import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readRepositoryFile, readLocalGuide, queryElk } from './evidence.mjs';
import { authorize, isToken, loadScope, requireScope, ScopeError } from './policy.mjs';

export { ScopeError };

const IDENTITY_FIELDS = ['work_id', 'correlation_id', 'actor', 'project_slug', 'environment', 'scope_revision'];
const OPERATIONS = new Set(['read_repo_file', 'read_local_guide', 'query_elk']);
const UNAVAILABLE = new Set([
    'scope_unavailable', 'credential_unavailable', 'repository_unavailable', 'guide_unavailable', 'elk_unavailable',
]);

async function appendAudit(path, record) {
    try {
        const handle = await open(path, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
            constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
        try {
            const file = await handle.stat();
            requireScope(file.isFile() && file.nlink === 1 && (file.mode & 0o077) === 0, 'audit_unavailable');
            await handle.writeFile(JSON.stringify(record) + '\n');
        } finally {
            await handle.close();
        }
    } catch {
        throw new ScopeError('audit_unavailable');
    }
}

export function createScopeAccess({
    configPath,
    auditPath,
    fetchImpl = globalThis.fetch,
    resolveSecret = ref => process.env[ref],
}) {
    const configFile = resolve(configPath);
    const auditFile = resolve(auditPath);
    requireScope(configFile !== auditFile, 'invalid_config');
    const services = { fetchImpl, resolveSecret };

    return Object.freeze({
        forWork(work) {
            requireScope(work && IDENTITY_FIELDS.every(field => isToken(work[field])), 'invalid_work');
            // This identity is supplied by the Worker after claiming the job.
            const identity = Object.fromEntries(IDENTITY_FIELDS.map(field => [field, work[field]]));
            let pinnedFingerprint;
            const current = async () => {
                const { scope, fingerprint } = await loadScope(configFile, identity);
                pinnedFingerprint ??= fingerprint;
                requireScope(fingerprint === pinnedFingerprint, 'scope_changed');
                return scope;
            };
            const audit = (operation, decision, target, reason) => appendAudit(auditFile, {
                ...identity,
                at: new Date().toISOString(),
                operation,
                decision,
                ...(target && { target }),
                ...(reason && { reason }),
            });

            async function run(operation, request) {
                let target;
                try {
                    const scope = await current();
                    if (operation === 'validate') {
                        await audit(operation, 'allowed');
                        return {
                            project_slug: identity.project_slug,
                            environment: identity.environment,
                            scope_revision: identity.scope_revision,
                        };
                    }

                    const allowed = authorize(scope, request, operation);
                    target = allowed.target;
                    await audit(operation, 'authorized', target);
                    await current();
                    const result = await executeEvidence(operation, allowed, request, services, current);
                    await current();
                    await audit(operation, 'allowed', target);
                    return result;
                } catch (error) {
                    const code = error instanceof ScopeError ? error.code : 'tool_unavailable';
                    if (code !== 'audit_unavailable') {
                        const decision = UNAVAILABLE.has(code) || code === 'tool_unavailable' ? 'failed' : 'denied';
                        await audit(operation, decision, target, code);
                    }
                    throw new ScopeError(code);
                }
            }

            return Object.freeze({
                validate: () => run('validate'),
                execute(request) {
                    // JSON tool input is untrusted and cannot override the bound identity.
                    const operation = OPERATIONS.has(request?.operation) ? request.operation : 'unknown';
                    return run(operation, request && { ...request });
                },
            });
        },
    });
}

function executeEvidence(operation, allowed, request, services, checkCurrent) {
    switch (operation) {
        case 'read_repo_file':
            return readRepositoryFile(allowed.source, request.path, checkCurrent);
        case 'read_local_guide':
            return readLocalGuide(allowed.source, request.path, checkCurrent);
        case 'query_elk':
            return queryElk(allowed.source, allowed.template, request, services, checkCurrent);
    }
}
