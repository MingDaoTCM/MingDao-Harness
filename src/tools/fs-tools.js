// 文件系统工具：read / write / edit / ls / glob / grep。
// 所有工具返回 { ok, output? | error? }，由 agent 序列化后交给模型。

import fs from 'node:fs';
import path from 'node:path';

const MAX_SCAN_FILES = 20000;
const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 250;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function resolvePath(cwd, p) {
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(cwd, p);
}

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

export function undo(args, ctx) {
  const store = ctx?.undoStore?.backups;
  if (!(store instanceof Map) || !store.size) return { ok: false, error: '没有可撤销的修改。' };
  const p = args.path ? resolvePath(ctx.cwd, args.path) : null;
  if (p) {
    const list = store.get(p);
    if (!list?.length) return { ok: false, error: `${p} 没有可撤销的修改记录。` };
    const last = list.pop();
    try {
      fs.writeFileSync(p, last.content);
      return { ok: true, output: `已撤销 ${p} 的最近一次修改（该文件剩余备份 ${list.length} 个）。` };
    } catch (err) {
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
  } catch (err) {
    return { ok: false, error: `撤销失败：${err?.message || err}` };
  }
}

const READ_CACHE_MAX = 200; // 会话级 read 缓存条数上限（超出清最旧，防止无界增长）
const readCache = new Map(); // 绝对路径 → { mtimeMs, size, lines }

export function invalidateReadCache(p) {
  readCache.delete(p);
}

export function read(args, ctx) {
  try {
    const p = resolvePath(ctx.cwd, args.path ?? '');
    if (!p) return { ok: false, error: '缺少 path 参数。' };
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
  } catch (err) {
    return { ok: false, error: `读取失败：${err?.message || err}` };
  }
}

const MAX_WRITE_BYTES = 2 * 1024 * 1024; // write 单次内容上限（防模型输出超大文件打爆磁盘）

export function write(args, ctx) {
  try {
    const p = resolvePath(ctx.cwd, args.path ?? '');
    if (!p) return { ok: false, error: '缺少 path 参数。' };
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
  } catch (err) {
    return { ok: false, error: `写入失败：${err?.message || err}` };
  }
}

// 提取替换区域（含上下文），供 TUI 渲染变更预览
function regionAround(text, lineStart, lineCount, context = 2) {
  const lines = text.split('\n');
  const from = Math.max(0, lineStart - context);
  const to = Math.min(lines.length, lineStart + lineCount + context);
  return lines.slice(from, to).join('\n');
}

export function edit(args, ctx) {
  try {
    const p = resolvePath(ctx.cwd, args.path ?? '');
    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    const replaceAll = Boolean(args.replace_all);
    if (!p) return { ok: false, error: '缺少 path 参数。' };
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
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
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
  } catch (err) {
    return { ok: false, error: `编辑失败：${err?.message || err}` };
  }
}

export function ls(args, ctx) {
  try {
    const p = resolvePath(ctx.cwd, args.path || '.');
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
  } catch (err) {
    return { ok: false, error: `列目录失败：${err?.message || err}` };
  }
}

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

export function glob(args, ctx) {
  try {
    const pattern = String(args.pattern ?? '*');
    const root = resolvePath(ctx.cwd, args.path || '.');
    if (!fs.existsSync(root)) return { ok: false, error: `目录不存在：${root}` };
    const re = globToRegExp(pattern);
    const matchRel = pattern.includes('/');
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
  } catch (err) {
    return { ok: false, error: `glob 失败：${err?.message || err}` };
  }
}

export function grep(args, ctx) {
  try {
    const pattern = String(args.pattern ?? '');
    if (!pattern) return { ok: false, error: '缺少 pattern 参数。' };
    if (pattern.length > 500) return { ok: false, error: 'pattern 过长（>500 字符）。' };
    // 拒绝嵌套量词类灾难回溯模式（如 (a+)+b），避免同步 ReDoS 卡死事件循环
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) {
      return { ok: false, error: 'pattern 疑似灾难性回溯（嵌套量词），请改写为等价安全形式。' };
    }
    let re;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { ok: false, error: `无效的正则表达式：${e.message}` };
    }
    // 单行截断：超长行（如压缩的 JS/日志）截到 20KB 再匹配，防止正则开销失控
    const MAX_LINE = 20 * 1024;
    const testLine = (line) => (line.length > MAX_LINE ? re.test(line.slice(0, MAX_LINE)) : re.test(line));
    const root = resolvePath(ctx.cwd, args.path || '.');
    const include = args.include ? globToRegExp(String(args.include)) : null;
    const matches = [];
    let truncated = false;
    let scannedFiles = 0;
    walkFiles(root, (full) => {
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
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: `grep 失败：${err?.message || err}` };
  }
}
