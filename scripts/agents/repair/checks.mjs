import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { requireScope, ScopeError } from '../scope/policy.mjs';

const exec = promisify(execFile);
const MAX_ARCHIVE = 256 * 1024 * 1024;
const CHECK_TIMEOUT = 120_000;
const SANDBOX_SCRIPT = 'mkdir source; tar -xf - -C source; cd source; exec "$@"';

function processOptions(directory) {
    return {
        cwd: directory,
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', HOME: directory },
        killSignal: 'SIGKILL',
    };
}

function containerOptions(name, image, argv) {
    return [
        'run', '--rm', '--name', name, '--interactive', '--pull=never', '--network=none',
        '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m,mode=1777',
        '--ipc=none', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--user=65534:65534', '--pids-limit=128', '--memory=512m', '--cpus=1',
        '--workdir=/tmp', '--env', 'HOME=/tmp', '--entrypoint=/bin/sh', image,
        '-eu', '-c', SANDBOX_SCRIPT, 'airedale-check', ...argv,
    ];
}

export async function archiveWorktree(archive, directory, tree, signal) {
    try {
        await exec('tar', ['-c', '-f', archive, '--exclude=./.git', '-C', tree, '.'], {
            ...processOptions(directory), env: { ...processOptions(directory).env, COPYFILE_DISABLE: '1' },
            signal, timeout: 30_000, maxBuffer: 16 * 1024,
        });
        requireScope((await stat(archive)).size <= MAX_ARCHIVE, 'repair_archive_too_large');
    } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ScopeError) throw error;
        throw new ScopeError('repair_archive_failed');
    }
}

export async function verifyInContainer({ directory, archive, image, argv, signal }) {
    signal.throwIfAborted();
    const name = 'feedback-repair-' + randomUUID();
    const options = processOptions(directory);
    const input = await open(archive);
    try {
        const result = await new Promise(resolve => {
            const child = spawn('docker', containerOptions(name, image, argv), {
                ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(CHECK_TIMEOUT)]),
                stdio: [input.fd, 'ignore', 'ignore'],
            });
            child.on('error', () => {});
            child.on('close', code => resolve(code));
        });
        signal.throwIfAborted();
        if (result === 125 || result === null) throw new ScopeError('repair_sandbox_unavailable');
        requireScope(result === 0, 'repair_check_failed');
    } finally {
        await input.close();
        await exec('docker', ['rm', '--force', name], { ...options, timeout: 5000, maxBuffer: 4096 })
            .catch(() => {});
    }
}
