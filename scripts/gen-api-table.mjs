// 从 `src/index.js` **生成**开发者指南里的「公共 API 速查」表（v0.6.8，文档审计 F-M4）。
//
// 为什么要有这个脚本：那张表此前是手写的，于是写着"32 个 @stable 导出"，而代码里其实是 70 个
// ——整个 Pack API v1 与约束引擎（下游 Pack 作者最需要的面）都不在表里。手写清单必然漂移，
// 所以这里把它变成**可再生成、可校验**的东西：
//   node scripts/gen-api-table.mjs            # 打印表格（可直接粘进 docs/DEVELOPER.md）
//   node scripts/gen-api-table.mjs --check    # 与 docs/DEVELOPER.md 里的表比对，不一致即 exit 1
// 解析规则：`// —— @stable：<分组名> ——` / `// —— @experimental：<分组名> ——` 作为分组标记，
// 其后的 `export { a, b } from …` 块里的名字都属于该组（多行导出块也支持）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');

/**
 * 解析 `src/index.js` 的导出分组。
 * 分组标记形如 `// —— @stable：工具（含 v0.4.0 第三方注册）——`（**结尾的 `——` 前不一定有空格**）。
 * 支持单行与多行 `export { … } from '…'` 两种写法。
 * @returns {{stable: [string, string[]][], experimental: string[]}}
 */
export function parseExports() {
  /** @type {[string, string[]][]} */
  const stable = [];
  /** @type {[string, string[]][]} */
  const expPairs = [];
  /** @type {{name: string, names: string[], isStable: boolean}|null} */
  let cur = null;
  let inBlock = false;
  const addNames = (/** @type {string} */ text) => {
    if (!cur) return;
    for (const part of String(text).split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      if (!t) continue;
      const name = t.split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) cur.names.push(name);
    }
  };
  const flush = () => {
    if (cur && cur.names.length) (cur.isStable ? stable : expPairs).push([cur.name, [...new Set(cur.names)]]);
    cur = null;
    inBlock = false;
  };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const m = /^\/\/ —— (@stable|@experimental)：(.*?) ?——/.exec(line);
    if (m) {
      flush();
      cur = { name: m[2].trim(), names: [], isStable: m[1] === '@stable' };
      continue;
    }
    if (!cur) continue;
    let text = null;
    if (inBlock) text = line;
    else if (line.startsWith('export {')) {
      text = line.replace(/^export\s*\{/, '');
      inBlock = !line.includes('}');
    } else continue;
    if (text === null) continue;
    if (text.includes('}')) {
      addNames(text.slice(0, text.indexOf('}')));
      inBlock = false;
      continue;
    }
    addNames(text);
  }
  flush();
  return { stable, experimental: expPairs.flatMap(([, n]) => n) };
}

export function renderTable() {
  const { stable, experimental } = parseExports();
  const total = stable.reduce((a, [, n]) => a + n.length, 0);
  const lines = [];
  lines.push(`| 分组 | 导出（共 ${total} 个 \`@stable\`） |`);
  lines.push('| --- | --- |');
  for (const [name, names] of stable) lines.push(`| ${name} | ${names.map((n) => '`' + n + '`').join(' · ')} |`);
  lines.push('');
  lines.push(`\`@experimental\`（接口可能调整，共 ${experimental.length} 个）：${experimental.map((n) => '`' + n + '`').join(' · ')}。`);
  lines.push('');
  lines.push('> 本表由 `node scripts/gen-api-table.mjs` 从 `src/index.js` 生成；`scripts/doc-lint.mjs` 会校验它与代码一致（漂移即失败）。');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const table = renderTable();
  if (process.argv.includes('--check')) {
    const dev = fs.readFileSync(path.join(root, 'docs', 'DEVELOPER.md'), 'utf8');
    // 逐行比对"分组行"（形如 `| Agent 内核 | ... |`），避免受周围散文影响
    const want = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
    const got = dev.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
    const missing = want.filter((l) => !got.includes(l));
    if (missing.length) {
      console.error('docs/DEVELOPER.md 的 API 表与 src/index.js 不一致，缺失/过时行：');
      for (const l of missing.slice(0, 12)) console.error('  ' + l.slice(0, 160));
      console.error('请运行 `node scripts/gen-api-table.mjs` 重新生成并替换 §四 的表格。');
      process.exit(1);
    }
    console.log(`✓ DEVELOPER.md 的 API 表与 src/index.js 一致（${want.length} 个分组）`);
    process.exit(0);
  }
  console.log(table);
  process.exit(0);
}
