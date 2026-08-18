// 系统提示词构建：基础角色 + 用户记忆 + 技能清单 + 项目 AGENTS.md。
// 借鉴 Claude Code 的记忆文件与 Codex 的技能渐进披露约定。

import fs from 'node:fs';
import path from 'node:path';
import { skillsRegistryBlock } from './skills.js';
import { mingdaoHome } from './config.js';

const BASE = `你是 MingDao（明道），一个由 MingDao-Harness 驱动的 AI 编程助手。你在用户的电脑上工作：通过工具读写文件、搜索代码、执行命令，帮助用户完成编程、调试与自动化任务。

工作准则：
1. 先了解再动手：修改或创建代码前，先用 read / ls / glob / grep 查看相关文件，不要凭空猜测。
2. 精准修改：优先用 edit 做小步精确替换；新建文件用 write；保持改动最小化；改错可用 undo 撤销。
3. 任务管理：多步骤任务先建 todo 清单并逐项更新；与技能（skill）相关的任务先加载对应 SKILL.md。
4. 委托与专注：独立、可并行的子问题（调研、复核、独立实现）用 task 委托子代理，把结果拿回来继续主线。
5. 命令谨慎：执行 bash 前想清楚影响；命令失败时阅读错误输出并修复，同一问题最多重试 3 次。
6. 回答风格：使用用户的语言（默认中文），简洁直接，先结论后说明。
7. 诚实可靠：不编造不存在的文件、行号、API 或执行结果。
8. 善用工具：能用工具确认的事实就用工具确认；多个只读工具可连续调用以提高效率。`;

function loadFile(p, cap) {
  try {
    const s = fs.readFileSync(p, 'utf8');
    return s.length > cap ? s.slice(0, cap) + '\n…[过长已截断]' : s;
  } catch {
    return null;
  }
}

export function buildSystemPrompt({ modelName, workingDir }) {
  let prompt = `${BASE}

当前工作目录：${workingDir}
当前模型：${modelName}
当前时间：${new Date().toISOString()}`;

  // 用户级记忆（~/.mingdao/AGENTS.md，可用 /memory add 追加）
  const memory = loadFile(path.join(mingdaoHome(), 'AGENTS.md'), 8000);
  if (memory) prompt += `\n\n<user_memory>\n${memory}\n</user_memory>`;

  // 技能清单（渐进披露：仅名称+描述，按需加载全文）
  prompt += skillsRegistryBlock(workingDir);

  // 项目约定（./AGENTS.md）
  const agentsMd = loadFile(path.join(workingDir, 'AGENTS.md'), 20000);
  if (agentsMd) prompt += `\n\n<agents_md>\n${agentsMd}\n</agents_md>`;

  return prompt;
}
