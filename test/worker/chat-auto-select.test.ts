import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoSelectTarget, EMPTY_THREAD_TEXT, visibleItems } from '../../src/shared/chat-tabs';
import type { Report } from '../../src/worker/lib/models';
import { Browser, reload, seedProject, seedReport, type SeededProject } from './helpers';

/**
 * 右下角對話面板打開就自動選第一張（對應 Laravel 版 chat-tabs.test.js 與 FeedbackConversationPanelTest）。
 * 客戶端自動彈出時用 ?peek=1 偷看，不標已讀；團隊端照常標已讀。
 */
const JSON_HEADERS = { accept: 'application/json' };

const READ_AT = '2020-01-01T00:00:00.000Z';
const MESSAGE_AT = '2020-01-01T00:01:00.000Z';
const OPENED_AT = '2020-01-01T00:02:00.000Z';

async function reportWithUnreadMessage(seeded: SeededProject, title: string, author: 'reporter' | 'owner'): Promise<Report> {
    const { report } = await seedReport(seeded.project, { title, at: Date.parse(READ_AT) });
    await env.DB.batch([
        env.DB.prepare('UPDATE reports SET client_last_read_at = ?, owner_last_read_at = ? WHERE id = ?').bind(READ_AT, READ_AT, report.id),
        env.DB.prepare('INSERT INTO messages (report_id, author_type, author_name, body, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)')
            .bind(report.id, author, '新留言', MESSAGE_AT, MESSAGE_AT),
    ]);
    return report;
}

async function unreadOf(browser: Browser, seeded: SeededProject, report: Report): Promise<number | undefined> {
    const data = (await (await browser.get(`/p/${seeded.project.slug}/conversations`, JSON_HEADERS)).json()) as { items: Array<{ id: string; unread: number }> };
    return data.items.find((item) => item.id === report.public_id)?.unread;
}

describe('對話面板自動選第一張的純邏輯', () => {
    const items = [
        { id: 'a', awaiting_reply: true, title: '登入壞了', number: 3 },
        { id: 'b', awaiting_reply: false, title: '報表', number: 2 },
        { id: 'c', awaiting_reply: true, title: '登出', number: 1 },
    ];

    it('filters by tab and keyword (title or number)', () => {
        expect(visibleItems(items, 'awaiting').map((item) => item.id)).toEqual(['a', 'c']);
        expect(visibleItems(items, 'awaiting', '登出').map((item) => item.id)).toEqual(['c']);
        expect(visibleItems(items, 'awaiting', '#3').map((item) => item.id)).toEqual(['a']);
        expect(visibleItems(items, 'replied', '登')).toEqual([]);
    });

    it('opens the first of the current tab, shows the empty state, and keeps a viewed thread unless forced', () => {
        const awaiting = visibleItems(items, 'awaiting');
        expect(autoSelectTarget(awaiting, {})).toEqual({ action: 'open', id: 'a' });
        expect(autoSelectTarget([], { currentId: 'a', viewing: true, force: true })).toEqual({ action: 'empty' });
        expect(autoSelectTarget(awaiting, { currentId: 'c', viewing: true })).toEqual({ action: 'keep' });
        expect(autoSelectTarget(awaiting, { currentId: 'c', viewing: true, force: true })).toEqual({ action: 'open', id: 'a' });
        expect(autoSelectTarget(awaiting, { currentId: 'a', viewing: true, force: true })).toEqual({ action: 'keep' });
        expect(autoSelectTarget(visibleItems(items, 'replied'), { currentId: 'a', viewing: false })).toEqual({ action: 'open', id: 'b' });
        expect(EMPTY_THREAD_TEXT).toBe('目前沒有回饋單');
    });
});

describe('對話面板偷看（peek）', () => {
    beforeEach(() => {
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse(OPENED_AT));
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('client peek keeps the thread unread; a normal open marks it read', async () => {
        const seeded = await seedProject();
        const report = await reportWithUnreadMessage(seeded, '有新回覆', 'owner');
        const client = await new Browser().asClient(seeded);
        expect(await unreadOf(client, seeded, report)).toBe(1);

        const peek = await client.get(`/p/${seeded.project.slug}/conversations/${report.public_id}?peek=1`, JSON_HEADERS);
        expect(peek.status).toBe(200);
        expect((await reload('reports', report)).client_last_read_at).toBe(READ_AT);
        expect(await unreadOf(client, seeded, report)).toBe(1);

        const open = await client.get(`/p/${seeded.project.slug}/conversations/${report.public_id}`, JSON_HEADERS);
        expect(open.status).toBe(200);
        expect((await reload('reports', report)).client_last_read_at).toBe(OPENED_AT);
        expect(await unreadOf(client, seeded, report)).toBe(0);
    });

    it('team side is marked read even with peek', async () => {
        const seeded = await seedProject();
        const report = await reportWithUnreadMessage(seeded, '老師新留言', 'reporter');
        const owner = await new Browser().asOwner(seeded);
        expect(await unreadOf(owner, seeded, report)).toBe(1);

        expect((await owner.get(`/p/${seeded.project.slug}/conversations/${report.public_id}?peek=1`, JSON_HEADERS)).status).toBe(200);
        expect((await reload('reports', report)).owner_last_read_at).toBe(OPENED_AT);
        expect(await unreadOf(owner, seeded, report)).toBe(0);
    });

    it('the panel placeholder no longer tells the user to pick from the left', async () => {
        const seeded = await seedProject();
        const html = await (await (await new Browser().asOwner(seeded)).get(`/p/${seeded.project.slug}`)).text();
        expect(html).not.toContain('從左側選一張回饋單查看留言');
        expect(html).toContain('data-chat-placeholder');
    });
});
