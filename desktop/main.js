// MingDao Harness 桌面版（Electron 薄壳）：
//  - 主进程内启动 MingDao WebUI（复用 src/web/server.js，零子进程零端口暴露）
//  - 127.0.0.1 随机端口 + 一次性访问令牌，窗口只加载本机地址
//  - 系统托盘（关闭最小化到托盘）、应用菜单、窗口大小/位置记忆、单实例锁
//  - 权限收紧（摄像头/通知/插件等一律拒绝）、外链交系统浏览器
//  - 打包版自动检查更新（electron-updater，GitHub Releases）
import { app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu, nativeImage, powerSaveBlocker } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 更新包**来源签名**校验（审计 K-8）：纯函数 + 内置公钥常量，判据/文案/取舍见该模块文件头。
// electron-updater 自带的 sha512 只防传输损坏，不防"换了发布源 / 被投毒的 feed"——这一步补的是来源。
import { collectUpdateSignature, evaluateUpdate, keyIdOf, requireSignatureFromEnv, UPDATE_PUBLIC_KEYS } from './update-verify.js';
// v0.8.3：deb 安装形态（无 $APPIMAGE）的独立更新通道——feed 解析 / 版本比较 / sha512 / 安装计划
// 都在这个纯函数模块里（可单测）；本文件只负责 https 下载、对话框与 spawn 安装。
import { DEB_FEED_FILE, installPlan, isNewer, parseDebFeed, parseSigFile, sigUrlCandidates, verifySha512Base64 } from './deb-update.js';
// v0.9.2：更新线路选择（香港 / 深圳）。纯函数 + 注入式探测在 desktop/endpoint.js（可单测），
// 本文件只做「真实 TTFB 探测 / endpoint.json 读写 / 把选中的 base 应用到每条通道」。
import {
  CACHE_FILE as ENDPOINT_CACHE_FILE,
  CACHE_TTL_MS as ENDPOINT_CACHE_TTL_MS,
  DEFAULT_ENDPOINT,
  ENDPOINT_CANDIDATES,
  PROBE_TIMEOUT_MS,
  UPDATE_BASE_ENV,
  downloadPageUrl,
  downloadsBase,
  fallbackChain,
  isMirrorMiss,
  joinPath,
  normalizeBase,
  selectEndpoint,
  updatesBase,
} from './endpoint.js';

/**
 * 更新遥测是否被显式关闭（审计 BUG-083）。
 * 任一方式即可退出：`MINGDAO_NO_TELEMETRY=1` 环境变量，或 `config.json` 里 `telemetry: false`。
 * 只读本地配置，失败（文件缺失/损坏）按"未关闭"处理——不因读配置失败而改变用户的选择。
 */
function telemetryDisabled() {
  if (String(process.env.MINGDAO_NO_TELEMETRY || '') === '1') return true;
  try {
    const home = process.env.MINGDAO_HOME || path.join(app.getPath('home'), '.mingdao');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    return cfg?.telemetry === false;
  } catch {
    return false;
  }
}

// Linux 桌面渲染加固（审计：deepin 等合成器下 Electron 窗口「只有菜单、内容黑屏」的通用修复）：
// 1) 强制 X11/XWayland 合成路径（规避 Wayland/DDE 合成器黑屏）；2) 默认禁用 GPU 硬件加速
// （本应用是文本界面，软渲染足够）。需要时 MINGDAO_GPU=1 / MINGDAO_WAYLAND=1 可恢复默认行为。
if (process.platform === 'linux') {
  if (process.env.MINGDAO_WAYLAND !== '1') app.commandLine.appendSwitch('ozone-platform', 'x11');
  if (process.env.MINGDAO_GPU !== '1') app.disableHardwareAcceleration();
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 开发态：desktop/ 的上一级即仓库根；打包态：src/ 在 process.resourcesPath 下
const srcRoot = app.isPackaged ? path.join(process.resourcesPath, 'src') : path.join(__dirname, '..', 'src');
const buildRoot = path.join(__dirname, 'build');
const isDev = !app.isPackaged;

// 桌面版诊断日志（渲染层 console + 主进程关键事件）：userData/logs/mingdao.log，1MB 滚动
// 质检 A6：统一日志写入器（append + 按行截断 + 原子替换），与服务端 srvlog 同款。
// 必须从 srcRoot 动态加载（开发态 ../src、打包态 resourcesPath/src），静态 import 会在打包版找不到路径
// （0.2.2 事故：此处调用 createLogWriter 却漏了导入，三平台启动即崩；冒烟见 MINGDAO_DESKTOP_SMOKE）。
const { createLogWriter } = await import(pathToFileURL(path.join(srcRoot, 'log-writer.js')).href);
const appLog = createLogWriter(path.join(app.getPath('userData'), 'logs', 'mingdao.log'));

// v0.9.2：更新专属日志 ~/.mingdao/logs/desktop.log（含 stage=feed/confirm/download/save/verify/sig/install、
// 线路 endpoint=sz|hk probe=xxms、每整十百分比进度行）。用户反馈"点下载并安装没反应"时，这个文件就是
// 唯一能带回来的证据；失败对话框统一有「打开日志」按钮直开它。MINGDAO_HOME 可改家目录（与 telemetry 同口径）。
const APP_TITLE = 'MingDao Harness';
function mingdaoHomeDir() {
  return process.env.MINGDAO_HOME || path.join(app.getPath('home'), '.mingdao');
}
function desktopLogFile() {
  return path.join(mingdaoHomeDir(), 'logs', 'desktop.log');
}
const desktopLogWriter = createLogWriter(desktopLogFile());
/** 更新链路日志：同时写主日志（userData）与 desktop.log（用户可带回的证据文件）。 */
function updLog(/** @type {string} */ msg) {
  appLog(msg);
  try { desktopLogWriter(msg); } catch {}
}

let mainWindow = null;
let tray = null;
let quitting = false;

// —— 窗口状态记忆（大小/位置，userData 下 JSON）——
function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}
function loadWindowState() {
  try {
    const st = JSON.parse(fs.readFileSync(windowStateFile(), 'utf8'));
    if (st && typeof st === 'object') return st;
  } catch {}
  return {};
}
function saveWindowState(win) {
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized() }), 'utf8');
  } catch {}
}

/** 启动内置 WebUI，返回 { port, token }；配置缺失时提示后退出 */
async function startServer() {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(srcRoot, 'web', 'server.js')).href);
  } catch (err) {
    dialog.showErrorBox('MingDao Harness', `无法加载内置服务：${err?.message || err}`);
    app.quit();
    return null;
  }
  const { ensureMinimalConfig } = await import(pathToFileURL(path.join(srcRoot, 'config.js')).href);
  // 首次运行自动初始化（审计）：无配置时自动建最小可用配置直接进入界面，
  // API Key 引导在 WebUI 内完成（顶部横幅 + ⚙ 设置），不再要求先跑终端 mingdao init
  ensureMinimalConfig();
  const authToken = crypto.randomBytes(16).toString('hex');
  // 质检 C2/D1：端口占用重试——listen 现在会 reject，随机段被占时换端口重试，不再黑屏空转
  for (let attempt = 0; attempt < 6; attempt++) {
    const port = 40000 + Math.floor(Math.random() * 20000);
    try {
      // v0.4.3 network error 修复：生成期防睡眠/防熄屏——macOS 熄屏（Idle Sleep）会中断
      // Chromium 网络栈导致 SSE 断连（长任务「network error」根因）。有 running 任务即持 blocker，
      // 任务结束释放；prevent-display-sleep 比 prevent-app-suspension 更对症（熄屏通知本身即断连）。
      let blockerId = /** @type {number | null} */ (null);
      const onBusy = (/** @type {boolean} */ busy) => {
        try {
          if (busy && blockerId === null) {
            blockerId = powerSaveBlocker.start('prevent-display-sleep');
            appLog('生成中：防睡眠已开启（prevent-display-sleep）');
          } else if (!busy && blockerId !== null) {
            if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
            blockerId = null;
            appLog('生成结束：防睡眠已释放');
          }
        } catch (e) {
          appLog('防睡眠切换失败：' + String((/** @type {any} */ (e))?.message || e));
        }
      };
      await mod.runWebServer({ host: '127.0.0.1', port, authToken, onBusy });
      return { port, token: authToken };
    } catch (err) {
      const code = /** @type {Error & { code?: string }} */ (err).code;
      if (code === 'EADDRINUSE') {
        appLog('端口被占用，重试随机端口（' + (attempt + 1) + '/6）');
        continue;
      }
      dialog.showErrorBox('MingDao Harness', `WebUI 启动失败：${err?.message || err}`);
      app.quit();
      return null;
    }
  }
  dialog.showErrorBox('MingDao Harness', 'WebUI 启动失败：连续 6 次随机端口均被占用，请稍后重试');
  app.quit();
  return null;
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: [{ role: 'quit', label: '退出 MingDao Harness' }] },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        ...(isDev ? [{ role: 'toggleDevTools', label: '开发者工具' }] : []),
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '官网', click: () => shell.openExternal('https://harness.mingdao.ai') },
        { label: '检查更新', click: () => checkUpdatesFromMenu() },
        { label: '文档（Gitee）', click: () => shell.openExternal('https://gitee.com/MingDaoTCM/MingDao-harness') },
        { label: '问题反馈（社区论坛）', click: () => shell.openExternal('https://harness.mingdao.ai/forum/') },
        { label: '关于 MingDao Harness', click: () => dialog.showMessageBox({ title: '关于', message: 'MingDao Harness 桌面版', detail: `版本 v${app.getVersion()}\n零依赖 DeepSeek-V4 智能体框架\nhttps://harness.mingdao.ai` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 图标读取：打包后 build/ 位于 app.asar 内——nativeImage.createFromPath 对 asar 路径
// 支持不稳定，统一改为读字节 + createFromBuffer（审计：打包版托盘/窗口图标缺失修复）
function loadIcon(file) {
  try {
    return nativeImage.createFromBuffer(fs.readFileSync(path.join(buildRoot, file)));
  } catch {
    return null;
  }
}

function trayIcon() {
  return loadIcon('tray.png');
}

function buildTray() {
  const icon = trayIcon();
  if (!icon) return;
  tray = new Tray(icon);
  tray.setToolTip('MingDao Harness');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 MingDao Harness', click: () => showMainWindow() },
      { label: '隐藏窗口', click: () => mainWindow?.hide() },
      { type: 'separator' },
      { label: '退出 MingDao Harness', click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on('double-click', () => showMainWindow());
}

function showMainWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

async function createWindow() {
  const info = await startServer();
  if (!info) return;
  const st = loadWindowState();
  const win = new BrowserWindow({
    width: st.width || 1280,
    height: st.height || 860,
    x: st.x,
    y: st.y,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: false,
    backgroundColor: '#0b0e14',
    title: 'MingDao Harness',
    icon: loadIcon('icon.png') || undefined,
    show: false,
    // 权限收紧（审计 MiniMax §2.1）：webview 显式禁用 + 页面 CSP（index.html meta）双重防线
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // v0.6.8：向 WebUI 暴露**极小**的桌面能力（目前只有"选目录"）。沙箱下 preload 仍可用
      // contextBridge/ipcRenderer，渲染进程依旧拿不到 Node —— 与既有安全档位一致。
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  // v0.9.2：下载期间窗口标题要显示"正在下载更新 NN%"（Linux 任务栏进度条多半不显示）。
  // 页面自身的 title 更新会把标题抢回去，所以下载期间拦掉 page-title-updated。
  win.on('page-title-updated', (e) => {
    if (updateTitleActive) e.preventDefault();
  });
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('resize', () => saveWindowState(win));
  win.on('move', () => saveWindowState(win));
  win.on('close', (e) => {
    // 关闭窗口 → 最小化到托盘（托盘菜单/菜单退出/Cmd+Q 才真正退出）
    if (!quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });

  // 权限收紧：摄像头/麦克风/通知/媒体等一律拒绝
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  appLog('窗口加载 ' + `http://127.0.0.1:${info.port}/?token=***`);
  win.loadURL(`http://127.0.0.1:${info.port}/?token=${info.token}`);
  // 渲染层控制台捕获（排查「第二问无反应」等前端状态问题）
  win.webContents.on('console-message', (e, _level, message) => {
    const m = typeof message === 'string' ? message : e && e.message;
    if (m) appLog('[renderer] ' + m);
  });
  win.webContents.on('did-finish-load', () => appLog('页面加载完成'));
  // 渲染自愈（审计：黑屏僵死兜底）——页面加载失败/渲染进程崩溃时自动重载一次；
  // dom-ready 兜底显示（个别合成器下 ready-to-show 不触发导致窗口一直不出现）
  win.once('dom-ready', () => {
    if (!win.isVisible()) win.show();
  });
  // 质检 A7：崩溃循环护栏——连续快速崩溃超过阈值后弹窗提示，避免无限重载闪烁
  let crashCount = 0;
  let crashWindowT0 = Date.now();
  const guardCrash = () => {
    const now = Date.now();
    if (now - crashWindowT0 > 60000) {
      crashWindowT0 = now;
      crashCount = 0;
    }
    crashCount += 1;
    if (crashCount >= 3) {
      appLog('渲染进程连续崩溃 3 次，停止自动重载');
      dialog
        .showMessageBox({
          type: 'error',
          title: '界面异常',
          message: '界面连续多次崩溃，已停止自动重载',
          detail: '请重启应用；若反复出现，请到论坛反馈：https://harness.mingdao.ai/forum/',
          buttons: ['重启应用', '退出'],
          noLink: true,
        })
        .then((r) => {
          if (r.response === 0) {
            crashCount = 0;
            win.webContents.reload();
          } else {
            app.quit();
          }
        })
        .catch(() => {});
      return false;
    }
    return true;
  };
  win.webContents.on('did-fail-load', (_e, code, _desc, url) => {
    appLog('did-fail-load code=' + code + ' ' + url);
    if (code !== -3 && String(url || '').startsWith('http://127.0.0.1:') && guardCrash()) win.webContents.reload();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    appLog('render-process-gone ' + JSON.stringify(details || {}));
    if (!quitting && guardCrash()) win.webContents.reload();
  });
  // 只允许**本窗口这一个端口**的本机地址在窗口内导航；其余链接交给系统浏览器。
  // v0.6.8（报告一 K-8）：此前判据是 `startsWith('http://127.0.0.1:')`——任何本机端口都放行，
  // 而本机常有别的服务（开发服务器、日志面板、其它应用的回环端口）；`openExternal` 也**不校验协议**
  // （`file:`/`smb:`/自定义 scheme 会原样交给系统处理）。现在：端口钉死 + 仅 http(s) 出外链。
  const allowedOrigin = `http://127.0.0.1:${info.port}`;
  const openExternalSafe = (/** @type {any} */ url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
      else appLog('拒绝用系统浏览器打开非 http(s) 链接：' + u.protocol);
    } catch {
      appLog('拒绝打开无法解析的链接');
    }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!String(url).startsWith(allowedOrigin)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  // 原生目录选择器（v0.6.8，负责人要求）：登记/添加工作空间时弹系统对话框，**默认停在当前用户家目录**，
  // 用户点一下就能选中自己的项目目录；取消返回 null（前端据此什么都不做）。
  ipcMain.removeHandler('mdh:pick-directory');
  ipcMain.handle('mdh:pick-directory', async (_evt, startDir) => {
    try {
      const start = typeof startDir === 'string' && startDir ? startDir : os.homedir();
      const r = await dialog.showOpenDialog(win, {
        title: '选择工作空间目录',
        defaultPath: start,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '使用此目录',
      });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
      return r.filePaths[0];
    } catch (e) {
      appLog('目录选择器失败：' + (e && /** @type {any} */ (e).message ? /** @type {any} */ (e).message : String(e)));
      return null;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.8.3：deb 安装形态（`/opt/MingDao Harness/`，无 `$APPIMAGE`）的自动更新通道。
//
// 背景：electron-updater 只支持 AppImage / NSIS / dmg+zip——deb 安装此前只弹"请到官网下载"。
// 现在：独立 feed（latest-linux-deb.yml）→ 语义化版本比较 → 下载 → **sha512 且 ed25519 来源签名**
// 双校验 → `pkexec dpkg -i` → 重启。判断/校验/安装计划的纯函数在 desktop/deb-update.js（可单测），
// 本段只做 I/O 与对话框。
//
// 信任边界（与 AppImage 路径同一口径，不降级）：sha512 只防传输损坏；来源信任必须靠
// UPDATE_PUBLIC_KEYS 验签。两者是**与**关系，任一失败 → 删除下载文件并报错，**绝不安装**。
// ─────────────────────────────────────────────────────────────────────────────
const DEB_MAX_BYTES = 400 * 1024 * 1024; // 400 MiB 上限：deb 约 76 MB，异常大包直接拒绝
const DEB_FEED_TIMEOUT_MS = 15000; // 清单/签名是静态小文件，15 秒拿不到就报错
const DEB_DOWNLOAD_TIMEOUT_MS = 300000; // 安装包大文件给 5 分钟**总**超时
// v0.9.2（用户实测"卡住要干等 5 分钟"）：总超时只兜"慢慢下"；链路静默断流（TCP 半开、中继掐断）
// 时数据不再到达，必须按**空闲**判死——连续 30s 一个字节都没收到就中止并提示"网络停滞"。
const DEB_IDLE_TIMEOUT_MS = 30000;

// —— v0.9.2：线路选择状态（香港 / 深圳；纯逻辑见 desktop/endpoint.js） ——
/** @type {{id: string, base: string, source: string, ms: number | null} | null} */
let updateEndpoint = null;
/** @type {Promise<{id: string, base: string, source: string, ms: number | null}> | null} */
let endpointResolving = null;
let updateTitleActive = false;

/** `userData/endpoint.json`（24h 缓存；env 覆盖/全失败回退都不写它）。 */
function endpointCacheFile() {
  return path.join(app.getPath('userData'), ENDPOINT_CACHE_FILE);
}
function readEndpointCacheText() {
  try { return fs.readFileSync(endpointCacheFile(), 'utf8'); } catch { return ''; }
}
function writeEndpointCacheText(text) {
  try {
    fs.mkdirSync(path.dirname(endpointCacheFile()), { recursive: true });
    fs.writeFileSync(endpointCacheFile(), text, 'utf8');
    return true;
  } catch (err) {
    updLog('stage=endpoint 线路缓存写入失败：' + String(err?.message || err));
    return false;
  }
}

/**
 * 真实 TTFB 探测（测量「发出请求 → 收到响应头」的时间），只取一个字节都不读就断开。
 * 注入给 endpoint.js 的 selectEndpoint（纯逻辑在那边，单测注入假 probe）。
 * @param {string} url
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ms: number, status: number}>}
 */
function httpsProbeTtfb(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = process.hrtime.bigint();
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @param {any} err @param {{ms: number, status: number}} [value] */
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(/** @type {{ms: number, status: number}} */ (value));
    };
    /** @type {import('node:http').ClientRequest} */
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': 'MingDaoHarness/' + app.getVersion(), Accept: '*/*' } }, (res) => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const status = Number(res.statusCode || 0);
        res.resume();
        try { req.destroy(); } catch {}
        if (status === 200) finish(null, { ms, status });
        else finish(Object.assign(new Error('HTTP ' + status), { status }));
      });
    } catch (err) {
      finish(err);
      return;
    }
    req.on('error', (/** @type {any} */ err) => finish(err));
    timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish(new Error('探测超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/**
 * 选定（或复用进程内已选的）更新线路。日志固定写 `endpoint=sz|hk probe=xxms`，便于用户反馈时定位。
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<{id: string, base: string, source: string, ms: number | null}>}
 */
function ensureUpdateEndpoint({ force = false } = {}) {
  if (updateEndpoint && !force) return Promise.resolve(updateEndpoint);
  if (endpointResolving) return endpointResolving;
  endpointResolving = (async () => {
    const result = await selectEndpoint({
      envBase: String(process.env[UPDATE_BASE_ENV] || ''),
      cache: readEndpointCacheText(),
      now: Date.now(),
      ttl: ENDPOINT_CACHE_TTL_MS,
      probe: httpsProbeTtfb,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const probeText = result.ms == null ? '-' : Math.round(Number(result.ms)) + 'ms';
    updLog(
      'stage=endpoint endpoint=' + result.id + ' probe=' + probeText + ' source=' + result.source + ' base=' + result.base +
        (result.source === 'env' ? '（' + UPDATE_BASE_ENV + ' 强制覆盖）' : '') +
        (result.source === 'fallback' ? '（全部探测失败，回退香港）' : '')
    );
    if (result.probes.length) {
      updLog(
        'stage=endpoint 探测明细 ' +
          result.probes
            .map((p) => p.id + '=' + (p.ok && p.ms != null ? Math.round(Number(p.ms)) + 'ms' : '失败(' + (p.reason || '?') + ')'))
            .join(' ')
      );
    }
    if (result.cacheRecord) writeEndpointCacheText(JSON.stringify(result.cacheRecord) + '\n');
    updateEndpoint = { id: result.id, base: result.base, source: result.source, ms: result.ms };
    return updateEndpoint;
  })().finally(() => { endpointResolving = null; });
  return endpointResolving;
}

/** 当前线路的 base（未选定时用默认香港——保证任何代码路径都能拼出可用 URL）。 */
function updateBase() {
  return (updateEndpoint && updateEndpoint.base) || DEFAULT_ENDPOINT.base;
}
/** feed 目录（electron-updater `setFeedURL` 与 deb 清单共用）。 */
function updateFeedDir() {
  return updatesBase(updateBase());
}
/** 安装包/签名目录（镜像 302 到香港也由 httpsGetBuffer 跟随即成）。 */
function updateDownloadsDir() {
  return downloadsBase(updateBase());
}
/** 「去官网下载」页面（按选中线路；香港默认即品牌站）。 */
function updateDownloadPage() {
  return downloadPageUrl(updateBase());
}
/** base → 线路 id（日志/证据用；未知 base 按香港标注——回退链的第二跳就是香港）。 */
function endpointLabelOf(base) {
  const normalized = normalizeBase(base);
  const hit = ENDPOINT_CANDIDATES.find((c) => normalizeBase(c.base) === normalized);
  return hit ? hit.id : DEFAULT_ENDPOINT.id;
}

/**
 * 按「选中线路 → 香港」顺序取一份更新资源（feed / 安装包 / `.sig` 全走它）。
 *
 * 诚实处理（历史记录：深圳镜像缺文件时曾 302 到香港，也出现过 404）：镜像 403/404/410
 * 或域名解析失败 → **自动回退香港再试一次**，成功就继续；仍然失败才把错误抛给调用方。
 * 超时/断流**不**回退（链路问题回退通常也救不了，只会让用户多等一倍时间）。
 * @param {string} relPath 相对 base 的路径，如 `/updates/latest-linux-deb.yml`
 * @param {{timeoutMs?: number, maxBytes?: number, onProgress?: ((got: number, total: number) => void) | null, redirects?: number, stage?: string}} [opts]
 * @returns {Promise<{base: string, url: string, buf: Buffer}>}
 */
async function getUpdateResource(relPath, { stage = 'download', ...opts } = {}) {
  /** @type {string[]} */
  const chain = fallbackChain(updateBase());
  /** @type {any} */
  let lastErr = null;
  for (let i = 0; i < chain.length; i += 1) {
    const base = chain[i];
    const url = joinPath(base, relPath);
    try {
      const buf = await httpsGetBuffer(url, opts);
      if (i > 0) updLog('stage=' + stage + ' 已回退香港取到 ' + url);
      return { base, url, buf };
    } catch (err) {
      lastErr = err;
      const canFallback = i === 0 && chain.length > 1 && isMirrorMiss(err);
      updLog(
        'stage=' + stage + ' 取 ' + url + ' 失败：' + String(err?.message || err) +
          (canFallback ? '（镜像缺文件，回退香港重试一次）' : '')
      );
      if (!canFallback) throw err;
    }
  }
  throw lastErr || new Error('取更新资源失败');
}

/**
 * 统一的对话框调用：**有窗口才传父窗口**。
 *
 * v0.9.2 根因修复（用户实测「确认后没反应」）：Electron 的签名是
 * `showMessageBox([browserWindow,] options)`；旧代码 `showMessageBox(mainWindow ?? undefined, opts)`
 * 在 `mainWindow === null`（窗口已隐藏/销毁、或启动期自动检查早于窗口创建）时**把 undefined 当成
 * options** 传进去 → Electron 抛 TypeError → 被 `.catch(() => ({ response: 1 }))` 吞掉 →
 * 被当成"用户点了稍后" → 整个更新流程静默终止，既无下载也无任何弹窗。
 * 现在：无窗口时只传一个参数；异常**记录日志并抛出**（由调用方弹出错误框，绝不静默）。
 * @param {any} opts
 * @returns {Promise<{response: number, checkboxChecked?: boolean}>}
 */
async function showBox(opts) {
  const parent = mainWindow && typeof mainWindow.isDestroyed === 'function' && !mainWindow.isDestroyed() ? mainWindow : null;
  try {
    return parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  } catch (err) {
    updLog('stage=dialog 对话框显示失败：' + String(err?.message || err));
    throw new Error('对话框显示失败：' + String(err?.message || err));
  }
}

/** 打开更新日志（`~/.mingdao/logs/desktop.log`；失败再退到所在目录）。 */
async function openDesktopLog() {
  const file = desktopLogFile();
  try {
    const err1 = await shell.openPath(file);
    if (!err1) { updLog('已打开更新日志 ' + file); return true; }
    const err2 = await shell.openPath(path.dirname(file));
    if (!err2) { updLog('日志文件打不开（' + err1 + '），已打开所在目录 ' + path.dirname(file)); return true; }
    updLog('打开日志失败：' + err1 + ' / ' + err2 + '（日志位置 ' + file + '）');
    return false;
  } catch (err) {
    updLog('打开日志异常：' + String(err?.message || err) + '（日志位置 ' + file + '）');
    return false;
  }
}

/**
 * 更新失败/异常对话框（**统一带「打开日志」按钮**）：把 stage + 线路 + 进度证据交给用户，
 * 便于把 desktop.log 发回来定位。detail 里同时给出日志绝对路径（即使按钮不可用也能手取）。
 * @param {{title?: string, message?: string, detail?: string, stage?: string, type?: 'warning' | 'error' | 'info'}} input
 * @returns {Promise<{response: number, openedLog?: boolean}>}
 */
async function showUpdateFailure({ title, message, detail, stage = '', type = 'warning' } = {}) {
  const logPath = desktopLogFile();
  const body = String(detail || '') + '\n\n日志：' + logPath + '\n（含 stage=' + (stage || '?') + ' / 线路 / 每整十百分比进度，可点「打开日志」后发给我们）';
  const res = await showBox({
    type,
    title: title || '更新失败',
    message: message || '更新失败',
    detail: body,
    buttons: ['打开日志', '知道了'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (res && res.response === 0) return { ...res, openedLog: await openDesktopLog() };
  return res || { response: 1 };
}

/**
 * 探测 `pkexec` 是否可用（精简发行版可能没装 polkit）。
 * 先 `which pkexec`，`which` 本身不存在时退 `sh -c 'command -v pkexec'`；找不到返回 ''（绝不抛）。
 * @returns {Promise<string>}
 */
function whichPkexec() {
  return new Promise((resolve) => {
    /** @param {string} cmd @param {string[]} args @param {(found: string) => void} next */
    const attempt = (cmd, args, next) => {
      /** @type {import('node:child_process').ChildProcess} */
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        next('');
        return;
      }
      let out = '';
      child.stdout?.on('data', (/** @type {Buffer} */ d) => { out += String(d); });
      child.on('error', () => next(''));
      child.on('close', (/** @type {number | null} */ code) => next(code === 0 ? out.trim() : ''));
    };
    attempt('which', ['pkexec'], (found) => {
      if (found) { resolve(found); return; }
      attempt('sh', ['-c', 'command -v pkexec'], (alt) => resolve(alt));
    });
  });
}

/**
 * 下载期间的**可见**进度：窗口标题百分比（Linux 任务栏/托盘进度条在多数桌面环境不显示，
 * 见 setUpdateProgress 注释）+ 每整十百分比一行 desktop.log。
 * @returns {(got: number, total: number) => void}
 */
function createDownloadProgressReporter() {
  let nextDecile = 10;
  let lastLoggedMiB = 0;
  setUpdateTitle('正在下载更新…');
  return (got, total) => {
    const gotN = Number(got) || 0;
    const totalN = Number(total) || 0;
    if (totalN > 0) {
      const ratio = Math.max(0, Math.min(1, gotN / totalN));
      setUpdateProgress(ratio);
      const pct = Math.floor(ratio * 100);
      setUpdateTitle('正在下载更新 ' + pct + '%');
      if (pct >= nextDecile) {
        const decile = Math.floor(pct / 10) * 10;
        updLog('stage=download 进度 ' + decile + '%（' + formatBytes(gotN) + '/' + formatBytes(totalN) + '）');
        nextDecile = decile + 10;
      }
    } else {
      setUpdateProgress(2);
      setUpdateTitle('正在下载更新…');
      const mib = Math.floor(gotN / (1024 * 1024));
      if (mib >= lastLoggedMiB + 10) {
        lastLoggedMiB = mib;
        updLog('stage=download 已下载 ' + mib + ' MiB（服务端未给 content-length）');
      }
    }
  };
}

/** 更新期间的窗口标题（可见反馈；传 null 恢复默认标题）。 */
function setUpdateTitle(/** @type {string | null} */ text) {
  try {
    if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) return;
    updateTitleActive = text != null;
    mainWindow.setTitle(text ? APP_TITLE + ' — ' + text : APP_TITLE);
  } catch (err) {
    appLog('更新标题设置失败：' + String(err?.message || err));
  }
}

/** 恢复默认窗口标题（幂等；任何退出路径都可调）。 */
function restoreUpdateTitle() {
  setUpdateTitle(null);
}

/** 窗口任务栏进度（无窗口时静默忽略）；value: 0~1 = 百分比，-1 = 清除，>1 = 不确定态。 */
function setUpdateProgress(value) {
  try {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.setProgressBar(value);
    }
  } catch {}
}

/** 人类可读字节数（只用于弹窗/日志，不做精确计算）。 */
function formatBytes(n) {
  const size = Number(n) || 0;
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  if (size >= 1024) return `${(size / 1024).toFixed(0)} KiB`;
  return `${size} B`;
}

/**
 * 极简 HTTPS GET → Buffer：跟随最多 5 次重定向、**总超时 + 空闲超时**、可选大小上限与进度回调。
 * 下载 deb 走它（而不是 fetch）是为了渐进式拿到 content-length 更新窗口进度，
 * 并在超过 400 MiB 时**边下边停**，不把异常大包整个读进内存。
 *
 * v0.9.2（用户实测「跨海下载卡住要干等 5 分钟」）：
 *   · `idleTimeoutMs`：连续 N 毫秒**没收到任何数据**就中止 → "网络停滞"（TCP 半开 / 中继掐断时
 *     套接字不会自己报错，只能靠空闲判死）；每次收到 data 重置计时。
 *   · `res.on('aborted')` / `res.on('close')`：对端中止、或连接在 `end` 之前关闭（半截包）
 *     都要立刻失败，而不是等总超时。
 *   · 非 200 的错误带上 `.status`（调用方据此判断"镜像缺文件 → 回退香港"）。
 * @param {string} url
 * @param {{timeoutMs?: number, idleTimeoutMs?: number, maxBytes?: number, onProgress?: ((got: number, total: number) => void) | null, redirects?: number}} [opts]
 * @returns {Promise<Buffer>}
 */
function httpsGetBuffer(
  url,
  {
    timeoutMs = DEB_FEED_TIMEOUT_MS,
    idleTimeoutMs = DEB_IDLE_TIMEOUT_MS,
    maxBytes = 0,
    onProgress = null,
    redirects = 0,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @type {NodeJS.Timeout | null} */
    let idleTimer = null;
    /** @param {string} [why] */
    const clearTimers = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    };
    /** @param {any} err @param {Buffer} [buf] */
    const done = (err, buf) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (err) reject(err);
      else resolve(/** @type {Buffer} */ (buf));
    };
    /** @type {import('node:http').ClientRequest} */
    let req;
    /** 空闲看门狗：重排计时；超时即中止并给出"网络停滞"文案。 */
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (!(idleTimeoutMs > 0)) return;
      idleTimer = setTimeout(() => {
        try { req.destroy(); } catch {}
        done(new Error('网络停滞：连续 ' + Math.round(idleTimeoutMs / 1000) + ' 秒没有收到任何数据，已中止下载'));
      }, idleTimeoutMs);
    };
    try {
      req = https.get(url, { headers: { 'User-Agent': 'MingDaoHarness/' + app.getVersion(), Accept: '*/*' } }, (res) => {
        const code = Number(res.statusCode || 0);
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirects >= 5) return done(new Error('重定向次数过多'));
          const next = new URL(String(res.headers.location), url).href;
          httpsGetBuffer(next, { timeoutMs, idleTimeoutMs, maxBytes, onProgress, redirects: redirects + 1 }).then(
            (b) => done(null, b),
            (e) => done(e)
          );
          return;
        }
        if (code !== 200) {
          res.resume();
          return done(Object.assign(new Error('HTTP ' + code), { status: code }));
        }
        const total = Number(res.headers['content-length'] || 0);
        if (maxBytes > 0 && total > maxBytes) {
          res.resume();
          return done(new Error('安装包过大（' + total + ' 字节，上限 ' + maxBytes + ' 字节）'));
        }
        /** @type {Buffer[]} */
        const chunks = [];
        let got = 0;
        armIdle();
        res.on('data', (/** @type {Buffer} */ chunk) => {
          armIdle();
          got += chunk.length;
          if (maxBytes > 0 && got > maxBytes) {
            try { req.destroy(); } catch {}
            return done(new Error('下载超过上限 ' + maxBytes + ' 字节，已中止'));
          }
          chunks.push(chunk);
          if (typeof onProgress === 'function') {
            try { onProgress(got, total); } catch {}
          }
        });
        res.on('end', () => done(null, Buffer.concat(chunks)));
        // 对端中止（RST / 服务端主动 abort）：立刻失败，不空等
        res.on('aborted', () => done(new Error('下载被中止：对端中断了连接（已收 ' + got + ' 字节）')));
        // 连接在 end 之前关闭 = 半截包；end 之后 close 属于正常收尾（settled 已置位）
        res.on('close', () => {
          if (settled) return;
          if (res.complete) return;
          done(new Error('下载被中止：连接提前关闭（已收 ' + got + ' 字节）'));
        });
        res.on('error', (/** @type {any} */ err) => done(err));
      });
    } catch (err) {
      done(err);
      return;
    }
    req.on('error', (/** @type {any} */ err) => done(err));
    timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      done(new Error('请求超时（' + timeoutMs + 'ms）'));
    }, timeoutMs);
  });
}

/** 同一时刻只允许一个 deb 更新流程（启动自动检查与菜单手动检查可能撞车）。 */
let debUpdateInFlight = false;

/**
 * deb 安装形态的更新主流程（v0.8.3 起；v0.9.2 重写可观测性与失败面）：检查 → 确认 → 下载 → 双校验 → 授权安装 → 重启。
 * 所有用户可见文案都在这里；纯判断与安装计划在 desktop/deb-update.js。
 *
 * v0.9.2（用户实测「点『下载并安装』后既无进度也无任何后续弹窗」）三处修复都在这条流程上：
 *   ① 对话框**按有无窗口分别调用**（旧 `showMessageBox(mainWindow ?? undefined, opts)` 在无窗口时
 *      把 undefined 当 options → 抛错被 `.catch(() => ({response:1}))` 吞成"用户点了稍后"→ 静默终止）；
 *   ② 下载有**空闲超时**（30s 无数据 → 网络停滞）与 stalled 提示；
 *   ③ 进度可见：窗口标题百分比 + desktop.log 每整十百分比一行（Linux 任务栏进度条多半不显示）。
 * 每一步都写 `stage=feed/confirm/download/save/verify/sig/install`；最外层 catch 记日志 + 明确报错。
 * @param {{fromMenu?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, stage?: string, upToDate?: boolean, deferred?: boolean, cancelled?: boolean, installed?: boolean, busy?: boolean, manual?: boolean, exitCode?: number, error?: string}>}
 */
async function runDebUpdateFlow({ fromMenu = false } = {}) {
  const errText = (/** @type {any} */ err) => String(err?.message || err);
  /** @type {string} */
  let stage = 'endpoint';
  if (debUpdateInFlight) {
    if (fromMenu) {
      try {
        await showBox({ type: 'info', title: '检查更新', message: '正在检查更新，请稍候…', detail: '上一轮 deb 更新流程尚未结束。' });
      } catch (err) {
        updLog('stage=confirm 提示「正在检查」的对话框失败：' + errText(err));
      }
    }
    return { ok: false, busy: true };
  }
  debUpdateInFlight = true;
  try {
    const current = String(app.getVersion());

    // ⓪ 线路选择（env 覆盖 / 24h 缓存 / 实时探测；日志固定 endpoint=sz|hk probe=xxms）
    await ensureUpdateEndpoint();

    // ① 拉取 deb 专用清单（15s 超时；解析失败一律不下载）。
    //    深圳镜像缺文件（403/404/410 或 DNS 失败）时 getUpdateResource 自动回退香港再试一次。
    stage = 'feed';
    /** @type {string} */
    let feedText;
    try {
      updLog(
        'stage=feed 拉取 deb 清单 ' + updateFeedDir() + DEB_FEED_FILE +
          '（endpoint=' + (updateEndpoint?.id ?? '?') + '）'
      );
      feedText = (
        await getUpdateResource('/updates/' + DEB_FEED_FILE, { stage: 'feed', timeoutMs: DEB_FEED_TIMEOUT_MS, maxBytes: 1024 * 1024 })
      ).buf.toString('utf8');
    } catch (err) {
      updLog('stage=feed 拉取清单失败：' + errText(err));
      await showUpdateFailure({
        stage: 'feed',
        title: '检查更新',
        message: '检查更新失败',
        detail: `无法获取 deb 更新清单（${errText(err)}）。\n请检查网络后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'feed' };
    }
    const feed = parseDebFeed(feedText, { downloadsBase: updateDownloadsDir() });
    if (!feed) {
      updLog('stage=feed 清单解析失败（缺 version/path/sha512 或格式非法）');
      await showUpdateFailure({
        stage: 'feed',
        title: '检查更新',
        message: '检查更新失败',
        detail: `deb 更新清单不可用（格式不符）。\n请稍后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'parse' };
    }
    updLog(
      `stage=feed 清单 v${feed.version}（当前 v${current}，size=${feed.size}，path=${feed.path}，base=${updateBase()}）`
    );

    // ② 版本比较 + ③ 确认下载（「确认」独立成一个 stage：用户点没点、点了哪个，日志都要能看见）
    stage = 'confirm';
    if (!isNewer(feed.version, current)) {
      updLog(`stage=confirm 已是最新（当前 v${current}，清单 v${feed.version}）`);
      await showBox({
        type: 'info',
        title: '检查更新',
        message: `当前版本：v${current}，已是最新版本`,
        detail: `deb 更新清单最新版本：v${feed.version}`,
        buttons: ['知道了'],
        noLink: true,
      });
      return { ok: true, upToDate: true };
    }
    const confirm = await showBox({
      type: 'info',
      title: '发现新版本',
      message: `发现新版本 v${feed.version}（当前 v${current}）`,
      detail: `deb 安装形态将下载安装包并做双重校验（sha512 完整性 + 来源签名），通过后才需要管理员授权安装。\n安装包约 ${formatBytes(feed.size)}。`,
      buttons: ['下载并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (confirm.response !== 0) {
      updLog('stage=confirm 用户选择稍后（未下载）：response=' + confirm.response);
      return { ok: true, deferred: true };
    }
    updLog('stage=confirm 用户确认下载安装 v' + feed.version);

    // ④ 下载到临时目录（文件名按任务书：mingdao-update-<ver>.deb；目录用 mkdtemp 防 /tmp 预置同名文件）
    //    feed 声明的 size 超过上限时直接拒绝，不浪费带宽下载一个注定被丢弃的包。
    stage = 'download';
    if (feed.size > DEB_MAX_BYTES) {
      updLog(`stage=download 清单 size ${feed.size} 超过上限 ${DEB_MAX_BYTES}，拒绝下载`);
      await showUpdateFailure({
        stage: 'download',
        title: '更新包异常',
        message: `更新包大小异常（${formatBytes(feed.size)}），已拒绝下载`,
        detail: `请稍后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'size' };
    }
    const safeVer = feed.version.replace(/[^0-9A-Za-z._-]/g, '_');
    let workDir = os.tmpdir();
    try { workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-update-')); } catch {}
    const filePath = path.join(workDir, `mingdao-update-${safeVer}.deb`);
    updLog('stage=download 开始下载 ' + updateDownloadsDir() + feed.path + ' → ' + filePath + '（endpoint=' + (updateEndpoint?.id ?? '?') + '）');
    setUpdateProgress(2);
    const onProgress = createDownloadProgressReporter();
    /** @type {Buffer} */
    let bytes;
    try {
      const got = await getUpdateResource('/downloads/' + feed.path, {
        stage: 'download',
        timeoutMs: DEB_DOWNLOAD_TIMEOUT_MS,
        idleTimeoutMs: DEB_IDLE_TIMEOUT_MS,
        maxBytes: DEB_MAX_BYTES,
        onProgress,
      });
      bytes = got.buf;
    } catch (err) {
      updLog('stage=download 下载失败：' + errText(err));
      await showUpdateFailure({
        stage: 'download',
        title: '更新下载失败',
        message: '新版本下载失败：' + errText(err),
        detail: `请检查网络后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'download' };
    } finally {
      restoreUpdateTitle();
      setUpdateProgress(-1);
    }
    if (feed.size > 0 && bytes.length !== feed.size) {
      updLog(`stage=download 大小与清单不一致（清单 ${feed.size}，实际 ${bytes.length}；交给 sha512 判定）`);
    }

    stage = 'save';
    try {
      fs.writeFileSync(filePath, bytes);
    } catch (err) {
      updLog('stage=save 写临时文件失败：' + errText(err));
      await showUpdateFailure({
        stage: 'save',
        title: '更新下载失败',
        message: '无法保存下载的安装包',
        detail: `${errText(err)}\n请检查磁盘空间/权限后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'save' };
    }
    updLog(`stage=save 下载完成 ${bytes.length} 字节 → ${filePath}`);

    // ⑤ 双校验：sha512 完整性 + ed25519 来源签名。任一失败 → 删除文件、绝不安装。
    stage = 'verify';
    const shaOk = verifySha512Base64(bytes, feed.sha512);
    stage = 'sig';
    const sigName = path.posix.basename(feed.path);
    // 候选 URL 由纯函数给出（feed 目录优先、包同目录兜底），下载时去掉 origin 走当前线路 + 香港回退。
    const sigCandidates = sigUrlCandidates({ sigName, feedUrl: feed.url, updatesBase: updateFeedDir() });
    /** @type {string[]} */
    const sigRelCandidates = sigCandidates
      .map((u) => {
        try { return new URL(u).pathname; } catch { return ''; }
      })
      .filter(Boolean);
    updLog('stage=sig 拉取来源签名，候选 ' + (sigRelCandidates.join(' , ') || '（无）'));
    let signatureB64 = '';
    let sigSource = '';
    let sigReason = '';
    for (const rel of sigRelCandidates) {
      try {
        const got = await getUpdateResource(rel, { stage: 'sig', timeoutMs: DEB_FEED_TIMEOUT_MS });
        const parsed = parseSigFile(got.buf.toString('utf8'));
        if (parsed) {
          signatureB64 = parsed;
          sigSource = path.posix.basename(got.url) + '@' + (endpointLabelOf(got.base));
          break;
        }
        sigReason = `${path.posix.basename(got.url)} 不是可用的 ed25519 签名（应为 64 字节 base64）`;
      } catch (err) {
        sigReason = `拉取 ${rel} 失败：${errText(err)}`;
      }
    }
    const sigResult = signatureB64
      ? verifyArtifactSignatureWithKeyring({ bytes, signatureB64, keys: UPDATE_PUBLIC_KEYS })
      : { ok: false, reason: sigReason || '没有取得可用的来源签名' };
    if (!shaOk || !sigResult.ok) {
      try { fs.unlinkSync(filePath); } catch {}
      updLog(
        `stage=verify 校验失败（sha512=${shaOk ? 'ok' : 'mismatch'}，签名=${sigResult.ok ? 'ok' : 'invalid'}，` +
          `原因=${sigReason || sigResult.reason || 'sha512 不匹配'}）→ 已删除下载文件，未安装`
      );
      await showUpdateFailure({
        stage: 'verify',
        title: '更新校验失败',
        message: '更新包未通过校验，已删除下载文件，未安装',
        detail:
          `sha512：${shaOk ? '通过' : '不匹配'}\n` +
          `来源签名：${sigResult.ok ? '通过' : sigResult.reason || '不可用'}\n\n` +
          `请检查网络后重试，或到官网下载：${updateDownloadPage()}`,
      });
      return { ok: false, stage: 'verify' };
    }
    updLog(`stage=verify 双校验通过（sha512=ok，sig=${sigSource}，keyId=${sigResult.keyId ?? '?'}）`);

    // ⑥ 校验通过后再谈安装
    stage = 'install';
    const go = await showBox({
      type: 'info',
      title: '更新已校验通过',
      message: '已校验通过。安装需要管理员授权（会弹出系统密码框）',
      detail: `版本 v${feed.version}\n安装包：${filePath}\n\n点「立即安装」后由系统弹出密码框；取消则不会安装。`,
      buttons: ['立即安装', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (go.response !== 0) {
      updLog('stage=install 用户取消安装（安装包保留：' + filePath + '）');
      return { ok: true, cancelled: true };
    }

    // ⑦ 安装：**先探测 pkexec**（精简发行版可能没装 polkit）——没有就直接给手动安装指引，
    //    不再 spawn 一个必然 ENOENT 的命令、也不会卡在 spawn 错误里。
    //    有 pkexec 时：`pkexec dpkg -i` 本地文件，不联网，等退出码。
    const pkexecPath = await whichPkexec();
    updLog('stage=install 探测提权工具 which pkexec → ' + (pkexecPath || '未找到'));
    /** @type {{cmd: string, args: string[], fallbackHint: string, manual: boolean}} */
    const plan = installPlan({ filePath, pkexecAvailable: !!pkexecPath });
    if (plan.manual) {
      updLog('stage=install 系统没有 pkexec（polkit 未安装），改为手动安装指引');
      await showUpdateFailure({
        stage: 'install',
        title: '需要手动安装',
        message: '系统未提供 pkexec，无法弹出管理员授权窗口',
        detail:
          '更新包已下载并通过校验：\n' + filePath + '\n\n' +
          '请在终端执行（复制粘贴）：\n' + plan.fallbackHint + '\n\n' +
          '官网下载页：' + updateDownloadPage() + '\n' +
          '镜像下载目录：' + updateDownloadsDir(),
      });
      return { ok: false, stage: 'install', manual: true };
    }
    const exitCode = await new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcess} */
      let child;
      try {
        child = spawn(plan.cmd, plan.args, { stdio: 'ignore' });
      } catch (err) {
        updLog('stage=install spawn 失败：' + errText(err));
        resolve(-1);
        return;
      }
      let settled = false;
      const finish = (/** @type {number | null} */ code) => {
        if (settled) return;
        settled = true;
        resolve(typeof code === 'number' ? code : -1);
      };
      child.on('error', (/** @type {any} */ err) => {
        updLog('stage=install 安装进程错误：' + errText(err));
        finish(-1);
      });
      child.on('close', (code) => finish(code));
    });
    updLog(`stage=install 安装进程退出码 ${exitCode}`);
    if (exitCode === 0) {
      const done = await showBox({
        type: 'info',
        title: '安装完成',
        message: '安装完成，重启后生效',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (done.response === 0) {
        updLog('stage=install 用户选择立即重启');
        quitting = true;
        app.relaunch();
        app.exit(0);
      }
      return { ok: true, installed: true };
    }
    updLog(`stage=install 安装未完成（退出码 ${exitCode}），已给出可复制命令回落`);
    await showUpdateFailure({
      stage: 'install',
      title: '安装未完成',
      message: `安装未完成（退出码 ${exitCode}）`,
      detail:
        '可能取消了管理员授权，或系统未提供 polkit。\n\n' +
        '可复制下面的命令在终端手动安装：\n' +
        `${plan.fallbackHint}\n\n` +
        `安装包位置：${filePath}\n` +
        `也可以到官网重新下载：${updateDownloadPage()}`,
    });
    return { ok: false, stage: 'install', exitCode };
  } catch (err) {
    // 任何未捕获异常（含对话框自身显示失败）都必须留痕 + 明确报错——绝不静默（v0.9.2 根因）。
    updLog(`stage=${stage} 未捕获异常：` + errText(err) + '（endpoint=' + (updateEndpoint?.id ?? '?') + '）');
    try {
      dialog.showErrorBox('更新出错', `更新流程在 ${stage} 阶段出错：${errText(err)}\n\n日志：${desktopLogFile()}`);
    } catch {}
    return { ok: false, stage, error: errText(err) };
  } finally {
    debUpdateInFlight = false;
    restoreUpdateTitle();
    setUpdateProgress(-1);
  }
}

// 菜单「检查更新」：手动触发并弹出结果。
// 审计（点击无响应根因）：此前依赖 autoUpdater 事件回调，任何一步异常
// （electron-updater 导入失败 / 事件不触发 / 网络挂起）都会静默吞掉——用户点击后毫无反馈。
// 修复：全程 try/catch + promise 结果兜底 + 30 秒超时兜底，任何路径必有弹窗；文案含当前版本号。
// v0.9.2：① 对话框按有无窗口分别调用（父窗口 bug 的第二个现场）；② feed 按选中线路 setFeedURL；
//          ③ 失败弹窗统一带「打开日志」。
async function checkUpdatesFromMenu() {
  /** @param {() => Promise<any>} fn */
  const runShow = (fn) => {
    Promise.resolve()
      .then(fn)
      .catch((err) => updLog('stage=confirm 检查更新结果对话框失败：' + String(err?.message || err)));
  };
  if (process.env.MINGDAO_NO_AUTOUPDATE === '1') {
    runShow(() => showBox({ type: 'info', title: '检查更新', message: '自动更新已被环境变量禁用（MINGDAO_NO_AUTOUPDATE=1）' }));
    return;
  }
  let done = false;
  /** @param {() => Promise<any>} fn */
  const finish = (fn) => { if (!done) { done = true; runShow(fn); } };
  const ver = app.getVersion();
  const LINUX_NO_APPIMAGE = process.platform === 'linux' && !process.env.APPIMAGE; // deb 安装形态
  if (LINUX_NO_APPIMAGE) {
    // v0.8.3：deb 安装形态不再"只引导去官网"——走独立 deb 更新通道
    // （feed → 版本比较 → 下载 → sha512 + 来源签名双校验 → pkexec dpkg -i）。
    await runDebUpdateFlow({ fromMenu: true });
    return;
  }
  try {
    // 线路选择：选中的 base 同时作用于 electron-updater 的 feed（AppImage/NSIS/dmg 的 sha512 校验
    // 按 feed 内容判定，换 base 不影响校验——同一批产物在两个源上字节一致）。
    const endpoint = await ensureUpdateEndpoint();
    // 审计（"Cannot read properties of undefined (reading 'once')"）：
    // 打包环境里 ESM 动态导入 CJS 的 electron-updater 时命名导出可能缺失，
    // 多级兜底解析，并显式校验 API 存在——任何失败都有可见弹窗。
    const updMod = await import('electron-updater');
    const autoUpdater = updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod;
    if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function' || typeof autoUpdater.once !== 'function') {
      throw new Error('electron-updater 模块导出不可用（打包环境加载异常）');
    }
    const feedUrl = updatesBase(endpoint.base);
    try {
      if (typeof autoUpdater.setFeedURL === 'function') autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
      updLog('stage=feed electron-updater feed=' + feedUrl + ' endpoint=' + endpoint.id);
    } catch (err) {
      updLog('stage=feed setFeedURL 失败（沿用打包内置 feed）：' + String(err?.message || err));
    }
    const timer = setTimeout(() => {
      updLog('stage=feed 检查超时（30 秒无响应）');
      finish(() => showUpdateFailure({ stage: 'feed', title: '检查更新', message: '检查超时（30 秒无响应）', detail: '可能网络不通或官网暂不可达；请稍后重试，或到官网下载最新安装包：' + updateDownloadPage() }));
    }, 30000);
    autoUpdater.once('error', (err) => {
      clearTimeout(timer);
      updLog('stage=feed updater error ' + String(err?.message || err));
      finish(() => showUpdateFailure({ stage: 'feed', title: '检查更新', message: '检查失败：' + String(err?.message || err), detail: '请检查网络后重试；或到官网下载最新安装包：' + updateDownloadPage() }));
    });
    autoUpdater.once('update-not-available', () => {
      clearTimeout(timer);
      updLog('stage=confirm 已是最新（v' + ver + '）');
      finish(() => showBox({ type: 'info', title: '检查更新', message: `当前版本：v${ver}，已是最新版本` }));
    });
    autoUpdater.once('update-available', (info) => {
      clearTimeout(timer);
      // 质检：info 可能为 undefined（打包环境事件参数形状差异），版本号做多层兜底
      const v = info?.version ?? '';
      updLog('stage=confirm 发现新版本 v' + v + '（endpoint=' + endpoint.id + '，开始自动下载）');
      finish(() => showBox({ type: 'info', title: '检查更新', message: '发现新版本 v' + v + '，开始自动下载…', detail: '下载完成后会提示重启安装。' }));
    });
    const result = await autoUpdater.checkForUpdates();
    // promise 直接返回但事件未触发时按结果兜底（避免任何静默路径）
    if (!done) {
      clearTimeout(timer);
      const latest = result?.updateInfo?.version;
      if (!latest || latest === ver) {
        finish(() => showBox({ type: 'info', title: '检查更新', message: `当前版本：v${ver}，已是最新版本` }));
      } else {
        finish(() => showBox({ type: 'info', title: '检查更新', message: '发现新版本 v' + latest + '，开始自动下载…', detail: '下载完成后会提示重启安装。' }));
      }
    }
  } catch (err) {
    const msg = String(err?.message || err);
    updLog('stage=feed 手动检查更新异常：' + msg);
    if (/progress|already|running/i.test(msg)) {
      // 启动时的自动检查尚未结束：给出可见反馈而非报错
      finish(() => showBox({ type: 'info', title: '检查更新', message: '正在检查更新，请稍候…', detail: '启动时的自动检查尚未结束，结果会随后提示。' }));
    } else {
      finish(() => showUpdateFailure({ stage: 'feed', title: '检查更新', message: '检查失败：' + msg, detail: '请检查网络后重试；或到官网下载最新安装包：' + updateDownloadPage() }));
    }
  }
}

/**
 * 「下载完成 → 安装」之间的**来源校验**（审计 K-8 的收口点）。
 *
 * 为什么不能让 electron-updater 的 sha512 顶这一关：sha512 来自**同一份 feed**的 latest*.yml，
 * 控制 feed 的一方可以同时换掉包与清单里的 sha512，校验照样通过（探针 /tmp/probe-update-feed.mjs
 * 用本文件的真实代码复现过：投毒 feed → 下载 → sha512 MATCH → quitAndInstall）。
 *
 * 判据与文案都在 desktop/update-verify.js（纯函数，test/smoke.js §135 逐条钉边界）：
 *   有签名 + 验签通过 → install；有签名 + 验不过 → **一律 reject**；
 *   无签名 → 默认 warn-and-install（如实提示"未验证来源签名"），
 *   设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 时改为 reject。
 *
 * 诚实边界：feed 被控制时攻击者可以**删掉签名**，把这次更新降级成"无签名"——本函数无法区分
 * "发布链路本来没签"与"签名被剥离"（当前发布链路确实还没有签名步骤）。所以默认档是放行+明示，
 * fail-closed 开关交给发行方/高安全用户。详见 docs/CODE-SIGNING.md §五。
 */
async function verifyDownloadedUpdate(info) {
  const filePath = String(info?.downloadedFile ?? '');
  const files = Array.isArray(info?.files) ? info.files : [];
  const hasKey = (o) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, 'signature');
  const declaredSignature = hasKey(info) || files.some(hasKey);
  const inlineSignature = typeof info?.signature === 'string' ? info.signature : typeof files[0]?.signature === 'string' ? files[0].signature : '';
  let sig = { signatureB64: '', source: '无', reason: '没有可用的签名载体' };
  try {
    sig = await collectUpdateSignature({ filePath, inlineSignature, declaredSignature });
  } catch (err) {
    sig = { signatureB64: '', source: '无', reason: '取签名失败：' + String(err?.message || err) };
  }
  // v0.7.1（审计报告2 H-02）：这里**必须用密钥环**，而不是单钥 resolveUpdatePublicKeyPem()——
  // 后者默认返回 legacy 公钥，而发布链路签的是环里的 current 私钥；单钥会让所有合法更新被误拒。
  return evaluateUpdate({
    filePath,
    signatureB64: sig.signatureB64,
    declaredSignature,
    keys: UPDATE_PUBLIC_KEYS,
    requireSignature: requireSignatureFromEnv(),
    source: sig.source,
    version: String(info?.version ?? app.getVersion()),
  });
}

// 自动更新（仅打包版；官网 generic feed 发布产物时生效）
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.MINGDAO_NO_AUTOUPDATE === '1') return;
  import('electron-updater')
    .then(async (updMod) => {
      const autoUpdater = updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod;
      if (!autoUpdater || typeof autoUpdater.on !== 'function') {
        appLog('updater 模块导出不可用，跳过自动更新');
        return;
      }
      const LINUX_NO_APPIMAGE = process.platform === 'linux' && !process.env.APPIMAGE; // deb 安装形态
      autoUpdater.autoDownload = !LINUX_NO_APPIMAGE;
      // v0.9.2：feed 按**选中线路**显式设定（深圳镜像也提供 /updates/*；AppImage 的 sha512 校验
      // 按 feed 内容判定，换 base 不影响——同一批产物在两个源上字节一致）。不能等打包内置的
      // app-update.yml（写死香港）生效，否则"按地区自动选线路"在 AppImage/NSIS/dmg 上落不了地。
      const endpoint = await ensureUpdateEndpoint();
      const feedUrl = updatesBase(endpoint.base);
      try {
        if (typeof autoUpdater.setFeedURL === 'function') autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
      } catch (err) {
        updLog('stage=feed setFeedURL 失败（沿用打包内置 feed）：' + String(err?.message || err));
      }
      const current = (UPDATE_PUBLIC_KEYS || []).find((k) => k.role === 'current') || UPDATE_PUBLIC_KEYS?.[0];
      updLog(
        '自动更新检查启动（feed: ' + feedUrl + ' endpoint=' + endpoint.id + ' probe=' + (endpoint.ms == null ? '-' : Math.round(Number(endpoint.ms)) + 'ms') +
          (LINUX_NO_APPIMAGE ? '，deb 形态：走独立 deb 更新通道（不自动下载）' : '') +
          '；来源签名：' +
          (requireSignatureFromEnv() ? '必须验签（MINGDAO_REQUIRE_UPDATE_SIGNATURE=1）' : '默认档（无签名时警告后安装）') +
          '，密钥环 ' + (UPDATE_PUBLIC_KEYS?.length ?? 0) + ' 把（current keyId=' + (current ? keyIdOf(current.pem) ?? '?' : '?') + '）'
      );
      let updateSeen = false;
      let downloaded = false;
      let downloadRetries = 0;
      autoUpdater.on('error', async (err) => {
        const msg = String(err?.message || err);
        updLog('stage=download updater error ' + msg);
        if (!updateSeen) return;
        // 瞬时网络错误（切网/VPN/代理抖动，如 net::ERR_NETWORK_CHANGED）：自动重试下载
        // 最多 2 次、间隔 5s——多数情况重试即恢复，不用打扰用户；重试失败再弹窗。
        const netErr = /ERR_NETWORK|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EPIPE|ECONNREFUSED/i.test(msg);
        if (!downloaded && netErr && downloadRetries < 2) {
          downloadRetries += 1;
          updLog(`updater 网络错误，5s 后自动重试下载（${downloadRetries}/2）`);
          setTimeout(() => autoUpdater.downloadUpdate().catch(() => {}), 5000);
          return;
        }
        // Linux AppImage 替换旧文件失败（ENOENT：旧文件被移动/删除）→ 针对性指引
        const hint =
          process.platform === 'linux' && /ENOENT/i.test(msg)
            ? '（旧的 AppImage 文件可能已被移动或删除——请到官网手动下载安装一次，之后可恢复自动更新）'
            : '可稍后重试，或到官网手动下载：' + updateDownloadPage();
        try {
          await showUpdateFailure({ stage: 'download', title: '更新下载失败', message: '新版本下载失败：' + msg, detail: hint });
        } catch (e) {
          updLog('stage=download 失败提示弹窗不可用：' + String(e?.message || e));
        }
      });
      autoUpdater.on('update-not-available', (info) => appLog('updater 已是最新 ' + String(info?.version ?? app.getVersion())));
      // 质检（Linux 更新下载失败根因）：info 在该打包环境为 undefined——旧代码 info.version
      // 在此抛 TypeError，中断 autoUpdater 事件派发导致下载永不开始。null-safe + 不抛错。
      autoUpdater.on('update-available', (info) => {
        updateSeen = true;
        const v = String(info?.version ?? '?');
        appLog('updater 发现新版本 ' + v);
        if (LINUX_NO_APPIMAGE) {
          // v0.8.3：deb 安装形态改走独立更新通道（deb feed → 下载 → sha512+签名双校验 → pkexec dpkg -i）。
          // 不再"仅弹去官网"；autoDownload 仍为 false，electron-updater 这一步只负责发现新版本号。
          void runDebUpdateFlow({ fromMenu: false });
          return;
        }
        appLog('开始自动下载（autoDownload=true）');
      });
      autoUpdater.on('download-progress', (p) => updLog('stage=download updater 进度 ' + Math.round(Number(p?.percent) || 0) + '%'));
      autoUpdater.on('update-downloaded', async (info) => {
        downloaded = true;
        const v = String(info?.version ?? app.getVersion());
        updLog('stage=download updater 下载完成 ' + v);
        // —— 来源签名门禁（审计 K-8）：下载完成 → 安装之间必须过这一关 ——
        const gate = await verifyDownloadedUpdate(info);
        updLog('stage=verify ' + gate.logLine);
        if (gate.allowInstall === false) {
          // 拒绝就要**彻底**拒绝：autoInstallOnAppQuit 默认为 true，不关掉的话退出应用时
          // electron-updater 照样会把这个已被拒的包装上——"拒绝"必须覆盖"退出时安装"这条路径。
          autoUpdater.autoInstallOnAppQuit = false;
          updLog('已关闭 autoInstallOnAppQuit：被拒绝的更新不得在退出时安装');
          updLog('更新包来源不可信，已拒绝；请从官网手动下载：' + updateDownloadPage());
          /** @type {any} */
          const notice = { ...gate.notice };
          // 失败弹窗统一附日志路径（按钮由 update-verify.js 单源产出，不改文案结构）
          notice.detail = String(notice.detail || '') + '\n\n日志：' + desktopLogFile();
          showBox(notice).catch((err) => updLog('stage=verify 拒绝提示弹窗失败：' + String(err?.message || err)));
          return;
        }
        // 官网下载统计信标：下载完成上报一次（按次精确计数，不受 Range 分片影响）。
        // 仅打包版上报；fire-and-forget，失败不影响更新流程。
        //
        // 审计 BUG-083：这里上报 {os, ver}（**不含任何用户标识**），但此前既没有隐私说明、
        // 也没有退出开关。现在两样都补上：① 显式退出（环境变量或 config.telemetry=false）；
        // ② README「隐私」一节点明上报内容、目的与关闭方式。默认仍上报——它是官网
        //    "桌面自动更新次数"的唯一数据源，关掉就等于该指标永远为 0。
        if (app.isPackaged && !telemetryDisabled()) {
          fetch('https://harness.mingdao.ai/updok', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'update', os: process.platform, ver: v }),
          }).catch(() => {});
        }
        // 更新就绪提示：文案由 desktop/update-verify.js 的 buildUpdateNotice 单源产出
        // （三态 = 验签通过 / 未验证来源签名 / 拒绝安装，避免"同一结论两处措辞"）
        showBox(gate.notice)
          .then((r) => {
            if (r.response !== 0) return;
            // Linux AppImage：安装前确认当前文件仍在（用户可能已手动移动/删除 → 历史 ENOENT 事故）
            if (process.platform === 'linux' && process.env.APPIMAGE && !fs.existsSync(process.env.APPIMAGE)) {
              showUpdateFailure({
                stage: 'install',
                title: '无法自动安装更新',
                message: '当前 AppImage 文件已不存在（可能被移动或删除），无法原地替换安装。',
                detail: '请到官网下载安装一次（建议保存到固定位置，如 ~/Applications/mingdao.AppImage），之后自动更新即可恢复。\n' + updateDownloadPage(),
              }).catch((err) => updLog('stage=install AppImage 缺失提示弹窗失败：' + String(err?.message || err)));
              return;
            }
            // v0.7.2（用户实测）：macOS 上 quitAndInstall 偶发"无法自动关闭，需手动退出后才能安装"。
            // 根因是两条并存：① autoInstallOnAppQuit 若曾因"拒绝更新"被置 false，quitAndInstall 会直接
            //   调 install() 而不 app.quit() → 运行中的 .app 无法被替换；② 托盘 close 处理器会把窗口
            //   hide 而非 close（quitting 未置位时）。这里在放行分支显式置位两处，再 quitAndInstall，
            //   保证"重启安装"一定先真正退出应用。
            autoUpdater.autoInstallOnAppQuit = true;
            quitting = true;
            updLog('stage=install 用户确认安装更新，退出并安装（' + v + '）');
            autoUpdater.quitAndInstall();
          })
          .catch((err) => updLog('stage=install 更新就绪弹窗失败：' + String(err?.message || err)));
      });
      autoUpdater.checkForUpdates().catch((err) => updLog('stage=feed updater check error ' + String(err?.message || err)));
    })
    .catch((err) => appLog('updater 初始化失败 ' + String(err?.message || err)));
}

// 冒烟自检（CI/无窗口环境）：MINGDAO_DESKTOP_SMOKE=1 时模块求值完成后直接退出，不创建窗口。
// 历史教训：0.2.2 三平台启动即崩（createLogWriter 漏导入），打包期不报错、运行期才炸——此自检专门拦截该类问题。
if (process.env.MINGDAO_DESKTOP_SMOKE === '1') {
  app.whenReady().then(() => { console.log('MINGDAO_DESKTOP_SMOKE_OK'); app.exit(0); });
} else if (!app.requestSingleInstanceLock()) {
  // 单实例：二次启动聚焦已有窗口
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  // macOS 退出修复（2026-09-01）：Cmd+Q / 菜单「退出」走 role:'quit' → app.quit()，此前 quitting
  // 从未置位，窗口 close 处理器 preventDefault+hide 把退出吞成「隐藏到托盘」——进程常驻退不出。
  // before-quit 在 app.quit() 触发（含 Cmd+Q 与菜单 role:'quit'）前统一置位，close 不再拦截。
  app.on('before-quit', () => {
    quitting = true;
  });
  app.whenReady().then(() => {
    buildMenu();
    buildTray();
    createWindow().then(() => setupAutoUpdate());
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
  // macOS 关闭全部窗口不退出（托盘/菜单退出）；其他平台托盘常驻
  app.on('window-all-closed', () => {
    // 交给托盘：不退出
  });
}
