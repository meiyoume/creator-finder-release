'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson, todayStamp } = require('./util');

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return todayStamp();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeResult(r) {
  if (!r || !r.platform || !r.id || !r.name) return null;
  const followers = r.followers == null ? null : Number(r.followers);
  const activityDays = r.activityDays == null ? null : Number(r.activityDays);
  return {
    platform: String(r.platform),
    id: String(r.id),
    name: String(r.name).slice(0, 200),
    handle: String(r.handle || '').slice(0, 120),
    url: String(r.url || ''),
    followers: Number.isFinite(followers) ? followers : null,
    followersText: String(r.followersText || '').slice(0, 30),
    domainName: String(r.domainName || '').slice(0, 80),
    latest: String(r.latest || '').slice(0, 80),
    activityDays: Number.isFinite(activityDays) ? activityDays : null,
    description: String(r.description || '').slice(0, 500)
  };
}

function keyOf(r) {
  return `${r.platform}:${r.id}`;
}

function repeatKey(r) {
  return `${r.platform}\n${String(r.name || '').trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

const PLATFORM_ORDER = ['youtube', 'x', 'twitch', 'kick', 'rumble', 'tiktok'];
function platformRank(platform) {
  const index = PLATFORM_ORDER.indexOf(String(platform));
  return index < 0 ? PLATFORM_ORDER.length : index;
}

class HistoryStore {
  constructor({ file, resultsDir }) {
    this.file = file;
    this.resultsDir = resultsDir;
    this.creators = {};
    this.dirty = false;
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && data.creators && typeof data.creators === 'object' && !Array.isArray(data.creators)) {
        this.creators = data.creators;
        return;
      }
    } catch { /* 没有历史文件：从现有 results 导入一次 */ }
    this.creators = {};
    const imported = this.importResults();
    if (imported) this.save();
  }

  // 第一次启用历史功能时，把 results/ 里以前的运行结果补进来；
  // 已经存在 history.json 时不再重复导入，避免把清空后的历史又灌回来。
  importResults() {
    let files = [];
    try {
      files = fs.readdirSync(this.resultsDir)
        .filter(name => /^results-.*\.json$/i.test(name))
        .sort();
    } catch {
      return false;
    }
    let imported = false;
    for (const name of files) {
      let payload;
      try {
        payload = JSON.parse(fs.readFileSync(path.join(this.resultsDir, name), 'utf8'));
      } catch {
        continue;
      }
      if (!payload || !Array.isArray(payload.results)) continue;
      if (payload.results.length) imported = true;
      for (const result of payload.results) {
        const at = result.foundAt || payload.createdAt || new Date().toISOString();
        this.upsert(result, at);
      }
    }
    return imported;
  }

  upsert(result, seenAt) {
    const clean = normalizeResult(result);
    if (!clean) return false;
    const when = Number.isNaN(Date.parse(seenAt || ''))
      ? new Date().toISOString()
      : new Date(seenAt).toISOString();
    const whenMs = Date.parse(when);
    const key = keyOf(clean);

    let item = this.creators[key];
    if (item) {
      item.seenCount = (Number(item.seenCount) || 1) + 1;
      if (!item.firstSeenAt || whenMs < Date.parse(item.firstSeenAt)) {
        item.firstSeenAt = when;
        item.firstSeen = localDay(when);
      }
      if (!item.lastSeenAt || whenMs >= Date.parse(item.lastSeenAt)) {
        item.lastSeenAt = when;
        item.lastSeen = localDay(when);
        item.name = clean.name;
        item.handle = clean.handle;
        item.url = clean.url;
        item.followers = clean.followers;
        item.followersText = clean.followersText;
        item.domainName = clean.domainName;
        item.latest = clean.latest;
        item.activityDays = clean.activityDays;
        item.description = clean.description;
      }
      this.dirty = true;
      return false;
    }

    this.creators[key] = {
      ...clean,
      firstSeen: localDay(when),
      firstSeenAt: when,
      lastSeen: localDay(when),
      lastSeenAt: when,
      seenCount: 1
    };
    this.dirty = true;
    return true;
  }

  add(result) {
    const added = this.upsert(result, new Date().toISOString());
    this.scheduleSave();
    return added;
  }

  // seen.json 里可能有更早的记录（results 文件已删/被覆盖），
  // 用最小字段补进历史，保证“找到过的账号”不会在历史里凭空消失。
  importSeen(seen) {
    let changed = false;
    for (const [platform, items] of Object.entries(seen || {})) {
      for (const [id, meta] of Object.entries(items || {})) {
        const key = `${platform}:${id}`;
        if (this.creators[key]) continue;
        const day = (meta && meta.firstSeen) || todayStamp();
        const d = new Date(day + 'T12:00:00');
        const when = Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
        this.creators[key] = {
          platform,
          id,
          name: (meta && meta.name) || id,
          handle: '',
          url: '',
          followers: null,
          followersText: '',
          domainName: '',
          latest: '',
          activityDays: null,
          description: '',
          firstSeen: localDay(when),
          firstSeenAt: when,
          lastSeen: localDay(when),
          lastSeenAt: when,
          seenCount: 1
        };
        changed = true;
      }
    }
    if (changed) {
      this.dirty = true;
      this.save();
    }
    return changed;
  }

  total() {
    return Object.keys(this.creators).length;
  }

  snapshot() {
    const days = new Map();
    for (const item of Object.values(this.creators)) {
      const date = item.firstSeen || (item.firstSeenAt ? localDay(item.firstSeenAt) : '');
      if (!date) continue;
      if (!days.has(date)) days.set(date, []);
      days.get(date).push({ ...item });
    }
    const out = [...days.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([date, creators]) => {
        const nameCounts = new Map();
        for (const item of creators) {
          const key = repeatKey(item);
          nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
        }
        for (const item of creators) {
          item.repeatCount = Math.max(
            Number(item.seenCount) || 1,
            nameCounts.get(repeatKey(item)) || 1
          );
        }
        creators.sort((a, b) => {
          const repeatA = a.repeatCount > 1 ? 1 : 0;
          const repeatB = b.repeatCount > 1 ? 1 : 0;
          if (repeatA !== repeatB) return repeatA - repeatB;
          const platformA = platformRank(a.platform);
          const platformB = platformRank(b.platform);
          if (platformA !== platformB) return platformA - platformB;
          if (a.repeatCount !== b.repeatCount) return a.repeatCount - b.repeatCount;
          return String(b.firstSeenAt).localeCompare(String(a.firstSeenAt));
        });
        return { date, count: creators.length, creators };
      });
    return { total: this.total(), days: out };
  }

  clear() {
    const previous = this.creators;
    this.creators = {};
    this.dirty = true;
    if (this.save()) return true;
    this.creators = previous;
    return false;
  }

  save() {
    if (!this.dirty) return true;
    try {
      atomicWriteJson(this.file, { version: 1, creators: this.creators }, false);
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, 1500);
    if (this.timer.unref) this.timer.unref();
  }
}

module.exports = { HistoryStore, localDay };
