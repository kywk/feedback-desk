import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInspectionBridge } from '../../scripts/agents/inspection/index.mjs';

const environment = {
    WHIPPET_QA: 'whippet-qa-token', WHIPPET_STAGE: 'whippet-stage-token',
    FEEDBACK_QA: 'fdi_' + 'a'.repeat(32), FEEDBACK_STAGE: 'fdi_' + 'b'.repeat(32),
};
const qa = {
    source_id: 'portal-qa', workspace_id: 'workspace-1', whippet_environment: 'qa', whippet_token_env: 'WHIPPET_QA',
    project_slug: 'portal', environment: 'feedback-qa', scope_revision: 'v1', feedback_desk_token_env: 'FEEDBACK_QA',
    tests: [{ test_id: 'test-1', check_keys: ['cart:total'] }],
};
const stage = { ...qa, source_id: 'portal-stage', whippet_environment: 'stage', whippet_token_env: 'WHIPPET_STAGE',
    environment: 'feedback-stage', feedback_desk_token_env: 'FEEDBACK_STAGE' };
const config = { whippet_origin: 'https://whippet.invalid', feedback_desk_origin: 'https://feedback.invalid', sources: [qa, stage] };
const finish = '2026-11-20T02:00:00.123456Z';
const reports = { qa: 'd842ef28-59f4-406e-8573-3b78fbaae225', stage: '002d2357-fe90-4094-a4b8-d19f99ce8b00' };

function terminal(runId: string, overrides: Record<string, unknown> = {}) {
    return {
        workspaceId: 'workspace-1', runId, testId: 'test-1', versionId: 'version-2', environment: 'qa', purpose: 'inspection',
        status: 'failed', outcome: 'assertion_failed', attemptId: 'attempt-' + runId, checkKey: 'cart:total',
        startedAt: '2026-11-20T01:59:00Z', finishedAt: finish, failureSignature: 'a'.repeat(64),
        reportUrl: '/api/runs/' + runId + '/artifacts/report.html', errorMessage: 'sensitive assertion detail',
        ...overrides,
    };
}

function fixture(runs: ReturnType<typeof terminal>[]) {
    const controls = { loseAck: '', staleRun: '', detail: new Map<string, ReturnType<typeof terminal>>() };
    const calls = {
        events: [] as any[], list: [] as { environment: string; after: string | null }[],
        details: [] as string[], dmzLinks: [] as any[], whippetLinks: [] as any[],
    };
    const events = new Map<string, { event: any; receipt: any }>();
    const links = new Map<string, any>();
    const acknowledgments = new Map<string, any>();

    function reply(operation: string, payload: unknown) {
        if (controls.loseAck === operation) {
            controls.loseAck = '';
            throw new TypeError('committed, response lost');
        }
        return Response.json(payload);
    }

    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
        expect(init.redirect).toBe('error');
        const token = new Headers(init.headers).get('authorization');
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        if (url.origin === config.whippet_origin) {
            const scope = token === 'Bearer ' + environment.WHIPPET_QA ? 'qa' : 'stage';
            expect(token).toBe('Bearer ' + (scope === 'qa' ? environment.WHIPPET_QA : environment.WHIPPET_STAGE));
            const [runId, action] = url.pathname.replace('/api/inspections/workspaces/workspace-1/runs', '').slice(1).split('/');
            if (!runId) {
                const after = url.searchParams.get('after');
                calls.list.push({ environment: scope, after });
                expect(url.searchParams.get('limit')).toBe('100');
                expect(after === null || after === 'opaque+' + scope + '/page').toBe(true);
                return Response.json(after === null
                    ? { items: runs.filter(run => run.environment === scope), nextCursor: 'opaque+' + scope + '/page' } : { items: [] });
            }
            const run = runs.find(run => run.runId === runId && run.environment === scope);
            if (!run) return Response.json({}, { status: 404 });
            if (!action) {
                calls.details.push(runId);
                return Response.json(controls.detail.get(runId) ?? run);
            }
            expect(action).toBe('links');
            expect(body).toEqual({ attemptId: run.attemptId, projectSlug: 'portal', reportPublicId: reports[scope] });
            calls.whippetLinks.push({ runId, ...body });
            links.set(runId, body);
            return reply('whippet-link', { workspaceId: run.workspaceId, runId, ...body });
        }

        expect(url.origin).toBe(config.feedback_desk_origin);
        const match = /^\/api\/automation\/portal\/(feedback-qa|feedback-stage)\/inspection-(events|links)$/.exec(url.pathname);
        expect(match).not.toBeNull();
        const scope = match![1] === 'feedback-qa' ? 'qa' : 'stage';
        expect(token).toBe('Bearer ' + (scope === 'qa' ? environment.FEEDBACK_QA : environment.FEEDBACK_STAGE));
        if (match![2] === 'links') {
            expect(links.get(body.run_id)?.reportPublicId).toBe(body.report_public_id);
            calls.dmzLinks.push(body);
            acknowledgments.set(body.run_id, body);
            return reply('dmz-link', { link: body });
        }
        calls.events.push(body);
        const previous = events.get(body.event_id);
        if (previous) expect(body).toEqual(previous.event);
        const { workspace_id, run_id, attempt_id } = body.payload;
        const stale = controls.staleRun === run_id;
        const receipt = previous?.receipt ?? { event_id: body.event_id, operation_id: body.operation_id, workspace_id, run_id,
            attempt_id, outcome: stale ? 'ignored' : 'linked', report_public_id: stale ? null : reports[scope],
            ...(stale ? { ignored_reason: 'stale_run' } : {}) };
        events.set(body.event_id, { event: body, receipt });
        return reply('dmz-event', { receipt });
    });
    return { calls, controls, events, links, acknowledgments, fetchImpl };
}

describe('Whippet inspection bridge', () => {
    let stateDirectory: string;

    beforeEach(async () => { stateDirectory = await mkdtemp(join(tmpdir(), 'fd-inspection-')); });
    afterEach(async () => { await rm(stateDirectory, { recursive: true, force: true }); });

    function bridge(service: ReturnType<typeof fixture>, options = {}) {
        return runInspectionBridge({ config, stateDirectory, environment, fetchImpl: service.fetchImpl, once: true, maxAttempts: 1, ...options });
    }

    it.each(['dmz-event', 'whippet-link', 'dmz-link'])('restarts after the %s commit loses its response and keeps the original receipt', async step => {
        const service = fixture([terminal('run-1')]);
        service.controls.loseAck = step;
        await expect(bridge(service)).rejects.toThrow(/unavailable/);
        const saved = await readdir(stateDirectory);
        expect(saved.filter(name => name.endsWith('.event.json'))).toHaveLength(1);
        expect(saved.filter(name => name.endsWith('.cursor.json'))).toHaveLength(0);
        expect(saved.filter(name => name.endsWith('.receipt.json'))).toHaveLength(step === 'dmz-event' ? 0 : 1);

        await bridge(service);
        const files = await readdir(stateDirectory);
        expect(files.filter(name => name.endsWith('.cursor.json'))).toHaveLength(1);
        const receipt = JSON.parse(await readFile(join(stateDirectory, files.find(name => name.endsWith('.receipt.json'))!), 'utf8'));
        expect(receipt).toEqual([...service.events.values()][0].receipt);
        expect(service.acknowledgments.size).toBe(1);
        expect(service.links.size).toBe(1);
        await bridge(service, { replay: { sourceId: qa.source_id, runId: 'run-1' } });
        expect(service.calls.events).toHaveLength(3);
        expect(service.events.size).toBe(1);
        expect(service.calls.list.filter(call => call.environment === 'qa').map(call => call.after)).toEqual([null, null]);

        await bridge(service);
        expect(service.calls.list).toContainEqual({ environment: 'qa', after: 'opaque+qa/page' });
        expect(service.calls.events).toHaveLength(3);
    });

    it('reads back each Run and keeps outcomes for success, validation, interruption, uncovered checks and unverifiable evidence', async () => {
        const service = fixture([
            terminal('draft', { purpose: 'draft_validation' }),
            terminal('passed', { status: 'succeeded', outcome: 'passed' }),
            terminal('interrupted', { status: 'interrupted', outcome: 'infrastructure' }),
            terminal('cancelled', { status: 'cancelled', outcome: 'cancelled', attemptId: null }),
            terminal('timed-out', { status: 'timed_out', outcome: 'timed_out' }),
            terminal('unknown', { outcome: 'feature_not_supported' }),
            terminal('unmapped', { testId: 'outside-allowlist' }),
            terminal('check', { checkKey: 'customer:pinned-data' }),
            terminal('evidence', { reportUrl: 'https://wrong.invalid/report?key=private' }),
            terminal('different-attempt'), terminal('stale'), terminal('genuine'),
        ]);
        service.controls.detail.set('different-attempt', terminal('different-attempt', { attemptId: 'new-attempt' }));
        service.controls.staleRun = 'stale';
        const log = vi.fn();
        await bridge(service, { log });
        expect(service.calls.details).toHaveLength(12);
        expect(service.calls.events).toHaveLength(2);
        const body = service.calls.events[1];
        expect(body).toMatchObject({ occurred_at: '2026-11-20T02:00:00.123Z', scope: { environment: 'feedback-qa' },
            payload: { started_at: '2026-11-20T01:59:00.000Z', version_id: 'version-2', evidence_refs: ['whippet:run:genuine'] } });
        expect(JSON.stringify(body)).not.toMatch(/https?:|sensitive assertion detail|private/);
        expect(service.links.size).toBe(1);
        const results = Object.fromEntries(log.mock.calls.map(([, fields]) => [fields.run_id, fields.outcome]));
        expect(results).toEqual({ draft: 'purpose_not_inspection', passed: 'passed', interrupted: 'infrastructure',
            cancelled: 'cancelled', 'timed-out': 'timed_out', unknown: 'unverified', unmapped: 'test_not_mapped',
            check: 'check_not_mapped', evidence: 'unverified', 'different-attempt': 'unverified', stale: 'stale_run', genuine: 'linked' });
        expect((await readdir(stateDirectory)).filter(file => file.endsWith('.result.json'))).toHaveLength(12);
    });

    it('keeps independent scope credentials, work and cursor streams within one Whippet workspace', async () => {
        const service = fixture([terminal('run-2'), terminal('run-3', { environment: 'stage' })]);
        service.controls.loseAck = 'dmz-event';
        await expect(bridge(service)).rejects.toThrow('feedback_desk_unavailable');
        expect(service.links.has('run-3')).toBe(true);
        expect(service.links.has('run-2')).toBe(false);
        await bridge(service);
        expect(service.calls.list).toEqual([
            { environment: 'qa', after: null }, { environment: 'stage', after: null },
            { environment: 'qa', after: null }, { environment: 'stage', after: 'opaque+stage/page' },
        ]);
        expect(service.links.get('run-2').reportPublicId).toBe(reports.qa);
        expect(service.links.get('run-3').reportPublicId).toBe(reports.stage);
        await expect(bridge(service, { replay: { sourceId: qa.source_id, runId: 'run-3' } })).rejects.toThrow('whippet_http_error');
        expect(service.events.size).toBe(2);
    });

    it('fails closed for a cross-environment readback and rejects ambiguous source configuration', async () => {
        const service = fixture([terminal('qa-1')]);
        service.controls.detail.set('qa-1', terminal('qa-1', { environment: 'stage' }));
        await expect(bridge(service)).rejects.toThrow('whippet_invalid_run');
        expect(service.events.size).toBe(0);
        expect(await readdir(stateDirectory)).toEqual([]);
        await expect(bridge(service, { config: { ...config, sources: [qa, { ...stage, whippet_environment: 'qa' }] } }))
            .rejects.toThrow('inspection_config_invalid');
    });

    it('exposes the command-line entry point without requiring credentials for help', () => {
        expect(execFileSync(process.execPath, ['scripts/agents/inspection/cli.mjs', '--help'], { encoding: 'utf8' }))
            .toContain('--replay <sourceId> <runId>');
    });
});
