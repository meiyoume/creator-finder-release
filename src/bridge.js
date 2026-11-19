'use strict';
// 跨平台桥接（bridge）
//
// 背景：2026-11 实测，DDG（202）、Brave（429 / 30–60 秒拖延）、Bing（忽略 site:）、
// Google（JS 壳）、Yandex/Mojeek/Startpage（人机验证）都拿不到 `site:` 结果。
// X / TikTok / Rumble 的"发现"如果只靠搜索引擎，整轮就是 0 个。
//
// 但创作者自己的公开资料里通常写着别的平台账号：
//   - Kick 频道接口直接给 user.twitter / user.tiktok / user.youtube
//   - YouTube 频道 RSS 的视频简介里常有 X / TikTok / Rumble 链接
//   - TikTok embed 的签名档里也常有链接
// 这些是我们已经为了核验/活跃度而请求过的页面，**零额外请求**就能拿到候选，
// 而且比搜索引擎猜出来的更准（本人自己挂的）。
//
// 桥接只在内存里累计：本轮从 A 平台捞到的人，喂给 B 平台的候选队列。

const RESERVED = {
  x: new Set(['i', 'home', 'search', 'explore', 'intent', 'share', 'hashtag', 'settings', 'login', 'logout',
    'signup', 'tos', 'privacy', 'messages', 'notifications', 'compose', 'account', 'ads', 'about',
    'download', 'jobs', 'help', 'en', 'rules', 'verified', 'premium', 'communities', 'lists']),
  tiktok: new Set(['tiktok', 'discover', 'foryou', 'following', 'search', 'tag', 'music', 'live', 'upload']),
  rumble: new Set(['c', 'user', 'v', 'search', 'channels', 'videos', 'live', 'about', 'terms', 'privacy']),
  kick: new Set(['api', 'search', 'categories', 'following', 'browse', 'video', 'clips', 'login', 'signup',
    'about', 'terms', 'privacy', 'help', 'drops', 'dashboard', 'messages', 'settings', 'directory']),
  twitch: new Set(['directory', 'search', 'p', 'videos', 'settings', 'subscriptions', 'inventory', 'drops',
    'wallet', 'friends', 'login', 'signup', 'downloads', 'jobs', 'turbo', 'store', 'collections',
    'about', 'privacy', 'terms', 'guidelines', 'v', 'team']),
  youtube: new Set(['watch', 'results', 'feed', 'playlist', 'channel', 'c', 'user', 'about', 'shorts'])
};

const PATTERNS = [
  ['x', /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{2,15})(?!["'\w])/g],
  ['tiktok', /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.]{2,24})(?!["'\w])/g],
  ['rumble', /(?:https?:\/\/)?(?:www\.)?rumble\.com\/(?:c|user)\/([A-Za-z0-9_-]{2,40})(?!["'\w])/g],
  ['kick', /(?:https?:\/\/)?(?:www\.)?kick\.com\/([A-Za-z0-9_-]{2,30})(?!["'\w])/g],
  ['twitch', /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([A-Za-z0-9_]{2,25})(?!["'\w])/g]
];

function normalize(platform, raw) {
  let v = String(raw || '').trim().replace(/^@+/, '');
  if (platform === 'tiktok') v = v.replace(/\.+$/, '');
  if (platform === 'twitch') v = v.replace(/^#/, '');
  return v;
}

// 从任意文本（HTML / JSON / 纯文本）里抽出各平台账号，返回 { x:[], tiktok:[], ... }
function extractLinks(text) {
  const out = { x: [], tiktok: [], rumble: [], kick: [], twitch: [] };
  let src = String(text || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  if (!src) return out;
  // YouTube 简介里的外链常被包成 /redirect?q=<urlencoded>，完整解一次编码才能看到真域名
  if (/%3A%2F%2F|%3a%2f%2f/.test(src)) {
    try { src += '\n' + decodeURIComponent(src); } catch { /* 局部坏编码就算了 */ }
  }
  for (const [platform, re] of PATTERNS) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      const handle = normalize(platform, m[1]);
      if (!handle) continue;
      if (RESERVED[platform] && RESERVED[platform].has(handle.toLowerCase())) continue;
      if (/^\d+$/.test(handle) && platform !== 'tiktok') continue;
      out[platform].push(handle);
    }
    out[platform] = [...new Set(out[platform])];
  }
  return out;
}

class Bridge {
  constructor(logger) {
    this.log = logger || (() => {});
    this.map = { x: new Map(), tiktok: new Map(), rumble: new Map(), kick: new Map(), twitch: new Map(), youtube: new Map() };
    this.absorbed = 0;
  }

  // text 可以是任意文本；also 允许直接传 { x, tiktok, ... } 形式的已知账号
  absorb(text, source) {
    if (!text) return 0;
    const found = typeof text === 'string' ? extractLinks(text) : text;
    let n = 0;
    for (const platform of Object.keys(this.map)) {
      const list = found && found[platform];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const handle = normalize(platform, raw);
        if (!handle) continue;
        const key = handle.toLowerCase();
        if (this.map[platform].has(key)) continue;
        this.map[platform].set(key, { handle, source: source || '' });
        n++;
      }
    }
    this.absorbed += n;
    return n;
  }

  // 取最多 limit 个还没被取走的候选（取走即出队，避免同一批反复核验）
  take(platform, limit) {
    const m = this.map[platform];
    if (!m) return [];
    const out = [];
    for (const [key, value] of m) {
      if (out.length >= limit) break;
      out.push(value.handle);
      m.delete(key);
    }
    return out;
  }

  counts() {
    const out = {};
    for (const k of Object.keys(this.map)) out[k] = this.map[k].size;
    return out;
  }
}

module.exports = { Bridge, extractLinks };
