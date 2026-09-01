// 命令族：mingdao desktop —— 任意目录启动 Electron 桌面版
// 定位仓库 → 检查 desktop/node_modules 里的 electron → 拉起；缺依赖给出镜像安装指引。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot } from '../update.js';

export async function handleDesktop(/** @type {any} */ args) {
  const repo = findRepoRoot();
  if (!repo) {
    console.log('mingdao desktop 需要「仓库安装形态」（npm 全局安装不含桌面壳）。');
    console.log('  方案一（推荐）：下载三平台安装包（GitHub Releases 或 CI 产物，带自动更新）；');
    console.log('  方案二：git clone 任一平台仓库后，在仓库目录运行 mingdao desktop。');
    console.log('  克隆地址：https://gitee.com/MingDaoTCM/MingDao-harness · https://gitcode.com/MingDaoTCM/MingDao-Harness');
    process.exitCode = 1;
    return true;
  }
  const desktopDir = path.join(repo, 'desktop');
  if (!fs.existsSync(path.join(desktopDir, 'main.js'))) {
    console.log('[错误] 仓库缺少 desktop/ 目录（版本过旧？先运行 mingdao update）。');
    process.exitCode = 1;
    return true;
  }
  const isWin = process.platform === 'win32';
  const localBin = path.join(desktopDir, 'node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  if (!fs.existsSync(localBin)) {
    console.log('[提示] 首次运行需要安装 Electron（约 120MB，仅桌面版构建依赖，运行时仍零依赖）：');
    console.log(`  cd "${desktopDir}"`);
    console.log('  npm install');
    console.log('  国内网络先执行：export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/（Windows 用 set）');
    process.exitCode = 1;
    return true;
  }
  console.log('正在启动 MingDao Harness 桌面版…（窗口弹出即成功；托盘常驻，关闭窗口 = 最小化到托盘）');
  const child = spawn(localBin, [desktopDir], { cwd: desktopDir, stdio: 'ignore', detached: true });
  child.on('error', (err) => {
    console.log('[错误] 启动 Electron 失败：' + (err?.message || err));
    process.exitCode = 1;
  });
  child.unref(); // CLI 退出后应用继续运行
  return true;
}
