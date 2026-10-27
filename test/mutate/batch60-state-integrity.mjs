// 批六十（v0.6.28，minimax 报告 M-10 / M-11 / M-12 / M-17 / L-13）的变异验证。
//
// 五条缺陷的共同点是「状态的生命周期写错」——不是崩溃、不是丢包，而是**判据/锁的作用域不对**，
// 正常路径几乎看不出、只在特定交错下发生。因此本批把每处修复逐个改回缺陷，
// `test/state-integrity.js` 必须当场红（11 条，要求 ≥8）。
//
// 覆盖：
//   M-10（4 条）：工具进展不复位、模型内容不复位、阈值 >= 改 >、空轮根本不累计；
//   L-13（2 条）：每步不重置 finish、伪重置（finish = finish ?? null，看着像修了其实没修）；
//   M-17（2 条）：裸写 saveTaskState 不走锁、merge 退回无锁读-改-写；
//   M-11（1 条）：分片索引整片读-改-写无锁；
//   M-12（2 条）：去重无锁、追加无锁（两条路都会让并发写互相覆盖）。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/state-integrity.js');

// ① M-10：工具进展不再复位 → 「空-有进展-空-空」被累计成 3 次非连续空轮，误判中止
M.mutate({
  name: '① M-10 工具进展不复位 emptyRounds（非连续空轮被累计中止）',
  file: 'src/agent.js',
  from: [
    '          // v0.6.28（M-10）：有进展的工具轮复位空轮计数（失败/重复调用不算进展，与看门狗同判据）。',
    '          if (toolOk && repeatedBefore === 0) emptyRounds = 0;',
  ].join('\n'),
  to: '          // 变异：有进展的工具轮不再复位 emptyRounds',
  expect: ['空-有进展-空-空'],
  run: SUITE,
});

// ② M-10：有内容的模型轮不复位（失败工具不算进展，只能靠正文复位）
M.mutate({
  name: '② M-10 有内容的模型轮不复位 emptyRounds',
  file: 'src/agent.js',
  from: [
    '      // v0.6.28（M-10）：**有内容的模型轮**复位空轮计数。`finish === \'length\'` 的轮次不算',
    '      // （正文即使非空也是被截断的半截，正是本护栏要计数的形态），否则截断续写护栏会被清零。',
    '      if (String(res.text || \'\').trim() && res.finish !== \'length\') emptyRounds = 0;',
  ].join('\n'),
  to: '      // 变异：有内容的模型轮不再复位（只剩工具进展一条复位路）',
  expect: ['有内容的模型轮必须复位'],
  run: SUITE,
});

// ③ M-10：阈值从 >= 改成 >（边界错一轮：第 3 次空轮不再中止）
M.mutate({
  name: '③ M-10 空轮阈值 >= 改成 >（第 3 次不中止）',
  file: 'src/agent.js',
  from: [
    '        if (!res.text) {',
    '          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"（审计 Q1：与截断续写统一护栏）',
    '          emptyRounds += 1;',
    '          if (emptyRounds >= maxEmptyRounds) {',
  ].join('\n'),
  to: [
    '        if (!res.text) {',
    '          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"（审计 Q1：与截断续写统一护栏）',
    '          emptyRounds += 1;',
    '          if (emptyRounds > maxEmptyRounds) {',
  ].join('\n'),
  expect: ['连续 3 轮空输出'],
  run: SUITE,
});

// ④ M-10：空轮根本不累计（护栏彻底失效，一直续写到步数上限）
M.mutate({
  name: '④ M-10 空轮不累计（emptyRounds 恒为 0）',
  file: 'src/agent.js',
  from: [
    '        if (!res.text) {',
    '          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"（审计 Q1：与截断续写统一护栏）',
    '          emptyRounds += 1;',
  ].join('\n'),
  to: [
    '        if (!res.text) {',
    '          // 静默空输出（无工具无正文）：同样回填续写提示，避免界面"没动静"（审计 Q1：与截断续写统一护栏）',
    '          emptyRounds = 0; // 变异：空轮不累计',
  ].join('\n'),
  expect: ['连续 3 轮空输出'],
  run: SUITE,
});

// ⑤ L-13：每步不再重置 finish → 上一轮 length 残留，正常轮被判 truncated
M.mutate({
  name: '⑤ L-13 每步不重置 finish（上轮 length 残留）',
  file: 'src/agent.js',
  from: [
    '      steps += 1;',
    '      // v0.6.28（L-13）：`finish` 是**本次模型请求**的 finish_reason，不是回合级状态。',
    '      // 每步开始重置，且只由本步的 res.finish 写入（见下方赋值）——否则上一轮 length/capped',
    '      // 会残留到下一轮正常回复，把 `truncated`/`capped` 判给一次正常收尾。',
    '      finish = null;',
  ].join('\n'),
  to: ['      steps += 1;', '      // 变异：不再每步重置 finish'].join('\n'),
  expect: ['不得残留到正常轮'],
  run: SUITE,
});

// ⑥ L-13：伪重置（写一句看起来像重置、实际保留旧值的代码）
M.mutate({
  name: '⑥ L-13 伪重置 finish = finish ?? null（看着修了其实没修）',
  file: 'src/agent.js',
  from: ['      finish = null;', '      // v0.6.5（审计 BUG-025'].join('\n'),
  to: ['      finish = finish ?? null; // 变异：伪重置', '      // v0.6.5（审计 BUG-025'].join('\n'),
  expect: ['不得残留到正常轮'],
  run: SUITE,
});

// ⑦ M-17：裸写 saveTaskState 退回无锁整份写（持锁期间直接插进 merge 的临界区）
M.mutate({
  name: '⑦ M-17 saveTaskState 退回无锁整份写',
  file: 'src/task-state.js',
  from: '  return writeTaskStateLocked(sessionName, ts, false);',
  to: [
    '  let file;',
    '  try { file = taskStateFile(sessionName); } catch (err) { return { ok: false, error: String((err)?.message ?? err) }; }',
    '  fs.mkdirSync(taskStateDir(), { recursive: true, mode: 0o700 });',
    "  atomicWriteFileSync(file, JSON.stringify(ts) + '\\n', { mode: 0o600 });",
    '  return { ok: true, error: null }; // 变异：无锁整份写',
  ].join('\n'),
  expect: ['saveTaskState 必须真的等过持锁者'],
  run: SUITE,
});

// ⑧ M-17：merge 退回无锁读-改-写（后写者用陈旧快照覆盖前者刚合并的 artifacts）
M.mutate({
  name: '⑧ M-17 saveTaskStateMerge 退回无锁读-改-写',
  file: 'src/task-state.js',
  from: '  return writeTaskStateLocked(sessionName, ts, true);',
  to: [
    '  let file;',
    '  try { file = taskStateFile(sessionName); } catch (err) { return { ok: false, error: String((err)?.message ?? err) }; }',
    '  fs.mkdirSync(taskStateDir(), { recursive: true, mode: 0o700 });',
    "  atomicWriteFileSync(file, JSON.stringify(mergeTaskState(loadTaskState(sessionName), ts)) + '\\n', { mode: 0o600 });",
    '  return { ok: true, error: null }; // 变异：无锁读-改-写',
  ].join('\n'),
  expect: ['并发合并不得丢更新'],
  run: SUITE,
});

// ⑨ M-11：分片索引整片读-改-写无锁（并发同步互相覆盖，条目丢失）
M.mutate({
  name: '⑨ M-11 分片索引读-改-写去除分片锁',
  file: 'src/session-index.js',
  from: '      idx = lockFileSync(shardLockFile(k), () => syncShardGroup(k, group, dir));',
  to: '      idx = syncShardGroup(k, group, dir); // 变异：无锁整片写',
  expect: ['并发写同一分片不得丢条目'],
  run: SUITE,
});

// ⑩ M-12：去重退回无锁整份写（读与写之间追加的记忆被抹掉）
M.mutate({
  name: '⑩ M-12 dedupeMemory 退回无锁读-改-写',
  file: 'src/memory.js',
  from: ['  return lockFileSync(memoryLockFile(), () => {', '    const raw = loadMemory();'].join('\n'),
  to: ['  return ((/** @type {any} */ fn) => fn())(() => { // 变异：无锁去重', '    const raw = loadMemory();'].join('\n'),
  expect: ['并发追加 + 去重不得丢条目'],
  run: SUITE,
});

// ⑪ M-12：追加不走锁（去重持锁也挡不住锁外追加落进它的读-改-写窗口）
M.mutate({
  name: '⑪ M-12 appendMemory 退回无锁追加',
  file: 'src/memory.js',
  from: ['  lockFileSync(memoryLockFile(), () => {', '    appendFilePrivateSync(memoryFile(), add.map('].join('\n'),
  to: ['  ((/** @type {any} */ fn) => fn())(() => { // 变异：无锁追加', '    appendFilePrivateSync(memoryFile(), add.map('].join('\n'),
    // Windows 上没有 O_APPEND 之外的一致性保证：去掉锁之后，去重的原子替换会与并发的追加
  // 撞在同一个文件上，先以 EBUSY 暴露（同样是「未加锁」的后果，只是失败形态不同），
  // 因此这里接受 EBUSY 作为被抓到的证据；POSIX 上仍是原来的数据丢失断言。
  expect: ['并发追加 + 去重不得丢条目', 'EBUSY'],
  run: SUITE,
});

process.exit(M.report() ? 0 : 1);
