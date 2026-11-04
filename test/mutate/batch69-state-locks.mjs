// 批六十九（v0.7.0 §1.3，持久状态「锁 + 原子写」）的变异验证。
//
// 六类缺陷共同点：单进程顺序调用永远绿，只在**真并发 / 写中崩溃 / 权限失败**下暴露；
// 一旦暴露就是用户能直接感知的数据丢失。本批把每处修复逐个改回缺陷，
// `test/state-locks.js` 必须当场红（≥8 条），且失败输出里必须出现对应断言原文关键词。
//
// 覆盖：
//   ① config 退回无锁（16 路并发互相覆盖）；
//   ② config 锁内不重读（用陈旧快照整份覆盖）；
//   ③ credentials setStoredKey 退回无锁（并发两把 Key 丢一把）；
//   ④ model-cache 退回截断式直写（写中 kill -9 留下半截 JSON）；
//   ⑤ endpoint-limits 退回无锁读-改-写（整表覆盖，别的端点学习值丢失）；
//   ⑥ ledger append 退回无锁（外部持锁也照写 → 互斥失效）；
//   ⑦ egress 退回「读全文 → 覆盖写」且无锁（并发丢行）；
//   ⑧ egress 只删锁（append 仍在 → 外部持锁拦不住）；
//   ⑨ config 写失败 warn 被吞（用户无感）；
//   ⑩ model-cache 写失败 warn 被吞。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/state-locks.js');

// ① 无锁 saveConfig：16 路各读同一份旧快照再整份写回 → 只剩最后一个键
M.mutate({
  name: '① config saveConfig 退回无锁（并发写各键互相覆盖）',
  file: 'src/config.js',
  from: '    withStateFileLockSync(configLockFile(), () => {',
  to: '    ((fn) => fn())(() => { // 变异：退回无锁',
  expect: ['E1：16 路并发 saveConfig'],
  run: RUN,
});

// ② 锁内不重读：锁还在，但直接把调用方手里的陈旧 cfg 整份落盘
M.mutate({
  name: '② config 锁内不重读（陈旧快照整份覆盖）',
  file: 'src/config.js',
  from: '      writeConfigUnlocked(prepareConfigForWrite(cfg));',
  to: '      writeConfigUnlocked(cfg); // 变异：不重读磁盘、不合并增量',
  expect: ['E1：16 路并发 saveConfig'],
  run: RUN,
});

// ③ credentials 退回无锁读-改-写：并发 setKey 两个 provider 只留一把
M.mutate({
  name: '③ credentials setStoredKey 退回无锁（并发两把 Key 丢一把）',
  file: 'src/credentials.js',
  from: [
    'export function setStoredKey(providerName, key) {',
    '  try {',
    '    ensureHome();',
    '    return withStateFileLockSync(credentialsLockFile(), () => {',
  ].join('\n'),
  to: [
    'export function setStoredKey(providerName, key) {',
    '  try {',
    '    ensureHome();',
    '    return ((fn) => fn())(() => { // 变异：退回无锁',
  ].join('\n'),
  expect: ['E2：并发 setKey 两个 provider'],
  run: RUN,
});

// ④ model-cache 退回截断式直写：写中 kill -9 → 目标文件半截、JSON.parse 失败
M.mutate({
  name: '④ model-cache 退回截断式直写（崩溃留下半截 JSON）',
  file: 'src/config.js',
  from: "  atomicWriteFileSync(path.join(mingdaoHome(), 'model-cache.json'), JSON.stringify(data, null, 2) + '\\n', { mode: 0o600 });",
  to: "  fs.writeFileSync(path.join(mingdaoHome(), 'model-cache.json'), JSON.stringify(data, null, 2) + '\\n', { mode: 0o600 }); // 变异：截断式直写",
  expect: ['E3：写中 kill -9'],
  run: RUN,
});

// ⑤ endpoint-limits 退回无锁 RMW：两个进程各拿旧表整表覆盖
M.mutate({
  name: '⑤ endpoint-limits 退回无锁读-改-写（整表覆盖别的端点）',
  file: 'src/providers/index.js',
  from: '    return withStateFileLockSync(endpointLimitsLockFile(), () => {',
  to: '    return ((fn) => fn())(() => { // 变异：退回无锁',
  expect: ['E4：并发学习不同 baseUrl'],
  run: RUN,
});

// ⑥ ledger append 退回无锁：外部持锁也照写 → 互斥语义消失
M.mutate({
  name: '⑥ ledger append 退回无锁（外部持锁拦不住）',
  file: 'src/ledger.js',
  from: "      withStateFileLockSync(ledgerLockFile(runId), () => appendFilePrivateSync(runFile(runId), line + '\\n'));",
  to: "      appendFilePrivateSync(runFile(runId), line + '\\n'); // 变异：退回无锁 append",
  expect: ['E5b：账本追加必须持锁'],
  run: RUN,
});

// ⑦ egress 退回「读全文 → 覆盖写」且无锁：并发丢行 + 外部持锁拦不住
M.mutate({
  name: '⑦ egress 退回无锁「读全文 → 覆盖写」（并发丢行）',
  file: 'src/net-guard.js',
  from: [
    '    withStateFileLockSync(egressLogLockFile(), () => {',
    "      appendFilePrivateSync(file, JSON.stringify(entry) + '\\n');",
    '      // 低频轮转（与 audit.jsonl 同款策略：按大小触发 + 持锁原子替换）：只保留最近 KEEP_LINES 行。',
    '      // **禁止**无锁「读全文 → 覆盖写」——那不是追加，而是把并发写进去的行静默丢掉。',
    '      if (fs.statSync(file).size > MAX_BYTES) {',
    "        const lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);",
    '        if (lines.length > MAX_LINES) {',
    "          atomicWriteFileSync(file, lines.slice(-KEEP_LINES).join('\\n') + '\\n', { mode: 0o600 });",
    '        }',
    '      }',
    '    });',
  ].join('\n'),
  to: [
    '    // 变异：退回「读全文 → 覆盖写」（无锁）',
    "    const prevText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';",
    "    atomicWriteFileSync(file, prevText + JSON.stringify(entry) + '\\n', { mode: 0o600 });",
  ].join('\n'),
  expect: ['E6a：并发 50 条出网日志'],
  run: RUN,
});

// ⑧ egress 只删锁（append 仍在）：并发 append 本身不丢行，但外部持锁语义失效
M.mutate({
  name: '⑧ egress 追加退回无锁（外部持锁拦不住）',
  file: 'src/net-guard.js',
  from: '    withStateFileLockSync(egressLogLockFile(), () => {',
  to: '    ((fn) => fn())(() => { // 变异：退回无锁',
  expect: ['E6b：出网日志追加必须持锁'],
  run: RUN,
});

// ⑨ config 写失败 warn 被吞：注入 EACCES 后用户完全无感（只返回失败）
M.mutate({
  name: '⑨ config 写失败不再 warn（静默失败）',
  file: 'src/config.js',
  from: '    console.warn(`[MingDao] ⚠ 配置写入失败（${configPath()}）：${msg}——本次修改未保存，请检查磁盘空间/目录权限后重试。`);',
  to: '    void msg; // 变异：吞掉可见 warn',
  expect: ['E7：写失败必须可见 warn'],
  run: RUN,
});

// ⑩ model-cache 写失败 warn 被吞
M.mutate({
  name: '⑩ model-cache 写失败不再 warn（静默失败）',
  file: 'src/config.js',
  from: "    console.warn(`[MingDao] ⚠ model-cache.json 写入失败（${path.join(mingdaoHome(), 'model-cache.json')}）：${msg}——本次模型名单缓存未更新（不影响本次对话，下次拉取会重试）。`);",
  to: '    void msg; // 变异：吞掉可见 warn',
  expect: ['E7：写失败必须可见 warn'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
