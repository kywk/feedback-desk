import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readBoundedPath, requireScope, ScopeError } from './policy.mjs';
import { inspectLocalRepository, verifyLocalRefPaths } from './local-repository.mjs';

const exec = promisify(execFile);
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ELK_BYTES = 1024 * 1024;
const MASKED = '[已遮罩]';
const SECRET_FIELD = /(?:^|[._-])(?:authorization|cookie|set-cookie|password|passphrase|secret|token|api[_-]?key|private[_-]?key|credential)s?$/i;
const GIT_ENV = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_GRAFT_FILE: '/dev/null',
};

function maskText(text, secret) {
    const value = secret ? text.replaceAll(secret, MASKED) : text;
    return value
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi, MASKED)
        .replace(/\b(authorization|cookie|set-cookie|password|passphrase|[\w.-]*(?:secret|token|api[_-]?key|private[_-]?key|credential))["']?[ \t]*[:=][^\r\n]*/gi, '$1=' + MASKED)
        .replace(/\b(?:bearer|basic)[ \t]+[A-Za-z0-9+/_.=-]{8,}/gi, MASKED)
        .replace(/\b(?:AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, MASKED)
        .replace(/\b(https?:\/\/)[^\s/]+:[^\s/@]+@/gi, '$1' + MASKED + '@')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, MASKED);
}

function evidenceText(buffer) {
    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        throw new ScopeError('invalid_evidence');
    }
    requireScope(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 'invalid_evidence');
    return maskText(text);
}

async function git(directory, ...args) {
    const { stdout } = await exec('git', ['-C', directory, ...args], {
        env: GIT_ENV,
        encoding: 'buffer',
        maxBuffer: MAX_TEXT_BYTES + 1024,
        timeout: 5000,
    });
    return stdout;
}

async function gitText(directory, ...args) {
    return (await git(directory, ...args)).toString('utf8').replace(/\n$/, '');
}

async function verifyRepository(repo) {
    const { directory, base_branch, base_commit } = repo;
    const gitDir = join(directory, '.git');
    if (repo.repair?.mode === 'local') {
        await inspectLocalRepository(repo);
        await verifyLocalRefPaths(gitDir, base_branch);
    }
    requireScope((await lstat(gitDir)).isDirectory() &&
        await realpath(directory) === directory, 'repository_not_allowed');
    const location = await gitText(directory, 'rev-parse', '--path-format=absolute',
        '--git-dir', '--git-common-dir', '--show-toplevel');
    requireScope(location === [gitDir, gitDir, directory].join('\n'), 'repository_not_allowed');
    let remote;
    try {
        remote = await gitText(directory, 'config', '--local', '--no-includes', '--get-all', 'remote.origin.url');
    } catch (error) {
        if (error.code === 1) throw new ScopeError('remote_not_allowed');
        throw error;
    }
    requireScope(remote === repo.remote, 'remote_not_allowed');
    const commit = await gitText(directory, 'rev-parse', '--verify', base_commit + '^{commit}');
    requireScope(commit === base_commit, 'commit_not_allowed');
    const ref = await gitText(directory, 'show-ref', '--verify', '--hash', 'refs/heads/' + base_branch);
    try {
        await git(directory, 'merge-base', '--is-ancestor', commit, ref);
    } catch (error) {
        if (error.code === 1) throw new ScopeError('commit_not_allowed');
        throw error;
    }
}

export async function readRepositoryFile(repo, path, checkCurrent) {
    try {
        await verifyRepository(repo);
        await checkCurrent();
        const entry = await gitText(repo.directory, 'ls-tree', '-z', repo.base_commit, '--', path);
        const match = /^100(?:644|755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/u.exec(entry);
        requireScope(match && match[2] === path, 'path_not_allowed');
        const size = Number(await gitText(repo.directory, 'cat-file', '-s', match[1]));
        requireScope(Number.isSafeInteger(size) && size >= 0 && size <= MAX_TEXT_BYTES, 'evidence_too_large');
        const content = evidenceText(await git(repo.directory, 'cat-file', 'blob', match[1]));
        return { repo_id: repo.id, commit: repo.base_commit, content };
    } catch (error) {
        if (error instanceof ScopeError) throw error;
        throw new ScopeError('repository_unavailable');
    }
}

export async function readLocalGuide(guide, path, checkCurrent) {
    try {
        requireScope(await realpath(guide.directory) === guide.directory, 'path_not_allowed');
        const parts = path.split('/');
        let target = guide.directory;
        for (const part of parts.slice(0, -1)) {
            target = join(target, part);
            requireScope((await lstat(target)).isDirectory(), 'path_not_allowed');
        }
        target = join(target, parts.at(-1));
        const expected = await lstat(target);
        requireScope(expected.isFile() && expected.nlink === 1, 'path_not_allowed');
        await checkCurrent();
        const buffer = await readBoundedPath(target, MAX_TEXT_BYTES, 'evidence_too_large', 'path_not_allowed', async file => {
            requireScope(file.dev === expected.dev && file.ino === expected.ino && file.nlink === 1 &&
                await realpath(target) === target, 'path_not_allowed');
        });
        return { guide_id: guide.id, content: evidenceText(buffer) };
    } catch (error) {
        if (error instanceof ScopeError) throw error;
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw new ScopeError('path_not_allowed');
        throw new ScopeError('guide_unavailable');
    }
}

async function parseSearchResponse(response) {
    requireScope(response.ok && response.body, 'elk_unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_ELK_BYTES) {
                await reader.cancel();
                throw new ScopeError('evidence_too_large');
            }
            chunks.push(value);
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } finally {
        reader.releaseLock();
    }
}

function ownField(object, key) {
    return object && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined;
}

function minimumRow(source, fields, redact, secret) {
    return Object.fromEntries(fields.flatMap(field => {
        const value = ownField(source, field) ?? field.split('.').reduce(ownField, source);
        if (value === undefined) return [];
        if (redact.includes(field) || SECRET_FIELD.test(field)) return [[field, MASKED]];
        if (typeof value === 'string') return [[field, maskText(value, secret).slice(0, 1000)]];
        if (typeof value === 'number' || typeof value === 'boolean') return [[field, value]];
        return [];
    }));
}

export async function queryElk(elk, template, request, services, checkCurrent) {
    let secret;
    if (elk.credential_ref) {
        try {
            secret = await services.resolveSecret(elk.credential_ref);
            requireScope(typeof secret === 'string' && /^[!-~]{1,8192}$/.test(secret), 'credential_unavailable');
        } catch {
            throw new ScopeError('credential_unavailable');
        }
    }
    await checkCurrent();
    try {
        const response = await services.fetchImpl(new URL('/' + elk.index + '/_search', elk.endpoint), {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
            headers: {
                'content-type': 'application/json',
                ...(secret ? { authorization: 'Bearer ' + secret } : {}),
            },
            body: JSON.stringify({
                size: request.limit,
                track_total_hits: false,
                _source: elk.fields,
                query: { bool: { filter: [
                    { range: { '@timestamp': { gte: request.from, lt: request.to } } },
                    { term: { 'service.name': request.service } },
                    ...Object.entries(template.terms).map(([field, value]) => ({ term: { [field]: value } })),
                ] } },
            }),
        });
        const result = await parseSearchResponse(response);
        requireScope(Array.isArray(result?.hits?.hits), 'elk_unavailable');
        return {
            index: elk.index,
            template_id: template.id,
            rows: result.hits.hits.slice(0, request.limit)
                .map(hit => minimumRow(hit?._source, elk.fields, elk.redact_fields, secret)),
        };
    } catch (error) {
        if (error instanceof ScopeError) throw error;
        throw new ScopeError('elk_unavailable');
    }
}
