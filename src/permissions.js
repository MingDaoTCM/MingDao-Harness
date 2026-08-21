// 权限引擎（借鉴 codewhale 的 execpolicy 独立分层思想）。
//
// 三种模式：
//  - ask      默认。只读工具自动放行；写文件/执行命令逐次询问。
//  - auto     全部自动允许（完全自主，注意风险）。
//  - readonly 只允许只读工具。
// config.permission 也可以是对象：
//  { mode: 'ask', allow: ['bash', 'bash:git *'], deny: ['write'] }
//  规则支持「工具名」或「工具名:参数前缀」模式匹配（* 通配）。
// check(name, args, label)：label 用于区分执行方（如子代理的「（子任务）」前缀）。

import { style, C } from './ui.js';
import { READONLY_TOOLS } from './tools/index.js';

function summarize(name, args) {
  try {
    if (name === 'bash') return ` ${args.command ?? ''}`;
    if (args.path) return ` ${args.path}`;
    return '';
  } catch {
    return '';
  }
}

function ruleMatches(rule, name, args) {
  const idx = rule.indexOf(':');
  if (idx > 0) {
    const ruleName = rule.slice(0, idx);
    if (ruleName !== name) return false;
    const want = rule.slice(idx + 1).trim();
    const have = summarize(name, args).trim();
    // bash 前缀规则防链式命令绕过：含 && / ; / | / ` / $( 的复合命令不匹配前缀规则，回落权限确认
    if (name === 'bash' && /&&|\|\||[;|`]|\$\(|\n/.test(have)) return false;
    if (want.endsWith('*')) return have.startsWith(want.slice(0, -1));
    return have === want;
  }
  return rule === name;
}

export function createPermission(rawMode, io) {
  let mode = 'ask';
  let allow = [];
  let deny = [];
  if (typeof rawMode === 'string') {
    mode = rawMode;
  } else if (rawMode && typeof rawMode === 'object') {
    mode = rawMode.mode ?? 'ask';
    allow = rawMode.allow ?? [];
    deny = rawMode.deny ?? [];
  }
  if (!['ask', 'auto', 'readonly'].includes(mode)) mode = 'ask';

  return {
    mode,
    async check(name, args = {}, label = '') {
      const askOverride = async (question) => {
        try {
          const answer = await io.ask(style(question, C.yellow));
          return /^y(es)?$/i.test(answer);
        } catch {
          return false; // 交互通道不可用（管道 EOF/静默 worker）：按拒绝处理
        }
      };
      // 需要特殊授权时弹出对话框与用户交互，而不是静默拒绝：
      // 1) 被 deny 规则拦截 → 询问是否本次强制放行
      if (deny.some((r) => ruleMatches(r, name, args))) {
        return askOverride(`规则拦截了 ${name}${summarize(name, args)}，是否本次强制放行？[y/N] `);
      }
      if (allow.some((r) => ruleMatches(r, name, args))) return true;
      if (mode === 'auto') return true;
      if (mode === 'readonly') {
        // 2) 只读模式下的写操作 → 询问是否本次放行
        if (READONLY_TOOLS.has(name)) return true;
        return askOverride(`只读模式将拦截 ${name}${summarize(name, args)}，是否本次放行？[y/N] `);
      }
      if (READONLY_TOOLS.has(name)) return true;
      const answer = await io.ask(
        style(`是否允许执行 ${label}${C.bold}${name}${C.reset}${summarize(name, args)} ？[y/N] `, C.yellow)
      );
      return /^y(es)?$/i.test(answer);
    },
  };
}
