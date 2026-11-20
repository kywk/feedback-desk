import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_EXAMPLE, ASSESSMENT_FACTORS, analysisDisposition, canonicalProposalJson,
    isSafeCustomerBody, parseAnalysis,
} from '../../src/shared/automation-analysis.mjs';
import { createAnalysisHandler } from '../../scripts/agents/analysis/index.mjs';
import { createTextModelAdapter } from '../../scripts/agents/analysis/model.mjs';
import { digest } from '../../scripts/agents/analysis/evidence.mjs';
import { createScopeAccess } from '../../scripts/agents/scope/index.mjs';
import { runConsumer } from '../../scripts/agents/consumer/index.mjs';

const rootScope = { project_slug: 'project-a', environment: 'test', scope_revision: 'rev-a' };
const work = {
    ...rootScope, worker_id: 'worker-w2', work_id: 'work-1', report_public_id: 'ticket-1',
    report_revision: 1, lease_generation: 1, event_id: 'report.created:ticket-1', correlation_id: 'report.created:ticket-1',
    input_revision: 1, decision_revision: 0, stage: 'running',
};

function example(scores: number[]) {
    const result = structuredClone(ANALYSIS_EXAMPLE);
    ASSESSMENT_FACTORS.forEach((factor, index) => {
        result.assessment[factor].score = scores[index] as 0 | 1 | 2;
    });
    return result;
}

describe('shared analysis decisions', () => {
    it.each([
        [[0, 0, 0, 0, 0], 0, 'blocked'],
        [[2, 2, 0, 0, 0], 4, 'blocked'],
        [[1, 1, 1, 1, 1], 5, 'waiting_review'],
        [[2, 2, 1, 1, 1], 7, 'waiting_review'],
        [[2, 2, 2, 1, 1], 8, 'repair'],
        [[2, 2, 2, 2, 2], 10, 'repair'],
    ])('classifies scores %j', (scores, score, kind) => {
        expect(analysisDisposition(parseAnalysis(example(scores)))).toMatchObject({ kind, score });
    });

    it('rejects non-integer and out-of-range scores, and blocks a high score without verification evidence', () => {
        for (const score of [-1, 3, 1.1, NaN, '2']) {
            const valid = example([2, 2, 2, 1, 1]);
            Object.assign(valid.assessment.verification, { score });
            expect(() => parseAnalysis(valid)).toThrow('invalid_analysis');
        }
        const missing = example([2, 2, 2, 2, 0]);
        missing.assessment.verification.evidence_refs = [];
        expect(analysisDisposition(parseAnalysis(missing))).toEqual({ kind: 'blocked', score: 8, reason: 'evidence_missing' });
    });

    it('routes verified explanation, a request for the minimum details, clear change, and pending business criteria', () => {
        const bug = example([2, 2, 2, 1, 1]);
        const { proposal, ...fields } = bug;
        expect(analysisDisposition(parseAnalysis({
            ...fields, classification: 'explanation', customer_body: '請打開結果頁，再重新整理。',
        })).kind).toBe('reply');
        expect(analysisDisposition(parseAnalysis({
            ...fields, classification: 'needs_information', missing_requirements: ['出現問題的頁面'], customer_body: '請提供出現問題的頁面。',
        })).kind).toBe('request_information');
        expect(analysisDisposition(parseAnalysis({ ...fields, proposal, classification: 'change_request' })).kind).toBe('repair');
        expect(analysisDisposition(parseAnalysis({
            ...fields, classification: 'change_request', criteria: [],
        }))).toMatchObject({ kind: 'waiting_review', reason: 'business_decision' });
    });
});

function git(directory: string, ...args: string[]) {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

describe('analysis workflow with real project scope', () => {
    let tmp: string;
    let auditPath: string;
    let configPath: string;
    let commit: string;
    let tools: ReturnType<ReturnType<typeof createScopeAccess>['forWork']>;
    const signal = new AbortController().signal;

    function transport(next_action = 'analyze', repair_authorization: unknown = undefined, decision_revision = 0) {
        return {
            input: vi.fn(async () => ({
                work: { ...work, next_action, decision_revision }, repair_authorization,
                report: {
                    public_id: work.report_public_id, title: '清單出現重複',
                    description: '信箱 tester@fixture.invalid，從 https://secret.fixture.invalid 查資料。',
                    messages: [{ side: 'customer', body: 'PASSWORD=fixture-secret' }],
                    attachment_refs: [{ file: '/home/private/path' }],
                    evidence_refs: ['repo:fixture-repo:src/items.js', 'repo:project-b:src/items.js', 'https://private.example.com'],
                },
            })),
            decisions: vi.fn(async (_lease, body) => ({ receipt: { operation_id: body.operation_id, work_id: work.work_id } })),
        };
    }

    function analysisWithEvidence(reference: string) {
        const analysis = example([2, 2, 2, 1, 1]);
        analysis.evidence_refs = [reference as `ev:${string}`];
        for (const item of Object.values(analysis.assessment)) item.evidence_refs = analysis.evidence_refs;
        analysis.proposal!.base_commit = commit;
        return analysis;
    }

    beforeEach(async () => {
        tmp = await realpath(await mkdtemp(join(tmpdir(), 'feedback-analysis-')));
        auditPath = join(tmp, 'scope-audit.jsonl');
        configPath = join(tmp, 'scopes.json');
        const repo = join(tmp, 'repo');
        await mkdir(join(repo, 'src'), { recursive: true });
        await writeFile(join(repo, 'src/items.js'), "const reportEmail = 'person@fixture.invalid';\nreturn allItems;\n");
        git(repo, 'init', '-b', 'main');
        git(repo, 'remote', 'add', 'origin', 'https://git.invalid/group/fixture.git');
        git(repo, 'add', '.');
        git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@fake.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
        commit = git(repo, 'rev-parse', 'HEAD');
        await writeFile(configPath, JSON.stringify({ scopes: [{
            ...rootScope, repositories: [{
                id: 'fixture-repo', directory: repo, remote: 'https://git.invalid/group/fixture.git',
                base_branch: 'main', base_commit: commit, read_paths: ['src'],
                repair: { allowed_paths: ['src'], checks: [{ id: 'unit', argv: ['internal-check-command'] }] },
            }],
            guides: [],
        }] }));
        tools = createScopeAccess({ configPath, auditPath }).forWork({
            ...work, actor: work.worker_id,
        });
    });

    afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

    it('queries bounded evidence, persists a traceable reference, and replays a checkpoint with the same decision', async () => {
        const queue = transport();
        const checkpoint = vi.fn(async (_data: Record<string, unknown>) => {});
        const analyze = vi.fn(async ({ report, catalog, readEvidence }) => {
            expect(JSON.stringify({ report, catalog })).not.toMatch(/tester@fixture|secret\.fixture|fixture-secret|private\/path|internal-check-command|\/repo|git\.invalid/);
            expect(catalog.supplemental_read_requests).toEqual([{ operation: 'read_repo_file', repo_id: 'fixture-repo', path: 'src/items.js' }]);
            await expect(readEvidence({ operation: 'read_repo_file', repo_id: 'project-b', path: 'src/items.js' }))
                .rejects.toMatchObject({ code: 'source_not_allowed' });
            await expect(readEvidence({ operation: 'exec', command: 'read internal env' }))
                .rejects.toMatchObject({ code: 'analysis_invalid_tool_request' });
            const view = await readEvidence(catalog.supplemental_read_requests[0]);
            expect(view.content).toContain('[已遮罩]');
            expect(view.content).not.toContain('person@fixture.invalid');
            return analysisWithEvidence(view.reference);
        });
        const handler = createAnalysisHandler({ configPath, auditPath, analyze });
        const base = { work, queue, tools, checkpoint, signal };
        await handler({ ...base, progress: {} });
        const [stored] = checkpoint.mock.calls[0]!;
        const second = await handler({ ...base, work: { ...work, lease_generation: 2 }, progress: stored });
        expect(second.receipt.operation_id).toMatch(/^analysis:[a-f\d]{64}$/);
        expect(analyze).toHaveBeenCalledTimes(1);
        expect(queue.decisions.mock.calls[0]![1]).toEqual(queue.decisions.mock.calls[1]![1]);
        const text = await readFile(auditPath, 'utf8');
        const refs = text.trim().split('\n').map(line => JSON.parse(line));
        expect(refs).toContainEqual(expect.objectContaining({
            operation: 'analysis_evidence', decision: 'allowed', ...rootScope,
            input_revision: work.input_revision, lease_generation: work.lease_generation,
            reference: queue.decisions.mock.calls[0]![1].analysis.evidence_refs[0], target: expect.objectContaining({ commit }),
        }));
        expect(refs).toContainEqual(expect.objectContaining({ operation: 'analysis_evidence', decision: 'denied' }));
        expect(text).not.toMatch(/read internal env|allItems|fixture-secret/);
    });

    it('uses a new operation key when a team supplement reopens analysis of the same input', async () => {
        const queue = transport();
        const reopened = transport('analyze', undefined, 1);
        const checkpoint = vi.fn(async (_data: Record<string, unknown>) => {});
        const analyze = vi.fn(async ({ readEvidence }) => {
            const view = await readEvidence({ operation: 'read_repo_file', repo_id: 'fixture-repo', path: 'src/items.js' });
            return analysisWithEvidence(view.reference);
        });
        const handler = createAnalysisHandler({ configPath, auditPath, analyze });
        const base = { work, queue, tools, checkpoint, signal };
        const first = await handler({ ...base, progress: {} });
        const [stored] = checkpoint.mock.calls[0]!;
        const second = await handler({ ...base, queue: reopened, progress: stored });
        expect(first.receipt.operation_id).not.toBe(second.receipt.operation_id);
        expect(analyze).toHaveBeenCalledTimes(2);
    });

    it('blocks when no model is configured', async () => {
        const queue = transport();
        const handler = createAnalysisHandler({ configPath, auditPath });
        await expect(handler({ work, queue, tools, checkpoint: vi.fn(), signal, progress: {} }))
            .rejects.toMatchObject({ code: 'analysis_model_not_configured' });
        expect(queue.decisions).not.toHaveBeenCalled();
    });

    it('rejects forged references and a change with a sensitive plaintext fragment before any DMZ decision', async () => {
        const queue = transport();
        const checkpoint = vi.fn();
        const base = { work, queue, tools, checkpoint, signal, progress: {} };
        const forged = createAnalysisHandler({ configPath, auditPath, analyze: async () => ANALYSIS_EXAMPLE });
        await expect(forged(base)).rejects.toMatchObject({ code: 'analysis_unverified_evidence' });

        const handler = createAnalysisHandler({ configPath, auditPath, analyze: async ({ readEvidence }) => {
            const view = await readEvidence({ operation: 'read_repo_file', repo_id: 'fixture-repo', path: 'src/items.js' });
            const analysis = analysisWithEvidence(view.reference);
            analysis.proposal!.changes[0]!.after = 'return "tester@fixture.invalid";';
            return analysis;
        } });
        await expect(handler(base)).rejects.toMatchObject({ code: 'analysis_sensitive_proposal' });
        expect(queue.decisions).not.toHaveBeenCalled();
        expect(checkpoint).not.toHaveBeenCalled();
    });

    it('releases only sanitized customer text for review', async () => {
        const queue = transport();
        const handler = createAnalysisHandler({ configPath, auditPath, analyze: async () => {
            const { proposal: _proposal, ...fields } = example([0, 0, 0, 0, 0]);
            for (const factor of Object.values(fields.assessment)) factor.evidence_refs = [];
            return {
                ...fields, classification: 'needs_information', evidence_refs: [],
                missing_requirements: ['發生的頁面'], customer_body: '請提供頁面。PASSWORD=fixture-password',
            };
        } });
        await handler({ work, queue, tools, checkpoint: vi.fn(), signal, progress: {} });
        const body = queue.decisions.mock.calls[0]![1].analysis.customer_body;
        expect(body).toContain('[已遮罩]');
        expect(body).not.toContain('fixture-password');
        expect(isSafeCustomerBody(body)).toBe(false);
    });

    it('uses the approved proposal for repair re-entry, and rejects stale grant revisions', async () => {
        const proposal = example([1, 1, 1, 1, 1]).proposal!;
        const grant = {
            kind: 'team_approved', approval_id: 'approval-1', proposal_revision: 2, proposal,
            proposal_digest: digest(canonicalProposalJson(proposal)), input_revision: work.input_revision, scope_revision: work.scope_revision,
        };
        const analyze = vi.fn();
        const runRepair = vi.fn(async () => ({ receipt: { operation_id: 'mr:registered' } }));
        const handler = createAnalysisHandler({ configPath, auditPath, analyze, runRepair });
        const base = { work, tools, checkpoint: vi.fn(), signal, progress: {} };
        await expect(handler({ ...base, queue: transport('repair', grant) })).resolves.toEqual({ receipt: { operation_id: 'mr:registered' } });
        await expect(handler({ ...base, queue: transport('repair', { ...grant, input_revision: 2 }) }))
            .rejects.toMatchObject({ code: 'repair_authorization_invalid' });
        expect(analyze).not.toHaveBeenCalled();
        expect(runRepair).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ repairAuthorization: grant, work }));
    });

    it('does not send another progress write after the service accepts a terminal decision', async () => {
        const after: string[] = [];
        const expires = new Date(Date.now() + 60_000).toISOString();
        const row = { ...work, lease_expires_at: expires, progress: null };
        const report = (await transport().input()).report;
        const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
            const section = url.pathname.split('/').at(-1)!;
            after.push(section);
            const data = init.body ? JSON.parse(init.body as string) : {};
            if (section === 'events') return Response.json({ events: [], next_cursor: '0' });
            if (section === 'claim') return Response.json({ work: row });
            if (section === 'input') return Response.json({ report, work: { ...row, next_action: 'analyze' } });
            if (section === 'renew') return Response.json({ work: row });
            if (section === 'progress') return Response.json({ work: { ...row, ...data } });
            if (section === 'decisions') return Response.json({ receipt: {
                operation_id: data.operation_id, input_revision: data.input_revision,
                work_id: data.work_id, stage: 'waiting_customer', outcome: 'needs_input_sent',
            } });
            throw new Error('unknown route');
        });
        const analyze = vi.fn(async () => {
            const { proposal: _proposal, ...fields } = example([0, 0, 0, 0, 0]);
            for (const factor of Object.values(fields.assessment)) factor.evidence_refs = [];
            return { ...fields, classification: 'needs_information', evidence_refs: [],
                missing_requirements: ['頁面'], customer_body: '請提供發生問題的頁面。' };
        });
        const log = vi.fn();
        await runConsumer({
            baseUrl: 'https://queue.invalid', token: 'fda_' + 'a'.repeat(28),
            projectSlug: work.project_slug, environment: work.environment, workerId: work.worker_id, scopeRevision: work.scope_revision,
            statePath: join(tmp, 'consumer.json'), scopeAccess: createScopeAccess({ configPath, auditPath }),
            fetchImpl, workflow: createAnalysisHandler({ analyze, configPath, auditPath }), once: true, log,
        });
        expect(after).toEqual(['events', 'claim', 'progress', 'input', 'renew', 'progress', 'decisions']);
        expect(log).toHaveBeenCalledWith('work_transitioned', expect.objectContaining({ operation_id: expect.stringMatching(/^analysis:/) }));
    });
    it('retries a lost MR-link ACK with the original observation and proof', async () => {
        const after: string[] = [];
        const attempts: unknown[] = [];
        const row = { ...work, lease_expires_at: new Date(Date.now() + 60_000).toISOString(), progress: null };
        const proposal = example([2, 2, 2, 1, 1]).proposal!;
        const grant = { kind: 'automatic', proposal_revision: 1, proposal,
            proposal_digest: digest(canonicalProposalJson(proposal)), input_revision: work.input_revision, scope_revision: work.scope_revision };
        const report = (await transport().input()).report;
        const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
            const section = url.pathname.split('/').at(-1)!;
            after.push(section);
            const data = init.body ? JSON.parse(init.body as string) : {};
            if (section === 'events') return Response.json({ events: [], next_cursor: '0' });
            if (section === 'claim') return Response.json({ work: row });
            if (section === 'input') return Response.json({ report, work: { ...row, next_action: 'repair' }, repair_authorization: grant });
            if (section === 'progress') return Response.json({ work: { ...row, ...data } });
            if (section === 'mr-links') {
                attempts.push(data);
                if (attempts.length === 1) throw new TypeError('fixture ACK lost after commit');
                return Response.json({ receipt: { operation_id: data.operation_id } });
            }
            throw new Error('unknown route');
        });
        const runRepair = vi.fn(async ({ work, queue, signal }) => {
            return queue.mrLinks(work, {
                operation_id: 'mr:fixture', input_revision: work.input_revision, proposal_revision: grant.proposal_revision,
                proposal_digest: grant.proposal_digest, observation: { mr_id: 99, mr_iid: 9 }, proof: 'fixture-signature',
            }, signal);
        });
        await runConsumer({
            baseUrl: 'https://queue.invalid', token: 'fda_' + 'a'.repeat(28),
            projectSlug: work.project_slug, environment: work.environment, workerId: work.worker_id, scopeRevision: work.scope_revision,
            statePath: join(tmp, 'consumer.json'), scopeAccess: createScopeAccess({ configPath, auditPath }),
            fetchImpl, workflow: createAnalysisHandler({ runRepair, configPath, auditPath }), once: true, retryBaseMs: 1,
        });
        expect(runRepair).toHaveBeenCalledTimes(1);
        expect(after).toEqual(['events', 'claim', 'progress', 'input', 'mr-links', 'mr-links']);
        expect(attempts).toHaveLength(2);
        expect(attempts[0]).toEqual(attempts[1]);
        expect(attempts[0]).toMatchObject({ operation_id: 'mr:fixture', proof: 'fixture-signature', lease_generation: work.lease_generation });
    });
});

it('uses the configured text endpoint and only appends approved tool responses', async () => {
    const readEvidence = vi.fn(async () => ({ reference: 'ev:' + '1'.repeat(64), content: 'Approved excerpt' }));
    const finish = { action: 'finish', analysis: ANALYSIS_EXAMPLE };
    const fetchImpl = vi.fn(async (_url: URL, init: RequestInit) => {
        const messages = JSON.parse(init.body as string).messages;
        if (messages.length === 2) return Response.json({ choices: [{ message: {
            content: JSON.stringify({ action: 'read', request: { operation: 'read_local_guide', guide_id: 'fixture', path: 'docs/guide.md' } }),
        } }] });
        expect(JSON.stringify(messages)).toContain('Approved excerpt');
        return Response.json({ choices: [{ message: { content: JSON.stringify(finish) } }] });
    });
    const analyze = createTextModelAdapter({ endpoint: 'https://model.invalid/v1/chat/completions', model: 'text-model', fetchImpl });
    await expect(analyze({
        readEvidence, report: { title: 'Fixture' }, catalog: { guides: ['fixture'] }, signal: new AbortController().signal,
    })).resolves.toEqual(ANALYSIS_EXAMPLE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readEvidence).toHaveBeenCalledExactlyOnceWith({ operation: 'read_local_guide', guide_id: 'fixture', path: 'docs/guide.md' });
    expect(fetchImpl.mock.calls[0]![1].redirect).toBe('error');
});
