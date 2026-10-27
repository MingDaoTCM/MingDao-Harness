// 批五十八（v0.6.28 审计报告 A：H-01 畸形请求致进程退出 / M-03 聊天早期异常假 running）
// 的变异验证。每一条都把修复逐个改回缺陷，`test/web-robustness.js` 必须当场红。
//
// 覆盖：
//   ① request-target 解析重新放回 http 回调、且在同步 try 之外（H-01 原缺陷 → 进程退出）
//   ② origin-form 边界失效（绝对形式 URI 被当成普通路径）
//   ③ 超长目标检查被删
//   ④ finishChat 漏 notifyBusy → onBusy 停在 true
//   ⑤ finishChat 漏 clearInterval(progressTimer) → 5s 计时器继续跑
//   ⑥ finishChat 漏 releaseSessionClaim → 同会话永久「忙」
//   ⑦ finishChat 漏发 SSE error → 客户端空流
//   ⑧ finishChat 不置 failed → /api/tasks 仍 running
//   ⑨ 纯函数不再导出（单源解析被拆掉）
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/web-robustness.js');

// ① H-01 原缺陷：解析发生在回调最前面、同步 try 之外
M.mutate({
  name: '① 把 URL 解析放回 http 回调、且在同步 try 之外（H-01 复现）',
  file: 'src/web/server.js',
  from: `  const server = http.createServer((req, res) => {
    // H-01：整个回调（含 request-target 解析、响应头补丁安装与 dispatch 调用）都在同步 try 内。`,
  to: `  const server = http.createServer((req, res) => {
    const __h01Unsafe = new URL(String(req.url || '/'), 'http://localhost');
    void __h01Unsafe;
    // H-01：整个回调（含 request-target 解析、响应头补丁安装与 dispatch 调用）都在同步 try 内。`,
  expect: ['Invalid URL'],
  run: SUITE,
});

// ② origin-form 边界失效：绝对形式 URI / 协议相对 URI 不再被拒
M.mutate({
  name: '② origin-form 边界失效（绝对形式 URI 放行）',
  file: 'src/web/server.js',
  from: `  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\\\')) {
    return { ok: false, reason: '仅接受 origin-form 请求目标（不以 / 开头或含 // / \\\\）' };
  }`,
  to: `  if (false) {
    return { ok: false, reason: '仅接受 origin-form 请求目标（不以 / 开头或含 // / \\\\）' };
  }`,
  expect: ['应被拒绝'],
  run: SUITE,
});

// ③ 超长目标检查被删：9k 目标进入 URL 解析
M.mutate({
  name: '③ 删除超长 request-target 检查',
  file: 'src/web/server.js',
  from: "  if (raw.length > MAX_REQUEST_TARGET) return { ok: false, reason: `请求目标过长（>${MAX_REQUEST_TARGET} 字节）` };",
  to: '  if (false) return { ok: false, reason: `请求目标过长（>${MAX_REQUEST_TARGET} 字节）` };',
  expect: ['超长目标 应被拒绝'],
  run: SUITE,
});

// ④ 漏 notifyBusy：任务置 failed 后全局忙状态不恢复
M.mutate({
  name: '④ finishChat 漏 notifyBusy（onBusy 停在 true）',
  file: 'src/web/server.js',
  from: `      // ④ 忙状态（必须在置终态之后：notifyBusy 按 status==='running' 计算）
      notifyBusy();`,
  to: `      // ④ 忙状态（变异：不恢复）`,
  expect: ['onBusy 必须恰好 true→false'],
  run: SUITE,
});

// ⑤ 漏 clearInterval：5s 进度计时器绕过收尾
M.mutate({
  name: '⑤ finishChat 漏 clearInterval(progressTimer)',
  file: 'src/web/server.js',
  from: `      if (progressTimer) {
        try {
          clearInterval(progressTimer);
        } catch {}
        progressTimer = null;
      }`,
  to: `      if (progressTimer) progressTimer = null;`,
  expect: ['finishChat 必须 clearInterval(progressTimer)'],
  run: SUITE,
});

// ⑥ 会话 claim 释放失效：finishChat 与 res.close 兜底都调它，把它改成 no-op 等价于整体漏放
M.mutate({
  name: '⑥ 会话 claim 释放失效（finishChat / res.close 都放不掉）',
  file: 'src/web/server.js',
  from: `    releaseSessionClaim = () => {
      if (sessionClaimReleased) return;
      sessionClaimReleased = true;
      for (const k of claimedKeys) busySessions.delete(k);
      claimedKeys.clear();
    };`,
  to: `    releaseSessionClaim = () => {};`,
  expect: ['会话 claim 必须释放'],
  run: SUITE,
});

// ⑦ 漏 SSE error：客户端收到空流
M.mutate({
  name: '⑦ finishChat 漏发 SSE error',
  file: 'src/web/server.js',
  from: `      if (message) {
        try {
          if (entry.send) entry.send({ type: 'error', message: prefix + message });
          else res.write(\`data: \${JSON.stringify({ type: 'error', message: prefix + message, taskId })}\\n\\n\`);
        } catch {}
      }`,
  to: `      if (false) {
        try {
          if (entry.send) entry.send({ type: 'error', message: prefix + message });
          else res.write(\`data: \${JSON.stringify({ type: 'error', message: prefix + message, taskId })}\\n\\n\`);
        } catch {}
      }`,
  expect: ['SSE 必须恰好一条 error'],
  run: SUITE,
});

// ⑧ 不置 failed：任务保持 running，prune 也删不掉
M.mutate({
  name: '⑧ finishChat 不置 failed（任务仍 running）',
  file: 'src/web/server.js',
  from: `        prefix = explicit ? String(cause.prefix ?? '') : '对话失败：';
        entry.status = 'failed';`,
  to: `        prefix = explicit ? String(cause.prefix ?? '') : '对话失败：';`,
  expect: ['任务终态必须是 failed', 'running 必须归零'],
  run: SUITE,
});

// ⑨ 纯函数不再导出：解析的单源入口被拆掉
M.mutate({
  name: '⑨ parseRequestTarget 不再导出',
  file: 'src/web/server.js',
  from: 'export function parseRequestTarget(raw) {',
  to: 'function parseRequestTarget(raw) {',
  expect: ['parseRequestTarget'],
  run: SUITE,
});

// ⑩ 路由层拿不到 finishChat：早期 await 抛出的意外异常（工作空间锁）失去最外层收尾入口
M.mutate({
  name: '⑩ 删除路由层收尾入口 entry.finish（finishChat 不再覆盖早期异常）',
  file: 'src/web/server.js',
  from: '    entry.finish = finishChat; // 路由层最外层 try/catch/finally 的入口（见 routes/domains/misc.js）',
  to: '    // 变异：路由层拿不到收尾入口',
  expect: ['running 必须归零'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
