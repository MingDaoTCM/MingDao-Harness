// 批十六~十九（v0.6.8：外圈质量洼地 + 桌面目录选择器）的变异验证
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('129');

M.mutate({
  name: '① K-1：送达判据加回 writableFinished 兜底（EPIPE 也算送达 → fail-open）',
  file: 'src/hooks.js',
  from: "        const delivered = stdinDeliveredBytes >= payloadBytes;",
  to: "        const delivered = stdinDeliveredBytes >= payloadBytes || child.stdin.writableFinished === true;",
  expect: ['送达判据必须严格等于'],
  run: SEC,
});

M.mutate({
  name: '①b K-1：退回用 finish 事件做判据（Windows 上不可靠的那个）',
  file: 'src/hooks.js',
  from: "      child.stdin.on('error', (e) => {",
  to: "      child.stdin.on('finish', () => {});\n      child.stdin.on('error', (e) => {",
  expect: ['判据不得再建立在'],
  run: SEC,
});

M.mutate({
  name: '② K-1：写入回调不再判 err（EPIPE 被当成送达成功）',
  file: 'src/hooks.js',
  from: "          if (!err) stdinDeliveredBytes = payloadBytes;",
  to: "          stdinDeliveredBytes = payloadBytes;",
  expect: ['写入回调必须判 err'],
  run: SEC,
});

M.mutate({
  name: '③ K-3：解码退回"整段按 GBK 解"',
  file: 'src/tools/bash.js',
  from: "    if (validMultibytePrefix(buf) >= 2) return new TextDecoder('utf-8', { fatal: false }).decode(buf);",
  to: "    if (false) return new TextDecoder('utf-8', { fatal: false }).decode(buf);",
  expect: ['保住其余内容', '逐字保真'],
  run: SEC,
});

M.mutate({
  name: '④ K-5：URL→路径 退回 replace("file://","")',
  file: 'scripts/coverage-report.mjs',
  from: '      file = fileURLToPath(url);',
  to: "      file = url.replace('file://', '');",
  expect: ['必须用 fileURLToPath'],
  run: SEC,
});

M.mutate({
  name: '⑤ K-6：分母不再从 src/ 根遍历（退回"只统计加载过的文件"）',
  file: 'scripts/coverage-report.mjs',
  from: "})(path.join(root, 'src'));",
  to: "})(path.join(root, '__definitely_not_src__'));",
  expect: ['分母必须真的从 src/ 根开始遍历'],
  run: SEC,
});

M.mutate({
  name: '⑥ K-6：删掉"分母为 0 即失败"',
  file: 'scripts/coverage-report.mjs',
  from: 'if (totalLines === 0 || allSrc.length === 0) {',
  to: 'if (false) {',
  expect: ['分母为 0 必须失败'],
  run: SEC,
});

M.mutate({
  name: '⑦ K-7：棘轮退回 npx tsc',
  file: 'scripts/strict-ratchet.mjs',
  from: '  const tscJs = path.join(root, \'node_modules\', \'typescript\', \'bin\', \'tsc\');',
  to: "  const tscJs = 'npx';\n  execSync('npx tsc -p tsconfig.full.json', { cwd: root, stdio: 'pipe' });",
  expect: ['棘轮不得再调用 npx tsc'],
  run: SEC,
});

// 注：变异 `test/mutate/lib.mjs` 自身（切片边界）**无法在本进程内**生效——该模块已被本进程
// 缓存，改文件不会改变已加载的行为。故 M-6 的判别改为：§129④ 的断言 + 一次新进程手工复现
// （把 lib.mjs 的 nextHeader 改回 smoke.length → `node -e "…section('129')"` 退出码 1，已实测）。

M.mutate({
  name: '⑨ K-2：VS Code 退回工作区级 binary 设置',
  file: 'ide/vscode/extension.js',
  from: "  const g = cfg.inspect ? cfg.inspect('binary') : null;\n  const v = (g && g.globalValue) || 'mingdao';",
  to: "  const v = cfg.get('binary', 'mingdao');",
  expect: ['VS Code 插件必须只读'],
  run: SEC,
});

M.mutate({
  name: '⑩ K-2：JetBrains 退回 sh -c 字符串拼接',
  file: 'ide/jetbrains/src/main/kotlin/mingdao/MingDaoPlugin.kt',
  from: '    val cmd = listOf(binary, "web", s.port.toString())',
  to: '    val cmd = listOf("sh", "-c", "nohup ${s.binary} web ${s.port} >/dev/null 2>&1 &")',
  expect: ['命令注入'],
  run: SEC,
});

M.mutate({
  name: '⑪ 桌面选择器：默认目录退回进程 cwd',
  file: 'desktop/main.js',
  from: "      const start = typeof startDir === 'string' && startDir ? startDir : os.homedir();",
  to: "      const start = typeof startDir === 'string' && startDir ? startDir : process.cwd();",
  expect: ['选择器必须默认停在当前系统用户的家目录'],
  run: SEC,
});

M.mutate({
  name: '⑫ 内置弹窗起点退回 cwd（家目录失效）',
  file: 'src/web/app.js',
  from: '      pickerDir = (j && (j.home || j.cwd)) || \'/\';',
  to: "      pickerDir = (j && j.cwd) || '/';",
  expect: ['起点必须是'],
  run: SEC,
});

M.mutate({
  name: '⑬ 服务端：fs-browse 不带 dir 退回"需要绝对路径"',
  file: 'src/web/routes/domains/workspace.js',
  from: '    if (!dir) dir = os.homedir();',
  to: "    if (!dir) return json(res, 400, { error: '需要绝对路径' });",
  expect: ['必须默认到家目录'],
  run: SEC,
});

if (!M.report()) process.exit(1);
