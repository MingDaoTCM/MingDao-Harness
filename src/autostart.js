// 开机自启：随登录自动启动 MingDao WebUI 服务器（跨平台、零依赖）。
//  - Linux：~/.config/autostart/mingdao-web.desktop（XDG Autostart）
//  - Windows：启动文件夹 .bat
//  - macOS：~/Library/LaunchAgents/org.mingdao.web.plist
// 命令：mingdao autostart on|off|status（WebUI 设置面板同款开关）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (process.platform === 'win32') {
      fs.writeFileSync(target, '@echo off\r\nstart "" cmd /c "mingdao web 3820"\r\n');
    } else if (process.platform === 'darwin') {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>org.mingdao.web</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string><string>mingdao web 3820</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/mingdao-web.log</string>
  <key>StandardErrorPath</key><string>/tmp/mingdao-web.err</string>
</dict></plist>
`;
      fs.writeFileSync(target, plist);
    } else {
      fs.writeFileSync(
        target,
        '[Desktop Entry]\nType=Application\nName=MingDao 自动启动\nComment=MingDao-Harness WebUI 服务器（登录时启动）\nExec=sh -c \'mingdao web 3820 >/dev/null 2>&1\'\nX-GNOME-Autostart-enabled=true\nHidden=false\n'
      );
    }
    return true;
  } catch {
    return false;
  }
}

export function disableAutostart() {
  try {
    if (fs.existsSync(autostartPath())) fs.unlinkSync(autostartPath());
    return true;
  } catch {
    return false;
  }
}
