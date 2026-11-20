import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { loadScope, isToken, localRepositoryPath, requireScope, ScopeError } from '../scope/policy.mjs';
import { LEASE_FIELDS } from '../consumer/queue.mjs';
import { canonicalProposalJson as canonicalJson } from '../../../src/shared/automation-analysis.mjs';

export { canonicalJson };

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SECRET_REF = /^[A-Z][A-Z0-9_]{0,127}$/;
const DISALLOWED_FILENAME = /^(?:\.|id_(?:rsa|ed25519)|secrets?(?:[._-]|$)|credentials?(?:[._-]|$))|(?:\.(?:pem|key|p12|pfx|keystore))$/i;

export function hash(text) {
    return createHash('sha256').update(text).digest('hex');
}

export function positiveInt(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function matches(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

function validPath(value) {
    return matches(value, /^[^\u0000-\u001f\u007f\\:]{1,512}$/u) &&
        value.split('/').every(part => part && !DISALLOWED_FILENAME.test(part));
}

function allowedPath(path, prefixes) {
    return validPath(path) && prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'));
}

function validList(values, predicate, maximum = 32) {
    return Array.isArray(values) && values.length > 0 && values.length <= maximum && values.every(predicate);
}

function unique(values) {
    return new Set(values).size === values.length;
}

function gitLabConfig(config, remote) {
    let origin;
    try {
        origin = new URL(config?.origin);
    } catch {
        throw new ScopeError('invalid_repair_config');
    }
    requireScope(config.origin === origin.origin && origin.protocol === 'https:' && isToken(config.instance_id) &&
        positiveInt(config.project_id) &&
        matches(config.project_path, /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/) &&
        config.project_path.split('/').every(part => part !== '.' && part !== '..') &&
        remote === config.origin + '/' + config.project_path + '.git' &&
        matches(config.push_username, /^[A-Za-z0-9_.@-]{1,128}$/), 'invalid_repair_config');
    const refs = [config.api_token_ref, config.push_token_ref, config.proof_key_ref];
    requireScope(refs.every(ref => matches(ref, SECRET_REF)) && unique(refs), 'invalid_repair_config');
    return config;
}

function validCheck(check) {
    return isToken(check?.id) && validList(check.argv, arg => matches(arg, /^[^\u0000-\u001f\u007f]{1,1024}$/u), 24) &&
        !check.argv[0].startsWith('-');
}

function editIsValid(change, prefixes) {
    return !!change && Object.keys(change).length === 3 && allowedPath(change.path, prefixes) &&
        matches(change.before, /^[^\u0000]{1,2048}$/u) && matches(change.after, /^[^\u0000]{0,2048}$/u) &&
        change.before !== change.after;
}

export function validateAuthorization(auth, scopeRevision) {
    requireScope(auth && positiveInt(auth.proposal_revision) &&
        positiveInt(auth.input_revision) && (auth.delivery_mode === undefined || ['local', 'gitlab'].includes(auth.delivery_mode)) &&
        auth.scope_revision === scopeRevision &&
        matches(auth.proposal_digest, DIGEST) &&
        (auth.kind === 'automatic' || (auth.kind === 'team_approved' && isToken(auth.approval_id))) &&
        auth.proposal && hash(canonicalJson(auth.proposal)) === auth.proposal_digest, 'invalid_repair_authorization');
}

export function createRepairScope(configPath, work, authorization) {
    requireScope([work?.project_slug, work?.environment, work?.scope_revision, work?.work_id,
        work?.event_id, work?.report_public_id, work?.worker_id].every(isToken) &&
        positiveInt(work.report_revision) && positiveInt(work.lease_generation), 'invalid_work');
    validateAuthorization(authorization, work.scope_revision);
    let scopeFingerprint;

    return async function currentScope() {
        const { scope, fingerprint } = await loadScope(configPath, work);
        scopeFingerprint ??= fingerprint;
        requireScope(scopeFingerprint === fingerprint, 'scope_changed');
        const proposal = authorization.proposal;
        const repo = scope.repositories.find(candidate => candidate.id === proposal.repo_id);
        requireScope(repo && matches(proposal.base_commit, SHA) && repo.base_commit === proposal.base_commit &&
            authorization.repo_id === repo.id && authorization.base_commit === repo.base_commit &&
            authorization.base_branch === repo.base_branch,
            'repair_repo_not_allowed');

        const config = repo.repair;
        const mode = config?.mode ?? 'gitlab';
        requireScope(mode === (authorization.delivery_mode ?? 'gitlab'), 'repair_delivery_mode_mismatch');
        requireScope(config && typeof config.recovery_directory === 'string' && isAbsolute(config.recovery_directory) &&
            !config.recovery_directory.includes('\0') && validList(config.allowed_paths, prefix => allowedPath(prefix, repo.read_paths)) &&
            matches(config.branch_prefix, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,88}\/$/) &&
            validList(config.checks, validCheck) && unique(config.checks.map(check => check.id)) &&
            matches(config.test_image, /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,199}@sha256:[a-f0-9]{64}$/),
        'invalid_repair_config');
        const recovery = resolve(config.recovery_directory);
        requireScope([...scope.repositories, ...scope.guides].every(source =>
            resolve(source.directory) !== recovery && !recovery.startsWith(resolve(source.directory) + '/')) &&
            (mode !== 'local' || (localRepositoryPath(repo.remote) !== recovery &&
                !recovery.startsWith(localRepositoryPath(repo.remote) + '/'))),
        'repair_recovery_not_private');

        requireScope(Array.isArray(proposal.pending_decisions) && proposal.pending_decisions.length === 0 &&
            validList(proposal.changes, change => editIsValid(change, config.allowed_paths), 8) &&
            validList(proposal.required_check_ids, isToken, 10) && unique(proposal.required_check_ids) &&
            canonicalJson(authorization.required_check_ids) === canonicalJson(proposal.required_check_ids) &&
            validList(authorization.acceptance_criteria, criterion =>
                typeof criterion === 'string' && criterion.trim().length > 0 && criterion.length <= 280, 8) &&
            validList(proposal.verification, item => typeof item === 'string' && item.trim().length > 0 && item.length <= 280, 6) &&
            canonicalJson(authorization.verification) === canonicalJson(proposal.verification),
        'repair_proposal_not_allowed');

        const checks = proposal.required_check_ids.map(id => config.checks.find(check => check.id === id));
        requireScope(checks.every(Boolean), 'repair_check_not_allowed');
        if (mode === 'local') {
            requireScope(config.gitlab === undefined, 'invalid_repair_config');
            return { repo, config, checks, mode };
        }
        return { repo, config, checks, mode, gitlab: gitLabConfig(config.gitlab, repo.remote) };
    };
}

export function assertCurrentAuthorization(input, lease, authorization) {
    requireScope(input?.work && LEASE_FIELDS.every(field => input.work[field] === lease[field]) &&
        input.work.input_revision === authorization.input_revision && input.work.next_action === 'repair',
    'repair_lease_changed');
    validateAuthorization(input.repair_authorization, lease.scope_revision);
    requireScope(canonicalJson(input.repair_authorization) === canonicalJson(authorization), 'repair_authorization_changed');
}

export async function resolveRepairSecret(resolveSecret, ref) {
    let value;
    try {
        value = await resolveSecret(ref);
    } catch {
        throw new ScopeError('credential_unavailable');
    }
    requireScope(matches(value, /^[!-~]{1,1024}$/), 'credential_unavailable');
    return value;
}
