// Explicit opt-in: this test creates a feedback/ branch in the authorised isolated bare repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const catalogPath = process.env.W2_TODOMVC_CATALOG;

test('TodoMVC real source reaches local branch with true Docker check', { skip: !catalogPath, timeout: 90000 }, async t => {
  const h = await harness({ local: true, catalogPath });
  try {
    const report = await h.report('score-10');
    const analysis = await h.runWorker(); assert.equal(analysis.code, 0, analysis.output);
    const initial = await h.work(report.public_id); assert.equal(initial.decision_outcome, 'repair_authorized', analysis.output);
    const repair = await h.runWorker(); assert.equal(repair.code, 0, repair.output);
    const final = await h.work(report.public_id); assert.equal(final.decision_outcome, 'local_branch_ready', repair.output);
    const response = await h.teamGet(report.public_id); assert.equal(response.status, 200);
    const detail = await response.json(), branch = detail.local_branch;
    assert.equal(branch.repo_id, 'todomvc'); assert.equal(branch.target_branch, 'main');
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/' + branch.source_branch), branch.head_sha);
    assert.equal(git(h.bare, 'rev-parse', 'refs/heads/main'), h.commit);
    assert.equal(git(h.repo, 'rev-parse', 'HEAD'), h.commit); assert.equal(git(h.repo, 'status', '--porcelain'), '');
    const source = git(h.bare, 'show', `${branch.head_sha}:examples/javascript-es5/src/model.js`);
    assert.ok(source.includes('title = (title || "").trim();\n        if (!title) return;'));
    assert.ok(!source.includes('title = title || "";'));
    assert.deepEqual(branch.check_results, [{ check_id: 'blank-title', status: 'passed' }]);
    t.diagnostic(JSON.stringify({ case: 'todomvc_local', report_id: report.public_id, work_id: final.work_id, operation_id: branch.operation_id, repo_id: branch.repo_id, base_sha: h.commit, branch: branch.source_branch, head_sha: branch.head_sha, check_results: branch.check_results, stage: final.stage, outcome: final.decision_outcome, model: 'fixture', docker: 'real' }));
  } finally { await h.close(); }
});
