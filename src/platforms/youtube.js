'use strict';

const { parseCount, compactCount, extractJsonAfter, ageToDays, ageTextToZh, daysToZh } = require('../util');

const CHANNEL_FILTER = 'EgIQAg%3D%3D';
const SUBSCRIBER_RE = /subscriber|登録者|구독자|订阅|訂閱/i;
// 与网页端一致的 innertube 版本号。接口不需要 API key，版本号只是让服务端按 WEB 客户端返回；
// 万一某天这个值过期，search() 会自动回退到整页 HTML 解析，不会把发现步骤整个打断。
const INNERTUBE_CLIENT_VERSION = '2.20261029.11.00';
const SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';

function textOf(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map(r => r.text || '').join('');
  return '';
}

function pickSubscriberText(renderer) {
  const primary = textOf(renderer.videoCountText);
  if (SUBSCRIBER_RE.test(primary)) return primary;
  const alt = textOf(renderer.subscriberCountText);
  if (SUBSCRIBER_RE.test(alt)) return alt;
  if (/video|動画|동영상|视频/i.test(primary)) return '';
  return primary;
}

function collectChannels(data) {
  const out = [];
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.channelRenderer) {
      const r = o.channelRenderer;
      const name = r.title?.simpleText || r.title?.runs?.[0]?.text || '';
      const path = r.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
      let handle = textOf(r.subscriberCountText).replace(/^@/, '').trim();
      if (!handle || /subscriber|登録者|구독자|订阅|訂閱/i.test(handle)) {
        const segs = path.split('/').filter(Boolean);
        handle = segs[0] === 'channel' ? '' : (segs[segs.length - 1] || '').replace(/^@/, '');
      }
      const subsText = pickSubscriberText(r);
      const subs = subsText ? parseCount(subsText) : null;
      const desc = (r.descriptionSnippet?.runs?.map(x => x.text).join('') || '').replace(/\s+/g, ' ').trim();
      const id = r.channelId || r.navigationEndpoint?.browseEndpoint?.browseId || '';
      const key = id || name;
      if (name && id && !seen.has(key)) {
        seen.add(key);
        out.push({
          platform: 'youtube',
          id,
          name: name.trim(),
          handle,
          channelPath: path,
          url: path ? 'https://www.youtube.com' + path : (id ? 'https://www.youtube.com/channel/' + id : ''),
          followers: subs,
          followersText: subs == null ? subsText.trim() : compactCount(subs),
          description: desc
        });
      }
    }
    for (const k in o) walk(o[k]);
  })(data);
  return out;
}

function findSearchContinuations(data) {
  const tokens = [];
  const seen = new Set();
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.continuationCommand && o.continuationCommand.token) {
      const token = o.continuationCommand.token;
      if (!seen.has(token)) { seen.add(token); tokens.push(token); }
    }
    for (const k in o) walk(o[k]);
  })(data);
  return tokens;
}

function pageMeta(html) {
  const apiKey = (String(html).match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || '';
  const clientVersion = (String(html).match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '';
  return { apiKey, clientVersion };
}

function innertubeBody(extra) {
  return JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: INNERTUBE_CLIENT_VERSION, hl: 'en', gl: 'US' } },
    ...extra
  });
}

// 直接调 youtubei/search（POST JSON）：约 17KB（压缩后）/ 20 个频道，
// 和打开整张搜索页（约 257KB 压缩、含脚本和样式）拿到的是同一批 channelRenderer。
// 这一步把 YouTube 发现的流量降到约 1/15，也让单次搜索更快。
async function searchInnertube(query, ctx) {
  if (typeof ctx.post !== 'function') return { error: '当前通道不支持 POST', channels: [] };
  const body = innertubeBody({ query, params: decodeURIComponent(CHANNEL_FILTER) });
  const res = await ctx.post(SEARCH_URL, body, {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': INNERTUBE_CLIENT_VERSION
  }, { label: `YouTube 搜索：${query}`, timeout: 35 });
  if (res.status !== 200) return { error: `HTTP ${res.status}`, status: res.status, channels: [] };
  let data;
  try { data = JSON.parse(res.body); } catch { return { error: '返回不是 JSON', channels: [] }; }
  const channels = collectChannels(data);
  const tokens = findSearchContinuations(data);
  if (!channels.length && !tokens.length) return { error: '没有解析到频道', channels: [] };
  return {
    error: null,
    channels,
    continuations: tokens,
    apiKey: '',
    clientVersion: INNERTUBE_CLIENT_VERSION
  };
}

async function searchHtml(query, ctx) {
  const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&sp=' + CHANNEL_FILTER + '&hl=en';
  let res = await ctx.get(url, { label: `YouTube 搜索（HTML）：${query}`, timeout: 45 });
  if (res.status !== 200) return { error: `HTTP ${res.status}`, channels: [] };
  let data = extractJsonAfter(res.body, 'var ytInitialData = ');
  if (!data) {
    res = await ctx.get(url, { label: `YouTube 搜索重试：${query}`, timeout: 45 });
    if (res.status !== 200) return { error: `HTTP ${res.status}（重试）`, channels: [] };
    data = extractJsonAfter(res.body, 'var ytInitialData = ');
  }
  if (!data) return { error: '页面结构变化，未找到 ytInitialData（已重试）', channels: [] };
  const meta = pageMeta(res.body);
  return {
    error: null,
    channels: collectChannels(data),
    continuations: findSearchContinuations(data),
    apiKey: meta.apiKey,
    clientVersion: meta.clientVersion
  };
}

async function search(query, ctx) {
  const inn = await searchInnertube(query, ctx);
  if (!inn.error) return inn;
  // 被限流时不要再拿 HTML 补一刀，直接把 429 交回引擎做全局退避。
  if (inn.status === 429 || inn.status === 503) return inn;
  return searchHtml(query, ctx);
}

// 频道搜索的第二页：官方 youtubei/search 接口，返回约 20 个 channelRenderer，
// 体积约 17KB（压缩后），比重新打开一整张搜索页轻得多。
async function searchMore(token, ctx, apiKey, clientVersion, query) {
  if (!token) return { error: '缺少翻页参数', channels: [], continuations: [] };
  const version = clientVersion || INNERTUBE_CLIENT_VERSION;
  const url = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false' +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '');
  const body = JSON.stringify({
    context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'US' } },
    continuation: token
  });
  const res = await ctx.post(url, body, {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': version
  }, { label: `YouTube 翻页：${query || ''}`.trim(), timeout: 35 });
  if (res.status !== 200) return { error: `HTTP ${res.status}`, channels: [], continuations: [] };
  let data;
  try { data = JSON.parse(res.body); } catch { return { error: '返回不是 JSON', channels: [], continuations: [] }; }
  return {
    error: null,
    channels: collectChannels(data),
    continuations: findSearchContinuations(data)
  };
}

function freshestVideo(data) {
  let best = null;
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (o.lockupViewModel) {
      const lv = o.lockupViewModel;
      const title = lv.metadata?.lockupMetadataViewModel?.title?.content || '';
      const rows = lv.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const parts = rows.flatMap(r => r.metadataParts || []).map(p => p.text?.content || '');
      const age = parts.find(t => /ago|Premieres|Scheduled/i.test(t)) || '';
      if (title && age && !/^(Premieres|Scheduled)\b/i.test(age) && (!best || ageToDays(age) < ageToDays(best.ageText))) best = { title, ageText: age };
    }
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      const title = v.title?.runs?.map(x => x.text).join('') || v.title?.simpleText || '';
      const age = v.publishedTimeText?.simpleText || '';
      if (title && age && !/^(Premieres|Scheduled)\b/i.test(age) && (!best || ageToDays(age) < ageToDays(best.ageText))) best = { title, ageText: age };
    }
    for (const k in o) walk(o[k]);
  })(data);
  return best;
}

function xmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// 频道 RSS 只返回最近 15 条上传，约 27KB；比 /videos 整页（约 1.3MB）轻两个数量级。
function latestFromRss(xml) {
  let best = null;
  const descs = [];
  for (const m of String(xml || '').matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    const published = xmlText((block.match(/<published>([\s\S]*?)<\/published>/) || [])[1]);
    const when = Date.parse(published);
    const desc = xmlText((block.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1]);
    if (desc) descs.push(desc);
    if (!Number.isFinite(when)) continue;
    const title = xmlText((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    if (!best || when > best.when) best = { when, title };
  }
  // 视频简介里常有 X / TikTok / Rumble 链接，白捡的跨平台候选（RSS 本来就要下）
  if (best) best.links = descs.join('\n').slice(0, 20000);
  return best;
}

async function checkActivity(channel, ctx) {
  const base = channel.channelPath
    ? 'https://www.youtube.com' + channel.channelPath
    : (channel.handle
      ? 'https://www.youtube.com/@' + encodeURIComponent(channel.handle)
      : (channel.id ? 'https://www.youtube.com/channel/' + encodeURIComponent(channel.id) : ''));
  if (!base) return null;

  if (channel.id) {
    const rssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channel.id);
    const rss = await ctx.get(rssUrl, { label: `检查活跃：${channel.handle || channel.name}`, timeout: 25 });
    if (rss.status === 200) {
      const latest = latestFromRss(rss.body);
      if (latest) {
        const days = Math.max(0, (Date.now() - latest.when) / 86400000);
        return {
          ok: true,
          ageDays: days,
          ageText: daysToZh(days),
          ageTextZh: daysToZh(days),
          latestTitle: latest.title,
          latestAt: latest.when,
          links: latest.links || ''
        };
      }
    }
  }

  // RSS 不可用或该频道没有公开上传时，回退到频道 /videos 页。
  const url = base.replace(/\/+$/, '') + '/videos?hl=en';
  const res = await ctx.get(url, { label: `检查活跃：${channel.handle || channel.name}`, timeout: 45 });
  if (res.status !== 200) return { ok: false, reason: `HTTP ${res.status}` };
  const data = extractJsonAfter(res.body, 'var ytInitialData = ');
  if (!data) return { ok: false, reason: '页面结构变化' };
  const v = freshestVideo(data);
  if (!v) return { ok: false, reason: '没有找到长视频' };
  const days = ageToDays(v.ageText);
  return {
    ok: true,
    ageDays: days,
    ageText: v.ageText,
    ageTextZh: ageTextToZh(v.ageText),
    latestTitle: v.title,
    latestAt: Date.now() - days * 86400000
  };
}

// 频道「关于」页里带着创作者自己填的外链（X / TikTok / Rumble / 个人站）。
// 页面约 1.5MB，所以只在已经收下这个频道、并且本次还要找其它平台时才来取一次。
async function about(channel, ctx) {
  const base = channel.channelPath
    ? 'https://www.youtube.com' + channel.channelPath
    : (channel.handle
      ? 'https://www.youtube.com/@' + encodeURIComponent(channel.handle)
      : (channel.id ? 'https://www.youtube.com/channel/' + encodeURIComponent(channel.id) : ''));
  if (!base) return '';
  const res = await ctx.get(base.replace(/\/+$/, '') + '/about?hl=en', {
    label: `YouTube 资料：${channel.handle || channel.name || ''}`.trim(),
    timeout: 30
  });
  return res.status === 200 ? res.body : '';
}

module.exports = { search, searchMore, checkActivity, latestFromRss, about };
