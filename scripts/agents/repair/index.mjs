import { rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaseOf, QueueError } from '../consumer/queue.mjs';
import { requireScope, ScopeError } from '../scope/policy.mjs';
import { applyEdits, commitRepair, createGitTransport, withWorktree } from './git.mjs';
import { archiveWorktree, verifyInContainer } from './checks.mjs';
import { createGitLab, signObservation } from './gitlab.mjs';
import { assertCurrentAuthorization, canonicalJson, createRepairScope, hash, resolveRepairSecret } from './policy.mjs';

const PUSH = 'git.push_branch';
const CREATE_MR = 'gitlab.create_merge_request';

function assertIntent(data, operationId, correlationId, type) {
    const intent = data?.intent;
    requireScope(intent?.operation_id === operationId && intent.correlation_id === correlationId &&
        intent.operation_type === type && ['pending', 'recorded'].includes(intent.status) &&
        typeof intent.worker_id === 'string' && Number.isSafeInteger(intent.lease_generation),
    'repair_intent_invalid');
    return intent;
}

async function publishBranch({ transport, payload, recordIntent, fenceWrite, queue, lease, signal }) {
    const { repo_id, base_commit, head_sha, source_branch, target_branch } = payload;
    const intent = await recordIntent(PUSH);
    const receipt = { repo_id, head_sha, source_branch };
    let actual = await transport.remoteHead(source_branch);
    if (intent.status === 'recorded') {
        requireScope(canonicalJson(intent.receipt?.result) === canonicalJson(receipt), 'repair_push_receipt_mismatch');
        requireScope(actual === head_sha, 'repair_remote_branch_changed');
        return;
    }

    if (actual === null) {
        requireScope(await transport.remoteHead(target_branch) === base_commit, 'repair_remote_base_changed');
        await fenceWrite();
        const pushed = await transport.createBranch(source_branch, head_sha);
        actual = await transport.remoteHead(source_branch);
        if (actual === null) {
            if (pushed) throw new QueueError('repair_remote_unverified', { retryable: true });
            throw new ScopeError('repair_push_failed');
        }
    }

    requireScope(actual === head_sha, 'repair_remote_branch_changed');
    const response = await queue.receipt(lease, intent.operation_id, receipt, signal);
    requireScope(response?.receipt?.operation_id === intent.operation_id &&
        canonicalJson(response.receipt.result) === canonicalJson(receipt), 'repair_push_receipt_mismatch');
}

async function openMergeRequest({ gitLab, transport, payload, recordIntent, fenceWrite, lease }) {
    const intent = await recordIntent(CREATE_MR);
    const id = intent.operation_id;
    let observation = await gitLab.find(id, payload);
    if (observation) return observation;
    if (intent.worker_id !== lease.worker_id || intent.lease_generation !== lease.lease_generation ||
        intent.status !== 'pending') {
        throw new QueueError('repair_mr_result_uncertain', { retryable: true });
    }
    requireScope(await transport.remoteHead(payload.source_branch) === payload.head_sha, 'repair_remote_branch_changed');
    requireScope(await transport.remoteHead(payload.target_branch) === payload.base_commit, 'repair_remote_base_changed');
    await fenceWrite();
    let createError;
    try {
        await gitLab.create(id, payload);
    } catch (error) {
        createError = error;
    }
    observation = await gitLab.find(id, payload);
    if (observation) return observation;
    if (createError instanceof QueueError && [400, 401, 403, 404, 422].includes(createError.status)) {
        throw new ScopeError('repair_mr_create_failed');
    }
    throw new QueueError('repair_mr_result_uncertain', {
        retryable: true, retryAfterMs: createError?.retryAfterMs ?? 0,
    });
}

export function createRepairHandler({ configPath }, {
    fetchImpl = globalThis.fetch,
    resolveSecret = ref => process.env[ref],
    verifyCheck = verifyInContainer,
    fixtureRemote,
} = {}) {
    const localRemote = fixtureRemote === undefined ? undefined : fileURLToPath(fixtureRemote);

    return async function runRepair({ work, repairAuthorization, queue, signal, checkpoint = async () => {} }) {
        // Hold a stable snapshot of the server's approved proposal for the entire operation.
        const authorization = structuredClone(repairAuthorization);
        const current = createRepairScope(configPath, work, authorization);
        const lease = leaseOf(work);
        async function verifyAuthorization() {
            signal.throwIfAborted();
            await current();
            assertCurrentAuthorization(await queue.input(lease, signal), lease, authorization);
        }
        async function fenceWrite() {
            await verifyAuthorization();
            await queue.renew(lease, signal);
            await current();
            signal.throwIfAborted();
        }

        await verifyAuthorization();
        const { repo, config, checks, gitlab } = await current();
        const correlationId = work.event_id;
        const repairId = hash(canonicalJson([
            work.project_slug, work.environment, work.work_id, work.scope_revision, authorization.input_revision,
            authorization.proposal_revision, authorization.proposal_digest,
        ]));
        const sourceBranch = config.branch_prefix + repairId.slice(0, 32);
        const mrOperation = 'repair-mr:' + repairId;
        return withWorktree(repo, sourceBranch, config.recovery_directory, signal, async ({ directory, tree }) => {
            const recoveryId = basename(directory);
            const phase = (name, fields = {}) => checkpoint({
                repair: { phase: name, recovery_id: recoveryId, source_branch: sourceBranch, ...fields },
            });
            await writeFile(join(directory, 'repair.json'), JSON.stringify({
                work_id: work.work_id, input_revision: authorization.input_revision,
                proposal_revision: authorization.proposal_revision, proposal_digest: authorization.proposal_digest,
                scope_revision: work.scope_revision, repo_id: repo.id, base_commit: repo.base_commit, source_branch: sourceBranch,
            }) + '\n', { flag: 'wx', mode: 0o600 });
            await phase('apply');
            const indexTree = await applyEdits(tree, repo.base_commit, authorization.proposal.changes, signal);
            const checkResults = [];
            const archive = join(directory, 'worktree.tar');
            try {
                await archiveWorktree(archive, directory, tree, signal);
                for (const check of checks) {
                    await phase('verify', { check_id: check.id });
                    await verifyAuthorization();
                    await verifyCheck({ directory, archive, image: config.test_image, argv: check.argv, signal });
                    checkResults.push({ check_id: check.id, status: 'passed' });
                }
            } finally {
                await rm(archive, { force: true });
            }

            await verifyAuthorization();
            const commit = await commitRepair(tree, sourceBranch, repo.base_commit, indexTree, mrOperation, signal);
            const payload = {
                proposal_revision: authorization.proposal_revision, proposal_digest: authorization.proposal_digest,
                input_revision: authorization.input_revision, repo_id: repo.id, base_commit: repo.base_commit,
                gitlab_instance_id: gitlab.instance_id, project_id: gitlab.project_id, source_branch: sourceBranch,
                target_branch: repo.base_branch, head_sha: commit, check_results: checkResults,
            };
            async function recordIntent(type) {
                await verifyAuthorization();
                const id = type === PUSH ? 'repair-push:' + repairId : mrOperation;
                const data = await queue.intent(lease, {
                    operation_id: id, correlation_id: correlationId, operation_type: type, payload,
                }, signal);
                return assertIntent(data, id, correlationId, type);
            }

            const proofKey = await resolveRepairSecret(resolveSecret, gitlab.proof_key_ref);
            requireScope(Buffer.byteLength(proofKey) >= 32, 'credential_unavailable');
            const apiToken = await resolveRepairSecret(resolveSecret, gitlab.api_token_ref);
            const gitLab = createGitLab({ config: gitlab, token: apiToken, fetchImpl, signal });
            await gitLab.verifyProject(repo.remote);
            let observation = await gitLab.find(mrOperation, payload);
            if (observation) {
                // A confirmed MR can survive deletion of its source branch after merge.
                const intent = await recordIntent(PUSH);
                requireScope(intent.status === 'recorded' && canonicalJson(intent.receipt?.result) === canonicalJson({
                    repo_id: repo.id, head_sha: commit, source_branch: sourceBranch,
                }), 'repair_push_receipt_mismatch');
                await recordIntent(CREATE_MR);
            } else {
                await phase('push', { head_sha: commit });
                const credential = await resolveRepairSecret(resolveSecret, gitlab.push_token_ref);
                const transport = createGitTransport(tree, repo.remote, gitlab, credential, signal, localRemote);
                await publishBranch({ transport, payload, recordIntent, fenceWrite, queue, lease, signal });
                await phase('merge_request', { head_sha: commit });
                observation = await openMergeRequest({ gitLab, transport, payload, recordIntent, fenceWrite, lease });
            }

            await phase('record_mr', { head_sha: commit });
            await fenceWrite();
            const link = {
                input_revision: authorization.input_revision, operation_id: mrOperation,
                proposal_revision: authorization.proposal_revision, proposal_digest: authorization.proposal_digest,
                observation, proof: signObservation(proofKey, work, authorization, mrOperation, observation),
            };
            const result = await queue.mrLinks(lease, link, signal);
            requireScope(result?.receipt?.operation_id === mrOperation && result.receipt.work_id === work.work_id &&
                result.receipt.mr_id === observation.mr_id && result.receipt.mr_iid === observation.mr_iid &&
                result.receipt.web_url === observation.web_url, 'repair_mr_receipt_mismatch');
            return result;
        });
    };
}
