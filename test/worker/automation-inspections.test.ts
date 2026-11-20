import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_EXAMPLE } from '../../src/shared/automation-analysis.mjs';
import type { Lease } from '../../src/worker/lib/automation';
import type { InspectionLink } from '../../src/worker/lib/automation-inspections';
import { randomString, sha256Hex } from '../../src/worker/lib/crypto';
import { api, BASE, Browser, seedClientAccount, seedDeveloper, seedProject, seedReport, seedToken, workerEnv, type SeededProject } from './helpers';
import { createToken } from '../../src/worker/lib/team';

const revision = 'inspections-v1';
const workspace = 'workspace-demo';
const testId = 'test-cart';
const check = 'cart-visible';
const signature = 'v1:' + 'a'.repeat(64);
const startedAt = '2026-10-14T09:00:00.000Z';
const finishedAt = '2026-10-14T09:00:15.000Z';

async function fixture(seed?: SeededProject, environment = 'stage', sourceInstance?: string, customerIngress = 0) {
    const seeded = seed ?? await seedProject();
    const { id, slug } = seeded.project;
    const source = sourceInstance ?? slug + '-whippet';
    const bridge = 'fdi_' + randomString(48);
    const worker = 'fda_' + randomString(48);
    await env.DB.batch([
        env.DB.prepare(`INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress, inspection_ingress)
            VALUES (?, ?, ?, ?, 1)`).bind(id, environment, revision, customerIngress),
        env.DB.prepare(`INSERT INTO automation_inspection_tokens (token_hash, project_id, environment, source_instance)
            VALUES (?, ?, ?, ?)`).bind(await sha256Hex(bridge), id, environment, source),
        env.DB.prepare(`INSERT INTO automation_inspection_targets (project_id, environment, scope_revision, source_instance, workspace_id, test_id, check_key)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(id, environment, revision, source, workspace, testId, check),
        env.DB.prepare('INSERT INTO automation_tokens (token_hash, project_id, environment) VALUES (?, ?, ?)')
            .bind(await sha256Hex(worker), id, environment),
    ]);
    const path = `${BASE}/api/automation/${slug}/${environment}`;
    return { seeded, id, slug, bridge, worker, environment, source, path };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Receipt = {
    event_id: string;
    operation_id: string;
    outcome: 'linked' | 'ignored';
    report_public_id: string | null;
    ignored_reason?: string;
} & Omit<InspectionLink, 'report_public_id'>;

function event(f: Fixture, runId: string) {
    return {
        schema_version: 1, event_type: 'whippet.run_finished', source: 'whippet', event_id: 'event-' + runId, operation_id: 'op-' + runId,
        scope: { project_slug: f.slug, environment: f.environment }, scope_revision: revision, occurred_at: finishedAt,
        payload: {
            workspace_id: workspace, test_id: testId, version_id: 'published-v1', run_id: runId, attempt_id: 'attempt-' + runId,
            started_at: startedAt, purpose: 'inspection', status: 'failed', failure_kind: 'assertion',
            check_key: check, failure_signature: signature, summary: '購物車頁面沒有顯示已選商品。 password=fixture-secret',
            evidence_refs: ['whippet:run:' + runId],
        },
    };
}

function request(f: Fixture, endpoint: string, body?: object, token = f.bridge) {
    return exports.default.fetch(new Request(`${f.path}/${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    }));
}

async function ok<T>(response: Response): Promise<T> {
    const body = await response.text();
    expect(response.status, body).toBe(200);
    return JSON.parse(body) as T;
}

async function ingest(f: Fixture, data: ReturnType<typeof event>) {
    return (await ok<{ receipt: Receipt }>(await request(f, 'inspection-events', data))).receipt;
}

async function count(project: Fixture, table: 'reports' | 'automation_work' | 'automation_inspection_runs' | 'automation_inspection_receipts') {
    return env.DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).bind(project.id).first<number>('n');
}

async function claim(f: Fixture) {
    const row = (await ok<{ work: Lease | null }>(await request(f, 'claim', { worker_id: 'worker-w3', scope_revision: revision }, f.worker))).work;
    if (!row) throw new Error('expected one inspection work');
    const { work_id, report_public_id, report_revision, lease_generation, scope_revision, worker_id } = row;
    return { work_id, report_public_id, report_revision, lease_generation, scope_revision, worker_id };
}

describe('W3 scoped Whippet inspections', () => {
    it('coalesces concurrent Runs and identical replays into one team report and one W1 work', async () => {
        const f = await fixture();
        const first = event(f, 'run-a');
        const second = event(f, 'run-b');
        second.payload.version_id = 'published-v2';
        second.occurred_at = '2026-10-14T10:00:15.000Z';
        const [a, b, retry] = await Promise.all([ingest(f, first), ingest(f, second), ingest(f, first)]);
        expect(a).toEqual(retry);
        expect(a.outcome).toBe('linked');
        expect(b.report_public_id).toBe(a.report_public_id);
        expect(await count(f, 'reports')).toBe(1);
        expect(await count(f, 'automation_work')).toBe(1);
        expect(await count(f, 'automation_inspection_runs')).toBe(2);
        expect(await count(f, 'automation_inspection_receipts')).toBe(2);
        expect(await env.DB.prepare('SELECT first_failed_at, last_failed_at FROM automation_inspection_groups WHERE report_public_id=?')
            .bind(a.report_public_id).first()).toEqual({ first_failed_at: first.occurred_at, last_failed_at: second.occurred_at });

        const alias = await ingest(f, { ...first, event_id: 'alias-a', operation_id: 'alias-a' });
        expect(alias.report_public_id).toBe(a.report_public_id);
        expect(await count(f, 'automation_inspection_runs')).toBe(2);
        expect((await request(f, 'inspection-events', { ...first, event_id: 'different-id' })).status).toBe(409);
        expect((await request(f, 'inspection-events', { ...first, payload: { ...first.payload, summary: '變更內容' } })).status).toBe(409);
        expect((await request(f, 'inspection-events', { ...first, event_id: 'new-attempt', operation_id: 'new-attempt',
            payload: { ...first.payload, attempt_id: 'new-attempt' } })).status).toBe(409);
        const lease = await claim(f);
        expect(lease.report_public_id).toBe(a.report_public_id);
        expect(await ok(await request(f, 'renew', lease, f.worker))).toMatchObject({ work: lease });
        expect(await ok(await request(f, 'input', lease, f.worker))).toMatchObject({
            report: { description: expect.stringContaining('購物車頁面沒有顯示已選商品。 password=[已遮罩]') },
        });
        expect(await count(f, 'automation_work')).toBe(1);
    });

    it('lists pending Whippet links after a lost response and acknowledges them idempotently', async () => {
        const f = await fixture();
        const data = event(f, 'run-link');
        const receipt = await ingest(f, data);
        const link = { workspace_id: workspace, run_id: receipt.run_id, attempt_id: receipt.attempt_id, report_public_id: receipt.report_public_id };
        expect(await ok(await request(f, 'inspection-links'))).toEqual({ links: [link] });
        expect((await request(f, 'inspection-links', { ...link, attempt_id: 'different-attempt' })).status).toBe(409);
        expect(await ok(await request(f, 'inspection-links', link))).toEqual({ link });
        expect(await ok(await request(f, 'inspection-links', link))).toEqual({ link });
        expect(await ok(await request(f, 'inspection-links'))).toEqual({ links: [] });
        expect(await ingest(f, data)).toEqual(receipt);
        expect(await ok(await request(f, 'inspection-links'))).toEqual({ links: [] });
    });

    it('isolates project, environment, source and check permissions from the W1 token', async () => {
        const f = await fixture();
        const otherEnv = await fixture(f.seeded, 'other-stage', f.source, 1);
        const otherProject = await fixture();
        const data = event(f, 'run-scope');
        expect((await request(f, 'inspection-events', data, f.worker)).status).toBe(401);
        expect((await request(f, 'claim', { worker_id: 'bridge', scope_revision: revision })).status).toBe(401);
        expect((await request(otherEnv, 'inspection-events', data, f.bridge)).status).toBe(403);
        expect((await request(otherProject, 'inspection-events', data, f.bridge)).status).toBe(403);
        expect((await request(f, 'inspection-events', { ...data, scope: { ...data.scope, environment: 'different' } })).status).toBe(403);
        expect((await request(f, 'inspection-events', { ...data, scope_revision: 'obsolete' })).status).toBe(409);
        expect((await request(f, 'inspection-events', { ...data, payload: { ...data.payload, test_id: 'other-test' } })).status).toBe(403);
        expect((await request(f, 'inspection-events', { ...data, payload: { ...data.payload, status: 'passed' } })).status).toBe(400);
        expect((await request(f, 'inspection-events', { ...data, payload: { ...data.payload, failure_kind: 'infrastructure' } })).status).toBe(400);
        expect((await request(f, 'inspection-events', { ...data, payload: { ...data.payload, purpose: 'draft_validation' } })).status).toBe(400);
        expect((await request(f, 'inspection-events', { ...data, payload: { ...data.payload, evidence_refs: ['https://example.invalid'] } })).status).toBe(400);
        expect(await count(f, 'reports')).toBe(0);

        const a = await ingest(f, data);
        const b = await ingest(otherEnv, event(otherEnv, 'another-run'));
        expect(a.report_public_id).not.toBe(b.report_public_id);
        expect(await count(f, 'reports')).toBe(2);
        expect((await claim(f)).report_public_id).toBe(a.report_public_id);
        expect((await claim(otherEnv)).report_public_id).toBe(b.report_public_id);
        await env.DB.prepare("UPDATE automation_inspection_tokens SET revoked_at='2026-10-15' WHERE token_hash=?")
            .bind(await sha256Hex(f.bridge)).run();
        expect((await request(f, 'inspection-events', data)).status).toBe(401);
        expect((await request(otherEnv, 'inspection-links')).status).toBe(200);
    });

    it('preserves historical receipts and opens a linked recurrence only for a post-closure Run', async () => {
        const f = await fixture();
        const first = event(f, 'run-first');
        const original = await ingest(f, first);
        await env.DB.prepare("UPDATE reports SET status='completed' WHERE public_id=?").bind(original.report_public_id).run();
        expect(await ingest(f, first)).toEqual(original);
        const late = event(f, 'run-preclose');
        late.occurred_at = new Date(Date.now() + 2000).toISOString();
        expect(await ingest(f, late)).toMatchObject({ outcome: 'ignored', report_public_id: null, ignored_reason: 'stale_run' });
        const after = event(f, 'run-postclose');
        after.payload.started_at = new Date(Date.now() + 1000).toISOString();
        after.occurred_at = new Date(Date.now() + 2000).toISOString();
        const recurrence = await ingest(f, after);
        expect(recurrence.outcome).toBe('linked');
        expect(recurrence.report_public_id).not.toBe(original.report_public_id);
        expect(await env.DB.prepare('SELECT previous_report_public_id FROM automation_inspection_groups WHERE report_public_id=?')
            .bind(recurrence.report_public_id).first('previous_report_public_id')).toBe(original.report_public_id);
        expect(await ingest(f, event(f, 'run-older-late'))).toMatchObject({ outcome: 'ignored', report_public_id: null });
        expect(await count(f, 'automation_work')).toBe(2);
        expect(await count(f, 'reports')).toBe(2);
    });

    it('revokes only the affected ingress when a scope disables inspections or customer automation', async () => {
        const f = await fixture(await seedProject(), 'shared', undefined, 1);
        const inspection = await ingest(f, event(f, 'run-disable'));
        const inspectionLease = await claim(f);
        expect(inspectionLease.report_public_id).toBe(inspection.report_public_id);
        const { report: customer } = await seedReport(f.seeded.project);
        const change = (column: 'inspection_ingress' | 'customer_ingress', enabled: number) =>
            env.DB.prepare(`UPDATE automation_scopes SET ${column}=? WHERE project_id=? AND environment=?`)
                .bind(enabled, f.id, f.environment).run();
        await change('inspection_ingress', 0);
        expect((await request(f, 'renew', inspectionLease, f.worker)).status).toBe(409);
        expect((await request(f, 'inspection-events', event(f, 'new-disabled-run'))).status).toBe(403);
        const customerLease = await claim(f);
        expect(customerLease.report_public_id).toBe(customer.public_id);
        expect(await env.DB.prepare('SELECT outcome FROM automation_work_attempts WHERE work_id=? AND lease_generation=?')
            .bind(inspectionLease.work_id, inspectionLease.lease_generation).first('outcome')).toBe('scope_paused');
        await change('inspection_ingress', 1);
        const newLease = await claim(f);
        expect(newLease.work_id).toBe(inspectionLease.work_id);
        expect(newLease.lease_generation).toBe(inspectionLease.lease_generation + 1);
        await change('customer_ingress', 0);
        expect((await request(f, 'renew', customerLease, f.worker)).status).toBe(409);
        expect((await request(f, 'renew', newLease, f.worker)).status).toBe(200);
        await env.DB.prepare('DELETE FROM automation_inspection_targets WHERE project_id=?').bind(f.id).run();
        expect((await request(f, 'renew', newLease, f.worker)).status).toBe(409);
    });

    it('keeps evidence team-only and blocks auto-reply in the same customer-enabled scope', async () => {
        const seeded: SeededProject = await seedProject();
        const f = await fixture(seeded, 'qa', undefined, 1);
        const reviewer = await seedDeveloper();
        const teamToken = await seedToken(reviewer.developer);
        const { account } = await seedClientAccount(seeded.project);
        const customerToken = (await createToken(workerEnv, { clientAccountId: account.id }, 'inspection-private', Date.now())).token;
        await env.DB.batch([
            env.DB.prepare('INSERT INTO automation_policies (project_id,environment,scope_revision,auto_reply) VALUES (?, ?, ?, 1)')
                .bind(f.id, f.environment, revision),
            env.DB.prepare('INSERT INTO automation_reviewers (project_id,environment,developer_id) VALUES (?, ?, ?)')
                .bind(f.id, f.environment, reviewer.developer.id),
        ]);
        const data = event(f, 'run-private');
        data.payload.summary += '\n' + f.bridge;
        const receipt = await ingest(f, data);
        const reportPath = `/p/${f.slug}/reports/${receipt.report_public_id}`;
        const teamPath = `/projects/${f.slug}/reports/${receipt.report_public_id}/automation/${f.environment}`;
        const client = await new Browser().asClient(seeded);
        expect((await client.get(reportPath)).ok).toBe(false);
        expect((await api('GET', teamPath, customerToken)).status).toBe(403);
        const team = await ok(await api('GET', teamPath, teamToken));
        expect(JSON.stringify(team)).not.toContain(f.bridge);
        expect(team).toMatchObject({
            inspection: { occurrence_count: 1, runs: [{ evidence_refs: ['whippet:run:run-private'], summary: expect.not.stringContaining('fixture-secret') }] },
        });
        const lease = await claim(f);
        const { proposal: _proposal, ...analysis } = structuredClone(ANALYSIS_EXAMPLE);
        const approval = { ...lease, input_revision: 1, operation_id: 'decision-private', correlation_id: 'w3-test',
            analysis: { ...analysis, classification: 'explanation', customer_body: '請重新整理頁面。' } };
        expect(await ok(await request(f, 'decisions', approval, f.worker))).toMatchObject({
            receipt: { outcome: 'business_review', stage: 'waiting_review' },
        });
        await env.DB.prepare('UPDATE reports SET shared_with_client=1 WHERE public_id=?').bind(receipt.report_public_id).run();
        const shared = await client.get(reportPath);
        expect(shared.status).toBe(200);
        const html = await shared.text();
        expect(html).not.toContain('whippet:run:run-private');
        expect(html).not.toContain('購物車頁面沒有顯示已選商品');
        expect(html).not.toContain('請重新整理頁面。');
    });
});
