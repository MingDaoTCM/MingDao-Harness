// 任务检查点（v0.3.0 P0-2）：把「一轮 24 步跑满即止」升级为「可续跑」。
// 存储：<mingdao-home>/taskstates/<会话名>.json（独立侧车文件 + 原子写，不污染会话 JSONL 消息结构）。
// 状态：{ goal, progress, artifacts, status('cap'|'interrupted'), updatedAt }
//   - cap：本轮跑满步数上限，未完成，可续跑；
//   - interrupted：用户主动中断（Ctrl+C/停止），可续跑；
//   - 任务正常完成时清除检查点（clearTaskState）。
import fs from 'node:fs';
import path from 'node:path';
import { mingdaoHome } from './config.js';
import { atomicWriteFileSync } from './atomic-write.js';

function taskStateDir() {
  return path.join(mingdaoHome(), 'taskstates');
}

/** @param {any} sessionName */
export function taskStateFile(sessionName) {
  return path.join(taskStateDir(), `${String(sessionName)}.json`);
}

/** @param {any} sessionName */
export function loadTaskState(sessionName) {
  try {
    const j = JSON.parse(fs.readFileSync(taskStateFile(sessionName), 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * 落盘检查点，**返回结果而不再静默吞掉**（v0.6.2，audit-report B-WS-1/2 的第二处）。
 *
 * 为什么这里必须可见：跑满步数时 agent 会打印「继续方式：直接发送『继续』即可」——
 * 那是**一个承诺**。而真正写检查点的是调用方（cli/web/repl），写在 banner **之后**。
 * 旧实现写失败只 `catch {}`，于是承诺照旧给出、续跑提示却永远不会出现：
 * 用户下次说「继续」，模型拿不到 goal/进度/交付物清单，只能从头猜。
 * 静默在这里的代价不是"少一个文件"，而是**用户按提示操作却得不到承诺的效果**。
 * @param {any} sessionName @param {any} ts
 * @returns {{ok: boolean, error: string|null}}
 */
export function saveTaskState(sessionName, ts) {
  try {
    const dir = taskStateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(taskStateFile(sessionName), JSON.stringify(ts) + '\n', { mode: 0o600 });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

/**
 * 清除检查点。**ENOENT 视为成功**（本来就没有检查点是常态，不能因此报警），
 * 其余失败必须报出来：清不掉 = 已完成的任务仍留着「未完成」检查点，
 * 下次打开该会话会被误提示续跑。
 * @param {any} sessionName
 * @returns {{ok: boolean, error: string|null}}
 */
export function clearTaskState(sessionName) {
  try {
    fs.unlinkSync(taskStateFile(sessionName));
    return { ok: true, error: null };
  } catch (err) {
    if (/** @type {any} */ (err)?.code === 'ENOENT') return { ok: true, error: null };
    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };
  }
}

/**
 * 把检查点写入结果翻译成**给用户看的那句话**，返回 null 表示无需提示。
 * 文案只此一处：三个调用点（cli / web / repl）共用，避免"改一处漏两处"。
 * @param {{ok: boolean, error: string|null}|null|undefined} res
 * @param {'save'|'clear'} [kind]
 * @returns {string|null}
 */
export function checkpointHint(res, kind = 'save') {
  if (!res || res.ok) return null;
  if (kind === 'clear') {
    return (
      `⚠ 上一任务的检查点未能清除：${res.error}\n` +
      `  该会话可能被误判为「未完成」，下次打开会提示续跑；可手动删除 <MINGDAO_HOME>/taskstates/ 下的对应文件。`
    );
  }
  return (
    `⚠ 任务检查点写入失败：${res.error}\n` +
    `  这意味着下次「继续」**不会**带上断点摘要（目标/进度/已交付文件会丢）——\n` +
    `  请把当前进度与已交付文件写在下一条消息里，再让我接着做。`
  );
}

// 合并落盘（v0.3.1 P2-3 修复）：续跑再中断时保留原始 goal、合并 artifacts，只更新 progress/status。
// 避免「第二次续跑」时把 goal 覆盖成「继续」、把已交付文件清单清零。
/** @param {any} sessionName @param {any} ts */
export function saveTaskStateMerge(sessionName, ts) {
  const prev = loadTaskState(sessionName);
  const prevUnfinished = prev && (prev.status === 'cap' || prev.status === 'interrupted');
  const merged = prevUnfinished
    ? {
        goal: prev.goal || ts.goal,
        artifacts: [...new Set([...(Array.isArray(prev.artifacts) ? prev.artifacts : []), ...(Array.isArray(ts.artifacts) ? ts.artifacts : [])])],
        progress: ts.progress || prev.progress,
        status: ts.status,
        updatedAt: ts.updatedAt,
      }
    : ts;
  return saveTaskState(sessionName, merged);
}

// 续跑提示：注入到消息历史，让模型先核对现状（已完成文件不重做）、再做未完成部分。
/** @param {any} ts */
export function resumePrompt(ts) {
  const art = (Array.isArray(ts?.artifacts) && ts.artifacts.length ? ts.artifacts : []).join('、') || '（无）';
  const progress = String(ts?.progress || '').slice(0, 2000) || '（无总结）';
  const goal = String(ts?.goal || '').slice(0, 500) || '（未知）';
  return (
    `（系统提示）上一个任务「${goal}」因步数上限中断，尚未完成，现在续跑。\n` +
    `已完成进度摘要：\n${progress}\n` +
    `已交付文件（勿重复重做，先核对现状）：${art}\n` +
    `请从断点继续：先确认已完成部分的现状，再完成剩余工作。`
  );
}
