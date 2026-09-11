// 垂域 Pack 加载器（v0.5.0 阶段 A，Pack API v1）。
//
// Pack = 一个声明式 + 可编程的「领域包」：manifest（pack.json）+ contributions（pack.mjs）。
// 让垂域团队（中医/法律/教育/制造/政务…）**不改内核源码**就能把领域工具、领域红线、领域提示词
// 接进内核的权限/审计/费用/UI 链路。契约定稿见 docs/PACK-API.md（v1 已冻结）。
//
// 设计要点：
//  - 零依赖：只用 node:fs / node:path / node:url；pack.mjs 由宿主直接 import（无构建步骤）。
//  - 坏 Pack 绝不阻塞启动：每条贡献独立 try/catch，失败只 warn 并跳过（与 config.tools 同口径）。
//  - 加载是**幂等**的：启动路径可能被调用多次（CLI/WebUI/worker），重复加载同名 Pack 直接跳过。
//  - 静态与动态分离：manifest 校验（`pack verify`，下游 CI 用）不 import 任何代码；
//    只有真正 mount 时才 import pack.mjs。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mingdaoHome } from './config.js';
import { registerTool } from './tools/index.js';

/** 本内核支持的 Pack API 主版本 */
export const SUPPORTED_PACK_API = [1];

/** Pack 名：小写字母/数字/连字符，2–32 位（与 PACK-API §2 一致） */
export const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** 保留名：不得被 Pack 占用 */
const RESERVED_PACK_NAMES = new Set(['core', 'mcp', 'mingdao', 'pack', 'builtin']);
/** 工具名白名单（与 registerTool 同一正则） */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** 约束 kind 合法集合（v1） */
export const CONSTRAINT_KINDS = new Set(['tool-deny', 'tool-arg-require', 'arg-forbid', 'output-forbid', 'completeness', 'confirm']);
/** manifest 允许的顶层字段（未知字段拒绝，防拼写错误被静默忽略） */
const KNOWN_MANIFEST_FIELDS = new Set(['apiVersion', 'name', 'displayName', 'version', 'engines', 'description', 'author', 'license', 'permissions', 'contributes', 'budget']);
const KNOWN_CONTRIBUTES = new Set(['tools', 'provider', 'presets', 'promptSections', 'constraints', 'skills', 'commands', 'memorySchema']);

// ---------- 极简 semver（零依赖） ----------

/** @param {any} v @returns {number[]|null} */
function parseVersion(v) {
  // 接受 1–3 段（`0.5`、`0.5.0`、`0.5.0-rc.1` 都合法）——内核版本是 x.y.z，
  // 但用户在 engines 里写 `>=0.5 <0.7` 是更自然的写法，不能被判为非法。
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[\w.]+)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
/** @param {number[]} a @param {number[]} b */
function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 判断 version 是否满足 range。支持（PACK-API §2 用到的形态）：
 *   `*` / 空、`1.2.3`（精确）、`>=1.2.3 <2.0.0`（空格分隔多条件）、`^1.2.3`、`~1.2.3`。
 * @param {any} version @param {any} range
 */
export function satisfiesRange(version, range) {
  const v = parseVersion(version);
  const r = String(range || '*').trim();
  if (!v) return false;
  if (!r || r === '*') return true;
  return r.split(/\s+/).filter(Boolean).every((part) => {
    // 每个 part 可能是 `>=1.2.3`、`<2.0.0`、`1.2.3`、`^1.2.3`、`~1.2.3`
    const m = /^(\^|~|>=|<=|>|<|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part);
    if (!m) return false;
    const op = m[1] || '=';
    const target = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)];
    const c = cmpVersion(v, target);
    if (op === '>=') return c >= 0;
    if (op === '<=') return c <= 0;
    if (op === '>') return c > 0;
    if (op === '<') return c < 0;
    if (op === '=') return c === 0;
    if (op === '^') {
      // npm semver 的 caret：major>0 时锁 major；major=0 时锁 minor；0.0.x 时锁 patch
      if (c < 0) return false;
      if (target[0] !== 0) return v[0] === target[0];
      if (target[1] !== 0) return v[0] === 0 && v[1] === target[1];
      return v[0] === 0 && v[1] === 0 && v[2] === target[2];
    }
    if (op === '~') return c >= 0 && v[0] === target[0] && v[1] === target[1]; // 同 minor
    return false;
  });
}

// ---------- manifest 校验（静态，不 import 代码） ----------

/**
 * 校验 manifest。返回 { ok, errors: string[] }——errors 必须**可操作**（下游 CI 靠它定位问题）。
 * @param {any} m @param {{ coreVersion?: string }} [opts]
 */
export function validateManifest(m, opts = {}) {
  const errors = [];
  const coreVersion = opts.coreVersion || coreVersionOf();
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['manifest 必须是 JSON 对象'] };
  }
  for (const k of Object.keys(m)) {
    if (!KNOWN_MANIFEST_FIELDS.has(k)) errors.push(`未知字段 "${k}"（允许：${[...KNOWN_MANIFEST_FIELDS].join(', ')}）`);
  }
  if (!Number.isInteger(m.apiVersion)) errors.push('apiVersion 必须是整数（当前 v1）');
  else if (!SUPPORTED_PACK_API.includes(m.apiVersion)) {
    errors.push(`apiVersion ${m.apiVersion} 不受支持（本内核支持：${SUPPORTED_PACK_API.join(', ')}）——请升级内核或降级 Pack`);
  }
  if (typeof m.name !== 'string' || !PACK_NAME_RE.test(m.name)) {
    errors.push(`name 非法（需匹配 ${PACK_NAME_RE}）：${JSON.stringify(m.name)}`);
  } else if (RESERVED_PACK_NAMES.has(m.name)) {
    errors.push(`name "${m.name}" 是保留名，不得占用`);
  }
  if (!parseVersion(m.version)) errors.push(`version 必须是 x.y.z 形式：${JSON.stringify(m.version)}`);
  const eng = m.engines && typeof m.engines === 'object' ? m.engines.mingdao : null;
  if (typeof eng !== 'string' || !eng.trim()) {
    errors.push('engines.mingdao 必填（如 ">=0.5 <0.7"）——用于声明兼容的内核版本窗口');
  } else if (!satisfiesRange(coreVersion, eng)) {
    errors.push(`engines.mingdao "${eng}" 不匹配当前内核 ${coreVersion}——请调整窗口或升级/降级内核`);
  }
  if (m.permissions !== undefined) {
    const p = m.permissions;
    if (!p || typeof p !== 'object' || Array.isArray(p)) errors.push('permissions 必须是对象');
    else {
      for (const key of Object.keys(p)) {
        if (!['fs', 'net', 'env'].includes(key)) errors.push(`permissions.${key} 不是可用能力（允许：fs / net / env）`);
      }
      for (const key of ['fs', 'net', 'env']) {
        if (p[key] !== undefined && !Array.isArray(p[key])) errors.push(`permissions.${key} 必须是字符串数组`);
      }
    }
  }
  if (m.budget !== undefined) {
    // v0.5.0 A4.5：Pack 级预算（与日费用护栏同语义）——垂域团队可为自己包住的模型调用设上限
    const b = m.budget;
    if (!b || typeof b !== 'object' || Array.isArray(b)) errors.push('budget 必须是对象');
    else {
      for (const k of Object.keys(b)) {
        if (!['dailyYuan', 'action'].includes(k)) errors.push(`budget.${k} 不是可用字段（允许：dailyYuan / action）`);
      }
      if (b.dailyYuan !== undefined && !(Number(b.dailyYuan) > 0)) errors.push('budget.dailyYuan 必须是正数（元）');
      if (b.action !== undefined && !['warn', 'block'].includes(String(b.action))) errors.push("budget.action 只支持 'warn' 或 'block'");
    }
  }
  if (m.contributes !== undefined) {
    if (!m.contributes || typeof m.contributes !== 'object' || Array.isArray(m.contributes)) {
      errors.push('contributes 必须是对象');
    } else {
      for (const k of Object.keys(m.contributes)) {
        if (!KNOWN_CONTRIBUTES.has(k)) errors.push(`contributes.${k} 不是可贡献项（允许：${[...KNOWN_CONTRIBUTES].join(', ')}）`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------- 目录发现（三级遮蔽） ----------

/** @param {any} [cfg] @param {any} [projectDir] */
export function packDirs(cfg, projectDir) {
  const out = [];
  // 优先级从低到高（后者遮蔽前者）
  // fileURLToPath 而非 url.pathname：后者在含空格/非 ASCII 的路径上会被百分号编码
  out.push({ dir: path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs')), source: 'builtin', priority: 0 });
  out.push({ dir: path.join(mingdaoHome(), 'packs'), source: 'user', priority: 1 });
  if (projectDir) out.push({ dir: path.join(projectDir, '.mingdao', 'packs'), source: 'project', priority: 2 });
  // config.packs 显式声明（优先级最高，按声明顺序后者胜）
  const declared = Array.isArray(cfg?.packs) ? cfg.packs : [];
  declared.forEach((/** @type {any} */ d, /** @type {number} */ i) => out.push({ dir: path.resolve(String(d)), source: 'config', priority: 10 + i }));
  return out;
}

/**
 * 发现全部 Pack 目录（三级遮蔽：同名高优先级胜出）。只读 manifest，不 import 代码。
 * @param {any} [cfg] @param {any} [projectDir]
 */
export function listPacks(cfg, projectDir, opts = {}) {
  const seen = new Map(); // name -> entry
  for (const tier of packDirs(cfg, projectDir).sort((a, b) => a.priority - b.priority)) {
    let entries = [];
    try {
      entries = fs.readdirSync(tier.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(tier.dir, e.name);
      const mf = path.join(dir, 'pack.json');
      if (!fs.existsSync(mf)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
      } catch (/** @type {any} */ err) {
        seen.set(e.name, { name: e.name, dir, source: tier.source, manifest: null, error: `pack.json 解析失败：${err?.message || err}` });
        continue;
      }
      const v = validateManifest(manifest, opts);
      seen.set(manifest?.name || e.name, {
        name: manifest?.name || e.name,
        displayName: manifest?.displayName || '',
        version: manifest?.version || '',
        apiVersion: manifest?.apiVersion,
        dir,
        source: tier.source,
        manifest,
        error: v.ok ? null : v.errors.join('；'),
      });
    }
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/** 用户级 Pack 目录（帮助文案用） */
export function packedDirsForHelp() {
  return path.join(mingdaoHome(), 'packs');
}

/** @returns {string} 当前内核版本 */
export function coreVersionOf() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// ---------- 约束校验（静态） ----------

/** @param {any} c @param {number} i */
function validateConstraint(c, i) {
  const tag = `约束[${i}]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return `${tag} 必须是对象`;
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(c.id)) return `${tag}.id 非法（需 [A-Za-z0-9_-]，≤64）`;
  if (!CONSTRAINT_KINDS.has(c.kind)) return `${tag}.kind 非法（允许：${[...CONSTRAINT_KINDS].join(' / ')}）`;
  if (c.kind === 'tool-deny' || c.kind === 'tool-arg-require' || c.kind === 'arg-forbid' || c.kind === 'completeness') {
    if (typeof c.tool !== 'string' || !c.tool.trim()) return `${tag}（${c.kind}）需要 tool 字段`;
  }
  if (c.kind === 'tool-arg-require' && (typeof c.requireArg !== 'string' || !c.requireArg.trim())) {
    return `${tag}（tool-arg-require）需要 requireArg 字段`;
  }
  if (c.kind === 'completeness' && (!Array.isArray(c.fields) || !c.fields.length)) {
    return `${tag}（completeness）需要非空 fields 数组`;
  }
  if (c.kind === 'output-forbid' && typeof c.pattern !== 'string') return `${tag}（output-forbid）需要 pattern 字段`;
  return null;
}

// ---------- 加载（动态，import pack.mjs） ----------

const loadedPacks = new Map(); // name -> { manifest, contributions }
let mountedTools = 0;
// 进程级「当前 Pack 上下文」：启动路径调用一次 mountPacks 后，agent/prompts 直接取用，
// 避免把 packCtx 一路穿透到每个 createAgent 调用点（调用点有 5+ 处）。
// 未调用 mountPacks 的库使用方拿到 null → 约束/提示词段完全惰性，行为与今天一致。
let activeCtx = /** @type {any} */ (null);

/**
 * 加载单个 Pack 目录：校验 manifest + 文件齐全 + import pack.mjs。
 * 只做「能不能用」的判定，不改全局状态（mount 才改）。
 * @param {string} dir @param {{ coreVersion?: string }} [opts]
 * @returns {Promise<any>} { ok: true, manifest, contributions, dir } | { ok: false, errors: string[] }
 */
export async function loadPack(dir, opts = {}) {
  const mf = path.join(dir, 'pack.json');
  if (!fs.existsSync(mf)) return { ok: false, errors: [`缺少 pack.json（${dir}）`] };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch (/** @type {any} */ err) {
    return { ok: false, errors: [`pack.json 解析失败：${err?.message || err}`] };
  }
  const v = validateManifest(manifest, opts);
  if (!v.ok) return { ok: false, errors: v.errors };

  const contributes = manifest.contributes || {};
  // 声明的文件必须存在（缺失即拒绝该 Pack——比静默少加载更容易排查）
  const fileChecks = [
    ['presets', 'presets'],
    ['promptSections', 'promptSections'],
    ['skills', 'skills'],
    ['commands', 'commands'],
  ];
  const errors = [];
  for (const [field, sub] of fileChecks) {
    for (const rel of Array.isArray(contributes[sub]) ? contributes[sub] : []) {
      // 允许两种写法：指向文件，或指向目录（目录内自行组织）
      if (!fs.existsSync(path.join(dir, String(rel)))) errors.push(`contributes.${field} 声明的路径不存在：${rel}`);
    }
  }
  if (errors.length) return { ok: false, errors };

  /** @type {string[]} */
  const warnings = [];
  let contributions = /** @type {any} */ ({});
  const hasCode = contributes.tools === true || contributes.constraints !== undefined || contributes.promptSections !== undefined || contributes.memorySchema !== undefined;
  const entry = path.join(dir, 'pack.mjs');
  if (hasCode) {
    if (!fs.existsSync(entry)) return { ok: false, errors: [`manifest 声明了代码贡献，但缺少 pack.mjs（${dir}）`] };
    // A4.6 静态提示（不阻断）：Pack 若自己 fetch 模型接口，费用将隐身、护栏失效、无法归因。
    // 判定刻意保守：出现 fetch( 且全文未提到 ctx.llm 时才提示（避免对「直连业务系统」误报）。
    try {
      const rawSrc = fs.readFileSync(entry, 'utf8');
      // 先去注释再判定：脚手架模板里就有一句「toolCtx.llm(...) 可调用模型」的注释，
      // 不剥注释会让 lint 对「照抄脚手架但自己 fetch」的 Pack 静默漏报。
      const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      if (/\bfetch\s*\(/.test(src) && !/ctx\.llm|toolCtx\.llm/.test(src)) {
        warnings.push(
          '检测到 fetch( 调用且未使用 ctx.llm——若这是**模型调用**，其费用不会进入账本与日费用护栏（见 PACK-API §5）。' +
            '若这是直连业务系统（HIS/ERP 等），请在 permissions.net 声明白名单。'
        );
      }
    } catch {}
    let mod;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (/** @type {any} */ err) {
      return { ok: false, errors: [`pack.mjs 加载失败：${err?.message || err}`] };
    }
    if (typeof mod.createPack !== 'function') return { ok: false, errors: ['pack.mjs 必须导出 createPack(ctx) 函数'] };
    if (mod.apiVersion !== undefined && mod.apiVersion !== manifest.apiVersion) {
      return { ok: false, errors: [`pack.mjs 的 apiVersion(${mod.apiVersion}) 与 pack.json(${manifest.apiVersion}) 不一致`] };
    }
    try {
      contributions = (await mod.createPack(makePackCtx(manifest, dir))) || {};
    } catch (/** @type {any} */ err) {
      return { ok: false, errors: [`createPack() 抛错：${err?.message || err}`] };
    }
  }

  // 约束校验（来自 pack.mjs 或 manifest.contributes.constraints 指向的文件）
  const constraints = Array.isArray(contributions.constraints) ? contributions.constraints : [];
  constraints.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const e = validateConstraint(c, i);
    if (e) errors.push(e);
  });
  if (errors.length) return { ok: false, errors };

  return { ok: true, manifest, contributions: { ...contributions, constraints }, dir, warnings };
}

/**
 * Pack 运行期上下文（最小能力面；v0.5.0 先给只读信息，ctx.llm 在 A4 接入）
 * @param {any} manifest @param {string} dir
 */
function makePackCtx(manifest, dir) {
  return {
    home: mingdaoHome(),
    packDir: dir,
    packName: manifest.name,
    log: (/** @type {any} */ msg) => console.log(`[pack:${manifest.name}] ${msg}`),
  };
}

/**
 * 加载并挂载全部 Pack（幂等）。贡献进内核注册表：
 *  - tools → registerTool（命名 `pack__<pack>__<tool>`，走权限/审计/schema 瘦身链路）
 *  - constraints → 返回给 agent 的约束引擎
 *  - promptSections → 返回给 prompts 注入
 * 坏 Pack 只 warn 并跳过，**绝不阻塞启动**。
 * @param {any} [cfg] @param {{ cwd?: string, coreVersion?: string }} [opts]
 */
export async function mountPacks(cfg, opts = {}) {
  const warnings = [];
  const mounted = [];
  const promptSections = [];
  const constraints = [];
  const projectDir = opts.cwd || process.cwd();
  for (const info of listPacks(cfg, projectDir, opts)) {
    if (info.error) {
      warnings.push(`Pack "${info.name}" 校验失败（已跳过）：${info.error}`);
      continue;
    }
    if (loadedPacks.has(info.name)) {
      // 已挂载：贡献面直接复用（幂等）。
      // 注意：`mounted` 必须同样列出「此前已挂载」的 Pack——否则第二次调用会返回空列表，
      // 调用方（CLI 横幅 / 测试 / 下游集成）会误判「没有 Pack」。
      const cached = loadedPacks.get(info.name);
      mounted.push({ name: info.name, source: info.source, version: cached.manifest.version, apiVersion: cached.manifest.apiVersion, budget: cached.manifest.budget || null });
      promptSections.push(...packSectionEntries(cached));
      constraints.push(...(cached.contributions.constraints || []).map((/** @type {any} */ c) => ({ ...c, pack: info.name })));
      continue;
    }
    const res = await loadPack(info.dir, opts);
    if (!res.ok) {
      warnings.push(`Pack "${info.name}" 加载失败（已跳过）：${res.errors.join('；')}`);
      continue;
    }
    for (const w of Array.isArray(res.warnings) ? res.warnings : []) warnings.push(`Pack "${info.name}"：${w}`);
    // 注册工具
    for (const t of Array.isArray(res.contributions.tools) ? res.contributions.tools : []) {
      const bare = String(t?.name || '').trim();
      if (!TOOL_NAME_RE.test(bare)) {
        warnings.push(`Pack "${info.name}" 工具名非法（已跳过）：${JSON.stringify(bare)}`);
        continue;
      }
      const full = `pack__${info.name}__${bare}`;
      if (full.length > 64) {
        warnings.push(`Pack "${info.name}" 工具 ${bare} 注册名过长（>64，已跳过）`);
        continue;
      }
      try {
        registerTool({
          name: full,
          description: String(t.description || ''),
          parameters: t.parameters,
          readOnly: t.readOnly === true,
          run: t.run,
        });
        mountedTools += 1;
      } catch (/** @type {any} */ err) {
        warnings.push(`Pack "${info.name}" 工具 ${bare} 注册失败（已跳过）：${err?.message || err}`);
      }
    }
    loadedPacks.set(info.name, res);
    mounted.push({ name: info.name, source: info.source, version: res.manifest.version, apiVersion: res.manifest.apiVersion, budget: res.manifest.budget || null });
    promptSections.push(...packSectionEntries(res));
    constraints.push(...(res.contributions.constraints || []).map((/** @type {any} */ c) => ({ ...c, pack: info.name })));
  }
  const result = { mounted, warnings, promptSections, constraints, toolCount: mountedTools };
  activeCtx = result;
  return result;
}

/** @param {any} res */
function packSectionEntries(res) {
  const list = Array.isArray(res.contributions.promptSections) ? res.contributions.promptSections : [];
  return list
    .filter((/** @type {any} */ s) => s && typeof s.content === 'string' && s.content.trim())
    .map((/** @type {any} */ s) => ({
      pack: res.manifest.name,
      id: String(s.id || 'section'),
      order: Number.isFinite(Number(s.order)) ? Number(s.order) : 100,
      content: String(s.content),
    }));
}

/** 当前进程已挂载的 Pack 上下文（未挂载时为 null——所有 Pack 能力随之惰性） */
export function getActivePackContext() {
  return activeCtx;
}

/** 已加载 Pack 列表（供 CLI/WebUI 展示） */
export function loadedPackNames() {
  return [...loadedPacks.keys()];
}

/** 测试/重启用：清空已挂载记录（幂等状态） */
export function resetPacksForTest() {
  loadedPacks.clear();
  mountedTools = 0;
  activeCtx = null;
}
