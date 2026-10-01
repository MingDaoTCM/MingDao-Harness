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
import { spawnOpts } from './proc.js';
import { isSensitiveEnv } from './tools/bash.js';

function normalize(/** @type {any} */ list) {
  if (!Array.isArray(list)) return [];
  return list.filter((h) => h && typeof h.cmd === 'string' && h.cmd.trim());
}

function match(/** @type {any} */ hook, /** @type {any} */ toolName) {
  const m = String(hook.matcher || '*').trim();
  if (!m || m === '*') return true;
  // P2 修复（v0.4.6）：同时支持 `,` 与 `|` 分隔。docs/CONFIG.md 的官方示例写的是
  // `"matcher": "write|edit|bash"` 并明文声明支持 `|`，而实现只按 `,` 切分——按文档写的
  // PreToolUse 策略钩子永不触发（fail-open），且没有任何日志，一个本该拦写操作的合规钩子静默失效。
  return m.split(/[,|]/).some((part) => {
    const p = part.trim();
    if (!p) return false;
    if (p.endsWith('*')) return toolName.startsWith(p.slice(0, -1));
    return p === toolName;
  });
}

export function createHooks(hooksCfg = {}, /** @type {any} */ workingDir, /** @type {any} */ cfg = {}) {
  const pre = normalize((/** @type {any} */ (hooksCfg))?.PreToolUse);
  const post = normalize((/** @type {any} */ (hooksCfg))?.PostToolUse);
  // 审计 P3-6（v0.4.2）：hook 子进程不再全量透传 process.env（含 API Key）——与 bash 工具同口径
  // 默认过滤敏感变量；config.bashEnvKeep 按名放行、bashEnvFilter=false 整体关闭。
  const keepEnv = new Set((cfg?.bashEnvKeep || []).map(String));
  let childEnv = process.env;
  if (cfg?.bashEnvFilter !== false) {
    const filtered = /** @type {any} */ ({});
    for (const [k, v] of Object.entries(process.env)) {
      if (!isSensitiveEnv(k) || keepEnv.has(k)) filtered[k] = v;
    }
    childEnv = filtered;
  }

  function run(/** @type {any} */ hook, /** @type {any} */ payload) {
    return new Promise((resolve) => {
      // 评估 6.5（v0.4.4）+ Windows 回归修复（v0.4.5）：POSIX 上 detached 自成进程组，
      // 超时 process.kill(-pid) 整组清理（否则只杀 shell，孙进程孤儿）；但 Windows 无进程组语义，
      // detached 反而新建控制台、打断 stdio 管道——hook 子进程收不到 stdin EOF 卡 10s 超时，
      // 使 Windows CI 自 v0.4.4 起冒烟测试恒红。改为 Windows 用 windowsHide（不闪窗）且直接 kill child。
      const isWin = process.platform === 'win32';
      const child = spawn(hook.cmd, {
        shell: true,
        cwd: workingDir,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        // v0.6.2：收口到统一出口（结论就是从这里提炼的）。spawnOpts 在 Windows 上
        // 返回 detached:false + windowsHide:true，与原先的 !isWin / isWin 完全等价。
        detached: true,
        ...spawnOpts({ piped: true }),
      });
      let out = '';
      let err = '';
      const MAX_HOOK_OUT = 64 * 1024;
      // 审计 BUG-041（实测复现）：原实现 `t.slice(-MAX_HOOK_OUT)` 保留的是**结尾**，
      // 于是 70000 字节的合法输出 `{"decision":"block","reason":"…"}` 头部被切掉、JSON.parse
      // 必失败，再被下面的 fail-closed 升格成 block —— 一次**误**拦（hook 明明说了话）。
      // 改成保留**前缀**（JSON 头完整），并把「发生过截断」如实带出去，让提示说的是真原因。
      let outTruncated = false;
      const capOut = (/** @type {any} */ acc, /** @type {any} */ d) => {
        if (acc.length >= MAX_HOOK_OUT) {
          outTruncated = true;
          return acc;
        }
        const t = acc + d;
        if (t.length <= MAX_HOOK_OUT) return t;
        outTruncated = true;
        return t.slice(0, MAX_HOOK_OUT);
      };
      const capErr = (/** @type {any} */ acc, /** @type {any} */ d) => (acc + d).slice(-MAX_HOOK_OUT); // stderr 只用于展示，留尾部
      let settled = false;
      const finish = (/** @type {any} */ result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        // 审计质量项：超时杀整组（shell:true 的孙进程不成孤儿）；Windows 无进程组，直接 kill child
        try {
          if (!isWin) process.kill(-(/** @type {any} */ (child)).pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        finish({ ok: false, error: 'hook 执行超时（10s）' });
      }, 10000);
      child.stdout.on('data', (d) => (out = capOut(out, d)));
      child.stderr.on('data', (d) => (err = capErr(err, d)));
      // P1 修复（v0.4.6）：stdin 必须有 error 监听。hook 若「不读 stdin 就退出」（如
      // cmd:'true' / echo 形式的策略脚本）且载荷超过管道缓冲（约 64KB，write 大文件时必然发生），
      // write 的 EPIPE 会作为异步 error 事件抛出——无人监听即未捕获异常，整个进程崩溃
      // （WebUI 场景下所有并发会话一起死）。write() 本身的 try/catch 捕不到异步事件。
      //
      // v0.6.3（审计 BUG-042）：**但不能只吞不报**。载荷没送到时 hook 的判定不可信，
      // 而本模块把「空输出」当作**放行**——于是 v0.4.6 这个"防崩溃"的监听顺带造成 fail-open：
      // 一次本该拦截的策略因为没收到载荷而被静默通过。现在记下失败，在 close 时收口。
      /** @type {string|null} */
      let stdinFailed = null;
      // v0.6.3（BUG-042 第二版修复）：**不能依赖 error 事件的到达时机**。
      //
      // 第一版只看 `stdinFailed`（stdin 'error'）。它在 Linux 上是竞态：子进程若 `dup` 过
      // fd 0（libuv 对 stdin 的常见处理），关闭 fd 0 并不会让父进程立刻拿到 EPIPE——
      // 要等子进程真正退出、内核回收重复描述符之后才会送达。于是 child 'close' 与
      // stdin 'error' 谁先到取决于调度：macOS 上 error 先到（本地 5/5 通过），
      // ubuntu Node 18/20 上 close 先到 → 空输出被当成「放行」，用例在 CI 上红。
      //
      // v0.6.8（报告一 K-1，**严重**）：判据从 `'finish'` 事件改为**写入回调**。
      //
      // 原判据是「`end()` 之后 'finish' 是否触发」，注释里写着"这个判据不依赖事件先后"——
      // 但实测它在 Windows 命名管道上**不可靠**：Node 24.14.0 下 40 次复现 0 次通过
      // （24.21.0 才 40/40），于是「载荷已送达」被误判成「未送达」→ 任何读 stdin 的合规 hook
      // 在大文件写入时都被误拦（生产功能破坏 + 测试/发布链路在 Windows 上断裂）。
      //
      // 现在改用**可计量的证据**：`write()` 的回调在**这一块数据交给内核**时触发。
      //   · hook 读了 stdin → 回调必触发（数据被读走）；
      //   · hook 不读 → 载荷若 ≤ 管道缓冲（64KB）回调也会触发（内核收下了）→ 尊重它的输出；
      //     载荷 > 64KB 且无人读 → 回调不触发 → close 时判「未送达」→ fail-closed。
      // 这条判据与平台无关，也不依赖任何事件先后。
      const payloadStr = JSON.stringify(payload);
      const payloadBytes = Buffer.byteLength(payloadStr);
      let stdinDeliveredBytes = 0;
      child.stdin.on('error', (e) => {
        stdinFailed = String(/** @type {any} */ (e)?.message ?? e);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        finish({ ok: false, error: `hook 启动失败：${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        // 载荷没送进去、且 hook 也没给出任何判定 → 这次运行**不可信**，按 hook 失败处理
        // （调用方 !ok → block，fail-closed）。若 hook 仍给出了输出，说明它本就没打算读 stdin
        // （例如 `echo '{"decision":"approve"}'`），那种情况下尊重它的判定，避免误伤既有策略。
        // 只认**写入回调**这一条可计量证据。刻意**不用** `writableFinished` 兜底：
        // 子进程 EPIPE 提前退出时它也可能是 true，于是「300KB 载荷没送进去」会被判成送达
        // ——那是 fail-open（实测：不读 stdin 且退出码 0 的 hook 会因此拿到 approve）。
        const delivered = stdinDeliveredBytes >= payloadBytes;
        if (!String(out).trim() && (stdinFailed || !delivered)) {
          const why = stdinFailed ?? `载荷未送达（已交给内核 ${stdinDeliveredBytes}/${payloadBytes} 字节，子进程可能未读取 stdin 就退出）`;
          finish({ ok: false, error: `hook 输入写入失败：${why}` });
          return;
        }
        finish({ ok: true, exitCode: code, output: out, stderr: err, truncated: outTruncated });
      });
      try {
        // ⚠ 回调在**出错时也会被调用**（Node 的 Writable 语义：`cb(err)`）。
        // 必须判 err —— 否则 EPIPE 会被当成"送达成功"，判据整体 fail-open
        // （实测：300KB 载荷 + 不读 stdin 的 hook 会因此拿到 approve）。
        child.stdin.write(payloadStr, (/** @type {any} */ err) => {
          if (!err) stdinDeliveredBytes = payloadBytes;
        });
        child.stdin.end();
      } catch (e) {
        // 同步抛出与异步 error 同源，统一交给 close 收口（不在这里 finish，避免重复结算）
        stdinFailed = String(/** @type {any} */ (e)?.message ?? e);
      }
    });
  }

  return {
    async pre(/** @type {any} */ toolName, /** @type {any} */ args) {
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
        const out = String(r.output || '').trim();
        if (!out) continue; // 空输出 = 放行
        try {
          const j = JSON.parse(out);
          if (j && j.decision === 'block') {
            decision = 'block';
            reason = j.reason || '被 PreToolUse 钩子阻止';
            break;
          }
        } catch {
          // fail-closed：输出不是合法 JSON（日志/报错混入）时按阻止处理，避免策略被静默绕过。
          // 审计 BUG-041：截断与「真解析不了」必须分开说——前者的提示要指向真正的原因。
          decision = 'block';
          reason = r.truncated
            ? `PreToolUse 钩子输出超过 64KB 被截断，无法据其判定（按 fail-closed 阻止）——请让 hook 只输出一行 JSON decision，或把判断逻辑放进 hook 内部。`
            : `PreToolUse 钩子输出无法解析（前 80 字）：${out.slice(0, 80)}`;
          break;
        }
      }
      return { decision, reason };
    },
    async post(/** @type {any} */ toolName, /** @type {any} */ args, /** @type {any} */ result) {
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
