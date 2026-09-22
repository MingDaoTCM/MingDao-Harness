// `mingdao pack` 命令族（v0.5.0 阶段 A）：垂域 Pack 的查看 / 校验 / 脚手架。
// 下游 CI 门禁入口是 `mingdao pack verify <dir>`——**默认只做静态校验，不 import Pack 代码**
// （v0.6.3 / H-9：此前帮助文案这么写、实现却无条件 loadPack → 等于在 CI 上执行被审仓库的任意代码，
// 且不经 pack trust 信任门。现在默认静态、要执行须显式 --runtime）。
import fs from 'node:fs';
import path from 'node:path';
import { listPacks, loadPack, loadPackStatic, validateManifest, coreVersionOf, SUPPORTED_PACK_API, CONSTRAINT_KINDS, packedDirsForHelp, packTrustState, trustPack, untrustPack } from '../packs.js';
import { loadConfig } from '../config.js';

const HELP = `用法：
  mingdao pack list                 已发现的 Pack（名/版本/来源/兼容状态）
  mingdao pack verify <目录>        静态校验 manifest + 文件齐全（**不执行 pack.mjs**，下游 CI 门禁用这个）
  mingdao pack verify <目录> --runtime  额外 import pack.mjs 验证运行时契约（会执行 Pack 代码，慎用）
  mingdao pack new <名字>           生成最小可用 Pack 脚手架
  mingdao pack info <名字>          单个 Pack 的贡献面明细
  mingdao pack trust <项目目录>     信任该项目的 .mingdao/packs（未信任则**不挂载**）
  mingdao pack untrust <项目目录>   撤销信任

项目级 Pack 默认不挂载：项目里的 pack.mjs 会以完整 Node 权限在本进程内执行，
不受 permission 模式约束。clone 来的仓库必须先 trust 才会加载（内容一变即自动失效）。

说明：Pack API v${SUPPORTED_PACK_API.join('/')}（契约见 docs/PACK-API.md）。
约束 kind：${[...CONSTRAINT_KINDS].join(' / ')}`;

/**
 * @param {any} cmd @param {any} args
 * @returns {Promise<boolean>}
 */
export async function handlePack(cmd, args) {
  if (cmd !== 'pack') return false;
  const sub = String(args[0] || '').trim();

  if (!sub || sub === 'help' || sub === '--help') {
    console.log(HELP);
    return true;
  }

  if (sub === 'list') {
    // v0.6.2（代码审计 P2-4）：这里硬传 `{}` 导致**读不到 config.packs 声明的 Pack**——
    // 用户按文档在 config.json 里声明了目录，`mingdao pack list` 却看不见它（info 同病）。
    const found = listPacks(loadConfig() || {}, process.cwd());
    if (!found.length) {
      console.log('未发现任何 Pack。');
      console.log(`放置位置（三级遮蔽）：<项目>/.mingdao/packs/ > ${packedDirsForHelp()} > 内置 packs/`);
      console.log('或运行 mingdao pack new <名字> 生成脚手架。');
      return true;
    }
    console.log(`共 ${found.length} 个 Pack（内核 ${coreVersionOf()}）：`);
    for (const p of found) {
      // 未信任的项目级 Pack 会被 mountPacks 跳过——列表里必须**看得出来**，
      // 否则用户会以为它生效了（这正是原缺陷「静默」的另一半）。
      const status = p.gate
        ? `⛔ 未信任（不挂载）——${p.gate === 'changed' ? '信任后内容已变化' : '执行 mingdao pack trust ' + (p.gateDir || '')}`
        : p.error
          ? `❌ ${p.error}`
          : `✅ apiVersion ${p.apiVersion}`;
      console.log(`  ${p.name}${p.displayName ? '（' + p.displayName + '）' : ''} v${p.version || '?'} · 来源 ${p.source} · ${status}`);
      console.log(`      ${p.dir}`);
    }
    return true;
  }

  if (sub === 'trust' || sub === 'untrust') {
    const dir = String(args[1] || '').trim();
    if (!dir) {
      console.log(`[错误] 用法：mingdao pack ${sub} <项目目录>（会作用于该目录下的 .mingdao/packs）`);
      process.exitCode = 1;
      return true;
    }
    // 传项目目录或 packs 目录都接受：统一解析到 .mingdao/packs
    const abs = path.resolve(dir);
    const root = path.basename(abs) === 'packs' && path.basename(path.dirname(abs)) === '.mingdao' ? abs : path.join(abs, '.mingdao', 'packs');
    if (!fs.existsSync(root)) {
      console.log(`[错误] 未找到 Pack 目录：${root}`);
      console.log('        该目录不存在时无需信任（没有项目级 Pack 会被加载）。');
      process.exitCode = 1;
      return true;
    }
    if (sub === 'untrust') {
      const r = untrustPack(root);
      if (r.error) {
        console.log(`[错误] ${r.error}`);
        process.exitCode = 1;
        return true;
      }
      console.log(`✓ 已撤销信任：${r.dir}（该项目的 Pack 不再挂载）`);
      return true;
    }
    const st = packTrustState(root);
    const r = trustPack(root);
    if (r.error) {
      console.log(`[错误] ${r.error}`);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已信任项目级 Pack 目录：${r.dir}`);
    console.log(`  内容指纹 ${String(r.sha256 || '').slice(0, 16)}…${st.reason === 'changed' ? '（与上次信任时不同，已更新为当前内容）' : ''}`);
    console.log('  ⚠ 该目录下的 pack.mjs 会以完整 Node 权限在本进程内执行——只信任你自己审过的代码。');
    console.log('  指纹变化后信任自动失效，需要重新执行本命令。');
    return true;
  }

  if (sub === 'verify') {
    const dir = String(args[1] || '').trim();
    if (!dir) {
      console.log('[错误] 用法：mingdao pack verify <目录>');
      process.exitCode = 1;
      return true;
    }
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) {
      console.log(`[错误] 目录不存在：${abs}`);
      process.exitCode = 1;
      return true;
    }
    // 静态校验优先（不 import 代码）——把可操作的错误一次性列全
    const mf = path.join(abs, 'pack.json');
    if (!fs.existsSync(mf)) {
      console.log(`[错误] 缺少 pack.json（${abs}）`);
      process.exitCode = 1;
      return true;
    }
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    } catch (/** @type {any} */ err) {
      console.log(`[错误] pack.json 解析失败：${err?.message || err}`);
      process.exitCode = 1;
      return true;
    }
    const v = validateManifest(manifest);
    if (!v.ok) {
      console.log(`[失败] ${manifest?.name || path.basename(abs)} 的 manifest 校验未通过：`);
      v.errors.forEach((/** @type {any} */ e, /** @type {number} */ i) => console.log(`  ${i + 1}. ${e}`));
      process.exitCode = 1;
      return true;
    }
    // v0.6.3（H-9）：默认**静态**收口——`verify` 是给 CI 审第三方 Pack 用的，不能顺手执行它的代码。
    const runtime = args.includes('--runtime');
    if (!runtime) {
      const st2 = loadPackStatic(abs);
      if (!st2.ok) {
        console.log(`[失败] ${manifest.name} 静态校验未通过：`);
        st2.errors.forEach((/** @type {any} */ e, /** @type {number} */ i) => console.log(`  ${i + 1}. ${e}`));
        process.exitCode = 1;
        return true;
      }
      console.log(`[通过·静态] ${manifest.name} v${manifest.version}（apiVersion ${manifest.apiVersion}，内核窗口 ${manifest.engines?.mingdao}）`);
      console.log('  已校验：manifest 字段 / 兼容窗口 / 声明文件齐全 / pack.mjs 存在性。**未执行 Pack 代码。**');
      console.log('  约束与提示词段的合法性由代码在装载时产出，静态阶段无法校验；需要时请加 --runtime（会执行代码）。');
      return true;
    }
    console.log('  ⚠ --runtime：即将 import pack.mjs——它会在**本进程内以完整 Node 权限执行**。');
    const res = await loadPack(abs);
    if (!res.ok) {
      console.log(`[失败] ${manifest.name} 加载校验未通过：`);
      res.errors.forEach((/** @type {any} */ e, /** @type {number} */ i) => console.log(`  ${i + 1}. ${e}`));
      process.exitCode = 1;
      return true;
    }
    const c = res.contributions;
    console.log(`[通过·运行时] ${manifest.name} v${manifest.version}（apiVersion ${manifest.apiVersion}，内核窗口 ${manifest.engines?.mingdao}）`);
    console.log(`  工具 ${Array.isArray(c.tools) ? c.tools.length : 0} 个 · 约束 ${Array.isArray(c.constraints) ? c.constraints.length : 0} 条 · 提示词段 ${Array.isArray(c.promptSections) ? c.promptSections.length : 0} 段`);
    for (const w of Array.isArray(res.warnings) ? res.warnings : []) console.log(`  ⚠ ${w}`);
    return true;
  }

  if (sub === 'new') {
    const name = String(args[1] || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(name)) {
      console.log('[错误] 用法：mingdao pack new <名字>（小写字母/数字/连字符，2–32 位）');
      process.exitCode = 1;
      return true;
    }
    const dir = path.resolve(process.cwd(), 'packs', name);
    if (fs.existsSync(dir)) {
      console.log(`[错误] 目录已存在：${dir}`);
      process.exitCode = 1;
      return true;
    }
    fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pack.json'),
      JSON.stringify(
        {
          apiVersion: SUPPORTED_PACK_API[0],
          name,
          displayName: name,
          version: '1.0.0',
          engines: { mingdao: `>=${coreVersionOf()} <0.7` },
          description: '（一句话说明这个垂域包做什么）',
          license: 'private',
          contributes: { tools: true, promptSections: ['prompts/domain.md'], constraints: true },
        },
        null,
        2
      ) + '\n'
    );
    fs.writeFileSync(path.join(dir, 'prompts', 'domain.md'), '（在这里写领域提示词：角色、边界、红线。）\n');
    fs.writeFileSync(
      path.join(dir, 'pack.mjs'),
      `// ${name} —— 垂域 Pack 入口。契约见 docs/PACK-API.md（Pack API v1）。
export const apiVersion = 1;

export function createPack(ctx) {
  return {
    tools: [
      {
        name: 'hello',
        description: '（示例工具：说明它能做什么、什么时候该用）',
        parameters: { type: 'object', properties: {}, required: [] },
        readOnly: true,
        async run(_args, toolCtx) {
          // toolCtx.llm(...) 可调用模型（自动入账 / 受护栏约束）——见 PACK-API §5
          return { ok: true, output: '来自 ' + ctx.packName + ' 的问候' };
        },
      },
    ],
    constraints: [
      // 领域红线示例：输出出现这些措辞即拦截（action: block / block-and-rewrite / warn）
      { id: 'no-forbidden-claim', kind: 'output-forbid', pattern: '（替换为你的禁用措辞，正则）', action: 'block-and-rewrite' },
    ],
    promptSections: [{ id: 'domain', order: 100, content: '（由 prompts/domain.md 读取，见下）' }],
  };
}
`
    );
    console.log(`✓ 已生成脚手架：${dir}`);
    console.log('下一步：');
    console.log(`  1. 编辑 ${path.join(dir, 'pack.json')}（描述/权限）与 pack.mjs（工具/约束）`);
    console.log(`  2. mingdao pack verify ${dir}`);
    return true;
  }

  if (sub === 'info') {
    const name = String(args[1] || '').trim();
    const found = listPacks(loadConfig() || {}, process.cwd()).find((p) => p.name === name);
    if (!found) {
      console.log(`[错误] 未发现 Pack "${name}"。可用：mingdao pack list`);
      process.exitCode = 1;
      return true;
    }
    if (found.error) {
      console.log(`[错误] ${name} 校验未通过：${found.error}`);
      process.exitCode = 1;
      return true;
    }
    // v0.6.5（独立审计 P0-2）：**信任门必须在这里也生效**。
    // `loadPack` 会 `import pack.mjs` —— 也就是以完整 Node 权限执行该目录里的代码；
    // 而未信任的项目级 Pack 恰恰是「clone 一个仓库就带进来」的第三方代码。
    // v0.6.2 修「clone 即执行」时只把门加在了 mountPacks 这条路径上（`pack list` 也会正确显示
    // 「⛔ 未信任（不挂载）」），但 `info` 直接 loadPack —— 于是"换个子命令就能执行"。
    // 与 `pack verify` 同口径：默认不执行代码，要执行必须显式确认（先 trust）。
    if (found.gate) {
      const root = found.gateDir || found.dir;
      console.log(`[错误] ${name} 未信任，拒绝加载（不执行其代码）。`);
      console.log(`  原因：项目内的 pack.mjs 会以**完整 Node 权限在本进程内执行**，不受 permission 模式约束。`);
      console.log(`  ${found.gate === 'changed' ? '该目录内容在信任后发生过变化，需重新确认。' : '确认这个目录是你信任的代码后，执行：'}`);
      console.log(`    mingdao pack trust ${root}`);
      process.exitCode = 1;
      return true;
    }
    const res = await loadPack(found.dir);
    if (!res.ok) {
      console.log(`[错误] ${name} 加载失败：${res.errors.join('；')}`);
      process.exitCode = 1;
      return true;
    }
    const c = res.contributions;
    console.log(`${found.name}${found.displayName ? '（' + found.displayName + '）' : ''} v${res.manifest.version}`);
    console.log(`  来源     ${found.source} · ${found.dir}`);
    console.log(`  兼容     apiVersion ${res.manifest.apiVersion} · engines.mingdao ${res.manifest.engines?.mingdao}`);
    console.log(`  描述     ${res.manifest.description || '（无）'}`);
    console.log(`  工具     ${(Array.isArray(c.tools) ? c.tools : []).map((/** @type {any} */ t) => `pack__${found.name}__${t.name}`).join(', ') || '（无）'}`);
    console.log(`  约束     ${(Array.isArray(c.constraints) ? c.constraints : []).map((/** @type {any} */ x) => `${x.id}(${x.kind})`).join(', ') || '（无）'}`);
    console.log(`  提示词段 ${(Array.isArray(c.promptSections) ? c.promptSections : []).map((/** @type {any} */ s) => s.id).join(', ') || '（无）'}`);
    return true;
  }

  // 未知子命令：不劫持整句，交回普通提问（与 handleUpdateFamily 同口径的保留词防护）
  return false;
}
