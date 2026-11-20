#!/usr/bin/env node
import { InspectionError } from '../inspection/client.mjs';
import { runDeploymentBridge } from './index.mjs';
import { readBounded } from './outbox.mjs';

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

async function readInput(file, limit, reason) {
    try {
        return await readBounded(file, limit);
    } catch {
        throw new InspectionError(reason);
    }
}

async function main(args, signal) {
    const [command, sourceId, input, signatureFile] = args;
    if (args.length === 1 && command === '--help') {
        process.stdout.write('Usage: node scripts/agents/deployment/cli.mjs [--once | --ingest <sourceId> <manifest.json> <signature-file> | --replay <sourceId> <retestRequestId>]\n');
        return;
    }
    const once = args.length === 1 && command === '--once';
    const ingest = args.length === 4 && command === '--ingest';
    const replay = args.length === 3 && command === '--replay' ? { sourceId, retestRequestId: input } : undefined;
    if (args.length && !once && !ingest && !replay) throw new InspectionError('invalid_arguments');
    const configPath = required('FEEDBACK_DESK_DEPLOYMENT_CONFIG');
    const stateDirectory = required('FEEDBACK_DESK_DEPLOYMENT_STATE_DIR');
    let config;
    try {
        config = JSON.parse(await readBounded(configPath, 256 * 1024));
    } catch {
        throw new InspectionError('deployment_config_invalid');
    }
    const submission = ingest ? {
        sourceId, raw: await readInput(input, 32 * 1024, 'deployment_manifest_invalid'),
        signature: (await readInput(signatureFile, 128, 'deployment_signature_invalid')).toString('utf8').trim(),
    } : undefined;
    await runDeploymentBridge({ config, stateDirectory, signal, log, once, submission, replay,
        pollMs: integerEnv('FEEDBACK_DESK_DEPLOYMENT_POLL_MS', 3000, 3_600_000),
        maxAttempts: integerEnv('FEEDBACK_DESK_DEPLOYMENT_MAX_ATTEMPTS', 3, 10) });
}

const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
    await main(process.argv.slice(2), controller.signal);
} catch (error) {
    if (!controller.signal.aborted) {
        log('deployment_bridge_failed', { reason: error instanceof InspectionError ? error.message : 'deployment_bridge_failed' });
        process.exitCode = 1;
    }
}
