import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createProbeServer, PROBE_ID } from './server.mjs';

// Finite loopback check only. This script never contacts Render or Cloudflare.
const server = createProbeServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let checks = 0;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
try {
  await check('homepage: 200, inline resources, no script or remote URL', async () => {
    const response = await fetch(base + '/');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('测试首页已打开'));
    assert.ok(html.includes('href="/health"'));
    assert.doesNotMatch(html, /<script|https?:\/\//i);
  });
  await check('health: live JSON, no game connection, no redirect', async () => {
    const response = await fetch(base + '/health', { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const json = await response.json();
    assert.equal(json.ok, true);
    assert.equal(json.probe, PROBE_ID);
    assert.equal(json.gameConnected, false);
    assert.ok(Math.abs(Date.now() - Date.parse(json.time)) < 10000);
  });
  await check('HEAD supports platform health checks', async () => {
    const response = await fetch(base + '/health', { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
  });
  await check('POST is not accepted', async () => {
    const response = await fetch(base + '/health', { method: 'POST' });
    assert.equal(response.status, 405);
  });
  await check('game API, diagnostics and arbitrary proxy paths are absent', async () => {
    for (const path of ['/api/health', '/api/rooms', '/diagnostics', '/proxy', '/health?target=other']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
  });
  await check('no WebSocket upgrade endpoint', async () => {
    const { request } = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = request(base + '/ws', { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }, res => {
        res.resume(); resolve(res.statusCode);
      });
      req.on('upgrade', (_res, socket) => { socket.destroy(); reject(new Error('Unexpected WebSocket upgrade')); });
      req.on('error', reject);
      req.setTimeout(3000, () => req.destroy(new Error('Timeout')));
      req.end();
    });
    assert.equal(status, 404);
  });
  console.log(`LOCAL_CHECKS=${checks}/6`);
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
