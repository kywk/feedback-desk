import { Hono, type HonoRequest } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AnalysisError, parseAnalysis } from '../../shared/automation-analysis.mjs';
import {
    applyAutomationDecision, automationInput, GIT_LOCAL_BRANCH, GIT_MR, GIT_PUSH, linkAutomationMr, recordLocalBranch, typedGitGuard, typedLocalBranchGuard,
} from '../lib/automation-decisions';
import {
    AUTOMATION_STAGES, AutomationError, automationScope, claimAutomationWork, listAutomationEvents,
    recordAutomationIntent, recordAutomationReceipt, renewAutomationWork, saveAutomationProgress, type AutomationScope,
} from '../lib/automation';
import { acceptInspectionEvent, acknowledgeInspectionLink, inspectionScope, pendingInspectionLinks } from '../lib/automation-inspections';
import { registerDeployment, w4Scope } from '../lib/automation-deployments';
import { bindRetestRun, getRetestIntent, listRetestIntents, recordRetestResult, RETEST_OUTCOMES } from '../lib/automation-retests';
import type { AppEnv } from './context';

export const automation = new Hono<AppEnv & { Variables: { automationScope: AutomationScope } }>();
const scopePath = '/:project_slug/:environment';

automation.onError((error, c) => {
    if (error instanceof AutomationError) {
        if (error.status === 401) c.header('WWW-Authenticate', 'Bearer');
        if (error.status === 503) c.header('Retry-After', '1');
        return c.json({ error: error.code, message: error.message }, error.status);
    }
    throw error;
});

automation.use(`${scopePath}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
});
automation.use(`${scopePath}/*`, bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ error: 'body_too_large', message: '請求內容超出限制。' }, 413),
}));

export const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
export const revision = z.number().int().positive();
const data = z.record(z.string(), z.unknown());
const claim = z.strictObject({ worker_id: identifier, scope_revision: identifier });
const lease = claim.extend({
    work_id: identifier,
    report_public_id: identifier,
    report_revision: revision,
    lease_generation: revision,
});
const progress = lease.extend({
    stage: z.enum(AUTOMATION_STAGES),
    progress: data.nullable().optional(),
    retry_at: z.iso.datetime().optional(),
}).refine((input) => input.retry_at === undefined || input.stage === 'queued');
const intent = lease.extend({
    operation_id: identifier,
    correlation_id: identifier,
    operation_type: identifier,
    payload: data,
});
const receipt = lease.extend({ operation_id: identifier, result: data });

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const branch = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
const branchIntent = z.strictObject({
    proposal_revision: revision,
    proposal_digest: digest,
    input_revision: revision,
    repo_id: identifier,
    base_commit: commit,
    source_branch: branch,
    target_branch: branch,
    head_sha: commit,
    check_results: z.array(z.strictObject({ check_id: identifier, status: z.literal('passed') })).min(1).max(10),
});
const gitIntent = branchIntent.extend({ gitlab_instance_id: identifier, project_id: revision });
const observation = gitIntent.extend({
    mr_id: revision,
    mr_iid: revision,
    web_url: z.string().max(2048),
    state: z.enum(['opened', 'merged']),
    observed_at: z.iso.datetime(),
});
const decision = lease.extend({ input_revision: revision, operation_id: identifier, correlation_id: identifier, analysis: z.unknown() });
const mr = lease.extend({
    input_revision: revision, operation_id: identifier, proposal_revision: revision, proposal_digest: digest,
    observation, proof: digest,
});

const localBranch = lease.extend({ operation_id: identifier, observation: branchIntent });

export async function readInput<T>(request: HonoRequest, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new AutomationError('invalid_request', 400, '請提供 JSON 請求內容。');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new AutomationError('invalid_request', 400, '請求欄位或格式不符。');
    }
    return parsed.data;
}

const inspectionLink = z.strictObject({
    workspace_id: identifier, run_id: identifier, attempt_id: identifier, report_public_id: z.uuid(),
});
const inspectionEvent = z.strictObject({
    schema_version: z.literal(1),
    event_type: z.literal('whippet.run_finished'),
    source: z.literal('whippet'),
    event_id: identifier,
    operation_id: identifier,
    scope: z.strictObject({ project_slug: identifier, environment: identifier }),
    scope_revision: identifier,
    occurred_at: z.iso.datetime(),
    payload: z.strictObject({
        workspace_id: identifier, test_id: identifier, version_id: identifier,
        run_id: identifier, attempt_id: identifier, started_at: z.iso.datetime(),
        purpose: z.literal('inspection'), status: z.literal('failed'), failure_kind: z.literal('assertion'),
        check_key: identifier, failure_signature: identifier,
        summary: z.string().trim().min(1).max(1000),
        evidence_refs: z.array(identifier.refine(ref => !ref.includes('://') && !/\bf(?:da|di)_[A-Za-z0-9_-]{28,124}\b/.test(ref))).min(1).max(10),
    }),
});

// These routes authenticate the narrower bridge identity before the queue credential middleware.
automation.post(`${scopePath}/inspection-events`, async (c) => {
    const scope = await inspectionScope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'));
    const input = await readInput(c.req, inspectionEvent);
    if (input.scope.project_slug !== scope.project_slug || input.scope.environment !== scope.environment) {
        throw new AutomationError('scope_forbidden', 403, '巡檢事件的專案或環境與授權不符。');
    }
    return c.json(await acceptInspectionEvent(c.env.DB, scope, input, c.get('now')));
});

automation.get(`${scopePath}/inspection-links`, async (c) => {
    const scope = await inspectionScope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'));
    const limit = c.req.query('limit') ?? '50';
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) {
        throw new AutomationError('invalid_request', 400, '請指定 1 至 50 筆關聯。');
    }
    return c.json(await pendingInspectionLinks(c.env.DB, scope, Number(limit)));
});

automation.post(`${scopePath}/inspection-links`, async (c) => {
    const scope = await inspectionScope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'));
    return c.json(await acknowledgeInspectionLink(c.env.DB, scope, await readInput(c.req, inspectionLink)));
});

const evidenceId = identifier.refine(ref => !ref.includes('://') && !/\bfd[adir]_[A-Za-z0-9_-]{28,124}\b/.test(ref));
const deploymentFields = {
    scope_revision: identifier, deployment_id: identifier, component_id: identifier,
    sequence: revision, occurred_at: z.iso.datetime(), evidence_ref: evidenceId,
};
const deploymentEvent = z.discriminatedUnion('state', [
    z.strictObject({ ...deploymentFields, state: z.literal('succeeded'), artifact_revision: identifier, commit_shas: z.array(commit).max(100) }),
    z.strictObject({ ...deploymentFields, state: z.literal('failed') }),
]);
const runBinding = z.strictObject({
    scope_revision: identifier, retest_request_id: z.uuid(), deployment_id: identifier, artifact_revision: identifier,
    workspace_id: identifier, test_id: identifier, version_id: identifier, run_id: identifier,
});
const retestResult = runBinding.extend({
    operation_id: identifier, attempt_id: identifier.nullable(), attempt_generation: revision.nullable(), started_at: z.iso.datetime().nullable(), finished_at: z.iso.datetime(),
    outcome: z.enum(RETEST_OUTCOMES),
    checks: z.array(z.strictObject({ check_key: identifier, status: z.enum(['passed', 'failed', 'skipped']) })).max(32)
        .refine(checks => new Set(checks.map(check => check.check_key)).size === checks.length),
    evidence_refs: z.array(evidenceId).max(10),
    failure_signature: evidenceId.optional(),
});

automation.post(`${scopePath}/deployments`, async (c) => {
    const scope = await w4Scope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'), 'deployment');
    return c.json(await registerDeployment(c.env.DB, scope, await readInput(c.req, deploymentEvent), c.get('now')));
});
automation.get(`${scopePath}/retest-intents`, async (c) => {
    const scope = await w4Scope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'), 'retest');
    const limit = c.req.query('limit') ?? '50';
    const after = c.req.query('after') ?? '0';
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) || !/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after))) {
        throw new AutomationError('invalid_request', 400, '重測清單的查詢範圍不符。');
    }
    return c.json(await listRetestIntents(c.env.DB, scope, Number(after), Number(limit)));
});
automation.get(`${scopePath}/retest-intents/:request_id`, async (c) => {
    const scope = await w4Scope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'), 'retest');
    const requestId = z.uuid().safeParse(c.req.param('request_id'));
    if (!requestId.success) throw new AutomationError('invalid_request', 400, '重測識別格式不符。');
    return c.json(await getRetestIntent(c.env.DB, scope, requestId.data));
});
automation.post(`${scopePath}/retest-runs`, async (c) => {
    const scope = await w4Scope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'), 'retest');
    return c.json(await bindRetestRun(c.env.DB, scope, await readInput(c.req, runBinding)));
});
automation.post(`${scopePath}/retest-results`, async (c) => {
    const scope = await w4Scope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment'), 'retest');
    return c.json(await recordRetestResult(c.env, scope, await readInput(c.req, retestResult), c.get('now')));
});

automation.use(`${scopePath}/*`, async (c, next) => {
    c.set('automationScope', await automationScope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment')));
    await next();
});
automation.get(`${scopePath}/events`, async (c) => {
    const after = c.req.query('after') ?? '0';
    const cursor = Number(after);
    if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(cursor)) {
        throw new AutomationError('invalid_cursor', 400, '事件游標格式不符。');
    }
    return c.json(await listAutomationEvents(c.env.DB, c.get('automationScope'), cursor));
});

automation.post(`${scopePath}/claim`, async (c) => {
    const input = await readInput(c.req, claim);
    return c.json(await claimAutomationWork(c.env.DB, c.get('automationScope'), input.worker_id, input.scope_revision));
});

automation.post(`${scopePath}/renew`, async (c) => {
    const input = await readInput(c.req, lease);
    return c.json(await renewAutomationWork(c.env.DB, c.get('automationScope'), input));
});

automation.post(`${scopePath}/progress`, async (c) => {
    const input = await readInput(c.req, progress);
    const retryAt = input.retry_at === undefined ? undefined : new Date(input.retry_at).toISOString();
    return c.json(await saveAutomationProgress(c.env.DB, c.get('automationScope'), input, input.stage, input.progress, retryAt));
});

automation.post(`${scopePath}/operations/intent`, async (c) => {
    const input = await readInput(c.req, intent);
    const scope = c.get('automationScope');
    const db = c.env.DB;
    if (input.operation_type === GIT_LOCAL_BRANCH) {
        const parsed = branchIntent.safeParse(input.payload);
        if (!parsed.success) throw new AutomationError('invalid_request', 400, '本機分支操作欄位或格式不符。');
        const guard = await typedLocalBranchGuard(db, scope, input, parsed.data);
        return c.json(await recordAutomationIntent(db, scope, input, { ...input, payload: parsed.data }, guard));
    }
    if (input.operation_type === GIT_PUSH || input.operation_type === GIT_MR) {
        const typed = gitIntent.safeParse(input.payload);
        if (!typed.success) throw new AutomationError('invalid_request', 400, '外部操作欄位或格式不符。');
        const { guard } = await typedGitGuard(db, scope, input, input.operation_type, typed.data);
        return c.json(await recordAutomationIntent(db, scope, input, { ...input, payload: typed.data }, guard));
    }
    return c.json(await recordAutomationIntent(db, scope, input, input));
});

automation.post(`${scopePath}/operations/receipt`, async (c) => {
    const input = await readInput(c.req, receipt);
    return c.json(await recordAutomationReceipt(c.env.DB, c.get('automationScope'), input, input.operation_id, input.result));
});

automation.post(`${scopePath}/input`, async (c) => {
    const input = await readInput(c.req, lease);
    return c.json(await automationInput(c.env.DB, c.get('automationScope'), input));
});

automation.post(`${scopePath}/decisions`, async (c) => {
    const input = await readInput(c.req, decision);
    try {
        const analysis = parseAnalysis(input.analysis);
        return c.json(await applyAutomationDecision(c.env, c.get('automationScope'), input, { ...input, analysis }));
    } catch (error) {
        if (error instanceof AnalysisError) {
            return c.json({ error: error.code, field: error.field, message: '分析資料欄位或格式不符。' }, 400);
        }
        throw error;
    }
});

automation.post(`${scopePath}/mr-links`, async (c) => {
    const input = await readInput(c.req, mr);
    return c.json(await linkAutomationMr(c.env, c.get('automationScope'), input, input));
});

automation.post(`${scopePath}/local-branches`, async (c) => {
    const input = await readInput(c.req, localBranch);
    return c.json(await recordLocalBranch(c.env.DB, c.get('automationScope'), input, input));
});
