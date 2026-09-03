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

/** @param {any} sessionName @param {any} ts */
export function saveTaskState(sessionName, ts) {
  try {
    const dir = taskStateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    atomicWriteFileSync(taskStateFile(sessionName), JSON.stringify(ts) + '\n', { mode: 0o600 });
  } catch {}
}

/** @param {any} sessionName */
export function clearTaskState(sessionName) {
  try {
    fs.unlinkSync(taskStateFile(sessionName));
  } catch {}
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
