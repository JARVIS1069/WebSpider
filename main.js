'use strict';
// WebSpider main process: window, webview hardening, robots.txt, output saving.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { buildOutputs } = require('./summarizer');

const AUTOTEST = process.env.WEBSPIDER_AUTOTEST === '1';
let win = null;
let llmHook = null;
if (process.env.WEBSPIDER_LLM === '1') {
  try { llmHook = require('./llm-hook.js'); } catch (e) { console.warn('LLM hook not loaded:', e.message); }
}

function defaultOut() {
  return process.env.WEBSPIDER_OUT || path.join(app.getPath('documents'), 'WebSpider');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, backgroundColor: '#05070b', title: 'WebSpider',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false
    }
  });
  // The guest page gets our scraper preload; we enforce isolation ourselves.
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.preload = path.join(__dirname, 'webview-preload.js');
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = false; // preload needs require() for ./scraper.js
  });
  win.loadFile(path.join('renderer', 'index.html'));
  if (AUTOTEST) {
    win.webContents.once('did-finish-load', () => win.webContents.send('autotest'));
    setTimeout(() => { console.log('AUTOTEST TIMEOUT'); app.exit(2); }, 150000);
  }
}

function buildMenu() {
  const send = (ch) => () => win && win.webContents.send(ch);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Spider', submenu: [
      { label: 'Start / Stop', accelerator: 'CommandOrControl+Shift+S', click: send('hotkey') },
      { type: 'separator' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'togglefullscreen' }] }
  ]));
}

// ---- robots.txt -----------------------------------------------------------
function robotsAllows(txt, ua, pathname) {
  const groups = []; let cur = null; let lastWasUA = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasUA) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasUA = true;
    } else if ((k === 'allow' || k === 'disallow') && cur) {
      lastWasUA = false; if (v) cur.rules.push({ allow: k === 'allow', pat: v });
    } else lastWasUA = false;
  }
  const mine = groups.filter(g => g.agents.some(a => ua.includes(a) && a !== '*'));
  const use = mine.length ? mine : groups.filter(g => g.agents.includes('*'));
  let best = null;
  for (const g of use) for (const r of g.rules) {
    const re = new RegExp('^' + r.pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.pat.length > best.pat.length || (r.pat.length === best.pat.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

ipcMain.handle('robots:check', async (_e, url) => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return { allowed: true, note: 'non-http' };
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(u.origin + '/robots.txt', { signal: ctrl.signal, headers: { 'User-Agent': 'WebSpider/1.0' } });
    clearTimeout(t);
    if (!res.ok) return { allowed: true, note: 'no robots.txt' };
    const allowed = robotsAllows(await res.text(), 'webspider', u.pathname + u.search);
    return { allowed };
  } catch (e) { return { allowed: true, note: 'robots unreachable' }; }
});

ipcMain.handle('app:info', () => ({
  defaultOut: defaultOut(),
  demoUrl: pathToFileURL(path.join(__dirname, 'demo.html')).href,
  autotest: AUTOTEST
}));

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('capture', async (_e, id) => {
  const wc = webContents.fromId(id);
  if (!wc) return null;
  const img = await wc.capturePage();
  return img.toDataURL();
});

const pad = (n) => String(n).padStart(2, '0');
ipcMain.handle('save', async (_e, payload) => {
  const out = await buildOutputs(payload, llmHook);
  let host = 'local';
  try { const u = new URL(payload.url); if (u.hostname) host = u.hostname.replace(/^www\./, ''); } catch (_) {}
  const d = new Date();
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const base = payload.outDir || defaultOut();
  let dir = path.join(base, `${host.replace(/[^a-z0-9.-]/gi, '_')}_${stamp}`);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${host}_${stamp}_${i}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.md'), out.summaryMd);
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(out.data, null, 2));
  fs.writeFileSync(path.join(dir, 'content.txt'), out.contentTxt);
  if (payload.screenshot) {
    fs.writeFileSync(path.join(dir, 'screenshot.png'), Buffer.from(payload.screenshot.split(',')[1], 'base64'));
  }
  return { dir, stats: out.data.stats };
});

ipcMain.handle('open-folder', (_e, dir) => shell.openPath(dir));
ipcMain.on('autotest-done', (_e, info) => {
  console.log('AUTOTEST RESULT ' + JSON.stringify(info));
  app.exit(info && info.dir ? 0 : 1);
});
ipcMain.on('log', (_e, m) => console.log('[renderer]', m));

app.whenReady().then(() => { buildMenu(); createWindow(); });
app.on('window-all-closed', () => app.quit());
