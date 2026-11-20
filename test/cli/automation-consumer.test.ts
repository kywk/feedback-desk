import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopeAccess } from '../../scripts/agents/scope/index.mjs';
import { RetryableWorkError, runConsumer } from '../../scripts/agents/consumer/index.mjs';

const scope = { project_slug: 'project-a', environment: 'test', scope_revision: 'rev-a' };
const workerId = 'worker-1';
const event = {
    schema_version: 1, source: 'feedback-desk', event_id: 'report.created:a123',
    event_type: 'report.created', scope, payload: { report_public_id: 'a123', report_revision: 1 },
};
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

function memoryQueue() {
    const leaseEnd = () => new Date(Date.now() + 60_000).toISOString();
    type Work = {
        report_public_id: string; report_revision: number; scope_revision: string; work_id: string;
        event_id: string; stage: string; lease_generation: number; worker_id: string | null;
        lease_expires_at: string | null; retry_at: string | null; progress: Record<string, unknown> | null;
    };
    let row: Work = {
        report_public_id: 'a123', report_revision: 1, scope_revision: scope.scope_revision, work_id: 'work-1',
        event_id: event.event_id, stage: 'queued', lease_generation: 0, worker_id: null,
        lease_expires_at: null, retry_at: null, progress: null,
    };
    const controls = { renewConflict: false, events429: false, loseTerminalAck: false };

    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
        if (url.pathname.endsWith('/events')) {
            if (controls.events429) return json({}, { status: 429, headers: { 'Retry-After': '3' } });
            const after = url.searchParams.get('after');
            return json({ events: after === '0' ? [event] : [], next_cursor: '2' });
        }
        const data = JSON.parse(init.body as string);
        if (url.pathname.endsWith('/claim')) {
            if (!['queued', 'running'].includes(row.stage) ||
                (row.lease_expires_at && Date.parse(row.lease_expires_at) > Date.now()) ||
                (row.retry_at && Date.parse(row.retry_at) > Date.now())) return json({ work: null });
            row = { ...row, worker_id: workerId, lease_generation: row.lease_generation + 1,
                lease_expires_at: leaseEnd(), retry_at: null };
            return json({ work: row });
        }
        if (data.worker_id !== row.worker_id || data.lease_generation !== row.lease_generation ||
            data.report_revision !== row.report_revision || !row.lease_expires_at) {
            return json({ error: 'lease_conflict' }, { status: 409 });
        }
        if (url.pathname.endsWith('/renew')) {
            if (controls.renewConflict) return json({ error: 'lease_conflict' }, { status: 409 });
            row.lease_expires_at = leaseEnd();
            return json({ work: row });
        }
        if (!url.pathname.endsWith('/progress')) throw new Error('unsupported queue route');
        const release = data.retry_at || !['running', 'queued'].includes(data.stage);
        row = { ...row, stage: data.stage, progress: data.progress, retry_at: data.retry_at ?? null,
            ...(release && { worker_id: null, lease_expires_at: null }) };
        if (release && controls.loseTerminalAck) throw new TypeError('fixture ACK lost');
        return json({ work: row });
    });
    return {
        fetchImpl, controls,
        get work() { return row; },
        expire() { row.lease_expires_at = '2026-01-01T00:00:00Z'; },
        due() { row.retry_at = '2026-01-01T00:00:00Z'; },
    };
}

describe('inner automation consumer', () => {
    let root: string;
    let statePath: string;
    let configPath: string;
    let scopeAccess: ReturnType<typeof createScopeAccess>;
    let queue: ReturnType<typeof memoryQueue>;
    let log: ReturnType<typeof vi.fn>;

    function options(overrides = {}) {
        return {
            baseUrl: 'https://queue.invalid', token: 'fda_' + 'a'.repeat(28),
            projectSlug: scope.project_slug, environment: scope.environment, workerId, scopeRevision: scope.scope_revision,
            statePath, scopeAccess, fetchImpl: queue.fetchImpl, log, once: true, retryBaseMs: 1,
            ...overrides,
        };
    }

    beforeEach(async () => {
        root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-consumer-')));
        statePath = join(root, 'state.json');
        configPath = join(root, 'scopes.json');
        const guide = join(root, 'guide');
        await mkdir(guide);
        await writeFile(join(guide, 'readme.md'), 'Local fixture');
        await writeFile(configPath, JSON.stringify({ scopes: [{ ...scope,
            repositories: [], guides: [{ id: 'guide-a', directory: guide, read_paths: ['readme.md'] }],
        }] }));
        scopeAccess = createScopeAccess({ configPath, auditPath: join(root, 'audit.jsonl') });
        queue = memoryQueue();
        log = vi.fn();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    });

    it('resumes the acknowledged checkpoint after stop and an expired lease, then avoids repeat dispatch', async () => {
        const controller = new AbortController();
        const first = vi.fn(async ({ checkpoint }) => {
            await checkpoint({ phase: 'review_ready' });
            controller.abort();
            await expect(checkpoint({ phase: 'late' })).rejects.toThrow();
        });
        await runConsumer(options({ handleWork: first, signal: controller.signal }));
        expect(first).toHaveBeenCalledTimes(1);
        expect(queue.work).toMatchObject({
            stage: 'running', lease_generation: 1,
            progress: { consumer: { attempt: 1 }, handler: { phase: 'review_ready' } },
        });
        expect(log).toHaveBeenCalledWith('work_stopped', expect.objectContaining({ work_id: 'work-1' }));

        await runConsumer(options());
        expect(queue.work.stage).toBe('running');
        queue.expire();
        const second = vi.fn(async ({ progress, work }) => {
            expect(work.lease_generation).toBe(2);
            expect(progress).toEqual({ phase: 'review_ready' });
            return { stage: 'waiting_review', progress };
        });
        await runConsumer(options({ handleWork: second }));
        await runConsumer(options({ handleWork: second }));
        expect(second).toHaveBeenCalledTimes(1);
        expect(queue.work.stage).toBe('waiting_review');
        expect(queue.fetchImpl.mock.calls.filter(([url]) => url.pathname.endsWith('/events'))
            .map(([url]) => url.searchParams.get('after'))).toEqual(['0', '2', '2', '2']);
    });

    it('persists poll backoff and respects Retry-After across process restarts', async () => {
        const at = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(at);
        queue.controls.events429 = true;
        await runConsumer(options());
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
            cursor: '0', poll_failures: 1, poll_retry_at: at + 3000,
        });
        queue.controls.events429 = false;
        await runConsumer(options());
        expect(queue.fetchImpl).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('poll_deferred', { retry_at: new Date(at + 3000).toISOString() });

        vi.mocked(Date.now).mockReturnValue(at + 3000);
        await runConsumer(options());
        expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({
            cursor: '2', poll_failures: 0, poll_retry_at: 0,
        });
        expect(queue.work).toMatchObject({
            stage: 'waiting_review', progress: { consumer: { reason: 'handler_not_configured' } },
        });
    });

    it('persists the handler retry deadline and blocks after its final attempt', async () => {
        const handler = vi.fn(async () => {
            throw new RetryableWorkError('fixture_busy', { retryAfterMs: 3000 });
        });
        const at = Date.now();
        await runConsumer(options({ handleWork: handler, maxAttempts: 2 }));
        expect(queue.work).toMatchObject({
            stage: 'queued', progress: { consumer: { attempt: 1, reason: 'fixture_busy' } },
        });
        expect(Date.parse(queue.work.retry_at ?? '')).toBeGreaterThanOrEqual(at + 3000);
        await runConsumer(options({ handleWork: handler, maxAttempts: 2 }));
        expect(handler).toHaveBeenCalledTimes(1);
        queue.due();
        await runConsumer(options({ handleWork: handler, maxAttempts: 2 }));
        await runConsumer(options({ handleWork: handler, maxAttempts: 2 }));
        expect(handler).toHaveBeenCalledTimes(2);
        expect(queue.work).toMatchObject({
            stage: 'blocked', retry_at: null, progress: { consumer: { attempt: 2, reason: 'fixture_busy' } },
        });
    });

    it('fences the handler and its capabilities after renewal is rejected', async () => {
        let lateOperation: Promise<unknown> | undefined;
        const handler = vi.fn(async ({ signal, checkpoint, tools }) => {
            await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
            lateOperation = Promise.allSettled([
                checkpoint({ phase: 'late' }),
                tools.execute({ operation: 'read_local_guide', guide_id: 'guide-a', path: 'readme.md' }),
            ]);
            return { stage: 'completed' };
        });
        queue.controls.renewConflict = true;
        await runConsumer(options({ handleWork: handler, heartbeatMs: 10 }));
        await expect(lateOperation).resolves.toMatchObject([{ status: 'rejected' }, { status: 'rejected' }]);
        expect(log).toHaveBeenCalledWith('lease_lost', { work_id: 'work-1', lease_generation: 1, reason: 'lease_conflict' });
        expect(queue.work.stage).toBe('running');
        expect(queue.work.progress).toMatchObject({ handler: {} });
    });

    it('uses bound evidence tools and rechecks the authoritative lease before and after the read', async () => {
        const handler = vi.fn(async ({ tools }) => {
            await expect(tools.execute({ operation: 'read_local_guide', guide_id: 'guide-a', path: 'readme.md' }))
                .resolves.toMatchObject({ content: 'Local fixture' });
            await expect(tools.execute({ operation: 'read_local_guide', guide_id: 'guide-b', path: 'readme.md' }))
                .rejects.toMatchObject({ code: 'source_not_allowed' });
            return { stage: 'waiting_review' };
        });
        await runConsumer(options({ handleWork: handler }));
        expect(queue.fetchImpl.mock.calls.filter(([url]) => url.pathname.endsWith('/renew'))).toHaveLength(3);
        expect(queue.work.stage).toBe('waiting_review');
    });

    it('blocks when the local scope is revoked after claim', async () => {
        const handler = vi.fn(async ({ checkpoint }) => {
            await writeFile(configPath, JSON.stringify({ scopes: [{ ...scope, enabled: false }] }));
            await checkpoint({ phase: 'revoked' });
            return { stage: 'completed' };
        });
        await runConsumer(options({ handleWork: handler }));
        expect(queue.work).toMatchObject({
            stage: 'blocked', progress: { consumer: { reason: 'scope_revoked' }, handler: {} },
        });
    });

    it('does not dispatch the same work again after a terminal write ACK is lost', async () => {
        const handler = vi.fn(async () => ({ stage: 'completed' }));
        queue.controls.loseTerminalAck = true;
        await runConsumer(options({ handleWork: handler }));
        await runConsumer(options({ handleWork: handler }));
        expect(handler).toHaveBeenCalledTimes(1);
        expect(queue.work.stage).toBe('completed');
    });

    it('launches the new worker through the PM script and rejects mixed legacy configuration', () => {
        const script = join(import.meta.dirname, '../../scripts/agents/pm_poll.sh');
        expect(execFileSync('bash', [script, '--help'], { encoding: 'utf8' })).toContain('consumer/cli.mjs [--once]');
        expect(() => execFileSync('bash', [script], {
            env: { ...process.env, FEEDBACK_DESK_POLL_MODE: 'legacy', FEEDBACK_DESK_AUTOMATION_TOKEN: 'fixture-not-used' },
            stdio: 'pipe',
        })).toThrow(/legacy/);
    });
});
