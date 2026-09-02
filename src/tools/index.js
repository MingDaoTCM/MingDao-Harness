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
    path: { type: 'string', description: '文件路径（相对或绝对）。' },
    offset: { type: 'integer', description: '起始行号，默认 1。' },
    limit: { type: 'integer', description: '最大行数，默认 400。' },
  },
  required: ['path'],
};

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径。' },
    content: { type: 'string', description: '完整文件内容（UTF-8）。' },
  },
  required: ['path', 'content'],
};

const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '文件路径。' },
    old_string: { type: 'string', description: '原文片段，必须逐字一致。' },
    new_string: { type: 'string', description: '替换后文本。' },
    replace_all: { type: 'boolean', description: '替换所有匹配，默认 false。' },
  },
  required: ['path', 'old_string', 'new_string'],
};

const LS_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '目录路径，默认当前目录。' },
  },
};

const GLOB_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '通配符模式，如 src/**/*.js。' },
    path: { type: 'string', description: '搜索根目录。' },
  },
  required: ['pattern'],
};

const GREP_SCHEMA = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '正则表达式。' },
    path: { type: 'string', description: '搜索根目录。' },
    include: { type: 'string', description: '文件名过滤，如 *.js。' },
  },
  required: ['pattern'],
};

const BASH_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'shell 命令。执行前需用户授权。' },
    timeout: { type: 'integer', description: '超时秒数，默认 120。' },
  },
  required: ['command'],
};

const SKILL_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '技能名；省略则列出全部。' },
  },
};

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string', description: '子任务一句话描述（用于进度展示）。' },
    prompt: { type: 'string', description: '子代理的完整任务说明（全新上下文，需自带全部必要背景）。' },
    readOnly: { type: 'boolean', description: '只读调研任务（不写文件不执行命令）。多个 readOnly 子任务同一轮派发会并行执行，效率最高。' },
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
    path: { type: 'string', description: '要撤销的文件；省略撤销最近一次。' },
  },
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读取文件内容（带行号）。修改文件前必须先读。',
      parameters: READ_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: '创建新文件或整体覆盖（自动建父目录）。',
      parameters: WRITE_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit',
      description: '精确文本替换：old_string 必须逐字匹配原文；多处匹配需 replace_all=true。',
      parameters: EDIT_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'ls',
      description: '列出目录内容（目录以 / 结尾）。',
      parameters: LS_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: '按通配符查找文件路径（支持 * 与 **）。',
      parameters: GLOB_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep',
      description: '正则搜索文件内容，返回「文件:行号: 内容」。',
      parameters: GREP_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令，返回输出与退出码。需用户授权。',
      parameters: BASH_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'skill',
      description: '加载技能 SKILL.md 全文；省略 name 则列出可用技能。',
      parameters: SKILL_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'task',
      description: '把独立、可并行的子任务委托给全新上下文子代理并返回汇报。适合：多方向调研/复核/独立实现等互不依赖的任务（多个只读调研子任务应同一轮一起派发，自动并行，效率最高）；不适合：依赖当前对话细节的小改动。',
      parameters: TASK_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description: '维护任务清单（全量替换）。多步任务先建清单再逐项更新。',
      parameters: TODO_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'undo',
      description: '撤销最近一次 write/edit 修改；指定 path 撤销该文件。',
      parameters: UNDO_SCHEMA,
    },
  },
];

export function toolSchemas() {
  return TOOLS;
}

/**
 * 递归去除对象中的全部 description 键（保留类型/required/enum 等结构性字段）。
 * @param {any} obj
 * @returns {any}
 */
function stripDescriptions(obj) {
  if (Array.isArray(obj)) return obj.map(stripDescriptions);
  if (obj && typeof obj === 'object') {
    const out = /** @type {Record<string, any>} */ ({});
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'description') continue;
      out[k] = stripDescriptions(v);
    }
    return out;
  }
  return obj;
}

/**
 * 按需构建工具 Schema（省钱 B1）：本会话已调用过的工具省略全部描述（工具级 + 参数级，
 * 模型已在消息历史里见过其用途，保留 name/parameters 结构与类型即可），未用过的保留完整描述。
 * 返回浅拷贝新数组，不修改原 TOOLS；extra（如 MCP 工具）按同一规则处理。
 * @param {Set<string>} usedNames 已调用工具名（内置名或 MCP 前缀名）
 * @param {Array<object>} [extra] 附加工具 Schema（MCP 等）
 * @returns {Array<any>}
 */
export function buildToolSchemas(usedNames, extra = []) {
  const strip = (/** @type {any[]} */ arr) =>
    arr.map((/** @type {any} */ t) => {
      const name = t?.function?.name;
      if (name && usedNames.has(name)) {
        return {
          ...t,
          function: { ...t.function, description: '', parameters: stripDescriptions(t.function?.parameters) },
        };
      }
      return t;
    });
  return [...strip(TOOLS), ...strip(extra)];
}

function runSkill(/** @type {any} */ args, /** @type {any} */ ctx) {
  const name = String(args.name ?? '').trim();
  const skills = listSkills(ctx.workingDir);
  const label = (/** @type {any} */ s) => `${s.name}${s.source === 'user' ? '（用户级）' : s.source === 'builtin' ? '（内置）' : ''}`;
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

async function runTask(/** @type {any} */ args, /** @type {any} */ ctx) {
  const prompt = String(args.prompt ?? '');
  const description = String(args.description ?? '');
  if (!prompt) return { ok: false, error: '缺少 prompt 参数。' };
  if (typeof ctx.spawnTask !== 'function') return { ok: false, error: '当前环境不支持子代理。' };
  try {
    const out = await ctx.spawnTask(prompt, { description, readOnly: args.readOnly === true });
    return { ok: true, output: out };
  } catch (err) {
    return { ok: false, error: `子任务失败：${(/** @type {any} */ (err))?.message || err}` };
  }
}

function runTodo(/** @type {any} */ args, /** @type {any} */ ctx) {
  const list = Array.isArray(args.todos) ? args.todos : [];
  if (Array.isArray(ctx.todos)) {
    ctx.todos.splice(0, ctx.todos.length, ...list);
  }
  return {
    ok: true,
    output:
      `任务清单已更新（${list.length} 项）：\n` +
      list.map((/** @type {any} */ t) => `- [${t.status || 'pending'}] ${t.content}`).join('\n'),
    todos: list,
  };
}

export async function dispatch(/** @type {any} */ name, /** @type {any} */ args, /** @type {any} */ ctx) {
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
