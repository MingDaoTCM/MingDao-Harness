// 批八十八（v0.7.1 正确性止血）：回合结局与工具成败判定的变异验证。
//
// 目标：把每处修复改回缺陷，`test/turn-outcome.js` 或 `test/state-locks.js` 必须当场红，
// 且失败输出里出现该条 expect 关键词（关键词对不上 = 逃逸）。
//
// 覆盖：allSettled 退成 all / 截断出口又漏 markOutcome / 异常出口不 markOutcome('error') /
//       toolOk 退回字符串包含 / 会话写锁被去掉 / rewriteSession 锁键用错 / 渲染移入 try 被撤销 /
//       截断续写 markOutcome 漏 truncated:true。
// 用法：node test/mutate/batch88-turn-outcome.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const TO = () => M.suite('test/turn-outcome.js');
const SL = () => M.suite('test/state-locks.js');

// ① allSettled 退成 all：一个兄弟工具拒绝即整体拒绝，其余并行工具结果被丢弃（S-2/H-2）
M.mutate({
  name: '① 并行批次 Promise.allSettled 退回 Promise.all',
  file: 'src/agent.js',
  from: 'const settled = await Promise.allSettled(',
  to: 'const settled = await Promise.all(', // 变异：退回 all
  expect: ['兄弟 a.txt 结果不得被丢弃', '不丢兄弟结果'],
  run: TO,
});

// ② 截断续写又漏 markOutcome：账本/返回值/事件流三口径再次分裂（status 记 done）
M.mutate({
  name: '② 截断续写又漏 markOutcome',
  file: 'src/agent.js',
  from: "            markOutcome('capped', { truncated: true }); // 截断续写也是「预算用尽」：账本/返回值/事件流三口径必须一致（审计报告1 S-1/H-2）\n",
  to: '',
  expect: ["截断续写必须 markOutcome('capped')", '截断续写必须 markOutcome'],
  run: TO,
});

// ③ 异常出口不 markOutcome('error')：崩溃回合被账本记「正常完成」
M.mutate({
  name: '③ 异常出口不 markOutcome("error")',
  file: 'src/agent.js',
  from: '      markOutcome(\'error\'); // 崩溃回合必须被账本记"异常"，不得记"正常完成"（审计报告1 S-1/H-2）\n',
  to: '',
  expect: ["异常出口必须 markOutcome('error')", '异常出口必须 markOutcome'],
  run: TO,
});

// ④ toolOk 退回字符串包含：正文出现 `"ok": false` 即误判失败（报告A H-1）
M.mutate({
  name: '④ toolOk 退回字符串包含',
  file: 'src/agent.js',
  from: [
    '          let toolOk = true;',
    "          if (typeof result === 'string') {",
    '            // 顶层 ok 解析（与下方审计/账本的 rObj 判定同款）：字符串是合法 JSON 且带顶层 ok 时看顶层，',
    '            // 正文里出现 `"ok": false` 只是文本、不是失败信号（审计报告A H-1）。',
    '            let rObj = null;',
    "            try { rObj = JSON.parse(result); } catch { rObj = null; }",
    '            toolOk = rObj ? rObj.ok !== false : !result.includes(\'"ok": false\');',
  ].join('\n'),
  to: [
    '          let toolOk = true;',
    "          if (typeof result === 'string') {",
    '            toolOk = !result.includes(\'"ok": false\'); // 变异：退回字符串包含',
  ].join('\n'),
  expect: ['toolOk 必须用顶层 ok 解析', 'toolOk 必须用顶层'],
  run: TO,
});

// ⑤ 会话写锁被去掉（appendMessages）：并发 append 写到被 rename 的旧 inode → 消息静默丢失（S-5/H2）
M.mutate({
  name: '⑤ appendMessages 会话写锁被去掉',
  file: 'src/session.js',
  from: [
    '  withFileLockSync(sessionLockFile(file), () => {',
    '    appendFilePrivateSync(file, lines);',
    '    doubleWriteSessionEvents(file, messages); // 旁路：失败只 warn，不影响上面的会话写入',
    '  });',
  ].join('\n'),
  to: [
    '  appendFilePrivateSync(file, lines); // 变异：去掉会话写锁',
    '  doubleWriteSessionEvents(file, messages); // 旁路：失败只 warn，不影响上面的会话写入',
  ].join('\n'),
  expect: ['appendMessages 必须持', 'appendMessages 必须持 `<session>.lock`'],
  run: SL,
});

// ⑥ rewriteSession 锁键用错：与 append 不同锁 → 两写方不互斥（S-5/H2）
M.mutate({
  name: '⑥ rewriteSession 锁键用错',
  file: 'src/session.js',
  from: [
    '  withFileLockSync(sessionLockFile(file), () => {',
    "    atomicWriteFileSync(file, lines + (lines ? '\\n' : ''), { mode: 0o600 }); // 质检 H4：会话文件原子写",
  ].join('\n'),
  to: [
    '  withFileLockSync(`${String(file)}.rewrite.lock`, () => { // 变异：rewriteSession 锁键用错',
    "    atomicWriteFileSync(file, lines + (lines ? '\\n' : ''), { mode: 0o600 }); // 质检 H4：会话文件原子写",
  ].join('\n'),
  expect: ['rewriteSession 必须与 append 共用同一把', 'rewriteSession 必须与 append'],
  run: SL,
});

// ⑦ 渲染移入 try 被撤销：渲染抛错即 Promise 拒绝（S-1）
M.mutate({
  name: '⑦ 渲染移入 try 被撤销',
  file: 'src/agent.js',
  from: [
    '          const prevPack = currentPack;',
    '          try {',
    '            io.renderToolStart?.(prep.name, prep.args);',
  ].join('\n'),
  to: [
    '          const prevPack = currentPack;',
    '            io.renderToolStart?.(prep.name, prep.args); // 变异：渲染移出 try',
    '          try {',
  ].join('\n'),
  expect: ['io.renderToolStart 必须在 try 内', 'io.renderToolStart 必须在 try'],
  run: TO,
});

// ⑧ 截断续写 markOutcome 漏 truncated:true：账本 truncated 记 false，与返回值分裂
M.mutate({
  name: '⑧ 截断续写 markOutcome 漏 truncated:true',
  file: 'src/agent.js',
  from: "            markOutcome('capped', { truncated: true }); // 截断续写也是「预算用尽」：账本/返回值/事件流三口径必须一致（审计报告1 S-1/H-2）",
  to: "            markOutcome('capped'); // 变异：漏 truncated:true",
  expect: ['截断续写必须 markOutcome({truncated:true})', '截断续写必须 markOutcome'],
  run: TO,
});

const okAll = M.report();
process.exit(okAll ? 0 : 1);
