import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/worker/lib/crypto';
import { BASE, Browser, seedProject, unique } from '../worker/helpers';

type Work = { work_id: string; worker_id: string; report_public_id: string; report_revision: number; scope_revision: string; lease_generation: number; stage: string };
type Event = { event_id: string; event_type: string; payload: { report_public_id: string; report_revision: number; message_id?: number } };
const scope = 'qa';
const revision = 'w1-r1';
async function fixture() {
    const a = await seedProject(); const b = await seedProject();
    const tokenA = `fda_${crypto.randomUUID()}${crypto.randomUUID()}`;
    const tokenB = `fda_${crypto.randomUUID()}${crypto.randomUUID()}`;
    for (const [project, token] of [[a.project, tokenA], [b.project, tokenB]] as const) {
        await env.DB.prepare('INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress, backfill_unclaimed) VALUES (?, ?, ?, 1, 0)').bind(project.id, scope, revision).run();
        await env.DB.prepare('INSERT INTO automation_tokens (project_id, environment, token_hash) VALUES (?, ?, ?)').bind(project.id, scope, await sha256Hex(token)).run();
    }
    return { a, b, tokenA, tokenB, client: await new Browser().asClient(a) };
}
async function automation(slug: string, token: string | null, endpoint: string, body?: unknown) {
    const headers = new Headers({ accept: 'application/json' });
    if (token) headers.set('authorization', `Bearer ${token}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return exports.default.fetch(new Request(`${BASE}/api/automation/${slug}/${scope}${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}
function lease(work: Work) { return { worker_id: work.worker_id, work_id: work.work_id, report_public_id: work.report_public_id, report_revision: work.report_revision, scope_revision: work.scope_revision, lease_generation: work.lease_generation }; }
async function rows(publicId: string) {
    return (await env.DB.prepare('SELECT work_id, input_revision, report_revision, stage, worker_id, lease_generation, revoked_reason FROM automation_work WHERE report_public_id = ? ORDER BY input_revision').bind(publicId).all<{ work_id: string; input_revision: number; report_revision: number; stage: string; worker_id: string | null; lease_generation: number; revoked_reason: string | null }>()).results;
}

describe('W1 real customer ingress and D1 queue', () => {
    it('deduplicates cursor replay, fences the old lease on follow-up and isolates client output', async () => {
        const { a, b, tokenA, client } = await fixture();
        const slug = a.project.slug; const title = unique('W1-客戶');
        expect((await client.post(`/p/${slug}/reports`, { 'issues[0][title]': title, 'issues[0][description]': '操作無法完成' })).status).toBe(302);
        const report = await env.DB.prepare('SELECT public_id FROM reports WHERE project_id = ? AND title = ?').bind(a.project.id, title).first<{ public_id: string }>();
        expect(report).not.toBeNull(); const id = report!.public_id;
        const firstResponse = await automation(slug, tokenA, '/events?after=0');
        expect(firstResponse.status).toBe(200);
        const first = await firstResponse.json() as { events: Event[]; next_cursor: string };
        expect(first.events).toHaveLength(1); expect(first.events[0]).toMatchObject({ event_type: 'report.created', payload: { report_public_id: id } });
        expect(first.next_cursor).not.toBe('0');
        const repeated = await (await automation(slug, tokenA, '/events?after=0')).json();
        expect(repeated).toEqual(first);
        const empty = await (await automation(slug, tokenA, `/events?after=${first.next_cursor}`)).json() as { events: Event[]; next_cursor: string };
        expect(empty.events).toEqual([]); expect(empty.next_cursor).toBe(first.next_cursor);
        expect(await rows(id)).toHaveLength(1);
        const claims = await Promise.all(['qa-worker-a', 'qa-worker-b'].map(worker_id => automation(slug, tokenA, '/claim', { worker_id, scope_revision: revision })));
        expect(claims.map(response => response.status)).toEqual([200, 200]);
        const results = await Promise.all(claims.map(response => response.json() as Promise<{ work: Work | null }>));
        const owned = results.flatMap(result => result.work ? [result.work] : []);
        expect(owned).toHaveLength(1); const old = owned[0];
        expect(old.report_public_id).toBe(id); expect(old.report_revision).toBe(first.events[0].payload.report_revision);
        const before = await rows(id); expect(before).toHaveLength(1); expect(before[0]).toMatchObject({ work_id: old.work_id, worker_id: old.worker_id, lease_generation: old.lease_generation });
        expect((await client.post(`/p/${slug}/reports/${id}/messages`, { body: '補充：上午十點操作' })).status).toBe(302);
        const next = await (await automation(slug, tokenA, `/events?after=${first.next_cursor}`)).json() as { events: Event[]; next_cursor: string };
        expect(next.events).toHaveLength(1); expect(next.events[0]).toMatchObject({ event_type: 'report.customer_replied', payload: { report_public_id: id } });
        expect(next.events[0].payload.message_id).toBeTypeOf('number'); expect(next.events[0].payload.report_revision).toBeGreaterThan(old.report_revision);
        const after = await rows(id); expect(after).toHaveLength(2); expect(after[0].revoked_reason).toBe('new_customer_input');
        expect(after[1]).toMatchObject({ input_revision: next.events[0].payload.report_revision, stage: 'queued' });
        const stale = await automation(slug, tokenA, '/progress', { ...lease(old), stage: 'running', progress: { detail: 'old worker' } });
        expect(stale.status).toBe(409); expect(await rows(id)).toEqual(after);
        const claimNew = await automation(slug, tokenA, '/claim', { worker_id: 'qa-worker-next', scope_revision: revision });
        expect(claimNew.status).toBe(200); const newer = (await claimNew.json() as { work: Work }).work;
        expect(newer.work_id).toBe(after[1].work_id); expect(newer.report_revision).toBe(next.events[0].payload.report_revision);
        expect((await automation(b.project.slug, tokenA, '/events?after=0')).status).toBe(403);
        expect((await automation(slug, null, '/events?after=0')).status).toBe(401);
        const html = await (await client.get(`/p/${slug}/reports/${id}`)).text();
        const jsonResponse = await client.get(`/p/${slug}/conversations/${id}`, { accept: 'application/json' });
        expect(jsonResponse.status).toBe(200); const json = await jsonResponse.text();
        expect(html).toContain(title); expect(json).toContain('補充：上午十點操作');
        for (const secret of [old.work_id, newer.work_id, old.worker_id, 'lease_generation', 'scope_revision', 'revoked_reason', 'automation_work', tokenA]) {
            expect(html).not.toContain(secret); expect(json).not.toContain(secret);
        }
    });
});
