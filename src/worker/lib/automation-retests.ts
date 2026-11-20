import { nowIso } from '../../shared/time';
import { config, type Env } from '../env';
import { AutomationError, SQL_NOW, assertion, assertScopeRevision, canonicalJson } from './automation';
import { W4_AUTH, isW4Contention, w4Bindings, w4Busy, type W4Scope } from './automation-deployments';
import { requestCompletionStatements } from './completion';
import { sha256Hex } from './crypto';
import type { Report } from './models';
import { changeStatusStatements } from './reports';

export interface RetestBinding {
    scope_revision: string;
    retest_request_id: string;
    deployment_id: string;
    artifact_revision: string;
    workspace_id: string;
    test_id: string;
    version_id: string;
    run_id: string;
}

export const RETEST_OUTCOMES = ['passed', 'assertion_failed', 'infrastructure', 'cancelled', 'timed_out', 'unverified'] as const;
export interface RetestObservation extends RetestBinding {
    operation_id: string;
    attempt_id: string | null;
    attempt_generation: number | null;
    started_at: string | null;
    finished_at: string;
    outcome: (typeof RETEST_OUTCOMES)[number];
    checks: { check_key: string; status: 'passed' | 'failed' | 'skipped' }[];
    evidence_refs: string[];
    failure_signature?: string;
}

type Status = 'pending' | 'running' | 'finished' | 'superseded';
type ReportOutcome = 'waiting_customer' | 'verified' | 'completed' | 'failed' | 'needs_review' | 'ignored_stale';
interface ReportResult {
    report_public_id: string;
    outcome: ReportOutcome;
    reason?: string;
}

interface ResultReceipt {
    operation_id: string;
    retest_request_id: string;
    run_id: string;
    attempt_id: string | null;
    outcome: 'applied' | 'ignored_stale' | 'needs_review';
    reports: ReportResult[];
}

interface IntentRow extends Omit<RetestBinding, 'run_id'> {
    cursor: number;
    component_id: string;
    project_id: number;
    environment: string;
    source_instance: string;
    run_id: string | null;
    status: Status;
    latest_generation: number;
    occurred_at: string;
    check_keys_json: string;
    target_current: number;
}

interface AffectedReport extends Report {
    linked_public_id: string;
    expected_revision: number;
    work_id: string;
    check_key: string;
    auto_reply: number;
    auto_close: number;
    pure_inspection: number;
    applicable: number;
    failed_after_start: number;
}

// The provisioned target must still describe the pinned deployment and check.
const TARGET_CURRENT = `t.project_id=q.project_id AND t.environment=q.environment AND t.scope_revision=s.scope_revision
    AND t.component_id=d.component_id AND t.source_instance=q.source_instance AND t.workspace_id=q.workspace_id
    AND t.test_id=q.test_id AND t.version_id=q.version_id AND t.check_key=a.check_key`;

const INTENT_TARGET_CURRENT = `EXISTS (SELECT 1 FROM automation_retest_reports a
    JOIN automation_retest_targets t ON t.id=a.target_id
    WHERE a.retest_request_id=q.retest_request_id AND ${TARGET_CURRENT})`;

const INTENT_ROWS = `SELECT q.*, d.scope_revision, d.component_id, d.artifact_revision, d.occurred_at,
    ${INTENT_TARGET_CURRENT} AS target_current,
    (SELECT json_group_array(check_key) FROM (
        SELECT DISTINCT a.check_key FROM automation_retest_reports a WHERE a.retest_request_id=q.retest_request_id ORDER BY a.check_key
    )) AS check_keys_json
    FROM automation_retest_intents q JOIN automation_deployments d USING (project_id, environment, deployment_id)
    JOIN automation_scopes s USING (project_id, environment)
    WHERE q.project_id=?1 AND q.environment=?2 AND q.source_instance=?3`;

const REPORTS = `SELECT r.*, a.report_public_id AS linked_public_id, a.report_revision AS expected_revision, a.work_id, a.check_key,
    COALESCE(p.auto_reply,0) AS auto_reply, COALESCE(p.auto_close_inspections,0) AS auto_close,
    (r.creator_type='owner_shared' AND r.shared_with_client=0 AND g.report_public_id IS NOT NULL AND g.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.report_id=r.id AND m.author_type='reporter')) AS pure_inspection,
    (r.id IS NOT NULL AND r.report_revision=a.report_revision AND r.status<>'completed' AND r.client_deleted_at IS NULL
        AND r.claimed_by_developer_id IS NULL AND r.automation_manual_takeover=0 AND ${TARGET_CURRENT}
        AND w.scope_revision=s.scope_revision AND (w.revoked_reason IS NULL OR w.revoked_reason='report_shared')
        AND NOT EXISTS (SELECT 1 FROM automation_work newer WHERE newer.report_public_id=a.report_public_id AND newer.event_cursor>w.event_cursor)
        AND (CASE w.ingress_kind WHEN 'inspection' THEN s.inspection_ingress ELSE s.customer_ingress END)=1
        AND (CASE t.target_kind WHEN 'mr' THEN EXISTS (
            SELECT 1 FROM automation_mr_links m JOIN automation_repositories repo
              ON repo.project_id=q.project_id AND repo.environment=q.environment AND repo.scope_revision=s.scope_revision
              AND repo.repo_id=t.repo_id AND repo.gitlab_project_id=m.gitlab_project_id AND repo.delivery_mode='gitlab'
            WHERE m.work_id=w.work_id AND m.decision_revision=w.proposal_revision AND m.gitlab_instance_id=p.gitlab_instance_id
              AND json_extract(m.observation_json, '$.head_sha')=a.mr_head_sha
              AND json_extract(m.observation_json, '$.repo_id')=t.repo_id
        ) WHEN 'inspection' THEN g.report_public_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM automation_mr_links m WHERE m.work_id=w.work_id)
          AND EXISTS (SELECT 1 FROM automation_inspection_targets x
              WHERE x.project_id=q.project_id AND x.environment=q.environment AND x.scope_revision=s.scope_revision
                AND x.source_instance=g.source_instance AND x.workspace_id=g.workspace_id AND x.test_id=g.test_id AND x.check_key=g.check_key)
          ELSE 0 END)
    ) AS applicable,
    EXISTS (SELECT 1 FROM automation_inspection_runs n WHERE n.report_public_id=a.report_public_id AND n.occurred_at>?2) AS failed_after_start
    FROM automation_retest_reports a
    JOIN automation_retest_intents q ON q.retest_request_id=a.retest_request_id
    JOIN automation_deployments d USING (project_id, environment, deployment_id)
    JOIN automation_scopes s ON s.project_id=q.project_id AND s.environment=q.environment
    LEFT JOIN automation_policies p ON p.project_id=q.project_id AND p.environment=q.environment AND p.scope_revision=s.scope_revision
    LEFT JOIN automation_retest_targets t ON t.id=a.target_id
    LEFT JOIN reports r ON r.public_id=a.report_public_id AND r.project_id=q.project_id
    LEFT JOIN automation_work w ON w.work_id=a.work_id
    LEFT JOIN automation_inspection_groups g ON g.report_public_id=a.report_public_id
    WHERE a.retest_request_id=?1`;

function conflict(code = 'retest_conflict') {
    return new AutomationError(code, 409, '重測意圖、部署、版本或已保存的 Run 結果不符。');
}

function scopeKey(scope: W4Scope): [number, string, string] {
    return [scope.project_id, scope.environment, scope.source_instance];
}

function intentView(row: IntentRow) {
    const { retest_request_id, deployment_id, component_id, artifact_revision, workspace_id, test_id, version_id, run_id, status } = row;
    return { retest_request_id, deployment_id, component_id, artifact_revision, workspace_id, test_id, version_id, run_id, status,
        check_keys: JSON.parse(row.check_keys_json) as string[] };
}

async function lookupIntent(db: D1Database, scope: W4Scope, requestId: string) {
    const row = await db.prepare(INTENT_ROWS + ' AND q.retest_request_id=?4').bind(...scopeKey(scope), requestId).first<IntentRow>();
    if (!row) throw conflict('retest_not_found');
    return row;
}

export async function listRetestIntents(db: D1Database, scope: W4Scope, after: number, limit: number) {
    const { results } = await db.prepare(INTENT_ROWS + ` AND d.scope_revision=?4 AND q.cursor>?5
        AND q.status IN ('pending','running') AND ${INTENT_TARGET_CURRENT} ORDER BY q.cursor LIMIT ?6`).bind(...scopeKey(scope), scope.scope_revision, after, limit + 1).all<IntentRow>();
    const page = results.slice(0, limit);
    return { intents: page.map(intentView), next_cursor: results.length > limit ? String(page.at(-1)!.cursor) : null };
}

export async function getRetestIntent(db: D1Database, scope: W4Scope, requestId: string) {
    const row = await lookupIntent(db, scope, requestId);
    const status = row.scope_revision !== scope.scope_revision || row.target_current !== 1 ? 'superseded' : row.status;
    return { intent: intentView({ ...row, status }) };
}

function assertBinding(row: IntentRow, data: RetestBinding) {
    if (row.deployment_id !== data.deployment_id || row.artifact_revision !== data.artifact_revision ||
        row.workspace_id !== data.workspace_id || row.test_id !== data.test_id || row.version_id !== data.version_id ||
        (row.run_id !== null && row.run_id !== data.run_id)) throw conflict();
}

export async function bindRetestRun(db: D1Database, scope: W4Scope, data: RetestBinding) {
    assertScopeRevision(scope, data.scope_revision);
    const receipt = { retest_request_id: data.retest_request_id, run_id: data.run_id };
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const row = await lookupIntent(db, scope, data.retest_request_id);
        assertBinding(row, data);
        if (row.run_id !== null) return { receipt };
        if (row.status === 'superseded' || row.scope_revision !== scope.scope_revision || row.target_current !== 1) throw conflict('retest_superseded');
        try {
            const bound = await db.prepare(`UPDATE automation_retest_intents AS q SET run_id=?8, status='running'
                WHERE project_id=?1 AND environment=?2 AND source_instance=?3 AND retest_request_id=?7
                    AND ${W4_AUTH} AND status='pending' AND run_id IS NULL
                    AND EXISTS (SELECT 1 FROM automation_deployments d JOIN automation_scopes s USING (project_id, environment)
                        WHERE d.project_id=q.project_id AND d.environment=q.environment AND d.deployment_id=q.deployment_id
                          AND d.scope_revision=s.scope_revision AND ${INTENT_TARGET_CURRENT}) RETURNING run_id`)
                .bind(...w4Bindings(scope), data.retest_request_id, data.run_id).first<string>('run_id');
            if (bound) return { receipt };
        } catch (error) {
            if (isW4Contention(error)) throw conflict();
            throw error;
        }
    }
    throw w4Busy();
}

async function savedReceipt(db: D1Database, scope: W4Scope, operationId: string, requestHash: string) {
    const saved = await db.prepare(`SELECT request_hash, receipt_json FROM automation_retest_receipts
        WHERE project_id=? AND environment=? AND operation_id=?`)
        .bind(scope.project_id, scope.environment, operationId).first<{ request_hash: string; receipt_json: string }>();
    if (!saved) return null;
    if (saved.request_hash !== requestHash) throw conflict();
    return JSON.parse(saved.receipt_json) as ResultReceipt;
}

async function earlierObservation(db: D1Database, data: RetestObservation, generation: number, observationHash: string) {
    const { results } = await db.prepare(`SELECT r.observation_hash, r.attempt_id, r.attempt_generation,
        (SELECT receipt_json FROM automation_retest_receipts a WHERE a.retest_request_id=r.retest_request_id
            AND a.attempt_generation=r.attempt_generation LIMIT 1) AS receipt_json
        FROM automation_retest_results r WHERE retest_request_id=?1 AND (attempt_generation=?2 OR attempt_id=?3)`)
        .bind(data.retest_request_id, generation, data.attempt_id)
        .all<{ observation_hash: string; attempt_id: string | null; attempt_generation: number; receipt_json: string }>();
    if (!results.length) return null;
    const [row] = results;
    if (results.length !== 1 || row.attempt_id !== data.attempt_id || row.attempt_generation !== generation ||
        row.observation_hash !== observationHash) throw conflict();
    return JSON.parse(row.receipt_json) as ResultReceipt;
}

function reportResult(report: AffectedReport, data: RetestObservation, stale: boolean): ReportResult {
    const report_public_id = report.linked_public_id;
    if (stale || report.applicable !== 1 || report.failed_after_start === 1) {
        return { report_public_id, outcome: 'ignored_stale', reason: stale ? 'superseded_attempt_or_deployment' :
            report.failed_after_start === 1 ? 'newer_inspection_failure' : 'report_or_scope_changed' };
    }
    const check = data.checks.find(item => item.check_key === report.check_key);
    if (!['passed', 'assertion_failed'].includes(data.outcome)) return { report_public_id, outcome: 'needs_review', reason: data.outcome };
    if (!data.evidence_refs.length || !check || check.status === 'skipped') {
        return { report_public_id, outcome: 'needs_review', reason: 'missing_verified_coverage' };
    }
    if (data.outcome === 'assertion_failed' && check.status === 'failed') return { report_public_id, outcome: 'failed', reason: 'assertion_failed' };
    // A failed test leaves any individual passes for team review.
    if (data.outcome !== 'passed' || check.status !== 'passed' || data.checks.some(item => item.status === 'failed')) return { report_public_id, outcome: 'needs_review', reason: 'inconsistent_result' };
    if (report.creator_type === 'client' && report.auto_reply === 1) return { report_public_id, outcome: 'waiting_customer' };
    if (report.pure_inspection === 1 && report.auto_close === 1) return { report_public_id, outcome: 'completed' };
    return { report_public_id, outcome: 'verified' };
}

function resultReportEffects(env: Env, data: RetestObservation, generation: number, report: AffectedReport, result: ReportResult, at: string) {
    const db = env.DB;
    const update = db.prepare(`INSERT INTO automation_retest_report_results
        (retest_request_id, attempt_generation, report_public_id, outcome, reason) VALUES (?,?,?,?,?)`)
        .bind(data.retest_request_id, generation, result.report_public_id, result.outcome, result.reason ?? null);
    if (result.outcome === 'ignored_stale') return [update];
    const actor = { name: 'Feedback Desk', developerId: null, clientAccountId: null, agent: 'Feedback Desk' };
    const guard = assertion(db, `EXISTS (SELECT 1 FROM (${REPORTS}) WHERE linked_public_id=?3 AND applicable=1
        AND failed_after_start=0 AND auto_reply=?4 AND auto_close=?5 AND pure_inspection IS ?6)`,
        [data.retest_request_id, data.started_at, result.report_public_id, report.auto_reply, report.auto_close, report.pure_inspection]);
    const effects = [guard, update];
    if (result.outcome === 'waiting_customer') {
        effects.push(...requestCompletionStatements(env, report, { authorName: config(env).sharedOwnerName, author: actor }, at).statements);
    }
    if (result.outcome === 'completed') {
        // End the work first so the normal close trigger will preserve the system disposition.
        effects.push(db.prepare("UPDATE automation_work SET stage='completed' WHERE work_id=?").bind(report.work_id));
        effects.push(...changeStatusStatements(db, report, 'completed', at, actor));
    }
    const stage = result.outcome === 'completed' ? 'completed' : result.outcome === 'waiting_customer' ? 'waiting_customer' : 'waiting_review';
    effects.push(db.prepare(`UPDATE automation_work SET stage=?, decision_outcome=?, report_revision=(SELECT report_revision FROM reports WHERE id=?),
        worker_id=NULL, lease_token_hash=NULL, lease_expires_at=NULL, retry_at=NULL, progress_json=NULL, updated_at=?
        WHERE work_id=? AND revoked_reason IS NULL AND (?=1 OR stage NOT IN ('queued','running'))`)
        .bind(stage, 'retest_' + result.outcome, report.id, at, report.work_id,
            Number(result.outcome === 'completed' || result.outcome === 'verified' || result.outcome === 'waiting_customer')));
    return effects;
}

export async function recordRetestResult(env: Env, scope: W4Scope, input: RetestObservation, now: number) {
    const db = env.DB;
    assertScopeRevision(scope, input.scope_revision);
    const start = input.started_at === null ? null : Date.parse(input.started_at);
    const generation = input.attempt_generation ?? 0;
    const proved = input.outcome === 'passed' || input.outcome === 'assertion_failed';
    const finish = Date.parse(input.finished_at);
    if ((input.attempt_id === null) !== (generation === 0) ||
        (start !== null && (generation === 0 || !Number.isFinite(start) || start > finish)) ||
        (proved && (generation === 0 || start === null)) || !Number.isFinite(finish) || finish > now + 5 * 60_000) {
        throw new AutomationError('invalid_request', 400, '重測代次或執行時間不符。');
    }
    const data = { ...input, started_at: start === null ? null : nowIso(start), finished_at: nowIso(finish) };
    const { operation_id, scope_revision: _scopeRevision, ...observation } = data;
    const observationHash = await sha256Hex(canonicalJson({ ...observation,
        checks: [...observation.checks].sort((a, b) => a.check_key < b.check_key ? -1 : 1),
        evidence_refs: [...new Set(observation.evidence_refs)].sort(),
    }));
    const requestHash = await sha256Hex(canonicalJson({ operation_id, observation_hash: observationHash }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const row = await lookupIntent(db, scope, data.retest_request_id);
        assertBinding(row, data);
        if (!row.run_id || data.finished_at < row.occurred_at || data.started_at !== null && data.started_at < row.occurred_at) throw conflict();
        const requiredChecks = new Set(intentView(row).check_keys);
        if (data.checks.some(check => !requiredChecks.has(check.check_key))) throw conflict();
        const saved = await savedReceipt(db, scope, operation_id, requestHash);
        if (saved) return { receipt: saved };
        const prior = await earlierObservation(db, data, generation, observationHash);
        const effects = [assertion(db, `${W4_AUTH} AND EXISTS (SELECT 1 FROM automation_retest_intents q
            WHERE q.project_id=?1 AND q.environment=?2 AND q.source_instance=?3 AND q.retest_request_id=?7
              AND q.run_id=?8 AND q.status=?9 AND q.latest_generation=?10)`,
        [...w4Bindings(scope), data.retest_request_id, data.run_id, row.status, row.latest_generation])];
        let receipt: ResultReceipt;
        if (prior) {
            receipt = { ...prior, operation_id };
        } else {
            const stale = row.status === 'superseded' || row.scope_revision !== scope.scope_revision || generation < row.latest_generation;
            const { results: reports } = await db.prepare(REPORTS + ' ORDER BY a.report_public_id')
                .bind(data.retest_request_id, data.started_at).all<AffectedReport>();
            const outcomes = reports.map(report => reportResult(report, data, stale));
            const outcome = stale || outcomes.every(item => item.outcome === 'ignored_stale') ? 'ignored_stale' :
                outcomes.some(item => !['needs_review', 'ignored_stale'].includes(item.outcome)) ? 'applied' : 'needs_review';
            receipt = { operation_id, retest_request_id: data.retest_request_id, run_id: data.run_id, attempt_id: data.attempt_id, outcome, reports: outcomes };
            effects.push(db.prepare(`INSERT INTO automation_retest_results (retest_request_id, attempt_generation,
                attempt_id, token_hash, observation_hash, observation_json, received_at) VALUES (?,?,?,?,?,?,${SQL_NOW})`)
                .bind(data.retest_request_id, generation, data.attempt_id, scope.tokenHash, observationHash, JSON.stringify(observation)));
            for (const [index, report] of reports.entries()) {
                effects.push(...resultReportEffects(env, data, generation, report, outcomes[index], nowIso(now)));
            }
            if (!stale) {
                effects.push(db.prepare("UPDATE automation_retest_intents SET status='finished', latest_generation=? WHERE retest_request_id=?")
                    .bind(generation, data.retest_request_id));
            }
        }
        effects.push(db.prepare(`INSERT INTO automation_retest_receipts (project_id, environment, operation_id,
            retest_request_id, attempt_generation, request_hash, receipt_json) VALUES (?,?,?,?,?,?,?)`)
            .bind(scope.project_id, scope.environment, operation_id, data.retest_request_id, generation, requestHash, JSON.stringify(receipt)));
        try {
            await db.batch(effects);
            return { receipt };
        } catch (error) {
            if (!isW4Contention(error)) throw error;
        }
    }
    throw w4Busy();
}

export async function retestHistory(db: D1Database, projectId: number, environment: string, reportId: string) {
    const { results } = await db.prepare(`SELECT q.retest_request_id, d.deployment_id, d.component_id, d.artifact_revision,
        d.sequence, d.evidence_ref AS deployment_evidence_ref, q.run_id, q.workspace_id, q.test_id, q.version_id, q.status,
        a.check_key, z.attempt_generation, z.outcome, z.reason, rr.observation_json
        FROM automation_retest_reports a
        JOIN automation_retest_intents q ON q.retest_request_id=a.retest_request_id
        JOIN automation_deployments d USING (project_id, environment, deployment_id)
        LEFT JOIN automation_retest_report_results z ON z.retest_request_id=a.retest_request_id AND z.report_public_id=a.report_public_id
        LEFT JOIN automation_retest_results rr ON rr.retest_request_id=z.retest_request_id AND rr.attempt_generation=z.attempt_generation
        WHERE q.project_id=? AND q.environment=? AND a.report_public_id=?
        ORDER BY q.cursor DESC, z.attempt_generation DESC LIMIT 30`).bind(projectId, environment, reportId)
        .all<Record<string, unknown> & { observation_json: string | null }>();
    return results.map(({ observation_json, ...row }) => ({ ...row, ...(observation_json ? { observation: JSON.parse(observation_json) as object } : {}) }));
}

export async function retestRunReports(db: D1Database, projectId: number, environment: string, runId: string) {
    const { results } = await db.prepare(`SELECT q.retest_request_id, q.workspace_id, q.test_id, q.version_id,
        q.deployment_id, d.artifact_revision, q.run_id, q.status, a.report_public_id, a.check_key,
        r.title, r.status AS report_status
        FROM automation_retest_intents q JOIN automation_retest_reports a ON a.retest_request_id=q.retest_request_id
        JOIN automation_deployments d USING (project_id, environment, deployment_id)
        LEFT JOIN reports r ON r.project_id=q.project_id AND r.public_id=a.report_public_id
        WHERE q.project_id=? AND q.environment=? AND q.run_id=?
        ORDER BY q.cursor DESC, a.report_public_id`).bind(projectId, environment, runId).all();
    return { run_id: runId, reports: results };
}
