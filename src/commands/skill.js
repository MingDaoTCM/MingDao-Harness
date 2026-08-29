// 命令族：mingdao skill / web / sessions（自 cli.js 拆出，评估 P0-1 拆包）
import { listSkills, tamperedSkillNames } from '../skills.js';
import { libraryList, searchLibrary, installSkill, uninstallSkill, reinstallSkill, trustSkill } from '../skill-lib.js';
import { searchRegistry } from '../skill-registry.js';
import { loadConfig, saveConfig, ensureHome } from '../config.js';
import { searchSessions, relativeTime } from '../session.js';
import { runWebServer } from '../web/server.js';
import readline from 'node:readline';

// 首次运行询问「是否自动后台启动 WebUI」（交互终端才问；管道/脚本下默认否）
function askAutoStart() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('是否在每次运行 mingdao 时自动后台启动 WebUI（免敲命令）？[y/N] ', (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(a).trim()));
    });
  });
}

export async function handleSkill(cmd, args) {
  const sub = args[0] || 'list';
  const arg = args[1];
  if (sub === 'search') {
    const local = searchLibrary(arg || '');
    const remote = await searchRegistry(arg || '');
    const localNames = new Set(local.map((s) => s.name));
    const remoteOnly = remote.skills ? remote.skills.filter((s) => !localNames.has(s.name)) : [];
    console.log(
      `技能库匹配：内置 ${local.length}${remote.error ? '' : ` + 线上 ${remoteOnly.length}`} · 安装：mingdao skill install <名称>`
    );
    for (const s of local) console.log(`  ${s.name.padEnd(18)} ${s.description}${s.installed ? '（已安装）' : ''}  [内置]`);
    if (remote.error) {
      console.log(`  ✗ 线上 registry 不可达：${remote.error}`);
    } else {
      for (const s of remoteOnly) console.log(`  ${s.name.padEnd(18)} ${s.description}${s.installed ? '（已安装）' : ''}  [线上]`);
      if (remote.stale) console.log('  （线上索引来自本地缓存，已过期）');
    }
    return true;
  }
  if (sub === 'install') {
    const r = await installSkill(arg);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    if (r.names) {
      console.log(`✓ 已从 git 仓库安装 ${r.names.length} 个技能：${r.names.join(', ')}`);
    } else {
      const srcLabel = r.host ? '（线上 registry）' : '';
      console.log(`✓ 已安装技能 ${r.name}${srcLabel} → ~/.mingdao/skills/${r.name}/（可编辑/删除，下次会话生效）`);
    }
    return true;
  }
  if (sub === 'uninstall') {
    if (!arg) {
      console.log('用法：mingdao skill uninstall <名称>');
      process.exitCode = 1;
      return true;
    }
    const r = uninstallSkill(arg);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已卸载 ${r.name}（内置同名技能如有会自动重新可见）`);
    return true;
  }
  if (sub === 'update') {
    if (!arg) {
      console.log('用法：mingdao skill update <名称>');
      process.exitCode = 1;
      return true;
    }
    const r = await reinstallSkill(arg);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已更新技能 ${r.name}`);
    return true;
  }
  if (sub === 'trust') {
    if (!arg) {
      console.log('用法：mingdao skill trust <名称>（编辑过 registry/库安装的技能后，重新记录内容指纹）');
      process.exitCode = 1;
      return true;
    }
    const r = trustSkill(arg);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已信任技能 ${r.name} 的当前内容（指纹 ${r.sha256}…）`);
    return true;
  }
  const skills = listSkills(process.cwd());
  console.log(`已安装技能（${skills.length}）· 三级来源：用户级 > 项目级 > 内置`);
  for (const s of skills) {
    const label = s.source === 'user' ? '（用户级）' : s.source === 'project' ? '（项目级）' : '（内置）';
    console.log(`  ${s.name.padEnd(18)} ${s.description || ''}${label}`);
  }
  const tampered = tamperedSkillNames(process.cwd());
  for (const t of tampered) {
    console.log(`  ⚠ ${t.name.padEnd(18)} 内容与安装时不一致，已拒绝加载——确认是你改的就执行 mingdao skill trust ${t.name}，否则 mingdao skill uninstall ${t.name} 后重装`);
  }
  const lib = libraryList();
  console.log(`\n技能库共 ${lib.length} 个可安装技能：mingdao skill search [关键词] 搜索，mingdao skill install <名称> 安装`);
  return true;
}

// WebUI：mingdao web [端口] [--auth-token <令牌>] [--autostart|--no-autostart]（评估 P3-1：参数结构不合法的按提问处理）
// --autostart/--no-autostart：写 config.web.autoStart——开启后每次运行 mingdao 会自动后台拉起 WebUI；
// 首次交互运行且未设置时，询问一次「下次是否自动启动」。
export async function handleWeb(cmd, args) {
  let portIndex = -1;
  let tokenSeen = false;
  let autoChoice; // undefined=未指定；true/false=显式指定
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--auth-token') {
      if (tokenSeen || i + 1 >= args.length) return false;
      tokenSeen = true;
      i += 1;
      continue;
    }
    if (a.startsWith('--auth-token=')) {
      if (tokenSeen) return false;
      tokenSeen = true;
      continue;
    }
    if (a === '--autostart' || a === '--no-autostart') {
      if (autoChoice !== undefined) return false;
      autoChoice = a === '--autostart';
      continue;
    }
    if (/^\d+$/.test(a) && portIndex === -1) {
      portIndex = i; // 审计 P2-11：记录端口实际位置，而非默认读首参
      continue;
    }
    return false;
  }
  const cfg0 = loadConfig();
  // 自动启动开关（先落盘再起服务，服务失败也保留用户选择）
  if (autoChoice !== undefined) {
    const c = cfg0 ? { ...cfg0, web: { ...(cfg0.web || {}), autoStart: autoChoice } } : { web: { autoStart: autoChoice } };
    saveConfig(c);
    console.log(
      autoChoice
        ? '✓ 已开启 WebUI 自动启动：以后直接运行 mingdao 即可后台拉起（关闭：mingdao web --no-autostart）'
        : '✓ 已关闭 WebUI 自动启动'
    );
  } else if (cfg0?.web?.autoStart === undefined && process.stdin.isTTY) {
    const ans = await askAutoStart();
    const c = { ...cfg0, web: { ...(cfg0.web || {}), autoStart: ans } };
    saveConfig(c);
    if (ans) console.log('✓ 已开启：以后直接运行 mingdao 即可自动后台启动 WebUI（关闭：mingdao web --no-autostart）');
  }
  const portArg = portIndex !== -1 ? Number(args[portIndex]) : NaN;
  const port = Number.isFinite(portArg) && portArg > 0 ? portArg : cfg0?.web?.port || 3820;
  const host = cfg0?.web?.host || '127.0.0.1';
  // 访问令牌优先级：--auth-token 参数 > 环境变量 MINGDAO_WEB_TOKEN > config.json 的 web.token
  let authToken = process.env.MINGDAO_WEB_TOKEN || cfg0?.web?.token || undefined;
  const atIdx = args.findIndex((a) => typeof a === 'string' && a.startsWith('--auth-token'));
  if (atIdx !== -1) {
    const raw = args[atIdx];
    authToken = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : args[atIdx + 1];
    if (!authToken) {
      console.log('用法：mingdao web [端口] [--auth-token <令牌>]');
      process.exitCode = 1;
      return true;
    }
  }
  try {
    await runWebServer({ host, port, authToken });
  } catch (err) {
    // 质检 C2：listen 现在会 reject（如端口占用），CLI 给出明确提示而非挂起
    console.error(`[MingDao] WebUI 启动失败：${err?.message || err}`);
    process.exitCode = 1;
  }
  return true;
}

// 会话检索：mingdao sessions search <关键词>
export async function handleSessions(cmd, args) {
  if (args[0] !== 'search') return false;
  const kw = args.slice(1).join(' ').trim();
  if (!kw) {
    console.log('用法：mingdao sessions search <关键词>');
    process.exitCode = 1;
    return true;
  }
  const home0 = ensureHome();
  const hits = searchSessions(home0, kw);
  if (!hits.length) console.log(`未找到包含「${kw}」的会话。`);
  else {
    console.log(`找到 ${hits.length} 个会话：`);
    for (const h of hits) {
      console.log(`  ${h.name}（${relativeTime(h.mtime)}）\n    ${h.snippet}`);
    }
    console.log(`\n恢复：mingdao --resume（选择器中可见全部会话）`);
  }
  return true;
}
