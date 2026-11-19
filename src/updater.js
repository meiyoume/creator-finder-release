'use strict';
// 应用内升级。
//
// 版本源：GitHub Release（repo 见下）。国内直连 github.com 不稳定，所以：
//   1. 检查更新先走 api.github.com（国内一般可达），失败再走 jsDelivr 上的 latest.json
//   2. 下载资产时对「直连 + 3 个加速镜像」各拉 256KB 测速，挑最快的那个下
//   3. 下完校验 sha256（GitHub API 的 digest 字段，或 latest.json 里的 sha256）
//
// 安装版：下载 Setup.exe，静默安装并退出（安装器自己弹 UAC）。
// 便携版：下载新 zip 放到桌面并打开所在文件夹，由用户解压覆盖（不动用户数据）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { app, net, shell, dialog } = require('electron');

const REPO = 'meiyoume/creator-finder-release';
const MIRRORS = [
  { name: '直连', prefix: '' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' }
];

let current = null; // { controller, file, asset, expected }
let lastProgressAt = 0;

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url, timeout = 12000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await net.fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'creator-finder-updater', Accept: 'application/vnd.github+json, application/json' }
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, status: 0, error: (e && e.message) || '网络错误' };
  } finally {
    clearTimeout(timer);
  }
}

function pickAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exe = list.find(a => /\.exe$/i.test(a.name));
  const zip = list.find(a => /\.zip$/i.test(a.name));
  // 便携版和标准版都是 zip，靠文件名区分：带 portable 的是便携包（默认直连），
  // 带 standard 的是给已安装版本用的（保留默认代理）。
  const standard = list.find(a => /standard/i.test(a.name)) || null;
  const portable = list.find(a => /portable/i.test(a.name)) || (zip && zip !== standard ? zip : null);
  const sha = a => {
    const d = String(a.digest || '');
    return d.startsWith('sha256:') ? d.slice(7).toLowerCase() : '';
  };
  const pick = a => (a ? { name: a.name, size: a.size, url: a.browser_download_url, sha256: sha(a) } : null);
  return {
    installer: pick(exe),
    portable: pick(portable),
    standard: pick(standard)
  };
}

async function check() {
  // app.getVersion() 读的是 package.json；在 Electron 主进程外（量具脚本）会拿到 Electron 的版本号，
  // 所以以 package.json 为准。
  let currentVersion = app.getVersion();
  try { currentVersion = require('../package.json').version || currentVersion; } catch { /* ignore */ }
  // 1) GitHub API
  const api = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  if (api.ok && api.json && api.json.tag_name) {
    const latest = String(api.json.tag_name).replace(/^v/i, '');
    const assets = pickAssets(api.json.assets);
    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate: cmpVersion(latest, currentVersion) > 0,
      notes: String(api.json.body || '').slice(0, 4000),
      publishedAt: api.json.published_at || '',
      assets,
      portable: fs.existsSync(path.join(__dirname, '..', 'portable.flag')),
      source: 'api.github.com',
      error: null
    };
  }
  // 2) jsDelivr 上的 latest.json（国内快照，发版时一起提交）
  const viaCdn = await fetchJson(`https://cdn.jsdelivr.net/gh/${REPO}@main/latest.json`, 12000);
  if (viaCdn.ok && viaCdn.json && viaCdn.json.version) {
    const j = viaCdn.json;
    const latest = String(j.version).replace(/^v/i, '');
    return {
      ok: true,
      current: currentVersion,
      latest,
      hasUpdate: cmpVersion(latest, currentVersion) > 0,
      notes: String(j.notes || '').slice(0, 4000),
      publishedAt: j.publishedAt || '',
      assets: j.assets || {},
      portable: fs.existsSync(path.join(__dirname, '..', 'portable.flag')),
      source: 'jsDelivr',
      error: null
    };
  }
  return {
    ok: false,
    current: currentVersion,
    error: `检查更新失败：${api.error || '未知错误'}${viaCdn.error ? ` / ${viaCdn.error}` : ''}`
  };
}

function tempFile(name) {
  const dir = path.join(os.tmpdir(), 'creator-finder-update');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, String(name).replace(/[\\/:*?"<>|]/g, '_'));
}

// 拉 256KB 测速，选最快的通道。失败的直接跳过。
async function fastestUrl(url) {
  const probes = MIRRORS.map(async m => {
    const target = m.prefix ? m.prefix + url : url;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 9000);
    const t0 = Date.now();
    try {
      const res = await net.fetch(target, {
        signal: ac.signal,
        headers: { Range: 'bytes=0-262143', 'User-Agent': 'creator-finder-updater' }
      });
      if (!res.ok && res.status !== 206) return null;
      const buf = await res.arrayBuffer();
      const secs = Math.max(0.05, (Date.now() - t0) / 1000);
      if (!buf.byteLength) return null;
      return { name: m.name, url: target, speed: buf.byteLength / secs };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  const done = (await Promise.all(probes)).filter(Boolean).sort((a, b) => b.speed - a.speed);
  if (!done.length) return null;
  const best = done[0];
  return { ...best, tried: done.map(d => `${d.name}:${Math.round(d.speed / 1024)}KB/s`) };
}

async function download(asset, onProgress) {
  if (!asset || !asset.url) throw new Error('没有可下载的安装包');
  // 上一轮留下的同版本包先清掉，否则容易在临时目录里堆几百 MB
  try { cleanupTemp(); } catch { /* 占用中就算了 */ }
  const picked = await fastestUrl(asset.url);
  if (!picked) throw new Error('所有下载通道都不可用（直连与镜像均失败）');
  onProgress({ phase: 'source', source: picked.name, tried: picked.tried });

  const file = tempFile(asset.name || 'update.bin');
  const ac = new AbortController();
  current = { controller: ac, file, asset };
  const res = await net.fetch(picked.url, { signal: ac.signal, headers: { 'User-Agent': 'creator-finder-updater' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  const reader = res.body.getReader();
  let received = 0;
  lastProgressAt = 0;
  // 卡死保护：45 秒没有任何数据就中断，避免界面停在 0% 永远不动
  let lastDataAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > 45000) {
      try { ac.abort(); } catch {}
    }
  }, 5000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      lastDataAt = Date.now();
      received += value.byteLength;
      hash.update(value);
      if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
      const now = Date.now();
      if (now - lastProgressAt > 200) {
        lastProgressAt = now;
        onProgress({ phase: 'download', percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0, received, total, source: picked.name });
      }
    }
  } finally {
    clearInterval(watchdog);
  }
  await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));
  const sha256 = hash.digest('hex');
  if (asset.sha256 && sha256.toLowerCase() !== String(asset.sha256).toLowerCase()) {
    try { fs.rmSync(file, { force: true, maxRetries: 2 }); } catch {}
    throw new Error('sha256 校验失败，文件可能被镜像损坏，已删除');
  }
  current = null;
  onProgress({ phase: 'done', percent: 100, received, total: received, source: picked.name, sha256 });
  return { file, sha256, source: picked.name };
}

function stageZip(file) {
  // 每次用唯一目录：上一轮的 staging 可能还被资源管理器/杀软占用，
  // 直接 rm 会 ENOTEMPTY 把整次升级炸掉（实测踩过）。
  const dir = path.join(os.tmpdir(), 'creator-finder-update', `staging-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  // Win10+ 自带 bsdtar，处理 zip 最快；失败再退回 PowerShell
  let r = spawnSync('tar', ['-xf', file, '-C', dir], { windowsHide: true });
  if (r.status !== 0) {
    const safe = String(file).replace(/'/g, "''");
    r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${safe}' -DestinationPath '${dir}' -Force`], { windowsHide: true });
    if (r.status !== 0) throw new Error('解压新版本失败');
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory());
  if (dirs.length === 1 && !fs.existsSync(path.join(dir, 'package.json'))) {
    return path.join(dir, dirs[0].name);
  }
  return dir;
}

// 下载完成后由批处理接手：等本进程退出 → robocopy 覆盖（跳过用户数据）→ 重新启动。
function launchReplacer(staging, appDir) {
  const bat = path.join(os.tmpdir(), 'creator-finder-update', 'apply-update.bat');
  const pid = process.pid;
  const launcher = path.join(appDir, '双击启动软件.vbs');
  // 已经有运行时就不再覆盖 runtime：既省几百 MB 拷贝，也避免撞上正在运行的
  // electron.exe（文件被占用会导致 robocopy 报错并留下半新半旧的状态）。
  const hasRuntime = fs.existsSync(path.join(appDir, 'runtime', 'electron', 'electron.exe'));
  const skipDirs = hasRuntime ? 'data results userData logs runtime' : 'data results userData logs';
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    ':wait',
    `tasklist /FI "PID eq ${pid}" | find "${pid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    `robocopy "${staging}" "${appDir}" /E /XD ${skipDirs} /XF portable.flag /NFL /NDL /NJH /NJS >nul`,
    fs.existsSync(launcher) ? `start "" "${launcher}"` : `start "" "${path.join(appDir, 'runtime', 'electron', 'electron.exe')}" "${appDir}"`,
    'exit /b 0'
  ];
  fs.writeFileSync(bat, lines.join('\r\n'), 'utf8');
  // 直接 spawn 的子进程会随 Electron 退出被作业对象一起杀掉，
  // 所以用 Start-Process 起一个独立进程；并且要等它真的起来再返回，
  // 否则 app.quit() 太快会把还没启动的 powershell 一起带走。
  const safeBat = bat.replace(/'/g, "''");
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command',
    `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','${safeBat}' -WindowStyle Hidden`],
  { windowsHide: true, timeout: 15000 });
}

async function install(file, appDirOverride) {
  const appDir = appDirOverride || path.join(__dirname, '..');
  const isPortable = fs.existsSync(path.join(appDir, 'portable.flag'));
  if (/\.zip$/i.test(file)) {
    const staging = stageZip(file);
    // 标准包不带 portable.flag；如果覆盖的是便携版，覆盖后 portable.flag 会被 /XF 保住，
    // 所以不会把便携版变成安装版。反过来（安装版覆盖标准包）也是对的。
    launchReplacer(staging, appDir);
    setTimeout(() => app.quit(), 800);
    return { ok: true, mode: 'replace-zip', file: appDir };
  }
  if (!/\.exe$/i.test(file)) throw new Error('不是可安装的文件');
  if (isPortable) {
    shell.showItemInFolder(file);
    return { ok: true, mode: 'portable-exe', file };
  }
  const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' });
  child.unref();
  setTimeout(() => app.quit(), 1200);
  return { ok: true, mode: 'installer', file };
}

// 清掉临时目录里除了 bat 以外的旧包/旧解包目录（体积很大，留着浪费）
function cleanupTemp(keepBat = '') {
  const dir = path.join(os.tmpdir(), 'creator-finder-update');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (keepBat && name === path.basename(keepBat)) continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 3 }); } catch { /* 占用中就算了 */ }
  }
}

function cancel() {
  if (current && current.controller) {
    try { current.controller.abort(); } catch {}
    try { fs.rmSync(current.file, { force: true, maxRetries: 2 }); } catch {}
    current = null;
    return true;
  }
  return false;
}

module.exports = { check, download, install, cancel, cleanupTemp, cmpVersion, MIRRORS, REPO };
