// Materialize pinned upstream trees as independent local Git repositories.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtures = JSON.parse(await readFile(new URL('projects.json', import.meta.url), 'utf8'));
const defaultRoot = fileURLToPath(new URL('../../../.feedback-desk/isolated-projects', import.meta.url));
const checkImage = 'node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293';
const gitEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Feedback Desk Fixtures',
    GIT_AUTHOR_EMAIL: 'fixtures@feedback-desk.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Feedback Desk Fixtures',
    GIT_COMMITTER_EMAIL: 'fixtures@feedback-desk.invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function git(cwd, args, input) {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', ...args], {
        cwd, input, env: gitEnv, stdio: ['pipe', 'pipe', 'inherit'],
    });
}

function gitText(dir, args) {
    return git(dir, args).toString('utf8').trim();
}

function repository(spec, root, commit) {
    const dir = join(root, spec.id);
    return {
        id: spec.id, directory: join(dir, 'repo'), remote: pathToFileURL(join(dir, 'origin.git')).href,
        base_branch: 'main', base_commit: commit, read_paths: spec.read_paths,
        repair: {
            mode: 'local', allowed_paths: spec.allowed_paths, branch_prefix: 'feedback/',
            recovery_directory: join(dir, 'recovery'), test_image: checkImage, checks: spec.checks,
        },
    };
}

function makeScope(repo) {
    return {
        project_slug: 'sandbox-' + repo.id, environment: 'local', scope_revision: 'fixture-v1-' + repo.base_commit.slice(0, 12),
        repositories: [repo], guides: [],
    };
}

function registerSql(scope) {
    const repo = scope.repositories[0];
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const projectId = '(SELECT id FROM projects WHERE slug = ' + quote(scope.project_slug) + ')';
    const keys = [projectId, quote(scope.environment), quote(scope.scope_revision)].join(', ');
    const checks = repo.repair.checks.map(check => check.id);
    return [
        '-- Run only against the isolated D1 containing this project and scope.',
        'INSERT INTO automation_policies (project_id, environment, scope_revision, auto_reply)',
        `VALUES (${keys}, 0) ON CONFLICT (project_id, environment, scope_revision) DO NOTHING;`,
        'INSERT INTO automation_repositories (project_id, environment, scope_revision, repo_id, delivery_mode, gitlab_project_id, base_branch, base_commit, branch_prefix, required_check_ids)',
        `VALUES (${keys}, ${quote(repo.id)}, 'local', NULL, 'main', ${quote(repo.base_commit)}, ${quote(repo.repair.branch_prefix)}, ${quote(JSON.stringify(checks))})`,
        'ON CONFLICT (project_id, environment, scope_revision, repo_id) DO NOTHING;',
        '',
    ].join('\n');
}

async function materialize(spec, staging, root) {
    const dir = join(staging, spec.id);
    await mkdir(dir);
    const source = join(dir, 'upstream.git');
    const bare = join(dir, 'origin.git');
    git(dir, ['init', '-q', '--bare', source]);
    git(source, ['fetch', '-q', '--no-tags', '--depth=1', spec.upstream, spec.commit]);
    if (gitText(source, ['rev-parse', 'FETCH_HEAD^{commit}']) !== spec.commit) throw new Error('Unexpected upstream commit');

    let tree = gitText(source, ['rev-parse', spec.commit + '^{tree}']);
    if (spec.include.length) {
        for (const path of spec.include) git(source, ['cat-file', '-e', spec.commit + ':' + path]);
        const entries = git(source, ['ls-tree', '-rz', spec.commit, '--', ...spec.include]);
        git(source, ['update-index', '-z', '--index-info'], entries);
        tree = gitText(source, ['write-tree']);
    }
    // A parentless snapshot retains Git file modes, blobs and licenses without retaining a writable upstream.
    const message = `Import ${spec.id} isolated fixture\n\nSource: ${spec.upstream}\nCommit: ${spec.commit}`;
    const commit = gitText(source, ['commit-tree', tree, '-m', message]);
    if (commit !== spec.base_commit) throw new Error('Unexpected fixture snapshot: ' + spec.id);
    git(source, ['update-ref', 'refs/heads/main', commit]);
    git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
    git(bare, ['fetch', '-q', '--no-tags', pathToFileURL(source).href, 'refs/heads/main:refs/heads/main']);
    git(dir, ['clone', '-q', pathToFileURL(bare).href, 'repo']);
    const repo = repository(spec, root, commit);
    git(join(dir, 'repo'), ['remote', 'set-url', 'origin', repo.remote]);
    await rm(source, { recursive: true });
    await mkdir(join(dir, 'recovery'), { mode: 0o700 });
    const scope = makeScope(repo);
    await writeFile(join(dir, 'register.sql'), registerSql(scope));
    return scope;
}

async function check(root) {
    const config = JSON.parse(await readFile(join(root, 'scope.json'), 'utf8'));
    if (config.scopes?.length !== fixtures.length) throw new Error('Unexpected scope list');
    for (const spec of fixtures) {
        const bare = join(root, spec.id, 'origin.git');
        const commit = gitText(bare, ['rev-parse', 'refs/heads/main']);
        const scope = makeScope(repository(spec, root, commit));
        const repo = scope.repositories[0];
        const actual = config.scopes.find(item => item.project_slug === scope.project_slug);
        const message = gitText(bare, ['show', '-s', '--format=%B', commit]);
        if (commit !== spec.base_commit || JSON.stringify(actual) !== JSON.stringify(scope) ||
            !message.endsWith('Commit: ' + spec.commit) ||
            gitText(bare, ['remote']) !== '' ||
            gitText(repo.directory, ['rev-parse', 'refs/heads/main']) !== commit ||
            gitText(repo.directory, ['remote']) !== 'origin' ||
            gitText(repo.directory, ['remote', 'get-url', 'origin']) !== repo.remote ||
            gitText(repo.directory, ['remote', 'get-url', '--push', '--all', 'origin']) !== repo.remote) {
            throw new Error('Existing fixture or configuration differs: ' + spec.id);
        }
        console.log(`${scope.project_slug}  ${commit}  ${repo.directory}`);
    }
}

async function main(args) {
    if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: node scripts/agents/fixtures/prepare.mjs [directory]');
    const target = resolve(args[0] ?? defaultRoot);
    await mkdir(dirname(target), { recursive: true });
    const root = join(await realpath(dirname(target)), basename(target));
    let present;
    try { present = await realpath(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (present) {
        if (present !== root) throw new Error('Fixture directory must not be a symlink');
        return check(root);
    }
    const staging = await mkdtemp(root + '.tmp-');
    try {
        const scopes = [];
        for (const spec of fixtures) scopes.push(await materialize(spec, staging, root));
        await writeFile(join(staging, 'scope.json'), JSON.stringify({ scopes }, null, 2) + '\n', { mode: 0o600 });
        await rename(staging, root);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    await check(root);
}

await main(process.argv.slice(2));
