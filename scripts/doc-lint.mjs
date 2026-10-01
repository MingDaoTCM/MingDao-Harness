// 文档守卫（v0.6.8，文档审计 §7.7 的建议）：把"文档与代码不一致"变成 CI 红，而不是靠人肉复查。
//
// 为什么需要：本项目已经吃过太多次"文档说了、代码没做"（反向也有）——
// 报告列出的就有：ARCHITECTURE 停在 v0.1.x、PACK-API 列了未实现的 kind、
// README 的 CI 矩阵与模型 id 过时、开发者指南的 API 表漏了一半 @stable 导出、
// 发布说明写着"待发布"而版本早发了、唯一的坏链没人发现。
// 这些都不是能力问题，是**没有守卫**。本脚本一次把可机械判定的那些钉住：
//   ① 相对链接必须解析得到文件（F-L1）
//   ② 每个 CLI 分发的子命令必须出现在 --help（F-L6）
//   ③ PACK-API 里点名的 constraint kind 必须在 KINDS 里，或就地标注"未实现"（F-M5）
//   ④ README/DEVELOPER 提到的模型 id 必须存在于 MODELS，旧名必须标注（F-M12）
//   ⑤ ARCHITECTURE.md 必须提到**每一个** src 模块（F-H1，防再次滞后）
//   ⑥ 变异总数（文档 vs 脚本里的 name: 条数）（F-M1）
//   ⑦ 开发者指南的 API 表必须等于从 src/index.js 生成的表（F-M4）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */
const problems = [];
const rel = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).join('/');
const tracked = (() => {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.coverage' || e.name === 'dist') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(f);
    }
  };
  walk(root);
  return out;
})();

// ① 相对链接（唯一的坏链曾被报告点名）
{
  let checked = 0;
  for (const f of tracked.filter((p) => p.endsWith('.md'))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      checked += 1;
      const abs = path.resolve(path.dirname(f), decodeURIComponent(clean));
      if (!fs.existsSync(abs)) problems.push(`坏链：${rel(f)} → ${target}`);
    }
  }
  console.log(`① 相对链接：检查 ${checked} 条`);
}

// ② CLI 分发表 ⊆ --help（help 是单源的，漏列等于用户看不到命令）
{
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  const block = cli.slice(cli.indexOf('const dispatchTable'), cli.indexOf('const hit = dispatchTable'));
  const keys = [...block.matchAll(/^\s{6}([a-z][a-z0-9-]*):\s*\{/gm)].map((m) => m[1]);
  const { helpLines } = await import(pathToFileURL(path.join(root, 'src', 'help.js')).href);
  const text = helpLines({ variant: 'cli' })
    .map(([line]) => String(line))
    .join('\n');
  for (const k of keys) if (!new RegExp(`(^|[\\s|])${k}([\\s,]|$)`).test(text)) problems.push(`--help 漏掉了子命令：${k}（src/cli.js 分发它）`);
  console.log(`② 子命令覆盖：分发 ${keys.length} 个，help 文本已核对`);
}

// ③ PACK-API 的 kind 表（未实现的必须就地标注）
{
  const cs = fs.readFileSync(path.join(root, 'src', 'constraints.js'), 'utf8');
  const kinds = new Set([...((/KINDS = new Set\(\[([^\]]*)\]\)/.exec(cs) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  const pak = fs.readFileSync(path.join(root, 'docs', 'PACK-API.md'), 'utf8');
  const known = new Set([...fs.readFileSync(path.join(root, 'src', 'packs.js'), 'utf8').matchAll(/require-citation/g)].map(() => 'require-citation'));
  let seen = 0;
  for (const line of pak.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`([a-z][a-z-]{2,})`/g)) {
      const kind = m[1];
      const looksLikeKind = kind.includes('-') && (kinds.has(kind) || known.has(kind) || /-forbid$|-require$|^completeness$/.test(kind));
      if (!looksLikeKind) continue;
      seen += 1;
      if (!kinds.has(kind) && !/未实现/.test(line)) problems.push(`PACK-API.md 把未实现的 kind 当成可用：${kind}（该行未标注"未实现"）`);
    }
  }
  console.log(`③ PACK-API kind：KINDS=${kinds.size} 个，表中提及 ${seen} 处`);
}

// ④ 模型 id（README/DEVELOPER 提到的必须在 MODELS 里；旧名必须标注）
{
  const modelsSrc = fs.readFileSync(path.join(root, 'src', 'models.js'), 'utf8');
  const models = new Set([...modelsSrc.matchAll(/^\s{2}'([a-z0-9][\w.-]*)':\s*\{/gm)].map((m) => m[1]));
  const legacy = new Set([...((/MODEL_ALIASES = \{([^}]*)\}/.exec(modelsSrc) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  let seen = 0;
  for (const f of ['README.md', 'docs/DEVELOPER.md'].map((x) => path.join(root, x))) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      for (const m of line.matchAll(/`(deepseek-[a-z0-9.-]+)`/g)) {
        const id = m[1];
        seen += 1;
        if (!models.has(id)) problems.push(`${rel(f)} 提到不存在的模型 id：${id}`);
        else if (legacy.has(id) && !/旧名|兼容|改名/.test(line)) problems.push(`${rel(f)} 用了旧模型名 ${id} 但没标注（官方已改名）`);
      }
    }
  }
  console.log(`④ 模型 id：MODELS=${models.size} 个、旧名 ${legacy.size} 个，文档提及 ${seen} 处`);
}

// ⑤ ARCHITECTURE.md 必须覆盖全部 src 模块（防再次滞后到 v0.1.x 口径）
{
  const arch = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const mods = tracked.filter((p) => p.includes(`${path.sep}src${path.sep}`) && p.endsWith('.js')).map((p) => rel(p).slice(4));
  const missing = mods.filter((m) => !arch.includes(m) && !arch.includes(path.basename(m)));
  if (missing.length) problems.push(`docs/ARCHITECTURE.md 未提到 ${missing.length}/${mods.length} 个 src 模块：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' …' : ''}`);
  console.log(`⑤ 架构文档：src 模块 ${mods.length} 个，未提及 ${missing.length} 个`);
}

// ⑥ 变异总数（文档写的必须等于脚本里真实的 name: 条数）
{
  const dir = path.join(root, 'test', 'mutate');
  const files = fs.readdirSync(dir).filter((f) => /^batch.*\.mjs$/.test(f));
  let actual = 0;
  for (const f of files) actual += [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s{2}name:\s*'/gm)].length;
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const claimed = Number((/变异总数[:：]\s*(\d+)/.exec(readme) || [0, NaN])[1]);
  if (!Number.isFinite(claimed)) problems.push('test/mutate/README.md 必须写明「变异总数：N」（供守卫比对）');
  else if (claimed !== actual) problems.push(`变异总数不一致：README 写 ${claimed}，脚本里实际 ${actual} 条`);
  console.log(`⑥ 变异总数：实际 ${actual} 条（README 写 ${claimed}）`);
}

// ⑦ 开发者指南的 API 表
{
  const { renderTable } = await import(pathToFileURL(path.join(root, 'scripts', 'gen-api-table.mjs')).href);
  const want = renderTable().split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
  const dev = fs.readFileSync(path.join(root, 'docs', 'DEVELOPER.md'), 'utf8');
  const got = dev.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
  const missing = want.filter((l) => !got.includes(l));
  if (missing.length) problems.push(`docs/DEVELOPER.md 的 API 表与 src/index.js 不一致（缺 ${missing.length} 组，跑 node scripts/gen-api-table.mjs 重新生成）`);
  console.log(`⑦ API 表：应有 ${want.length} 组`);
}

// ⑧ 只读工具集合：文档里点名的必须与 READONLY_TOOLS 一致
{
  const tools = fs.readFileSync(path.join(root, 'src', 'tools', 'index.js'), 'utf8');
  const ro = new Set([...((/READONLY_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(tools) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  const docs = ['docs/CONFIG.md', 'docs/ARCHITECTURE.md'].map((x) => path.join(root, x)).filter((p) => fs.existsSync(p));
  for (const f of docs) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/只读[^\n]*?\(?((?:read|ls|glob|grep|skill|git|fetch)(?:\/(?:read|ls|glob|grep|skill|git|fetch))+)\)?/g)) {
      for (const name of m[1].split('/')) if (!ro.has(name)) problems.push(`${rel(f)} 把 ${name} 列为只读，但 READONLY_TOOLS 里没有`);
    }
  }
  console.log(`⑧ 只读工具：READONLY_TOOLS=${[...ro].join('/')}`);
}

if (problems.length) {
  console.error(`\n✗ 文档守卫发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  · ' + p);
  console.error('\n（这些守卫的意义是：文档漂移在 CI 就红，而不是等第三方审计指出。）');
  process.exit(1);
}
console.log('\n✓ 文档守卫全部通过');
