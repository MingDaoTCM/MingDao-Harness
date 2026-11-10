// 批八十五（v0.7.0 B2-a）：事件日志「完整记录消息」的变异验证。
//
// 目标：B2 要把真源从消息数组切到事件日志，前提是**每一条写盘路径都可等价重放**。这一批把
// `messages.replace` 双写的每一处价值改回缺陷，`test/event-completeness.js` 必须当场红，
// 且失败输出里出现该条 `expect` 关键词。
//
// 覆盖：rewrite 不写事件 / 写了但不带 messages / replay 忽略 messages.replace /
//       事件写失败拖垮 rewrite / eventLog=false 仍写 / reason 丢失 /
//       replace 当作追加 / 大消息截断 / 先写事件后写会话（顺序错）。
// 用法：node test/mutate/batch85-completeness.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const COMPLETE = () => M.suite('test/event-completeness.js');

// ① rewrite 不写事件：压缩/resume/CLI 重写后，事件流只能重放出旧窗口
M.mutate({
  name: '① rewrite 不写事件（rewriteSession 不落 messages.replace）',
  file: 'src/session.js',
  from: '  doubleWriteReplaceEvents(file, messages, reason);',
  to: '  // 变异：rewrite 不写事件',
  expect: ['rewriteSession 之后必须出现 messages.replace 事件'],
  run: COMPLETE,
});

// ② 写了但不带 messages：只剩一条「替换过」的占位，窗口内容不可恢复
M.mutate({
  name: '② 写了但不带 messages（messages.replace 只剩 reason）',
  file: 'src/session.js',
  from: '      data: { messages, reason: normalizeRewriteReason(reason) },',
  to: '      data: { reason: normalizeRewriteReason(reason) }, // 变异：不带 messages',
  expect: ['data.messages 必须与写盘内容逐条一致'],
  run: COMPLETE,
});

// ③ replay 忽略 messages.replace：替换事件被当作未知类型跳过，重放停在旧基线
M.mutate({
  name: '③ replay 忽略 messages.replace（重放不认新类型）',
  file: 'src/session-events.js',
  from: "    } else if (ev.type === 'compact' || ev.type === 'messages.replace') {",
  to: "    } else if (ev.type === 'compact') { // 变异：replay 忽略 messages.replace",
  expect: ['重放必须与消息数组等价（压缩）'],
  run: COMPLETE,
});

// ④ 事件写失败拖垮 rewrite：旁路日志反过来让会话重写失败
M.mutate({
  name: '④ 事件写失败拖垮 rewrite（旁路失败改成抛异常）',
  file: 'src/session.js',
  from: [
    '    if (!r.ok) warnEventFailure(eventFile, r.error ?? null);',
    '  } catch (err) {',
    '    warnEventFailure(eventFile, String(/** @type {any} */ (err)?.message ?? err));',
    '  }',
  ].join('\n'),
  to: [
    '    if (!r.ok) throw new Error(String(r.error)); // 变异：事件写失败拖垮 rewrite',
    '  } catch (err) {',
    '    throw err;',
    '  }',
  ].join('\n'),
  expect: ['事件写失败不得让 rewrite 抛异常'],
  run: COMPLETE,
});

// ⑤ eventLog=false 仍写：回滚开关失效，关掉之后事件侧车照样出现
M.mutate({
  name: '⑤ eventLog=false 仍写（回滚开关失效）',
  file: 'src/session-events.js',
  from: '  return processEnabled;',
  to: '  return true; // 变异：eventLog=false 仍写',
  expect: ['eventLog=false 时不得创建事件侧车'],
  run: COMPLETE,
});

// ⑥ reason 丢失：compact/resume/rewrite 不可区分，审计/排障失去依据
M.mutate({
  name: '⑥ reason 丢失（messages.replace 不带 reason）',
  file: 'src/session.js',
  from: '      data: { messages, reason: normalizeRewriteReason(reason) },',
  to: '      data: { messages }, // 变异：reason 丢失',
  expect: ['reason 必须原样保留（compact）'],
  run: COMPLETE,
});

// ⑦ replace 当作追加：替换事件被 push 到旧窗口后面，旧消息全部残留
M.mutate({
  name: '⑦ replace 当作追加（旧窗口残留，重放分叉）',
  file: 'src/session-events.js',
  from: '        messages = base.filter((m) => m && typeof m === \'object\' && !Array.isArray(m)).map(cloneJson);',
  to: '        messages.push(...base.filter((m) => m && typeof m === \'object\' && !Array.isArray(m)).map(cloneJson)); // 变异：replace 当作追加',
  expect: ['重放必须与消息数组等价（压缩）'],
  run: COMPLETE,
});

// ⑧ 大消息截断：整份窗口里的大内容被截到 1000 字符，重放与写盘不再等价
M.mutate({
  name: '⑧ 大消息截断（data.messages 只留前 1000 字符）',
  file: 'src/session.js',
  from: '      data: { messages, reason: normalizeRewriteReason(reason) },',
  to: [
    '      data: { // 变异：大消息截断',
    '        messages: messages.map((m) => (typeof m?.content === \'string\' && m.content.length > 1000 ? { ...m, content: m.content.slice(0, 1000) } : m)),',
    '        reason: normalizeRewriteReason(reason),',
    '      },',
  ].join('\n'),
  expect: ['data.messages 不得被截断'],
  run: COMPLETE,
});

// ⑨ 顺序错（先写事件后写会话）：会话写失败时事件侧车已前进，留下不可恢复的分叉
M.mutate({
  name: '⑨ 先写事件后写会话（写盘失败也留下 messages.replace）',
  file: 'src/session.js',
  // v0.7.1（会话写锁 S-5）：rewriteSession 现在包在 withFileLockSync 里，缩进 +2，锚点跟随。
  from: [
    "    atomicWriteFileSync(file, lines + (lines ? '\\n' : ''), { mode: 0o600 }); // 质检 H4：会话文件原子写",
    '    // v0.7.0 B2-a：重写是「整体替换窗口」，必须以 messages.replace 落事件（append-only，不删旧行）。',
    '    // 只有会话文件写成功之后才写；失败只 warn（见 doubleWriteReplaceEvents）。',
    '    doubleWriteReplaceEvents(file, messages, reason);',
  ].join('\n'),
  to: [
    '    // 变异：先写事件后写会话',
    '    doubleWriteReplaceEvents(file, messages, reason);',
    "    atomicWriteFileSync(file, lines + (lines ? '\\n' : ''), { mode: 0o600 }); // 质检 H4：会话文件原子写",
  ].join('\n'),
  expect: ['会话写盘失败时不得留下 messages.replace（事件必须在写盘成功之后）'],
  run: COMPLETE,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
