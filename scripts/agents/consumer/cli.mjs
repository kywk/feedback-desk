#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScopeAccess } from '../scope/index.mjs';
import { runConsumer } from './index.mjs';
import { QueueError } from './queue.mjs';
import { AnalysisError } from '../../../src/shared/automation-analysis.mjs';
import { createAnalysisHandler } from '../analysis/index.mjs';
import { createTextModelAdapter } from '../analysis/model.mjs';

function log(event, fields = {}) {
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error('missing_env_' + name);
    return value;
}

function integerEnv(name, fallback, max) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
        throw new Error('invalid_env_' + name);
    }
    return Number(value);
}

async function loadHandler(path) {
    if (!path) return undefined;
    try {
        const module = await import(pathToFileURL(resolve(path)).href);
        if (typeof module.handleWork !== 'function') throw new Error();
        return module.handleWork;
    } catch {
        throw new Error('consumer_handler_invalid');
    }
}

async function loadWorkflow(configPath, auditPath) {
    const { FEEDBACK_DESK_ANALYSIS_ADAPTER: adapter, FEEDBACK_DESK_ANALYSIS_MODEL_URL: endpoint,
        FEEDBACK_DESK_ANALYSIS_MODEL: model, FEEDBACK_DESK_ANALYSIS_MODEL_TOKEN: token } = process.env;
    let analyze;
    if (adapter || endpoint || model || token) {
        try {
            if (adapter) {
                const module = await import(pathToFileURL(resolve(adapter)).href);
                if (typeof module.analyze !== 'function') throw new Error();
                analyze = module.analyze;
            } else {
                analyze = createTextModelAdapter({ endpoint, model, token });
            }
        } catch {
            analyze = () => { throw new AnalysisError('analysis_model_config_invalid'); };
        }
    }
    return createAnalysisHandler({
        configPath, auditPath, analyze,
        async runRepair(input) {
            let createRepairHandler;
            try {
                ({ createRepairHandler } = await import('../repair/index.mjs'));
                if (typeof createRepairHandler !== 'function') throw new Error();
            } catch {
                throw new AnalysisError('repair_handler_not_configured');
            }
            return createRepairHandler({ configPath })(input);
        },
    });
}

async function main(args, signal) {
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write('Usage: node scripts/agents/consumer/cli.mjs [--once]\n');
        return;
    }
    const once = args.length === 1 && args[0] === '--once';
    if (args.length && !once) throw new Error('invalid_arguments');
    const baseUrl = required('FEEDBACK_DESK_URL');
    const token = required('FEEDBACK_DESK_AUTOMATION_TOKEN');
    const projectSlug = required('FEEDBACK_DESK_PROJECT_SLUG');
    const environment = required('FEEDBACK_DESK_ENVIRONMENT');
    const scopeRevision = required('FEEDBACK_DESK_SCOPE_REVISION');
    const workerId = required('FEEDBACK_DESK_WORKER_ID');
    const configPath = required('FEEDBACK_DESK_SCOPE_CONFIG');
    const auditPath = required('FEEDBACK_DESK_SCOPE_AUDIT');
    const statePath = required('FEEDBACK_DESK_CONSUMER_STATE');
    if (new Set([configPath, auditPath, statePath].map(path => resolve(path))).size !== 3) {
        throw new Error('consumer_paths_overlap');
    }
    const handleWork = await loadHandler(process.env.FEEDBACK_DESK_CONSUMER_HANDLER);
    const workflow = handleWork ? undefined : await loadWorkflow(configPath, auditPath);
    await runConsumer({
        baseUrl, token, projectSlug, environment, scopeRevision, workerId, statePath,
        scopeAccess: createScopeAccess({ configPath, auditPath }),
        handleWork, workflow, once, signal, log,
        pollMs: integerEnv('FEEDBACK_DESK_POLL_MS', 3000, 3_600_000),
        heartbeatMs: integerEnv('FEEDBACK_DESK_HEARTBEAT_MS', 15_000, 30_000),
        retryBaseMs: integerEnv('FEEDBACK_DESK_RETRY_BASE_MS', 1000, 60_000),
        maxAttempts: integerEnv('FEEDBACK_DESK_MAX_ATTEMPTS', 4, 10),
    });
}

const controller = new AbortController();
function stop() {
    if (controller.signal.aborted) return;
    controller.abort(new Error('worker_stopped'));
    // A trusted handler may still hold timers after cancellation.
    setTimeout(() => process.exit(process.exitCode || 0), 5000).unref();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
    await main(process.argv.slice(2), controller.signal);
} catch (error) {
    if (!controller.signal.aborted) {
        const reason = error instanceof QueueError || /^(?:(?:missing|invalid)_env_FEEDBACK_DESK_[A-Z_]+|consumer_[a-z_]+|invalid_arguments)$/.test(error?.message)
            ? error.message : 'consumer_failed';
        log('consumer_failed', { reason });
        process.exitCode = 1;
    }
}
