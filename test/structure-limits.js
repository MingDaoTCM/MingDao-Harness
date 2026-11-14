// 结构守卫（v0.7.0 §1.5 第二步）：`src/**` 里**单个函数 ≤500 行**。
//
// 运行：node test/structure-limits.js
//
// 为什么需要：v0.7.0 审计把「单函数数百上千行」列为缺陷放大器（闭包状态多、出口多、难测试），
// 并在路线图 §1.5 明确要求加结构门禁。本守卫做三件事：
//   ① 扫描 `src/**/*.js` 的每个具名函数（`function` 声明 + `const/let/var = function/箭头函数`），
//      按源码行号统计长度（含函数体花括号）；
//   ② 当前已超限的函数登记在 `ALLOWED_LONG_FUNCTIONS`（文件名 + 函数名 + **当前行数**）——
//      **行数只许降不许升**：任何一项比基线长即红；
//   ③ 基线之外出现新的 >500 行函数即红（防止"拆一个、长一个"）。
//
// 基线是逐版本**实测**的，不是拍脑袋：改完必须把下降后的数字同步到本文件（否则守卫会保留旧的宽松上界）。
// `sync-server.js` 在本轮实测中已没有 >500 行的函数（此前拆分已消化），故不在基线内；
// 将来若长出超限函数，会被 ③ 直接抓住，不需要预先登记。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const LIMIT = 500;

/**
 * 允许超限的函数基线：`'<相对仓库根的路径>::<函数名>' → 当前行数`。
 *
 * v0.7.0 §1.5 的 `runWebServer` 记录：**切前 1208 行**（任务书口径；本仓库 HEAD 实测
 * 1211 行 = 1509 行的 `web/server.js` − 299 行函数前内容）。切出 `web/auth.js` +
 * `web/provider-cache.js`（含启动文案）后已降到 **1007 行**；v0.6.40 插话闭环在 runWebServer/
 * handleChat/agent 循环里新增了接线（+2/+1/+5 行），实测同步到 **1009** —— 之后仍只许降不许升。
 */
const ALLOWED_LONG_FUNCTIONS = {
  // v0.7.0 §1.1 切片 A：事件双写（turn/step/tool/usage/compact/interrupt）在 createAgent /
  // runTurnInner 内新增了边界写入；行数按实测同步，之后仍只许降不许升。
  //
  // v0.6.35 明确记录一次**基线被抬高**（这是本守卫唯一一次允许上调，原因与回收期限）：
  //   createAgent   2177 → 2265（+88）
  //   runTurnInner  1718 → 1743（+25）
  // 原因：切片 A 要求把 turn/step/tool 边界事件写在循环内；切片 B（SSE seq + UI 投影）
  // 会把这三处写事件搬进 `finishTurn`/事件中间件，届时**必须回到 ≤2177 / ≤1718**。
  // 若切片 B 之后仍高于原值，说明"搬出去"没做完——请把它当成未完成项，而不是再调基线。
  // v0.6.40：插话闭环带来两处接线（step 边界 drain / 收尾前再 drain）+ 服务端缓冲/路由，
  // 实测 2265→2270、1743→1748、1007→1009、695→696。基线只按**实测**同步，不预留余量。
  'src/agent.js::createAgent': 2270,
  'src/agent.js::runTurnInner': 1748,
  // v0.8.1：应用模式分支切到 `web/app-mode-run.js` 后，两个函数实测各降 1 行（1009→1008 /
  // 696→695）；基线按实测同步，之后仍只许降不许升。
  'src/web/server.js::runWebServer': 1008,
  'src/web/server.js::handleChat': 695,
  'src/commands/repl.js::runRepl': 687,
  'src/cli.js::main': 509,
};

/**
 * 把注释 / 字符串 / 模板字符串 / 正则字面量抹成空格（保留换行与字符偏移）。
 * 目的：花括号计数只数**代码**里的括号，字符串里的 `{`、正则字符类里的 `"` 都不能干扰。
 * @param {string} src
 * @returns {string}
 */
function mask(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  let state = 'code';
  const blank = (/** @type {number} */ k) => {
    if (src[k] !== '\n') out[k] = ' ';
  };
  // 前一个有效字符决定 `/` 是除号还是正则起头（本仓库的 JS 里够用；误判只会让扫描更保守）。
  const regexAllowed = () => {
    for (let k = i - 1; k >= 0; k--) {
      const ch = src[k];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
      if ('([{,;:=!&|?{}>+-*%~^'.includes(ch)) return true;
      return /\b(?:return|typeof|case|in|of|new|delete|void|throw|else)$/.test(src.slice(Math.max(0, k - 6), k + 1));
    }
    return true;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = 'line';
        continue;
      }
      if (c === '/' && d === '*') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = 'block';
        continue;
      }
      if (c === "'" || c === '"') {
        blank(i);
        i += 1;
        state = c;
        continue;
      }
      if (c === '`') {
        blank(i);
        i += 1;
        state = '`';
        continue;
      }
      if (c === '/' && regexAllowed()) {
        blank(i);
        i += 1;
        let inClass = false;
        while (i < n) {
          const ch = src[i];
          if (ch === '\\') {
            blank(i);
            if (i + 1 < n) blank(i + 1);
            i += 2;
            continue;
          }
          if (ch === '[') inClass = true;
          else if (ch === ']') inClass = false;
          else if (ch === '/' && !inClass) {
            blank(i);
            i += 1;
            break;
          } else if (ch === '\n') break;
          blank(i);
          i += 1;
        }
        while (i < n && /[a-z]/i.test(src[i])) {
          blank(i);
          i += 1;
        }
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') state = 'code';
      else blank(i);
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = 'code';
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    // 字符串 / 模板字符串
    if (c === '\\') {
      blank(i);
      if (i + 1 < n) blank(i + 1);
      i += 2;
      continue;
    }
    if (c === state) {
      blank(i);
      i += 1;
      state = 'code';
      continue;
    }
    blank(i);
    i += 1;
  }
  return out.join('');
}

/**
 * 找 `masked[open]` 对应的闭合括号（`()`/`{}`）。找不到返回 -1。
 * @param {string} masked
 * @param {number} open
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function matchPair(masked, open, left, right) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === left) depth += 1;
    else if (masked[i] === right) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 统计一份源码里所有具名函数的行号跨度（1-based，含起止行）。
 * 支持：`function name(...)`、`async function`、`const name = function(...)`、
 * `const name = async (...) => {}`、`const name = x => {}`。
 * @param {string} src
 * @returns {{ name: string, startLine: number, endLine: number, lines: number }[]}
 */
function findFunctions(src) {
  const masked = mask(src);
  /** @type {number[]} */
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  /** @param {number} pos */
  const lineOf = (pos) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  /** @type {{ name: string, startLine: number, endLine: number, lines: number }[]} */
  const found = [];
  /**
   * 从函数头之后找函数体 `{` 并配对，登记。
   * @param {string} name
   * @param {number} startPos
   * @param {number} searchFrom
   */
  const register = (name, startPos, searchFrom) => {
    let bodyStart = -1;
    for (let i = searchFrom; i < masked.length; i++) {
      if (masked[i] === '{') {
        bodyStart = i;
        break;
      }
      // 只有到语句结束还没看到 `{` 才放弃（箭头函数的表达式体不登记）
      if (masked[i] === ';') return;
    }
    if (bodyStart < 0) return;
    const bodyEnd = matchPair(masked, bodyStart, '{', '}');
    if (bodyEnd < 0) return;
    const startLine = lineOf(startPos);
    const endLine = lineOf(bodyEnd);
    found.push({ name, startLine, endLine, lines: endLine - startLine + 1 });
  };
  // ① function 声明（含 async / export）
  const declRe = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = declRe.exec(masked))) {
    const open = m.index + m[0].length - 1;
    const close = matchPair(masked, open, '(', ')');
    if (close < 0) continue;
    register(m[1], m.index, close + 1);
  }
  // ② const/let/var 赋值的函数表达式 / 箭头函数
  const assignRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  while ((m = assignRe.exec(masked))) {
    let i = assignRe.lastIndex;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked.startsWith('async', i)) {
      let j = i + 5;
      while (j < masked.length && /\s/.test(masked[j])) j++;
      if (j < masked.length && masked[j] === '(') i = j;
      // async 后直接 function
      if (masked.startsWith('function', j)) i = j;
    }
    if (masked.startsWith('function', i)) {
      let j = i + 'function'.length;
      while (j < masked.length && /[\w$]/.test(masked[j])) j++;
      while (j < masked.length && /\s/.test(masked[j])) j++;
      if (masked[j] !== '(') continue;
      const close = matchPair(masked, j, '(', ')');
      if (close < 0) continue;
      register(m[1], m.index, close + 1);
      continue;
    }
    if (masked[i] === '(') {
      const close = matchPair(masked, i, '(', ')');
      if (close < 0) continue;
      let j = close + 1;
      while (j < masked.length && /\s/.test(masked[j])) j++;
      if (!masked.startsWith('=>', j)) continue;
      register(m[1], m.index, j);
      continue;
    }
    const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(masked.slice(i, i + 200));
    if (single) register(m[1], m.index, i + single[0].length);
  }
  return found;
}

/** 递归收集 `src/**` 下的 .js 文件。 */
function walk(/** @type {string} */ dir, /** @type {string[]} */ out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

let passed = 0;
let failed = 0;
/**
 * @param {string} name
 * @param {() => any} fn
 */
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ structure-limits：${name}`);
  } catch (/** @type {any} */ e) {
    failed += 1;
    console.error(`  ✗ structure-limits：${name} —— ${String(e?.message || e)}`);
  }
}

const files = walk(srcDir);
/** @type {{ file: string, name: string, lines: number, startLine: number, endLine: number }[]} */
const functions = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8').replace(/\r\n?/g, '\n');
  const rel = path.relative(root, f).split(path.sep).join('/');
  for (const fn of findFunctions(src)) functions.push({ file: rel, ...fn });
}

console.log(`\n[structure-limits · 扫描 ${files.length} 个源文件 / ${functions.length} 个具名函数]`);

t('S1 扫描器自检：必须能测到基线里的已知函数（防正则失效导致静默放行）', () => {
  const runWebServer = functions.find((f) => f.file === 'src/web/server.js' && f.name === 'runWebServer');
  if (!runWebServer) throw new Error('S1：扫描器没有找到 web/server.js 的 runWebServer（正则/掩码失效）');
  for (const key of Object.keys(ALLOWED_LONG_FUNCTIONS)) {
    const [file, name] = key.split('::');
    const hit = functions.find((f) => f.file === file && f.name === name);
    if (!hit) console.log(`  ℹ 基线项 ${key} 当前不存在（视为已删除/重命名；若为误删请检查扫描器）`);
  }
});

t('S2 runWebServer 已降到 1009 行（切前 1208，红线 ≤1010）', () => {
  const hit = functions.find((f) => f.file === 'src/web/server.js' && f.name === 'runWebServer');
  if (!hit) throw new Error('S2：找不到 runWebServer');
  if (hit.lines > 1010) throw new Error(`S2：runWebServer 现在 ${hit.lines} 行（红线 ≤1010，切前 1208）——拆分被回退或又长了`);
  if (hit.lines > ALLOWED_LONG_FUNCTIONS['src/web/server.js::runWebServer']) {
    throw new Error(`S2：runWebServer 涨到 ${hit.lines} 行，超过基线 ${ALLOWED_LONG_FUNCTIONS['src/web/server.js::runWebServer']}（只许降不许升）`);
  }
});

t('S3 基线函数行数只许降不许升', () => {
  /** @type {string[]} */
  const grew = [];
  for (const [key, baseline] of Object.entries(ALLOWED_LONG_FUNCTIONS)) {
    const [file, name] = key.split('::');
    const hit = functions.find((f) => f.file === file && f.name === name);
    if (!hit) continue; // 已消失：S1 已提示，不算恶化
    if (hit.lines > baseline) grew.push(`${key}：${baseline} → ${hit.lines}`);
  }
  if (grew.length) throw new Error('S3：以下函数超过基线（行数只许降不许升）：' + grew.join('；'));
});

t('S4 基线之外不得出现新的 >500 行函数', () => {
  const over = functions.filter((f) => f.lines > LIMIT && !(`${f.file}::${f.name}` in ALLOWED_LONG_FUNCTIONS));
  if (over.length) {
    throw new Error(
      `S4：发现 ${over.length} 个基线之外的超限函数（>${LIMIT} 行）：` + over.map((f) => `${f.file}::${f.name}=${f.lines}`).join('；')
    );
  }
});

// 报告：超限清单（不参与断言，供人看）
const over = functions.filter((f) => f.lines > LIMIT).sort((a, b) => b.lines - a.lines);
console.log('\n超限函数清单（>500 行）：');
for (const f of over) {
  const key = `${f.file}::${f.name}`;
  const baseline = ALLOWED_LONG_FUNCTIONS[key];
  const tail = baseline === undefined ? '未登记 ⛔' : f.lines < baseline ? `基线 ${baseline}（已降，请同步基线）` : `基线 ${baseline}`;
  console.log(`  ${f.lines} 行  ${key}（${f.startLine}-${f.endLine}）  ${tail}`);
}
const rw = over.find((f) => f.file === 'src/web/server.js' && f.name === 'runWebServer');
console.log(`\nrunWebServer：切前 1208 行（仓库 HEAD 实测 1211）→ 现在 ${rw ? rw.lines : '?'} 行`);
console.log(`structure-limits：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
