import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { randomString, sha256Hex } from '../../src/worker/lib/crypto';
import { api, BASE, Browser, seedDeveloper, seedProject, seedReport, seedToken, type SeededProject } from './helpers';

const revision = 'w4-v1';
const component = 'cart-app';
const workspace = 'ws-live';
const testId = 'cart-test';
const version = 'v2-published';
const check = 'cart-visible';
const mrCheck = 'checkout-works';
const mrHead = 'a'.repeat(40);
const at = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

async function fixture({ autoClose = 1, autoReply = 1, qa = 'qa', seed }: {
    autoClose?: number; autoReply?: number; qa?: string; seed?: SeededProject;
} = {}) {
    const seeded = seed ?? await seedProject();
    const id = seeded.project.id;
    const slug = seeded.project.slug;
    const whippet = slug + '-whippet';
    const ci = slug + '-ci';
    const deployment = 'fdd_' + randomString(48);
    const retest = 'fdr_' + randomString(48);
    const inspection = 'fdi_' + randomString(48);
    const reviewer = await seedDeveloper();
    const team = await seedToken(reviewer.developer);
    await env.DB.batch([
        env.DB.prepare('INSERT INTO automation_scopes (project_id,environment,scope_revision,customer_ingress,inspection_ingress) VALUES (?,?,?,?,1)')
            .bind(id, qa, revision, Number(qa === 'qa')),
        env.DB.prepare(`INSERT INTO automation_w4_tokens (token_hash,project_id,environment,role,source_instance)
            VALUES (?1,?3,?4,'deployment',?5),(?2,?3,?4,'retest',?6)`)
            .bind(await sha256Hex(deployment), await sha256Hex(retest), id, qa, ci, whippet),
        env.DB.prepare('INSERT INTO automation_deployment_sources (project_id,environment,scope_revision,component_id,source_instance) VALUES (?,?,?,?,?)')
            .bind(id, qa, revision, component, ci),
        env.DB.prepare(`INSERT INTO automation_retest_targets (project_id,environment,scope_revision,component_id,target_kind,repo_id,source_instance,workspace_id,test_id,version_id,check_key)
            VALUES (?1,?2,?3,?4,'mr','cart-repo',?5,?6,?7,?8,?9),(?1,?2,?3,?4,'inspection',NULL,?5,?6,?7,?8,?10)`)
            .bind(id, qa, revision, component, whippet, workspace, testId, version, mrCheck, check),
        env.DB.prepare('INSERT INTO automation_inspection_tokens (token_hash,project_id,environment,source_instance) VALUES (?,?,?,?)')
            .bind(await sha256Hex(inspection), id, qa, whippet),
        env.DB.prepare(`INSERT INTO automation_inspection_targets (project_id,environment,scope_revision,source_instance,workspace_id,test_id,check_key)
            VALUES (?,?,?,?,?,?,?)`).bind(id, qa, revision, whippet, workspace, testId, check),
        env.DB.prepare(`INSERT INTO automation_policies (project_id,environment,scope_revision,auto_reply,gitlab_instance_id,auto_close_inspections)
            VALUES (?,?,?,?, 'gitlab-live',?)`).bind(id, qa, revision, autoReply, autoClose),
        env.DB.prepare(`INSERT INTO automation_repositories (project_id,environment,scope_revision,repo_id,gitlab_project_id,base_branch,base_commit,branch_prefix,required_check_ids)
            VALUES (?,?,?,'cart-repo',19,'main',?,'feedback/','["blank-title"]')`).bind(id, qa, revision, 'b'.repeat(40)),
        env.DB.prepare('INSERT INTO automation_reviewers (project_id,environment,developer_id) VALUES (?,?,?)')
            .bind(id, qa, reviewer.developer.id),
    ]);
    const base = `${BASE}/api/automation/${slug}/${qa}`;
    return { id, slug, qa, base, deployment, retest, inspection, seed: seeded, team };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Intent = { retest_request_id: string; deployment_id: string; artifact_revision: string; workspace_id: string;
    test_id: string; version_id: string; status: string; run_id: string | null; check_keys: string[] };

function call(f: Fixture, endpoint: string, token: string, data?: object) {
    return exports.default.fetch(new Request(`${f.base}/${endpoint}`, {
        method: data ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + token, ...(data ? { 'content-type': 'application/json' } : {}) },
        body: data ? JSON.stringify(data) : undefined,
    }));
}

async function json<T>(response: Response): Promise<T> {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return JSON.parse(body) as T;
}

function deploy(id: string, sequence: number, commits = [mrHead]) {
    return { scope_revision: revision, deployment_id: id, component_id: component, sequence,
        occurred_at: at(60), state: 'succeeded', artifact_revision: 'artifact:' + id, commit_shas: commits, evidence_ref: 'ci:build:' + id };
}

async function register(f: Fixture, event: ReturnType<typeof deploy> | object) {
    return (await json<{ receipt: { outcome: string; intent_ids: string[] } }>(await call(f, 'deployments', f.deployment, event))).receipt;
}

async function list(f: Fixture) {
    return json<{ intents: Intent[]; next_cursor: string | null }>(await call(f, 'retest-intents', f.retest));
}

async function inspection(f: Fixture, runId: string, end = at(90), signature = 'v1:cart-missing') {
    const result = await json<{ receipt: { report_public_id: string } }>(await call(f, 'inspection-events', f.inspection, {
        schema_version: 1, event_type: 'whippet.run_finished', source: 'whippet', event_id: 'whippet:' + runId, operation_id: 'ingest:' + runId,
        scope: { project_slug: f.slug, environment: f.qa }, scope_revision: revision, occurred_at: end,
        payload: { workspace_id: workspace, test_id: testId, version_id: 'previous-published', run_id: runId,
            attempt_id: 'attempt:' + runId, started_at: at(100), purpose: 'inspection', status: 'failed', failure_kind: 'assertion',
            check_key: check, failure_signature: signature, summary: '商品清單未出現', evidence_refs: ['whippet:report:' + runId] },
    }));
    return result.receipt.report_public_id;
}

async function customerMr(f: Fixture, head = mrHead) {
    const { report } = await seedReport(f.seed.project);
    const work = await env.DB.prepare('SELECT work_id FROM automation_work WHERE report_public_id=?').bind(report.public_id).first<string>('work_id');
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO automation_decisions (work_id,decision_revision,report_revision,scope_revision,analysis_json,outcome,created_at)
            VALUES (?,1,1,?,'{}','repair_authorized',?)`).bind(work, revision, at(120)),
        env.DB.prepare(`INSERT INTO automation_mr_links (work_id,decision_revision,operation_id,gitlab_instance_id,gitlab_project_id,mr_iid,observation_json)
            VALUES (?,1,'mr-proof','gitlab-live',19,?,?)`).bind(work, report.id, JSON.stringify({ repo_id: 'cart-repo', state: 'opened', head_sha: head })),
        env.DB.prepare("UPDATE automation_work SET proposal_revision=1,stage='waiting_review',decision_outcome='mr_opened' WHERE work_id=?").bind(work),
    ]);
    return report.public_id;
}

function binding(intent: Intent, run = 'whippet-run-' + intent.deployment_id) {
    return {
        scope_revision: revision, retest_request_id: intent.retest_request_id, deployment_id: intent.deployment_id, artifact_revision: intent.artifact_revision,
        workspace_id: intent.workspace_id, test_id: intent.test_id, version_id: intent.version_id, run_id: run,
    };
}

async function bind(f: Fixture, intent: Intent) {
    const data = binding(intent);
    expect(await json(await call(f, 'retest-runs', f.retest, data))).toEqual({
        receipt: { retest_request_id: intent.retest_request_id, run_id: data.run_id },
    });
    return data;
}

function result(data: ReturnType<typeof binding>, keys: string[], generation = 1, outcome = 'passed') {
    return {
        ...data, operation_id: 'result:' + data.run_id + ':' + generation, attempt_id: 'attempt:' + generation, attempt_generation: generation,
        started_at: at(40), finished_at: at(30), outcome,
        checks: keys.map(check_key => ({ check_key, status: outcome === 'assertion_failed' ? 'failed' : 'passed' })),
        evidence_refs: ['whippet:report:retest'],
    };
}

async function status(publicId: string) {
    return env.DB.prepare('SELECT status FROM reports WHERE public_id=?').bind(publicId).first<string>('status');
}

async function count(f: Fixture, table: 'reports' | 'automation_deployments' | 'automation_retest_intents') {
    return env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).bind(f.id).first<number>('n');
}

describe('W4 deployment and trusted retests', () => {
    it('requires the registered CI identity and does not schedule on failed deployment or an unproven MR commit', async () => {
        const f = await fixture();
        const customer = await customerMr(f);
        const submitted = deploy('deploy-wrong', 1, ['c'.repeat(40)]);
        const stage = await fixture({ seed: f.seed, qa: 'stage' });
        expect((await call(f, 'deployments', f.retest, submitted)).status).toBe(401);
        expect((await call(stage, 'deployments', f.deployment, submitted)).status).toBe(403);
        expect((await call(f, 'deployments', f.deployment, { ...submitted, scope_revision: 'old' })).status).toBe(409);
        expect((await call(f, 'deployments', f.deployment, { ...submitted, component_id: 'other-component' })).status).toBe(403);
        expect((await call(f, 'deployments', f.deployment, { ...submitted, artifact_revision: undefined })).status).toBe(400);
        expect(await register(f, submitted)).toMatchObject({ outcome: 'registered', intent_ids: [] });
        const { artifact_revision: _artifact, commit_shas: _commits, ...failed } = deploy('deploy-failed', 2);
        expect(await register(f, { ...failed, state: 'failed' })).toMatchObject({ outcome: 'failed', intent_ids: [] });
        expect(await list(f)).toEqual({ intents: [], next_cursor: null });
        const audit = `/projects/${f.slug}/automation/${f.qa}/deployments/${failed.deployment_id}`;
        expect(await json(await api('GET', audit, f.team))).toMatchObject({ deployment: { state: 'failed', receipt: { outcome: 'failed' } } });
        expect((await api('GET', audit, stage.team)).status).toBe(403);
        expect(await status(customer)).toBe('new');
    });

    it('shares a single version-pinned Run and applies one customer confirmation and one system close', async () => {
        const f = await fixture();
        const customer = await customerMr(f);
        const internal = await inspection(f, 'run-failed');
        const deployment = deploy('deploy-real', 10);
        const [first, second] = await Promise.all([register(f, deployment), register(f, deployment)]);
        expect(first).toEqual(second);
        expect(first.intent_ids).toHaveLength(1);
        expect(await count(f, 'automation_deployments')).toBe(1);
        expect((await call(f, 'deployments', f.deployment, { ...deployment, artifact_revision: 'different' })).status).toBe(409);
        expect((await call(f, 'deployments', f.deployment, { ...deployment, deployment_id: 'duplicate-sequence' })).status).toBe(409);
        const { intents: [intent], next_cursor } = await list(f);
        expect(next_cursor).toBeNull();
        expect(intent).toMatchObject({ status: 'pending', artifact_revision: deployment.artifact_revision, version_id: version, check_keys: [check, mrCheck] });
        expect((await call(f, 'retest-runs', f.retest, { ...binding(intent), version_id: 'moved' })).status).toBe(409);
        const bound = await bind(f, intent);
        await bind(f, intent);
        expect((await call(f, 'retest-runs', f.retest, { ...bound, run_id: 'different-run' })).status).toBe(409);
        const done = result(bound, intent.check_keys);
        expect((await call(f, 'retest-results', f.retest, { ...done, artifact_revision: 'moved' })).status).toBe(409);
        const replies = await Promise.all([call(f, 'retest-results', f.retest, done).then(json), call(f, 'retest-results', f.retest, done).then(json)]);
        expect(replies[0]).toEqual(replies[1]);
        expect(replies[0]).toMatchObject({ receipt: { outcome: 'applied', reports: expect.arrayContaining([
            { report_public_id: customer, outcome: 'waiting_customer' }, { report_public_id: internal, outcome: 'completed' },
        ]) } });
        expect(await status(internal)).toBe('completed');
        expect(await status(customer)).toBe('needs_input');
        expect(await list(f)).toEqual({ intents: [], next_cursor: null });
        const confirmation = await env.DB.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN reports r ON r.id=m.report_id
            WHERE r.public_id=? AND m.is_completion_request=1`).bind(customer).first<number>('n');
        expect(confirmation).toBe(1);
        const system = await env.DB.prepare(`SELECT e.actor_name, e.agent FROM report_events e JOIN reports r ON r.id=e.report_id
            WHERE r.public_id=? AND e.kind='status' ORDER BY e.id DESC LIMIT 1`).bind(internal).first();
        expect(system).toEqual({ actor_name: 'Feedback Desk', agent: 'Feedback Desk' });
        const detail = await json(await api('GET', `/projects/${f.slug}/reports/${customer}/automation/${f.qa}`, f.team));
        expect(detail).toMatchObject({ retests: [{ deployment_id: deployment.deployment_id, outcome: 'waiting_customer',
            observation: { evidence_refs: done.evidence_refs, attempt_id: done.attempt_id } }] });
        const client = await new Browser().asClient(f.seed);
        const html = await (await client.get(`/p/${f.slug}/reports/${customer}`)).text();
        expect(html).toContain('通過');
        expect(html).not.toContain(done.evidence_refs[0]);
        const reverse = `/projects/${f.slug}/automation/${f.qa}/retest-runs/${bound.run_id}`;
        expect(await json(await api('GET', reverse, f.team))).toMatchObject({
            run_id: bound.run_id, reports: expect.arrayContaining([
                expect.objectContaining({ report_public_id: customer, check_key: mrCheck, deployment_id: deployment.deployment_id }),
                expect.objectContaining({ report_public_id: internal, check_key: check, deployment_id: deployment.deployment_id }),
            ]),
        });
        const stage = await fixture({ qa: 'stage', seed: f.seed });
        expect((await api('GET', reverse, stage.team)).status).toBe(403);
        expect((await api('GET', reverse.replace('/qa/', '/stage/'), stage.team)).status).toBe(404);
        expect((await client.post(`/p/${f.slug}/reports/${customer}/status`, { status: 'completed' })).status).toBe(302);
        expect(await status(customer)).toBe('completed');
    });

    it('records failed and older results without reopening or closing the original report', async () => {
        const f = await fixture();
        const report = await inspection(f, 'run-before-deploy');
        await register(f, deploy('deploy-old', 3));
        const old = (await list(f)).intents[0];
        const boundOld = await bind(f, old);
        await register(f, deploy('deploy-new', 5));
        expect(await register(f, deploy('deploy-late', 4))).toMatchObject({ outcome: 'ignored_stale', intent_ids: [] });
        const current = (await list(f)).intents[0];
        expect(current.deployment_id).toBe('deploy-new');
        const bound = await bind(f, current);
        const failed = { ...result(bound, [check], 2, 'assertion_failed'), failure_signature: 'v1:new-failure' };
        const failure = await json(await call(f, 'retest-results', f.retest, failed));
        expect(failure).toMatchObject({ receipt: { outcome: 'applied', reports: [{ report_public_id: report, outcome: 'failed' }] } });
        expect(await json(await call(f, 'retest-results', f.retest, result(bound, [check], 1))))
            .toMatchObject({ receipt: { outcome: 'ignored_stale' } });
        expect(await json(await call(f, 'retest-results', f.retest, result(boundOld, [check]))))
            .toMatchObject({ receipt: { outcome: 'ignored_stale' } });
        expect(await json(await call(f, 'retest-results', f.retest, failed))).toEqual(failure);
        expect((await call(f, 'retest-results', f.retest, { ...failed, operation_id: 'alias-failure', failure_signature: 'different' })).status).toBe(409);
        expect(await count(f, 'reports')).toBe(1);
        expect(await status(report)).toBe('new');
    });

    it('keeps a newer inspection failure and a changed report pending when older proof arrives', async () => {
        const f = await fixture();
        const report = await inspection(f, 'run-baseline');
        const customer = await customerMr(f);
        await register(f, deploy('deploy-check', 1));
        const intent = (await list(f)).intents[0];
        const bound = await bind(f, intent);
        expect(await inspection(f, 'run-newer', at(20))).toBe(report);
        await env.DB.prepare("UPDATE reports SET description='新補充資料' WHERE public_id=?").bind(customer).run();
        expect(await json(await call(f, 'retest-results', f.retest, result(bound, intent.check_keys))))
            .toMatchObject({ receipt: { outcome: 'ignored_stale', reports: expect.arrayContaining([
                expect.objectContaining({ report_public_id: report, reason: 'newer_inspection_failure' }),
                expect.objectContaining({ report_public_id: customer, reason: 'report_or_scope_changed' }),
            ]) } });
        expect(await status(report)).toBe('new');
        expect(await status(customer)).toBe('new');
    });

    it('keeps currently and previously shared inspection reports for team review even when auto-close is enabled', async () => {
        const f = await fixture();
        const historical = await inspection(f, 'run-historically-shared', at(90), 'v1:historical');
        const shared = await inspection(f, 'run-now-shared', at(90), 'v1:currently');
        await env.DB.batch([
            env.DB.prepare('UPDATE reports SET shared_with_client=1 WHERE public_id IN (?,?)').bind(historical, shared),
            env.DB.prepare('UPDATE reports SET shared_with_client=0 WHERE public_id=?').bind(historical),
        ]);
        await register(f, deploy('deploy-shared', 1));
        const intent = (await list(f)).intents[0];
        const bound = await bind(f, intent);
        expect(await json(await call(f, 'retest-results', f.retest, result(bound, [check]))))
            .toMatchObject({ receipt: { reports: expect.arrayContaining([
                { report_public_id: historical, outcome: 'verified' }, { report_public_id: shared, outcome: 'verified' },
            ]) } });
        expect(await status(historical)).toBe('new');
        expect(await status(shared)).toBe('new');
    });

    it('records cancellation before dispatch and failure before an assigned attempt starts', async () => {
        const f = await fixture();
        const report = await inspection(f, 'run-with-prestart-terminal');
        await register(f, deploy('deploy-never-dispatched', 1));
        let intent = (await list(f)).intents[0];
        let bound = await bind(f, intent);
        const notDispatched = { ...result(bound, [], 1, 'cancelled'), attempt_id: null, attempt_generation: null, started_at: null, evidence_refs: [] };
        expect((await call(f, 'retest-results', f.retest, { ...notDispatched, outcome: 'passed' })).status).toBe(400);
        expect(await json(await call(f, 'retest-results', f.retest, notDispatched))).toMatchObject({
            receipt: { outcome: 'needs_review', attempt_id: null, reports: [{ report_public_id: report, outcome: 'needs_review' }] },
        });
        await register(f, deploy('deploy-dispatched-not-started', 2));
        intent = (await list(f)).intents[0];
        bound = await bind(f, intent);
        const failedOnDispatch = { ...result(bound, [], 1, 'infrastructure'), started_at: null, evidence_refs: [] };
        expect(await json(await call(f, 'retest-results', f.retest, failedOnDispatch))).toMatchObject({
            receipt: { outcome: 'needs_review', attempt_id: failedOnDispatch.attempt_id },
        });
        expect(await list(f)).toEqual({ intents: [], next_cursor: null });
        expect(await status(report)).toBe('new');
    });

    it('keeps no-evidence, skipped checks and policy-disabled cases out of automated closure', async () => {
        const f = await fixture({ autoClose: 0, autoReply: 0 });
        const report = await inspection(f, 'run-policy-disabled');
        await register(f, deploy('deploy-no-evidence', 1));
        const [initial] = (await list(f)).intents;
        const bounded = await bind(f, initial);
        const noEvidence = { ...result(bounded, [check]), evidence_refs: [] };
        expect(await json(await call(f, 'retest-results', f.retest, noEvidence))).toMatchObject({ receipt: { outcome: 'needs_review' } });
        expect(await list(f)).toEqual({ intents: [], next_cursor: null });
        await register(f, deploy('deploy-valid-evidence', 2));
        const [latest] = (await list(f)).intents;
        const bound = await bind(f, latest);
        expect(await json(await call(f, 'retest-results', f.retest, result(bound, [check]))))
            .toMatchObject({ receipt: { reports: [{ report_public_id: report, outcome: 'verified' }] } });
        expect(await status(report)).toBe('new');
    });
});
