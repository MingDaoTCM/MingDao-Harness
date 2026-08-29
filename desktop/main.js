// MingDao Harness 桌面版（Electron 薄壳）：
//  - 主进程内启动 MingDao WebUI（复用 src/web/server.js，零子进程零端口暴露）
//  - 127.0.0.1 随机端口 + 一次性访问令牌，窗口只加载本机地址
//  - 系统托盘（关闭最小化到托盘）、应用菜单、窗口大小/位置记忆、单实例锁
//  - 权限收紧（摄像头/通知/插件等一律拒绝）、外链交系统浏览器
//  - 打包版自动检查更新（electron-updater，GitHub Releases）
import { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
function appLog(msg) {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'mingdao.log');
    let prev = '';
    try {
      prev = fs.readFileSync(f, 'utf8');
    } catch {}
    if (prev.length > 1024 * 1024) prev = prev.slice(-512 * 1024);
    fs.writeFileSync(f, prev + new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
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
      await mod.runWebServer({ host: '127.0.0.1', port, authToken });
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  mainWindow = win;
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
  win.webContents.on('did-fail-load', (_e, code, _desc, url) => {
    appLog('did-fail-load code=' + code + ' ' + url);
    if (code !== -3 && String(url || '').startsWith('http://127.0.0.1:')) win.webContents.reload();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    appLog('render-process-gone ' + JSON.stringify(details || {}));
    if (!quitting) win.webContents.reload();
  });
  // 只允许本机地址在窗口内导航；其余链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

// 菜单「检查更新」：手动触发并弹出结果。
// 审计（点击无响应根因）：此前依赖 autoUpdater 事件回调，任何一步异常
// （electron-updater 导入失败 / 事件不触发 / 网络挂起）都会静默吞掉——用户点击后毫无反馈。
// 修复：全程 try/catch + promise 结果兜底 + 30 秒超时兜底，任何路径必有弹窗；文案含当前版本号。
async function checkUpdatesFromMenu() {
  const show = (opts) => dialog.showMessageBox(mainWindow ?? undefined, opts).catch(() => {});
  if (process.env.MINGDAO_NO_AUTOUPDATE === '1') {
    show({ type: 'info', title: '检查更新', message: '自动更新已被环境变量禁用（MINGDAO_NO_AUTOUPDATE=1）' });
    return;
  }
  let done = false;
  const finish = (fn) => { if (!done) { done = true; fn(); } };
  const ver = app.getVersion();
  try {
    // 审计（"Cannot read properties of undefined (reading 'once')"）：
    // 打包环境里 ESM 动态导入 CJS 的 electron-updater 时命名导出可能缺失，
    // 多级兜底解析，并显式校验 API 存在——任何失败都有可见弹窗。
    const updMod = await import('electron-updater');
    const autoUpdater = updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod;
    if (!autoUpdater || typeof autoUpdater.checkForUpdates !== 'function' || typeof autoUpdater.once !== 'function') {
      throw new Error('electron-updater 模块导出不可用（打包环境加载异常）');
    }
    const timer = setTimeout(() => {
      finish(() => show({ type: 'warning', title: '检查更新', message: '检查超时（30 秒无响应）', detail: '可能网络不通或官网暂不可达；请稍后重试，或到官网下载最新安装包。' }));
    }, 30000);
    autoUpdater.once('error', (err) => {
      clearTimeout(timer);
      appLog('updater error ' + String(err?.message || err));
      finish(() => show({ type: 'warning', title: '检查更新', message: '检查失败：' + String(err?.message || err), detail: '请检查网络后重试；或到官网下载最新安装包。' }));
    });
    autoUpdater.once('update-not-available', () => {
      clearTimeout(timer);
      finish(() => show({ type: 'info', title: '检查更新', message: `当前版本：v${ver}，已是最新版本` }));
    });
    autoUpdater.once('update-available', (info) => {
      clearTimeout(timer);
      // 质检：info 可能为 undefined（打包环境事件参数形状差异），版本号做多层兜底
      const v = info?.version ?? '';
      finish(() => show({ type: 'info', title: '检查更新', message: '发现新版本 v' + v + '，开始自动下载…', detail: '下载完成后会提示重启安装。' }));
    });
    const result = await autoUpdater.checkForUpdates();
    // promise 直接返回但事件未触发时按结果兜底（避免任何静默路径）
    if (!done) {
      clearTimeout(timer);
      const latest = result?.updateInfo?.version;
      if (!latest || latest === ver) {
        finish(() => show({ type: 'info', title: '检查更新', message: `当前版本：v${ver}，已是最新版本` }));
      } else {
        finish(() => show({ type: 'info', title: '检查更新', message: '发现新版本 v' + latest + '，开始自动下载…', detail: '下载完成后会提示重启安装。' }));
      }
    }
  } catch (err) {
    appLog('updater check error ' + String(err?.message || err));
    const msg = String(err?.message || err);
    if (/progress|already|running/i.test(msg)) {
      // 启动时的自动检查尚未结束：给出可见反馈而非报错
      finish(() => show({ type: 'info', title: '检查更新', message: '正在检查更新，请稍候…', detail: '启动时的自动检查尚未结束，结果会随后提示。' }));
    } else {
      finish(() => show({ type: 'warning', title: '检查更新', message: '检查失败：' + msg, detail: '请检查网络后重试；或到官网下载最新安装包。' }));
    }
  }
}

// 自动更新（仅打包版；官网 generic feed 发布产物时生效）
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.MINGDAO_NO_AUTOUPDATE === '1') return;
  import('electron-updater')
    .then((updMod) => {
      const autoUpdater = updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod;
      if (!autoUpdater || typeof autoUpdater.on !== 'function') {
        appLog('updater 模块导出不可用，跳过自动更新');
        return;
      }
      autoUpdater.autoDownload = true;
      appLog('自动更新检查启动（feed: 官网 /updates）');
      let updateSeen = false;
      autoUpdater.on('error', (err) => {
        appLog('updater error ' + String(err?.message || err));
        // 质检（下载失败不可见）：发现新版本之后发生的错误直接弹窗告知，并引导官网手动下载
        if (updateSeen) {
          dialog
            .showMessageBox({
              type: 'warning',
              title: '更新下载失败',
              message: '新版本下载失败：' + String(err?.message || err),
              detail: '可稍后重试，或到官网手动下载：https://harness.mingdao.ai/#downloads',
              buttons: ['知道了'],
              noLink: true,
            })
            .catch(() => {});
        }
      });
      autoUpdater.on('update-not-available', (info) => appLog('updater 已是最新 ' + String(info?.version ?? app.getVersion())));
      // 质检（Linux 更新下载失败根因）：info 在该打包环境为 undefined——旧代码 info.version
      // 在此抛 TypeError，中断 autoUpdater 事件派发导致下载永不开始。null-safe + 不抛错。
      autoUpdater.on('update-available', (info) => {
        updateSeen = true;
        appLog('updater 发现新版本 ' + String(info?.version ?? '?'));
        appLog('开始自动下载（autoDownload=true）');
      });
      autoUpdater.on('download-progress', (p) => appLog('updater 下载进度 ' + Math.round(Number(p?.percent) || 0) + '%'));
      autoUpdater.on('update-downloaded', (info) => {
        const v = String(info?.version ?? app.getVersion());
        appLog('updater 下载完成 ' + v);
        // 友好的更新就绪提示（用户反馈：此前界面像报错——改为明确的正向语气）
        dialog
          .showMessageBox({
            type: 'info',
            title: '更新已就绪',
            message: `MingDao Harness v${v} 下载完成，重启应用即可完成更新`,
            detail: '更新不会改动你的配置与会话。更新内容见官网：https://harness.mingdao.ai',
            buttons: ['立即重启安装', '稍后'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .then((r) => {
            if (r.response === 0) autoUpdater.quitAndInstall();
          })
          .catch(() => {});
      });
      autoUpdater.checkForUpdates().catch((err) => appLog('updater check error ' + String(err?.message || err)));
    })
    .catch(() => {});
}

// 单实例：二次启动聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
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
