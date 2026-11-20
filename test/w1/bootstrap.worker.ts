import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { Browser, seedProject } from '../worker/helpers';

it('sets up two isolated projects and creates a report through the customer HTTP form', async () => {
    const a = await seedProject();
    const b = await seedProject();
    const client = await new Browser().asClient(a);
    const response = await client.post(`/p/${a.project.slug}/reports`, { 'issues[0][title]': 'W1 客戶回報', 'issues[0][description]': '操作無法完成' });
    expect(response.status).toBe(302);
    const reports = await env.DB.prepare('SELECT public_id, project_id FROM reports WHERE project_id IN (?, ?)').bind(a.project.id, b.project.id).all<{ public_id: string; project_id: number }>();
    expect(reports.results).toHaveLength(1);
    expect(reports.results[0].project_id).toBe(a.project.id);
    expect((await client.get(`/p/${a.project.slug}/reports/${reports.results[0].public_id}`)).status).toBe(200);
});
