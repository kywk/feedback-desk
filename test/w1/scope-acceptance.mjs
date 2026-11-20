// Run manually after W1-02 is merged. Git and policy are real; ELK is an isolated HTTP substitute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fd-w1-scope-')));
  const scopes = [];
  for (const name of ['a', 'b']) {
    const dir = join(root, name); await mkdir(dir);
    git(dir, 'init', '-b', 'main');
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, 'docs', 'marker.txt'), `W1_${name.toUpperCase()}_ONLY\n`);
    git(dir, 'add', 'docs/marker.txt');
    git(dir, '-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'fixture');
    const remote = `https://git.invalid/${name}.git`; git(dir, 'remote', 'add', 'origin', remote);
    const guides = join(root, `guide-${name}`); await mkdir(guides); await writeFile(join(guides, 'note.txt'), `guide-${name}`);
    scopes.push({ project_slug: `w1-qa-${name}`, environment: 'qa', scope_revision: `w1-${name}-r1`,
      repositories: [{ id: `repo-${name}`, directory: dir, remote, base_branch: 'main', base_commit: git(dir, 'rev-parse', 'HEAD'), read_paths: ['docs'] }],
      guides: [{ id: `guide-${name}`, directory: guides, read_paths: ['note.txt', 'escape.txt'] }],
      elk: { endpoint: 'https://elk.invalid', index: `w1-${name}-logs`, services: [`service-${name}`], queries: [{ id: 'errors', terms: { 'log.level': 'error' } }], fields: ['message', 'token'], redact_fields: ['token'], max_window_seconds: 3600, max_hits: 5 } });
  }
  await symlink(join(root, 'guide-b', 'note.txt'), join(root, 'guide-a', 'escape.txt'));
  const configPath = join(root, 'scopes.json'); const auditPath = join(root, 'audit.jsonl');
  await writeFile(configPath, JSON.stringify({ scopes }));
  return { root, configPath, auditPath, scopes };
}

test('real scope tool confines A against B using isolated Git and ELK substitute', async () => {
  const f = await fixture();
  try {
    const modulePath = resolve(process.env.W1_SCOPE_MODULE ?? 'scripts/agents/scope/index.mjs');
    const { createScopeAccess } = await import(pathToFileURL(modulePath).href);
    const calls = [];
    const access = createScopeAccess({ configPath: f.configPath, auditPath: f.auditPath,
      fetchImpl: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ hits: { hits: [{ _source: { message: 'W1_A_LOG', token: 'fixture-secret', hidden: 'internal' } }] } }); } });
    const tools = access.forWork({ work_id: 'w1-work-a', correlation_id: 'w1-corr-a', actor: 'qa', project_slug: 'w1-qa-a', environment: 'qa', scope_revision: 'w1-a-r1' });
    assert.deepEqual(await tools.validate(), { project_slug: 'w1-qa-a', environment: 'qa', scope_revision: 'w1-a-r1' });
    const a = await tools.execute({ operation: 'read_repo_file', repo_id: 'repo-a', path: 'docs/marker.txt' });
    assert.equal(a.content.trim(), 'W1_A_ONLY'); assert.equal(a.commit, f.scopes[0].repositories[0].base_commit);
    await assert.rejects(tools.execute({ operation: 'read_repo_file', repo_id: 'repo-b', path: 'docs/marker.txt' }), { code: 'source_not_allowed' });
    await assert.rejects(tools.execute({ operation: 'read_local_guide', guide_id: 'guide-a', path: 'escape.txt' }), { code: 'path_not_allowed' });
    const query = { operation: 'query_elk', index: 'w1-a-logs', template_id: 'errors', service: 'service-a', from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:10:00Z', limit: 2 };
    const result = await tools.execute(query);
    assert.deepEqual(result.rows, [{ message: 'W1_A_LOG', token: '[已遮罩]' }]);
    await assert.rejects(tools.execute({ ...query, index: 'w1-b-logs' }), { code: 'index_not_allowed' });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://elk.invalid/w1-a-logs/_search');
    git(f.scopes[0].repositories[0].directory, 'remote', 'set-url', 'origin', 'https://git.invalid/other.git');
    await assert.rejects(tools.execute({ operation: 'read_repo_file', repo_id: 'repo-a', path: 'docs/marker.txt' }), { code: 'remote_not_allowed' });
    const audit = (await readFile(f.auditPath, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const reason of ['source_not_allowed', 'path_not_allowed', 'index_not_allowed', 'remote_not_allowed']) assert.ok(audit.some(row => row.decision === 'denied' && row.reason === reason), reason);
    assert.doesNotMatch(JSON.stringify(audit), /fixture-secret|W1_A_LOG/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
