'use strict';

const { parseCount, stripTags, compactCount, daysToZh } = require('../util');
const searchApi = require('../search-api');

const BRAND_RE = /\b(official|shop|store|supply|supplies|magazine|community|agency|company|llc|inc\.?|corporation|network|how-to|media|publishing)\b/i;
const RESERVED = new Set([
  'tiktok', 'foryou', 'search', 'discover', 'live', 'music', 'trending',
  'newsroom', 'support', 'safety', 'creators', 'business'
]);

function extractBraveItems(html) {
  const out = [];
  // Brave 的结果块结构不稳定，只取 handle；粉丝数只信 DDG 的结果块级摘要，
  // 避免把相邻结果的粉丝数误挂到当前账号上，导致把该找的人提前筛掉。
  for (const m of String(html).matchAll(/href="https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,30})/gi)) {
    out.push({ handle: m[1], followers: null, name: '', bio: '' });
  }
  return out;
}

function extractDdgItems(html) {
  const source = String(html);
  const items = [];
  // DDG 的每个自然结果块里，标题链接后面通常跟着 "353.8K Followers"。
  // 先按结果块解析，拿到 handle + 粉丝数，后面就能在打开主页前筛掉区间外的人。
  for (const block of source.split(/<div class="result results_links/i).slice(1)) {
    let handle = '';
    for (const m of block.matchAll(/uddg=([^&"]+)/g)) {
      let u;
      try { u = new URL(decodeURIComponent(m[1])); } catch { continue; }
      if (u.hostname.replace(/^www\./, '').toLowerCase() !== 'tiktok.com') continue;
      const mm = u.pathname.match(/^\/@([A-Za-z0-9._]{2,30})/);
      if (mm) { handle = mm[1]; break; }
    }
    if (!handle) continue;
    const text = stripTags(block);
    const fm = text.match(/([\d.,]+)\s*([KMB])?\s*Followers/i);
    const titleM = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM ? stripTags(titleM[1]) : '';
    const name = (title.match(/^(.*?)\s*\(@/) || [])[1] || '';
    items.push({
      handle,
      followers: fm ? parseCount(fm[1] + (fm[2] || '')) : null,
      name,
      bio: text.slice(0, 320)
    });
  }
  if (items.length) return items;

  // 布局变化时退回纯链接扫描：仍然能发现 handle，只是没有粉丝数提示。
  const out = [], seen = new Set();
  for (const m of source.matchAll(/uddg=([^&"]+)/g)) {
    let u;
    try { u = decodeURIComponent(m[1]); } catch { continue; }
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.hostname.replace(/^www\./, '').toLowerCase() !== 'tiktok.com') continue;
    const mm = p.pathname.match(/^\/@([A-Za-z0-9._]{2,30})/);
    if (!mm) continue;
    const handle = mm[1];
    const key = handle.toLowerCase();
    if (RESERVED.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ handle, followers: null, name: '', bio: '' });
  }
  return out;
}

function mergeItems(groups) {
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

const gate = require('../discovery-gate');

// DDG 被限流时不总是回 202：实测也会回 200 + 一个解析不出结果的壳页面。
// 连续 4 个词都解析不出东西就当它已经被限流，主动冷却，免得把剩下的词全空跑一遍。
let ddgEmptyStreak = 0;

async function discover(query, ctx) {
  // 配了 Brave Search API key 就直接走 JSON 接口，不抓网页、不受 IP 限流影响。
  if (searchApi.hasKey(ctx)) {
    const api = await searchApi.urls('tiktok.com', query, ctx);
    if (api && api.ok) {
      const items = searchApi.handlesFor('tiktok.com', api.urls).map(handle => ({ handle, followers: null, name: '', bio: '' }));
      if (items.length) return { error: null, ...mergeItems([items]), source: 'brave-api' };
    } else if (api && (api.status === 401 || api.status === 403)) {
      return { error: `${api.error}（检查设置里的 Brave API key）`, handles: [], hints: Object.create(null), source: '' };
    }
  }
  // DDG 先查：它的结果 snippet 带粉丝数，能直接预筛；Brave 只作为数量不足时的补充。
  let ddgItems = [];
  let ddgStatus = 0;
  if (gate.available('ddg')) {
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(`site:tiktok.com ${query}`);
    const ddg = await ctx.get(ddgUrl, { label: `TikTok 发现(DDG)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    ddgStatus = ddg.status;
    if (ddg.status === 200) {
      ddgItems = extractDdgItems(ddg.body);
      if (!ddgItems.length) {
        // 同样的 200 空壳：换更轻的 lite 版再解析一次（只拿 handle，粉丝数留给 embed 页）。
        const liteUrl = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(`site:tiktok.com ${query}`);
        const lite = await ctx.get(liteUrl, { label: `TikTok 发现(DDG lite)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
        if (lite.status === 200) ddgItems = extractBraveItems(lite.body);
      }
      if (ddgItems.length) ddgEmptyStreak = 0;
      else if (++ddgEmptyStreak >= 4) gate.block('ddg');
    } else if (ddg.status === 202 || ddg.status === 429) {
      gate.block('ddg');
    }
  }

  // 一个词能拿到 4 个以上不同候选就先走，不再为了几个补充候选多花一次 Brave 请求。
  if (ddgItems.length) {
    const merged = mergeItems([ddgItems]);
    if (merged.handles.length >= 4) return { error: null, ...merged, source: 'ddg' };
  }

  let braveItems = [];
  let braveStatus = 0;
  if (gate.available('brave')) {
    const braveUrl = 'https://search.brave.com/search?q=' + encodeURIComponent(`site:tiktok.com ${query}`);
    // Brave 只对 curl 偶尔放行，且会给非浏览器客户端 30–60 秒慢速陷阱
    const brave = await ctx.get(braveUrl, { label: `TikTok 发现(Brave)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    braveStatus = brave.status;
    const tarpit = brave.status === 200 && Number(brave.ms) > 12000;
    if (brave.status === 429 || brave.status === 403 || tarpit) {
      gate.block('brave');
      braveStatus = tarpit ? 0 : brave.status;
    } else if (brave.status === 200) {
      braveItems = extractBraveItems(brave.body);
    }
  }

  const merged = mergeItems([braveItems, ddgItems]);
  if (merged.handles.length) {
    const source = braveItems.length && ddgItems.length ? 'brave+ddg' : (ddgItems.length ? 'ddg' : 'brave');
    return { error: null, ...merged, source };
  }

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

  const braveNote = !gate.available('brave')
    ? 'Brave 冷却中'
    : (braveStatus === 200 ? 'Brave 无结果' : `Brave HTTP ${braveStatus || '失败'}`);
  const ddgNote = !gate.available('ddg')
    ? 'DDG 冷却中'
    : (ddgStatus === 200 ? 'DDG 无结果' : `DDG HTTP ${ddgStatus || '失败'}`);
  return { error: `${ddgNote} / ${braveNote}`, handles: [], hints: Object.create(null), source: '' };
}

function decodeJsonString(raw) {
  try {
    return JSON.parse('"' + raw + '"');
  } catch {
    return String(raw || '')
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

function extractArrayAfter(text, marker) {
  const i = text.indexOf(marker);
  if (i < 0) return null;
  let start = i + marker.length;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (text[start] !== '[') return null;
  let depth = 0, inStr = false, esc = false;
  for (let p = start; p < text.length; p++) {
    const c = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, p + 1);
    }
  }
  return null;
}

function validSeconds(sec) {
  return Number.isFinite(sec) && sec > 946684800 && sec < Date.now() / 1000 + 172800;
}

function latestFromArray(arrText) {
  if (!arrText) return null;
  let latest = 0;
  for (const m of arrText.matchAll(/"createTime":\s*(\d{10})/g)) {
    const sec = Number(m[1]);
    if (validSeconds(sec)) latest = Math.max(latest, sec);
  }
  for (const m of arrText.matchAll(/"id":\s*"?(\d{15,25})"?/g)) {
    let sec;
    try { sec = Number(BigInt(m[1]) >> 32n); } catch { continue; }
    if (validSeconds(sec)) latest = Math.max(latest, sec);
  }
  return latest || null;
}

function parsePage(body, handle) {
  if (!body) return null;
  const idx = body.indexOf('"followerCount"');
  if (idx < 0) return null;
  const fm = body.slice(idx).match(/^"followerCount":\s*(\d+)/);
  if (!fm) return null;
  const followers = Number(fm[1]);
  if (!Number.isFinite(followers)) return null;

  const before = body.slice(Math.max(0, idx - 5000), idx);
  const after = body.slice(idx, idx + 4000);
  const win = before + after;

  const uidMatches = [...before.matchAll(/"uniqueId":"((?:[^"\\]|\\.)*)"/g)];
  const uid = uidMatches.length
    ? decodeJsonString(uidMatches[uidMatches.length - 1][1])
    : (after.match(/"uniqueId":"((?:[^"\\]|\\.)*)"/) ? decodeJsonString(after.match(/"uniqueId":"((?:[^"\\]|\\.)*)"/)[1]) : handle);

  const nameMatch = win.match(/"nickname":"((?:[^"\\]|\\.)*)"/);
  const sigMatch = win.match(/"signature":"((?:[^"\\]|\\.)*)"/);
  const name = nameMatch ? decodeJsonString(nameMatch[1]) : uid;
  const signature = sigMatch ? decodeJsonString(sigMatch[1]) : '';
  const privateAccount = /"privateAccount":\s*true/.test(win);

  let latestSec = latestFromArray(extractArrayAfter(body, '"videoList":'));
  if (!latestSec) latestSec = latestFromArray(extractArrayAfter(body, '"itemList":'));

  const activityDays = latestSec ? Math.max(0, (Date.now() - latestSec * 1000) / 86400000) : null;
  return {
    uid: uid || handle,
    name: name || uid || handle,
    signature,
    followers,
    followersText: compactCount(followers),
    privateAccount,
    activityDays,
    latest: activityDays == null ? '' : daysToZh(activityDays),
    latestRaw: latestSec ? new Date(latestSec * 1000).toISOString() : '',
    isBrand: BRAND_RE.test(`${name || ''} ${signature}`)
  };
}

async function profile(handle, ctx) {
  const embedUrl = `https://www.tiktok.com/embed/@${encodeURIComponent(handle)}`;
  // embed 页走 curl：实测同样的请求，Chromium 会被 TikTok 回 429、curl 稳定 200；
  // 这里不涉及需要浏览器指纹的登录态，用轻的那条通道更快也更少触发限流。
  const res = await ctx.get(embedUrl, { label: `TikTok 核验：@${handle}`, timeout: 35, transport: 'curl' });
  let parsed = res.status === 200 ? parsePage(res.body, handle) : null;

  if (!parsed || parsed.followers == null) {
    const fallbackUrl = `https://www.tiktok.com/@${encodeURIComponent(handle)}?lang=en`;
    const fb = await ctx.get(fallbackUrl, { label: `TikTok 主页：@${handle}`, timeout: 35, transport: 'curl' });
    if (fb.status === 200) {
      const p2 = parsePage(fb.body, handle);
      if (p2 && p2.followers != null) parsed = p2;
    }
    if (!parsed || parsed.followers == null) {
      return { error: `未解析到粉丝数（HTTP ${res.status}/${fb.status}）` };
    }
  }
  if (parsed.privateAccount) return { error: '私密账号' };

  return {
    error: null,
    platform: 'tiktok',
    id: String(parsed.uid).toLowerCase(),
    name: parsed.name,
    handle: parsed.uid,
    url: `https://www.tiktok.com/@${encodeURIComponent(parsed.uid)}`,
    followers: parsed.followers,
    followersText: parsed.followersText,
    description: parsed.signature,
    activityDays: parsed.activityDays,
    latest: parsed.latest,
    latestRaw: parsed.latestRaw,
    links: parsed.signature || '',
    isBrand: parsed.isBrand
  };
}

function resetCooldowns() {
  ddgEmptyStreak = 0;
  gate.reset();
}

module.exports = { discover, profile, resetCooldowns };
