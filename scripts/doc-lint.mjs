// 文档守卫（v0.6.8，文档审计 §7.7 的建议）：把"文档与代码不一致"变成 CI 红，而不是靠人肉复查。
//
// 为什么需要：本项目已经吃过太多次"文档说了、代码没做"（反向也有）——
// 报告列出的就有：ARCHITECTURE 停在 v0.1.x、PACK-API 列了未实现的 kind、
// README 的 CI 矩阵与模型 id 过时、开发者指南的 API 表漏了一半 @stable 导出、
// 发布说明写着"待发布"而版本早发了、唯一的坏链没人发现。
// 这些都不是能力问题，是**没有守卫**。本脚本一次把可机械判定的那些钉住：
//   ① 相对链接必须解析得到文件（F-L1）
//   ② 每个 CLI 分发的子命令必须出现在 --help（F-L6）
//   ③ PACK-API 里点名的 constraint kind 必须在 KINDS 里，或就地标注"未实现"（F-M5）
//   ④ README/DEVELOPER 提到的模型 id 必须存在于 MODELS，旧名必须标注（F-M12）
//   ⑤ ARCHITECTURE.md 必须提到**每一个** src 模块（F-H1，防再次滞后）
//   ⑥ 变异总数（文档 vs 脚本里的 name: 条数）（F-M1）
//   ⑦ 开发者指南的 API 表必须等于从 src/index.js 生成的表（F-M4）
//   ⑨ 测试不得写死监听端口（固定端口在 CI 并发时 EADDRINUSE）
//   ⑩ src/** 不得残留变异补丁标记（`// 变异：`）——v0.6.30 实测有一处被提交进主线
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string[]} */
const problems = [];
const rel = (/** @type {string} */ p) => path.relative(root, p).split(path.sep).join('/');
const tracked = (() => {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.coverage' || e.name === 'dist') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out.push(f);
    }
  };
  walk(root);
  return out;
})();

// ① 相对链接（唯一的坏链曾被报告点名）
{
  let checked = 0;
  for (const f of tracked.filter((p) => p.endsWith('.md'))) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#|tel:)/.test(target)) continue;
      const clean = target.split('#')[0];
      if (!clean) continue;
      checked += 1;
      const abs = path.resolve(path.dirname(f), decodeURIComponent(clean));
      if (!fs.existsSync(abs)) problems.push(`坏链：${rel(f)} → ${target}`);
    }
  }
  console.log(`① 相对链接：检查 ${checked} 条`);
}

// ② CLI 分发表 ⊆ --help（help 是单源的，漏列等于用户看不到命令）
//
// 事故（v0.8.1 审计实测）：v0.8.0 把 `main()` 里的 `dispatchTable` 提成了模块常量
// `DISPATCH_TABLE`（少一层缩进、不占函数行数），但这里的正则还锚在旧的
// `const dispatchTable` + 6 空格缩进上——于是匹配到 **0 个**，而 `keys.length === 0`
// 让下面的 `for` 一条都不检查，2 行后照样打印「help 文本已核对」并判绿。
// **空守卫是最坏情况**：它不会误报，只会让后面所有命令永久免检，比单条断言写错危险得多。
// 所以现在的口径是 fail-closed：
//   ① 解析器改为直接读模块常量 `DISPATCH_TABLE` 的对象字面量（括号配平 + 只取一级键名），
//      不再依赖缩进/变量名大小写/`= /** @type */ ({` 这类包装写法；
//   ② 解析到 0 个 → 判红（「什么都没找到」不能等于「全部正确」）；
//   ③ 解析结果 < DISPATCH_MIN_KEYS（15）→ 也判红：这是**解析器退化自检**，不是命令数产品要求。
//      为什么是 15 而不是当前值 20：留 5 个的余量，让「真删了 3-4 个命令」不误伤，又能在
//      解析器再次静默只抓到一半（或换写法后抓到 0-14 个）时立刻红；否则 ② 会再次变成空转。
const DISPATCH_MIN_KEYS = 15;

/**
 * 从 `src/cli.js` 源码里解析出 `DISPATCH_TABLE` 的**一级键名**。
 *
 * 不按缩进/行首匹配（那正是 v0.8.1 失效的原因），而是：定位 `DISPATCH_TABLE =` 后的
 * 第一个 `{`，逐字符括号配平走到对应的 `}`，只收 depth === 1 且位于行首位置的 `键:`。
 * 字符串/模板/注释里的 `{` `}` `:` 都不参与配平（否则 `handler: 'a{b'` 之类会跑偏）。
 *
 * 兼容性：`const DISPATCH_TABLE = {…}`、带 JSDoc 类型注解再包一层括号的写法、
 * `const DISPATCH_TABLE = Object.freeze({…})` 都能解析；键名可带引号。
 *
 * @param {string} src
 * @returns {{ keys: string[], reason: string }}（解析失败时 keys 为 []，reason 说明原因）
 */
function parseDispatchKeys(src) {
  const anchor = /\bDISPATCH_TABLE\b\s*(?::[^=;{]*?)?=(?!=)/.exec(src);
  if (!anchor) return { keys: [], reason: '未找到 DISPATCH_TABLE 赋值' };
  // 找对象字面量的 `{`：必须跳过 `= /** @type {Record<...>} */ (` 这类注释/包装，
  // 否则会把 JSDoc 里的 `{Record` 当成表体（v0.8.0 正是这种写法）。
  let braceStart = -1;
  for (let i = anchor.index + anchor[0].length; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end - 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return { keys: [], reason: 'DISPATCH_TABLE 赋值后的块注释没有结束' };
      i = end + 1;
      continue;
    }
    if (ch === '{') { braceStart = i; break; }
    if (ch === ';') break; // 赋值语句已结束却没有对象字面量
  }
  if (braceStart < 0) return { keys: [], reason: 'DISPATCH_TABLE 赋值后没有对象字面量' };
  /** @type {string[]} */
  const keys = [];
  let depth = 0;
  let lineStart = false;
  for (let i = braceStart; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    // 一级键名：只认「行首第一个 token 且紧跟冒号」，嵌套对象的 module/handler 在 depth 2。
    // 必须在字符串分支之前判：键名本身可能就是带引号的（`'update': {...}`）。
    if (depth === 1 && lineStart) {
      const m = /^([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:/.exec(src.slice(i, i + 120));
      if (m) keys.push(m[1].replace(/^['"]|['"]$/g, ''));
      lineStart = false;
    }
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      lineStart = true; // 跳过行注释后就是下一行行首
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) break;
      if (src.slice(i, end).includes('\n')) lineStart = true;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      for (i += 1; i < src.length; i += 1) {
        if (src[i] === '\\') { i += 1; continue; }
        if (src[i] === quote) break;
        if (quote === '`' && src[i] === '\n') lineStart = false;
      }
      lineStart = false;
      continue;
    }
    if (ch === '\n') { lineStart = true; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) break; // 分发表结束
      lineStart = false;
      continue;
    }
    if (ch === '{') { depth += 1; lineStart = false; continue; }
    lineStart = false;
  }
  if (!keys.length) return { keys, reason: '对象字面量里没解析到一级键名（写法变了？）' };
  return { keys, reason: '' };
}

// ② CLI 分发表 ⊆ --help（help 是单源的，漏列等于用户看不到命令）
{
  const cli = fs.readFileSync(path.join(root, 'src', 'cli.js'), 'utf8');
  const { keys, reason } = parseDispatchKeys(cli);
  const { helpLines } = await import(pathToFileURL(path.join(root, 'src', 'help.js')).href);
  const text = helpLines({ variant: 'cli' })
    .map(([line]) => String(line))
    .join('\n');
  // help 里的命令以「mingdao <cmd>」为首词出现；复合行（mingdao ledger list/show/…）取首词。
  const helpCmds = new Set([...text.matchAll(/mingdao\s+([a-z][a-z0-9-]*)/g)].map((m) => m[1]));
  const matched = keys.filter((k) => helpCmds.has(k));
  if (!keys.length) {
    problems.push(
      `CLI 分发表解析到 0 个子命令（${reason}）——空守卫会让后续命令全部免检，按失败处理。` +
        ' 请检查 src/cli.js 的 DISPATCH_TABLE 写法是否变化，并同步 scripts/doc-lint.mjs 的解析器'
    );
  } else if (keys.length < DISPATCH_MIN_KEYS) {
    problems.push(
      `CLI 分发表只解析到 ${keys.length} 个子命令（< ${DISPATCH_MIN_KEYS}）——大概率是解析器退化了，` +
        '不是命令真的只剩这几个。这条自检就是防止 ② 再次静默空转'
    );
  }
  for (const k of keys) {
    if (!helpCmds.has(k)) problems.push(`--help 漏掉了子命令：${k}（src/cli.js 分发它）`);
  }
  console.log(
    `② 子命令覆盖：分发 ${keys.length} 个（自检下限 ${DISPATCH_MIN_KEYS}），help 对齐 ${matched.length}/${keys.length} 个`
  );
}

// ③ PACK-API 的 kind 表（未实现的必须就地标注）
{
  const cs = fs.readFileSync(path.join(root, 'src', 'constraints.js'), 'utf8');
  const kinds = new Set([...((/KINDS = new Set\(\[([^\]]*)\]\)/.exec(cs) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  const pak = fs.readFileSync(path.join(root, 'docs', 'PACK-API.md'), 'utf8');
  const known = new Set([...fs.readFileSync(path.join(root, 'src', 'packs.js'), 'utf8').matchAll(/require-citation/g)].map(() => 'require-citation'));
  let seen = 0;
  for (const line of pak.split('\n')) {
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`([a-z][a-z-]{2,})`/g)) {
      const kind = m[1];
      const looksLikeKind = kind.includes('-') && (kinds.has(kind) || known.has(kind) || /-forbid$|-require$|^completeness$/.test(kind));
      if (!looksLikeKind) continue;
      seen += 1;
      if (!kinds.has(kind) && !/未实现/.test(line)) problems.push(`PACK-API.md 把未实现的 kind 当成可用：${kind}（该行未标注"未实现"）`);
    }
  }
  console.log(`③ PACK-API kind：KINDS=${kinds.size} 个，表中提及 ${seen} 处`);
}

// ④ 模型 id（README/DEVELOPER 提到的必须在 MODELS 里；旧名必须标注）
{
  const modelsSrc = fs.readFileSync(path.join(root, 'src', 'models.js'), 'utf8');
  const models = new Set([...modelsSrc.matchAll(/^\s{2}'([a-z0-9][\w.-]*)':\s*\{/gm)].map((m) => m[1]));
  const legacy = new Set([...((/MODEL_ALIASES = \{([^}]*)\}/.exec(modelsSrc) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  let seen = 0;
  for (const f of ['README.md', 'docs/DEVELOPER.md'].map((x) => path.join(root, x))) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      for (const m of line.matchAll(/`(deepseek-[a-z0-9.-]+)`/g)) {
        const id = m[1];
        seen += 1;
        if (!models.has(id)) problems.push(`${rel(f)} 提到不存在的模型 id：${id}`);
        else if (legacy.has(id) && !/旧名|兼容|改名/.test(line)) problems.push(`${rel(f)} 用了旧模型名 ${id} 但没标注（官方已改名）`);
      }
    }
  }
  console.log(`④ 模型 id：MODELS=${models.size} 个、旧名 ${legacy.size} 个，文档提及 ${seen} 处`);
}

// ⑤ ARCHITECTURE.md 必须覆盖全部 src 模块（防再次滞后到 v0.1.x 口径）
{
  const arch = fs.readFileSync(path.join(root, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const mods = tracked.filter((p) => p.includes(`${path.sep}src${path.sep}`) && p.endsWith('.js')).map((p) => rel(p).slice(4));
  const missing = mods.filter((m) => !arch.includes(m) && !arch.includes(path.basename(m)));
  if (missing.length) problems.push(`docs/ARCHITECTURE.md 未提到 ${missing.length}/${mods.length} 个 src 模块：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' …' : ''}`);
  console.log(`⑤ 架构文档：src 模块 ${mods.length} 个，未提及 ${missing.length} 个`);
}

// ⑥ 变异总数（文档写的必须等于脚本里真实的 name: 条数）
{
  const dir = path.join(root, 'test', 'mutate');
  const files = fs.readdirSync(dir).filter((f) => /^batch.*\.mjs$/.test(f));
  let actual = 0;
  for (const f of files) actual += [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s{2}name:\s*'/gm)].length;
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  const claimed = Number((/变异总数[:：]\s*(\d+)/.exec(readme) || [0, NaN])[1]);
  if (!Number.isFinite(claimed)) problems.push('test/mutate/README.md 必须写明「变异总数：N」（供守卫比对）');
  else if (claimed !== actual) problems.push(`变异总数不一致：README 写 ${claimed}，脚本里实际 ${actual} 条`);
  console.log(`⑥ 变异总数：实际 ${actual} 条（README 写 ${claimed}）`);
}

// ⑦ 开发者指南的 API 表
{
  const { renderTable } = await import(pathToFileURL(path.join(root, 'scripts', 'gen-api-table.mjs')).href);
  const want = renderTable().split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
  const dev = fs.readFileSync(path.join(root, 'docs', 'DEVELOPER.md'), 'utf8');
  const got = dev.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| ---') && !l.startsWith('| 分组'));
  const missing = want.filter((l) => !got.includes(l));
  if (missing.length) problems.push(`docs/DEVELOPER.md 的 API 表与 src/index.js 不一致（缺 ${missing.length} 组，跑 node scripts/gen-api-table.mjs 重新生成）`);
  console.log(`⑦ API 表：应有 ${want.length} 组`);
}

// ⑧ 只读工具集合：文档里点名的必须与 READONLY_TOOLS 一致
{
  const tools = fs.readFileSync(path.join(root, 'src', 'tools', 'index.js'), 'utf8');
  const ro = new Set([...((/READONLY_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(tools) || ['', ''])[1].matchAll(/'([^']+)'/g))].map((m) => m[1]));
  const docs = ['docs/CONFIG.md', 'docs/ARCHITECTURE.md'].map((x) => path.join(root, x)).filter((p) => fs.existsSync(p));
  for (const f of docs) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/只读[^\n]*?\(?((?:read|ls|glob|grep|skill|git|fetch)(?:\/(?:read|ls|glob|grep|skill|git|fetch))+)\)?/g)) {
      for (const name of m[1].split('/')) if (!ro.has(name)) problems.push(`${rel(f)} 把 ${name} 列为只读，但 READONLY_TOOLS 里没有`);
    }
  }
  console.log(`⑧ 只读工具：READONLY_TOOLS=${[...ro].join('/')}`);
}

// ⑨ 测试监听端口：test/** 不得写死四位端口（固定端口在 CI 并发时被占用 → EADDRINUSE 假红）
//
// 背景（v0.6.19 §3.76）：`6927bd8` 的 node18 腿因 §145 的固定端口 45998 `EADDRINUSE` 红过一次，
// 同一条 smoke 重跑即绿——不是代码缺陷，是测试自己抢端口。临时端口只有一个正确写法：
// `server.listen(0)` 后读 `server.address().port`（先写配置再 spawn 的场景也先 listen(0) 拿端口）。
// 这里做结构检查而不是运行时探测：让"下一次又写死端口"在 doc-lint（CI 必跑）就红。
{
  const testDir = path.join(root, 'test');
  const files = tracked.filter(
    (p) => p.startsWith(testDir + path.sep) && /\.(?:m?js)$/.test(p) && !p.includes(`${path.sep}.generated${path.sep}`)
  );
  /** @type {string[]} */
  const hits = [];
  for (const f of files) {
    // 块注释整段抹成空白（保留行号）；行注释按行剔除。注释里可以写历史端口，不算违规。
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*\/\/.*$/, '').replace(/(^|[^:'"`\\])\/\/.*$/, '$1');
      const m = code.match(/\blisten\(\s*([45]\d{4})\b/);
      if (m) hits.push(`${rel(f)}:${i + 1} → listen(${m[1]})`);
    });
  }
  if (hits.length) {
    problems.push(
      `test/** 里出现固定四位监听端口 ${hits.length} 处：${hits.slice(0, 8).join('；')}${hits.length > 8 ? ' …' : ''}。` +
        '测试必须用 listen(0) 取临时端口，避免 CI 端口冲突（固定端口会 EADDRINUSE，见 §3.76）'
    );
  }
  console.log(`⑨ 测试端口：扫描 ${files.length} 个测试文件，固定四位 listen 端口 ${hits.length} 处`);
}


// ⑩ 变异残留：src/** 不得出现变异补丁标记
// 事故（v0.6.30）：变异框架会把文件改写成补丁、跑完在 finally 里还原；若在**变异在飞**时提交
// （或强杀 mutator），`// 变异：…` 的补丁就会进主线——实测 `74ec0a1` 把 `pendingTool: null
// // 变异：等待中的工具不可见` 提交了，等于把"等待中的工具在界面上不可见"这个缺陷随版本发布。
// 这里扫源码文本：出现标记即 CI 红（fail-closed）。变异脚本本身在 test/mutate/ 下，不受此限。
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.js')) files.push(f);
    }
  };
  walk(path.join(root, 'src'));
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\/\/\s*变异[：:]/.test(line)) hits.push(`${rel(f)}:${i + 1} → ${line.trim().slice(0, 90)}`);
    });
  }
  if (hits.length) {
    problems.push(
      `src/** 残留变异补丁标记 ${hits.length} 处：${hits.slice(0, 5).join('；')}` +
        '。变异必须由 mutator 在 finally 还原；带着残留提交等于把缺陷随版本发布'
    );
  }
  console.log(`⑩ 变异残留：扫描 ${files.length} 个源码文件，残留标记 ${hits.length} 处`);
}

if (problems.length) {
  console.error(`\n✗ 文档守卫发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error('  · ' + p);
  console.error('\n（这些守卫的意义是：文档漂移在 CI 就红，而不是等第三方审计指出。）');
  process.exit(1);
}
console.log('\n✓ 文档守卫全部通过');
