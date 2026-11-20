import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InspectionError } from '../inspection/client.mjs';
import { digest } from '../inspection/state.mjs';

async function privateDirectory(path) {
    try {
        await mkdir(path, { mode: 0o700, recursive: true });
        const info = await lstat(path);
        if (!info.isDirectory() || (info.mode & 0o077)) throw new Error();
    } catch {
        throw new InspectionError('deployment_state_unavailable');
    }
}

export async function readBounded(path, limit, privateFile = false) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > limit || (privateFile && (info.mode & 0o077))) throw new Error();
        // Read one extra byte to reject files which grew after stat.
        const bytes = Buffer.allocUnsafe(limit + 1);
        let count = 0;
        while (count <= limit) {
            const { bytesRead } = await handle.read(bytes, count, bytes.length - count, null);
            if (bytesRead === 0) return bytes.subarray(0, count);
            count += bytesRead;
        }
        throw new Error();
    } finally {
        await handle.close();
    }
}

export async function createOutbox(path) {
    const root = resolve(path);
    await privateDirectory(root);

    async function read(file) {
        try {
            return JSON.parse(await readBounded(file, 64 * 1024, true));
        } catch (error) {
            if (error.code === 'ENOENT') return undefined;
            throw new InspectionError('deployment_state_invalid');
        }
    }

    return async function sourceOutbox(sourceKey) {
        const directory = join(root, sourceKey);
        await privateDirectory(directory);

        async function persist(file, data) {
            const contents = JSON.stringify(data);
            const temporary = join(directory, '.' + randomUUID() + '.tmp');
            try {
                const handle = await open(temporary, 'wx', 0o600);
                try {
                    await handle.writeFile(contents + '\n');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                try {
                    await link(temporary, file);
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    if (JSON.stringify(await read(file)) !== contents) throw new InspectionError('deployment_state_conflict');
                }
                const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                try {
                    await parent.sync();
                } finally {
                    await parent.close();
                }
            } catch (error) {
                if (error instanceof InspectionError) throw error;
                throw new InspectionError('deployment_state_unavailable');
            } finally {
                await rm(temporary, { force: true }).catch(() => {});
            }
        }

        function entry(kind, key) {
            const prefix = join(directory, kind + '-' + digest(key));
            return {
                read: () => read(prefix + '.request.json'),
                put: value => persist(prefix + '.request.json', value),
                ack: receipt => persist(prefix + '.receipt.json', receipt),
            };
        }

        return {
            entry,
            async *pending(kind) {
                for (const name of await readdir(directory)) {
                    if (!name.startsWith(kind + '-') || !name.endsWith('.request.json')) continue;
                    const prefix = name.slice(0, -'.request.json'.length);
                    if (await read(join(directory, prefix + '.receipt.json')) !== undefined) continue;
                    const request = await read(join(directory, name));
                    if (request !== undefined) yield request;
                }
            },
        };
    };
}
