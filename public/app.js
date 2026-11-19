'use strict';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'creator-finder-settings-v1';
const LOG_COLLAPSE_KEY = 'creator-finder-log-collapsed';
const NETWORK_OPEN_KEY = 'creator-finder-network-open';
const DOMAIN_OPEN_KEY = 'creator-finder-domain-open';
const THEME_KEY = 'creator-finder-theme';
const THEMES = ['ember', 'paper', 'snow', 'mint', 'rose'];

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

const PLATFORM_META = {
  youtube: { label: 'YouTube', short: 'YouTube', mark: 'YT', cls: 'youtube' },
  x: { label: 'X/Twitter', short: 'X', mark: 'X', cls: 'x' },
  twitch: { label: 'Twitch', short: 'Twitch', mark: 'TW', cls: 'twitch' },
  kick: { label: 'Kick', short: 'Kick', mark: 'K', cls: 'kick' },
  rumble: { label: 'Rumble', short: 'Rumble', mark: 'R', cls: 'rumble' },
  tiktok: { label: 'TikTok', short: 'TikTok', mark: 'TT', cls: 'tiktok' }
};

const PLATFORM_ICONS = {
  youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  x: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  twitch: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  kick: 'M1.333 0h8v5.333H12V2.667h2.667V0h8v8H20v2.667h-2.667v2.666H20V16h2.667v8h-8v-2.667H12v-2.666H9.333V24h-8Z',
  rumble: 'M14.4528 13.5458c.8064-.6542.9297-1.8381.2756-2.6445a1.8802 1.8802 0 0 0-.2756-.2756 21.2127 21.2127 0 0 0-4.3121-2.776c-1.066-.51-2.256.2-2.4261 1.414a23.5226 23.5226 0 0 0-.14 5.5021c.116 1.23 1.292 1.964 2.372 1.492a19.6285 19.6285 0 0 0 4.5062-2.704v-.008zm6.9322-5.4002c2.0335 2.228 2.0396 5.637.014 7.8723A26.1487 26.1487 0 0 1 8.2946 23.846c-2.6848.6713-5.4168-.914-6.1662-3.5781-1.524-5.2002-1.3-11.0803.17-16.3045.772-2.744 3.3521-4.4661 6.0102-3.832 4.9242 1.174 9.5443 4.196 13.0764 8.0121v.002z',
  tiktok: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z'
};

function platformIcon(id) {
  const path = PLATFORM_ICONS[id];
  if (!path) return '';
  return `<svg class="platform-logo" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
}
const ppCache = new Map();

const state = {
  config: null,
  running: false,
  results: [],
  seen: { youtube: 0, x: 0, twitch: 0, kick: 0, rumble: 0, tiktok: 0 },
  startedAt: 0,
  target: 30,
  lastRequests: 0,
  lastElapsed: 0,
  timer: null,
  es: null,
  toastTimer: null,
  searchTimer: null,
  settingsTimer: null,
  filter: 'all',
  search: '',
  sort: 'activity',
  runPlatforms: [],
  hasRun: false,
  frame: 0,
  logQueue: [],
  needsRender: false,
  needsMetrics: false,
  pendingFound: null,
  pendingTarget: 0,
  pendingNewResults: [],
  domKeys: [],
  domValid: false,
  renderedSort: 'activity',
  historyOpen: false,
  historyData: null,
  historyFilter: 'all',
  historySearch: '',
  historyExpanded: new Set(),
  historyTotal: 0
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function platformMeta(id) {
  return PLATFORM_META[id] || {
    label: id || '未知',
    short: id || '未知',
    mark: String(id || '?').slice(0, 2).toUpperCase(),
    cls: 'x'
  };
}

function toast(message, type = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast show ' + (type === 'ok' ? '' : type);
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.className = 'toast'; }, 4600);
}

function formatElapsed(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function shorten(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function selectedPlatforms() {
  return [...document.querySelectorAll('[data-platform]:checked:not(:disabled)')].map(x => x.dataset.platform);
}

function setStatus(text, mode) {
  $('statusText').textContent = text;
  $('statusDot').className = 'dot' + (mode ? ' ' + mode : '');
}

function setRunning(running) {
  state.running = running;
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
  $('startBtn').textContent = running ? '正在寻找…' : '开始寻找';
  if (running) {
    setStatus('运行中', 'running');
    state.startedAt = state.startedAt || Date.now();
    $('elapsedSub').textContent = '运行中';
    if (!state.timer) {
      state.timer = setInterval(() => {
        if (!state.running) return;
        const sec = (Date.now() - state.startedAt) / 1000;
        $('elapsedNum').textContent = formatElapsed(sec);
      }, 1000);
    }
  } else {
    setStatus('就绪', '');
    $('elapsedSub').textContent = state.hasRun ? '已结束' : '等待开始';
    clearInterval(state.timer);
    state.timer = null;
  }
}

function scheduleFrame() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(flushFrame);
}

function flushNow() {
  if (state.frame) {
    cancelAnimationFrame(state.frame);
    state.frame = 0;
  }
  flushFrame();
}

function cancelFrame() {
  if (state.frame) {
    cancelAnimationFrame(state.frame);
    state.frame = 0;
  }
  state.logQueue.length = 0;
  state.needsRender = false;
  state.needsMetrics = false;
  state.pendingFound = null;
  state.pendingTarget = 0;
  state.pendingNewResults = [];
}

function flushFrame() {
  state.frame = 0;
  if (state.logQueue.length) flushLogQueue();
  if (state.needsRender) {
    state.needsRender = false;
    const pending = state.pendingNewResults;
    state.pendingNewResults = [];
    if (pending.length === 1 && canAppendResult(pending[0])) appendResultRow(pending[0]);
    else renderResults();
  }
  if (state.needsMetrics) {
    state.needsMetrics = false;
    updateFound(
      state.pendingFound == null ? state.results.length : state.pendingFound,
      state.pendingTarget || state.target
    );
    updateStats(state.lastRequests, state.lastElapsed);
    state.pendingFound = null;
    state.pendingTarget = 0;
  }
}

const pad2 = n => (n < 10 ? '0' + n : String(n));
function formatLogTime() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function flushLogQueue() {
  if (!state.logQueue.length) return;
  const log = $('log');
  const queued = state.logQueue;
  state.logQueue = [];
  const lines = queued.length > 500 ? queued.slice(-500) : queued;
  const nearBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 44;
  const time = formatLogTime();
  const frag = document.createDocumentFragment();
  for (const item of lines) {
    const line = document.createElement('div');
    line.className = 'log-line log-' + (item.level || 'info');
    const ts = document.createElement('span');
    ts.className = 'log-time';
    ts.textContent = time;
    const tx = document.createElement('span');
    tx.className = 'log-text';
    tx.textContent = item.text;
    line.appendChild(ts);
    line.appendChild(tx);
    frag.appendChild(line);
  }
  if (lines.length >= 500) {
    log.replaceChildren(frag);
  } else {
    const overflow = log.children.length + lines.length - 500;
    for (let i = 0; i < overflow; i++) log.removeChild(log.firstChild);
    log.appendChild(frag);
  }
  $('logCount').textContent = log.children.length;
  if (nearBottom) log.scrollTop = log.scrollHeight;
}

function appendLog(level, text) {
  state.logQueue.push({ level, text });
  if (state.logQueue.length > 500) state.logQueue.splice(0, state.logQueue.length - 500);
  scheduleFrame();
}

function clearLog() {
  state.logQueue.length = 0;
  $('log').replaceChildren();
  $('logCount').textContent = '0';
}

function updateSeen(seen) {
  state.seen = seen || { youtube: 0, x: 0, twitch: 0, kick: 0, rumble: 0, tiktok: 0 };
  $('seenCounts').textContent =
    `YouTube ${state.seen.youtube || 0} · X ${state.seen.x || 0} · Twitch ${state.seen.twitch || 0} · Kick ${state.seen.kick || 0} · Rumble ${state.seen.rumble || 0} · TikTok ${state.seen.tiktok || 0}`;
}

function updateFound(found, target) {
  const t = target || state.target || Number($('count').value) || 30;
  state.target = t;
  const pct = t > 0 ? Math.min(100, (found / t) * 100) : 0;
  $('foundNum').textContent = found;
  $('targetNum').textContent = t;
  $('foundRing').style.setProperty('--pct', pct.toFixed(1));
  $('progressBar').style.transform = `scaleX(${(pct / 100).toFixed(4)})`;
  $('progressBar').setAttribute('aria-valuenow', String(Math.round(pct)));
  if (found >= t && t > 0) $('foundSub').textContent = '已达成目标';
  else if (state.running) $('foundSub').textContent = '正在寻找';
  else if (state.hasRun) $('foundSub').textContent = '已结束';
  else $('foundSub').textContent = '等待开始';
  $('resultCount').textContent = state.results.length;
}

function updateStats(requests, elapsedSec) {
  if (requests != null) state.lastRequests = Number(requests) || 0;
  if (elapsedSec != null) state.lastElapsed = Number(elapsedSec) || 0;
  $('requestNum').textContent = state.lastRequests;
  $('elapsedNum').textContent = formatElapsed(state.lastElapsed);
  $('requestSub').textContent = state.lastRequests > 0 && state.lastElapsed > 1
    ? `平均 ${(state.lastElapsed / state.lastRequests).toFixed(1)} 秒/次`
    : '—';
}

function runSummary(text) {
  $('runSummary').textContent = text;
}

function ppFor(platformId) {
  return ppCache.get(platformId) || document.querySelector(`#platformProgress .pp[data-platform="${platformId}"]`);
}

function setPlatformStatus(platformId, text, mode) {
  const pp = ppFor(platformId);
  if (!pp) return;
  pp.classList.remove('active', 'waiting', 'error', 'idle');
  if (mode) pp.classList.add(mode);
  if (text != null) pp.querySelector('.pp-status').textContent = text;
}

function bumpPlatformCount(platformId) {
  const pp = ppFor(platformId);
  if (!pp) return;
  const el = pp.querySelector('.pp-count');
  el.textContent = String((Number(el.textContent) || 0) + 1);
}

function renderPlatformProgress() {
  const list = $('platformProgress');
  list.innerHTML = '';
  ppCache.clear();
  const ready = (state.config?.platforms || []).filter(p => p.status === 'ready');
  for (const p of ready) {
    const meta = platformMeta(p.id);
    const el = document.createElement('div');
    el.className = 'pp idle';
    el.dataset.platform = p.id;
    el.title = p.note || '';
    el.innerHTML = `
      <span class="p-mark mark-${meta.cls}">${escapeHtml(meta.mark)}</span>
      <div class="pp-body">
        <div class="pp-name">${escapeHtml(meta.short)}</div>
        <div class="pp-status">未选</div>
      </div>
      <div class="pp-count">0</div>
    `;
    ppCache.set(p.id, el);
    list.appendChild(el);
  }
}

function resetPlatformStats(platformIds) {
  const active = new Set(platformIds || []);
  document.querySelectorAll('#platformProgress .pp').forEach(pp => {
    const id = pp.dataset.platform;
    pp.querySelector('.pp-count').textContent = '0';
    pp.classList.remove('active', 'waiting', 'error');
    if (active.has(id)) {
      pp.classList.remove('idle');
      pp.querySelector('.pp-status').textContent = '待开始';
    } else {
      pp.classList.add('idle');
      pp.querySelector('.pp-status').textContent = '未选';
    }
  });
}

function updatePlatformSelection() {
  const selected = new Set(state.running ? state.runPlatforms : selectedPlatforms());
  $('platformSelected').textContent = selected.size;
  document.querySelectorAll('#platformProgress .pp').forEach(pp => {
    const id = pp.dataset.platform;
    if (state.running) {
      pp.classList.toggle('idle', !selected.has(id));
      return;
    }
    if (!selected.has(id)) {
      pp.classList.add('idle');
      pp.classList.remove('active', 'waiting', 'error');
      pp.querySelector('.pp-status').textContent = '未选';
    } else {
      pp.classList.remove('idle');
      if (pp.querySelector('.pp-status').textContent === '未选') {
        pp.querySelector('.pp-status').textContent = '待开始';
      }
    }
  });
  updateSafetySummary();
}

function updateSafetySummary() {
  const n = selectedPlatforms().length;
  const parallel = $('parallelPlatforms').checked;
  const delay = Number($('delaySec').value) || 5;
  let text;
  if (n === 0) text = '未选择平台';
  else if (parallel) text = `平台内串行 · ${n} 条队列 · ${delay}s 间隔`;
  else text = `全平台单队列 · ${delay}s 间隔`;
  $('safetyText').textContent = text;
  $('safetySummary').classList.toggle('warn', n > 1 && parallel && delay < 4);
}

function renderPlatforms(platforms) {
  const list = $('platformList');
  list.innerHTML = '';
  for (const p of platforms) {
    const ready = p.status === 'ready';
    const blocked = p.status === 'blocked';
    const badgeText = ready ? '可用' : (blocked ? '受限' : '待接入');
    const badgeCls = ready ? 'ready' : (blocked ? 'blocked' : 'soon');
    const meta = platformMeta(p.id);
    const label = document.createElement('label');
    label.className = 'platform-card' + (ready ? '' : ' disabled');
    label.title = p.note || '';
    label.innerHTML = `
      <input type="checkbox" data-platform="${escapeHtml(p.id)}" ${ready ? '' : 'disabled'}>
      <span class="p-mark mark-${meta.cls}">${escapeHtml(meta.mark)}</span>
      <div class="p-body">
        <div class="p-name">${escapeHtml(p.name)} <span class="badge ${badgeCls}">${badgeText}</span></div>
        <div class="p-note" title="${escapeHtml(p.note)}">${escapeHtml(p.note)}</div>
      </div>
    `;
    const input = label.querySelector('input');
    if (ready) input.checked = true;
    label.classList.toggle('checked', input.checked);
    list.appendChild(label);
  }
  updatePlatformSelection();
}

function renderDomains(domains) {
  const list = $('domainList');
  list.innerHTML = '';
  for (const d of domains) {
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.dataset.name = d.name;
    chip.innerHTML = `<input type="checkbox" data-domain="${escapeHtml(d.id)}"><span>${escapeHtml(d.name)}</span>`;
    list.appendChild(chip);
  }
  updateDomainCount();
}

function updateDomainCount() {
  const all = document.querySelectorAll('#domainList input[data-domain]');
  const checked = [...all].filter(x => x.checked).length;
  $('domainSelected').textContent = checked;
}

function applyDomainFilter() {
  const q = $('domainSearch').value.trim().toLowerCase();
  document.querySelectorAll('#domainList .chip').forEach(chip => {
    const name = (chip.dataset.name || '').toLowerCase();
    chip.classList.toggle('hidden', !!q && !name.includes(q));
  });
}

function setAllDomains(checked) {
  document.querySelectorAll('#domainList input[data-domain]').forEach(input => {
    input.checked = checked;
    input.closest('.chip').classList.toggle('checked', checked);
  });
  updateDomainCount();
  saveSettings();
}

function platformBadge(platform) {
  const meta = platformMeta(platform);
  return `<span class="badge-platform badge-${meta.cls}">${escapeHtml(meta.short)}</span>`;
}

function activityClass(days, latest) {
  if (latest && /直播|DVR/i.test(latest)) return 'live';
  if (days == null || !Number.isFinite(Number(days))) return 'unknown';
  const d = Number(days);
  if (d <= 7) return 'fresh';
  if (d <= 30) return 'recent';
  return 'stale';
}

function resultKey(r) {
  return `${r.platform}:${r.id}`;
}

function rowHtml(r, index) {
  const desc = r.description || r.latestTitle || '—';
  const act = activityClass(r.activityDays, r.latest);
  const meta = platformMeta(r.platform);
  const num = String(index).padStart(2, '0');
  return `
    <article class="creator-row">
      <span class="row-index">${num}</span>
      <div class="creator-id">
        <span class="avatar avatar-${meta.cls}" title="来源平台：${escapeHtml(meta.label)}">${PLATFORM_ICONS[r.platform] ? platformIcon(r.platform) : escapeHtml(meta.mark)}</span>
        <div class="creator-copy">
          <div class="creator-name">${escapeHtml(r.name)}</div>
          <div class="creator-handle">${escapeHtml(r.handle ? '@' + r.handle : '')}</div>
        </div>
      </div>
      ${platformBadge(r.platform)}
      <span class="row-followers">${escapeHtml(r.followersText)}</span>
      <span class="row-domain" title="${escapeHtml(r.domainName)}">${escapeHtml(r.domainName)}</span>
      <span class="row-bio" title="${escapeHtml(desc)}">${escapeHtml(desc)}</span>
      <span class="row-signal"><i class="signal-dot ${act}"></i>${escapeHtml(r.latest || '—')}</span>
      ${r.url
        ? `<a class="row-open" href="${escapeHtml(r.url)}" target="_blank" rel="noreferrer" title="打开主页">↗</a>`
        : '<span class="row-open row-open-off" aria-hidden="true">↗</span>'}
    </article>
  `;
}

function emptyHtml(kind) {
  const radar = '<div class="empty-radar" aria-hidden="true"><i></i></div>';
  if (kind === 'filter') {
    return `${radar}<h3>没有匹配的结果</h3><p>换个关键词，或把平台筛选切回「全部」。</p><button id="clearFiltersBtn" class="mini-btn">清除筛选</button>`;
  }
  if (kind === 'none') {
    return `${radar}<h3>这次没有找到符合条件的频道</h3><p>可以换领域、放宽粉丝区间，或把「最近活跃」调大。</p>`;
  }
  if (kind === 'running') {
    return `${radar}<h3>正在搜索…</h3><p>各平台的状态会显示在上方，找到的频道会实时出现在这里。</p>`;
  }
  return `${radar}<h3>准备发现新创作者</h3><p>选择平台和领域，设置目标数量，然后点击「开始寻找」。</p><div class="empty-hints"><span>平台内串行</span><span>自动去重</span><span>实时保存</span></div>`;
}

function visibleResults() {
  let list = state.results.slice();
  if (state.filter !== 'all') list = list.filter(r => r.platform === state.filter);
  const q = state.search.trim().toLowerCase();
  if (q) {
    list = list.filter(r => `${r.name || ''} ${r.handle || ''} ${r.description || ''} ${r.domainName || ''}`.toLowerCase().includes(q));
  }
  list.sort((a, b) => {
    if (state.sort === 'followers') return (Number(b.followers) || 0) - (Number(a.followers) || 0);
    const da = a.activityDays == null ? Infinity : a.activityDays;
    const db = b.activityDays == null ? Infinity : b.activityDays;
    return da - db;
  });
  return list;
}

function updateFilterTabs() {
  const ready = (state.config?.platforms || []).filter(p => p.status === 'ready');
  const counts = {};
  for (const r of state.results) counts[r.platform] = (counts[r.platform] || 0) + 1;
  const tabs = [{ id: 'all', label: '全部', count: state.results.length }]
    .concat(ready.map(p => ({ id: p.id, label: platformMeta(p.id).short, count: counts[p.id] || 0 })));
  const container = $('platformFilter');
  const existing = [...container.querySelectorAll('button[data-filter]')];
  const same = existing.length === tabs.length && existing.every((b, i) => b.dataset.filter === tabs[i].id);
  if (!same) {
    container.innerHTML = tabs.map(t =>
      `<button type="button" class="filter-tab${state.filter === t.id ? ' active' : ''}" data-filter="${escapeHtml(t.id)}" aria-pressed="${state.filter === t.id ? 'true' : 'false'}">${escapeHtml(t.label)}<span>${t.count}</span></button>`
    ).join('');
    return;
  }
  existing.forEach((btn, i) => {
    const count = btn.querySelector('span');
    if (count) count.textContent = tabs[i].count;
    btn.classList.toggle('active', state.filter === tabs[i].id);
    btn.setAttribute('aria-pressed', state.filter === tabs[i].id ? 'true' : 'false');
  });
}

function renderResults(preserveScroll = true) {
  state.needsRender = false;
  state.pendingNewResults = [];
  const visible = visibleResults();
  const wrap = document.querySelector('.table-wrap');
  const scrollTop = wrap.scrollTop;
  const has = visible.length > 0;
  $('resultBody').innerHTML = visible.map((r, i) => rowHtml(r, i + 1)).join('');
  state.domKeys = visible.map(resultKey);
  state.domValid = true;
  state.renderedSort = state.sort;
  if (has) {
    $('empty').style.display = 'none';
    wrap.style.display = '';
    if (preserveScroll) wrap.scrollTop = scrollTop;
  } else {
    wrap.style.display = 'none';
    $('empty').style.display = '';
    const kind = state.results.length > 0 ? 'filter' : (state.running ? 'running' : (state.hasRun ? 'none' : 'start'));
    $('empty').innerHTML = emptyHtml(kind);
  }
  $('resultCount').textContent = state.results.length;
  updateFilterTabs();
}

function renumberRows(from) {
  const rows = document.querySelectorAll('#resultBody .row-index');
  for (let i = from; i < rows.length; i++) {
    rows[i].textContent = String(i + 1).padStart(2, '0');
  }
}

function canAppendResult(item) {
  return state.domValid
    && state.filter === 'all'
    && !state.search
    && state.renderedSort === state.sort
    && state.domKeys.length + 1 === state.results.length
    && !state.domKeys.includes(resultKey(item));
}

function appendResultRow(item) {
  if (!canAppendResult(item)) { renderResults(); return; }
  const visible = visibleResults();
  const idx = visible.findIndex(r => resultKey(r) === resultKey(item));
  if (idx < 0) { renderResults(); return; }

  const wrap = document.querySelector('.table-wrap');
  const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 44;
  const body = $('resultBody');
  const ref = body.children[idx];
  if (ref) ref.insertAdjacentHTML('beforebegin', rowHtml(item, idx + 1));
  else body.insertAdjacentHTML('beforeend', rowHtml(item, idx + 1));
  state.domKeys.splice(idx, 0, resultKey(item));
  renumberRows(idx);

  if (state.results.length === 1) {
    $('empty').style.display = 'none';
    wrap.style.display = '';
  }
  $('resultCount').textContent = state.results.length;
  updateFilterTabs();
  if (atBottom) wrap.scrollTop = wrap.scrollHeight;
}

function resetRunUI() {
  cancelFrame();
  state.results = [];
  state.filter = 'all';
  state.search = '';
  state.hasRun = true;
  state.startedAt = Date.now();
  state.target = Number($('count').value) || 30;
  $('resultSearch').value = '';
  $('resultBody').innerHTML = '';
  state.domKeys = [];
  state.domValid = true;
  state.renderedSort = state.sort;
  clearLog();
  $('empty').style.display = '';
  document.querySelector('.table-wrap').style.display = 'none';
  $('empty').innerHTML = emptyHtml('running');
  updateFound(0, state.target);
  updateStats(0, 0);
  $('progressBar').style.transform = 'scaleX(0)';
  $('foundRing').style.setProperty('--pct', '0');
  $('resultCount').textContent = '0';
  runSummary('正在启动…');
  updateFilterTabs();
}

function handleEvent(ev) {
  if (!ev || !ev.type) return;

  if (ev.type === 'state') {
    const s = ev.state || {};
    updateSeen(s.seen || state.seen);
    if (s.running) {
      state.startedAt = Date.now() - (s.elapsedSec || 0) * 1000;
      state.results = s.results || [];
      state.runPlatforms = s.platforms || [];
      state.hasRun = true;
      setRunning(true);
      renderPlatformProgress();
      resetPlatformStats(state.runPlatforms);
      for (const r of state.results) bumpPlatformCount(r.platform);
      state.runPlatforms.forEach(id => setPlatformStatus(id, '搜索中', 'active'));
      renderResults();
      updateFound(s.found || state.results.length, s.target || state.target);
      updateStats(s.requests || 0, s.elapsedSec || 0);
      runSummary(`搜索中 · ${s.requests || 0} 次请求`);
    } else if (s.results && s.results.length) {
      state.results = s.results;
      state.runPlatforms = s.platforms || [];
      state.hasRun = true;
      setRunning(false);
      setStatus('上次结果', '');
      renderResults();
      resetPlatformStats(state.runPlatforms);
      for (const r of state.results) bumpPlatformCount(r.platform);
      for (const id of state.runPlatforms) {
        const pp = ppFor(id);
        if (pp) {
          pp.classList.remove('idle');
          pp.querySelector('.pp-status').textContent = '上次结果';
        }
      }
      updateFound(s.found || state.results.length, s.target || state.target);
      updateStats(s.requests || 0, s.elapsedSec || 0);
      runSummary(`上次结束 · 找到 ${state.results.length} 个`);
    } else if (Array.isArray(s.results) && (state.results.length || state.running)) {
      state.results = [];
      state.runPlatforms = s.platforms || [];
      state.hasRun = !!(s.requests || s.elapsedSec);
      setRunning(false);
      setStatus(state.hasRun ? '上次结束' : '就绪', '');
      renderResults();
      resetPlatformStats([]);
      updatePlatformSelection();
      updateFound(0, s.target || state.target);
      updateStats(s.requests || 0, s.elapsedSec || 0);
      runSummary(state.hasRun ? '上次结束 · 0 个结果' : '等待开始');
    }
    state.needsRender = false;
    state.needsMetrics = false;
    state.pendingNewResults = [];
    state.pendingFound = null;
    state.pendingTarget = 0;
    return;
  }

  if (ev.type === 'start') {
    state.runPlatforms = (ev.options && ev.options.platforms) || selectedPlatforms();
    setRunning(true);
    resetRunUI();
    renderPlatformProgress();
    resetPlatformStats(state.runPlatforms);
    $('targetNum').textContent = ev.target || state.target;
    updateFound(0, ev.target || state.target);
    runSummary(`已启动 · 目标 ${ev.target || state.target} 个`);
    return;
  }

  if (ev.type === 'progress') {
    state.pendingFound = ev.found == null ? state.results.length : ev.found;
    state.pendingTarget = ev.target || state.target;
    if (ev.requests != null) state.lastRequests = Number(ev.requests) || 0;
    if (ev.elapsedSec != null) state.lastElapsed = Number(ev.elapsedSec) || 0;
    state.needsMetrics = true;
    scheduleFrame();
    if (ev.platformId) {
      if (ev.query || ev.domain) {
        const full = [ev.domain, ev.query].filter(Boolean).join(' · ');
        setPlatformStatus(ev.platformId, shorten(ev.query || ev.domain, 26), 'active');
        const pp = ppFor(ev.platformId);
        if (pp) pp.title = full;
      } else {
        setPlatformStatus(ev.platformId, null, 'active');
      }
    }
    runSummary(`搜索中 · ${ev.requests || state.lastRequests} 次请求 · ${formatElapsed(ev.elapsedSec || state.lastElapsed)}`);
    return;
  }

  if (ev.type === 'request') {
    state.lastRequests = ev.count || state.lastRequests;
    if (ev.elapsedSec != null) state.lastElapsed = Number(ev.elapsedSec) || 0;
    state.pendingFound = ev.found == null ? state.results.length : ev.found;
    state.pendingTarget = ev.target || state.target;
    state.needsMetrics = true;
    scheduleFrame();
    if (ev.platformId) setPlatformStatus(ev.platformId, '请求中', 'active');
    setStatus('运行中', 'running');
    runSummary(`搜索中 · ${state.lastRequests} 次请求 · ${formatElapsed(state.lastElapsed)}`);
    return;
  }

  if (ev.type === 'pace') {
    const sec = ev.waitSec;
    if (ev.platformId) {
      setPlatformStatus(ev.platformId, ev.label === 'long-pause' ? '长休中' : `限速 ${sec}s`, 'waiting');
    }
    runSummary(`安全等待 ${sec} 秒 · ${state.lastRequests} 次请求`);
    return;
  }

  if (ev.type === 'result') {
    state.results.push(ev.result);
    state.pendingNewResults.push(ev.result);
    bumpPlatformCount(ev.result.platform);
    state.pendingFound = ev.found || state.results.length;
    state.pendingTarget = ev.target || state.target;
    state.needsRender = true;
    state.needsMetrics = true;
    scheduleFrame();
    runSummary(`已找到 ${state.results.length}/${state.target} · ${state.lastRequests} 次请求`);
    return;
  }

  if (ev.type === 'log') {
    appendLog(ev.level, ev.text);
    if (ev.level === 'error') {
      for (const [id, meta] of Object.entries(PLATFORM_META)) {
        if (ev.text.includes(meta.label)) {
          setPlatformStatus(id, '出错', 'error');
        }
      }
    } else if (ev.level === 'pace' && ev.platformId) {
      setPlatformStatus(ev.platformId, '长休中', 'waiting');
    }
    return;
  }

  if (ev.type === 'done') {
    state.results = Array.isArray(ev.results) ? ev.results : state.results;
    state.hasRun = true;
    setRunning(false);
    if (ev.requests != null) state.lastRequests = Number(ev.requests) || 0;
    if (ev.elapsedSec != null) state.lastElapsed = Number(ev.elapsedSec) || 0;
    state.pendingFound = ev.found || state.results.length;
    state.pendingTarget = ev.target || state.target;
    state.pendingNewResults = [];
    state.needsRender = true;
    state.needsMetrics = true;
    flushNow();
    const labels = {
      target: '已完成', stopped: '已停止', budget: '达到安全上限',
      exhausted: '关键词已跑完', partial: '部分平台出错', error: '出错'
    };
    const failed = Array.isArray(ev.failedPlatforms) ? ev.failedPlatforms : [];
    const cooldowns = Array.isArray(ev.cooldownPlatforms) ? ev.cooldownPlatforms : [];
    const dried = Array.isArray(ev.driedPlatforms) ? ev.driedPlatforms : [];
    const failedText = failed.map(id => platformMeta(id).label).join(' / ');
    // partial 只是“有平台出错”，真正让运行停下的是关键词已经跑完；
    // 把两者分开显示，避免“10/30”被误解成软件提前停了。
    const exhaustedPartial = ev.reason === 'partial' && ev.found < ev.target;
    let label = exhaustedPartial ? '关键词已跑完' : (labels[ev.reason] || '结束');
    // 选中的平台全都因为“没有新候选”提前收工时，说清楚不是出错、也不是被中断。
    const runPlatformCount = Array.isArray(ev.platforms) ? ev.platforms.length : 0;
    if (ev.reason === 'exhausted' && dried.length && dried.length >= runPlatformCount) {
      label = '没有新候选了';
    }
    const detail = exhaustedPartial && failedText ? `；${failedText} 出错` : '';
    setStatus(label, ev.reason === 'error' ? 'stopped' : '');
    $('elapsedSub').textContent = '已结束';
    runSummary(`结束 · ${ev.found}/${ev.target} · ${label}${detail} · ${ev.requests} 次请求`);
    const donePlatforms = Array.isArray(ev.platforms) && ev.platforms.length ? ev.platforms : state.runPlatforms;
    resetPlatformStats(donePlatforms);
    for (const r of state.results) bumpPlatformCount(r.platform);
    for (const id of donePlatforms) {
      const pp = ppFor(id);
      if (!pp) continue;
      pp.classList.remove('active', 'waiting');
      if (cooldowns.includes(id)) {
        pp.classList.add('waiting');
        pp.querySelector('.pp-status').textContent = '冷却';
      } else if (failed.includes(id) || (ev.reason === 'error' && !failed.length)) {
        pp.classList.add('error');
        pp.querySelector('.pp-status').textContent = '出错';
      } else if (dried.includes(id)) {
        pp.classList.add('waiting');
        pp.querySelector('.pp-status').textContent = '无新候选';
      } else if (!pp.classList.contains('error')) {
        pp.querySelector('.pp-status').textContent = (ev.reason === 'stopped' || ev.reason === 'budget') ? '已停止' : '完成';
      }
    }
    if (ev.found >= ev.target) {
      toast(ev.resultBase
        ? `完成：找到 ${ev.found} 个，结果已保存`
        : `完成：找到 ${ev.found} 个，但结果文件保存失败`, ev.resultBase ? 'ok' : 'warn');
    } else toast(`结束：找到 ${ev.found}/${ev.target} 个（${label}${detail}）`, ev.reason === 'error' ? 'error' : 'warn');
    if (ev.resultBase) appendLog('debug', `结果文件：${ev.resultBase}`);
    refreshConfig();
    return;
  }

  if (ev.type === 'error') {
    toast(ev.message || '出错了', 'error');
    appendLog('error', ev.message || '出错了');
  }
}

function connectSSE() {
  if (state.es) {
    try { state.es.close(); } catch { /* ignore */ }
  }
  const es = new EventSource('/api/events');
  state.es = es;
  es.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        for (const ev of data) handleEvent(ev);
      } else {
        handleEvent(data);
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => setStatus('连接重试中', 'stopped');
  es.onopen = () => {
    if (state.running) setStatus('运行中', 'running');
    else setStatus(state.hasRun ? '上次结束' : '就绪', '');
  };
}

function collectOptions() {
  const platforms = selectedPlatforms();
  const domains = [...document.querySelectorAll('[data-domain]:checked')].map(x => x.dataset.domain);
  if (!platforms.length) { toast('至少选一个平台', 'warn'); return null; }
  if (!domains.length) { toast('至少选一个领域', 'warn'); return null; }
  const min = Number($('minFollowers').value) || 0;
  const max = Number($('maxFollowers').value) || 0;
  if (max <= min) { toast('粉丝上限要大于下限', 'warn'); return null; }
  return {
    platforms,
    domains,
    count: Number($('count').value) || 30,
    minFollowers: min,
    maxFollowers: max,
    activityDays: Number($('activityDays').value),
    delaySec: Number($('delaySec').value),
    jitterSec: Number($('jitterSec').value),
    pauseEvery: Number($('pauseEvery').value),
    pauseSec: Number($('pauseSec').value),
    proxy: $('proxy').value.trim(),
    proxyPool: ($('proxyPool')?.value || '').split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean),
    braveKey: ($('braveKey')?.value || '').trim(),
    avoidDuplicates: $('avoidDuplicates').checked,
    excludeBrands: $('excludeBrands').checked,
    parallelPlatforms: $('parallelPlatforms').checked,
    maxRequests: Number($('maxRequests').value) || 320,
    maxMinutes: Number($('maxMinutes').value) || 30
  };
}

async function startRun() {
  if (state.running) return;
  const options = collectOptions();
  if (!options) return;
  state.startedAt = Date.now();
  setRunning(true);
  setStatus('启动中', 'running');
  runSummary('正在启动…');
  try {
    const res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || '启动失败');
  } catch (e) {
    setRunning(false);
    setStatus('就绪', '');
    runSummary('启动失败');
    toast(e.message, 'error');
  }
}

async function stopRun() {
  try {
    const res = await fetch('/api/stop', { method: 'POST' });
    if (!res.ok) throw new Error('停止失败');
    setStatus('停止中', 'running');
    runSummary('正在停止…');
  } catch (e) {
    toast(e.message || '停止失败', 'error');
  }
}

async function exportFile(format) {
  if (!state.results.length) { toast('还没有结果', 'warn'); return; }
  try {
    const res = await fetch(`/api/export?format=${format}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '导出失败');
    }
    const blob = await res.blob();
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `creators-${stamp}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已导出 ${format.toUpperCase()}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function openResults() {
  try {
    const res = await fetch('/api/open-results', { method: 'POST' });
    if (!res.ok) throw new Error('打开文件夹失败');
  } catch {
    toast('打开文件夹失败', 'error');
  }
}

function updateHistoryBadge(total) {
  state.historyTotal = Number(total) || 0;
  const el = $('historyCount');
  el.textContent = String(state.historyTotal);
  el.title = `历史记录 ${state.historyTotal} 个`;
}

function weekdayOf(date) {
  const d = new Date(date + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
}

function historyRowHtml(c) {
  const meta = platformMeta(c.platform);
  const handle = c.handle ? '@' + c.handle : '';
  const legacy = c.url ? '' : '旧记录';
  const sub = [handle, meta.label, legacy].filter(Boolean).join(' · ');
  const repeatCount = Math.max(Number(c.repeatCount) || 1, Number(c.seenCount) || 1);
  const repeat = repeatCount > 1
    ? `<span class="history-repeat">重复 ${repeatCount} 次</span>`
    : '';
  const attrs = c.url
    ? `href="${escapeHtml(c.url)}" target="_blank" rel="noreferrer" title="打开主页"`
    : '';
  return `
    <a class="history-row${c.url ? '' : ' no-link'}${repeatCount > 1 ? ' is-repeat' : ''}" data-platform="${escapeHtml(c.platform)}" ${attrs}>
      <span class="avatar avatar-${meta.cls}" title="来源平台：${escapeHtml(meta.label)}">${PLATFORM_ICONS[c.platform] ? platformIcon(c.platform) : escapeHtml(meta.mark)}</span>
      <span class="history-main">
        <span class="history-title"><strong>${escapeHtml(c.name)}</strong>${repeat}</span>
        <span class="history-sub">${escapeHtml(sub)}</span>
      </span>
      <span class="history-followers">${escapeHtml(c.followersText || '—')}</span>
      <span class="history-domain" title="${escapeHtml(c.domainName || '')}">${escapeHtml(c.domainName || '—')}</span>
      <span class="history-latest">${escapeHtml(c.latest || '—')}</span>
    </a>`;
}

function renderHistoryPlatforms() {
  const box = $('historyPlatforms');
  if (!box) return;
  const data = state.historyData;
  if (!data) { box.innerHTML = ''; return; }
  const counts = {};
  for (const day of data.days) {
    for (const c of day.creators) counts[c.platform] = (counts[c.platform] || 0) + 1;
  }
  if (state.historyFilter !== 'all' && !counts[state.historyFilter]) state.historyFilter = 'all';
  const chips = [`<button class="history-chip${state.historyFilter === 'all' ? ' on' : ''}" data-hplatform="all">全部 ${data.total}</button>`];
  for (const [id, meta] of Object.entries(PLATFORM_META)) {
    if (!counts[id]) continue;
    chips.push(`<button class="history-chip${state.historyFilter === id ? ' on' : ''}" data-hplatform="${escapeHtml(id)}">${escapeHtml(meta.short)} ${counts[id]}</button>`);
  }
  box.innerHTML = chips.join('');
}

function filteredHistoryDays() {
  const data = state.historyData;
  if (!data) return [];
  const q = state.historySearch.trim().toLowerCase();
  return data.days
    .map(day => ({
      date: day.date,
      creators: day.creators.filter(c => {
        if (state.historyFilter !== 'all' && c.platform !== state.historyFilter) return false;
        if (!q) return true;
        return `${c.name || ''} ${c.handle || ''} ${c.domainName || ''} ${c.description || ''}`.toLowerCase().includes(q);
      })
    }))
    .filter(day => day.creators.length);
}

function expandFilteredDays() {
  for (const day of filteredHistoryDays()) state.historyExpanded.add(day.date);
}

function renderHistory() {
  const body = $('historyBody');
  if (!body) return;
  const data = state.historyData;
  if (!data) return;
  const days = filteredHistoryDays();
  const total = days.reduce((n, day) => n + day.creators.length, 0);
  $('historyMeta').textContent = total === data.total
    ? `按天归档 · 同一账号只记一次 · 重复账号排最后 · 共 ${data.total} 个 / ${days.length} 天`
    : `筛选后 ${total} 个 / ${days.length} 天 · 历史总计 ${data.total} 个`;
  if (!days.length) {
    body.innerHTML = `<div class="history-empty"><strong>${data.total ? '没有匹配的历史记录' : '还没有历史记录'}</strong><p>${data.total ? '换个关键词或平台筛选试试。' : '找到的创作者会自动按天归档；同一平台同一账号只记一次。'}</p></div>`;
    return;
  }
  body.innerHTML = days.map(day => {
    const expanded = state.historyExpanded.has(day.date);
    return `
      <section class="history-day${expanded ? '' : ' collapsed'}">
        <button type="button" class="history-day-head" data-hday="${escapeHtml(day.date)}" aria-expanded="${expanded}">
          <span class="history-day-date"><strong>${escapeHtml(day.date)}</strong><span>${escapeHtml(weekdayOf(day.date))} · ${day.creators.length} 个</span></span>
          <span class="history-day-chevron" aria-hidden="true">⌄</span>
        </button>
        <div class="history-day-body"${expanded ? '' : ' hidden'}>
          ${day.creators.map(historyRowHtml).join('')}
        </div>
      </section>`;
  }).join('');
}

async function reloadHistory() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) throw new Error('读取历史失败');
    state.historyData = await res.json();
    updateHistoryBadge(state.historyData.total);
    if (!state.historyExpanded.size && state.historyData.days.length) {
      state.historyExpanded.add(state.historyData.days[0].date);
    }
    if (!state.historyOpen) return;
    renderHistoryPlatforms();
    renderHistory();
  } catch (e) {
    if (state.historyOpen) {
      $('historyBody').innerHTML = `<div class="history-empty"><strong>读取历史失败</strong><p>${escapeHtml(e.message || '请稍后再试')}</p></div>`;
    }
  }
}

function openHistory() {
  state.historyOpen = true;
  $('historyModal').hidden = false;
  document.body.classList.add('modal-open');
  $('historySearch').value = state.historySearch;
  $('historyBody').innerHTML = '<div class="history-empty"><p>正在读取历史…</p></div>';
  renderHistoryPlatforms();
  reloadHistory();
  setTimeout(() => { try { $('historyClose').focus(); } catch { /* ignore */ } }, 0);
}

function closeHistory() {
  if (!state.historyOpen) return;
  state.historyOpen = false;
  $('historyModal').hidden = true;
  document.body.classList.remove('modal-open');
  $('historyBtn').focus();
}

async function clearAllHistory() {
  if (!confirm('确定清空历史记录和去重库？清空后以前出现过的账号会再次被抓到，历史也会从空开始。')) return;
  try {
    const res = await fetch('/api/seen/clear', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || '清空失败');
    updateSeen(data.seen);
    updateHistoryBadge(data.historyTotal || 0);
    state.historyData = { total: 0, days: [] };
    state.historyExpanded = new Set();
    renderHistoryPlatforms();
    renderHistory();
    toast('历史记录和去重库已清空');
  } catch (e) {
    toast(e.message || '清空失败', 'error');
  }
}

async function clearSeen() {
  return clearAllHistory();
}

function refreshConfig() {
  fetch('/api/config').then(r => r.json()).then(cfg => {
    state.config = cfg;
    updateSeen(cfg.seen);
    updateHistoryBadge(cfg.historyTotal || 0);
    if (state.historyOpen) reloadHistory();
  }).catch(() => {});
}

function saveSettings() {
  if (!state.config) return;
  const data = {
    v: 4,
    count: $('count').value,
    activityDays: $('activityDays').value,
    minFollowers: $('minFollowers').value,
    maxFollowers: $('maxFollowers').value,
    delaySec: $('delaySec').value,
    jitterSec: $('jitterSec').value,
    pauseEvery: $('pauseEvery').value,
    pauseSec: $('pauseSec').value,
    proxy: $('proxy').value,
    proxyPool: $('proxyPool') ? $('proxyPool').value : '',
    braveKey: $('braveKey') ? $('braveKey').value : '',
    maxRequests: $('maxRequests').value,
    maxMinutes: $('maxMinutes').value,
    avoidDuplicates: $('avoidDuplicates').checked,
    excludeBrands: $('excludeBrands').checked,
    parallelPlatforms: $('parallelPlatforms').checked,
    sort: $('resultSort').value,
    platforms: [...document.querySelectorAll('[data-platform]:checked:not(:disabled)')].map(x => x.dataset.platform),
    domains: [...document.querySelectorAll('[data-domain]:checked')].map(x => x.dataset.domain)
  };
  writeStore(SETTINGS_KEY, JSON.stringify(data));
}

function applySavedSettings() {
  let s = {};
  try { s = JSON.parse(readStore(SETTINGS_KEY) || '{}'); } catch { /* ignore */ }
  const textKeys = ['count', 'activityDays', 'minFollowers', 'maxFollowers', 'delaySec', 'jitterSec', 'pauseEvery', 'pauseSec', 'proxy', 'proxyPool', 'braveKey', 'maxRequests', 'maxMinutes'];
  for (const k of textKeys) {
    if (s[k] == null) continue;
    if (k !== 'proxy' && s[k] === '') continue;
    $(k).value = s[k];
  }
  if (s.activityDays == null && s.activityMonths != null) {
    $('activityDays').value = Math.round(Number(s.activityMonths) * 30.44) || 0;
  }
  if (typeof s.avoidDuplicates === 'boolean') $('avoidDuplicates').checked = s.avoidDuplicates;
  if (typeof s.excludeBrands === 'boolean') $('excludeBrands').checked = s.excludeBrands;
  if (typeof s.parallelPlatforms === 'boolean') $('parallelPlatforms').checked = s.parallelPlatforms;
  if (s.sort === 'followers' || s.sort === 'activity') $('resultSort').value = s.sort;

  if (Array.isArray(s.platforms)) {
    const saved = s.platforms.slice();
    if (!s.v) {
      for (const id of ['kick', 'rumble']) {
        if (!saved.includes(id)) saved.push(id);
      }
    }
    // v4 之前 TikTok 一直是“受限”，老设置里不可能主动取消它；升级后默认补上。
    if (!s.v || s.v < 4) {
      if (!saved.includes('tiktok')) saved.push('tiktok');
    }
    document.querySelectorAll('input[data-platform]').forEach(input => {
      input.checked = !input.disabled && saved.includes(input.dataset.platform);
      input.closest('.platform-card').classList.toggle('checked', input.checked);
    });
  }
  if (Array.isArray(s.domains)) {
    const inputs = [...document.querySelectorAll('[data-domain]')];
    const known = new Set(inputs.map(x => x.dataset.domain));
    let saved = s.domains.filter(id => known.has(id));
    // 旧版默认全选；把“全选”当作没做过选择，升级后不再一屏全亮。
    if ((!s.v || s.v < 3) && saved.length >= inputs.length) saved = [];
    const picked = new Set(saved);
    inputs.forEach(input => {
      input.checked = picked.has(input.dataset.domain);
      input.closest('.chip').classList.toggle('checked', input.checked);
    });
  }
  state.sort = $('resultSort').value;
  updatePlatformSelection();
  updateDomainCount();
  updateSafetySummary();
  saveSettings();
}

function applyTheme(theme, persist) {
  const next = THEMES.includes(theme) ? theme : 'ember';
  document.documentElement.dataset.theme = next;
  document.querySelectorAll('#themeDots .theme-dot').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.theme === next ? 'true' : 'false');
  });
  if (persist) writeStore(THEME_KEY, next);
  try { window.creatorAPI?.setTheme(next); } catch { /* 非 Electron 预览时忽略 */ }
}

function applyLogCollapsed(collapsed) {
  $('logPanel').classList.toggle('collapsed', collapsed);
  $('logToggle').textContent = collapsed ? '展开' : '收起';
}

function applyNetworkOpen(open) {
  $('networkBody').classList.toggle('collapsed', !open);
  $('networkToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('networkToggle').title = open ? '收起网络设置' : '展开网络设置';
}

function applyDomainOpen(open) {
  $('domainBody').classList.toggle('collapsed', !open);
  $('domainToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('domainToggle').title = open ? '收起领域选择' : '展开领域选择';
}

function bindEvents() {
  $('themeDots').addEventListener('click', e => {
    const btn = e.target.closest('button[data-theme]');
    if (btn) applyTheme(btn.dataset.theme, true);
  });
  $('startBtn').addEventListener('click', startRun);
  $('stopBtn').addEventListener('click', stopRun);
  $('historyBtn').addEventListener('click', openHistory);
  $('historyClose').addEventListener('click', closeHistory);
  $('historyClear').addEventListener('click', clearAllHistory);
  $('historyModal').addEventListener('click', e => {
    if (e.target.closest('[data-history-close]')) closeHistory();
  });
  $('historySearch').addEventListener('input', () => {
    state.historySearch = $('historySearch').value;
    expandFilteredDays();
    renderHistory();
  });
  $('historyPlatforms').addEventListener('click', e => {
    const btn = e.target.closest('[data-hplatform]');
    if (!btn) return;
    state.historyFilter = btn.dataset.hplatform;
    expandFilteredDays();
    renderHistoryPlatforms();
    renderHistory();
  });
  $('historyBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-hday]');
    if (!btn) return;
    const date = btn.dataset.hday;
    if (state.historyExpanded.has(date)) state.historyExpanded.delete(date);
    else state.historyExpanded.add(date);
    renderHistory();
  });
  $('exportMd').addEventListener('click', () => exportFile('md'));
  $('exportCsv').addEventListener('click', () => exportFile('csv'));
  $('openResults').addEventListener('click', openResults);
  $('openResultsTop').addEventListener('click', openResults);
  $('clearSeen').addEventListener('click', clearSeen);
  $('clearLog').addEventListener('click', clearLog);
  $('domainsAll').addEventListener('click', () => setAllDomains(true));
  $('domainsNone').addEventListener('click', () => setAllDomains(false));
  $('fastPreset').addEventListener('click', () => {
    $('delaySec').value = 3;
    $('jitterSec').value = 0.5;
    $('pauseEvery').value = 20;
    $('pauseSec').value = 10;
    applyNetworkOpen(true);
    writeStore(NETWORK_OPEN_KEY, '1');
    updateSafetySummary();
    saveSettings();
    toast('已切换到快速模式：3 秒间隔，平台内仍然串行');
  });
  $('safePreset').addEventListener('click', () => {
    $('delaySec').value = 6;
    $('jitterSec').value = 2;
    $('pauseEvery').value = 6;
    $('pauseSec').value = 30;
    applyNetworkOpen(true);
    writeStore(NETWORK_OPEN_KEY, '1');
    updateSafetySummary();
    saveSettings();
    toast('已切换到安全模式：6 秒间隔，每 6 次长休 30 秒');
  });

  $('domainSearch').addEventListener('input', applyDomainFilter);

  $('platformList').addEventListener('change', e => {
    const input = e.target.closest('input[data-platform]');
    if (!input) return;
    input.closest('.platform-card').classList.toggle('checked', input.checked);
    updatePlatformSelection();
  });

  $('domainList').addEventListener('change', e => {
    const input = e.target.closest('input[data-domain]');
    if (!input) return;
    input.closest('.chip').classList.toggle('checked', input.checked);
    updateDomainCount();
  });

  $('platformFilter').addEventListener('click', e => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    renderResults(false);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#clearFiltersBtn')) return;
    state.filter = 'all';
    state.search = '';
    $('resultSearch').value = '';
    renderResults(false);
  });

  $('resultSearch').addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.search = $('resultSearch').value;
      renderResults(false);
    }, 120);
  });

  $('resultSort').addEventListener('change', () => {
    state.sort = $('resultSort').value;
    renderResults(false);
  });

  $('logToggle').addEventListener('click', () => {
    const collapsed = !$('logPanel').classList.contains('collapsed');
    applyLogCollapsed(collapsed);
    writeStore(LOG_COLLAPSE_KEY, collapsed ? '1' : '0');
  });

  $('networkToggle').addEventListener('click', () => {
    const open = $('networkBody').classList.contains('collapsed');
    applyNetworkOpen(open);
    writeStore(NETWORK_OPEN_KEY, open ? '1' : '0');
  });

  $('domainToggle').addEventListener('click', () => {
    const open = $('domainBody').classList.contains('collapsed');
    applyDomainOpen(open);
    writeStore(DOMAIN_OPEN_KEY, open ? '1' : '0');
  });

  $('parallelPlatforms').addEventListener('change', updateSafetySummary);
  $('delaySec').addEventListener('input', updateSafetySummary);
  $('count').addEventListener('input', () => {
    if (state.running) return;
    const target = Number($('count').value) || 30;
    state.target = target;
    updateFound(state.results.length, target);
  });

  document.addEventListener('change', e => {
    if (e.target.matches('input, select')) saveSettings();
  });

  document.addEventListener('input', e => {
    const el = e.target;
    if (!el.matches('input[type="text"], input[type="number"]')) return;
    if (!el.closest('.control-rail')) return;
    clearTimeout(state.settingsTimer);
    state.settingsTimer = setTimeout(saveSettings, 200);
  });

  window.addEventListener('beforeunload', saveSettings);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleFrame();
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (!state.running) startRun();
    } else if (e.key === 'Escape' && state.historyOpen) {
      e.preventDefault();
      closeHistory();
    } else if (e.key === 'Escape' && state.running) {
      e.preventDefault();
      stopRun();
    }
  });
}

async function init() {
  const savedTheme = readStore(THEME_KEY);
  const validTheme = THEMES.includes(savedTheme);
  applyTheme(validTheme ? savedTheme : 'ember', !!savedTheme && !validTheme);
  bindEvents();
  try {
    const res = await fetch('/api/config');
    state.config = await res.json();
    renderPlatforms(state.config.platforms);
    renderDomains(state.config.domains);
    renderPlatformProgress();
    applySavedSettings();
    updateSeen(state.config.seen);
    updateHistoryBadge(state.config.historyTotal || 0);
    updateFound(0, Number($('count').value) || 30);
    updateStats(0, 0);
    updateFilterTabs();
    document.querySelector('.table-wrap').style.display = 'none';
    $('empty').innerHTML = emptyHtml('start');
  } catch (e) {
    toast('读取配置失败：' + e.message, 'error');
  }

  applyLogCollapsed(readStore(LOG_COLLAPSE_KEY) === '1');
  applyNetworkOpen(readStore(NETWORK_OPEN_KEY) === '1');
  applyDomainOpen(readStore(DOMAIN_OPEN_KEY) !== '0');
  connectSSE();
}

// ---------- 应用内升级 ----------
(function initUpdater() {
  const modal = $('updateModal');
  if (!modal) return;
  const api = window.creatorAPI;
  let latest = null;
  let downloading = false;
  let offProgress = null;

  const setStatus = text => { $('updateStatus').textContent = text; };
  const setBar = (pct, show) => {
    $('updateBar').hidden = !show;
    $('updateBarFill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  };

  function closeModal() {
    modal.hidden = true;
    if (offProgress) { offProgress(); offProgress = null; }
  }

  async function runCheck() {
    setStatus('正在检查更新…');
    $('updateAction').disabled = true;
    $('updateNotes').hidden = true;
    $('updateNotes').textContent = '';
    setBar(0, false);
    if (!api || !api.checkUpdate) {
      setStatus('应用内升级只在桌面版可用（浏览器预览里没有这个能力）。');
      return;
    }
    try {
      const r = await api.checkUpdate();
      if (!r || !r.ok) {
        setStatus(`检查失败：${(r && r.error) || '未知错误'}`);
        return;
      }
      if (r.current) $('updateMeta').textContent = `当前版本 ${r.current} · 检查源 ${r.source || '—'}`;
      latest = r;
      if (!r.hasUpdate) {
        setStatus(`已经是最新版本（${r.current}）。`);
        return;
      }
      setStatus(`发现新版本 ${r.latest}（当前 ${r.current}）。`);
      if (r.notes) {
        $('updateNotes').textContent = r.notes;
        $('updateNotes').hidden = false;
      }
      const a = r.assets || {};
      // 便携版拿便携包（默认直连），安装版拿标准包（保留默认代理）。
      // 拿错了会把对方的默认设置带过来，实测踩过。
      const asset = r.portable
        ? (a.portable || a.standard || a.installer)
        : (a.standard || a.installer || a.portable);
      if (!asset) {
        setStatus('这个版本没有可下载的安装包，请到 GitHub Release 页面手动下载。');
        return;
      }
      latest.asset = asset;
      $('updateAction').disabled = false;
      $('updateAction').textContent = r.portable ? '下载新版本' : '下载并升级';
    } catch (e) {
      setStatus(`检查失败：${e.message}`);
    }
  }

  async function startDownload() {
    if (!latest || !latest.asset || downloading) return;
    downloading = true;
    $('updateAction').disabled = true;
    $('updateCancel').hidden = false;
    setBar(0, true);
    setStatus('正在挑选最快的下载通道（直连 + 国内镜像测速）…');
    offProgress = api.onUpdateProgress(p => {
      if (!p) return;
      if (p.phase === 'source') {
        setStatus(`使用通道：${p.source}${p.tried ? `（测速：${p.tried.join('，')}）` : ''}，开始下载…`);
      } else if (p.phase === 'download') {
        setBar(p.percent || 0, true);
        setStatus(`正在下载 ${p.percent || 0}% · ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`);
      } else if (p.phase === 'done') {
        setBar(100, true);
        setStatus('下载完成，sha256 校验通过。');
      }
    });
    const r = await api.downloadUpdate(latest.asset);
    if (offProgress) { offProgress(); offProgress = null; }
    downloading = false;
    $('updateCancel').hidden = true;
    if (!r || !r.ok) {
      setStatus(`下载失败：${(r && r.error) || '未知错误'}`);
      $('updateAction').disabled = false;
      return;
    }
    setStatus(latest.portable ? '正在保存新版本…' : '正在启动安装程序，软件会自动退出…');
    const ins = await api.installUpdate(r.file);
    if (ins && ins.ok) {
      if (ins.mode === 'installer') setStatus('安装程序已启动，请按提示完成安装（会保留 data / results）。');
      else setStatus(`已保存到：${ins.file}\n解压覆盖原文件夹即可；不要删 data / results。`);
    } else {
      setStatus(`启动安装失败：${(ins && ins.error) || '未知错误'}`);
      $('updateAction').disabled = false;
    }
  }

  $('updateBtn').addEventListener('click', async () => {
    modal.hidden = false;
    $('updateAction').textContent = '下载并安装';
    $('updateCancel').hidden = true;
    $('updateMeta').textContent = '当前版本 —';
    if (api && api.version) {
      try { $('updateMeta').textContent = `当前版本 ${await api.version()}`; } catch { /* ignore */ }
    }
    runCheck();
  });
  $('updateClose').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target.closest('[data-update-close]')) closeModal(); });
  $('updateAction').addEventListener('click', startDownload);
  $('updateCancel').addEventListener('click', () => {
    if (api && api.cancelUpdate) api.cancelUpdate();
    setStatus('已取消下载。');
    $('updateCancel').hidden = true;
    downloading = false;
    $('updateAction').disabled = false;
  });
})();

init();
