// Deploy the actual model from the designated private fixture project's immutable commit.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function deployTodoMVC(directory, deploymentId, revision, modelRevision = revision) {
    assert.match(revision, /^[a-f0-9]{40}$/);
    const origin = new URL(process.env.W2_GITLAB_ORIGIN);
    assert.equal(origin.protocol, 'https:');
    const projectId = Number(process.env.W2_GITLAB_PROJECT_ID);
    assert.ok(Number.isSafeInteger(projectId) && projectId > 0);
    const get = async path => {
        const res = await fetch(new URL('/api/v4/projects/' + projectId + path, origin), {
            headers: { 'private-token': process.env.W2_GITLAB_API_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(15000),
        });
        assert.equal(res.status, 200);
        return res.json();
    };
    const project = await get('');
    assert.equal(project.path_with_namespace, process.env.W2_GITLAB_PROJECT_PATH);
    assert.equal(project.visibility, 'private');
    const file = await get('/repository/files/' + encodeURIComponent('examples/javascript-es5/src/model.js') + '?ref=' + revision);
    assert.equal(file.commit_id, revision);
    const bytes = Buffer.from(file.content, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.content_sha256);
    const proof = { deploymentId, artifactRevision: revision, environment: 'gitlab-qa', projectSlug: 'sandbox-todomvc' };
    const tmp = join(directory, randomUUID() + '.json');
    await writeFile(tmp, JSON.stringify({ proof, model: bytes.toString('utf8'), modelRevision }), { flag: 'wx' });
    await rename(tmp, join(directory, 'active.json'));
    return proof;
}

// Create a follow-up change on a fresh, unmerged QA branch. Parent and file content
// are checked against GitLab before the test CI attests the deployed history.
export async function regressOnTestBranch(parent, base) {
    const root = process.env.W2_GITLAB_ORIGIN + '/api/v4/projects/' + Number(process.env.W2_GITLAB_PROJECT_ID);
    const headers = { 'private-token': process.env.W2_GITLAB_API_TOKEN, 'content-type':'application/json' };
    const path = 'examples/javascript-es5/src/model.js';
    const source = await fetch(root + '/repository/files/' + encodeURIComponent(path) + '?ref=' + base, {headers,redirect:'error'});
    assert.equal(source.status,200);
    const original = await source.json();
    assert.equal(original.commit_id,base);
    const response = await fetch(root + '/repository/commits', { method:'POST',headers,redirect:'error',body:JSON.stringify({
        branch:'feedback/w4-regression-' + randomUUID(),start_sha:parent,commit_message:'test: reproduce blank title regression on QA branch',
        actions:[{action:'update',file_path:path,content:original.content,encoding:'base64'}],
    })});
    assert.equal(response.status,201);
    const commit=await response.json();
    assert.deepEqual(commit.parent_ids,[parent]);
    return commit.id;
}
