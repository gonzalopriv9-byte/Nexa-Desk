import http from 'node:http';

const listenPort = parsePort(process.env.PORT, 3000);
const upstreamHost = process.env.NEXADESK_UPSTREAM_HOST || '127.0.0.1';
const upstreamPort = parsePort(process.env.NEXADESK_UPSTREAM_PORT, 3001);
const upstreamTimeoutMs = parsePort(process.env.NEXADESK_UPSTREAM_TIMEOUT_MS, 15_000);
let lastUpstreamErrorAt = 0;

const server = http.createServer((req, res) => {
  const headers = { ...req.headers };
  const forwardedFor = headers['x-forwarded-for'];
  headers['x-forwarded-for'] = forwardedFor
    ? forwardedFor + ', ' + (req.socket.remoteAddress || 'unknown')
    : (req.socket.remoteAddress || 'unknown');
  headers['x-forwarded-proto'] = headers['x-forwarded-proto'] || 'http';
  headers['x-forwarded-host'] = headers['x-forwarded-host'] || headers.host || '';
  delete headers.connection;

  const upstream = http.request({
    host: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path: req.url,
    headers
  }, (upstreamResponse) => {
    const responseHeaders = { ...upstreamResponse.headers };
    delete responseHeaders.connection;
    delete responseHeaders['keep-alive'];
    delete responseHeaders['transfer-encoding'];
    delete responseHeaders.upgrade;
    res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(res);
  });

  upstream.setTimeout(upstreamTimeoutMs, () => {
    upstream.destroy(new Error('upstream timeout'));
  });
  upstream.on('error', (error) => {
    if (res.headersSent || res.destroyed) return;
    const now = Date.now();
    if (now - lastUpstreamErrorAt > 5000) {
      console.warn('NexaDesk gateway upstream unavailable:', error?.message ?? error);
      lastUpstreamErrorAt = now;
    }
    sendFallback(req, res);
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  req.pipe(upstream);
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\\r\\nConnection: close\\r\\n\\r\\n');
});
server.on('error', (error) => {
  console.error('NexaDesk gateway listener error:', error);
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;
server.listen(listenPort, '0.0.0.0', () => {
  console.log('NexaDesk gateway listening on http://localhost:' + listenPort + ' -> http://' + upstreamHost + ':' + upstreamPort);
});

function sendFallback(req, res) {
  const path = String(req.url || '');
  const wantsJson = (req.method !== 'GET' && req.method !== 'HEAD') || path.startsWith('/api/') || path.startsWith('/health');
  res.statusCode = wantsJson ? 503 : 200;
  res.setHeader('retry-after', '3');
  res.setHeader('cache-control', 'no-store');
  if (wantsJson) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'NexaDesk is starting. Please retry shortly.' }));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(FALLBACK_HTML);
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

const FALLBACK_HTML = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>NexaDesk · Conectando</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;color:#f7f7f7;background:#050505;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,100%);padding:42px;border:1px solid rgba(255,255,255,.16);border-radius:28px;background:linear-gradient(145deg,rgba(255,255,255,.1),rgba(255,255,255,.03));text-align:center;box-shadow:0 30px 100px rgba(0,0,0,.5)}.logo{display:grid;place-items:center;width:58px;height:58px;margin:0 auto 22px;border:1px solid #d6b86a;border-radius:18px;color:#d6b86a;font-size:26px}.eyebrow{margin:0 0 12px;color:#d6b86a;font-size:11px;font-weight:800;letter-spacing:.2em;text-transform:uppercase}.card h1{margin:0 0 12px;font-size:clamp(30px,7vw,54px);letter-spacing:-.07em}.card p{margin:0;color:#aaa;line-height:1.6}.loader{width:160px;height:4px;margin:26px auto 0;overflow:hidden;border-radius:99px;background:rgba(255,255,255,.12)}.loader:after{content:"";display:block;width:45%;height:100%;border-radius:99px;background:#d6b86a;animation:load 1.2s ease-in-out infinite}@keyframes load{0%{transform:translateX(-110%)}100%{transform:translateX(350%)}}</style></head><body><main class="card"><div class="logo">⌁</div><p class="eyebrow">NexaDesk / conexión segura</p><h1>Estamos conectando.</h1><p>El servicio está terminando de arrancar. Esta página se actualizará automáticamente en unos segundos.</p><div class="loader" aria-label="Cargando"></div></main></body></html>';
