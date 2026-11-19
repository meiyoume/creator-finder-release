'use strict';

const { compactCount, daysToZh } = require('../util');
const gate = require('../discovery-gate');
const searchApi = require('../search-api');

const RESERVED = new Set([
  'search', 'categories', 'category', 'browse', 'about', 'login', 'signup', 'settings',
  'dashboard', 'following', 'followers', 'video', 'videos', 'clips', 'schedule', 'terms',
  'privacy', 'help', 'en', 'es', 'pt', 'fr', 'de'
]);
const BRAND_RE = /\b(official|shop|store|supply|supplies|magazine|community|agency|company|llc|inc\.?|corporation|network|how-to|media|publishing)\b/i;

function parseDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasZone ? s : s.replace(' ', 'T') + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function addSlug(out, seen, raw) {
  const slug = String(raw || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(slug)) return;
  if (RESERVED.has(slug.toLowerCase())) return;
  const key = slug.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(slug);
}

function extractBrave(html) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/href="https?:\/\/(?:www\.)?kick\.com\/([^"?#/]+)/gi)) {
    addSlug(out, seen, m[1]);
  }
  return out;
}

function extractDdg(html) {
  const out = [], seen = new Set();
  for (const m of String(html).matchAll(/uddg=([^&"]+)/g)) {
    let u;
    try { u = decodeURIComponent(m[1]); } catch { continue; }
    let p;
    try { p = new URL(u); } catch { continue; }
    if (p.hostname.replace(/^www\./, '').toLowerCase() !== 'kick.com') continue;
    addSlug(out, seen, p.pathname.split('/').filter(Boolean)[0] || '');
  }
  return out;
}

async function discover(query, ctx) {
  const apiUrl = 'https://kick.com/api/search?searched_word=' + encodeURIComponent(query);
  const api = await ctx.get(apiUrl, {
    label: `Kick 搜索：${query}`,
    timeout: 35,
    headers: { Accept: 'application/json' }
  });
  if (api.status === 200) {
    try {
      const j = JSON.parse(api.body);
      const out = [], seen = new Set(), hints = Object.create(null);
      for (const c of (j.channels || [])) {
        if (!c || c.is_banned) continue;
        addSlug(out, seen, c.slug);
        const key = String(c.slug || '').toLowerCase();
        const rawFollowers = c.followers_count;
        hints[key] = {
          followers: rawFollowers == null ? NaN : Number(rawFollowers),
          name: c.user?.username || c.slug,
          bio: c.user?.bio || '',
          isLive: !!(c.isLive || (c.livestream && c.livestream.is_live))
        };
      }
      if (out.length) return { error: null, slugs: out, hints, source: 'kick-search' };
    } catch { /* fall through */ }
  }

  // 搜索源冷却状态与 X / Rumble / TikTok 共享：谁先撞到 429/202，其余平台当轮直接跳过，
  // 不会四个平台各撞一遍。
  const braveUrl = 'https://search.brave.com/search?q=' + encodeURIComponent(`site:kick.com ${query}`);
  let brave = { status: 0, body: '' };
  if (gate.available('brave')) {
    brave = await ctx.get(braveUrl, { label: `Kick 发现(Brave)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    const tarpit = brave.status === 200 && Number(brave.ms) > 12000;
    if (brave.status === 429 || brave.status === 403 || tarpit) {
      gate.block('brave');
      brave = { ...brave, status: 0 };
    } else if (brave.status === 200) {
      const slugs = extractBrave(brave.body);
      if (slugs.length) return { error: null, slugs, source: 'brave' };
    }
  }

  if (gate.available('ddg')) {
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(`site:kick.com ${query}`);
    const ddg = await ctx.get(ddgUrl, { label: `Kick 发现(DDG)：${query}`, timeout: 15, skipCooldown: true, transport: 'curl' });
    if (ddg.status === 200) {
      const slugs = extractDdg(ddg.body);
      if (slugs.length) return { error: null, slugs, source: 'ddg' };
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
      source: ''
    };
  }

  const braveNote = !gate.available('brave') ? 'Brave 冷却中' : `Brave HTTP ${brave.status}`;
  const ddgNote = !gate.available('ddg') ? 'DDG 冷却中' : 'DDG 无结果';
  return { error: `Kick 搜索 HTTP ${api.status} / ${braveNote} / ${ddgNote}`, slugs: [], source: '' };
}

async function profile(slug, ctx, hint) {
  let j = null;
  // wantLinks：搜索结果自带粉丝数时本来可以跳过详情请求，但详情里带着
  // twitter / tiktok / youtube，是给其它平台送候选的免费桥接来源——
  // 只对已经进入区间的账号多花这一次请求。
  if (!hint || !Number.isFinite(hint.followers) || hint.wantLinks) {
    const ch = await ctx.get(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      label: `Kick 核验：${slug}`,
      timeout: 35,
      headers: { Accept: 'application/json' }
    });
    if (ch.status !== 200) return { error: `HTTP ${ch.status}` };
    try { j = JSON.parse(ch.body); } catch { return { error: '返回不是 JSON' }; }
    if (!j || j.is_banned) return { error: '频道不可用' };
  }

  const followers = hint && Number.isFinite(hint.followers) ? hint.followers : Number(j && j.followers_count);
  if (!Number.isFinite(followers)) return { error: '未解析到粉丝数' };

  const name = (hint && hint.name) || j?.user?.username || j?.slug || slug;
  const bio = String((hint && hint.bio) || j?.user?.bio || '').replace(/\s+/g, ' ').trim();
  const isLive = hint ? hint.isLive : !!(j.livestream && (j.livestream.is_live || j.livestream.created_at));

  let activityDays = null, latest = '', latestRaw = '';
  if (isLive) {
    activityDays = 0;
    const liveStart = parseDate(j && j.livestream && j.livestream.created_at);
    latestRaw = liveStart ? liveStart.toISOString() : new Date().toISOString();
    latest = '正在直播';
  }
  if (activityDays == null) {
    const v = await ctx.get(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}/videos`, {
      label: `Kick 活跃：${slug}`,
      timeout: 35,
      headers: { Accept: 'application/json' }
    });
    if (v.status === 200) {
      try {
        const parsed = JSON.parse(v.body);
        const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.data) ? parsed.data : []);
        const dates = arr
          .map(x => parseDate(x && x.created_at))
          .filter(Boolean);
        if (dates.length) {
          const newest = new Date(Math.max(...dates.map(d => d.getTime())));
          activityDays = (Date.now() - newest.getTime()) / 86400000;
          latestRaw = newest.toISOString();
          latest = daysToZh(activityDays);
        }
      } catch { /* ignore */ }
    }
  }

  // 频道资料里自带的社交账号（Kick 接口原生字段），直接变成其它平台的候选
  const links = [];
  const u = (j && j.user) || {};
  for (const [field, prefix] of [
    ['twitter', 'https://x.com/'],
    ['tiktok', 'https://www.tiktok.com/@'],
    ['youtube', 'https://www.youtube.com/']
  ]) {
    const v = String(u[field] || '').trim();
    if (!v) continue;
    links.push(/^https?:\/\//i.test(v) ? v : prefix + v.replace(/^@+/, ''));
  }

  return {
    error: null,
    platform: 'kick',
    id: String(slug).toLowerCase(),
    name,
    handle: slug,
    url: `https://kick.com/${slug}`,
    followers,
    followersText: compactCount(followers),
    description: bio,
    activityDays,
    latest,
    latestRaw,
    links,
    isBrand: BRAND_RE.test(`${name} ${bio}`)
  };
}

module.exports = { discover, profile };
