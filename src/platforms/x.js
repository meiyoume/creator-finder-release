'use strict';

const { parseCount, stripTags } = require('../util');
const gate = require('../discovery-gate');
const searchApi = require('../search-api');

const RESERVED = new Set([
  'i', 'search', 'hashtag', 'explore', 'home', 'login', 'logout', 'signup', 'settings',
  'notifications', 'messages', 'compose', 'intent', 'share', 'tos', 'privacy', 'about',
  'download', 'jobs', 'help', 'en', 'account', 'oauth', 'rules', 'premium'
]);

function addHandle(out, seen, raw) {
  const handle = String(raw || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!handle || RESERVED.has(handle.toLowerCase())) return;
  if (!/^[A-Za-z0-9_]{2,15}$/.test(handle)) return;
  const key = handle.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(handle);
}

function extractDdgItems(html) {
  const source = String(html);
  const out = [];
  for (const block of source.split(/<div class="result results_links/i).slice(1)) {
    let handle = '';
    for (const m of block.matchAll(/uddg=([^&"]+)/g)) {
      let u;
      try { u = decodeURIComponent(m[1]); } catch { continue; }
      let parsed;
      try { parsed = new URL(u); } catch { continue; }
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.x.com') continue;
      const seg = parsed.pathname.split('/').filter(Boolean)[0] || '';
      if (!seg || RESERVED.has(seg.toLowerCase())) continue;
      if (!/^[A-Za-z0-9_]{2,15}$/.test(seg)) continue;
      handle = seg;
      break;
    }
    if (!handle) continue;
    const text = stripTags(block);
    const fm = text.match(/([\d.,]+)\s*([KMB])?\s*Followers/i);
    const titleM = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM ? stripTags(titleM[1]) : '';
    const name = (title.match(/^(.*?)\s*\(@/) || [])[1] || title.replace(/\s*[|-]\s*(?:X|Twitter).*$/i, '').trim();
    out.push({
      handle,
      followers: fm ? parseCount(fm[1] + (fm[2] || '')) : null,
      name,
      bio: text.slice(0, 320)
    });
  }
  if (out.length) return out;

  const fallback = [], seen = new Set();
  for (const m of source.matchAll(/uddg=([^&"]+)/g)) {
    let u;
    try { u = decodeURIComponent(m[1]); } catch { continue; }
    let parsed;
    try { parsed = new URL(u); } catch { continue; }
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'x.com' && host !== 'twitter.com' && host !== 'mobile.x.com') continue;
    const seg = parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (!seg || RESERVED.has(seg.toLowerCase())) continue;
    if (!/^[A-Za-z0-9_]{2,15}$/.test(seg)) continue;
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fallback.push({ handle: seg, followers: null, name: '', bio: '' });
  }
  return fallback;
}

function mergeHandles(groups) {
  const handles = [];
  const hints = Object.create(null);
  const seen = new Set();
  for (const group of groups) {
    for (const item of group) {
      const key = item.handle.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        handles.push(item.handle);
      }
      const hint = hints[key] || (hints[key] = { followers: null, name: '', bio: '' });
      if (hint.followers == null && Number.isFinite(item.followers)) hint.followers = item.followers;
      if (!hint.name && item.name) hint.name = item.name;
      if (!hint.bio && item.bio) hint.bio = item.bio;
    }
  }
  return { handles, hints };
}

function extractHrefHandles(html) {
  const out = [];
  const seen = new Set();
  const re = /href="https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^"?#/]+)/gi;
  for (const m of String(html).matchAll(re)) addHandle(out, seen, m[1]);
  return out;
}

async function discoverDdg(query, ctx) {
  if (!gate.available('ddg')) return { error: 'DDG 冷却中', handles: [], hints: Object.create(null), items: [] };
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(`site:x.com ${query}`);
  const res = await ctx.get(url, { label: `X 发现(DDG)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
  if (res.status === 202 || res.status === 429) {
    gate.block('ddg');
    return { error: `HTTP ${res.status}（已冷却 10 分钟）`, handles: [], hints: Object.create(null), items: [] };
  }
  if (res.status !== 200) return { error: `HTTP ${res.status}`, handles: [], hints: Object.create(null), items: [] };
  let items = extractDdgItems(res.body);
  // DDG 有时回 200 但页面解析不出结果（壳页面）。lite 版更轻，换它再试一次；
  // 它和 html 版是同一索引、同一 IP 限制，所以只在 html 明确 200 时才补这一刀。
  if (!items.length) {
    const liteUrl = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(`site:x.com ${query}`);
    const lite = await ctx.get(liteUrl, { label: `X 发现(DDG lite)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    if (lite.status === 200) {
      items = extractHrefHandles(lite.body).map(handle => ({ handle, followers: null, name: '', bio: '' }));
    }
  }
  return { error: null, ...mergeHandles([items]), items };
}

async function discoverBrave(query, ctx) {
  if (!gate.available('brave')) return { error: 'Brave 冷却中', handles: [], hints: Object.create(null), items: [] };
  const url = 'https://search.brave.com/search?q=' + encodeURIComponent(`site:x.com ${query}`);
  // Brave 对浏览器指纹回 429，对 curl 才偶尔给 200；而且会给非浏览器客户端
  // 一个 30–60 秒的「慢速陷阱」。所以固定走 curl、15 秒上限，超时即当被限流。
  const res = await ctx.get(url, { label: `X 发现(Brave)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
  const tarpit = res.status === 200 && Number(res.ms) > 12000;
  if (res.status === 429 || res.status === 403 || tarpit) {
    gate.block('brave');
    return { error: `HTTP ${res.status}${tarpit ? '（响应过慢）' : ''}（已冷却 10 分钟）`, handles: [], hints: Object.create(null), items: [] };
  }
  if (res.status !== 200) return { error: `HTTP ${res.status}`, handles: [], hints: Object.create(null), items: [] };
  const items = extractHrefHandles(res.body).map(handle => ({ handle, followers: null, name: '', bio: '' }));
  return { error: null, ...mergeHandles([items]), items };
}

async function discover(query, ctx) {
  // 配了 Brave Search API key 就直接走 JSON 接口：不抓网页、不受 IP 限流影响。
  if (searchApi.hasKey(ctx)) {
    const api = await searchApi.urls('x.com', query, ctx);
    if (api && api.ok) {
      const items = searchApi.handlesFor('x.com', api.urls).map(handle => ({ handle, followers: null, name: '', bio: '' }));
      if (items.length) return { error: null, ...mergeHandles([items]), items, source: 'brave-api' };
    } else if (api && (api.status === 401 || api.status === 403)) {
      return { error: `${api.error}（检查设置里的 Brave API key）`, handles: [], hints: Object.create(null), items: [] };
    }
  }
  // DDG 快（3 秒）但不稳定；Brave 能出结果但要 30 秒以上并且很快 429。
  // 所以先问快的，不够再问慢的，而不是反过来把 30 秒耗在第一个源上。
  const ddg = await discoverDdg(query, ctx);
  if (!ddg.error && ddg.handles.length >= 4) return { ...ddg, source: 'ddg' };

  const brave = await discoverBrave(query, ctx);
  if (!brave.error && brave.handles.length) {
    const merged = mergeHandles([ddg.items, brave.items]);
    return { error: null, ...merged, source: ddg.handles.length ? 'ddg+brave' : 'brave' };
  }
  if (!ddg.error && ddg.handles.length) return { ...ddg, source: 'ddg' };

  const cd = gate.cooldownInfo();
  if (cd) {
    return {
      error: `DDG / Brave 冷却中（约 ${cd.cooldownMinutes} 分钟）`,
      ...cd,
      handles: [],
      hints: Object.create(null),
      source: ''
    };
  }

  return {
    error: [brave.error, ddg.error].filter(Boolean).join(' / ') || '没有发现结果',
    handles: [],
    hints: Object.create(null),
    source: ''
  };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function daysToZh(days) {
  if (days == null || !Number.isFinite(days)) return '';
  if (days < 1 / 1440) return '刚刚';
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))} 分钟前`;
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} 小时前`;
  if (days < 7) return `${Math.round(days)} 天前`;
  if (days < 30) return `${Math.round(days / 7)} 周前`;
  if (days < 365) return `${Math.round(days / 30.44)} 个月前`;
  return `${Math.round(days / 365.25)} 年前`;
}

function parseLatestActivity(handle, text) {
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    '@' + esc + '\\s+(?:·\\s*)?(?:Pinned\\s+)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}(?:,\\s*\\d{4})?|\\d+\\s*[smhd]|Yesterday|now)',
    'gi'
  );
  const now = new Date();
  let best = null;
  for (const m of text.matchAll(re)) {
    const token = m[1].trim();
    let days = null;
    const rel = token.match(/^(\d+)\s*([smhd])$/i);
    if (rel) {
      const n = +rel[1];
      const u = rel[2].toLowerCase();
      days = n * ({ s: 1 / 86400, m: 1 / 1440, h: 1 / 24, d: 1 }[u] || 0);
    } else if (/^Yesterday$/i.test(token)) {
      days = 1;
    } else if (/^now$/i.test(token)) {
      days = 0;
    } else {
      const dm = token.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
      if (dm) {
        const mon = MONTHS[dm[1].toLowerCase()];
        if (mon == null) continue;
        const day = +dm[2];
        let year = dm[3] ? +dm[3] : now.getFullYear();
        let dt = new Date(year, mon, day, 12, 0, 0);
        if (!dm[3] && dt.getTime() > now.getTime() + 86400000) {
          year -= 1;
          dt = new Date(year, mon, day, 12, 0, 0);
        }
        days = Math.max(0, (now.getTime() - dt.getTime()) / 86400000);
      }
    }
    if (days != null && (best == null || days < best.days)) best = { days, raw: token };
  }
  if (!best) return { activityDays: null, latest: '', latestRaw: '' };
  return {
    activityDays: Math.round(best.days * 100) / 100,
    latest: daysToZh(best.days),
    latestRaw: best.raw
  };
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return stripTags(m[1]);
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? stripTags(m2[1]) : '';
}

function parseProfile(handle, html) {
  const text = stripTags(html);
  let followers = null, followersText = '';
  const m2 = text.match(/([\d.,]+[KMB]?)\s+Following\s+([\d.,]+[KMB]?)\s+Followers/i);
  if (m2) {
    followersText = m2[2];
    followers = parseCount(m2[2]);
  } else {
    const m = text.match(/([\d.,]+[KMB]?)\s+Followers/i);
    if (m && !/with\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) {
      followersText = m[1];
      followers = parseCount(m[1]);
    }
  }
  const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bios = [...text.matchAll(new RegExp('@' + esc + '\\s+([\\s\\S]*?)\\s+Joined', 'gi'))];
  const bio = bios.length ? bios[bios.length - 1][1].trim() : '';
  // 页面正文的姓名会被 "Log in Sign up" 之类的导航文字污染，优先用 og:title。
  const ogTitle = metaContent(html, 'og:title')
    .replace(/\s*\(@[^)]*\).*$/, '')
    .replace(/\s*[/|]\s*X\s*$/i, '')
    .trim();
  const nm = text.match(new RegExp('^(.*?)\\s+\\(@' + esc + '\\)', 'i'));
  const name = ogTitle || (nm ? nm[1].trim() : handle);
  return { name, bio, followers, followersText };
}

const BRAND_RE = /\b(official|shop|store|supply|supplies|magazine|community|agency|company|llc|inc\.?|corporation|network|how-to|howto|media|publishing)\b/i;
const INSTITUTION_RE = /\b(institute|university|college|school|center|centre|foundation|council|association|society|organization|organisation|official|magazine|press|media|network|agency|journal|times|herald|tribune|gazette|broadcasting|television|radio)\b/i;
const HANDLE_BRAND_RE = /(^|_)(official|media|mag|press|journal|times|network|agency)($|_)|mag$/i;

async function profile(handle, ctx) {
  const url = `https://x.com/${encodeURIComponent(handle)}?lang=en`;
  const res = await ctx.get(url, { label: `X 核验：@${handle}`, timeout: 40 });
  if (res.status !== 200) return { error: `HTTP ${res.status}` };
  if (/\/i\/jf\/onboarding|\/i\/flow\/login/i.test(res.body.slice(0, 2000))) return { error: '需要登录' };
  const p = parseProfile(handle, res.body);
  if (p.followers == null) return { error: '未解析到粉丝数' };
  const act = parseLatestActivity(handle, stripTags(res.body));
  return {
    error: null,
    platform: 'x',
    id: handle.toLowerCase(),
    name: p.name,
    handle,
    url: `https://x.com/${handle}`,
    followers: p.followers,
    followersText: p.followersText,
    description: p.bio,
    activityDays: act.activityDays,
    latest: act.latest,
    latestRaw: act.latestRaw,
    isBrand: BRAND_RE.test(`${p.name} ${p.bio}`) || INSTITUTION_RE.test(p.name) || HANDLE_BRAND_RE.test(handle)
  };
}

module.exports = { discover, profile, resetCooldowns: () => gate.reset() };
