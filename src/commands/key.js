// 命令族：mingdao key（自 cli.js 拆出，评估 P0-1 拆包）
import fs from 'node:fs';
import { createIO, style, C } from '../ui.js';
import { ensureHome } from '../config.js';
import { setStoredKey, removeStoredKey, credentialsPath, loadCredentials, maskKey } from '../credentials.js';
import { PROVIDERS } from '../models.js';

export async function handleKey(/** @type {any} */ cmd, /** @type {any} */ args) {
  const io = createIO();
  try {
    const sub = args[0] || 'status';
    const target = args[1];
    if (sub === 'status') {
      ensureHome();
      io.print(style(`本地凭证库：${credentialsPath()}`, C.bold));
      const creds = loadCredentials();
      const names = Object.keys(creds);
      if (!names.length) io.print('  (空)');
      for (const n of names) {
        io.print(style(`  ${n}: ${maskKey(creds[n])}`, C.dim));
      }
      for (const [k, pp] of Object.entries(PROVIDERS)) {
        if (pp.envKey && process.env[pp.envKey]) {
          io.print(style(`  环境变量 ${pp.envKey}: 已设置（未读取内容）`, C.dim));
        }
      }
      if (process.env.MINGDAO_API_KEY) {
        io.print(style('  环境变量 MINGDAO_API_KEY: 已设置（未读取内容）', C.dim));
      }
      io.print('提示：密钥只存本机凭证库，config.json 可安全分享/提交仓库。');
    } else if (sub === 'set') {
      if (!target) {
        io.print('用法：mingdao key set <服务商名> [key]');
        return true;
      }
      // v0.4.7（P3 T22）：密钥优先从**标准输入**读，而不是命令行参数。
      // argv 会出现在 `ps aux` / 进程会计 / CI 日志里，本机任何用户都能直接读到明文密钥
      // ——这不是理论风险：本项目自己校验进程归属（src/proc.js）与回收强杀 worker 时，
      // 用的正是「读命令行」这条路径。
      let key = args[2] || '';
      const fromArgv = Boolean(key);
      if (!key) {
        if (process.stdin.isTTY) {
          key = await io.ask(`输入 ${target} 的 API Key（隐藏输入）：`, { hidden: true });
        } else {
          // 管道/重定向（脚本与 CI 的常规用法）：echo "<key>" | mingdao key set <服务商名>
          try {
            key = String(fs.readFileSync(0, 'utf8') || '');
          } catch {
            key = '';
          }
          key = key.trim(); // echo 会带上结尾换行
          if (!key) {
            io.print('用法：echo "<API Key>" | mingdao key set <服务商名>');
            io.print('（也可交互输入：mingdao key set <服务商名>）');
            return true;
          }
        }
      }
      if (!key) {
        io.print('未输入，已取消。');
        return true;
      }
      if (fromArgv) {
        io.print(style('⚠ 命令行参数中的密钥会出现在进程列表里（ps aux 可见），建议改用：echo "<key>" | mingdao key set ' + target, C.yellow));
      }
      setStoredKey(target, key);
      io.print(`已保存 ${target} → ${maskKey(key)}（${credentialsPath()}，权限 600）。`);
      io.print('注意：密钥不会写入 config.json，也不会进入项目仓库。');
    } else if (sub === 'remove') {
      if (!target) {
        io.print('用法：mingdao key remove <服务商名>');
        return true;
      }
      removeStoredKey(target);
      io.print(`已移除 ${target} 的本地凭证。`);
    } else if (sub === 'import') {
      ensureHome();
      let count = 0;
      for (const [k, pp] of Object.entries(PROVIDERS)) {
        if (pp.envKey && process.env[pp.envKey]) {
          setStoredKey(k, process.env[pp.envKey]);
          io.print(`已导入 ${k}（来自环境变量 ${pp.envKey}）。`);
          count += 1;
        }
      }
      if (!count) io.print('没有可导入的环境变量（如 DEEPSEEK_API_KEY）。');
    } else {
      io.print('用法：mingdao key [status|set <服务商> [key]|remove <服务商>|import]');
    }
  } finally {
    io.close();
  }
  return true;
}
