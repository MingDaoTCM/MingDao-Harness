#!/usr/bin/env node
// 真实 WebUI 截图（Electron）。存在理由：v0.6.19 前端改了约 2,561 行后真机"界面凌乱/
// 按钮失灵"，而 smoke 只有字符串/选择器断言、test/ui-p2.js 只有桩 DOM——都没有渲染页面。
// 本工具起真实 `src/cli.js web`、用真实 Electron 渲染、截 PNG，给 UI 改动留下"看得见"的证据。
//
// 用法：
//   node scripts/ui-shot.mjs
//   node scripts/ui-shot.mjs --viewport narrow --theme light
//   node scripts/ui-shot.mjs --width 1280 --height 800 --out /tmp/mdh-shots
//   node scripts/ui-shot.mjs --mobile --theme dark
//
// 退出码：0 成功 · 1 服务/通用失败 · 2 参数错误 · 3 Electron 不可用
//         4 页面报错（did-fail-load / console error / 渲染进程崩溃） · 5 截图失败
//
// 约束：临时 MINGDAO_HOME 建在 os.tmpdir() 下，退出时删除；不碰真实的 ~/.mingdao。
// 说明：为了能截到会话界面，默认往临时 home 里放一条**演示会话**（--no-seed-session 可关）；
//       它只用于渲染截图，不是真实对话，也不会写回项目或用户目录。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { OK: 0, FAIL: 1, USAGE: 2, ELECTRON: 3, PAGE: 4, SHOT: 5 };
const VIEWPORTS = { wide: 1440, mid: 1000, narrow: 880 };
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ELECTRON_MAIN = String.raw`'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(process.env.MDH_SHOT_CONFIG, 'utf8'));
const shots = [];
const pageErrors = [];
const warnings = [];
let finished = false;
let winRef = null;

function finish(ok, error) {
  if (finished) return;
  finished = true;
  const payload = {
    ok: !!ok,
    error: error ? String((error && error.stack) || error) : null,
    shots,
    pageErrors,
    warnings,
  };
  try { fs.writeFileSync(cfg.resultPath, JSON.stringify(payload, null, 2)); } catch {}
  try { if (winRef) winRef.destroy(); } catch {}
  setTimeout(() => app.exit(ok ? 0 : 1), 80);
}

process.on('uncaughtException', (e) => finish(false, 'uncaughtException: ' + e));
process.on('unhandledRejection', (e) => finish(false, 'unhandledRejection: ' + e));

// 固定 DPR：让产物尺寸可断言（--scale 2 时宽高各 ×2）。
app.commandLine.appendSwitch('force-device-scale-factor', String(cfg.scale || 1));
app.commandLine.appendSwitch('disable-features', 'TranslateUI');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitLoad(wc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('页面加载超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      wc.removeListener('did-finish-load', onFinish);
      wc.removeListener('did-fail-load', onFail);
    }
    function onFinish() {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }
    function onFail(_e, code, desc, url, isMain) {
      if (!isMain || code === -3) return; // -3 = ERR_ABORTED（reload 的正常中止）
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('页面加载失败 ' + code + ' ' + desc + ' ' + url));
    }
    wc.once('did-finish-load', onFinish);
    wc.on('did-fail-load', onFail);
  });
}

async function waitFor(js, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await winRef.webContents.executeJavaScript(js)) return true;
    } catch {}
    await sleep(120);
  }
  throw new Error('等待超时：' + label);
}

async function click(sel) {
  const ok = await winRef.webContents.executeJavaScript(
    "(()=>{const el=document.querySelector(" + JSON.stringify(sel) + "); if(!el) return false; el.click(); return true;})()"
  );
  if (!ok) throw new Error('页面里找不到可点击的 ' + sel);
}

async function capture(name) {
  await sleep(180); // 让点击后的布局/字体落一帧
  const image = await winRef.webContents.capturePage();
  if (!image || image.isEmpty()) throw new Error('capturePage 返回空图：' + name);
  let size = image.getSize();
  const expectedW = Math.round(cfg.width * cfg.scale);
  const expectedH = Math.round(cfg.height * cfg.scale);
  let png;
  if (size.width === expectedW && size.height === expectedH) {
    png = image.toPNG();
  } else {
    // 某些 macOS/Electron 组合会忽略 force-device-scale-factor（本机是 Retina 2x）；
    // 按目标像素重采样，保证报告里的尺寸是真实可断言的（同一偏差只记一条 warning）。
    if (!warnings.some((w) => w.startsWith('capturePage 尺寸'))) {
      warnings.push('capturePage 尺寸 ' + size.width + 'x' + size.height + ' ≠ 目标 ' + expectedW + 'x' + expectedH + '，已重采样');
    }
    const resized = image.resize({ width: expectedW, height: expectedH, quality: 'best' });
    png = resized.toPNG();
    size = resized.getSize();
  }
  const file = path.join(cfg.outDir, name + '.png');
  fs.writeFileSync(file, png);
  const bytes = fs.statSync(file).size;
  if (!bytes) throw new Error('写出的 PNG 为空：' + file);
  shots.push({ name, path: file, width: size.width, height: size.height, bytes });
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: cfg.width,
    height: cfg.height,
    useContentSize: true,
    backgroundColor: cfg.theme === 'light' ? '#f6f7f9' : '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
    },
  });
  winRef = win;
  try { win.setMenuBarVisibility(false); } catch {}
  const wc = win.webContents;
  try { wc.setWindowOpenHandler(() => ({ action: 'deny' })); } catch {}
  if (cfg.mobile) { try { wc.setUserAgent(cfg.userAgent || undefined); } catch {} }

  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) pageErrors.push('did-fail-load ' + code + ' ' + desc + ' ' + url);
  });
  wc.on('did-fail-provisional-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) pageErrors.push('did-fail-provisional-load ' + code + ' ' + desc + ' ' + url);
  });
  wc.on('console-message', (_e, level, message, line, sourceId) => {
    const text = String(message || '');
    if (level >= 3) pageErrors.push('console.error: ' + text + ' @ ' + sourceId + ':' + line);
    else if (level === 2) warnings.push('console.warn: ' + text);
  });
  wc.on('render-process-gone', (_e, details) => {
    pageErrors.push('render-process-gone: ' + JSON.stringify(details));
  });
  wc.on('preload-error', (_e, preloadPath, error) => {
    pageErrors.push('preload-error: ' + preloadPath + ' ' + error);
  });

  await win.loadURL(cfg.url);
  await waitFor("document.readyState === 'complete' || document.readyState === 'interactive'", 15000, 'document.readyState');
  await sleep(cfg.waitMs);

  // 主题：localStorage 是页面自己的偏好来源（mingdao-theme）；设置后 reload 一次。
  await wc.executeJavaScript(
    "(()=>{try{localStorage.setItem('mingdao-theme', " + JSON.stringify(cfg.theme) + ");}catch(e){} return true;})()"
  );
  const reloaded = waitLoad(wc, 30000);
  wc.reload();
  await reloaded;
  await sleep(cfg.waitMs);
  try {
    await wc.executeJavaScript(
      "new Promise((r)=>{ if(document.fonts && document.fonts.ready) document.fonts.ready.then(()=>r(true),()=>r(true)); else r(true); })"
    );
  } catch {}
  const actualTheme = await wc.executeJavaScript("document.documentElement.getAttribute('data-theme')");
  if (actualTheme !== cfg.theme) {
    warnings.push('主题未由页面应用（实际 ' + actualTheme + '），已在截图前注入 data-theme');
    await wc.executeJavaScript(
      "document.documentElement.setAttribute('data-theme', " + JSON.stringify(cfg.theme) + ")"
    );
  }

  // 1) 首屏
  await waitFor("!!document.querySelector('#sessions')", 10000, '#sessions');
  await capture('home');

  // 2) 设置（真实点击 #cfgBtn）
  await click('#cfgBtn');
  await sleep(450);
  const settingsOpen = await wc.executeJavaScript(
    "(()=>{const m=document.querySelector('#cfgModal'); return !!m && getComputedStyle(m).display !== 'none' && m.getBoundingClientRect().height > 0;})()"
  );
  if (!settingsOpen) throw new Error('点击 #cfgBtn 后设置面板未打开（#cfgModal 不可见）');
  await capture('settings');
  await wc.executeJavaScript(
    "(()=>{const b=document.querySelector('#cfgCancel'); if(b) b.click(); else {const m=document.querySelector('#cfgModal'); if(m) m.style.display='none';} return true;})()"
  );
  await sleep(250);

  // 3) 命令面板（⌘K；若键盘事件没送达则退回同入口的 #paletteBtn）
  try {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'k', modifiers: ['meta'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'k', modifiers: ['meta'] });
  } catch {}
  await sleep(450);
  let paletteOpen = await wc.executeJavaScript(
    "(()=>{const m=document.querySelector('#paletteMask'); return !!m && !m.hidden && m.getBoundingClientRect().height > 0;})()"
  );
  if (!paletteOpen) {
    await click('#paletteBtn');
    await sleep(500);
    paletteOpen = await wc.executeJavaScript(
      "(()=>{const m=document.querySelector('#paletteMask'); return !!m && !m.hidden && m.getBoundingClientRect().height > 0;})()"
    );
  }
  if (!paletteOpen) throw new Error('⌘K / #paletteBtn 都没能打开命令面板（#paletteMask 不可见）');
  await capture('palette');

  // 关掉命令面板，再开一个真实会话（临时 home 里默认有一条演示会话）
  await wc.executeJavaScript("(()=>{const m=document.querySelector('#paletteMask'); if(m) m.hidden=true; return true;})()");
  await sleep(200);
  let picked = null;
  try {
    await waitFor(
      "(()=>{const s=document.querySelector('#sessions'); return !!s && [...s.options].some(o=>o.value);})()",
      6000,
      '#sessions 有可打开的会话'
    );
    picked = await wc.executeJavaScript(
      "(()=>{const s=document.querySelector('#sessions'); const o=[...s.options].find(x=>x.value); if(!o) return null; s.value=o.value; s.dispatchEvent(new Event('change')); return {file:o.value,label:o.textContent};})()"
    );
  } catch (e) {
    warnings.push('没有可打开的会话，跳过 session.png：' + ((e && e.message) || e));
  }
  if (picked) {
    await sleep(1200);
    await capture('session');
  }

  if (pageErrors.length && !cfg.allowConsoleErrors) {
    finish(false, '页面报错（' + pageErrors.length + ' 条）：' + pageErrors.join(' | '));
    return;
  }
  finish(true);
}

app.whenReady().then(run).catch((e) => finish(false, e));
`;

function usage() {
  return `MingDao WebUI 真实截图（Electron）

用法:
  node scripts/ui-shot.mjs [选项]

选项:
  --width <px>             视口宽（默认 1440；会覆盖 --viewport 的宽）
  --height <px>            视口高（默认 900）
  --viewport <档>          wide|mid|narrow = 1440 / 1000 / 880（默认 wide）
  --theme <dark|light>     主题（默认 dark；写入 localStorage mingdao-theme 后 reload）
  --out <dir>              输出目录（默认 /tmp/mdh-shots）
  --mobile                 移动视口（默认 390×844、DPR 2、移动 UA；显式宽高优先）
  --scale <n>              设备像素比（默认 1；--mobile 默认 2）
  --wait <ms>               did-finish-load 后的固定等待（默认 2000）
  --electron <path>        Electron 可执行文件（也可用 MDH_ELECTRON；默认自动探测）
  --no-seed-session        不往临时 home 放演示会话（此时没有会话就不出 session.png）
  --allow-console-errors   页面 console.error 只警告、不判失败
  --keep-temp              保留临时 MINGDAO_HOME / Electron app（排障用）
  --verbose                打印服务端与 Electron 的完整输出
  -h, --help               显示本帮助

产物（成功时）:
  home.png · settings.png · palette.png · session.png（有会话时）

退出码:
  0 成功 · 1 服务/通用失败 · 2 参数错误 · 3 Electron 不可用
  4 页面报错 · 5 截图失败`;
}

function parseArgs(argv) {
  const opts = {
    width: null,
    height: null,
    viewport: 'wide',
    theme: 'dark',
    out: '/tmp/mdh-shots',
    mobile: false,
    scale: null,
    wait: 2000,
    electron: null,
    seedSession: true,
    allowConsoleErrors: false,
    keepTemp: false,
    verbose: false,
    help: false,
  };
  const takesValue = new Set([
    '--width',
    '--height',
    '--viewport',
    '--theme',
    '--out',
    '--scale',
    '--wait',
    '--electron',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let val;
    if (arg.startsWith('--') && arg.includes('=')) {
      const at = arg.indexOf('=');
      val = arg.slice(at + 1);
      arg = arg.slice(0, at);
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
      continue;
    }
    if (arg === '--mobile') { opts.mobile = true; continue; }
    if (arg === '--no-seed-session') { opts.seedSession = false; continue; }
    if (arg === '--allow-console-errors') { opts.allowConsoleErrors = true; continue; }
    if (arg === '--keep-temp') { opts.keepTemp = true; continue; }
    if (arg === '--verbose') { opts.verbose = true; continue; }
    if (!takesValue.has(arg)) throw new UsageError('未知参数：' + arg);
    if (val === undefined) {
      i += 1;
      val = argv[i];
    }
    if (val === undefined || val === '') throw new UsageError(arg + ' 需要一个值');
    if (arg === '--width' || arg === '--height' || arg === '--wait') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError(arg + ' 需要正数，收到：' + val);
      opts[arg.slice(2)] = Math.round(n);
    } else if (arg === '--scale') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) throw new UsageError('--scale 需要正数，收到：' + val);
      opts.scale = n;
    } else if (arg === '--viewport') {
      if (!VIEWPORTS[val]) throw new UsageError('--viewport 只能是 wide|mid|narrow，收到：' + val);
      opts.viewport = val;
    } else if (arg === '--theme') {
      if (val !== 'dark' && val !== 'light') throw new UsageError('--theme 只能是 dark|light，收到：' + val);
      opts.theme = val;
    } else if (arg === '--out') {
      opts.out = val;
    } else if (arg === '--electron') {
      opts.electron = val;
    }
  }
  if (opts.width === null) opts.width = opts.mobile ? 390 : VIEWPORTS[opts.viewport];
  if (opts.height === null) opts.height = opts.mobile ? 844 : 900;
  if (opts.scale === null) opts.scale = opts.mobile ? 2 : 1;
  opts.out = path.resolve(opts.out);
  return opts;
}

class UsageError extends Error {}
class ToolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function tail(text, n = 4000) {
  const s = redactToken(String(text || ''));
  return s.length > n ? '…' + s.slice(-n) : s;
}

// 临时 token 只活一次运行；错误日志里也不要把它打全（服务启动日志会打印带 token 的 URL）。
function redactToken(text) {
  return String(text || '').replace(/([?&]token=)[^&\s"']+/gi, '$1***');
}

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  // 关键：DSH/桌面壳会把 ELECTRON_RUN_AS_NODE=1 继承给子进程，导致 Electron 退化成
  // Node（require('electron') 直接失败 / --version 挂起）。截图必须显式拿掉。
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

function runSync(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: options.timeout || 180000,
    env: childEnv(),
  });
}

function validateElectron(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['--version'], {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve(null);
    }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = (out + '\n' + err).trim();
      const v = text.match(/v?(\d+\.\d+\.\d+[^\s]*)/);
      if (code === 0 && v) resolve(v[1]);
      else resolve(null);
    });
  });
}

function electronBinOf(pkgDir) {
  const pathTxt = path.join(pkgDir, 'path.txt');
  if (fs.existsSync(pathTxt)) {
    const rel = fs.readFileSync(pathTxt, 'utf8').trim();
    if (rel) return path.join(pkgDir, 'dist', rel);
  }
  for (const rel of [
    'dist/Electron.app/Contents/MacOS/Electron',
    'dist/electron',
    'dist/Electron',
    'dist/electron.exe',
  ]) {
    const p = path.join(pkgDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function cacheZipDirs() {
  if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Caches', 'electron')];
  if (process.platform === 'win32') {
    return [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')];
  }
  return [path.join(os.homedir(), '.cache', 'electron')];
}

function findCacheZips() {
  const zips = [];
  for (const dir of cacheZipDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^electron-v\d+\.\d+\.\d+-.*\.zip$/.test(f)) continue;
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        zips.push({ file: full, name: f, mtime: st.mtimeMs });
      }
    } catch {}
  }
  zips.sort((a, b) => b.mtime - a.mtime);
  return zips;
}

function extractCacheElectron(zip) {
  const destRoot = path.join(os.tmpdir(), 'mdh-electron-runtime', zip.name.replace(/\.zip$/, ''));
  const marker = path.join(destRoot, '.mdh-runtime-ok');
  let bin;
  if (process.platform === 'darwin') bin = path.join(destRoot, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  else if (process.platform === 'win32') bin = path.join(destRoot, 'electron.exe');
  else bin = path.join(destRoot, 'electron');
  if (fs.existsSync(marker) && fs.existsSync(bin)) return bin;

  fs.rmSync(destRoot, { recursive: true, force: true });
  fs.mkdirSync(destRoot, { recursive: true });
  const unzip = runSync('unzip', ['-oq', zip.file, '-d', destRoot]);
  if (unzip.status !== 0) {
    throw new Error('解包 Electron 缓存失败（unzip 退出 ' + unzip.status + '）：' + tail(unzip.stderr || unzip.stdout, 1000));
  }
  if (process.platform === 'darwin') {
    const appDir = path.join(destRoot, 'Electron.app');
    runSync('chmod', ['-R', 'u+w', appDir]);
    runSync('xattr', ['-cr', appDir]);
    // 项目缓存里的 Electron 是 ad-hoc/已撤销签名；macOS 会在 dyld 阶段挂住。
    // 本地重签成 ad-hoc 后可正常运行（产物只用于截图，不用于分发）。
    const sign = runSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { timeout: 180000 });
    if (sign.status !== 0) {
      throw new Error('Electron 缓存重签失败（codesign 退出 ' + sign.status + '）：' + tail(sign.stderr || sign.stdout, 1000));
    }
  } else {
    runSync('chmod', ['+x', bin]);
  }
  if (!fs.existsSync(bin)) throw new Error('解包后找不到 Electron 可执行文件：' + bin);
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  return bin;
}

async function resolveElectron(opts) {
  const tried = [];
  // 显式指定（--electron / MDH_ELECTRON）时不再回退：用户说用哪个就用哪个，失败要立刻说清楚。
  const explicit = opts.electron || process.env.MDH_ELECTRON;
  if (explicit) {
    const bin = path.resolve(explicit);
    if (!fs.existsSync(bin)) {
      throw new ToolError('指定的 Electron 不存在：' + bin, EXIT.ELECTRON);
    }
    const version = await validateElectron(bin);
    if (!version) {
      throw new ToolError('指定的 Electron 无法启动（--version 失败/8s 无输出）：' + bin, EXIT.ELECTRON);
    }
    return { bin, source: opts.electron ? '--electron' : 'MDH_ELECTRON', version };
  }

  const candidates = [];
  const add = (bin, source) => {
    if (!bin) return;
    const abs = path.resolve(bin);
    if (!candidates.some((c) => c.bin === abs)) candidates.push({ bin: abs, source });
  };

  // 1) 项目已有依赖：desktop/node_modules/electron（含 path.txt / dist）
  const desktopPkg = path.join(ROOT, 'desktop', 'node_modules', 'electron');
  if (fs.existsSync(desktopPkg)) add(electronBinOf(desktopPkg), 'desktop/node_modules/electron');
  // 2) 本地依赖（若将来根目录也装了 electron）
  const rootPkg = path.join(ROOT, 'node_modules', 'electron');
  if (fs.existsSync(rootPkg)) add(electronBinOf(rootPkg), 'node_modules/electron');
  // 3) npx / npm 缓存里已安装的 electron（_npx/<hash>/node_modules/electron）
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      const pkg = path.join(npxRoot, dir, 'node_modules', 'electron');
      if (!fs.existsSync(pkg)) continue;
      const bin = electronBinOf(pkg);
      add(bin, 'npx electron 缓存 (' + dir + ')');
    }
  } catch {}

  for (const c of candidates) {
    if (!c.bin || !fs.existsSync(c.bin)) {
      tried.push(`${c.source}: 文件不存在（${c.bin || '未解析到'}）`);
      continue;
    }
    const version = await validateElectron(c.bin);
    if (version) return { bin: c.bin, source: c.source, version };
    tried.push(`${c.source}: 启动失败/挂起（${c.bin}）`);
  }

  // 4) 项目 Electron 缓存 zip 兜底（desktop/node_modules/electron 安装不完整时常见）。
  const zips = findCacheZips();
  for (const zip of zips) {
    try {
      const bin = extractCacheElectron(zip);
      const version = await validateElectron(bin);
      if (version) return { bin, source: 'Electron 缓存 zip（' + zip.name + '，已本地重签）', version };
      tried.push(`缓存 zip ${zip.name}: 解包后启动失败`);
    } catch (e) {
      tried.push(`缓存 zip ${zip.name}: ${e.message}`);
    }
  }
  throw new ToolError(
    '找不到可用的 Electron。已尝试：\n  - ' + (tried.join('\n  - ') || '无候选') +
      '\n可显式指定：--electron <Electron 可执行文件> 或 MDH_ELECTRON=...',
    EXIT.ELECTRON
  );
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function seedHome(home, seedSession) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(home, 'providers'), { recursive: true, mode: 0o700 });
  // 最小可用配置：不写任何密钥；服务会正常起界面，只在对话前提示缺 Key。
  const cfg = {
    provider: 'deepseek',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com/v1',
    permission: 'ask',
    sandbox: 'off',
    contextBudget: 128000,
  };
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  if (!seedSession) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(home, 'sessions', `${stamp}-ui-shot.jsonl`);
  const messages = [
    {
      role: 'user',
      content: '用一句话说明这个 WebUI 是做什么的，并给一个最短的验证步骤。',
    },
    {
      role: 'assistant',
      content:
        '这是 MingDao Harness 的本地 WebUI：在浏览器里跑真实的 Agent 会话，查看工具轨迹、费用与设置。\n\n' +
        '最短验证：运行 `node scripts/ui-shot.mjs`，确认 `home.png / settings.png / palette.png / session.png` 四张图都生成且尺寸正确。',
    },
  ];
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n', { mode: 0o600 });
  return file;
}

function startWebServer({ port, home, token, verbose }) {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'web', String(port)], {
    cwd: ROOT,
    env: childEnv({ MINGDAO_HOME: home, MINGDAO_WEB_TOKEN: token, NO_COLOR: '1', FORCE_COLOR: '0' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ToolError('WebUI 服务启动超时（30s）\n--- stdout ---\n' + tail(stdout) + '\n--- stderr ---\n' + tail(stderr), EXIT.FAIL));
    }, 30000);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (verbose) process.stderr.write('[web] ' + redactToken(String(d)));
      const m = stdout.match(/访问令牌:\s*(http:\/\/[^\s]+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(m[1].trim());
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      if (verbose) process.stderr.write('[web:err] ' + d);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError('无法启动 WebUI 子进程：' + err.message, EXIT.FAIL));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new ToolError(
          'WebUI 服务在就绪前退出（code=' + code + ', signal=' + signal + '）\n--- stdout ---\n' + tail(stdout) + '\n--- stderr ---\n' + tail(stderr),
          EXIT.FAIL
        )
      );
    });
  });
  return { child, ready, logs: () => ({ stdout, stderr }) };
}

async function waitHttp(url) {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status === 200) return;
      last = 'HTTP ' + res.status;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new ToolError('服务端口已监听，但 HTTP 自检失败：' + last, EXIT.FAIL);
}

async function stopChild(child, name) {
  if (!child || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch {}
  }
  const exited = await Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (exited || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
  await Promise.race([
    new Promise((r) => child.once('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 2000)),
  ]);
  if (child.exitCode === null) process.stderr.write('[ui-shot] ⚠ ' + name + ' 未能确认退出（pid ' + pid + '）\n');
}

function runElectron({ electron, appDir, configPath, resultPath, timeoutMs, verbose }) {
  const args = [appDir, '--user-data-dir=' + path.join(appDir, 'user-data')];
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const child = spawn(electron.bin, args, {
    cwd: ROOT,
    env: childEnv({ MDH_SHOT_CONFIG: configPath, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
    if (verbose) process.stderr.write('[electron] ' + redactToken(String(d)));
  });
  child.stderr.on('data', (d) => {
    stderr += d;
    if (verbose) process.stderr.write('[electron:err] ' + redactToken(String(d)));
  });
  const result = new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ timedOut: true, code: null, stdout, stderr });
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, signal: null, stdout, stderr: stderr + '\n' + err.message });
    });
  });
  return { child, result };
}

function readResult(resultPath) {
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

function assertTempDir(dir, prefix) {
  const abs = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  if (!abs.startsWith(tmp + path.sep) || !path.basename(abs).startsWith(prefix)) {
    throw new Error('拒绝删除非临时目录：' + abs);
  }
  return abs;
}

function writeElectronApp(appDir) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'mdh-ui-shot-runner', version: '1.0.0', private: true, main: 'main.cjs' }, null, 2) + '\n'
  );
  fs.writeFileSync(path.join(appDir, 'main.cjs'), ELECTRON_MAIN);
}

function reportShots(shots) {
  for (const s of shots) {
    const kb = (s.bytes / 1024).toFixed(1);
    console.log(`  ${s.name.padEnd(9)} ${String(s.width).padStart(4)}×${String(s.height).padEnd(4)}  ${kb} KB  ${s.path}`);
  }
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error('[ui-shot] ✗ ' + e.message + '\n\n' + usage());
      return EXIT.USAGE;
    }
    throw e;
  }
  if (opts.help) {
    console.log(usage());
    return EXIT.OK;
  }

  let electron;
  try {
    electron = await resolveElectron(opts);
  } catch (e) {
    console.error('[ui-shot] ✗ ' + redactToken(e.message || e));
    return e.code || EXIT.ELECTRON;
  }
  console.log('[ui-shot] electron: ' + electron.source + ' · v' + electron.version);
  console.log('[ui-shot] electron 路径: ' + electron.bin);

  fs.mkdirSync(opts.out, { recursive: true });
  // 清掉上次的四张同名图，避免本次失败时把旧图误当成新证据。
  for (const name of ['home', 'settings', 'palette', 'session']) {
    try { fs.rmSync(path.join(opts.out, name + '.png'), { force: true }); } catch {}
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-ui-shot-home-'));
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-ui-shot-app-'));
  const configPath = path.join(appDir, 'shot-config.json');
  const resultPath = path.join(appDir, 'result.json');
  let sessionFile = null;
  const token = crypto.randomBytes(16).toString('hex');
  let server = null;
  let electronRun = null;
  let code = EXIT.OK;

  try {
    sessionFile = seedHome(home, opts.seedSession);
    const port = await getFreePort();
    server = startWebServer({ port, home, token, verbose: opts.verbose });
    console.log('[ui-shot] 启动 WebUI：node src/cli.js web ' + port + '（MINGDAO_HOME=' + home + '）');
    const url = await server.ready;
    console.log('[ui-shot] 真实 URL: ' + url.replace(/token=[^&]+/, 'token=***'));
    await waitHttp(url);
    if (sessionFile) console.log('[ui-shot] 演示会话: ' + path.basename(sessionFile));

    writeElectronApp(appDir);
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          url,
          outDir: opts.out,
          resultPath,
          width: opts.width,
          height: opts.height,
          scale: opts.scale,
          theme: opts.theme,
          mobile: opts.mobile,
          userAgent: opts.mobile ? MOBILE_UA : null,
          waitMs: opts.wait,
          allowConsoleErrors: opts.allowConsoleErrors,
          viewport: opts.viewport,
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    );

    console.log(
      '[ui-shot] 截图：' + (opts.mobile ? 'mobile' : opts.viewport) + ' ' + opts.width + '×' + opts.height +
        ' @' + opts.scale + 'x · theme=' + opts.theme + (opts.mobile ? ' · mobile' : '')
    );
    electronRun = runElectron({
      electron,
      appDir,
      configPath,
      resultPath,
      timeoutMs: 120000,
      verbose: opts.verbose,
    });
    const outcome = await electronRun.result;
    if (outcome.timedOut) {
      await stopChild(electronRun.child, 'Electron');
      throw new ToolError('Electron 截图超时（120s）\n--- stdout ---\n' + tail(outcome.stdout) + '\n--- stderr ---\n' + tail(outcome.stderr), EXIT.SHOT);
    }
    const result = readResult(resultPath);
    if (!result) {
      throw new ToolError(
        'Electron 没有写出结果文件（exit=' + outcome.code + '）\n--- stdout ---\n' + tail(outcome.stdout) + '\n--- stderr ---\n' + tail(outcome.stderr),
        EXIT.SHOT
      );
    }
    if (result.warnings && result.warnings.length) {
      for (const w of result.warnings) console.warn('[ui-shot] ⚠ ' + w);
    }
    if (!result.ok) {
      const isPage = String(result.error || '').includes('页面报错');
      throw new ToolError(
        redactToken(result.error || 'Electron 截图失败') +
          (result.pageErrors && result.pageErrors.length
            ? '\n页面错误：\n  - ' + result.pageErrors.map((x) => redactToken(x)).join('\n  - ')
            : ''),
        isPage ? EXIT.PAGE : EXIT.SHOT
      );
    }
    console.log('[ui-shot] ✓ ' + result.shots.length + ' 张截图 → ' + opts.out);
    reportShots(result.shots);
    const missing = ['home', 'settings', 'palette', 'session'].filter(
      (n) => !result.shots.some((s) => s.name === n)
    );
    if (missing.length) console.warn('[ui-shot] ⚠ 未生成：' + missing.join(', '));
  } catch (e) {
    code = e instanceof ToolError ? e.code : EXIT.FAIL;
    console.error('[ui-shot] ✗ ' + redactToken(e.message || e));
    if (server) {
      const logs = server.logs();
      if (code !== EXIT.FAIL || opts.verbose) {
        console.error('--- WebUI stdout ---\n' + tail(logs.stdout));
        console.error('--- WebUI stderr ---\n' + tail(logs.stderr));
      }
    }
  } finally {
    if (electronRun) await stopChild(electronRun.child, 'Electron');
    if (server) await stopChild(server.child, 'WebUI');
    if (opts.keepTemp) {
      console.log('[ui-shot] --keep-temp：保留 MINGDAO_HOME=' + home + '，Electron app=' + appDir);
    } else {
      try { fs.rmSync(assertTempDir(home, 'mdh-ui-shot-home-'), { recursive: true, force: true }); } catch (e) {
        console.warn('[ui-shot] ⚠ 删除临时 MINGDAO_HOME 失败：' + e.message);
      }
      try { fs.rmSync(assertTempDir(appDir, 'mdh-ui-shot-app-'), { recursive: true, force: true }); } catch (e) {
        console.warn('[ui-shot] ⚠ 删除临时 Electron app 失败：' + e.message);
      }
    }
  }
  return code;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error('[ui-shot] ✗ 未处理异常：' + (e && e.stack ? e.stack : e));
    process.exitCode = EXIT.FAIL;
  });
