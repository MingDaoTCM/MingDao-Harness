// `mingdao pack` 命令族（v0.5.0 阶段 A）：垂域 Pack 的查看 / 校验 / 脚手架。
// 下游 CI 门禁入口是 `mingdao pack verify <dir>`——它只做静态校验（不 import Pack 代码），
// 因此可以在没有内核运行时的环境里安全执行。
import fs from 'node:fs';
import path from 'node:path';
import { listPacks, loadPack, validateManifest, coreVersionOf, SUPPORTED_PACK_API, CONSTRAINT_KINDS, packedDirsForHelp } from '../packs.js';

const HELP = `用法：
  mingdao pack list                 已发现的 Pack（名/版本/来源/兼容状态）
  mingdao pack verify <目录>        静态校验 manifest + 文件齐全 + 约束合法（下游 CI 门禁）
  mingdao pack new <名字>           生成最小可用 Pack 脚手架
  mingdao pack info <名字>          单个 Pack 的贡献面明细

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
    const found = listPacks({}, process.cwd());
    if (!found.length) {
      console.log('未发现任何 Pack。');
      console.log(`放置位置（三级遮蔽）：<项目>/.mingdao/packs/ > ${packedDirsForHelp()} > 内置 packs/`);
      console.log('或运行 mingdao pack new <名字> 生成脚手架。');
      return true;
    }
    console.log(`共 ${found.length} 个 Pack（内核 ${coreVersionOf()}）：`);
    for (const p of found) {
      const status = p.error ? `❌ ${p.error}` : `✅ apiVersion ${p.apiVersion}`;
      console.log(`  ${p.name}${p.displayName ? '（' + p.displayName + '）' : ''} v${p.version || '?'} · 来源 ${p.source} · ${status}`);
      console.log(`      ${p.dir}`);
    }
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
    // 再走一次完整加载（会 import pack.mjs，验证运行时契约）
    const res = await loadPack(abs);
    if (!res.ok) {
      console.log(`[失败] ${manifest.name} 加载校验未通过：`);
      res.errors.forEach((/** @type {any} */ e, /** @type {number} */ i) => console.log(`  ${i + 1}. ${e}`));
      process.exitCode = 1;
      return true;
    }
    const c = res.contributions;
    console.log(`[通过] ${manifest.name} v${manifest.version}（apiVersion ${manifest.apiVersion}，内核窗口 ${manifest.engines?.mingdao}）`);
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
    const found = listPacks({}, process.cwd()).find((p) => p.name === name);
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
