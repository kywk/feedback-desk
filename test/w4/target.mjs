// Disposable QA site. Each response uses the metadata and the TodoMVC module from one release.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const releaseFile = process.env.W4_RELEASE_FILE;
if (!releaseFile) throw new Error('W4_RELEASE_FILE is required');
const html = '<!doctype html><meta charset="utf-8"><title>TodoMVC deployment test</title><script src="/model.js"></script>';
createServer(async (request, response) => {
    if (request.method !== 'GET') return response.writeHead(405).end();
    try {
        const { model, proof } = JSON.parse(await readFile(releaseFile, 'utf8'));
        const headers = {
            'cache-control': 'no-store',
            'x-whippet-deployment-id': proof.deploymentId,
            'x-whippet-artifact-revision': proof.artifactRevision,
        };
        switch (request.url) {
            case '/': return response.writeHead(200, { ...headers, 'content-type': 'text/html' }).end(html);
            case '/model.js': return response.writeHead(200, { ...headers, 'content-type': 'application/javascript' }).end(model);
            case '/.well-known/deployment.json': return response.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(proof));
            default: return response.writeHead(404, headers).end();
        }
    } catch {
        response.writeHead(503).end('No active release');
    }
}).listen(8080);
