'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, shell, Menu, dialog, nativeTheme, ipcMain } = require('electron');
const { startServer } = require('./server');

// 原生标题栏默认跟随深色界面；界面切到浅色主题时由渲染进程通知切换。
nativeTheme.themeSource = 'dark';
const LIGHT_THEMES = new Set(['paper', 'snow', 'mint', 'rose']);

// 自动化测试/截图时不要抢用户焦点：CF_TEST_HIDE=1 或 --cf-test-hide，窗口保持隐藏，只走 CDP。
const TEST_HIDE = String(process.env.CF_TEST_HIDE || '').trim() === '1' || process.argv.includes('--cf-test-hide');

// 便携版把界面设置也放在软件目录里，避免和安装版共用 %APPDATA%。
if (fs.existsSync(path.join(__dirname, 'portable.flag'))) {
  app.setPath('userData', path.join(__dirname, 'userData'));
}

let win = null;
let server = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!TEST_HIDE) win.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    server = await startServer({ port: 17897, host: '127.0.0.1' });
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}`;

    win = new BrowserWindow({
      width: 1360,
      height: 920,
      minWidth: 1080,
      minHeight: 720,
      title: '国外小博主寻找器',
      backgroundColor: '#080b11',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // 隐藏测试窗口时仍要正常跑定时器（SSE 日志、进度），否则会被后台节流。
        backgroundThrottling: !TEST_HIDE
      }
    });

    ipcMain.on('ui-theme', (event, theme) => {
      if (!win || event.sender !== win.webContents) return;
      nativeTheme.themeSource = LIGHT_THEMES.has(String(theme)) ? 'light' : 'dark';
    });

    // ---- 应用内升级 ----
    const updater = require('./src/updater');
    const sendUpdate = payload => {
      try { if (win && !win.isDestroyed()) win.webContents.send('update:progress', payload); } catch { /* ignore */ }
    };
    ipcMain.handle('app:version', () => {
      try { return require('./package.json').version; } catch { return app.getVersion(); }
    });
    ipcMain.handle('update:check', () => updater.check());
    ipcMain.handle('update:download', async (event, asset) => {
      if (!win || event.sender !== win.webContents) return { ok: false, error: '无效请求' };
      try {
        const out = await updater.download(asset, sendUpdate);
        return { ok: true, ...out };
      } catch (e) {
        return { ok: false, error: (e && e.message) || '下载失败' };
      }
    });
    ipcMain.handle('update:install', async (event, file) => {
      if (!win || event.sender !== win.webContents) return { ok: false, error: '无效请求' };
      try {
        return { ok: true, ...(await updater.install(file)) };
      } catch (e) {
        return { ok: false, error: (e && e.message) || '安装失败' };
      }
    });
    ipcMain.on('update:cancel', () => updater.cancel());

    win.once('ready-to-show', () => { if (!TEST_HIDE) win.show(); });
    win.webContents.on('did-fail-load', (event, code, description) => {
      if (code === -3) return;
      try { dialog.showErrorBox('页面加载失败', `${description || '未知错误'}（${code}）`); } catch { /* ignore */ }
      if (!TEST_HIDE && !win.isVisible()) win.show();
    });
    win.loadURL(url).catch(err => {
      console.error(err);
      try { dialog.showErrorBox('页面加载失败', err.message); } catch { /* ignore */ }
      if (!TEST_HIDE) win.show();
    });

    win.webContents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) shell.openExternal(target);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, target) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(target).origin === new URL(url).origin;
      } catch { /* ignore */ }
      if (!sameOrigin) event.preventDefault();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) win = null;
    });
  }).catch(err => {
    console.error(err);
    const message = err && err.code === 'EADDRINUSE'
      ? '端口 17897 已被占用。请关闭其他正在运行的实例后重试。'
      : `本地服务启动失败：${err && err.message ? err.message : String(err)}`;
    try { dialog.showErrorBox('国外小博主寻找器 无法启动', message); } catch { /* ignore */ }
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (server) {
    try { server.engine.stop(); } catch { /* ignore */ }
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
});
