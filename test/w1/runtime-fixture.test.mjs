import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDesk, createProject, createCustomerReport } from './runtime-fixture.mjs';

test('isolated real HTTP and D1 fixture creates A/B and captures customer input', async () => {
  const desk = await startDesk();
  try {
    const a = await createProject(desk, 'w1-runtime-a'); const b = await createProject(desk, 'w1-runtime-b');
    const report = await createCustomerReport(desk, a, 'QA 客戶入口');
    const work = await desk.db.prepare('SELECT work_id, stage, input_revision FROM automation_work WHERE report_public_id = ?').bind(report.public_id).first();
    assert.equal(work.stage, 'queued'); assert.equal(work.input_revision, report.report_revision);
    const bRows = await desk.db.prepare('SELECT count(*) n FROM automation_work WHERE project_id = ?').bind(b.id).first();
    assert.equal(bRows.n, 0);
    assert.equal((await a.client.get(`/p/${a.slug}/reports/${report.public_id}`)).status, 200);
    const cross = await fetch(`${desk.url}/api/automation/${b.slug}/qa/events?after=0`, { headers: { authorization: `Bearer ${a.serviceToken}` } });
    assert.equal(cross.status, 403);
  } finally { await desk.close(); }
});

test('fault proxy injects real 429 and disconnect before forwarding', async () => {
  const desk = await startDesk();
  const { startProxy } = await import('./runtime-proxy.mjs');
  const proxy = await startProxy(desk.url);
  try {
    const a = await createProject(desk, 'w1-proxy-a');
    const path = `/api/automation/${a.slug}/qa/events?after=0`;
    const init = { headers: { authorization: `Bearer ${a.serviceToken}` } };
    proxy.inject({ path: '/events', mode: 'rate-limit', retryAfter: 2 });
    const throttled = await fetch(proxy.url + path, init); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '2');
    proxy.inject({ path: '/events', mode: 'disconnect' });
    await assert.rejects(fetch(proxy.url + path, init));
    assert.equal((await fetch(proxy.url + path, init)).status, 200);
    assert.deepEqual(proxy.events.map(entry => entry.outcome), ['429', 'disconnect', '200']);
    assert.doesNotMatch(JSON.stringify(proxy.events), /fda_/);
  } finally { await proxy.close(); await desk.close(); }
});
