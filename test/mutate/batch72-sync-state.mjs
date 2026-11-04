// 批七十二（v0.7.0 §1.2「变异补盲」）：`src/sync.js` 的状态增量 / 冲突 / 边界变异。
//
// 这一批的目标不是"多几条命中"，而是把**单进程顺序调用永远看不到**的同步语义钉住：
//   · 状态增量合并（整份覆盖会丢并发进程刚记下的 remoteMtime）
//   · localMtime 一丢，增量推送退化成每轮全量重传
//   · 跳过条件少一个判据 → 本地改过的会话被静默跳过（远端永远停在旧内容）
//   · 增量拉取 / 冲突判定 / 首次推送不造虚假备份
//   · 三条边界：空会话、>20MB、恶意服务器返回的非法会话名
//
// 每条都真的在 `test/sync-state.js` 上跑一遍，必须**红**，且失败输出里出现对应 `E<n>：` 关键词。
// 用法：node test/mutate/batch72-sync-state.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/sync-state.js');

// ① 状态增量退回「整份覆盖」：并发/先后两次同步时，磁盘上别的会话记账被抹掉
M.mutate({
  name: '① 状态提交退回整份覆盖（丢掉别的会话 remoteMtime）',
  file: 'src/sync.js',
  from: ['  const cur = readState();', '  for (const k of keys) cur[k] = delta[k];', '  writeState(cur);'].join('\n'),
  to: ['  writeState(delta); // 变异：不再合并磁盘上的其它键'].join('\n'),
  expect: ['E15：状态增量必须保留'],
  run: RUN,
});

// ② 状态增量退回「字段合并」：同一会话的旧字段残留，删除语义失效
M.mutate({
  name: '② 状态增量改成字段合并（旧字段残留）',
  file: 'src/sync.js',
  from: '  for (const k of keys) cur[k] = delta[k];',
  to: '  for (const k of keys) cur[k] = { ...(cur[k] || {}), ...delta[k] }; // 变异：字段合并',
  expect: ['E15：同一会话是整键替换'],
  run: RUN,
});

// ③ 推送记账丢掉 localMtime：下一次同步无法判断"本地没变"，增量推送失效
M.mutate({
  name: '③ 推送不再记 localMtime（增量推送失效）',
  file: 'src/sync.js',
  from: '        delta[s.name] = { remoteMtime: r.mtime, localMtime: localStat.mtimeMs };',
  to: '        delta[s.name] = { remoteMtime: r.mtime }; // 变异：localMtime 丢失',
  expect: ['E2：推送后必须记下 localMtime'],
  run: RUN,
});

// ④ 跳过条件少一层：只看"远端记过账"，本地改过的会话被静默跳过 → 远端永远旧内容
M.mutate({
  name: '④ 推送跳过条件忽略 localMtime（本地改动被吞）',
  file: 'src/sync.js',
  from: '    if (prevState?.localMtime === localStat.mtimeMs && prevState?.remoteMtime) {',
  to: '    if (prevState?.remoteMtime) { // 变异：只看远端记账，忽略本地改动',
  expect: ['E4：本地内容变化后必须重推'],
  run: RUN,
});

// ⑤ 拉取取消增量判断：每次 sync 都重新下载全部会话
M.mutate({
  name: '⑤ 拉取取消增量判断（远端未变也重下）',
  file: 'src/sync.js',
  from: '    if (state[s.name]?.remoteMtime === s.mtime) continue;',
  to: '    if (false && state[s.name]?.remoteMtime === s.mtime) continue; // 变异：取消增量',
  expect: ['E11：跳过时不得再发 pull 请求'],
  run: RUN,
});

// ⑥ 拉取不再判冲突：本地内容被远端直接覆盖，且不留 .remote- 副本（丢数据）
M.mutate({
  name: '⑥ 拉取不再判冲突（本地内容被覆盖）',
  file: 'src/sync.js',
  from: '    if (local !== null && local !== r.content) {',
  to: '    if (false && local !== null && local !== r.content) { // 变异：不再判冲突',
  expect: ['E13：本地内容不同必须记为冲突'],
  run: RUN,
});

// ⑦ 去掉 20MB 上限：超大会话照传（半截/超时/服务端打爆）
M.mutate({
  name: '⑦ 推送去掉 20MB 上限',
  file: 'src/sync.js',
  from: ['    if (Buffer.byteLength(content) > 19 * 1024 * 1024) {', '      return { error: `${s.name} 超过 20MB 上限，跳过同步` };', '    }'].join('\n'),
  to: '    // 变异：去掉 20MB 上限',
  expect: ['E8：超过 20MB'],
  run: RUN,
});

// ⑧ 空会话也推送：刚创建、没写消息的会话被反复上传
M.mutate({
  name: '⑧ 空会话也推送（不发内容也发请求）',
  file: 'src/sync.js',
  from: ['    if (!rawContent.trim()) {', '      skipped.push(s.name); // 空会话文件（刚创建未写消息）不推送', '      continue;', '    }'].join('\n'),
  to: '    // 变异：空会话照推',
  expect: ['E7：空会话必须跳过'],
  run: RUN,
});

// ⑨ 不再校验远端返回的会话名：恶意服务器可用 `../` 把文件写出 sessions 目录
M.mutate({
  name: '⑨ 拉取不再校验远端会话名（路径穿越写盘）',
  file: 'src/sync.js',
  from: '    if (!isValidRemoteName(s.name)) continue; // 恶意服务器返回的非法名：跳过，绝不落盘',
  to: '    // 变异：不再校验远端返回的会话名',
  expect: ['E14：非法会话名必须被拒绝落盘'],
  run: RUN,
});

// ⑩ 首次推送也判冲突：凭空产生 .server- 备份（审计 B7 回归）
M.mutate({
  name: '⑩ 首次推送也判冲突（虚假 .server- 备份）',
  file: 'src/sync.js',
  from: '      if (lastMtime !== undefined && remote.content !== content && remote.mtime !== lastMtime) {',
  to: '      if (remote.content !== content && remote.mtime !== lastMtime) { // 变异：首次推送也判冲突',
  expect: ['E5：首次推送不得判冲突'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
