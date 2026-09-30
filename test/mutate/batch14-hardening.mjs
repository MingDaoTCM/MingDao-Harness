// 批十四/十五（安全面中危 + P3 速修）的变异验证
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('128');

M.mutate({
  name: '① H-2：脱敏正则的键名不再允许被引号包裹（JSON/YAML 形态漏掉）',
  file: 'src/redact.js',
  from: '([A-Za-z0-9][A-Za-z0-9_-]{0,63})\\1(\\s*[=:]',
  to: '([A-Za-z0-9][A-Za-z0-9_-]{0,63})(\\s*[=:]',
  expect: ['必须被掩码'],
  run: SEC,
});

M.mutate({
  name: '② P3-7：redactDeep 对象键数退回无上限',
  file: 'src/ledger.js',
  from: '  for (const [k, v] of entries.slice(0, 100)) out[k] = redactDeep(v, depth + 1, fn);',
  to: '  for (const [k, v] of entries) out[k] = redactDeep(v, depth + 1, fn);',
  expect: ['必须被截断'],
  run: SEC,
});

M.mutate({
  name: '③ M-3：bash env 段词表退回手写版（漏 key 段）',
  file: 'src/tools/bash.js',
  from: "const SENSITIVE_ENV_SEGMENT = new RegExp(`(^|_)(${[...ENV_SECRET_SEGMENTS].join('|')})(_|$)`, 'i');",
  to: "const SENSITIVE_ENV_SEGMENT = /(^|_)(token|secret|password|passwd|credential|authorization|auth)(_|$)/i;",
  expect: ['必须被判为敏感变量'],
  run: SEC,
});

M.mutate({
  name: '④ M-2：拆段退回只认 ; && || | & 换行（命令替换漏掉）',
  file: 'src/permissions.js',
  from: '    .split(/\\s*(?:;|&&|\\|\\||\\||&|\\r|\\n|\\$\\(|\\(|\\)|`|\\\\\\r?\\n)\\s*/)',
  to: '    .split(/\\s*(?:;|&&|\\|\\||\\||&|\\n)\\s*/)',
  expect: ['必须被拆成独立段'],
  run: SEC,
});

M.mutate({
  name: '⑤ P3-6：denyStrict 的包装执行判定被去掉（sh -c 直达）',
  file: 'src/permissions.js',
  from: '  if (denyStrict && deny.length > 0 && name === \'bash\' && SHELL_WRAPPER.test(String(args?.command ?? \'\'))) {',
  to: '  if (false && denyStrict && deny.length > 0 && name === \'bash\' && SHELL_WRAPPER.test(String(args?.command ?? \'\'))) {',
  expect: ['denyStrict 下必须拦'],
  run: SEC,
});

M.mutate({
  name: '⑥ M-5：约束引擎退回只看嵌套量词（歧义分支漏掉）',
  file: 'src/constraints.js',
  from: '  if (hasNestedQuantifier(pattern) || hasAmbiguousAlternation(pattern)) {',
  to: '  if (hasNestedQuantifier(pattern)) {',
  expect: ['约束引擎也必须拒', '必须被拒'],
  run: SEC,
});

M.mutate({
  name: '⑦ M-1：setStoredKey 退回宽松读（损坏时静默清空其余凭据）',
  file: 'src/credentials.js',
  from: '  const r = readCredentialsStrict();\n  if (!r.ok) {',
  to: '  const r = { ok: true, data: loadCredentials(), error: null };\n  if (!r.ok) {',
  expect: ['必须拒绝写'],
  run: SEC,
});

M.mutate({
  name: '⑧ M-13：Provider 模块退回按 Date.now() 换 URL（无限重载）',
  file: 'src/providers/index.js',
  from: "    const mod = await import(pathToFileURL(customFile).href + `?v=${ver}`);",
  to: "    const mod = await import(pathToFileURL(customFile).href + `?v=${Date.now()}`);",
  expect: ['只应被求值一次'],
  run: SEC,
});

M.mutate({
  name: '⑨ P3-5：pack new 退回 cwd/packs（不在发现路径）',
  file: 'src/commands/pack.js',
  from: "    const dir = path.resolve(process.cwd(), '.mingdao', 'packs', name);",
  to: "    const dir = path.resolve(process.cwd(), 'packs', name);",
  expect: ['必须写进 .mingdao/packs'],
  run: SEC,
});

M.mutate({
  name: '⑩ L-1：clampText 退回裸 slice（可切出半个代理对）',
  file: 'src/context.js',
  from: '  return safeHead(s, maxChars) + `\\n…[输出过长已截断，原文共 ${s.length} 字符]`;',
  to: '  return s.slice(0, maxChars) + `\\n…[输出过长已截断，原文共 ${s.length} 字符]`;',
  expect: ['不得留下孤立的高位代理'],
  run: SEC,
});

if (!M.report()) process.exit(1);
