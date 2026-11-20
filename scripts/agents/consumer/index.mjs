import { setTimeout as sleep } from 'node:timers/promises';
import { createQueueClient, leaseOf, LEASE_FIELDS, QueueError, retryDelay, STAGES } from './queue.mjs';
import { createCursorStore } from './state.mjs';
import { ScopeError } from '../scope/index.mjs';
import { AnalysisError } from '../../../src/shared/automation-analysis.mjs';

const MAX_TIMER_MS = 2_147_483_647;
const RETRYABLE_SCOPE = new Set([
    'repository_unavailable', 'guide_unavailable', 'elk_unavailable',
    'scope_unavailable', 'credential_unavailable', 'audit_unavailable',
]);

export class RetryableWorkError extends Error {
    constructor(code, { retryAfterMs = 0 } = {}) {
        super('retryable_handler_failure');
        this.code = typeof code === 'string' && /^[a-z0-9][a-z0-9_]{0,47}$/.test(code) && !code.startsWith('fda_')
            ? code : 'retryable_handler_failure';
        this.retryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= 31_536_000_000
            ? retryAfterMs : 0;
    }
}

async function pause(ms, signal) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        await sleep(Math.min(MAX_TIMER_MS, end - Date.now()), undefined, { signal });
    }
    signal.throwIfAborted();
}

function guardResult(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).then(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

function fenced(error) {
    return error instanceof QueueError && [401, 403, 409].includes(error.status);
}

async function retryRequest(call, options, signal) {
    for (let attempt = 1; ; attempt += 1) {
        signal.throwIfAborted();
        try {
            return await call();
        } catch (error) {
            if (!(error instanceof QueueError) || !error.retryable || attempt >= options.maxAttempts) throw error;
            await pause(retryDelay(attempt, options.retryBaseMs, error.retryAfterMs), signal);
        }
    }
}

function leaseGuard(queue, work, options, parentSignal, log) {
    const lease = leaseOf(work);
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    let deadline;
    let expiry;
    let renewal;
    let heartbeat;
    let closed = false;

    function lose(reason) {
        if (signal.aborted || closed) return;
        log('lease_lost', { reason });
        controller.abort(new Error('lease_lost'));
    }

    function setExpiry(value) {
        deadline = Date.parse(value);
        clearTimeout(expiry);
        const remaining = deadline - Date.now();
        if (remaining <= 0) lose('lease_expired');
        else expiry = setTimeout(() => lose('lease_expired'), Math.min(MAX_TIMER_MS, remaining));
    }

    function ensure() {
        if (Date.now() >= deadline) lose('lease_expired');
        signal.throwIfAborted();
    }

    function renew() {
        ensure();
        renewal ??= retryRequest(() => queue.renew(lease, signal), options, signal)
            .then(result => {
                ensure();
                setExpiry(result.lease_expires_at);
                ensure();
                return result;
            })
            .catch(error => {
                lose(error instanceof QueueError ? error.code : 'renew_failed');
                throw error;
            })
            .finally(() => { renewal = undefined; });
        return renewal;
    }

    setExpiry(work.lease_expires_at);
    heartbeat = setInterval(() => { Promise.resolve().then(renew).catch(() => {}); }, options.heartbeatMs);

    return {
        signal, ensure, renew, lose,
        async stopHeartbeat() {
            clearInterval(heartbeat);
            if (renewal) await renewal;
            ensure();
        },
        async save(stage, progress, retryAt) {
            ensure();
            try {
                return await retryRequest(() => queue.progress(lease, stage, progress, retryAt, signal), options, signal);
            } catch (error) {
                if (fenced(error)) lose(error.code);
                throw error;
            }
        },
        close() {
            closed = true;
            clearTimeout(expiry);
            clearInterval(heartbeat);
            controller.abort(new Error('lease_closed'));
        },
    };
}

function objectProgress(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_handler_progress');
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || Buffer.byteLength(json) > 12 * 1024) throw new Error('invalid_handler_progress');
    const result = JSON.parse(json);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid_handler_progress');
    return result;
}

function savedProgress(work) {
    const saved = work.progress;
    if (!saved || typeof saved !== 'object') return { attempt: 0, progress: {} };
    if (Number.isSafeInteger(saved.consumer?.attempt) && saved.consumer.attempt >= 0) {
        return { attempt: saved.consumer.attempt, progress: objectProgress(saved.handler) };
    }
    return { attempt: 0, progress: objectProgress(saved) };
}

function failure(error) {
    if (error instanceof RetryableWorkError) return { reason: error.code, retryable: true, after: error.retryAfterMs };
    if (error instanceof ScopeError) return { reason: error.code, retryable: RETRYABLE_SCOPE.has(error.code) };
    if (error instanceof QueueError) return { reason: error.code, retryable: error.retryable, after: error.retryAfterMs };
    if (error instanceof AnalysisError) return { reason: error.code, retryable: false };
    if (error?.name === 'RepairError' && /^[a-z0-9_]{1,48}$/.test(error.code ?? '')) {
        return { reason: error.code, retryable: error.retryable === true, after: error.retryAfterMs };
    }
    return { reason: 'handler_failed', retryable: false };
}

function workflowQueue(queue, claim, lease, scope, options, ensureHandler) {
    const credentials = leaseOf(claim);
    const transition = { attempted: false, receipt: undefined };

    async function call(method, supplied, values, terminal = false) {
        ensureHandler();
        if (transition.attempted || !LEASE_FIELDS.every(field => supplied?.[field] === credentials[field])) {
            throw new QueueError('invalid_workflow_lease');
        }
        await guardResult(scope.validate(), lease.signal);
        ensureHandler();
        try {
            if (method === 'renew') return await lease.renew();
            if (terminal) {
                await lease.stopHeartbeat();
                ensureHandler();
                transition.attempted = true;
            }
            const result = await retryRequest(
                () => queue[method](credentials, ...values, lease.signal), options, lease.signal,
            );
            if (terminal) transition.receipt = result.receipt;
            return result;
        } catch (error) {
            if (fenced(error)) lease.lose(error.code);
            throw error;
        }
    }

    return { transition, api: Object.freeze({
        input: work => call('input', work, []),
        renew: work => call('renew', work, []),
        intent: (work, body) => call('intent', work, [body]),
        receipt: (work, id, result) => call('receipt', work, [id, result]),
        decisions: (work, body) => call('decisions', work, [body], true),
        mrLinks: (work, body) => call('mrLinks', work, [body], true),
        localBranches: (work, body) => call('localBranches', work, [body], true),
    }) };
}

async function runWork(queue, work, scopeAccess, handleWork, workflow, options, parentSignal, log) {
    const workLog = (event, fields) => log(event, { work_id: work.work_id, lease_generation: work.lease_generation, ...fields });
    const lease = leaseGuard(queue, work, options, parentSignal, workLog);
    workLog('work_claimed', { stage: work.stage });
    try {
        let saved;
        try {
            saved = savedProgress(work);
        } catch {
            await lease.stopHeartbeat();
            await lease.save('blocked', { consumer: { attempt: 0, reason: 'invalid_saved_progress' }, handler: {} });
            workLog('work_finished', { stage: 'blocked', reason: 'invalid_saved_progress' });
            return;
        }
        const attempt = Math.min(saved.attempt + 1, options.maxAttempts);
        let progress = saved.progress;
        const envelope = reason => ({ consumer: { attempt, ...(reason && { reason }) }, handler: progress });
        if (saved.attempt >= options.maxAttempts) {
            await lease.stopHeartbeat();
            await lease.save('blocked', envelope('attempt_limit'));
            workLog('work_finished', { stage: 'blocked', reason: 'attempt_limit', attempt });
            return;
        }
        const scope = scopeAccess.forWork({
            work_id: work.work_id,
            correlation_id: work.event_id,
            actor: work.worker_id,
            project_slug: queue.scope.project_slug,
            environment: queue.scope.environment,
            scope_revision: work.scope_revision,
        });

        let accepting = false;
        let checkpoints = Promise.resolve();
        let checkpointError;
        function ensureHandler() {
            lease.ensure();
            if (!accepting) throw new Error('handler_closed');
        }
        async function checkpoint(data) {
            ensureHandler();
            const next = objectProgress(data);
            const result = checkpoints.then(async () => {
                if (checkpointError) throw checkpointError;
                lease.ensure();
                await guardResult(scope.validate(), lease.signal);
                await lease.save('running', { consumer: { attempt }, handler: next });
                progress = next;
            });
            checkpoints = result.catch(error => { checkpointError ??= error; });
            return result;
        }
        const tools = Object.freeze({
            ...(workflow && {
                async validate() {
                    ensureHandler();
                    await lease.renew();
                    ensureHandler();
                    await guardResult(scope.validate(), lease.signal);
                    ensureHandler();
                },
            }),
            async execute(request) {
                ensureHandler();
                await lease.renew();
                ensureHandler();
                const result = await guardResult(scope.execute(request), lease.signal);
                ensureHandler();
                // A new report revision or manual takeover can invalidate a lease during evidence I/O.
                await lease.renew();
                ensureHandler();
                return result;
            },
        });

        const jobQueue = workflow && workflowQueue(queue, work, lease, scope, options, ensureHandler);
        const handler = workflow ?? handleWork;
        let outcome;
        try {
            lease.ensure();
            await guardResult(scope.validate(), lease.signal);
            await lease.save('running', envelope());
            if (!handler) outcome = { stage: 'waiting_review', reason: 'handler_not_configured' };
            else {
                accepting = true;
                workLog('work_started', { attempt });
                const result = await guardResult(Promise.resolve().then(() => {
                    ensureHandler();
                    return handler({
                        work: Object.freeze({
                            ...leaseOf(work), event_id: work.event_id, correlation_id: work.event_id,
                            stage: work.stage, project_slug: queue.scope.project_slug, environment: queue.scope.environment,
                        }),
                        progress: objectProgress(progress),
                        checkpoint, tools, signal: lease.signal, ...(jobQueue && { queue: jobQueue.api }),
                    });
                }), lease.signal);
                accepting = false;
                if (jobQueue?.transition.receipt) {
                    const receipt = jobQueue.transition.receipt;
                    workLog('work_transitioned', { operation_id: receipt.operation_id });
                    return;
                }
                if (jobQueue?.transition.attempted) throw new QueueError('work_transition_unconfirmed');
                await guardResult(checkpoints, lease.signal);
                if (checkpointError) throw checkpointError;
                if (!STAGES.has(result?.stage)) throw new Error('invalid_handler_result');
                const next = result.progress === undefined ? progress : objectProgress(result.progress);
                await guardResult(scope.validate(), lease.signal);
                progress = next;
                outcome = { stage: result.stage };
            }
        } catch (error) {
            accepting = false;
            if (jobQueue?.transition.attempted) throw error;
            lease.ensure();
            await guardResult(checkpoints, lease.signal);
            const { reason, retryable, after } = failure(checkpointError ?? error);
            outcome = retryable && attempt < options.maxAttempts
                ? { stage: 'queued', reason, retryAt: new Date(Date.now() + retryDelay(attempt, options.retryBaseMs, after)).toISOString() }
                : { stage: 'blocked', reason };
        }

        await lease.stopHeartbeat();
        await lease.save(outcome.stage, envelope(outcome.reason), outcome.retryAt);
        workLog(outcome.retryAt ? 'work_retry_scheduled' : 'work_finished', {
            stage: outcome.stage, attempt, ...(outcome.reason && { reason: outcome.reason }),
            ...(outcome.retryAt && { retry_at: outcome.retryAt }),
        });
    } catch (error) {
        if (parentSignal.aborted) workLog('work_stopped');
        else if (!lease.signal.aborted) workLog('work_write_failed', { reason: failure(error).reason });
    } finally {
        lease.close();
    }
}

export async function runConsumer({
    statePath, scopeAccess, handleWork, workflow, signal = new AbortController().signal, once = false,
    log = () => {}, pollMs = 3000, heartbeatMs = 15_000, retryBaseMs = 1000, maxAttempts = 4,
    ...queueOptions
}) {
    const queue = createQueueClient(queueOptions);
    const store = createCursorStore(statePath, queue.scope);
    const options = { heartbeatMs, retryBaseMs, maxAttempts };
    let state = await store.load();

    try {
        do {
            if (state.poll_retry_at > Date.now()) {
                if (once) {
                    log('poll_deferred', { retry_at: new Date(state.poll_retry_at).toISOString() });
                    return;
                }
                await pause(state.poll_retry_at - Date.now(), signal);
            }
            signal.throwIfAborted();
            let work;
            try {
                const page = await queue.events(state.cursor, signal);
                if (page.next_cursor !== state.cursor) {
                    // The queue was populated in the same D1 transaction as these events. The cursor tracks observation.
                    state = { ...state, cursor: page.next_cursor };
                    await store.save(state);
                    log('events_observed', { cursor: state.cursor, count: page.events.length });
                }
                work = await queue.claim(signal);
            } catch (error) {
                signal.throwIfAborted();
                if (!(error instanceof QueueError)) throw error;
                if (!error.retryable) {
                    log('poll_failed', { reason: error.code, ...(error.status && { status: error.status }) });
                    throw error;
                }
                const failures = Math.min(state.poll_failures + 1, maxAttempts);
                state = { ...state, poll_failures: failures,
                    poll_retry_at: Date.now() + retryDelay(failures, retryBaseMs, error.retryAfterMs) };
                await store.save(state);
                log('poll_failed', {
                    reason: error.code, attempt: failures, retry_at: new Date(state.poll_retry_at).toISOString(),
                    ...(error.status && { status: error.status }),
                });
                if (failures >= maxAttempts) throw error;
                continue;
            }

            if (state.poll_failures || state.poll_retry_at) {
                state = { ...state, poll_failures: 0, poll_retry_at: 0 };
                await store.save(state);
            }
            if (work) await runWork(queue, work, scopeAccess, handleWork, workflow, options, signal, log);
            if (!once) await pause(pollMs, signal);
        } while (!once);
    } catch (error) {
        if (!signal.aborted) throw error;
    }
}
