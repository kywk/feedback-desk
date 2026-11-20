import { createCustomerReport } from '../w1/runtime-fixture.mjs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { startModel } from '../fixtures/w2/model.mjs';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, realpath, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha = value => createHash('sha256').update(value).digest('hex');
async function startDesk() {
  const root = resolve('dist/worker');
  const chunks = (await readdir(root)).filter(name => name.endsWith('.js') && name !== 'index.js');
  const modules = ['index.js', ...chunks].map(name => ({ type: 'ESModule', path: resolve(root, name) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, modules, modulesRoot: root, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['FILES'], bindings: { APP_SECRET: 'qa-secret-only-not-for-production-0123456789', FEEDBACK_AUTOMATION_QA_PROOF_KEY: 'qa-proof-key-123456789012345678901234567890' } }));
  try {
    const url = (await mf.ready).origin; const db = await mf.getD1Database('DB');
    for (const migration of await readD1Migrations(resolve('migrations'))) await db.batch(migration.queries.map(query => db.prepare(query)));
    return { url, db, close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
async function createProject(desk, slug) {
  const clientToken = randomBytes(24).toString('hex');
  const serviceToken = 'fda_' + randomBytes(24).toString('hex');
  const owner = randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  const row = await desk.db.prepare('INSERT INTO projects (name, slug, owner_token_hash, client_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id').bind(`QA ${slug}`, slug, sha(owner), sha(clientToken), now, now).first();
  await desk.db.prepare("INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress) VALUES (?, 'qa', 'w1-r1', 1)").bind(row.id).run();
  await desk.db.prepare("INSERT INTO automation_tokens (project_id, environment, token_hash) VALUES (?, 'qa', ?)").bind(row.id, sha(serviceToken)).run();
  const cookies = new Map();
  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    const response = await fetch(new URL(path, desk.url), { ...init, headers, redirect: 'manual' });
    for (const item of response.headers.getSetCookie()) {
      const [pair, ...attrs] = item.split(';'); const index = pair.indexOf('=');
      const name = pair.slice(0, index), value = pair.slice(index + 1);
      if (!value || attrs.some(attr => attr.trim().toLowerCase() === 'max-age=0')) cookies.delete(name); else cookies.set(name, value);
    }
    return response;
  }
  const access = await request(`/p/${slug}/access?token=${clientToken}`);
  if (access.status !== 302) throw new Error('customer authentication failed');
  const client = {
    get: (path, headers = {}) => request(path, { headers }),
    post: (path, data) => request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) }),
  };
  return { slug, id: row.id, serviceToken, client };
}
export async function harness({ local = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fd-w2-qa-')));
  const desk = await startDesk(); const model = await startModel();
  try {
    const a = await createProject(desk, 'w2-qa-a'); const b = await createProject(desk, 'w2-qa-b');
    let repo = join(root, 'repo'); await mkdir(repo); await mkdir(join(repo, 'src'));
    if (local) { await mkdir(join(repo, 'test')); await writeFile(join(repo, 'test/check.mjs'), "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.match(readFileSync('src/items.js', 'utf8'), /return uniqueItems;/);\n"); }
    await writeFile(join(repo, 'src/items.js'), 'function items() {\n  return allItems;\n}\n');
    git(repo, 'init', '-b', 'main'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'fixture');
    const commit = git(repo, 'rev-parse', 'HEAD');
    const bare = join(root, 'remote.git'), recovery = join(root, 'recovery'); await mkdir(recovery, { mode: 0o700 });
    git(root, 'init', '--bare', '-b', 'main', bare); git(repo, 'push', bare, 'main');
    const remote = local ? pathToFileURL(await realpath(bare)).href : 'https://gitlab.invalid/qa/test.git';
    if (local) { const clone = join(root, 'clone'); git(root, 'clone', remote, clone); repo = await realpath(clone); }
    else git(repo, 'remote', 'add', 'origin', remote);
    const scope = { scopes: [a, b].map(p => ({ project_slug: p.slug, environment: 'qa', scope_revision: 'w1-r1', repositories: [{ id: 'fixture-repo', directory: repo, remote, base_branch: 'main', base_commit: commit, read_paths: ['src'], repair: { allowed_paths: ['src'], checks: [{ id: 'unit', argv: ['true'] }], branch_prefix: 'feedback/', recovery_directory: recovery, test_image: 'fixture@sha256:' + 'a'.repeat(64), gitlab: { instance_id: 'gitlab-fixture', origin: 'https://gitlab.invalid', project_id: 23, project_path: 'qa/test', api_token_ref: 'W2_QA_API_TOKEN', push_token_ref: 'W2_QA_PUSH_TOKEN', proof_key_ref: 'FEEDBACK_AUTOMATION_QA_PROOF_KEY', push_username: 'qa' } } }], guides: [] })) };
    if (local) {
      for (const scoped of scope.scopes) {
        scoped.repositories[0].repair = { mode: 'local', allowed_paths: ['src'], branch_prefix: 'feedback/', recovery_directory: recovery, test_image: 'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293', checks: [{ id: 'unit', argv: ['node', '--test', 'test/check.mjs'] }] };
      }
    }
    const config = join(root, 'scope.json'); await writeFile(config, JSON.stringify(scope));
    if (!local) await desk.db.prepare("INSERT INTO automation_policies (project_id, environment, scope_revision, auto_reply, gitlab_instance_id, gitlab_origin, gitlab_proof_key_ref) VALUES (?, 'qa', 'w1-r1', 1, 'gitlab-fixture', 'https://gitlab.invalid', 'FEEDBACK_AUTOMATION_QA_PROOF_KEY')").bind(a.id).run();
    if (!local) await desk.db.prepare("INSERT INTO automation_repositories (project_id, environment, scope_revision, repo_id, gitlab_project_id, base_branch, base_commit, branch_prefix, required_check_ids) VALUES (?, 'qa', 'w1-r1', 'fixture-repo', 23, 'main', ?, 'feedback/', '[\"unit\"]')").bind(a.id, commit).run();
    if (local) {
      await desk.db.prepare("INSERT INTO automation_policies (project_id, environment, scope_revision, auto_reply) VALUES (?, 'qa', 'w1-r1', 1)").bind(a.id).run();
      await desk.db.prepare("INSERT INTO automation_repositories (project_id, environment, scope_revision, repo_id, gitlab_project_id, base_branch, base_commit, branch_prefix, required_check_ids, delivery_mode) VALUES (?, 'qa', 'w1-r1', 'fixture-repo', NULL, 'main', ?, 'feedback/', '[\"unit\"]', 'local')").bind(a.id, commit).run();
    }
    const now = new Date().toISOString(); const token = 'fdk_' + randomBytes(24).toString('hex');
    const reviewer = await desk.db.prepare('INSERT INTO developers (name, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id').bind('QA reviewer', 'w2-reviewer', 'unused', now, now).first();
    await desk.db.prepare('INSERT INTO api_tokens (developer_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').bind(reviewer.id, 'qa', sha(token), now).run();
    await desk.db.prepare("INSERT INTO automation_reviewers (project_id, environment, developer_id) VALUES (?, 'qa', ?)").bind(a.id, reviewer.id).run();
    let count = 0;
    async function runWorker() {
      const workerId = `w2-worker-${++count}`;
      const env = { ...process.env, FEEDBACK_DESK_URL: desk.url, FEEDBACK_DESK_AUTOMATION_TOKEN: a.serviceToken, FEEDBACK_DESK_PROJECT_SLUG: a.slug,
        FEEDBACK_DESK_ENVIRONMENT: 'qa', FEEDBACK_DESK_SCOPE_REVISION: 'w1-r1', FEEDBACK_DESK_WORKER_ID: workerId, FEEDBACK_DESK_SCOPE_CONFIG: config,
        FEEDBACK_DESK_SCOPE_AUDIT: join(root, `${workerId}-audit.jsonl`), FEEDBACK_DESK_CONSUMER_STATE: join(root, `${workerId}-state.json`),
        FEEDBACK_DESK_ANALYSIS_MODEL_URL: model.url, FEEDBACK_DESK_ANALYSIS_MODEL: 'fixture', FEEDBACK_DESK_RETRY_BASE_MS: '100', FEEDBACK_DESK_MAX_ATTEMPTS: '3' };
      delete env.FEEDBACK_DESK_CONSUMER_HANDLER; delete env.FEEDBACK_DESK_ANALYSIS_ADAPTER;
      return await new Promise((done, fail) => {
        const child = spawn(process.execPath, [resolve('scripts/agents/consumer/cli.mjs'), '--once'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        child.once('error', fail); child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, output }); });
      });
    }
    async function runRepairWorker() {
      const env = { ...process.env, FEEDBACK_DESK_URL: desk.url, FEEDBACK_DESK_AUTOMATION_TOKEN: a.serviceToken,
        FEEDBACK_DESK_PROJECT_SLUG: a.slug, FEEDBACK_DESK_SCOPE_CONFIG: config,
        FEEDBACK_DESK_SCOPE_AUDIT: join(root, 'repair-audit.jsonl'), FEEDBACK_DESK_CONSUMER_STATE: join(root, 'repair-state.json'), W2_QA_BARE: bare };
      return await new Promise((done, fail) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('../fixtures/w2/repair-runner.mjs', import.meta.url))], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        child.once('error', fail); child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, output }); });
      });
    }
    async function report(title) { return createCustomerReport(desk, a, title); }
    async function work(id) { return desk.db.prepare('SELECT * FROM automation_work WHERE report_public_id=? ORDER BY input_revision DESC LIMIT 1').bind(id).first(); }
    async function decisions(id) { return (await desk.db.prepare('SELECT * FROM automation_decisions WHERE work_id=? ORDER BY decision_revision').bind(id).all()).results; }
    async function teamGet(id) { return fetch(`${desk.url}/api/v1/projects/${a.slug}/reports/${id}/automation/qa`, { headers: { authorization: `Bearer ${token}` } }); }
    async function human(id, endpoint, body) { return fetch(`${desk.url}/api/v1/projects/${a.slug}/reports/${id}/automation/qa/${endpoint}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
    return { desk, model, a, b, root, commit, config, bare, repo, remote, report, work, decisions, runWorker, runRepairWorker, teamGet, human, close: async () => { await model.close(); await desk.close(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await model.close(); await desk.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
