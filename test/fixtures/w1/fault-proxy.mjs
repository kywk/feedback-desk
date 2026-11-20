// Local fault injector for a real worker and an isolated upstream service.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream';

export function createFaultProxy({ upstream, mode, failures, retryAfter = 2, log = () => {} }) {
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('upstream must be an HTTP(S) origin without credentials');
  if (!['disconnect', 'rate-limit'].includes(mode) || !Number.isSafeInteger(failures) || failures < 1 || !Number.isSafeInteger(retryAfter) || retryAfter < 0) throw new Error('invalid fault configuration');
  let count = 0;
  return http.createServer(async (req, res) => {
    count++;
    const at = new Date().toISOString();
    if (count <= failures) {
      log({ at, attempt: count, fault: mode });
      if (mode === 'disconnect') return req.socket.destroy();
      res.writeHead(429, { 'retry-after': String(retryAfter) });
      return res.end();
    }
    try {
      // Fetch has no streaming request support without duplex; buffer only the small W1 API requests.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 1024 * 1024) throw new Error('request too large');
      const headers = new Headers(req.headers);
      headers.delete('host');
      headers.delete('content-length');
      const url = new URL(req.url, target);
      if (url.origin !== target.origin) throw new Error('invalid request target');
      const response = await fetch(url, { method: req.method, headers, ...(body.length ? { body } : {}), redirect: 'manual' });
      const outputHeaders = Object.fromEntries(response.headers);
      delete outputHeaders['content-encoding'];
      delete outputHeaders['content-length'];
      res.writeHead(response.status, outputHeaders);
      log({ at, attempt: count, status: response.status });
      if (response.body) pipeline(response.body, res, () => {}); else res.end();
    } catch {
      log({ at, attempt: count, fault: 'upstream_error' });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.W1_PROXY_PORT ?? '18877');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    const server = createFaultProxy({ upstream: process.env.W1_UPSTREAM, mode: process.env.W1_FAULT, failures: Number(process.env.W1_FAILURES ?? '1'), retryAfter: Number(process.env.W1_RETRY_AFTER ?? '2'), log: entry => console.log(JSON.stringify(entry)) });
    server.listen(port, '127.0.0.1', () => console.error(`W1 fault proxy listening on 127.0.0.1:${port}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
