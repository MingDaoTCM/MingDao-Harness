// 变异验证脚手架（v0.6.7，第三方报告一 S-3② 的落地）：
// 「把修复逐个改回缺陷，断言必须当场失败」此前是**手工过程**——报告指出这与项目
// 「守卫必须可回归」的自我要求不一致。这里把它变成可复跑的工具：
//
//   node test/mutate/run.mjs            # 跑全部批次
//   node test/mutate/run.mjs batch12    # 只跑某一批
//
// 用法（写某一批时）：
//   const M = await makeMutator();            // 或 makeMutator({ rebuild: <节号> })
//   等一等的原语：
//     M.section('124')                        // 跑 test/smoke.js 第 124 节（自动抽成独立脚本后执行）
//     M.suite('test/e2e-schedule.js')         // 跑一整个套件
//     M.mutate({ name, file, from, to, expect: ['关键词'], run: () => M.section('126') })
//
// 约定：`expect` 是**断言原文里的关键词**——关键词对不上就算"逃逸"（很可能只是失败的断言不是你修的那条）。
//
// v0.6.17 fail-safe（登记过两次事故：① 变异在飞时被另一条扫描线误报成"残留"；② 进程被强杀后
// 补丁留在工作树里、看起来像"有意改动"，曾差点把"停止键失效"发进版本）。做法分三层：
//   1. **持久标记**：写补丁前先落 `test/mutate/.generated/pending/<hash>.json`（含 file/from/to/
//      pid/时间戳 + 原始字节与补丁全文），还原后删除。进程被 kill -9 时标记会留下——这就是
//      "残留"的**唯一可信判据**（而不是靠扫描源码文本猜）。
//   2. **锁**：`test/mutate/.generated/mutate.lock`（pid + 启动时间）。第二个 mutator 直接拒绝；
//      锁持有者死了的陈旧锁会被自动清理。**pid 还活着的标记一律不算残留**（事故①就是把它当残留）。
//   3. **可感知**：每次变异在 stdout 与 `.generated/mutate.journal`（JSONL）落「变异进行中」/
//      「已还原」；SIGINT/SIGTERM/正常退出时 `process.once` 清理锁并尝试还原在途补丁。
//      SIGKILL 无法被任何处理器捕获——那种情况靠 2 的陈旧锁 + 1 的标记，由
//      `node test/mutate/check.mjs`（run.mjs 启动时也会跑）自愈或拒绝。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smokePath = path.join(repoRoot, 'test', 'smoke.js');
export const outDir = path.join(repoRoot, 'test', 'mutate', '.generated');

/** `.generated/` 下的路径（root 可换，selfcheck 用临时目录模拟整棵树）。 */
export function genDir(root = repoRoot) {
  return path.join(root, 'test', 'mutate', '.generated');
}
export function pendingDir(root = repoRoot) {
  return path.join(genDir(root), 'pending');
}
export function lockFilePath(root = repoRoot) {
  return path.join(genDir(root), 'mutate.lock');
}
export function journalPath(root = repoRoot) {
  return path.join(genDir(root), 'mutate.journal');
}

/**
 * 行尾归一化：CRLF（含游离 CR）→ LF。
 *
 * v0.6.8（Windows 腿修复）：Git for Windows 的 `core.autocrlf` 默认是 true，而本仓库没有
 * `.gitattributes`——windows-latest 上 checkout 出来的工作树里，**每个文本文件都是 CRLF**，
 * 而本文件的 `from` 锚点一律按 LF 书写（多行锚点用 '\n' 连接）。读文件不归一化，多行锚点就
 * 永远 `includes()` 不到：批十二~十五会静默退化成"变异点未找到 7 处 / 批次 0/4 全中"，
 * 看起来像"守卫全挂了"，实际是脚手架自己读错了行尾（假红）。
 *
 * 本地复现（macOS 上同样可行）：把 src/ssrf-guard.js、src/agent.js、src/cost-guard.js、
 * src/batch.js、src/credentials.js、ide/vscode/extension.js 转成 CRLF 后跑
 * `node test/mutate/run.mjs`，失败项与数量与 CI 的 Windows 日志逐字一致。
 */
export function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

/** 抽出 smoke.js 的某一节（含软链探测辅助函数与最小前置），生成可独立运行的脚本。 */
export function extractSection(num) {
  fs.mkdirSync(outDir, { recursive: true });
  const smoke = normalizeEol(fs.readFileSync(smokePath, 'utf8'));
  const start = smoke.indexOf(`// ---------- ${num}.`);
  if (start < 0) throw new Error(`未能定位第 ${num} 节`);
  // v0.6.8（报告一 M-6）：边界取**从本节起的下一个节头**（或文件末的收尾标记），
  // 而不是"文件里第一处 `delete process.env.MINGDAO_HOME;`"——后者若出现在本节之前，
  // slice(start, end) 会得到空串：生成脚本里一条断言都没有，节"通过"得毫无意义
  // （变异验证会因此变成假绿，正是它本该防的事）。
  const nextHeader = smoke.indexOf('\n// ---------- ', start + 1);
  const tailMark = smoke.indexOf('\ndelete process.env.MINGDAO_HOME;', start + 1);
  const candidates = [nextHeader, tailMark].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : smoke.length;
  if (end <= start) throw new Error(`第 ${num} 节的边界计算异常`);
  const hStart = smoke.indexOf('// 建一个**真正的**符号链接');
  const hEnd = smoke.indexOf('// ---------- 1. token 估算');
  const helpers = hStart >= 0 && hEnd > hStart ? smoke.slice(hStart, hEnd) : '';
  const file = path.join(outDir, `sec${num}.mjs`);
  fs.writeFileSync(
    file,
    `import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const srcDir = ${JSON.stringify(path.join(repoRoot, 'src'))};
const repoRoot = path.dirname(srcDir); // v0.6.8：节里可能引用仓库根（脚本/desktop/ide 守卫）
const require = (await import('node:module')).createRequire(import.meta.url); // 生成的脚本是 ESM，CJS 加载 preload 时需要它
const { dispatch } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
const { saveConfig, loadConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
function ok(n) { console.log('  \\u2713 ' + n); }
function safeRmSync(...a) { try { fs.rmSync(...a); } catch {} }
process.env.MINGDAO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sec-home-'));
${helpers}
${smoke.slice(start, end)}
console.log('第 ${num} 节：全部通过');
process.exit(0);
`
  );
  return file;
}

// ---------------------------------------------------------------------------
// fail-safe 基础设施（v0.6.17）：pid 存活判断 / journal / 持久标记 / 锁 / 清理。
// 这些函数都接受 `root`，selfcheck 用临时目录模拟整棵树，不必碰真实工作树。
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** pid 是否还活着（EPERM = 存在但没权限，算活着）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

/**
 * 落一行 journal（JSONL）。日志写不进去**绝不能反过来阻断变异**——真正的 fail-safe 凭据是
 * pending 标记；journal 只是让人事后能区分"在飞"与"残留"（事故①的根因就是日志里两者长得一样）。
 */
export function journal(event, { root = repoRoot, ...extra } = {}) {
  try {
    ensureDir(genDir(root));
    fs.appendFileSync(journalPath(root), `${JSON.stringify({ ts: new Date().toISOString(), event, pid: process.pid, ...extra })}\n`);
  } catch {
    /* 忽略：见上 */
  }
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/** 标记文件名 = sha256(file \0 to) 前 16 位：同一文件的不同补丁各有各的标记，互不覆盖。 */
function markerHash(file, to) {
  return crypto.createHash('sha256').update(`${file}\0${to}`).digest('hex').slice(0, 16);
}

export function pendingMarkerPath({ root = repoRoot, file, to }) {
  return path.join(pendingDir(root), `${markerHash(file, to)}.json`);
}

/**
 * 写补丁**之前**先落标记（原子上报：先写 .tmp 再 rename，避免强杀留下半截 JSON）。
 * 标记里同时存原始字节（originalRaw，用于字节级还原，Windows 上就是 CRLF 原样）与补丁全文
 * （patched，用于判断"文件现在是不是仍等于我们写下的那份"）。
 */
export function writePendingMarker({ root = repoRoot, file, from, to, originalRaw, patched, pid = process.pid, startedAt = new Date().toISOString() }) {
  ensureDir(pendingDir(root));
  const markerPath = pendingMarkerPath({ root, file, to });
  const data = { v: 1, file, from, to, pid, startedAt, originalRaw, patched };
  const tmp = `${markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, markerPath);
  return markerPath;
}

export function removePendingMarker(markerPath) {
  try {
    fs.unlinkSync(markerPath);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    throw e;
  }
}

/** 列出全部 pending 标记（损坏的也列出来，交给调用方判冲突——不能静默跳过）。 */
export function listPending(root = repoRoot) {
  let names;
  try {
    names = fs.readdirSync(pendingDir(root)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  names.sort();
  const entries = [];
  for (const name of names) {
    const markerPath = path.join(pendingDir(root), name);
    try {
      entries.push({ markerPath, data: JSON.parse(fs.readFileSync(markerPath, 'utf8')) });
    } catch (e) {
      entries.push({ markerPath, data: null, error: String((e && e.message) || e) });
    }
  }
  return entries;
}

function insideRoot(root, rel) {
  const abs = path.resolve(root, rel);
  const base = path.resolve(root) + path.sep;
  return abs.startsWith(base) ? abs : null;
}

/**
 * 扫描残留标记。
 *
 * - `mode: 'check'`（开跑前/手工自检）：能自愈的（文件仍等于我们写下的 `patched`）当场还原成
 *   `originalRaw` 并删标记；pid 还活着的**一律当"在飞"**（绝不碰）；其余算冲突，调用方拒绝运行。
 * - `mode: 'abort'`（SIGINT/SIGTERM/退出）：只还原"自己 pid"与"pid 已死"的标记，活着的其它
 *   pid 跳过（父进程不能替还在跑的子进程写回文件）。
 *
 * 判据是**标记 + 文件当前内容**，不是源码文本模式——这样"在飞"与"残留"第一次有了区分依据。
 *
 * @returns {{healed: string[], stale: string[], conflicts: Array<{file: string, markerPath: string, reason: string}>, inflight: Array<{file: string, pid: number, markerPath: string, startedAt?: string}>}}
 */
export function scanResidue({ root = repoRoot, mode = 'check' } = {}) {
  const healed = [];
  const stale = [];
  const conflicts = [];
  const inflight = [];
  for (const entry of listPending(root)) {
    const { markerPath, data, error } = entry;
    const relMarker = path.relative(root, markerPath).split(path.sep).join('/');
    if (!data || typeof data.file !== 'string' || typeof data.patched !== 'string' || typeof data.originalRaw !== 'string') {
      conflicts.push({
        file: '(标记损坏)',
        markerPath: relMarker,
        reason: error ? `无法解析：${error}` : '缺少 file/patched/originalRaw 字段（旧版或半截标记）',
      });
      continue;
    }
    const target = insideRoot(root, data.file);
    if (!target) {
      conflicts.push({ file: data.file, markerPath: relMarker, reason: '标记里的路径不在仓库根之内（拒绝触碰）' });
      continue;
    }
    // 在飞 ≠ 残留：持有者 pid 还活着时，任何自愈都可能踩到正在跑的变异（事故①的根因）。
    if (data.pid !== process.pid && isPidAlive(data.pid)) {
      inflight.push({ file: data.file, pid: data.pid, markerPath: relMarker, startedAt: data.startedAt });
      continue;
    }
    let current;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch (e) {
      conflicts.push({ file: data.file, markerPath: relMarker, reason: `读不到目标文件：${(e && e.code) || e}` });
      continue;
    }
    const norm = normalizeEol(current);
    // 标记还在、文件已经是原文：上次写回成功但删标记失败（或死在两步之间）→ 陈旧标记，直接清掉。
    if (current === data.originalRaw || norm === normalizeEol(data.originalRaw)) {
      removePendingMarker(markerPath);
      stale.push(data.file);
      journal('stale-marker', { root, file: data.file, marker: relMarker });
      continue;
    }
    if (norm === normalizeEol(data.patched)) {
      try {
        fs.writeFileSync(target, data.originalRaw); // 字节级写回：Windows 上原样写回 CRLF
        removePendingMarker(markerPath);
      } catch (e) {
        conflicts.push({ file: data.file, markerPath: relMarker, reason: `自愈写回失败：${(e && e.code) || e}` });
        continue;
      }
      healed.push(data.file);
      journal('heal', { root, file: data.file, marker: relMarker, pid: data.pid, mode });
      console.log(`已自愈 1 处残留变异：${data.file}（${mode === 'abort' ? '中止清理' : '开跑前自检'}；标记 ${relMarker}）`);
      continue;
    }
    conflicts.push({
      file: data.file,
      markerPath: relMarker,
      reason: '文件既不是补丁内容（to）、也不是原始内容（from）——像被第三方改过',
      currentSha: shortHash(current),
      patchedSha: shortHash(data.patched),
      originalSha: shortHash(data.originalRaw),
    });
  }
  return { healed, stale, conflicts, inflight };
}

// ---------------------------------------------------------------------------
// 并发互斥：锁文件。第二个 mutator 直接拒绝；持有者已死的陈旧锁自动清理。
// ---------------------------------------------------------------------------

export class LockHeldError extends Error {
  constructor(holder, lockPath) {
    const pid = holder && Number.isInteger(holder.pid) ? holder.pid : '?';
    const at = (holder && holder.startedAt) || '未知时间';
    super(`已有 mutator 在跑（pid ${pid}，启动于 ${at}）；锁文件：${lockPath}。若是上次被强杀留下的陈旧锁，确认该 pid 不在后删掉锁再跑。`);
    this.name = 'LockHeldError';
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

export function readLock(root = repoRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(lockFilePath(root), 'utf8'));
    return data && Number.isInteger(data.pid) ? data : null;
  } catch {
    return null;
  }
}

function makeLockHandle({ root, own, file, holderPid }) {
  let released = false;
  return {
    root,
    own,
    path: file,
    holderPid,
    release() {
      if (released) return false;
      released = true;
      if (!own) return false;
      const current = readLock(root);
      if (!current || current.pid !== process.pid) return false; // 锁已被别人（陈旧清理后）接管，不能删别人的
      try {
        fs.unlinkSync(file);
      } catch {
        return false;
      }
      journal('lock-released', { root });
      return true;
    },
  };
}

export function acquireLock({ root = repoRoot, quiet = false } = {}) {
  ensureDir(genDir(root));
  const file = lockFilePath(root);
  const payload = {
    v: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    host: os.hostname(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify(payload, null, 2), { flag: 'wx' });
      journal('lock-acquired', { root });
      return makeLockHandle({ root, own: true, file, holderPid: process.pid });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const holder = readLock(root);
      if (holder && holder.pid === process.pid) {
        return makeLockHandle({ root, own: true, file, holderPid: process.pid });
      }
      if (holder && isPidAlive(holder.pid)) {
        journal('lock-refused', { root, holderPid: holder.pid });
        throw new LockHeldError(holder, path.relative(root, file));
      }
      // 陈旧锁：持有者已不在（上次被强杀留下的）→ 清掉再抢一次。
      if (!quiet) console.log(`[mutate] 清理陈旧锁：${path.relative(root, file)}（pid ${(holder && holder.pid) || '?'} 已不在）`);
      journal('lock-stale', { root, holderPid: (holder && holder.pid) || null });
      try {
        fs.unlinkSync(file);
      } catch {
        /* 别人先清了就算了，下一轮 'wx' 会告诉我们真实状态 */
      }
    }
  }
  throw new LockHeldError(readLock(root), path.relative(root, file));
}

/** 子进程继承父进程的锁（run.mjs 持锁跑批次，批次进程不再抢锁）。 */
export function inheritLock({ root = repoRoot, pid }) {
  const holder = readLock(root);
  if (!holder || holder.pid !== pid || !isPidAlive(pid)) return null;
  return makeLockHandle({ root, own: false, file: lockFilePath(root), holderPid: pid });
}

let cleanupInstalled = false;

/**
 * 注册退出/信号清理（`process.once`）：清理锁 + 尝试还原**自己的/已死进程的**在途补丁。
 * SIGKILL 捕获不到——这正是需要持久标记 + check 的原因；这里不假装能兜住它。
 */
export function installCleanup({ root = repoRoot, lock } = {}) {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  let cleaned = false;
  const cleanup = (why, verbose) => {
    if (cleaned) return;
    cleaned = true;
    let res;
    try {
      res = scanResidue({ root, mode: 'abort' });
    } catch (e) {
      res = { healed: [], stale: [], conflicts: [{ file: '(扫描失败)', markerPath: '', reason: String((e && e.message) || e) }], inflight: [] };
    }
    try {
      lock?.release();
    } catch {
      /* 退出路径上不能再抛 */
    }
    const bits = [];
    if (res.healed.length) bits.push(`已还原 ${res.healed.length} 处在途补丁`);
    if (res.conflicts.length) bits.push(`${res.conflicts.length} 处冲突未触碰（见 pending 标记）`);
    if (res.inflight.length) bits.push(`${res.inflight.length} 处仍在飞（pid 存活，未触碰）`);
    if (verbose || res.healed.length || res.conflicts.length) {
      console.log(`[mutate] ${why}：已清理锁${bits.length ? `；${bits.join('；')}` : '；无在途补丁'}`);
    }
    journal('abort', {
      root,
      why,
      healed: res.healed,
      conflicts: res.conflicts.map((c) => c.file),
      inflight: res.inflight.map((i) => i.file),
    });
  };
  process.once('exit', () => cleanup('进程退出', false));
  process.once('SIGINT', () => {
    cleanup('收到 SIGINT', true);
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup('收到 SIGTERM', true);
    process.exit(143);
  });
}

/** @param {ReturnType<typeof makeMutator>} M */
export function makeMutator(opts = {}) {
  const quiet = opts.quiet === true;
  const results = [];
  // 锁：run.mjs 已经持锁时通过环境变量把 pid 传下来，批次进程继承而不是再抢一次；
  // 单独跑 `node test/mutate/batchNN-*.mjs` 时自己抢锁。
  const inheritedPid = Number(process.env.MINGDAO_MUTATE_LOCK || 0);
  const lock = (inheritedPid && inheritLock({ root: repoRoot, pid: inheritedPid })) || acquireLock({ root: repoRoot, quiet });
  installCleanup({ root: repoRoot, lock });
  // 开跑前自检（事故②）：pid 已死的残留直接自愈；冲突/在飞的文件拒绝开跑，绝不"边写边猜"。
  const scan = scanResidue({ root: repoRoot, mode: 'check' });
  if (scan.conflicts.length || scan.inflight.length) {
    const lines = [...scan.conflicts.map((c) => `${c.file}（${c.reason}）`), ...scan.inflight.map((i) => `${i.file}（仍在飞，pid ${i.pid}）`)];
    throw new Error(`[mutate] 拒绝在未处理的残留/在飞变异上开跑（${lines.length} 处）：\n  ${lines.join('\n  ')}\n先跑 node test/mutate/check.mjs 并按其提示处理。`);
  }
  const M = {
    results,
    /** 跑 smoke 的某一节（每次按当前源码重新抽取，避免跑到陈旧副本） */
    section(num) {
      const file = extractSection(String(num));
      return spawnSync(process.execPath, [file], { cwd: repoRoot, encoding: 'utf8' });
    },
    /** 跑一整个套件（相对仓库根） */
    suite(rel, extraEnv = {}) {
      return spawnSync(process.execPath, [rel], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, MINGDAO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-mut-')), ...extraEnv },
      });
    },
    /**
     * 做一次变异：改坏 → 跑 → 无论结果如何都还原。
     * v0.6.17：**先落持久标记再写补丁**——被强杀时 finally 不会执行，标记就是唯一的残留凭据。
     * @param {{name: string, file: string, from: string, to: string, expect: string[], run: () => any}} m
     */
    mutate(m) {
      const f = path.join(repoRoot, m.file);
      const raw = fs.readFileSync(f, 'utf8');
      // v0.6.8（Windows 腿）：匹配前把工作树的行尾归一化成 LF（见 normalizeEol 的注释）。
      // 归一化只用于**匹配与写入**；还原时写回 raw——跑完工作树的字节必须与跑之前完全一致
      // （Windows 上就是 CRLF 原样），否则变异验证会污染工作区，比不跑还危险。
      const orig = normalizeEol(raw);
      if (!orig.includes(m.from)) {
        const crlf = raw.includes('\r\n');
        results.push({
          name: m.name,
          ok: false,
          why: `变异点未找到：${JSON.stringify(m.from.slice(0, 60))}${crlf ? '（该文件是 CRLF，已按 LF 归一化后仍未匹配）' : ''}`,
        });
        if (!quiet) console.log(`✗ ${m.name}\n    变异点未找到（${m.file}）`);
        return false;
      }
      const patched = orig.replace(m.from, m.to);
      const markerPath = writePendingMarker({ root: repoRoot, file: m.file, from: m.from, to: m.to, originalRaw: raw, patched });
      const relMarker = path.relative(repoRoot, markerPath).split(path.sep).join('/');
      journal('start', { root: repoRoot, file: m.file, marker: relMarker });
      console.log(`变异进行中：${m.file}（pid ${process.pid}，标记 ${relMarker}）`);
      fs.writeFileSync(f, patched);
      let out;
      try {
        out = m.run();
      } finally {
        fs.writeFileSync(f, raw); // 先还原原始字节，再判结果
        try {
          removePendingMarker(markerPath);
        } catch {
          /* 删不掉也要让还原继续；下次 check 会把它当陈旧标记清掉 */
        }
        journal('restore', { root: repoRoot, file: m.file, marker: relMarker });
        console.log(`已还原：${m.file}`);
      }
      const text = String(out?.stdout || '') + String(out?.stderr || '');
      const hit = out?.status !== 0 && m.expect.some((k) => text.includes(k));
      results.push({ name: m.name, ok: hit });
      if (!quiet) {
        if (hit) console.log(`✓ ${m.name}`);
        else console.log(`✗ 逃逸：${m.name}（exit=${out?.status}）\n${text.slice(-500)}`);
      }
      return hit;
    },
    /** 打印并返回是否全中（给批脚本当退出码用） */
    report() {
      const caught = results.filter((r) => r.ok).length;
      console.log(`\n变异验证：${caught}/${results.length} 被抓到`);
      if (results.some((r) => !r.ok)) {
        for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}${r.why ? ` — ${r.why}` : ''}`);
      }
      return caught === results.length;
    },
  };
  return M;
}
