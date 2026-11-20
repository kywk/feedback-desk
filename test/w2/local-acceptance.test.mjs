// Production CLI and local repair adapter, real Docker checks and isolated file: Git remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function run(h) { const result = await h.runWorker(); assert.equal(result.code, 0, result.output); return result; }

test('normal CLI creates one local repair branch with real Docker checks and replay-safe receipt', { timeout: 60000 }, async t => {
  const h = await harness({ local: true });
  try {
    assert.ok(h.remote.startsWith('file:'));
    assert.equal(git(h.repo, 'remote', 'get-url', 'origin'), h.remote);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), h.commit);
    const report = await h.report('score-10');
    const initial = await run(h); const approved = await h.work(report.public_id);
    assert.equal(approved.decision_outcome, 'repair_authorized', initial.output);
    assert.equal(approved.next_action, 'repair');
    const execution = await run(h); const finished = await h.work(report.public_id);
    assert.equal(finished.decision_outcome, 'local_branch_ready', execution.output);
    assert.equal(finished.stage, 'waiting_review');
    const team = await h.teamGet(report.public_id); assert.equal(team.status, 200);
    const detail = await team.json();
    assert.equal(detail.mr, null); assert.equal(detail.work.outcome, 'local_branch_ready');
    const local = detail.local_branch; assert.equal(local.repo_id, 'fixture-repo');
    assert.equal(local.target_branch, 'main'); assert.ok(local.source_branch.startsWith('feedback/'));
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/' + local.source_branch), local.head_sha);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), h.commit);
    assert.notEqual(local.head_sha, h.commit);
    assert.ok(git(h.bare, 'show', `${local.head_sha}:src/items.js`).includes('return uniqueItems;'));
    const branchesBefore = git(h.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feedback');
    const retry = await run(h); assert.equal(retry.code, 0);
    assert.equal(git(h.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feedback'), branchesBefore);
    const operations = await h.desk.db.prepare("SELECT operation_id, operation_type, result_json, worker_id, lease_generation, report_revision FROM automation_operations WHERE work_id=?").bind(finished.work_id).all();
    assert.equal(operations.results.length, 1); assert.equal(operations.results[0].operation_type, 'git.local_branch');
    assert.ok(operations.results[0].result_json); assert.equal((await h.decisions(finished.work_id)).length, 1);
    const op = operations.results[0];
    const keys = ['input_revision', 'proposal_revision', 'proposal_digest', 'repo_id', 'base_commit', 'target_branch', 'source_branch', 'head_sha', 'check_results'];
    const observation = Object.fromEntries(keys.map(key => [key, local[key]]));
    assert.ok(keys.every(key => observation[key] !== undefined));
    const body = { worker_id: op.worker_id, work_id: finished.work_id, report_public_id: report.public_id, report_revision: op.report_revision,
      lease_generation: op.lease_generation, scope_revision: finished.scope_revision, operation_id: op.operation_id, observation };
    const replay = payload => fetch(`${h.desk.url}/api/automation/${h.a.slug}/qa/local-branches`, { method: 'POST', headers: { authorization: `Bearer ${h.a.serviceToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const firstReplay = await replay(body); assert.equal(firstReplay.status, 200); const firstReceipt = await firstReplay.json();
    assert.equal(firstReceipt.receipt.outcome, 'local_branch_ready'); assert.equal(firstReceipt.receipt.head_sha, local.head_sha);
    const secondReplay = await replay(body); assert.equal(secondReplay.status, 200); assert.deepEqual(await secondReplay.json(), firstReceipt);
    const conflict = await replay({ ...body, observation: { ...observation, head_sha: 'f'.repeat(40) } }); assert.equal(conflict.status, 409);
    assert.equal(git(h.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/feedback'), branchesBefore);

    const customer = await h.a.client.get(`/p/${h.a.slug}/reports/${report.public_id}`); assert.equal(customer.status, 200);
    const html = await customer.text(); assert.ok(!html.includes(local.source_branch)); assert.ok(!html.includes(local.head_sha));
    const msg = await h.desk.db.prepare('SELECT count(*) n FROM messages WHERE report_id=(SELECT id FROM reports WHERE public_id=?)').bind(report.public_id).first(); assert.equal(msg.n, 0);
    const mrs = await h.desk.db.prepare('SELECT count(*) n FROM automation_mr_links WHERE work_id=?').bind(finished.work_id).first(); assert.equal(mrs.n, 0);
    t.diagnostic(JSON.stringify({ case: 'local_repair', report_id: report.public_id, work_id: finished.work_id, operation_id: operations.results[0].operation_id, base_sha: h.commit, branch: local.source_branch, head_sha: local.head_sha, outcome: finished.decision_outcome, real_docker: true, remote: 'isolated-file' }));
  } finally { await h.close(); }
});
