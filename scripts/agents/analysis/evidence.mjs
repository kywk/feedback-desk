import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AnalysisError, redactAnalysisText } from '../../../src/shared/automation-analysis.mjs';
import { loadScope } from '../scope/policy.mjs';

const MAX_READS = 8;
const MAX_TEXT = 3000;
const QUERY_FIELDS = ['operation', 'index', 'template_id', 'service', 'from', 'to', 'limit'];
const MASK = '[已遮罩]';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export function digest(value) {
    return createHash('sha256').update(value).digest('hex');
}

export async function analysisCatalog(configPath, work) {
    const { scope } = await loadScope(configPath, work);
    return {
        repositories: scope.repositories.map(repo => ({
            id: repo.id,
            base_commit: repo.base_commit,
            read_paths: repo.read_paths.map(redactAnalysisText),
            repair_paths: Array.isArray(repo.repair?.allowed_paths)
                ? repo.repair.allowed_paths.filter(path => typeof path === 'string').map(redactAnalysisText)
                : [],
            check_ids: Array.isArray(repo.repair?.checks)
                ? repo.repair.checks.map(check => check?.id).filter(id => typeof id === 'string' && ID.test(id))
                : [],
        })),
        guides: scope.guides.map(guide => ({ id: guide.id, read_paths: guide.read_paths.map(redactAnalysisText) })),
        ...(scope.elk && {
            elk: {
                index: scope.elk.index,
                services: scope.elk.services,
                template_ids: scope.elk.queries.map(query => query.id),
                max_window_seconds: scope.elk.max_window_seconds,
                max_hits: Math.min(scope.elk.max_hits, 8),
            },
        }),
    };
}

export function supplementalReads(refs, catalog) {
    if (!Array.isArray(refs)) return [];
    return refs.slice(0, 12).flatMap(ref => {
        if (typeof ref !== 'string' || redactAnalysisText(ref) !== ref) return [];
        const match = /^(repo|guide):([A-Za-z0-9][A-Za-z0-9_./-]{0,127}):([^\\:\r\n]{1,300})$/u.exec(ref);
        if (!match) return [];
        const [, kind, id, path] = match;
        const source = (kind === 'repo' ? catalog.repositories : catalog.guides).find(item => item.id === id);
        if (path.startsWith('/') || path.split('/').some(part => !part || part.startsWith('.')) ||
            !source?.read_paths.some(allowed => path === allowed || path.startsWith(allowed + '/'))) return [];
        return kind === 'repo' ? [{ operation: 'read_repo_file', repo_id: id, path }]
            : [{ operation: 'read_local_guide', guide_id: id, path }];
    });
}

function boundedText(value, max) {
    return typeof value === 'string' ? redactAnalysisText(value).slice(0, max) : '';
}

export function minimizeReport(report) {
    const messages = Array.isArray(report.messages) ? report.messages : [];
    return {
        title: boundedText(report.title, 240),
        description: boundedText(report.description, 1200),
        messages: messages.slice(-6).map(message => ({
            speaker: message?.side === 'customer' ? 'customer' : 'team',
            body: boundedText(message?.body, 500),
        })),
        has_attachments: Array.isArray(report.attachment_refs) && report.attachment_refs.length > 0,
    };
}

function sourceRequest(value, id) {
    const keys = ['operation', id, 'path', 'start_line', 'line_count'];
    const start = value.start_line ?? 1;
    const count = value.line_count ?? 40;
    if (!Object.keys(value).every(key => keys.includes(key)) ||
        !Number.isSafeInteger(start) || start < 1 || start > 65_536 ||
        !Number.isSafeInteger(count) || count < 1 || count > 80) {
        throw new AnalysisError('analysis_invalid_tool_request');
    }
    return {
        request: { operation: value.operation, [id]: value[id], path: value.path },
        start, count,
    };
}

function evidenceRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new AnalysisError('analysis_invalid_tool_request');
    }
    switch (value.operation) {
        case 'read_repo_file':
            return sourceRequest(value, 'repo_id');
        case 'read_local_guide':
            return sourceRequest(value, 'guide_id');
        case 'query_elk':
            if (Object.keys(value).length !== QUERY_FIELDS.length || !QUERY_FIELDS.every(key => Object.hasOwn(value, key)) ||
                !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 8) {
                throw new AnalysisError('analysis_invalid_tool_request');
            }
            return { request: Object.fromEntries(QUERY_FIELDS.map(key => [key, value[key]])) };
        default:
            throw new AnalysisError('analysis_invalid_tool_request');
    }
}

function logExcerpt(rows) {
    const snippet = [];
    for (const row of rows) {
        const safe = Object.fromEntries(Object.entries(row)
            .filter(([field, value]) => /^[A-Za-z_@][A-Za-z0-9_.-]{0,127}$/.test(field) &&
                (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number'))
            .map(([field, value]) => [field, typeof value === 'string' ? boundedText(value, 240) : value]));
        if (JSON.stringify([...snippet, safe]).length > MAX_TEXT) break;
        snippet.push(safe);
    }
    return snippet;
}

async function appendEvidence(auditPath, record) {
    try {
        const handle = await open(auditPath, constants.O_APPEND | constants.O_WRONLY |
            constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) throw new Error();
            await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n');
        } finally {
            await handle.close();
        }
    } catch {
        throw new AnalysisError('analysis_evidence_audit_unavailable');
    }
}

export function createEvidenceSession({ work, tools, auditPath, signal }) {
    const observed = new Map();
    const identity = {
        work_id: work.work_id, correlation_id: work.correlation_id, report_revision: work.report_revision,
        input_revision: work.input_revision, decision_revision: work.decision_revision, lease_generation: work.lease_generation, actor: work.worker_id,
        project_slug: work.project_slug, environment: work.environment, scope_revision: work.scope_revision,
    };
    let reads = 0;
    let open = true;
    function ensureOpen() {
        signal.throwIfAborted();
        if (!open) throw new AnalysisError('analysis_evidence_closed');
    }
    return {
        async readEvidence(value) {
            ensureOpen();
            if (++reads > MAX_READS) throw new AnalysisError('analysis_evidence_limit');
            let details;
            try {
                details = evidenceRequest(value);
            } catch (error) {
                await appendEvidence(auditPath, {
                    ...identity, operation: 'analysis_evidence', decision: 'denied', reason: error.code,
                });
                throw error;
            }
            const { request, start, count } = details;
            const answer = await tools.execute(request);
            ensureOpen();

            const { operation } = request;
            let view;
            if (operation === 'query_elk') {
                const rows = logExcerpt(answer.rows);
                if (!rows.length) throw new AnalysisError('analysis_evidence_empty');
                view = { kind: 'elk', index: answer.index, template_id: answer.template_id, rows };
            } else {
                // Slice before the second pass of redaction so line numbers refer to the source.
                const content = boundedText(answer.content.split('\n').slice(start - 1, start + count - 1).join('\n'), MAX_TEXT);
                if (!content.trim()) throw new AnalysisError('analysis_evidence_empty');
                const source = operation === 'read_repo_file'
                    ? { kind: 'repo', repo_id: answer.repo_id, base_commit: answer.commit }
                    : { kind: 'guide', guide_id: answer.guide_id };
                view = { ...source, path: redactAnalysisText(request.path), start_line: start, content };
            }
            const contentDigest = digest(JSON.stringify(view));
            const target = operation === 'query_elk'
                ? { index: request.index, template_id: request.template_id, service: request.service, from: request.from, to: request.to, limit: request.limit }
                : { path: view.path, start_line: start, line_count: count,
                    ...(view.kind === 'repo' ? { repo_id: view.repo_id, commit: view.base_commit } : { guide_id: view.guide_id }) };
            const reference = 'ev:' + digest(JSON.stringify({ ...identity, operation, target, content_sha256: contentDigest }));
            await appendEvidence(auditPath, {
                ...identity, operation: 'analysis_evidence', source_operation: operation, decision: 'allowed',
                reference, target, content_sha256: contentDigest,
            });
            ensureOpen();
            observed.set(reference, view);
            return { reference, ...structuredClone(view) };
        },
        close() { open = false; },
        verify(analysis) {
            if (!analysis.evidence_refs.every(ref => observed.has(ref))) {
                throw new AnalysisError('analysis_unverified_evidence');
            }
            const proposal = analysis.proposal;
            if (!proposal) return;
            const references = analysis.evidence_refs.map(ref => observed.get(ref));
            for (const change of proposal.changes) {
                if ([change.path, change.before, change.after].some(part => part.includes(MASK) || part !== redactAnalysisText(part))) {
                    throw new AnalysisError('analysis_sensitive_proposal');
                }
                if (!references.some(view => view.kind === 'repo' && view.repo_id === proposal.repo_id &&
                    view.base_commit === proposal.base_commit && view.path === change.path &&
                    view.content.includes(change.before))) {
                    throw new AnalysisError('analysis_unverified_proposal');
                }
            }
        },
    };
}
