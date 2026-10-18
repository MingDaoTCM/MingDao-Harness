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
//   2. **锁**：**全局**锁目录 `os.tmpdir()/mingdao-mutate.lock/`（`mkdirSync` 原子创建，锁内记
//      pid/startedAt/cwd/argv）。第二个 mutator 直接拒绝；**跨 worktree** 也只有一个能进
//      （v0.6.18：此前锁在 `.generated/` 里，每个 worktree 各持一把，等于没互斥）。陈旧锁必须
//      **同时**满足"pid 已不在"与"锁 mtime 超过 15 分钟"才接管——只看 pid 会踩 mkdir→node 空窗。
//      **pid 还活着的标记一律不算残留**（事故①就是把它当残留）。
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
// 并发互斥：**全局**锁目录（v0.6.18，跨 worktree）。
//
// 为什么不能放 `.generated/`：那是每个工作树各自的目录——两个 worktree 各自持一把"锁"，
// 等于没有互斥（固定端口 45997/45998 冲突、§145 时序断言在负载下"逃逸"就是这么来的）。
//
// 路径：`os.tmpdir()/mingdao-mutate.lock/`（`MINGDAO_MUTATE_LOCK_DIR` 只给 selfcheck 隔离用）。
// 原子性：`mkdirSync` 本身是原子的（EEXIST = 已有人持有）；锁内 `owner.json` 记
// `pid/startedAt/cwd/argv`。cwd 是**被变异的 worktree 根**，不是进程的当前目录。
//
// 陈旧判据（**两个条件同时满足**才接管）：
//   ① owner.pid 已不在（`process.kill(pid, 0)` 失败且不是 EPERM）；
//   ② 锁目录 mtime 已超过 15 分钟。
// 只看 ① 是错的：`mkdir` 到 node 真正开始跑之间有一小段空窗（pid 还没写进锁），
// "看到 pgrep 为空就删锁"正是这么把活锁删掉的——今天两次事故的共同根因。
// 两个条件都满足时仍用 **rename 抢占**（锁目录整体改名为唯一 tombstone 再删）并加一个
// `.takeover` 令牌串行化，避免两个进程同时判陈旧、同时删、双双以为自己持锁。
// ---------------------------------------------------------------------------

export const GLOBAL_LOCK_NAME = 'mingdao-mutate.lock';
export const LOCK_STALE_MS = 15 * 60 * 1000;

/** 全局锁目录。selfcheck 用 MINGDAO_MUTATE_LOCK_DIR 指向独立临时目录，避免碰到真锁。 */
export function globalLockDir() {
  const override = process.env.MINGDAO_MUTATE_LOCK_DIR;
  return override ? path.resolve(override) : path.join(os.tmpdir(), GLOBAL_LOCK_NAME);
}

export function lockOwnerPath(dir = globalLockDir()) {
  return path.join(dir, 'owner.json');
}

/** 读锁里的持有者信息；目录/文件不存在或内容不完整时返回 null。 */
export function readLockOwner(dir = globalLockDir()) {
  try {
    const data = JSON.parse(fs.readFileSync(lockOwnerPath(dir), 'utf8'));
    return data && Number.isInteger(data.pid) ? data : null;
  } catch {
    return null;
  }
}

function lockAgeMs(dir) {
  try {
    return Math.max(0, Date.now() - fs.statSync(dir).mtimeMs);
  } catch {
    return 0;
  }
}

function formatAge(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${String(sec % 60).padStart(2, '0')}s`;
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export class LockHeldError extends Error {
  /**
   * @param {any} holder
   * @param {string} lockPath
   * @param {{ageMs?: number, pidAlive?: boolean|null, reason?: string}} [opts]
   */
  constructor(holder, lockPath, { ageMs = null, pidAlive = null, reason = '' } = {}) {
    const pid = holder && Number.isInteger(holder.pid) ? holder.pid : '未知';
    const cwd = (holder && (holder.cwd || holder.processCwd)) || (holder ? '未知工作树' : '未知（owner 尚未落盘）');
    let age = Number.isFinite(ageMs) ? ageMs : null;
    if (age === null && holder && holder.startedAt) {
      const ts = Date.parse(holder.startedAt);
      if (Number.isFinite(ts)) age = Date.now() - ts;
    }
    const ageText = age === null ? '未知' : formatAge(age);
    let msg = `已有 mutator 在跑（pid ${pid}，cwd ${cwd}，已运行 ${ageText}）；锁目录：${lockPath}`;
    if (!holder) {
      // mkdir 成功、owner.json 还没落盘的几毫秒里，第二个进程会看到这个形状。
      // 这正是"不能只看进程在不在"的那个空窗——一律拒绝，绝不替它清锁。
      msg +=
        '。锁内容还读不到（可能刚 mkdir、owner 尚未落盘）——按"不接管"处理，稍后重试；' +
        '确认无人在跑后再手工解锁（见 test/mutate/FAILSAFE.md）。';
    } else if (pidAlive === false) {
      msg +=
        `。该 pid 当前不在，但锁的 mtime 只有 ${ageText}（未超过 15 分钟）——可能正处在 mkdir→node 启动的空窗，` +
        '按"不接管"处理；确认无人在跑后再手工解锁（见 test/mutate/FAILSAFE.md）。';
    } else if (pidAlive === true) {
      msg += '。它正在跑：等它结束，或确认该 pid 不是 mutator 后再手工解锁。';
    } else {
      msg += '。锁内容不可读（可能正在初始化）；未超过 15 分钟不接管，确认无人在跑后手工解锁。';
    }
    if (reason) msg += `（${reason}）`;
    super(msg);
    this.name = 'LockHeldError';
    this.holder = holder;
    this.lockPath = lockPath;
    this.ageMs = age;
    this.pidAlive = pidAlive;
  }
}

/** 本进程持有的锁（目录 → 引用计数）。同 pid 重复 acquire 是幂等的。 */
const heldLocks = new Map();
function bumpHeld(dir, root, delta) {
  const prev = heldLocks.get(dir) || { count: 0, root };
  const count = prev.count + delta;
  if (count <= 0) heldLocks.delete(dir);
  else heldLocks.set(dir, { count, root });
  return count;
}

function makeLockHandle({ root, dir, own, holderPid }) {
  let released = false;
  return {
    root,
    own,
    path: dir,
    holderPid,
    release() {
      if (released) return false;
      released = true;
      if (!own) return false;
      if (bumpHeld(dir, root, -1) > 0) return false; // 同进程还有别的句柄仍持锁
      const current = readLockOwner(dir);
      if (!current || current.pid !== process.pid) return false; // 锁已被别人（陈旧清理后）接管，不能删别人的
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        return false;
      }
      journal('lock-released', { root, lock: dir });
      return true;
    },
  };
}

/** 退出路径上的兜底：只删 owner 仍是自己的锁，绝不碰别人的。 */
export function releaseAllLocks() {
  for (const [dir, entry] of [...heldLocks]) {
    const current = readLockOwner(dir);
    if (current && current.pid === process.pid) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        journal('lock-released', { root: entry.root, lock: dir, all: true });
      } catch {
        /* 退出路径上不能再抛 */
      }
    }
    heldLocks.delete(dir);
  }
}

function tokenDir(dir) {
  return `${dir}.takeover`;
}

/**
 * 拿"接管令牌"：只有拿到令牌的进程可以动陈旧锁，避免两个进程同时判陈旧后互相抢。
 * 令牌本身崩溃残留时，按同一套两条件（pid 死 + mtime > 15 分钟）用 rename 原子回收；
 * 活着的令牌直接返回 null（调用方拒绝，让人稍后重试）。
 */
function acquireTakeoverToken({ dir, root }) {
  const token = tokenDir(dir);
  const payload = JSON.stringify(
    { v: 1, pid: process.pid, startedAt: new Date().toISOString(), cwd: path.resolve(root), argv: process.argv.slice(2), host: os.hostname() },
    null,
    2
  );
  try {
    fs.mkdirSync(token);
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    const holder = readLockOwner(token);
    const age = lockAgeMs(token);
    if (holder && isPidAlive(holder.pid)) return null;
    if (age <= LOCK_STALE_MS) return null;
    const tomb = `${token}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(token, tomb);
    } catch {
      return null;
    }
    try {
      fs.rmSync(tomb, { recursive: true, force: true });
    } catch {
      return null;
    }
    try {
      fs.mkdirSync(token);
    } catch {
      return null;
    }
  }
  try {
    const tmp = path.join(token, `owner.${process.pid}.tmp`);
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, lockOwnerPath(token));
  } catch (e) {
    try {
      fs.rmSync(token, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
    throw e;
  }
  return token;
}

function releaseTakeoverToken(token) {
  if (!token) return;
  try {
    fs.rmSync(token, { recursive: true, force: true });
  } catch {
    /* 令牌清不掉只会拖慢下一次接管，不能反过来阻断本次 */
  }
}

/**
 * 接管陈旧锁：rename 整个锁目录到唯一 tombstone（原子），再重建。调用方必须已持令牌。
 * @returns {boolean} 是否成功抢到（false = 令牌/锁被别人先动了，调用方重试）
 */
function takeOverStaleLock({ dir, root, holder, ageMs, quiet, reclaimDeadOwner = false }) {
  const token = acquireTakeoverToken({ dir, root });
  if (!token) return false;
  try {
    // 拿到令牌后重新核对：这段时间里可能已经有人清掉并重建了锁。
    const fresh = readLockOwner(dir);
    const freshAge = lockAgeMs(dir);
    /** @type {boolean} */
    let stillStale;
    if (!fresh) stillStale = freshAge > LOCK_STALE_MS;
    else if (fresh.pid === process.pid) stillStale = false;
    else if (isPidAlive(fresh.pid)) stillStale = false;
    else stillStale = freshAge > LOCK_STALE_MS || reclaimDeadOwner;
    if (!stillStale) return false;
    const tomb = `${dir}.stale-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(dir, tomb);
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
      throw e;
    }
    try {
      fs.rmSync(tomb, { recursive: true, force: true });
    } catch {
      /* 旧锁内容清不掉不影响抢占（下一次 mtime 判据仍按新目录算） */
    }
    if (!quiet) {
      console.log(
        `[mutate] 清理陈旧锁并接管：${dir}（pid ${(holder && holder.pid) || (fresh && fresh.pid) || '?'} 已不在，锁已 ${formatAge(ageMs)} 未更新）`
      );
    }
    journal('lock-stale', { root, lock: dir, holderPid: (holder && holder.pid) || (fresh && fresh.pid) || null, ageMs });
    return true;
  } finally {
    releaseTakeoverToken(token);
  }
}

/**
 * 抢全局变异锁。
 *
 * @param {{root?: string, quiet?: boolean, reclaimDeadOwner?: boolean}} [opts]
 *   `reclaimDeadOwner` 只给 `check.mjs` 这个**显式自愈入口**用：owner 里记录的 pid 已死时，
 *   即使锁 mtime 很新也允许接管（否则强杀后 15 分钟内无法自愈残留补丁）。它仍然**绝不**接管
 *   pid 存活、或 owner 还读不到（mkdir→node 空窗）的锁；`run.mjs` 永远走严格两条件。
 */
export function acquireLock({ root = repoRoot, quiet = false, reclaimDeadOwner = false } = {}) {
  const dir = globalLockDir();
  const payload = {
    v: 2,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: path.resolve(root),
    argv: process.argv.slice(2),
    host: os.hostname(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.mkdirSync(dir);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const holder = readLockOwner(dir);
      const ageMs = lockAgeMs(dir);
      if (holder && holder.pid === process.pid) {
        bumpHeld(dir, root, 1);
        return makeLockHandle({ root, dir, own: true, holderPid: process.pid });
      }
      if (holder && isPidAlive(holder.pid)) {
        journal('lock-refused', { root, lock: dir, holderPid: holder.pid, ageMs, why: 'pid-alive' });
        throw new LockHeldError(holder, dir, { ageMs, pidAlive: true });
      }
      const deadOwner = Boolean(holder);
      const staleByAge = ageMs > LOCK_STALE_MS;
      // 严格两条件：① pid 已不在 ② mtime 超过 15 分钟。check 的自愈入口额外允许 ① 单条，
      // 但空窗（owner 读不到）永远要求 ②——那才是今天误删活锁的形状。
      const canTakeOver = deadOwner ? staleByAge || reclaimDeadOwner : staleByAge;
      if (!canTakeOver) {
        // 条件 ① 满足、② 不满足：绝不接管（mkdir→node 空窗的回归）。
        journal('lock-refused', { root, lock: dir, holderPid: holder ? holder.pid : null, ageMs, why: deadOwner ? 'fresh-lock-dead-pid' : 'unreadable-fresh' });
        throw new LockHeldError(holder, dir, { ageMs, pidAlive: deadOwner ? false : null });
      }
      if (!takeOverStaleLock({ dir, root, holder, ageMs, quiet, reclaimDeadOwner })) {
        continue; // 令牌/锁被别人动了，重试（下一轮会看到新的真实状态）
      }
      continue; // 已清掉旧锁，回到循环去 mkdir
    }
    // mkdir 成功 = 抢到。锁内容原子落盘（先写临时文件再 rename），避免半截 JSON。
    try {
      const tmp = path.join(dir, `owner.${process.pid}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, lockOwnerPath(dir));
    } catch (err) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 尽力而为 */
      }
      throw err;
    }
    bumpHeld(dir, root, 1);
    journal('lock-acquired', { root, lock: dir });
    return makeLockHandle({ root, dir, own: true, holderPid: process.pid });
  }
  throw new LockHeldError(readLockOwner(dir), dir, { ageMs: lockAgeMs(dir), pidAlive: null, reason: '接管竞争失败，稍后重试' });
}

/** 子进程继承父进程的锁（run.mjs 持锁跑批次，批次进程不再抢锁）。 */
export function inheritLock({ root = repoRoot, pid }) {
  const dir = globalLockDir();
  const holder = readLockOwner(dir);
  if (!holder || holder.pid !== pid || !isPidAlive(pid)) return null;
  // cwd 必须对得上：防止环境变量被别的工作树的进程误继承。
  if (holder.cwd && !samePath(holder.cwd, root)) return null;
  return makeLockHandle({ root, dir, own: false, holderPid: pid });
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
      releaseAllLocks();
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
