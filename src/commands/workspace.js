// 命令族：mingdao workspace / mcp preset（自 cli.js 拆出，评估 P0-1 拆包）
import { addWorkspace, listWorkspaces, removeWorkspace, workspacePath, touchWorkspace } from '../workspace.js';
import { presetList, buildPreset } from '../mcp-presets.js';
import { ensureHome, loadConfig, saveConfig } from '../config.js';

export async function handleWorkspace(cmd, args) {
  const sub = args[0] || 'list';
  const name = args[1];
  if (sub === 'add') {
    if (!name) {
      console.log('用法：mingdao workspace add <名称> [目录]');
      process.exitCode = 1;
      return true;
    }
    const r = addWorkspace(name, args[2]);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已登记工作空间 ${r.name} → ${r.dir}`);
    return true;
  }
  if (sub === 'remove') {
    if (!name) {
      console.log('用法：mingdao workspace remove <名称>');
      process.exitCode = 1;
      return true;
    }
    console.log(removeWorkspace(name) ? `✓ 已移除 ${name}` : '未找到该工作空间');
    return true;
  }
  if (sub === 'path') {
    if (!name) {
      console.log('用法：mingdao workspace path <名称>');
      process.exitCode = 1;
      return true;
    }
    const p = workspacePath(name);
    if (p) console.log(p);
    else {
      console.error('未找到该工作空间（mingdao workspace list 查看）');
      process.exitCode = 1;
    }
    return true;
  }
  if (sub === 'use') {
    if (!name) {
      console.log('用法：mingdao workspace use <名称>');
      process.exitCode = 1;
      return true;
    }
    const p = workspacePath(name);
    if (!p) {
      console.log('未找到该工作空间（mingdao workspace list 查看）');
      process.exitCode = 1;
      return true;
    }
    touchWorkspace(name);
    console.log(`✓ 工作空间 ${name}：${p}`);
    console.log(`  快速进入：cd "$(mingdao workspace path ${name})"（建议做成 shell 函数/别名，如 mdw() { cd "$(mingdao workspace path "$1")"; }）`);
    return true;
  }
  const ws = listWorkspaces();
  if (!ws.length) {
    console.log('暂无工作空间。添加：mingdao workspace add <名称> [目录]');
  } else {
    console.log('工作空间（最近使用优先）');
    for (const w of ws) console.log(`  ${w.name.padEnd(16)} ${w.dir}`);
    console.log('\n  进入：cd "$(mingdao workspace path <名称>)"');
  }
  return true;
}

// MCP 预设：mingdao mcp preset list|add <名称> [参数]
export async function handleMcp(cmd, args) {
  if (args[0] !== 'preset') return false;
  const home0 = ensureHome();
  if (args[1] === 'add') {
    const name = args[2];
    if (!name) {
      console.log('用法：mingdao mcp preset add <名称> [参数]（列表见 mingdao mcp preset list）');
      process.exitCode = 1;
      return true;
    }
    const r = buildPreset(name, args[3], process.cwd());
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    const cfg0 = loadConfig();
    if (!cfg0) {
      console.log('未初始化配置，请先运行 mingdao init');
      process.exitCode = 1;
      return true;
    }
    cfg0.mcpServers = cfg0.mcpServers || {};
    cfg0.mcpServers[name] = r.config;
    saveConfig(cfg0);
    console.log(`✓ 已添加 MCP 服务器 ${name}（重启 mingdao web 后生效；会话内 /mcp 查看状态）`);
    return true;
  }
  console.log('MCP 生态预设（mingdao mcp preset add <名称> 一键接入）：');
  for (const p of presetList()) {
    console.log(`  ${p.name.padEnd(20)} ${p.label}${p.argLabel ? `（参数：${p.argLabel}）` : ''}`);
  }
  return true;
}
