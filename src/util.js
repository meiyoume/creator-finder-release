'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

class StoppedError extends Error {
  constructor() {
    super('已停止');
    this.name = 'StoppedError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseCount(text) {
  if (text == null) return null;
  const s = String(text).replace(/,/g, '');
  // 日/中/韩 的万、億、만、억
  let m = s.match(/([\d.]+)\s*(万|萬|億|만|억)/);
  if (m) {
    let n = parseFloat(m[1]);
    const u = m[2];
    if (u === '万' || u === '萬' || u === '만') n *= 1e4;
    else n *= 1e8;
    return Math.round(n);
  }
  m = s.match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const u = (m[2] || '').toUpperCase();
  if (u === 'K') n *= 1e3;
  else if (u === 'M') n *= 1e6;
  else if (u === 'B') n *= 1e9;
  return Math.round(n);
}

function compactCount(n) {
  if (n == null || n === '') return '';
  n = Number(n);
  if (!Number.isFinite(n)) return '';
  const fmt = (v, unit) => {
    const rounded = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
    return String(rounded).replace(/\.0$/, '') + unit;
  };
  if (n >= 999.5e6) return fmt(n / 1e9, 'B');
  if (n >= 999.5e3) return fmt(n / 1e6, 'M');
  if (n >= 1000) return fmt(n / 1e3, 'K');
  return String(Math.round(n));
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { const cp = parseInt(n, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&#(\d+);/g, (_, n) => { const cp = parseInt(n, 10); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; })
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonAfter(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let p = start; p < html.length; p++) {
    const c = html[p];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = p + 1; break; }
      }
    }
  }
  if (end < 0) return null;
  try { return JSON.parse(html.slice(start, end)); } catch { return null; }
}

function ageToDays(text) {
  const s = String(text || '');
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year|mo|s|m|h|d|w|y|秒|分|時間|日|週間|か月|ヶ月|年|分钟|小时|天|周|个月|초|분|시간|일|주|개월|년)/i);
  if (!m) return Infinity;
  const n = +m[1];
  const raw = m[2].toLowerCase();
  const u = raw
    .replace('second', 's').replace('minute', 'm').replace('hour', 'h')
    .replace('day', 'd').replace('week', 'w').replace('month', 'mo').replace('year', 'y');
  const factor = {
    s: 1 / 86400, '秒': 1 / 86400, '초': 1 / 86400,
    m: 1 / 1440, '分': 1 / 1440, '分钟': 1 / 1440, '분': 1 / 1440,
    h: 1 / 24, '時間': 1 / 24, '小时': 1 / 24, '시간': 1 / 24,
    d: 1, '日': 1, '天': 1, '일': 1,
    w: 7, '週間': 7, '周': 7, '주': 7,
    mo: 30.44, 'か月': 30.44, 'ヶ月': 30.44, '个月': 30.44, '개월': 30.44,
    y: 365.25, '年': 365.25, '년': 365.25
  }[u];
  return factor == null ? Infinity : n * factor;
}

function ageTextToZh(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year|mo|s|m|h|d|w|y|秒|分|時間|日|週間|か月|ヶ月|年|分钟|小时|天|周|个月|초|분|시간|일|주|개월|년)/i);
  if (!m) return s;
  const n = +m[1];
  const raw = m[2].toLowerCase();
  let zh = raw;
  if (raw === 'second' || raw === 's' || raw === '秒' || raw === '초') zh = '秒';
  else if (raw === 'minute' || raw === 'm' || raw === '分' || raw === '分钟' || raw === '분') zh = '分钟';
  else if (raw === 'hour' || raw === 'h' || raw === '時間' || raw === '小时' || raw === '시간') zh = '小时';
  else if (raw === 'day' || raw === 'd' || raw === '日' || raw === '天' || raw === '일') zh = '天';
  else if (raw === 'week' || raw === 'w' || raw === '週間' || raw === '周' || raw === '주') zh = '周';
  else if (raw === 'month' || raw === 'mo' || raw === 'か月' || raw === 'ヶ月' || raw === '个月' || raw === '개월') zh = '个月';
  else if (raw === 'year' || raw === 'y' || raw === '年' || raw === '년') zh = '年';
  return `${n} ${zh}前`;
}

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

function todayStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

function atomicWriteJson(file, data, pretty = true) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
  fs.renameSync(tmp, file);
}

async function curlRequest(url, opts = {}) {
  const args = ['-s', '-L', '--proto', '=https,http', '--proto-redir', '=https,http', '--max-time', String(opts.timeout || 40), '-A', opts.userAgent || UA];
  if (opts.proxy) args.push('-x', opts.proxy);
  const headers = { 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) };
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (opts.method === 'POST') {
    args.push('-X', 'POST');
    if (opts.body != null) args.push('--data-binary', opts.body);
  }
  args.push('-w', '__HTTP__%{http_code}', url);

  return new Promise((resolve, reject) => {
    const child = execFile('curl.exe', args, {
      maxBuffer: 40 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true
    }, (err, stdout) => {
      if (opts.onChild) opts.onChild(null);
      if (err && !stdout) return reject(err);
      const idx = String(stdout).lastIndexOf('__HTTP__');
      if (idx < 0) return resolve({ status: 0, body: String(stdout) });
      resolve({
        status: parseInt(String(stdout).slice(idx + 8).trim(), 10) || 0,
        body: String(stdout).slice(0, idx)
      });
    });
    if (opts.onChild) opts.onChild(child);
  });
}

class Pacer {
  constructor(options, emit, isStopped) {
    this.delayMs = Math.max(3000, Number(options.delaySec || 5) * 1000);
    this.jitterMs = Math.max(0, Number(options.jitterSec == null ? 1.5 : options.jitterSec) * 1000);
    this.pauseEvery = Math.max(0, Number(options.pauseEvery || 0));
    this.pauseMs = Math.max(0, Number(options.pauseSec || 0) * 1000);
    this.emit = emit;
    this.isStopped = isStopped;
    this.count = 0;
    this.nextAt = 0;
  }

  async sleepChecked(ms, label) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.isStopped()) throw new StoppedError();
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  async wait(label) {
    if (this.isStopped()) throw new StoppedError();
    if (this.count > 0 && this.nextAt > Date.now()) {
      const waitMs = this.nextAt - Date.now();
      this.emit({ type: 'pace', waitSec: Math.ceil(waitMs / 100) / 10, label: label || '' });
      await this.sleepChecked(waitMs, label);
    }
    if (this.pauseEvery > 0 && this.count > 0 && this.count % this.pauseEvery === 0) {
      const sec = Math.round(this.pauseMs / 1000);
      this.emit({ type: 'log', level: 'pace', text: `安全休息 ${sec} 秒（本段已请求 ${this.count} 次）` });
      this.emit({ type: 'pace', waitSec: sec, label: 'long-pause' });
      await this.sleepChecked(this.pauseMs, 'long-pause');
    }
    if (this.isStopped()) throw new StoppedError();
    this.count++;
  }

  // 一次请求真正结束（成功或失败）后才排下一次的间隔：
  // 间隔从"上一次请求结束"起算，而不是从它开始起算，
  // 否则慢请求（超时最长 40 秒）一结束，下一条会立刻发出。
  complete() {
    this.nextAt = Date.now() + this.delayMs + Math.random() * this.jitterMs;
  }
}

module.exports = {
  UA,
  StoppedError,
  sleep,
  parseCount,
  compactCount,
  stripTags,
  extractJsonAfter,
  ageToDays,
  ageTextToZh,
  daysToZh,
  todayStamp,
  nowStamp,
  atomicWriteJson,
  curlRequest,
  Pacer
};
