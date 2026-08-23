// 桌面通知（零依赖）：后台任务完成/失败时弹出系统通知。
//  - Linux：notify-send（GNOME/KDE 等桌面环境自带）
//  - macOS：osascript display notification
//  - Windows：PowerShell WScript.Shell Popup（10 秒自动消失）
//  config.notify 可关闭（默认开启）；通知失败静默忽略，绝不影响任务流程。

import { spawn } from 'node:child_process';

export function notify(title, message) {
  try {
    const text = String(message).replace(/\s+/g, ' ').slice(0, 120);
    // 审计 P2-12：title 同样转义（mac 反斜杠/引号、win 单引号），防注入破坏命令
    const t = String(title).replace(/\s+/g, ' ').slice(0, 40);
    if (process.platform === 'linux') {
      const child = spawn('notify-send', [t, text], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } else if (process.platform === 'darwin') {
      const safe = text.replace(/[\\"]/g, '\\$&');
      const safeT = t.replace(/[\\"]/g, '\\$&');
      const child = spawn('osascript', ['-e', `display notification "${safe}" with title "${safeT}"`], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    } else if (process.platform === 'win32') {
      const safe = text.replace(/'/g, "''");
      const safeT = t.replace(/'/g, "''");
      const child = spawn('powershell', ['-NoProfile', '-Command', `(New-Object -ComObject Wscript.Shell).Popup('${safe}', 10, '${safeT}', 64)`], { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
  } catch {
    // 通知失败静默忽略
  }
}

export function notifyTaskDone(question, status) {
  notify('MingDao', `${status === 'done' ? '✓ 完成' : '✖ 失败'}：${String(question).slice(0, 60)}`);
}
