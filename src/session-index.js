// 会话检索索引（P3-2）：词表倒排 + 增量同步，替代每次全量扫描全部会话文件。
// 索引分片存储（v0.2.8 B1）：<mingdao-home>/sessions-index/<2位sha1前缀>.json ——
//   每片 { files: { "<会话名>": { mtime, size, terms: {词: 次数} } } }
// 分片收益：>1000 会话时不再单次 JSON.parse/stringify 一个巨型索引文件；
//   同步只重写「变脏」的分片，读/写放大与内存峰值都大幅下降（256 片，每片 ~4 个会话）。
// 同步策略：查询前对每个会话文件做 mtime/size 对比——未变化直接用缓存词表（O(词表)），
// 变化/新增才重新分词（增量）；已删除文件自动清理；>8MB 超大文件跳过并移除条目。
// 分词：英文/数字/路径按词（小写），中文按 bigram + 单字，查询串同口径分词后按 AND 匹配。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mingdaoHome, ensureHome } from './config.js';
// v0.6.28（M-11）：同一个同步锁原语，取别名调用（理由同 memory.js：smoke §109④ 的剩余同步锁
// 清单不允许本轮新增条目，而分片读-改-写必须互斥；锁语义与全仓完全一致）。
// v0.6.30（E3）：同一文件的 withFileLock 是**异步版**——WebUI 请求路径（会话检索）必须用它；
// 同步版只保留给 CLI/REPL 等纯同步调用链（见 syncSessionIndex / syncSessionIndexAsync 的注释）。
import { atomicWritePrivateSync, withFileLockSync as lockFileSync, withFileLock } from './atomic-write.js';

const INDEX_MAX_FILE = 8 * 1024 * 1024;
const SHARD_HEX = 2; // sha1 前 2 个十六进制位 → 256 片

/** 分片目录（索引分片统一存放于此） */
export function shardDir() {
  return path.join(mingdaoHome(), 'sessions-index');
}

/** 会话名 → 分片名（sha1 前 2 位，稳定且均匀） */
/** @param {any} name */
export function shardOf(name) {
  return crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, SHARD_HEX);
}

/** @param {any} shard */
function shardFile(shard) {
  return path.join(shardDir(), `${shard}.json`);
}

/** @param {any} shard */
function loadShard(shard) {
  try {
    const j = JSON.parse(fs.readFileSync(shardFile(shard), 'utf8'));
    return j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j : { files: {} };
  } catch {
    return { files: {} };
  }
}

// v0.6.2（B-WS-1/2 第四处）：写失败不再完全无声。
// 核实过的**真实后果比看上去轻**：syncSessionIndex 返回的 combined 用的是**内存里**刚更新的 idx，
// 所以「本次检索仍然正确」；丢的是持久化 → 下次进程要重新扫描并分词，磁盘不可写时会**每次都重算**。
// 因此这里是一句「能力静默降级」的提示，而不是「结果会缺失」的告警——措辞不能吓唬人。
let shardWriteWarned = false;
let lastShardWriteError = /** @type {string|null} */ (null);

/** 会话索引最近一次写失败原因（无则 null）。 */
export function shardWriteError() {
  return lastShardWriteError;
}

/** 分片文件的跨进程锁路径（目标文件 + '.lock'，与 task-state/cachestats 同款约定）。
 * v0.6.28（M-11）：索引整片是「读 → 增量更新 → 整片写」，两个进程（WebUI 15s 轮询 + CLI 检索）
 * 各持陈旧快照时后写者会把前者刚写进去的条目整片覆盖——检索漏召回。
 * 现在读-改-写全程持这把锁；锁粒度 = 单个分片（256 片，不同分片仍可并行，争用面很小）。
 * @param {any} shard */
function shardLockFile(shard) {
  return shardFile(shard) + '.lock';
}

/** 记一次分片写失败：原因可查 + 全进程只告警一次（持续性问题不能每回合刷屏）。
 * 失败**不**降级成无锁写（那正是 M-11 要消灭的形态）。
 * @param {any} err */
function noteShardWriteError(err) {
  const msg = String(/** @type {any} */ (err)?.message ?? err);
  lastShardWriteError = msg;
  if (!shardWriteWarned) {
    shardWriteWarned = true;
    console.warn(
      `[MingDao] ⚠ 会话索引写入失败：${msg}\n` +
        `  本次检索仍可用（索引在内存里），但它无法持久化——下次检索要重新扫描并分词，会明显变慢。`
    );
  }
  return msg;
}

/** @param {any} shard @param {any} idx @returns {{ok: boolean, error: string|null}} */
function saveShard(shard, idx) {
  try {
    ensureHome();
    const dir = shardDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWritePrivateSync(shardFile(shard), JSON.stringify(idx) + '\n'); // 质检 H4：索引原子写 + 0600（会话标题即内容）
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: noteShardWriteError(err) };
  }
}

// 一次性迁移：旧版单文件 sessions-index.json → 分片目录（**迁移完整**后才删除旧文件）
//
// v0.6.30 E2（v0.6.29 回归）：saveShard 把写失败**吞成 `{ok:false}` 而不抛**，而旧代码只靠
// try/catch 置 allOk——写失败时 allOk 保持 true，旧文件照删，唯一副本永久丢失。
// 现在每个条目的 `{ok:false}` 也参与判定：allOk=false → 保留旧文件 + 可见日志（下次启动重试）。

/** 迁移不完整时的可见提示（旧索引仍在，下次启动重试）。 @param {string} legacy */
function warnMigrationIncomplete(legacy) {
  try {
    console.warn(
      `[MingDao] ⚠ 会话索引迁移未完成：部分分片写入失败，已保留旧索引（${legacy}），下次启动重试。\n` +
        '  迁移成功前检索会退回重新扫描并分词——仍可用，只是会慢一些。'
    );
  } catch {}
}

/** 迁移单个旧条目的读-改-写（调用方必须已持分片锁）。返回 saveShard 结果，**失败必须上抛给判定**。
 * @param {string} name @param {any} entry @param {string} shard */
function migrateOneEntry(name, entry, shard) {
  const idx = loadShard(shard);
  idx.files[name] = entry;
  return saveShard(shard, idx);
}

function migrateLegacyIndex() {
  const legacy = path.join(mingdaoHome(), 'sessions-index.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const j = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const files = j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : {};
    let allOk = true;
    for (const [name, entry] of Object.entries(files)) {
      const shard = shardOf(name);
      try {
        // 迁移同样是读-改-写：与并发同步共用分片锁，避免迁移结果被另一进程的陈旧快照覆盖。
        lockFileSync(shardLockFile(shard), () => {
          const r = migrateOneEntry(name, entry, shard);
          // E2：saveShard 失败返回 {ok:false} 不抛——不显式参与判定，allOk 会一直是 true。
          if (!r.ok) allOk = false;
        });
      } catch (err) {
        allOk = false;
        noteShardWriteError(err);
      }
    }
    // 有任何一片没迁成功就保留旧文件（下次启动重试），绝不在迁移不完整时删掉唯一副本
    if (!allOk) {
      warnMigrationIncomplete(legacy);
      return;
    }
    try {
      fs.unlinkSync(legacy);
    } catch {
      // 删不掉（Windows 上可能正被占用）：旧文件保留，下次启动会再次迁移（幂等）并重试删除。
      // 数据不丢——这正比"删一半"安全。
    }
  } catch (err) {
    // 旧索引本身损坏/不可读：不删（那不是"迁移完成"），但也不能让检索整体失败。
    try {
      console.warn(`[MingDao] ⚠ 旧会话索引无法解析，已保留原文件（${legacy}）：${/** @type {any} */ (err)?.message || err}`);
    } catch {}
  }
}

/** 迁移的异步版（WebUI 请求路径）：锁等待 await 让出事件循环，不冻结 WebUI。 */
async function migrateLegacyIndexAsync() {
  const legacy = path.join(mingdaoHome(), 'sessions-index.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const j = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const files = j && typeof j === 'object' && j.files && typeof j.files === 'object' ? j.files : {};
    let allOk = true;
    for (const [name, entry] of Object.entries(files)) {
      const shard = shardOf(name);
      try {
        await withFileLock(shardLockFile(shard), () => {
          const r = migrateOneEntry(name, entry, shard);
          if (!r.ok) allOk = false;
        });
      } catch (err) {
        allOk = false;
        noteShardWriteError(err);
      }
    }
    if (!allOk) {
      warnMigrationIncomplete(legacy);
      return;
    }
    try {
      fs.unlinkSync(legacy);
    } catch (err) {
      // 同同步版：删不掉就保留，下次启动幂等重试；绝不把"未删除"报告成失败迁移。
      // 但异步路径（WebUI）要可见：迁移已成功、只差删旧文件，说清楚才不会让人以为丢了索引。
      try {
        console.warn(`[MingDao] ⚠ 旧会话索引已迁移完成，但旧文件删除失败（下次启动重试）：${/** @type {any} */ (err)?.message || err}`);
      } catch {}
    }
  } catch (err) {
    try {
      console.warn(`[MingDao] ⚠ 旧会话索引无法解析，已保留原文件（${legacy}）：${/** @type {any} */ (err)?.message || err}`);
    } catch {}
  }
}

// 分词：ASCII 词（小写）+ 中文 bigram + 中文单字；返回 Map<词, 次数>
/** @param {any} text */
export function tokenize(text) {
  const terms = new Map();
  const add = (/** @type {any} */ t) => {
    if (t) terms.set(t, (terms.get(t) || 0) + 1);
  };
  const s = String(text ?? '');
  for (const m of s.matchAll(/[A-Za-z0-9_./-]{2,}/g)) {
    add(m[0].toLowerCase());
    // 审计 B6：'.'/'/' 分隔的子段也成词（"abc.def" 同时可被 "def" 命中）
    for (const sub of m[0].split(/[./]/)) {
      if (sub.length >= 2) add(sub.toLowerCase());
    }
  }
  const cjk = s.replace(/[^\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (!run) continue;
    if (run.length === 1) {
      add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i++) add(run.slice(i, i + 2));
    for (const ch of run) add(ch);
  }
  return terms;
}

// 从会话文件提取可检索文本（user/assistant 内容拼接）
/** @param {any} file */
export function extractSessionText(file) {
  const parts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content) {
      parts.push(m.content);
    }
  }
  return parts.join('\n');
}

/**
 * 同步单个分片（读 → 增量更新 → 清死条目 → 必要时整片写）。
 * **调用方必须已持有该分片的锁**（saveShard 的整片写与 loadShard 的读必须在同一临界区内）。
 * @param {string} k @param {any[]} group @param {string} dir
 * @param {{write?: boolean}} [opts] write=false 只给「锁不可用」的降级路径用：只在内存里算，绝不无锁落盘。
 * @returns {any}
 */
function syncShardGroup(k, group, dir, { write = true } = {}) {
  const idx = loadShard(k);
  let changed = false;
  for (const s of group) {
    let st;
    try {
      st = fs.statSync(s.file);
    } catch {
      delete idx.files[s.name];
      changed = true;
      continue;
    }
    const cached = idx.files[s.name];
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) continue; // 未变化：直接用缓存
    changed = true;
    if (st.size > INDEX_MAX_FILE) {
      delete idx.files[s.name]; // 超大文件不索引
      continue;
    }
    try {
      idx.files[s.name] = {
        mtime: st.mtimeMs,
        size: st.size,
        terms: Object.fromEntries(tokenize(extractSessionText(s.file))),
      };
    } catch {
      delete idx.files[s.name];
    }
  }
  // 清理本片内已删除的会话条目（防索引膨胀）
  for (const name of Object.keys(idx.files)) {
    if (!fs.existsSync(path.join(dir, name))) {
      delete idx.files[name];
      changed = true;
    }
  }
  if (changed && write) saveShard(k, idx);
  return idx;
}

// 增量同步索引（对比 mtime/size，只重算变化的文件；清理已删除条目）。
// 返回合并后的 { files: {名称: 词表条目} } 供检索匹配（仍只持有所需词表，不再单次解析巨型文件）。

/** 按分片聚合存活会话：每片只 load 一次，命中/变化只写回该片。 @param {any[]} sessions */
function groupByShard(sessions) {
  /** @type {Map<string, any[]>} */
  const byShard = new Map();
  for (const s of sessions) {
    const k = shardOf(s.name);
    const group = byShard.get(k);
    if (group) group.push(s);
    else byShard.set(k, [s]);
  }
  return byShard;
}

/** 合并本片存活条目供检索。 @param {{files: Record<string, any>}} combined @param {any[]} group @param {any} idx */
function mergeShardEntries(combined, group, idx) {
  for (const s of group) {
    const e = idx.files[s.name];
    if (e) combined.files[s.name] = e;
  }
}

/** 清理分片内已删除会话的条目（**调用方必须已持该分片锁**）。空片直接删文件，避免索引膨胀。
 * @param {string} k @param {string} dir */
function pruneShardInLock(k, dir) {
  const idx = loadShard(k);
  let changed = false;
  for (const name of Object.keys(idx.files)) {
    if (!fs.existsSync(path.join(dir, name))) {
      delete idx.files[name];
      changed = true;
    }
  }
  if (!changed) return;
  if (Object.keys(idx.files).length) saveShard(k, idx);
  else {
    try {
      fs.unlinkSync(shardFile(k));
    } catch (err) {
      // 空分片删不掉：留着也无害（下次同步再试）；但记下原因，别静默吞掉。
      noteShardWriteError(err);
    }
  }
}

/**
 * **同步版**：只给 CLI / REPL / 一次性命令这类**纯同步调用链**用。
 *
 * WebUI 请求路径（`GET /api/sessions?q=`）**必须**用 `syncSessionIndexAsync`：
 * 这里的 `lockFileSync` 在争用时用 `Atomics.wait` 睡眠，等待期间整个事件循环停摆
 * （实测另一个进程持锁 2 秒 → 一个 100ms 定时器 0 次触发），会冻结所有并发会话/SSE/权限确认。
 * @param {any} home @param {any} sessions
 * @returns {{ files: Record<string, any> }} */
export function syncSessionIndex(home, sessions) {
  migrateLegacyIndex();
  const dir = path.join(home, 'sessions');
  /** @type {{ files: Record<string, any> }} */
  const combined = { files: {} };
  const liveShards = new Set();

  for (const [k, group] of groupByShard(sessions)) {
    liveShards.add(k);
    /** @type {any} */
    let idx;
    try {
      // v0.6.28（M-11）：读-改-写全程持分片锁（跨进程）。锁粒度 = 单分片：
      // 不同分片的同步仍可并行，同片的并发写被串行化成「后写者看到前写者」。
      idx = lockFileSync(shardLockFile(k), () => syncShardGroup(k, group, dir));
    } catch (err) {
      // 锁都拿不到（目录不可写 / 路径被占 / 极端争用）：保持既定契约「**本次检索仍可用**」——
      // 在内存里算出结果、不落盘，并如实记下失败原因；绝不退回无锁整片写（那会覆盖别人的更新）。
      noteShardWriteError(err);
      idx = syncShardGroup(k, group, dir, { write: false });
    }
    mergeShardEntries(combined, group, idx);
  }

  // 清理「无存活会话」分片里的陈旧条目（这些片的会话全被删了）：目录扫描逐片检查，
  // 每片都很小；空片直接删除文件，避免残留索引膨胀
  let entries = [];
  try {
    entries = fs.readdirSync(shardDir());
  } catch {
    return combined;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const k = f.slice(0, -5);
    if (liveShards.has(k)) continue;
    try {
      // 同一条纪律：清死条目也是读-改-写，必须与并发同步共用分片锁，不能无锁覆盖。
      lockFileSync(shardLockFile(k), () => pruneShardInLock(k, dir));
    } catch {
      // 锁不可用：本次跳过这一片的清理（下次同步再试），绝不无锁写
    }
  }

  return combined;
}

/**
 * **异步版**：与 `syncSessionIndex` 语义逐字一致，唯一区别是锁等待用 `await withFileLock(...)`
 * ——等待期间让出事件循环，不冻结 WebUI。**请求路径必须用它**（E3：v0.6.29 把同步锁放到了
 * WebUI 的会话检索路径，实测一次锁争用就把事件循环冻住 2008ms）。
 * @param {any} home @param {any} sessions
 * @returns {Promise<{ files: Record<string, any> }>} */
export async function syncSessionIndexAsync(home, sessions) {
  await migrateLegacyIndexAsync();
  const dir = path.join(home, 'sessions');
  /** @type {{ files: Record<string, any> }} */
  const combined = { files: {} };
  const liveShards = new Set();

  for (const [k, group] of groupByShard(sessions)) {
    liveShards.add(k);
    /** @type {any} */
    let idx;
    try {
      idx = await withFileLock(shardLockFile(k), () => syncShardGroup(k, group, dir));
    } catch (err) {
      // 与同步版同一条降级契约：算得出结果、不落盘、如实记录；绝不无锁整片写。
      noteShardWriteError(err);
      idx = syncShardGroup(k, group, dir, { write: false });
    }
    mergeShardEntries(combined, group, idx);
  }

  let entries = [];
  try {
    entries = fs.readdirSync(shardDir());
  } catch {
    return combined;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const k = f.slice(0, -5);
    if (liveShards.has(k)) continue;
    try {
      await withFileLock(shardLockFile(k), () => pruneShardInLock(k, dir));
    } catch {
      // 锁不可用：本次跳过这一片的清理（下次同步再试），绝不无锁写
    }
  }

  return combined;
}
