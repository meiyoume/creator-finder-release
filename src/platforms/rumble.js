'use strict';

const { parseCount, compactCount, stripTags, daysToZh } = require('../util');
const gate = require('../discovery-gate');
const searchApi = require('../search-api');

const BRAND_RE = /\b(official|shop|store|supply|supplies|magazine|community|agency|company|llc|inc\.?|corporation|network|how-to|media|publishing)\b/i;

function addSlug(out, seen, raw, kind, hints) {
  const slug = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!/^[A-Za-z0-9_-]{2,60}$/.test(slug)) return;
  const key = slug.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(slug);
  if (kind) {
    const h = hints[key] || (hints[key] = {});
    h.kind = kind;
  }
}

function extractBrave(html) {
  const out = [], seen = new Set(), hints = Object.create(null);
  for (const m of String(html).matchAll(/href="https?:\/\/(?:www\.)?rumble\.com\/(c|user)\/([^"?#/]+)/gi)) {
    addSlug(out, seen, m[2], m[1].toLowerCase(), hints);
  }
  return { slugs: out, hints };
}

function extractDdg(html) {
  const source = String(html);
  const out = [], seen = new Set(), hints = Object.create(null);
  // 结果块里通常带 "12.3K Followers" 和真实路径 /c/ 或 /user/：
  // 前者用来在打开频道页前筛掉区间外的人，后者避免 /c/ 404 后再打一次 /user/。
  for (const block of source.split(/<div class="result results_links/i).slice(1)) {
    let slug = '', kind = '';
    for (const m of block.matchAll(/uddg=([^&"]+)/g)) {
      let u;
      try { u = decodeURIComponent(m[1]); } catch { continue; }
      let p;
      try { p = new URL(u); } catch { continue; }
      if (p.hostname.replace(/^www\./, '').toLowerCase() !== 'rumble.com') continue;
      const parts = p.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'c' && parts[0] !== 'user') continue;
      slug = parts[1] || '';
      kind = parts[0];
      break;
    }
    if (!slug) continue;
    const text = stripTags(block);
    const fm = text.match(/([\d.,]+)\s*([KMB])?\s*Followers/i);
    const titleM = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleM ? stripTags(titleM[1]).replace(/\s*[-|]\s*Rumble.*$/i, '').trim() : '';
    addSlug(out, seen, slug, kind, hints);
    const h = hints[slug.toLowerCase()];
    if (h) {
      if (fm) h.followers = parseCount(fm[1] + (fm[2] || ''));
      if (title) h.name = title;
      if (text) h.bio = text.slice(0, 320);
    }
  }
  if (out.length) return { slugs: out, hints };

  // 布局变化时退回纯链接扫描，至少保留路径类型。
  for (const m of source.matchAll(/uddg=([^&"]+)/g)) {
    let u;
    try { u = decodeURIComponent(m[1]); } catch { continue; }
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.hostname.replace(/^www\./, '').toLowerCase() !== 'rumble.com') continue;
    const parts = p.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'c' && parts[0] !== 'user') continue;
    addSlug(out, seen, parts[1] || '', parts[0], hints);
  }
  return { slugs: out, hints };
}

function extractRelative(html) {
  const out = [], seen = new Set(), hints = Object.create(null);
  for (const m of String(html).matchAll(/href="\/(c|user)\/([^"?#/]+)/gi)) {
    addSlug(out, seen, m[2], m[1].toLowerCase(), hints);
  }
  return { slugs: out, hints };
}

function mergeHints(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    const h = target[key] || (target[key] = {});
    if (value.kind) h.kind = value.kind;
    if (h.followers == null && Number.isFinite(value.followers)) h.followers = value.followers;
    if (!h.name && value.name) h.name = value.name;
    if (!h.bio && value.bio) h.bio = value.bio;
  }
  return target;
}

async function discover(query, ctx) {
  if (searchApi.hasKey(ctx)) {
    const api = await searchApi.urls('rumble.com', query, ctx);
    if (api && api.ok) {
      const slugs = searchApi.handlesFor('rumble.com', api.urls);
      if (slugs.length) return { error: null, slugs, hints: Object.create(null), source: 'brave-api' };
    } else if (api && (api.status === 401 || api.status === 403)) {
      return { error: `${api.error}（检查设置里的 Brave API key）`, slugs: [], hints: Object.create(null), source: '' };
    }
  }
  const braveUrl = 'https://search.brave.com/search?q=' + encodeURIComponent(`site:rumble.com ${query}`);
  let brave = { status: 0, body: '' };
  let braveResult = { slugs: [], hints: Object.create(null) };
  if (gate.available('brave')) {
    brave = await ctx.get(braveUrl, { label: `Rumble 发现(Brave)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    const tarpit = brave.status === 200 && Number(brave.ms) > 12000;
    if (brave.status === 429 || brave.status === 403 || tarpit) {
      gate.block('brave');
      brave = { ...brave, status: 0 };
    } else if (brave.status === 200) {
      braveResult = extractBrave(brave.body);
      if (braveResult.slugs.length >= 12) {
        return { error: null, slugs: braveResult.slugs, hints: braveResult.hints, source: 'brave' };
      }
    }
  }
  if (/(?:news|politic|geopolit|world|conflict|war)/i.test(query)) {
    const cat = await ctx.get('https://rumble.com/channels/news', {
      label: 'Rumble 新闻频道列表',
      timeout: 40
    });
    if (cat.status === 200) {
      const catResult = extractRelative(cat.body);
      const merged = [...braveResult.slugs];
      const seen = new Set(braveResult.slugs.map(s => s.toLowerCase()));
      const hints = mergeHints({ ...braveResult.hints }, catResult.hints);
      for (const s of catResult.slugs) {
        const k = s.toLowerCase();
        if (!seen.has(k)) { seen.add(k); merged.push(s); }
      }
      if (merged.length) {
        return { error: null, slugs: merged, hints, source: 'brave+news-channels' };
      }
    }
  }
  if (braveResult.slugs.length) {
    return { error: null, slugs: braveResult.slugs, hints: braveResult.hints, source: 'brave' };
  }

  if (gate.available('ddg')) {
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(`site:rumble.com ${query}`);
    const ddg = await ctx.get(ddgUrl, { label: `Rumble 发现(DDG)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    if (ddg.status === 200) {
      const found = extractDdg(ddg.body);
      if (found.slugs.length) {
        return { error: null, slugs: found.slugs, hints: found.hints, source: 'ddg' };
      }
    } else if (ddg.status === 202 || ddg.status === 429) {
      gate.block('ddg');
    }
  }

  const cd = gate.cooldownInfo();
  if (cd) {
    return {
      error: `DDG / Brave 冷却中（约 ${cd.cooldownMinutes} 分钟）`,
      ...cd,
      slugs: [],
      hints: Object.create(null),
      source: ''
    };
  }

  const braveNote = !gate.available('brave')
    ? 'Brave 冷却中'
    : (brave.status === 200 ? 'Brave 无结果' : `Brave HTTP ${brave.status || '失败'}`);
  const ddgNote = !gate.available('ddg') ? 'DDG 冷却中' : 'DDG 无结果';
  return { error: `${braveNote} / ${ddgNote}`, slugs: [], hints: Object.create(null), source: '' };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const cp = parseInt(n, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&#(\d+);/g, (_, n) => { const cp = parseInt(n, 10); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return decodeEntities(m[1]);
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${key}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]) : '';
}

function parsePage(html, slug) {
  const fm = html.match(/([\d.,]+[KMB]?)\s*Followers/i);
  const followers = fm ? parseCount(fm[1]) : null;
  let name = metaContent(html, 'og:title');
  if (!name) {
    const tm = html.match(/<title>([^<]+)<\/title>/i);
    name = tm ? decodeEntities(tm[1]) : slug;
  }
  name = name.replace(/\s*[-|]\s*Rumble.*$/i, '').trim() || slug;
  const desc = metaContent(html, 'og:description') || metaContent(html, 'description');

  let activityDays = null, latest = '', latestRaw = '';
  const firstLink = html.search(/<a[^>]+class="[^"]*videostream__link/);
  let firstBlock = '';
  if (firstLink > 0) {
    const prefix = html.slice(Math.max(0, firstLink - 6000), firstLink);
    const thumbs = [...prefix.matchAll(/<div\s+class="[^"]*thumbnail__thumb[^"]*"/g)];
    firstBlock = thumbs.length ? prefix.slice(thumbs[thumbs.length - 1].index) : prefix.slice(-2500);
  }
  const isLive = /videostream__status--live/.test(firstBlock);
  const isDvr = /videostream__status--dvr/.test(firstBlock);
  if (isLive || isDvr) {
    activityDays = 0;
    latestRaw = new Date().toISOString();
    latest = isLive ? '正在直播' : 'DVR（刚直播过）';
  } else {
    const dates = [...html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)]
      .map(m => new Date(m[1]))
      .filter(d => !Number.isNaN(d.getTime()));
    if (dates.length) {
      const newest = new Date(Math.max(...dates.map(d => d.getTime())));
      activityDays = (Date.now() - newest.getTime()) / 86400000;
      latestRaw = newest.toISOString();
      latest = daysToZh(activityDays);
    }
  }

  return {
    name,
    desc,
    followers,
    followersText: followers == null ? '' : compactCount(followers),
    activityDays,
    latest,
    latestRaw
  };
}

async function profile(slug, ctx, hint) {
  const encoded = encodeURIComponent(slug);
  const candidates = [
    `https://rumble.com/c/${encoded}`,
    `https://rumble.com/user/${encoded}`
  ];
  // 搜索结果里已经带了 /c/ 或 /user/，先走命中的那条，避免 404 再补一次请求。
  const ordered = hint && hint.kind === 'user' ? [candidates[1], candidates[0]] : candidates;
  let res = null;
  let url = ordered[0];
  let lastStatus = 0;
  for (const candidate of ordered) {
    res = await ctx.get(candidate, { label: `Rumble 核验：${slug}`, timeout: 40 });
    lastStatus = res.status;
    if (res.status === 200) { url = candidate; break; }
    if (res.status !== 404) break;
  }
  if (!res || res.status !== 200) return { error: `HTTP ${lastStatus}` };
  const p = parsePage(res.body, slug);
  if (p.followers == null) return { error: '未解析到粉丝数' };
  return {
    error: null,
    platform: 'rumble',
    id: String(slug).toLowerCase(),
    name: p.name,
    handle: slug,
    url,
    followers: p.followers,
    followersText: p.followersText,
    description: p.desc,
    activityDays: p.activityDays,
    latest: p.latest,
    latestRaw: p.latestRaw,
    isBrand: BRAND_RE.test(`${p.name} ${p.desc}`)
  };
}

module.exports = { discover, profile, resetCooldowns: () => gate.reset() };
