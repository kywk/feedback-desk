import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { InspectionError } from './client.mjs';

export function digest(values) {
    return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

function eventIdentity(event) {
    if (!event || typeof event !== 'object') return null;
    const { scope_revision: revision, ...observation } = event;
    return typeof revision === 'string' ? observation : null;
}

export async function createInspectionStore(path) {
    const directory = resolve(path);
    try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(directory);
        if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) throw new Error();
    } catch {
        throw new InspectionError('inspection_state_unavailable');
    }

    async function read(file) {
        let handle;
        try {
            handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = await handle.stat();
            if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error();
            return JSON.parse(await handle.readFile('utf8'));
        } catch (error) {
            if (!handle && error.code === 'ENOENT') return undefined;
            throw new InspectionError('inspection_state_invalid');
        } finally {
            await handle?.close();
        }
    }

    async function write(file, record, identity) {
        const temporary = join(directory, '.' + randomUUID() + '.tmp');
        const contents = JSON.stringify(record);
        try {
            const handle = await open(temporary, 'wx', 0o600);
            try {
                await handle.writeFile(contents + '\n');
                await handle.sync();
            } finally {
                await handle.close();
            }
            if (identity) {
                try {
                    await link(temporary, file);
                } catch (error) {
                    if (error.code !== 'EEXIST') throw error;
                    if (JSON.stringify(identity(await read(file))) !== JSON.stringify(identity(record))) {
                        throw new InspectionError('inspection_state_conflict');
                    }
                }
            } else {
                await rename(temporary, file);
            }
            const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            try {
                await parent.sync();
            } finally {
                await parent.close();
            }
        } catch (error) {
            if (error instanceof InspectionError) throw error;
            throw new InspectionError('inspection_state_unavailable');
        } finally {
            await rm(temporary, { force: true }).catch(() => {});
        }
    }

    return {
        readCursor: stream => read(join(directory, stream + '.cursor.json')),
        saveCursor: (stream, cursor) => write(join(directory, stream + '.cursor.json'), cursor),
        run(stream, runId) {
            const key = join(directory, digest([stream, runId]));
            return {
                // A scope revision authorizes the request. The source Run and event payload remain immutable.
                saveEvent: event => write(key + '.event.json', event, eventIdentity),
                saveReceipt: receipt => write(key + '.receipt.json', receipt, value => value),
                saveResult: result => write(key + '.result.json', result),
            };
        },
    };
}
