// 批六十三（v0.6.30 授权边界加固：C1 deny 归一化 / C2 git 白名单化 / C3 fetch 与 net 默认）的变异验证。
//
// 判定入口：test/permission-hardening.js（独立套件，54 条断言，含真实 git 仓库）。
// 每条变异都把修复改回缺陷形态，套件必须当场红；`expect` 是失败断言原文里的关键词，
// 对不上就算"逃逸"（很可能只是失败的断言不是你改的那条）。
//
// 运行：node test/mutate/batch63-permission-hardening.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/permission-hardening.js');

// ── C1：deny 的命令归一化 ───────────────────────────────────────────────────
// ① 去掉 basename 归一：`/bin/rm` 直接绕过 deny。
M.mutate({
  name: '① C1 去掉 basename 归一（/bin/rm 绕过）',
  file: 'src/permissions.js',
  from: '  const seg = parts.length ? parts[parts.length - 1] : s;',
  to: '  const seg = s; // mutated: 不取 basename',
  expect: ['绝对路径必须归一为 basename'],
  run: SUITE,
});

// ② 不剥包装前缀：env / sudo / xargs / command / nice / timeout / nohup / exec 全部绕过。
M.mutate({
  name: '② C1 不剥包装前缀（env/sudo/xargs/command…）',
  file: 'src/permissions.js',
  from: '    const spec = WRAPPER_PREFIXES[base];',
  to: '    const spec = /** @type {any} */ (undefined); // mutated: 不剥包装前缀',
  expect: ['包装前缀必须剥离'],
  run: SUITE,
});

// ③ 不剥前缀环境变量赋值：`FOO=1 rm -rf /` 绕过。
M.mutate({
  name: '③ C1 不剥前缀环境变量赋值（FOO=1 rm）',
  file: 'src/permissions.js',
  from: '    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);',
  to: '    while (false) toks = toks.slice(1); // mutated: 不剥前缀赋值',
  expect: ['前缀环境变量赋值必须剥离'],
  run: SUITE,
});

// ④ 不递归 shell -c 里的脚本：`sh -c "rm"` / `bash -lc 'rm'` 绕过。
M.mutate({
  name: '④ C1 不递归 -c 参数里的真命令（sh -c / bash -lc）',
  file: 'src/permissions.js',
  from: '      if (ci > 0 && toks[ci + 1] !== undefined) {',
  to: '      if (false) { // mutated: 不递归 -c',
  expect: ['递归判定'],
  run: SUITE,
});

// ⑤ 词法切分不再处理引号：`r''m` / `"rm"` 拼不出 rm。
M.mutate({
  name: '⑤ C1 引号当普通字符（r\'\'m 绕过）',
  file: 'src/permissions.js',
  from: [
    '    if (ch === "\'" || ch === \'"\') {',
    '      quote = ch;',
    '      started = true;',
    '      continue;',
    '    }',
  ].join('\n'),
  to: ['    if (ch === "\'" || ch === \'"\') {', '      cur += ch; // mutated: 引号当普通字符', '      started = true;', '      continue;', '    }'].join('\n'),
  expect: ['引号拼接与反斜杠转义必须归一'],
  run: SUITE,
});

// ⑥ 归一化结果不参与 deny 判定（回到"只比字面段"）：所有归一化绕过同时复活。
M.mutate({
  name: '⑥ C1 只按字面段匹配（归一化不参与 deny）',
  file: 'src/permissions.js',
  from: '      return canonicalizeCommand(args?.command, { shellScripts: !wrapperForm }).some((cand) => denyCanonicalMatch(want, cand));',
  to: '      return false; // mutated: 只看字面段',
  expect: ['绝对路径必须归一为 basename', '包装前缀必须剥离'],
  run: SUITE,
});

// ── C2：git 子命令与参数白名单化 ───────────────────────────────────────────
// ⑦ `blame --contents` 不再特判（只剩兜底黑名单的笼统文案，读仓库外文件的危害不再点名）。
M.mutate({
  name: '⑦ C2 去掉 blame --contents 特判',
  file: 'src/tools/git.js',
  from: "  if (sub === 'blame' && argv.some((a) => /^--contents(=|$)/.test(a))) {",
  to: '  if (false) { // mutated: 不特判 --contents',
  expect: ['blame --contents 必须拒绝'],
  run: SUITE,
});

// ⑧ 不判 branch/tag 的写形态：`branch <名>` / `tag <名>` 免询问直接建 ref。
M.mutate({
  name: '⑧ C2 不判 branch/tag 写形态（可创建 ref）',
  file: 'src/tools/git.js',
  from: "  if (sub === 'branch' || sub === 'tag') {",
  to: '  if (false) { // mutated: 不判写形态',
  expect: ['branch <名> 必须被拒（写操作）'],
  run: SUITE,
});

// ⑨ 参数白名单失效（回到"黑名单兜底"）：未登记参数直接放行。
M.mutate({
  name: '⑨ C2 参数白名单失效（回到黑名单兜底）',
  file: 'src/tools/git.js',
  from: '    if (!isAllowedOption(sub, tok)) {',
  to: '    if (false) { // mutated: 不按白名单',
  expect: ['未知参数必须按白名单拒绝'],
  run: SUITE,
});

// ⑩ 子命令白名单失效：stash / remote 等写类子命令重新变成"只读工具"。
M.mutate({
  name: '⑩ C2 子命令白名单失效（stash/remote/push 放行）',
  file: 'src/tools/git.js',
  from: '  if (!GIT_READONLY.has(sub)) {',
  to: '  if (false) { // mutated: 不再限制子命令',
  expect: ['stash 不是只读子命令'],
  run: SUITE,
});

// ── C3：fetch 归类 + net 未配置默认拒绝 + read→fetch 提示 ────────────────────
// ⑪ fetch 重新进只读集合：默认 ask 档又变成"免询问直接出网"。
M.mutate({
  name: '⑪ C3 fetch 重新进 READONLY_TOOLS',
  file: 'src/tools/index.js',
  from: "export const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'skill', 'git']);",
  to: "export const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'skill', 'git', 'fetch']);",
  expect: ['fetch 不得再属于只读工具集合'],
  run: SUITE,
});

// ⑫ 去掉 dispatch 的默认拒绝：net 未配置时 fetch 直接放行到 safe-fetch。
M.mutate({
  name: '⑫ C3 去掉 net 未配置的默认拒绝',
  file: 'src/tools/index.js',
  from: '      if (egress) return { ok: false, error: egress.message };',
  to: '      if (false && egress) return { ok: false, error: egress.message }; // mutated: 未配置时放行',
  expect: ['未配置 net 时 fetch 必须默认拒绝出网'],
  run: SUITE,
});

// ⑬ 默认拒绝的文案不给出路：用户不知道是"没配白名单"，也不知道去哪加域名。
M.mutate({
  name: '⑬ C3 默认拒绝文案缺少可操作指引',
  file: 'src/net-guard.js',
  from: '      `若确需访问 ${host}，请在设置里把该域名加入 config.net.allow` +',
  to: '      `若确需访问 ${host}，请自行配置` +',
  expect: ['默认拒绝必须给出可操作提示'],
  run: SUITE,
});

// ⑭ 去掉 read→fetch 的外传提示：零确认外传通道的"知情同意"退化成一句普通询问。
M.mutate({
  name: '⑭ C3 read 之后的 fetch 确认不再提示外传风险',
  file: 'src/permissions.js',
  from: "        if (name !== 'fetch' || !recentReads.length) return '';",
  to: "        return ''; // mutated: 不提示外传风险",
  expect: ['read 之后 fetch 的确认文案必须标出外传风险'],
  run: SUITE,
});

const allCaught = M.report();
process.exit(allCaught ? 0 : 1);
