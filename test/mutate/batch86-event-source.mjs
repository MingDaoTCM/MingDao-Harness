// 批八十六（v0.7.0 B2-b）：事件读取真源**翻默认** + 运维级环境变量回退的变异验证。
//
// 目标：默认必须是 `events`（对拍一致才采用、不一致回退），且 `MINGDAO_EVENT_SOURCE`
// 必须真的压过配置文件（env > config > 默认）。把每一处价值改回缺陷，`test/event-source.js`
// 必须当场红，且失败输出里出现该条 `expect` 关键词。
//
// 覆盖：对拍失败也采用派生 / 旧格式也派生 / cfg 非法时回落 messages / 回退时不 warn /
//       warn 内容不带差异位置 / 派生结果不深拷贝（污染事件）/ 默认值回退成 messages /
//       事件读失败直接抛 / 无侧车也用空数组冒充 / 环境变量被忽略。
// 用法：node test/mutate/batch86-event-source.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const ES = () => M.suite('test/event-source.js');

// ① 对拍失败也采用派生：一旦与消息文件分叉，用户看到的历史会被静默改写
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
  expect: ['默认 events 模式下对拍不一致必须回退到消息数组', '对拍不一致必须回退到消息数组'],
  run: ES,
});

// ② 旧格式也派生：本版之前的日志没有 rewrite 记录，派生必然缺窗口；旧会话必须永远回退消息数组
M.mutate({
  name: '② 旧格式也派生（format 戳不再拦）',
  file: 'src/session.js',
  from: '    if (!newFormat) return null;',
  to: '    if (false && !newFormat) return null; // 变异：旧格式也派生',
  expect: ['默认 events 模式下旧格式（format=1）必须静默回退', '旧格式（format=1）必须静默回退'],
  run: ES,
});

// ③ cfg 非法时回落 messages：默认翻成 events 后，非法值必须跟默认走，不能悄悄切回旧路径
M.mutate({
  name: '③ cfg 非法时回落 messages（默认已翻 events，非法值却切回旧真源）',
  file: 'src/config.js',
  from: '  return EVENT_SOURCE_SET.has(value) ? value : DEFAULT_EVENT_SOURCE;',
  to: "  return value === EVENT_SOURCE_EVENTS ? EVENT_SOURCE_EVENTS : EVENT_SOURCE_MESSAGES; // 变异：非法值回落 messages",
  expect: ['默认 events 模式下对拍不一致必须 warn 一条', 'cfg 非法（eventSource=bogus）必须按默认 events'],
  run: ES,
});

// ④ 回退时不 warn：对拍回归完全不可见，翻默认后失去唯一信号
M.mutate({
  name: '④ 回退时不 warn（对拍不一致静默回退）',
  file: 'src/session.js',
  from: [
    '        try {',
    '          console.warn(',
    '            `[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}；差异位置：${at}——已回退到消息数组` +',
    '              `（消息数组始终是兜底真源；可设 MINGDAO_EVENT_SOURCE=messages 强制回退）。`',
    '          );',
    '        } catch {}',
  ].join('\n'),
  to: '        // 变异：回退时不 warn',
  expect: ['默认 events 模式下对拍不一致必须 warn 一条'],
  run: ES,
});

// ⑤ warn 内容不带差异位置：只报「不一致」，排障时无法定位第一条坏消息
M.mutate({
  name: '⑤ warn 内容不带差异位置（只说回退不说第几条）',
  file: 'src/session.js',
  from: '`[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}；差异位置：${at}——已回退到消息数组` +',
  to: '`[MingDao] ⚠ 会话事件源对拍不一致（${file}）：${d.reason}——已回退到消息数组` +', // 变异：不带差异位置
  expect: ['默认回退 warn 必须带文件与首个差异位置'],
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

// ⑦ 默认值回退成 messages：未配置用户会被整体切回旧真源——翻默认后的最贵回归
M.mutate({
  name: '⑦ 默认值回退成 messages（未配置也走旧真源）',
  file: 'src/config.js',
  from: 'export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_EVENTS;',
  to: 'export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_MESSAGES; // 变异：默认回退成 messages',
  expect: ['默认 events 模式下对拍不一致必须 warn 一条', '默认真源必须是 events'],
  run: ES,
});

// ⑧ 事件读失败直接抛：旁路故障反过来让会话读不出来
M.mutate({
  name: '⑧ 事件读失败直接抛（旁路故障阻断会话读取）',
  file: 'src/session.js',
  from: [
    '    if (list == null) {',
    '      if (!fs.existsSync(eventFile)) return null;',
    '      const read = readEvents(eventFile);',
    '      if (!read.ok) return null;',
    '      list = read.events;',
    '    }',
    '    // 与 scripts/event-parity.mjs 同一判据：format >= EVENT_LOG_FORMAT 才认为日志可完整回溯',
    '    // （旧日志没有 rewrite 记录，派生出来必然缺窗口，不能拿它当读取真源）。',
    '    const newFormat = list.some((ev) => ev.type === \'session.start\' && Number(ev.data?.format) >= EVENT_LOG_FORMAT);',
    '    if (!newFormat) return null;',
    '    return replayToMessages(list);',
    '  } catch {',
    '    // 事件侧车是旁路：任何异常都只意味着「这次不用事件源」，绝不能让会话读不出来。',
    '    return null;',
    '  }',
  ].join('\n'),
  to: [
    '    if (list == null) {',
    '      if (!fs.existsSync(eventFile)) return null;',
    '      const read = readEvents(eventFile);',
    '      if (!read.ok) throw new Error(String(read.error)); // 变异：事件读失败直接抛',
    '      list = read.events;',
    '    }',
    '    // 与 scripts/event-parity.mjs 同一判据：format >= EVENT_LOG_FORMAT 才认为日志可完整回溯',
    '    // （旧日志没有 rewrite 记录，派生出来必然缺窗口，不能拿它当读取真源）。',
    '    const newFormat = list.some((ev) => ev.type === \'session.start\' && Number(ev.data?.format) >= EVENT_LOG_FORMAT);',
    '    if (!newFormat) return null;',
    '    return replayToMessages(list);',
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
  from: '      if (!fs.existsSync(eventFile)) return null;',
  to: '      if (!fs.existsSync(eventFile)) return []; // 变异：无侧车也派生',
  expect: ['默认 events 模式下无事件侧车必须静默回退', '无事件侧车必须静默回退'],
  run: ES,
});

// ⑩ 环境变量被忽略：出事时无法一键回退（env=messages 仍走 events），运维级开关形同虚设
M.mutate({
  name: '⑩ 环境变量被忽略（MINGDAO_EVENT_SOURCE 不生效）',
  file: 'src/config.js',
  from: [
    '  const fromEnv = eventSourceFromEnv();',
    '  return fromEnv ?? normalizeConfiguredEventSource(value);',
  ].join('\n'),
  to: '  return normalizeConfiguredEventSource(value); // 变异：忽略 MINGDAO_EVENT_SOURCE',
  expect: ['MINGDAO_EVENT_SOURCE=messages 必须退回旧行为', 'MINGDAO_EVENT_SOURCE=messages 必须优先于配置文件'],
  run: ES,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
