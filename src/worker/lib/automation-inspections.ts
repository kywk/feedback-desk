import { redactAnalysisText } from '../../shared/automation-analysis.mjs';
import { nowIso } from '../../shared/time';
import {
    AutomationError, SQL_NOW, assertion, assertScopeRevision, canonicalJson,
    failedAutomationAssertion, type AutomationScope,
} from './automation';
import { sha256Hex } from './crypto';
import { createReportStatements } from './reports';

type Scope = Pick<AutomationScope, 'project_id' | 'project_slug' | 'environment' | 'scope_revision'>;
interface InspectionScope extends AutomationScope {
    source_instance: string;
    inspection_ingress: number;
}

export interface InspectionEvent {
    event_id: string;
    operation_id: string;
    scope_revision: string;
    occurred_at: string;
    payload: {
        workspace_id: string;
        test_id: string;
        version_id: string;
        run_id: string;
        attempt_id: string;
        started_at: string;
        check_key: string;
        failure_signature: string;
        summary: string;
        evidence_refs: string[];
    };
}

export interface InspectionLink {
    workspace_id: string;
    run_id: string;
    attempt_id: string;
    report_public_id: string;
}

type InspectionReceipt = Omit<InspectionLink, 'report_public_id'> & {
    event_id: string;
    operation_id: string;
} & ({ outcome: 'linked'; report_public_id: string } |
    { outcome: 'ignored'; report_public_id: null; ignored_reason: 'stale_run' });

interface RunRow {
    project_id: number;
    environment: string;
    observation_hash: string;
    report_public_id: string | null;
}

interface GroupHead {
    report_public_id: string;
    closed_at: string | null;
    previous_closed_at: string | null;
}

const LINK_COLUMNS = 'workspace_id, run_id, attempt_id, report_public_id';
const BRIDGE_SECRET = /\bfdi_[A-Za-z0-9_-]{28,124}\b/g;
const ACTIVE_TARGETS = `automation_inspection_targets t
    JOIN automation_scopes s ON s.project_id=t.project_id AND s.environment=t.environment AND s.scope_revision=t.scope_revision
    JOIN automation_inspection_tokens b ON b.project_id=t.project_id AND b.environment=t.environment AND b.source_instance=t.source_instance
    WHERE t.project_id=?1 AND t.environment=?2 AND t.source_instance=?3 AND t.scope_revision=?4
      AND b.token_hash=?5 AND b.revoked_at IS NULL AND s.enabled=1 AND s.inspection_ingress=1`;
const EVENT_TARGET = `EXISTS (SELECT 1 FROM ${ACTIVE_TARGETS} AND t.workspace_id=?6 AND t.test_id=?7 AND t.check_key=?8)`;
const LINK_TARGET = `EXISTS (SELECT 1 FROM ${ACTIVE_TARGETS}
    AND t.workspace_id=r.workspace_id AND t.test_id=r.test_id AND t.check_key=r.check_key)`;
const GROUP_HEAD = `SELECT g.report_public_id, g.closed_at, prev.closed_at AS previous_closed_at
    FROM automation_inspection_groups g
    LEFT JOIN automation_inspection_groups prev ON prev.report_public_id=g.previous_report_public_id
    WHERE g.project_id=?1 AND g.environment=?2 AND g.source_instance=?3
      AND g.workspace_id=?4 AND g.test_id=?5 AND g.check_key=?6 AND g.failure_signature=?7
    ORDER BY g.closed_at IS NULL DESC, g.closed_at DESC, g.rowid DESC LIMIT 1`;

function denied() {
    return new AutomationError('scope_forbidden', 403, '憑證無權存取此巡檢範圍。');
}

function conflict() {
    return new AutomationError('inspection_conflict', 409, '此巡檢事件、操作或 Run 已登記不同內容。');
}

function scopeBindings(scope: InspectionScope): [number, string, string, string, string] {
    return [scope.project_id, scope.environment, scope.source_instance, scope.scope_revision, scope.tokenHash];
}

export async function inspectionScope(db: D1Database, authorization: string | undefined, slug: string, environment: string): Promise<InspectionScope> {
    const plain = /^Bearer (fdi_[A-Za-z0-9_-]{28,124})$/i.exec(authorization ?? '')?.[1];
    const tokenHash = plain ? await sha256Hex(plain) : null;
    const scope = tokenHash && await db.prepare(
        `SELECT s.project_id, p.slug AS project_slug, s.environment, s.scope_revision, s.enabled, s.inspection_ingress, b.source_instance
         FROM automation_inspection_tokens b JOIN automation_scopes s USING (project_id, environment)
         JOIN projects p ON p.id=s.project_id WHERE b.token_hash=? AND b.revoked_at IS NULL`,
    ).bind(tokenHash).first<Omit<InspectionScope, 'tokenHash'>>();
    if (!scope || !tokenHash) throw new AutomationError('unauthorized', 401, '需要有效的巡檢轉接憑證。');
    if (scope.enabled !== 1 || scope.inspection_ingress !== 1 || scope.project_slug !== slug || scope.environment !== environment) {
        throw denied();
    }
    return { ...scope, tokenHash };
}

async function replay(db: D1Database, scope: InspectionScope, event: InspectionEvent, requestHash: string) {
    const { results } = await db.prepare(
        `SELECT project_id, environment, source_instance, event_id, operation_id, request_hash, receipt_json
         FROM automation_inspection_receipts WHERE (source_instance=? AND event_id=?)
         OR (project_id=? AND environment=? AND operation_id=?)`,
    ).bind(scope.source_instance, event.event_id, scope.project_id, scope.environment, event.operation_id).all<{
        project_id: number; environment: string; source_instance: string; event_id: string;
        operation_id: string; request_hash: string; receipt_json: string;
    }>();
    if (!results.length) return null;
    const [row] = results;
    if (results.length !== 1 || row.project_id !== scope.project_id || row.environment !== scope.environment ||
        row.source_instance !== scope.source_instance || row.event_id !== event.event_id ||
        row.operation_id !== event.operation_id || row.request_hash !== requestHash) throw conflict();
    return JSON.parse(row.receipt_json) as InspectionReceipt;
}

function assertRunScope(scope: InspectionScope, run: RunRow, observationHash: string) {
    if (run.project_id !== scope.project_id || run.environment !== scope.environment || run.observation_hash !== observationHash) throw conflict();
}

async function newInspectionReport(db: D1Database, projectId: number, now: number) {
    return createReportStatements(db, projectId, {
        title: 'Whippet 巡檢失敗',
        description: 'Whippet 正式巡檢的產品檢查未通過。團隊可查閱本單的巡檢紀錄與證據索引。',
        uploads: [],
        author: { name: 'Whippet', developerId: null, clientAccountId: null, agent: 'Whippet' },
        shared_with_client: false,
    }, { creator_type: 'owner_shared', creator_developer_id: null }, now);
}

function isContended(error: unknown) {
    return failedAutomationAssertion(error) || error instanceof Error &&
        /UNIQUE constraint failed: automation_inspection_(?:receipts|runs|groups)\./.test(error.message);
}

export async function acceptInspectionEvent(db: D1Database, scope: InspectionScope, event: InspectionEvent, now: number) {
    assertScopeRevision(scope, event.scope_revision);
    const data = event.payload;
    const start = Date.parse(data.started_at);
    const end = Date.parse(event.occurred_at);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end > now + 5 * 60_000) {
        throw new AutomationError('invalid_request', 400, '巡檢執行的開始或結束時間不符。');
    }
    const startedAt = nowIso(start);
    const occurredAt = nowIso(end);
    const receivedAt = nowIso(now);
    const observationHash = await sha256Hex(canonicalJson({ ...data, started_at: startedAt, occurred_at: occurredAt }));
    const requestHash = await sha256Hex(canonicalJson({ event_id: event.event_id, operation_id: event.operation_id, observation_hash: observationHash }));
    const target = [...scopeBindings(scope), data.workspace_id, data.test_id, data.check_key];
    const groupKey = [scope.project_id, scope.environment, scope.source_instance,
        data.workspace_id, data.test_id, data.check_key, data.failure_signature];
    const runKey = [scope.source_instance, data.workspace_id, data.run_id, data.check_key];

    // A concurrent write can create or close the group between observation and commit.
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!await db.prepare(`SELECT ${EVENT_TARGET} AS allowed`).bind(...target).first<number>('allowed')) throw denied();
        const prior = await replay(db, scope, event, requestHash);
        if (prior) return { receipt: prior };
        const run = await db.prepare(`SELECT project_id, environment, observation_hash, report_public_id FROM automation_inspection_runs
            WHERE source_instance=? AND workspace_id=? AND run_id=? AND check_key=?`).bind(...runKey).first<RunRow>();
        const statements = [assertion(db, EVENT_TARGET, target)];
        let reportPublicId = run?.report_public_id ?? null;
        if (run) {
            assertRunScope(scope, run, observationHash);
        } else {
            const head = await db.prepare(GROUP_HEAD).bind(...groupKey).first<GroupHead>();
            const cutoff = head?.closed_at ?? head?.previous_closed_at;
            statements.push(assertion(db, `EXISTS (WITH head AS (${GROUP_HEAD}) SELECT 1
                WHERE (SELECT report_public_id FROM head) IS ?8 AND (SELECT closed_at FROM head) IS ?9)`,
            [...groupKey, head?.report_public_id ?? null, head?.closed_at ?? null]));
            if (!cutoff || startedAt > cutoff) {
                if (head && head.closed_at === null) {
                    reportPublicId = head.report_public_id;
                    statements.push(db.prepare(`UPDATE automation_inspection_groups SET first_failed_at=min(first_failed_at, ?),
                        last_failed_at=max(last_failed_at, ?) WHERE report_public_id=?`).bind(occurredAt, occurredAt, reportPublicId));
                } else {
                    const report = await newInspectionReport(db, scope.project_id, now);
                    reportPublicId = report.publicId;
                    statements.push(...report.statements,
                        db.prepare(`INSERT INTO automation_inspection_groups (project_id, environment, source_instance, workspace_id,
                            test_id, check_key, failure_signature, report_public_id, previous_report_public_id, first_failed_at, last_failed_at)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
                            .bind(...groupKey, reportPublicId, head?.report_public_id ?? null, occurredAt),
                        db.prepare(`INSERT INTO automation_events (event_id, event_type, project_id, environment, scope_revision,
                            occurred_at, report_public_id, report_revision, ingress_kind)
                            VALUES (?, 'report.created', ?, ?, ?, ?, ?, 1, 'inspection')`)
                            .bind('report.created:' + reportPublicId, scope.project_id, scope.environment, scope.scope_revision, receivedAt, reportPublicId),
                    );
                }
            }
            statements.push(db.prepare(`INSERT INTO automation_inspection_runs (source_instance, workspace_id, run_id, check_key,
                attempt_id, test_id, version_id, project_id, environment, observation_hash, started_at, occurred_at, summary, evidence_json, report_public_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .bind(...runKey, data.attempt_id, data.test_id, data.version_id, scope.project_id, scope.environment, observationHash,
                    startedAt, occurredAt, redactAnalysisText(data.summary).replace(BRIDGE_SECRET, '[已遮罩]'),
                    JSON.stringify(data.evidence_refs), reportPublicId));
        }
        const receipt: InspectionReceipt = {
            event_id: event.event_id, operation_id: event.operation_id,
            workspace_id: data.workspace_id, run_id: data.run_id, attempt_id: data.attempt_id,
            ...(reportPublicId ? { outcome: 'linked', report_public_id: reportPublicId } :
                { outcome: 'ignored', report_public_id: null, ignored_reason: 'stale_run' }),
        };
        statements.push(db.prepare(`INSERT INTO automation_inspection_receipts (source_instance, event_id, project_id,
            environment, operation_id, scope_revision, token_hash, request_hash, receipt_json, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(scope.source_instance, event.event_id, scope.project_id, scope.environment, event.operation_id,
                scope.scope_revision, scope.tokenHash, requestHash, JSON.stringify(receipt), receivedAt));
        try {
            await db.batch(statements);
            return { receipt };
        } catch (error) {
            if (!isContended(error)) throw error;
        }
    }
    throw new AutomationError('inspection_busy', 503, '巡檢關聯正在更新，請重試原事件。');
}

export async function pendingInspectionLinks(db: D1Database, scope: InspectionScope, limit: number) {
    const { results } = await db.prepare(`SELECT DISTINCT ${LINK_COLUMNS} FROM automation_inspection_runs r
        WHERE project_id=?1 AND environment=?2 AND source_instance=?3 AND report_public_id IS NOT NULL AND linked_at IS NULL
          AND ${LINK_TARGET}
        ORDER BY occurred_at, workspace_id, run_id, attempt_id, report_public_id LIMIT ?6`)
        .bind(...scopeBindings(scope), limit).all<InspectionLink>();
    return { links: results };
}

export async function acknowledgeInspectionLink(db: D1Database, scope: InspectionScope, link: InspectionLink) {
    const row = await db.prepare(`UPDATE automation_inspection_runs AS r SET linked_at=COALESCE(linked_at, ${SQL_NOW})
        WHERE project_id=?1 AND environment=?2 AND source_instance=?3 AND ${LINK_TARGET}
          AND workspace_id=?6 AND run_id=?7 AND attempt_id=?8 AND report_public_id=?9
        RETURNING ${LINK_COLUMNS}`).bind(...scopeBindings(scope), link.workspace_id, link.run_id, link.attempt_id, link.report_public_id)
        .first<InspectionLink>();
    if (!row) throw conflict();
    return { link: row };
}

export async function inspectionDetail(db: D1Database, scope: Scope, reportPublicId: string) {
    const group = await db.prepare(
        `SELECT workspace_id, test_id, check_key, failure_signature, previous_report_public_id, first_failed_at, last_failed_at, closed_at,
            (SELECT COUNT(*) FROM automation_inspection_runs r WHERE r.report_public_id=g.report_public_id) AS occurrence_count
         FROM automation_inspection_groups g WHERE project_id=? AND environment=? AND report_public_id=?`,
    ).bind(scope.project_id, scope.environment, reportPublicId).first<Record<string, unknown>>();
    if (!group) return null;
    const { results } = await db.prepare(`SELECT run_id, attempt_id, version_id, started_at, occurred_at, summary, evidence_json, linked_at
        FROM automation_inspection_runs WHERE report_public_id=? ORDER BY occurred_at DESC, run_id DESC LIMIT 50`)
        .bind(reportPublicId).all<{ evidence_json: string } & Record<string, unknown>>();
    return { ...group, runs: results.map(({ evidence_json, ...run }) => ({ ...run, evidence_refs: JSON.parse(evidence_json) as string[] })) };
}
