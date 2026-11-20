import { sha256Hex } from './crypto';
import { messageTarget, type MessageTarget } from './db';

export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SQL_LEASE_END = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')";
const EVENT_PAGE_SIZE = 100;

export const AUTOMATION_STAGES = ['queued', 'running', 'waiting_customer', 'waiting_review', 'blocked', 'completed'] as const;
type Stage = (typeof AUTOMATION_STAGES)[number];
type Data = Record<string, unknown>;

export interface AutomationScope {
    project_id: number;
    project_slug: string;
    environment: string;
    scope_revision: string;
    enabled: number;
    tokenHash: string;
}

export interface Lease {
    worker_id: string;
    work_id: string;
    report_public_id: string;
    report_revision: number;
    lease_generation: number;
    scope_revision: string;
}

export class AutomationError extends Error {
    constructor(readonly code: string, readonly status: 400 | 401 | 403 | 409, message: string) {
        super(message);
    }
}

export async function automationScope(db: D1Database, authorization: string | undefined, projectSlug: string, environment: string): Promise<AutomationScope> {
    const plain = /^Bearer (fda_[A-Za-z0-9_-]{28,124})$/i.exec(authorization ?? '')?.[1];
    if (!plain) {
        throw new AutomationError('unauthorized', 401, '需要有效的自動化憑證。');
    }
    const tokenHash = await sha256Hex(plain);
    const scope = await db.prepare(
        `SELECT s.project_id, p.slug AS project_slug, s.environment, s.scope_revision, s.enabled
         FROM automation_tokens t
         JOIN automation_scopes s ON s.project_id = t.project_id AND s.environment = t.environment
         JOIN projects p ON p.id = s.project_id
         WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    ).bind(tokenHash).first<Omit<AutomationScope, 'tokenHash'>>();
    if (!scope) {
        throw new AutomationError('unauthorized', 401, '需要有效的自動化憑證。');
    }
    if (scope.enabled !== 1 || scope.project_slug !== projectSlug || scope.environment !== environment) {
        throw new AutomationError('scope_forbidden', 403, '憑證無權存取此專案與環境。');
    }
    return { ...scope, tokenHash };
}

export function assertScopeRevision(scope: AutomationScope, revision: string): void {
    if (scope.scope_revision !== revision) {
        throw new AutomationError('scope_changed', 409, '專案範圍版本已變動。');
    }
}

/** Appended inside the message, attachments and status batch, after changes to report_revision. */
export function customerReplyEvent(db: D1Database, reportId: number, target: MessageTarget, at: string): D1PreparedStatement {
    const message = messageTarget(target);
    return db.prepare(
        `INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision, occurred_at, report_public_id, report_revision, message_id, ignored_reason)
         SELECT 'report.customer_replied:' || m.id, 'report.customer_replied', r.project_id, s.environment, s.scope_revision, ?, r.public_id, r.report_revision, m.id,
             CASE
                 WHEN r.automation_manual_takeover = 1 OR r.claimed_by_developer_id IS NOT NULL THEN 'manual_takeover'
                 WHEN r.client_deleted_at IS NOT NULL OR r.status = 'completed' THEN 'report_closed'
             END
         FROM reports r JOIN automation_scopes s ON s.project_id = r.project_id
         JOIN messages m ON m.id = ${message.sql} AND m.report_id = r.id
         WHERE r.id = ? AND r.creator_type = 'client' AND m.author_type = 'reporter'
             AND s.enabled = 1 AND s.customer_ingress = 1
         ON CONFLICT (event_id) DO NOTHING`,
    ).bind(at, message.value, reportId);
}

interface EventRow {
    cursor: number;
    event_id: string;
    event_type: string;
    report_public_id: string;
    report_revision: number;
    message_id: number | null;
    occurred_at: string;
    ignored_reason: string | null;
}

export async function listAutomationEvents(db: D1Database, scope: AutomationScope, after: number) {
    const { results } = await db.prepare(
        `SELECT cursor, event_id, event_type, report_public_id, report_revision, message_id, occurred_at, ignored_reason
         FROM automation_events e
         JOIN automation_scopes s USING (project_id, environment)
         JOIN automation_tokens t USING (project_id, environment)
         WHERE e.project_id = ? AND e.environment = ? AND e.cursor > ?
             AND s.enabled = 1 AND t.token_hash = ? AND t.revoked_at IS NULL
         ORDER BY cursor LIMIT ?`,
    ).bind(scope.project_id, scope.environment, after, scope.tokenHash, EVENT_PAGE_SIZE).all<EventRow>();
    return {
        events: results.map((row) => ({
            schema_version: 1,
            event_id: row.event_id,
            event_type: row.event_type,
            source: 'feedback-desk',
            scope: { project_slug: scope.project_slug, environment: scope.environment },
            occurred_at: row.occurred_at,
            correlation_id: row.event_id,
            payload: {
                report_public_id: row.report_public_id,
                report_revision: row.report_revision,
                ...(row.message_id === null ? {} : { message_id: row.message_id }),
            },
            ...(row.ignored_reason === null ? {} : { ignored_reason: row.ignored_reason }),
        })),
        next_cursor: String(results.at(-1)?.cursor ?? after),
    };
}

interface WorkRow extends Omit<Lease, 'worker_id'> {
    worker_id: string | null;
    stage: Stage;
    event_id: string;
    progress_json: string | null;
    retry_at: string | null;
    lease_expires_at: string | null;
}

const WORK_COLUMNS = `work_id, report_public_id, report_revision, lease_generation, scope_revision, worker_id, stage, progress_json, retry_at, lease_expires_at,
    (SELECT event_id FROM automation_events WHERE cursor = automation_work.event_cursor) AS event_id`;

function workView(row: WorkRow) {
    const { progress_json, ...work } = row;
    return { ...work, progress: progress_json === null ? null : JSON.parse(progress_json) as Data };
}

function assertLease<T>(row: T | null | undefined): T {
    if (!row) {
        throw new AutomationError('lease_conflict', 409, '工單版本或租約已失效。');
    }
    return row;
}

// Lease validity, report liveness and revocable credentials are checked at the guarded write.
export const ACTIVE_LEASE = `
    w.project_id = ?1 AND w.environment = ?2 AND w.scope_revision = ?3 AND w.lease_token_hash = ?4
    AND w.work_id = ?5 AND w.report_public_id = ?6 AND w.report_revision = ?7 AND w.lease_generation = ?8 AND w.worker_id = ?9
    AND w.revoked_reason IS NULL AND w.stage IN ('queued', 'running') AND w.lease_expires_at > ${SQL_NOW}
    AND EXISTS (
        SELECT 1 FROM reports r JOIN automation_scopes s ON s.project_id = r.project_id
        JOIN automation_tokens t ON t.project_id = s.project_id AND t.environment = s.environment
        WHERE r.project_id = w.project_id AND r.public_id = w.report_public_id AND r.report_revision = w.report_revision
            AND r.client_deleted_at IS NULL AND r.status <> 'completed' AND r.claimed_by_developer_id IS NULL AND r.automation_manual_takeover = 0
            AND s.environment = w.environment AND s.scope_revision = w.scope_revision AND s.enabled = 1 AND s.customer_ingress = 1
            AND t.token_hash = w.lease_token_hash AND t.revoked_at IS NULL
    )`;

export function leaseBindings(scope: AutomationScope, lease: Lease): [number, string, string, string, string, string, number, number, string] {
    assertScopeRevision(scope, lease.scope_revision);
    return [
        scope.project_id, scope.environment, lease.scope_revision, scope.tokenHash,
        lease.work_id, lease.report_public_id, lease.report_revision, lease.lease_generation, lease.worker_id,
    ];
}

export async function claimAutomationWork(db: D1Database, scope: AutomationScope, workerId: string, revision: string) {
    assertScopeRevision(scope, revision);
    // Choosing the candidate and fencing it is one statement. A reacquired lease increments the
    // generation even when the same worker restarts. An edited report needs a fresh checkpoint.
    const row = await db.prepare(
        `UPDATE automation_work SET
            stage = CASE WHEN automation_work.report_revision <> r.report_revision THEN 'queued' ELSE stage END,
            next_action = CASE WHEN automation_work.report_revision <> r.report_revision THEN 'analyze' ELSE next_action END,
            progress_json = CASE WHEN automation_work.report_revision <> r.report_revision THEN NULL ELSE progress_json END,
            retry_at = NULL,
            report_revision = r.report_revision, worker_id = ?5, lease_token_hash = ?4, lease_expires_at = ${SQL_LEASE_END},
            lease_generation = lease_generation + 1, updated_at = ${SQL_NOW}
         FROM reports r
         WHERE r.public_id = automation_work.report_public_id AND automation_work.work_id = (
             SELECT w.work_id FROM automation_work w
             JOIN reports report ON report.public_id = w.report_public_id AND report.project_id = w.project_id
             JOIN automation_scopes s ON s.project_id = w.project_id AND s.environment = w.environment
             JOIN automation_tokens t ON t.project_id = s.project_id AND t.environment = s.environment
             WHERE w.project_id = ?1 AND w.environment = ?2 AND w.scope_revision = ?3
                 AND s.scope_revision = w.scope_revision AND s.enabled = 1 AND s.customer_ingress = 1
                 AND t.token_hash = ?4 AND t.revoked_at IS NULL
                 AND w.revoked_reason IS NULL AND w.stage IN ('queued', 'running')
                 AND (w.retry_at IS NULL OR w.retry_at <= ${SQL_NOW})
                 AND (w.lease_expires_at IS NULL OR w.lease_expires_at <= ${SQL_NOW} OR w.report_revision <> report.report_revision)
                 AND report.client_deleted_at IS NULL AND report.status <> 'completed'
                 AND report.claimed_by_developer_id IS NULL AND report.automation_manual_takeover = 0
             ORDER BY w.event_cursor LIMIT 1
         ) RETURNING ${WORK_COLUMNS}`,
    ).bind(scope.project_id, scope.environment, revision, scope.tokenHash, workerId).first<WorkRow>();
    return { work: row === null ? null : workView(row) };
}

export async function renewAutomationWork(db: D1Database, scope: AutomationScope, lease: Lease) {
    const row = await db.prepare(
        `UPDATE automation_work AS w SET lease_expires_at = ${SQL_LEASE_END}, updated_at = ${SQL_NOW}
         WHERE ${ACTIVE_LEASE} RETURNING ${WORK_COLUMNS}`,
    ).bind(...leaseBindings(scope, lease)).first<WorkRow>();
    return { work: workView(assertLease(row)) };
}

export async function saveAutomationProgress(
    db: D1Database, scope: AutomationScope, lease: Lease, stage: Stage, progress: Data | null | undefined, retryAt: string | undefined,
) {
    const release = retryAt !== undefined || (stage !== 'queued' && stage !== 'running');
    const row = await db.prepare(
        `UPDATE automation_work AS w SET
            stage = ?10, progress_json = CASE WHEN ?11 THEN ?12 ELSE progress_json END, retry_at = ?13,
            lease_expires_at = CASE WHEN ?14 THEN NULL ELSE lease_expires_at END,
            lease_token_hash = CASE WHEN ?14 THEN NULL ELSE lease_token_hash END,
            worker_id = CASE WHEN ?14 THEN NULL ELSE worker_id END, updated_at = ${SQL_NOW}
         WHERE ${ACTIVE_LEASE} RETURNING ${WORK_COLUMNS}`,
    ).bind(...leaseBindings(scope, lease), stage, Number(progress !== undefined), progress == null ? null : canonicalJson(progress), retryAt ?? null, Number(release)).first<WorkRow>();
    return { work: workView(assertLease(row)) };
}

interface OperationRow {
    operation_id: string;
    work_id: string;
    report_revision: number;
    correlation_id: string;
    operation_type: string;
    worker_id: string;
    lease_generation: number;
    created_at: string;
    result_json: string | null;
    recorded_at: string | null;
}

export function canonicalJson(data: Data): string {
    try {
        return JSON.stringify(data, (_key, value: unknown) => {
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
            }
            return value;
        });
    } catch {
        throw new AutomationError('invalid_request', 400, '操作資料的巢狀結構超出限制。');
    }
}

function receiptView(row: OperationRow, reportPublicId: string) {
    return {
        operation_id: row.operation_id,
        work_id: row.work_id,
        report_public_id: reportPublicId,
        report_revision: row.report_revision,
        status: 'recorded',
        result: JSON.parse(row.result_json as string) as Data,
        recorded_at: row.recorded_at,
    };
}

export async function recordAutomationIntent(
    db: D1Database, scope: AutomationScope, lease: Lease,
    operation: { operation_id: string; correlation_id: string; operation_type: string; payload: Data },
    additionalGuard?: { sql: string; values: (string | number | null)[] },
) {
    const bindings = leaseBindings(scope, lease);
    const hash = await sha256Hex(canonicalJson(operation.payload));
    // The no-op update returns the original row only when the same intent is replayed.
    const row = await db.prepare(
        `INSERT INTO automation_operations (project_id, environment, operation_id, work_id, report_revision, correlation_id, operation_type, payload_hash, worker_id, lease_generation, created_at)
         SELECT ?1, ?2, ?10, ?5, ?7, ?11, ?12, ?13, ?9, ?8, ${SQL_NOW}
         WHERE EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE} ${additionalGuard?.sql ?? ''})
         ON CONFLICT (project_id, environment, operation_id) DO UPDATE SET operation_id = excluded.operation_id
         WHERE work_id = excluded.work_id AND report_revision = excluded.report_revision
             AND correlation_id = excluded.correlation_id AND operation_type = excluded.operation_type AND payload_hash = excluded.payload_hash
         RETURNING *`,
    ).bind(...bindings, operation.operation_id, operation.correlation_id, operation.operation_type, hash, ...(additionalGuard?.values ?? [])).first<OperationRow>();
    if (!row) {
        throw new AutomationError('operation_conflict', 409, '操作內容或租約與此次請求不符。');
    }
    return {
        intent: {
            operation_id: row.operation_id,
            correlation_id: row.correlation_id,
            operation_type: row.operation_type,
            status: row.recorded_at === null ? 'pending' : 'recorded',
            worker_id: row.worker_id,
            lease_generation: row.lease_generation,
            created_at: row.created_at,
            receipt: row.recorded_at === null ? null : receiptView(row, lease.report_public_id),
        },
    };
}

export async function recordAutomationReceipt(db: D1Database, scope: AutomationScope, lease: Lease, operationId: string, result: Data) {
    const bindings = leaseBindings(scope, lease);
    const json = canonicalJson(result);
    const hash = await sha256Hex(json);
    const row = await db.prepare(
        `UPDATE automation_operations SET
            result_json = COALESCE(result_json, ?11), result_hash = COALESCE(result_hash, ?12),
            recorded_at = COALESCE(recorded_at, ${SQL_NOW}), recorded_by = COALESCE(recorded_by, ?9),
            recorded_generation = COALESCE(recorded_generation, ?8)
         WHERE project_id = ?1 AND environment = ?2 AND operation_id = ?10 AND work_id = ?5 AND report_revision = ?7
             AND operation_type NOT IN ('gitlab.create_merge_request', 'git.local_branch')
             AND (result_hash IS NULL OR result_hash = ?12)
             AND EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE})
         RETURNING *`,
    ).bind(...bindings, operationId, json, hash).first<OperationRow>();
    if (!row) {
        throw new AutomationError('receipt_conflict', 409, '操作意圖、租約或既有收據與此次請求不符。');
    }
    return { receipt: receiptView(row, lease.report_public_id) };
}
