import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { environments, project, startDesk, testId, workspace } from './desk.mjs';

const versionId = '30000000-0000-4000-8000-000000000004';
const whippet = 'http://127.0.0.1:19831';
const desk = 'http://127.0.0.1:19833';
const runCollection = '/api/inspections/workspaces/' + workspace + '/runs';
const exec = promisify(execFile);

async function request(path, token, body) {
    return fetch(whippet + path, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        ...(body && { body: JSON.stringify(body) }),
    });
}

async function schedule(environment, onQueued) {
    const scheduleToken = process.env['W3_' + environment.toUpperCase() + '_SCHEDULE'];
    const bridgeToken = process.env['W3_' + environment.toUpperCase() + '_BRIDGE'];
    const body = { testId, versionId, environment, requestId: randomUUID() };
    const response = await request(runCollection, scheduleToken, body);
    assert.equal(response.status, 202);
    const { runId } = await response.json();
    const retry = await request(runCollection, scheduleToken, body);
    assert.equal((await retry.json()).runId, runId);
    if (onQueued) await onQueued(runId);
    const end = Date.now() + 120000;
    while (Date.now() < end) {
        const observed = await request(runCollection + '/' + runId, bridgeToken);
        if (observed.ok) {
            const run = await observed.json();
            if (run.finishedAt) return run;
        } else {
            assert.ok([404, 409].includes(observed.status), 'terminal lookup ' + observed.status);
        }
        await pause(800);
    }
    assert.fail('Whippet did not finish Run ' + runId);
}

test('兩個真實巡檢斷言失敗連到同一張團隊單，跨環境分單', { skip: process.env.W3_LIVE !== '1', timeout: 480000 }, async t => {
    const site = process.env.W3_FIXTURE_HTML;
    const initial = await readFile(site);
    t.after(() => writeFile(site, initial));
    const { mf, db } = await startDesk();
    t.after(() => mf.dispose());
    const dir = await mkdtemp(join(tmpdir(),'w3-inspection-'));
    t.after(() => rm(dir,{recursive:true,force:true}));
    const config = join(dir,'bridge.json');
    await writeFile(config, JSON.stringify({
        whippet_origin: whippet, feedback_desk_origin: desk,
        sources: environments.map(env => ({
            source_id: env, workspace_id: workspace, whippet_environment: env,
            whippet_token_env: 'W3_' + env.toUpperCase() + '_BRIDGE',
            project_slug: project, environment: env, scope_revision: 'w3-r1',
            feedback_desk_token_env: 'W3_' + env.toUpperCase() + '_DMZ',
            tests: [{ test_id: testId, check_keys: ['heading'] }],
        })),
    }));
    async function bridge(...args) {
        try {
            await exec(process.execPath,['scripts/agents/inspection/cli.mjs', ...args], {
                env: { ...process.env, FEEDBACK_DESK_INSPECTION_CONFIG:config, FEEDBACK_DESK_INSPECTION_STATE_DIR:join(dir,'state') },
            });
        } catch (error) {
            throw new Error('inspection bridge failed: ' + error.stdout + error.stderr, { cause: error });
        }
    }
    await writeFile(site,'<!doctype html><h1>Ready</h1>');
    const passed = await schedule('qa');
    assert.equal(passed.outcome, 'passed');
    const interrupted = await schedule('qa', async runId => {
        const until = Date.now() + 30000;
        while (Date.now() < until) {
            const { stdout } = await exec('docker', ['ps','--filter','label=whippet.run.id=' + runId,
                '--filter','ancestor=whippet-worker:fd-w3-qa','--format','{{.ID}}']);
            if (/^[0-9a-f]{12}$/.test(stdout.trim())) {
                await exec('docker', ['kill', stdout.trim()]);
                return;
            }
            await pause(100);
        }
        assert.fail('disposable Runner did not start');
    });
    assert.ok(['infrastructure','unverified','cancelled'].includes(interrupted.outcome), JSON.stringify(interrupted));
    await writeFile(site,'<!doctype html><h1>Changed</h1>');
    const failures = [];
    for (const env of ['qa','qa','stage']) {
        const run = await schedule(env);
        assert.equal(run.outcome,'assertion_failed',JSON.stringify(run));
        assert.equal(run.checkKey,'heading');
        failures.push(run);
    }
    await bridge('--once');
    await bridge('--replay','qa',failures[0].runId);
    async function cookie(role, token) {
        const response = await fetch(desk + '/' + role + '/' + project + '/access?token=' + encodeURIComponent(token), { redirect: 'manual' });
        assert.equal(response.status, 302);
        return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    }
    const ownerCookie = await cookie('owner', process.env.W3_DESK_OWNER);
    const clientCookie = await cookie('p', process.env.W3_DESK_CLIENT);
    const rows = [];
    for (const run of failures) {
        const row = await db.prepare('SELECT r.report_public_id, r.linked_at, p.shared_with_client FROM automation_inspection_runs r JOIN reports p ON p.public_id=r.report_public_id WHERE r.run_id=?').bind(run.runId).first();
        assert.ok(row?.linked_at, 'expected successful Whippet link for ' + run.runId);
        assert.equal(row.shared_with_client,0);
        const runView = whippet + '/api/runs/' + run.runId;
        const view = await fetch(runView, { headers: { 'X-Whippet-Admin-Token': process.env.WHIPPET_ADMIN_TOKEN } });
        assert.equal(view.status, 200);
        const url = (await view.json()).feedbackReportUrl;
        assert.equal(url, desk + '/p/' + project + '/reports/' + row.report_public_id);
        const ownerPage = await fetch(url, { headers: { cookie: ownerCookie }, redirect: 'manual' });
        assert.equal(ownerPage.status, 200);
        assert.match(await ownerPage.text(), /Whippet 巡檢失敗/);
        const clientPage = await fetch(url, { headers: { cookie: clientCookie }, redirect: 'manual' });
        assert.ok([302, 303, 403, 404].includes(clientPage.status), 'client must not see the team-only report');
        const anonymous = await fetch(url, { redirect: 'manual' });
        assert.ok([302, 303, 401, 403, 404].includes(anonymous.status));
        rows.push(row.report_public_id);
    }
    assert.equal(rows[0],rows[1]);
    assert.notEqual(rows[1],rows[2]);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM automation_inspection_runs WHERE run_id=?').bind(passed.runId).first('n'),0);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM automation_inspection_runs WHERE run_id=?').bind(interrupted.runId).first('n'),0);
    t.diagnostic(JSON.stringify({pass:passed.runId,interrupted:interrupted.runId,failures:failures.map((r,i)=>({run:r.runId,attempt:r.attemptId,environment:r.environment,report:rows[i]}))}));
});
