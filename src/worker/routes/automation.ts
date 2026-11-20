import { Hono, type HonoRequest } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
    AUTOMATION_STAGES, AutomationError, automationScope, claimAutomationWork, listAutomationEvents,
    recordAutomationIntent, recordAutomationReceipt, renewAutomationWork, saveAutomationProgress, type AutomationScope,
} from '../lib/automation';
import type { AppEnv } from './context';

export const automation = new Hono<AppEnv & { Variables: { automationScope: AutomationScope } }>();
const scopePath = '/:project_slug/:environment';

automation.onError((error, c) => {
    if (error instanceof AutomationError) {
        const headers = error.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined;
        return c.json({ error: error.code, message: error.message }, error.status, headers);
    }
    throw error;
});

automation.use(`${scopePath}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.set('automationScope', await automationScope(c.env.DB, c.req.header('authorization'), c.req.param('project_slug'), c.req.param('environment')));
    await next();
});
automation.use(`${scopePath}/*`, bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => c.json({ error: 'body_too_large', message: '請求內容超出限制。' }, 413),
}));

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const revision = z.number().int().positive();
const data = z.record(z.string(), z.unknown());
const claim = z.strictObject({ worker_id: identifier, scope_revision: identifier });
const lease = claim.extend({
    work_id: identifier,
    report_public_id: identifier,
    report_revision: revision,
    lease_generation: revision,
});
const progress = lease.extend({
    stage: z.enum(AUTOMATION_STAGES),
    progress: data.nullable().optional(),
    retry_at: z.iso.datetime().optional(),
}).refine((input) => input.retry_at === undefined || input.stage === 'queued');
const intent = lease.extend({
    operation_id: identifier,
    correlation_id: identifier,
    operation_type: identifier,
    payload: data,
});
const receipt = lease.extend({ operation_id: identifier, result: data });

async function readInput<T>(request: HonoRequest, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        throw new AutomationError('invalid_request', 400, '請提供 JSON 請求內容。');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new AutomationError('invalid_request', 400, '請求欄位或格式不符。');
    }
    return parsed.data;
}

automation.get(`${scopePath}/events`, async (c) => {
    const after = c.req.query('after') ?? '0';
    const cursor = Number(after);
    if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(cursor)) {
        throw new AutomationError('invalid_cursor', 400, '事件游標格式不符。');
    }
    return c.json(await listAutomationEvents(c.env.DB, c.get('automationScope'), cursor));
});

automation.post(`${scopePath}/claim`, async (c) => {
    const input = await readInput(c.req, claim);
    return c.json(await claimAutomationWork(c.env.DB, c.get('automationScope'), input.worker_id, input.scope_revision));
});

automation.post(`${scopePath}/renew`, async (c) => {
    const input = await readInput(c.req, lease);
    return c.json(await renewAutomationWork(c.env.DB, c.get('automationScope'), input));
});

automation.post(`${scopePath}/progress`, async (c) => {
    const input = await readInput(c.req, progress);
    const retryAt = input.retry_at === undefined ? undefined : new Date(input.retry_at).toISOString();
    return c.json(await saveAutomationProgress(c.env.DB, c.get('automationScope'), input, input.stage, input.progress, retryAt));
});

automation.post(`${scopePath}/operations/intent`, async (c) => {
    const input = await readInput(c.req, intent);
    return c.json(await recordAutomationIntent(c.env.DB, c.get('automationScope'), input, input));
});

automation.post(`${scopePath}/operations/receipt`, async (c) => {
    const input = await readInput(c.req, receipt);
    return c.json(await recordAutomationReceipt(c.env.DB, c.get('automationScope'), input, input.operation_id, input.result));
});
