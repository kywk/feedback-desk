import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { localRepositoryPath, requireScope, ScopeError } from './policy.mjs';

const exec = promisify(execFile);
const GIT_CONFIG_ENV = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_ALLOW_PROTOCOL: '',
};

const BAD_LOCAL_CONFIG = /^(?:include(?:if)?\.|core\.(?:worktree|alternaterefscommand)$|extensions\.(?:worktreeconfig|refstorage)$)/iu;
const BAD_LOCAL_REPO = 'local_repository_not_allowed';

async function localStat(path) {
    try {
        return await lstat(path);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

async function checkEntry(path, type, required = false) {
    const entry = await localStat(path);
    requireScope(entry ? entry[type]() : !required, BAD_LOCAL_REPO);
    return entry;
}

async function inspectGitDir(directory, bare) {
    const config = join(directory, 'config');
    requireScope(await realpath(directory) === directory, BAD_LOCAL_REPO);
    await checkEntry(config, 'isFile', true);
    await checkEntry(join(directory, 'HEAD'), 'isFile', true);
    await checkEntry(join(directory, 'packed-refs'), 'isFile');
    for (const name of ['gitdir', 'commondir']) {
        requireScope(!await localStat(join(directory, name)), BAD_LOCAL_REPO);
    }

    const { stdout } = await exec('git', ['config', '--file', config, '--no-includes', '--null', '--list'], {
        cwd: '/', env: GIT_CONFIG_ENV, timeout: 5000, maxBuffer: 128 * 1024,
    });
    const pairs = stdout.split('\0').filter(Boolean).map(record => {
        const newline = record.indexOf('\n');
        return [newline === -1 ? record : record.slice(0, newline), record.slice(newline + 1)];
    });
    requireScope(pairs.every(([key]) => !BAD_LOCAL_CONFIG.test(key)), BAD_LOCAL_REPO);
    const values = pairs.filter(([key]) => key === 'core.bare').map(([, value]) => value);
    requireScope(values.length === 1 && values[0] === String(bare), BAD_LOCAL_REPO);

    const objects = join(directory, 'objects');
    await checkEntry(objects, 'isDirectory', true);
    const entries = await readdir(objects, { withFileTypes: true, recursive: true });
    requireScope(entries.every(entry => entry.isDirectory() || entry.isFile()), BAD_LOCAL_REPO);
    for (const name of ['alternates', 'http-alternates']) {
        requireScope(!await localStat(join(objects, 'info', name)), BAD_LOCAL_REPO);
    }
    return pairs;
}

export async function inspectLocalRepository(repo) {
    try {
        const directory = localRepositoryPath(repo.remote);
        requireScope(directory && directory !== repo.directory && !directory.startsWith(repo.directory + '/') &&
            !repo.directory.startsWith(directory + '/'), BAD_LOCAL_REPO);
        const identity = await checkEntry(directory, 'isDirectory', true);
        await inspectGitDir(directory, true);
        const cloneConfig = await inspectGitDir(join(repo.directory, '.git'), false);
        const origin = cloneConfig.filter(([key]) => key === 'remote.origin.url').map(([, value]) => value);
        requireScope(origin.length === 1 && origin[0] === repo.remote, 'remote_not_allowed');
        return { directory, device: identity.dev, inode: identity.ino };
    } catch (error) {
        if (error instanceof ScopeError) throw error;
        throw new ScopeError(BAD_LOCAL_REPO);
    }
}

export async function verifyLocalRefPaths(directory, branch) {
    try {
        for (const prefix of ['refs', 'logs/refs']) {
            let path = directory;
            const segments = (prefix + '/heads/' + branch).split('/');
            for (const segment of segments.slice(0, -1)) {
                path = join(path, segment);
                await checkEntry(path, 'isDirectory');
            }
            await checkEntry(join(path, segments.at(-1)), 'isFile');
        }
    } catch {
        throw new ScopeError(BAD_LOCAL_REPO);
    }
}
