// 系统提示词构建：基础角色 + 用户记忆 + 技能清单 + 项目 AGENTS.md。
// 借鉴 Claude Code 的记忆文件与 Codex 的技能渐进披露约定。

import fs from 'node:fs';
import path from 'node:path';
import { skillsRegistryBlock } from './skills.js';
import { mingdaoHome } from './config.js';
import { recentJournalBlock } from './memory.js';

const BASE = `你是 MingDao（明道），一个由 MingDao-Harness 驱动的 AI 编程助手。你在用户的电脑上工作：通过工具读写文件、搜索代码、执行命令，帮助用户完成编程、调试与自动化任务。

工作准则：
1. 先了解再动手：修改或创建代码前，先用 read / ls / glob / grep 查看相关文件，不要凭空猜测。
2. 精准修改：优先用 edit 做小步精确替换；新建文件用 write；保持改动最小化；改错可用 undo 撤销。
3. 任务管理：多步骤任务先建 todo 清单并逐项更新；与技能（skill）相关的任务先加载对应 SKILL.md。
4. 委托与专注：独立、可并行的子问题（调研、复核、独立实现）用 task 委托子代理，把结果拿回来继续主线。
5. 命令谨慎：执行 bash 前想清楚影响；命令失败时阅读错误输出并修复，同一问题最多重试 3 次。
6. 回答风格：使用用户的语言（默认中文），简洁直接，先结论后说明。
7. 诚实可靠：不编造不存在的文件、行号、API 或执行结果。
8. 善用工具：能用工具确认的事实就用工具确认；多个只读工具可连续调用以提高效率。
9. 交付收尾：完成工具操作后必须给出简短交付总结——生成了哪些文件（路径）、如何运行/使用（如「浏览器打开 angry-birds.html 即可游玩」或运行命令）、以及未完成或注意事项（若有）。绝不能不声不响结束。`;

function loadFile(p, cap) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.length > cap ? s.slice(0, cap) + '\n…[过长已截断]' : s;
  } catch {
    return null;
  }
}

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

  // 最近会话日志（跨会话连续性）：默认不注入——新会话应当全新开始，避免串到
  // 上一次会话的上下文（曾出现「新会话却接着给上个会话的游戏升级」的混淆）。
  // 仅当用户显式开启时注入（WebUI 勾选「带上文」/ CLI --journal）。
  if (withJournal) prompt += recentJournalBlock(mingdaoHome());

  // 技能清单（渐进披露：仅名称+描述，按需加载全文）
  prompt += skillsRegistryBlock(workingDir);

  // 项目约定（./AGENTS.md）
  const agentsMd = loadFile(path.join(workingDir, 'AGENTS.md'), 20000);
  if (agentsMd) prompt += `\n\n<agents_md>\n${agentsMd}\n</agents_md>`;

  return prompt;
}
