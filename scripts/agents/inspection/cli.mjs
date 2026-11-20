#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { InspectionError } from './client.mjs';
import { runInspectionBridge } from './index.mjs';

function log(event, fields = {}) {
    process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}

function required(name) {
    const value = process.env[name];
    if (!value) throw new InspectionError('missing_env_' + name);
    return value;
}

function integerEnv(name, fallback, max) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new InspectionError('invalid_env_' + name);
    return Number(value);
}

async function main(args, signal) {
    if (args.length === 1 && args[0] === '--help') {
        process.stdout.write('Usage: node scripts/agents/inspection/cli.mjs [--once | --replay <sourceId> <runId>]\n');
        return;
    }
    const once = args.length === 1 && args[0] === '--once';
    const replay = args.length === 3 && args[0] === '--replay' ? { sourceId: args[1], runId: args[2] } : undefined;
    if (args.length && !once && !replay) throw new InspectionError('invalid_arguments');
    const configPath = required('FEEDBACK_DESK_INSPECTION_CONFIG');
    const stateDirectory = required('FEEDBACK_DESK_INSPECTION_STATE_DIR');
    let config;
    try {
        config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
        throw new InspectionError('inspection_config_invalid');
    }
    await runInspectionBridge({ config, stateDirectory, signal, log, once, replay,
        pollMs: integerEnv('FEEDBACK_DESK_INSPECTION_POLL_MS', 3000, 3_600_000),
        maxAttempts: integerEnv('FEEDBACK_DESK_INSPECTION_MAX_ATTEMPTS', 3, 10) });
}

const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
    await main(process.argv.slice(2), controller.signal);
} catch (error) {
    if (!controller.signal.aborted) {
        log('inspection_failed', { reason: error instanceof InspectionError ? error.message : 'inspection_failed' });
        process.exitCode = 1;
    }
}
