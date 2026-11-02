// 批六十五（v0.6.30，E1–E5 文件锁 / 写完整性）的变异验证。
//
// 五类缺陷共同点：正常路径看不出来，只在**争用 / 失败 / 掉电 / 坏条目**下暴露；一旦暴露就是
// 数据级后果（消息凭空消失、唯一索引副本被删、WebUI 冻结 2 秒、写到 0 字节、会话列表整体清空）。
// 本批把每处修复逐个改回缺陷，`test/fs-integrity-hardening.js` 必须当场红（≥10 条）。
//
// 覆盖：
//   E1（2 条）：cleanup 无条件 delete、cleanup 永不 delete；
//   E2（2 条）：saveShard 的 {ok:false} 不参与 allOk、迁移失败不打印可见日志；
//   E3（3 条）：异步分片锁退回同步、/api/memory 去重不 await、会话收尾退回同步 append；
//   E4（5 条）：文件 fsync 被删、目录 fsync 被删（Windows 无目录 fsync，按平台跳过）、
//              Windows chmod 兜底被删、chmod 失败无可见 warning、失败路径不清理 tmp；
//   E5（2 条）：不可 stat 的条目不计入 skipped、跳过时不打印可见 warning。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/fs-integrity-hardening.js');

// ① E1：cleanup 回到「无条件 delete」（A 完成时删掉 B/C 的链 → 第 4 个并发与 B 重叠）
M.mutate({
  name: '① E1 withSessionLock cleanup 无条件 delete（第 4 个并发互斥失效）',
  file: 'src/web/server.js',
  from: [
    '    tail.then(() => {',
    '      if (sessionLocks.get(file) === tail) sessionLocks.delete(file);',
    '    });',
  ].join('\n'),
  to: [
    '    tail.then(() => {',
    '      sessionLocks.delete(file); // 变异：无条件删除（回到 v0.6.29 的缺陷）',
    '    });',
  ].join('\n'),
  expect: ['E1：A/B/C/D 不得重叠'],
  run: RUN,
});

// ② E1：cleanup 永不 delete（链仍在，但 map 条目永久残留 → 内存泄漏）
M.mutate({
  name: '② E1 withSessionLock cleanup 永不清理（sessionLocks 无界增长）',
  file: 'src/web/server.js',
  from: [
    '    tail.then(() => {',
    '      if (sessionLocks.get(file) === tail) sessionLocks.delete(file);',
    '    });',
  ].join('\n'),
  to: "    tail.then(() => { /* 变异：不清理 */ });",
  expect: ['E1：全部完成后 sessionLocks 应为空'],
  run: RUN,
});

// ③ E2：saveShard 的 {ok:false} 不参与 allOk → 迁移失败仍删唯一副本
M.mutate({
  name: '③ E2 迁移失败仍删旧索引（saveShard 的 {ok:false} 被忽略）',
  file: 'src/session-index.js',
  from: [
    '        lockFileSync(shardLockFile(shard), () => {',
    '          const r = migrateOneEntry(name, entry, shard);',
    '          // E2：saveShard 失败返回 {ok:false} 不抛——不显式参与判定，allOk 会一直是 true。',
    '          if (!r.ok) allOk = false;',
    '        });',
  ].join('\n'),
  to: [
    '        lockFileSync(shardLockFile(shard), () => {',
    '          const r = migrateOneEntry(name, entry, shard);',
    '          void r; // 变异：saveShard 失败不参与 allOk 判定',
    '        });',
  ].join('\n'),
  expect: ['E2：迁移不完整时必须保留旧索引文件'],
  run: RUN,
});

// ④ E2：迁移失败不再打印可见日志（旧文件虽保留，但用户完全无感）
M.mutate({
  name: '④ E2 迁移失败不打印可见日志（静默保留）',
  file: 'src/session-index.js',
  from: ['  try {', '    console.warn(', '      `[MingDao] ⚠ 会话索引迁移未完成'].join('\n'),
  to: ['  try {', '    if (false) console.warn(', '      `[MingDao] ⚠ 会话索引迁移未完成'].join('\n'),
  expect: ['E2：必须打印可见的迁移未完成日志'],
  run: RUN,
});

// ⑤ E3：WebUI 会话检索的异步分片锁退回同步版（锁争用冻结事件循环）
M.mutate({
  name: '⑤ E3 syncSessionIndexAsync 退回同步锁（请求路径冻结事件循环）',
  file: 'src/session-index.js',
  from: '      idx = await withFileLock(shardLockFile(k), () => syncShardGroup(k, group, dir));',
  to: '      idx = lockFileSync(shardLockFile(k), () => syncShardGroup(k, group, dir)); // 变异：请求路径退回同步锁',
  expect: ['E3：异步版等待期间不得冻结事件循环'],
  run: RUN,
});

// ⑥ E3：/api/memory 去重退回同步入口（不 await 异步版）
M.mutate({
  name: '⑥ E3 /api/memory 去重不再 await 异步版',
  file: 'src/web/routes/domains/misc.js',
  from: '      const removed = await dedupeMemoryAsync();',
  to: '      const removed = dedupeMemoryAsync(); // 变异：不 await（请求路径退化为同步语义）',
  expect: ['E3：/api/memory 去重必须 await dedupeMemoryAsync'],
  run: RUN,
});

// ⑦ E3：会话收尾退回同步 appendMemory（WebUI 收尾路径上的同步锁）
M.mutate({
  name: '⑦ E3 会话收尾退回同步 appendMemory',
  file: 'src/memory.js',
  from: '      if (lines.length) await appendMemoryAsync(lines);',
  to: '      if (lines.length) appendMemory(lines); // 变异：收尾退回同步锁',
  expect: ['E3：会话收尾必须 await appendMemoryAsync'],
  run: RUN,
});

// ⑧ E4：写临时文件后不再 fsync 文件（rename 可能先于数据落盘）
M.mutate({
  name: '⑧ E4 临时文件写入后不 fsync（掉电可能得到 0 字节/半截）',
  file: 'src/atomic-write.js',
  from: ['      fs.fsyncSync(fd);', '      result.fileFsync = true;'].join('\n'),
  to: '      result.fileFsync = true; // 变异：写后不 fsync 文件',
  expect: ['E4：写临时文件后必须 fsync'],
  run: RUN,
});

// ⑨ E4：rename 后不再 fsync 目录（目录项未落盘，崩溃后仍可能看到旧目标）
//
// Windows 上**不可验证**：Windows 不支持对目录 fsync（本实现按任务书 try/catch 跳过并标记），
// 套件在 win32 下断言的是 `dirFsync === 'skipped'`，没有观测面。如实跳过，不让整条腿假红。
const mutateUnlessWindows = (m) => {
  if (process.platform === 'win32') {
    console.log(`⚠ 跳过：${m.name}（Windows 无目录 fsync 语义，套件同一用例按平台分支）`);
    return;
  }
  M.mutate(m);
};
mutateUnlessWindows({
  name: '⑨ E4 rename 后不 fsync 目录',
  file: 'src/atomic-write.js',
  from: ['        fs.fsyncSync(dfd);', '        result.dirFsync = true;'].join('\n'),
  to: '        result.dirFsync = true; // 变异：不 fsync 目录',
  expect: ['E4：rename 后必须 fsync 目录'],
  run: RUN,
});

// ⑩ E4：Windows 权限兜底被删（open(mode) 在 Windows 上不生效，实测 0666）
M.mutate({
  name: '⑩ E4 Windows 不补 chmod（权限收不回来）',
  file: 'src/atomic-write.js',
  from: [
    '    if (process.platform === \'win32\') {',
    '      try {',
    '        fs.chmodSync(target, wantedMode);',
    '        result.chmod = \'applied\';',
  ].join('\n'),
  to: [
    '    if (false) {',
    '      try {',
    '        fs.chmodSync(target, wantedMode);',
    '        result.chmod = \'applied\';',
  ].join('\n'),
  expect: ['E4：Windows 模拟必须走 chmod 兜底'],
  run: RUN,
});

// ⑪ E4：chmod 失败不留可见 warning（静默失败，用户以为权限已收）
M.mutate({
  name: '⑪ E4 chmod 失败无可见 warning',
  file: 'src/atomic-write.js',
  from: [
    '        result.chmod = \'failed\';',
    '        result.warnings.push(`chmod ${wantedMode.toString(8)} 失败（${target}）：${/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message || err}`);',
  ].join('\n'),
  to: "        result.chmod = 'failed'; // 变异：不记 warning",
  expect: ['E4：chmod 失败必须有可见 warning'],
  run: RUN,
});

// ⑫ E4：失败路径不清理临时文件（半截 .tmp 永久残留）
M.mutate({
  name: '⑫ E4 失败路径不清理临时文件',
  file: 'src/atomic-write.js',
  from: ['    try {', '      fs.unlinkSync(tmp);', '    } catch {}'].join('\n'),
  to: '    // 变异：失败路径不清理 tmp',
  expect: ['E4：失败路径必须清理临时文件'],
  run: RUN,
});

// ⑬ E5：不可 stat 的条目被静默丢弃（不计数 → 用户不知道少了几条）
M.mutate({
  name: '⑬ E5 不可 stat 的条目不计入 skipped',
  file: 'src/session.js',
  from: [
    '    } catch (err) {',
    '      skipped.push({ file, name: f, error: String(/** @type {any} */ (err)?.code || /** @type {any} */ (err)?.message || err) });',
    '    }',
  ].join('\n'),
  to: ['    } catch (err) {', '      void err; // 变异：失败条目既不返回也不计数', '    }'].join('\n'),
  expect: ['E5：1 个不可 stat 的文件必须计入 skipped'],
  run: RUN,
});

// ⑭ E5：跳过时不打印可见 warning（列表静默变短）
M.mutate({
  name: '⑭ E5 跳过文件不打印可见 warning',
  file: 'src/session.js',
  from: '  if (skipped.length) {',
  to: '  if (false) { // 变异：跳过时不再告警',
  expect: ['E5：必须打印可见 warning'],
  run: RUN,
});

process.exit(M.report() ? 0 : 1);
