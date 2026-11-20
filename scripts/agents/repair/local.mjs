import { inspectLocalRepository, verifyLocalRefPaths } from '../scope/local-repository.mjs';
import { requireScope, ScopeError } from '../scope/policy.mjs';
import { git } from './git.mjs';

const MAX_PACK_BYTES = 16 * 1024 * 1024;

export function localBranchStorage(repo, identity, tree, signal) {
    const { directory } = identity;
    const bareGit = (args, options) => git(tree, ['--git-dir', directory, ...args], { signal, ...options });

    async function assertRepository(...branches) {
        signal.throwIfAborted();
        const current = await inspectLocalRepository(repo);
        requireScope(current.device === identity.device && current.inode === identity.inode, 'local_repository_not_allowed');
        for (const branch of branches) {
            const ref = 'refs/heads/' + branch;
            await bareGit(['check-ref-format', ref]);
            await verifyLocalRefPaths(directory, branch);
            try {
                await bareGit(['symbolic-ref', '--quiet', '--no-recurse', ref]);
                throw new ScopeError('local_repository_not_allowed');
            } catch (error) {
                signal.throwIfAborted();
                if (error.code === 1) continue;
                throw new ScopeError('local_repository_not_allowed');
            }
        }
    }

    async function head(branch) {
        await assertRepository(branch);
        const ref = 'refs/heads/' + branch;
        try {
            await bareGit(['show-ref', '--verify', '--quiet', ref]);
        } catch (error) {
            signal.throwIfAborted();
            if (error.code === 1) return null;
            throw new ScopeError('local_branch_unverified');
        }
        try {
            const sha = (await bareGit(['show-ref', '--verify', '--hash', ref])).toString('utf8').trim();
            requireScope(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha), 'local_branch_unverified');
            return sha;
        } catch {
            signal.throwIfAborted();
            throw new ScopeError('local_branch_unverified');
        }
    }

    return {
        head,
        async install(observation, fenceWrite) {
            const { source_branch, target_branch, head_sha, base_commit } = observation;
            requireScope(await head(target_branch) === base_commit, 'local_base_changed');
            let pack;
            try {
                pack = await git(tree, ['pack-objects', '--revs', '--stdout'], {
                    signal, input: head_sha + '\n^' + base_commit + '\n', maxBuffer: MAX_PACK_BYTES, timeout: 30_000,
                });
            } catch {
                signal.throwIfAborted();
                throw new ScopeError('local_pack_failed');
            }

            await fenceWrite();
            await assertRepository(source_branch, target_branch);
            try {
                await bareGit(['index-pack', '--stdin', '--strict'], { input: pack, timeout: 30_000 });
            } catch {
                signal.throwIfAborted();
                throw new ScopeError('local_pack_failed');
            }

            await fenceWrite();
            await assertRepository(source_branch, target_branch);
            try {
                await bareGit(['update-ref', '--no-deref', '--stdin'], { input: [
                    'start',
                    'verify refs/heads/' + target_branch + ' ' + base_commit,
                    'create refs/heads/' + source_branch + ' ' + head_sha,
                    'prepare',
                    'commit',
                    '',
                ].join('\n') });
            } catch {
                signal.throwIfAborted();
                // A racing retry can have created the same branch. The caller reads the authoritative ref.
                if (await head(source_branch) === null) {
                    requireScope(await head(target_branch) === base_commit, 'local_base_changed');
                    throw new ScopeError('local_branch_write_failed');
                }
            }
        },
    };
}
