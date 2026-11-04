// 批七十（v0.7.0 §1.4）：请求路径去同步锁的变异验证。
//
// 每条变异把「异步入口 / 异步锁 / 正确性 / CLI 同步版」中的一处改回缺陷形态，
// `test/request-path-locks.js` 必须当场红，且失败输出里必须出现 expect 里的**断言关键词**。
// 覆盖：异步改回同步（冻结）、去掉锁（不等）、超时/错误返回空、Web 路由退回同步入口、
//       异步入口被摘掉 async、CLI 同步版被误改成 async、sync.js 请求路径退回同步提交。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/request-path-locks.js');

M.mutate({
  name: '① listSchedulesAsync 改回同步锁（事件循环冻结）',
  file: 'src/schedule.js',
  from: '  return withFileLock(scheduleLockFile(home), () => readSchedulesUnlocked(home));',
  to: '  return withFileLockSync(scheduleLockFile(home), () => readSchedulesUnlocked(home));',
  expect: ['异步版等待期间事件循环不得冻结'],
  run: RUN,
});

M.mutate({
  name: '② listSchedulesAsync 去掉锁（持锁期间直接返回，根本没等）',
  file: 'src/schedule.js',
  from: '  return withFileLock(scheduleLockFile(home), () => readSchedulesUnlocked(home));',
  to: '  return readSchedulesUnlocked(home);',
  expect: ['异步版必须真的等到持锁方释放'],
  run: RUN,
});

M.mutate({
  name: '③ 异步版"超时/出错就返回空"（锁释放后仍给空结果）',
  file: 'src/schedule.js',
  from: '  return withFileLock(scheduleLockFile(home), () => readSchedulesUnlocked(home));',
  to: '  return withFileLock(scheduleLockFile(home), () => []);',
  expect: ['必须返回锁释放后的真实结果'],
  run: RUN,
});

M.mutate({
  name: '④ CLI 同步版 pauseSchedule 被去锁（对照失效，读-改-写也不再互斥）',
  file: 'src/schedule.js',
  from: '  return withFileLockSync(scheduleLockFile(home), () => {\n    const job = readSchedule(home, id);\n    if (!job) return false;\n    writeSchedule(home, { ...job, status: \'paused\', pid: null, lastTaskId: null });\n    return true;\n  });',
  to: '  const job = readSchedule(home, id);\n  if (!job) return false;\n  writeSchedule(home, { ...job, status: \'paused\', pid: null, lastTaskId: null });\n  return true;',
  expect: ['对照前提：同步版必须被持锁方挡住'],
  run: RUN,
});

M.mutate({
  name: '⑤ Web 路由退回同步入口 listSchedules（请求路径同步锁）',
  file: 'src/web/routes/domains/schedule.js',
  from: '    const jobs = (await listSchedulesAsync(home)).map((j) => ({',
  to: '    const jobs = (listSchedules(home)).map((j) => ({',
  expect: ['不得调用同步入口 listSchedules('],
  run: RUN,
});

M.mutate({
  name: '⑥ tasks 回收路径退回同步 reapTasks（/api/tasks 冻结）',
  file: 'src/tasks.js',
  from: '      await reapTasksAsync(home, {});',
  to: '      reapTasks(home, {});',
  expect: ['tasks 异步回收等待期间事件循环不得冻结'],
  run: RUN,
});

M.mutate({
  name: '⑩ patchTaskAsync 改回同步锁（异步入口名存实亡）',
  file: 'src/tasks.js',
  from: '  return withFileLock(tasksLockFile(home), () => applyTaskPatch(home, id, patch, terminal));',
  to: '  return withFileLockSync(tasksLockFile(home), () => applyTaskPatch(home, id, patch, terminal));',
  expect: ['异步入口必须使用 async withFileLock'],
  run: RUN,
});

M.mutate({
  name: '⑦ sync.js 请求路径退回同步 commitState（/api/sync 冻结）',
  file: 'src/sync.js',
  from: '  await commitStateAsync(delta);',
  to: '  commitState(delta);',
  expect: ['三个业务入口'],
  run: RUN,
});

M.mutate({
  name: '⑧ CLI 同步版 listSchedules 被误改成 async（返回值语义破坏）',
  file: 'src/schedule.js',
  from: 'export function listSchedules(',
  to: 'export async function listSchedules(',
  expect: ['listSchedules 必须同步返回数组'],
  run: RUN,
});

M.mutate({
  name: '⑨ listTasksAsync 不再导出（异步入口消失，调用方拿不到 await 语义）',
  file: 'src/tasks.js',
  from: 'export async function listTasksAsync(',
  to: 'async function listTasksAsync(',
  expect: ['必须提供 listTasksAsync'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
