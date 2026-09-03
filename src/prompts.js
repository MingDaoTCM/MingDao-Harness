// 系统提示词构建：基础角色 + 用户记忆 + 技能清单 + 项目 AGENTS.md。
// 借鉴 Claude Code 的记忆文件与 Codex 的技能渐进披露约定。

import fs from 'node:fs';
import path from 'node:path';
import { skillsRegistryBlock } from './skills.js';
import { mingdaoHome, loadConfig } from './config.js';
import { recentJournalBlock, loadProjectMemory } from './memory.js';

const BASE = `你是 MingDao Harness，一个由 MingDao Harness 驱动的 AI 编程助手。你在用户的电脑上工作：通过工具读写文件、搜索代码、执行命令，帮助用户完成编程、调试与自动化任务。

工作准则：
1. 先了解再动手：修改或创建代码前，先用 read / ls / glob / grep 查看相关文件，不要凭空猜测。
2. 精准修改：优先用 edit 做小步精确替换；新建文件用 write；保持改动最小化；改错可用 undo 撤销。
3. 大内容分批写：单个 write 的参数总长控制在 6000 字符以内；大文件先写核心骨架，再分多次 write/edit 逐步补充——单次输出超限会被截断并导致参数解析失败。
4. 任务管理：多步骤任务先建 todo 清单并逐项更新；与技能（skill）相关的任务先加载对应 SKILL.md。
5. 委托与专注：把「互不依赖、可并行」的子问题（同时调研多个方向、复核多份文件、独立实现多模块）用 task 委托子代理；多个只读调研子代理应在同一轮一起派发（readOnly=true，自动并行，效率最高）；依赖当前对话细节的小改动自己做，不要委托。子代理返回后拿结果继续主线。
6. 命令谨慎：执行 bash 前想清楚影响；命令失败时阅读错误输出并修复，同一问题最多重试 3 次。
7. 回答风格：使用用户的语言（默认中文），简洁直接，先结论后说明。
8. 诚实可靠：不编造不存在的文件、行号、API 或执行结果。
9. 善用工具：能用工具确认的事实就用工具确认；多个只读工具可连续调用以提高效率。
10. 交付收尾：完成工具操作后必须给出简短交付总结——生成了哪些文件（路径）、如何运行/使用（如「浏览器打开 angry-birds.html 即可游玩」或运行命令）、以及未完成或注意事项（若有）。绝不能不声不响结束。`;

function loadFile(/** @type {any} */ p, /** @type {any} */ cap) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.length > cap ? s.slice(0, cap) + '\n…[过长已截断]' : s;
  } catch {
    return null;
  }
}

/** @param {{ workingDir: any, withJournal?: boolean, [key: string]: any }} opts */
export function buildSystemPrompt({ workingDir, withJournal = false }) {
  // 前缀字节稳定性（评估 P1-1/P1-2，四份评估一致的最高价值项）：
  // 系统提示不含「当前模型」「当前日期」等易变字段——DeepSeek 上下文缓存按前缀字节匹配，
  // 路由 pro⇄flash 翻转或跨天会改变前缀 → 整段历史按未命中价重计（命中价的 30 倍）。
  // 现在同一工作空间内系统提示恒定（记忆/技能/AGENTS.md 只在用户显式改动时变化）。
  let prompt = `${BASE}

当前工作目录：${workingDir}`;

  // 用户级记忆（~/.mingdao/AGENTS.md，/memory add 手动追加 + 会话结束自动提炼）
  const memory = loadFile(path.join(mingdaoHome(), 'AGENTS.md'), 8000);
  if (memory) prompt += `\n\n<user_memory>\n${memory}\n</user_memory>`;

  // 项目级自动记忆（v0.3.0 P0-3）：<工作空间>/.mingdao/memory.md 自动沉淀的决定/事实/教训。
  // 与 AGENTS.md（手动约定）区分；默认截 4K 保持系统提示前缀稳定，超长可 read 工具按需读。
  const projMem = loadProjectMemory(workingDir);
  if (projMem) prompt += `\n\n<project_memory>\n${projMem.length > 4000 ? projMem.slice(0, 4000) + '\n…[过长已截断]' : projMem}\n</project_memory>`;

  // 最近会话日志（跨会话连续性）：默认不注入——新会话应当全新开始，避免串到
  // 上一次会话的上下文（曾出现「新会话却接着给上个会话的游戏升级」的混淆）。
  // 仅当用户显式开启时注入（WebUI 勾选「带上文」/ CLI --journal）。
  if (withJournal) prompt += recentJournalBlock(mingdaoHome());

  // 技能清单（渐进披露：仅名称+描述，按需加载全文）
  prompt += skillsRegistryBlock(workingDir);

  // 项目约定（./AGENTS.md）——体积可配置（审计 MiniMax §3.3-B，v0.1.48 P0-D）：
  // 典型项目 6-12K 的 AGENTS.md 全量进 system 每轮按缓存价计费；默认截 4K，超长部分
  // 模型可 read 工具按需读全文。config.maxAgentsMdChars 可调（0 表示不注入）。
  const cfg = loadConfig();
  const agentsMdCap = cfg && Number.isFinite(Number(cfg.maxAgentsMdChars)) ? Math.max(0, Number(cfg.maxAgentsMdChars)) : 4000;
  if (agentsMdCap > 0) {
    const agentsMd = loadFile(path.join(workingDir, 'AGENTS.md'), agentsMdCap);
    if (agentsMd) prompt += `\n\n<agents_md>\n${agentsMd}\n</agents_md>`;
  }

  return prompt;
}
