// 明道 MingDao 桌面版（Electron 薄壳）：
//  - 主进程内启动 MingDao WebUI（复用 src/web/server.js，零子进程零端口暴露）
//  - 127.0.0.1 随机端口 + 一次性访问令牌，窗口只加载本机地址
//  - 外链一律交系统浏览器打开；单实例锁；打包后 src/ 经 extraResources 随应用分发
import { app, BrowserWindow, shell, dialog } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 开发态：desktop/ 的上一级即仓库根；打包态：src/ 在 process.resourcesPath 下
const srcRoot = app.isPackaged ? path.join(process.resourcesPath, 'src') : path.join(__dirname, '..', 'src');

/** 启动内置 WebUI，返回 { port, token }；配置缺失时提示后退出 */
async function startServer() {
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(srcRoot, 'web', 'server.js')).href);
  } catch (err) {
    dialog.showErrorBox('明道 MingDao', `无法加载内置服务：${err?.message || err}`);
    app.quit();
    return null;
  }
  const { loadConfig } = await import(pathToFileURL(path.join(srcRoot, 'config.js')).href);
  const cfg = loadConfig();
  if (!cfg) {
    dialog.showErrorBox(
      '明道 MingDao',
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
    dialog.showErrorBox('明道 MingDao', `WebUI 启动失败：${err?.message || err}`);
    app.quit();
    return null;
  }
  return { port, token: authToken };
}

async function createWindow() {
  const info = await startServer();
  if (!info) return;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    title: '明道 MingDao',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
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

// 单实例：二次启动聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
