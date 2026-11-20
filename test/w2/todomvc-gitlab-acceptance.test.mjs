// Opt in only against a dedicated private GitLab project. The MR and branch are retained as evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { harness } from './harness.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const testcase = 'examples/javascript-es5/src/model.js';

function required(name) {
  assert.ok(process.env[name], 'missing environment variable ' + name);
  return process.env[name];
}

function gitLabSettings() {
  const origin = required('W2_GITLAB_ORIGIN');
  const projectId = Number(required('W2_GITLAB_PROJECT_ID'));
  const projectPath = required('W2_GITLAB_PROJECT_PATH');
  const endpoint = new URL(origin);
  assert.ok(endpoint.protocol === 'https:' && endpoint.origin === origin, 'expected a GitLab HTTPS origin');
  assert.ok(Number.isSafeInteger(projectId) && projectId > 0, 'expected a GitLab numeric project ID');
  assert.match(projectPath, /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+$/u);
  const apiTokenRef = 'W2_GITLAB_API_TOKEN';
  const pushTokenRef = 'W2_GITLAB_PUSH_TOKEN';
  required(apiTokenRef);
  required(pushTokenRef);
  return {
    instance_id: 'gitlab-todomvc-qa', origin, project_id: projectId, project_path: projectPath,
    api_token_ref: apiTokenRef, push_token_ref: pushTokenRef, push_username: required('W2_GITLAB_PUSH_USERNAME'),
  };
}

function gitLabReader(config) {
  const prefix = config.origin + '/api/v4/projects/' + config.project_id;
  return async (path = '') => {
    const response = await fetch(prefix + path, {
      headers: { 'private-token': process.env[config.api_token_ref] },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, 'GitLab GET ' + path);
    return response.json();
  };
}

async function startReceiptLossProxy(deskUrl, mrLinkPath) {
  const writes = [];
  const server = createServer(async (request, response) => {
    try {
      const target = new URL(request.url, deskUrl);
      if (target.origin !== deskUrl) {
        response.writeHead(400).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const result = await fetch(target, {
        method: request.method,
        headers: { authorization: request.headers.authorization, 'content-type': 'application/json' },
        body: body.length ? body : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(4_000),
      });
      const message = await result.text();
      if (target.pathname === mrLinkPath && result.ok) {
        writes.push({ digest: createHash('sha256').update(body).digest('hex'), receipt: JSON.parse(message).receipt });
        if (writes.length === 1) {
          response.destroy();
          return;
        }
      }
      response.writeHead(result.status, { 'content-type': 'application/json' }).end(message);
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    writes,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('production consumer pushes a TodoMVC repair and verifies one real GitLab MR after a lost receipt', {
  skip: process.env.W2_GITLAB_LIVE !== '1', timeout: 180_000,
}, async t => {
  const gitlab = gitLabSettings();
  const h = await harness({ catalogPath: required('W2_TODOMVC_CATALOG'), gitlab });
  t.after(() => h.close());
  const get = gitLabReader(gitlab);
  const projectUrl = gitlab.origin + '/' + gitlab.project_path;
  const project = await get();
  assert.equal(project.id, gitlab.project_id);
  assert.equal(project.path_with_namespace, gitlab.project_path);
  assert.equal(project.web_url, projectUrl);
  assert.equal(project.http_url_to_repo, h.remote);
  assert.equal(project.visibility, 'private');
  assert.equal(project.default_branch, 'main');
  const mainPath = '/repository/branches/main';
  const main = await get(mainPath);
  assert.equal(main.commit.id, h.commit);
  assert.equal(main.protected, true);

  const report = await h.report('score-10 TodoMVC：空白標題不應建立待辦');
  const analysis = await h.runWorker();
  assert.equal(analysis.code, 0, analysis.output);
  const authorized = await h.work(report.public_id);
  assert.equal(authorized.decision_outcome, 'repair_authorized', analysis.output);
  assert.equal(authorized.next_action, 'repair');

  const receiptProxy = await startReceiptLossProxy(h.desk.url, '/api/automation/' + h.a.slug + '/gitlab-qa/mr-links');
  t.after(() => receiptProxy.close());
  const repair = await h.runWorker({ baseUrl: receiptProxy.url, timeoutMs: 120_000 });
  assert.equal(repair.code, 0, repair.output);
  const finished = await h.work(report.public_id);
  assert.equal(finished.work_id, authorized.work_id);
  assert.equal(finished.decision_outcome, 'mr_opened', repair.output);

  const team = await h.teamGet(report.public_id);
  assert.equal(team.status, 200);
  const detail = await team.json();
  const mr = detail.mr;
  assert.equal(detail.work.outcome, 'mr_opened');
  assert.equal(detail.work.stage, 'waiting_mr_review');
  assert.equal(detail.local_branch, null);
  assert.equal(mr.repo_id, 'todomvc');
  assert.equal(mr.project_id, gitlab.project_id);
  assert.equal(mr.base_commit, h.commit);
  assert.match(mr.source_branch, /^feedback\/[a-f0-9]{32}$/);
  assert.equal(mr.target_branch, 'main');
  assert.notEqual(mr.head_sha, h.commit);
  assert.deepEqual(mr.check_results, [{ check_id: 'blank-title', status: 'passed' }]);

  assert.equal(receiptProxy.writes.length, 2);
  const [lost, replayed] = receiptProxy.writes;
  assert.deepEqual(replayed, lost);
  const receipt = replayed.receipt;
  assert.equal(receipt.work_id, finished.work_id);
  assert.equal(receipt.outcome, 'mr_opened');
  assert.equal(receipt.mr_id, mr.mr_id);
  assert.equal(receipt.mr_iid, mr.mr_iid);
  assert.equal(receipt.web_url, mr.web_url);
  assert.match(receipt.operation_id, /^repair-mr:[a-f0-9]{64}$/);
  assert.match(repair.output, /"event":"work_transitioned"/);

  const params = new URLSearchParams({ scope: 'all', state: 'all', source_branch: mr.source_branch });
  const list = await get('/merge_requests?' + params);
  assert.deepEqual(list.map(item => item.iid), [mr.mr_iid]);
  const mrPath = '/merge_requests/' + mr.mr_iid;
  const actual = await get(mrPath);
  assert.equal(actual.id, mr.mr_id);
  assert.equal(actual.iid, mr.mr_iid);
  assert.equal(actual.web_url, projectUrl + '/-/merge_requests/' + actual.iid);
  assert.equal(actual.web_url, mr.web_url);
  assert.equal(actual.project_id, gitlab.project_id);
  assert.equal(actual.source_project_id, gitlab.project_id);
  assert.equal(actual.target_project_id, gitlab.project_id);
  assert.equal(actual.source_branch, mr.source_branch);
  assert.equal(actual.target_branch, mr.target_branch);
  assert.equal(actual.sha, mr.head_sha);
  assert.equal(actual.state, 'opened');
  assert.equal(actual.description, 'Feedback Desk operation: ' + receipt.operation_id);
  const changes = await get(mrPath + '/diffs');
  assert.deepEqual(changes.map(file => [file.old_path, file.new_path]), [[testcase, testcase]]);
  assert.ok(changes[0].diff.includes('+        title = (title || "").trim();\n+        if (!title) return;'));
  const sourceRef = await get('/repository/branches/' + encodeURIComponent(mr.source_branch));
  assert.equal(sourceRef.commit.id, mr.head_sha);
  assert.deepEqual(sourceRef.commit.parent_ids, [h.commit]);
  assert.equal((await get(mainPath)).commit.id, h.commit);
  assert.equal(git(h.repo, 'rev-parse', 'HEAD'), h.commit);
  assert.equal(git(h.repo, 'status', '--porcelain'), '');

  const operations = await h.desk.db.prepare('SELECT operation_type, result_json FROM automation_operations WHERE work_id=? ORDER BY operation_type')
    .bind(finished.work_id).all();
  assert.deepEqual(operations.results.map(operation => operation.operation_type), ['git.push_branch', 'gitlab.create_merge_request']);
  assert.ok(operations.results.every(operation => operation.result_json));
  const links = await h.desk.db.prepare('SELECT operation_id FROM automation_mr_links WHERE work_id=?').bind(finished.work_id).all();
  assert.deepEqual(links.results, [{ operation_id: receipt.operation_id }]);
  const retry = await h.runWorker();
  assert.equal(retry.code, 0, retry.output);
  assert.ok(!retry.output.includes('"event":"work_claimed"'));
  assert.deepEqual((await get('/merge_requests?' + params)).map(item => item.id), [actual.id]);

  const customer = await h.a.client.get('/p/' + h.a.slug + '/reports/' + report.public_id);
  assert.equal(customer.status, 200);
  const html = await customer.text();
  for (const value of [mr.web_url, mr.head_sha, mr.source_branch]) assert.ok(!html.includes(value));
  t.diagnostic(JSON.stringify({
    case: 'todomvc_gitlab_live', report_id: report.public_id, work_id: finished.work_id,
    operation_id: receipt.operation_id, gitlab_project_id: gitlab.project_id, mr_id: mr.mr_id,
    mr_iid: mr.mr_iid, mr_url: mr.web_url, base_sha: h.commit,
    source_branch: mr.source_branch, target_branch: mr.target_branch, head_sha: mr.head_sha,
    check_results: mr.check_results, stage: detail.work.stage, outcome: finished.decision_outcome,
    receipt_attempts: receiptProxy.writes.length, matching_mrs: list.length, model: 'fixture', docker: 'real',
  }));
});
