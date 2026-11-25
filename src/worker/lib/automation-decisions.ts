import {
    analysisDisposition, assessmentScore, canonicalProposalJson, hasRepairBasis, isSafeCustomerBody,
    redactAnalysisText, type Analysis, type RepairProposal as Proposal,
} from '../../shared/automation-analysis.mjs';
import { nowIso } from '../../shared/time';
import { config, type Env } from '../env';
import { ACTIVE_LEASE, AutomationError, SQL_NOW, WORK_INGRESS_ENABLED, assertion, canonicalJson, failedAutomationAssertion, leaseBindings, type AutomationScope, type Lease } from './automation';
import { sha256Hex, timingSafeEqualString } from './crypto';
import type { Developer, Report } from './models';
import { addMessageStatements, eventStatement, messageAuthorName } from './reports';

export const GIT_PUSH = 'git.push_branch';
export const GIT_MR = 'gitlab.create_merge_request';
export const GIT_LOCAL_BRANCH = 'git.local_branch';
const SCOPE_KEY = 'project_id = ? AND environment = ? AND scope_revision = ?';
type Scope = Pick<AutomationScope, 'project_id' | 'project_slug' | 'environment' | 'scope_revision'>;
type Data = Record<string, unknown>;

interface Work {
    work_id: string;
    ingress_kind: 'customer' | 'inspection';
    input_revision: number;
    report_revision: number;
    scope_revision: string;
    stage: string;
    next_action: 'analyze' | 'repair';
    decision_outcome: string | null;
    proposal_revision: number | null;
    revoked_reason: string | null;
    event_id: string;
}

interface Policy {
    auto_reply: number;
    gitlab_instance_id: string | null;
    gitlab_origin: string | null;
    gitlab_proof_key_ref: string | null;
}

type DeliveryMode = 'gitlab' | 'local';

interface Repository {
    repo_id: string;
    gitlab_project_id: number | null;
    delivery_mode: DeliveryMode;
    base_branch: string;
    base_commit: string;
    branch_prefix: string;
    required_check_ids: string;
}

interface Decision {
    decision_revision: number;
    report_revision: number;
    scope_revision: string;
    analysis_json: string;
    outcome: string;
    proposal_digest: string | null;
    delivery_mode: DeliveryMode | null;
}

export interface LocalBranchIntent {
    proposal_revision: number;
    proposal_digest: string;
    input_revision: number;
    repo_id: string;
    base_commit: string;
    source_branch: string;
    target_branch: string;
    head_sha: string;
    check_results: Array<{ check_id: string; status: 'passed' }>;
}
export interface GitIntent extends LocalBranchIntent {
    gitlab_instance_id: string;
    project_id: number;
}

export interface GitObservation extends GitIntent {
    mr_id: number;
    mr_iid: number;
    web_url: string;
    state: 'opened' | 'merged';
    observed_at: string;
}

const WORK_ROW = `SELECT w.*, e.event_id FROM automation_work w JOIN automation_events e ON e.cursor = w.event_cursor`;

function conflict(): AutomationError {
    return new AutomationError('decision_conflict', 409, '工單、工作租約或審查版本已變動。');
}

function scopeBindings(scope: Scope): [number, string, string] {
    return [scope.project_id, scope.environment, scope.scope_revision];
}

export { failedAutomationAssertion } from './automation';

async function policyFor(db: D1Database, scope: Scope) {
    return db.prepare(`SELECT * FROM automation_policies WHERE ${SCOPE_KEY}`).bind(...scopeBindings(scope)).first<Policy>();
}

async function repositoryFor(db: D1Database, scope: Scope, proposal: Proposal) {
    return db.prepare(`SELECT * FROM automation_repositories WHERE ${SCOPE_KEY} AND repo_id = ?`)
        .bind(...scopeBindings(scope), proposal.repo_id).first<Repository>();
}

function checkIdsMatch(repo: Repository, ids: string[]): boolean {
    const configured: unknown = JSON.parse(repo.required_check_ids);
    return Array.isArray(configured) && configured.every(id => typeof id === 'string')
        && JSON.stringify([...ids].sort()) === JSON.stringify(configured.sort());
}

function repoMatches(repo: Repository | null, proposal: Proposal): repo is Repository {
    return repo !== null && repo.base_commit === proposal.base_commit && checkIdsMatch(repo, proposal.required_check_ids);
}

async function activeWork(db: D1Database, scope: AutomationScope, lease: Lease) {
    const row = await db.prepare(`${WORK_ROW} WHERE ${ACTIVE_LEASE}`).bind(...leaseBindings(scope, lease)).first<Work>();
    if (!row) throw conflict();
    return row;
}

function readReport(db: D1Database, projectId: number, publicId: string) {
    return db.prepare('SELECT * FROM reports WHERE project_id = ? AND public_id = ?').bind(projectId, publicId);
}

function decisionFor(db: D1Database, work: Work) {
    return db.prepare('SELECT * FROM automation_decisions WHERE work_id = ? AND decision_revision = ?')
        .bind(work.work_id, work.proposal_revision).first<Decision>();
}

async function repairGrant(db: D1Database, scope: Scope, work: Work) {
    if (work.next_action !== 'repair' || work.decision_outcome !== 'repair_authorized') return null;
    const decision = await decisionFor(db, work);
    if (!decision?.proposal_digest || decision.report_revision !== work.report_revision || decision.scope_revision !== work.scope_revision) return null;
    const analysis = JSON.parse(decision.analysis_json) as Analysis;
    const proposal = analysis.proposal;
    if (!proposal || !hasRepairBasis(analysis)) return null;
    const repo = await repositoryFor(db, scope, proposal);
    if (!repoMatches(repo, proposal) || decision.delivery_mode !== repo.delivery_mode) return null;
    const approval = decision.outcome === 'repair_authorized' ? null : await db.prepare(
        "SELECT approval_id FROM automation_reviews WHERE work_id = ? AND decision_revision = ? AND action = 'approve'",
    ).bind(work.work_id, decision.decision_revision).first<{ approval_id: string }>();
    if (decision.outcome !== 'repair_authorized' && !approval) return null;
    return {
        kind: approval ? 'team_approved' : 'automatic',
        ...(approval ? { approval_id: approval.approval_id } : {}),
        proposal_revision: decision.decision_revision,
        proposal_digest: decision.proposal_digest,
        input_revision: work.input_revision,
        scope_revision: work.scope_revision,
        proposal,
        repo_id: proposal.repo_id,
        delivery_mode: decision.delivery_mode,
        base_branch: repo.base_branch,
        base_commit: proposal.base_commit,
        required_check_ids: proposal.required_check_ids,
        acceptance_criteria: analysis.criteria,
        verification: proposal.verification,
    };
}

export async function automationInput(db: D1Database, scope: AutomationScope, lease: Lease) {
    const bindings = leaseBindings(scope, lease);
    const guard = `EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE})`;
    const [workRows, reportRows, messages, attachments, reviews, inspection] = await db.batch([
        db.prepare(`${WORK_ROW} WHERE ${ACTIVE_LEASE}`).bind(...bindings),
        db.prepare(`SELECT public_id, title, description, status FROM reports WHERE project_id = ?1 AND public_id = ?6 AND ${guard}`).bind(...bindings),
        db.prepare(`SELECT m.id AS message_id, CASE WHEN author_type = 'reporter' THEN 'customer' ELSE 'team' END AS side,
            substr(body,1,3000) AS body, m.created_at FROM messages m JOIN reports r ON r.id = m.report_id
            WHERE r.project_id = ?1 AND r.public_id = ?6 AND m.deleted_at IS NULL AND ${guard} ORDER BY m.id DESC LIMIT 20`).bind(...bindings),
        db.prepare(`SELECT a.id AS attachment_id, a.message_id, a.mime_type, a.size
            FROM attachments a JOIN reports r ON r.id = a.report_id LEFT JOIN messages m ON m.id = a.message_id
            WHERE r.project_id = ?1 AND r.public_id = ?6 AND a.kind = 'feedback'
                AND (a.message_id IS NULL OR (m.id IS NOT NULL AND m.deleted_at IS NULL)) AND ${guard} ORDER BY a.id DESC LIMIT 20`).bind(...bindings),
        db.prepare(`SELECT rt.evidence_json FROM automation_reviews rt WHERE work_id = ?5 AND evidence_json IS NOT NULL
            AND ${guard} ORDER BY created_at DESC LIMIT 20`).bind(...bindings),
        db.prepare(`SELECT summary FROM automation_inspection_runs WHERE project_id=?1 AND environment=?2 AND report_public_id=?6
            AND ${guard} ORDER BY occurred_at DESC, run_id DESC LIMIT 1`).bind(...bindings),
    ]);
    const work = workRows.results[0] as Work | undefined;
    const report = reportRows.results[0] as Pick<Report, 'public_id' | 'title' | 'description' | 'status'> | undefined;
    const observation = inspection.results[0] as { summary: string } | undefined;
    if (!work || !report) throw conflict();
    const repair = work.next_action === 'repair' ? await repairGrant(db, scope, work) : null;
    // The extra policy reads for a repair grant may race a report edit or takeover.
    if (work.next_action === 'repair') {
        if (!repair) throw conflict();
        await activeWork(db, scope, lease);
    }
    return {
        work: {
            ...lease, input_revision: work.input_revision, next_action: work.next_action, event_id: work.event_id,
            decision_revision: work.proposal_revision ?? 0,
        },
        report: {
            ...report,
            ...(work.ingress_kind === 'inspection' && observation
                ? { description: report.description + '\n\n' + observation.summary } : {}),
            messages: messages.results.reverse(),
            attachment_refs: attachments.results,
            evidence_refs: [...new Set((reviews.results as { evidence_json: string }[]).flatMap((r) => JSON.parse(r.evidence_json) as string[]))],
        },
        ...(repair ? { repair_authorization: repair } : {}),
    };
}

interface Command {
    operation_id: string;
    work_id: string;
}

async function executeCommand(
    db: D1Database, scope: Scope, command: Command, semantic: Data, build: () => Promise<D1PreparedStatement[]>,
) {
    const hash = await sha256Hex(canonicalJson(semantic));
    async function recorded() {
        const row = await db.prepare(
            'SELECT request_hash, receipt_json FROM automation_commands WHERE project_id = ? AND environment = ? AND operation_id = ?',
        ).bind(scope.project_id, scope.environment, command.operation_id).first<{ request_hash: string; receipt_json: string }>();
        if (row && row.request_hash !== hash) throw conflict();
        return row ? { receipt: JSON.parse(row.receipt_json) as Data } : null;
    }
    const prior = await recorded();
    if (prior) return prior;
    try {
        const effects = await build();
        await db.batch([
            ...effects.slice(0, 1),
            db.prepare('INSERT INTO automation_commands (project_id, environment, operation_id, work_id, request_hash) VALUES (?, ?, ?, ?, ?)')
                .bind(scope.project_id, scope.environment, command.operation_id, command.work_id, hash),
            ...effects.slice(1),
        ]);
    } catch (error) {
        const recovered = await recorded();
        if (recovered) return recovered;
        if (failedAutomationAssertion(error)) throw conflict();
        throw error;
    }
    const result = await recorded();
    if (!result) throw new Error('automation command produced no receipt');
    return result;
}

function releaseWork(db: D1Database, workId: string, outcome: string, stage: string, next: string, reportId: number, revision: number | null) {
    const work = db.prepare(
        `UPDATE automation_work SET stage = ?, next_action = ?, decision_outcome = ?, proposal_revision = ?,
            report_revision = (SELECT report_revision FROM reports WHERE id = ?),
            worker_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, retry_at = NULL, progress_json = NULL, updated_at = ${SQL_NOW}
         WHERE work_id = ?`,
    ).bind(stage, next, outcome, revision, reportId, workId);
    const attempt = db.prepare(`UPDATE automation_work_attempts SET outcome = ?
        WHERE work_id = ? AND lease_generation = (SELECT lease_generation FROM automation_work WHERE work_id = ?)`).bind(outcome, workId, workId);
    return [work, attempt];
}

function saveCommandReceipt(
    db: D1Database, scope: Scope, command: Command, extras: Data, ids: { message?: number; draft?: number } = {},
) {
    return db.prepare(
        `UPDATE automation_commands SET receipt_json = (
            SELECT json_patch(json_object(
                'operation_id', ?1, 'work_id', w.work_id, 'input_revision', w.input_revision, 'applied_report_revision', w.report_revision,
                'stage', CASE WHEN w.decision_outcome IN ('mr_opened','mr_merged') THEN
                    CASE w.decision_outcome WHEN 'mr_opened' THEN 'waiting_mr_review' ELSE 'waiting_deployment' END ELSE w.stage END,
                'next_action', CASE WHEN w.stage = 'queued' THEN w.next_action END,
                'outcome', w.decision_outcome
            ), json_patch(?2, CASE WHEN ?3 IS NOT NULL THEN json_object('message_id', (SELECT MAX(id) FROM messages WHERE report_id = ?3))
                WHEN ?4 IS NOT NULL THEN json_object('draft_id', (SELECT MAX(id) FROM message_drafts WHERE report_id = ?4)) ELSE '{}' END))
            FROM automation_work w WHERE w.work_id = automation_commands.work_id
        ) WHERE project_id = ?5 AND environment = ?6 AND operation_id = ?1`,
    ).bind(command.operation_id, JSON.stringify(extras), ids.message ?? null, ids.draft ?? null, scope.project_id, scope.environment);
}

function workSemantic(lease: Lease, inputRevision: number) {
    return {
        work_id: lease.work_id, report_public_id: lease.report_public_id,
        report_revision: lease.report_revision, scope_revision: lease.scope_revision, input_revision: inputRevision,
    };
}

export async function applyAutomationDecision(env: Env, scope: AutomationScope, lease: Lease, command: Command & {
    input_revision: number;
    correlation_id: string;
    analysis: Analysis;
}) {
    const { DB: db } = env;
    const analysis = command.analysis;
    return executeCommand(db, scope, command, { kind: 'decision', ...workSemantic(lease, command.input_revision), correlation_id: command.correlation_id, analysis },
        async () => {
            const work = await activeWork(db, scope, lease);
            if (work.input_revision !== command.input_revision || work.next_action !== 'analyze') throw conflict();
            const report = await readReport(db, scope.project_id, lease.report_public_id).first<Report>();
            if (!report) throw conflict();
            const policy = await policyFor(db, scope);
            const disposition = analysisDisposition(analysis);
            const proposal = analysis.proposal;
            const repo = proposal ? await repositoryFor(db, scope, proposal) : null;
            const knownRepo = proposal !== undefined && repoMatches(repo, proposal);
            const digest = proposal ? await sha256Hex(canonicalProposalJson(proposal)) : null;
            const revision = (work.proposal_revision ?? 0) + 1;
            const customerBody = analysis.customer_body?.trim();
            const isCustomerResponse = disposition.kind === 'reply' || disposition.kind === 'request_information';
            const safe = isSafeCustomerBody(customerBody);
            let outcome = 'blocked';
            let stage = 'blocked';
            let next = 'analyze';
            const reason = disposition.kind === 'repair' && !knownRepo ? 'repo_not_approved' : disposition.reason;
            const followUp = reason === 'repo_not_approved' ? '請由團隊核對程式庫、基底版本與必要檢查的授權。'
                : reason === 'score_below_threshold' || reason === 'evidence_missing' ? '請由團隊補正證據後要求重新分析。'
                : reason === 'business_decision' ? '請由團隊確認業務需求與驗收條件。' : null;
            if (isCustomerResponse) {
                outcome = 'business_review';
                if (work.ingress_kind === 'customer' && safe) {
                    outcome = policy?.auto_reply === 1
                        ? disposition.kind === 'reply' ? 'reply_sent' : 'needs_input_sent'
                        : 'draft_created';
                }
                stage = outcome === 'reply_sent' || outcome === 'needs_input_sent' ? 'waiting_customer' : 'waiting_review';
            } else if (disposition.kind === 'repair' && knownRepo) {
                outcome = 'repair_authorized';
                stage = 'queued';
                next = 'repair';
            } else if (disposition.kind === 'waiting_review') {
                outcome = proposal && !disposition.reason ? 'review_required' : 'business_review';
                stage = 'waiting_review';
            }
            const at = nowIso();
            const actor = { name: config(env).sharedOwnerName, developerId: null, clientAccountId: null, agent: 'Airedale' };
            const effects: D1PreparedStatement[] = [
                assertion(db, `EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE} AND w.input_revision = ?10
                    AND w.next_action = 'analyze' AND w.proposal_revision IS ?11)
                    AND COALESCE((SELECT auto_reply FROM automation_policies WHERE project_id=?1 AND environment=?2 AND scope_revision=?3), 0) = ?12
                    ${next === 'repair' ? `AND EXISTS (SELECT 1 FROM automation_repositories a
                        WHERE a.project_id=?1 AND a.environment=?2 AND a.scope_revision=?3
                        AND a.repo_id=?13 AND a.base_commit=?14 AND a.required_check_ids=?15 AND a.delivery_mode=?16)` : ''}`,
                    [...leaseBindings(scope, lease), command.input_revision, work.proposal_revision, policy?.auto_reply ?? 0,
                        ...(next === 'repair' && repo ? [repo.repo_id, repo.base_commit, repo.required_check_ids, repo.delivery_mode] : [])]),
            ];
            const ids: { message?: number; draft?: number } = {};
            if (stage === 'waiting_customer' && customerBody) {
                effects.push(...addMessageStatements(db, report, {
                    author_type: 'owner', author_name: messageAuthorName(env, report, true, null), body: customerBody, uploads: [], author: actor,
                }, at).statements);
                ids.message = report.id;
            } else if (outcome === 'draft_created' && customerBody) {
                effects.push(
                    db.prepare(`INSERT INTO message_drafts (report_id, author_name, author_agent, body, created_at, updated_at)
                        VALUES (?,?,?,?,?,?)`).bind(report.id, actor.name, actor.agent, customerBody, at, at),
                    db.prepare(`INSERT INTO automation_drafts (draft_id, work_id, report_revision, scope_revision)
                        VALUES ((SELECT MAX(id) FROM message_drafts WHERE report_id = ?),?,?,?)`)
                        .bind(report.id, work.work_id, lease.report_revision, lease.scope_revision),
                    eventStatement(db, report, 'draft', actor, at),
                );
                ids.draft = report.id;
            }
            const { customer_body: _customerBody, ...internal } = analysis;
            effects.push(
                db.prepare(`INSERT INTO automation_decisions
                    (work_id, decision_revision, report_revision, scope_revision, analysis_json, outcome, proposal_digest, created_at, delivery_mode)
                    VALUES (?,?,?,?,?,?,?,?,?)`).bind(work.work_id, revision, lease.report_revision, lease.scope_revision,
                        JSON.stringify(internal), outcome, digest, at, repo?.delivery_mode ?? null),
                db.prepare(`INSERT INTO handoff_notes (report_id, author_name, agent, body, created_at) VALUES (?,?,?,?,?)`)
                    .bind(report.id, actor.name, actor.agent,
                        [redactAnalysisText(analysis.summary), followUp, ...analysis.missing_requirements.map(redactAnalysisText)].filter(Boolean).join('\n').slice(0, 5000), at),
                ...releaseWork(db, work.work_id, outcome, stage, next, report.id, revision),
                saveCommandReceipt(db, scope, command, {
                    score: assessmentScore(analysis),
                    decision_revision: revision,
                    ...(reason ? { reason } : {}),
                    ...(digest ? { proposal_revision: revision, proposal_digest: digest } : {}),
                }, ids),
            );
            return effects;
        });
}

interface TeamScope extends Scope {
    enabled: number;
}

export async function automationTeamScope(db: D1Database, slug: string, environment: string, developer: Developer): Promise<TeamScope | null> {
    return db.prepare(`SELECT s.*, p.slug AS project_slug
        FROM automation_scopes s JOIN projects p ON p.id = s.project_id
        JOIN automation_reviewers ar ON ar.project_id = s.project_id AND ar.environment = s.environment
        JOIN developers d ON d.id = ar.developer_id
        WHERE p.slug = ? AND s.environment = ? AND d.id = ? AND d.disabled_at IS NULL`)
        .bind(slug, environment, developer.id).first<TeamScope>();
}

const REVIEWER = `EXISTS (
    SELECT 1 FROM automation_reviewers ar JOIN developers d ON d.id = ar.developer_id
    JOIN automation_scopes s ON s.project_id = ar.project_id AND s.environment = ar.environment
    WHERE ar.project_id = ?1 AND ar.environment = ?2 AND s.scope_revision = ?3
        AND s.enabled = 1 AND d.id = ?4 AND d.disabled_at IS NULL
)`;

export async function automationReviewState(db: D1Database, scope: TeamScope, publicId: string, workId?: string) {
    const report = await readReport(db, scope.project_id, publicId).first<{ report_revision: number }>();
    if (!report) return null;
    const work = await db.prepare(`${WORK_ROW} WHERE w.project_id=? AND w.environment=? AND w.report_public_id=?
        AND (?4 IS NULL OR w.work_id=?4) ORDER BY w.event_cursor DESC LIMIT 1`)
        .bind(scope.project_id, scope.environment, publicId, workId ?? null).first<Work>();
    if (!work) return { report_public_id: publicId, report_revision: report.report_revision, scope_revision: scope.scope_revision, work: null };
    const [decision, reviews, mr, localBranch] = await Promise.all([
        decisionFor(db, work),
        db.prepare(`SELECT approval_id, action, decision_revision, developer_name, report_revision, scope_revision, evidence_json, reason, created_at
             FROM automation_reviews WHERE work_id=? ORDER BY created_at, rowid LIMIT 50`).bind(work.work_id).all(),
        db.prepare('SELECT observation_json FROM automation_mr_links WHERE work_id=?').bind(work.work_id).first<string>('observation_json'),
        db.prepare('SELECT operation_id, observation_json, recorded_at FROM automation_local_branches WHERE work_id=? ORDER BY decision_revision DESC LIMIT 1')
            .bind(work.work_id).first<{ operation_id: string; observation_json: string; recorded_at: string }>(),
    ]);
    const { decision_outcome, ...workFields } = work;
    // Explicit projection keeps the worker credential hash out of human APIs.
    return {
        report_public_id: publicId,
        report_revision: report.report_revision,
        scope_revision: scope.scope_revision,
        work: {
            work_id: workFields.work_id, scope_revision: workFields.scope_revision, input_revision: workFields.input_revision,
            report_revision: workFields.report_revision, next_action: decision_outcome === 'local_branch_ready' ? null : workFields.next_action,
            stage: decision_outcome === 'mr_opened' ? 'waiting_mr_review' : decision_outcome === 'mr_merged' ? 'waiting_deployment' : workFields.stage,
            outcome: decision_outcome,
            revoked_reason: work.revoked_reason,
        },
        decision: decision && {
            decision_revision: decision.decision_revision, report_revision: decision.report_revision, scope_revision: decision.scope_revision,
            proposal_revision: decision.proposal_digest ? decision.decision_revision : null, proposal_digest: decision.proposal_digest,
            analysis: JSON.parse(decision.analysis_json) as Analysis, outcome: decision.outcome, delivery_mode: decision.delivery_mode,
        },
        reviews: reviews.results.map(({ evidence_json, ...review }) => ({
            ...review, evidence_refs: evidence_json === null ? [] : JSON.parse(String(evidence_json)) as string[],
        })),
        mr: mr ? JSON.parse(mr) as GitObservation : null,
        local_branch: localBranch ? {
            ...JSON.parse(localBranch.observation_json) as LocalBranchIntent,
            operation_id: localBranch.operation_id,
            recorded_at: localBranch.recorded_at,
        } : null,
    };
}

export interface TeamReviewInput {
    action_id: string;
    work_id: string;
    input_revision: number;
    report_revision: number;
    scope_revision: string;
    decision_revision: number;
    action: 'approve' | 'request_changes' | 'provide_evidence';
    proposal_digest?: string;
    evidence_refs?: string[];
    reason?: string;
}

export async function reviewAutomationDecision(db: D1Database, scope: TeamScope, developer: Developer, publicId: string, input: TeamReviewInput) {
    const command = { operation_id: input.action_id, work_id: input.work_id };
    return executeCommand(db, scope, command, { kind: 'review', publicId, reviewer_id: developer.id, ...input }, async () => {
        if (input.scope_revision !== scope.scope_revision) throw conflict();
        const work = await db.prepare(`${WORK_ROW} WHERE w.work_id=? AND w.project_id=? AND w.environment=? AND w.report_public_id=?`)
            .bind(input.work_id, scope.project_id, scope.environment, publicId).first<Work>();
        const report = await readReport(db, scope.project_id, publicId).first<Report>();
        if (!work || !report) throw conflict();
        const decision = await decisionFor(db, work);
        if (!decision || decision.decision_revision !== input.decision_revision) throw conflict();
        const approve = input.action === 'approve';
        const repo = approve ? await repositoryForApproval(db, scope, work, decision, input) : null;
        const rebase = input.action !== 'approve' && work.scope_revision !== scope.scope_revision;
        const approvalId = crypto.randomUUID();
        const stage = approve ? "'waiting_review'" : "'waiting_review','blocked'";
        const guard = assertion(db, `${REVIEWER} AND EXISTS (
            SELECT 1 FROM automation_work w JOIN reports r ON r.public_id=w.report_public_id AND r.project_id=w.project_id
            JOIN automation_scopes s ON s.project_id=w.project_id AND s.environment=w.environment
            WHERE ${WORK_INGRESS_ENABLED} AND w.project_id=?1 AND w.environment=?2 AND w.work_id=?5 AND w.report_public_id=?6 AND w.input_revision=?7
              AND w.proposal_revision=?8 AND r.report_revision=?9 AND r.status<>'completed' AND r.client_deleted_at IS NULL
              AND r.automation_manual_takeover=0 AND r.claimed_by_developer_id IS NULL AND w.stage IN (${stage})
              AND w.lease_expires_at IS NULL AND ((w.scope_revision=?3 AND w.revoked_reason IS NULL)
                OR (?10=1 AND w.revoked_reason='scope_changed'))
              AND NOT EXISTS (SELECT 1 FROM automation_work newer WHERE newer.report_public_id=w.report_public_id AND newer.event_cursor>w.event_cursor)
              ${approve ? "AND w.decision_outcome='review_required' AND w.report_revision=r.report_revision" : ''}
        ) ${repo ? `AND EXISTS (SELECT 1 FROM automation_repositories a WHERE a.project_id=?1 AND a.environment=?2 AND a.scope_revision=?3
                      AND a.repo_id=?11 AND a.base_commit=?12 AND a.required_check_ids=?13 AND a.delivery_mode=?14)` : ''}`,
        [...scopeBindings(scope), developer.id, work.work_id, publicId, input.input_revision, input.decision_revision, input.report_revision,
            Number(rebase), ...(repo ? [repo.repo_id, repo.base_commit, repo.required_check_ids, repo.delivery_mode] : [])]);
        const outcome = approve ? 'repair_authorized' : 'analysis_requested';
        return [
            guard,
            db.prepare(`INSERT INTO automation_reviews
                (approval_id, work_id, decision_revision, developer_id, developer_name, action, report_revision, scope_revision, evidence_json, reason, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,${SQL_NOW})`).bind(approvalId, work.work_id, input.decision_revision, developer.id, developer.name,
                input.action, input.report_revision, input.scope_revision, input.evidence_refs ? JSON.stringify(input.evidence_refs) : null,
                input.reason ? redactAnalysisText(input.reason) : null),
            db.prepare(`UPDATE automation_work SET stage='queued', next_action=?, decision_outcome=?, revoked_reason=NULL,
                scope_revision=?, report_revision=?, retry_at=NULL, progress_json=NULL, updated_at=${SQL_NOW} WHERE work_id=?`)
                .bind(approve ? 'repair' : 'analyze', outcome, scope.scope_revision, input.report_revision, work.work_id),
            saveCommandReceipt(db, scope, command, { approval_id: approvalId }),
        ];
    });
}

async function repositoryForApproval(db: D1Database, scope: Scope, work: Work, decision: Decision, input: TeamReviewInput) {
    if (decision.outcome !== 'review_required' || decision.report_revision !== input.report_revision
        || decision.scope_revision !== input.scope_revision || !decision.proposal_digest || decision.proposal_digest !== input.proposal_digest
        || work.scope_revision !== scope.scope_revision) throw conflict();
    const analysis = JSON.parse(decision.analysis_json) as Analysis;
    const proposal = analysis.proposal;
    if (!proposal || !hasRepairBasis(analysis)) throw conflict();
    const repo = await repositoryFor(db, scope, proposal);
    if (!repoMatches(repo, proposal) || decision.delivery_mode !== repo.delivery_mode) throw conflict();
    return repo;
}

async function repairTarget(
    db: D1Database, scope: AutomationScope, lease: Lease, mode: DeliveryMode, payload: LocalBranchIntent,
) {
    const work = await activeWork(db, scope, lease);
    const grant = await repairGrant(db, scope, work);
    if (!grant || grant.delivery_mode !== mode || payload.input_revision !== work.input_revision
        || payload.proposal_revision !== grant.proposal_revision || payload.proposal_digest !== grant.proposal_digest
        || payload.repo_id !== grant.repo_id || payload.base_commit !== grant.base_commit
        || payload.target_branch !== grant.base_branch || payload.head_sha === payload.base_commit) throw conflict();
    const repo = await repositoryFor(db, scope, grant.proposal);
    if (!repoMatches(repo, grant.proposal) || repo.delivery_mode !== mode || payload.target_branch !== repo.base_branch
        || !payload.source_branch.startsWith(repo.branch_prefix) || payload.source_branch === repo.branch_prefix || payload.source_branch === payload.target_branch
        || !checkIdsMatch(repo, payload.check_results.map(({ check_id }) => check_id))) throw conflict();
    return {
        repo,
        sql: `AND w.input_revision=?14 AND w.proposal_revision=?15 AND w.next_action='repair' AND w.decision_outcome='repair_authorized'
            AND EXISTS (
                SELECT 1 FROM automation_repositories a JOIN automation_decisions d ON d.work_id=w.work_id AND d.decision_revision=w.proposal_revision
                WHERE a.project_id=?1 AND a.environment=?2 AND a.scope_revision=?3 AND a.repo_id=?16 AND a.gitlab_project_id IS ?17
                    AND a.base_branch=?18 AND a.base_commit=?19 AND a.branch_prefix=?20 AND a.required_check_ids=?21
                    AND a.delivery_mode='${mode}' AND a.delivery_mode=d.delivery_mode
            )`,
        values: [payload.input_revision, payload.proposal_revision, repo.repo_id, repo.gitlab_project_id,
            repo.base_branch, repo.base_commit, repo.branch_prefix, repo.required_check_ids],
    };
}

export async function typedGitGuard(
    db: D1Database, scope: AutomationScope, lease: Lease, operationType: string, payload: GitIntent,
) {
    const target = await repairTarget(db, scope, lease, 'gitlab', payload);
    const policy = await policyFor(db, scope);
    if (!policy || policy.gitlab_instance_id !== payload.gitlab_instance_id || target.repo.gitlab_project_id !== payload.project_id) throw conflict();
    const payloadHash = await sha256Hex(canonicalJson({ ...payload }));
    return {
        payloadHash,
        policy,
        guard: {
            sql: `${target.sql}
                AND EXISTS (SELECT 1 FROM automation_policies p WHERE p.project_id=?1 AND p.environment=?2 AND p.scope_revision=?3 AND p.gitlab_instance_id=?22)
                ${operationType === GIT_MR ? `AND EXISTS (SELECT 1 FROM automation_operations push WHERE push.project_id=?1 AND push.environment=?2
                    AND push.work_id=?5 AND push.report_revision=?7 AND push.operation_type='git.push_branch'
                    AND push.payload_hash=?23 AND push.recorded_at IS NOT NULL)` : ''}`,
            values: [...target.values, payload.gitlab_instance_id, ...(operationType === GIT_MR ? [payloadHash] : [])],
        },
    };
}

export async function typedLocalBranchGuard(db: D1Database, scope: AutomationScope, lease: Lease, payload: LocalBranchIntent) {
    const { sql, values } = await repairTarget(db, scope, lease, 'local', payload);
    return { sql, values };
}

function gitProofMessage(scope: Scope, command: Command & { input_revision: number }, observation: GitObservation) {
    return canonicalJson({
        project_slug: scope.project_slug, environment: scope.environment, work_id: command.work_id, operation_id: command.operation_id,
        input_revision: command.input_revision, scope_revision: scope.scope_revision, proposal_revision: observation.proposal_revision,
        proposal_digest: observation.proposal_digest, observation,
    });
}

async function verifiedObservation(env: Env, policy: Policy, scope: Scope, command: Command & { input_revision: number }, observation: GitObservation, proof: string) {
    const ref = policy.gitlab_proof_key_ref;
    const key = ref && /^FEEDBACK_AUTOMATION_[A-Z0-9_]+$/.test(ref) ? env[ref] : null;
    let url: URL;
    try {
        url = new URL(observation.web_url);
    } catch {
        throw conflict();
    }
    if (typeof key !== 'string' || key.length < 32 || url.protocol !== 'https:' || url.origin !== policy.gitlab_origin
        || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/-/merge_requests/${observation.mr_iid}`)) throw conflict();
    const encoder = new TextEncoder();
    const signingKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const result = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(gitProofMessage(scope, command, observation)));
    const expected = Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!timingSafeEqualString(expected, proof)) throw conflict();
}

export async function linkAutomationMr(env: Env, scope: AutomationScope, lease: Lease, command: Command & {
    input_revision: number;
    proposal_revision: number;
    proposal_digest: string;
    observation: GitObservation;
    proof: string;
}) {
    const { DB: db } = env;
    const { mr_id, mr_iid, web_url, state, observed_at: _observedAt, ...payload } = command.observation;
    if (command.input_revision !== payload.input_revision || command.proposal_revision !== payload.proposal_revision || command.proposal_digest !== payload.proposal_digest) {
        throw conflict();
    }
    return executeCommand(db, scope, command, { kind: 'mr', ...workSemantic(lease, command.input_revision), observation: command.observation },
        async () => {
            const { payloadHash, policy, guard } = await typedGitGuard(db, scope, lease, GIT_MR, payload);
            await verifiedObservation(env, policy, scope, command, command.observation, command.proof);
            const report = await readReport(db, scope.project_id, lease.report_public_id).first<Report>();
            if (!report) throw conflict();
            const result = canonicalJson({ mr_id, mr_iid, web_url, state, head_sha: payload.head_sha });
            const resultHash = await sha256Hex(result);
            const outcome = state === 'merged' ? 'mr_merged' : 'mr_opened';
            return [
                assertion(db, `EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE} ${guard.sql})
                    AND EXISTS (SELECT 1 FROM automation_operations o WHERE o.project_id=?1 AND o.environment=?2 AND o.work_id=?5
                        AND o.report_revision=?7 AND o.operation_id=?10 AND o.operation_type='gitlab.create_merge_request'
                        AND o.payload_hash=?11 AND o.recorded_at IS NULL)
                    AND EXISTS (SELECT 1 FROM automation_policies p WHERE p.project_id=?1 AND p.environment=?2 AND p.scope_revision=?3
                        AND p.gitlab_origin=?12 AND p.gitlab_proof_key_ref=?13)
                    AND NOT EXISTS (SELECT 1 FROM automation_mr_links WHERE gitlab_instance_id=?22 AND gitlab_project_id=?17 AND mr_iid=?24)`,
                    [...leaseBindings(scope, lease), command.operation_id, payloadHash, policy.gitlab_origin, policy.gitlab_proof_key_ref,
                        ...guard.values, mr_iid]),
                db.prepare(`INSERT INTO automation_mr_links (work_id, decision_revision, operation_id, gitlab_instance_id, gitlab_project_id, mr_iid, observation_json)
                    VALUES (?,?,?,?,?,?,?)`).bind(command.work_id, command.proposal_revision, command.operation_id,
                    payload.gitlab_instance_id, payload.project_id, mr_iid, JSON.stringify(command.observation)),
                db.prepare(`UPDATE automation_operations SET result_json=?, result_hash=?, recorded_at=${SQL_NOW}, recorded_by=?, recorded_generation=?
                    WHERE project_id=? AND environment=? AND operation_id=?`).bind(result, resultHash, lease.worker_id, lease.lease_generation,
                    scope.project_id, scope.environment, command.operation_id),
                ...releaseWork(db, command.work_id, outcome, 'waiting_review', 'repair', report.id, command.proposal_revision),
                saveCommandReceipt(db, scope, command, { mr_id, mr_iid, web_url }),
            ];
        });
}

export async function recordLocalBranch(db: D1Database, scope: AutomationScope, lease: Lease, command: Command & {
    observation: LocalBranchIntent;
}) {
    const { observation } = command;
    return executeCommand(db, scope, command, { kind: 'local_branch', ...workSemantic(lease, observation.input_revision), observation },
        async () => {
            const guard = await typedLocalBranchGuard(db, scope, lease, observation);
            const report = await readReport(db, scope.project_id, lease.report_public_id).first<Report>();
            if (!report) throw conflict();
            const result = canonicalJson({ ...observation });
            const payloadHash = await sha256Hex(result);
            return [
                assertion(db, `EXISTS (SELECT 1 FROM automation_work w WHERE ${ACTIVE_LEASE} ${guard.sql})
                    AND EXISTS (SELECT 1 FROM automation_operations o WHERE o.project_id=?1 AND o.environment=?2 AND o.work_id=?5
                        AND o.report_revision=?7 AND o.operation_id=?10 AND o.operation_type='git.local_branch'
                        AND o.payload_hash=?11 AND o.recorded_at IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM automation_local_branches WHERE work_id=?5 AND decision_revision=?15)`,
                    [...leaseBindings(scope, lease), command.operation_id, payloadHash, null, null, ...guard.values]),
                db.prepare(`INSERT INTO automation_local_branches (work_id, decision_revision, operation_id, observation_json, recorded_at)
                    VALUES (?,?,?,?,${SQL_NOW})`).bind(command.work_id, observation.proposal_revision, command.operation_id, result),
                db.prepare(`UPDATE automation_operations SET result_json=?, result_hash=?, recorded_at=${SQL_NOW}, recorded_by=?, recorded_generation=?
                    WHERE project_id=? AND environment=? AND operation_id=?`).bind(result, payloadHash, lease.worker_id, lease.lease_generation,
                    scope.project_id, scope.environment, command.operation_id),
                ...releaseWork(db, command.work_id, 'local_branch_ready', 'waiting_review', 'repair', report.id, observation.proposal_revision),
                saveCommandReceipt(db, scope, command, {
                    repo_id: observation.repo_id, source_branch: observation.source_branch, target_branch: observation.target_branch, head_sha: observation.head_sha,
                }),
            ];
        });
}

export async function automationDraftSend(
    db: D1Database, report: Report, draft: { id: number; body: string; updated_at: string }, developerId: number | null,
) {
    const link = await db.prepare('SELECT work_id FROM automation_drafts WHERE draft_id=?').bind(draft.id).first<{ work_id: string }>();
    if (!link) {
        return { before: assertion(db, 'EXISTS (SELECT 1 FROM message_drafts WHERE id=? AND report_id=?)', [draft.id, report.id]) };
    }
    const before = assertion(db, `EXISTS (SELECT 1 FROM automation_drafts ad
        JOIN message_drafts md ON md.id=ad.draft_id JOIN automation_work w ON w.work_id=ad.work_id
        JOIN reports r ON r.id=md.report_id JOIN automation_scopes s ON s.project_id=w.project_id AND s.environment=w.environment
        JOIN automation_reviewers ar ON ar.project_id=s.project_id AND ar.environment=s.environment
        JOIN developers d ON d.id=ar.developer_id
        WHERE ad.draft_id=? AND r.id=? AND md.body=? AND md.updated_at=? AND d.id=? AND d.disabled_at IS NULL
          AND ad.report_revision=r.report_revision AND ad.scope_revision=s.scope_revision AND s.enabled=1 AND s.customer_ingress=1
          AND w.ingress_kind='customer' AND w.stage='waiting_review' AND w.decision_outcome='draft_created' AND w.revoked_reason IS NULL
          AND r.client_deleted_at IS NULL AND r.status<>'completed' AND r.automation_manual_takeover=0 AND r.claimed_by_developer_id IS NULL
    )`, [draft.id, report.id, draft.body, draft.updated_at, developerId]);
    const after = db.prepare(`UPDATE automation_work SET stage='waiting_customer', decision_outcome='draft_sent',
        report_revision=(SELECT report_revision FROM reports WHERE id=?), updated_at=${SQL_NOW} WHERE work_id=?`)
        .bind(report.id, link.work_id);
    return { before, after };
}
