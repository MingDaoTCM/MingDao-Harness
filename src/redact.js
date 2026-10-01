// 统一脱敏（v0.3.1 P1-1 修复）：审计/日志/会话/诊断/错误消息共用同一套规则，消除「各层自扫门前雪」。
//  - redactSecrets：密钥脱敏（常见前缀 + Bearer + URL 内嵌凭据），保留路径便于排查 → 审计/日志用
//  - redactSensitive：在 redactSecrets 之上再加私网 IP + 家目录路径掩码 → 诊断包/对外输出用
import os from 'node:os';

// 常见密钥前缀（GitHub/OpenAI/AWS/Slack/Google 等）；sk- 保留前缀、其余整体掩码
// 密钥词（按 `_`/`-` 分段后**整段相等**才算命中，避免 `monkey` 这类子串误伤）
export const SECRET_NAME_SEGMENTS = new Set([
  'key', 'keys', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'pass',
  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'session',
]);
// v0.6.7（报告一 M-3）：子进程 env 过滤（bash/hooks/MCP）与脱敏器必须**同一份词表**——
// 此前两份各自维护，bash 那份漏了 `key` 段：`OPENAI_KEY` / `ANTHROPIC_KEY` / `GITHUB_KEY`
// 会原样透传给子进程，一条 `env` 就把密钥打进模型上下文。
// 唯一例外是 `pwd`：`PWD` 是每个 shell 都有的标准变量（不是凭据），
// 按它过滤会让子进程少一个常用变量 —— 所以 env 侧用下面这份去掉 pwd 的集合。
export const ENV_SECRET_SEGMENTS = new Set([...SECRET_NAME_SEGMENTS].filter((x) => x !== 'pwd'));
const KEY_PREFIX = /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})/g;

// v0.6.3（审计 H-1/H-2）：**脱敏器自身的覆盖缺口**。
//
// 起因：把「会话原文上传前脱敏」接上之后，实测发现三种最常见的凭据形态根本不被匹配——
//   · **PEM 私钥块**（`-----BEGIN … PRIVATE KEY-----`）：完全没有规则，整段原文照抄；
//   · **JWT**（`eyJ…​.eyJ…​.…`）：没有规则；
//   · **赋值式密钥**（`AWS_SECRET_ACCESS_KEY=…`）：原有的字段名列表要求
//     `secret` **紧跟** `=`/`:`，而这里是 `SECRET_ACCESS_KEY=`——看着像覆盖了，实际漏。
// 上层把脱敏接得再牢，也挡不住脱敏器本身不认——所以这一批先补基础（账本/审计/诊断/同步同时受益）。
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g;

// ── 已知密钥前缀表（**单一来源**，v0.6.8）──────────────────────────────────────────
//
// 为什么把它做成**表**而不是散在 redactSecrets 里的若干行 replace：
// 前缀表是"按厂商逐个维护"的，每接入一个新厂商就多一个漏点，**而且漏了不会报错**——
// v0.6.3 漏了 PEM/JWT/赋值式，v0.6.8 又漏了 Dify 的 `app-`（下游反馈：同一份日志里
// DeepSeek 的 `sk-` 被掩掉了、Dify 的 key 原样漏出。**半掩比不掩更危险**——贴日志的人
// 会以为"已经脱敏了"）。两次的教训是同一句话：**"表里有规则"不等于"规则认得你正在用的那种 key"**。
//
// 所以每一行都必须带 `sample`（该前缀的一个真实形态样例），由 test/smoke.js 的**表驱动断言**
// 逐个验证"样例确实被掩掉了"——新增一行而没被掩，测试当场红。
// @type {{vendor: string, re: RegExp, mask: string, sample: string}[]}
export const SECRET_PREFIXES = [
  // DeepSeek / OpenAI 风格：保留前缀便于排查"配了哪一类 key"
  { vendor: 'sk- 系（DeepSeek/OpenAI 等）', re: /(sk-[A-Za-z0-9_-]{6,})/g, mask: 'sk-***', sample: 'sk-abcdefghijklmnopqrstuvwx' },
  // Dify 应用 API Key：`app-` + 一长串 base62（下游每把都是这个形态）。
  // 刻意**不含** `-`/`_`：否则 `app-deployment-config-2024` 这类普通标识会被误掩，
  // 而脱敏器一旦误伤就会被人关掉——保守与可用之间，这条选"只认纯 base62 长串"。
  { vendor: 'Dify 应用 Key', re: /\bapp-[A-Za-z0-9]{20,}/g, mask: 'app-***', sample: 'app-abcdefghijklmnopqrstuvwx' },
  // Dify 知识库（dataset）API Key：同厂商另一类凭据，形态与 app- 同构
  { vendor: 'Dify 知识库 Key', re: /\bdataset-[A-Za-z0-9]{20,}/g, mask: 'dataset-***', sample: 'dataset-abcdefghijklmnopqrstuvwx' },
  // 其余厂商（GitHub / AWS / Slack / Google）：整体掩码
  { vendor: 'GitHub/AWS/Slack/Google', re: KEY_PREFIX, mask: '***', sample: 'ghp_abcdefghijklmnopqrstuvwx' },
];

export function redactSecrets(/** @type {any} */ text) {
  let s = String(text ?? '');
  // 私钥块必须**先**处理：它内部含大量 base64，交给后面的规则逐段匹配既慢又可能只掩一半
  s = s.replace(PEM_BLOCK, '[已脱敏的私钥块]');
  // 前缀表逐行替换（顺序即优先级；每行的 re 都带 /g，String.replace 会重置 lastIndex，可安全复用）
  for (const { re, mask } of SECRET_PREFIXES) s = s.replace(re, mask);
  s = s.replace(JWT_TOKEN, 'eyJ***');
  s = s.replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',}]+/gi, '$1***');
  // 赋值式密钥：**按名字分段判定**，而不是枚举固定字段名。
  //
  // 原写法要求密钥词**紧跟** `=`/`:`，于是三种最常见的形态全漏：
  //   `AWS_SECRET_ACCESS_KEY=…`（词在中间段）、`MY_TOKEN_V2=…`（词在前段带后缀）、
  //   `x-api-key: …`（带 `api` 的复合名）。注释当时写着"覆盖 api_key/token/secret/password"，
  //   读起来像覆盖了，实测一个都没中——**"有规则"不等于"规则认得"**。
  // 现在把名字按 `_`/`-` 分段，任一段是密钥词就掩码值（保留名字，便于排查"配了哪些"）。
  // v0.6.7（报告一 H-2，**三份报告都点到**）：**键名可能带引号**。
  // 原正则要求名字后面紧跟 `=`/`:`（只允许空白），于是 JSON/YAML 里最常见的形态全部漏过：
  //   `{"api_key": "sk-…"}`、`{'api_key': 'sk-…'}`、`api_key: "sk-…"`
  // ——而诊断包是用户会主动贴到公开渠道的产物、审计日志是本机持久化的明文。
  // 现在名字两侧允许成对的引号（`\1` 反向引用保证左右引号一致），值一侧的引号也允许。
  s = s.replace(
    /(["']?)([A-Za-z0-9][A-Za-z0-9_-]{0,63})\1(\s*[=:]\s*)(["']?)([^\s"',}]{5,})/g,
    (/** @type {string} */ m, /** @type {string} */ qn, /** @type {string} */ name, /** @type {string} */ sep, /** @type {string} */ qv, /** @type {string} */ val) => {
      const segs = String(name).toLowerCase().split(/[_-]+/);
      if (!segs.some((x) => SECRET_NAME_SEGMENTS.has(x))) return m;
      // 认证方案名本身不是凭据：`Authorization: Bearer <token>` 由上面那条 Bearer 规则
      // 负责掩掉 token，这里若连 `Bearer` 一起掩，审计行会退化成 `Authorization: *** ***`（可读性白损）
      if (/^(bearer|basic|token|digest)$/i.test(val)) return m;
      return `${qn}${name}${qn}${sep}${qv}***`;
    }
  );
  s = s.replace(/([?&](?:key|token|secret|api_key|access_token)=)[^&\s"']+/gi, '$1***');
  // P2 修复（v0.4.6）：URL 内嵌凭据（scheme://user:pass@host）——本文件头注释一直声称覆盖，
  // 但规则里从来没有这一条：`git clone https://oauth2:glpat-xxx@host/repo`、
  // `postgres://user:pw@host/db` 这类命令行会**原样**落入 ~/.mingdao/audit.jsonl
  // （bash/fetch 的完整参数写审计）与 diagnose 诊断包。只掩码密码段，保留用户名与主机便于排查。
  s = s.replace(/(:\/\/[^/\s:@]{1,64}:)[^/\s@]{1,256}@/g, '$1***@');
  return s;
}

// ---------- v0.6.2（第三方审计 P2-13）：配置需要**结构感知**脱敏，光靠字段名堵不住 ----------
// redactSecrets 是按字段名匹配的（api_key|token|secret|password|access_token…）。
// 而 `mcpServers.foo.env.MY_CUSTOM_CRED`、`tools[].env.INTERNAL_SSO` 这类**自定义名**
// 完全不被匹配，值会原样落进诊断包——而诊断包正是用户会主动贴到公开反馈渠道的产物。
// 字段名是用户起的，靠枚举名字永远堵不住，所以按**结构位置**判定。
const SECRET_KEY_RE = /(?:key|token|secret|password|passwd|credential|authorization|auth|cookie)/i;
// 这些容器下的**全部值**都当敏感处理（保留键名，便于排查"配了哪些"）
const OPAQUE_CONTAINERS = new Set(['env', 'headers', 'environment']);

/**
 * 把一棵子树的所有叶子值掩码，但保留键与结构（诊断需要知道「配了哪些」，不需要「配了什么」）。
 * @param {any} v
 * @returns {any}
 */
function maskAllValues(/** @type {any} */ v) {
  if (Array.isArray(v)) return v.map(maskAllValues);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskAllValues(x)]));
  }
  return '***';
}

/**
 * 递归脱敏一份配置对象（返回新对象，不改原值）。
 * @param {any} value
 * @param {string} [key] 该值所处的键名（用于按名判定）
 * @returns {any}
 */
export function redactConfigValue(/** @type {any} */ value, /** @type {string} */ key = '') {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redactConfigValue(v, key));
  if (typeof value === 'object') {
    const out = /** @type {any} */ ({});
    for (const [k, v] of Object.entries(value)) {
      // 两种情况都掩码整棵子树：① env/headers 这类"装密钥的容器"；
      // ② 键名本身命中密钥词（credential/token/…）——**哪怕它的值是对象**，
      //    否则 `customCredentials: { whatever: 'plain' }` 会因为内层键名无害而漏出去。
      // 代价：`author` 之类含 auth 的键会被过度掩码（诊断可读性略降），
      // 但方向是安全的——宁可少显示，不可泄漏。
      const opaque = OPAQUE_CONTAINERS.has(k.toLowerCase()) || SECRET_KEY_RE.test(k);
      if (opaque && v && typeof v === 'object') out[k] = maskAllValues(v);
      else out[k] = redactConfigValue(v, k);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (key && SECRET_KEY_RE.test(key)) return '***';
    return redactSensitive(value); // 复用同一套字符串规则（私网 IP / 家目录 / 已知前缀）
  }
  return value;
}

/** 便捷入口：整份 config → 脱敏后的可安全外发对象 */
export function redactConfig(/** @type {any} */ cfg) {
  return redactConfigValue(cfg);
}

export function redactSensitive(/** @type {any} */ text) {
  let s = redactSecrets(text);
  s = s.replace(/\b(?:10|127)(?:\.\d{1,3}){3}\b|\b192\.168(?:\.\d{1,3}){2}\b|\b169\.254(?:\.\d{1,3}){2}\b|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b/g, '[私网IP]');
  s = s.replace(/(?:fe80:[\da-f:]+|::1|::)/gi, '[链路本地/回环IPv6]');
  const home = os.homedir();
  // 审计 P3-1（v0.4.2）：split().join() 无边界——/home/user2/xxx 会被误脱敏为 ~2/xxx。
  // 正则要求家目录后跟路径分隔符或字符串结尾（如 /home/user2 的 2 紧跟目录名不匹配）。
  if (home && home.length > 1) {
    s = s.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=/|$)', 'g'), '~');
  }
  return s;
}
