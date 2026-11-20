import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

export const workspace = '00000000-0000-4000-8000-000000000001';
export const testId = '10000000-0000-4000-8000-000000000002';
export const project = 'w3-demo';
export const environments = ['qa', 'stage'];
const sha = value => createHash('sha256').update(value).digest('hex');

// A dedicated D1 directory keeps the report IDs corresponding to Whippet's retained links.
export async function startDesk() {
    if (!process.env.W3_DESK_OWNER) throw new Error('W3_DESK_OWNER is required');
    const root = resolve('dist/worker');
    const chunks = (await readdir(root)).filter(name => name.endsWith('.js') && name !== 'index.js');
    const modules = ['index.js', ...chunks].map(name => ({ type: 'ESModule', path: join(root, name) }));
    const mf = new Miniflare(convertV4MiniflareOptions({
        host: '127.0.0.1', port: 19833, modulesRoot: root, modules, compatibilityDate: '2026-10-01',
        compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['FILES'],
        assets: { directory: resolve('dist/public'), binding: 'ASSETS', routerConfig: { has_user_worker: true }, run_worker_first: ['/*', '!/assets/*'] },
        ...(process.env.W3_D1_PERSIST && { resourcePersistencePath: resolve(process.env.W3_D1_PERSIST) }),
        bindings: { APP_SECRET: process.env.W3_DESK_SECRET || randomBytes(32).toString('hex') },
    }));
    try {
        await mf.ready;
        const db = await mf.getD1Database('DB');
        await db.prepare('CREATE TABLE IF NOT EXISTS w3_qa_migrations (name TEXT PRIMARY KEY)').run();
        for (const migration of await readD1Migrations(resolve('migrations'))) {
            if (await db.prepare('SELECT name FROM w3_qa_migrations WHERE name=?').bind(migration.name).first()) continue;
            await db.batch([...migration.queries.map(query => db.prepare(query)),
                db.prepare('INSERT INTO w3_qa_migrations(name) VALUES (?)').bind(migration.name)]);
        }
        const now = new Date().toISOString();
        await db.prepare('INSERT INTO projects (name, slug, owner_token_hash, client_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET owner_token_hash=excluded.owner_token_hash, client_token_hash=excluded.client_token_hash')
            .bind('Inspection QA', project, sha(process.env.W3_DESK_OWNER), sha(process.env.W3_DESK_CLIENT || randomBytes(32).toString('hex')), now, now).run();
        const { id } = await db.prepare('SELECT id FROM projects WHERE slug=?').bind(project).first();
        for (const env of environments) {
            const token = process.env['W3_' + env.toUpperCase() + '_DMZ'];
            if (!token) throw new Error('Missing DMZ token for ' + env);
            await db.batch([
                db.prepare('INSERT OR IGNORE INTO automation_scopes(project_id, environment, scope_revision, customer_ingress, inspection_ingress) VALUES (?, ?, ?, 0, 1)').bind(id, env, 'w3-r1'),
                db.prepare('INSERT OR IGNORE INTO automation_inspection_tokens(token_hash, project_id, environment, source_instance) VALUES (?, ?, ?, ?)').bind(sha(token), id, env, 'whippet-qa'),
                db.prepare('INSERT OR IGNORE INTO automation_inspection_targets(project_id,environment,scope_revision,source_instance,workspace_id,test_id,check_key) VALUES (?,?,?,?,?,?,?)')
                    .bind(id, env, 'w3-r1', 'whippet-qa', workspace, testId, 'heading'),
            ]);
        }
        return { mf, db };
    } catch (error) {
        await mf.dispose();
        throw error;
    }
}
