import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScopeAccess, ScopeError } from '../../scripts/agents/scope/index.mjs';

const work = {
    work_id: 'work-1',
    correlation_id: 'correlation-1',
    actor: 'worker-1',
    project_slug: 'project-a',
    environment: 'test',
    scope_revision: 'rev-a',
};

const repoRead = { operation: 'read_repo_file', repo_id: 'repo-a', path: 'docs/source.md' };
const guideRead = { operation: 'read_local_guide', guide_id: 'guide-a', path: 'manual/setup.md' };
const elkQuery = {
    operation: 'query_elk',
    index: 'logs-a-test',
    template_id: 'errors',
    service: 'service-a',
    from: '2026-11-20T00:00:00Z',
    to: '2026-11-20T00:10:00Z',
    limit: 1,
};
const credential = 'fixture-only-elk-credential';

function git(directory: string, ...args: string[]): string {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixtures(root: string, project: string) {
    const repo = join(root, 'repo-' + project);
    const guide = join(root, 'guide-' + project);
    await mkdir(join(repo, 'docs'), { recursive: true });
    await mkdir(join(guide, 'manual'), { recursive: true });
    await writeFile(join(guide, 'manual/setup.md'), 'Guide ' + project + '\n');
    await writeFile(join(guide, 'manual/.env'), 'FIXTURE_HIDDEN_SECRET');
    await writeFile(join(repo, 'docs/source.md'), 'Source ' + project + '\nPASSWORD=fixture-password\n');
    await writeFile(join(repo, 'docs/.env'), 'FIXTURE_HIDDEN_SECRET');
    await writeFile(join(repo, 'outside.md'), 'Out-of-scope fixture\n');
    await symlink('../outside.md', join(repo, 'docs/link.md'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'add', '-f', '.');
    const remote = 'https://git.invalid/org/' + project + '.git';
    git(repo, 'remote', 'add', 'origin', remote);
    git(repo, '-c', 'user.name=Scope Test', '-c', 'user.email=scope@fixture.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
    return {
        project_slug: 'project-' + project,
        environment: 'test',
        scope_revision: 'rev-' + project,
        enabled: true,
        repositories: [{
            id: 'repo-' + project,
            directory: repo,
            remote,
            base_branch: 'main',
            base_commit: git(repo, 'rev-parse', 'HEAD'),
            read_paths: ['docs'],
        }],
        guides: [{ id: 'guide-' + project, directory: guide, read_paths: ['manual'] }],
        elk: {
            endpoint: 'https://elk.invalid',
            index: 'logs-' + project + '-test',
            services: ['service-' + project],
            queries: [{ id: 'errors', terms: { 'log.level': 'error' } }],
            fields: ['@timestamp', 'message', 'user.email', 'api_token'],
            redact_fields: ['user.email'],
            max_window_seconds: 600,
            max_hits: 2,
            credential_ref: 'FIXTURE_ELK_TOKEN',
        },
    };
}

function elkResponse() {
    return Response.json({ hits: { hits: [{
        _id: 'protected-id',
        _source: {
            '@timestamp': '2026-11-20T00:01:00Z',
            message: 'Fixture result includes ' + credential,
            user: { email: 'fixture-address', name: 'private-name' },
            api_token: 'private-token',
            payload: 'private-payload',
        },
    }, { _source: { message: 'out-of-limit' } }] } });
}

describe('automation project scope', () => {
    let root: string;
    let configPath: string;
    let auditPath: string;
    let a: Awaited<ReturnType<typeof fixtures>>;
    let b: Awaited<ReturnType<typeof fixtures>>;
    const fetchImpl = vi.fn(async (_url: URL, _init: RequestInit) => elkResponse());
    const resolveSecret = vi.fn(async (_ref: string) => credential);

    async function configure(scopes = [a, b]) {
        await writeFile(configPath, JSON.stringify({ scopes }));
    }

    function access() {
        return createScopeAccess({ configPath, auditPath, fetchImpl, resolveSecret });
    }

    async function audit() {
        return (await readFile(auditPath, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    }

    beforeEach(async () => {
        fetchImpl.mockReset().mockImplementation(async () => elkResponse());
        resolveSecret.mockReset().mockResolvedValue(credential);
        root = await realpath(await mkdtemp(join(tmpdir(), 'feedback-scope-')));
        configPath = join(root, 'scopes.json');
        auditPath = join(root, 'scope-audit.jsonl');
        [a, b] = await Promise.all([fixtures(root, 'a'), fixtures(root, 'b')]);
        await configure();
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('reads the pinned Git blob, a local guide, and only necessary ELK fields', async () => {
        const bound = access().forWork(work);
        await expect(bound.validate()).resolves.toEqual({
            project_slug: work.project_slug, environment: work.environment, scope_revision: work.scope_revision,
        });
        const repo = a.repositories[0];
        await writeFile(join(repo.directory, repoRead.path), 'Uncommitted and untrusted\n');
        await expect(bound.execute(repoRead)).resolves.toEqual({
            repo_id: 'repo-a', commit: repo.base_commit, content: 'Source a\nPASSWORD=[已遮罩]\n',
        });
        await expect(bound.execute(guideRead)).resolves.toEqual({ guide_id: 'guide-a', content: 'Guide a\n' });
        await expect(bound.execute(elkQuery)).resolves.toEqual({
            index: 'logs-a-test', template_id: 'errors',
            rows: [{
                '@timestamp': '2026-11-20T00:01:00Z',
                message: 'Fixture result includes [已遮罩]',
                'user.email': '[已遮罩]',
                api_token: '[已遮罩]',
            }],
        });
        expect(resolveSecret).toHaveBeenCalledExactlyOnceWith('FIXTURE_ELK_TOKEN');
        const [[url, init]] = fetchImpl.mock.calls;
        expect(url.href).toBe('https://elk.invalid/logs-a-test/_search');
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + credential } });
        expect(JSON.parse(init.body as string)).toMatchObject({
            size: 1, _source: a.elk.fields, query: { bool: { filter: [
                { range: { '@timestamp': { gte: elkQuery.from, lt: elkQuery.to } } },
                { term: { 'service.name': 'service-a' } },
                { term: { 'log.level': 'error' } },
            ] } },
        });
        const records = await audit();
        expect(records.map(record => record.decision)).toEqual([
            'allowed', 'authorized', 'allowed', 'authorized', 'allowed', 'authorized', 'allowed',
        ]);
        expect(records[2]).toMatchObject({
            ...work, operation: 'read_repo_file', target: { repo_id: 'repo-a', commit: repo.base_commit },
        });
        expect(JSON.stringify(records)).not.toMatch(/fixture-password|docs\/source\.md|fixture-only-elk-credential/);
    });

    it('rejects a second project, work overrides and unsupported operations without resolving credentials', async () => {
        const bound = access().forWork(work);
        await expect(bound.execute({ ...repoRead, repo_id: 'repo-b' })).rejects.toMatchObject({ code: 'source_not_allowed' });
        await expect(bound.execute({ ...guideRead, guide_id: 'guide-b' })).rejects.toMatchObject({ code: 'source_not_allowed' });
        await expect(bound.execute({ ...elkQuery, index: 'logs-b-test' })).rejects.toMatchObject({ code: 'index_not_allowed' });
        await expect(bound.execute({ ...repoRead, project_slug: 'project-b', command: 'fixture-command-text' }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        await expect(bound.execute({ operation: 'read_secret', ref: 'FIXTURE_ELK_TOKEN' }))
            .rejects.toMatchObject({ code: 'operation_not_allowed' });
        await expect(bound.execute({ operation: 'git_push', remote: 'https://unknown.invalid' }))
            .rejects.toBeInstanceOf(ScopeError);
        await expect(access().forWork({ ...work, environment: 'production' }).validate())
            .rejects.toMatchObject({ code: 'unknown_scope' });
        await expect(access().forWork({ ...work, scope_revision: 'older' }).validate())
            .rejects.toMatchObject({ code: 'scope_revision_mismatch' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(resolveSecret).not.toHaveBeenCalled();
        const records = await audit();
        expect(records).toHaveLength(8);
        expect(records.every(record => record.decision === 'denied')).toBe(true);
        expect(JSON.stringify(records)).not.toMatch(/fixture-command-text|FIXTURE_ELK_TOKEN|unknown\.invalid|logs-b-test/);
    });

    it('blocks Git remote mismatch and an unapproved pinned commit', async () => {
        const bound = access().forWork(work);
        const repo = a.repositories[0];
        git(repo.directory, 'remote', 'set-url', 'origin', b.repositories[0].remote);
        await expect(bound.execute(repoRead)).rejects.toMatchObject({ code: 'remote_not_allowed' });
        git(repo.directory, 'remote', 'set-url', 'origin', repo.remote);
        git(repo.directory, 'checkout', '--orphan', 'replacement');
        git(repo.directory, '-c', 'user.name=Scope Test', '-c', 'user.email=scope@fixture.invalid',
            '-c', 'commit.gpgsign=false', 'commit', '-m', 'Unrelated base');
        git(repo.directory, 'branch', '-f', 'main', 'HEAD');
        await expect(bound.execute(repoRead)).rejects.toMatchObject({ code: 'commit_not_allowed' });
        expect((await audit()).filter(entry => entry.decision === 'denied').map(entry => entry.reason))
            .toEqual(['remote_not_allowed', 'commit_not_allowed']);
    });

    it('rejects traversal, dotfiles, Git symlinks, and local symlink components', async () => {
        const bound = access().forWork(work);
        const local = a.guides[0].directory;
        await symlink(join(b.guides[0].directory, 'manual/setup.md'), join(local, 'manual/link.md'));
        await symlink(join(b.guides[0].directory, 'manual'), join(local, 'manual/link-dir'));
        await link(join(b.guides[0].directory, 'manual/setup.md'), join(local, 'manual/hardlink.md'));

        for (const path of ['docs/../outside.md', 'outside.md', '/etc/passwd', 'docs/.env', 'docs/link.md']) {
            await expect(bound.execute({ ...repoRead, path })).rejects.toMatchObject({ code: 'path_not_allowed' });
        }
        for (const path of ['manual/link.md', 'manual/link-dir/setup.md', 'manual/hardlink.md', 'manual/../../guide-b/manual/setup.md', 'manual/.env']) {
            await expect(bound.execute({ ...guideRead, path })).rejects.toMatchObject({ code: 'path_not_allowed' });
        }
        const records = await audit();
        expect(records.filter(record => record.decision === 'denied')).toHaveLength(10);
        expect(JSON.stringify(records)).not.toMatch(/outside\.md|\/etc\/passwd|link-dir|FIXTURE_HIDDEN_SECRET/);
    });

    it('rejects raw queries, unlisted templates/services and excessive dates or limits before transport', async () => {
        const bound = access().forWork(work);
        const overrides = [
            { template_id: 'unknown' }, { service: 'service-b' }, { limit: 3 },
            { to: '2026-11-21T00:00:00Z' }, { from: '2026-02-30T00:00:00Z' },
            { from: 'now-10m' }, { to: elkQuery.from },
        ];
        for (const override of overrides) {
            await expect(bound.execute({ ...elkQuery, ...override })).rejects.toMatchObject({ code: 'query_not_allowed' });
        }
        await expect(bound.execute({ ...elkQuery, index: 'logs-*' })).rejects.toMatchObject({ code: 'index_not_allowed' });
        await expect(bound.execute({ ...elkQuery, query: { match_all: {} } }))
            .rejects.toMatchObject({ code: 'invalid_request' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(resolveSecret).not.toHaveBeenCalled();
    });

    it('rereads invalidated grants before successive calls and when a credential is being resolved', async () => {
        const bound = access().forWork(work);
        await bound.validate();
        a.enabled = false;
        await configure();
        await expect(bound.execute(guideRead)).rejects.toMatchObject({ code: 'scope_revoked' });
        a.enabled = true;
        await configure();
        resolveSecret.mockImplementationOnce(async () => {
            a.scope_revision = 'rev-a2';
            await configure();
            return credential;
        });
        await expect(bound.execute(elkQuery)).rejects.toMatchObject({ code: 'scope_revision_mismatch' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect((await audit()).at(-1)).toMatchObject({ decision: 'denied', reason: 'scope_revision_mismatch' });
    });

    it('does not broaden a bound grant when entries are changed without a revision bump', async () => {
        const bound = access().forWork(work);
        await bound.validate();
        a.repositories.push(b.repositories[0]);
        await configure();
        await expect(bound.execute({ ...repoRead, repo_id: 'repo-b' })).rejects.toMatchObject({ code: 'scope_changed' });
        expect((await audit()).at(-1)).toMatchObject({ decision: 'denied', reason: 'scope_changed' });
    });

    it('withholds data when scope changes during an ELK call', async () => {
        const bound = access().forWork(work);
        fetchImpl.mockImplementationOnce(async () => {
            await configure([b]);
            return elkResponse();
        });
        await expect(bound.execute(elkQuery)).rejects.toMatchObject({ code: 'unknown_scope' });
        expect((await audit()).at(-1)).toMatchObject({ decision: 'denied', reason: 'unknown_scope' });
    });

    it('fails if the audit destination cannot be opened safely', async () => {
        await symlink(configPath, auditPath);
        await expect(access().forWork(work).execute(elkQuery)).rejects.toMatchObject({ code: 'audit_unavailable' });
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(resolveSecret).not.toHaveBeenCalled();
    });
});
