/**
 * 開發團隊請客戶確認完成：只發一則確認留言（附「通過」按鈕），單不會被結案。
 * 網頁、CLI、MCP、團隊 API、巡檢 API 共用這一個函式；已完成只由客戶按「通過」（走原本客戶專用的完成端點）決定。
 */
import { defaultCompletionBody } from '../../shared/completion';
import { charLength } from '../../shared/text';
import { nowIso } from '../../shared/time';
import { config, type Env } from '../env';
import type { Author } from './access';
import type { Report } from './models';
import { addMessageStatements, MAX_MESSAGE } from './reports';
import { ServiceError } from './team';

interface CompletionRequest {
    body?: string | null;
    authorName: string;
    author: Author;
}

export function requestCompletionStatements(env: Env, report: Report, input: CompletionRequest, at: string) {
    const clientLabel = config(env).labels.client;
    if (report.status === 'completed') {
        throw new ServiceError('already_completed', `這張單已經完成，不用再請${clientLabel}確認。`, 422);
    }
    const typed = (input.body ?? '').trim();
    const body = typed === '' ? defaultCompletionBody(clientLabel) : typed;
    if (charLength(body) > MAX_MESSAGE) {
        throw new ServiceError('body_too_long', `留言內容不能超過 ${MAX_MESSAGE} 個字元。`, 422);
    }
    const db = env.DB;
    const message = addMessageStatements(db, report, {
        author_type: 'owner', author_name: input.authorName, body, uploads: [], author: input.author, isCompletionRequest: true,
    }, at);
    return {
        ...message,
        statements: [...message.statements, db.prepare('UPDATE reports SET owner_last_read_at = ? WHERE id = ?').bind(at, report.id)],
    };
}

export async function requestCompletion(env: Env, report: Report, input: CompletionRequest, now = Date.now()) {
    const { statements, status, statusChanged } = requestCompletionStatements(env, report, input, nowIso(now));
    const batch = await env.DB.batch<{ id: number }>(statements);
    const message = batch[0].results[0];
    if (!message) throw new Error('completion message insert returned no id');
    return { id: message.id, status, statusChanged };
}
