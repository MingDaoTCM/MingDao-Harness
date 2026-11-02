// 灾难性回溯（ReDoS）判定的**单一来源**（v0.6.7，报告一 M-5 / M-14②）。
//
// 为什么单独成模块：同一个判定此前有**两份**实现，且都不完整——
//   · `constraints.js` 只看嵌套量词（`(a+)+`），于是 `(a|aa)+` 装载即通过；
//   · `tools/fs-tools.js` 的 `hasAmbiguousAlternation` 只扫**单层**括号（`\(([^()]*)\)`），
//     于是 `((a|ab)x)+` 连它也绕过去（报告实测：这类模式对长模型输出同步指数回溯，冻结进程）。
// 判定对象来自第三方 Pack / 用户配置（`pattern` 类约束），匹配对象是**模型输出**——
// 也就是可被外部文本影响的内容。两份实现里**最弱的那份说了算**，这正是本项目反复登记的根因。
//
// 口径：**装载时 fail-closed 拒绝**（宁可让作者改写 pattern，也不让内核在长输出上卡死）。
// 判定刻意保守——只拦"被量词修饰的组内出现歧义分支/嵌套量词"这类教科书形状，
// 不动 `(a|b)+`、`(ab)+`、`(a+)?` 这些常见且安全的写法。
//
// v0.6.31（第三方代码审计 H-13 / 核验报告 C-1）：原判据还有两个可被**语义等价写法**绕过的口子：
//   ① 交替分支按**源码首字符**比较：`^(\d|[\d])+$` 的两个分支首字符是 `\` 与 `[`，于是放行；
//      实测 29 字符输入同步阻塞 9.6~19s（不同机器），把整个进程（WebUI/SSE/权限弹窗）冻死。
//      现在把分支首字符归一化为**字符集**再比较（`\d` 与 `[\d]` 都归一为数字区间）。
//   ② **相邻无界量词**（`a*a*a*a*a*a*a*a*b`、`\d+\d*`、`.*.*`）：量词各自有界、但相邻且字符集重叠，
//      切分方式组合爆炸（8 个 `a*` 对 20KB 单行是天文级回溯）。现在补一条专门的判定。
//
// 覆盖范围：约束装载 / Pack 校验（经 `hasNestedQuantifier` + `hasAmbiguousAlternation`）与
// grep 工具（经 `patternRejectionReason`）仍共用本文件；`tools/fs-tools.js` 不再维护第二份更弱的判据。

const ANY = /** @type {null} */ (null); // null = 任意字符（`.`、`\D`、`[^x]`、无法解析的集合）
/** @typedef {Array<[number, number]>} CharRanges */

/** 并集：任一侧为 ANY 即 ANY；空集是并集单位元。 @param {CharRanges|null} a @param {CharRanges|null} b */
function union(a, b) {
  if (a === ANY || b === ANY) return ANY;
  if (!a.length) return b;
  if (!b.length) return a;
  return a.concat(b);
}

/** 两个字符集是否有交集。ANY/未知与任何集合都算相交（fail-closed）。 @param {CharRanges|null} a @param {CharRanges|null} b */
function overlap(a, b) {
  if (a === ANY || b === ANY) return true;
  if (!a.length || !b.length) return false;
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      if (alo <= bhi && blo <= ahi) return true;
    }
  }
  return false;
}

const DIGIT = /** @type {CharRanges} */ ([[48, 57]]);
const WORD = /** @type {CharRanges} */ ([[48, 57], [65, 90], [95, 95], [97, 122]]);
const SPACE = /** @type {CharRanges} */ ([
  [9, 13], [32, 32], [160, 160], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
]);

/** 从 `\` 处解析一个转义可以匹配的字符集（`\b`/`\B` 由调用方当零宽断言处理）。
 * @param {string} src @param {number} i @returns {{ set: CharRanges|null, next: number }}
 */
function escapeSet(src, i) {
  const e = src[i + 1];
  if (e === undefined) return { set: ANY, next: src.length };
  if (e === 'd') return { set: DIGIT, next: i + 2 };
  if (e === 'w') return { set: WORD, next: i + 2 };
  if (e === 's') return { set: SPACE, next: i + 2 };
  // 补集/Unicode 属性类：不在此精确建模，按「任意字符」fail-closed
  if (e === 'D' || e === 'W' || e === 'S' || e === 'p' || e === 'P') return { set: ANY, next: i + 2 };
  const lit = /** @type {(cp: number) => { set: CharRanges|null, next: number }} */ ((cp) => ({
    set: cp >= 0 && cp <= 0xffff ? [[cp, cp]] : ANY,
    next: i + 2,
  }));
  if (e === 'n') return lit(10);
  if (e === 'r') return lit(13);
  if (e === 't') return lit(9);
  if (e === 'f') return lit(12);
  if (e === 'v') return lit(11);
  if (e === '0') return lit(0);
  if (e === 'x') {
    const h = src.slice(i + 2, i + 4);
    if (/^[0-9a-fA-F]{2}$/.test(h)) return { set: [[parseInt(h, 16), parseInt(h, 16)]], next: i + 4 };
    return { set: ANY, next: i + 2 };
  }
  if (e === 'u') {
    if (src[i + 2] === '{') {
      const close = src.indexOf('}', i + 3);
      const h = close > 0 ? src.slice(i + 3, close) : '';
      if (/^[0-9a-fA-F]{1,6}$/.test(h)) {
        const cp = parseInt(h, 16);
        return { set: cp <= 0xffff ? [[cp, cp]] : ANY, next: close + 1 };
      }
      return { set: ANY, next: i + 2 };
    }
    const h = src.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(h)) return { set: [[parseInt(h, 16), parseInt(h, 16)]], next: i + 6 };
    return { set: ANY, next: i + 2 };
  }
  if (e === 'c') {
    const c = src[i + 2];
    if (c !== undefined && /[A-Za-z]/.test(c)) return lit(c.toUpperCase().charCodeAt(0) - 64);
    return { set: ANY, next: i + 2 };
  }
  // 其余转义（\.、\\、\]、\- 等）就是字面量
  return { set: [[e.charCodeAt(0), e.charCodeAt(0)]], next: i + 2 };
}

/** 找字符类结尾 `]` 的下标（处理转义；`[]]`/`[^]]` 里的首个 `]` 是字面量）。
 * @param {string} src @param {number} i（指向 `[`） @returns {number}
 */
function classEnd(src, i) {
  let j = i + 1;
  if (src[j] === '^') j += 1;
  if (src[j] === ']') j += 1; // 首个 ] 是字面量
  for (; j < src.length; j += 1) {
    if (src[j] === '\\') { j += 1; continue; }
    if (src[j] === ']') return j;
  }
  return src.length - 1;
}

/** 字符类 `[...]`（含方括号）→ 字符区间集；无法精确建模时返回 ANY（fail-closed）。
 * @param {string} raw @returns {CharRanges|null}
 */
function classSet(raw) {
  const body = raw.slice(1, -1);
  if (!body) return [];
  if (body[0] === '^') return ANY;
  /** @type {CharRanges} */
  let out = [];
  let i = 0;
  while (i < body.length) {
    /** @type {CharRanges|null} */
    let set;
    let consumed;
    if (body[i] === '\\') {
      const r = escapeSet(body, i);
      set = r.set;
      consumed = r.next - i;
    } else {
      set = /** @type {CharRanges} */ ([[body.charCodeAt(i), body.charCodeAt(i)]]);
      consumed = 1;
    }
    if (set === ANY) return ANY;
    if (!set.length) { i += consumed; continue; }
    // 区间 a-z（只支持「单字符 - 单字符」；其余按字面量处理）
    if (set.length === 1 && set[0][0] === set[0][1] && body[i + consumed] === '-' && i + consumed + 1 < body.length) {
      const j = i + consumed + 1;
      /** @type {CharRanges|null} */
      let hiSet;
      let hiConsumed;
      if (body[j] === '\\') {
        const r2 = escapeSet(body, j);
        hiSet = r2.set;
        hiConsumed = r2.next - j;
      } else {
        hiSet = /** @type {CharRanges} */ ([[body.charCodeAt(j), body.charCodeAt(j)]]);
        hiConsumed = 1;
      }
      if (hiSet === ANY || hiSet.length !== 1) return ANY;
      out.push([set[0][0], Math.max(set[0][0], hiSet[0][1])]);
      i = j + hiConsumed;
      continue;
    }
    out = out.concat(set);
    i += consumed;
  }
  return out;
}

/** 量词：`* + ? {n} {n,} {n,m}`（含惰性/占有后缀）。
 * @param {string} src @param {number} i @returns {{ min: number, max: number, next: number }|null}
 */
function parseQuantifier(src, i) {
  const lazy = (/** @type {number} */ j) => (src[j] === '?' || src[j] === '+' ? j + 1 : j);
  const ch = src[i];
  if (ch === '*') return { min: 0, max: Infinity, next: lazy(i + 1) };
  if (ch === '+') return { min: 1, max: Infinity, next: lazy(i + 1) };
  if (ch === '?') return { min: 0, max: 1, next: lazy(i + 1) };
  if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
    if (!m) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
    return { min, max, next: lazy(i + m[0].length) };
  }
  return null;
}

/** 顶层拆分（跳过括号与字符类）——按 `|` 切分支。
 * @param {string} body @returns {string[]}
 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      cur += ch + (body[i + 1] || '');
      i += 1;
      continue;
    }
    if (ch === '[') {
      const end = classEnd(body, i);
      cur += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * 解析一个分支的原子序列（组递归解析）。每个原子：{ first, last, nullable, zeroWidth, quant }。
 * 字符集用区间表示；`ANY`（null）表示任意/未知。这样 `\d` 与 `[\d]` 可以被归一为同一集合。
 * @param {string} src @param {any} ctx
 */
function parseAtoms(src, ctx) {
  /** @type {any[]} */
  const atoms = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '^' || ch === '$') {
      atoms.push({ first: [], last: [], nullable: true, zeroWidth: true, quant: null });
      i += 1;
      continue;
    }
    /** @type {any} */
    let atom;
    let next = i + 1;
    if (ch === '\\') {
      const e = src[i + 1];
      if (e === 'b' || e === 'B') {
        atoms.push({ first: [], last: [], nullable: true, zeroWidth: true, quant: null });
        i += 2;
        continue;
      }
      const r = escapeSet(src, i);
      atom = { first: r.set, last: r.set, nullable: false, zeroWidth: false };
      next = r.next;
    } else if (ch === '[') {
      const end = classEnd(src, i);
      const set = classSet(src.slice(i, end + 1));
      atom = { first: set, last: set, nullable: false, zeroWidth: false };
      next = end + 1;
    } else if (ch === '.') {
      atom = { first: ANY, last: ANY, nullable: false, zeroWidth: false };
    } else if (ch === '(') {
      // 组的量词已由 parseGroup 解析过（组后紧跟 * + ? {n,m}），这里不能再解析一次，
      // 否则 `(ab)+` 的 + 会被当成「无量化」覆盖掉 → 相邻无界量词判定整条失效。
      const g = parseGroup(src, i, ctx);
      atoms.push(g.atom);
      i = g.next;
      continue;
    } else if (ch === '|') {
      i += 1; // 分支已在 splitTopLevel 切开；防御性跳过
      continue;
    } else {
      atom = { first: [[ch.charCodeAt(0), ch.charCodeAt(0)]], last: [[ch.charCodeAt(0), ch.charCodeAt(0)]], nullable: false, zeroWidth: false };
    }
    const q = parseQuantifier(src, next);
    if (q) {
      atom.quant = { min: q.min, max: q.max };
      if (q.min === 0) atom.nullable = true;
      next = q.next;
    } else {
      atom.quant = null;
    }
    atoms.push(atom);
    i = next;
  }
  return atoms;
}

/** 序列的首字符集（跳过零宽断言；可空原子继续往后看）。 @param {any[]} atoms */
function firstSet(atoms) {
  let out = /** @type {CharRanges|null} */ ([]);
  for (const a of atoms) {
    if (a.zeroWidth) continue;
    out = union(out, a.first);
    if (a.first === ANY) return ANY;
    if (!a.nullable) return out;
  }
  return out;
}

/** 序列的末字符集（反向）。 @param {any[]} atoms */
function lastSet(atoms) {
  let out = /** @type {CharRanges|null} */ ([]);
  for (let k = atoms.length - 1; k >= 0; k -= 1) {
    const a = atoms[k];
    if (a.zeroWidth) continue;
    out = union(out, a.last);
    if (a.last === ANY) return ANY;
    if (!a.nullable) return out;
  }
  return out;
}

/** 解析 `(` 处的一个组：识别 `(?:` `(?=` `(?!` `(?<=` `(?<!` `(?<name>`，找配对 `)` 并解析体。
 * @param {string} src @param {number} i @param {any} ctx
 * @returns {{ atom: any, next: number }}
 */
function parseGroup(src, i, ctx) {
  let j = i + 1;
  let lookaround = false;
  if (src[j] === '?') {
    if (src[j + 1] === ':') {
      j += 2;
    } else if (src[j + 1] === '=' || src[j + 1] === '!') {
      lookaround = true;
      j += 2;
    } else if (src[j + 1] === '<' && (src[j + 2] === '=' || src[j + 2] === '!')) {
      lookaround = true;
      j += 3;
    } else if (src[j + 1] === '<') {
      j += 2;
      while (j < src.length && src[j] !== '>') j += 1;
      j += 1; // 跳过 '>'
    } else {
      j += 2; // (?>…) 等（JS 里通常非法，按普通组保守处理）
    }
  }
  const bodyStart = j;
  let depth = 1;
  let close = src.length;
  for (; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '\\') { j += 1; continue; }
    if (ch === '[') { j = classEnd(src, j); continue; }
    if (ch === '(') { depth += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) { close = j; break; }
    }
  }
  const body = src.slice(bodyStart, close);
  const rec = /** @type {any} */ ({ body, lookaround, quant: null, branches: [], parent: ctx.stack[ctx.stack.length - 1] || null });
  ctx.groups.push(rec);
  ctx.stack.push(rec);
  const branches = parseAlternation(body, ctx);
  ctx.stack.pop();
  rec.branches = branches;
  let next = close + 1;
  const q = parseQuantifier(src, next);
  if (q) {
    rec.quant = { min: q.min, max: q.max };
    next = q.next;
  }
  const atom = {
    first: lookaround ? [] : unionAll(branches.map((/** @type {any} */ b) => b.first)),
    last: lookaround ? [] : unionAll(branches.map((/** @type {any} */ b) => b.last)),
    nullable: q ? q.min === 0 || branches.some((/** @type {any} */ b) => b.nullable) : branches.some((/** @type {any} */ b) => b.nullable),
    zeroWidth: lookaround,
    quant: rec.quant,
  };
  return { atom, next };
}

/** @param {Array<CharRanges|null>} sets */
function unionAll(sets) {
  let out = /** @type {CharRanges|null} */ ([]);
  for (const s of sets) {
    out = union(out, s);
    if (out === ANY) return ANY;
  }
  return out;
}

/** 解析一段可含顶层 `|` 的正则，返回各分支的原子序列/首末字符集/可空性，并把每条序列登记到 ctx.sequences。
 * @param {string} src @param {any} ctx
 */
function parseAlternation(src, ctx) {
  return splitTopLevel(src).map((part) => {
    const atoms = parseAtoms(part, ctx);
    ctx.sequences.push(atoms);
    return { atoms, first: firstSet(atoms), last: lastSet(atoms), nullable: atoms.every((/** @type {any} */ a) => a.nullable) };
  });
}

/** @param {string} pattern */
function analyze(pattern) {
  const ctx = { groups: /** @type {any[]} */ ([]), stack: /** @type {any[]} */ ([]), sequences: /** @type {any[][]} */ ([]) };
  parseAlternation(pattern, ctx);
  return ctx;
}

/** 一组是否「被重复」：自身量词无界/>1，或任一祖先组被重复。 @param {any} group */
function isRepeatedGroup(group) {
  const repeats = (/** @type {any} */ q) => Boolean(q) && (q.max === Infinity || q.max > 1);
  if (repeats(group.quant)) return true;
  for (let p = group.parent; p; p = p.parent) if (repeats(p.quant)) return true;
  return false;
}

/** 交替分支歧义：被重复的组里，有分支可空，或两个分支的**归一化首字符集**相交。
 *  `(a|b)+` 不相交 → 放行；`(a|aa)+`、`(x|xx)+`、`(\d|[\d])+` 相交 → 拒绝。
 * @param {any[]} groups
 */
function alternationAmbiguous(groups) {
  for (const g of groups) {
    if (g.lookaround || !g.body.includes('|')) continue;
    if (!isRepeatedGroup(g)) continue;
    const branches = g.branches.filter((/** @type {any} */ b) => b.atoms.length > 0 || b.nullable);
    if (branches.length < 2) continue;
    for (let a = 0; a < branches.length; a += 1) {
      for (let b = a + 1; b < branches.length; b += 1) {
        const A = branches[a];
        const B = branches[b];
        if (A.nullable || B.nullable) return true;
        if (overlap(A.first, B.first)) return true;
      }
    }
  }
  return false;
}

/** 相邻无界量词：两条相邻原子的量词都无上界，且**前者的末字符集与后者的首字符集相交**。
 *  `a*a*`、`\d+\d*`、`.*.*`、`(?:ab)+b*` 命中；`a*b*`、`\s*\w+`、`\d+\.\d+` 不命中。
 * @param {any[][]} sequences
 */
function adjacentUnbounded(sequences) {
  for (const atoms of sequences) {
    const seq = atoms.filter((/** @type {any} */ a) => !a.zeroWidth);
    for (let i = 0; i + 1 < seq.length; i += 1) {
      const a = seq[i];
      const b = seq[i + 1];
      if (!a.quant || a.quant.max !== Infinity) continue;
      if (!b.quant || b.quant.max !== Infinity) continue;
      if (overlap(a.last, b.first)) return true;
    }
  }
  return false;
}

/** 平衡括号扫描：返回每个括号组的 {start,end,body,quantified}（start/end 为 '(' ')' 的下标）
 * @param {string} pattern */
function scanGroups(pattern) {
  /** @type {{start:number,end:number,body:string,quantified:boolean}[]} */
  const out = [];
  const stack = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1; // 跳过转义字符
      continue;
    }
    if (ch === '[') {
      // 字符类内部不算分组（`[(]` 是字面量括号）
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === '(') stack.push(i);
    else if (ch === ')') {
      const start = stack.pop();
      if (start === undefined) continue;
      // 组后是否紧跟**可重复**的量词（+ * {n,m}）。刻意**不含 `?`**：`(a+)?` 只重复 0/1 次，
      // 不会指数回溯——把它算进来会白白拒掉一批本来安全的 pattern（过严也会伤人）。
      const j = i + 1;
      const quantified = /[+*]/.test(pattern[j] || '') || /\{\d*,?\d*\}/.test(pattern.slice(j, j + 8));
      out.push({ start, end: i, body: pattern.slice(start + 1, i), quantified });
    }
  }
  return out;
}

/** 被量词修饰的组内部还有量词吗（`(a+)+`、`(\d+)*`） */
export function hasNestedQuantifier(/** @type {string} */ pattern) {
  return scanGroups(pattern).some((g) => g.quantified && /[+*]|\{\d*,?\d*\}/.test(g.body.replace(/^\?:/, '')));
}

/** 相邻无界量词（`a*a*`、`\d+\d*`、`.*.*` 等）——各自有界但切分组合爆炸。
 * @param {string} pattern */
export function hasAdjacentUnboundedQuantifiers(/** @type {string} */ pattern) {
  return adjacentUnbounded(analyze(pattern).sequences);
}

/**
 * 重复边界歧义（**这是约束引擎 / Pack 校验与 grep 共用的判据**）：
 *   · 交替重复：`(a|aa)+`、`(x|xx)+`、`(\d|[\d])+`、`((a|ab)x)+`、`(a|a?)+`；
 *   · 相邻无界量词：`a*a*`、`\d+\d*`、`.*.*`（v0.6.31 补齐，见文件头 ②）。
 *
 * 函数名沿用历史名称；约束引擎（`constraints.js`）只调用此函数，因此把「相邻无界量词」
 * 也并入这里，**不改 constraints.js 即可让 Pack 的 output-forbid / result-forbid 同口径拒绝**。
 * @param {string} pattern
 */
export function hasAmbiguousAlternation(/** @type {string} */ pattern) {
  const ctx = analyze(pattern);
  return alternationAmbiguous(ctx.groups) || adjacentUnbounded(ctx.sequences);
}

/**
 * pattern 的拒绝原因（null = 可用）。**约束引擎 / Pack 装载 / grep 工具共用这一个判据。**
 * 拒绝原因写清**具体形态**，调用方（grep）会把它原样透给模型，而不是静默放行。
 * @param {any} pattern
 * @returns {string|null}
 */
export function patternRejectionReason(/** @type {any} */ pattern) {
  if (typeof pattern !== 'string' || pattern === '') return 'pattern 必须是非空字符串';
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
  } catch (/** @type {any} */ e) {
    return `正则无法编译：${e?.message || e}`;
  }
  if (pattern.length > 500) return 'pattern 过长（>500 字符）';
  if (hasNestedQuantifier(pattern)) {
    return 'pattern 含嵌套量词（如 (a+)+、(\\d+)*），在长文本上会指数级回溯——实测 29 字符即耗时数秒；请改写为不含嵌套量词的形式';
  }
  const ctx = analyze(pattern);
  if (alternationAmbiguous(ctx.groups)) {
    return 'pattern 含歧义分支 + 量词（如 (a|aa)+、(a|a?)+、((a|ab)x)+、(\\d|[\\d])+），重复时指数级回溯——实测 29 字符可耗时数十秒；请改写为无歧义的分支（如 (?:aa|a) 且调换顺序仍不行，请改用字符类或分段匹配）';
  }
  if (adjacentUnbounded(ctx.sequences)) {
    return 'pattern 含相邻无界量词（如 a*a*、\\d+\\d*、.*.*）——相邻量词可匹配同一字符时，切分方式组合爆炸，单行 20KB 即可回溯数十秒并冻结事件循环；请合并为一个量词（如 a*）或改用互不重叠的字符类';
  }
  return null;
}

/** @param {any} pattern */
export function isSafePattern(/** @type {any} */ pattern) {
  return patternRejectionReason(pattern) === null;
}
