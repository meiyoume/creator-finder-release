'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const domains = require('./src/domains');
const { Engine } = require('./src/engine');
const { toMarkdown, toCsv } = require('./src/export');
const { todayStamp } = require('./src/util');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_DIR = path.join(__dirname, 'results');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', c => {
      if (failed) return;
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        failed = true;
        chunks.length = 0;
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', e => { if (!failed) { failed = true; reject(e); } });
    req.on('aborted', () => { if (!failed) { failed = true; reject(new Error('请求中断')); } });
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  } catch {
    res.writeHead(400); res.end('bad request'); return;
  }
  if (rel.includes('\0')) { res.writeHead(400); res.end('bad request'); return; }
  const root = path.resolve(PUBLIC_DIR);
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function startServer({ port = 8123, host = '127.0.0.1' } = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const engine = new Engine({ dataDir: DATA_DIR, resultsDir: RESULTS_DIR });
  const clients = new Set();

  let pending = [];
  let flushTimer = null;
  function flushEvents() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    if (!clients.size) return;
    const payload = `data: ${JSON.stringify(batch)}\n\n`;
    for (const c of clients) {
      try { c.write(payload); } catch { clients.delete(c); }
    }
  }

  engine.on('event', event => {
    if (!clients.size) return;
    pending.push(event);
    if (pending.length > 500) pending = pending.slice(-500);
    if (!flushTimer) flushTimer = setTimeout(flushEvents, 40);
  });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400); res.end('bad request');
      return;
    }
    const pathname = url.pathname;

    const origin = req.headers.origin;
    if (origin) {
      let sameHost = false;
      try {
        const o = new URL(origin);
        const host = String(req.headers.host || '');
        sameHost = o.host === host && (o.hostname === '127.0.0.1' || o.hostname === 'localhost');
      } catch { /* ignore */ }
      if (!sameHost) return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
    } else if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      return sendJson(res, 403, { ok: false, error: 'forbidden origin' });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    try {
      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write(`data: ${JSON.stringify({ type: 'state', state: engine.getState() })}\n\n`);
        clients.add(res);
        const hb = setInterval(() => {
          try { res.write(': ping\n\n'); } catch { /* ignore */ }
        }, 20000);
        req.on('close', () => {
          clearInterval(hb);
          clients.delete(res);
          if (!clients.size) pending = [];
        });
        return;
      }

      if (pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, {
          platforms: [
            { id: 'youtube', name: 'YouTube', status: 'ready', note: '搜索 + 活跃核验' },
            { id: 'x', name: 'X / Twitter', status: 'ready', note: '搜索 + 主页核验' },
            { id: 'twitch', name: 'Twitch', status: 'ready', note: '接口读粉丝数' },
            { id: 'kick', name: 'Kick', status: 'ready', note: '接口 + 最近开播' },
            { id: 'rumble', name: 'Rumble', status: 'ready', note: '页面 + 最近更新' },
            { id: 'tiktok', name: 'TikTok', status: 'ready', note: '搜索 + 主页核验' }
          ],
          domains: domains.map(d => ({ id: d.id, name: d.name })),
          defaults: {
            count: 30,
            minFollowers: 5000,
            maxFollowers: 20000,
            activityDays: 90,
            delaySec: 5,
            jitterSec: 1.5,
            pauseEvery: 8,
            pauseSec: 20,
            proxy: 'http://127.0.0.1:7897',
            avoidDuplicates: true,
            excludeBrands: true,
            parallelPlatforms: true,
            maxRequests: 320,
            maxMinutes: 30
          },
          seen: engine.seenCounts(),
          historyTotal: engine.historyTotal(),
          resultsDir: RESULTS_DIR
        });
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, 200, engine.getState());
      }

      if (pathname === '/api/logs' && req.method === 'GET') {
        return sendJson(res, 200, { lines: engine.getLogs(url.searchParams.get('limit')) });
      }

      if (pathname === '/api/history' && req.method === 'GET') {
        return sendJson(res, 200, engine.historySnapshot());
      }

      if (pathname === '/api/start' && req.method === 'POST') {
        if (engine.running) return sendJson(res, 409, { ok: false, error: '已经在运行中' });
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          const tooLarge = e && e.message === '请求体过大';
          return sendJson(res, tooLarge ? 413 : 400, { ok: false, error: e.message || '读取请求失败' });
        }
        let options;
        try { options = body ? JSON.parse(body) : {}; } catch { return sendJson(res, 400, { ok: false, error: 'JSON 格式错误' }); }
        engine.run(options).catch(e => {
          engine.emitEvent({ type: 'error', message: e.message });
        });
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/stop' && req.method === 'POST') {
        engine.stop();
        return sendJson(res, 200, { ok: true });
      }

      if (pathname === '/api/seen/clear' && req.method === 'POST') {
        if (engine.running) return sendJson(res, 409, { ok: false, error: '运行中不能清空' });
        const previousSeen = engine.seen;
        engine.seen = { youtube: {}, x: {}, twitch: {}, kick: {}, rumble: {}, tiktok: {} };
        if (!engine.saveSeen()) {
          engine.seen = previousSeen;
          return sendJson(res, 500, { ok: false, error: '清空后写入失败，请检查磁盘权限' });
        }
        engine.clearCache();
        engine.resetKeywordCursor();
        if (!engine.clearHistory()) {
          engine.seen = previousSeen;
          engine.saveSeen();
          return sendJson(res, 500, { ok: false, error: '历史记录写入失败，请检查磁盘权限' });
        }
        return sendJson(res, 200, { ok: true, seen: engine.seenCounts(), historyTotal: 0 });
      }

      if (pathname === '/api/export' && req.method === 'GET') {
        const format = (url.searchParams.get('format') || 'md').toLowerCase();
        if (!engine.results.length) return sendJson(res, 400, { ok: false, error: '还没有结果' });
        const stamp = todayStamp();
        if (format === 'csv') {
          const content = toCsv(engine.results);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="creators-${stamp}.csv"`,
            'Cache-Control': 'no-store'
          });
          return res.end(content);
        }
        const content = toMarkdown(engine.results, {
          date: stamp,
          note: '筛选口径：粉丝数在设定区间内；优先个人创作者；每个平台内部串行抓取。'
        });
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="creators-${stamp}.md"`,
          'Cache-Control': 'no-store'
        });
        return res.end(content);
      }

      if (pathname === '/api/open-results' && req.method === 'POST') {
        execFile('explorer.exe', [RESULTS_DIR], { windowsHide: true }, () => {});
        return sendJson(res, 200, { ok: true, dir: RESULTS_DIR });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { ok: false, error: 'not found' });
      }

      if (req.method === 'GET') return serveStatic(req, res, pathname);
      res.writeHead(405); res.end('method not allowed');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });

  server.engine = engine;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer({ port: Number(process.env.PORT || 8123) }).then(server => {
    const addr = server.address();
    console.log(`creator-finder running at http://${addr.address}:${addr.port}`);
  }).catch(e => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { startServer };
