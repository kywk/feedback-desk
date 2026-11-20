import { createHmac, timingSafeEqual } from 'node:crypto';
import { IDENTIFIER } from '../consumer/queue.mjs';
import { InspectionError } from '../inspection/client.mjs';
import { digest } from '../inspection/state.mjs';

export const ROUTE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ENV_REF = /^[A-Z][A-Z0-9_]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAC = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const MANIFEST_FIELDS = ['schema_version', 'source_id', 'project_slug', 'environment', 'deployment_id', 'component_id',
    'sequence', 'occurred_at', 'state', 'evidence_ref'];
const secretRefs = ['manifest_hmac_key_env', 'deployment_token_env', 'retest_token_env', 'whippet_schedule_token_env', 'whippet_read_token_env'];
const OUTCOME_STATUS = {
    passed: ['succeeded'], assertion_failed: ['failed'], infrastructure: ['failed', 'interrupted'],
    cancelled: ['cancelled'], timed_out: ['timed_out'], unverified: ['failed', 'succeeded'],
};

export function is(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

export function assert(condition, reason) {
    if (!condition) throw new InspectionError(reason);
}

function sameFields(actual, expected) {
    return actual != null && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function address(value, allowPath = false) {
    if (typeof value !== 'string') throw new Error();
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (!allowPath && url.pathname !== '/') ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new Error();
    return url;
}

function time(value) {
    return is(value, UTC) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

function checkList(value) {
    return Array.isArray(value) && value.length >= 1 && value.length <= 32 && value.every(key => is(key, IDENTIFIER)) &&
        new Set(value).size === value.length;
}

export function loadDeploymentConfig(config) {
    const invalid = 'deployment_config_invalid';
    try {
        const whippetOrigin = address(config.whippet_origin).origin;
        const feedbackOrigin = address(config.feedback_desk_origin).origin;
        assert(whippetOrigin !== feedbackOrigin && Array.isArray(config.sources) && config.sources.length > 0, invalid);
        const sources = new Map();
        const scopes = new Set();
        const manifestRefs = new Set();
        for (const input of config.sources) {
            const { source_id, project_slug, environment, scope_revision, workspace_id, components } = input;
            const scope = JSON.stringify([project_slug, environment]);
            const refs = secretRefs.map(key => input[key]);
            assert([source_id, project_slug, environment].every(value => is(value, ROUTE_ID)) && is(workspace_id, UUID) &&
                is(scope_revision, IDENTIFIER) && !sources.has(source_id) && !scopes.has(scope) &&
                refs.every(ref => is(ref, ENV_REF)) && new Set(refs).size === refs.length &&
                !manifestRefs.has(input.manifest_hmac_key_env) && Array.isArray(components) && components.length > 0, invalid);
            scopes.add(scope);
            manifestRefs.add(input.manifest_hmac_key_env);
            const componentMap = new Map();
            for (const { component_id, proof_url, tests } of components) {
                const proof = address(proof_url, true);
                assert(is(component_id, IDENTIFIER) && !componentMap.has(component_id) &&
                    ![feedbackOrigin, whippetOrigin].includes(proof.origin) && !proof.pathname.startsWith('//') &&
                    Array.isArray(tests) && tests.length > 0, invalid);
                const testMap = new Map();
                for (const { test_id, version_id, check_keys } of tests) {
                    const key = JSON.stringify([test_id, version_id]);
                    assert(is(test_id, UUID) && is(version_id, UUID) && !testMap.has(key) && checkList(check_keys), invalid);
                    testMap.set(key, new Set(check_keys));
                }
                componentMap.set(component_id, { proof, testMap });
            }
            sources.set(source_id, { source_id, project_slug, environment, scope_revision, workspace_id,
                ...Object.fromEntries(secretRefs.map(key => [key, input[key]])), components: componentMap,
                key: digest([whippetOrigin, feedbackOrigin, source_id, project_slug, environment, workspace_id]) });
        }
        return { whippetOrigin, feedbackOrigin, sources };
    } catch {
        throw new InspectionError(invalid);
    }
}

export function getSecret(environment, ref, pattern) {
    const value = environment[ref];
    assert(is(value, pattern), 'deployment_credential_unavailable');
    return value;
}

export function validateManifest(manifest, source) {
    const { source_id, project_slug, environment } = source;
    const invalid = 'deployment_manifest_invalid';
    assert(sameFields(manifest, { schema_version: 1, source_id, project_slug, environment }) &&
        is(manifest.deployment_id, IDENTIFIER) && source.components.has(manifest.component_id) &&
        Number.isSafeInteger(manifest.sequence) && manifest.sequence > 0 && time(manifest.occurred_at) &&
        is(manifest.evidence_ref, IDENTIFIER) && !manifest.evidence_ref.includes('://') &&
        !/\bfd[adir]_[A-Za-z0-9_-]{28,124}\b/.test(manifest.evidence_ref) &&
        ['succeeded', 'failed'].includes(manifest.state), invalid);
    const fields = [...MANIFEST_FIELDS];
    if (manifest.state === 'succeeded') {
        assert(is(manifest.artifact_revision, IDENTIFIER) && Array.isArray(manifest.commit_shas) &&
            manifest.commit_shas.length <= 100 && manifest.commit_shas.every(sha => is(sha, SHA)) &&
            new Set(manifest.commit_shas).size === manifest.commit_shas.length, invalid);
        fields.push('artifact_revision', 'commit_shas');
    }
    assert(Object.keys(manifest).length === fields.length, invalid);
    const normalized = Object.fromEntries(fields.map(field => [field, manifest[field]]));
    normalized.occurred_at = time(normalized.occurred_at);
    if (normalized.commit_shas) normalized.commit_shas = [...normalized.commit_shas].sort();
    return normalized;
}

export function verifyManifest(raw, signature, source, environment) {
    assert(Buffer.isBuffer(raw) && raw.length >= 1 && raw.length <= 32 * 1024 && is(signature, MAC), 'deployment_signature_invalid');
    const key = getSecret(environment, source.manifest_hmac_key_env, MAC);
    const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(raw).digest();
    assert(timingSafeEqual(expected, Buffer.from(signature, 'hex')), 'deployment_signature_invalid');
    let manifest;
    try {
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
        throw new InspectionError('deployment_manifest_invalid');
    }
    return validateManifest(manifest, source);
}

export function validateIntent(intent, source) {
    const invalid = 'feedback_desk_invalid_retest_intent';
    const component = source.components.get(intent?.component_id);
    const test = component?.testMap.get(JSON.stringify([intent?.test_id, intent?.version_id]));
    assert(intent?.workspace_id === source.workspace_id && is(intent.retest_request_id, UUID) &&
        is(intent.deployment_id, IDENTIFIER) && is(intent.artifact_revision, IDENTIFIER) &&
        checkList(intent.check_keys) && intent.check_keys.every(check => test?.has(check)) &&
        (intent.run_id === null || is(intent.run_id, UUID)), invalid);
    return component;
}

export function validateLiveProof(proof, intent, source) {
    assert(sameFields(proof, { deploymentId: intent.deployment_id, artifactRevision: intent.artifact_revision,
        environment: source.environment, projectSlug: source.project_slug }), 'deployment_live_revision_mismatch');
}

export function prepareResult(run, intent, source, runId) {
    const invalid = 'whippet_invalid_retest_result';
    assert(sameFields(run, {
        workspaceId: intent.workspace_id, testId: intent.test_id, versionId: intent.version_id, runId,
        purpose: 'deployment_retest', environment: source.environment, deploymentId: intent.deployment_id,
        artifactRevision: intent.artifact_revision,
    }) && Object.hasOwn(OUTCOME_STATUS, run.outcome) && OUTCOME_STATUS[run.outcome].includes(run.status) &&
        time(run.finishedAt) && Array.isArray(run.checks) && run.checks.length === intent.check_keys.length, invalid);
    const statuses = new Map();
    for (const check of run.checks) {
        assert(intent.check_keys.includes(check?.checkKey) && !statuses.has(check.checkKey) &&
            ['passed', 'failed', 'skipped'].includes(check.status), invalid);
        statuses.set(check.checkKey, check.status);
    }
    const attemptId = run.attemptId ?? null;
    const attemptGeneration = run.attemptGeneration ?? null;
    const startedAt = run.startedAt == null ? null : time(run.startedAt);
    const finishedAt = time(run.finishedAt);
    assert((attemptId === null || is(attemptId, UUID)) && ((attemptId === null && attemptGeneration === null) ||
        (attemptId !== null && Number.isSafeInteger(attemptGeneration) && attemptGeneration > 0)) &&
        (startedAt === null || (attemptId && startedAt && startedAt <= finishedAt)), invalid);
    const reportPath = '/api/runs/' + runId + '/artifacts/report.html';
    if (run.outcome === 'passed' || run.outcome === 'assertion_failed') {
        const validChecks = run.outcome === 'passed' ? [...statuses.values()].every(status => status === 'passed')
            : [...statuses.values()].some(status => status === 'failed');
        assert(attemptId && startedAt && run.reportUrl === reportPath && validChecks, invalid);
    }
    assert(run.failureSignature === undefined || (run.outcome === 'assertion_failed' && is(run.failureSignature, MAC)), invalid);
    return {
        operation_id: 'retest:' + digest([intent.retest_request_id, runId, attemptId, attemptGeneration]),
        retest_request_id: intent.retest_request_id,
        deployment_id: intent.deployment_id,
        artifact_revision: intent.artifact_revision,
        workspace_id: intent.workspace_id,
        test_id: intent.test_id,
        version_id: intent.version_id,
        run_id: runId,
        attempt_id: attemptId,
        attempt_generation: attemptGeneration,
        started_at: startedAt,
        finished_at: finishedAt,
        outcome: run.outcome,
        checks: [...statuses].sort(([a], [b]) => a < b ? -1 : Number(a > b)).map(([check_key, status]) => ({ check_key, status })),
        evidence_refs: run.reportUrl === reportPath ? ['whippet:run:' + runId] : [],
        ...(run.failureSignature === undefined ? {} : { failure_signature: run.failureSignature }),
    };
}

export { UUID };
