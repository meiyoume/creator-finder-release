'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const domains = require('./domains');
const youtube = require('./platforms/youtube');
const xPlatform = require('./platforms/x');
const twitch = require('./platforms/twitch');
const kick = require('./platforms/kick');
const rumble = require('./platforms/rumble');
const tiktok = require('./platforms/tiktok');
const { HistoryStore } = require('./history');
const net = require('./net');
const { Bridge } = require('./bridge');
const { toMarkdown, toCsv } = require('./export');
const {
  StoppedError, Pacer, atomicWriteJson, todayStamp, nowStamp, compactCount, daysToZh
} = require('./util');

const PLATFORM_LABELS = { youtube: 'YouTube', x: 'X/Twitter', twitch: 'Twitch', kick: 'Kick', rumble: 'Rumble', tiktok: 'TikTok' };
const BRAND_RE = /\b(official|shop|store|supply|supplies|magazine|community|agency|company|llc|inc\.?|corporation|network|how-to|howto|media|publishing)\b/i;
// 名字里带这些词的通常是机构/官方账号，不是「小博主」。
// 只检查名字、不检查简介——简介里出现“government / council”是评论内容，不代表账号是机构。
// 英语之外还要覆盖西/葡/法：拉美、南欧的长尾词会大量带出 Ministerio / Cámara / Tribunal 这类官方号。
const ORG_NAME_RE = new RegExp(
  '\\b(' + [
    // 英
    'commission', 'ministry', 'parliament', 'embassy', 'consulate', 'university', 'institute',
    'foundation', 'association', 'council', 'department', 'presidency', 'senate', 'unicef',
    'united nations', 'world bank', 'european union',
    // 西
    'ministerio', 'camara', 'cámara', 'congreso', 'diputados', 'tribunal', 'cancilleria',
    'cancillería', 'embajada', 'consulado', 'presidencia', 'vicepresidencia', 'gobernacion',
    'gobernación', 'alcaldia', 'alcaldía', 'municipalidad', 'prefectura', 'fiscalia', 'fiscalía',
    'contraloria', 'contraloría', 'procuraduria', 'procuraduría', 'oficial',
    // 葡
    'ministério', 'câmara', 'senado', 'presidência', 'governo', 'prefeitura',
    // 法
    'ministère', 'assemblée', 'sénat', 'présidence', 'mairie', 'gouvernement'
  ].join('|') + ')\\b', 'i'
);
const PROFILE_CACHE_TTL = 12 * 3600 * 1000;
const ACTIVITY_CACHE_TTL = 6 * 3600 * 1000;
const DISCOVERY_CACHE_TTL = 12 * 3600 * 1000;
const CACHE_PLATFORMS = ['youtube', 'youtube-activity', 'x', 'twitch', 'kick', 'rumble', 'tiktok', 'tiktok-discovery'];
// 连续几个关键词都拿不到「区间内且未见过」的候选，就认为这个平台的词表已抓空。
// 实测：geopolitics analysis 前两页 40 个频道全部在 2 万粉以上，后面再搜也只是白等。
const DRY_LIMIT = { youtube: 4, x: 3, twitch: 4, kick: 3, rumble: 3, tiktok: 3 };

class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

function clamp(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) n = min;
  return Math.max(min, Math.min(max, n));
}

function safeUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function safeKey(id) {
  const key = String(id == null ? '' : id);
  return key && key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

// 搜索摘要的粉丝数可能过期（实测 14.6K -> 35.7K），只能用来跳过“明显离谱”的候选：
// 低于下限一半或高于上限 2 倍的才跳过；接近边界的仍然打开主页核验。
const HINT_LOW_FACTOR = 0.5;
const HINT_HIGH_FACTOR = 2;

function hintClearlyOutOfRange(value, min, max) {
  if (!Number.isFinite(value)) return false;
  return value < min * HINT_LOW_FACTOR || value > max * HINT_HIGH_FACTOR;
}

function isBrandAccount(name, description) {
  return BRAND_RE.test(`${name || ''} ${description || ''}`) || ORG_NAME_RE.test(String(name || ''));
}

class Engine extends EventEmitter {
  constructor({ dataDir, resultsDir }) {
    super();
    this.dataDir = dataDir;
    this.resultsDir = resultsDir;
    this.logs = [];
    this.logDir = path.join(dataDir, 'logs');
    this.logStream = null;
    this.seenFile = path.join(dataDir, 'seen.json');
    this.seen = this.loadSeen();
    this.cacheFile = path.join(dataDir, 'cache.json');
    this.cache = this.loadCache();
    this.cacheTimer = null;
    this.cacheDirty = false;
    this.cacheSaveErrorLogged = false;
    this.history = new HistoryStore({
      file: path.join(dataDir, 'history.json'),
      resultsDir
    });
    this.history.importSeen(this.seen);
    this.running = false;
    this.stopped = false;
    this.results = [];
    this.resultKeys = new Set();
    this.requestCount = 0;
    this.children = new Set();
    this.userStopped = false;
    this.startTime = 0;
    this.endTime = 0;
    this.lastResultBase = null;
    this.resultBase = null;
    this.resultSaveTimer = null;
    this.resultSaveErrorLogged = false;
    this.seenTimer = null;
    this.platformFailures = new Map();
    this.platformSuccesses = new Set();
    this.platformHalted = new Set();
    this.platformCooldowns = new Set();
    // 关键词轮换：每次从上次停下的位置继续，避免每天都从同一批词开始、
    // 搜回来的人全在「已见」里，后面的新词永远轮不到。
    this.cursorFile = path.join(dataDir, 'keyword-cursor.json');
    this.cursorTimer = null;
    this.keywordCursor = this.loadKeywordCursor();
  }

  loadKeywordCursor() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cursorFile, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  saveKeywordCursor() {
    try {
      atomicWriteJson(this.cursorFile, this.keywordCursor, false);
    } catch { /* 轮换位置写不进去不影响运行 */ }
  }

  cursorKey(platformId, domain) {
    return `${platformId}:${domain.id}`;
  }

  cursorIndex(platformId, domain, length) {
    if (!length) return 0;
    const raw = Number(this.keywordCursor[this.cursorKey(platformId, domain)]) || 0;
    return ((raw % length) + length) % length;
  }

  advanceCursor(platformId, domain, length) {
    if (!length) return;
    const key = this.cursorKey(platformId, domain);
    this.keywordCursor[key] = (this.cursorIndex(platformId, domain, length) + 1) % length;
    // 每走一个词就防抖落盘：中途关掉软件也不会把轮换位置丢掉。
    if (!this.cursorTimer) {
      this.cursorTimer = setTimeout(() => {
        this.cursorTimer = null;
        this.saveKeywordCursor();
      }, 1500);
      if (this.cursorTimer.unref) this.cursorTimer.unref();
    }
  }

  resetKeywordCursor() {
    this.keywordCursor = {};
    this.saveKeywordCursor();
  }

  loadSeen() {
    const empty = { youtube: {}, x: {}, twitch: {}, kick: {}, rumble: {}, tiktok: {} };
    try {
      const data = JSON.parse(fs.readFileSync(this.seenFile, 'utf8'));
      const pick = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
      return {
        youtube: pick(data.youtube),
        x: pick(data.x),
        twitch: pick(data.twitch),
        kick: pick(data.kick),
        rumble: pick(data.rumble),
        tiktok: pick(data.tiktok)
      };
    } catch {
      return empty;
    }
  }

  loadCache() {
    const empty = Object.create(null);
    for (const p of CACHE_PLATFORMS) empty[p] = Object.create(null);
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      for (const p of CACHE_PLATFORMS) {
        const src = data && data[p];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        for (const [key, value] of Object.entries(src)) {
          if (!safeKey(key) || !value || typeof value !== 'object' || !value.data) continue;
          empty[p][key] = value;
        }
      }
    } catch { /* 没有缓存或缓存损坏，按空缓存处理 */ }
    return empty;
  }

  saveCache() {
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
    if (!this.cacheDirty) return;
    try {
      for (const p of CACHE_PLATFORMS) {
        const entries = Object.entries(this.cache[p] || {});
        if (entries.length <= 4000) continue;
        entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (let i = 0; i < entries.length - 4000; i++) delete this.cache[p][entries[i][0]];
      }
      atomicWriteJson(this.cacheFile, this.cache, false);
      this.cacheDirty = false;
      this.cacheSaveErrorLogged = false;
    } catch (e) {
      if (!this.cacheSaveErrorLogged) {
        this.cacheSaveErrorLogged = true;
        this.log('error', `保存核验缓存失败：${e.message}`);
      }
    }
  }

  scheduleCacheSave() {
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.saveCache();
    }, 1500);
    if (this.cacheTimer.unref) this.cacheTimer.unref();
  }

  cacheEntry(platform, key, ttlMs) {
    if (!safeKey(key)) return null;
    const bucket = this.cache[platform];
    const entry = bucket && bucket[key];
    if (!entry || !entry.at || !entry.data || Date.now() - entry.at > ttlMs) return null;
    return entry;
  }

  cachePut(platform, key, data) {
    if (!safeKey(key) || !data || data.error) return;
    if (!this.cache[platform]) this.cache[platform] = Object.create(null);
    const copy = { ...data };
    if (copy.activityDays != null && Number.isFinite(copy.activityDays) && copy.latestAt == null) {
      copy.latestAt = Date.now() - copy.activityDays * 86400000;
    }
    this.cache[platform][key] = { at: Date.now(), data: copy };
    this.cacheDirty = true;
    this.scheduleCacheSave();
  }

  refreshCachedProfile(entry) {
    const data = { ...entry.data };
    const elapsedDays = Math.max(0, (Date.now() - (entry.at || Date.now())) / 86400000);
    if (data.activityDays != null && Number.isFinite(data.activityDays)) {
      data.activityDays += elapsedDays;
      data.latest = daysToZh(data.activityDays);
    }
    if (Number.isFinite(data.latestAt)) data.latestRaw = new Date(data.latestAt).toISOString();
    return data;
  }

  async cachedProfile(platform, key, fn) {
    const entry = this.cacheEntry(platform, key, PROFILE_CACHE_TTL);
    if (entry) {
      this.log('debug', `缓存命中：${PLATFORM_LABELS[platform] || platform} · ${key}`);
      return this.refreshCachedProfile(entry);
    }
    const data = await this.attempt(fn);
    if (data && !data.error) this.cachePut(platform, key, data);
    return data;
  }

  async cachedActivity(channel, fn) {
    const entry = this.cacheEntry('youtube-activity', channel.id, ACTIVITY_CACHE_TTL);
    if (entry && Number.isFinite(entry.data.latestAt)) {
      const ageDays = Math.max(0, (Date.now() - entry.data.latestAt) / 86400000);
      return {
        ok: true,
        ageDays,
        ageText: daysToZh(ageDays),
        ageTextZh: daysToZh(ageDays),
        latestTitle: entry.data.latestTitle || '',
        latestAt: entry.data.latestAt
      };
    }
    const act = await this.attempt(fn);
    if (act && act.ok && Number.isFinite(act.latestAt)) {
      this.cachePut('youtube-activity', channel.id, {
        ok: true,
        latestAt: act.latestAt,
        latestTitle: act.latestTitle || ''
      });
    }
    return act;
  }

  clearCache() {
    this.cache = Object.create(null);
    for (const p of CACHE_PLATFORMS) this.cache[p] = Object.create(null);
    this.cacheDirty = true;
    this.saveCache();
  }

  historyTotal() {
    return this.history.total();
  }

  historySnapshot() {
    return this.history.snapshot();
  }

  clearHistory() {
    return this.history.clear();
  }

  saveSeen() {
    if (this.seenTimer) {
      clearTimeout(this.seenTimer);
      this.seenTimer = null;
    }
    try {
      atomicWriteJson(this.seenFile, this.seen, false);
      return true;
    } catch (e) {
      this.log('error', `保存去重记录失败：${e.message}`);
      return false;
    }
  }

  markPlatformFailure(platformId, message) {
    const cur = this.platformFailures.get(platformId) || { count: 0, message: '' };
    cur.count++;
    if (message) cur.message = message;
    this.platformFailures.set(platformId, cur);
  }

  markPlatformSuccess(platformId) {
    this.platformSuccesses.add(platformId);
  }

  // 搜索引擎（Brave / DDG）被按 IP 限流时，X / Rumble / TikTok 都是同一处境：
  // 记成「冷却」而不是「出错」，整轮只说一次，后面不再逐词重试。
  discoveryCooldown(platformId, label, found, opts = {}) {
    if (!found || !found.cooldown) return false;
    const minutes = Number(found.cooldownMinutes) || 10;
    if (opts.soft) {
      // 软跳过：搜索引擎在冷却，但这个平台还能靠跨平台桥接拿到候选。
      // 不再整轮拉黑它，只是本关键词返回空，下一个关键词再看有没有新桥接候选。
      // 平台卡仍标「冷却」（这是事实），但后台继续跑。
      this.platformCooldowns.add(platformId);
      this.softCooldowns = this.softCooldowns || new Set();
      if (!this.softCooldowns.has(platformId)) {
        this.softCooldowns.add(platformId);
        this.log('info', `${label} 的搜索源被限流（Brave / DDG 冷却约 ${minutes} 分钟），先靠跨平台推荐继续，有候选就核验`);
      }
      return false;
    }
    this.platformHalted.add(platformId);
    this.platformCooldowns.add(platformId);
    this.log('warn', `${label} 的搜索源被限流（Brave / DDG 冷却约 ${minutes} 分钟），本次运行跳过 ${label}；等冷却结束或更换代理出口后再试`);
    return true;
  }

  hardFailedPlatforms() {
    return [...this.platformFailures.keys()].filter(id => !this.platformSuccesses.has(id));
  }

  // 每一轮把候选的去向都记下来：没有新增时，用户要能一眼看出
  // 是「都太大」「都见过」还是「都停更」，而不是只看到 0/30。
  funnelAdd(platformId, stats) {
    if (!stats) return;
    const cur = this.funnel[platformId] || {
      queries: 0, candidates: 0, noFollowers: 0, outOfRange: 0,
      seen: 0, brand: 0, stale: 0, checked: 0, inRangeUnseen: 0, added: 0
    };
    cur.queries++;
    for (const k of ['candidates', 'noFollowers', 'outOfRange', 'seen', 'brand', 'stale', 'checked', 'inRangeUnseen', 'added']) {
      cur[k] += Number(stats[k]) || 0;
    }
    this.funnel[platformId] = cur;
  }

  funnelSummary(platformId) {
    const f = this.funnel[platformId];
    if (!f) return '';
    const parts = [`跑了 ${f.queries} 个关键词`, `候选 ${f.candidates}`];
    if (f.noFollowers) parts.push(`无粉丝数 ${f.noFollowers}`);
    if (f.outOfRange) parts.push(`区间外 ${f.outOfRange}`);
    if (f.seen) parts.push(`已见 ${f.seen}`);
    if (f.brand) parts.push(`机构 ${f.brand}`);
    if (f.stale) parts.push(`停更 ${f.stale}`);
    parts.push(`新增 ${f.added}`);
    return parts.join('，');
  }

  scheduleSeenSave() {
    if (this.seenTimer) return;
    this.seenTimer = setTimeout(() => {
      this.seenTimer = null;
      this.saveSeen();
    }, 1200);
    if (this.seenTimer.unref) this.seenTimer.unref();
  }

  seenCounts() {
    return {
      youtube: Object.keys(this.seen.youtube || {}).length,
      x: Object.keys(this.seen.x || {}).length,
      twitch: Object.keys(this.seen.twitch || {}).length,
      kick: Object.keys(this.seen.kick || {}).length,
      rumble: Object.keys(this.seen.rumble || {}).length,
      tiktok: Object.keys(this.seen.tiktok || {}).length
    };
  }

  isSeen(platform, id) {
    if (!safeKey(id)) return false;
    return !!(this.seen[platform] && this.seen[platform][id]);
  }

  markSeen(platform, id, item) {
    if (!safeKey(id)) return;
    if (!this.seen[platform]) this.seen[platform] = {};
    if (!this.seen[platform][id]) {
      this.seen[platform][id] = { name: item.name, firstSeen: todayStamp() };
      this.scheduleSeenSave();
    }
  }

  emitEvent(event) {
    this.emit('event', event);
  }

  log(level, text) {
    const line = { t: new Date().toISOString(), level, text: String(text == null ? '' : text) };
    // 日志同时留一份在内存和 data/logs/ 里：出问题时不用开着 DevTools 也能查。
    this.logs.push(line);
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
    try {
      if (!this.logStream) {
        fs.mkdirSync(this.logDir, { recursive: true });
        const day = line.t.slice(0, 10);
        this.logStream = fs.createWriteStream(path.join(this.logDir, `${day}.log`), { flags: 'a' });
        this.logStream.on('error', () => { this.logStream = null; });
      }
      const hhmmss = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      this.logStream.write(`${line.t.slice(0, 10)} ${hhmmss} [${level}] ${line.text}\n`);
    } catch { /* 日志写不进去不影响主流程 */ }
    this.emitEvent({ type: 'log', level, text });
  }

  getLogs(limit) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 300));
    return this.logs.slice(-n);
  }

  normalizeOptions(raw = {}) {
    const platforms = (Array.isArray(raw.platforms) ? raw.platforms : ['youtube'])
      .filter(p => PLATFORM_LABELS[p]);
    const domainIds = (Array.isArray(raw.domains) ? raw.domains : [])
      .filter(id => domains.some(d => d.id === id));
    const minFollowers = clamp(raw.minFollowers == null ? 5000 : raw.minFollowers, 0, 1e9);
    const maxFollowers = clamp(raw.maxFollowers == null ? 20000 : raw.maxFollowers, 1, 1e9);
    return {
      platforms: platforms.length ? platforms : ['youtube'],
      domains: domainIds.length ? domainIds : [domains[0].id],
      count: clamp(raw.count == null ? 30 : raw.count, 1, 200),
      minFollowers: Math.min(minFollowers, maxFollowers),
      maxFollowers: Math.max(minFollowers, maxFollowers),
      activityDays: clamp(
        raw.activityDays != null
          ? raw.activityDays
          : (raw.activityMonths == null ? 90 : raw.activityMonths * 30.44),
        0,
        3650
      ),
      delaySec: clamp(raw.delaySec == null ? 5 : raw.delaySec, 3, 120),
      jitterSec: clamp(raw.jitterSec == null ? 1.5 : raw.jitterSec, 0, 30),
      pauseEvery: clamp(raw.pauseEvery == null ? 8 : raw.pauseEvery, 0, 100),
      pauseSec: clamp(raw.pauseSec == null ? 20 : raw.pauseSec, 0, 600),
      proxy: raw.proxy === undefined ? 'http://127.0.0.1:7897' : String(raw.proxy).trim(),
      avoidDuplicates: raw.avoidDuplicates !== false,
      excludeBrands: raw.excludeBrands !== false,
      parallelPlatforms: raw.parallelPlatforms !== false,
      maxRequests: clamp(raw.maxRequests == null ? 320 : raw.maxRequests, 10, 3000),
      maxMinutes: clamp(raw.maxMinutes == null ? 30 : raw.maxMinutes, 1, 240),
      // 备用出口：每行一个，被搜索源限流时自动轮换（依赖 Clash 多节点时最有用）
      proxyPool: (Array.isArray(raw.proxyPool)
        ? raw.proxyPool
        : String(raw.proxyPool || '').split(/[\r\n,;]+/))
        .map(s => String(s).trim())
        .filter(p => p && p !== String(raw.proxy || '').trim()),
      // 可选：Brave Search API key（免费额度约 1000 次/月）。填了就不再抓网页。
      braveKey: String(raw.braveKey || '').trim(),
      // 回归测试里关掉：seedPass 会真的发 YouTube 请求
      seedPass: raw.seedPass !== false
    };
  }

  async run(rawOptions) {
    if (this.running) throw new Error('已经在运行中');
    const opts = this.normalizeOptions(rawOptions);
    this.opts = opts;
    this.target = opts.count;
    this.running = true;
    this.stopped = false;
    this.userStopped = false;
    this.results = [];
    this.resultKeys = new Set();
    this.requestCount = 0;
    this.children.clear();
    net.abortAll();
    net.setLogger((level, text) => this.log(level, text));
    this.startTime = Date.now();
    this.endTime = 0;
    this.lastResultBase = null;
    this.resultBase = path.join(this.resultsDir, `results-${nowStamp()}`);
    this.resultSaveErrorLogged = false;
    if (this.resultSaveTimer) {
      clearTimeout(this.resultSaveTimer);
      this.resultSaveTimer = null;
    }
    this.platformFailures = new Map();
    this.platformSuccesses = new Set();
    this.platformHalted = new Set();
    this.platformCooldowns = new Set();
    this.platformDried = new Set();
    this.funnel = Object.create(null);
    // 跨平台桥接：A 平台资料里的外链 → B 平台候选。搜索引擎被限流时这是主力来源。
    this.bridge = new Bridge();
    this.seedPromise = null;
    // 只有在还要找 X / TikTok / Rumble 时才值得多花请求去翻频道「关于」页
    this.needsBridge = opts.platforms.some(p => p === 'x' || p === 'tiktok' || p === 'rumble');
    this.aboutBudget = this.needsBridge ? 8 : 0;

    this.emitEvent({
      type: 'start',
      options: opts,
      platforms: opts.platforms.map(p => PLATFORM_LABELS[p]),
      domains: opts.domains.map(id => (domains.find(d => d.id === id) || {}).name),
      target: opts.count
    });
    const parallel = opts.parallelPlatforms && opts.platforms.length > 1;
    this.log('info', `开始：目标 ${opts.count} 个；平台 ${opts.platforms.map(p => PLATFORM_LABELS[p]).join(' / ')}；领域 ${opts.domains.map(id => (domains.find(d => d.id === id) || {}).name || id).join(' / ')}；每个平台请求间隔 ${opts.delaySec} 秒，从上一次请求结束起算（平台内串行${parallel ? '，平台间并行' : ''}）`);

    let reason = 'exhausted';
    try {
      const domainObjs = opts.domains.map(id => domains.find(d => d.id === id)).filter(Boolean);

      // 配了代理就先做一次连通性探测（约 1 秒，最长等 8 秒）：
      // 代理挂了直接给出明确报错，而不是每个平台各自白等 40 秒超时。
      // 探测走和正式请求同一条传输通道，避免"探测能通、正式请求不通"。
      await net.configure(opts.proxy, opts.proxyPool);
      this.log('info', `网络通道：${net.isElectron() ? 'Chromium 浏览器栈（真实 TLS/HTTP2、Cookie 会话）' : 'curl'}${opts.proxyPool.length ? `；备用出口 ${opts.proxyPool.length} 个（搜索源被限流时自动轮换）` : ''}${opts.braveKey ? '；使用 Brave Search API' : ''}`);
      let proxyDead = null;
      if (opts.proxy) {
        this.log('info', `检查代理 ${opts.proxy} 连通性…`);
        try {
          const probe = await net.request('GET', 'https://www.gstatic.com/generate_204', null, {}, {
            timeout: 8,
            shouldStop: () => this.stopped
          });
          if (probe.status === 0 || probe.status === 407 || probe.status >= 500) {
            proxyDead = `代理无法访问外网（探测返回 HTTP ${probe.status}）`;
          }
        } catch (e) {
          if (e && e.code === 'ESTOP') throw new StoppedError();
          proxyDead = `代理不可用（${e.message}）`;
        }
      }

      if (proxyDead) {
        reason = 'error';
        const message = `${proxyDead}。请确认代理已启动，或把代理一栏清空改用直连。`;
        this.log('error', message);
        this.emitEvent({ type: 'error', message });
      } else {
        const startWorker = platformId =>
          this.runPlatform(platformId, domainObjs, opts).catch(e => {
            if (!(e instanceof StoppedError)) {
              if (e instanceof BudgetError) {
                this.stopped = true;
                this.log('warn', e.message);
              } else {
                this.log('error', `${PLATFORM_LABELS[platformId]} 出错：${e.message}`);
              }
            }
            throw e;
          });

        // 只选了 X / TikTok / Rumble 的时候，搜索引擎被限流就等于整轮 0 个。
        // YouTube 的搜索和 RSS 都不依赖搜索引擎，所以先在后台捞一批
        // 「创作者公开资料里写着的其它平台账号」当种子，边跑边喂给这些平台。
        const needsSeeds = opts.platforms.some(p => p === 'x' || p === 'tiktok' || p === 'rumble');
        if (needsSeeds && !opts.platforms.includes('youtube') && opts.seedPass) {
          // 把 promise 存下来：X / TikTok 在种子还没到位时会先等它一会儿，
          // 否则它们会在几秒内把关键词全部空跑完，整轮直接结束（实测 40 秒 0 个）。
          this.seedPromise = this.runSeedPass(domainObjs, opts);
          this.seedWorker = this.seedPromise.catch(e => {
            this.log('debug', `跨平台种子采集失败：${e.message}`);
          });
        }

        const settled = [];
        if (parallel) {
          const workers = opts.platforms.map(startWorker);
          settled.push(...await Promise.allSettled(workers));
        } else {
          for (const platformId of opts.platforms) {
            try { await startWorker(platformId); settled.push({ status: 'fulfilled' }); }
            catch (e) { settled.push({ status: 'rejected', reason: e }); }
          }
        }
        const rejected = settled.filter(r => r.status === 'rejected');
        const budgetFailed = rejected.find(r => r.reason instanceof BudgetError);
        const hardFailed = this.hardFailedPlatforms();
        if (this.results.length >= opts.count) reason = 'target';
        else if (this.userStopped) reason = 'stopped';
        else if (budgetFailed) reason = 'budget';
        else if (hardFailed.length && hardFailed.length === opts.platforms.length && !this.results.length) {
          reason = 'error';
          const first = this.platformFailures.get(hardFailed[0]);
          this.emitEvent({
            type: 'error',
            message: `${PLATFORM_LABELS[hardFailed[0]]} 搜索失败：${first?.message || '未知错误'}`
          });
        } else if (hardFailed.length || rejected.length) {
          reason = 'partial';
        }
      }
    } catch (e) {
      if (e instanceof StoppedError) reason = 'stopped';
      else if (e instanceof BudgetError) { reason = 'budget'; this.log('warn', e.message); }
      else { reason = 'error'; this.log('error', e.message); this.emitEvent({ type: 'error', message: e.message }); }
    } finally {
      this.running = false;
      this.stopped = true;
      this.endTime = Date.now();
      this.children.clear();
      if (this.resultSaveTimer) {
        clearTimeout(this.resultSaveTimer);
        this.resultSaveTimer = null;
      }
      this.saveSeen();
      this.saveCache();
      this.saveKeywordCursor();
      if (!this.history.save()) this.log('error', '保存历史记录失败');
      this.results.sort((a, b) => {
        const da = a.activityDays == null ? Infinity : a.activityDays;
        const db = b.activityDays == null ? Infinity : b.activityDays;
        return da - db;
      });
      this.saveResults();
      this.emitEvent({
        type: 'done',
        reason,
        found: this.results.length,
        target: opts.count,
        requests: this.requestCount,
        elapsedSec: Math.round((Date.now() - this.startTime) / 1000),
        platforms: opts.platforms.slice(),
        results: this.results,
        resultBase: this.lastResultBase,
        failedPlatforms: this.hardFailedPlatforms(),
        cooldownPlatforms: [...this.platformCooldowns],
        driedPlatforms: [...this.platformDried]
      });
      const finalFailed = this.hardFailedPlatforms();
      for (const id of Object.keys(this.funnel)) {
        this.log('info', `${PLATFORM_LABELS[id]} 汇总：${this.funnelSummary(id)}`);
      }
      // 0 个结果时把「为什么」直接写出来：用户看到的是一句可执行的结论，
      // 而不是盯着 0/30 猜是不是坏了。
      if (this.results.length === 0) {
        const ids = Object.keys(this.funnel);
        const tot = ids.reduce((a, id) => {
          const f = this.funnel[id];
          for (const k of ['candidates', 'noFollowers', 'outOfRange', 'seen', 'brand', 'stale']) a[k] += f[k] || 0;
          return a;
        }, { candidates: 0, noFollowers: 0, outOfRange: 0, seen: 0, brand: 0, stale: 0 });
        if (tot.candidates > 0) {
          const parts = [`候选 ${tot.candidates}`];
          if (tot.noFollowers) parts.push(`无粉丝数 ${tot.noFollowers}`);
          if (tot.outOfRange) parts.push(`区间外 ${tot.outOfRange}`);
          if (tot.seen) parts.push(`已见 ${tot.seen}`);
          if (tot.brand) parts.push(`机构 ${tot.brand}`);
          if (tot.stale) parts.push(`停更 ${tot.stale}`);
          let tip;
          if (tot.outOfRange >= tot.candidates * 0.6) {
            tip = '这些关键词的搜索结果被大号占满（粉丝数超过上限），换更具体的小众关键词或换领域更容易出结果';
          } else if (tot.seen >= tot.candidates * 0.4) {
            tip = '候选大多之前已经给过、被「已见」挡住了：换领域，或明天再跑（重复的人不会再给一次）';
          } else {
            tip = '可以把粉丝区间放宽，或换一个领域再试';
          }
          this.log('warn', `本轮 0 个：${parts.join('，')}。${tip}`);
        }
      }
      this.log(reason === 'target' ? 'ok' : 'warn', `结束：找到 ${this.results.length}/${opts.count}，共请求 ${this.requestCount} 次${finalFailed.length ? `；${finalFailed.map(id => PLATFORM_LABELS[id]).join(' / ')} 出错` : ''}${this.platformDried.size ? `；${[...this.platformDried].map(id => PLATFORM_LABELS[id]).join(' / ')} 提前收工（没有新候选）` : ''}`);
    }
    return this.results;
  }

  async runPlatform(platformId, domainObjs, opts) {
    const label = PLATFORM_LABELS[platformId];
    const pacer = new Pacer(
      opts,
      event => this.emitEvent({ ...event, platformId, platform: label }),
      () => this.stopped || this.results.length >= opts.count
    );
    const ctx = {
      braveKey: opts.braveKey || '',
      get: (url, o = {}) => this.doRequest('GET', url, null, {}, { ...o, platform: label, platformId }, pacer, opts),
      post: (url, body, headers, o = {}) => this.doRequest('POST', url, body, headers || {}, { ...o, platform: label, platformId }, pacer, opts)
    };
    const maxPasses = Math.max(1, ...domainObjs.map(d => this.queriesFor(platformId, d).length));
    const totalQueries = domainObjs.reduce((n, d) => n + this.queriesFor(platformId, d).length, 0);
    const startAt = new Map(domainObjs.map(d => [d.id, this.cursorIndex(platformId, d, this.queriesFor(platformId, d).length)]));
    let doneQueries = 0;
    let dry = 0;
    try {
      for (let pass = 0; pass < maxPasses; pass++) {
        if (this.stopped || this.results.length >= opts.count) break;
        for (const domain of domainObjs) {
          if (this.stopped || this.results.length >= opts.count) break;
          const list = this.queriesFor(platformId, domain);
          // 关键词少的领域只跑到自己的词数为止：后面的轮次不再回头重复搜
          // 已搜过的词——同一个词返回同一批频道，重复搜只是一次白白花钱的请求。
          if (pass >= list.length) continue;
          // 从上次停下的位置往后轮换，而不是每次都从第 0 个词开始。
          // 起点必须在本次运行开始时固定：游标每个词都会往后走，
          // 一边走一边拿来算下标会让 pass 和游标叠加，变成两个词一跳。
          const start = startAt.get(domain.id) || 0;
          const query = list[(start + pass) % list.length];
          const stats = await this.runOne(platformId, domain, pass, opts, ctx, query);
          this.advanceCursor(platformId, domain, list.length);
          doneQueries++;
          this.funnelAdd(platformId, stats);
          if (this.platformHalted.has(platformId)) return;
          // 「有区间内候选」才算有效：只是没新增（比如候选停更）说明词表还有货，
          // 继续跑下一个词；连续多个词一个区间内候选都没有，就提前收工。
          const productive = stats && (stats.added > 0 || stats.inRangeUnseen > 0 || stats.soft);
          dry = productive ? 0 : dry + 1;
          if (dry >= (DRY_LIMIT[platformId] || 4)) {
            this.platformDried.add(platformId);
            const left = Math.max(0, totalQueries - doneQueries);
            this.log('warn', `${label} 提前收工：连续 ${dry} 个关键词都没有「区间内且未见过」的候选，剩下 ${left} 个词不再空跑（约省 ${Math.max(1, Math.round(left * 2 * (opts.delaySec + opts.jitterSec / 2) / 60))} 分钟）`);
            return;
          }
        }
      }
    } catch (e) {
      if (e instanceof StoppedError) return;
      if (!(e instanceof BudgetError)) this.markPlatformFailure(platformId, e.message);
      throw e;
    }
  }

  // 跨平台种子采集：只选了 X / TikTok / Rumble 时，用 YouTube 当"发现引擎"。
  // 不产出 YouTube 结果，只把频道资料里的外链抽成其它平台的候选。
  // 上限 3 个搜索 + 12 个频道 RSS（约 15 次请求），不碰 X / TikTok 的限流。
  async runSeedPass(domainObjs, opts) {
    const queries = [];
    for (const d of domainObjs) {
      const qs = (d.queries && d.queries.youtube) || [];
      for (const q of qs.slice(0, 2)) if (q && !queries.includes(q)) queries.push(q);
    }
    if (!queries.length) return;
    const pacer = new Pacer(opts, () => {}, () => this.stopped || this.results.length >= opts.count);
    const ctx = {
      get: (url, o = {}) => this.doRequest('GET', url, null, {}, { ...o, platform: 'YouTube（种子）', platformId: 'youtube' }, pacer, opts),
      post: (url, body, headers, o = {}) => this.doRequest('POST', url, body, headers || {}, { ...o, platform: 'YouTube（种子）', platformId: 'youtube' }, pacer, opts)
    };
    let channels = 0;
    let seeds = 0;
    for (const query of queries.slice(0, 3)) {
      if (this.stopped) break;
      const res = await this.attempt(() => youtube.search(query, ctx));
      if (!res || res.error) continue;
      for (const c of res.channels || []) {
        if (this.stopped || channels >= 12) break;
        if (!c.id) continue;
        channels++;
        // 种子阶段只关心外链：关于页（约 1.5MB）比 RSS（27KB）产出高得多，
        // 前 10 个频道用关于页，之后不再多花请求。
        if (channels <= 10) {
          const aboutHtml = await this.attempt(() => youtube.about(c, ctx));
          if (aboutHtml) seeds += this.bridge.absorb(aboutHtml, `YouTube · ${c.name}`);
        }
        if (c.description) seeds += this.bridge.absorb(c.description, `YouTube · ${c.name}`);
      }
    }
    const counts = this.bridge.counts();
    this.log(seeds ? 'info' : 'debug', `种子采集：检查 ${channels} 个 YouTube 频道，拿到跨平台账号 ${seeds} 个（X ${counts.x} / TikTok ${counts.tiktok} / Rumble ${counts.rumble}）`);
  }

  bridgeTotal() {
    if (!this.bridge) return 0;
    const c = this.bridge.counts();
    return Object.keys(c).reduce((n, k) => n + c[k], 0);
  }

  // 种子还没采到时先等一会儿，而不是几秒内把关键词全部空跑完。
  // 搜索源被限流（202/403/429/5xx）不是"平台代码出错"：不要在界面上标红。
  isRateLimitError(message) {
    return /HTTP\s*(202|403|429|5\d\d)|冷却|限流/i.test(String(message || ''));
  }

  async waitSeeds(maxMs = 90000) {
    if (!this.seedPromise) return;
    if (!this.seedWaitLogged) {
      this.seedWaitLogged = true;
      this.log('info', `X / TikTok 的搜索源不可用，正在用 YouTube 公开资料采集跨平台候选（最多等 ${Math.round(maxMs / 1000)} 秒）…`);
    }
    await Promise.race([
      this.seedPromise.catch(() => {}),
      new Promise(resolve => setTimeout(resolve, maxMs))
    ]);
  }

  async doRequest(method, url, body, headers, o, pacer, opts) {
    if (this.stopped || this.results.length >= opts.count) throw new StoppedError();
    if (this.requestCount >= opts.maxRequests) throw new BudgetError(`已达到请求上限（${opts.maxRequests} 次），为避免 IP 风险停止`);
    if ((Date.now() - this.startTime) / 60000 > opts.maxMinutes) throw new BudgetError(`已达到运行上限（${opts.maxMinutes} 分钟），停止`);

    await pacer.wait(o.label || '');
    if (this.stopped || this.results.length >= opts.count) throw new StoppedError();
    if ((Date.now() - this.startTime) / 60000 > opts.maxMinutes) {
      throw new BudgetError(`已达到运行上限（${opts.maxMinutes} 分钟），停止`);
    }

    this.requestCount++;
    this.emitEvent({
      type: 'request',
      count: this.requestCount,
      label: o.label || '',
      platform: o.platform || '',
      platformId: o.platformId || '',
      found: this.results.length,
      target: opts.count,
      elapsedSec: this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0
    });

    try {
      const res = await net.request(method, url, body, headers, {
        timeout: o.timeout || 40,
        transport: o.transport,
        shouldStop: () => this.stopped || this.results.length >= opts.count
      });
      if (this.stopped || this.results.length >= opts.count) throw new StoppedError();
      return res;
    } catch (e) {
      if (e && e.code === 'ESTOP') throw new StoppedError();
      if (this.stopped || this.results.length >= opts.count) throw new StoppedError();
      throw e;
    } finally {
      pacer.complete();
    }
  }

  queriesFor(platformId, domain) {
    const own = domain.queries[platformId];
    if (own && own.length) return own;
    if (platformId === 'kick' || platformId === 'rumble') {
      return domain.queries.twitch || domain.queries.youtube || [];
    }
    if (platformId === 'tiktok') {
      return domain.queries.tiktok || domain.queries.twitch || domain.queries.youtube || [];
    }
    return [];
  }

  async runOne(platformId, domain, pass, opts, ctx, queryOverride) {
    const queries = this.queriesFor(platformId, domain);
    if (!queries.length || pass >= queries.length) return;
    const query = queryOverride || queries[pass];
    this.emitEvent({
      type: 'progress',
      found: this.results.length,
      target: opts.count,
      requests: this.requestCount,
      platform: PLATFORM_LABELS[platformId],
      platformId,
      domain: domain.name,
      query
    });
    this.log('info', `[${PLATFORM_LABELS[platformId]}] ${domain.name} · ${query}`);

    if (platformId === 'youtube') return this.runYouTube(query, domain, opts, ctx);
    if (platformId === 'x') return this.runX(query, domain, opts, ctx);
    if (platformId === 'twitch') return this.runTwitch(query, domain, opts, ctx);
    if (platformId === 'kick') return this.runKick(query, domain, opts, ctx);
    if (platformId === 'rumble') return this.runRumble(query, domain, opts, ctx);
    if (platformId === 'tiktok') return this.runTikTok(query, domain, opts, ctx);
  }

  async attempt(fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StoppedError || e instanceof BudgetError) throw e;
      return null;
    }
  }

  async runYouTube(query, domain, opts, ctx) {
    const { channels, continuations, apiKey, clientVersion, error } = await youtube.search(query, ctx);
    if (error) {
      this.markPlatformFailure('youtube', error);
      this.log('warn', `YouTube 搜索失败：${error}`);
      return { candidates: 0, inRangeUnseen: 0, added: 0 };
    }
    this.markPlatformSuccess('youtube');
    const stats = {
      candidates: 0, noFollowers: 0, outOfRange: 0, seen: 0, brand: 0, stale: 0,
      checked: 0, added: 0, inRangeUnseen: 0
    };
    const handleChannel = async c => {
      if (this.stopped || this.results.length >= opts.count) return;
      stats.candidates++;
      if (c.followers == null) { stats.noFollowers++; return; }
      if (c.followers < opts.minFollowers || c.followers > opts.maxFollowers) {
        stats.outOfRange++;
        return;
      }
      if (opts.avoidDuplicates && this.isSeen('youtube', c.id)) {
        stats.seen++;
        return;
      }
      if (opts.excludeBrands && isBrandAccount(c.name, c.description)) {
        stats.brand++;
        return;
      }
      stats.inRangeUnseen++;

      let latest = null;
      if (opts.activityDays > 0) {
        const act = await this.cachedActivity(c, () => youtube.checkActivity(c, ctx));
        stats.checked++;
        if (!act || !act.ok) return;
        if (act.ageDays > opts.activityDays) {
          stats.stale++;
          this.log('debug', `跳过停更：${c.name}（最近 ${act.ageTextZh || act.ageText}）`);
          return;
        }
        latest = act;
      }

      const ok = this.addResult({
        ...c,
        domainId: domain.id,
        domainName: domain.name,
        latest: latest ? latest.ageTextZh : '',
        latestRaw: latest ? latest.ageText : '',
        latestTitle: latest ? latest.latestTitle : '',
        activityDays: latest ? latest.ageDays : null
      }, opts);
      if (ok) stats.added++;
      // 视频简介 / 频道简介里的外链 → 其它平台候选（免费，RSS 本来就要下）
      if (latest && latest.links) {
        const n = this.bridge.absorb(latest.links, `YouTube · ${c.name}`);
        if (n) this.log('debug', `桥接：${c.name} 的频道资料里发现 ${n} 个其它平台账号`);
      }
      if (c.description) this.bridge.absorb(c.description, `YouTube · ${c.name}`);
      // 关于页里通常有创作者自己填的 X / TikTok / Rumble 链接。只为已经收下的
      // 频道付这一次约 1.5MB 的请求，并且整轮最多 8 次。
      if (ok && this.aboutBudget > 0) {
        this.aboutBudget--;
        const aboutHtml = await this.attempt(() => youtube.about(c, ctx));
        if (aboutHtml) {
          const n2 = this.bridge.absorb(aboutHtml, `YouTube · ${c.name}`);
          if (n2) this.log('debug', `桥接：${c.name} 的频道关于页里有 ${n2} 个其它平台账号`);
        }
      }
    };

    for (const c of channels) await handleChannel(c);

    // 一页约 20 个频道。窄主题第一页常常只有 3–4 个区间内候选，而翻页很便宜
    // （17KB / 约 0.5 秒，不再下整页 HTML），所以区间内候选不足 6 个就继续往后翻，
    // 最多 3 页；某页返回 0 个频道就停（实测更深的页常常已经空了）。
    let token = Array.isArray(continuations) ? continuations[0] : '';
    let pages = 0;
    while (!this.stopped && this.results.length < opts.count && token && pages < 3 && stats.inRangeUnseen < 6) {
      const more = await youtube.searchMore(token, ctx, apiKey, clientVersion, query);
      pages++;
      if (more.error) {
        this.log('debug', `YouTube 翻页失败：${more.error}`);
        break;
      }
      if (!more.channels.length) {
        this.log('debug', `YouTube 第 ${pages} 页没有更多频道，停止翻页`);
        break;
      }
      for (const c of more.channels) await handleChannel(c);
      token = Array.isArray(more.continuations) ? more.continuations[0] : '';
    }

    this.log(stats.added ? 'debug' : 'info', `YouTube 本轮：候选 ${stats.candidates}（无粉丝数 ${stats.noFollowers}），区间外 ${stats.outOfRange}，已见 ${stats.seen}，机构 ${stats.brand}，停更 ${stats.stale}，活跃检查 ${stats.checked}，新增 ${stats.added}`);
    return stats;
  }

  async runX(query, domain, opts, ctx) {
    if (this.seedPromise && this.bridgeTotal() === 0) await this.waitSeeds();
    const seeds = this.bridge.take('x', 10);
    let found;
    if (seeds.length >= 3) {
      this.log('info', `X · 跨平台推荐 ${seeds.length} 个候选（来自其它平台的公开资料），本轮不走搜索引擎`);
      found = { error: null, handles: seeds, hints: Object.create(null), source: 'bridge' };
    } else {
      found = await xPlatform.discover(query, ctx);
      if (seeds.length) {
        if (found.error || found.cooldown) {
          this.log('info', `X · 搜索引擎不可用，改用跨平台推荐 ${seeds.length} 个候选`);
          found = { error: null, handles: seeds, hints: Object.create(null), source: 'bridge' };
        } else {
          found = { ...found, handles: [...new Set([...seeds, ...(found.handles || [])])], source: `${found.source || ''}+bridge` };
        }
      }
    }
    if (this.discoveryCooldown('x', 'X', found, { soft: true })) return { candidates: 0, inRangeUnseen: 0, added: 0 };
    if (found.cooldown) return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
    const { handles, hints, error } = found;
    if (error) {
      if (this.isRateLimitError(error)) {
        this.log('info', `X 的搜索源暂时不可用（${error}），本轮先跳过这个关键词`);
        return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
      }
      this.markPlatformFailure('x', error);
      this.log('warn', `X 发现失败：${error}`);
      return { candidates: 0, inRangeUnseen: 0, added: 0 };
    }
    this.markPlatformSuccess('x');
    const stats = {
      candidates: handles.length, noFollowers: 0, outOfRange: 0, seen: 0,
      brand: 0, stale: 0, checked: 0, prefiltered: 0, inRangeUnseen: 0, added: 0
    };
    let consecutiveBig = 0;
    for (const handle of handles) {
      if (this.stopped || this.results.length >= opts.count) break;
      if (opts.avoidDuplicates && this.isSeen('x', handle.toLowerCase())) {
        stats.seen++;
        continue;
      }
      const hint = hints && hints[handle.toLowerCase()];
      if (hint && hintClearlyOutOfRange(hint.followers, opts.minFollowers, opts.maxFollowers)) {
        stats.prefiltered++;
        this.log('debug', `摘要明显区间外，跳过：X · @${handle}（摘要 ${compactCount(hint.followers)}）`);
        continue;
      }
      const p = await this.cachedProfile('x', handle.toLowerCase(), () => xPlatform.profile(handle, ctx));
      stats.checked++;
      if (!p || p.error) continue;
      if (p.followers == null) { stats.noFollowers++; continue; }
      if (p.followers < opts.minFollowers || p.followers > opts.maxFollowers) {
        stats.outOfRange++;
        // X 的搜索结果常年被大号（媒体、政客、百万粉账号）占满。实测一个词里
        // 连续 6 个都是区间外的，后面基本也是同一批，不必再逐个打开主页。
        if (++consecutiveBig >= 6) {
          this.log('info', `X · ${query}：连续 ${consecutiveBig} 个候选都不在 ${opts.minFollowers}–${opts.maxFollowers} 粉区间（多为大号），这个词不再往下核验`);
          break;
        }
        continue;
      }
      consecutiveBig = 0;
      stats.inRangeUnseen++;
      if (opts.excludeBrands && (p.isBrand || isBrandAccount(p.name, p.description))) {
        stats.brand++;
        this.log('debug', `跳过机构号：@${handle}`);
        continue;
      }
      if (opts.activityDays > 0 && p.activityDays != null && p.activityDays > opts.activityDays) {
        stats.stale++;
        this.log('debug', `跳过不活跃：@${handle}（最近 ${p.latest || p.latestRaw}）`);
        continue;
      }
      const ok = this.addResult({
        ...p,
        domainId: domain.id,
        domainName: domain.name,
        latest: p.latest || '',
        latestRaw: p.latestRaw || '',
        latestTitle: '',
        activityDays: p.activityDays
      }, opts);
      if (ok) stats.added++;
    }
    this.log(stats.added ? 'debug' : 'info', `X 本轮：候选 ${stats.candidates}，已见 ${stats.seen}，摘要预筛 ${stats.prefiltered}，核验 ${stats.checked}，区间外 ${stats.outOfRange}，机构 ${stats.brand}，不活跃 ${stats.stale}，新增 ${stats.added}`);
    return stats;
  }

  async runTwitch(query, domain, opts, ctx) {
    const { channels, error } = await twitch.search(query, ctx);
    if (error) {
      this.markPlatformFailure('twitch', error);
      this.log('warn', `Twitch 搜索失败：${error}`);
      return { candidates: 0, inRangeUnseen: 0, added: 0 };
    }
    this.markPlatformSuccess('twitch');
    let added = 0, noFollowers = 0, outOfRange = 0, seenSkipped = 0, brandSkipped = 0, staleSkipped = 0, inRangeUnseen = 0;
    for (const c of channels) {
      if (this.stopped || this.results.length >= opts.count) break;
      if (c.followers == null) { noFollowers++; continue; }
      if (c.followers < opts.minFollowers || c.followers > opts.maxFollowers) { outOfRange++; continue; }
      if (opts.avoidDuplicates && this.isSeen('twitch', c.id)) { seenSkipped++; continue; }
      if (opts.excludeBrands && isBrandAccount(c.name, c.description)) { brandSkipped++; continue; }
      inRangeUnseen++;

      let latest = '';
      let activityDays = null;
      if (opts.activityDays > 0) {
        if (!c.lastBroadcast) { staleSkipped++; continue; }
        const days = (Date.now() - Date.parse(c.lastBroadcast)) / 86400000;
        if (!Number.isFinite(days) || days > opts.activityDays) { staleSkipped++; continue; }
        latest = daysToZh(days);
        activityDays = days;
      }

      const ok = this.addResult({
        ...c,
        domainId: domain.id,
        domainName: domain.name,
        latest,
        latestRaw: c.lastBroadcast || '',
        latestTitle: '',
        activityDays
      }, opts);
      if (ok) added++;
    }
    const stats = { candidates: channels.length, noFollowers, outOfRange, seen: seenSkipped, brand: brandSkipped, stale: staleSkipped, checked: channels.length, inRangeUnseen, added };
    this.log(added ? 'debug' : 'info', `Twitch 本轮：候选 ${channels.length}（无粉丝数 ${noFollowers}），区间外 ${outOfRange}，已见 ${seenSkipped}，机构 ${brandSkipped}，停更 ${staleSkipped}，新增 ${added}`);
    return stats;
  }

  async runKick(query, domain, opts, ctx) {
    return this.runSlugPlatform('kick', kick, query, domain, opts, ctx);
  }

  async runRumble(query, domain, opts, ctx) {
    return this.runSlugPlatform('rumble', rumble, query, domain, opts, ctx);
  }

  async runTikTok(query, domain, opts, ctx) {
    if (this.seedPromise && this.bridgeTotal() === 0) await this.waitSeeds();
    const seeds = this.bridge.take('tiktok', 10);
    const cacheKey = `tiktok:${String(query).trim().toLowerCase()}`;
    const cached = this.cacheEntry('tiktok-discovery', cacheKey, DISCOVERY_CACHE_TTL);
    let handles = [];
    let hints = Object.create(null);
    let error = null;
    let cooldown = false;
    let cooldownMinutes = 0;

    if (cached && Array.isArray(cached.data.handles) && cached.data.handles.length) {
      handles = cached.data.handles;
      hints = cached.data.hints || Object.create(null);
      this.log('debug', `缓存命中：TikTok 发现 · ${query}`);
      if (seeds.length) handles = [...new Set([...seeds, ...handles])];
    } else if (seeds.length >= 3) {
      handles = seeds;
      this.log('info', `TikTok · 跨平台推荐 ${seeds.length} 个候选（来自其它平台的公开资料），本轮不走搜索引擎`);
    } else {
      const found = await tiktok.discover(query, ctx);
      handles = found.handles || [];
      hints = found.hints || Object.create(null);
      error = found.error;
      cooldown = !!found.cooldown;
      cooldownMinutes = Number(found.cooldownMinutes) || 0;
      if (seeds.length) {
        if (error || cooldown) {
          this.log('info', `TikTok · 搜索引擎不可用，改用跨平台推荐 ${seeds.length} 个候选`);
          handles = seeds;
          hints = Object.create(null);
          error = null;
          cooldown = false;
        } else {
          handles = [...new Set([...seeds, ...handles])];
        }
      }
      if (!error && handles.length) {
        this.cachePut('tiktok-discovery', cacheKey, { handles, hints });
      }
    }

    if (this.discoveryCooldown('tiktok', 'TikTok', { cooldown, cooldownMinutes }, { soft: true })) return { candidates: 0, inRangeUnseen: 0, added: 0 };
    if (cooldown) return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
    if (error) {
      if (this.isRateLimitError(error)) {
        this.log('info', `TikTok 的搜索源暂时不可用（${error}），本轮先跳过这个关键词`);
        return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
      }
      this.markPlatformFailure('tiktok', error);
      this.log('warn', `TikTok 发现失败：${error}`);
      return { candidates: 0, inRangeUnseen: 0, added: 0 };
    }
    this.markPlatformSuccess('tiktok');
    const stats = {
      candidates: handles.length, noFollowers: 0, outOfRange: 0, seen: 0,
      brand: 0, stale: 0, checked: 0, prefiltered: 0, inRangeUnseen: 0, added: 0
    };
    let consecutiveBig = 0;
    for (const handle of handles) {
      if (this.stopped || this.results.length >= opts.count) break;
      if (opts.avoidDuplicates && this.isSeen('tiktok', handle.toLowerCase())) {
        stats.seen++;
        continue;
      }
      const hint = hints && hints[handle.toLowerCase()];
      if (hint && hintClearlyOutOfRange(hint.followers, opts.minFollowers, opts.maxFollowers)) {
        stats.prefiltered++;
        this.log('debug', `摘要明显区间外，跳过：TikTok · @${handle}（摘要 ${compactCount(hint.followers)}）`);
        continue;
      }
      const p = await this.cachedProfile('tiktok', handle.toLowerCase(), () => tiktok.profile(handle, ctx));
      stats.checked++;
      if (!p || p.error) continue;
      if (p.links) this.bridge.absorb(p.links, `TikTok · @${handle}`);
      if (p.followers == null) { stats.noFollowers++; continue; }
      if (p.followers < opts.minFollowers || p.followers > opts.maxFollowers) {
        stats.outOfRange++;
        if (++consecutiveBig >= 6) {
          this.log('info', `TikTok · ${query}：连续 ${consecutiveBig} 个候选都不在 ${opts.minFollowers}–${opts.maxFollowers} 粉区间，这个词不再往下核验`);
          break;
        }
        continue;
      }
      consecutiveBig = 0;
      stats.inRangeUnseen++;
      if (opts.excludeBrands && (p.isBrand || isBrandAccount(p.name, p.description))) {
        stats.brand++;
        this.log('debug', `跳过机构号：TikTok · @${handle}`);
        continue;
      }
      if (opts.activityDays > 0) {
        if (p.activityDays == null) {
          stats.stale++;
          this.log('debug', `跳过（无活跃时间）：TikTok · @${handle}`);
          continue;
        }
        if (p.activityDays > opts.activityDays) {
          stats.stale++;
          this.log('debug', `跳过不活跃：TikTok · @${handle}（最近 ${p.latest || p.latestRaw}）`);
          continue;
        }
      }
      const ok = this.addResult({
        ...p,
        domainId: domain.id,
        domainName: domain.name,
        latest: p.latest || '',
        latestRaw: p.latestRaw || '',
        latestTitle: '',
        activityDays: p.activityDays
      }, opts);
      if (ok) stats.added++;
    }
    this.log(stats.added ? 'debug' : 'info', `TikTok 本轮：候选 ${stats.candidates}，已见 ${stats.seen}，摘要预筛 ${stats.prefiltered}，核验 ${stats.checked}，区间外 ${stats.outOfRange}，机构 ${stats.brand}，不活跃 ${stats.stale}，新增 ${stats.added}`);
    return stats;
  }

  async runSlugPlatform(platformId, adapter, query, domain, opts, ctx) {
    const label = PLATFORM_LABELS[platformId];
    if (platformId === 'rumble' && this.seedPromise && this.bridgeTotal() === 0) await this.waitSeeds();
    const seeds = this.bridge.take(platformId, 10);
    let found;
    if (seeds.length >= 3) {
      this.log('info', `${label} · 跨平台推荐 ${seeds.length} 个候选（来自其它平台的公开资料），本轮不走搜索引擎`);
      found = { error: null, slugs: seeds, hints: Object.create(null), source: 'bridge' };
    } else {
      found = await adapter.discover(query, ctx);
      if (seeds.length) {
        if (found.error || found.cooldown) {
          this.log('info', `${label} · 搜索引擎不可用，改用跨平台推荐 ${seeds.length} 个候选`);
          found = { error: null, slugs: seeds, hints: Object.create(null), source: 'bridge' };
        } else {
          found = { ...found, slugs: [...new Set([...seeds, ...(found.slugs || [])])], source: `${found.source || ''}+bridge` };
        }
      }
    }
    if (this.discoveryCooldown(platformId, label, found, { soft: true })) return { candidates: 0, inRangeUnseen: 0, added: 0 };
    if (found.cooldown) return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
    const { slugs, hints, error } = found;
    if (error) {
      if (this.isRateLimitError(error)) {
        this.log('info', `${label} 的搜索源暂时不可用（${error}），本轮先跳过这个关键词`);
        return { candidates: 0, inRangeUnseen: 0, added: 0, soft: true };
      }
      this.markPlatformFailure(platformId, error);
      this.log('warn', `${label} 发现失败：${error}`);
      return { candidates: 0, inRangeUnseen: 0, added: 0 };
    }
    this.markPlatformSuccess(platformId);
    const stats = {
      candidates: slugs.length, noFollowers: 0, outOfRange: 0, seen: 0,
      brand: 0, stale: 0, checked: 0, prefiltered: 0, inRangeUnseen: 0, added: 0
    };
    let consecutiveBig = 0;
    for (const slug of slugs) {
      if (this.stopped || this.results.length >= opts.count) break;
      if (opts.avoidDuplicates && this.isSeen(platformId, slug.toLowerCase())) {
        stats.seen++;
        continue;
      }
      const hint = hints && hints[slug.toLowerCase()];
      if (hint && hintClearlyOutOfRange(hint.followers, opts.minFollowers, opts.maxFollowers)) {
        stats.prefiltered++;
        this.log('debug', `摘要明显区间外，跳过：${label} · ${slug}（摘要 ${compactCount(hint.followers)}）`);
        continue;
      }
      // Kick 的搜索结果自带粉丝数，本来会跳过详情请求；但详情里带着
      // twitter / tiktok / youtube，对进入区间的账号强制取一次，供桥接使用。
      const wantLinks = platformId === 'kick' && !!hint;
      const p = await this.cachedProfile(platformId, slug.toLowerCase(), () => adapter.profile(slug, ctx, wantLinks ? { ...hint, wantLinks: true } : hint));
      stats.checked++;
      if (!p || p.error) continue;
      if (p.links) this.bridge.absorb(Array.isArray(p.links) ? p.links.join('\n') : p.links, `${label} · ${slug}`);
      if (p.followers == null) { stats.noFollowers++; continue; }
      if (p.followers < opts.minFollowers || p.followers > opts.maxFollowers) {
        stats.outOfRange++;
        if (++consecutiveBig >= 6) {
          this.log('info', `${label} · ${query}：连续 ${consecutiveBig} 个候选都不在 ${opts.minFollowers}–${opts.maxFollowers} 粉区间，这个词不再往下核验`);
          break;
        }
        continue;
      }
      consecutiveBig = 0;
      stats.inRangeUnseen++;
      if (opts.excludeBrands && (p.isBrand || isBrandAccount(p.name, p.description))) {
        stats.brand++;
        this.log('debug', `跳过机构号：${label} · ${slug}`);
        continue;
      }
      if (opts.activityDays > 0) {
        if (p.activityDays == null) {
          stats.stale++;
          this.log('debug', `跳过（无活跃时间）：${label} · ${slug}`);
          continue;
        }
        if (p.activityDays > opts.activityDays) {
          stats.stale++;
          this.log('debug', `跳过不活跃：${label} · ${slug}（最近 ${p.latest || p.latestRaw}）`);
          continue;
        }
      }
      const ok = this.addResult({
        ...p,
        domainId: domain.id,
        domainName: domain.name,
        latest: p.latest || '',
        latestRaw: p.latestRaw || '',
        latestTitle: '',
        activityDays: p.activityDays
      }, opts);
      if (ok) stats.added++;
    }
    this.log(stats.added ? 'debug' : 'info', `${label} 本轮：候选 ${stats.candidates}，已见 ${stats.seen}，摘要预筛 ${stats.prefiltered}，核验 ${stats.checked}，区间外 ${stats.outOfRange}，机构 ${stats.brand}，不活跃 ${stats.stale}，新增 ${stats.added}`);
    return stats;
  }

  addResult(item, opts) {
    if (this.results.length >= opts.count) return false;
    const key = `${item.platform}:${item.id}`;
    if (this.resultKeys.has(key)) return false;
    this.resultKeys.add(key);

    const days = item.activityDays == null ? null : Number(item.activityDays);
    const result = {
      platform: item.platform,
      platformLabel: PLATFORM_LABELS[item.platform],
      id: item.id,
      name: item.name,
      handle: item.handle,
      url: safeUrl(item.url),
      followers: item.followers,
      followersText: item.followersText || compactCount(item.followers),
      domainId: item.domainId,
      domainName: item.domainName,
      description: item.description || '',
      latest: item.latest || '',
      latestRaw: item.latestRaw || '',
      latestTitle: item.latestTitle || '',
      activityDays: days == null || !Number.isFinite(days) ? null : Math.round(days * 10) / 10,
      foundAt: new Date().toISOString()
    };
    this.results.push(result);
    this.markSeen(item.platform, item.id, result);
    this.history.add(result);
    this.emitEvent({ type: 'result', result, found: this.results.length, target: opts.count });
    this.log('ok', `+ ${result.platformLabel} · ${result.name}（${result.followersText}）· ${result.domainName}`);
    this.scheduleResultsSave();
    return true;
  }

  scheduleResultsSave() {
    if (this.resultSaveTimer) return;
    this.resultSaveTimer = setTimeout(() => {
      this.resultSaveTimer = null;
      this.saveResults();
    }, 1500);
    if (this.resultSaveTimer.unref) this.resultSaveTimer.unref();
  }

  saveResults() {
    if (!this.results.length) return;
    const base = this.resultBase || path.join(this.resultsDir, `results-${nowStamp()}`);
    try {
      fs.mkdirSync(this.resultsDir, { recursive: true });
      atomicWriteJson(base + '.json', { createdAt: new Date().toISOString(), results: this.results });
      fs.writeFileSync(base + '.md', toMarkdown(this.results, {
        date: todayStamp(),
        note: '筛选口径：粉丝数在设定区间内；优先个人创作者；每个平台内部串行抓取。'
      }), 'utf8');
      fs.writeFileSync(base + '.csv', toCsv(this.results), 'utf8');
      this.lastResultBase = base;
      this.resultSaveErrorLogged = false;
    } catch (e) {
      if (!this.resultSaveErrorLogged) {
        this.resultSaveErrorLogged = true;
        this.log('error', `保存结果失败：${e.message}`);
      }
    }
  }

  stop() {
    if (!this.running) return;
    this.userStopped = true;
    this.stopped = true;
    net.abortAll();
    this.children.clear();
    this.saveSeen();
    this.saveCache();
    if (!this.history.save()) this.log('error', '保存历史记录失败');
    this.saveResults();
    this.log('warn', '正在停止，等待当前请求结束…');
  }

  getState() {
    return {
      running: this.running,
      found: this.results.length,
      target: this.target || 0,
      requests: this.requestCount,
      elapsedSec: this.startTime ? Math.round(((this.endTime || Date.now()) - this.startTime) / 1000) : 0,
      results: this.results,
      platforms: this.opts ? this.opts.platforms.slice() : [],
      lastResultBase: this.lastResultBase,
      seen: this.seenCounts(),
      historyTotal: this.history.total()
    };
  }
}

module.exports = { Engine, PLATFORM_LABELS, BRAND_RE };
