// 批八十六（v0.7.0 B2-b）：事件读取真源灰度开关的变异验证。
//
// 目标：`eventSource:'events'` 只是实验分支，**默认必须仍是 messages**，且对拍兜底必须真的挡住
// 不一致的派生结果。把每一处价值改回缺陷，`test/event-source.js` 必须当场红，且失败输出里
// 出现该条 `expect` 关键词。
//
// 覆盖：对拍失败也采用派生 / 旧格式也派生 / cfg 非法时当 events / 回退时不 warn /
//       warn 内容不带差异位置 / 派生结果不深拷贝（污染事件）/ 默认值被改成 events /
//       事件读失败直接抛 / 无侧车也用空数组冒充。
// 用法：node test/mutate/batch86-event-source.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const ES = () => M.suite('test/event-source.js');

// ① 对拍失败也采用派生：实验分支一旦与消息文件分叉，用户看到的历史会被静默改写
M.mutate({
  name: '① 对拍失败也采用派生（不一致时仍返回派生结果）',
  file: 'src/session.js',
  from: [
    '      if (d.ok) result = derived;',
    '      else {',
  ].join('\n'),
  to: [
    '      result = derived; // 变异：对拍失败也采用派生',
    '      if (false) {',
  ].join('\n'),
  expect: ['对拍不一致必须回退到消息数组'],
  run: ES,
});

// ② 旧格式也派生：本版之前的日志没有 rewrite 记录，派生必然缺窗口
M.mutate({
  name: '② 旧格式也派生（format 戳不再拦）',
  file: 'src/session.js',
  from: '    if (!newFormat) return null;',
  to: '    if (false && !newFormat) return null; // 变异：旧格式也派生',
  expect: ['格式戳缺失必须静默回退', '旧格式（format=1）必须静默回退'],
  run: ES,
});

// ③ cfg 非法时当 events：一个拼错的值把读取路径切到实验分支
M.mutate({
  name: '③ cfg 非法时当 events（只把 messages 当关）',
  file: 'src/config.js',
  from: '  return EVENT_SOURCE_SET.has(value) ? value : DEFAULT_EVENT_SOURCE;',
  to: "  return value === 'messages' || value === undefined ? 'messages' : 'events'; // 变异：cfg 非法时当 events（默认仍 messages）",
  expect: ['cfg 非法（eventSource=bogus）必须当 messages'],
  run: ES,
});

// ④ 回退时不 warn：对拍回归完全不可见，灰度验证失去唯一信号
M.mutate({
  name: '④ 回退时不 warn（对拍不一致静默回退）',
  file: 'src/session.js',
  from: [
    '        try {',
    '          console.warn(',
    '            `[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}；差异位置：${at}——已回退到消息数组` +',
    '              `（config.eventSource=events 仅灰度验证用，默认仍是 messages）。`',
    '          );',
    '        } catch {}',
  ].join('\n'),
  to: '        // 变异：回退时不 warn',
  expect: ['对拍不一致必须 warn 一条'],
  run: ES,
});

// ⑤ warn 内容不带差异位置：只报「不一致」，排障时无法定位第一条坏消息
M.mutate({
  name: '⑤ warn 内容不带差异位置（只说回退不说第几条）',
  file: 'src/session.js',
  from: '`[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}；差异位置：${at}——已回退到消息数组` +',
  to: '`[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}——已回退到消息数组` + // 变异：不带差异位置',
  expect: ['回退 warn 必须带文件与首个差异位置'],
  run: ES,
});

// ⑥ 派生结果不深拷贝：修改返回值会污染事件数据（同进程复用/缓存时串历史）
M.mutate({
  name: '⑥ 派生结果不深拷贝（直接引用事件里的消息对象）',
  file: 'src/session-events.js',
  from: '      if (m && typeof m === \'object\' && !Array.isArray(m)) messages.push(cloneJson(m));',
  to: '      if (m && typeof m === \'object\' && !Array.isArray(m)) messages.push(m); // 变异：派生结果不深拷贝（会污染事件）',
  expect: ['派生结果必须深拷贝'],
  run: ES,
});

// ⑦ 默认值被改成 events：未配置用户的读取路径被整体切走——本版绝不允许翻默认
M.mutate({
  name: '⑦ eventSource 默认值被改成 events（未配置也走事件源）',
  file: 'src/config.js',
  from: 'export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_MESSAGES;',
  to: 'export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_EVENTS; // 变异：默认值被改成 events',
  expect: ['默认 messages 模式不得读事件源'],
  run: ES,
});

// ⑧ 事件读失败直接抛：旁路故障反过来让会话读不出来
M.mutate({
  name: '⑧ 事件读失败直接抛（旁路故障阻断会话读取）',
  file: 'src/session.js',
  from: [
    '    if (!read.ok) return null;',
    '    // 与 scripts/event-parity.mjs 同一判据：format >= EVENT_LOG_FORMAT 才认为日志可完整回溯',
    '    // （旧日志没有 rewrite 记录，派生出来必然缺窗口，不能拿它当读取真源）。',
    '    const newFormat = read.events.some((ev) => ev.type === \'session.start\' && Number(ev.data?.format) >= EVENT_LOG_FORMAT);',
    '    if (!newFormat) return null;',
    '    return replayToMessages(read.events);',
    '  } catch {',
    '    // 事件侧车是旁路：任何异常都只意味着「这次不用事件源」，绝不能让会话读不出来。',
    '    return null;',
    '  }',
  ].join('\n'),
  to: [
    '    if (!read.ok) throw new Error(String(read.error)); // 变异：事件读失败直接抛',
    '    // 与 scripts/event-parity.mjs 同一判据：format >= EVENT_LOG_FORMAT 才认为日志可完整回溯',
    '    // （旧日志没有 rewrite 记录，派生出来必然缺窗口，不能拿它当读取真源）。',
    '    const newFormat = read.events.some((ev) => ev.type === \'session.start\' && Number(ev.data?.format) >= EVENT_LOG_FORMAT);',
    '    if (!newFormat) return null;',
    '    return replayToMessages(read.events);',
    '  } catch (err) {',
    '    throw err;',
    '  }',
  ].join('\n'),
  expect: ['事件日志读失败必须静默回退，不得抛异常'],
  run: ES,
});

// ⑨ 无侧车也用空数组冒充：旧会话会被当成「事件源里本来就没有消息」
M.mutate({
  name: '⑨ 无侧车也派生（空数组冒充事件流）',
  file: 'src/session.js',
  from: '    if (!fs.existsSync(eventFile)) return null;',
  to: '    if (!fs.existsSync(eventFile)) return []; // 变异：无侧车也派生',
  expect: ['无事件侧车必须静默回退'],
  run: ES,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
