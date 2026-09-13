// MCP 生态预设包：官方常用 MCP 服务器的一键接入目录。
// 命令：mingdao mcp preset list / add <名称> [参数]
// 预设以 npx 运行（无需预装），add 时合并进 config.json 的 mcpServers（重启 WebUI 生效）。

import fs from 'node:fs';

export const MCP_PRESETS = {
  filesystem: {
    label: '文件系统（读写指定目录）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{dir}'],
    argLabel: '目录（默认当前工作目录）',
    argKind: 'dir', // 目录类：缺参时默认 cwd 是合理默认
  },
  fetch: {
    label: '网页抓取（把网页内容转 Markdown）',
    command: 'npx',
    args: ['-y', 'mcp-server-fetch'],
  },
  everything: {
    label: 'Everything 测试服务器（echo/环境/资源演示）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  },
  git: {
    label: 'Git 操作（状态/提交/日志/分支）',
    command: 'npx',
    args: ['-y', 'mcp-server-git', '--repository', '{dir}'],
    argLabel: '仓库目录（默认当前工作目录）',
    argKind: 'dir',
  },
  memory: {
    label: '知识图谱记忆（持久化实体关系记忆）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  },
  'sequential-thinking': {
    label: '结构化分步思考（复杂推理辅助）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  playwright: {
    label: '浏览器自动化（页面操作/截图/测试）',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
  },
  sqlite: {
    label: 'SQLite 数据库查询',
    command: 'npx',
    args: ['-y', 'mcp-server-sqlite', '--db-path', '{dir}'],
    argLabel: '数据库文件路径（必填）',
    // v0.6.2（第三方代码审计 P2-5）：**文件类**参数绝不能套用"缺参默认 cwd"。
    // 此前 sqlite 的 args 里同样写 {dir}，于是缺参时被静默替换成 cwd（一个目录），
    // `mcp-server-sqlite --db-path <目录>` 启动即失败，而用户看不到任何原因。
    argKind: 'file',
  },
  time: {
    label: '时间与时区查询',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
  },
};

export function presetList() {
  return Object.entries(MCP_PRESETS).map(([name, p]) => ({
    name,
    label: p.label,
    argLabel: (/** @type {any} */ (p)).argLabel || null,
    argKind: (/** @type {any} */ (p)).argKind || null,
    args: p.args,
    command: p.command,
  }));
}

export function buildPreset(/** @type {any} */ name, /** @type {any} */ arg, /** @type {any} */ cwd) {
  const p = /** @type {any} */ (MCP_PRESETS)[name];
  if (!p) return { error: `未知预设 ${name}（mingdao mcp preset list 查看）` };
  const kind = (/** @type {any} */ (p)).argKind || (p.args.includes('{dir}') ? 'dir' : '');
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
  const args = p.args.map((/** @type {any} */ a) => (a === '{dir}' ? arg : a));
  return { config: { command: p.command, args } };
}
