// 会话「文件族」生命周期（v0.10.1，v0.8.1 审计报告2 M-06）：
// 删除 / 改名一个会话时，必须把它**同一 basename 的全部伴生文件**一起处理，不能只动 `.jsonl`。
//
// 为什么需要这个模块：此前 `POST /api/session` 的 delete 只 `unlink(.jsonl)`、rename 只
// `rename(.jsonl)`，而一个会话在磁盘上实际有 6 个文件（以实际代码为准，见 `sessionFileFamily()`）：
//
//   <home>/sessions/<name>.jsonl                     消息本体
//   <home>/sessions/<name>.jsonl.lock                会话写锁（append / rewrite）
//   <home>/sessions/<name>.events.ndjson             事件侧车（v0.7.0 §1.1）
//   <home>/sessions/<name>.events.ndjson.lock        事件追加锁（session-events.js）
//   <home>/taskstates/<name>.jsonl.json              任务检查点侧车（task-state.js，名字就是「会话文件名 + .json」）
//   <home>/taskstates/<name>.jsonl.json.lock         检查点写锁
//
// 残留的后果（审计实测）：磁盘只增不减；`scripts/event-parity.mjs` 的对拍集合里出现
// 「有事件侧车、没有会话」的幽灵；删除后再新建同名会话会继承旧事件日志（seq 从旧值继续），
// 客户端按游标重取时拿到不属于本会话的事件。
//
// 两个操作都做**要么全成、要么不留半套**：
//   · 删除：先把全部现存文件 `rename` 进同目录的隐藏临时目录（同一文件系统内 rename 是原子的），
//     全部搬完才 `rm -rf` 临时目录；中途任何一步失败 → 把已搬走的按逆序搬回原路径并报错，
//     **绝不留下「主文件没了、侧车还在」**这种半删状态。
//   · 改名：同样是「先搬到一个中间态、失败逆序搬回」，全部成功才算改名成功。
//
// 为什么用 rename 而不是先备份内容：会话文件可能几十 MB，复制既慢又可能写失败；
// rename 不搬数据、同设备内原子，而且天然保留权限/时间戳。
import fs from 'node:fs';
import path from 'node:path';
import { eventFileFor } from './session-events.js';

/** 会话文件族：主文件 + 会话写锁 + 事件侧车 + 事件锁 + 任务检查点 + 检查点锁。
 * @param {string} sessionFile @returns {{main:string,event:string,taskState:string,files:string[]}} */
export function sessionFileFamily(sessionFile) {
  const main = String(sessionFile);
  const event = eventFileFor(main);
  // 会话在 <home>/sessions/ 下，任务检查点在 <home>/taskstates/ 下（见 task-state.js#taskStateFile）。
  const home = path.dirname(path.dirname(main));
  const taskState = path.join(home, 'taskstates', `${path.basename(main)}.json`);
  return {
    main,
    event,
    taskState,
    files: [main, `${main}.lock`, event, `${event}.lock`, taskState, `${taskState}.lock`],
  };
}

/** 供调用方判断「目标 basename 是否已被占用」（主文件或任一侧车存在都算）。
 * @param {string} sessionFile @param {any} [io] @returns {boolean} */
export function sessionFamilyExists(sessionFile, io = fs) {
  return sessionFileFamily(sessionFile).files.some((f) => {
    try {
      return io.existsSync(f);
    } catch {
      return false;
    }
  });
}

/** @param {any} err */
function errorText(err) {
  return String(/** @type {any} */ (err)?.message ?? err);
}

/**
 * 逆序搬回。返回回滚失败的原因（空串 = 全部还原成功）。
 * @param {any} io @param {{from:string,to:string}[]} moved
 */
function rollbackMoved(io, moved) {
  const failed = [];
  for (let i = moved.length - 1; i >= 0; i -= 1) {
    const m = moved[i];
    try {
      io.renameSync(m.to, m.from);
    } catch (err) {
      // 回滚失败必须可见：它会留下半套文件，调用方/用户需要知道去手工处理哪几个路径。
      console.warn(`[MingDao] ⚠ 会话文件回滚失败：无法还原 ${m.from}（${errorText(err)}）`);
      failed.push(`${m.from}（${errorText(err)}）`);
    }
  }
  return failed.length ? `以下文件未能还原：${failed.join('、')}` : '';
}

/**
 * 原子删除一个会话的文件族。
 *
 * 成功 = 6 个文件（存在的那几个）都不再以原来的名字存在；
 * 失败 = 原状保留（或如实报告哪些没能还原），绝不「删一半」。
 *
 * @param {string} sessionFile 会话主文件绝对路径
 * @param {{io?: any}} [opts] io 仅给单测注入（默认 node:fs）
 * @returns {{ok: boolean, error: string|null, removed: string[]}}
 */
export function deleteSessionFamily(sessionFile, { io = fs } = {}) {
  const { files } = sessionFileFamily(sessionFile);
  /** @type {string[]} */
  const existing = [];
  for (const f of files) {
    try {
      if (io.existsSync(f)) existing.push(f);
    } catch {
      // existsSync 失败（权限）按「不好判断」处理、交由 rename 报错，绝不静默跳过。
      existing.push(f);
    }
  }
  if (!existing.length) return { ok: true, error: null, removed: [] };
  const dir = path.dirname(files[0]);
  /** @type {string} */
  let trash;
  try {
    trash = io.mkdtempSync(path.join(dir, '.session-del-'));
  } catch (err) {
    return { ok: false, error: `删除会话失败（无法创建临时目录）：${errorText(err)}`, removed: [] };
  }
  /** @type {{from:string,to:string}[]} */
  const moved = [];
  try {
    for (let i = 0; i < existing.length; i += 1) {
      const from = existing[i];
      const to = path.join(trash, `${i}-${path.basename(from)}`);
      io.renameSync(from, to);
      moved.push({ from, to });
    }
  } catch (err) {
    const rollbackError = rollbackMoved(io, moved);
    try {
      io.rmSync(trash, { recursive: true, force: true });
    } catch (err) {
      // 临时目录清不掉不影响「已回滚」的结论，但会占磁盘，必须留下可见告警。
      console.warn(`[MingDao] ⚠ 会话删除的临时目录清不掉：${trash}（${errorText(err)}）`);
    }
    return {
      ok: false,
      error: `删除会话失败：${errorText(err)}${rollbackError ? `；${rollbackError}` : '（已回滚，原文件保持未删）'}`,
      removed: [],
    };
  }
  try {
    io.rmSync(trash, { recursive: true, force: true });
  } catch (err) {
    // 全部文件已搬进临时目录后才失败：回滚，保证「要么删掉、要么保持原状」。
    const rollbackError = rollbackMoved(io, moved);
    try {
      io.rmSync(trash, { recursive: true, force: true });
    } catch (err) {
      // 见上：全部文件都已在临时目录里，清不掉只会占磁盘。
      console.warn(`[MingDao] ⚠ 会话删除的临时目录清不掉：${trash}（${errorText(err)}）`);
    }
    return {
      ok: false,
      error: `删除会话失败：${errorText(err)}${rollbackError ? `；${rollbackError}` : '（已回滚，原文件保持未删）'}`,
      removed: [],
    };
  }
  return { ok: true, error: null, removed: existing };
}

/**
 * 原子搬迁一个会话的文件族（改名 / 移动工作空间时使用）。
 *
 * 目标族的任一文件已存在 → 拒绝（调用方另选名字），绝不覆盖别人的侧车；
 * 中途失败 → 逆序搬回，原会话保持原状。
 *
 * 锁文件（`*.lock`）的特别处理：它们是**瞬时**并发控制文件，**不搬到新名字**——
 * 若把别人（或自己）正在持有的锁改名到新会话名下，锁的释放路径仍去 unlink 旧路径，
 * 新名下就会留下一个「持有者还活着的」孤儿锁，改名后的会话下一次写入会白等超时。
 * 因此锁文件在改名事务里先搬进同目录临时目录（可回滚），全部成功后再随临时目录删除。
 *
 * @param {string} oldSessionFile @param {string} newSessionFile
 * @param {{io?: any}} [opts]
 * @returns {{ok: boolean, error: string|null, moved: {from:string,to:string}[]}}
 */
export function moveSessionFamily(oldSessionFile, newSessionFile, { io = fs } = {}) {
  const from = sessionFileFamily(oldSessionFile);
  const to = sessionFileFamily(newSessionFile);
  if (path.resolve(from.main) === path.resolve(to.main)) {
    return { ok: false, error: '目标名与原会话相同', moved: [] };
  }
  /** @param {string} p */
  const exists = (p) => {
    try {
      return io.existsSync(p);
    } catch {
      return false;
    }
  };
  if (!exists(from.main)) return { ok: false, error: '会话主文件不存在', moved: [] };
  /** @type {{from:string,to:string|null}[]} */
  const pairs = [];
  for (let i = 0; i < from.files.length; i += 1) {
    const source = from.files[i];
    if (!exists(source)) continue;
    // 目标族的任一文件（含锁）已存在都算冲突：调用方据此换随机后缀，绝不覆盖。
    try {
      if (io.existsSync(to.files[i])) {
        return { ok: false, error: `目标位置已存在同名文件：${to.files[i]}`, moved: [] };
      }
    } catch {
      return { ok: false, error: `无法确认目标位置是否可用：${to.files[i]}`, moved: [] };
    }
    pairs.push({ from: source, to: source.endsWith('.lock') ? null : to.files[i] });
  }
  /** @type {string|null} */
  let trash = null;
  /** @type {{from:string,to:string}[]} */
  const moved = [];
  try {
    for (const pair of pairs) {
      let destination = pair.to;
      if (destination === null) {
        if (!trash) trash = io.mkdtempSync(path.join(path.dirname(from.main), '.session-move-'));
        destination = path.join(/** @type {string} */ (trash), path.basename(pair.from));
      }
      io.renameSync(pair.from, destination);
      moved.push({ from: pair.from, to: destination });
    }
  } catch (err) {
    const rollbackError = rollbackMoved(io, moved);
    if (trash) {
      try {
        io.rmSync(trash, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn(`[MingDao] ⚠ 会话改名的临时目录清不掉：${trash}（${errorText(cleanupErr)}）`);
      }
    }
    return {
      ok: false,
      error: `会话改名失败：${errorText(err)}${rollbackError ? `；${rollbackError}` : '（已回滚，原会话保持原状）'}`,
      moved: [],
    };
  }
  if (trash) {
    try {
      io.rmSync(trash, { recursive: true, force: true });
    } catch (err) {
      // 全部文件已搬到目标/临时目录后才失败：回滚，保证「要么改名、要么保持原状」。
      const rollbackError = rollbackMoved(io, moved);
      try {
        io.rmSync(trash, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn(`[MingDao] ⚠ 会话改名的临时目录清不掉：${trash}（${errorText(cleanupErr)}）`);
      }
      return {
        ok: false,
        error: `会话改名失败：${errorText(err)}${rollbackError ? `；${rollbackError}` : '（已回滚，原会话保持原状）'}`,
        moved: [],
      };
    }
  }
  return { ok: true, error: null, moved };
}
