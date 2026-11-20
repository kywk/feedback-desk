import { createHmac } from 'node:crypto';
import { QueueError } from '../consumer/queue.mjs';
import { requireScope, ScopeError } from '../scope/policy.mjs';
import { canonicalJson, positiveInt } from './policy.mjs';

const MAX_BODY = 256 * 1024;

function retryAfterMs(response) {
    const value = response.headers.get('retry-after');
    if (!value) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isSafeInteger(delay) && delay > 0 ? Math.min(delay, 86_400_000) : 0;
}

async function readBody(response) {
    requireScope(response.body, 'repair_gitlab_invalid_response');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY) {
                await reader.cancel();
                throw new ScopeError('repair_gitlab_invalid_response');
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
        reader.releaseLock();
    }
}

export function createGitLab({ config, token, fetchImpl, signal }) {
    const path = '/api/v4/projects/' + config.project_id;
    const projectUrl = config.origin + '/' + config.project_path;

    async function request(subpath, data) {
        signal.throwIfAborted();
        let response;
        try {
            response = await fetchImpl(new URL(path + subpath, config.origin), {
                method: data === undefined ? 'GET' : 'POST',
                redirect: 'error',
                signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
                headers: { 'private-token': token, 'content-type': 'application/json' },
                ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            });
            if (response.ok) return await readBody(response);
            await response.body?.cancel();
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof ScopeError) throw error;
            throw new QueueError('repair_gitlab_unavailable', { retryable: true });
        }
        const status = response.status;
        throw new QueueError('repair_gitlab_http_error', {
            status,
            retryAfterMs: retryAfterMs(response),
            retryable: status === 408 || status === 429 || status >= 500,
        });
    }

    function marker(operationId) {
        return 'Feedback Desk operation: ' + operationId;
    }

    function matchesMr(mr, operationId, intent) {
        return mr?.project_id === config.project_id && mr.source_project_id === config.project_id &&
            mr.target_project_id === config.project_id && mr.source_branch === intent.source_branch &&
            mr.target_branch === intent.target_branch && positiveInt(mr.id) && positiveInt(mr.iid) &&
            mr.web_url === projectUrl + '/-/merge_requests/' + mr.iid &&
            typeof mr.description === 'string' && mr.description.split(/\r?\n/u).includes(marker(operationId));
    }

    return {
        async verifyProject(remote) {
            const project = await request('');
            requireScope(project?.id === config.project_id && project.path_with_namespace === config.project_path &&
                project.http_url_to_repo === remote && project.web_url === projectUrl, 'repair_gitlab_project_not_allowed');
        },
        async find(operationId, intent) {
            const query = new URLSearchParams({
                scope: 'all', state: 'all', source_branch: intent.source_branch, target_branch: intent.target_branch,
                per_page: '2',
            });
            const candidates = await request('/merge_requests?' + query);
            requireScope(Array.isArray(candidates) && candidates.length <= 1, 'repair_mr_ambiguous');
            if (candidates.length === 0) return null;
            const candidate = candidates[0];
            requireScope(matchesMr(candidate, operationId, intent), 'repair_mr_mismatch');
            const mr = await request('/merge_requests/' + candidate.iid);
            requireScope(matchesMr(mr, operationId, intent) && mr.id === candidate.id && mr.iid === candidate.iid &&
                ['opened', 'merged'].includes(mr.state) && mr.sha === intent.head_sha &&
                (!mr.diff_refs?.head_sha || mr.diff_refs.head_sha === intent.head_sha), 'repair_mr_mismatch');
            return {
                ...intent, mr_id: mr.id, mr_iid: mr.iid, web_url: mr.web_url, state: mr.state,
                observed_at: new Date().toISOString(),
            };
        },
        async create(operationId, intent) {
            await request('/merge_requests', {
                source_branch: intent.source_branch, target_branch: intent.target_branch,
                title: 'Feedback Desk repair ' + operationId.slice(-12), description: marker(operationId),
            });
        },
    };
}

export function signObservation(key, work, authorization, operationId, observation) {
    return createHmac('sha256', key).update(canonicalJson({
        project_slug: work.project_slug, environment: work.environment, work_id: work.work_id,
        scope_revision: work.scope_revision, operation_id: operationId, input_revision: authorization.input_revision,
        proposal_revision: authorization.proposal_revision, proposal_digest: authorization.proposal_digest,
        observation,
    })).digest('hex');
}
