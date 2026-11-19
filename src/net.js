'use strict';

// 统一的网络层。
//
// 两条传输通道：
//   1. Electron 的 Chromium 网络栈（session.fetch）——真实浏览器 TLS/HTTP2 指纹、连接复用、Cookie 会话。
//      实测：同样请求 X 公开主页，curl 拿到的页面不含粉丝数（X 按指纹降级），Chromium 拿到的页面含；
//      同一批 YouTube innertube 请求，Chromium 每次 0.52–0.57 秒，curl 进程每次约 1.2 秒。
//   2. curl.exe 子进程——纯 Node 环境（回归脚本）和搜索源（DDG / Brave 对 Chromium 反而更容易弹验证码）使用。
//
// 另外两个全局约束（跨平台共享，避免平台间并行时把同一个站点打爆）：
//   - 同一域名串行：同一时刻只允许一个请求在飞；搜索引擎之间再强制 2 秒间隔。
//   - 429/503 退避：按 Retry-After 或指数退避，让所有平台一起停下来，而不是各自重试。

const { curlRequest, UA, sleep } = require('./util');

const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const JSON_ACCEPT = 'application/json, text/plain, */*';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

let ses = null;
let currentProxy = null;
let logger = () => {};
const controllers = new Set();
const hosts = new Map();

// 备用出口池：搜索引擎按 IP 限流，换一个出口往往立刻恢复。
// 只有被限流时才切，切完清掉所有站点冷却（旧 IP 的退避对新 IP 不成立）。
let proxyPool = [];
let proxyIndex = -1;
let lastRotateAt = 0;

function isElectron() {
  return !!(process.versions && process.versions.electron);
}

function setLogger(fn) {
  logger = typeof fn === 'function' ? fn : () => {};
}

function hostState(host) {
  let st = hosts.get(host);
  if (!st) {
    st = { tail: Promise.resolve(), lastReleasedAt: 0, cooldownUntil: 0, strikes: 0 };
    hosts.set(host, st);
  }
  return st;
}

function stopError() {
  const e = new Error('已停止');
  e.code = 'ESTOP';
  return e;
}

async function sleepChecked(ms, shouldStop) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (shouldStop && shouldStop()) throw stopError();
    await sleep(Math.min(200, Math.max(0, end - Date.now())));
  }
}

// 搜索引擎是全平台共用的稀缺资源：X / Rumble / TikTok / Kick 会同时用，
// 所以同域名不仅不能并发，还要留出比普通页面更长的间隔。
function minGapFor(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'html.duckduckgo.com' || h === 'lite.duckduckgo.com' || h === 'duckduckgo.com') return 2000;
  if (h === 'search.brave.com' || h === 'www.bing.com') return 2000;
  return 0;
}

async function acquireHost(host, opts = {}) {
  const st = hostState(host);
  // 搜索引擎在退避时不要让整个平台陪着等 30–120 秒：直接告诉调用方"还在冷却"，
  // 由发现层决定换源或跳过。普通站点仍然照常等待。
  if (opts.skipCooldown && Date.now() < st.cooldownUntil) {
    const err = new Error('cooldown');
    err.code = 'ECOOL';
    err.leftMs = st.cooldownUntil - Date.now();
    throw err;
  }
  const prev = st.tail;
  let releaseHold;
  const hold = new Promise(resolve => { releaseHold = resolve; });
  st.tail = prev.then(() => hold);
  await prev;
  try {
    while (Date.now() < st.cooldownUntil) {
      const left = st.cooldownUntil - Date.now();
      logger('info', `${host} 限流退避中，约 ${Math.ceil(left / 1000)} 秒后继续`);
      await sleepChecked(left, opts.shouldStop);
    }
    const gap = minGapFor(host);
    const wait = st.lastReleasedAt + gap - Date.now();
    if (wait > 0) await sleepChecked(wait, opts.shouldStop);
  } catch (e) {
    releaseHold();
    throw e;
  }
  return () => {
    st.lastReleasedAt = Date.now();
    releaseHold();
  };
}

function noteThrottle(host, retryAfterSec, status) {
  const st = hostState(host);
  st.strikes++;
  const retryMs = Number(retryAfterSec) > 0 ? Number(retryAfterSec) * 1000 : 0;
  const backoff = Math.min(MAX_BACKOFF_MS, retryMs || 30000 * Math.pow(2, st.strikes - 1));
  st.cooldownUntil = Math.max(st.cooldownUntil, Date.now() + backoff);
  logger('warn', `${host} 返回 ${status}，已让所有平台对该站暂停 ${Math.round(backoff / 1000)} 秒`);
  return st.cooldownUntil - Date.now();
}

function noteOk(host) {
  const st = hostState(host);
  st.strikes = 0;
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const sec = Number(value);
  if (Number.isFinite(sec) && sec > 0) return sec;
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, (when - Date.now()) / 1000) : 0;
}

async function getSession(proxy) {
  if (!isElectron()) return null;
  const { session } = require('electron');
  if (!ses) {
    ses = session.fromPartition('cf-net');
    ses.setUserAgent(UA, 'en-US,en;q=0.9');
  }
  const rule = proxy ? String(proxy) : '';
  if (currentProxy !== rule) {
    await ses.setProxy(rule ? { proxyRules: rule } : { mode: 'direct' });
    currentProxy = rule;
    try { await ses.closeAllConnections(); } catch { /* ignore */ }
  }
  return ses;
}

async function configure(proxy, pool) {
  proxyPool = Array.isArray(pool)
    ? pool.map(String).map(s => s.trim()).filter(Boolean)
    : [];
  proxyIndex = -1;
  lastRotateAt = 0;
  if (!isElectron()) {
    currentProxy = proxy ? String(proxy) : '';
    return;
  }
  await getSession(proxy);
}

// 被限流时切到下一个备用出口。返回是否真的切了。
async function rotateProxy(reason) {
  if (!proxyPool.length) return false;
  if (Date.now() - lastRotateAt < 15000) return false; // 15 秒内不连切第二次
  proxyIndex = (proxyIndex + 1) % proxyPool.length;
  const next = proxyPool[proxyIndex];
  lastRotateAt = Date.now();
  for (const st of hosts.values()) { st.cooldownUntil = 0; st.strikes = 0; }
  try {
    if (isElectron()) await getSession(next);
    else currentProxy = next;
  } catch (e) {
    logger('warn', `切换备用出口失败：${e.message}`);
    return false;
  }
  logger('info', `搜索源被限流，已切换备用出口 #${proxyIndex + 1}（${reason || '429/202'}），并清空旧出口的退避计时`);
  return true;
}

function buildHeaders(method, headers) {
  // 注意：不要把 Sec-Fetch-* / Upgrade-Insecure-Requests 手动塞进来。
  // Chromium 的 fetch 会拒绝这些"浏览器自管"的头（实测 POST 直接 net::ERR_INVALID_ARGUMENT），
  // 由它自己生成反而更像真实浏览器。
  const base = {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: method === 'POST' ? JSON_ACCEPT : HTML_ACCEPT
  };
  return { ...base, ...(headers || {}) };
}

async function fetchChromium(session, method, url, body, headers, opts) {
  const controller = new AbortController();
  controllers.add(controller);
  const timeoutMs = Math.max(1000, Number(opts.timeout || 40) * 1000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await session.fetch(url, {
      method,
      headers: buildHeaders(method, headers),
      body: method === 'POST' ? body : undefined,
      redirect: 'follow',
      credentials: 'include',
      signal: controller.signal
    });
    let text = await res.text();
    if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY);
    return {
      status: res.status,
      body: text,
      retryAfter: parseRetryAfter(res.headers.get('retry-after')),
      error: null
    };
  } catch (e) {
    return {
      status: 0,
      body: '',
      retryAfter: 0,
      error: controller.signal.aborted ? '请求超时' : (e && e.message) || '网络错误'
    };
  } finally {
    clearTimeout(timer);
    controllers.delete(controller);
  }
}

async function request(method, url, body, headers, opts = {}) {
  let host = '';
  try { host = new URL(url).hostname; } catch { host = String(url); }

  let release;
  try {
    release = await acquireHost(host, { shouldStop: opts.shouldStop, skipCooldown: opts.skipCooldown });
  } catch (e) {
    if (e && e.code === 'ECOOL') {
      return { status: 0, body: '', retryAfter: 0, error: '冷却中', cooldownMs: e.leftMs || 0, ms: 0 };
    }
    throw e;
  }
  const startedAt = Date.now();
  try {
    let res;
    if (opts.transport === 'curl' || !isElectron()) {
      const raw = await curlRequest(url, {
        method,
        body,
        headers: { 'Accept-Language': 'en-US,en;q=0.9', ...(headers || {}) },
        proxy: currentProxy,
        timeout: opts.timeout || 40
      });
      res = { status: raw.status, body: raw.body, retryAfter: 0, error: null };
    } else {
      const session = await getSession(currentProxy);
      res = await fetchChromium(session, method, url, body, headers, opts);
    }
    res.ms = Date.now() - startedAt;
    // 搜索引擎的 429/202/403 基本都是按 IP 判的：有备用出口就换一个再试。
    const engineHost = minGapFor(host) > 0;
    if (res.status === 429 || res.status === 503) {
      noteThrottle(host, res.retryAfter, res.status);
      if (engineHost) await rotateProxy(`${host} ${res.status}`);
    } else if (engineHost && (res.status === 202 || res.status === 403)) {
      await rotateProxy(`${host} ${res.status}`);
    } else if (res.status >= 200 && res.status < 400) {
      noteOk(host);
    }
    return res;
  } finally {
    release();
  }
}

function abortAll() {
  for (const c of controllers) {
    try { c.abort(); } catch { /* ignore */ }
  }
  controllers.clear();
}

function resetGates() {
  for (const st of hosts.values()) {
    st.cooldownUntil = 0;
    st.strikes = 0;
  }
}

module.exports = {
  isElectron,
  setLogger,
  configure,
  request,
  abortAll,
  resetGates,
  noteThrottle,
  rotateProxy,
  minGapFor
};
