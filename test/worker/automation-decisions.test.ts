import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_EXAMPLE, ASSESSMENT_FACTORS, type Analysis } from '../../src/shared/automation-analysis.mjs';
import { canonicalJson, type Lease } from '../../src/worker/lib/automation';
import { randomString, sha256Hex } from '../../src/worker/lib/crypto';
import { createToken } from '../../src/worker/lib/team';
import { api, Browser, seedClientAccount, seedDeveloper, seedProject, seedReport, seedToken, workerEnv } from './helpers';

const scopeRevision = 'v1';
const proofKeyName = 'FEEDBACK_AUTOMATION_GITLAB_PROOF_KEY';
const proofKey = 'fixture-gitlab-secret-independent-of-bearer';
const evidence = 'ev:' + 'b'.repeat(64);
const gitlab = 'https://gitlab.fixture.test';

async function fixture(autoReply = false, deliveryMode: 'gitlab' | 'local' = 'gitlab') {
    const seeded = await seedProject();
    const project = seeded.project;
    const token = `fda_${randomString(48)}`;
    const reviewer = await seedDeveloper();
    const teamToken = await seedToken(reviewer.developer);
    const client = await new Browser().asClient(seeded);
    const local = deliveryMode === 'local';
    await env.DB.batch([
        env.DB.prepare("INSERT INTO automation_scopes (project_id,environment,scope_revision,customer_ingress) VALUES (?, 'qa', ?, 1)").bind(project.id, scopeRevision),
        env.DB.prepare("INSERT INTO automation_tokens (project_id,environment,token_hash) VALUES (?, 'qa', ?)").bind(project.id, await sha256Hex(token)),
        env.DB.prepare(`INSERT INTO automation_policies (project_id,environment,scope_revision,auto_reply,gitlab_instance_id,gitlab_origin,gitlab_proof_key_ref)
            VALUES (?, 'qa', ?, ?, ?, ?, ?)`).bind(project.id, scopeRevision, Number(autoReply),
            local ? null : 'gitlab-fixture', local ? null : gitlab, local ? null : proofKeyName),
        env.DB.prepare(`INSERT INTO automation_repositories (project_id,environment,scope_revision,repo_id,gitlab_project_id,base_branch,base_commit,branch_prefix,required_check_ids,delivery_mode)
            VALUES (?, 'qa', ?, 'fixture-repo', ?, 'main', ?, 'feedback/', '["unit"]', ?)`)
            .bind(project.id, scopeRevision, local ? null : 23, 'a'.repeat(40), deliveryMode),
        env.DB.prepare("INSERT INTO automation_reviewers (project_id,environment,developer_id) VALUES (?, 'qa', ?)").bind(project.id, reviewer.developer.id),
    ]);
    const { report } = await seedReport(project);
    const browser = new Browser(undefined, local ? {} : { [proofKeyName]: proofKey });
    const workerPath = `/api/automation/${project.slug}/qa`;
    const ownPath = `/p/${project.slug}/reports/${report.public_id}`;
    return {
        report, seeded, client, reviewer, teamToken, project, ownPath,
        teamPath: `/projects/${project.slug}/reports/${report.public_id}/automation/qa`,
        call: (endpoint: string, payload: object) => browser.request('POST', `${workerPath}/${endpoint}`, {
            body: JSON.stringify(payload), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        }),
    };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function ok<T>(response: Response): Promise<T> {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return JSON.parse(body) as T;
}
async function claim(f: Fixture) {
    const { work } = await ok<{ work: Lease & { stage: string } | null }>(await f.call('claim', { worker_id: 'operator', scope_revision: scopeRevision }));
    if (!work) throw new Error('missing work');
    const { work_id, report_public_id, report_revision, lease_generation, scope_revision, worker_id } = work;
    return { work_id, report_public_id, report_revision, lease_generation, scope_revision, worker_id };
}

function envelope(lease: Lease, analysis: Analysis = structuredClone(ANALYSIS_EXAMPLE), operationId = 'decision-1') {
    return { ...lease, input_revision: 1, operation_id: operationId, correlation_id: 'w2-tests', analysis };
}
function reply(body = '請在清單頁重新整理後查看最新的處理進度。'): Analysis {
    const { proposal: _proposal, ...analysis } = structuredClone(ANALYSIS_EXAMPLE);
    return { ...analysis, classification: 'needs_information', missing_requirements: ['操作時間'], customer_body: body };
}

describe('W2 automation decisions and repairs', () => {
    it('returns only the leased report and saves customer reply, status and replay receipt atomically', async () => {
        const f = await fixture(true);
        const lease = await claim(f);
        const input = await ok<{ work: object; report: object }>(await f.call('input', lease));
        expect(input).toMatchObject({ work: { input_revision: 1, next_action: 'analyze', decision_revision: 0 }, report: { public_id: f.report.public_id, messages: [] } });
        expect((await f.call('input', { ...lease, report_public_id: 'wrong' })).status).toBe(409);
        const body = envelope(lease, reply());
        const writes = await Promise.all([f.call('decisions', body).then(ok), f.call('decisions', body).then(ok)]);
        expect(writes[0]).toEqual(writes[1]);
        expect(writes[0]).toMatchObject({ receipt: { outcome: 'needs_input_sent', stage: 'waiting_customer', message_id: expect.any(Number), applied_report_revision: expect.any(Number) } });
        expect((await f.call('input', lease)).status).toBe(409);
        expect((await f.call('decisions', { ...body, analysis: reply('請補上錯誤出現的時間。') })).status).toBe(409);
        expect(await env.DB.prepare('SELECT status FROM reports WHERE id=?').bind(f.report.id).first('status')).toBe('needs_input');
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE report_id=?').bind(f.report.id).first('n')).toBe(1);
        const customerHtml = await (await f.client.get(f.ownPath)).text();
        expect(customerHtml).toContain('請在清單頁重新整理');
        expect(customerHtml).not.toContain('needs_input_sent');
        expect((await f.client.post(`${f.ownPath}/messages`, { body: '謝謝' })).status).toBe(302);
        const next = await claim(f);
        expect(next.work_id).not.toBe(lease.work_id);
        expect(await ok(await f.call('decisions', body))).toEqual(writes[0]);
        expect((await f.call('decisions', { ...body, operation_id: 'stale-write' })).status).toBe(409);
    });

    it('keeps policy-gated drafts internal and fences stale drafts in the existing send endpoint', async () => {
        const f = await fixture();
        const lease = await claim(f);
        const { receipt } = await ok<{ receipt: { draft_id: number } }>(await f.call('decisions', envelope(lease, reply())));
        const draftUrl = `${f.ownPath}/drafts/${receipt.draft_id}/send`;
        expect(await (await f.client.get(f.ownPath)).text()).not.toContain('請在清單頁重新整理');
        expect((await f.client.post(draftUrl)).status).toBe(403);
        const browser = new Browser();
        expect((await browser.loginAs(f.project.slug, f.reviewer.developer.username, f.reviewer.password)).status).toBe(302);
        expect((await f.client.post(`${f.ownPath}/messages`, { body: '新的資料' })).status).toBe(302);
        expect((await browser.post(draftUrl, {}, { accept: 'application/json' })).status).toBe(409);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE report_id=? AND author_type='owner'").bind(f.report.id).first('n')).toBe(0);
    });

    it('keeps sensitive reply content out of public messages and drafts even with auto-reply enabled', async () => {
        const f = await fixture(true);
        const lease = await claim(f);
        const { receipt } = await ok<{ receipt: { draft_id?: number } }>(await f.call('decisions',
            envelope(lease, reply('請提供 Authorization: Bearer fixture-sensitive-secret。'))));
        expect(receipt).toMatchObject({ outcome: 'business_review', stage: 'waiting_review' });
        expect(receipt.draft_id).toBeUndefined();
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE report_id=?').bind(f.report.id).first('n')).toBe(0);
        const team = await (await api('GET', f.teamPath, f.teamToken)).text();
        expect(team).not.toContain('fixture-sensitive-secret');
    });

    it('publishes a still-current draft once through the personal reviewer', async () => {
        const f = await fixture();
        const lease = await claim(f);
        const { receipt } = await ok<{ receipt: { draft_id: number } }>(await f.call('decisions', envelope(lease, reply())));
        const browser = new Browser();
        await browser.loginAs(f.project.slug, f.reviewer.developer.username, f.reviewer.password);
        const draftUrl = `${f.ownPath}/drafts/${receipt.draft_id}/send`;
        const responses = await Promise.all([browser.post(draftUrl), browser.post(draftUrl)]);
        expect(responses.map((r) => r.status).sort()).toContain(302);
        expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE report_id=? AND author_type='owner'").bind(f.report.id).first('n')).toBe(1);
        expect(await env.DB.prepare('SELECT stage FROM automation_work WHERE work_id=?').bind(lease.work_id).first('stage')).toBe('waiting_customer');
    });

    it('checks human identity and exact proposal revision when authorizing a mid-score repair', async () => {
        const f = await fixture();
        const analysis = structuredClone(ANALYSIS_EXAMPLE);
        ASSESSMENT_FACTORS.forEach((factor) => { analysis.assessment[factor].score = factor === 'verification' ? 2 : 1; });
        const lease = await claim(f);
        const { receipt } = await ok<{ receipt: { decision_revision: number; proposal_digest: string } }>(await f.call('decisions', envelope(lease, analysis)));
        expect(receipt).toMatchObject({ stage: 'waiting_review', outcome: 'review_required', score: 6 });
        const clientAccount = await seedClientAccount(f.project);
        const clientToken = (await createToken(workerEnv, { clientAccountId: clientAccount.account.id }, 'fixture', Date.now())).token;
        expect((await api('GET', f.teamPath, clientToken)).status).toBe(403);
        const unauthorized = await seedToken((await seedDeveloper()).developer);
        expect((await api('GET', f.teamPath, unauthorized)).status).toBe(403);
        const review = {
            action_id: 'approval-1', action: 'approve', work_id: lease.work_id, input_revision: 1,
            report_revision: lease.report_revision, scope_revision: scopeRevision,
            decision_revision: receipt.decision_revision, proposal_digest: receipt.proposal_digest,
        };
        expect((await api('POST', `${f.teamPath}/review`, f.teamToken, { ...review, proposal_digest: 'd'.repeat(64) })).status).toBe(409);
        const approval = await ok(await api('POST', `${f.teamPath}/review`, f.teamToken, review));
        expect(approval).toMatchObject({ receipt: { outcome: 'repair_authorized', next_action: 'repair', approval_id: expect.any(String) } });
        expect(await ok(await api('POST', `${f.teamPath}/review`, f.teamToken, review))).toEqual(approval);
        expect(await ok(await f.call('input', await claim(f)))).toMatchObject({ repair_authorization: { kind: 'team_approved', proposal_digest: receipt.proposal_digest } });
    });

    it('requires adequate evidence for repair and resumes the same blocked work after trusted team evidence', async () => {
        const f = await fixture();
        const lease = await claim(f);
        const analysis = structuredClone(ANALYSIS_EXAMPLE);
        analysis.assessment.verification.evidence_refs = [];
        const { receipt } = await ok<{ receipt: { decision_revision: number } }>(await f.call('decisions', envelope(lease, analysis)));
        expect(receipt).toMatchObject({ outcome: 'blocked', score: 10 });
        const supplement = {
            action_id: 'more-evidence', work_id: lease.work_id, input_revision: 1, report_revision: lease.report_revision,
            scope_revision: scopeRevision, decision_revision: receipt.decision_revision, evidence_refs: [evidence, 'repo:fixture-repo:src/items.js'], reason: '已補重現紀錄。',
        };
        expect(await ok(await api('POST', `${f.teamPath}/evidence`, f.teamToken, supplement))).toMatchObject({ receipt: { outcome: 'analysis_requested', next_action: 'analyze' } });
        const resumed = await claim(f);
        expect(resumed.work_id).toBe(lease.work_id);
        expect(resumed.report_revision).toBe(lease.report_revision);
        expect(await ok(await f.call('input', resumed))).toMatchObject({
            work: { next_action: 'analyze', decision_revision: receipt.decision_revision },
            report: { evidence_refs: [evidence, 'repo:fixture-repo:src/items.js'] },
        });
        expect(await ok(await f.call('decisions', envelope(resumed, structuredClone(ANALYSIS_EXAMPLE), 'decision-2')))).toMatchObject({
            receipt: { outcome: 'repair_authorized', decision_revision: receipt.decision_revision + 1 },
        });
    });

    it('links only a verified MR backed by the repair grant and push receipt, returning the same historical receipt', async () => {
        const f = await fixture();
        const initial = await claim(f);
        const { receipt } = await ok<{ receipt: { proposal_revision: number; proposal_digest: string } }>(await f.call('decisions', envelope(initial)));
        expect(receipt).toMatchObject({ outcome: 'repair_authorized' });
        const lease = await claim(f);
        const payload = {
            proposal_revision: receipt.proposal_revision, proposal_digest: receipt.proposal_digest, input_revision: 1,
            repo_id: 'fixture-repo', base_commit: 'a'.repeat(40), gitlab_instance_id: 'gitlab-fixture', project_id: 23,
            source_branch: 'feedback/fixture', target_branch: 'main', head_sha: 'b'.repeat(40), check_results: [{ check_id: 'unit', status: 'passed' }],
        };
        expect(await ok(await f.call('input', lease))).toMatchObject({ repair_authorization: { delivery_mode: 'gitlab' } });
        const { gitlab_instance_id: _gitlab, project_id: _project, ...localPayload } = payload;
        expect((await f.call('operations/intent', {
            ...lease, operation_id: 'local-wrong-mode', correlation_id: 'w2-tests', operation_type: 'git.local_branch', payload: localPayload,
        })).status).toBe(409);
        const push = { ...lease, operation_id: 'push-42', correlation_id: 'w2-tests', operation_type: 'git.push_branch', payload };
        const mr = { ...push, operation_id: 'mr-42', operation_type: 'gitlab.create_merge_request' };
        expect((await f.call('operations/intent', mr)).status).toBe(409);
        await ok(await f.call('operations/intent', push));
        await ok(await f.call('operations/receipt', { ...lease, operation_id: push.operation_id, result: { head_sha: payload.head_sha } }));
        await ok(await f.call('operations/intent', mr));
        expect((await f.call('operations/receipt', { ...lease, operation_id: mr.operation_id, result: { mr_id: 47 } })).status).toBe(409);

        const observation = { ...payload, mr_id: 47, mr_iid: 4, web_url: `${gitlab}/group/repo/-/merge_requests/4`, state: 'opened', observed_at: new Date().toISOString() };
        const base = { ...lease, operation_id: mr.operation_id, input_revision: 1, proposal_revision: payload.proposal_revision, proposal_digest: payload.proposal_digest, observation };
        const content = canonicalJson({
            project_slug: f.project.slug, environment: 'qa', work_id: lease.work_id, operation_id: mr.operation_id,
            input_revision: 1, scope_revision: scopeRevision, proposal_revision: base.proposal_revision, proposal_digest: base.proposal_digest, observation,
        });
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey('raw', encoder.encode(proofKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(content));
        const proof = Array.from(new Uint8Array(digest), (num) => num.toString(16).padStart(2, '0')).join('');
        expect((await f.call('mr-links', { ...base, proof: '0'.repeat(64) })).status).toBe(409);
        const response = await ok(await f.call('mr-links', { ...base, proof }));
        expect(response).toMatchObject({ receipt: { stage: 'waiting_mr_review', outcome: 'mr_opened', mr_iid: 4, mr_id: 47 } });
        expect(await ok(await f.call('mr-links', { ...base, proof }))).toEqual(response);
        expect(await ok(await api('GET', f.teamPath, f.teamToken))).toMatchObject({ mr: { mr_iid: 4 }, work: { stage: 'waiting_mr_review' } });
        expect((await (await f.client.get(f.ownPath)).text())).not.toContain(observation.web_url);
        expect(await env.DB.prepare('SELECT status FROM reports WHERE id=?').bind(f.report.id).first('status')).toBe('new');
    });
});


async function localRepair(f: Fixture) {
    const initial = await claim(f);
    const { receipt } = await ok<{ receipt: { proposal_revision: number; proposal_digest: string } }>(await f.call('decisions', envelope(initial)));
    const lease = await claim(f);
    const observation = {
        proposal_revision: receipt.proposal_revision, proposal_digest: receipt.proposal_digest, input_revision: 1,
        repo_id: 'fixture-repo', base_commit: 'a'.repeat(40),
        source_branch: 'feedback/fixture-local', target_branch: 'main', head_sha: 'b'.repeat(40),
        check_results: [{ check_id: 'unit', status: 'passed' }],
    };
    const operationId = 'local-branch-42';
    return {
        lease,
        observation,
        intent: { ...lease, operation_id: operationId, correlation_id: 'loc-tests', operation_type: 'git.local_branch', payload: observation },
        body: { ...lease, operation_id: operationId, observation },
    };
}

describe('local delivery mode', () => {
    it('upgrades existing GitLab configuration and permits a local repo with a null project ID', async () => {
        const db = env.UPGRADE_DB;
        await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(({ name }) => name < '0018'));
        const at = '2026-10-01T00:00:00.000Z';
        await db.batch([
            db.prepare("INSERT INTO projects (id,name,slug,owner_token_hash,created_at,updated_at) VALUES (17,'Legacy','loc-upgrade','test',?,?)").bind(at, at),
            db.prepare("INSERT INTO automation_scopes (project_id,environment,scope_revision) VALUES (17,'qa','v1')"),
            db.prepare(`INSERT INTO automation_policies
                (project_id,environment,scope_revision,gitlab_instance_id,gitlab_origin,gitlab_proof_key_ref)
                VALUES (17,'qa','v1','legacy','https://gitlab.example.test','FEEDBACK_AUTOMATION_LEGACY_PROOF_KEY')`),
            db.prepare(`INSERT INTO automation_repositories
                (project_id,environment,scope_revision,repo_id,gitlab_project_id,base_branch,base_commit,branch_prefix,required_check_ids)
                VALUES (17,'qa','v1','legacy-repo',23,'release',?,'feedback/','["unit","lint"]')`).bind('a'.repeat(40)),
        ]);

        await applyD1Migrations(db, env.TEST_MIGRATIONS);
        expect(await db.prepare("SELECT * FROM automation_repositories WHERE repo_id='legacy-repo'").first()).toEqual({
            project_id: 17, environment: 'qa', scope_revision: 'v1', repo_id: 'legacy-repo', gitlab_project_id: 23,
            base_branch: 'release', base_commit: 'a'.repeat(40), branch_prefix: 'feedback/',
            required_check_ids: '["unit","lint"]', delivery_mode: 'gitlab',
        });
        expect(await db.prepare("SELECT gitlab_proof_key_ref FROM automation_policies WHERE project_id=17").first('gitlab_proof_key_ref'))
            .toBe('FEEDBACK_AUTOMATION_LEGACY_PROOF_KEY');
        await db.prepare(`INSERT INTO automation_repositories
            (project_id,environment,scope_revision,repo_id,base_branch,base_commit,branch_prefix,required_check_ids,delivery_mode)
            VALUES (17,'qa','v1','local-repo','main',?,'feedback/','["unit"]','local')`).bind('b'.repeat(40)).run();
        expect(await db.prepare("SELECT gitlab_project_id, delivery_mode FROM automation_repositories WHERE repo_id='local-repo'").first())
            .toEqual({ gitlab_project_id: null, delivery_mode: 'local' });
    });

    it('records exactly one local branch receipt without changing the report or creating an MR', async () => {
        const f = await fixture(false, 'local');
        const { lease, body, intent, observation } = await localRepair(f);
        expect(await ok(await f.call('input', lease))).toMatchObject({ repair_authorization: { delivery_mode: 'local' } });
        expect((await f.call('local-branches', body)).status).toBe(409);
        for (const operationType of ['git.push_branch', 'gitlab.create_merge_request']) {
            expect((await f.call('operations/intent', {
                ...intent, operation_type: operationType, payload: { ...observation, gitlab_instance_id: 'fixture', project_id: 23 },
            })).status).toBe(409);
        }
        expect((await f.call('operations/intent', { ...intent, payload: { ...observation, source_branch: 'outside/prefix' } })).status).toBe(409);
        expect((await f.call('operations/intent', { ...intent, payload: { ...observation, proposal_digest: 'd'.repeat(64) } })).status).toBe(409);
        expect((await f.call('operations/intent', { ...intent, payload: { ...observation, check_results: [{ check_id: 'lint', status: 'passed' }] } })).status).toBe(409);
        await ok(await f.call('operations/intent', intent));
        expect((await f.call('operations/receipt', { ...lease, operation_id: body.operation_id, result: observation })).status).toBe(409);
        expect((await f.call('local-branches', { ...body, observation: { ...observation, head_sha: 'c'.repeat(40) } })).status).toBe(409);
        const [first, second] = await Promise.all([
            f.call('local-branches', body).then(ok), f.call('local-branches', body).then(ok),
        ]);
        expect(first).toEqual(second);
        expect(first).toEqual({ receipt: {
            operation_id: body.operation_id, work_id: lease.work_id, input_revision: 1, applied_report_revision: lease.report_revision,
            stage: 'waiting_review', next_action: null, outcome: 'local_branch_ready', repo_id: observation.repo_id,
            source_branch: observation.source_branch, target_branch: observation.target_branch, head_sha: observation.head_sha,
        } });
        expect(await ok(await f.call('local-branches', body))).toEqual(first);
        expect((await f.call('local-branches', { ...body, observation: { ...observation, head_sha: 'd'.repeat(40) } })).status).toBe(409);
        expect(await ok(await f.call('claim', { worker_id: 'operator', scope_revision: scopeRevision }))).toEqual({ work: null });
        expect(await ok(await api('GET', f.teamPath, f.teamToken))).toMatchObject({
            work: { stage: 'waiting_review', next_action: null, outcome: 'local_branch_ready' }, mr: null,
            local_branch: { ...observation, operation_id: body.operation_id, recorded_at: expect.any(String) },
        });
        expect((await (await f.client.get(f.ownPath)).text())).not.toContain(observation.source_branch);
        expect(await env.DB.prepare('SELECT status FROM reports WHERE id=?').bind(f.report.id).first('status')).toBe('new');
        expect(await env.DB.prepare('SELECT COUNT(*) n FROM messages WHERE report_id=?').bind(f.report.id).first('n')).toBe(0);
        expect(await env.DB.prepare('SELECT COUNT(*) n FROM automation_local_branches WHERE work_id=?').bind(lease.work_id).first('n')).toBe(1);
        expect(await env.DB.prepare('SELECT COUNT(*) n FROM automation_mr_links WHERE work_id=?').bind(lease.work_id).first('n')).toBe(0);
    });

    it('rejects a local receipt when the approved delivery mode changes before it is recorded', async () => {
        const f = await fixture(false, 'local');
        const { body, intent, lease } = await localRepair(f);
        await ok(await f.call('operations/intent', intent));
        await env.DB.prepare("UPDATE automation_repositories SET delivery_mode='gitlab', gitlab_project_id=23 WHERE project_id=?").bind(f.project.id).run();
        expect((await f.call('input', lease)).status).toBe(409);
        expect((await f.call('local-branches', body)).status).toBe(409);
        expect(await env.DB.prepare('SELECT COUNT(*) n FROM automation_local_branches WHERE work_id=?').bind(body.work_id).first('n')).toBe(0);
    });

    it('rejects an unrecorded local branch result after the customer changes the input', async () => {
        const f = await fixture(false, 'local');
        const { body, intent } = await localRepair(f);
        await ok(await f.call('operations/intent', intent));
        expect((await f.client.post(`${f.ownPath}/messages`, { body: '補上重現步驟' })).status).toBe(302);
        expect((await f.call('local-branches', body)).status).toBe(409);
        expect(await env.DB.prepare('SELECT COUNT(*) n FROM automation_local_branches WHERE work_id=?').bind(body.work_id).first('n')).toBe(0);
    });
});
