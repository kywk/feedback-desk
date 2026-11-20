// Explicit W2 QA suite. CLI and D1 are real; the model endpoint is a deterministic local fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';

async function run(h) { const result = await h.runWorker(); assert.equal(result.code, 0, result.output); return result; }
function reviewBody(work, decision, actionId) {
  return { action_id: actionId, action: 'approve', work_id: work.work_id, input_revision: work.input_revision, report_revision: work.report_revision, scope_revision: work.scope_revision, decision_revision: decision.decision_revision, proposal_digest: decision.proposal_digest };
}

test('customer question, supplement and replay yield one answer per input revision', { timeout: 30000 }, async t => {
  const h = await harness();
  try {
    const report = await h.report('needs-info'); await run(h);
    const old = await h.work(report.public_id); assert.equal(old.stage, 'waiting_customer');
    assert.equal(old.decision_outcome, 'needs_input_sent');
    assert.equal((await h.desk.db.prepare('SELECT count(*) n FROM messages WHERE report_id=(SELECT id FROM reports WHERE public_id=?)').bind(report.public_id).first()).n, 1);
    await run(h); assert.equal((await h.decisions(old.work_id)).length, 1);
    assert.equal((await h.a.client.post(`/p/${h.a.slug}/reports/${report.public_id}/messages`, { body: '補充：上午十點。' })).status, 302);
    await run(h); const next = await h.work(report.public_id);
    assert.notEqual(next.work_id, old.work_id); assert.ok(next.input_revision > old.input_revision);
    assert.equal(next.decision_outcome, 'reply_sent'); assert.equal(next.stage, 'waiting_customer');
    const count = await h.desk.db.prepare('SELECT count(*) n FROM messages WHERE report_id=(SELECT id FROM reports WHERE public_id=?)').bind(report.public_id).first(); assert.equal(count.n, 3);
    const html = await (await h.a.client.get(`/p/${h.a.slug}/reports/${report.public_id}`)).text();
    assert.ok(html.includes('已收到補充資料'), `customer page does not contain answer: ${html.slice(0, 1500)}`); assert.ok(!html.includes('ev:')); assert.ok(!html.includes(old.work_id));
    assert.deepEqual(h.model.calls.map(item => item.action), ['read', 'finish', 'read', 'finish']);
    t.diagnostic(JSON.stringify({ case: 'supplement', report_id: report.public_id, work_ids: [old.work_id, next.work_id], decisions: [old.decision_outcome, next.decision_outcome], message_count: count.n }));
  } finally { await h.close(); }
});

for (const [score, expected] of [[0, 'blocked'], [4, 'blocked'], [5, 'review_required'], [7, 'review_required'], [8, 'repair_authorized'], [10, 'repair_authorized']]) {
  test(`real consumer classifies score ${score}`, { timeout: 30000 }, async t => {
    const h = await harness();
    try {
      const report = await h.report(`score-${score}`); await run(h); const work = await h.work(report.public_id);
      assert.equal(work.decision_outcome, expected); const decisions = await h.decisions(work.work_id); assert.equal(decisions.length, 1);
      const analysis = JSON.parse(decisions[0].analysis_json);
      assert.equal(Object.values(analysis.assessment).reduce((sum, item) => sum + item.score, 0), score);
      assert.equal(analysis.proposal.base_commit, h.commit); assert.equal(analysis.proposal.changes[0].before, 'return allItems;');
      const customer = await (await h.a.client.get(`/p/${h.a.slug}/reports/${report.public_id}`)).text();
      assert.ok(!customer.includes(decisions[0].proposal_digest)); assert.ok(!customer.includes('ev:'));
      t.diagnostic(JSON.stringify({ case: `score-${score}`, report_id: report.public_id, work_id: work.work_id, decision_revision: decisions[0].decision_revision, stage: work.stage, outcome: work.decision_outcome }));
    } finally { await h.close(); }
  });
}

test('pending business question stays with team and invalid score cannot authorize repair', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const pending = await h.report('pending'); await run(h); const pendingWork = await h.work(pending.public_id);
    assert.equal(pendingWork.decision_outcome, 'business_review'); assert.equal(pendingWork.stage, 'waiting_review');
    const invalid = await h.report('score-11'); await run(h); const invalidWork = await h.work(invalid.public_id);
    assert.equal(invalidWork.stage, 'blocked'); assert.notEqual(invalidWork.decision_outcome, 'repair_authorized');
    assert.equal((await h.decisions(invalidWork.work_id)).length, 0);
  } finally { await h.close(); }
});

test('mid score rejects stale approval then authorizes exact current proposal', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const report = await h.report('score-7'); await run(h); const work = await h.work(report.public_id); const [decision] = await h.decisions(work.work_id);
    const review = reviewBody(work, decision, 'w2-review-valid');
    const stale = await h.human(report.public_id, 'review', { ...review, action_id: 'w2-review-stale', proposal_digest: '0'.repeat(64) });
    assert.equal(stale.status, 409); assert.equal((await h.work(report.public_id)).decision_outcome, 'review_required');
    const accepted = await h.human(report.public_id, 'review', review); assert.equal(accepted.status, 200);
    assert.equal((await h.work(report.public_id)).next_action, 'repair');
    const replay = await h.human(report.public_id, 'review', review); assert.deepEqual(await replay.json(), await accepted.json());
  } finally { await h.close(); }
});

test('supplemental evidence reanalyzes same work and input revision into a new decision', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const report = await h.report('score-4'); await run(h); const initial = await h.work(report.public_id); const [decision] = await h.decisions(initial.work_id);
    const body = { action_id: 'w2-evidence', work_id: initial.work_id, input_revision: initial.input_revision, report_revision: initial.report_revision, scope_revision: initial.scope_revision, decision_revision: decision.decision_revision, evidence_refs: ['repo:fixture-repo:src/items.js'], reason: '補上核准的程式證據。' };
    assert.equal((await h.human(report.public_id, 'evidence', body)).status, 200); await run(h);
    const after = await h.work(report.public_id); const decisions = await h.decisions(initial.work_id);
    assert.equal(after.work_id, initial.work_id); assert.equal(after.input_revision, initial.input_revision); assert.equal(after.report_revision, initial.report_revision);
    assert.equal(decisions.length, 2); assert.equal(decisions[1].decision_revision, decisions[0].decision_revision + 1);
  } finally { await h.close(); }
});

test('customer follow-up makes the original review approval stale', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const report = await h.report('score-7'); await run(h);
    const work = await h.work(report.public_id); const [decision] = await h.decisions(work.work_id);
    const review = reviewBody(work, decision, 'w2-old-approval');
    assert.equal((await h.a.client.post(`/p/${h.a.slug}/reports/${report.public_id}/messages`, { body: '補充新條件。' })).status, 302);
    const newer = await h.work(report.public_id); assert.notEqual(newer.work_id, work.work_id);
    assert.equal((await h.human(report.public_id, 'review', review)).status, 409);
    assert.equal((await h.work(report.public_id)).work_id, newer.work_id);
  } finally { await h.close(); }
});

test('ordinary customer explanation is published with no internal evidence identifiers', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const report = await h.report('explanation'); await run(h); const work = await h.work(report.public_id);
    assert.equal(work.decision_outcome, 'reply_sent');
    const page = await h.a.client.get(`/p/${h.a.slug}/reports/${report.public_id}`);
    const html = await page.text(); assert.ok(html.includes('請重新整理清單')); assert.ok(!html.includes(work.work_id)); assert.ok(!html.includes('ev:'));
    const json = await (await h.a.client.get(`/p/${h.a.slug}/conversations/${report.public_id}`, { accept: 'application/json' })).text();
    assert.ok(json.includes('請重新整理清單')); assert.ok(!json.includes('ev:')); assert.ok(!json.includes(work.work_id));
  } finally { await h.close(); }
});

test('customer secrets are masked before the local model receives the report', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const report = await h.report('explanation sensitive');
    assert.equal((await h.a.client.post(`/p/${h.a.slug}/reports/${report.public_id}/messages`, { body: 'Authorization: Bearer fixture-secret-1234567890' })).status, 302);
    await run(h); assert.ok(h.model.calls.length >= 2);
    assert.ok(h.model.calls.every(call => call.leaked_fixture_secret === false));
    const work = await h.work(report.public_id); assert.equal(work.decision_outcome, 'reply_sent');
    const row = await h.desk.db.prepare("SELECT body FROM messages WHERE report_id=(SELECT id FROM reports WHERE public_id=?) AND author_type='owner' ORDER BY id DESC LIMIT 1").bind(report.public_id).first();
    assert.ok(!row.body.includes('fixture-secret-1234567890'));
  } finally { await h.close(); }
});

for (const score of [10, 7]) {
  test(`score ${score} reaches a verified MR using real Git and a simulated GitLab`, { timeout: 30000 }, async t => {
    const h = await harness();
    try {
      const report = await h.report(`score-${score}`); await run(h);
      const initial = await h.work(report.public_id); const [decision] = await h.decisions(initial.work_id);
      if (score === 7) {
        assert.equal(initial.decision_outcome, 'review_required');
        assert.equal((await h.human(report.public_id, 'review', reviewBody(initial, decision, 'w2-approve-repair'))).status, 200);
      } else assert.equal(initial.decision_outcome, 'repair_authorized');
      const outcome = await h.runRepairWorker(); assert.equal(outcome.code, 0, outcome.output);
      const finished = await h.work(report.public_id);
      assert.equal(finished.decision_outcome, 'mr_opened', outcome.output);
      const link = await h.desk.db.prepare('SELECT * FROM automation_mr_links WHERE work_id=?').bind(initial.work_id).first();
      assert.equal(link.mr_iid, 7); assert.equal(link.gitlab_project_id, 23);
      const observation = JSON.parse(link.observation_json); assert.equal(observation.mr_id, 102); assert.equal(observation.base_commit, h.commit);
      const events = outcome.output.trim().split('\n').filter(Boolean).map(JSON.parse);
      const fixture = events.find(event => event.event === 'qa_repair_double'); assert.equal(fixture.posts, 1); assert.equal(fixture.checks, 1);
      const operations = await h.desk.db.prepare('SELECT operation_type, result_json FROM automation_operations WHERE work_id=?').bind(initial.work_id).all();
      assert.equal(operations.results.length, 2); assert.ok(operations.results.every(item => item.result_json));
      const html = await (await h.a.client.get(`/p/${h.a.slug}/reports/${report.public_id}`)).text(); assert.ok(!html.includes(observation.web_url));
      t.diagnostic(JSON.stringify({ case: `repair-${score}`, report_id: report.public_id, work_id: initial.work_id, mr_id: observation.mr_id, mr_iid: observation.mr_iid, head_sha: observation.head_sha, gitlab: 'fixture', checks: 'fixture' }));
    } finally { await h.close(); }
  });
}
