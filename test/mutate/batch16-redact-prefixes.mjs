// 批十七（v0.6.8：脱敏器前缀表 / 下游 Dify 反馈）的变异验证。
// 每个变异都把"修复"改回缺陷，看 §130 的对应断言是否当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('130');

M.mutate({
  name: '① 删掉 Dify app- 那一行（回到"表里没有它"）',
  file: 'src/redact.js',
  from: "  { vendor: 'Dify 应用 Key', re: /\\bapp-[A-Za-z0-9]{20,}/g, mask: 'app-***', sample: sampleOf('app-') },\n",
  to: '',
  expect: ['前缀表必须存在且至少 4 行', '同口径掩码'],
  run: SEC,
});

M.mutate({
  name: '② 替换循环只跑第一行（后加的前缀静默失效）',
  file: 'src/redact.js',
  from: '  for (const { re, mask } of SECRET_PREFIXES) s = s.replace(re, mask);',
  to: '  s = s.replace(SECRET_PREFIXES[0].re, SECRET_PREFIXES[0].mask);',
  expect: ['必须被掩码', '同口径掩码'],
  run: SEC,
});

M.mutate({
  name: '③ app- 正则放宽到含 `-`（误伤普通标识）',
  file: 'src/redact.js',
  from: "  { vendor: 'Dify 应用 Key', re: /\\bapp-[A-Za-z0-9]{20,}/g, mask: 'app-***', sample: sampleOf('app-') },",
  to: "  { vendor: 'Dify 应用 Key', re: /\\bapp-[A-Za-z0-9-]{20,}/g, mask: 'app-***', sample: sampleOf('app-') },",
  expect: ['不得误掩普通标识'],
  run: SEC,
});

M.mutate({
  name: '④ 某一行忘了带 sample（表驱动断言失去依据）',
  file: 'src/redact.js',
  from: "sample: sampleOf('dataset-') },",
  to: "sample: undefined },",
  expect: ['每行必须带 vendor/re/mask/sample'],
  run: SEC,
});

M.mutate({
  name: '⑤ 掩码不保留前缀（改成整体 ***，排查时看不出配了哪类 key）',
  file: 'src/redact.js',
  from: "  { vendor: 'Dify 应用 Key', re: /\\bapp-[A-Za-z0-9]{20,}/g, mask: 'app-***', sample: sampleOf('app-') },",
  to: "  { vendor: 'Dify 应用 Key', re: /\\bapp-[A-Za-z0-9]{20,}/g, mask: '***', sample: sampleOf('app-') },",
  expect: ['应保留', '同口径掩码'],
  run: SEC,
});

M.mutate({
  name: '⑥ 退回"散写一行 sk- 替换 + 前缀表不导出"',
  file: 'src/redact.js',
  from: 'export const SECRET_PREFIXES = [',
  to: 'const SECRET_PREFIXES = [',
  expect: ['必须导出', '前缀表必须存在'],
  run: SEC,
});

if (!M.report()) process.exit(1);
