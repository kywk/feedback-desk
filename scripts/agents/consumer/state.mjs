import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function createCursorStore(path, scope) {
    const file = resolve(path);
    const initial = { schema_version: 1, scope, cursor: '0', poll_failures: 0, poll_retry_at: 0 };
    return {
        async load() {
            let handle;
            try {
                handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                const status = await handle.stat();
                if (!status.isFile() || status.size > 4096 || (status.mode & 0o077) !== 0) throw new Error();
                const state = JSON.parse(await handle.readFile('utf8'));
                if (state.schema_version !== 1 || !Object.keys(scope).every(key => state.scope?.[key] === scope[key]) ||
                    typeof state.cursor !== 'string' || !/^\d{1,16}$/.test(state.cursor) ||
                    !Number.isSafeInteger(Number(state.cursor)) ||
                    !Number.isSafeInteger(state.poll_failures) || state.poll_failures < 0 ||
                    !Number.isSafeInteger(state.poll_retry_at) || state.poll_retry_at < 0) throw new Error();
                return { ...initial, cursor: state.cursor, poll_failures: state.poll_failures, poll_retry_at: state.poll_retry_at };
            } catch (error) {
                if (!handle && error.code === 'ENOENT') return initial;
                throw new Error('consumer_state_invalid');
            } finally {
                if (handle) await handle.close();
            }
        },
        async save(state) {
            const temporary = file + '.' + randomUUID();
            try {
                const handle = await open(temporary, 'wx', 0o600);
                try {
                    await handle.writeFile(JSON.stringify(state) + '\n');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                await rename(temporary, file);
            } catch {
                await rm(temporary, { force: true }).catch(() => {});
                throw new Error('consumer_state_unavailable');
            }
        },
    };
}
