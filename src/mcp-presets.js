// MCP 生态预设包：官方常用 MCP 服务器的一键接入目录。
// 命令：mingdao mcp preset list / add <名称> [参数]
// 预设以 npx 运行（无需预装），add 时合并进 config.json 的 mcpServers（重启 WebUI 生效）。
//
// 审计 BUG-053（版本漂移）：预设此前一律不带版本，`@playwright/mcp@latest` 更是显式 latest ——
// npx 每次按 dist-tag 解析，**上游一发新版就在用户机器上执行**，既没有锚点也看不出会跑什么。
// 现在每个可用预设都**钉死版本**（`<pkg>@<version>`），并由 `presetList()` / `mcp preset list`
// 显示出来：安装前就能看到"将要执行哪一个确切版本"。升级是**有意动作**（改这里的 version），
// 不再自动发生。
//
// 顺带核实（2026-09-21，`npm view`）：目录里有 4 个预设指向的包**已经不可安装**——
//   · mcp-server-fetch / mcp-server-git → npm 只返回 `0.0.1-security`（包名被安全保留）
//   · mcp-server-sqlite → 仍有 0.0.2，但上游已停止维护（保留，钉版本）
//   · @modelcontextprotocol/server-time → 404（该名字从未发布或已被撤）
// 这些不是"版本漂移"而是"根本装不上"，因此**如实标成不可用**并给出原因：与其让用户
// `npx -y` 装到一个占位包、然后在 MCP 握手里莫名失败，不如在 add 的一刻就说清楚。

import fs from 'node:fs';

export const MCP_PRESETS = {
  filesystem: {
    label: '文件系统（读写指定目录）',
    pkg: '@modelcontextprotocol/server-filesystem',
    version: '2026.8.31',
    extraArgs: ['{dir}'],
    argLabel: '目录（默认当前工作目录）',
    argKind: 'dir', // 目录类：缺参时默认 cwd 是合理默认
  },
  fetch: {
    label: '网页抓取（把网页内容转 Markdown）',
    pkg: 'mcp-server-fetch',
    version: null,
    unavailableReason: 'npm 上游包 mcp-server-fetch 已被安全保留（只返回 0.0.1-security），当前无法安装。可改用内置的 fetch 工具，或在 config.mcpServers 里手写一个可用的抓取服务器。',
    extraArgs: [],
  },
  everything: {
    label: 'Everything 测试服务器（echo/环境/资源演示）',
    pkg: '@modelcontextprotocol/server-everything',
    version: '2026.8.31',
    extraArgs: [],
  },
  git: {
    label: 'Git 操作（状态/提交/日志/分支）',
    pkg: 'mcp-server-git',
    version: null,
    unavailableReason: 'npm 上游包 mcp-server-git 已被安全保留（只返回 0.0.1-security），当前无法安装。git 操作可直接用内置的 git 工具（只读白名单）。',
    extraArgs: ['--repository', '{dir}'],
    argLabel: '仓库目录（默认当前工作目录）',
    argKind: 'dir',
  },
  memory: {
    label: '知识图谱记忆（持久化实体关系记忆）',
    pkg: '@modelcontextprotocol/server-memory',
    version: '2026.8.31',
    extraArgs: [],
  },
  'sequential-thinking': {
    label: '结构化分步思考（复杂推理辅助）',
    pkg: '@modelcontextprotocol/server-sequential-thinking',
    version: '2026.8.31',
    extraArgs: [],
  },
  playwright: {
    label: '浏览器自动化（页面操作/截图/测试）',
    pkg: '@playwright/mcp',
    version: '0.0.82', // 原为 @latest：每次 npx 都按 dist-tag 取最新，详见文件头 BUG-053
    extraArgs: [],
  },
  sqlite: {
    label: 'SQLite 数据库查询',
    pkg: 'mcp-server-sqlite',
    version: '0.0.2', // 上游已停更，但包还在：钉住这个"最后可用"的版本
    extraArgs: ['--db-path', '{dir}'],
    argLabel: '数据库文件路径（必填）',
    // v0.6.2（第三方代码审计 P2-5）：**文件类**参数绝不能套用"缺参默认 cwd"。
    // 此前 sqlite 的 args 里同样写 {dir}，于是缺参时被静默替换成 cwd（一个目录），
    // `mcp-server-sqlite --db-path <目录>` 启动即失败，而用户看不到任何原因。
    argKind: 'file',
  },
  time: {
    label: '时间与时区查询',
    pkg: '@modelcontextprotocol/server-time',
    version: null,
    unavailableReason: 'npm 上游包 @modelcontextprotocol/server-time 返回 404（该名字当前不可安装）。模型本身可以处理时间/时区换算，也可在 config.mcpServers 里手写一个可用的时间服务器。',
    extraArgs: [],
  },
};

/** 该预设要执行的 npx 参数（钉死版本）；不可用时返回 null。 */
function presetArgs(/** @type {any} */ p) {
  if (!p?.pkg || !p.version) return null;
  return ['-y', `${p.pkg}@${p.version}`, ...(p.extraArgs || [])];
}

export function presetList() {
  return Object.entries(MCP_PRESETS).map(([name, p]) => ({
    name,
    label: p.label,
    argLabel: (/** @type {any} */ (p)).argLabel || null,
    argKind: (/** @type {any} */ (p)).argKind || null,
    args: presetArgs(p) || [],
    command: 'npx',
    // 审计 BUG-053：把"将要执行的确切包与版本"显式暴露给 CLI/WebUI
    pkg: p.pkg || null,
    version: p.version || null,
    unavailableReason: (/** @type {any} */ (p)).unavailableReason || null,
  }));
}

export function buildPreset(/** @type {any} */ name, /** @type {any} */ arg, /** @type {any} */ cwd) {
  const p = /** @type {any} */ (MCP_PRESETS)[name];
  if (!p) return { error: `未知预设 ${name}（mingdao mcp preset list 查看）` };
  // 审计 BUG-053：不可安装的预设要在**这一刻**说清楚，而不是写进 config 后
  // 在 MCP 握手里莫名失败（用户根本看不出是包没了）。
  if (p.unavailableReason) return { error: `预设 ${name} 当前不可用：${p.unavailableReason}` };
  const args0 = presetArgs(p) || [];
  const kind = (/** @type {any} */ (p)).argKind || (args0.includes('{dir}') ? 'dir' : '');
  if ((/** @type {any} */ (p)).argLabel && !arg) {
    // v0.6.2（P2-5）：只有**目录类**参数才默认 cwd。
    // 旧逻辑是「args 里含 {dir} 就默认 cwd」，把文件类参数（sqlite 的 --db-path）也算进去了
    // ——缺参时静默传一个目录，MCP 服务器启动即失败且无提示。
    if (kind === 'dir') arg = cwd;
    else return { error: `该预设需要参数：${(/** @type {any} */ (p)).argLabel}` };
  }
  // 文件类参数做一次「明显传错」的拦截：给的是已存在的**目录**时立刻说清楚，
  // 而不是让它去启动一个必然失败的服务（sqlite 的 --db-path 传目录是常见误用）。
  if (kind === 'file' && arg) {
    try {
      if (fs.statSync(String(arg)).isDirectory()) {
        return { error: `该预设需要的是**文件**路径，但给的是目录：${arg}（例如 ./data/app.db）` };
      }
    } catch {
      // 文件还不存在是合法的（sqlite 会自己创建），不拦截
    }
  }
  const args = args0.map((/** @type {any} */ a) => (a === '{dir}' ? arg : a));
  return { config: { command: 'npx', args } };
}
