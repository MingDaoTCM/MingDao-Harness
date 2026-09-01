// MCP 生态预设包：官方常用 MCP 服务器的一键接入目录。
// 命令：mingdao mcp preset list / add <名称> [参数]
// 预设以 npx 运行（无需预装），add 时合并进 config.json 的 mcpServers（重启 WebUI 生效）。

export const MCP_PRESETS = {
  filesystem: {
    label: '文件系统（读写指定目录）',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{dir}'],
    argLabel: '目录（默认当前工作目录）',
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
    args: p.args,
    command: p.command,
  }));
}

export function buildPreset(/** @type {any} */ name, /** @type {any} */ arg, /** @type {any} */ cwd) {
  const p = /** @type {any} */ (MCP_PRESETS)[name];
  if (!p) return { error: `未知预设 ${name}（mingdao mcp preset list 查看）` };
  if ((/** @type {any} */ (p)).argLabel && !arg) {
    if (p.args.includes('{dir}')) {
      arg = cwd; // 目录类参数默认当前工作目录
    } else {
      return { error: `该预设需要参数：${p.argLabel}` };
    }
  }
  const args = p.args.map((/** @type {any} */ a) => (a === '{dir}' ? arg : a));
  return { config: { command: p.command, args } };
}
