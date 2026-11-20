import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalProposalJson } from '../../src/shared/automation-analysis.mjs';
import { createRepairHandler } from '../../scripts/agents/repair/index.mjs';
import { QueueError } from '../../scripts/agents/consumer/queue.mjs';
import { runConsumer } from '../../scripts/agents/consumer/index.mjs';
import { createScopeAccess } from '../../scripts/agents/scope/index.mjs';
import { createAnalysisHandler } from '../../scripts/agents/analysis/index.mjs';

const source = 'https://gitlab.example';
const project = source + '/team/fixture';
const remoteUrl = project + '.git';
const endpoint = '/api/v4/projects/42';
const key = 'fixture-key-only-not-an-external-secret-42';
const image = 'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293';
const temp: string[] = [];

function git(cwd: string, ...args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

type Json = Record<string, any>;
const hash = (data: unknown) => createHash('sha256').update(canonicalProposalJson(data)).digest('hex');

afterEach(async () => {
    for (const path of temp.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(mode: 'gitlab' | 'local' = 'gitlab') {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'feedback-desk-repair-test-'));
    temp.push(root);
    const repo = join(root, 'repo');
    const bare = join(root, 'remote.git');
    const recovery = join(root, 'recovery');
    await mkdir(recovery, { mode: 0o700 });
    await mkdir(repo);
    await mkdir(join(repo, 'src'));
    await mkdir(join(repo, 'test'));
    await writeFile(join(repo, 'src/counter.mjs'), 'export const count = 1;\n');
    await symlink(join(root, 'outside.mjs'), join(repo, 'src/link.mjs'));
    await writeFile(join(root, 'outside.mjs'), 'export const count = 1;\n');
    await writeFile(join(repo, 'test/check.mjs'), [
        'import assert from "node:assert/strict";',
        'import { existsSync } from "node:fs";',
        'import { count } from "../src/counter.mjs";',
        'assert.equal(count, 2);',
        'assert.equal(existsSync(".git"), false);',
        'if (!process.env.REPAIR_HOST_FIXTURE) assert.equal(existsSync("/var/run/docker.sock"), false);',
        'assert.equal(process.env.FIXTURE_GITLAB_TOKEN, undefined);',
        'assert.equal(process.env.FIXTURE_PUSH_TOKEN, undefined);',
        'assert.equal(process.env.FIXTURE_PROOF_KEY, undefined);',
    ].join('\n'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '--all');
    git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(root, 'init', '--bare', '-b', 'main', bare);
    git(repo, 'push', bare, 'main');
    const approvedRemote = mode === 'local' ? pathToFileURL(bare).href : remoteUrl;
    git(repo, 'remote', 'add', 'origin', approvedRemote);

    const configPath = join(root, 'scopes.json');
    const repoConfig = {
        id: 'fixture-repo', directory: repo, read_paths: ['src'],
        remote: approvedRemote, base_commit: base, base_branch: 'main',
        repair: {
            allowed_paths: ['src/counter.mjs', 'src/link.mjs'], branch_prefix: 'automation/test/',
            recovery_directory: recovery,
            checks: [{ id: 'unit', argv: ['node', 'test/check.mjs'] }], test_image: image,
            ...(mode === 'local' ? { mode } : {
                gitlab: {
                    instance_id: 'fixture-gitlab', origin: source, project_id: 42, project_path: 'team/fixture',
                    api_token_ref: 'FIXTURE_GITLAB_TOKEN', push_token_ref: 'FIXTURE_PUSH_TOKEN',
                    proof_key_ref: 'FIXTURE_PROOF_KEY', push_username: 'automation',
                },
            }),
        },
    };
    const scope = {
        project_slug: 'fixture', environment: 'test', scope_revision: 'scope-1',
        repositories: [repoConfig], guides: [],
    };
    const saveConfig = () => writeFile(configPath, JSON.stringify({ scopes: [scope] }));
    await saveConfig();
    const tokenValues: Record<string, string> = {
        FIXTURE_GITLAB_TOKEN: 'mock-api-token', FIXTURE_PUSH_TOKEN: 'mock-push-token', FIXTURE_PROOF_KEY: key,
    };
    const proposal = {
        repo_id: repoConfig.id, base_commit: base,
        changes: [{ path: 'src/counter.mjs', before: 'count = 1', after: 'count = 2' }],
        required_check_ids: ['unit'], verification: ['預期計數為 2'], pending_decisions: [],
    };
    const auth = {
        kind: 'automatic', proposal_revision: 1, input_revision: 3, scope_revision: scope.scope_revision,
        repo_id: proposal.repo_id, base_branch: 'main', base_commit: base, proposal,
        required_check_ids: proposal.required_check_ids, proposal_digest: hash(proposal),
        acceptance_criteria: ['預期計數為 2'], verification: proposal.verification,
        ...(mode === 'local' && { delivery_mode: mode }),
    };
    const work = {
        worker_id: 'worker-1', work_id: 'work-1', lease_generation: 1, report_public_id: 'report-1',
        report_revision: 4, scope_revision: scope.scope_revision, event_id: 'event-1',
        project_slug: scope.project_slug, environment: scope.environment,
    };

    const events: string[] = [];
    const intents = new Map<string, Json>();
    const payloads = new Map<string, Json>();
    const links: Json[] = [];
    const localReceipts: Json[] = [];
    let loseLocalReceipt = false;
    const refs = () => git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/automation');
    let mr: Json | undefined;
    let posts = 0;
    let hideAfterPost = false;
    let hideMr = false;
    let skipMrCreate = false;
    let failRenew = false;
    let currentAuth: Json | undefined = auth;
    let beforeIntent: (data: Json) => void | Promise<void> = () => {};

    const queue = {
        async input(lease: Json) {
            events.push('input');
            return {
                work: { ...lease, input_revision: auth.input_revision, decision_revision: auth.proposal_revision, next_action: 'repair' },
                repair_authorization: currentAuth,
            };
        },
        async renew(lease: Json) {
            events.push('renew');
            if (failRenew) throw new QueueError('lease_conflict', { status: 409 });
            return lease;
        },
        async intent(lease: Json, data: Json) {
            events.push(data.operation_type);
            await beforeIntent(data);
            const key = data.operation_id;
            if (intents.has(key)) {
                expect(data.payload).toEqual(payloads.get(key));
                return { intent: intents.get(key) };
            }
            payloads.set(key, structuredClone(data.payload));
            const intent = {
                operation_id: key, operation_type: data.operation_type, correlation_id: data.correlation_id, status: 'pending',
                worker_id: lease.worker_id, lease_generation: lease.lease_generation,
            };
            intents.set(key, intent);
            return { intent };
        },
        async receipt(_lease: Json, id: string, result: Json) {
            events.push('push-receipt');
            expect(git(bare, 'rev-parse', 'refs/heads/' + result.source_branch)).toBe(result.head_sha);
            const intent = intents.get(id)!;
            expect(intent.operation_type).toBe('git.push_branch');
            const receipt = { operation_id: id, result };
            intents.set(id, { ...intent, status: 'recorded', receipt });
            return { receipt };
        },
        async localBranches(lease: Json, body: Json) {
            events.push('local-link');
            expect(intents.get(body.operation_id)?.operation_type).toBe('git.local_branch');
            expect(body.observation).toEqual(payloads.get(body.operation_id));
            expect(JSON.stringify(body)).not.toContain(root);
            const { repo_id, source_branch, target_branch, head_sha, input_revision } = body.observation;
            expect(git(bare, 'rev-parse', 'refs/heads/' + source_branch)).toBe(head_sha);
            const result = {
                receipt: {
                    operation_id: body.operation_id, work_id: lease.work_id, input_revision,
                    applied_report_revision: work.report_revision, stage: 'waiting_review', next_action: null,
                    outcome: 'local_branch_ready', repo_id, source_branch, target_branch, head_sha,
                },
            };
            if (loseLocalReceipt) {
                loseLocalReceipt = false;
                throw new TypeError('fixture terminal ACK lost');
            }
            localReceipts.push(result.receipt);
            return result;
        },
        async mrLinks(lease: Json, body: Json) {
            events.push('mr-link');
            expect(intents.get(body.operation_id)?.operation_type).toBe('gitlab.create_merge_request');
            expect(body.proof).toBe(createHmac('sha256', key).update(canonicalProposalJson({
                project_slug: work.project_slug, environment: work.environment, work_id: work.work_id,
                scope_revision: work.scope_revision, operation_id: body.operation_id, input_revision: body.input_revision,
                proposal_revision: body.proposal_revision, proposal_digest: body.proposal_digest, observation: body.observation,
            })).digest('hex'));
            links.push(body);
            return {
                receipt: {
                    operation_id: body.operation_id, work_id: lease.work_id,
                    mr_id: body.observation.mr_id, mr_iid: body.observation.mr_iid, web_url: body.observation.web_url,
                },
            };
        },
    };
    const fetchImpl = async (url: URL, init: RequestInit) => {
        expect(url.origin).toBe(source);
        expect(init.redirect).toBe('error');
        expect(new Headers(init.headers).get('private-token')).toBe(tokenValues.FIXTURE_GITLAB_TOKEN);
        if (url.pathname === endpoint) {
            return Response.json({ id: 42, path_with_namespace: 'team/fixture', http_url_to_repo: remoteUrl, web_url: project });
        }
        if (url.pathname === endpoint + '/merge_requests' && init.method === 'GET') {
            expect(url.searchParams.get('target_branch')).toBe('main');
            expect(url.searchParams.get('source_branch')).toMatch(/^automation\/test\/[a-f0-9]{32}$/);
            events.push('mr-list');
            return Response.json(mr && !hideMr ? [mr] : []);
        }
        if (url.pathname === endpoint + '/merge_requests/7' && init.method === 'GET') {
            events.push('mr-get');
            return Response.json(mr);
        }
        if (url.pathname === endpoint + '/merge_requests' && init.method === 'POST') {
            events.push('mr-post');
            posts += 1;
            expect(events.slice(0, -1).at(-1)).toBe('renew');
            expect(events).toContain('push-receipt');
            const body = JSON.parse(init.body as string);
            const sha = git(bare, 'rev-parse', 'refs/heads/' + body.source_branch);
            if (!skipMrCreate) {
                mr = {
                    ...body, project_id: 42, source_project_id: 42, target_project_id: 42,
                    id: 102, iid: 7, state: 'opened', sha, web_url: project + '/-/merge_requests/7',
                };
            }
            if (hideAfterPost) {
                hideMr = true;
                throw new TypeError('Mock lost upstream response');
            }
            return Response.json(mr ?? { web_url: project + '/-/merge_requests/999' });
        }
        throw new Error('Unexpected fixture route ' + url.pathname);
    };
    const fixtureVerifier = async ({ directory, archive, argv }: { directory: string; archive: string; argv: string[] }) => {
        const checked = await mkdtemp(join(directory, 'check-'));
        const env = { PATH: process.env.PATH, REPAIR_HOST_FIXTURE: '1' };
        execFileSync('tar', ['-xf', archive, '-C', checked], { env, stdio: 'pipe' });
        expect((await readdir(checked)).sort()).toEqual(['src', 'test']);
        try {
            execFileSync(process.execPath, argv.slice(1), { cwd: checked, env, stdio: 'pipe' });
        } catch {
            throw new Error('fixture_check_failed');
        }
    };
    let savedProgress: Json;
    const checkpoint = async (progress: Json) => {
        events.push('phase:' + progress.repair.phase);
        savedProgress = progress.repair;
    };
    const repair = (useDocker = false) => createRepairHandler({ configPath }, {
        ...(mode === 'local' ? {
            fetchImpl: () => { throw new Error('local mode used GitLab'); },
            resolveSecret: () => { throw new Error('local mode requested a credential'); },
        } : { fixtureRemote: pathToFileURL(bare), fetchImpl, resolveSecret: (ref: string) => tokenValues[ref] }),
        ...(useDocker ? {} : { verifyCheck: fixtureVerifier }),
    });
    const run = ({ useDocker = false, repairAuthorization = auth } = {}) =>
        repair(useDocker)({ work, repairAuthorization, queue, signal: new AbortController().signal, checkpoint });
    const auditPath = join(root, 'audit.jsonl');
    const scopeAccess = createScopeAccess({ configPath, auditPath });
    const httpSections: string[] = [];
    const consumerLogs: unknown[] = [];
    const httpLocalRequests: Json[] = [];
    async function runLocalConsumer() {
        const row = { ...work, stage: 'queued', progress: null, lease_expires_at: new Date(Date.now() + 60_000).toISOString() };
        await runConsumer({
            baseUrl: 'https://queue.invalid', token: 'fda_' + 'a'.repeat(28), projectSlug: work.project_slug,
            environment: work.environment, workerId: work.worker_id, scopeRevision: work.scope_revision,
            statePath: join(root, 'state.json'), scopeAccess,
            workflow: createAnalysisHandler({ configPath, auditPath, runRepair: repair() }), once: true, retryBaseMs: 1,
            log: (event, details) => { consumerLogs.push({ event, ...details }); },
            fetchImpl: async (url: URL, init: RequestInit) => {
                const section = url.pathname.split('/').at(-1)!;
                httpSections.push(section);
                const data = init.body ? JSON.parse(init.body as string) : {};
                if (section === 'events') return Response.json({ events: [], next_cursor: '0' });
                if (section === 'claim') return Response.json({ work: row });
                if (section === 'input') {
                    const input = await queue.input(data);
                    return Response.json({ ...input, report: { public_id: work.report_public_id } });
                }
                if (section === 'progress' || section === 'renew') return Response.json({ work: { ...row, ...data } });
                if (section === 'intent') return Response.json(await queue.intent(data, data));
                if (section === 'local-branches') {
                    httpLocalRequests.push(data);
                    return Response.json(await queue.localBranches(data, data));
                }
                throw new Error('Unexpected queue route ' + section);
            },
        });
    }
    const refreshDigest = () => { auth.proposal_digest = hash(auth.proposal); };
    return {
        auth, proposal, refreshDigest, work, repoConfig, run, refs, events, posts: () => posts, links, saveConfig, repo, bare, base,
        root, configPath, approvedRemote, scopeAccess, httpSections, httpLocalRequests, localReceipts, runLocalConsumer, consumerLogs,
        loseNextLocalReceipt: () => { loseLocalReceipt = true; },
        setBeforeIntent: (callback: typeof beforeIntent) => { beforeIntent = callback; },
        recoveries: () => readdir(recovery),
        lastRecovery: () => join(recovery, savedProgress.recovery_id),
        progress: () => savedProgress,
        setAuthorization: (authorization?: Json) => { currentAuth = authorization; },
        revokeLease: () => { failRenew = true; },
        loseMrReply: () => { hideAfterPost = true; },
        revealMr: () => { hideMr = false; },
        falsifyCreateResponse: () => { skipMrCreate = true; },
        readMr: () => mr,
    };
}

describe('W2 修復 Worker', () => {
    it.each(['automatic', 'team_approved'])('以 %s 同版授權修正、檢查、推測試分支並回查 MR', async kind => {
        const f = await fixture();
        Object.assign(f.auth, { kind, ...(kind === 'team_approved' ? { approval_id: 'approval-1', delivery_mode: 'gitlab' } : {}) });
        await expect(f.run()).resolves.toMatchObject({ receipt: { mr_id: 102, mr_iid: 7 } });
        expect(f.refs()).toMatch(/^automation\/test\//);
        expect(git(f.bare, 'show', f.refs() + ':src/counter.mjs')).toBe('export const count = 2;');
        expect(git(f.bare, 'rev-parse', f.refs() + '^')).toBe(f.base);
        expect(await readFile(join(f.repo, 'src/counter.mjs'), 'utf8')).toBe('export const count = 1;\n');
        expect(git(f.repo, 'status', '--porcelain')).toBe('');
        expect(f.events.indexOf('git.push_branch')).toBeLessThan(f.events.indexOf('push-receipt'));
        expect(f.events.indexOf('push-receipt')).toBeLessThan(f.events.indexOf('gitlab.create_merge_request'));
        expect(f.events.indexOf('mr-get')).toBeLessThan(f.events.indexOf('mr-link'));
        expect(f.posts()).toBe(1);
        expect(await f.recoveries()).toEqual([]);
    });

    it('遇到 MR 回應遺失時，用新租約回查同一個 MR', async () => {
        const f = await fixture();
        f.loseMrReply();
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_result_uncertain', retryable: true });
        expect(f.links).toEqual([]);
        f.work.lease_generation += 1;
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_result_uncertain' });
        f.revealMr();
        f.work.lease_generation += 1;
        await expect(f.run()).resolves.toMatchObject({ receipt: { mr_id: 102 } });
        expect(f.posts()).toBe(1);
        expect(f.links).toHaveLength(1);
    });

    it('已合併的 MR 可在來源分支自動刪除後對帳', async () => {
        const f = await fixture();
        f.loseMrReply();
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_result_uncertain' });
        git(f.bare, 'update-ref', '-d', 'refs/heads/' + f.refs());
        f.readMr()!.state = 'merged';
        f.revealMr();
        f.work.lease_generation += 1;
        await expect(f.run()).resolves.toMatchObject({ receipt: { mr_id: 102 } });
        expect(f.links[0].observation.state).toBe('merged');
        expect(f.refs()).toBe('');
        expect(f.posts()).toBe(1);
    });

    it('推送失敗保留操作意圖，未查到分支就不開 MR', async () => {
        const f = await fixture();
        await writeFile(join(f.bare, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_push_failed' });
        expect(f.events).toContain('git.push_branch');
        expect(f.events).not.toContain('push-receipt');
        const localTree = join(f.lastRecovery(), 'worktree');
        expect(git(localTree, 'rev-parse', f.progress().source_branch)).toBe(f.progress().head_sha);
        expect(git(localTree, 'show', 'HEAD:src/counter.mjs')).toBe('export const count = 2;');
        expect(f.refs()).toBe('');
        expect(f.posts()).toBe(0);
    });

    it('建立回應即使有網址，未回查到 MR 仍保留待查', async () => {
        const f = await fixture();
        f.falsifyCreateResponse();
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_result_uncertain' });
        expect(f.refs()).toMatch(/^automation\/test\//);
        expect(f.links).toEqual([]);
    });

    it('GitLab 回查取得不同的 HEAD 時不關聯 MR', async () => {
        const f = await fixture();
        f.loseMrReply();
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_result_uncertain' });
        f.readMr()!.sha = f.base;
        f.revealMr();
        f.work.lease_generation += 1;
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_mr_mismatch' });
        expect(f.links).toEqual([]);
    });

    it.each([
        { code: 'repair_path_not_allowed', path: 'src/link.mjs' },
        { code: 'repair_proposal_not_allowed', path: 'test/check.mjs' },
        { code: 'repair_edit_not_unique', before: 'missing' },
        { code: 'repair_empty_diff', revert: true },
        { code: 'repair_check_not_allowed', unknownCheck: true },
    ])('不允許 $code 寫到遠端', async ({ code, path, before, revert, unknownCheck }) => {
        const f = await fixture();
        if (path) f.proposal.changes[0].path = path;
        if (before) f.proposal.changes[0].before = before;
        if (revert) f.proposal.changes.push({ path: 'src/counter.mjs', before: 'count = 2', after: 'count = 1' });
        if (unknownCheck) f.proposal.required_check_ids[0] = 'unconfigured';
        f.refreshDigest();
        await expect(f.run()).rejects.toMatchObject({ code });
        expect(f.events).not.toContain('git.push_branch');
        expect(f.refs()).toBe('');
        expect(f.posts()).toBe(0);
    });

    it('服務端已換版即使傳入舊授權也無法寫入', async () => {
        const f = await fixture();
        f.setAuthorization({ ...f.auth, proposal_revision: 2 });
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_authorization_changed' });
        expect(f.events).toEqual(['input']);
        expect(f.refs()).toBe('');
    });

    it.each(['scope', 'lease', 'approval'])('意圖保存後再次驗證 %s', async drift => {
        const f = await fixture();
        f.setBeforeIntent(async data => {
            if (data.operation_type !== 'git.push_branch') return;
            if (drift === 'lease') f.revokeLease();
            if (drift === 'approval') f.setAuthorization(undefined);
            if (drift === 'scope') {
                f.repoConfig.repair.branch_prefix = 'automation/new/';
                await f.saveConfig();
            }
        });
        const code = { lease: 'lease_conflict', scope: 'scope_changed', approval: 'invalid_repair_authorization' }[drift];
        await expect(f.run()).rejects.toMatchObject({ code });
        expect(f.refs()).toBe('');
        expect(f.posts()).toBe(0);
    });

    it('MR 建立前再次驗證租約', async () => {
        const f = await fixture();
        f.setBeforeIntent(data => {
            if (data.operation_type === 'gitlab.create_merge_request') f.revokeLease();
        });
        await expect(f.run()).rejects.toMatchObject({ code: 'lease_conflict' });
        expect(f.events).toContain('push-receipt');
        expect(f.posts()).toBe(0);
    });

    it('準備建 MR 時遠端工作分支已變動，停止外部寫入', async () => {
        const f = await fixture();
        f.setBeforeIntent(data => {
            if (data.operation_type === 'gitlab.create_merge_request') {
                git(f.bare, 'update-ref', 'refs/heads/' + f.refs(), f.base);
            }
        });
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_remote_branch_changed' });
        expect(f.posts()).toBe(0);
    });

    it('必要檢查失敗時沒有外部寫入', async () => {
        const f = await fixture();
        f.proposal.changes[0].after = 'count = 3';
        f.refreshDigest();
        await expect(f.run()).rejects.toThrow('fixture_check_failed');
        expect(f.events).not.toContain('git.push_branch');
        expect(f.refs()).toBe('');
        expect(f.progress()).toMatchObject({ phase: 'verify', check_id: 'unit' });
        const localTree = join(f.lastRecovery(), 'worktree');
        expect(git(localTree, 'branch', '--show-current')).toBe(f.progress().source_branch);
        expect(git(localTree, 'diff', '--cached', '--name-only')).toBe('src/counter.mjs');
        expect(git(localTree, 'show', ':src/counter.mjs')).toBe('export const count = 3;');
        expect(await readdir(f.lastRecovery())).not.toContain('worktree.tar');
    });

    it('本機正常入口完成修復，回應遺失時 consumer 重送原本機收據請求', async () => {
        const f = await fixture('local');
        f.loseNextLocalReceipt();
        await f.runLocalConsumer();
        expect(f.localReceipts, JSON.stringify({ segments: f.httpSections, logs: f.consumerLogs })).toHaveLength(1);
        expect(f.httpLocalRequests).toHaveLength(2);
        expect(f.httpLocalRequests[1]).toEqual(f.httpLocalRequests[0]);
        expect(f.httpSections.slice(-2)).toEqual(['local-branches', 'local-branches']);
        const receipt = f.localReceipts[0];
        expect(receipt).toMatchObject({ outcome: 'local_branch_ready', stage: 'waiting_review', target_branch: 'main' });
        expect(receipt.source_branch).toMatch(/^automation\/test\/[0-9a-f]{32}$/);
        expect(f.refs()).toBe(receipt.source_branch);
        expect(git(f.bare, 'show', receipt.head_sha + ':src/counter.mjs')).toBe('export const count = 2;');
        expect(git(f.bare, 'rev-parse', receipt.head_sha + '^')).toBe(f.base);
        expect(git(f.repo, 'status', '--porcelain')).toBe('');
        expect(await f.recoveries()).toEqual([]);
    }, 15_000);

    it('本機分支已建立但新租約接手時可對帳同一 commit', async () => {
        const f = await fixture('local');
        f.loseNextLocalReceipt();
        await expect(f.run()).rejects.toThrow('fixture terminal ACK lost');
        const branch = f.refs();
        const sha = git(f.bare, 'rev-parse', branch);
        f.work.lease_generation += 1;
        const result = await f.run();
        expect(result.receipt).toMatchObject({ source_branch: branch, head_sha: sha });
        expect(f.refs()).toBe(branch);
    });

    it('本機既有分支指向不同 HEAD 時保留既有分支並拒絕回寫', async () => {
        const f = await fixture('local');
        f.setBeforeIntent(async data => {
            git(f.bare, 'branch', data.payload.source_branch, f.base);
        });
        await expect(f.run()).rejects.toMatchObject({ code: 'local_branch_changed' });
        expect(git(f.bare, 'rev-parse', f.refs())).toBe(f.base);
        expect(f.localReceipts).toEqual([]);
    });

    it('本機交付在意圖保存後失去租約時保留裸庫原狀', async () => {
        const f = await fixture('local');
        f.setBeforeIntent(f.revokeLease);
        await expect(f.run()).rejects.toMatchObject({ code: 'lease_conflict' });
        expect(f.refs()).toBe('');
        expect(f.localReceipts).toEqual([]);
    });

    it('本機裸庫基底與受管 commit 不符時不建分支', async () => {
        const f = await fixture('local');
        git(f.bare, 'update-ref', '-d', 'refs/heads/main');
        await expect(f.run()).rejects.toMatchObject({ code: 'local_base_changed' });
        expect(f.refs()).toBe('');
        expect(f.localReceipts).toEqual([]);
    });

    it('本機交付不讀取遠端轉送設定及可執行 hooks', async () => {
        const f = await fixture('local');
        const other = join(f.root, 'other.git');
        const marker = join(f.root, 'hook-ran');
        git(f.root, 'init', '--bare', '-b', 'main', other);
        git(f.repo, 'config', 'remote.origin.pushurl', pathToFileURL(other).href);
        git(f.bare, 'config', 'url.' + pathToFileURL(other).href + '.insteadOf', f.approvedRemote);
        const hook = '#!/bin/sh\nprintf yes > "' + marker + '"\nexit 1\n';
        for (const name of ['pre-receive', 'reference-transaction']) {
            await writeFile(join(f.bare, 'hooks', name), hook, { mode: 0o700 });
        }
        await expect(f.run()).resolves.toMatchObject({ receipt: { outcome: 'local_branch_ready' } });
        expect(git(other, 'for-each-ref')).toBe('');
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('本機修復拒絕其他庫的 origin 與方案 repo', async () => {
        const f = await fixture('local');
        const other = join(f.root, 'other.git');
        git(f.root, 'init', '--bare', '-b', 'main', other);
        git(f.repo, 'remote', 'set-url', 'origin', pathToFileURL(other).href);
        await expect(f.run()).rejects.toMatchObject({ code: 'remote_not_allowed' });
        expect(git(other, 'for-each-ref')).toBe('');
        f.proposal.repo_id = 'other-repo';
        f.refreshDigest();
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_repo_not_allowed' });
        expect(f.refs()).toBe('');
    });

    it('本機修復拒絕裸庫與 refs 路徑的符號連結逃逸', async () => {
        const f = await fixture('local');
        const alias = join(f.root, 'alias.git');
        await symlink(f.bare, alias);
        f.repoConfig.remote = pathToFileURL(alias).href;
        git(f.repo, 'remote', 'set-url', 'origin', f.repoConfig.remote);
        await f.saveConfig();
        await expect(f.run()).rejects.toMatchObject({ code: 'local_repository_not_allowed' });

        f.repoConfig.remote = f.approvedRemote;
        git(f.repo, 'remote', 'set-url', 'origin', f.repoConfig.remote);
        await f.saveConfig();
        const outside = join(f.root, 'outside-refs');
        await mkdir(outside);
        await symlink(outside, join(f.bare, 'refs', 'heads', 'automation'));
        await expect(f.run()).rejects.toMatchObject({ code: 'local_repository_not_allowed' });
        expect(await readdir(outside)).toEqual([]);
    });

    it('本機唯讀工具讀取核准基底的 tracked 檔案', async () => {
        const f = await fixture('local');
        const access = f.scopeAccess.forWork({ ...f.work, actor: f.work.worker_id, correlation_id: f.work.event_id });
        await expect(access.execute({ operation: 'read_repo_file', repo_id: 'fixture-repo', path: 'src/counter.mjs' }))
            .resolves.toMatchObject({ commit: f.base, content: 'export const count = 1;\n' });
    });

    it.each(['local', 'gitlab'] as const)('拒絕與設定不符的 %s 交付授權', async mode => {
        const f = await fixture(mode);
        Object.assign(f.auth, { delivery_mode: mode === 'local' ? 'gitlab' : 'local' });
        await expect(f.run()).rejects.toMatchObject({ code: 'repair_delivery_mode_mismatch' });
        expect(f.refs()).toBe('');
        expect(f.posts()).toBe(0);
    });

    it.skipIf(process.env.FEEDBACK_REPAIR_DOCKER_SMOKE !== '1')('本機模式使用真 Docker 交付可查驗分支', async () => {
        const f = await fixture('local');
        await expect(f.run({ useDocker: true })).resolves.toMatchObject({ receipt: { outcome: 'local_branch_ready' } });
        expect(git(f.bare, 'show', f.refs() + ':src/counter.mjs')).toBe('export const count = 2;');
    }, 30_000);

    it.skipIf(process.env.FEEDBACK_REPAIR_DOCKER_SMOKE !== '1')('用真 Docker 以隔離環境檢查修復前後的結果', async () => {
        const credentials = ['FIXTURE_GITLAB_TOKEN', 'FIXTURE_PUSH_TOKEN', 'FIXTURE_PROOF_KEY'];
        const saved = credentials.map(name => process.env[name]);
        try {
            for (const name of credentials) process.env[name] = 'hidden-from-check';
            const f = await fixture();
            f.proposal.changes[0].after = 'count = 3';
            f.refreshDigest();
            await expect(f.run({ useDocker: true })).rejects.toMatchObject({ code: 'repair_check_failed' });
            expect(f.refs()).toBe('');
            f.proposal.changes[0].after = 'count = 2';
            f.refreshDigest();
            await expect(f.run({ useDocker: true })).resolves.toMatchObject({ receipt: { mr_id: 102 } });
            expect(f.posts()).toBe(1);
        } finally {
            for (const [index, name] of credentials.entries()) {
                if (saved[index] === undefined) delete process.env[name];
                else process.env[name] = saved[index];
            }
        }
    }, 30_000);
});
