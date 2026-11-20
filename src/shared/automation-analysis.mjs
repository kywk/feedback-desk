export const ANALYSIS_CLASSIFICATIONS = Object.freeze(['explanation', 'needs_information', 'bug', 'change_request']);
export const ASSESSMENT_FACTORS = Object.freeze([
    'cause_or_requirement',
    'implementation',
    'impact',
    'scope_and_checks',
    'verification',
]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EVIDENCE_REF = /^ev:[0-9a-f]{64}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PRIVATE_PATH = /^(?:\.|id_(?:rsa|ed25519)|secrets?(?:[._-]|$)|credentials?(?:[._-]|$))|\.(?:pem|key|p12|pfx|keystore)$/i;
const NON_CUSTOMER_CONTENT = /(?:https?:\/\/|ssh:\/\/|\b(?:git|file):\/\/|\[[^\]\r\n]+\]\(|<\/?[A-Za-z]|\x60\x60\x60|\bev:[0-9a-f]{64}\b|\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b|\b\S+\.git\b)/iu;
const MASK = '[已遮罩]';
const MAX_ANALYSIS_BYTES = 10_240;

export class AnalysisError extends Error {
    constructor(code, field) {
        super(code);
        this.name = 'AnalysisError';
        this.code = code;
        if (field !== undefined) this.field = field;
    }
}

function requireAnalysis(condition, field) {
    if (!condition) throw new AnalysisError('invalid_analysis', field);
}

function record(value) {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function keys(value, required, optional = []) {
    return record(value) && required.every(key => Object.hasOwn(value, key)) &&
        Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function text(value, max, allowEmpty = false) {
    return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) && !CONTROL.test(value);
}

function strings(values, count, size) {
    return Array.isArray(values) && values.length <= count && values.every(value => text(value, size));
}

function identifiers(values, count, pattern) {
    return strings(values, count, 128) && values.every(value => pattern.test(value)) && new Set(values).size === values.length;
}

function repoPath(value) {
    return text(value, 300) && !/[\\:\r\n\t]/u.test(value) &&
        value.split('/').every(part => part.length > 0 && !PRIVATE_PATH.test(part));
}

function edit(value) {
    return keys(value, ['path', 'before', 'after']) && repoPath(value.path) &&
        text(value.before, 2048, true) && value.before.length > 0 && text(value.after, 2048, true) && value.before !== value.after;
}

function parseProposal(value) {
    requireAnalysis(keys(value, ['repo_id', 'base_commit', 'changes', 'verification', 'required_check_ids', 'pending_decisions']) &&
        text(value.repo_id, 128) && TOKEN.test(value.repo_id) && text(value.base_commit, 64) && COMMIT.test(value.base_commit) &&
        Array.isArray(value.changes) && value.changes.length <= 8 && value.changes.every(edit) &&
        strings(value.verification, 6, 280) && identifiers(value.required_check_ids, 10, TOKEN) &&
        strings(value.pending_decisions, 6, 280), 'proposal');
    return value;
}

export function parseAnalysis(value) {
    requireAnalysis(keys(value, ['classification', 'summary', 'impact', 'criteria', 'evidence_refs', 'missing_requirements', 'assessment'],
        ['proposal', 'customer_body']), 'analysis');
    requireAnalysis(ANALYSIS_CLASSIFICATIONS.includes(value.classification), 'classification');
    requireAnalysis(text(value.summary, 640) && text(value.impact, 640), 'summary_or_impact');
    requireAnalysis(strings(value.criteria, 8, 280), 'criteria');
    requireAnalysis(strings(value.missing_requirements, 8, 280), 'missing_requirements');
    requireAnalysis(identifiers(value.evidence_refs, 16, EVIDENCE_REF), 'evidence_refs');
    requireAnalysis(keys(value.assessment, ASSESSMENT_FACTORS), 'assessment');
    for (const factor of ASSESSMENT_FACTORS) {
        const item = value.assessment[factor];
        requireAnalysis(keys(item, ['score', 'reason', 'evidence_refs']) && Number.isInteger(item.score) &&
            item.score >= 0 && item.score <= 2 && text(item.reason, 320) &&
            identifiers(item.evidence_refs, 10, EVIDENCE_REF) && item.evidence_refs.every(ref => value.evidence_refs.includes(ref)), factor);
    }

    if (value.classification === 'explanation' || value.classification === 'needs_information') {
        requireAnalysis(text(value.customer_body, 1000) && !Object.hasOwn(value, 'proposal'), 'customer_body');
        if (value.classification === 'needs_information') requireAnalysis(value.missing_requirements.length > 0, 'missing_requirements');
    } else {
        requireAnalysis(!Object.hasOwn(value, 'customer_body'), 'customer_body');
        if (Object.hasOwn(value, 'proposal')) parseProposal(value.proposal);
    }

    requireAnalysis(new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ANALYSIS_BYTES, 'size');
    return value;
}

export function assessmentScore(analysis) {
    return ASSESSMENT_FACTORS.reduce((sum, factor) => sum + analysis.assessment[factor].score, 0);
}

export function hasRepairBasis(analysis) {
    const proposal = analysis.proposal;
    return (analysis.classification === 'bug' || analysis.classification === 'change_request') &&
        !!proposal && proposal.changes.length > 0 && proposal.verification.length > 0 &&
        proposal.required_check_ids.length > 0 && proposal.pending_decisions.length === 0 &&
        analysis.criteria.length > 0 && analysis.evidence_refs.length > 0 && analysis.missing_requirements.length === 0;
}

export function analysisDisposition(analysis) {
    const score = assessmentScore(analysis);
    if (analysis.classification === 'explanation') {
        return analysis.evidence_refs.length > 0
            ? { kind: 'reply', score }
            : { kind: 'waiting_review', score, reason: 'evidence_missing' };
    }
    if (analysis.classification === 'needs_information') return { kind: 'request_information', score };
    if (analysis.classification === 'change_request' &&
        (!analysis.criteria.length || analysis.proposal?.pending_decisions.length)) {
        return { kind: 'waiting_review', score, reason: 'business_decision' };
    }
    if (score < 5) return { kind: 'blocked', score, reason: 'score_below_threshold' };
    if (score < 8) return { kind: 'waiting_review', score };
    if (!hasRepairBasis(analysis) || ASSESSMENT_FACTORS.some(factor =>
        analysis.assessment[factor].score === 0 || analysis.assessment[factor].evidence_refs.length === 0)) {
        return { kind: 'blocked', score, reason: 'evidence_missing' };
    }
    return { kind: 'repair', score };
}

export function redactAnalysisText(value) {
    return value
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, MASK)
        .replace(/\b(?:bearer|basic)[ \t]+[A-Za-z0-9+/_.=-]{8,}/gi, MASK)
        .replace(/\b(?:fda_[A-Za-z0-9_-]{28,124}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, MASK)
        .replace(/\b(authorization|cookie|set-cookie|password|passphrase|[\w.-]*(?:secret|token|api[_-]?key|private[_-]?key|credential))["']?[ \t]*[:=][ \t]*[^\r\n]+/gi, '$1=' + MASK)
        .replace(/\b(?:https?|ssh|file):\/\/[^\s<>"']+/gi, MASK)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, MASK)
        .replace(/(?:~\/|\/(?:Users|home|etc|srv|var\/log|private\/tmp)\/)[^\s<>"']+/gu, MASK)
        .replace(/\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|127\.0\.0\.1)\b/g, MASK)
        .replace(/\b[A-Z][12]\d{8}\b/g, MASK)
        .replace(/\b09\d{2}[ -]?\d{3}[ -]?\d{3}\b/g, MASK)
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, '');
}

export function isSafeCustomerBody(value) {
    return text(value, 1000) && value === redactAnalysisText(value) && !NON_CUSTOMER_CONTENT.test(value);
}

export function canonicalProposalJson(proposal) {
    return JSON.stringify(proposal, (_key, value) => record(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        : value);
}

const EXAMPLE_REF = 'ev:' + 'a'.repeat(64);
export const ANALYSIS_EXAMPLE = Object.freeze({
    classification: 'bug',
    summary: '同一操作重複列出資料。',
    impact: '使用者在結果清單看見重複項目。',
    criteria: ['同一操作只顯示一個項目。'],
    evidence_refs: [EXAMPLE_REF],
    missing_requirements: [],
    assessment: Object.fromEntries(ASSESSMENT_FACTORS.map(factor => [
        factor, { score: 2, reason: '觀察結果可對應此項。', evidence_refs: [EXAMPLE_REF] },
    ])),
    proposal: {
        repo_id: 'fixture-repo',
        base_commit: 'a'.repeat(40),
        changes: [{ path: 'src/items.js', before: 'return allItems;', after: 'return uniqueItems;' }],
        verification: ['重複資料只出現一次。'],
        required_check_ids: ['unit'],
        pending_decisions: [],
    },
});
