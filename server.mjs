import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROBE_ID = 'red10-network-only-20261018';
const home = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>网络入口测试</title>
<style>body{font:18px/1.7 "Microsoft YaHei","PingFang SC",sans-serif;max-width:680px;margin:36px auto;padding:0 20px;color:#17212b;background:#f6f8fa}h1{font-size:28px}a{display:inline-block;padding:12px 18px;background:#0759b8;color:white;border-radius:8px}small{display:block;margin-top:24px;color:#43515e}</style>
</head><body><h1>测试首页已打开</h1>
<p>这是独立网络探针，未接入《东港红十》游戏。</p>
<p>请在关闭 VPN 后，用微信和普通浏览器分别打开本页，再点击下方链接。</p>
<p><a href="/health">手动打开 /health</a></p>
<p>若显示含有 <strong>"ok":true</strong> 的文字，请记录运营商、Wi-Fi 或手机流量、浏览器及打开时间。</p>
<p>本页不自动刷新，不发送后台保活请求。</p>
<small>探针标识：${PROBE_ID}。首页可达不代表游戏联机已通过。</small>
</body></html>`;

export function createProbeServer() {
  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const send = (status, contentType, body) => {
      res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, 'text/plain; charset=utf-8', 'Method not allowed\n');
    }
    // Only two exact local paths. No forwarding, uploaded files, auth, or game data.
    if (req.url === '/') return send(200, 'text/html; charset=utf-8', home);
    if (req.url === '/health') {
      return send(200, 'application/json; charset=utf-8', JSON.stringify({
        ok: true, probe: PROBE_ID, time: new Date().toISOString(), gameConnected: false,
      }));
    }
    return send(404, 'text/plain; charset=utf-8', 'Not found\n');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createProbeServer();
  server.listen(port, '0.0.0.0', () => console.log(`${PROBE_ID} listening on port ${port}`));
  // Request URLs, IPs, cookies and headers are deliberately not logged by this program.
  server.on('error', () => { console.error('Probe server failed'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
