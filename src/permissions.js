// 权限引擎（借鉴 codewhale 的 execpolicy 独立分层思想）。
//
// 三种模式：
//  - ask      默认。只读工具自动放行；写文件/执行命令逐次询问。
//  - auto     全部自动允许（完全自主，注意风险）。
//  - readonly 只允许只读工具。
// config.permission 也可以是对象：
//  { mode: 'ask', allow: ['bash', 'bash:git *'], deny: ['write'] }
//  规则支持「工具名」或「工具名:参数前缀」模式匹配（* 通配）。
// check(name, args, label)：label 用于区分执行方（如子代理的「（子任务）」前缀）。

import { style, C } from './ui.js';
import { READONLY_TOOLS } from './tools/index.js';

/** @param {any} name @param {any} args */
function summarize(name, args) {
  try {
    if (name === 'bash') return ` ${args.command ?? ''}`;
    // v0.6.30（C3）：出网确认必须让用户看见**目标 URL**——否则"是否允许 fetch"无从判断。
    // 截断到 200 字：URL 可能很长；判定与提示都不依赖完整串。
    if (name === 'fetch') return ` ${String(args.url ?? '').slice(0, 200)}`;
    if (args.path) return ` ${args.path}`;
    return '';
  } catch {
    return '';
  }
}

/**
 * 把 bash 命令行按 shell 分隔符拆段：`;` `&&` `||` `|` `&` 与换行。
 *
 * 只用于 **deny** 的加严匹配（allow 仍走前缀 + 字符白名单，防止 `git status && rm -rf /`
 * 借前缀提权）。不做完整 shell 解析——目标不是"理解命令"，而是"不漏掉任何一段可能是危险命令的片段"。
 * 引号内的分隔符会被一并拆开，可能带来极少量误拦（多问一次），但方向是 fail-closed，可接受。
 * @param {any} cmd
 */
export function splitShellSegments(/** @type {any} */ cmd) {
  return String(cmd ?? '')
    // v0.6.7（报告一 M-2 / 报告二 P3-6）：分隔面补全——此前只拆 `; && || | & 换行`，于是
    //   `echo $(rm -rf /x)`、`` echo `rm -rf /x` ``、`true \r rm -rf /x`、`a \\\n rm -rf /x`
    // 的**段首**都不是危险命令，deny 规则被直达绕过（deny 是 auto 档唯一防线）。
    // 现在把命令替换（`$(` / 反引号）、子 shell 括号、`\r`、行尾续行反斜杠一并当分隔符。
    // 方向是 fail-closed：多拆只会多匹配 deny 规则（最坏是多问一次确认），不会漏掉危险段。
    .split(/\s*(?:;|&&|\|\||\||&|\r|\n|\$\(|\(|\)|`|\\\r?\n)\s*/)
    .map((/** @type {string} */ seg) => seg.trim())
    .filter(Boolean);
}

// ── C1（v0.6.30 安全语义对齐 / 报告四 S1，报告三 H-12）：命令**归一化** ─────────────
//
// 缺陷：deny 只对「段的字面文本」做前缀比较，于是同一个可执行文件的另一种写法就直达执行：
// `/bin/rm`（绝对路径）、`env rm` / `sudo rm` / `xargs rm` / `command rm`（包装前缀）、
// `FOO=1 rm`（前缀赋值）、`\rm` / `r''m`（引号与转义）、`bash -lc 'rm'`（藏在 -c 参数里）。
// deny 在 auto 档是唯一防线，`denyStrict` 更被文档承诺为「硬拦截」——这些写法让承诺不成立。
//
// 修法（三步，全部 fail-closed）：
//   ① 拆段（既有 splitShellSegments）→ 每段**无依赖词法切分**（去引号 / 反斜杠转义）；
//   ② 取 argv[0] 的 **basename**（`/bin/rm` → `rm`），并**剥包装前缀**（env/sudo/xargs/… 及其选项），
//      遇到 `sh -c` / `bash -lc` / `eval` 时把参数里的真命令**递归**归一（深度上限 5）；
//   ③ 归一后的命令同时以「全名」与「basename」两种形态匹配 deny 规则，任一命中即拒。
// 无法归一的部分（管道/重定向/`$()`/`&&`）已经由拆段覆盖：拆开后逐段归一，任一段命中即拒。
//
// 明确的边界：`find / -delete`、脚本文件（`bash evil.sh`）、`$VAR` 展开、自定义包装器
// 仍然判不出来——它们在字符串层面**不可静态判定**。这里的承诺是「同一 argv 的常见书写
// 形态不漏」，不是「语义级沙箱」；需要硬边界请用 denyStrict + 沙箱（见 docs/CONFIG.md）。

/** shell 可执行名：`sh -c '<真命令>'` 一类写法要把参数里的命令再归一一次。 */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);

/**
 * 包装器前缀表：键是包装器的 basename。
 *  `shortValue`：需要**独立下一个参数**作值的短选项（`-u x`、`-n 5`）；
 *  `longValue`：需要独立下一个参数作值的长选项（`--user x`；`--user=x` 自带值，不消耗下一个）；
 *  `skipOperand`：剥完选项后再跳过一个操作数（`timeout 5 rm` 里的 `5`）。
 * 只列「会改变真命令位置」的选项；其余选项按无值选项跳过（保守：宁可少判一个参数，不能错位）。
 * @type {Record<string, { shortValue?: string[], longValue?: string[], skipOperand?: boolean }>}
 */
const WRAPPER_PREFIXES = {
  env: { shortValue: ['-u', '-C'], longValue: ['--unset', '--chdir'] },
  sudo: {
    shortValue: ['-u', '-g', '-p', '-C', '-T', '-r', '-t', '-U', '-h', '-D', '-R'],
    longValue: ['--user', '--group', '--prompt', '--chdir', '--close-from', '--role', '--type', '--other-user', '--host', '--chroot', '--command-timeout'],
  },
  doas: { shortValue: ['-u', '-C'], longValue: [] },
  command: {},
  builtin: {},
  exec: { shortValue: ['-a'], longValue: [] },
  nohup: {},
  time: { shortValue: ['-f', '-o'], longValue: ['--format', '--output'] },
  nice: { shortValue: ['-n'], longValue: ['--adjustment'] },
  ionice: { shortValue: ['-c', '-n', '-p', '-P', '-u'], longValue: [] },
  timeout: { shortValue: ['-s', '-k'], longValue: ['--signal', '--kill-after'], skipOperand: true },
  stdbuf: { shortValue: ['-i', '-o', '-e'], longValue: ['--input', '--output', '--error'] },
  setsid: {},
  xargs: {
    shortValue: ['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a', '-R', '-S'],
    longValue: ['--max-args', '--max-lines', '--max-procs', '--max-chars', '--delimiter', '--eof', '--arg-file', '--replace'],
  },
  watch: { shortValue: ['-n'], longValue: ['--interval'] },
  busybox: {},
};

/** 递归归一深度上限：超过就停（避免病态嵌套把这里变成 CPU 热点）。 */
const MAX_CANON_DEPTH = 5;

/**
 * 取可执行文件的 basename：`/bin/rm` → `rm`；`C:\\Windows\\System32\\RM.EXE` → `RM`。
 * 不做大小写归一（大小写在 deny 匹配时统一按忽略处理）。
 * @param {any} token
 */
export function basenameOfCommand(/** @type {any} */ token) {
  const s = String(token ?? '').trim();
  const parts = s.split(/[\\/]+/).filter(Boolean);
  const seg = parts.length ? parts[parts.length - 1] : s;
  return /\.exe$/i.test(seg) ? seg.slice(0, -4) : seg;
}

/**
 * 无依赖词法切分：去引号、处理反斜杠转义、保留引号拼接（`r''m` → `rm`）。
 * 不做变量展开、不做 glob——目标只是「把同一个 argv 的不同书写形态合成同一串词」。
 * @param {any} text
 * @returns {string[]}
 */
export function tokenizeCommandSegment(/** @type {any} */ text) {
  /** @type {string[]} */
  const out = [];
  const s = String(text ?? '');
  let cur = '';
  let started = false;
  /** @type {''|"'"|'"'} */
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = '';
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = '';
        continue;
      }
      if (ch === '\\' && i + 1 < s.length) {
        i += 1;
        cur += s[i];
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '\\') {
      started = true;
      if (i + 1 < s.length) {
        i += 1;
        cur += s[i];
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/**
 * 归一化一条 bash 命令行 → 若干「可能是真命令」的 argv。
 *
 * 返回的是**候选集合**（而不是唯一解）：包装器/`-c` 嵌套让「哪一段才是真命令」无法唯一确定。
 * deny 判定只要任一候选命中就拒（fail-closed），所以多给候选是安全的。
 * @param {any} cmd
 * @returns {{ argv: string[], text: string }[]}
 */
export function canonicalizeCommand(/** @type {any} */ cmd) {
  /** @type {{ argv: string[], text: string }[]} */
  const out = [];
  const seen = new Set();
  /** @param {string[]} argv */
  const add = (argv) => {
    if (!argv.length) return;
    const text = argv.join(' ');
    if (seen.has(text)) return;
    seen.add(text);
    out.push({ argv, text });
  };
  /**
   * @param {string[]} tokens
   * @param {number} depth
   */
  const visitTokens = (tokens, depth) => {
    if (depth > MAX_CANON_DEPTH) return;
    let toks = tokens.slice();
    // ① 前缀环境变量赋值：`FOO=1 rm -rf /` / `env A=1 rm`
    while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1);
    if (!toks.length) return;
    const base = basenameOfCommand(toks[0]);
    // ② shell 的 -c（含 -lc / -xc 等捆绑形态）与 eval：真命令在参数里，递归拆
    if (SHELL_NAMES.has(base)) {
      const ci = toks.findIndex((t, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
      if (ci > 0 && toks[ci + 1] !== undefined) {
        visitText(toks.slice(ci + 1).join(' '), depth + 1);
        return;
      }
      add(toks);
      return;
    }
    if (base === 'eval') {
      const rest = toks.slice(1).join(' ').trim();
      if (rest) visitText(rest, depth + 1);
      return;
    }
    // ③ 包装器前缀：跳过包装器自身的选项/赋值，再递归归一其后的真命令
    const spec = WRAPPER_PREFIXES[base];
    if (spec) {
      // `env -S 'rm -rf /'`：值本身就是一条命令串（GNU coreutils 的 split-string）
      if (base === 'env') {
        const si = toks.findIndex((t) => t === '-S' || t === '--split-string');
        if (si > 0 && toks[si + 1] !== undefined) {
          visitText(toks[si + 1], depth + 1);
          toks = [...toks.slice(0, si), ...toks.slice(si + 2)];
        }
      }
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') {
          i += 1;
          break;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          i += 1;
          continue;
        }
        if (t.startsWith('--')) {
          const name = t.split('=')[0];
          i += spec.longValue?.includes(name) && !t.includes('=') ? 2 : 1;
          continue;
        }
        if (t.startsWith('-') && t !== '-') {
          const chars = t.slice(1);
          let needsValue = false;
          for (let k = 0; k < chars.length; k++) {
            if (spec.shortValue?.includes('-' + chars[k])) {
              needsValue = k === chars.length - 1;
              break;
            }
          }
          i += needsValue ? 2 : 1;
          continue;
        }
        break; // 第一个非选项 = 真命令
      }
      if (spec.skipOperand && i < toks.length) i += 1;
      visitTokens(toks.slice(i), depth + 1);
      return;
    }
    add(toks);
  };
  /**
   * @param {string} text
   * @param {number} depth
   */
  const visitText = (text, depth) => {
    if (depth > MAX_CANON_DEPTH) return;
    for (const seg of splitShellSegments(text)) visitTokens(tokenizeCommandSegment(seg), depth);
  };
  visitText(String(cmd ?? ''), 0);
  return out;
}

/**
 * 归一后的候选是否命中 deny 规则的参数部分。
 *
 * 候选与规则都按**忽略大小写**比较（Windows 命令名不区分大小写；方向是 fail-closed——
 * deny 名单写 `rm` 时 `RM` 也必须被拦）。规则尾随 `*` 表示「前缀」：
 * `rm *` 同时覆盖 `rm`（无参数）与 `rm -rf /x`；`rm` 覆盖 `rm` 与 `rm -rf /x`（argv 前缀语义）。
 * @param {string} want deny 规则 `:` 之后的参数部分
 * @param {string} cand 归一后的命令文本
 */
function denyTextMatches(/** @type {any} */ want, /** @type {any} */ cand) {
  const w = String(want ?? '').trim().toLowerCase();
  const c = String(cand ?? '').trim().toLowerCase();
  if (!w || !c) return false;
  if (w.endsWith('*')) {
    const prefix = w.slice(0, -1);
    if (/\s$/.test(prefix)) {
      const bare = prefix.trimEnd();
      return c === bare || c.startsWith(prefix);
    }
    return c.startsWith(prefix);
  }
  return c === w || c.startsWith(w + ' ');
}

/**
 * 归一后的候选命令命中 deny 规则？（全名与 basename 两种形态都试）
 * @param {string} want
 * @param {{ argv: string[], text: string }} cand
 */
function denyCanonicalMatch(/** @type {any} */ want, /** @type {any} */ cand) {
  if (denyTextMatches(want, cand.text)) return true;
  const base = basenameOfCommand(cand.argv[0]);
  const rest = cand.argv.slice(1).join(' ');
  return denyTextMatches(want, rest ? `${base} ${rest}` : base);
}

/** @param {any} rule @param {any} name @param {any} args @param {boolean} [forDeny] */
function ruleMatches(rule, name, args, forDeny = false) {
  const idx = rule.indexOf(':');
  if (idx > 0) {
    const ruleName = rule.slice(0, idx);
    if (ruleName !== name) return false;
    const want = rule.slice(idx + 1).trim();
    const have = summarize(name, args).trim();
    // bash 前缀规则防链式命令绕过（P0 安全，v0.4.1）：白名单字符法——前缀规则仅匹配
    // 单条简单命令（字母数字/空格/下划线/./-/），任何 shell 元字符（&&/||/;|&<>`$()\n\r）都不匹配，
    // 回落权限确认。黑名单枚举永远追不上绕过手法（单 & 后台串联、重定向、\r 等），白名单才可靠。
    //
    // P1 修复（v0.4.6）：该白名单只适用于 **allow** 规则（目的正是防止 `git status && rm -rf /`
    // 借前缀匹配提权）。deny 是「硬拦截」，方向相反——失配 = 不拦 = fail-open：命令里只要出现
    // & ; | $ @ = ' " Tab 等元字符，deny 规则就失配并回落到 mode，而 auto 档下 deny 是唯一防线，
    // 等于形同不存在（实测 deny:['bash:rm *'] 拦得住 `rm -rf /x`，却放过 `cd /tmp && rm -rf /x`）。
    // 故 deny 一律按命令原文匹配，不设字符白名单。
    if (!forDeny && name === 'bash' && !/^[A-Za-z0-9_ ./\\:-]+$/.test(have)) return false;
    if (forDeny && name === 'bash') {
      // v0.6.2（自评报告 P2-2）：deny 必须**按 shell 分隔符拆段后逐段判**。
      // 原实现只拿整条命令的前缀去比：`deny:['bash:rm *']` 拦得住 `rm -rf /x`，
      // 却放过 `cd /tmp && rm -rf /x`（开头不是 rm）——而 auto 档下不会对每条命令发问，
      // deny 失配就等于这条规则**形同不存在**。v0.4.6 只修了元字符失配那一半，链式仍可绕过。
      //
      // v0.6.3：措辞订正。原注释写「auto 档下 deny 是唯一防线」，容易被读成"不可越过的硬拦截"，
      // 而 docs/CONFIG.md 明确记载「被 deny 拦截会弹窗询问、同意即放行」——**能越过**。
      // 要真正的硬拦截请显式开 `denyStrict: true`（见 normalizePermission 注释）。
      // 方向是 fail-closed：宁可多拦（多问一次），不可漏拦。
      const segs = splitShellSegments(have);
      const literalHit = segs.some((seg) => (want.endsWith('*') ? seg.startsWith(want.slice(0, -1)) : seg === want));
      if (literalHit) return true;
      // v0.6.30（C1）：字面匹配之后**必须**再跑一遍归一化匹配——
      // 绝对路径 / 包装前缀 / 前缀赋值 / 引号转义 / `sh -c` 的绕过都在这一步被堵住。
      // 两者是 OR：字面规则保持向后兼容，归一规则只加严（fail-closed）。
      return canonicalizeCommand(args?.command).some((cand) => denyCanonicalMatch(want, cand));
    }
    if (want.endsWith('*')) return have.startsWith(want.slice(0, -1));
    return have === want;
  }
  return rule === name;
}

/**
 * 归一化权限配置（v0.6.0 C2：从 check() 中抽出，供**纯函数**判定复用）。
 * @param {any} rawMode
 * @returns {{mode: string, allow: any[], deny: any[], denyStrict: boolean}}
 */
export function normalizePermission(/** @type {any} */ rawMode) {
  let mode = 'ask';
  let allow = [];
  let deny = [];
  // v0.6.3（审计 H-11）：`denyStrict` = 把 deny 升级为**不可临时放行**的硬拦截。
  // 默认 false 保持既有行为（docs/CONFIG.md 明确记载「被 deny 拦截会弹窗询问，同意即放行」，
  // 那是 v0.4.6 有意加的"不再静默拦截"）；需要硬拦截的场景（无人值守/强合规）显式打开。
  let denyStrict = false;
  if (typeof rawMode === 'string') {
    mode = rawMode;
  } else if (rawMode && typeof rawMode === 'object') {
    mode = rawMode.mode ?? 'ask';
    allow = rawMode.allow ?? [];
    deny = rawMode.deny ?? [];
    denyStrict = rawMode.denyStrict === true;
  }
  if (!['ask', 'auto', 'readonly'].includes(mode)) mode = 'ask';
  return { mode, allow, deny, denyStrict };
}

/**
 * **不产生任何副作用**的权限判定（v0.6.0 C2）。
 *
 * 为什么必须抽出来：账本回放要在**离线、无人值守**的前提下回答「这条调用今天会不会被拒」，
 * 而 `check()` 在 deny/写操作档位上会弹交互询问。若回放自己复制一份规则匹配逻辑，
 * 两处长到不一致只是时间问题——本项目已经因为「同一规则两份实现」栽过（T20 的 PID 归属校验）。
 * 因此判定只此一份：`check()` 调它拿到决定，再决定要不要问用户。
 *
 * 语义与 `check()` 完全一致：deny → allow → auto 全放 → 只读工具放行 →
 * 只读档的写操作要问 / ask 档要问。区别只在于把「要问」如实报成 `ask`，而不是替用户回答。
 * @param {any} rawMode
 * @param {any} name
 * @param {any} args
 * @returns {{decision: 'allow'|'deny'|'ask', reason: string, rule: string|null, denyStrict?: boolean}}
 */
// v0.6.7（报告二 P3-6，报告一 M-2 的另一半）：**denyStrict 下包装执行形态 fail-closed**。
//
// 拆段（splitShellSegments）已经补上命令替换与子 shell 括号，但 `sh -c '…'`、`eval '…'`、
// `bash -c "…"` 这类**把真命令藏在参数里**的写法无法靠拆段看穿：段首是 `sh`/`eval`，
// 不匹配任何以真实命令开头的 deny 规则。普通 deny 档可以接受这一点（它是"防手滑"，
// 被绕过还有权限模式兜底）；但 `denyStrict: true` 是用户显式要求的**硬拦截**，
// 语义上不该存在"换个写法就直达"的通道 —— 于是这里对包装形态直接拒绝。
const SHELL_WRAPPER = /(^|\s|;|&&|\|\||\|)(sh|bash|zsh|dash|ksh|cmd|powershell|pwsh)\s+-c\b|(^|\s|;|&&|\|\||\|)eval\b|(^|\s|;|&&|\|\||\|)command\s+-v\b/i;

/**
 * @param {any} rawMode @param {any} name @param {any} args
 */
export function evaluatePermission(/** @type {any} */ rawMode, /** @type {any} */ name, /** @type {any} */ args = {}) {
  const { mode, allow, deny, denyStrict } = normalizePermission(rawMode);
  const hitDeny = deny.find((/** @type {any} */ r) => ruleMatches(r, name, args, true));
  if (hitDeny) return { decision: 'deny', reason: 'rule-deny', rule: hitDeny, denyStrict };
  // denyStrict + 包装执行：deny 规则看不穿参数里的命令，只能整体拒绝（给出可操作的指引）
  if (denyStrict && deny.length > 0 && name === 'bash' && SHELL_WRAPPER.test(String(args?.command ?? ''))) {
    return {
      decision: 'deny',
      reason: 'deny-strict-wrapper',
      rule: 'denyStrict:shell-wrapper',
      denyStrict: true,
    };
  }
  const hitAllow = allow.find((/** @type {any} */ r) => ruleMatches(r, name, args));
  if (hitAllow) return { decision: 'allow', reason: 'rule-allow', rule: hitAllow };
  if (mode === 'auto') return { decision: 'allow', reason: 'mode-auto', rule: null };
  if (READONLY_TOOLS.has(name)) return { decision: 'allow', reason: 'readonly-tool', rule: null };
  if (mode === 'readonly') return { decision: 'ask', reason: 'readonly-write', rule: null };
  return { decision: 'ask', reason: 'interactive', rule: null };
}

// v0.6.30（C3③，报告四 H2 / 报告三 H-12）：**read → fetch 的叠加提示**。
//
// `fetch` 移出只读集合后，默认 ask 档会为每次出网弹确认——但只写「是否允许 fetch https://…」
// 还不够：一个被注入的模型常常是**先读一批本地文件、再把内容拼进 URL**。用户看到一条普通的
// 出网确认，很难意识到这条请求可能就是外传通道。于是在同一「回合」内先 `read` 过本地文件、
// 随后 `fetch` 的确认文案里必须点名这件事。
//
// 为什么是时间窗而不是严格回合：回合边界在 agent.js 的 runTurn 里，permissions 不持有它
// （本文件刻意保持无状态、可被账本回放复用）。用 10 分钟窗口近似「同一次交互」：方向是
// **多提醒**而不是漏提醒——即便跨了两个回合，多一句提示没有安全代价。
const READ_THEN_EGRESS_WINDOW_MS = 10 * 60 * 1000;
const RECENT_READS_MAX = 20;

/** @param {any} rawMode @param {any} io */
export function createPermission(rawMode, io) {
  const { mode, allow, deny } = normalizePermission(rawMode);
  /** 本权限实例（≈ 本会话）最近读过的本地文件：`read` 自动放行时记录，供 fetch 确认文案使用。 */
  /** @type {{ path: string, at: number }[]} */
  const recentReads = [];

  return {
    mode,
    /** @param {any} name @param {any} args @param {any} label */
    async check(name, args = {}, label = '') {
      const now = Date.now();
      /**
       * fetch 的确认文案追加段：窗口内读过本地文件时，点明「这条请求可能携带刚读到的内容」。
       * 只在**确认文案**里加，不改变判定（判定仍只此一份：evaluatePermission）。
       */
      const egressReadWarning = () => {
        if (name !== 'fetch' || !recentReads.length) return '';
        const cutoff = Date.now() - READ_THEN_EGRESS_WINDOW_MS;
        const paths = recentReads
          .filter((r) => r.at >= cutoff && r.path)
          .slice(-3)
          .map((r) => r.path);
        return (
          `\n  ⚠ 该请求可能携带刚读取的本地内容${paths.length ? `（${paths.join('、')}）` : ''}——` +
          `URL 的查询串/路径会把内容带出本机，确认前请核对目标域名与参数。`
        );
      };
      const askOverride = async (/** @type {any} */ question) => {
        try {
          const answer = await io.ask(style(question, C.yellow));
          return /^y(es)?$/i.test(answer);
        } catch {
          return false; // 交互通道不可用（管道 EOF/静默 worker）：按拒绝处理
        }
      };
      // 判定只此一份（evaluatePermission）；这里只负责「需要用户点头时怎么问」。
      const v = evaluatePermission(rawMode, name, args);
      if (v.decision === 'allow') {
        // 只记录**真的放行**的 read：被 deny 拦下（或询问被拒）的读取没有发生，
        // 拿它去提示 fetch 外传风险就是误报。
        if (name === 'read') {
          const cutoff = now - READ_THEN_EGRESS_WINDOW_MS;
          while (recentReads.length && recentReads[0].at < cutoff) recentReads.shift();
          recentReads.push({ path: String(args?.path ?? ''), at: now });
          if (recentReads.length > RECENT_READS_MAX) recentReads.splice(0, recentReads.length - RECENT_READS_MAX);
        }
        return true;
      }
      // 1) 被 deny 规则拦截。
      //    默认（与 docs/CONFIG.md 一致）：询问是否本次强制放行，而不是静默拒绝。
      //    但 `denyStrict: true` 时**不给放行入口**——那是用户显式要求的硬拦截。
      if (v.decision === 'deny') {
        if (v.denyStrict) {
          try {
            io.print(
              style(
                `⛔ 已拒绝：${name}${summarize(name, args)} 命中 deny 规则「${v.rule}」` +
                  `（config.permission.denyStrict=true：deny 为硬拦截，不提供本次放行）。` +
                  (v.reason === 'deny-strict-wrapper' ? '\n  原因：命令用 sh -c / eval 等包装执行，deny 规则看不穿参数里的真实命令。请直接写命令本身（不要包一层 shell）。' : ''),
                C.red
              )
            );
          } catch {}
          return false;
        }
        // 知情同意：点名命中的规则与来源，而不是笼统的"规则拦截了"
        return askOverride(
          `⚠ ${name}${summarize(name, args)} 命中你配置的 deny 规则「${v.rule}」——是否本次强制放行？（这会绕过你自己写的禁令）[y/N] `
        );
      }
      // 2) 只读模式下的写操作 / 出网 → 询问是否本次放行
      if (v.reason === 'readonly-write') {
        return askOverride(`只读模式将拦截 ${name}${summarize(name, args)}，是否本次放行？${egressReadWarning()}[y/N] `);
      }
      const answer = await io.ask(
        style(`是否允许执行 ${label}${C.bold}${name}${C.reset}${summarize(name, args)} ？${egressReadWarning()}[y/N] `, C.yellow)
      );
      return /^y(es)?$/i.test(answer);
    },
  };
}
