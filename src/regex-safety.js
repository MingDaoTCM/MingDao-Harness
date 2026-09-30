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

/** 顶层拆分（跳过括号与字符类） */
function splitTopLevel(/** @type {string} */ body) {
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
      while (i < body.length && body[i] !== ']') {
        if (body[i] === '\\') i += 1;
        cur += body[i];
        i += 1;
      }
      cur += body[i] || '';
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
 * 歧义分支（`(a|aa)+`、`((a|ab)x)+`）：分支首字符相同，或一个是另一个的前缀。
 *
 * 关键改进（v0.6.7）：**嵌套也算**——只要该组自身被量词修饰，或它嵌在某个被量词修饰的组里，
 * 它内部的歧义分支就会在重复时指数爆炸。此前只扫单层括号，`((a|ab)x)+` 因此漏网。
 * @param {string} pattern
 */
export function hasAmbiguousAlternation(/** @type {string} */ pattern) {
  const groups = scanGroups(pattern);
  for (const g of groups) {
    if (!g.body.includes('|')) continue;
    const repeated = g.quantified || groups.some((o) => o.quantified && o.start < g.start && o.end > g.end);
    if (!repeated) continue;
    const branches = splitTopLevel(g.body)
      .map((b) => b.replace(/^\?:/, '').trim())
      .filter((b) => b !== '');
    if (branches.length < 2) continue;
    const firsts = branches.map((b) => b[0] || '');
    if (new Set(firsts).size < firsts.length) return true;
    if (branches.some((a) => branches.some((b) => a !== b && b.startsWith(a)))) return true;
  }
  return false;
}

/**
 * pattern 的拒绝原因（null = 可用）。**约束引擎 / Pack 装载 / grep 工具共用这一个判据。**
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
  if (hasAmbiguousAlternation(pattern)) {
    return 'pattern 含歧义分支 + 量词（如 (a|aa)+、(a|a?)+、((a|ab)x)+），重复时指数级回溯——实测 28 字符可耗时数十秒；请改写为无歧义的分支（如 (?:aa|a) 且调换顺序仍不行，请改用字符类或分段匹配）';
  }
  return null;
}

/** @param {any} pattern */
export function isSafePattern(/** @type {any} */ pattern) {
  return patternRejectionReason(pattern) === null;
}
