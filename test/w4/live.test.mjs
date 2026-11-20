import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { harness } from '../w2/harness.mjs';
import { deployTodoMVC, regressOnTestBranch } from './release.mjs';
import { base, checkKey, component, digest, environment, eventually, gitLabSettings, inspect, projectSlug, repair,
    replayInspection, runCli, scopeRevision, signManifest, testId, versionId, whippetOrigin, workspace } from './journey.mjs';

async function holdFirstResult(desk) {
    let holding = true;
    let held;
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, desk);
            assert.equal(url.origin, desk);
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const data = Buffer.concat(chunks);
            if (holding && url.pathname.endsWith('/retest-results')) {
                held = { url, data, token: req.headers.authorization };
                return res.writeHead(503).end();
            }
            const upstream = await fetch(url, {method:req.method,redirect:'error',
                headers:{authorization:req.headers.authorization,'content-type':'application/json'},
                ...(data.length && {body:data})});
            res.writeHead(upstream.status,{'content-type':'application/json'}).end(await upstream.text());
        } catch { res.writeHead(502).end(); }
    });
    await new Promise((ok,fail) => { server.once('error',fail);server.listen(0,'127.0.0.1',ok); });
    return {
        origin:'http://127.0.0.1:'+server.address().port,
        hasResult:()=>Boolean(held),
        resume(){holding=false;},
        hold(){holding=true;held=undefined;},
        async deliverLate(transform = value => value){
            assert.ok(held);
            const r=await fetch(held.url,{method:'POST',headers:{authorization:held.token,'content-type':'application/json'},body:JSON.stringify(transform(JSON.parse(held.data)))});
            assert.equal(r.status,200,await r.clone().text());return r.json();
        },
        close:()=>new Promise(ok=>{server.closeAllConnections();server.close(ok);}),
    };
}

async function register(h, credentials) {
    const db=h.desk.db;
    await db.batch([
        ...[['deployment','w4',credentials.W4_DEPLOY_TOKEN],['retest','whippet-w4',credentials.W4_RETEST_TOKEN]].map(([role,source,token])=>
            db.prepare('INSERT INTO automation_w4_tokens(token_hash,project_id,environment,role,source_instance) VALUES (?,?,?,?,?)')
                .bind(digest(token),h.a.id,environment,role,source)),
        db.prepare('INSERT INTO automation_deployment_sources(project_id,environment,scope_revision,component_id,source_instance) VALUES (?,?,?,?,?)')
            .bind(h.a.id,environment,scopeRevision,component,'w4'),
        ...[['mr','todomvc'],['inspection',null]].map(([kind,repo])=>
            db.prepare('INSERT INTO automation_retest_targets(project_id,environment,scope_revision,component_id,target_kind,repo_id,source_instance,workspace_id,test_id,version_id,check_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
                .bind(h.a.id,environment,scopeRevision,component,kind,repo,'whippet-w4',workspace,testId,versionId,checkKey)),
    ]);
}

test('actual GitLab repair, release, deployment retest and case disposition', {skip:process.env.W4_LIVE!=='1',timeout:900000}, async t=>{
    const releases=resolve(process.env.W4_RELEASES);
    const runs=resolve(process.env.W4_EVIDENCE_DIR);
    await mkdir(runs,{recursive:true,mode:0o700});
    const dir=await mkdtemp(join(runs,'journey-'));
    const prefix=randomUUID();
    const h=await harness({catalogPath:process.env.W2_TODOMVC_CATALOG,gitlab:gitLabSettings(),deskOptions:{port:19933,persistencePath:join(dir,'desk')}});
    t.after(()=>h.close());
    const proxy=await holdFirstResult(h.desk.url);
    t.after(()=>proxy.close());
    const credentials={W4_DEPLOY_TOKEN:'fdd_'+randomBytes(32).toString('hex'),W4_RETEST_TOKEN:'fdr_'+randomBytes(32).toString('hex')};
    await register(h, credentials);
    const config=join(dir,'bridge.json');
    await writeFile(config,JSON.stringify({whippet_origin:whippetOrigin,feedback_desk_origin:proxy.origin,sources:[{
        source_id:'w4',project_slug:projectSlug,environment,scope_revision:scopeRevision,workspace_id:workspace,
        manifest_hmac_key_env:'W4_SIGNING_KEY',deployment_token_env:'W4_DEPLOY_TOKEN',retest_token_env:'W4_RETEST_TOKEN',
        whippet_schedule_token_env:'WHIPPET_SCHEDULE',whippet_read_token_env:'WHIPPET_BRIDGE',components:[{
            component_id:component,proof_url:'http://127.0.0.1:19932/.well-known/deployment.json',
            tests:[{test_id:testId,version_id:versionId,check_keys:[checkKey]}],
        }],
    }]}));
    const cli=(...args)=>runCli('scripts/agents/deployment/cli.mjs',args,{...credentials,FEEDBACK_DESK_DEPLOYMENT_CONFIG:config,
        FEEDBACK_DESK_DEPLOYMENT_STATE_DIR:join(dir,'deployment-state'),FEEDBACK_DESK_DEPLOYMENT_MAX_ATTEMPTS:'1'});
    const intent=id=>h.desk.db.prepare('SELECT * FROM automation_retest_intents WHERE deployment_id=?').bind(id).first();
    const reportStatus=id=>h.desk.db.prepare('SELECT status FROM reports WHERE public_id=?').bind(id).first('status');
    const closePolicy=value=>h.desk.db.prepare('UPDATE automation_policies SET auto_close_inspections=? WHERE project_id=? AND environment=?').bind(value,h.a.id,environment).run();
    const evidence={prefix,deployments:[]};
    async function deploy(n,sha,commits=[sha]){
        const id=prefix+'-'+n;
        await deployTodoMVC(releases,id,sha);
        const manifest=await signManifest(dir,n,id,sha,'succeeded',commits);
        await cli('--ingest','w4',manifest.path,manifest.sig);
        await cli('--ingest','w4',manifest.path,manifest.sig);
        return id;
    }
    async function finish(id){
        const result=await eventually(async()=>{
            await cli('--once');
            const row=await intent(id);
            if (row?.status==='finished')return row;
        });
        const rows=(await h.desk.db.prepare('SELECT report_public_id,outcome,reason FROM automation_retest_report_results WHERE retest_request_id=?')
            .bind(result.retest_request_id).all()).results;
        evidence.deployments.push({id,run:result.run_id,reports:rows});
        return {result,rows};
    }
    // The first incident originates in a real browser exercising the deployed model.
    await deployTodoMVC(releases,prefix+'-base',base);
    const initial=await inspect();assert.equal(initial.outcome,'assertion_failed');
    const first=await replayInspection(h,initial,dir);
    const mr=await repair(h,first);
    evidence.inspection={run:initial.runId,report:first,mr:mr.web_url,commit:mr.head_sha};
    assert.equal(await h.desk.db.prepare('SELECT COUNT(*) AS n FROM automation_retest_intents').first('n'),0);
    const failedEvent=await signManifest(dir,1,prefix+'-failed-ci',mr.head_sha,'failed');
    await cli('--ingest','w4',failedEvent.path,failedEvent.sig);
    assert.equal(await intent(prefix+'-failed-ci'),null);
    const wrongRelease=await signManifest(dir,2,prefix+'-wrong-release',mr.head_sha);
    await assert.rejects(cli('--ingest','w4',wrongRelease.path,wrongRelease.sig));
    assert.equal(await intent(prefix+'-wrong-release'),null);
    const wrongEnvironment=await signManifest(dir,2,prefix+'-wrong-environment',mr.head_sha,'succeeded',[mr.head_sha],'production');
    await assert.rejects(cli('--ingest','w4',wrongEnvironment.path,wrongEnvironment.sig));
    assert.equal(await intent(prefix+'-wrong-environment'),null);
    // Inject a transport-level infrastructure outcome for a real bound Run, then verify fail-closed.
    const environmentErrorId=await deploy(3,mr.head_sha);
    await eventually(async()=>{
        try{await cli('--once');}catch(e){if(!proxy.hasResult())throw e;}
        return proxy.hasResult();
    });
    const environmentError=await proxy.deliverLate(result=>({...result,outcome:'infrastructure',checks:[],evidence_refs:[]}));
    assert.equal(environmentError.receipt.outcome,'needs_review');
    assert.equal(environmentError.receipt.reports[0].outcome,'needs_review');
    assert.notEqual(await reportStatus(first),'completed');
    evidence.environmentError={deployment:environmentErrorId,receipt:environmentError};
    proxy.hold();
    const staleId=await deploy(4,mr.head_sha);
    await eventually(async()=>{
        try{await cli('--once');}catch(e){if(!proxy.hasResult())throw e;}
        return proxy.hasResult();
    });
    assert.notEqual(await reportStatus(first),'completed');
    const early=await intent(staleId);assert.ok(early?.run_id);
    proxy.resume();
    const regression=await regressOnTestBranch(mr.head_sha,base);
    const failed=await finish(await deploy(5,regression,[regression,mr.head_sha]));
    assert.deepEqual(failed.rows,[{report_public_id:first,outcome:'failed',reason:'assertion_failed'}]);
    const late=await proxy.deliverLate();
    assert.equal(late.receipt.outcome,'ignored_stale');
    assert.deepEqual(await proxy.deliverLate(),late);
    assert.notEqual(await reportStatus(first),'completed');
    evidence.late={deployment:staleId,run:early.run_id,receipt:late};
    await closePolicy(1);
    const fixed=await finish(await deploy(6,mr.head_sha));
    assert.deepEqual(fixed.rows.map(row=>row.outcome),['completed']);
    assert.equal(await reportStatus(first),'completed',JSON.stringify(fixed.rows));
    // A customer repair and a fresh pure-inspection recurrence share this release's Run.
    const customer=await h.report('score-10 TodoMVC：空白標題不能建立待辦');
    const customerMr=await repair(h,customer.public_id);
    await deployTodoMVC(releases,prefix+'-recurrence',base);
    const recurring=await inspect();assert.equal(recurring.outcome,'assertion_failed');
    const second=await replayInspection(h,recurring,dir);
    assert.notEqual(second,first);
    await closePolicy(0);
    const shared=await finish(await deploy(7,customerMr.head_sha));
    assert.deepEqual(shared.rows.map(r=>r.report_public_id).sort(),[customer.public_id,second].sort());
    assert.deepEqual(Object.fromEntries(shared.rows.map(row=>[row.report_public_id,row.outcome])),{[customer.public_id]:'waiting_customer',[second]:'verified'});
    assert.notEqual(await reportStatus(second),'completed');
    assert.equal(await reportStatus(customer.public_id),'needs_input');
    const reverseResponse=await h.retestRun(shared.result.run_id);
    assert.equal(reverseResponse.status,200);
    const reverse=await reverseResponse.json();
    assert.equal(reverse.run_id,shared.result.run_id);
    assert.deepEqual(reverse.reports.map(r=>r.report_public_id).sort(),[customer.public_id,second].sort());
    for (const id of [customer.public_id,second]) {
        const detailResponse=await h.teamGet(id);
        assert.equal(detailResponse.status,200);
        const detail=await detailResponse.json();
        assert.ok(detail.retests.some(r=>r.deployment_id===shared.result.deployment_id && r.run_id===shared.result.run_id));
    }
    evidence.reverse={run:reverse.run_id,reports:reverse.reports};
    const response=await h.a.client.post('/p/'+projectSlug+'/reports/'+customer.public_id+'/status',{status:'completed'});
    assert.equal(response.status,302);
    assert.equal(await reportStatus(customer.public_id),'completed');
    evidence.customer={report:customer.public_id,mr:customerMr.web_url,commit:customerMr.head_sha};
    evidence.recurrence={run:recurring.runId,report:second};
    await writeFile(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));
    t.diagnostic(JSON.stringify(evidence));
});
