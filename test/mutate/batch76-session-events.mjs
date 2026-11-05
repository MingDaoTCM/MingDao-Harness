// 批七十六（v0.7.0 §1.1 切片 A）：会话事件日志的变异验证。
//
// 目标：事件日志的价值全在「seq 可信 + 坏行不拖垮 + 重放等价」——每条把其中一处修复改回缺陷，
// `test/session-events.js` 必须当场红，且失败输出里出现该条 `expect` 关键词
// （关键词 = 断言原文，防止"红是红了，但不是因为你改坏的那条"）。
//
// 覆盖：seq 不从尾部取（重号）/ torn 行不跳过（整份读崩）/ 未知 type 崩 /
//       replay 丢掉 compact / interrupt 不补占位 / 写失败抛异常。
// 用法：node test/mutate/batch76-session-events.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const EVENTS = () => M.suite('test/session-events.js');

// ① seq 不从尾部取：永远分配 1 → 连续 20 条全是 1（重号）
M.mutate({
  name: '① seq 不从尾部取（每条都从 1 开始，重号）',
  file: 'src/session-events.js',
  from: '        const seq = base + 1;',
  to: '        const seq = 1; // 变异：不从尾部取',
  expect: ['seq 必须从 1 连续到 20（无洞、无重号）'],
  run: EVENTS,
});

// ② torn 行不跳过：JSON.parse 裸奔，整份读取直接崩
M.mutate({
  name: '② torn 行不跳过（JSON.parse 裸奔，整份读崩）',
  file: 'src/session-events.js',
  from: [
    '      let parsed;',
    '      try {',
    '        parsed = JSON.parse(line);',
    '      } catch {',
    '        skipped += 1;',
    '        continue;',
    '      }',
  ].join('\n'),
  to: '      const parsed = JSON.parse(line); // 变异：torn 行不跳过',
  expect: ['torn 行必须跳过且不能整份读崩'],
  run: EVENTS,
});

// ③ 未知 type 崩：不再跳过/计数，直接抛
M.mutate({
  name: '③ 未知 type 直接抛（未来版本加类型就整份读崩）',
  file: 'src/session-events.js',
  from: [
    '      if (!EVENT_TYPE_SET.has(parsed.type)) {',
    '        skipped += 1;',
    '        continue;',
    '      }',
  ].join('\n'),
  to: "      if (!EVENT_TYPE_SET.has(parsed.type)) { throw new Error('变异：未知 type 崩'); }",
  expect: ['未知 type 必须跳过而不能崩'],
  run: EVENTS,
});

// ④ replay 丢掉 compact：压缩前的旧消息留在结果里，重放与消息数组分叉
M.mutate({
  name: '④ replay 丢掉 compact（压缩基线不生效）',
  file: 'src/session-events.js',
  from: [
    "    } else if (ev.type === 'compact') {",
    '      const base = ev.data?.messages;',
    '      if (Array.isArray(base)) {',
    '        messages = base.filter((m) => m && typeof m === \'object\' && !Array.isArray(m)).map(cloneJson);',
    '      }',
  ].join('\n'),
  to: "    } else if (ev.type === 'compact') { // 变异：丢掉 compact",
  expect: ['compact 必须重置重放基线'],
  run: EVENTS,
});

// ⑤ interrupt 不补占位：被中断的 tool_call 永远没有 tool 回填
M.mutate({
  name: '⑤ interrupt 不补 tool 占位（孤儿 tool_call）',
  file: 'src/session-events.js',
  from: '  for (const id of [...new Set(pendingInterruptIds)]) {',
  to: '  for (const id of []) { // 变异：interrupt 不补占位',
  expect: ['interrupt 必须补齐尚未回填的 tool 占位'],
  run: EVENTS,
});

// ⑥ 写失败抛异常：旁路日志的失败反而打断调用方
M.mutate({
  name: '⑥ 写失败抛异常（事件日志失败拖垮调用方）',
  file: 'src/session-events.js',
  from: [
    '    return result;',
    '  } catch (err) {',
    '    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };',
    '  }',
  ].join('\n'),
  to: [
    '    return result;',
    '  } catch (err) {',
    '    throw err; // 变异：写失败抛异常',
    '  }',
  ].join('\n'),
  expect: ['写失败必须返回 {ok:false} 而不是抛出'],
  run: EVENTS,
});


// ⑦ 双写失败反过来打断会话写入：事件日志是旁路，却让 appendMessages 抛异常
M.mutate({
  name: '⑦ 双写失败抛异常（旁路失败反过来打断会话写入）',
  file: 'src/session.js',
  from: [
    '      if (!r.ok) {',
    '        warnEventFailure(eventFile, r.error ?? null);',
    '        return; // 写不进去就停：后面的每一条都只会重复同一条告警',
    '      }',
    '    }',
    '  } catch (err) {',
    '    warnEventFailure(eventFile, String(/** @type {any} */ (err)?.message ?? err));',
    '  }',
  ].join('\n'),
  to: [
    '      if (!r.ok) {',
    '        throw new Error(String(r.error));',
    '      }',
    '    }',
    '  } catch (err) {',
    '    throw err;',
    '  }',
  ].join('\n'),
  expect: ['双写失败绝不能影响会话写入'],
  run: EVENTS,
});

// ⑧ 进程开关失效：setEventLogEnabled(false) 之后仍然写事件
M.mutate({
  name: '⑧ 进程开关失效（setEventLogEnabled(false) 仍写事件）',
  file: 'src/session-events.js',
  from: '  return processEnabled;',
  to: '  return true; // 变异：进程开关失效',
  expect: ['开关关闭时必须完全停止事件写入'],
  run: EVENTS,
});

// ⑨ cfg.eventLog=false 被忽略：配置回滚开关失效
M.mutate({
  name: '⑨ cfg.eventLog=false 被忽略（配置回滚开关失效）',
  file: 'src/session-events.js',
  from: '  if (cfg && cfg.eventLog === false) return false;',
  to: '  // 变异：忽略 cfg.eventLog',
  expect: ['cfg.eventLog=false 必须关闭事件日志'],
  run: EVENTS,
});

// ⑩ 事件侧车被当成会话：列表/最近会话被幽灵会话污染
M.mutate({
  name: '⑩ isEventLogName 恒真（正常会话被当成事件侧车 → 会话列表空）',
  file: 'src/session-events.js',
  // v0.6.35：侧车改 `.ndjson` 后，"不排除侧车"这条变异已**没有判别力**（`!f.endsWith('.jsonl')`
  // 本来就把它挡掉了）。改成等价且仍可判的方向：让 `isEventLogName` 恒真 →
  // 正常会话全部被当成侧车排除 → 会话列表为空（`test/session-events.js` 里有对应断言）。
  from: "  return String(name || '').endsWith('.events.ndjson');",
  to: "  return true; // 变异：把一切都当成事件侧车",
  expect: ['侧车'],
  run: EVENTS,
});

// ⑪ turn.start 不写：agent 的回合边界事件缺失
M.mutate({
  name: '⑪ turn.start 不写（agent 回合边界缺失）',
  file: 'src/agent.js',
  from: "    emitEvent('turn.start', { model: modelName, session: sessionRef?.name ?? null, messages: Array.isArray(messages) ? messages.length : 0 });",
  to: '    // 变异：不写 turn.start',
  expect: ['agent 事件边界必须写入 turn.start'],
  run: EVENTS,
});


// ⑫ loadConfig 不同步 eventLog：Web「先落盘、后建 agent」的顺序会漏掉配置回滚
M.mutate({
  name: '⑫ loadConfig 不同步 eventLog（先落盘后建 agent 时回滚失效）',
  file: 'src/config.js',
  from: '  applyEventLogGate(cfg); // v0.7.0 §1.1：config.eventLog=false 在「先落盘、后建 agent」路径也生效',
  to: '  // 变异：loadConfig 不再同步 eventLog 开关',
  expect: ['loadConfig 必须把 config.eventLog=false 同步到事件日志进程开关'],
  run: EVENTS,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
