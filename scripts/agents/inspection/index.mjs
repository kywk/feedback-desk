import { setTimeout as delay } from 'node:timers/promises';
import { IDENTIFIER, retryDelay } from '../consumer/queue.mjs';
import { createClient, InspectionError } from './client.mjs';
import { createInspectionStore, digest } from './state.mjs';

const PAGE_LIMIT = 100;
const PATH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,115}$/;
const ENV_REF = /^[A-Z][A-Z0-9_]{0,127}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const REPORT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CURSOR = /^[!-~]{1,1024}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const OBSERVED_FIELDS = ['workspaceId', 'runId', 'testId', 'versionId', 'environment', 'purpose', 'status',
    'attemptId', 'startedAt', 'finishedAt', 'outcome', 'checkKey', 'failureSignature', 'reportUrl'];

function matches(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

function origin(value) {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
    return url.origin;
}

function loadConfig(config) {
    try {
        const whippetOrigin = origin(config.whippet_origin);
        const feedbackOrigin = origin(config.feedback_desk_origin);
        if (whippetOrigin === feedbackOrigin || !Array.isArray(config.sources) || !config.sources.length) throw new Error();
        const sourceIds = new Set();
        const scopeIds = new Set();
        const whippetRefs = new Set(config.sources.map(source => source.whippet_token_env));
        if (whippetRefs.size !== config.sources.length) throw new Error();
        const sources = config.sources.map(source => {
            const { source_id, workspace_id, whippet_environment, project_slug, environment, scope_revision,
                whippet_token_env, feedback_desk_token_env, tests } = source;
            const scopeId = JSON.stringify([workspace_id, whippet_environment]);
            if (![source_id, workspace_id, whippet_environment, project_slug, environment].every(value => matches(value, PATH_ID)) ||
                sourceIds.has(source_id) || scopeIds.has(scopeId) || !matches(scope_revision, IDENTIFIER) ||
                ![whippet_token_env, feedback_desk_token_env].every(value => matches(value, ENV_REF)) ||
                whippetRefs.has(feedback_desk_token_env) || !Array.isArray(tests) || !tests.length) throw new Error();
            sourceIds.add(source_id);
            scopeIds.add(scopeId);
            const checksByTest = new Map();
            for (const { test_id, check_keys } of tests) {
                if (!matches(test_id, PATH_ID) || checksByTest.has(test_id) || !Array.isArray(check_keys) ||
                    !check_keys.length || !check_keys.every(key => matches(key, IDENTIFIER))) throw new Error();
                checksByTest.set(test_id, new Set(check_keys));
            }
            return { source_id, workspace_id, whippet_environment, project_slug, environment, scope_revision,
                whippet_token_env, feedback_desk_token_env, checksByTest,
                stream: digest([whippetOrigin, feedbackOrigin, workspace_id, whippet_environment]) };
        });
        return { whippetOrigin, feedbackOrigin, sources };
    } catch {
        throw new InspectionError('inspection_config_invalid');
    }
}

function getToken(environment, ref, pattern) {
    const token = environment[ref];
    if (!matches(token, pattern)) throw new InspectionError('inspection_credential_unavailable');
    return token;
}

function classify(run, listed, checkKeys) {
    if (listed && !OBSERVED_FIELDS.every(field => run[field] === listed[field])) return 'unverified';
    if (run.purpose !== 'inspection') return run.purpose ? 'purpose_not_inspection' : 'unverified';
    if (![run.testId, run.versionId, run.environment].every(value => matches(value, PATH_ID)) ||
        !matches(run.finishedAt, UTC) || !Number.isFinite(Date.parse(run.finishedAt))) return 'unverified';
    if (!checkKeys) return 'test_not_mapped';
    if (run.status === 'succeeded' && run.outcome === 'passed') return 'passed';
    if (run.status === 'cancelled' && run.outcome === 'cancelled') return 'cancelled';
    if (run.status === 'timed_out' && run.outcome === 'timed_out') return 'timed_out';
    if (['interrupted', 'failed'].includes(run.status) && run.outcome === 'infrastructure') return 'infrastructure';
    if (run.status === 'failed' && run.outcome === 'assertion_failed' && matches(run.attemptId, PATH_ID) &&
        matches(run.checkKey, IDENTIFIER) && matches(run.failureSignature, SIGNATURE) &&
        matches(run.startedAt, UTC) && Date.parse(run.startedAt) <= Date.parse(run.finishedAt) &&
        run.reportUrl === '/api/runs/' + run.runId + '/artifacts/report.html') {
        return checkKeys.has(run.checkKey) ? 'assertion_failed' : 'check_not_mapped';
    }
    return 'unverified';
}

function eventFor(run, source) {
    const sourceKey = digest([run.workspaceId, run.runId, run.attemptId, run.checkKey]);
    return {
        schema_version: 1,
        event_type: 'whippet.run_finished',
        source: 'whippet',
        event_id: 'whippet:' + sourceKey,
        operation_id: 'inspection:' + sourceKey,
        scope: { project_slug: source.project_slug, environment: source.environment },
        scope_revision: source.scope_revision,
        occurred_at: new Date(run.finishedAt).toISOString(),
        payload: {
            workspace_id: run.workspaceId,
            test_id: run.testId,
            version_id: run.versionId,
            run_id: run.runId,
            attempt_id: run.attemptId,
            started_at: new Date(run.startedAt).toISOString(),
            purpose: 'inspection',
            status: 'failed',
            failure_kind: 'assertion',
            check_key: run.checkKey,
            failure_signature: run.failureSignature,
            summary: 'Whippet 正式巡檢的產品檢查失敗。請從 Run 查閱原始證據。',
            evidence_refs: ['whippet:run:' + run.runId],
        },
    };
}

function receiptFor(receipt, event) {
    const expected = { event_id: event.event_id, operation_id: event.operation_id,
        workspace_id: event.payload.workspace_id, run_id: event.payload.run_id, attempt_id: event.payload.attempt_id };
    if (!receipt || !Object.entries(expected).every(([key, value]) => receipt[key] === value)) {
        throw new InspectionError('feedback_desk_invalid_receipt');
    }
    if (receipt.outcome === 'linked' && matches(receipt.report_public_id, REPORT_ID)) {
        return { ...expected, outcome: 'linked', report_public_id: receipt.report_public_id };
    }
    if (receipt.outcome === 'ignored' && receipt.report_public_id === null && receipt.ignored_reason === 'stale_run') {
        return { ...expected, outcome: 'ignored', report_public_id: null, ignored_reason: 'stale_run' };
    }
    throw new InspectionError('feedback_desk_invalid_receipt');
}

function verifyLink(actual, expected, reason) {
    if (!actual || !Object.entries(expected).every(([key, value]) => actual[key] === value)) throw new InspectionError(reason);
}

export async function runInspectionBridge({ config, stateDirectory, environment = process.env, fetchImpl = globalThis.fetch,
    signal = new AbortController().signal, log = () => {}, once = false, replay, pollMs = 3000, maxAttempts = 3,
    retryBaseMs = 1000 }) {
    const { whippetOrigin, feedbackOrigin, sources } = loadConfig(config);
    const store = await createInspectionStore(stateDirectory);
    const transport = { fetchImpl, signal, maxAttempts, retryBaseMs };

    function whippetFor(source) {
        const token = getToken(environment, source.whippet_token_env, /^[!-~]{1,1024}$/);
        return {
            token,
            request: createClient({ service: 'whippet', origin: whippetOrigin, token, ...transport }),
            path: '/api/inspections/workspaces/' + source.workspace_id + '/runs',
        };
    }

    async function processRun(source, whippet, runId, listed) {
        const path = whippet.path + '/' + runId;
        const observed = await whippet.request(path);
        if (observed?.workspaceId !== source.workspace_id || observed?.environment !== source.whippet_environment || observed.runId !== runId) {
            throw new InspectionError('whippet_invalid_run');
        }
        const outcome = classify(observed, listed, source.checksByTest.get(observed.testId));
        const run = store.run(source.stream, runId);
        const result = { source_id: source.source_id, workspace_id: source.workspace_id, run_id: runId, outcome };
        if (matches(observed.attemptId, PATH_ID)) result.attempt_id = observed.attemptId;

        if (outcome === 'assertion_failed') {
            const token = getToken(environment, source.feedback_desk_token_env, /^fdi_[A-Za-z0-9_-]{28,124}$/);
            if (token === whippet.token) throw new InspectionError('inspection_credential_unavailable');
            const request = createClient({ service: 'feedback_desk', origin: feedbackOrigin, token, ...transport });
            const base = '/api/automation/' + source.project_slug + '/' + source.environment;
            const event = eventFor(observed, source);
            await run.saveEvent(event);
            const receipt = receiptFor((await request(base + '/inspection-events', event))?.receipt, event);
            await run.saveReceipt(receipt);

            result.outcome = receipt.ignored_reason ?? receipt.outcome;
            result.event_id = receipt.event_id;
            if (receipt.outcome === 'linked') {
                const body = { attemptId: observed.attemptId, projectSlug: source.project_slug, reportPublicId: receipt.report_public_id };
                verifyLink(await whippet.request(path + '/links', body), { workspaceId: source.workspace_id, runId, ...body },
                    'whippet_invalid_link');
                const link = { workspace_id: source.workspace_id, run_id: runId,
                    attempt_id: observed.attemptId, report_public_id: receipt.report_public_id };
                verifyLink((await request(base + '/inspection-links', link))?.link, link, 'feedback_desk_invalid_link');
                result.project_slug = source.project_slug;
                result.environment = source.environment;
                result.report_public_id = receipt.report_public_id;
            }
        }

        await run.saveResult(result);
        log('inspection_result', result);
    }

    async function poll(source) {
        const whippet = whippetFor(source);
        const checkpoint = await store.readCursor(source.stream);
        if (checkpoint !== undefined && !matches(checkpoint?.after, CURSOR)) throw new InspectionError('inspection_state_invalid');
        const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (checkpoint) query.set('after', checkpoint.after);
        const page = await whippet.request(whippet.path + '?' + query);
        if (!Array.isArray(page?.items) || page.items.length > PAGE_LIMIT || page.items.some(run =>
            run?.workspaceId !== source.workspace_id || run?.environment !== source.whippet_environment ||
            !matches(run.runId, PATH_ID))) throw new InspectionError('whippet_invalid_page');
        if (!page.items.length) return;
        if (!matches(page.nextCursor, CURSOR) || page.nextCursor === checkpoint?.after) throw new InspectionError('whippet_invalid_cursor');
        for (const run of page.items) await processRun(source, whippet, run.runId, run);
        await store.saveCursor(source.stream, { after: page.nextCursor });
    }

    if (replay) {
        const source = sources.find(item => item.source_id === replay.sourceId);
        if (!source || !matches(replay.runId, PATH_ID)) throw new InspectionError('inspection_replay_invalid');
        await processRun(source, whippetFor(source), replay.runId);
        return;
    }

    const schedules = sources.map(source => ({ source, dueAt: 0, failures: 0 }));
    while (!signal.aborted) {
        let firstFailure;
        for (const schedule of schedules) {
            if (schedule.dueAt > Date.now()) continue;
            try {
                await poll(schedule.source);
                schedule.failures = 0;
                schedule.dueAt = Date.now() + pollMs;
            } catch (error) {
                if (signal.aborted) return;
                if (!(error instanceof InspectionError)) throw error;
                firstFailure ??= error;
                schedule.failures++;
                schedule.dueAt = Date.now() + retryDelay(schedule.failures, pollMs, error.retryAfterMs);
                log('inspection_poll_failed', { source_id: schedule.source.source_id, reason: error.message,
                    ...(error.status === undefined ? {} : { status: error.status }) });
            }
        }
        if (once) {
            if (firstFailure) throw firstFailure;
            return;
        }
        const waitMs = Math.min(pollMs, ...schedules.map(schedule => Math.max(0, schedule.dueAt - Date.now())));
        await delay(waitMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
}
