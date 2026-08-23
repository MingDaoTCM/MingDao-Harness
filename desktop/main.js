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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 开发态：desktop/ 的上一级即仓库根；打包态：src/ 在 process.resourcesPath 下
const srcRoot = app.isPackaged ? path.join(process.resourcesPath, 'src') : path.join(__dirname, '..', 'src');
const buildRoot = path.join(__dirname, 'build');
const isDev = !app.isPackaged;

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
  const { loadConfig } = await import(pathToFileURL(path.join(srcRoot, 'config.js')).href);
  const cfg = loadConfig();
  if (!cfg) {
    dialog.showErrorBox(
      'MingDao Harness',
      '尚未初始化配置。\n\n请先在终端运行：mingdao init\n（或 mingdao key set deepseek 设置 API Key）后重新打开桌面版。'
    );
    app.quit();
    return null;
  }
  const port = 40000 + Math.floor(Math.random() * 20000);
  const authToken = crypto.randomBytes(16).toString('hex');
  try {
    await mod.runWebServer({ host: '127.0.0.1', port, authToken });
  } catch (err) {
    dialog.showErrorBox('MingDao Harness', `WebUI 启动失败：${err?.message || err}`);
    app.quit();
    return null;
  }
  return { port, token: authToken };
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
        { label: '文档（Gitee）', click: () => shell.openExternal('https://gitee.com/MingDaoTCM/MingDao-harness') },
        { label: '关于 MingDao Harness', click: () => dialog.showMessageBox({ title: '关于', message: 'MingDao Harness 桌面版', detail: `版本 v${app.getVersion()}\n零依赖 DeepSeek-V4 智能体框架\nhttps://harness.mingdao.ai` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function trayIcon() {
  const file = path.join(buildRoot, 'tray.png');
  if (!fs.existsSync(file)) return null;
  return nativeImage.createFromPath(file);
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
    icon: path.join(buildRoot, 'icon.png'),
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

  win.loadURL(`http://127.0.0.1:${info.port}/?token=${info.token}`);
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

// 自动更新（仅打包版；GitHub Releases 发布产物时生效）
function setupAutoUpdate() {
  if (!app.isPackaged || process.env.MINGDAO_NO_AUTOUPDATE === '1') return;
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-downloaded', (info) => {
        dialog
          .showMessageBox({
            type: 'info',
            title: '发现新版本',
            message: `MingDao Harness v${info.version} 已下载完成`,
            detail: '重启应用即可完成更新。',
            buttons: ['立即重启', '稍后'],
          })
          .then((r) => {
            if (r.response === 0) autoUpdater.quitAndInstall();
          });
      });
      autoUpdater.checkForUpdates().catch(() => {});
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
