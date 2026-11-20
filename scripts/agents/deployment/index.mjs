import { setTimeout as delay } from 'node:timers/promises';
import { IDENTIFIER, retryDelay } from '../consumer/queue.mjs';
import { createClient, InspectionError } from '../inspection/client.mjs';
import { createOutbox } from './outbox.mjs';
import { assert, getSecret, is, loadDeploymentConfig, prepareResult, UUID,
    validateIntent, validateLiveProof, validateManifest, verifyManifest } from './policy.mjs';

const PAGE_LIMIT = 50;
const CURSOR = /^\d{1,16}$/;
const WHIPPET_TOKEN = /^[!-~]{1,1024}$/;

function receiptFields(receipt, expected, error) {
    assert(receipt != null && Object.entries(expected).every(([key, value]) => receipt[key] === value), error);
}

function reportError(log, source, event, error, fields = {}) {
    if (!(error instanceof InspectionError)) throw error;
    log(event, { source_id: source.source_id, ...fields, reason: error.message,
        ...(error.status === undefined ? {} : { status: error.status }) });
}

export async function runDeploymentBridge({ config, stateDirectory, environment = process.env, fetchImpl = globalThis.fetch,
    signal = new AbortController().signal, log = () => {}, once = false, submission, replay, pollMs = 3000,
    maxAttempts = 3, retryBaseMs = 1000 }) {
    const { whippetOrigin, feedbackOrigin, sources } = loadDeploymentConfig(config);
    const sourceOutbox = await createOutbox(stateDirectory);
    const transport = { fetchImpl, signal, maxAttempts, retryBaseMs };

    function dmzFor(source, ref, pattern) {
        const token = getSecret(environment, source[ref], pattern);
        const origin = feedbackOrigin;
        const base = '/api/automation/' + source.project_slug + '/' + source.environment;
        const request = createClient({ service: 'feedback_desk', origin, token, ...transport });
        return (path, body) => request(base + path, body);
    }

    function retestServices(source) {
        const dmz = dmzFor(source, 'retest_token_env', /^fdr_[A-Za-z0-9_-]{28,124}$/);
        const readToken = getSecret(environment, source.whippet_read_token_env, WHIPPET_TOKEN);
        const scheduleToken = getSecret(environment, source.whippet_schedule_token_env, WHIPPET_TOKEN);
        assert(readToken !== scheduleToken && !/^fd[dr]_/.test(readToken) && !/^fd[dr]_/.test(scheduleToken), 'deployment_credential_unavailable');
        const path = '/api/retests/workspaces/' + source.workspace_id + '/runs';
        const read = createClient({ service: 'whippet', origin: whippetOrigin, token: readToken, ...transport });
        const create = createClient({ service: 'whippet', origin: whippetOrigin, token: scheduleToken, ...transport });
        return { dmz, read: runId => read(path + '/' + runId), schedule: body => create(path, body) };
    }

    async function deliverDeployment(source, outbox, manifest) {
        const valid = validateManifest(manifest, source);
        const dmz = dmzFor(source, 'deployment_token_env', /^fdd_[A-Za-z0-9_-]{28,124}$/);
        const { schema_version, source_id, project_slug, environment, ...event } = valid;
        const receipt = (await dmz('/deployments', { ...event, scope_revision: source.scope_revision }))?.receipt;
        receiptFields(receipt, { deployment_id: valid.deployment_id }, 'feedback_desk_invalid_deployment_receipt');
        assert(['registered', 'ignored_stale', 'failed'].includes(receipt.outcome) &&
            Array.isArray(receipt.intent_ids) && receipt.intent_ids.every(id => is(id, UUID)) &&
            (valid.state === 'failed' ? receipt.outcome !== 'registered' : receipt.outcome !== 'failed') &&
            (receipt.outcome === 'registered' || receipt.intent_ids.length === 0), 'feedback_desk_invalid_deployment_receipt');
        const saved = { deployment_id: receipt.deployment_id, outcome: receipt.outcome, intent_ids: receipt.intent_ids };
        await outbox.entry('deployment', [valid.deployment_id]).ack(saved);
        log('deployment_receipt', { source_id, ...saved });
    }

    async function readIntent(source, services, requestId) {
        assert(is(requestId, UUID), 'deployment_replay_invalid');
        const response = await services.dmz('/retest-intents/' + requestId);
        const intent = response?.intent;
        validateIntent(intent, source);
        assert(intent.retest_request_id === requestId && ['pending', 'running', 'finished', 'superseded'].includes(intent.status),
            'feedback_desk_invalid_retest_intent');
        return intent;
    }

    async function deliverResult(source, outbox, services, result) {
        const reply = await services.dmz('/retest-results', { ...result, scope_revision: source.scope_revision });
        const receipt = reply?.receipt;
        receiptFields(receipt, { operation_id: result.operation_id, retest_request_id: result.retest_request_id,
            run_id: result.run_id, attempt_id: result.attempt_id }, 'feedback_desk_invalid_retest_receipt');
        assert(['applied', 'ignored_stale', 'needs_review'].includes(receipt.outcome) && Array.isArray(receipt.reports) &&
            receipt.reports.every(report => is(report?.report_public_id, UUID) && is(report.outcome, IDENTIFIER)),
        'feedback_desk_invalid_retest_receipt');
        const saved = { operation_id: receipt.operation_id, retest_request_id: receipt.retest_request_id,
            run_id: receipt.run_id, attempt_id: receipt.attempt_id, outcome: receipt.outcome,
            reports: receipt.reports.map(({ report_public_id, outcome }) => ({ report_public_id, outcome })) };
        await outbox.entry('result', [result.operation_id]).ack(saved);
        log('retest_receipt', { source_id: source.source_id, ...saved });
    }

    async function verifyProof(source, component, intent) {
        const { proof } = component;
        const request = createClient({ service: 'deployment_proof', origin: proof.origin, ...transport });
        validateLiveProof(await request(proof.pathname), intent, source);
    }

    async function verifyResultBinding(source, services, result, current) {
        const intent = current ?? await readIntent(source, services, result.retest_request_id);
        receiptFields(intent, { run_id: result.run_id, deployment_id: result.deployment_id, artifact_revision: result.artifact_revision,
            workspace_id: result.workspace_id, test_id: result.test_id, version_id: result.version_id }, 'deployment_state_conflict');
        if (intent.status === 'running' && ['passed', 'assertion_failed'].includes(result.outcome)) {
            await verifyProof(source, source.components.get(intent.component_id), intent);
        }
    }

    async function recoverResult(source, outbox, services, result) {
        const intent = await readIntent(source, services, result?.retest_request_id);
        await verifyResultBinding(source, services, result, intent);
        if (intent.status === 'running') {
            const observed = prepareResult(await services.read(result.run_id), intent, source, result.run_id);
            assert(JSON.stringify(observed) === JSON.stringify(result), 'deployment_state_conflict');
        }
        await deliverResult(source, outbox, services, result);
    }

    async function processIntent(source, outbox, services, intent) {
        const component = validateIntent(intent, source);
        let runId = intent.run_id;
        if (!runId) {
            if (intent.status === 'superseded') return;
            await verifyProof(source, component, intent);
            const scheduled = await services.schedule({
                testId: intent.test_id, versionId: intent.version_id, environment: source.environment,
                deploymentId: intent.deployment_id, artifactRevision: intent.artifact_revision, checkKeys: [...intent.check_keys].sort(),
            });
            runId = scheduled?.runId;
            assert(is(runId, UUID), 'whippet_invalid_retest_run');
            try {
                const receipt = (await services.dmz('/retest-runs', {
                    scope_revision: source.scope_revision, retest_request_id: intent.retest_request_id,
                    deployment_id: intent.deployment_id, artifact_revision: intent.artifact_revision,
                    workspace_id: intent.workspace_id, test_id: intent.test_id, version_id: intent.version_id, run_id: runId,
                }))?.receipt;
                receiptFields(receipt, { retest_request_id: intent.retest_request_id, run_id: runId }, 'feedback_desk_invalid_retest_run');
            } catch (error) {
                if (!(error instanceof InspectionError) || error.status !== 409) throw error;
                if ((await readIntent(source, services, intent.retest_request_id)).status === 'superseded') return;
                throw error;
            }
            log('retest_scheduled', { source_id: source.source_id, retest_request_id: intent.retest_request_id,
                deployment_id: intent.deployment_id, run_id: runId });
        }

        let run;
        try {
            run = await services.read(runId);
        } catch (error) {
            if (error instanceof InspectionError && error.status === 409) return;
            throw error;
        }
        const result = prepareResult(run, intent, source, runId);
        await verifyResultBinding(source, services, result);
        await outbox.entry('result', [result.operation_id]).put(result);
        await deliverResult(source, outbox, services, result);
    }

    async function pollSource(source) {
        const outbox = await sourceOutbox(source.key);
        let firstError;
        async function perform(event, fields, action) {
            try {
                await action();
            } catch (error) {
                if (signal.aborted) throw error;
                reportError(log, source, event, error, fields);
                firstError ??= error;
            }
        }

        for await (const manifest of outbox.pending('deployment')) {
            await perform('deployment_delivery_failed', { deployment_id: manifest.deployment_id }, () => deliverDeployment(source, outbox, manifest));
        }
        const services = retestServices(source);
        for await (const result of outbox.pending('result')) {
            await perform('retest_delivery_failed', { retest_request_id: result.retest_request_id }, () => recoverResult(source, outbox, services, result));
        }

        let cursor = '0';
        const seen = new Set([cursor]);
        do {
            const page = await services.dmz('/retest-intents?limit=' + PAGE_LIMIT + '&after=' + cursor);
            assert(Array.isArray(page?.intents) && page.intents.length <= PAGE_LIMIT &&
                (page.next_cursor === null || (is(page.next_cursor, CURSOR) && !seen.has(page.next_cursor))),
            'feedback_desk_invalid_retest_page');
            for (const intent of page.intents) {
                const fields = is(intent?.retest_request_id, UUID) ? { retest_request_id: intent.retest_request_id } : {};
                await perform('retest_processing_failed', fields, () => processIntent(source, outbox, services, intent));
            }
            cursor = page.next_cursor;
            seen.add(cursor);
        } while (cursor !== null);
        if (firstError) throw firstError;
    }

    if (submission) {
        const source = sources.get(submission.sourceId);
        assert(source, 'deployment_source_unknown');
        const manifest = verifyManifest(submission.raw, submission.signature, source, environment);
        const outbox = await sourceOutbox(source.key);
        const entry = outbox.entry('deployment', [manifest.deployment_id]);
        const previous = await entry.read();
        if (previous !== undefined) {
            assert(JSON.stringify(previous) === JSON.stringify(manifest), 'deployment_state_conflict');
        } else if (manifest.state === 'succeeded') {
            // Only attestations whose revision was observed live enter the durable deployment outbox.
            await verifyProof(source, source.components.get(manifest.component_id), manifest);
        }
        await entry.put(manifest);
        await deliverDeployment(source, outbox, manifest);
        return;
    }
    if (replay) {
        const source = sources.get(replay.sourceId);
        assert(source, 'deployment_source_unknown');
        const services = retestServices(source);
        const intent = await readIntent(source, services, replay.retestRequestId);
        await processIntent(source, await sourceOutbox(source.key), services, intent);
        return;
    }

    const schedules = [...sources.values()].map(source => ({ source, dueAt: 0, failures: 0 }));
    while (!signal.aborted) {
        let failure;
        for (const schedule of schedules) {
            if (schedule.dueAt > Date.now()) continue;
            try {
                await pollSource(schedule.source);
                schedule.failures = 0;
                schedule.dueAt = Date.now() + pollMs;
            } catch (error) {
                if (signal.aborted) return;
                reportError(log, schedule.source, 'deployment_poll_failed', error);
                failure ??= error;
                schedule.failures++;
                schedule.dueAt = Date.now() + retryDelay(schedule.failures, pollMs, error.retryAfterMs);
            }
        }
        if (once) {
            if (failure) throw failure;
            return;
        }
        const waitMs = Math.min(pollMs, ...schedules.map(schedule => Math.max(0, schedule.dueAt - Date.now())));
        await delay(waitMs, undefined, { signal }).catch(error => { if (!signal.aborted) throw error; });
    }
}
