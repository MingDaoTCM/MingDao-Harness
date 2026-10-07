// 批二十一（v0.6.11：IDE 插件**令牌安全存储** + 探测**三态**）的变异验证。
//
// 先复现（探针 /tmp/probe-ide-token.mjs：桩 vscode 模块 + 本机真实 HTTP 假 WebUI，同一份探针修前修后各跑一次）：
//   ① 工作区级设置**确实**可被被打开的仓库写入：package.json 里 mingdao.port / autoStopServer 都没声明
//      scope（默认 window），而 `get('token')` 对未声明的键也照样返回工作区值；
//   ② 但「修前从 settings 读令牌」**复现不了**（修前 token 字样 0 次、全历史 `-S token -- ide/` 为空）
//      —— 修前的问题是**没有令牌支持**（K-9："对令牌失明"），不是读错了地方；
//   ③ 同一机制下的活注入面：mingdao.port 的工作区值修前直达 terminal.sendText
//      （实测 `"mingdao web 1; touch /tmp/pwned-by-repo #"`）；
//   ④ K-9 根因：假 WebUI 回 401 时修前 openWebUI() **spawn 次数 = 1**，且 401 与 ECONNREFUSED
//      的用户提示**逐字相同**。
// 本批把 §134 的每条断言反着验一遍：逐个把修复改回缺陷，看它们是否**当场红**
// （红不了一定是关键词对不上，而不是"断言太强"）。`expect` 里同时列出会先后命中的几处断言。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('134');

// ① 403 掉出"令牌类失败"集合：Host/来源校验失败会被说成"连不上"，用户去重启一个本来在跑的服务
M.mutate({
  name: '① probe.js 只把 401 当令牌失败（403 退化成"连不上"）',
  file: 'ide/vscode/probe.js',
  from: 'const UNAUTHORIZED_STATUS = new Set([401, 403]);',
  to: 'const UNAUTHORIZED_STATUS = new Set([401]);',
  expect: ['403 → unauthorized'],
  run: SEC,
});

// ② 2xx 判据收窄成"恰好 200"：修前那句 `statusCode === 200` 换个写法又回来了（204/206 会被判成不可达）
M.mutate({
  name: '② probe.js 把 2xx 收窄成"恰好 200"（旧判据换皮回归）',
  file: 'ide/vscode/probe.js',
  from: "    if (statusCode >= 200 && statusCode < 300) return 'ok';",
  to: "    if (statusCode === 200) return 'ok';",
  expect: ['2xx 都是"可用"信号'],
  run: SEC,
});

// ③ 非 2xx / 非 401 的状态码返回 ok：5xx 的服务被当成"可用"，用户拿到空白界面而不是日志指引
M.mutate({
  name: '③ probe.js 把 5xx 判成 ok（服务在但不可用 → 直接放行）',
  file: 'ide/vscode/probe.js',
  from: '    // 服务在，但状态码不是"可用"信号（5xx / 404 / …）：归入不可用，文案里点明状态码\n    return \'unreachable\';',
  to: '    // 服务在，但状态码不是"可用"信号（5xx / 404 / …）：归入不可用，文案里点明状态码\n    return \'ok\';',
  expect: ['5xx 不是 ok'],
  run: SEC,
});

// ④ 没拿到响应码也判 ok：连接被拒/超时被当成健康（K-9 的反面：这次连"服务没起"都不说了）
M.mutate({
  name: '④ probe.js 无响应码（拒连/超时）也判 ok',
  file: 'ide/vscode/probe.js',
  from: "  // 没有任何响应码：连接层失败（ECONNREFUSED / 超时 / 被 destroy）。\n  return 'unreachable';",
  to: "  // 没有任何响应码：连接层失败（ECONNREFUSED / 超时 / 被 destroy）。\n  return 'ok';",
  expect: ['ECONNREFUSED → unreachable'],
  run: SEC,
});

// ⑤ 有响应码时又说回"服务未启动"：这正是 K-9 的误导（服务明明活着，用户被指去重启它）
M.mutate({
  name: '⑤ probe.js 服务已响应（500）却提示"服务未启动"',
  file: 'ide/vscode/probe.js',
  from: '    return `服务已响应但状态异常（HTTP ${statusCode}）——请查看服务端日志（mingdao web 的输出）。`;',
  to: "    return '连不上服务（服务未启动？运行 `mingdao web`）。';",
  expect: ['服务有响应时不得再说'],
  run: SEC,
});

// ⑥ 令牌回到 settings：工作区里写什么就是什么（被打开的仓库决定插件用哪个凭据）+ 迁移路径一并失灵
M.mutate({
  name: '⑥ extension.js 的 token() 改回从 settings 读（工作区可写）',
  file: 'ide/vscode/extension.js',
  from: "    return String((await ctx.secrets.get(SECRET_KEY)) || '').trim();",
  to: "    return String(vscode.workspace.getConfiguration('mingdao').get('token') || '').trim();",
  expect: ['用户级旧令牌必须被迁移进 SecretStorage', '带正确令牌必须判 ok', '请求必须带 SecretStorage 里的令牌'],
  run: SEC,
});

// ⑦ 迁移时把**工作区级**旧值也当令牌：仓库给的字符串被持久化进用户的加密存储，此后一直是它
M.mutate({
  name: '⑦ extension.js 迁移时采纳工作区级 mingdao.token（仓库决定凭据）',
  file: 'ide/vscode/extension.js',
  from: '  const globalValue = String((info && info.globalValue) || \'\').trim();',
  to: '  const globalValue = String((info && (info.globalValue || info.workspaceValue)) || \'\').trim();',
  expect: ['工作区级旧令牌**绝不**能成为凭据'],
  run: SEC,
});

// ⑧ 401 时照样启动服务：K-9 的原行为（启动第二个注定失败的服务 → 空壳页面 → 每个 /api 都 401）
M.mutate({
  name: '⑧ extension.js 在 401 时照样启动第二个服务（K-9 回归）',
  file: 'ide/vscode/extension.js',
  from: "  if (first.state === 'unauthorized') return { ok: false, probe: first };",
  to: "  if (first.state === 'unauthorized' && false) return { ok: false, probe: first };",
  expect: ['K-9：401 时**不得**启动第二个服务'],
  run: SEC,
});

// ⑨ 端口不再数值化：工作区给的字符串直达 terminal.sendText 的命令行（K-2 同类的命令注入）
M.mutate({
  name: '⑨ extension.js 端口不做数值化（工作区值直达命令行）',
  file: 'ide/vscode/extension.js',
  from: '  if (Number.isInteger(n) && n >= 1 && n <= 65535 && !Array.isArray(raw)) return n;',
  to: '  if (raw) return raw;',
  expect: ['工作区给的 port 不得进入命令行'],
  run: SEC,
});

// ⑩ 弃用声明消失：用户只看到"未知设置"，不知道令牌该放哪（静默留着密钥，也不提示迁移）
M.mutate({
  name: '⑩ package.json 删掉 mingdao.token 的弃用声明',
  file: 'ide/vscode/package.json',
  from: '        "mingdao.token": {\n          "type": "string",',
  to: '        "mingdao.token.disabled": {\n          "type": "string",',
  expect: ['mingdao.token 必须在 configuration 里**显式弃用**'],
  run: SEC,
});

// ⑪ JetBrains：401/403 映射成 UNREACHABLE（令牌问题被说成"服务没起"，用户去重启一个在跑的服务）
M.mutate({
  name: '⑪ JetBrains 把 401/403 映射成 UNREACHABLE（三态退回两态）',
  file: 'ide/jetbrains/src/main/kotlin/mingdao/MingDaoPlugin.kt',
  from: '            code == 401 || code == 403 -> Probe.UNAUTHORIZED',
  to: '            code == 401 || code == 403 -> Probe.UNREACHABLE',
  expect: ['401/403 必须映射成 UNAUTHORIZED'],
  run: SEC,
});

// ⑫ 令牌字段回到 MingDaoSettings：等于持久化进项目配置（随仓库/工作区走），危险面回来
M.mutate({
  name: '⑫ JetBrains 把 token 字段加回 MingDaoSettings（持久化到项目配置）',
  file: 'ide/jetbrains/src/main/kotlin/mingdao/MingDaoPlugin.kt',
  from: '    var binary: String\n        get() = props.getValue("mingdao.binary") ?: "mingdao"\n        set(value) = props.setValue("mingdao.binary", value)\n}',
  to: '    var binary: String\n        get() = props.getValue("mingdao.binary") ?: "mingdao"\n        set(value) = props.setValue("mingdao.binary", value)\n    var token: String\n        get() = props.getValue("mingdao.token") ?: ""\n        set(value) = props.setValue("mingdao.token", value)\n}',
  expect: ['不得再有任何 token 字段'],
  run: SEC,
});

// ⑬ 写令牌不再走凭据库（回到 PropertiesComponent）：明文随项目配置落盘，"存 IDE 凭据库"落空
M.mutate({
  name: '⑬ JetBrains 写令牌改回 PropertiesComponent（不用 PasswordSafe）',
  file: 'ide/jetbrains/src/main/kotlin/mingdao/MingDaoPlugin.kt',
  from: '    onPooledThread { PasswordSafe.instance.set(TOKEN_ATTRS, if (v.isEmpty()) null else Credentials("mingdao", v)) }',
  to: '    PropertiesComponent.getInstance().setValue(LEGACY_TOKEN_KEY, v)',
  expect: ['令牌必须存 IDE 凭据库 PasswordSafe'],
  run: SEC,
});

// ⑭ 三种提示塌成两种：401 说"连不上"（K-9 的用户可见面又回来了）
M.mutate({
  name: '⑭ JetBrains 的 401 文案塌回"连不上服务"',
  file: 'ide/jetbrains/src/main/kotlin/mingdao/MingDaoPlugin.kt',
  from: '    Probe.UNAUTHORIZED -> "令牌无效或已过期（HTTP 401/403）——请重新输入访问令牌（Tools → MingDao 的任一动作会提示输入；令牌存入 IDE 的 PasswordSafe，不写项目配置）。"',
  to: '    Probe.UNAUTHORIZED -> "连不上服务（服务未启动？运行 `mingdao web`，或 Tools → MingDao: 启动服务器）。"',
  expect: ['三种状态的用户提示不得是同一句'],
  run: SEC,
});

if (!M.report()) process.exit(1);
