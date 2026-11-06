// 批七十九（v0.6.39）：安装包裁剪的纯语义（版本解析 / 数值比较 / 保留 N 版 / 未知文件不碰）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/prune-downloads.js');

M.mutate({
  name: '① 版本号按字符串比较（0.6.10 被当成比 0.6.9 旧 → 删错版本）',
  file: 'scripts/prune-downloads.mjs',
  // 注意：把 `.map(Number)` 去掉**不会**改变行为（循环里做的是减法，字符串会被强制转数字），
  // 必须真的改成字典序比较才会暴露。
  from: "    const d = (pa[i] || 0) - (pb[i] || 0);",
  to: "    const d = String(pa[i] || 0) < String(pb[i] || 0) ? -1 : String(pa[i] || 0) > String(pb[i] || 0) ? 1 : 0; // 变异：字典序",
  expect: ['0.6.10 > 0.6.9'],
  run: RUN,
});

M.mutate({
  name: '② 版本号取错（取到文件名里第一个数字段）',
  file: 'scripts/prune-downloads.mjs',
  from: "  const m = String(name).match(/(\\d+\\.\\d+\\.\\d+)/);",
  to: "  const m = String(name).match(/(\\d+)/); // 变异：只取第一段数字",
  expect: ['从文件名取版本'],
  run: RUN,
});

M.mutate({
  name: '③ 保留数取反（keep 变成"删掉最新"）',
  file: 'scripts/prune-downloads.mjs',
  from: '  const keepSet = new Set(versions.slice(0, n));',
  to: '  const keepSet = new Set(versions.slice(n)); // 变异：留下最旧的',
  expect: ['保留最新 2 个版本'],
  run: RUN,
});

M.mutate({
  name: '④ 不认识的文件也一并删除（清单/统计文件被误删）',
  file: 'scripts/prune-downloads.mjs',
  from: "    if (!v) { unknown.push(f); continue; }",
  to: "    if (!v) { continue; } // 变异：无版本号的文件被静默丢弃（既不留也不报）",
  expect: ['无版本号的文件一律不碰'],
  run: RUN,
});

M.mutate({
  name: '⑤ 版本排序方向反了（新→旧 变 旧→新）',
  file: 'scripts/prune-downloads.mjs',
  from: "  const versions = [...byVersion.keys()].sort(compareVersion).reverse(); // 新 → 旧",
  to: "  const versions = [...byVersion.keys()].sort(compareVersion); // 变异：旧 → 新",
  expect: ['版本按新→旧排序'],
  run: RUN,
});
