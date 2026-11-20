import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { QueueError } from '../consumer/queue.mjs';
import { readBoundedPath, requireScope, ScopeError } from '../scope/policy.mjs';

const MAX_EDIT_FILE = 1024 * 1024;
const GIT_ENV = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
};
const SAFE_CONFIG = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.autocrlf=false', '-c', 'core.protectHFS=true', '-c', 'core.protectNTFS=true',
    '-c', 'commit.gpgSign=false', '-c', 'push.gpgSign=false', '-c', 'push.followTags=false',
    '-c', 'credential.helper=', '-c', 'http.followRedirects=false',
];

export async function git(cwd, args, { signal, env, input, timeout = 5000, maxBuffer = MAX_EDIT_FILE + 8192 } = {}) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = execFile('git', [...SAFE_CONFIG, ...args], {
            cwd, signal, env: { ...GIT_ENV, ...env }, timeout, killSignal: 'SIGKILL',
            encoding: 'buffer', maxBuffer,
        }, (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
    });
}

async function gitText(cwd, args, options) {
    return (await git(cwd, args, options)).toString('utf8').replace(/\n$/, '');
}

async function verifySource(repo, signal) {
    const { directory, base_branch, base_commit } = repo;
    const dir = join(directory, '.git');
    const objects = join(dir, 'objects');
    try {
        requireScope(await realpath(directory) === directory && (await lstat(dir)).isDirectory() &&
            (await lstat(objects)).isDirectory() && !objects.includes('\n'), 'repair_repo_not_allowed');
        const opt = { signal };
        const repoGit = (...args) => gitText(directory, ['--git-dir', dir, ...args], opt);
        requireScope(await repoGit('config', '--local', '--no-includes', '--get-all', 'remote.origin.url') === repo.remote,
            'repair_remote_not_allowed');
        requireScope(await repoGit('rev-parse', '--verify', base_commit + '^{commit}') === base_commit, 'repair_base_not_allowed');
        const ref = await repoGit('show-ref', '--verify', '--hash', 'refs/heads/' + base_branch);
        await repoGit('merge-base', '--is-ancestor', base_commit, ref);
        try {
            await lstat(join(objects, 'info', 'alternates'));
            throw new ScopeError('repair_repo_not_allowed');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        return objects;
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScopeError) throw error;
        throw new ScopeError('repair_base_not_allowed');
    }
}

async function privateRecoveryDirectory(path) {
    try {
        const stat = await lstat(path);
        requireScope(stat.isDirectory() && await realpath(path) === path && stat.uid === process.getuid() &&
            (stat.mode & 0o077) === 0, 'repair_recovery_not_private');
        return await mkdtemp(join(path, 'feedback-repair-'));
    } catch {
        throw new ScopeError('repair_recovery_not_private');
    }
}

export async function withWorktree(repo, branch, recoveryDirectory, signal, run) {
    const objects = await verifySource(repo, signal);
    const directory = await privateRecoveryDirectory(recoveryDirectory);
    const bare = join(directory, 'repo.git');
    const tree = join(directory, 'worktree');
    let prepared = false;
    let completed = false;
    try {
        try {
            const opt = { signal };
            await git(directory, ['check-ref-format', 'refs/heads/' + branch], opt);
            await git(directory, ['init', '--bare', '--template=', '--object-format=' +
                (repo.base_commit.length === 64 ? 'sha256' : 'sha1'), bare], opt);
            await writeFile(join(bare, 'objects', 'info', 'alternates'), objects + '\n', { flag: 'wx', mode: 0o600 });
            await git(bare, ['worktree', 'add', '-b', branch, '--', tree, repo.base_commit], { signal, timeout: 60_000 });
            prepared = true;
        } catch {
            signal.throwIfAborted();
            throw new ScopeError('repair_worktree_failed');
        }
        const result = await run({ directory, tree });
        completed = true;
        return result;
    } finally {
        if (completed || !prepared) await rm(directory, { recursive: true, force: true });
    }
}

async function editableEntry(tree, base, path, signal) {
    const entry = await gitText(tree, ['ls-tree', '-z', base, '--', path], { signal });
    const match = /^(100(?:644|755)) blob ([0-9a-f]{40,64})\t([^\0]+)\0$/u.exec(entry);
    requireScope(match && match[3] === path, 'repair_path_not_allowed');
    const segments = path.split('/');
    let file = tree;
    for (const segment of segments.slice(0, -1)) {
        file = join(file, segment);
        requireScope((await lstat(file)).isDirectory(), 'repair_path_not_allowed');
    }
    file = join(file, segments.at(-1));
    requireScope(await realpath(file) === file, 'repair_path_not_allowed');
    const bytes = await readBoundedPath(file, MAX_EDIT_FILE, 'repair_file_too_large', 'repair_path_not_allowed',
        stat => requireScope(stat.nlink === 1, 'repair_path_not_allowed'));
    requireScope((await git(tree, ['cat-file', 'blob', match[2]], { signal })).equals(bytes), 'repair_checkout_changed');
    return { file, mode: match[1], text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
}

export async function applyEdits(tree, base, changes, signal) {
    const files = new Map();
    try {
        for (const { path, before, after } of changes) {
            signal.throwIfAborted();
            const entry = files.get(path) ?? await editableEntry(tree, base, path, signal);
            requireScope(!entry.text.includes('\0'), 'repair_path_not_allowed');
            const start = entry.text.indexOf(before);
            requireScope(start >= 0 && entry.text.indexOf(before, start + 1) === -1, 'repair_edit_not_unique');
            entry.text = entry.text.slice(0, start) + after + entry.text.slice(start + before.length);
            const bytes = Buffer.from(entry.text, 'utf8');
            requireScope(bytes.length <= MAX_EDIT_FILE && bytes.toString('utf8') === entry.text, 'repair_edit_not_utf8');
            files.set(path, entry);
        }
        for (const [path, { file, mode, text }] of files) {
            const opt = { signal };
            const blob = await gitText(tree, ['hash-object', '-w', '--stdin', '--no-filters'], { ...opt, input: text });
            await writeFile(file, text, { flag: constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW });
            await git(tree, ['update-index', '--cacheinfo', mode, blob, path], opt);
        }
        const indexTree = await gitText(tree, ['write-tree'], { signal });
        const baseTree = await gitText(tree, ['rev-parse', '--verify', base + '^{tree}'], { signal });
        requireScope(indexTree !== baseTree, 'repair_empty_diff');
        return indexTree;
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScopeError) throw error;
        throw new ScopeError('repair_edit_failed');
    }
}

export async function commitRepair(tree, branch, base, indexTree, operation, signal) {
    try {
        const timestamp = await gitText(tree, ['show', '-s', '--format=%ct', base], { signal });
        const date = Number(timestamp) + 1;
        requireScope(Number.isSafeInteger(date) && date > 0, 'repair_commit_failed');
        const sha = await gitText(tree, ['commit-tree', indexTree, '-p', base, '-m', 'Feedback Desk repair ' + operation], {
            signal,
            env: {
                GIT_AUTHOR_NAME: 'Feedback Desk', GIT_AUTHOR_EMAIL: 'automation@feedback-desk.invalid',
                GIT_COMMITTER_NAME: 'Feedback Desk', GIT_COMMITTER_EMAIL: 'automation@feedback-desk.invalid',
                GIT_AUTHOR_DATE: '@' + date + ' +0000', GIT_COMMITTER_DATE: '@' + date + ' +0000',
            },
        });
        await git(tree, ['update-ref', 'refs/heads/' + branch, sha, base], { signal });
        return sha;
    } catch {
        signal.throwIfAborted();
        throw new ScopeError('repair_commit_failed');
    }
}

export function createGitTransport(tree, remote, gitlab, credential, signal, fixtureRemote) {
    const caFile = process.env.GIT_SSL_CAINFO;
    const opt = {
        signal, timeout: 30_000,
        env: fixtureRemote ? { GIT_ALLOW_PROTOCOL: 'file' } : {
            GIT_ALLOW_PROTOCOL: 'https', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader',
            GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from(gitlab.push_username + ':' + credential).toString('base64'),
            ...(caFile && { GIT_SSL_CAINFO: caFile }),
        },
    };
    const endpoint = fixtureRemote ?? remote;

    return {
        async remoteHead(branch) {
            const ref = 'refs/heads/' + branch;
            try {
                const output = await gitText(tree, ['ls-remote', '--refs', '--exit-code', '--', endpoint, ref], opt);
                const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/u.exec(output);
                requireScope(match && match[2] === ref, 'repair_remote_unverified');
                return match[1];
            } catch (error) {
                signal.throwIfAborted();
                if (error.code === 2) return null;
                if (error instanceof ScopeError) throw error;
                throw new QueueError('repair_remote_unverified', { retryable: true });
            }
        },
        async createBranch(branch, sha) {
            const ref = 'refs/heads/' + branch;
            try {
                await git(tree, ['push', '--porcelain', '--force-with-lease=' + ref + ':', '--', endpoint, sha + ':' + ref], opt);
                return true;
            } catch {
                signal.throwIfAborted();
                return false;
            }
        },
    };
}
