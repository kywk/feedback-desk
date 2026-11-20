// Manually run after W1-03 is integrated. Child process + real HTTP/D1; handler is a test double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startDesk, createProject, createCustomerReport } from './runtime-fixture.mjs';
import { startProxy } from './runtime-proxy.mjs';

async function eventually(fn, label, timeout = 12000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout waiting for ${label}`);
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fd-w1-runtime-'));
  const desk = await startDesk(); const proxy = await startProxy(desk.url);
  const a = await createProject(desk, 'w1-runtime-a'); const b = await createProject(desk, 'w1-runtime-b');
  const scopes = [a, b].map(p => ({ project_slug: p.slug, environment: 'qa', scope_revision: 'w1-r1', repositories: [], guides: [] }));
  const config = join(dir, 'scope.json'); await writeFile(config, JSON.stringify({ scopes }));
  const trace = join(dir, 'handler.jsonl');
  const children = new Set();
  function worker(workerId, mode = 'finish', once = true) {
    const entry = resolve(process.env.W1_CONSUMER_ENTRY ?? 'scripts/agents/consumer/cli.mjs');
    const child = spawn(process.execPath, [entry, ...(once ? ['--once'] : [])], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, FEEDBACK_DESK_URL: proxy.url, FEEDBACK_DESK_AUTOMATION_TOKEN: a.serviceToken,
      FEEDBACK_DESK_PROJECT_SLUG: a.slug, FEEDBACK_DESK_ENVIRONMENT: 'qa', FEEDBACK_DESK_SCOPE_REVISION: 'w1-r1', FEEDBACK_DESK_WORKER_ID: workerId,
      FEEDBACK_DESK_SCOPE_CONFIG: config, FEEDBACK_DESK_SCOPE_AUDIT: join(dir, `audit-${workerId}.jsonl`), FEEDBACK_DESK_CONSUMER_STATE: join(dir, `state-${workerId}.json`),
      FEEDBACK_DESK_CONSUMER_HANDLER: resolve('test/w1/runtime-handler.mjs'), FEEDBACK_DESK_POLL_MS: '100', FEEDBACK_DESK_HEARTBEAT_MS: '150',
      FEEDBACK_DESK_RETRY_BASE_MS: '100', FEEDBACK_DESK_MAX_ATTEMPTS: '4', W1_HANDLER_MODE: mode, W1_HANDLER_TRACE: trace,
    } });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const done = new Promise((resolveDone, reject) => { child.once('error', reject); child.once('exit', (code, signal) => { children.delete(child); resolveDone({ code, signal, output }); }); });
    children.add(child); return { child, done };
  }
  async function traces() { try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function row(id) { return desk.db.prepare('SELECT * FROM automation_work WHERE report_public_id = ? ORDER BY input_revision DESC LIMIT 1').bind(id).first(); }
  async function cleanup() { for (const child of children) child.kill('SIGKILL'); await Promise.all([...children].map(child => new Promise(resolveDone => child.once('exit', resolveDone)))); await proxy.close(); await desk.close(); await rm(dir, { recursive: true, force: true }); }
  return { desk, proxy, a, b, worker, traces, row, cleanup };
}

test('killed consumer resumes checkpoint; customer follow-up creates new work; review is not re-dispatched', { timeout: 30000 }, async t => {
  const h = await harness();
  try {
    const report = await createCustomerReport(h.desk, h.a, 'runtime restart');
    const first = h.worker('qa-first', 'wait');
    await eventually(async () => (await h.traces()).some(x => x.event === 'checkpointed'), 'checkpoint');
    const before = await h.row(report.public_id);
    assert.equal(JSON.parse(before.progress_json).handler.phase, 'qa_checkpoint');
    first.child.kill('SIGKILL'); assert.equal((await first.done).signal, 'SIGKILL');
    // Advance the lease in the isolated D1 fixture; avoids a 60-second wall-clock wait.
    await h.desk.db.prepare("UPDATE automation_work SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE work_id = ?").bind(before.work_id).run();
    const next = h.worker('qa-next'); assert.equal((await next.done).code, 0);
    const after = await h.row(report.public_id); assert.equal(after.work_id, before.work_id); assert.equal(after.lease_generation, before.lease_generation + 1); assert.equal(after.stage, 'waiting_review');
    assert.equal(JSON.parse(after.progress_json).handler.observed, 'qa_checkpoint');
    const attempts = await h.desk.db.prepare('SELECT worker_id, lease_generation, outcome FROM automation_work_attempts WHERE work_id = ? ORDER BY lease_generation').bind(before.work_id).all();
    assert.equal(attempts.results.length, 2); assert.deepEqual(attempts.results.map(row => row.worker_id), ['qa-first', 'qa-next']);
    const noRedispatch = h.worker('qa-idle'); assert.equal((await noRedispatch.done).code, 0);
    assert.equal((await h.traces()).filter(x => x.event === 'started').length, 2);
    assert.equal((await h.a.client.post(`/p/${h.a.slug}/reports/${report.public_id}/messages`, { body: 'QA 客戶補件' })).status, 302);
    const newer = await h.row(report.public_id); assert.notEqual(newer.work_id, before.work_id); assert.ok(newer.input_revision > before.input_revision);
    const followup = h.worker('qa-followup'); assert.equal((await followup.done).code, 0);
    assert.equal((await h.row(report.public_id)).stage, 'waiting_review');
    const rows = await h.desk.db.prepare('SELECT work_id, input_revision FROM automation_work WHERE report_public_id = ?').bind(report.public_id).all(); assert.equal(rows.results.length, 2);
    t.diagnostic(JSON.stringify({ case: 'restart_followup', report_id: report.public_id, work_ids: rows.results.map(row => row.work_id), attempts: attempts.results, checkpoint: 'qa_checkpoint', final_stage: (await h.row(report.public_id)).stage }));
  } finally { await h.cleanup(); }
});

test('429 Retry-After, disconnect and lost ACK are recoverable with one durable work', { timeout: 30000 }, async t => {
  const h = await harness();
  try {
    const report = await createCustomerReport(h.desk, h.a, 'runtime faults');
    h.proxy.inject({ path: '/events', mode: 'rate-limit', retryAfter: 1 });
    h.proxy.inject({ path: '/events', mode: 'disconnect' });
    h.proxy.inject({ path: '/progress', mode: 'lost-ack' });
    const consumer = h.worker('qa-fault', 'finish', false);
    await eventually(async () => (await h.row(report.public_id))?.stage === 'waiting_review', 'fault recovery', 20000);
    consumer.child.kill('SIGTERM'); await consumer.done;
    const events = h.proxy.events.filter(item => item.path.endsWith('/events'));
    const rate = events.findIndex(item => item.outcome === '429'); assert.ok(rate >= 0); assert.ok(events[rate + 1].at - events[rate].at >= 1000);
    assert.ok(events.some(item => item.outcome === 'disconnect'));
    assert.ok(h.proxy.events.some(item => item.outcome === 'lost-ack' && item.upstream_status === 200));
    assert.equal((await h.desk.db.prepare('SELECT count(*) n FROM automation_work WHERE report_public_id = ?').bind(report.public_id).first()).n, 1);
    assert.equal((await h.traces()).filter(item => item.event === 'started').length, 1);
    const row = await h.row(report.public_id);
    t.diagnostic(JSON.stringify({ case: 'faults', report_id: report.public_id, work_id: row.work_id, generation: row.lease_generation, stage: row.stage, progress: JSON.parse(row.progress_json), requests: h.proxy.events }));
  } finally { await h.cleanup(); }
});

test('human claim fences the running process and prevents automatic reassignment', { timeout: 30000 }, async t => {
  const h = await harness();
  try {
    const report = await createCustomerReport(h.desk, h.a, 'runtime manual takeover');
    const running = h.worker('qa-taken', 'wait');
    await eventually(async () => (await h.traces()).some(x => x.event === 'checkpointed'), 'live checkpoint');
    const before = await h.row(report.public_id);
    const crypto = await import('node:crypto');
    const humanToken = `fdk_${crypto.randomBytes(24).toString('hex')}`;
    const humanHash = crypto.createHash('sha256').update(humanToken).digest('hex');
    const now = new Date().toISOString();
    const dev = await h.desk.db.prepare('INSERT INTO developers (name, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id').bind('QA reviewer', 'qa-reviewer', 'unused', now, now).first();
    await h.desk.db.prepare('INSERT INTO api_tokens (developer_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(dev.id, 'qa', humanHash, now).run();
    const apiPath = `/api/v1/projects/${h.a.slug}/reports/${report.public_id}`;
    const humanPost = path => fetch(h.desk.url + apiPath + path, { method: 'POST', headers: { authorization: `Bearer ${humanToken}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await humanPost('/claim')).status, 200);
    const stopped = await eventually(async () => { const row = await h.row(report.public_id); return row.revoked_reason === 'manual_takeover' && row; }, 'manual takeover');
    assert.equal(stopped.worker_id, null);
    await eventually(() => h.proxy.events.some(event => event.path.endsWith('/renew') && event.outcome === '409'), 'old worker renewal 409');
    assert.equal((await humanPost('/release')).status, 200);
    const duplicate = h.worker('qa-after-human'); assert.equal((await duplicate.done).code, 0);
    assert.equal((await h.traces()).filter(item => item.event === 'started').length, 1);
    const after = await h.row(report.public_id);
    assert.equal(after.work_id, before.work_id); assert.equal(after.revoked_reason, 'manual_takeover'); assert.equal(after.lease_generation, before.lease_generation);
    running.child.kill('SIGTERM'); await running.done;
    t.diagnostic(JSON.stringify({ case: 'manual_takeover', report_id: report.public_id, work_id: after.work_id, generation: after.lease_generation, stage: after.stage, revoked_reason: after.revoked_reason, denied_renewals: h.proxy.events.filter(event => event.path.endsWith('/renew') && event.outcome === '409') }));
  } finally { await h.cleanup(); }
});
