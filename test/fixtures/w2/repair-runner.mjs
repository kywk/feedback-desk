// Test-only transport injection: real consumer, repair adapter, Git, D1/API; GitLab/check runner are doubles.
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const load = path => import(pathToFileURL(resolve(path)).href);
const { createScopeAccess } = await load('scripts/agents/scope/index.mjs');
const { createAnalysisHandler } = await load('scripts/agents/analysis/index.mjs');
const { runConsumer } = await load('scripts/agents/consumer/index.mjs');
const { createRepairHandler } = await load('scripts/agents/repair/index.mjs');
const bare = process.env.W2_QA_BARE;
const key = 'qa-proof-key-123456789012345678901234567890';
const values = { FEEDBACK_AUTOMATION_QA_PROOF_KEY: key, W2_QA_API_TOKEN: 'qa-api-token', W2_QA_PUSH_TOKEN: 'qa-push-token' };
let mr; let posts = 0; let checks = 0;
const fetchImpl = async (url, init) => {
  if (url.origin !== 'https://gitlab.invalid') throw new Error('unexpected origin');
  const endpoint = '/api/v4/projects/23';
  if (url.pathname === endpoint) return Response.json({ id: 23, path_with_namespace: 'qa/test', http_url_to_repo: 'https://gitlab.invalid/qa/test.git', web_url: 'https://gitlab.invalid/qa/test' });
  if (url.pathname === endpoint + '/merge_requests' && init.method === 'GET') return Response.json(mr ? [mr] : []);
  if (url.pathname === endpoint + '/merge_requests/7' && init.method === 'GET') return Response.json(mr);
  if (url.pathname === endpoint + '/merge_requests' && init.method === 'POST') {
    posts++; const data = JSON.parse(init.body);
    const sha = execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/' + data.source_branch], { encoding: 'utf8' }).trim();
    mr = { ...data, project_id: 23, source_project_id: 23, target_project_id: 23, id: 102, iid: 7, state: 'opened', sha, web_url: 'https://gitlab.invalid/qa/test/-/merge_requests/7' };
    throw new TypeError('fixture lost response after MR created');
  }
  throw new Error('unexpected fixture route');
};
const verifyCheck = async ({ directory, archive }) => {
  const extracted = join(directory, 'qa-check'); await mkdir(extracted);
  execFileSync('tar', ['-xf', archive, '-C', extracted]);
  const content = await readFile(join(extracted, 'src/items.js'), 'utf8');
  if (!content.includes('return uniqueItems;') || content.includes('return allItems;')) throw new Error('fixture_check_failed');
  checks++;
};
const configPath = process.env.FEEDBACK_DESK_SCOPE_CONFIG, auditPath = process.env.FEEDBACK_DESK_SCOPE_AUDIT;
const repair = createRepairHandler({ configPath }, { fixtureRemote: pathToFileURL(bare), fetchImpl, resolveSecret: ref => values[ref], verifyCheck });
const workflow = createAnalysisHandler({ configPath, auditPath, runRepair: repair });
await runConsumer({ baseUrl: process.env.FEEDBACK_DESK_URL, token: process.env.FEEDBACK_DESK_AUTOMATION_TOKEN,
  projectSlug: process.env.FEEDBACK_DESK_PROJECT_SLUG, environment: 'qa', scopeRevision: 'w1-r1', workerId: 'w2-repair-worker',
  statePath: process.env.FEEDBACK_DESK_CONSUMER_STATE, scopeAccess: createScopeAccess({ configPath, auditPath }), workflow,
  once: true, heartbeatMs: 15000, retryBaseMs: 100, maxAttempts: 3,
  log: (event, data) => process.stdout.write(JSON.stringify({ event, ...data }) + '\n') });
process.stdout.write(JSON.stringify({ event: 'qa_repair_double', posts, checks, mr_id: mr?.id, mr_iid: mr?.iid }) + '\n');
