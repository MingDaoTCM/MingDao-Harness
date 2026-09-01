// TUI 输入输出层（产品级）：
//  - 流式 Markdown 渲染：标题/列表/引用/行内样式
//  - 代码块轻量语法高亮（零依赖，覆盖 js/ts/py/sh/json 等）
//  - 工具执行可视化：写入预览、编辑 diff、bash 退出码徽章
//  - 思考过程 dim 流、生成中 spinner、Ctrl+C 中断、/命令 Tab 补全、历史记录
//  - 会话横幅（box）、token/耗时/费用估算状态行
// 核心引擎不依赖本模块以外的 UI 细节，未来 WebUI 只需实现同样的 io 接口。

import readline from 'node:readline';
import { MODELS } from './models.js';
import { estimateCostLabel } from './pricing.js';

export const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const stdoutTTY = () => Boolean(process.stdout.isTTY);

/**
 * @param {any} text
 * @param {any} code
 */
export function style(text, code) {
  if (!stdoutTTY()) {
    // 非 TTY（管道/重定向）：剥离所有内嵌 ANSI 码，保证输出干净可解析
    return String(text).replace(/\x1b\[[0-9;]*m/g, '');
  }
  return `${code}${text}${C.reset}`;
}

// ---------- 终端显示宽度（CJK 占 2 列） ----------
/** @param {any} s */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = /** @type {any} */ (ch.codePointAt(0));
    const wide =
      c >= 0x1100 &&
      (c <= 0x115f ||
        c === 0x2329 ||
        c === 0x232a ||
        (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
        (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) ||
        (c >= 0xfe10 && c <= 0xfe19) ||
        (c >= 0xfe30 && c <= 0xfe6f) ||
        (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6) ||
        (c >= 0x20000 && c <= 0x3fffd));
    w += wide ? 2 : 1;
  }
  return w;
}

/**
 * @param {any} s
 * @param {any} w
 */
function padTo(s, w) {
  return String(s) + ' '.repeat(Math.max(0, w - displayWidth(s)));
}

/**
 * @param {any} s
 * @param {any} prefix
 */
function indent(s, prefix) {
  return String(s)
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

// ---------- 轻量代码高亮 ----------
const HASH_LANGS = new Set(['py', 'python', 'sh', 'bash', 'yaml', 'yml', 'toml', 'markdown', 'md']);
/** @type {Record<string, string[]>} */
const LANG_KEYWORDS = {
  js: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'import', 'from', 'export', 'default', 'class', 'extends', 'new', 'await', 'async', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'null', 'undefined', 'true', 'false', 'this', 'super', 'switch', 'case', 'break', 'continue', 'do', 'of', 'in', 'static', 'get', 'set', 'delete', 'void', 'yield'],
  ts: ['interface', 'type', 'enum', 'implements', 'readonly', 'private', 'public', 'protected', 'namespace', 'declare', 'as', 'any', 'unknown', 'never', 'string', 'number', 'boolean'],
  py: ['def', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'class', 'try', 'except', 'finally', 'raise', 'with', 'as', 'lambda', 'None', 'True', 'False', 'async', 'await', 'yield', 'pass', 'break', 'continue', 'global', 'nonlocal', 'assert', 'del', 'in', 'is', 'not', 'and', 'or', 'self'],
  sh: ['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'echo', 'export', 'function', 'case', 'esac', 'local', 'set', 'unset', 'exit', 'return', 'source', 'read', 'shift', 'in'],
  bash: ['if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'echo', 'export', 'function', 'case', 'esac', 'local', 'set', 'unset', 'exit', 'return', 'source', 'read', 'shift', 'in'],
  go: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'select', 'switch', 'case', 'break', 'continue', 'nil', 'true', 'false', 'error'],
  rust: ['fn', 'let', 'mut', 'pub', 'use', 'mod', 'impl', 'struct', 'enum', 'trait', 'match', 'if', 'else', 'for', 'while', 'loop', 'return', 'async', 'await', 'crate', 'self', 'super', 'where', 'move', 'ref', 'Some', 'None', 'Ok', 'Err', 'true', 'false'],
  java: ['public', 'private', 'protected', 'class', 'interface', 'extends', 'implements', 'static', 'final', 'void', 'int', 'long', 'String', 'new', 'return', 'if', 'else', 'for', 'while', 'try', 'catch', 'throw', 'throws', 'import', 'package', 'this', 'super', 'null', 'true', 'false'],
  json: [],
  yaml: [],
};

/**
 * @param {any} code
 * @param {any} lang
 */
export function highlightCode(code, lang = '') {
  if (!stdoutTTY()) return code;
  const kws = new Set([...(LANG_KEYWORDS[lang] || []), ...(LANG_KEYWORDS[lang.replace(/-.*/, '')] || [])]);
  const useHash = HASH_LANGS.has(lang);
  const parts = [
    '\\/\\/[^\\n]*',
    '\\/\\*[\\s\\S]*?\\*\\/',
    useHash ? '#[^\\n]*' : null,
    '"(?:\\\\.|[^"\\\\])*"',
    "'(?:\\\\.|[^'\\\\])*'",
    '`(?:\\\\.|[^`\\\\])*`',
    '\\b\\d[\\d._]*\\b',
    '[A-Za-z_$][\\w$]*',
  ].filter(Boolean);
  const re = new RegExp(parts.join('|'), 'g');
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code))) {
    out += code.slice(last, m.index);
    const tok = m[0];
    if (tok.startsWith('//') || tok.startsWith('/*') || tok.startsWith('#')) out += style(tok, C.gray);
    else if (/^["'`]/.test(tok)) out += style(tok, C.green);
    else if (/^\d/.test(tok)) out += style(tok, C.yellow);
    else if (kws.has(tok)) out += style(tok, C.blue + C.bold);
    else if (code[m.index + tok.length] === '(') out += style(tok, C.cyan);
    else out += tok;
    last = m.index + tok.length;
  }
  out += code.slice(last);
  return out;
}

// ---------- Markdown 行内样式 ----------
/** @param {any} s */
function inline(s) {
  const parts = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    parts.push(s.slice(last, m.index));
    const tok = m[1];
    if (tok.startsWith('`')) parts.push(style(tok.slice(1, -1), C.yellow));
    else if (tok.startsWith('**')) parts.push(style(tok.slice(2, -2), C.bold));
    else parts.push(style(tok.slice(1, -1), C.italic));
    last = m.index + tok.length;
  }
  parts.push(s.slice(last));
  return parts.join('');
}

/** @param {any} line */
function renderInline(line) {
  const trimmed = line.trim();
  if (/^#{1,6}\s/.test(trimmed)) return style(inline(line), C.bold + C.cyan);
  if (/^\s*[-*+]\s/.test(line)) return '  ' + style(inline(line), C.dim);
  if (/^\s*\d+[.)]\s/.test(line)) return '  ' + style(inline(line), C.dim);
  if (/^>\s?/.test(line)) return '  ' + style(inline(line), C.gray);
  if (/^-{3,}$/.test(trimmed) || /^={3,}$/.test(trimmed)) return style(line, C.dim);
  return inline(line);
}

// ---------- 流式渲染器 ----------
/** @param {any} io */
function createStreamRenderer(io) {
  let buf = '';
  let inCode = false;
  let lang = '';
  /** @type {any[]} */
  let codeLines = [];
  let streamed = false;

  /** @param {any} line */
  function renderLine(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        io.printCodeBlock(codeLines.join('\n'), lang);
        codeLines = [];
        inCode = false;
        lang = '';
      } else {
        lang = trimmed.slice(3).trim().split(/\s+/)[0] || 'text';
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeLines.push(line);
      return;
    }
    io.print(renderInline(line));
  }

  return {
    /** @param {any} text */
    push(text) {
      streamed = true;
      buf += String(text);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        renderLine(line);
      }
    },
    end() {
      if (buf) {
        renderLine(buf);
        buf = '';
      }
      if (inCode) {
        io.printCodeBlock(codeLines.join('\n'), lang);
        codeLines = [];
        inCode = false;
      }
    },
    get streamed() {
      return streamed;
    },
  };
}

// ---------- 行级 diff（编辑预览用，仅小区域） ----------
/**
 * @param {any} a
 * @param {any} b
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(['-', a[i]]);
      i++;
    } else {
      out.push(['+', b[j]]);
      j++;
    }
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMMANDS = [
  '/help',
  '/clear',
  '/model',
  '/mode',
  '/compact',
  '/plan',
  '/init',
  '/memory',
  '/skills',
  '/sessions',
  '/usage',
  '/status',
  '/cost',
  '/verbose',
  '/save',
  '/exit',
  '/quit',
];

/** @param {any} line */
function completeLine(line) {
  if (line.startsWith('/model ') && line.length >= 7) {
    const pre = line.slice(7);
    return [Object.keys(MODELS).filter((m) => m.startsWith(pre)), line];
  }
  return [COMMANDS.filter((c) => c.startsWith(line)), line];
}

/**
 * @param {any} name
 * @param {any} args
 */
function summarizeArgs(name, args) {
  try {
    if (name === 'bash') return ` ${args.command ?? ''}`;
    if (args.path) return ` ${args.path}`;
    if (args.pattern) return ` ${args.pattern}`;
    return '';
  } catch {
    return '';
  }
}

// ---------- io 工厂 ----------
export function createIO({ quiet = false } = {}) {
  /** @type {any} */
  let rl = null;
  /** @type {any} */
  let spinnerTimer = null;
  /** @type {any} */
  let renderer = null;
  /** @type {any[]} */
  let askQueue = []; // 非 TTY：挂起的输入请求
  /** @type {any[]} */
  let lineQueue = []; // 非 TTY：已缓冲但未被消费的行
  /** @type {any} */
  let sigintHandler = null; // TTY 下 rl 'SIGINT' 事件转发目标
  /** @type {any} */
  let ttyPending = null;
  let closed = false;

  const EOF_ERROR = new Error('输入流已结束（stdin 关闭），无法继续交互。请使用 TTY 运行，或使用单次提问模式：mingdao "问题"。');

  const io = {
    _reasoningStarted: false,
    _answerStarted: false,
    isTTY: Boolean(process.stdin.isTTY),
    showReasoning: true,

    /** @param {any} v */
    setShowReasoning(v) {
      io.showReasoning = !!v;
    },

    ensureRl() {
      if (rl && rl.closed) throw EOF_ERROR;
      if (!rl) {
        const terminal = Boolean(process.stdin.isTTY);
        rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal,
          historySize: 200,
          completer: (/** @type {any} */ line) => completeLine(line),
        });
        if (terminal) {
          // 关键：TTY 下 Ctrl+C 由 readline 捕获（raw 模式），需要在这里转发给中断处理器；
          // 注册该监听会抑制 readline 默认的 close 行为，无处理器时显式 close
          rl.on('SIGINT', () => {
            if (sigintHandler) {
              try {
                sigintHandler();
              } catch {}
            } else {
              rl.close();
            }
          });
        }
        if (!terminal) {
          // 非 TTY（管道输入）：持久 line 监听 + 队列，避免 rl.question 丢弃首行之后的输入
          rl.on('line', (/** @type {any} */ line) => {
            const trimmed = line.trim();
            const pending = askQueue.shift();
            if (pending) pending.resolve(trimmed);
            else lineQueue.push(trimmed);
          });
        }
        rl.on('close', () => {
          closed = true;
          while (askQueue.length) {
            const p = askQueue.shift();
            p.reject(EOF_ERROR);
          }
          if (ttyPending) {
            ttyPending.restore?.();
            ttyPending.resolve('');
            ttyPending = null;
          }
        });
      }
      return rl;
    },

    /** @param {any} lines */
    setHistory(lines) {
      try {
        const r = io.ensureRl();
        for (const l of lines.slice(-50)) {
          if (l && !r.history.includes(l)) r.history.push(l);
        }
      } catch {}
    },

    print(text = '') {
      if (!quiet) console.log(text);
    },

    /**
     * @param {any} title
     * @param {any} lines
     */
    box(title, lines) {
      if (quiet) return;
      if (!stdoutTTY()) {
        io.print(title);
        for (const l of lines) io.print(l);
        return;
      }
      const inner = Math.max(...lines.map(displayWidth), displayWidth(title)) + 4;
      const topTitle = ` ${title} `;
      const rest = inner - displayWidth(topTitle);
      io.print(style('╭─', C.cyan) + topTitle + style('─'.repeat(rest) + '╮', C.cyan));
      for (const l of lines) {
        io.print(style('│ ', C.cyan) + padTo(l, inner) + style(' │', C.cyan));
      }
      io.print(style('╰', C.cyan) + style('─'.repeat(inner) + '╯', C.cyan));
    },

    // —— 一轮生成的生命周期 ——
    beginTurn() {
      io._reasoningStarted = false;
      io._answerStarted = false;
      renderer = createStreamRenderer(io);
    },

    endTurn() {
      if (renderer) {
        renderer.end();
        renderer = null;
      }
      io.stopSpinner();
    },

    /** @param {any} label */
    startSpinner(label) {
      if (quiet || !stdoutTTY()) return;
      io.stopSpinner();
      let i = 0;
      process.stdout.write(style(SPINNER_FRAMES[0] + ` ${label} `, C.dim));
      spinnerTimer = setInterval(() => {
        i = (i + 1) % SPINNER_FRAMES.length;
        process.stdout.write('\r' + style(SPINNER_FRAMES[i] + ` ${label} `, C.dim));
      }, 80);
    },

    stopSpinner() {
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
        process.stdout.write('\r\x1b[K');
      }
    },

    /** @param {any} text */
    writeText(text) {
      if (quiet) return;
      if (io._reasoningStarted && !io._answerStarted && stdoutTTY()) {
        io._answerStarted = true;
        io.print(style('─'.repeat(20) + ' 回答 ' + '─'.repeat(20), C.dim));
      }
      renderer?.push(String(text));
    },

    /** @param {any} text */
    writeReasoning(text) {
      if (quiet || !io.showReasoning) return;
      if (!io._reasoningStarted) {
        io._reasoningStarted = true;
        io.print(style('┄ 思考过程', C.dim));
      }
      process.stdout.write(style(String(text), C.dim));
    },

    /** @param {any} todos */
    renderTodo(todos) {
      if (quiet || !todos?.length) return;
      io.print(style('  ☑ 任务清单', C.bold));
      for (const t of todos) {
        const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
        const color = t.status === 'completed' ? C.dim : t.status === 'in_progress' ? C.cyan : C.gray;
        io.print(style(`    ${mark} ${t.content}`, color));
      }
    },

    /**
     * @param {any} code
     * @param {any} lang
     */
    printCodeBlock(code, lang) {
      if (quiet) return;
      const label = lang || 'code';
      const prefix = stdoutTTY() ? ' │ ' : '';
      if (stdoutTTY()) io.print(style(`┌─ ${label} `, C.gray));
      io.print(prefix + highlightCode(code, lang));
      if (stdoutTTY()) io.print(style('└─', C.gray));
    },

    // —— 工具执行可视化 ——
    /**
     * @param {any} name
     * @param {any} args
     * @param {any} result
     * @param {any} durationMs
     */
    renderTool(name, args, result, durationMs) {
      if (quiet) return;
      const r = result && typeof result === 'object' ? result : { ok: false, error: String(result ?? '') };
      const ms = durationMs != null ? ` · ${durationMs}ms` : '';

      if (name === 'write' && r.ok) {
        io.print(style(`  ✎ 写入 ${args.path}`, C.bold));
        const lines = String(args.content ?? '').split('\n');
        const preview = lines.slice(0, 8).join('\n');
        if (preview) io.print(style(indent(preview, '    │ '), C.dim));
        if (lines.length > 8) io.print(style(`    │ …（共 ${lines.length} 行）`, C.dim));
        io.print(style(`  ✓ ${r.output}${ms}`, C.green));
        return;
      }

      if (name === 'edit' && r.ok) {
        io.print(style(`  ✎ 编辑 ${args.path}`, C.bold));
        if (r.diff) {
          const before = r.diff.before.split('\n');
          const after = r.diff.after.split('\n');
          if (before.length + after.length <= 60) {
            for (const [kind, line] of diffLines(before, after)) {
              const color = kind === '-' ? C.red : kind === '+' ? C.green : C.dim;
              io.print(style(`    ${kind} ${line}`, color));
            }
          } else {
            io.print(style('    …（变更区域较大，省略 diff 预览）', C.dim));
          }
        }
        io.print(style(`  ✓ ${r.output}${ms}`, C.green));
        return;
      }

      if (name === 'bash' && r.ok) {
        io.print(style(`  ⚙ ${args.command ?? ''}`, C.bold));
        const badge = r.timedOut ? '⏱ 超时' : `exit ${r.exitCode}`;
        io.print(style(`    ${badge}${ms}`, r.exitCode === 0 ? C.green : C.red));
        const out = String(r.stdout ?? '').trim();
        if (out) {
          const lines = out.split('\n');
          io.print(style(indent(lines.slice(0, 10).join('\n'), '    '), C.dim));
          if (lines.length > 10) io.print(style(`    …（共 ${lines.length} 行输出）`, C.dim));
        }
        const errT = String(r.stderr ?? '').trim();
        if (errT) io.print(style(indent(errT.split('\n').slice(-4).join('\n'), '    '), C.red));
        return;
      }

      if (!r.ok) {
        io.print(style(`  ✖ ${name}${summarizeArgs(name, args)}：${r.error}${ms}`, C.red));
        return;
      }

      if (name === 'ls') {
        // 目录列表只给一行摘要 + 前几项，不整屏刷文件
        const lines = String(r.output ?? '').split('\n').filter(Boolean);
        io.print(style(`  📁 列出 ${lines.length} 项` + (lines.length ? '：' + lines.slice(0, 3).map((x) => x.trim()).join('、') + (lines.length > 3 ? ' 等' : '') : '') + ms, C.bold));
        return;
      }

      if (name === 'skill') {
        // 技能全文只供模型使用，终端只给一行摘要
        const out = String(r.output ?? '');
        const desc = (out.match(/^description:\s*(.+)$/m) || [])[1] || '';
        io.print(style(`  🧩 已加载技能 ${args.name}${desc ? '：' + desc.slice(0, 60) : ''}（${out.length} 字）${ms}`, C.bold));
        return;
      }

      // 只读工具：read / ls / glob / grep
      io.print(style(`  🔍 ${name}${summarizeArgs(name, args)}`, C.bold));
      const out = String(r.output ?? '');
      if (out) {
        const lines = out.split('\n');
        io.print(style(indent(lines.slice(0, 8).join('\n'), '    '), C.dim));
        if (lines.length > 8) io.print(style(`    …（共 ${lines.length} 行）`, C.dim));
      }
      io.print(style(`  ✓ 输出 ${out.length} 字符${ms}`, C.green));
    },

    /**
     * @param {any} name
     * @param {any} args
     * @param {any} reason
     */
    renderToolDenied(name, args, reason) {
      if (quiet) return;
      const label = reason === '未授权' || !reason ? '未授权，已跳过' : reason;
      io.print(style(`  ✖ ${label}：${name}${summarizeArgs(name, args)}`, C.yellow));
    },

    // —— 用量与费用状态行 ——
    /** @param {{ modelName: any, usage: any, durationMs: any }} param0 */
    printUsageLine({ modelName, usage, durationMs }) {
      if (quiet) return;
      const p = usage?.prompt_tokens ?? 0;
      const c = usage?.completion_tokens ?? 0;
      const fmt = (/** @type {any} */ n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
      const secs = ((durationMs ?? 0) / 1000).toFixed(1) + 's';
      const costPart = estimateCostLabel(modelName, p, c, usage);
      io.print(
        style(
          `[${C.bold}${modelName}${C.reset} · ${fmt(p)}↑/${fmt(c)}↓ tokens · ${secs}${costPart}]`,
          C.dim
        )
      );
    },

    // —— SIGINT（Ctrl+C 中断生成，不退出程序） ——
    // TTY 下 readline raw 模式会把 Ctrl+C 转成 rl 的 'SIGINT' 事件（ensureRl 转发到 sigintHandler），
    // 非 TTY/其他来源走 process 级 SIGINT；两层都注册，保证任何路径都能中断
    /** @param {any} fn */
    onSigint(fn) {
      const h = () => {
        try {
          fn();
        } catch {}
      };
      sigintHandler = h;
      process.on('SIGINT', h);
      return () => {
        sigintHandler = null;
        process.removeListener('SIGINT', h);
      };
    },

    /**
     * @param {any} question
     * @param {any} opts
     */
    ask(question, opts = {}) {
      if (!process.stdin.isTTY) {
        // 非 TTY：优先消费已缓冲的行（接口关闭后仍可能有剩余行），不打印提示符
        if (lineQueue.length) return Promise.resolve(lineQueue.shift());
        if (closed) return Promise.reject(EOF_ERROR);
        let r;
        try {
          r = io.ensureRl();
        } catch (e) {
          return Promise.reject(e); // 确保 ask 永远以 rejection 报告，不向调用方同步抛错
        }
        if (r.closed) return Promise.reject(EOF_ERROR);
        return new Promise((resolve, reject) => {
          askQueue.push({ resolve, reject });
        });
      }
      const r = io.ensureRl();
      // TTY：rl.question 保留行编辑 / 补全 / 历史 / 隐藏输入
      return new Promise((resolve) => {
        const orig = r._writeToOutput;
        const restore = () => {
          if (typeof orig === 'function') r._writeToOutput = orig;
        };
        if (opts.hidden && typeof r._writeToOutput === 'function') {
          r._writeToOutput = () => {};
        }
        const entry = { resolve, restore };
        ttyPending = entry;
        r.question(question, (/** @type {any} */ answer) => {
          restore();
          if (ttyPending === entry) ttyPending = null;
          resolve(answer.trim());
        });
      });
    },

    // 行尾反斜杠续行，支持多行输入
    /** @param {any} prompt */
    async askMultiline(prompt, continuation = '…> ') {
      const lines = [];
      for (;;) {
        const line = await io.ask(prompt);
        if (line.endsWith('\\')) {
          lines.push(line.slice(0, -1));
          prompt = continuation;
          continue;
        }
        lines.push(line);
        return lines.join('\n');
      }
    },

    /** @param {any} question */
    async confirm(question) {
      const a = await io.ask(question + ' ');
      return /^y(es)?$/i.test(a);
    },

    /**
     * @param {any} label
     * @param {any} options
     */
    async choose(label, options) {
      io.print(style(label, C.bold));
      options.forEach((/** @type {any} */ o, /** @type {any} */ i) => io.print(`  ${style(String(i + 1), C.cyan)}. ${o.label}`));
      for (;;) {
        const ans = await io.ask('请输入序号：');
        const n = Number(ans);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
        io.print(style('输入无效，请重新输入。', C.yellow));
      }
    },

    close() {
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };

  return io;
}
