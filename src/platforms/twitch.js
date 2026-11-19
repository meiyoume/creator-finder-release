'use strict';

const { compactCount } = require('../util');

const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_URL = 'https://gql.twitch.tv/gql';

function relevance(text, query) {
  const t = String(text || '').toLowerCase();
  const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length >= 4);
  if (!tokens.length) return true;
  return tokens.some(tok => t.includes(tok));
}

async function search(query, ctx) {
  const gql = `query { searchFor(userQuery: ${JSON.stringify(query)}, platform: "web", target: null) { channels { edges { item { ... on User { id login displayName description followers { totalCount } lastBroadcast { startedAt } } } } } } }`;
  const body = JSON.stringify({ query: gql });
  const res = await ctx.post(GQL_URL, body, {
    'Client-ID': CLIENT_ID,
    'Content-Type': 'application/json'
  }, { label: `Twitch 搜索：${query}`, timeout: 35 });

  if (res.status !== 200) return { error: `HTTP ${res.status}`, channels: [] };
  let data;
  try { data = JSON.parse(res.body); } catch { return { error: '返回不是 JSON', channels: [] }; }
  if (data.errors) return { error: data.errors.map(e => e.message).join('; '), channels: [] };

  const rawEdges = data?.data?.searchFor?.channels?.edges;
  const edges = Array.isArray(rawEdges) ? rawEdges : [];
  const channels = [];
  for (const e of edges) {
    const u = e?.item;
    if (!u || !u.login) continue;
    const followers = u.followers?.totalCount ?? null;
    const text = `${u.displayName || ''} ${u.description || ''}`;
    if (!relevance(text, query)) continue;
    channels.push({
      platform: 'twitch',
      id: String(u.login).toLowerCase(),
      name: u.displayName || u.login,
      handle: u.login,
      url: `https://www.twitch.tv/${u.login}`,
      followers,
      followersText: followers == null ? '' : compactCount(followers),
      description: (u.description || '').replace(/\s+/g, ' ').trim(),
      lastBroadcast: u.lastBroadcast?.startedAt || null
    });
  }
  return { error: null, channels };
}

module.exports = { search };
