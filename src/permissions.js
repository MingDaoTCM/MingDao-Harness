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
//
// v0.10.1（遗留安全批：v0.8.1 报告 H-2/H-3，连续两个版本未修）补两个缺口：
//   ① **提权型包装器**（su/runuser/pkexec/chroot/nsenter/unshare/capsh）此前不在前缀表里，
//      `pkexec rm -rf /`、`su -c 'rm -rf /'`、`chroot /srv rm -rf /` 归一后 argv[0] 仍是包装器，
//      deny 规则全部失配 → 直达执行；其中 `-c`/`--command` 的值是命令串，走 visitText 再分词。
//   ② **Windows shell 写法**：命令名大小写不敏感（`CMD.EXE`）、`cmd /c` / `cmd.exe /C`、
//      powershell `-Command` 的 /c 之后才是真命令，此前完全不归一 → 软 deny 失配。

/** shell 可执行名：`sh -c '<真命令>'` 一类写法要把参数里的命令再归一一次。 */
const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd']);

/**
 * 包装器前缀表：键是包装器的 basename（**大小写不敏感**，见 visitTokens 的 baseLower）。
 *  `shortValue`：需要**独立下一个参数**作值的短选项（`-u x`、`-n 5`）；
 *  `longValue`：需要独立下一个参数作值的长选项（`--user x`；`--user=x` 自带值，不消耗下一个）；
 *  `optionalValue`：**参数可选**的选项（`nsenter -m[=file]`）。两种解释都要试——见下方原则；
 *  `commandValue`：值是**一条命令串**的选项（`su -c '<命令>'`、`env -S '<命令>'`），必须像 shell
 *    文本那样**再分词归一化**（否则引号里的 `rm -rf /` 永远只是包装器的参数）；
 *  `skipOperand`：剥完选项后再跳过一个操作数（`timeout 5 rm` 里的 `5`、`chroot NEWROOT`）；
 *  `shellStyle`：选项之后是 `[--] -c '<命令>'` 形态（capsh），`-c` 的值才是真命令。
 *
 * 取值方向的**原则（fail-closed）**：不确定某个选项是否吃一个值时就**当作吃值**，或两种解释都试；
 * 只列会改变真命令位置的选项。**确定不吃值**的选项（如 `pkexec --disable-internal-agent`、
 * `unshare -m` 的短形态）绝不登记成吃值——否则会把后面的真命令当成它的值吞掉。
 * 对参数可选的选项（nsenter 的 `-m[=file]`）这里不做单边猜测：扫描器会**同时**产出「带值 /
 * 不带值」两条候选路径，任一条命中 deny 即拒——单边"当作吃值"会把 `nsenter -m rm -rf /` 的 rm
 * 吞掉（漏判），单边"当作不吃值"会把 `nsenter -m /proc/1/ns/mnt rm -rf /` 的文件名当命令（同样漏判）。
 * @type {Record<string, {
 *   shortValue?: string[], longValue?: string[], optionalValue?: { short?: string[], long?: string[] },
 *   commandValue?: { short?: string[], long?: string[] }, skipOperand?: boolean, shellStyle?: boolean,
 * }>}
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
  // ── v0.10.1（遗留安全批，v0.8.1 报告 H-3 / 报告一 P1）：提权型包装器 ──────────────
  // 这组缺项不是"少判一个参数"，而是 **deny 规则看不见真正要执行的命令**：
  // `pkexec rm -rf /`、`su -c 'rm -rf /'`、`chroot /srv rm -rf /`、`runuser -u x -- rm -rf /`
  // 归一化后 argv[0] 仍是包装器本身，于是 `deny:['bash:rm *']` 全部失配 → auto 档零确认执行。
  //
  // su / runuser：`-c` / `--command` / `--session-command` 的值是**一条命令串**，走 commandValue
  // （与 env -S 同一条通道再分词）；`-s/-g/-G/-u/-w` 与对应长选项吃值；`-l/-p/-m` 不吃值。
  su: {
    shortValue: ['-s', '-g', '-G', '-u', '-w'],
    longValue: ['--shell', '--group', '--supplementary-group', '--supp-group', '--user', '--whitelist-environment'],
    commandValue: { short: ['-c', '-C'], long: ['--command', '--session-command'] },
  },
  runuser: {
    shortValue: ['-s', '-g', '-G', '-u', '-w'],
    longValue: ['--shell', '--group', '--supplementary-group', '--supp-group', '--user', '--whitelist-environment'],
    commandValue: { short: ['-c', '-C'], long: ['--command', '--session-command'] },
  },
  // pkexec [--user username] [--disable-internal-agent] PROGRAM [ARG...]：PROGRAM 是**第一个操作数**
  // （没有 skipOperand）。--disable-internal-agent 确定不吃值——登记成吃值会吞掉 PROGRAM。
  pkexec: { longValue: ['--user'] },
  // chroot [OPTION] NEWROOT [COMMAND [ARG]...]：NEWROOT 是操作数（skipOperand），
  // COMMAND 及其后才是要归一的真命令；--skip-chdir 不吃值。
  chroot: { longValue: ['--userspec', '--groups'], skipOperand: true },
  // nsenter [options] [program [arguments]]：-m/-u/-i/-n/-p/-U/-C/-T 的文件名**可选**（optionalValue，
  // 两条路径都试）；-t/-S/-G/-r/-w 必吃值；--all/--preserve-credentials/--no-fork 不吃值。
  nsenter: {
    shortValue: ['-t', '-S', '-G', '-r', '-w'],
    longValue: ['--target', '--setuid', '--setgid', '--root', '--wd'],
    optionalValue: { short: ['-m', '-u', '-i', '-n', '-p', '-U', '-C', '-T'], long: ['--mount', '--uts', '--ipc', '--net', '--pid', '--user', '--cgroup', '--time'] },
  },
  // unshare [options] [program [arguments]]：短选项 -m/-u/-i/-n/-p/-U/-C/-T 是**无值开关**
  // （与 nsenter 不同！），-S/-G/-R/-w 吃值；--mount-proc/--kill-child 的文件/信号可选。
  unshare: {
    shortValue: ['-S', '-G', '-R', '-w'],
    longValue: ['--setuid', '--setgid', '--root', '--wd', '--map-user', '--map-group', '--map-users', '--map-groups', '--setgroups', '--propagation'],
    optionalValue: { long: ['--mount-proc', '--kill-child'] },
  },
  // capsh [options] [-- ARGS]：`-- ARGS` 交给 shell 执行；`capsh -- -c 'rm -rf /'` 的 -c 值才是真命令
  // （shellStyle）。不带 `--` 时只剩选项，没有可执行命令。
  capsh: {
    longValue: ['--user', '--uid', '--gid', '--groups', '--cap-set', '--drop', '--inh', '--addamb', '--caps', '--keep', '--decode', '--shell', '--suppress', '--explain', '--mode'],
    shellStyle: true,
  },
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
 * @param {{ shellScripts?: boolean }} [opts] shellScripts=false：不递归解释 `sh -c`/`eval` 的脚本参数
 *   （denyStrict 下改用「包装形态整体拒绝」这条更保守的判据，见 ruleMatches）
 * @returns {{ argv: string[], text: string }[]}
 */
export function canonicalizeCommand(/** @type {any} */ cmd, /** @type {any} */ opts = {}) {
  const shellScripts = opts?.shellScripts !== false;
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
    // v0.10.1（v0.8.1 审计 H-2）：命令名比较**大小写不敏感**（与 deny 匹配同口径）。
    // Windows 的 `CMD.EXE`、`BASH` 都必须识别为同一个可执行文件——否则换个大写就能绕过归一化。
    const baseLower = base.toLowerCase();
    // ② shell 的 -c（含 -lc / -xc 等捆绑形态）与 eval：真命令在参数里，递归拆
    if (SHELL_NAMES.has(baseLower)) {
      if (!shellScripts) {
        add(toks);
        return;
      }
      // v0.10.1（v0.8.1 审计 H-2）：此前只认小写 `-c` 形态，不认 Windows 的 `cmd /c` / `cmd.exe /C`，
      // 于是 `cmd /c "rm -rf /"`、`CMD /C "..."` 的真命令完全不被归一 —— 软 deny（auto 档唯一防线）
      // 直接失配。判据按 shell 家族区分，避免"一律忽略大小写"把 POSIX 的其它短选项误当 -c：
      //   · POSIX shell：小写 `-c`（含 -lc/-xc 捆绑）；`-C` 在 bash 里是 noclobber，不是执行命令，
      //     若把它当 -c，`bash -C -c 'rm -rf /'` 会归一错位（反而漏判）。
      //   · cmd：`/c`（大小写不敏感，也要认 `cmd.exe`；/d /s /c 这类前置开关不影响找 /c）。
      //   · powershell/pwsh：`-Command`/`-c` 大小写不敏感（PowerShell 参数本身就不区分大小写）。
      const ci = toks.findIndex((t, i) => {
        if (i === 0) return false;
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return true;
        if (baseLower === 'cmd') return /^\/[A-Za-z]*c[A-Za-z]*$/i.test(t);
        if (baseLower === 'powershell' || baseLower === 'pwsh') return /^-[A-Za-z]*c[A-Za-z]*$/i.test(t);
        return false;
      });
      if (ci > 0 && toks[ci + 1] !== undefined) {
        visitText(toks.slice(ci + 1).join(' '), depth + 1);
        return;
      }
      add(toks);
      return;
    }
    if (baseLower === 'eval') {
      if (!shellScripts) {
        add(toks);
        return;
      }
      const rest = toks.slice(1).join(' ').trim();
      if (rest) visitText(rest, depth + 1);
      return;
    }
    // ③ 包装器前缀：跳过包装器自身的选项/赋值，再递归归一其后的真命令
    const spec = WRAPPER_PREFIXES[baseLower];
    if (spec) {
      // `env -S 'rm -rf /'`：值本身就是一条命令串（GNU coreutils 的 split-string）
      if (baseLower === 'env') {
        const si = toks.findIndex((t) => t === '-S' || t === '--split-string');
        if (si > 0 && toks[si + 1] !== undefined) {
          visitText(toks[si + 1], depth + 1);
          toks = [...toks.slice(0, si), ...toks.slice(si + 2)];
        }
      }
      // v0.10.1（v0.8.1 审计 H-3）：`-c`/`--command` 的值是**一条命令串**（su/runuser），
      // 必须先整串扫一遍：用户名操作数可能出现在选项之前（`su root -c '…'`、`su - root -c '…'`），
      // 按位置逐个剥选项会在第一个操作数处提前 break，从而漏掉 -c 的值。
      // 与 env -S 走同一条 visitText（再按 shell 分词）通道。
      if (spec.commandValue) {
        const cvShort = spec.commandValue.short || [];
        const cvLong = spec.commandValue.long || [];
        for (let k = 1; k < toks.length; k++) {
          const t = toks[k];
          if (t === '--') break; // 选项区结束：之后的 -c 是传给目标 shell 的参数，不再当本命令的选项
          if (t.startsWith('--')) {
            const name = t.split('=')[0];
            if (!cvLong.includes(name)) continue;
            const eq = t.indexOf('=');
            if (eq > 0) visitText(t.slice(eq + 1), depth + 1);
            else if (toks[k + 1] !== undefined) {
              visitText(toks[k + 1], depth + 1);
              k += 1;
            }
            continue;
          }
          if (t.startsWith('-') && t !== '-' && /^-[A-Za-z]*c[A-Za-z]*$/.test(t)) {
            // 只认登记过的短选项，且仅当它是捆绑形态的**末位**字符时才吃下一个参数
            if (!cvShort.includes('-' + t.slice(-1))) continue;
            if (toks[k + 1] !== undefined) {
              visitText(toks[k + 1], depth + 1);
              k += 1;
            }
          }
        }
      }
      // 扫描所有可能的「真命令起始下标」。不用单边 break：参数可选的选项（nsenter 的
      // `-m[=file]`）会产生「带值 / 不带值」两条分支，两条都归一并交给 deny 判定
      // （fail-closed：任一条命中即拒；单边猜测两边都可能漏掉真命令）。
      /** @type {number[]} */
      const terminals = [];
      /** @type {number[]} */
      let starts = [1];
      for (let guard = 0; guard < 32 && starts.length; guard++) {
        /** @type {number[]} */
        const next = [];
        /** @param {number} i */
        const push = (i) => {
          if (next.length < 32 && !next.includes(i)) next.push(i);
        };
        for (const i of starts) {
          if (i >= toks.length) {
            terminals.push(i);
            continue;
          }
          const t = toks[i];
          if (t === '--') {
            // `--` 之后全部是操作数/命令：直接收口（旧实现也是 break）。
            // 对 capsh 尤其关键：`capsh -- -c 'rm'` 的 `-c` 在 `--` 之后，若继续按选项扫会把它跳过。
            terminals.push(i + 1);
            continue;
          }
          if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
            push(i + 1);
            continue;
          }
          if (t.startsWith('--')) {
            const name = t.split('=')[0];
            const inline = t.includes('=');
            if (inline) {
              push(i + 1);
              continue;
            }
            if ((spec.commandValue?.long || []).includes(name) || (spec.longValue || []).includes(name)) {
              push(i + 2);
              continue;
            }
            if ((spec.optionalValue?.long || []).includes(name)) {
              push(i + 1);
              push(i + 2);
              continue;
            }
            push(i + 1);
            continue;
          }
          if (t.startsWith('-') && t !== '-') {
            const chars = t.slice(1);
            /** @type {'none'|'value'|'optional'} */
            let kind = 'none';
            for (let k = 0; k < chars.length; k++) {
              const opt = '-' + chars[k];
              const last = k === chars.length - 1;
              if ((spec.commandValue?.short || []).includes(opt) || (spec.shortValue || []).includes(opt)) {
                kind = last ? 'value' : 'none';
                break;
              }
              if ((spec.optionalValue?.short || []).includes(opt)) {
                kind = last ? 'optional' : 'none';
                break;
              }
            }
            if (kind === 'value') push(i + 2);
            else if (kind === 'optional') {
              push(i + 1);
              push(i + 2);
            } else push(i + 1);
            continue;
          }
          terminals.push(i); // 第一个非选项 = 真命令起点
        }
        starts = next;
      }
      for (const i of starts) terminals.push(i);
      // skipOperand（timeout 的时长 / chroot 的 NEWROOT）只跳过**存在**的那个操作数
      const cmdStarts = new Set(spec.skipOperand ? terminals.map((i) => (i < toks.length ? i + 1 : i)) : terminals);
      for (const i of cmdStarts) {
        if (i >= toks.length) continue;
        if (spec.shellStyle) {
          // capsh -- -c '<命令>'：`--` 之后交给 shell，-c 的值才是真命令
          const ci2 = toks.findIndex((t, k) => k >= i && /^-[A-Za-z]*c[A-Za-z]*$/.test(t));
          if (ci2 >= i) {
            if (toks[ci2 + 1] !== undefined) visitText(toks.slice(ci2 + 1).join(' '), depth + 1);
            continue;
          }
        }
        visitTokens(toks.slice(i), depth + 1);
      }
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
function ruleMatches(rule, name, args, forDeny = false, denyStrict = false) {
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
      // v0.10.1（v0.8.1 审计 H-2）：字面匹配也改为**大小写不敏感**，与归一化匹配（denyTextMatches）
      // 同口径——Windows 命令名不区分大小写，deny 里写 `rm` 时 `RM -RF /` 必须同样被拦；
      // 方向只收紧（原来能匹配的继续匹配，不会放行任何原先被拦的命令）。
      const wantLow = want.toLowerCase();
      const literalHit = segs.some((seg) => {
        const s = seg.toLowerCase();
        return wantLow.endsWith('*') ? s.startsWith(wantLow.slice(0, -1)) : s === wantLow;
      });
      if (literalHit) return true;
      // v0.6.30（C1）：字面匹配之后**必须**再跑一遍归一化匹配——
      // 绝对路径 / 包装前缀 / 前缀赋值 / 引号转义 / `sh -c` 的绕过都在这一步被堵住。
      // 两者是 OR：字面规则保持向后兼容，归一规则只加严（fail-closed）。
      //
      // denyStrict + 包装执行形态：**不尝试解释脚本**（`sh -c '<任意内容>'` 的内容与被包装的
      // 命令同样不可静态判定），交给 evaluatePermission 的 `denyStrict:shell-wrapper` 分支
      // 整体拒绝。这样既保住了"硬拦截"的可观测性（去掉那条分支就真的会放行 → 变异必红），
      // 也避免在严格模式下对脚本内容做半懂不懂的解析。
      const wrapperForm = denyStrict && SHELL_WRAPPER.test(String(args?.command ?? ''));
      return canonicalizeCommand(args?.command, { shellScripts: !wrapperForm }).some((cand) => denyCanonicalMatch(want, cand));
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
// v0.6.30（C1）：`-c` 的判定补上**捆绑形态**（`-lc` / `-xc` / `-ec`；Windows 的 `cmd /c`）——
// 原正则只认 `-c`，`bash -lc 'rm -rf /x'` 因此在 denyStrict 下也不算"包装执行"（实测放行）。
// v0.10.1（v0.8.1 审计 H-2）：再补 Windows 的两处写法——`cmd.exe`/`powershell.exe`（带扩展名）与
// `cmd /d /s /c`（/c 之前的开关）。大小写本来就有 /i（`CMD /C` 也认）；这条只用于 denyStrict 的
// 「包装形态整体拒绝」，普通 deny 的归一化走 canonicalizeCommand（同一份 H-2 修复在那边）。
const SHELL_WRAPPER = /(^|\s|;|&&|\|\||\|)(sh|bash|zsh|dash|ksh|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)\s+(?:-[A-Za-z]*c[A-Za-z]*|(?:\/[A-Za-z]+\s+)*\/c)\b|(^|\s|;|&&|\|\||\|)eval\b|(^|\s|;|&&|\|\||\|)command\s+-v\b/i;

/**
 * @param {any} rawMode @param {any} name @param {any} args
 */
export function evaluatePermission(/** @type {any} */ rawMode, /** @type {any} */ name, /** @type {any} */ args = {}) {
  const { mode, allow, deny, denyStrict } = normalizePermission(rawMode);
  const hitDeny = deny.find((/** @type {any} */ r) => ruleMatches(r, name, args, true, denyStrict));
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
