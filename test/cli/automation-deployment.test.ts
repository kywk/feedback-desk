import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDeploymentBridge } from '../../scripts/agents/deployment/index.mjs';

const ids = {
    workspace: '0785eb41-4863-4f0a-9ee1-6826e4f96696', test: '58f3278c-5cf9-4a14-83e5-3e5655bea317',
    version: '30592608-8e10-403d-8705-fcb608d7dc60', attempt: '44660dd2-a349-42ba-af55-8a4ff2ef3f4e',
    report: 'fb16c3cf-2eb3-459d-8441-eb44da7e4ede',
};
const sequenceId = (sequence: number, kind: 'run' | 'intent') =>
    `7e0d391e-005c-47b0-${kind === 'run' ? '90cb' : 'ac35'}-${String(sequence).padStart(12, '0')}`;
const commit = 'a'.repeat(40);
const environment = {
    HMAC: 'b'.repeat(64), DEPLOY: 'fdd_' + 'b'.repeat(32), RETEST: 'fdr_' + 'c'.repeat(32),
    SCHEDULE: 'whippet-schedule', READ: 'whippet-read',
};
const proofOrigin = 'https://application.invalid';
const source = {
    source_id: 'portal-qa', project_slug: 'portal', environment: 'qa', scope_revision: 'scope-v1', workspace_id: ids.workspace,
    manifest_hmac_key_env: 'HMAC', deployment_token_env: 'DEPLOY', retest_token_env: 'RETEST',
    whippet_schedule_token_env: 'SCHEDULE', whippet_read_token_env: 'READ',
    components: [{ component_id: 'checkout', proof_url: proofOrigin + '/.well-known/deployment.json',
        tests: [{ test_id: ids.test, version_id: ids.version, check_keys: ['cart:total', 'cart:tax'] }] }],
};
const config = { whippet_origin: 'https://whippet.invalid', feedback_desk_origin: 'https://feedback.invalid', sources: [source] };
const timestamp = '2026-11-21T02:00:00.123456Z';

function signed(sequence: number, overrides: Record<string, unknown> = {}) {
    const manifest = { schema_version: 1, source_id: source.source_id, project_slug: source.project_slug, environment: source.environment,
        deployment_id: 'deploy-' + sequence, component_id: 'checkout', sequence, occurred_at: timestamp, state: 'succeeded',
        evidence_ref: 'ci:deploy-' + sequence, artifact_revision: 'artifact-' + sequence, commit_shas: [commit], ...overrides };
    const raw = Buffer.from(JSON.stringify(manifest));
    const signature = createHmac('sha256', Buffer.from(environment.HMAC, 'hex')).update(raw).digest('hex');
    return { sourceId: source.source_id, raw, signature };
}

type Intent = {
    retest_request_id: string; deployment_id: string; component_id: string; artifact_revision: string;
    workspace_id: string; test_id: string; version_id: string; check_keys: string[]; run_id: string | null;
    status: 'pending' | 'running' | 'finished' | 'superseded';
};
type Result = { operation_id: string; retest_request_id: string; run_id: string; attempt_id: string | null; outcome: string };

function fixture() {
    const controls = { liveSequence: 1, terminal: new Map<number, Record<string, unknown>>(), loseAck: '', badVersion: false };
    const calls = { deployments: [] as unknown[], schedules: [] as unknown[], bindings: [] as unknown[], results: [] as Result[],
        proof: 0, details: [] as string[] };
    const deployments = new Map<string, { deployment_id: string; outcome: string; intent_ids: string[] }>();
    const intents = new Map<string, Intent>();
    const scheduled = new Map<string, string>();
    const results = new Map<string, { operation_id: string; retest_request_id: string; run_id: string; attempt_id: string | null;
        outcome: string; reports: { report_public_id: string; outcome: string }[] }>();
    let latestSuccessful = 0;

    function reply(step: string, response: unknown, status = 200) {
        if (controls.loseAck === step) {
            controls.loseAck = '';
            throw new TypeError('committed but response lost');
        }
        return Response.json(response, { status });
    }

    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
        const token = new Headers(init.headers).get('authorization');
        const data = init.body ? JSON.parse(init.body as string) : undefined;
        expect(init.redirect).toBe('error');
        if (url.origin === proofOrigin) {
            expect(token).toBeNull();
            expect(url.pathname).toBe('/.well-known/deployment.json');
            calls.proof++;
            const sequence = controls.liveSequence;
            return Response.json({ deploymentId: 'deploy-' + sequence, artifactRevision: 'artifact-' + sequence,
                environment: 'qa', projectSlug: 'portal' });
        }

        if (url.origin === config.whippet_origin) {
            const prefix = '/api/retests/workspaces/' + ids.workspace + '/runs';
            if (init.method === 'POST') {
                expect(token).toBe('Bearer ' + environment.SCHEDULE);
                expect(url.pathname).toBe(prefix);
                calls.schedules.push(data);
                const runId = sequenceId(Number(data.deploymentId.split('-').at(-1)), 'run');
                scheduled.set(data.deploymentId, runId);
                expect(data.checkKeys).toEqual(['cart:tax', 'cart:total']);
                return reply('schedule', { runId }, 202);
            }
            expect(token).toBe('Bearer ' + environment.READ);
            const runId = url.pathname.slice(prefix.length + 1);
            expect([...scheduled.values()]).toContain(runId);
            calls.details.push(runId);
            const sequence = Number(runId.split('-').at(-1));
            const terminal = controls.terminal.get(sequence);
            if (!terminal) return Response.json({}, { status: 409 });
            return Response.json({ workspaceId: ids.workspace, runId, testId: ids.test, versionId: ids.version, environment: 'qa',
                purpose: 'deployment_retest', deploymentId: 'deploy-' + sequence, artifactRevision: 'artifact-' + sequence,
                status: 'succeeded', outcome: 'passed', attemptId: ids.attempt, attemptGeneration: 1,
                startedAt: timestamp, finishedAt: '2026-11-21T02:06:00.000Z', reportUrl: '/api/runs/' + runId + '/artifacts/report.html',
                checks: [{ checkKey: 'cart:total', status: 'passed' }, { checkKey: 'cart:tax', status: 'passed' }],
                ...terminal });
        }

        expect(url.origin).toBe(config.feedback_desk_origin);
        const route = url.pathname.replace('/api/automation/portal/qa', '');
        expect(token).toBe('Bearer ' + (route === '/deployments' ? environment.DEPLOY : environment.RETEST));
        if (route === '/deployments') {
            calls.deployments.push(data);
            expect(data.scope_revision).toBe(source.scope_revision);
            if (controls.loseAck === 'deployment-before') {
                controls.loseAck = '';
                throw new TypeError('request interrupted before commit');
            }
            const { deployment_id, sequence, state, commit_shas, artifact_revision } = data;
            if (!deployments.has(deployment_id)) {
                const outcome = state === 'failed' ? 'failed' : sequence <= latestSuccessful ? 'ignored_stale' : 'registered';
                const intent_ids: string[] = [];
                if (outcome === 'registered') {
                    for (const old of intents.values()) old.status = 'superseded';
                    latestSuccessful = sequence;
                    // The DMZ independently requires a matching MR head SHA for this fixture's customer test.
                    if (commit_shas.includes(commit)) {
                        const retest_request_id = sequenceId(sequence, 'intent');
                        intents.set(retest_request_id, { retest_request_id, deployment_id, artifact_revision, component_id: 'checkout',
                            workspace_id: ids.workspace, test_id: ids.test, version_id: ids.version, check_keys: ['cart:total', 'cart:tax'],
                            run_id: null, status: 'pending' });
                        intent_ids.push(retest_request_id);
                    }
                }
                deployments.set(deployment_id, { deployment_id, outcome, intent_ids });
            }
            return reply('deployment', { receipt: deployments.get(deployment_id) });
        }
        if (route === '/retest-intents') {
            expect(url.searchParams.get('after')).toBe('0');
            expect(url.searchParams.get('limit')).toBe('50');
            return Response.json({ intents: [...intents.values()].filter(intent => ['pending', 'running'].includes(intent.status))
                .map(intent => ({ ...intent, version_id: controls.badVersion ? ids.report : intent.version_id })), next_cursor: null });
        }
        if (route.startsWith('/retest-intents/')) {
            const intent = intents.get(route.slice('/retest-intents/'.length));
            return intent ? Response.json({ intent }) : Response.json({}, { status: 404 });
        }
        if (route === '/retest-runs') {
            calls.bindings.push(data);
            const intent = intents.get(data.retest_request_id)!;
            expect(data.run_id).toBe(scheduled.get(intent.deployment_id));
            Object.assign(intent, { run_id: data.run_id, status: 'running' });
            return reply('bind', { receipt: { retest_request_id: data.retest_request_id, run_id: data.run_id } });
        }
        expect(route).toBe('/retest-results');
        calls.results.push(data);
        const intent = intents.get(data.retest_request_id)!;
        const { operation_id, retest_request_id, run_id, attempt_id } = data;
        expect(run_id).toBe(intent.run_id);
        if (!results.has(operation_id)) {
            const outcome = intent.status === 'superseded' ? 'ignored_stale' : data.outcome === 'passed' ? 'applied' : 'needs_review';
            if (intent.status !== 'superseded') intent.status = 'finished';
            results.set(operation_id, { operation_id, retest_request_id, run_id, attempt_id, outcome,
                reports: [{ report_public_id: ids.report, outcome: outcome === 'applied' ? 'requested_customer' : outcome }] });
        }
        return reply('result', { receipt: results.get(operation_id) });
    });

    return { controls, calls, deployments, intents, results, scheduled, fetchImpl };
}

describe('deployment retest bridge', () => {
    let stateDirectory: string;
    beforeEach(async () => { stateDirectory = await mkdtemp(join(tmpdir(), 'fd-deploy-')); });
    afterEach(async () => { await rm(stateDirectory, { recursive: true, force: true }); });

    function bridge(service: ReturnType<typeof fixture>, options = {}) {
        return runDeploymentBridge({ config, stateDirectory, environment, once: true, maxAttempts: 1, fetchImpl: service.fetchImpl, ...options });
    }

    it('authenticates the raw manifest and rejects tampering, a foreign environment and abbreviations of the deployed commit', async () => {
        const service = fixture();
        const signedEvent = signed(1);
        await expect(bridge(service, { submission: { ...signedEvent, raw: Buffer.concat([signedEvent.raw, Buffer.from('\n')]) } }))
            .rejects.toThrow('deployment_signature_invalid');
        await expect(bridge(service, { submission: signed(1, { environment: 'stage' }) })).rejects.toThrow('deployment_manifest_invalid');
        await expect(bridge(service, { submission: signed(1, { commit_shas: ['abc1234'] }) })).rejects.toThrow('deployment_manifest_invalid');
        expect(service.fetchImpl).not.toHaveBeenCalled();
        await bridge(service, { submission: signedEvent });
        expect(service.calls.deployments).toEqual([{ deployment_id: 'deploy-1', component_id: 'checkout', sequence: 1,
            occurred_at: '2026-11-21T02:00:00.123Z', state: 'succeeded', artifact_revision: 'artifact-1',
            evidence_ref: 'ci:deploy-1', commit_shas: [commit], scope_revision: source.scope_revision }]);
    });

    it('records failed and unrelated deployments with zero retests while refusing a schedule against a different live revision', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1, { state: 'failed', artifact_revision: undefined, commit_shas: undefined }) });
        service.controls.liveSequence = 2;
        await bridge(service, { submission: signed(2, { commit_shas: ['c'.repeat(40)] }) });
        await bridge(service);
        expect(service.scheduled.size).toBe(0);
        expect(service.deployments.get('deploy-1')?.outcome).toBe('failed');
        await expect(bridge(service, { submission: signed(3) })).rejects.toThrow('deployment_live_revision_mismatch');
        expect(service.deployments.has('deploy-3')).toBe(false);
        service.controls.liveSequence = 3;
        await bridge(service, { submission: signed(3) });
        service.controls.liveSequence = 2;
        await expect(bridge(service)).rejects.toThrow('deployment_live_revision_mismatch');
        expect(service.calls.proof).toBe(4);
        expect(service.scheduled.size).toBe(0);
        service.controls.liveSequence = 3;
        await bridge(service);
        expect(service.scheduled.size).toBe(1);
        expect(service.calls.results).toHaveLength(0);
    });

    it.each(['deployment', 'schedule', 'bind', 'result'])('resumes after a %s commit loses its response', async step => {
        const service = fixture();
        service.controls.terminal.set(1, {});
        if (step === 'deployment') {
            service.controls.loseAck = step;
            await expect(bridge(service, { submission: signed(1) })).rejects.toThrow('feedback_desk_unavailable');
        } else {
            await bridge(service, { submission: signed(1) });
            service.controls.loseAck = step;
            await expect(bridge(service)).rejects.toThrow(/unavailable/);
        }
        await bridge(service);
        expect(service.deployments.size).toBe(1);
        expect(service.scheduled.size).toBe(1);
        expect(service.intents.get(sequenceId(1, 'intent'))?.status).toBe('finished');
        expect(service.results.size).toBe(1);
        if (step === 'result') expect(service.calls.results[0]).toEqual(service.calls.results[1]);
        if (step === 'schedule') expect(service.calls.schedules[0]).toEqual(service.calls.schedules[1]);
        await bridge(service, { replay: { sourceId: source.source_id, retestRequestId: sequenceId(1, 'intent') } });
        expect(service.results.size).toBe(1);
    });

    it('preserves the newer result when a valid older success arrives after it', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1) });
        await bridge(service);
        service.controls.liveSequence = 2;
        service.controls.loseAck = 'deployment-before';
        await expect(bridge(service, { submission: signed(2) })).rejects.toThrow('feedback_desk_unavailable');
        service.controls.liveSequence = 3;
        await bridge(service, { submission: signed(3) });
        // The earlier request was verified live before being staged. Replaying it returns the DMZ stale receipt.
        await bridge(service, { submission: signed(2) });
        expect(service.deployments.get('deploy-2')?.outcome).toBe('ignored_stale');
        service.controls.terminal.set(3, { status: 'failed', outcome: 'assertion_failed',
            checks: [{ checkKey: 'cart:total', status: 'failed' }, { checkKey: 'cart:tax', status: 'passed' }] });
        await bridge(service);
        service.controls.terminal.set(1, {});
        await bridge(service, { replay: { sourceId: source.source_id, retestRequestId: sequenceId(1, 'intent') } });
        expect(service.scheduled.size).toBe(2);
        expect([...service.results.values()].map(result => result.outcome)).toEqual(['needs_review', 'ignored_stale']);
        expect(service.intents.get(sequenceId(3, 'intent'))?.status).toBe('finished');
    });

    it('records pre-start cancellation using null attempt data and rejects a forged positive result', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1) });
        service.controls.terminal.set(1, { environment: 'stage' });
        await expect(bridge(service)).rejects.toThrow('whippet_invalid_retest_result');
        service.controls.terminal.set(1, { checks: [{ checkKey: 'cart:total', status: 'passed' }] });
        await expect(bridge(service)).rejects.toThrow('whippet_invalid_retest_result');
        expect(service.calls.results).toHaveLength(0);
        service.controls.terminal.set(1, { status: 'cancelled', outcome: 'cancelled', attemptId: undefined, attemptGeneration: undefined,
            startedAt: undefined, reportUrl: undefined,
            checks: [{ checkKey: 'cart:tax', status: 'skipped' }, { checkKey: 'cart:total', status: 'skipped' }] });
        await bridge(service);
        expect(service.calls.results[0]).toMatchObject({ attempt_id: null, attempt_generation: null, started_at: null,
            outcome: 'cancelled', evidence_refs: [],
            checks: [{ check_key: 'cart:tax', status: 'skipped' }, { check_key: 'cart:total', status: 'skipped' }] });
    });

    it('refuses a positive result after the observed live deployment changes before the writeback', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1) });
        await bridge(service);
        service.controls.terminal.set(1, {});
        service.controls.liveSequence = 2;
        await expect(bridge(service)).rejects.toThrow('deployment_live_revision_mismatch');
        expect(service.calls.results).toHaveLength(0);
        expect(service.intents.get(sequenceId(1, 'intent'))?.status).toBe('running');
    });

    it('retains a dispatched attempt when the runner stops before it starts', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1) });
        service.controls.terminal.set(1, { status: 'interrupted', outcome: 'infrastructure', startedAt: undefined, reportUrl: undefined,
            checks: [{ checkKey: 'cart:tax', status: 'skipped' }, { checkKey: 'cart:total', status: 'skipped' }] });
        await bridge(service);
        expect(service.calls.results[0]).toMatchObject({ attempt_id: ids.attempt, attempt_generation: 1, started_at: null,
            outcome: 'infrastructure', evidence_refs: [] });
    });

    it('refuses an unapproved test version returned by the DMZ and exposes CLI usage', async () => {
        const service = fixture();
        await bridge(service, { submission: signed(1) });
        service.controls.badVersion = true;
        await expect(bridge(service)).rejects.toThrow('feedback_desk_invalid_retest_intent');
        expect(service.scheduled.size).toBe(0);
        expect(execFileSync(process.execPath, ['scripts/agents/deployment/cli.mjs', '--help'], { encoding: 'utf8' })).toContain('--ingest <sourceId>');
    });
});
