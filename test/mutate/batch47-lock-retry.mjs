// 批四十七（v0.6.23 §3.86：Windows 上锁/重命名遇 EACCES/EPERM 视为争用并重试）的变异验证。
//
// 本批把「瞬时拒绝 → 有界退避重试」的每一处修复逐个改回缺陷，test/smoke.js §156 必须当场红。
// 覆盖（任务书要求 ≥6 条，本批 9 条）：EACCES 当致命、EPERM 当致命、耗尽后折成锁超时、
// 预算缩到几十毫秒、rename 不重试、tmp 写入不重试、写失败被吞、成功返回值形状改变、
// 锁成功后不释放。
//
// 为什么每条都必须在 §156 里被抓到：这些 errno 在 macOS/Linux 上几乎不出现（本机注入是唯一
// 可复现手段），如果断言只覆盖「Windows 会红」，回归在 POSIX CI 上就会一路绿到发版。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEC = () => M.section('156');

// ① 把 EACCES 当致命：tryAcquire 不再把瞬时拒绝转成「争用」，saveTaskStateMerge 立刻 {ok:false}
M.mutate({
  name: '① 锁获取把 EACCES 当致命（不重试，直接失败）',
  file: 'src/atomic-write.js',
  from: "    if (code === 'EEXIST' || isTransientDenyCode(code)) return { ok: false, code, error: err };",
  to: "    if (code === 'EEXIST') return { ok: false, code, error: err };",
  expect: ['锁获取遇 EACCES 必须视为争用重试'],
  run: SEC,
});

// ② 只把 EACCES 当争用、漏掉 EPERM（Windows 杀软/索引器更常见的那一种）
M.mutate({
  name: '② 锁获取把 EPERM 当致命（瞬时机集合漏掉 EPERM）',
  file: 'src/atomic-write.js',
  from: "const TRANSIENT_DENY_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);",
  to: "const TRANSIENT_DENY_CODES = new Set(['EACCES', 'EBUSY']);",
  expect: ['锁获取遇 EPERM 也必须重试'],
  run: SEC,
});

// ③ 重试耗尽后折成「锁超时」——把权限/杀软问题伪装成死锁，归因信息丢失
M.mutate({
  name: '③ 重试耗尽折成「锁超时」（丢弃原始 errno）',
  file: 'src/atomic-write.js',
  from: [
    '        if (!transientSince) transientSince = Date.now();',
    '        if (Date.now() - transientSince >= TRANSIENT_RETRY_BUDGET_MS) throw got.error;',
    '      }',
    '      sleepMs(delay);',
  ].join('\n'),
  to: [
    '        if (!transientSince) transientSince = Date.now();',
    '        if (Date.now() - transientSince >= TRANSIENT_RETRY_BUDGET_MS) throw lockTimeoutError(lockPath, timeoutMs);',
    '      }',
    '      sleepMs(delay);',
  ].join('\n'),
  expect: ['失败必须带原始 errno 文本'],
  run: SEC,
});

// ④ 瞬时预算缩到 50ms：Windows 杀软扫描窗口（数百 ms）还没过去就放弃
M.mutate({
  name: '④ 瞬时拒绝预算缩到 50ms（等不到杀软扫描结束）',
  file: 'src/atomic-write.js',
  from: 'const TRANSIENT_RETRY_BUDGET_MS = 2000;',
  to: 'const TRANSIENT_RETRY_BUDGET_MS = 50;',
  expect: ['瞬时拒绝的重试预算应接近 2s'],
  run: SEC,
});

// ⑤ 原子写的 rename 不重试：Windows 上 .tmp 被扫描时直接失败
M.mutate({
  name: '⑤ rename 遇 EPERM 不重试（原子写直接失败）',
  file: 'src/atomic-write.js',
  from: '    retryTransientSync(() => fs.renameSync(tmp, target), deadline);',
  to: '    fs.renameSync(tmp, target);',
  expect: ['rename 遇 EPERM 必须重试后成功'],
  run: SEC,
});

// ⑥ 原子写的 tmp 写入不重试：杀软扫描刚创建的文件时 EACCES 直接失败
M.mutate({
  name: '⑥ tmp 写入遇 EACCES 不重试',
  file: 'src/atomic-write.js',
  from: '    retryTransientSync(() => fs.writeFileSync(tmp, data, options), deadline);',
  to: '    fs.writeFileSync(tmp, data, options);',
  expect: ['tmp 写入遇 EACCES 必须重试后成功'],
  run: SEC,
});

// ⑦ 原子写失败被吞：caller 以为写成功（本仓反复登记过的「假成功」形态）
M.mutate({
  name: '⑦ 原子写失败被静默吞掉（不 rethrow）',
  file: 'src/atomic-write.js',
  from: [
    '  } catch (err) {',
    '    try {',
    '      fs.unlinkSync(tmp);',
    '    } catch {}',
    '    throw err;',
    '  }',
    '}',
  ].join('\n'),
  to: [
    '  } catch (err) {',
    '    try {',
    '      fs.unlinkSync(tmp);',
    '    } catch {}',
    '  }',
    '}',
  ].join('\n'),
  expect: ['rename 持续 EPERM 必须抛出原始 errno'],
  run: SEC,
});

// ⑧ 成功返回值形状变了（少了 error:null）——调用方/测试的字段契约被破坏
M.mutate({
  name: '⑧ 成功返回值少了 error:null（形状不兼容）',
  file: 'src/task-state.js',
  from: [
    "    atomicWriteFileSync(taskStateFile(sessionName), JSON.stringify(ts) + '\\n', { mode: 0o600 });",
    '    return { ok: true, error: null };',
  ].join('\n'),
  to: [
    "    atomicWriteFileSync(taskStateFile(sessionName), JSON.stringify(ts) + '\\n', { mode: 0o600 });",
    '    return { ok: true };',
  ].join('\n'),
  expect: ['成功路径的返回值必须仍是'],
  run: SEC,
});

// ⑨ 锁成功后不释放：下一次写要白等到 5s 超时（并发下直接退化成 6/8）
M.mutate({
  name: '⑨ 锁成功后不释放（后续写白等到超时）',
  file: 'src/atomic-write.js',
  from: [
    '          return fn();',
    '        } finally {',
    '          held.delete(lockPath);',
    '          releaseLock(lockPath);',
    '        }',
  ].join('\n'),
  to: [
    '          return fn();',
    '        } finally {',
    '          held.delete(lockPath);',
    '        }',
  ].join('\n'),
  expect: ['成功后锁文件必须被释放'],
  run: SEC,
});
