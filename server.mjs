// Standalone transport only. No game code, state, credentials, frame parsing or retries.
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'https://donggang-red10-final-preview.gleaming-writer.workers.dev';
export const ENTRY = 'https://red10-network-probe.onrender.com';
export const BUILD = 'render-preview-proxy-20261018';
const upstreamHost = new URL(UPSTREAM).hostname;
const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const forbiddenQuery = /^(?:token|authorization|password|secret)$/i;
const methods = new Set(['GET', 'HEAD', 'POST', 'OPTIONS']);
const codeOnly = error => /^[A-Z][A-Z0-9_]{1,60}$/.test(error?.code || '') ? error.code : 'UPSTREAM_ERROR';

export function permitted(req, origin, websocket = false) {
  if (!methods.has(req.method) || !req.url?.startsWith('/') || req.url.startsWith('//') || /[\\\s\x00-\x1f\x7f]/.test(req.url)) return false;
  if (req.headers.host?.toLowerCase() !== new URL(origin).host) return false;
  for (const header of ['host', 'origin']) {
    const count = (req.rawHeaders || []).filter((name, i) => i % 2 === 0 && name.toLowerCase() === header).length;
    if (count > 1) return false;
  }
  if (req.headers.origin !== undefined && req.headers.origin !== origin) return false;
  const url = new URL(req.url, origin);
  if ([...url.searchParams.keys()].some(key => forbiddenQuery.test(key))) return false;
  const navigation = req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
  if (['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']) && !navigation) return false;
  if ((websocket || !['GET', 'HEAD'].includes(req.method)) && req.headers.origin !== origin) return false;
  if (req.url.startsWith('/api/') && url.search) return false; // Credentials belong in the auth frame, never the URL.
  if (req.method === 'POST' && !/^\/api\/rooms(?:\/[A-Z2-9]{8}\/join)?$/.test(req.url)) return false;
  if (websocket) {
    if (req.method !== 'GET' || !/^\/api\/rooms\/[A-Z2-9]{8}\/ws$/.test(req.url)) return false;
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13') return false;
    if (!/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '')) return false;
  }
  return true;
}

function cleanHeaders(source) {
  const headers = { ...source };
  const nominated = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  for (const name of [...hopHeaders, ...nominated]) delete headers[name];
  return headers;
}
export function upstreamHeaders(req, websocket = false) {
  const headers = cleanHeaders(req.headers);
  for (const key of Object.keys(headers)) {
    if (key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('cf-') || ['x-real-ip', 'referer', 'cookie', 'authorization'].includes(key)) delete headers[key];
  }
  headers.host = upstreamHost;
  // This translation is safe only AFTER permitted() checks the actual public Origin.
  if (req.headers.origin) headers.origin = UPSTREAM;
  if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}
export function downstreamHeaders(source, origin, api = false, websocket = false) {
  const headers = cleanHeaders(source);
  // Current game authentication uses localStorage + WS auth frames, not cookies/CORS.
  for (const key of Object.keys(headers)) if (key === 'set-cookie' || key.startsWith('access-control-')) delete headers[key];
  if (headers.location) {
    const target = new URL(headers.location, UPSTREAM);
    if (target.origin !== UPSTREAM || target.username || target.password) throw new Error('Redirect refused');
    headers.location = origin + target.pathname + target.search + target.hash;
  }
  if (api) headers['cache-control'] = 'no-store';
  headers['referrer-policy'] = 'no-referrer';
  headers['x-content-type-options'] = 'nosniff';
  if (websocket) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}

export function createProxy({ localOnly = false, connect = options => https.request(options), log = record => console.log(JSON.stringify(record)), headerTimeoutMs = 30000 } = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Unsafe TLS environment refused');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
  const sockets = new Set();
  const pending = new Set();
  const record = (event, error) => log({ event, ...(error ? { code: codeOnly(error) } : {}) });
  const origin = () => localOnly ? `http://127.0.0.1:${server.address().port}` : ENTRY;
  const upstream = (req, websocket = false) => {
    const next = connect({ protocol: 'https:', hostname: upstreamHost, servername: upstreamHost, port: 443,
      rejectUnauthorized: true, minVersion: 'TLSv1.2', agent,
      method: req.method, path: req.url, headers: upstreamHeaders(req, websocket) });
    pending.add(next);
    next.once('close', () => pending.delete(next));
    return next;
  };
  const plain = (res, status, text) => {
    if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end(text); }
    else res.destroy();
  };
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 15000, requestTimeout: 30000 }, (req, res) => {
    if (!permitted(req, origin())) return plain(res, 403, 'Entry rejected');
    if (req.url === '/health') {
      if (!['GET', 'HEAD'].includes(req.method)) return plain(res, 405, 'Method not allowed');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ ok: true, mode: 'preview-proxy', build: BUILD, upstreamChecked: false }));
    }
    const next = upstream(req);
    const timer = setTimeout(() => next.destroy(Object.assign(new Error(), { code: 'UPSTREAM_TIMEOUT' })), headerTimeoutMs);
    let failed = false;
    const fail = error => {
      clearTimeout(timer);
      if (failed || res.destroyed) return;
      failed = true;
      record('http_upstream_error', error);
      plain(res, 502, 'Preview upstream unavailable');
      next.destroy();
    };
    next.once('error', fail);
    next.once('response', reply => {
      clearTimeout(timer);
      let headers;
      try { headers = downstreamHeaders(reply.headers, origin(), req.url.startsWith('/api/')); }
      catch { reply.destroy(); return fail(); }
      res.writeHead(reply.statusCode, headers);
      reply.setTimeout(30000, () => reply.destroy(Object.assign(new Error(), { code: 'UPSTREAM_IDLE_TIMEOUT' })));
      reply.once('aborted', () => fail());
      reply.once('error', fail);
      reply.pipe(res);
    });
    req.once('aborted', () => next.destroy());
    req.once('error', () => next.destroy());
    res.once('close', () => { clearTimeout(timer); if (!res.writableFinished) next.destroy(); });
    req.pipe(next);
  });
  const rejectSocket = (socket, status = 502) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
  server.on('upgrade', (req, socket, head) => {
    if (!permitted(req, origin(), true)) return rejectSocket(socket, 403);
    const next = upstream(req, true);
    const timer = setTimeout(() => next.destroy(Object.assign(new Error(), { code: 'WS_HANDSHAKE_TIMEOUT' })), headerTimeoutMs);
    socket.once('close', () => { clearTimeout(timer); next.destroy(); });
    next.once('error', error => { clearTimeout(timer); record('ws_upstream_error', error); socket.destroy(); });
    next.once('response', reply => { clearTimeout(timer); rejectSocket(socket, reply.statusCode >= 400 ? reply.statusCode : 502); reply.resume(); });
    next.once('upgrade', (reply, remote, remoteHead) => {
      clearTimeout(timer);
      const expected = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (reply.headers['sec-websocket-accept'] !== expected || reply.headers.upgrade?.toLowerCase() !== 'websocket') {
        remote.destroy(); return rejectSocket(socket);
      }
      let headers;
      try { headers = downstreamHeaders(reply.headers, origin(), true, true); }
      catch { remote.destroy(); return rejectSocket(socket); }
      sockets.add(remote);
      remote.once('close', () => sockets.delete(remote));
      remote.setTimeout(0); socket.setTimeout(0);
      const lines = Object.entries(headers).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(v => `${key}: ${v}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.once('error', () => remote.destroy());
      remote.once('error', () => socket.destroy());
      socket.once('close', () => remote.destroy());
      remote.once('close', () => socket.destroy());
      socket.pipe(remote); remote.pipe(socket);
    });
    next.end();
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    server, origin,
    listen: (port = 0) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, localOnly ? '127.0.0.1' : '0.0.0.0', () => { server.removeListener('error', reject); resolve(origin()); });
    }),
    stop: async () => {
      for (const request of pending) request.destroy();
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const localOnly = process.argv.includes('--local');
  const port = localOnly ? 0 : Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < (localOnly ? 0 : 1) || port > 65535) throw new Error('Invalid PORT');
  const proxy = createProxy({ localOnly });
  await proxy.listen(port);
  console.log(JSON.stringify({ event: 'proxy_started', build: BUILD, origin: proxy.origin() }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { proxy.stop().catch(() => { process.exitCode = 1; }); });
}
