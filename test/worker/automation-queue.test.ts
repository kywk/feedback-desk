import { applyD1Migrations } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Lease } from '../../src/worker/lib/automation';
import { randomString, sha256Hex } from '../../src/worker/lib/crypto';
import { api, BASE, Browser, seedDeveloper, seedProject, seedReport, seedToken, type SeededProject } from './helpers';

const ENVIRONMENT = 'qa';
const REVISION = 'scope-v1';

type Work = Lease & {
    stage: string;
    progress: Record<string, unknown> | null;
    lease_expires_at: string;
};
type Events = {
    events: Array<{ event_id: string; payload: { report_public_id: string; report_revision: number; message_id?: number } }>;
    next_cursor: string;
};

async function credential(seeded: SeededProject, environment = ENVIRONMENT): Promise<string> {
    const token = `fda_${randomString(48)}`;
    await env.DB.prepare('INSERT INTO automation_tokens (project_id, environment, token_hash) VALUES (?, ?, ?)')
        .bind(seeded.project.id, environment, await sha256Hex(token)).run();
    return token;
}

async function enable(seeded: SeededProject, { backfill = 0, environment = ENVIRONMENT, ingress = 1 } = {}) {
    await env.DB.prepare('INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress, backfill_unclaimed) VALUES (?, ?, ?, ?, ?)')
        .bind(seeded.project.id, environment, REVISION, ingress, backfill).run();
    return credential(seeded, environment);
}

async function call(seeded: SeededProject, token: string | null, endpoint: string, body?: object, environment = ENVIRONMENT) {
    const headers = new Headers({ accept: 'application/json' });
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body) headers.set('content-type', 'application/json');
    return exports.default.fetch(new Request(`${BASE}/api/automation/${seeded.project.slug}/${environment}/${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
    }));
}

async function json<T>(response: Response): Promise<T> {
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as T;
}

function claim(seeded: SeededProject, token: string, workerId = 'worker-a') {
    return call(seeded, token, 'claim', { worker_id: workerId, scope_revision: REVISION }).then(json<{ work: Work | null }>);
}

function fence(work: Work): Lease {
    const { worker_id, work_id, report_public_id, report_revision, lease_generation, scope_revision } = work;
    return { worker_id, work_id, report_public_id, report_revision, lease_generation, scope_revision };
}

async function customerReport(seeded: SeededProject, client: Browser) {
    const path = `/p/${seeded.project.slug}/reports`;
    const created = await client.post(path, { 'issues[0][title]': '開單', 'issues[0][description]': '客戶內容' });
    expect(created.status).toBe(302);
    const id = await env.DB.prepare('SELECT public_id FROM reports WHERE project_id = ? ORDER BY id DESC LIMIT 1').bind(seeded.project.id).first<string>('public_id');
    expect(id).toBeTruthy();
    return { id, url: `${path}/${id}` };
}

describe('scoped automation queue', () => {
    it('queues ordinary customer input atomically, pages events, and fences earlier work after a reply', async () => {
        const seeded = await seedProject();
        const token = await enable(seeded);
        const client = await new Browser().asClient(seeded);
        const { id, url } = await customerReport(seeded, client);
        const firstPage = await json<Events>(await call(seeded, token, 'events?after=0'));
        expect(firstPage.events).toEqual([expect.objectContaining({
            event_type: 'report.created', payload: { report_public_id: id, report_revision: 1 },
        })]);
        expect(await json(await call(seeded, token, `events?after=${firstPage.next_cursor}`))).toEqual({ events: [], next_cursor: firstPage.next_cursor });

        const { work: first } = await claim(seeded, token);
        expect(first).toMatchObject({ report_public_id: id, report_revision: 1, lease_generation: 1, stage: 'queued' });
        const uploaded = await client.uploadId(seeded.project.slug, `purpose=message&report=${id}`);
        expect((await client.post(`${url}/messages`, { body: '顯示結果', 'upload_ids[]': uploaded })).status).toBe(302);

        const secondPage = await json<Events>(await call(seeded, token, `events?after=${firstPage.next_cursor}`));
        expect(secondPage.events).toHaveLength(1);
        const [event] = secondPage.events;
        expect(event).toMatchObject({ event_type: 'report.customer_replied', payload: { report_public_id: id, message_id: expect.any(Number) } });
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?').bind(event.payload.message_id ?? 0).first('n')).toBe(1);
        expect(await json(await call(seeded, token, `events?after=${firstPage.next_cursor}`))).toEqual(secondPage);

        expect((await call(seeded, token, 'progress', { ...fence(first!), stage: 'running' })).status).toBe(409);
        const { work: next } = await claim(seeded, token);
        expect(next).toMatchObject({ report_public_id: id, report_revision: event.payload.report_revision, lease_generation: 1 });
        expect(next?.work_id).not.toBe(first?.work_id);
        expect((await claim(seeded, token)).work).toBeNull();
        expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM automation_work WHERE report_public_id = ?').bind(id).first('n')).toBe(2);
    });

    it('serializes claims and preserves checkpoints through retry, expiry and renewal', async () => {
        const seeded = await seedProject();
        const token = await enable(seeded);
        await seedReport(seeded.project);
        const results = await Promise.all([claim(seeded, token), claim(seeded, token, 'worker-b')]);
        const active = results.flatMap(({ work }) => work ? [work] : []);
        expect(active).toHaveLength(1);
        const first = fence(active[0]);
        const checkpoint = { step: 'read-report', attempts: 1 };
        await json(await call(seeded, token, 'progress', { ...first, stage: 'running', progress: checkpoint }));
        const oldDate = '2000-01-01T00:00:00.000Z';
        await env.DB.prepare('UPDATE automation_work SET lease_expires_at = ? WHERE work_id = ?').bind(oldDate, first.work_id).run();
        expect((await call(seeded, token, 'renew', first)).status).toBe(409);

        const reclaimed = await claim(seeded, token, 'replacement');
        expect(reclaimed.work).toMatchObject({ work_id: first.work_id, lease_generation: 2, stage: 'running', progress: checkpoint });
        const second = fence(reclaimed.work!);
        expect((await call(seeded, token, 'progress', { ...first, stage: 'blocked' })).status).toBe(409);
        expect((await call(seeded, await credential(seeded), 'renew', second)).status).toBe(409);
        const renewed = await json<{ work: Work }>(await call(seeded, token, 'renew', second));
        expect(Date.parse(renewed.work.lease_expires_at)).toBeGreaterThan(Date.now());

        const retryAt = new Date(Date.now() + 60_000).toISOString();
        expect(await json(await call(seeded, token, 'progress', { ...second, stage: 'queued', retry_at: retryAt }))).toMatchObject({
            work: { lease_expires_at: null, progress: checkpoint, retry_at: retryAt },
        });
        expect((await claim(seeded, token)).work).toBeNull();
        await env.DB.prepare('UPDATE automation_work SET retry_at = ? WHERE work_id = ?').bind(oldDate, first.work_id).run();
        const resumed = await claim(seeded, token);
        expect(resumed.work).toMatchObject({ work_id: first.work_id, lease_generation: 3, stage: 'queued', progress: checkpoint });
        await json(await call(seeded, token, 'progress', { ...fence(resumed.work!), stage: 'waiting_review' }));
        expect((await claim(seeded, token)).work).toBeNull();
        const attempts = await env.DB.prepare(
            'SELECT lease_generation, worker_id, outcome, retry_at FROM automation_work_attempts WHERE work_id = ? ORDER BY lease_generation',
        ).bind(first.work_id).all();
        expect(attempts.results).toEqual([
            { lease_generation: 1, worker_id: first.worker_id, outcome: 'lease_expired', retry_at: null },
            { lease_generation: 2, worker_id: 'replacement', outcome: 'retry_scheduled', retry_at: retryAt },
            { lease_generation: 3, worker_id: 'worker-a', outcome: 'waiting_review', retry_at: null },
        ]);
    });

    it('replays operation receipts and rejects changed content, versions, and manual handoff', async () => {
        const seeded = await seedProject();
        const token = await enable(seeded);
        const client = await new Browser().asClient(seeded);
        const { id, url } = await customerReport(seeded, client);
        const first = fence((await claim(seeded, token)).work!);
        const metadata = { operation_id: 'operation-1', operation_type: 'w1_fixture', correlation_id: 'integration-test' };
        const intent = { ...first, ...metadata, payload: { b: 2, a: 1 } };
        expect((await call(seeded, token, 'operations/receipt', { ...first, operation_id: metadata.operation_id, result: { accepted: true } })).status).toBe(409);
        const pending = await json(await call(seeded, token, 'operations/intent', intent));
        expect(await json(await call(seeded, token, 'operations/intent', { ...intent, payload: { a: 1, b: 2 } }))).toEqual(pending);
        expect((await call(seeded, token, 'operations/intent', { ...intent, payload: { a: 9 } })).status).toBe(409);

        const body = { ...first, operation_id: metadata.operation_id, result: { external_id: 'example-1' } };
        const receipts = await Promise.all([
            call(seeded, token, 'operations/receipt', body).then(json<{ receipt: object }>),
            call(seeded, token, 'operations/receipt', body).then(json<{ receipt: object }>),
        ]);
        expect(receipts[0]).toEqual(receipts[1]);
        expect(await json(await call(seeded, token, 'operations/intent', intent))).toMatchObject({ intent: { receipt: receipts[0].receipt } });
        expect((await call(seeded, token, 'operations/receipt', { ...body, result: { external_id: 'different' } })).status).toBe(409);

        await env.DB.prepare('UPDATE automation_work SET lease_expires_at = ? WHERE work_id = ?').bind('2000-01-01T00:00:00.000Z', first.work_id).run();
        expect((await call(seeded, token, 'operations/receipt', body)).status).toBe(409);
        const successor = fence((await claim(seeded, token, 'worker-b')).work!);
        expect(await json(await call(seeded, token, 'operations/receipt', { ...body, ...successor }))).toEqual(receipts[0]);

        expect((await client.post(`${url}/update`, { title: '更正標題', description: '客戶內容' })).status).toBe(302);
        expect((await call(seeded, token, 'renew', successor)).status).toBe(409);
        const replacement = (await claim(seeded, token)).work!;
        expect(replacement).toMatchObject({ work_id: first.work_id, lease_generation: 3, progress: null });
        expect(replacement.report_revision).toBeGreaterThan(first.report_revision);

        const human = await seedToken((await seedDeveloper()).developer);
        const claimUrl = `/projects/${seeded.project.slug}/reports/${id}`;
        expect((await api('POST', `${claimUrl}/claim`, human, {})).status).toBe(200);
        expect((await call(seeded, token, 'operations/intent', { ...intent, ...fence(replacement), operation_id: 'operation-2' })).status).toBe(409);
        expect((await api('POST', `${claimUrl}/release`, human, {})).status).toBe(200);
        expect((await client.post(`${url}/messages`, { body: '補資料' })).status).toBe(302);
        expect((await claim(seeded, token)).work).toBeNull();
        expect(await json(await call(seeded, token, 'events'))).toMatchObject({
            events: [expect.anything(), { ignored_reason: 'manual_takeover' }],
        });
        const visible = await (await client.get(url)).text();
        expect(visible).not.toContain('operation-1');
        expect(visible).not.toContain('manual_takeover');
    });

    it('uses project- and environment-bound credentials and independently revokes them', async () => {
        const a = await seedProject();
        const b = await seedProject();
        const aToken = await enable(a);
        const bToken = await enable(b);
        const aOther = await enable(a, { environment: 'other', ingress: 0 });
        const { report: aReport } = await seedReport(a.project);
        const { report: bReport } = await seedReport(b.project);
        const { work } = await claim(a, aToken);
        expect(work?.report_public_id).toBe(aReport.public_id);
        expect((await call(a, null, 'events')).status).toBe(401);
        expect((await call(a, a.ownerToken, 'events')).status).toBe(401);
        expect((await call(b, aToken, 'events')).status).toBe(403);
        expect((await call(a, aOther, 'events')).status).toBe(403);
        expect(await json(await call(a, aOther, 'events', undefined, 'other'))).toEqual({ events: [], next_cursor: '0' });
        expect((await call(b, bToken, 'renew', fence(work!))).status).toBe(409);
        expect((await claim(b, bToken)).work?.report_public_id).toBe(bReport.public_id);
        expect((await call(a, aToken, 'claim', { worker_id: 'worker-a', scope_revision: 'stale' })).status).toBe(409);

        const rotated = await credential(a);
        await env.DB.prepare('UPDATE automation_tokens SET revoked_at = ? WHERE token_hash = ?').bind(new Date().toISOString(), await sha256Hex(aToken)).run();
        expect((await call(a, aToken, 'renew', fence(work!))).status).toBe(401);
        expect((await claim(a, rotated)).work).toMatchObject({ work_id: work?.work_id, lease_generation: 2 });
        await env.DB.prepare('UPDATE automation_scopes SET enabled = 0 WHERE project_id = ? AND environment = ?').bind(a.project.id, ENVIRONMENT).run();
        expect((await call(a, rotated, 'events')).status).toBe(403);
    });

    it('backfills unclaimed old customer reports only when enabled, without re-enqueuing held or blocked work', async () => {
        const seeded = await seedProject();
        const { report: old } = await seedReport(seeded.project);
        const { report: held } = await seedReport(seeded.project);
        const human = await seedToken((await seedDeveloper()).developer);
        const claimPath = `/projects/${seeded.project.slug}/reports/${held.public_id}/claim`;
        expect((await api('POST', claimPath, human, {})).status).toBe(200);
        await seedReport(seeded.project, { creator: 'owner_shared' });
        await seedReport(seeded.project, { creator: 'public' });
        const token = await enable(seeded);
        expect((await claim(seeded, token)).work).toBeNull();
        const config = env.DB.prepare('UPDATE automation_scopes SET backfill_unclaimed = ? WHERE project_id = ? AND environment = ?');
        await config.bind(1, seeded.project.id, ENVIRONMENT).run();
        const { work } = await claim(seeded, token);
        expect(work?.report_public_id).toBe(old.public_id);
        await json(await call(seeded, token, 'progress', { ...fence(work!), stage: 'blocked', progress: { why: 'missing evidence' } }));
        await config.bind(0, seeded.project.id, ENVIRONMENT).run();
        await config.bind(1, seeded.project.id, ENVIRONMENT).run();
        expect((await claim(seeded, token)).work).toBeNull();
        expect((await json<Events>(await call(seeded, token, 'events'))).events).toHaveLength(1);
    });

    it('preserves pre-migration team ownership when enabling rollout on an existing database', async () => {
        const db = env.UPGRADE_DB;
        await applyD1Migrations(db, env.TEST_MIGRATIONS.filter(({ name }) => name < '0016'));
        const at = '2026-10-01T00:00:00.000Z';
        await db.batch([
            db.prepare("INSERT INTO projects (id, name, slug, owner_token_hash, created_at, updated_at) VALUES (1, 'Old project', 'old', 'fixture', ?, ?)").bind(at, at),
            db.prepare("INSERT INTO developers (id, name, username, password_hash, created_at, updated_at) VALUES (1, 'Developer', 'developer', 'fixture', ?, ?)").bind(at, at),
            db.prepare(
                `INSERT INTO reports (project_id, public_id, reporter_token_hash, title, description, claimed_by_developer_id, claimed_at, latest_activity_at, created_at, updated_at)
                 VALUES (1, 'already-held', 'fixture', 'Held', '', 1, ?1, ?1, ?1, ?1),
                     (1, 'open-unclaimed', 'fixture', 'Available', '', NULL, NULL, ?1, ?1, ?1)`,
            ).bind(at),
        ]);
        await applyD1Migrations(db, env.TEST_MIGRATIONS);
        await db.batch([
            db.prepare("UPDATE reports SET claimed_by_developer_id = NULL, claimed_at = NULL WHERE public_id = 'already-held'"),
            db.prepare("INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress, backfill_unclaimed) VALUES (1, 'qa', 'v1', 1, 1)"),
        ]);
        expect((await db.prepare('SELECT report_public_id FROM automation_work').all()).results).toEqual([{ report_public_id: 'open-unclaimed' }]);
    });
});
