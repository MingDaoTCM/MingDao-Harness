// 批五十五（v0.6.26 §3.95：发版校验 `verify-release` 的两处工具债）的变异验证。
//
// 两处已确认的误报：
// ① 网络失败（超时/DNS/HTTP 5xx）被渲染成「四平台未对齐」→ 本该 exit 2 被弄成 1；
// ② peel 拿不到 `tag^{}` 时回退比较未 peel 的 tag 对象 → 与 main 的提交必然不等 → 假 mismatch。
// 修法：三态（ok/mismatch/unreachable）+ `--retry` 只重试 unreachable + peel 失败按 unreachable；
// 本批把每一处逐个改回缺陷，test/verify-release.js 必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/verify-release.js');

// ① unreachable 归成 mismatch：一次网络抖动又变成 exit 1「发布未完成」
M.mutate({
  name: '① unreachable 归成 mismatch（exit 2 → 1）',
  file: 'scripts/verify-release.mjs',
  from: '  const mismatches = normalized.filter((c) => c.status === STATUS.MISMATCH);',
  to: '  const mismatches = normalized.filter((c) => c.status !== STATUS.OK);',
  expect: ['一个 unreachable 必须 exit 2（不是 1）'],
  run: RUN,
});

// ② peel 失败回退比较 tag 对象：tag 对象 ≠ 提交，必然「不一致」
M.mutate({
  name: '② peel 失败回退比较未 peel 的 tag 对象',
  file: 'scripts/verify-release.mjs',
  from: '    if (unpeeled.sha === localTag) return done(unpeeled.sha);',
  to: '    return done(unpeeled.sha);',
  expect: ['peel 失败必须按 unreachable（exit 2），不得回退比较 tag 对象'],
  run: RUN,
});

// ③ retry 对 mismatch 也生效：真不一致被反复重试，拖慢发版且掩盖问题性质
M.mutate({
  name: '③ retry 对 mismatch 也生效',
  file: 'scripts/verify-release.mjs',
  from: '    if (result.status !== STATUS.UNREACHABLE) return { result, attempts };',
  to: '    if (result.status === STATUS.OK) return { result, attempts };',
  expect: ['mismatch 不允许重试（重试只服务于网络抖动）'],
  run: RUN,
});

// ④ 读失败不归类为 unreachable：超时/TLS/代理又变成 mismatch
M.mutate({
  name: '④ 读失败不归类为 unreachable（超时 → mismatch）',
  file: 'scripts/verify-release.mjs',
  from: '  if (read && read.error) return STATUS.UNREACHABLE;',
  to: '  if (read && read.error) return STATUS.MISMATCH;',
  expect: ['超时必须归类为 unreachable（不是 mismatch）', '任何 git 读失败（含 TLS/代理/凭据）都归 unreachable，不是 mismatch'],
  run: RUN,
});

// ⑤ exit code 映射错：mismatch 与 unreachable 的 1/2 对调
M.mutate({
  name: '⑤ exit code 映射错（1 与 2 对调）',
  file: 'scripts/verify-release.mjs',
  from: '  const exitCode = mismatches.length ? 1 : unreachable.length ? 2 : 0;',
  to: '  const exitCode = mismatches.length ? 2 : unreachable.length ? 1 : 0;',
  expect: ['一个 mismatch 必须 exit 1'],
  run: RUN,
});

// ⑥ unreachable 文案退回「发布可能有问题」：丢掉「不是发布失败」这句关键提示
M.mutate({
  name: '⑥ unreachable 文案丢掉「不是发布失败」',
  file: 'scripts/verify-release.mjs',
  from: '    err.push(`✗ 取不到（网络/服务不可达）：${classified.unreachable.length} 项——这不是发布失败，请重试`);',
  to: '    err.push(`✗ 取不到（网络/服务不可达）：${classified.unreachable.length} 项——发布可能有问题`);',
  expect: ['unreachable 文案必须写明「不是发布失败」'],
  run: RUN,
});

// ⑦ unreachable 不重试：--retry 形同虚设，一次抖动就 exit 2
M.mutate({
  name: '⑦ unreachable 不重试（--retry 形同虚设）',
  file: 'scripts/verify-release.mjs',
  from: '  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {',
  to: '  for (let attempt = 0; attempt < 1; attempt += 1) {',
  expect: ['unreachable 必须按 --retry 重试（1 次初始 + 2 次重试）'],
  run: RUN,
});

if (!M.report()) process.exit(1);
