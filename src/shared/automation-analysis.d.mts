export const ANALYSIS_CLASSIFICATIONS: readonly ['explanation', 'needs_information', 'bug', 'change_request'];
export const CUSTOMER_REVIEW_MARKER: '[需人工檢查]';
export const ASSESSMENT_FACTORS: readonly ['cause_or_requirement', 'implementation', 'impact', 'scope_and_checks', 'verification'];

export type AnalysisClassification = typeof ANALYSIS_CLASSIFICATIONS[number];
export type AssessmentFactor = typeof ASSESSMENT_FACTORS[number];
export type EvidenceRef = `ev:${string}`;
export interface FactorAssessment {
    score: 0 | 1 | 2;
    reason: string;
    evidence_refs: EvidenceRef[];
}
export interface RepairProposal {
    repo_id: string;
    base_commit: string;
    changes: { path: string; before: string; after: string }[];
    verification: string[];
    required_check_ids: string[];
    pending_decisions: string[];
}
interface AnalysisFields {
    summary: string;
    impact: string;
    criteria: string[];
    evidence_refs: EvidenceRef[];
    missing_requirements: string[];
    assessment: Record<AssessmentFactor, FactorAssessment>;
}
export type Analysis = AnalysisFields & (
    | { classification: 'explanation' | 'needs_information'; customer_body: string; proposal?: never }
    | { classification: 'bug' | 'change_request'; proposal?: RepairProposal; customer_body?: never }
);
export type AnalysisDisposition = {
    kind: 'reply' | 'request_information' | 'repair' | 'waiting_review' | 'blocked';
    score: number;
    reason?: 'business_decision' | 'evidence_missing' | 'score_below_threshold';
};
export class AnalysisError extends Error {
    constructor(code: string, field?: string);
    readonly code: string;
    readonly field?: string;
}
export function parseAnalysis(value: unknown): Analysis;
export function assessmentScore(analysis: Analysis): number;
export function hasRepairBasis(analysis: Analysis): boolean;
export function analysisDisposition(analysis: Analysis): AnalysisDisposition;
export function redactAnalysisText(value: string): string;
export function isSafeCustomerBody(value: unknown): value is string;
export function canonicalProposalJson(proposal: RepairProposal): string;
export const ANALYSIS_EXAMPLE: Readonly<Analysis>;
