// 命令族：mingdao key（自 cli.js 拆出，评估 P0-1 拆包）
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
      let key = args[2] || '';
      if (!key) {
        if (!io.isTTY) {
          io.print('非交互环境请直接传参：mingdao key set <服务商名> <key>');
          return true;
        }
        key = await io.ask(`输入 ${target} 的 API Key（隐藏输入）：`, { hidden: true });
      }
      if (!key) {
        io.print('未输入，已取消。');
        return true;
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
