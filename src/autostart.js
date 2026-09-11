// 开机自启：随登录自动启动 MingDao WebUI 服务器（跨平台、零依赖）。
//  - Linux：~/.config/autostart/mingdao-web.desktop（XDG Autostart）
//  - Windows：启动文件夹 .bat
//  - macOS：~/Library/LaunchAgents/org.mingdao.web.plist
// 命令：mingdao autostart on|off|status（WebUI 设置面板同款开关）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// v0.4.6 P2 修复：自启命令必须用**绝对路径**。
// 三个平台原先都只写命令名（`mingdao web 3820`）。在 macOS 上这是必然失败：launchd 给 agent 的
// 是一个极简环境（PATH=/usr/bin:/bin:/usr/sbin:/sbin，不读登录 shell 配置），而 mingdao 常装在
// /usr/local/bin、~/.local/bin 或 nvm 目录 —— 实测 `env -i PATH=… command -v mingdao` 找不到，
// 登录后只会把 "command not found" 写进 StandardErrorPath，WebUI 静默不自启。
// 现用 process.execPath（node 绝对路径）+ src/cli.js 绝对路径，彻底不依赖 PATH。
function cliEntry() {
  try {
    return fileURLToPath(new URL('./cli.js', import.meta.url));
  } catch {
    return path.join(process.cwd(), 'src', 'cli.js');
  }
}
function nodeBin() {
  return process.execPath || 'node';
}

function linuxFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'mingdao-web.desktop');
}

function windowsFile() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'mingdao-autostart.bat');
}

function macFile() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'org.mingdao.web.plist');
}

export function autostartPath() {
  if (process.platform === 'win32') return windowsFile();
  if (process.platform === 'darwin') return macFile();
  return linuxFile();
}

export function autostartStatus() {
  return fs.existsSync(autostartPath());
}

export function enableAutostart() {
  const target = autostartPath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const node = nodeBin();
    const cli = cliEntry();
    if (process.platform === 'win32') {
      fs.writeFileSync(target, `@echo off\r\nstart "" "${node}" "${cli}" web 3820\r\n`);
    } else if (process.platform === 'darwin') {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.mingdao.web</string>
  <key>ProgramArguments</key><array>
    <string>${node}</string><string>${cli}</string><string>web</string><string>3820</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>/tmp/mingdao-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/mingdao-web.err</string>
</dict></plist>
`;
      fs.writeFileSync(target, plist);
      // 立即注册（否则要等下次登录才生效，用户以为开关没起作用）。失败不致命：
      // 文件已落盘，下次登录仍会由 RunAtLoad 拉起。
      try {
        spawnSync('launchctl', ['bootstrap', `gui/${process.getuid?.() ?? 0}`, target], { stdio: 'ignore' });
      } catch {}
    } else {
      fs.writeFileSync(
        target,
        `[Desktop Entry]\nType=Application\nName=MingDao 自动启动\nComment=MingDao-Harness WebUI 服务器（登录时启动）\nExec="${node}" "${cli}" web 3820\nX-GNOME-Autostart-enabled=true\nHidden=false\n`
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function disableAutostart() {
  try {
    if (process.platform === 'darwin') {
      // 已 bootstrap 的 agent 必须 bootout 才真正停用（仅删 plist 不影响本次会话）
      try {
        spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/org.mingdao.web`], { stdio: 'ignore' });
      } catch {}
    }
    if (fs.existsSync(autostartPath())) fs.unlinkSync(autostartPath());
    return true;
  } catch {
    return false;
  }
}
