#!/usr/bin/env node
// scripts/measure-cache.mjs —— 开发用：在**真实 DeepSeek 端点**上量一次「上下文缓存命中率」。
//
// 手动运行（不进 CI、不进 test/run-all.mjs、不进 npm 包）：
//   node scripts/measure-cache.mjs            # 6 次请求，单次 prompt ≤2000 token，成本几分钱
//   node scripts/measure-cache.mjs --dry-run  # 只做本地检查 + 打印计划，不花一分钱
//   node scripts/measure-cache.mjs --full     # 用真实 home 的完整 system prompt（会 >2000 token，仅本机自查）
//
// 为什么需要它：DeepSeek 的上下文缓存是**前缀字节匹配**（64 token 粒度），命中部分按约 1/10 价计费，
// 且「缓存前缀单元」必须在后续请求里**完整命中**才算（官方 Context Caching 文档）。所以「命中率低」
// 只有一个可测的定义：每轮请求的前缀在变，或新增长度过大。本脚本把这件事拆成四处：
//   ① 基线：同一请求重复两次 → 第二次必须接近 100%（证明账号/端点/等待时间足够）
//   ② 工具集字节：**只换 tools、消息一模一样**再发一次 → 命中应掉到 ≈0（tools 在前缀最前面）
//   ③ MDH 真实 system prompt + 真实工具集：两次构建/序列化是否逐字节相同；同请求再发一次是否 ≈100%
//   ④ 模拟一回合追加：同一前缀 + assistant 回复 + 新 user → 命中率应≈前缀占比
//
// 只读 usage.prompt_cache_hit_tokens / prompt_tokens，**非流式**。凭据只从本机读取，不打印、不外发。
// 硬约束：请求数 ≤6、单次 prompt ≤2000 token。超限直接中止，而不是偷偷跑贵的。
//
// 注意「缓存构建需要数秒」（官方文档）：重复请求之间默认等 5s（--delay-ms 可调），否则还没写完
// 缓存就发第二次，量出来的是"缓存没建好"而不是"前缀不稳定"——这正是第一次实测踩过的坑。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = hasFlag('--dry-run');
const FULL = hasFlag('--full');
/**
 * `--pad <token>`：在 MDH 真实 system 之后**前置**一段确定性的合成历史，把 prompt 撑到约 N token，
 * 用来验证「端点固定未缓存尾段」在大 prompt 下被稀释到 <1%（小 prompt 上它占百分之十几，
 * 容易让人误以为实现有问题）。带 --pad 时跳过 ④（保持请求数 ≤6）。
 */
const PAD = Math.max(0, Number(argOf('--pad', '0')) || 0);
const MAX_REQUESTS = 6;
const MAX_PROMPT_TOKENS = 2000;
const DELAY_MS = Math.max(0, Number(argOf('--delay-ms', '5000')) || 0);

const realHome = process.env.MINGDAO_HOME || path.join(os.homedir(), '.mingdao');
const workingDir = argOf('--working-dir', root);

// ---------- 0. 凭据 / 端点（只读本机，不打印） ----------
function readJsonSafe(/** @type {string} */ p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
const cfg = readJsonSafe(path.join(realHome, 'config.json')) || {};
const creds = readJsonSafe(path.join(realHome, 'credentials.json')) || {};
const providerKey = String(argOf('--provider', cfg.provider || 'deepseek'));
const model = String(argOf('--model', cfg.model || 'deepseek-flash'));
const baseUrl = String(argOf('--base-url', cfg.baseUrl || 'https://api.deepseek.com/v1')).replace(/\/+$/, '');
const apiKey = String(argOf('--key', process.env.DEEPSEEK_API_KEY || creds[providerKey] || ''));
const timeoutMs = Number(argOf('--timeout', '120000'));

const { buildSystemPrompt } = await load('src/prompts.js');
const { buildToolSchemas } = await load('src/tools/index.js');
const { visibleToolsFor, usedToolNamesFromMessages } = await load('src/tools-flow.js');
const { wireMessages } = await load('src/context.js');
const { makeTokenCounter } = await load('src/tokenizer.js');
const counter = makeTokenCounter(model);
const sha = (/** @type {string} */ s) => crypto.createHash('sha256').update(s).digest('hex');
const shaJson = (/** @type {any} */ v) => sha(JSON.stringify(v));

/**
 * 与 `agent.js` 默认路径同一判据：schemaTier 未开启时，可见工具只取决于 cfg/preset/MCP
 * （会话内恒定）——readOnlyPhase 恒 false、剥描述集合恒空。
 */
function toolsForDefault() {
  return visibleToolsFor(buildToolSchemas(new Set(), []), {
    readOnlyPhase: false,
    usedNames: new Set(),
    presetToolSet: null,
    isMcpReadonly: null,
  });
}

/** 旧默认行为（schemaTier=true 才允许）：只读档收缩 + 已用工具剥描述。这里用来量它的缓存代价。 */
function toolsOptInOldBehavior(/** @type {any[]} */ history) {
  const used = usedToolNamesFromMessages(history);
  return visibleToolsFor(buildToolSchemas(used, []), {
    readOnlyPhase: false,
    usedNames: used,
    presetToolSet: null,
    isMcpReadonly: null,
  });
}

/** 首个差异位置（行 + 字符级上下文），不贴全文——只用于回答「哪一段在变」。 */
function firstDiff(/** @type {string} */ a, /** @type {string} */ b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  if (i === n && a.length === b.length) return null;
  const ctx = (/** @type {string} */ s) => JSON.stringify(s.slice(Math.max(0, i - 24), i + 40));
  return { at: i, line: a.slice(0, i).split('\n').length, ctxA: ctx(a), ctxB: ctx(b), delta: b.length - a.length };
}

/** 估算一次 chat 请求的 prompt token（messages + tools 的 JSON 口径，偏保守）。 */
function estimatePrompt(/** @type {any[]} */ messages, /** @type {any[]|null|undefined} */ tools) {
  let n = 0;
  for (const m of messages) n += counter(JSON.stringify(m)) + 4;
  if (tools) n += counter(JSON.stringify(tools));
  return n + 8;
}

/** @type {{label: string, prompt: number, hit: number, miss: number, pct: number, ms: number}[]} */
const rows = [];

async function callApi(/** @type {string} */ label, /** @type {any[]} */ messages, /** @type {any[]|null|undefined} */ tools) {
  const est = estimatePrompt(messages, tools);
  if (est > MAX_PROMPT_TOKENS && !FULL && !PAD) {
    throw new Error(`${label}：估算 prompt ${est} token > ${MAX_PROMPT_TOKENS}（加 --full 显式放开）`);
  }
  if (rows.length >= MAX_REQUESTS) throw new Error(`请求数上限 ${MAX_REQUESTS}：${label}`);
  const body = /** @type {any} */ ({ model, messages, temperature: 0, max_tokens: 8, stream: false });
  if (tools) body.tools = tools;
  if (DRY) {
    console.log(`· [dry-run] ${label}：估算 ${est} token，sha256=${shaJson({ messages, tools: tools || null }).slice(0, 16)}`);
    return null;
  }
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`${label}：HTTP ${res.status} ${String(text).slice(0, 300)}`);
  const u = json?.usage || {};
  const prompt = Number(u.prompt_tokens) || 0;
  const hit = Number.isFinite(u.prompt_cache_hit_tokens) ? Number(u.prompt_cache_hit_tokens) : 0;
  const miss = Number.isFinite(u.prompt_cache_miss_tokens) ? Number(u.prompt_cache_miss_tokens) : prompt - hit;
  const row = { label, prompt, hit, miss, pct: prompt ? (hit / prompt) * 100 : 0, ms: Date.now() - t0 };
  rows.push(row);
  console.log(
    `  ${label.padEnd(36)} hit ${String(hit).padStart(6)} / prompt ${String(prompt).padStart(6)} ` +
      `= ${row.pct.toFixed(1).padStart(5)}%   （miss ${miss}，${row.ms}ms）`
  );
  return row;
}

const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 本地证据（零请求）：system prompt 逐字节稳定性 ----------
console.log(`\n== ① 本地：MDH system prompt 构建 3 次（工作目录 ${workingDir}）==`);
const realPrompt = buildSystemPrompt({ workingDir, withJournal: false });
const realHashes = new Set();
for (let i = 0; i < 3; i += 1) realHashes.add(sha(buildSystemPrompt({ workingDir, withJournal: false })));
console.log(
  `  真实 home（${realHome}）：${realPrompt.length} 字符 / ${counter(realPrompt)} token，` +
    `3 次 sha256 ${realHashes.size === 1 ? '一致 ✅' : `不一致 ❌（${[...realHashes].map((h) => h.slice(0, 12)).join(', ')}）`}`
);

// 端点测量用的 home：干净 fixture，让 system prompt 稳定落在 ≤2000 token 内（真实 home 的用户记忆+技能
// 会把它推到 ~2000+；--full 时才用真实 home）。两者走的是**同一个 builder**。
const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-cache-home-'));
process.env.MINGDAO_HOME = cleanHome;
const sysPrompt = FULL ? realPrompt : buildSystemPrompt({ workingDir, withJournal: false });
const cleanHashes = new Set();
for (let i = 0; i < 3; i += 1) cleanHashes.add(sha(buildSystemPrompt({ workingDir, withJournal: false })));
process.env.MINGDAO_HOME = realHome;
fs.rmSync(cleanHome, { recursive: true, force: true });
console.log(
  `  端点测量用 home（干净 fixture，${FULL ? '**--full：实际发真实 home 的 prompt**' : '同 builder、无用户记忆/技能'}）：` +
    `${sysPrompt.length} 字符 / ${counter(sysPrompt)} token，3 次 sha256 ${cleanHashes.size === 1 ? '一致 ✅' : '不一致 ❌'}`
);

// ---------- 2. 本地证据：MDH 工具集序列化 + 回合边界 ----------
console.log('\n== ② 本地：MDH 真实工具集序列化（默认路径 vs schemaTier=true 旧行为）==');
const sysTools = toolsForDefault();
console.log(
  `  默认路径（${sysTools.length} 个工具）：3 次序列化 sha256 ` +
    `${new Set([shaJson(sysTools), shaJson(sysTools), shaJson(sysTools)]).size === 1 ? '一致 ✅' : '不一致 ❌'}：` +
    `${shaJson(sysTools).slice(0, 16)}（${counter(JSON.stringify(sysTools))} token）`
);

// 回合一（提问）→ 用过 read/write → 回合二（WebUI 每回合 createAgent，进程内状态清零）
const historyAfterTurn1 = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'write', arguments: '{}' } }] },
];
const states = [
  ['回合1 第1次请求（纯提问，默认路径）', toolsForDefault()],
  ['回合1 用过 read/write 后（默认路径）', toolsForDefault()],
  ['回合2 第1次请求（新 agent，历史里有 read/write；默认路径）', toolsForDefault()],
  ['对照：schemaTier=true 旧行为（回合2 第1次请求）', toolsOptInOldBehavior(historyAfterTurn1)],
];
for (const [label, arr] of states) {
  console.log(`  ${label.padEnd(52)} sha256 ${shaJson(arr).slice(0, 16)}  ${String(counter(JSON.stringify(arr))).padStart(4)} token`);
}
const defaultStates = states.slice(0, 3).map(([, arr]) => shaJson(arr));
console.log(
  defaultStates.every((h) => h === defaultStates[0])
    ? '  ✅ 默认路径：三个回合状态 tools 字节完全相同（前缀缓存不会在回合边界失效）'
    : '  ❌ 默认路径：回合边界上 tools 字节不一致'
);
const churn = firstDiff(JSON.stringify(states[2][1]), JSON.stringify(states[3][1]));
if (churn) {
  console.log(`  ⚠ 对照（schemaTier=true）：同一会话内 tools 字节在第 ${churn.at} 字符处变化，${churn.delta > 0 ? '+' : ''}${churn.delta} 字符`);
  console.log(`      前：${churn.ctxA}`);
  console.log(`      后：${churn.ctxB}`);
  console.log('      → 这正是不稳定来源：tools 在前缀最前面，字节一变整段历史按未命中价重计。');
}

// ---------- 3. 本地证据：消息跨回合被改写（ts） ----------
console.log('\n== ③ 本地：消息跨回合字节（appendMessages → loadSession → 上线形态）==');
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-cache-sess-'));
  process.env.MINGDAO_HOME = tmpHome;
  const { createSession, appendMessages, loadSession } = await load('src/session.js');
  const { ensureHome } = await load('src/config.js');
  ensureHome();
  const session = createSession(tmpHome);
  const sent = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U1' },
    { role: 'assistant', content: 'A1' },
  ];
  // 关键：**先**拍下"发给端点时的字节"，再落盘（appendMessages 会就地补 ts）
  const wireBefore = JSON.stringify(wireMessages(sent));
  appendMessages(session.file, sent.slice(1)); // 落盘：与 web 路径同一函数（补 ts）
  const reloaded = loadSession(session.file, null).messages;
  const rawDiff = firstDiff(JSON.stringify(sent), JSON.stringify([sent[0], ...reloaded]));
  const wireAfter = JSON.stringify(wireMessages([sent[0], ...reloaded]));
  if (rawDiff) {
    console.log(`  磁盘读回的消息比发送时多出字段（第 ${rawDiff.at} 字符处，行 ${rawDiff.line}）：${rawDiff.ctxB} —— ts 是本地时间戳。`);
  }
  console.log(
    wireBefore === wireAfter
      ? '  ✅ 上线形态（wireMessages：只发 role/content/tool_calls/… 协议字段）跨回合字节一致'
      : '  ❌ 上线形态跨回合字节不一致（本地字段漏到请求里了）'
  );
  process.env.MINGDAO_HOME = realHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

// ---------- 4. 端点测量 ----------
if (!apiKey) {
  console.error(`\n✗ 没有可用的 API Key（${path.join(realHome, 'credentials.json')} 的 ${providerKey} 键，或 --key / DEEPSEEK_API_KEY）`);
  process.exit(2);
}
console.log(`\n== ④ 端点测量（${model} @ ${baseUrl}，非流式，max_tokens=8，请求数 ≤${MAX_REQUESTS}，重复请求间隔 ${DELAY_MS}ms）==`);

const baseMessages = [{ role: 'system', content: 'S:只回复 ok' }, { role: 'user', content: 'U:只回复 ok' }];
const toolsA = toolsForDefault().filter((t) => ['read', 'write', 'edit', 'grep'].includes(t.function?.name));
const toolsB = toolsOptInOldBehavior(historyAfterTurn1).filter((t) => ['read', 'write', 'edit', 'grep'].includes(t.function?.name));

// ① 基线（2 次请求）
const r1 = await callApi('①-1 基线：固定 system+tools+user', baseMessages, toolsA);
await wait(DELAY_MS);
const r2 = await callApi('①-2 同一请求（应≈100%）', baseMessages, toolsA);
// ② 工具集变化探测（1 次请求）：消息一字不差，只把 tools 换成"剥描述态"
await wait(DELAY_MS);
const r3 = await callApi('② 只换 tools（消息不变）', baseMessages, toolsB);

// ③ MDH 真实 system + 真实工具子集（2 次请求，逐字节相同）
const mdhMessages = [{ role: 'system', content: sysPrompt }, { role: 'user', content: 'U:只回复 ok，不要调用任何工具。' }];
/** 合成一段确定性的历史（内容固定 → 前缀字节稳定），把 prompt 撑到 ~PAD token。 */
function paddedHistory(/** @type {number} */ targetTokens) {
  if (!targetTokens) return [];
  const filler = '背景资料（用于把上下文撑到目标长度，内容固定以保证前缀字节稳定）。'.repeat(4);
  /** @type {any[]} */
  const out = [];
  let n = estimatePrompt(mdhMessages, toolsA);
  while (n < targetTokens) {
    out.push({ role: 'user', content: `第 ${out.length + 1} 段资料：${filler}` });
    out.push({ role: 'assistant', content: '已记录。' });
    n += counter(filler) + 40;
  }
  return out;
}
const pad = paddedHistory(PAD);
if (pad.length) mdhMessages.splice(1, 0, ...pad);
await wait(DELAY_MS);
const r4 = await callApi(PAD ? `③-1 MDH system+tools（+${PAD} token 合成历史）` : '③-1 MDH system+tools', mdhMessages, toolsA);
await wait(DELAY_MS);
const r5 = await callApi('③-2 同一请求（应≈100%）', mdhMessages, toolsA);

// ④ 模拟一回合追加（1 次请求；--pad 时跳过，保持请求数上限）
/** @type {any} */
let r6 = null;
if (!PAD) {
  await wait(DELAY_MS);
  r6 = await callApi('④ 前缀 + assistant + 新 user', [
    ...mdhMessages,
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '继续：再回复一次 ok。' },
  ], toolsA);
}

// ---------- 5. 三段结论 ----------
console.log('\n== 结论 ==');
const sysOk = realHashes.size === 1 && cleanHashes.size === 1;
console.log(
  `① system/tools 稳定性：system prompt 3 次构建 ${sysOk ? 'sha256 一致' : 'sha256 不一致'}；` +
    `默认路径 tools 3 次序列化 ${new Set(states.slice(0, 3).map(([, a]) => shaJson(a))).size === 1 ? '一致' : '不一致'}` +
    `，且回合边界字节${defaultStates.every((h) => h === defaultStates[0]) ? '不变 ✅' : '变化 ❌'}` +
    `（对照：schemaTier=true 的旧行为会变 ${churn ? '❌' : '—'}）`
);
if (r2) {
  console.log(
    `② 同一请求重复：${r2.hit}/${r2.prompt} = ${r2.pct.toFixed(1)}%（可缓存前缀已全部命中；尾段见 ③ 的说明）` +
      `${r3 ? `；**只换 tools**（消息一字不差）→ ${r3.hit}/${r3.prompt} = ${r3.pct.toFixed(1)}%（差 ${(r2.pct - r3.pct).toFixed(1)} 个百分点）` : ''}`
  );
  if (r3 && r3.pct < r2.pct * 0.5) {
    console.log('   → tools 位于缓存前缀最前面：只换它就让整段前缀作废。默认关闭 schemaTier 的理由即此。');
  }
}
if (r5) {
  console.log(`   MDH system+tools 重复请求：${r5.pct.toFixed(1)}%（${r5.pct >= 95 ? '前缀稳定、可被整体命中 ✅' : '前缀没能整体命中 ❌'}）`);
}
if (r4 && r6) {
  const prefixShare = (r4.prompt / r6.prompt) * 100;
  const samePrefix = r5 ? r6.hit === r5.hit : false;
  console.log(
    `③ 一回合追加的命中率：实测 ${r6.pct.toFixed(1)}%（前缀 ${r4.prompt} / 总 ${r6.prompt} token = 前缀占比 ${prefixShare.toFixed(1)}%）`
  );
  console.log(
    `   与重复请求的命中量对比：${samePrefix ? `完全相同（${r6.hit}）→ 前缀 100% 被复用，只多付新增的 ` +
      `${r6.prompt - r4.prompt} token 与端点固定尾段 ✅` : `不同（${r6.hit} vs ${r5?.hit}）→ 追加动作动了前缀 ❌`}`
  );
  console.log(
    `   注意：${r4.miss} token 的"未命中"即使是**逐字节相同**的重复请求也一样不命中（见 ③-1/③-2 的 hit 相同）` +
      `——那是端点侧缓存单元粒度造成的固定尾段，在 1~2K 的小 prompt 上占百分之十几，` +
      `在真实 20K+ 会话里 <1%，不是 MDH 的不稳定性。`
  );
}
const lowest = rows.reduce((a, b) => (a && a.pct <= b.pct ? a : b), null);
if (lowest && lowest !== r1 && lowest.pct < 95 && lowest !== r3 && lowest !== r4) {
  console.log(`   最低命中出现在「${lowest.label}」：看上面 ②/③ 的字节变化行，第一个变化点就是元凶所在段。`);
}
console.log(
  '\n自测口径：命中率 <95% 时，先看本地 ①②③ 三段的 sha256/字节差异——system、tools、消息体三者里' +
    '先变的那一段就是根因；再对照 ④ 的前缀占比，判断是"前缀变了"还是"新增太多"。'
);
