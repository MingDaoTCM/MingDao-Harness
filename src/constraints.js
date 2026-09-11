// 约束引擎 v1（v0.5.0 阶段 A3，Pack API v1）。
//
// 定位：把「领域红线」从**提示词里的一句话**升级为**内核强制 + 留痕**的机械检查。
// 垂域的红线（「缺项绝不编造」「不输出诊疗结论」「不得跨患者串病历」）今天只能写在 prompt 里，
// 而 prompt 是建议不是强制——模型越界一次就是事故。本模块提供三个执行时机：
//
//   ① PreToolUse  —— tool-deny / tool-arg-require / arg-forbid：阻止执行并回填错误给模型
//   ② PostToolUse —— completeness / result-forbid：拒绝工具结果并要求补采
//   ③ 输出前       —— output-forbid：按 action（block / block-and-rewrite / warn）处理
//
// 设计原则（与 PACK-API §4 一致）：
//  - **只能收紧、不能放松**：约束不授予任何权限，也不改变 permissions.js 的判定。
//  - **fail-closed**：约束求值异常一律按「阻断」处理，绝不静默放行。
//  - 纯函数：本模块不碰 IO/全局状态，便于单测与 `pack verify` 复用。
//  - 默认空集合时行为与「没有约束引擎」完全一致（零 Pack 场景零影响）。

/** @typedef {{ id: string, kind: string, pack?: string, tool?: string, pattern?: string, action?: string, fields?: string[], requireArg?: string, arg?: string, onMissing?: string }} Constraint */

/** 合法的输出处置动作 */
export const OUTPUT_ACTIONS = new Set(['block', 'block-and-rewrite', 'warn']);

/** 约束支持的 kind（与 packs.js / PACK-API §4 对齐） */
export const KINDS = new Set(['tool-deny', 'tool-arg-require', 'arg-forbid', 'output-forbid', 'completeness', 'confirm', 'result-forbid']);
/** 依赖正则 pattern 的 kind（校验与求值都必须统一走 isValidPattern，避免两处口径分叉） */
export const PATTERN_KINDS = new Set(['arg-forbid', 'output-forbid', 'result-forbid']);
/** 作用域限于「某个工具」的 kind：其 pattern 坏掉时可以精确 fail-closed（只拦这个工具） */
const SCOPED_PATTERN_KINDS = new Set(['arg-forbid', 'result-forbid']);

/** 预编译的正则缓存：pattern → RegExp（非法正则返回 null，由调用方 fail-closed） */
const reCache = new Map();
/** @param {any} pattern */
function toRegExp(pattern) {
  const key = String(pattern ?? '');
  if (reCache.has(key)) return reCache.get(key);
  let re = null;
  try {
    re = new RegExp(key);
  } catch {
    re = null;
  }
  if (reCache.size > 500) reCache.clear();
  reCache.set(key, re);
  return re;
}

/**
 * 工具名匹配：约束里写**裸名**（`intake_collect`），内核注册名是 `pack__<pack>__<tool>`。
 * 两种写法都接受；同 Pack 限定（c.pack 存在时不允许跨 Pack 命中同名工具）。
 * @param {any} c @param {any} toolName
 */
export function toolMatches(c, toolName) {
  const name = String(toolName || '');
  const want = String(c?.tool || '');
  if (!want) return false;
  if (name === want) return true;
  if (want.startsWith('pack__')) return name === want;
  if (c?.pack) return name === `pack__${c.pack}__${want}`;
  // 无 pack 归属（内置/本地约束）：也允许匹配已注册的包内工具裸名后缀
  return name.endsWith(`__${want}`);
}

/**
 * pattern 是否是一个**可用**的正则（v0.6.0：单一来源，packs.js 的装载校验与引擎求值共用）。
 *
 * 为什么必须显式判空串：`new RegExp('')` 是合法正则且**匹配一切**。也就是说
 * 「arg-forbid 忘了写 pattern」不会报错，而会变成「这个参数的任何取值都拦」——
 * 比作者本意严得多，且理由里会印出 `/undefined/`，看起来像引擎坏了。
 * @param {any} pattern
 */
export function isValidPattern(/** @type {any} */ pattern) {
  if (typeof pattern !== 'string' || pattern === '') return false;
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * 编译约束集合：过滤掉不合法条目（fail-safe：非法条目被忽略而不是让整轮崩掉），
 * 并按时机分组，避免每次工具调用都全量遍历。
 * @param {any[]} list（通常来自 packs.js mountPacks 的 constraints）
 */
export function compileConstraints(list) {
  const invalid = [];
  /** pattern 坏掉、但已按 fail-closed 保留的作用域类约束（v0.6.0） */
  /** @type {any[]} */
  const broken = [];
  /** @type {any[]} */
  const pre = [];
  /** @type {any[]} */
  const post = [];
  /** @type {any[]} */
  const output = [];
  let n = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    const c = raw && typeof raw === 'object' ? raw : null;
    if (!c || typeof c.id !== 'string' || !KINDS.has(c.kind)) {
      invalid.push(c?.id || '(无 id)');
      continue;
    }
    // pattern 类约束：非法/缺失的 pattern 绝不能「静默放行」。
    // 修复前的实际行为（v0.5.0 起的 fail-**open** 缺陷）：
    //   · arg-forbid + 非法正则  → toRegExp 返回 null → `if (re && ...)` 为假 → **永不阻断**，
    //     且连 invalid 都不进，作者以为自己有红线，其实没有；
    //   · arg-forbid + 缺失 pattern → new RegExp('') 匹配一切 → 拦下该参数的任何取值；
    //   · output-forbid + 非法正则 → 被丢进 invalid 后**从 all 里消失**，同样是红线静默消失。
    // 这与本模块第 13 行声明的「fail-closed：约束求值异常一律按阻断处理」直接矛盾。
    if (PATTERN_KINDS.has(c.kind) && !isValidPattern(c.pattern)) {
      // 作用域类（只针对某个工具）可以精确 fail-closed：保留该条，让 checkPreTool/checkPostTool
      // 在遇到它时按「配置有误」阻断**这个工具**，理由直接指向缺哪个字段——
      // 比静默放行安全，也比「拦下全部工具」克制。
      if (SCOPED_PATTERN_KINDS.has(c.kind)) {
        broken.push(c);
        n += 1;
        if (c.kind === 'arg-forbid') pre.push(c);
        else post.push(c);
        continue;
      }
      // 输出类没有作用域可言，若在这里 fail-closed 会让「一个正则写错」变成「整个会话无法输出」。
      // 因此不进 all，但要**可见**：进 invalid 由调用方告警，并由 packs.js 的装载校验 +
      // `pack verify`（下游 CI 门禁）在更早、更该出错的地方拒绝它。
      invalid.push(`${c.id}（pattern 缺失或非法正则）`);
      continue;
    }
    n += 1;
    if (c.kind === 'tool-deny' || c.kind === 'tool-arg-require' || c.kind === 'arg-forbid') pre.push(c);
    else if (c.kind === 'completeness' || c.kind === 'result-forbid') post.push(c);
    else output.push(c);
  }
  return {
    all: [...pre, ...post, ...output],
    pre,
    post,
    output,
    invalid,
    broken,
    size: n,
    /** 是否存在任何约束——false 时调用方应完全跳过（零影响路径） */
    get active() {
      return n > 0;
    },
  };
}

/**
 * 统一的约束事件（进审计 / 执行账本）
 * @param {any} c @param {string} stage @param {any} [extra]
 */
function event(c, stage, extra = {}) {
  return {
    pack: c?.pack || null,
    constraint: c?.id || null,
    kind: c?.kind || null,
    stage,
    ...extra,
  };
}

/**
 * ① PreToolUse：工具与参数层面的红线。
 * @param {any} compiled @param {any} toolName @param {any} args
 * @returns {{ blocked: boolean, reason: string, event: any } | null}
 */
export function checkPreTool(compiled, toolName, args) {
  if (!compiled?.active) return null;
  try {
    for (const c of compiled.pre) {
      if (!toolMatches(c, toolName)) continue;
      if (c.kind === 'tool-deny') {
        return { blocked: true, reason: `领域约束「${c.id}」禁止调用 ${c.tool}`, event: event(c, 'pre-tool', { action: 'block' }) };
      }
      if (c.kind === 'tool-arg-require') {
        const v = args?.[c.requireArg];
        if (v === undefined || v === null || String(v).trim() === '') {
          return {
            blocked: true,
            reason: `领域约束「${c.id}」要求 ${c.tool} 必须携带参数 ${c.requireArg}（缺失或为空）`,
            event: event(c, 'pre-tool', { action: 'block', missingArg: c.requireArg }),
          };
        }
      }
      if (c.kind === 'arg-forbid') {
        const v = String(args?.[c.arg] ?? '');
        if (!isValidPattern(c.pattern)) {
          // fail-closed：pattern 配错时**不能**放行（否则红线静默消失）。
          // 理由直接指出问题所在，而不是抛一个让人猜的「领域约束拦截」。
          return {
            blocked: true,
            reason: `领域约束「${c.id}」的 pattern 缺失或非法正则，按 fail-closed 阻断（请修正 Pack 中的 ${c.kind} 配置）`,
            event: event(c, 'pre-tool', { action: 'block', arg: c.arg, specError: true }),
          };
        }
        const re = toRegExp(c.pattern);
        if (re && re.test(v)) {
          return {
            blocked: true,
            reason: `领域约束「${c.id}」禁止参数 ${c.arg} 匹配 /${c.pattern}/`,
            event: event(c, 'pre-tool', { action: 'block', arg: c.arg }),
          };
        }
      }
    }
    return null;
  } catch (/** @type {any} */ err) {
    // fail-closed：约束求值异常按阻断处理，绝不静默放行
    return {
      blocked: true,
      reason: `领域约束求值异常，已按阻断处理：${err?.message || err}`,
      event: { pack: null, constraint: null, kind: 'error', stage: 'pre-tool', action: 'block' },
    };
  }
}

/**
 * ② PostToolUse：工具结果层面的红线。
 * completeness 要求 result.data（或 result.todos）里 fields 全部非空；缺项 → 拒绝该结果。
 * @param {any} compiled @param {any} toolName @param {any} result
 * @returns {{ rejected: boolean, reason: string, missing: string[], event: any } | null}
 */
export function checkPostTool(compiled, toolName, result) {
  if (!compiled?.active) return null;
  try {
    for (const c of compiled.post) {
      // v0.6.0：result-forbid 此前只存在于 PACK-API v1 契约与本文件头注释里，KINDS 与实现都没有它
      // ——下游按冻结契约写 result-forbid 会被判为非法条目并**静默丢弃**（红线不存在）。
      // 现在补齐实现：结果（序列化后）命中 pattern 即拒绝该结果，要求模型改用合规表述。
      if (c.kind === 'result-forbid') {
        if (!toolMatches(c, toolName)) continue;
        if (!isValidPattern(c.pattern)) {
          return {
            rejected: true,
            reason: `领域约束「${c.id}」的 pattern 缺失或非法正则，按 fail-closed 拒绝该工具结果（请修正 Pack 中的 ${c.kind} 配置）`,
            missing: [],
            event: event(c, 'post-tool', { action: 'reject', specError: true }),
          };
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
        const re = toRegExp(c.pattern);
        if (re && re.test(String(text))) {
          return {
            rejected: true,
            reason: `领域约束「${c.id}」：工具结果命中禁用内容，已拒绝该结果——请改用合规表述后重新采集`,
            missing: [],
            event: event(c, 'post-tool', { action: 'reject' }),
          };
        }
        continue;
      }
      if (c.kind !== 'completeness' || !toolMatches(c, toolName)) continue;
      const data = result && typeof result === 'object' && result.data && typeof result.data === 'object' ? result.data : null;
      if (!data) {
        return {
          rejected: true,
          reason: `领域约束「${c.id}」要求 ${c.tool} 返回结构化 data（用于校验必填项），但本次未返回`,
          missing: Array.isArray(c.fields) ? c.fields.slice() : [],
          event: event(c, 'post-tool', { action: 'reject', reason: 'no-data' }),
        };
      }
      const missing = (Array.isArray(c.fields) ? c.fields : []).filter((/** @type {any} */ f) => {
        const v = data[f];
        return v === undefined || v === null || String(v).trim() === '' || String(v).trim() === '未提及';
      });
      if (missing.length) {
        return {
          rejected: true,
          reason: `领域约束「${c.id}」：必填项缺失 ${missing.join('、')}——缺项绝不编造，请继续采集后再落盘`,
          missing,
          event: event(c, 'post-tool', { action: c.onMissing === 'require-tool' ? 'require-tool' : 'reject', missing: missing.length }),
        };
      }
    }
    return null;
  } catch (/** @type {any} */ err) {
    return {
      rejected: true,
      reason: `领域约束求值异常，已按拒绝处理：${err?.message || err}`,
      missing: [],
      event: { pack: null, constraint: null, kind: 'error', stage: 'post-tool', action: 'reject' },
    };
  }
}

/**
 * ③ 输出前：正文层面的红线。
 * @param {any} compiled @param {any} text
 * @returns {{ hit: boolean, action: string, matched: string, reason: string, constraint: any, event: any } | null}
 */
export function checkOutput(compiled, text) {
  if (!compiled?.active) return null;
  const s = String(text ?? '');
  if (!s) return null;
  try {
    for (const c of compiled.output) {
      if (c.kind !== 'output-forbid') continue;
      const re = toRegExp(c.pattern);
      if (!re) continue;
      const m = re.exec(s);
      if (!m) continue;
      const action = OUTPUT_ACTIONS.has(String(c.action)) ? String(c.action) : 'block';
      return {
        hit: true,
        action,
        matched: String(m[0]).slice(0, 40),
        reason: `领域约束「${c.id}」命中禁用措辞「${String(m[0]).slice(0, 40)}」`,
        constraint: c,
        event: event(c, 'pre-output', { action, matched: String(m[0]).slice(0, 40) }),
      };
    }
    return null;
  } catch (/** @type {any} */ err) {
    // fail-closed：求值异常按最严处理
    return {
      hit: true,
      action: 'block',
      matched: '',
      reason: `领域约束求值异常，已按阻断处理：${err?.message || err}`,
      constraint: null,
      event: { pack: null, constraint: null, kind: 'error', stage: 'pre-output', action: 'block' },
    };
  }
}

/**
 * 命中 output-forbid 时的替换文案（block / block-and-rewrite 用）。
 * 刻意保守：只说明「被领域红线拦下」，不编造领域内容。
 * @param {any} hit
 */
export function blockedOutputText(hit) {
  const id = hit?.constraint?.id || '领域红线';
  // 刻意**不回显命中的措辞**：回显会把被禁用的表述重新写进正文与会话历史，
  // 下一轮又被当作既成事实喂回模型——拦截就白做了。（命中详情仍进审计事件，可追溯。）
  return `（本段回复已被领域约束「${id}」拦截：内容命中该约束的禁用表述。请改写为不含该表述的事实陈述，或补充依据。本提示由内核强制，非模型自觉。）`;
}
