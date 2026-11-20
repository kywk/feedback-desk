// Fault injection for a real consumer: failures before forwarding or after an upstream commit.
import http from 'node:http';

export async function startProxy(upstream) {
  const target = new URL(upstream);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('QA proxy requires a loopback upstream');
  const events = [], faults = [];
  const server = http.createServer(async (req, res) => {
    const at = Date.now();
    const path = new URL(req.url, target).pathname;
    const faultIndex = faults.findIndex(fault => path.endsWith(fault.path));
    const fault = faultIndex < 0 ? null : faults.splice(faultIndex, 1)[0];
    if (fault?.mode === 'disconnect') { events.push({ at, path, outcome: 'disconnect' }); req.socket.destroy(); return; }
    if (fault?.mode === 'rate-limit') { events.push({ at, path, outcome: '429', retry_after: fault.retryAfter }); res.writeHead(429, { 'retry-after': String(fault.retryAfter) }).end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (body.length > 1024 * 1024) throw new Error('request too large');
      const headers = new Headers(req.headers); headers.delete('host'); headers.delete('content-length');
      const upstreamResponse = await fetch(new URL(req.url, target), { method: req.method, headers, ...(body.length ? { body } : {}), redirect: 'manual' });
      const output = Buffer.from(await upstreamResponse.arrayBuffer());
      if (fault?.mode === 'lost-ack') { events.push({ at, path, outcome: 'lost-ack', upstream_status: upstreamResponse.status }); req.socket.destroy(); return; }
      events.push({ at, path, outcome: String(upstreamResponse.status) });
      const responseHeaders = Object.fromEntries(upstreamResponse.headers); delete responseHeaders['content-length']; delete responseHeaders['content-encoding'];
      res.writeHead(upstreamResponse.status, responseHeaders).end(output);
    } catch { events.push({ at, path, outcome: 'upstream-error' }); if (!res.headersSent) res.writeHead(502); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, events, inject: fault => faults.push(fault), close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
