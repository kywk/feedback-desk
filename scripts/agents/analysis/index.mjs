import {
    AnalysisError, CUSTOMER_REVIEW_MARKER, analysisDisposition, canonicalProposalJson,
    isSafeCustomerBody, parseAnalysis, redactAnalysisText,
} from '../../../src/shared/automation-analysis.mjs';
import { analysisCatalog, createEvidenceSession, digest, minimizeReport, supplementalReads } from './evidence.mjs';

function safeText(value) {
    return redactAnalysisText(value).trim() || '[已遮罩]';
}

function sanitizedAnalysis(analysis) {
    const result = {
        ...analysis, summary: safeText(analysis.summary), impact: safeText(analysis.impact),
        criteria: analysis.criteria.map(safeText),
        missing_requirements: analysis.missing_requirements.map(safeText),
        assessment: Object.fromEntries(Object.entries(analysis.assessment).map(([key, entry]) => [
            key, { ...entry, reason: safeText(entry.reason) },
        ])),
    };
    if (analysis.customer_body) {
        result.customer_body = isSafeCustomerBody(analysis.customer_body) ? analysis.customer_body.trim()
            : (CUSTOMER_REVIEW_MARKER + '\n' + safeText(analysis.customer_body)).slice(0, 1000);
    }
    if (analysis.proposal) {
        result.proposal = {
            ...analysis.proposal,
            verification: analysis.proposal.verification.map(safeText),
            pending_decisions: analysis.proposal.pending_decisions.map(safeText),
        };
    }
    return parseAnalysis(result);
}

function requireRepairScope(analysis, catalog) {
    if (analysisDisposition(analysis).kind !== 'repair') return;
    const proposal = analysis.proposal;
    const repo = catalog.repositories.find(candidate => candidate.id === proposal.repo_id);
    if (!repo || repo.base_commit !== proposal.base_commit ||
        !proposal.required_check_ids.every(id => repo.check_ids.includes(id)) ||
        !proposal.changes.every(change => repo.repair_paths.some(path =>
            change.path === path || change.path.startsWith(path + '/')))) {
        throw new AnalysisError('analysis_repair_scope_denied');
    }
}

function verifiedAuthorization(work, grant) {
    if (!grant || !['automatic', 'team_approved'].includes(grant.kind) ||
        grant.input_revision !== work.input_revision || grant.scope_revision !== work.scope_revision ||
        !Number.isSafeInteger(grant.proposal_revision) || grant.proposal_revision < 1 ||
        (grant.kind === 'team_approved' && !grant.approval_id) ||
        !grant.proposal || grant.proposal_digest !== digest(canonicalProposalJson(grant.proposal))) {
        throw new AnalysisError('repair_authorization_invalid');
    }
    return grant;
}

export function createAnalysisHandler({ configPath, auditPath, analyze, runRepair }) {
    return async function handleAnalysis({ work, progress, checkpoint, tools, queue, signal }) {
        const input = await queue.input(work, signal);
        const current = {
            ...work, input_revision: input.work.input_revision, decision_revision: input.work.decision_revision,
        };
        if (input.work.next_action === 'repair') {
            const repairAuthorization = verifiedAuthorization(current, input.repair_authorization);
            if (!runRepair) throw new AnalysisError('repair_handler_not_configured');
            return runRepair({ work: current, repairAuthorization, queue, signal, checkpoint });
        }
        if (!analyze) throw new AnalysisError('analysis_model_not_configured');
        const operationId = 'analysis:' + digest(JSON.stringify([
            current.work_id, current.scope_revision, current.input_revision, current.report_revision, current.decision_revision,
        ]));
        const catalog = await analysisCatalog(configPath, current);
        const pending = progress.pending_decision?.operation_id === operationId;
        let analysis;
        if (pending) {
            // This checkpoint was persisted after successful tools and before submitting the decision.
            analysis = parseAnalysis(progress.pending_decision.analysis);
        } else {
            catalog.supplemental_read_requests = supplementalReads(input.report.evidence_refs, catalog);
            const evidence = createEvidenceSession({ work: current, tools, auditPath, signal });
            try {
                await tools.validate?.();
                const result = await analyze({
                    report: minimizeReport(input.report), catalog, readEvidence: evidence.readEvidence, signal,
                    authorizeModelTransfer: tools.validate,
                });
                signal.throwIfAborted();
                const candidate = parseAnalysis(result);
                evidence.verify(candidate);
                analysis = sanitizedAnalysis(candidate);
            } finally {
                evidence.close();
            }
        }
        requireRepairScope(analysis, catalog);
        if (!pending) await checkpoint({ pending_decision: { operation_id: operationId, analysis } });
        return queue.decisions(current, {
            input_revision: current.input_revision, operation_id: operationId,
            correlation_id: current.correlation_id, analysis,
        }, signal);
    };
}
