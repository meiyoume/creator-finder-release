'use strict';

function escMd(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function escCsv(s) {
  let v = String(s == null ? '' : s).replace(/\r?\n/g, ' ').trim();
  if (/^[=+\-@\t]/.test(v)) v = "'" + v;
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function toMarkdown(results, meta = {}) {
  const lines = [];
  lines.push(`# 国外小博主清单${meta.date ? `（${meta.date}）` : ''}`);
  lines.push('');
  if (meta.note) lines.push(meta.note, '');
  lines.push('| # | 平台 | 名称 | 粉丝 | 领域 | 内容方向 | 最近活跃 | 链接 |');
  lines.push('|---|---|---|---|---|---|---|---|');
  results.forEach((r, i) => {
    const desc = (r.description || r.latestTitle || '').slice(0, 160);
    const link = r.url ? `[打开](<${r.url}>)` : '—';
    lines.push(`| ${i + 1} | ${escMd(r.platformLabel)} | ${escMd(r.name)} | ${escMd(r.followersText)} | ${escMd(r.domainName)} | ${escMd(desc)} | ${escMd(r.latest)} | ${link} |`);
  });
  lines.push('');
  return lines.join('\n');
}

function toCsv(results) {
  const header = ['平台', '名称', '账号', '粉丝', '领域', '内容方向', '最近活跃', '链接', '发现时间'];
  const rows = results.map(r => [
    r.platformLabel,
    r.name,
    r.handle,
    r.followersText,
    r.domainName,
    r.description || r.latestTitle || '',
    r.latest,
    r.url,
    r.foundAt
  ]);
  return '\uFEFF' + [header, ...rows].map(row => row.map(escCsv).join(',')).join('\r\n');
}

module.exports = { toMarkdown, toCsv };
