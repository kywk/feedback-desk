import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const ELK_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const ELK_FIELD = /^[@A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const SECRET_REF = /^[A-Z][A-Z0-9_]{0,127}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SENSITIVE_NAME = /^(?:\.|id_(?:rsa|ed25519)|secrets?(?:[._-]|$)|credentials?(?:[._-]|$))|(?:\.(?:pem|key|p12|pfx|keystore))$/i;

export class ScopeError extends Error {
    constructor(code) {
        super(code);
        this.name = 'ScopeError';
        this.code = code;
    }
}

export function requireScope(condition, code) {
    if (!condition) throw new ScopeError(code);
}

export function isToken(value) {
    return typeof value === 'string' && TOKEN.test(value);
}

function matches(value, pattern) {
    return typeof value === 'string' && pattern.test(value);
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
}

function exactFields(value, keys) {
    return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validList(value, predicate, limit = 128) {
    return Array.isArray(value) && value.length <= limit && value.every(predicate);
}

function uniqueBy(value, getKey) {
    return new Set(value.map(getKey)).size === value.length;
}

function within(value, min, max) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
}

function safePath(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
        !/[\r\n\t\u0000-\u001f\u007f\\:]/u.test(value) &&
        value.split('/').every(part => part && !SENSITIVE_NAME.test(part));
}

function safeDirectory(value) {
    return typeof value === 'string' && isAbsolute(value) && !value.includes('\0');
}

export function localRepositoryPath(remote) {
    try {
        const path = fileURLToPath(remote);
        if (path !== '/' && !/[\u0000-\u001f\u007f]/u.test(path) && pathToFileURL(path).href === remote) return path;
    } catch {
        // The configured value must be a canonical, hostless file URL.
    }
}

function validRemote(value) {
    if (typeof value !== 'string' || /[\s\u0000-\u001f]/u.test(value)) return false;
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/-]+$/.test(value)) return true;
    try {
        const url = new URL(value);
        return ['https:', 'ssh:'].includes(url.protocol) && !!url.hostname &&
            !url.password && (url.protocol === 'ssh:' || !url.username) && !url.search && !url.hash &&
            url.pathname.length > 1;
    } catch {
        return false;
    }
}

function validSource(value) {
    return isRecord(value) && isToken(value.id) && safeDirectory(value.directory) &&
        validList(value.read_paths, safePath) && value.read_paths.length > 0;
}

function validRepo(repo) {
    const mode = repo?.repair?.mode === undefined ? 'gitlab' : repo.repair.mode;
    return validSource(repo) &&
        (mode === 'local' ? localRepositoryPath(repo.remote) : mode === 'gitlab' && validRemote(repo.remote)) &&
        matches(repo.base_branch, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/) &&
        matches(repo.base_commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
}

function validEndpoint(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password &&
            !url.search && !url.hash && url.pathname === '/';
    } catch {
        return false;
    }
}

function validTemplate(template) {
    if (!isRecord(template) || !isToken(template.id) || !isRecord(template.terms)) return false;
    const terms = Object.entries(template.terms);
    return terms.length <= 10 && terms.every(([name, value]) =>
        ELK_FIELD.test(name) && !['@timestamp', 'service.name'].includes(name) &&
        ((typeof value === 'string' && value.length <= 128) || typeof value === 'boolean' || Number.isFinite(value)));
}

function validElk(elk) {
    return isRecord(elk) && validEndpoint(elk.endpoint) && matches(elk.index, ELK_NAME) &&
        validList(elk.services, isToken) && elk.services.length > 0 &&
        validList(elk.queries, validTemplate) && uniqueBy(elk.queries, query => query.id) &&
        validList(elk.fields, field => matches(field, ELK_FIELD), 40) && elk.fields.length > 0 &&
        validList(elk.redact_fields, field => elk.fields.includes(field), 40) &&
        within(elk.max_window_seconds, 1, 604800) && within(elk.max_hits, 1, 100) &&
        (elk.credential_ref === undefined || matches(elk.credential_ref, SECRET_REF));
}

async function readBoundedFile(handle, limit, sizeError, invalidError) {
    const file = await handle.stat();
    requireScope(file.isFile(), invalidError);
    requireScope(file.size <= limit, sizeError);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    requireScope(offset <= limit, sizeError);
    return buffer.subarray(0, offset);
}

export async function readBoundedPath(path, limit, sizeError, invalidError, verifyFile) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        if (verifyFile) await verifyFile(await handle.stat());
        return await readBoundedFile(handle, limit, sizeError, invalidError);
    } finally {
        await handle.close();
    }
}

export async function loadScope(configPath, identity) {
    let config;
    try {
        const contents = await readBoundedPath(configPath, 256 * 1024, 'invalid_config', 'invalid_config');
        config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
    } catch (error) {
        if (error.code === 'ENOENT') throw new ScopeError('scope_unavailable');
        throw new ScopeError('invalid_config');
    }

    requireScope(isRecord(config) && validList(config.scopes, scope => isRecord(scope) &&
        isToken(scope.project_slug) && isToken(scope.environment) && isToken(scope.scope_revision)), 'invalid_config');
    const matchesScope = config.scopes.filter(scope =>
        scope.project_slug === identity.project_slug && scope.environment === identity.environment);
    requireScope(matchesScope.length > 0, 'unknown_scope');
    requireScope(matchesScope.length === 1, 'invalid_config');
    const scope = matchesScope[0];
    requireScope(scope.scope_revision === identity.scope_revision, 'scope_revision_mismatch');
    requireScope(scope.enabled !== false, 'scope_revoked');
    requireScope((scope.enabled === undefined || scope.enabled === true) &&
        validList(scope.repositories, validRepo) && uniqueBy(scope.repositories, repo => repo.id) &&
        validList(scope.guides, validSource) && uniqueBy(scope.guides, guide => guide.id) &&
        (scope.elk === undefined || validElk(scope.elk)), 'invalid_config');
    const fingerprint = createHash('sha256').update(JSON.stringify(sortKeys(scope))).digest('hex');
    return { scope, fingerprint };
}

function fileTarget(sources, id, path) {
    requireScope(isToken(id), 'invalid_request');
    const source = sources.find(candidate => candidate.id === id);
    requireScope(source, 'source_not_allowed');
    requireScope(safePath(path) && source.read_paths.some(allowed =>
        path === allowed || path.startsWith(allowed + '/')), 'path_not_allowed');
    return source;
}

function utcTime(value) {
    if (!matches(value, ISO_UTC)) return NaN;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) return NaN;
    return new Date(time).toISOString().replace(/\.000Z$/, 'Z') === value.replace(/\.000Z$/, 'Z') ? time : NaN;
}

function authorizeElk(elk, request) {
    requireScope(exactFields(request, ['operation', 'index', 'template_id', 'service', 'from', 'to', 'limit']), 'invalid_request');
    requireScope(elk && elk.index === request.index, 'index_not_allowed');
    const template = elk.queries.find(query => query.id === request.template_id);
    requireScope(template && elk.services.includes(request.service), 'query_not_allowed');
    const from = utcTime(request.from);
    const to = utcTime(request.to);
    requireScope(Number.isFinite(from) && to > from && to - from <= elk.max_window_seconds * 1000 &&
        within(request.limit, 1, elk.max_hits), 'query_not_allowed');
    return { source: elk, template, target: { index: elk.index, template_id: template.id } };
}

export function authorize(scope, request, operation) {
    switch (operation) {
        case 'read_repo_file': {
            requireScope(exactFields(request, ['operation', 'repo_id', 'path']), 'invalid_request');
            const source = fileTarget(scope.repositories, request.repo_id, request.path);
            return { source, target: { repo_id: source.id, commit: source.base_commit } };
        }
        case 'read_local_guide': {
            requireScope(exactFields(request, ['operation', 'guide_id', 'path']), 'invalid_request');
            const source = fileTarget(scope.guides, request.guide_id, request.path);
            return { source, target: { guide_id: source.id } };
        }
        case 'query_elk':
            return authorizeElk(scope.elk, request);
        default:
            throw new ScopeError('operation_not_allowed');
    }
}
