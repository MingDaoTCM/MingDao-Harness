// 工具注册表：模型可见的工具 Schema（OpenAI function-calling 格式）与执行分发器。
// 文件/命令工具 + 智能体工具（skill 技能加载 / task 子代理 / todo 任务清单 / undo 撤销）。

import { read, write, edit, ls, glob, grep, undo } from './fs-tools.js';
import { runBash } from './bash.js';
import { listSkills, loadSkill } from '../skills.js';

// 只读工具集合的单一来源：permissions.js 引用此导出，新增只读工具时只需改这里
export const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'skill']);

const READ_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要读取的文件路径（相对或绝对）。' },
    offset: { type: 'integer', description: '起始行号，默认 1。' },
    limit: { type: 'integer', description: '最大返回行数，默认 400。' },
  },
  required: ['path'],
};

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要创建或覆盖的文件路径。' },
    content: { type: 'string', description: '完整文件内容（UTF-8）。' },
  },
  required: ['path', 'content'],
};

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要修改的文件路径。' },
    old_string: { type: 'string', description: '文件中真实存在的原文片段，必须逐字符完全一致。' },
    new_string: { type: 'string', description: '替换后的文本。' },
    replace_all: { type: 'boolean', description: '是否替换所有匹配处，默认 false。' },
  },
  required: ['path', 'old_string', 'new_string'],
};

const LS_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目录路径，默认当前工作目录。' },
  },
};

const GLOB_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '通配符模式，如 src/**/*.js、*.md。' },
    path: { type: 'string', description: '搜索根目录，默认当前工作目录。' },
  },
  required: ['pattern'],
};

const GREP_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '正则表达式。' },
    path: { type: 'string', description: '搜索根目录，默认当前工作目录。' },
    include: { type: 'string', description: '文件名通配符过滤，如 *.js。' },
  },
  required: ['pattern'],
};

const BASH_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: '要执行的 shell 命令。执行前会请求用户授权。' },
    timeout: { type: 'integer', description: '超时秒数，默认 120。' },
  },
  required: ['command'],
};

const SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '技能名；省略时列出所有可用技能。' },
  },
};

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: '子任务一句话描述（用于进度展示）。' },
    prompt: { type: 'string', description: '交给子代理的完整任务说明（它没有当前对话上下文）。' },
  },
  required: ['prompt'],
};

const TODO_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: '完整任务清单（全量替换）。',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '任务描述。' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: '任务状态。' },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
};

const UNDO_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要撤销的文件；省略时撤销最近一次修改的文件。' },
  },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文本文件，返回带行号的内容。修改文件前务必先读取。',
      parameters: READ_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: '创建新文件或完全覆盖已有文件（自动创建父目录）。',
      parameters: WRITE_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: '对文件做精确文本替换。old_string 必须与文件内容完全一致；匹配多处时需 replace_all=true 或提供更精确上下文。',
      parameters: EDIT_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: '列出目录内容，目录以 / 结尾。',
      parameters: LS_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按通配符模式查找文件路径（支持 * 与 **）。',
      parameters: GLOB_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '在文件内容中按正则表达式搜索，返回「文件:行号: 内容」。',
      parameters: GREP_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令并返回输出（stdout/stderr/退出码）。需要用户授权。',
      parameters: BASH_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description: '加载指定技能的 SKILL.md 全文；省略 name 时列出可用技能。任务与技能匹配时应先加载。',
      parameters: SKILL_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description: '把独立子任务委托给一个全新上下文的子代理，返回其汇报。适合搜索调研、独立实现、复核验证等可并行的工作。',
      parameters: TASK_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description: '维护任务清单（全量替换）。多步骤任务开始前建立清单，完成一项更新一项。',
      parameters: TODO_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo',
      description: '撤销 write/edit 造成的最近一次文件修改；指定 path 则撤销该文件。',
      parameters: UNDO_SCHEMA,
    },
  },
];

export function toolSchemas() {
  return TOOLS;
}

function runSkill(args, ctx) {
  const name = String(args.name ?? '').trim();
  const skills = listSkills(ctx.workingDir);
  const label = (s) => `${s.name}${s.source === 'user' ? '（用户级）' : s.source === 'builtin' ? '（内置）' : ''}`;
  if (!name) {
    return {
      ok: true,
      output: skills.length
        ? skills.map((s) => `- ${label(s)}：${s.description || '（无描述）'}`).join('\n')
        : '（未安装任何技能。目录：~/.mingdao/skills/、<项目>/.mingdao/skills/）',
    };
  }
  const s = loadSkill(ctx.workingDir, name);
  if (!s) {
    return { ok: false, error: `未找到技能 "${name}"。可用：${skills.map((x) => x.name).join(', ') || '（无）'}` };
  }
  return { ok: true, output: `技能 ${name}${s.source === 'builtin' ? '（内置）' : ''}（${s.path}）：\n\n${s.content}` };
}

async function runTask(args, ctx) {
  const prompt = String(args.prompt ?? '');
  const description = String(args.description ?? '');
  if (!prompt) return { ok: false, error: '缺少 prompt 参数。' };
  if (typeof ctx.spawnTask !== 'function') return { ok: false, error: '当前环境不支持子代理。' };
  try {
    const out = await ctx.spawnTask(prompt, { description });
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, error: `子任务失败：${err?.message || err}` };
  }
}

function runTodo(args, ctx) {
  const list = Array.isArray(args.todos) ? args.todos : [];
  if (Array.isArray(ctx.todos)) {
    ctx.todos.splice(0, ctx.todos.length, ...list);
  }
  return {
    ok: true,
    output:
      `任务清单已更新（${list.length} 项）：\n` +
      list.map((t) => `- [${t.status || 'pending'}] ${t.content}`).join('\n'),
    todos: list,
  };
}

export async function dispatch(name, args, ctx) {
  switch (name) {
    case 'read':
      return read(args, ctx);
    case 'write':
      return write(args, ctx);
    case 'edit':
      return edit(args, ctx);
    case 'ls':
      return ls(args, ctx);
    case 'glob':
      return glob(args, ctx);
    case 'grep':
      return grep(args, ctx);
    case 'bash':
      return runBash(args, ctx);
    case 'skill':
      return runSkill(args, ctx);
    case 'task':
      return runTask(args, ctx);
    case 'todo':
      return runTodo(args, ctx);
    case 'undo':
      return undo(args, ctx);
    default:
      return { ok: false, error: `未知工具：${name}` };
  }
}
