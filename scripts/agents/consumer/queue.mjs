export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
export const LEASE_FIELDS = ['worker_id', 'work_id', 'report_public_id', 'report_revision', 'lease_generation', 'scope_revision'];
export const STAGES = new Set(['waiting_customer', 'waiting_review', 'blocked', 'completed']);
const DENIALS = new Set(['unauthorized', 'scope_forbidden', 'scope_changed', 'lease_conflict', 'invalid_request']);
const MAX_RESPONSE_BYTES = 256 * 1024;

export class QueueError extends Error {
    constructor(code, { retryable = false, retryAfterMs = 0, status } = {}) {
        super(code);
        this.code = code;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        this.status = status;
    }
}

export function retryDelay(attempt, baseMs, retryAfterMs = 0) {
    const exponential = Math.min(60_000, baseMs * 2 ** Math.min(attempt - 1, 16));
    return Math.max(retryAfterMs, Math.round(exponential * (0.75 + Math.random() * 0.25)));
}

function retryAfter(value) {
    if (!value) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isSafeInteger(delay) && delay <= 8_640_000_000_000_000 - Date.now() ? Math.max(0, delay) : 0;
}

async function responseJson(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new QueueError('invalid_queue_response');
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new QueueError('invalid_queue_response');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
}

export function leaseOf(work) {
    return Object.fromEntries(LEASE_FIELDS.map(key => [key, work[key]]));
}

function validateWork(work, identity, lease, released) {
    if (!work || !IDENTIFIER.test(work.work_id ?? '') || !IDENTIFIER.test(work.report_public_id ?? '') ||
        !IDENTIFIER.test(work.event_id ?? '') || !Number.isSafeInteger(work.report_revision) || work.report_revision < 1 ||
        !Number.isSafeInteger(work.lease_generation) || work.lease_generation < 1 ||
        work.scope_revision !== identity.scope_revision ||
        work.worker_id !== (released ? null : identity.worker_id) ||
        (released ? work.lease_expires_at !== null : !Number.isFinite(Date.parse(work.lease_expires_at))) ||
        (lease && LEASE_FIELDS.some(key => !(released && key === 'worker_id') && lease[key] !== work[key]))) {
        throw new QueueError('invalid_queue_response');
    }
    return work;
}

export function createQueueClient(options) {
    const { baseUrl, token, projectSlug, environment, workerId, scopeRevision, fetchImpl = globalThis.fetch } = options;
    const base = new URL(baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
        (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))) {
        throw new QueueError('invalid_queue_url');
    }
    if (![projectSlug, environment].every(value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value ?? '')) ||
        ![workerId, scopeRevision].every(value => IDENTIFIER.test(value ?? '')) ||
        typeof token !== 'string' || !/^fda_[A-Za-z0-9_-]{28,124}$/.test(token)) {
        throw new QueueError('invalid_queue_identity');
    }
    const prefix = '/api/automation/' + projectSlug + '/' + environment;
    const identity = { worker_id: workerId, scope_revision: scopeRevision };

    async function request(path, data, signal) {
        let response;
        let body;
        try {
            signal.throwIfAborted();
            response = await fetchImpl(new URL(prefix + path, base), {
                method: data === undefined ? 'GET' : 'POST',
                redirect: 'error',
                headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            });
            body = await responseJson(response);
        } catch (error) {
            signal.throwIfAborted();
            if (!response || response.ok) {
                if (error instanceof QueueError) throw error;
                throw new QueueError('queue_unavailable', { retryable: true });
            }
        }
        signal.throwIfAborted();
        if (!response.ok) {
            const status = response.status;
            throw new QueueError(DENIALS.has(body?.error) ? body.error : 'queue_http_error', {
                status,
                retryable: status === 408 || status === 429 || status >= 500,
                retryAfterMs: retryAfter(response.headers.get('retry-after')),
            });
        }
        return body;
    }

    return {
        scope: { origin: base.origin, project_slug: projectSlug, environment, worker_id: workerId },
        async events(cursor, signal) {
            const page = await request('/events?after=' + cursor, undefined, signal);
            if (!Array.isArray(page?.events) || page.events.length > 100 ||
                typeof page.next_cursor !== 'string' || !/^\d{1,16}$/.test(page.next_cursor) ||
                !Number.isSafeInteger(Number(page.next_cursor)) || Number(page.next_cursor) < Number(cursor) ||
                (page.events.length > 0 && Number(page.next_cursor) === Number(cursor)) ||
                page.events.some(event => !event || event.source !== 'feedback-desk' || event.schema_version !== 1 ||
                    event.scope?.project_slug !== projectSlug || event.scope?.environment !== environment ||
                    !IDENTIFIER.test(event.event_id ?? ''))) {
                throw new QueueError('invalid_queue_response');
            }
            return page;
        },
        async claim(signal) {
            const result = await request('/claim', identity, signal);
            if (result?.work === null) return null;
            const work = validateWork(result?.work, identity);
            if (work.stage !== 'queued' && work.stage !== 'running') throw new QueueError('invalid_queue_response');
            return work;
        },
        async renew(lease, signal) {
            const result = await request('/renew', lease, signal);
            return validateWork(result?.work, identity, lease);
        },
        async progress(lease, stage, progress, retryAt, signal) {
            const result = await request('/progress', {
                ...lease, stage, progress, ...(retryAt === undefined ? {} : { retry_at: retryAt }),
            }, signal);
            const work = validateWork(result?.work, identity, lease, retryAt !== undefined || STAGES.has(stage));
            if (work.stage !== stage) throw new QueueError('invalid_queue_response');
            return work;
        },
    };
}
