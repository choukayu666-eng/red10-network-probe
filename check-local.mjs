// Finite local checks only; no game, cloud requests, secrets or keepalive job.
import assert from 'node:assert/strict';
import { createProxy, permitted, upstreamHeaders, downstreamHeaders, UPSTREAM, BUILD } from './server.mjs';
const proxy = createProxy({ localOnly: true, connect: () => { throw new Error('Local check must never contact cloud'); } });
const origin = await proxy.listen();
let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`PASS ${name}`); }
const req = (headers = {}) => ({ method: 'POST', url: '/api/rooms', headers: { host: new URL(origin).host, origin, ...headers } });
try {
  await check('Local health identifies candidate without upstream traffic', async () => {
    const response = await fetch(origin + '/health'); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mode: 'preview-proxy', build: BUILD, upstreamChecked: false });
  });
  await check('Health HEAD supported', async () => { const response = await fetch(origin + '/health', { method: 'HEAD' }); assert.equal(response.status, 200); assert.equal(await response.text(), ''); });
  await check('Foreign Origin rejected before cloud connection', async () => { assert.equal((await fetch(origin + '/api/health', { headers: { Origin: 'https://foreign.invalid' } })).status, 403); });
  await check('Only actual same-origin mutation accepted', () => { assert.ok(permitted(req(), origin)); assert.ok(!permitted(req({ origin: undefined }), origin)); assert.ok(!permitted(req({ origin: 'null' }), origin)); });
  await check('Forwarded authority and cookie credentials stripped', () => {
    const headers = upstreamHeaders(req({ 'x-forwarded-host': 'foreign.invalid', cookie: 'test', authorization: 'test' }));
    assert.equal(headers.origin, UPSTREAM); assert.equal(headers.host, new URL(UPSTREAM).host);
    for (const field of ['x-forwarded-host', 'cookie', 'authorization']) assert.equal(headers[field], undefined);
  });
  await check('External redirects refused; same upstream redirected to entry', () => {
    assert.throws(() => downstreamHeaders({ location: 'https://foreign.invalid/' }, origin));
    assert.equal(downstreamHeaders({ location: UPSTREAM + '/diagnostics.html' }, origin).location, origin + '/diagnostics.html');
  });
  console.log(`LOCAL_CHECKS=${count}/6`);
} finally { await proxy.stop(); }
