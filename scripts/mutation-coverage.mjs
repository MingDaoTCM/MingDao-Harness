// 变异覆盖盲区检查（v0.7.0 §1.2）：找出「有真实逻辑、却一条变异都没有」的模块。
//
// 背景：v0.6.32 的自审实测里，633→669 条变异中 **4 个文件占了 285 条**
// （agent.js 82 / app.js 81 / server.js 63 / index.html 59），而 90 个模块里有 43 个
// **0 条变异**。变异分数的口径是「改过的都被测了」，它对「从没被改过的模块」完全沉默——
// 那不是安全，只是没尺子。本脚本把这份沉默变成可复现的清单，并可当作 CI 门禁。
//
// 用法：
//   node scripts/mutation-coverage.mjs                 # 只报告（默认退出 0）
//   node scripts/mutation-coverage.mjs --fail-over 0   # 盲区数 > 0 即失败（CI 卡新增盲区）
//   node scripts/mutation-coverage.mjs --fail-over 40  # 只允许已有 40 个盲区（存量基线）
//   node scripts/mutation-coverage.mjs --min-lines 150  # 调整「有真实逻辑」的行数门槛
//   node scripts/mutation-coverage.mjs --json          # 机器可读（CI/仪表盘用）
//
// 口径（刻意简单、可解释）：
//   · 「代码行」= 去掉空行与**纯注释行**后的行数（逐字符识别 `//`、`/* */`，
//     以及字符串/模板字面量里出现的 `//` 不算注释）；不解析正则字面量——它只会让
//     「代码行」略微高估或低估，不改变「有没有真实逻辑」的判断。
//   · 「变异条数」= 该文件在所有 `test/mutate/batch*.mjs` 的 `file:` 字段里出现的次数。
//     只统计 `src/**` 下的文件；脚本/desktop/ide 的变异不计入内核模块覆盖。
//   · 盲区 = 代码行 > min-lines（默认 150）且变异条数 === 0。
//
// 这个脚本**不修改任何文件**，也不依赖覆盖率数据（V8 覆盖率回答的是「执行过没有」，
// 与「改坏了会不会被抓到」是两个问题）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(here, '..');

/** 逐行判断是否「纯注释/空行」——与覆盖率报告同一类启发式（此处独立实现，仅用于行数口径）。 */
export function countCodeLines(/** @type {string} */ source) {
  const src = String(source).replace(/\r\n?/g, '\n');
  let inBlock = false;
  let count = 0;
  for (const line of src.split('\n')) {
    let i = 0;
    let hasCode = false;
    while (i < line.length) {
      const ch = line[i];
      const next = line[i + 1];
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) {
          i = line.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (ch === '/' && next === '/') break; // 行注释：本行其后不再有代码
      if (ch === '/' && next === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        // 字符串字面量：整段跳过（含转义），内部的 // 与 /* 都不是注释
        const quote = ch;
        hasCode = true;
        i += 1;
        while (i < line.length) {
          if (line[i] === '\\') {
            i += 2;
            continue;
          }
          if (line[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch !== ' ' && ch !== '\t' && ch !== '\r') hasCode = true;
      i += 1;
    }
    if (hasCode) count += 1;
  }
  return count;
}

/** 递归列出 `src/**` 下的 .js 文件（相对仓库根、POSIX 分隔符）。 */
export function listSrcFiles(/** @type {string} */ root = repoRoot) {
  const out = [];
  const walk = (/** @type {string} */ dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, 'src'));
  return out.sort();
}

/** 从全部 `test/mutate/batch*.mjs` 里抽出被变异的文件 → 条数。 */
export function mutationCounts(/** @type {string} */ root = repoRoot) {
  const dir = path.join(root, 'test', 'mutate');
  /** @type {Map<string, number>} */
  const counts = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^batch.*\.mjs$/.test(f)).sort();
  } catch {
    return counts;
  }
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    // 本仓约定：M.mutate({ ..., file: 'src/x.js', ... })。同时接受双引号与反引号。
    const re = /\bfile\s*:\s*(['"`])([^'"`]+)\1/g;
    let m;
    while ((m = re.exec(src))) {
      const rel = m[2].replace(/\\/g, '/');
      if (!rel.startsWith('src/')) continue;
      counts.set(rel, (counts.get(rel) || 0) + 1);
    }
  }
  return counts;
}

/**
 * @param {{root?: string, minLines?: number}} [opts]
 * @returns {{modules: {file: string, codeLines: number, mutations: number}[], blind: {file: string, codeLines: number, mutations: number}[], totalModules: number, totalMutations: number}}
 */
export function scan({ root = repoRoot, minLines = 150 } = {}) {
  const counts = mutationCounts(root);
  const modules = listSrcFiles(root).map((file) => ({
    file,
    codeLines: countCodeLines(fs.readFileSync(path.join(root, file), 'utf8')),
    mutations: counts.get(file) || 0,
  }));
  const blind = modules.filter((m) => m.codeLines > minLines && m.mutations === 0).sort((a, b) => b.codeLines - a.codeLines || a.file.localeCompare(b.file));
  const totalMutations = [...counts.values()].reduce((a, b) => a + b, 0);
  return { modules, blind, totalModules: modules.length, totalMutations };
}

export function formatReport(/** @type {ReturnType<typeof scan>} */ { modules, blind, totalModules, totalMutations }, /** @type {number} */ minLines) {
  const lines = [];
  lines.push(`变异覆盖盲区检查（阈值：代码行 > ${minLines} 且 0 条变异）`);
  lines.push(`  src 模块：${totalModules} 个；src/** 变异条目：${totalMutations} 条；盲区模块：${blind.length} 个`);
  if (!blind.length) {
    lines.push('  ✅ 没有盲区模块');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('  模块（按代码行降序）：');
  const width = Math.max(...blind.map((b) => b.file.length), '模块'.length);
  lines.push(`  ${'模块'.padEnd(width)}  代码行  变异`);
  for (const b of blind) {
    lines.push(`  ${b.file.padEnd(width)}  ${String(b.codeLines).padStart(6)}  ${String(b.mutations).padStart(4)}`);
  }
  lines.push('');
  lines.push(`  合计：${blind.length} 个模块、${blind.reduce((a, b) => a + b.codeLines, 0)} 行代码没有可抓的变异。`);
  return lines.join('\n');
}

export function main(/** @type {string[]} */ argv = process.argv.slice(2)) {
  let minLines = 150;
  /** @type {number|null} */
  let failOver = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--min-lines') {
      minLines = Number(argv[++i]);
      if (!Number.isFinite(minLines) || minLines < 0) {
        console.error('✗ --min-lines 需要一个非负数字');
        return 2;
      }
    } else if (a.startsWith('--min-lines=')) {
      minLines = Number(a.slice('--min-lines='.length));
      if (!Number.isFinite(minLines) || minLines < 0) {
        console.error('✗ --min-lines 需要一个非负数字');
        return 2;
      }
    } else if (a === '--fail-over') {
      // 不带值时按 0：即「一有盲区就失败」——CI 里最常用的形态。
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('-')) {
        failOver = Number(v);
        i += 1;
      } else {
        failOver = 0;
      }
      if (!Number.isInteger(failOver) || failOver < 0) {
        console.error('✗ --fail-over 需要一个非负整数');
        return 2;
      }
    } else if (a.startsWith('--fail-over=')) {
      failOver = Number(a.slice('--fail-over='.length));
      if (!Number.isInteger(failOver) || failOver < 0) {
        console.error('✗ --fail-over 需要一个非负整数');
        return 2;
      }
    } else if (a === '--help' || a === '-h') {
      console.log('用法：node scripts/mutation-coverage.mjs [--fail-over N] [--min-lines N] [--json]');
      return 0;
    } else {
      console.error(`✗ 未知参数：${a}`);
      return 2;
    }
  }
  const result = scan({ root: repoRoot, minLines });
  if (json) {
    console.log(JSON.stringify({ minLines, ...result }, null, 2));
  } else {
    console.log(formatReport(result, minLines));
  }
  if (failOver !== null && result.blind.length > failOver) {
    console.error(`\n✗ 盲区模块 ${result.blind.length} 个，超过 --fail-over ${failOver}——请给这些模块补行为套件与变异批次（见 docs/DEVELOPER.md §八）。`);
    return 1;
  }
  return 0;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) process.exit(main());
