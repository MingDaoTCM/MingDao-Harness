// 文件系统工具：read / write / edit / ls / glob / grep。
// 所有工具返回 { ok, output? | error? }，由 agent 序列化后交给模型。

import fs from 'node:fs';
import path from 'node:path';
import { MAX_FILE_READ_BYTES } from '../web/constants.js';

const MAX_SCAN_FILES = 20000;
const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 250;
const MAX_FILE_BYTES = MAX_FILE_READ_BYTES; // 单源化（v0.2.8 B2）：read/edit 单文件读取上限

/**
 * @param {any} cwd
 * @param {any} p
 */
function resolvePath(cwd, p) {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(cwd, p);
}

// —— 路径穿越防护（P0 安全，v0.4.1）——
// 文件工具限定在「工作目录 + config.fsAllowDirs 白名单」内；realpath 逐级校验防软链接逃逸。
// auto 模式下模型（或被提示注入诱导）也无法 read ~/.ssh、~/.mingdao/credentials.json 等越界文件。
// 白名单：config.json 的 fsAllowDirs 数组（绝对目录），需要访问工作目录外时显式添加。
function normCmp(/** @type {any} */ p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : String(p);
}
function realPathOrNull(/** @type {any} */ p) {
  try {
    return normCmp(fs.realpathSync(p));
  } catch {
    return null;
  }
}
// 判断 target 是否在 root 内：对 target 逐级向上找最近的已存在祖先 realpath，再与 root realpath 比较。
// （write 新文件时父目录可能尚不存在，逐级向上即可正确处理；软链接已被 realpath 展开。）
function withinRoot(/** @type {any} */ root, /** @type {any} */ target) {
  const rr = realPathOrNull(root);
  if (!rr) return false;
  let cur = target;
  for (let i = 0; i < 64; i++) {
    const rp = realPathOrNull(cur);
    if (rp) return rp === rr || rp.startsWith(rr + path.sep);
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}
/**
 * 解析路径并做工作目录边界检查。
 * @param {any} ctx
 * @param {any} p
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
function boundedPath(/** @type {any} */ ctx, /** @type {any} */ p) {
  const cwd = ctx?.cwd || ctx?.workingDir || process.cwd();
  const raw = resolvePath(cwd, p ?? '');
  if (!raw) return { ok: false, error: '缺少 path 参数。' };
  const allowDirs = Array.isArray(ctx?.cfg?.fsAllowDirs) ? ctx.cfg.fsAllowDirs : [];
  const roots = [cwd, ...allowDirs.map((/** @type {any} */ d) => path.resolve(String(d)))];
  for (const r of roots) {
    if (withinRoot(r, raw)) return { ok: true, path: raw };
  }
  return { ok: false, error: `路径越界（工作目录外）：${raw}。如需访问请将目录加入 config.fsAllowDirs 白名单。` };
}

/**
 * @param {any} buf
 */
function isProbablyBinary(buf) {
  const head = buf.subarray(0, 8192);
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return true;
  }
  return false;
}

// —— undo 备份（会话级，每文件最多 10 份 + 全局上限，质检 M9） ——
const UNDO_MAX_FILES = 64;
const UNDO_MAX_BYTES = 20 * 1024 * 1024;
/**
 * @param {any} ctx
 * @param {any} p
 */
function backup(ctx, p) {
  try {
    const store = ctx?.undoStore?.backups;
    if (!(store instanceof Map)) return;
    const buf = fs.readFileSync(p);
    const list = store.get(p) || [];
    list.push({ time: Date.now(), content: buf });
    if (list.length > 10) list.shift();
    store.set(p, list);
    // 质检 M9：文件数超限删最旧文件；总字节超限按最旧时间戳逐条淘汰（防长会话内存膨胀）
    if (store.size > UNDO_MAX_FILES) {
      const first = store.keys().next().value;
      if (first !== undefined) store.delete(first);
    }
    let bytes = 0;
    for (const v of store.values()) for (const b of v) bytes += b.content.length;
    while (bytes > UNDO_MAX_BYTES && store.size) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of store) {
        const t0 = v[0]?.time ?? Infinity;
        if (t0 < oldestTime) { oldestTime = t0; oldestKey = k; }
      }
      if (oldestKey == null) break;
      const v = store.get(oldestKey);
      bytes -= v[0]?.content.length ?? 0;
      v.shift();
      if (!v.length) store.delete(oldestKey);
    }
  } catch {}
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function undo(args, ctx) {
  const store = ctx?.undoStore?.backups;
  if (!(store instanceof Map) || !store.size) return { ok: false, error: '没有可撤销的修改。' };
  // P2 修复（v0.4.6）：显式传入 path 但越界/无效时必须报错。此前 boundedPath 失败会得到
  // p=null，代码静默落到下方「撤销最近一次」分支——模型指定 /etc/hosts，实际回滚的却是
  // **另一个无关文件**（实测 other.txt 被还原），还回报「已撤销成功」。指定路径与省略路径的
  // 语义必须分开，绝不互相回落。
  if (args.path) {
    const bb = boundedPath(ctx, args.path);
    if (!bb.ok) return bb;
    const p = bb.path;
    const list = store.get(p);
    if (!list?.length) return { ok: false, error: `${p} 没有可撤销的修改记录。` };
    const last = list.pop();
    try {
      fs.writeFileSync(p, last.content);
      return { ok: true, output: `已撤销 ${p} 的最近一次修改（该文件剩余备份 ${list.length} 个）。` };
    } catch (/** @type {any} */ err) {
      return { ok: false, error: `撤销失败：${err?.message || err}` };
    }
  }
  let latestFile = null;
  let latestTime = 0;
  for (const [file, list] of store) {
    const last = list[list.length - 1];
    if (last && last.time > latestTime) {
      latestTime = last.time;
      latestFile = file;
    }
  }
  if (!latestFile) return { ok: false, error: '没有可撤销的修改。' };
  const list = store.get(latestFile);
  const last = list.pop();
  try {
    fs.writeFileSync(latestFile, last.content);
    return { ok: true, output: `已撤销 ${latestFile} 的最近一次修改。` };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `撤销失败：${err?.message || err}` };
  }
}

const READ_CACHE_MAX = 200; // 会话级 read 缓存条数上限（超出清最旧，防止无界增长）
const readCache = new Map(); // 绝对路径 → { mtimeMs, size, lines }

/**
 * @param {any} p
 */
export function invalidateReadCache(p) {
  readCache.delete(p);
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function read(args, ctx) {
  try {
    const b = boundedPath(ctx, args.path ?? '');
    if (!b.ok) return b;
    const p = b.path;
    const st = fs.statSync(p);
    if (st.isDirectory()) return { ok: false, error: `"${p}" 是目录，请使用 ls 查看。` };
    if (st.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: `"${p}" 大小 ${(st.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限。请用 grep 搜索或 bash 分块查看。`,
      };
    }
    // 重复读取去重（审计 MiniMax P2-2）：同一文件 mtime+size 未变且非强制重读时，
    // 返回「内容未变化」标记（省下整段重复内容回填的 prompt token）；force=true 强制重读。
    // 注意：带 offset/limit 的切片读取不能走缓存标记（必须返回所请求的切片）。
    const wantsSlice = args.offset !== undefined || args.limit !== undefined;
    const cached = readCache.get(p);
    if (!args.force && !wantsSlice && cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { ok: true, output: `[内容与上次读取一致（未变化，共 ${cached.lines} 行）——如需强制重读请传 force:true]`, totalLines: cached.lines, cached: true };
    }
    const buf = fs.readFileSync(p);
    if (isProbablyBinary(buf)) return { ok: false, error: `"${p}" 疑似二进制文件，无法按文本读取。` };
    const lines = buf.toString('utf8').split('\n');
    if (!wantsSlice) {
      if (readCache.size >= READ_CACHE_MAX) {
        const first = readCache.keys().next().value;
        if (first !== undefined) readCache.delete(first);
      }
      readCache.set(p, { mtimeMs: st.mtimeMs, size: st.size, lines: lines.length });
    }
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 400);
    // 审计质量项：offset 超出文件行数时明确提示，而非返回空内容让模型误以为文件为空
    if (offset > lines.length) {
      return { ok: true, output: `（offset=${offset} 超出文件总行数 ${lines.length}，文件已读完）`, totalLines: lines.length };
    }
    const end = Math.min(lines.length, offset - 1 + limit);
    const out = [];
    for (let i = offset - 1; i < end; i++) out.push(`${i + 1}\t${lines[i]}`);
    const truncated = end < lines.length;
    return {
      ok: true,
      output:
        out.join('\n') + (truncated ? `\n…[共 ${lines.length} 行，已显示第 ${offset}-${end} 行]` : ''),
      totalLines: lines.length,
    };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `读取失败：${err?.message || err}` };
  }
}

const MAX_WRITE_BYTES = 2 * 1024 * 1024; // write 单次内容上限（防模型输出超大文件打爆磁盘）

/**
 * @param {any} args
 * @param {any} ctx
 */
export function write(args, ctx) {
  try {
    const b = boundedPath(ctx, args.path ?? '');
    if (!b.ok) return b;
    const p = b.path;
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) {
      return { ok: false, error: `内容超过 ${MAX_WRITE_BYTES / 1024 / 1024}MB 上限，请分多次写入。` };
    }
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      if (st.size > MAX_FILE_BYTES) {
        return { ok: false, error: `目标文件 ${p} 超过 5MB，请改用 edit 精确修改。` };
      }
      backup(ctx, p);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    invalidateReadCache(p);
    return { ok: true, output: `已写入 ${p}（${Buffer.byteLength(content)} 字节）。` };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `写入失败：${err?.message || err}` };
  }
}

// 提取替换区域（含上下文），供 TUI 渲染变更预览
/**
 * @param {any} text
 * @param {any} lineStart
 * @param {any} lineCount
 */
function regionAround(text, lineStart, lineCount, context = 2) {
  const lines = text.split('\n');
  const from = Math.max(0, lineStart - context);
  const to = Math.min(lines.length, lineStart + lineCount + context);
  return lines.slice(from, to).join('\n');
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function edit(args, ctx) {
  try {
    const b = boundedPath(ctx, args.path ?? '');
    if (!b.ok) return b;
    const p = b.path;
    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    const replaceAll = Boolean(args.replace_all);
    if (!oldString) return { ok: false, error: '缺少 old_string 参数。' };
    try {
      if (fs.statSync(p).size > MAX_FILE_BYTES) {
        return { ok: false, error: `文件 ${p} 超过 5MB，请先 read 定位后用更小的改动。` };
      }
    } catch {}
    const text = fs.readFileSync(p, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) {
      return { ok: false, error: `在 ${p} 中未找到 old_string 匹配。文件可能已变化，请先 read 确认最新内容。` };
    }
    if (count > 1 && !replaceAll) {
      return { ok: false, error: `old_string 匹配到 ${count} 处。请提供更精确的上下文，或设置 replace_all=true。` };
    }
    // P1 修复（v0.4.6）：单处替换必须用「函数式替换值」。String.replace 的字符串替换值会解释
    // `$&`（匹配文本）、`` $` ``（匹配前）、`$'`（匹配后）、`$$`（字面 $）等模式——new_string 里
    // 出现这些序列（写 shell/模板字符串/正则/sed/LaTeX 时极常见）会静默写坏文件甚至把文件尾部
    // 整段复制进来，而工具仍回报「已编辑成功」。replace_all 路径走 split/join 本就是字面量，
    // 这里统一为同一语义。
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    backup(ctx, p);
    fs.writeFileSync(p, next);
    invalidateReadCache(p);
    const idx = text.indexOf(oldString);
    const lineStart = text.slice(0, idx).split('\n').length - 1;
    const before = regionAround(text, lineStart, oldString.split('\n').length);
    const after = regionAround(next, lineStart, newString.split('\n').length);
    return {
      ok: true,
      output: `已编辑 ${p}（替换 ${count} 处）。`,
      diff: { before, after },
    };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `编辑失败：${err?.message || err}` };
  }
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function ls(args, ctx) {
  try {
    const b = boundedPath(ctx, args.path || '.');
    if (!b.ok) return b;
    const p = b.path;
    const entries = fs.readdirSync(p, { withFileTypes: true });
    const rows = entries
      .map((e) => {
        const full = path.join(p, e.name);
        if (e.isDirectory()) return `${e.name}/`;
        let size = '';
        try {
          size = ` (${fs.statSync(full).size}B)`;
        } catch {}
        return e.name + size;
      })
      .sort((a, b) => {
        const ad = a.endsWith('/') ? 0 : 1;
        const bd = b.endsWith('/') ? 0 : 1;
        return ad - bd || a.localeCompare(b);
      });
    return { ok: true, output: rows.join('\n') || '(空目录)' };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `列目录失败：${err?.message || err}` };
  }
}

/**
 * @param {any} pattern
 */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'; // **/ 匹配零层或多层目录
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      re += '\\' + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * @param {any} root
 * @param {(full: any) => any} visitor
 */
function walkFiles(root, visitor) {
  const stack = [root];
  let scanned = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned++ > MAX_SCAN_FILES) return scanned;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (visitor(full) === false) return scanned;
      }
    }
  }
  return scanned;
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function glob(args, ctx) {
  try {
    const pattern = String(args.pattern ?? '*');
    const b = boundedPath(ctx, args.path || '.');
    if (!b.ok) return b;
    const root = b.path;
    if (!fs.existsSync(root)) return { ok: false, error: `目录不存在：${root}` };
    const re = globToRegExp(pattern);
    const matchRel = pattern.includes('/');
    /** @type {any[]} */
    const results = [];
    let truncated = false;
    walkFiles(root, (full) => {
      if (results.length >= MAX_GLOB_RESULTS) {
        truncated = true;
        return false;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (re.test(matchRel ? rel : path.basename(full))) results.push(rel);
    });
    let output = results.join('\n');
    if (!results.length) output = '(无匹配)';
    if (truncated) output += `\n…[结果超过 ${MAX_GLOB_RESULTS} 条，已截断]`;
    return { ok: true, output };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `glob 失败：${err?.message || err}` };
  }
}

/**
 * 判定「同前缀歧义分支被量词修饰」这一 ReDoS 形态（v0.4.6）。
 * 提取 `(…|…)` 后紧跟量词的分组，若存在两个分支首字符相同（分支前缀重叠），
 * 则形如 (a|aa)+ / (\d|\d\d)+ 会在失败匹配时指数回溯。
 * 保守起见只看首字符：`(foo|bar)+`、`(get|post)+` 这类无重叠分支不会误伤。
 * @param {string} pattern
 */
function hasAmbiguousAlternation(pattern) {
  const re = /\(([^()]*)\)\s*(?:[+*]|\{\d+,?\d*\})/g;
  let m;
  while ((m = re.exec(pattern))) {
    const branches = m[1].split('|').map((b) => b.trim());
    if (branches.length < 2) continue;
    const firsts = branches.map((b) => b.replace(/^\^/, '')[0] || '');
    if (new Set(firsts).size < firsts.length) return true;
  }
  return false;
}

/**
 * @param {any} args
 * @param {any} ctx
 */
export function grep(args, ctx) {
  try {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { ok: false, error: '缺少 pattern 参数。' };
    if (pattern.length > 500) return { ok: false, error: 'pattern 过长（>500 字符）。' };
    // 拒绝嵌套量词类灾难回溯模式（如 (a+)+b），避免同步 ReDoS 卡死事件循环
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
      return { ok: false, error: 'pattern 疑似灾难性回溯（嵌套量词），请改写为等价安全形式。' };
    }
    // P2 修复（v0.4.6）：上面的嵌套量词检查覆盖不到「歧义分支 + 外层量词」这一大类
    // （`(a|aa)+$` 的括号里没有任何量词，直接放行）——实测 20KB 行 n=60 时同步回溯 >180s，
    // 冻结整个 Node 进程（WebView/全部会话/SSE 一起卡死，同步阻塞连 setTimeout 都不触发）。
    // 这里补一条精确判定：分组内以 `|` 分支、且**存在两个分支首字符相同**（重叠前缀 → 指数回溯）。
    if (hasAmbiguousAlternation(pattern)) {
      return { ok: false, error: 'pattern 疑似灾难性回溯（同前缀歧义分支被量词修饰，如 (a|aa)+），请改写为等价安全形式。' };
    }
    let re;
    try {
      re = new RegExp(pattern);
    } catch (/** @type {any} */ e) {
      return { ok: false, error: `无效的正则表达式：${e.message}` };
    }
    // 单行截断：超长行（如压缩的 JS/日志）截到 20KB 再匹配，防止正则开销失控
    const MAX_LINE = 20 * 1024;
    /** @type {(line: any) => any} */
    const testLine = (line) => (line.length > MAX_LINE ? re.test(line.slice(0, MAX_LINE)) : re.test(line));
    const root0 = boundedPath(ctx, args.path || '.');
    if (!root0.ok) return root0;
    const root = root0.path;
    const include = args.include ? globToRegExp(String(args.include)) : null;
    // v0.4.6：总时间预算——即使静态检查漏过某种回溯形态，也不让一次 grep 无限期占用事件循环。
    const grepStart = Date.now();
    const GREP_BUDGET_MS = 5000;
    let budgetHit = false;
    /** @type {any[]} */
    const matches = [];
    let truncated = false;
    let scannedFiles = 0;
    walkFiles(root, (full) => {
      if (Date.now() - grepStart > GREP_BUDGET_MS) { budgetHit = true; return false; }
      if (include && !include.test(path.basename(full))) return;
      if (matches.length >= MAX_GREP_MATCHES) {
        truncated = true;
        return false;
      }
      scannedFiles += 1;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        return;
      }
      if (stat.size > MAX_FILE_BYTES) return;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        return;
      }
      const rel = path.relative(root, full).split(path.sep).join('/');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (testLine(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= MAX_GREP_MATCHES) {
            truncated = true;
            return false;
          }
        }
      }
    });
    let output = matches.length ? matches.join('\n') : '(无匹配)';
    output += truncated
      ? `\n…[匹配超过 ${MAX_GREP_MATCHES} 条，已截断；已扫描 ${scannedFiles} 个文件]`
      : `\n[已扫描 ${scannedFiles} 个文件]`;
    if (budgetHit) {
      output += `\n…[已用满 ${GREP_BUDGET_MS / 1000}s 时间预算，提前停止扫描；请缩小路径范围或改写 pattern]`;
    }
    return { ok: true, output };
  } catch (/** @type {any} */ err) {
    return { ok: false, error: `grep 失败：${err?.message || err}` };
  }
}
