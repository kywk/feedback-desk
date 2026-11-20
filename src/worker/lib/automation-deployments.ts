import { nowIso } from '../../shared/time';
import { AutomationError, assertion, assertScopeRevision, canonicalJson, failedAutomationAssertion, SQL_NOW, type AutomationScope } from './automation';
import { sha256Hex } from './crypto';

export type W4Role = 'deployment' | 'retest';
export interface W4Scope extends AutomationScope {
    role: W4Role;
    source_instance: string;
}

interface BaseDeployment {
    scope_revision: string;
    deployment_id: string;
    component_id: string;
    sequence: number;
    occurred_at: string;
    evidence_ref: string;
}
export type Deployment = BaseDeployment & (
    { state: 'succeeded'; artifact_revision: string; commit_shas: string[] } | { state: 'failed' }
);

type DeploymentOutcome = 'registered' | 'ignored_stale' | 'failed';
interface DeploymentReceipt {
    deployment_id: string;
    outcome: DeploymentOutcome;
    intent_ids: string[];
}

// The matching scope, integration role, registered source and active credential must survive the write transaction.
export const W4_AUTH = `EXISTS (SELECT 1 FROM automation_w4_tokens b JOIN automation_scopes s USING (project_id, environment)
    WHERE b.project_id=?1 AND b.environment=?2 AND b.source_instance=?3 AND s.scope_revision=?4
        AND b.token_hash=?5 AND b.role=?6 AND b.revoked_at IS NULL AND s.enabled=1)`;

const DEPLOYMENT_AUTH = `${W4_AUTH} AND EXISTS (SELECT 1 FROM automation_deployment_sources a
    WHERE a.project_id=?1 AND a.environment=?2 AND a.source_instance=?3 AND a.scope_revision=?4 AND a.component_id=?7)`;

const CURRENT_DEPLOYMENT = `SELECT MAX(sequence) FROM automation_deployments
    WHERE project_id=?1 AND environment=?2 AND component_id=?7`;

const UUID = "lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-a'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(6)))";

const CANDIDATES = `
    WITH eligible_targets AS (
        SELECT t.*, d.commits_json, s.customer_ingress, s.inspection_ingress
        FROM automation_retest_targets t
        JOIN automation_deployments d ON d.project_id=t.project_id AND d.environment=t.environment
            AND d.component_id=t.component_id AND d.scope_revision=t.scope_revision
        JOIN automation_scopes s ON s.project_id=t.project_id AND s.environment=t.environment
            AND s.scope_revision=t.scope_revision
        WHERE t.project_id=?1 AND t.environment=?2 AND d.deployment_id=?3 AND d.state='succeeded'
    ), eligible_work AS (
        SELECT t.*, r.public_id, r.report_revision, w.work_id, w.ingress_kind, w.proposal_revision
        FROM eligible_targets t
        JOIN automation_work w ON w.project_id=t.project_id AND w.environment=t.environment AND w.scope_revision=t.scope_revision
        JOIN reports r ON r.project_id=w.project_id AND r.public_id=w.report_public_id
        WHERE r.status<>'completed' AND r.client_deleted_at IS NULL AND r.claimed_by_developer_id IS NULL
            AND r.automation_manual_takeover=0
            AND (w.revoked_reason IS NULL OR (w.ingress_kind='inspection' AND w.revoked_reason='report_shared'))
            AND CASE w.ingress_kind WHEN 'inspection' THEN t.inspection_ingress ELSE t.customer_ingress END=1
            AND NOT EXISTS (SELECT 1 FROM automation_work newer
                WHERE newer.report_public_id=w.report_public_id AND newer.event_cursor>w.event_cursor)
    ), candidates AS (
        SELECT e.id AS target_id, e.source_instance, e.workspace_id, e.test_id, e.version_id, e.check_key,
            e.public_id, e.report_revision, e.work_id, json_extract(m.observation_json, '$.head_sha') AS mr_head_sha
        FROM eligible_work e
        JOIN automation_mr_links m ON m.work_id=e.work_id AND m.decision_revision=e.proposal_revision
        JOIN automation_policies p ON p.project_id=e.project_id AND p.environment=e.environment
            AND p.scope_revision=e.scope_revision AND p.gitlab_instance_id=m.gitlab_instance_id
        JOIN automation_repositories r ON r.project_id=e.project_id AND r.environment=e.environment
            AND r.scope_revision=e.scope_revision AND r.repo_id=e.repo_id AND r.gitlab_project_id=m.gitlab_project_id
        WHERE e.target_kind='mr' AND r.delivery_mode='gitlab'
            AND json_extract(m.observation_json, '$.repo_id')=e.repo_id
            AND json_extract(m.observation_json, '$.head_sha') IN (SELECT value FROM json_each(e.commits_json))
            AND EXISTS (SELECT 1 FROM automation_work w WHERE w.work_id=e.work_id AND w.report_revision=e.report_revision)
        UNION ALL
        SELECT e.id, e.source_instance, e.workspace_id, e.test_id, e.version_id, e.check_key,
            e.public_id, e.report_revision, e.work_id, NULL
        FROM eligible_work e
        JOIN automation_inspection_groups g ON g.report_public_id=e.public_id AND g.project_id=e.project_id
            AND g.environment=e.environment AND g.source_instance=e.source_instance
            AND g.workspace_id=e.workspace_id AND g.test_id=e.test_id AND g.check_key=e.check_key
        JOIN automation_inspection_targets known ON known.project_id=e.project_id AND known.environment=e.environment
            AND known.scope_revision=e.scope_revision AND known.source_instance=g.source_instance
            AND known.workspace_id=g.workspace_id AND known.test_id=g.test_id AND known.check_key=g.check_key
        WHERE e.target_kind='inspection' AND e.ingress_kind='inspection'
            AND NOT EXISTS (SELECT 1 FROM automation_mr_links m WHERE m.work_id=e.work_id)
    )`;

export function w4Bindings(scope: W4Scope): [number, string, string, string, string, W4Role] {
    return [scope.project_id, scope.environment, scope.source_instance, scope.scope_revision, scope.tokenHash, scope.role];
}

export function w4Denied(): AutomationError {
    return new AutomationError('scope_forbidden', 403, '憑證無權執行此專案環境的部署或重測操作。');
}

export function isW4Contention(error: unknown): boolean {
    return failedAutomationAssertion(error) || error instanceof Error &&
        /UNIQUE constraint failed: automation_(?:deployments|retest_(?:intents|receipts|results|reports))\./.test(error.message);
}

export function w4Busy(): AutomationError {
    return new AutomationError('retest_busy', 503, '部署或重測紀錄正在更新，請重試原操作。');
}

export async function w4Scope(db: D1Database, authorization: string | undefined, slug: string, environment: string, role: W4Role): Promise<W4Scope> {
    const plain = /^Bearer (fd[dr]_[A-Za-z0-9_-]{28,124})$/i.exec(authorization ?? '')?.[1];
    const prefix = role === 'deployment' ? 'fdd_' : 'fdr_';
    const tokenHash = plain?.startsWith(prefix) ? await sha256Hex(plain) : null;
    const scope = tokenHash && await db.prepare(`SELECT s.project_id, p.slug AS project_slug, s.environment, s.scope_revision,
        s.enabled, b.source_instance, b.role FROM automation_w4_tokens b
        JOIN automation_scopes s USING (project_id, environment) JOIN projects p ON p.id=s.project_id
        WHERE b.token_hash=? AND b.role=? AND b.revoked_at IS NULL`)
        .bind(tokenHash, role).first<Omit<W4Scope, 'tokenHash'>>();
    if (!scope || !tokenHash) throw new AutomationError('unauthorized', 401, '需要有效的部署或重測憑證。');
    if (scope.enabled !== 1 || scope.project_slug !== slug || scope.environment !== environment) throw w4Denied();
    return { ...scope, tokenHash };
}

interface ExistingDeployment {
    deployment_id: string;
    source_instance: string;
    request_hash: string;
    receipt_json: string;
}

async function previousReceipt(db: D1Database, scope: W4Scope, event: Deployment, requestHash: string) {
    const { results } = await db.prepare(`SELECT deployment_id, source_instance, request_hash, receipt_json FROM automation_deployments
        WHERE project_id=?1 AND environment=?2 AND (deployment_id=?3 OR (component_id=?4 AND sequence=?5))`)
        .bind(scope.project_id, scope.environment, event.deployment_id, event.component_id, event.sequence).all<ExistingDeployment>();
    if (!results.length) return null;
    const [row] = results;
    if (results.length !== 1 || row.deployment_id !== event.deployment_id || row.source_instance !== scope.source_instance || row.request_hash !== requestHash) {
        throw new AutomationError('deployment_conflict', 409, '部署識別或來源序號已登記不同資料。');
    }
    return JSON.parse(row.receipt_json) as DeploymentReceipt;
}

export async function registerDeployment(db: D1Database, scope: W4Scope, event: Deployment, now: number) {
    assertScopeRevision(scope, event.scope_revision);
    const timestamp = Date.parse(event.occurred_at);
    if (!Number.isFinite(timestamp) || timestamp > now + 5 * 60_000) {
        throw new AutomationError('invalid_request', 400, '部署時間不符。');
    }
    const occurredAt = nowIso(timestamp);
    const commitShas = event.state === 'succeeded' ? [...new Set(event.commit_shas)].sort() : [];
    const artifact = event.state === 'succeeded' ? event.artifact_revision : null;
    const requestHash = await sha256Hex(canonicalJson({
        deployment_id: event.deployment_id, component_id: event.component_id, sequence: event.sequence,
        occurred_at: occurredAt, state: event.state, artifact_revision: artifact, commit_shas: commitShas, evidence_ref: event.evidence_ref,
    }));
    const binding = [...w4Bindings(scope), event.component_id];
    const identity = [scope.project_id, scope.environment, event.deployment_id];
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!await db.prepare(`SELECT ${DEPLOYMENT_AUTH} AS allowed`).bind(...binding).first<number>('allowed')) throw w4Denied();
        const previous = await previousReceipt(db, scope, event, requestHash);
        if (previous) return { receipt: previous };
        const latest = await db.prepare(`SELECT (${CURRENT_DEPLOYMENT}) AS n`).bind(...binding).first<number>('n');
        const stale = latest !== null && event.sequence < latest;
        const outcome: DeploymentOutcome = stale ? 'ignored_stale' : event.state === 'failed' ? 'failed' : 'registered';
        const effects = [
            assertion(db, `${DEPLOYMENT_AUTH} AND (${CURRENT_DEPLOYMENT}) IS ?8`, [...binding, latest]),
            db.prepare(`INSERT INTO automation_deployments (project_id, environment, deployment_id, component_id,
                source_instance, scope_revision, token_hash, sequence, occurred_at, state, artifact_revision, commits_json, evidence_ref,
                request_hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW})`)
                .bind(...identity, event.component_id, scope.source_instance, scope.scope_revision, scope.tokenHash,
                    event.sequence, occurredAt, event.state, artifact, JSON.stringify(commitShas), event.evidence_ref, requestHash),
        ];
        if (!stale) {
            effects.push(db.prepare(`UPDATE automation_retest_intents AS q SET status='superseded'
                WHERE q.project_id=?1 AND q.environment=?2 AND q.status<>'superseded' AND EXISTS (
                    SELECT 1 FROM automation_deployments d WHERE d.project_id=q.project_id AND d.environment=q.environment
                        AND d.deployment_id=q.deployment_id AND d.component_id=?3 AND d.sequence<?4)`)
                .bind(scope.project_id, scope.environment, event.component_id, event.sequence));
        }
        if (outcome === 'registered') {
            effects.push(
                db.prepare(`${CANDIDATES} INSERT INTO automation_retest_intents (
                        retest_request_id, project_id, environment, deployment_id, source_instance, workspace_id, test_id, version_id)
                    SELECT ${UUID}, ?1, ?2, ?3, source_instance, workspace_id, test_id, version_id FROM candidates
                    GROUP BY source_instance, workspace_id, test_id, version_id ORDER BY source_instance, workspace_id, test_id, version_id`).bind(...identity),
                db.prepare(`${CANDIDATES} INSERT INTO automation_retest_reports (
                        retest_request_id, report_public_id, report_revision, work_id, target_id, check_key, mr_head_sha)
                    SELECT q.retest_request_id, c.public_id, c.report_revision, c.work_id, c.target_id, c.check_key, c.mr_head_sha
                    FROM candidates c JOIN automation_retest_intents q
                        ON q.project_id=?1 AND q.environment=?2 AND q.deployment_id=?3 AND q.source_instance=c.source_instance
                        AND q.workspace_id=c.workspace_id AND q.test_id=c.test_id AND q.version_id=c.version_id`).bind(...identity),
            );
        }
        effects.push(db.prepare(`UPDATE automation_deployments SET receipt_json=json_object(
            'deployment_id', ?3, 'outcome', ?4, 'intent_ids', json((SELECT json_group_array(retest_request_id) FROM (
                SELECT retest_request_id FROM automation_retest_intents WHERE project_id=?1 AND environment=?2 AND deployment_id=?3 ORDER BY cursor
            )))) WHERE project_id=?1 AND environment=?2 AND deployment_id=?3 RETURNING receipt_json`).bind(...identity, outcome));
        try {
            const batch = await db.batch<{ receipt_json: string }>(effects);
            return { receipt: JSON.parse(batch.at(-1)!.results[0].receipt_json) as DeploymentReceipt };
        } catch (error) {
            if (!isW4Contention(error)) throw error;
        }
    }
    throw w4Busy();
}

export async function deploymentRecord(db: D1Database, projectId: number, environment: string, id: string) {
    const row = await db.prepare(`SELECT deployment_id, component_id, source_instance, scope_revision, sequence, occurred_at,
        state, artifact_revision, evidence_ref, commits_json, receipt_json, received_at
        FROM automation_deployments WHERE project_id=? AND environment=? AND deployment_id=?`)
        .bind(projectId, environment, id).first<Record<string, unknown> & { commits_json: string; receipt_json: string }>();
    if (!row) return null;
    const { commits_json, receipt_json, ...rest } = row;
    return { ...rest, commit_shas: JSON.parse(commits_json) as string[], receipt: JSON.parse(receipt_json) as DeploymentReceipt };
}
