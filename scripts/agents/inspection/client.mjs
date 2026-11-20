import { setTimeout as delay } from 'node:timers/promises';
import { retryDelay } from '../consumer/queue.mjs';

const MAX_RESPONSE_BYTES = 256 * 1024;

export class InspectionError extends Error {
    constructor(reason, { retryAfterMs = 0, status } = {}) {
        super(reason);
        this.retryAfterMs = retryAfterMs;
        this.status = status;
    }
}

function retryAfter(value) {
    if (!value) return 0;
    const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isSafeInteger(ms) && ms > 0 ? ms : 0;
}

async function readJson(response, service) {
    const reader = response.body?.getReader();
    if (!reader) throw new InspectionError(service + '_invalid_response');
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new InspectionError(service + '_invalid_response');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new InspectionError(service + '_invalid_response');
    }
}

export function createClient({ service, origin, token, fetchImpl, signal, maxAttempts, retryBaseMs }) {
    return async function request(path, data) {
        for (let attempt = 1; ; attempt++) {
            let failure;
            try {
                signal.throwIfAborted();
                const response = await fetchImpl(new URL(path, origin), {
                    method: data === undefined ? 'GET' : 'POST',
                    cache: 'no-store',
                    headers: {
                        ...(token === undefined ? {} : { authorization: 'Bearer ' + token }),
                        accept: 'application/json',
                        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    redirect: 'error',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
                });
                if (response.ok) return await readJson(response, service);
                await response.body?.cancel().catch(() => {});
                failure = new InspectionError(service + '_http_error', {
                    status: response.status,
                    retryAfterMs: retryAfter(response.headers.get('retry-after')),
                });
                if (response.status !== 408 && response.status !== 429 && response.status < 500) throw failure;
            } catch (error) {
                signal.throwIfAborted();
                if (error instanceof InspectionError) throw error;
                failure = new InspectionError(service + '_unavailable');
            }
            // Long server-directed delays are handled by the workspace scheduler.
            if (attempt >= maxAttempts || failure.retryAfterMs > 60_000) throw failure;
            await delay(retryDelay(attempt, retryBaseMs, failure.retryAfterMs), undefined, { signal });
        }
    };
}
