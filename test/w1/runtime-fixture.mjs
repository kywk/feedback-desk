// Isolated Miniflare/D1 + real loopback HTTP fixture. The service and customer routes are real.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(24).toString('hex');

export async function startDesk() {
  const root = resolve('dist/worker');
  const chunks = (await readdir(root)).filter(name => name.endsWith('.js') && name !== 'index.js');
  const modules = ['index.js', ...chunks].map(name => ({ type: 'ESModule', path: resolve(root, name) }));
  const mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, modules, modulesRoot: root, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
    d1Databases: ['DB'], r2Buckets: ['FILES'], bindings: { APP_SECRET: 'qa-secret-only-not-for-production-0123456789' } }));
  try {
    const url = (await mf.ready).origin; const db = await mf.getD1Database('DB');
    for (const migration of await readD1Migrations(resolve('migrations'))) {
      await db.batch(migration.queries.map(query => db.prepare(query)));
    }
    return { mf, url, db, close: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}

export async function createProject(desk, slug) {
  const token = random(), owner = random(), serviceToken = `fda_${random()}`;
  const now = new Date().toISOString();
  const project = await desk.db.prepare('INSERT INTO projects (name, slug, owner_token_hash, client_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(`QA ${slug}`, slug, hash(owner), hash(token), now, now).first();
  await desk.db.prepare('INSERT INTO automation_scopes (project_id, environment, scope_revision, customer_ingress, backfill_unclaimed) VALUES (?, ?, ?, 1, 0)').bind(project.id, 'qa', 'w1-r1').run();
  await desk.db.prepare('INSERT INTO automation_tokens (project_id, environment, token_hash) VALUES (?, ?, ?)').bind(project.id, 'qa', hash(serviceToken)).run();
  const client = await browser(desk.url, `/p/${slug}/access?token=${token}`);
  const team = await browser(desk.url, `/owner/${slug}/access?token=${owner}`);
  return { slug, id: project.id, serviceToken, client, team };
}

async function browser(baseUrl, entry) {
  let cookie = '';
  async function request(path, init = {}) {
    const headers = new Headers(init.headers); if (cookie) headers.set('cookie', cookie);
    const response = await fetch(new URL(path, baseUrl), { ...init, headers, redirect: 'manual' });
    const set = response.headers.getSetCookie(); if (set.length) cookie = set.map(item => item.split(';')[0]).join('; ');
    return response;
  }
  const access = await request(entry);
  if (access.status !== 302) throw new Error(`fixture access failed: ${access.status}`);
  return { get: path => request(path), post: (path, form) => request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }) };
}

export async function createCustomerReport(desk, project, title) {
  const response = await project.client.post(`/p/${project.slug}/reports`, { 'issues[0][title]': title, 'issues[0][description]': '測試資料：操作無法完成' });
  if (response.status !== 302) throw new Error(`customer create failed: ${response.status}`);
  const report = await desk.db.prepare('SELECT public_id, report_revision FROM reports WHERE project_id = ? AND title = ?').bind(project.id, title).first();
  if (!report) throw new Error('customer report was not saved');
  return report;
}
