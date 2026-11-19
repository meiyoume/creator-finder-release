'use strict';
// 可选通道：Brave Search API（https://api.search.brave.com/res/v1/web/search）。
// 填了 key 就完全绕开网页抓取：不受 IP 限流、不弹验证码、返回 JSON。
// 免费额度约每月 $5 信用（≈1000 次查询），对每天几十个关键词足够。
//
// 没有 key 时本模块所有函数返回 null，调用方继续走原来的网页抓取逻辑。

const { extractLinks } = require('./bridge');

function hasKey(ctx) {
  return !!(ctx && ctx.braveKey);
}

async function urls(site, query, ctx) {
  if (!hasKey(ctx)) return null;
  const url = 'https://api.search.brave.com/res/v1/web/search?q=' +
    encodeURIComponent(`site:${site} ${query}`) +
    '&count=20&search_lang=en&safesearch=off';
  const res = await ctx.get(url, {
    label: `Brave API：${site} ${query}`,
    timeout: 20,
    headers: { Accept: 'application/json', 'X-Subscription-Token': ctx.braveKey }
  });
  if (res.status !== 200) {
    return { ok: false, status: res.status, urls: [], error: `Brave API HTTP ${res.status || '失败'}` };
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* ignore */ }
  if (!json) return { ok: false, status: 200, urls: [], error: 'Brave API 返回不是 JSON' };
  const list = json.web && Array.isArray(json.web.results) ? json.web.results : [];
  return { ok: true, status: 200, urls: list.map(r => r && r.url).filter(u => /^https?:/i.test(u)), error: null };
}

function handlesFor(site, list) {
  const found = extractLinks((list || []).join('\n'));
  if (site === 'x.com') return found.x;
  if (site === 'tiktok.com') return found.tiktok;
  if (site === 'rumble.com') return found.rumble;
  if (site === 'kick.com') return found.kick;
  return [];
}

module.exports = { hasKey, urls, handlesFor };
