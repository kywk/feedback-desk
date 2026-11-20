import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const workspace = '00000000-0000-4000-8000-000000000001';
export const testId = '10000000-0000-4000-8000-000000000002';
export const versionId = '40000000-0000-4000-8000-000000000004';
export const environment = 'gitlab-qa';
export const component = 'todomvc';
export const projectSlug = 'sandbox-todomvc';
export const whippetOrigin = 'http://127.0.0.1:19931';
export const base = '6b4c0ed422426e0252ed95dd065a2854d204b89c';
export const digest = text => createHash('sha256').update(text).digest('hex');
export const checkKey = 'blank-title';
export const scopeRevision = 'fixture-gitlab-' + base.slice(0,12);

export function gitLabSettings() {
    return {
        instance_id: 'gitlab-todomvc-qa', origin: process.env.W2_GITLAB_ORIGIN,
        project_id: Number(process.env.W2_GITLAB_PROJECT_ID), project_path: process.env.W2_GITLAB_PROJECT_PATH,
        api_token_ref: 'W2_GITLAB_API_TOKEN', push_token_ref: 'W2_GITLAB_PUSH_TOKEN',
        push_username: process.env.W2_GITLAB_PUSH_USERNAME,
    };
}

export async function callWhippet(path, token, body) {
    const res = await fetch(whippetOrigin + path, {
        method: body ? 'POST':'GET', signal: AbortSignal.timeout(8000), redirect: 'error',
        headers: { authorization: 'Bearer ' + token, 'content-type':'application/json' },
        ...(body && { body:JSON.stringify(body) }),
    });
    return { status: res.status, data: await res.json() };
}

export async function eventually(fn, timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        const value = await fn();
        if (value) return value;
        await sleep(750);
    }
    throw Error('Timed out waiting for the W4 acceptance condition');
}

export async function inspect() {
    const route = '/api/inspections/workspaces/' + workspace + '/runs';
    const {status,data} = await callWhippet(route,process.env.WHIPPET_SCHEDULE,{testId,versionId,environment,requestId:randomUUID()});
    assert.equal(status,202,JSON.stringify(data));
    return eventually(async () => {
        const observed = await callWhippet(route + '/' + data.runId, process.env.WHIPPET_BRIDGE);
        if (observed.status === 404) return;
        assert.equal(observed.status,200,JSON.stringify(observed.data));
        return observed.data;
    });
}

export async function runCli(script, args, env) {
    try {
        const {stdout} = await exec(process.execPath,[script,...args],{env:{...process.env,...env},timeout:45000});
        return stdout;
    } catch (e) {
        throw new Error('QA command failed ' + script + ': ' + e.stdout + ' ' + e.stderr);
    }
}

export async function replayInspection(h, observation, dir) {
    const token = process.env.W4_INSPECTION_TOKEN;
    await h.desk.db.batch([
        h.desk.db.prepare('UPDATE automation_scopes SET inspection_ingress=1 WHERE project_id=? AND environment=?').bind(h.a.id,environment),
        h.desk.db.prepare('INSERT OR IGNORE INTO automation_inspection_tokens(token_hash, project_id, environment, source_instance) VALUES (?, ?, ?, ?)').bind(digest(token),h.a.id,environment,'whippet-w4'),
        h.desk.db.prepare('INSERT OR IGNORE INTO automation_inspection_targets(project_id,environment,scope_revision,source_instance,workspace_id,test_id,check_key) VALUES (?,?,?,?,?,?,?)')
            .bind(h.a.id,environment,scopeRevision,'whippet-w4',workspace,testId,checkKey),
    ]);
    const config = join(dir,'inspection.json');
    await writeFile(config,JSON.stringify({whippet_origin:whippetOrigin,feedback_desk_origin:h.desk.url,sources:[{
        source_id:'w4',workspace_id:workspace,whippet_environment:environment,whippet_token_env:'WHIPPET_BRIDGE',
        project_slug:projectSlug,environment,scope_revision:scopeRevision,feedback_desk_token_env:'W4_INSPECTION_TOKEN',
        tests:[{test_id:testId,check_keys:[checkKey]}],
    }]}));
    await runCli('scripts/agents/inspection/cli.mjs',['--replay','w4',observation.runId],{
        FEEDBACK_DESK_INSPECTION_CONFIG:config,FEEDBACK_DESK_INSPECTION_STATE_DIR:join(dir,'inspection-state'),
    });
    const receipt = await h.desk.db.prepare('SELECT report_public_id,linked_at FROM automation_inspection_runs WHERE run_id=?').bind(observation.runId).first();
    assert.ok(receipt?.linked_at);
    return receipt.report_public_id;
}

export async function repair(h, report) {
    for (let n=0;n<2;n++) {
        const step=await h.runWorker({timeoutMs:100000});
        assert.equal(step.code,0,step.output);
    }
    const detail=await (await h.teamGet(report)).json();
    assert.ok(detail.mr?.head_sha,JSON.stringify(detail.work));
    assert.deepEqual(detail.mr.check_results,[{check_id:checkKey,status:'passed'}]);
    return detail.mr;
}

export async function signManifest(dir, sequence, deploymentId, commit, state = 'succeeded', commits = [commit], deploymentEnvironment = environment) {
    const body = {
        schema_version:1,source_id:'w4',project_slug:projectSlug,environment:deploymentEnvironment,deployment_id:deploymentId,component_id:component,
        sequence,occurred_at:new Date().toISOString(),state,
        ...(state === 'succeeded' && {artifact_revision:commit,commit_shas:commits}),
        evidence_ref:'release-' + sequence,
    };
    const bytes=JSON.stringify(body);
    const path=join(dir,'deployment-' + sequence + '.json');
    const sig=path+'.sig';
    await writeFile(path,bytes);
    await writeFile(sig,createHmac('sha256',Buffer.from(process.env.W4_SIGNING_KEY,'hex')).update(bytes).digest('hex')+'\n');
    return {path,sig};
}
