// Hooks 生命周期钩子（借鉴 Claude Code PreToolUse/PostToolUse 设计）：
//  config.hooks = {
//    "PreToolUse":  [ { "matcher": "write|edit|bash", "cmd": "node ~/hooks/pre.js" } ],
//    "PostToolUse": [ { "matcher": "*", "cmd": "curl -X POST http://localhost:9000/audit" } ]
//  }
//  - PreToolUse：向子进程 stdin 写入 JSON {hook_event_name, tool_name, tool_input}；
//    子进程 stdout 输出 JSON {decision:"approve"|"block", reason} 可阻止工具执行。
//  - PostToolUse：写入 {hook_event_name, tool_name, tool_input, tool_response}，结果仅记录不阻塞。
//  - matcher 支持精确工具名、逗号分隔多个名、'*' 通配。

import { spawn } from 'node:child_process';

function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((h) => h && typeof h.cmd === 'string' && h.cmd.trim());
}

function match(hook, toolName) {
  const m = String(hook.matcher || '*').trim();
  if (!m || m === '*') return true;
  return m.split(',').some((part) => {
    const p = part.trim();
    if (p.endsWith('*')) return toolName.startsWith(p.slice(0, -1));
    return p === toolName;
  });
}

export function createHooks(hooksCfg = {}, workingDir) {
  const pre = normalize(hooksCfg?.PreToolUse);
  const post = normalize(hooksCfg?.PostToolUse);

  function run(hook, payload) {
    return new Promise((resolve) => {
      const child = spawn(hook.cmd, {
        shell: true,
        cwd: workingDir,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ ok: false, error: 'hook 执行超时（10s）' });
      }, 10000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `hook 启动失败：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ ok: true, exitCode: code, output: out, stderr: err });
      });
      try {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      } catch {}
    });
  }

  return {
    async pre(toolName, args) {
      let decision = 'approve';
      let reason = '';
      for (const h of pre) {
        if (!match(h, toolName)) continue;
        const r = await run(h, { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: args });
        if (!r.ok) {
          decision = 'block';
          reason = r.error;
          break;
        }
        try {
          const j = JSON.parse(r.output.trim());
          if (j && j.decision === 'block') {
            decision = 'block';
            reason = j.reason || '被 PreToolUse 钩子阻止';
            break;
          }
        } catch {}
      }
      return { decision, reason };
    },
    async post(toolName, args, result) {
      for (const h of post) {
        if (!match(h, toolName)) continue;
        try {
          await run(h, {
            hook_event_name: 'PostToolUse',
            tool_name: toolName,
            tool_input: args,
            tool_response: result,
          });
        } catch {}
      }
    },
  };
}
