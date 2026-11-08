// 配置管理：<mingdao-home>/config.json（默认 ~/.mingdao/config.json）与初始化向导。
// 优先级：命令行参数 > 环境变量 > config.json > 内置预设。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, modelPreset, providerPreset, pickFamilyModel, normalizeModelLabels, DEFAULT_MODEL, DEFAULT_PLANNER_MODEL, DEFAULT_EXECUTOR_MODEL } from './models.js';
import { setStoredKey, resolveApiKey, maskKey } from './credentials.js';
import { atomicWriteFileSync, withFileLock, withFileLockSync as withStateFileLockSync } from './atomic-write.js';
import { setEventLogEnabled } from './session-events.js';

export function mingdaoHome() {
  return process.env.MINGDAO_HOME || path.join(os.homedir(), '.mingdao');
}

export function ensureHome() {
  const home = mingdaoHome();
  for (const sub of ['', 'sessions', 'providers']) {
    fs.mkdirSync(sub ? path.join(home, sub) : home, { recursive: true, mode: 0o700 });
  }
  return home;
}

export function configPath() {
  return path.join(mingdaoHome(), 'config.json');
}

/**
 * config.json 的跨进程锁（v0.7.0 §1.3）。
 * 锁文件与目标同目录：所有写方（WebUI 请求、CLI、守护进程）都用同一把锁，
 * 锁内做「重读磁盘 → 合并本次改动 → 原子写」，而不是拿一份可能已经陈旧的快照整文件覆盖。
 */
export function configLockFile() {
  return configPath() + '.lock';
}

/** model-cache.json 的跨进程锁（与配置文件同款：写前拿锁、锁内原子替换）。 */
export function modelCacheLockFile() {
  return path.join(mingdaoHome(), 'model-cache.json.lock');
}

/**
 * 读取 model-cache.json 的**唯一入口**（v0.7.0 §1.3）。
 * 缺失 / 损坏 / 顶层不是对象一律返回空对象：缓存是纯优化，坏掉只应降级，不能阻断启动。
 * @returns {Record<string, any>}
 */
export function readModelCache() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(mingdaoHome(), 'model-cache.json'), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 原子写入 model-cache.json（调用方必须已持锁）。 */
function writeModelCacheUnlocked(/** @type {any} */ data) {
  ensureHome();
  atomicWriteFileSync(path.join(mingdaoHome(), 'model-cache.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * 写入 model-cache.json 的**唯一入口**：跨进程锁 + 原子替换（tmp/fsync/rename）。
 *
 * v0.7.0 §1.3：此前这里是 `fs.writeFileSync(target)` 的**截断式直写**——进程在写一半时崩溃，
 * 下次启动就读到半截 JSON，`cachedModelNames()` 静默回退旧模型名，用户看到的是「模型名自己变回去了」。
 * 写失败**必须可见**：返回 `{ok:false,error}` 并打一条 warn，绝不静默吞掉。
 * @param {any} data
 * @returns {{ok: boolean, error: string|null}}
 */
export function writeModelCache(/** @type {any} */ data) {
  try {
    withStateFileLockSync(modelCacheLockFile(), () => writeModelCacheUnlocked(data));
    return { ok: true, error: null };
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ model-cache.json 写入失败（${path.join(mingdaoHome(), 'model-cache.json')}）：${msg}——本次模型名单缓存未更新（不影响本次对话，下次拉取会重试）。`);
    return { ok: false, error: msg };
  }
}

/**
 * 锁内「重读 → 修改 → 写回」model-cache.json。
 * 名单缓存与预检基线共用同一文件，两个写方并发时不能拿旧快照互相覆盖。
 * @param {(cache: Record<string, any>) => any} mutate
 * @returns {{ok: boolean, error: string|null, cache: Record<string, any>|null}}
 */
export function updateModelCacheSync(/** @type {(cache: Record<string, any>) => any} */ mutate) {
  try {
    ensureHome();
    return withStateFileLockSync(modelCacheLockFile(), () => {
      const current = readModelCache();
      const next = typeof mutate === 'function' ? mutate(current) : current;
      const out = next && typeof next === 'object' && !Array.isArray(next) ? next : current;
      writeModelCacheUnlocked(out);
      return { ok: true, error: null, cache: out };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ model-cache.json 更新失败（${path.join(mingdaoHome(), 'model-cache.json')}）：${msg}——本次模型名单缓存未更新。`);
    return { ok: false, error: msg, cache: null };
  }
}

/**
 * 严格读取配置：区分「不存在」与「存在但读不出来」。v0.6.3（H-7）。
 *
 * 原实现 `catch { return null }` 把 ENOENT 与「JSON 解析失败 / 权限不足 / 不是对象」抹平成同一件事，
 * 而所有调用点对 null 的处理都是**当作首次运行**——于是改坏一个字符（或存成带 BOM 的 UTF-8）
 * 之后跑 `mingdao init` / 桌面版首启，`customModels`/`mcpServers`/`sync`/`net`/`costGuard`
 * 会被一个全新对象**整文件覆盖**，且不备份、不告警。BOM 这一支尤其冤：内容完全合法，
 * 只是 JSON.parse 不认 BOM。
 *
 * @returns {{ok: boolean, exists: boolean, data: any, error: string|null}}
 */
export function readConfigStrict() {
  const file = configPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (/** @type {any} */ err) {
    if (err?.code === 'ENOENT') return { ok: true, exists: false, data: null, error: null };
    return { ok: false, exists: true, data: null, error: `无法读取 ${file}：${err?.message || err}` };
  }
  // BOM：合法的 JSON 内容 + 文件头 BOM = JSON.parse 直接抛（Excel/记事本另存为的常见产物）
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (!text.trim()) return { ok: false, exists: true, data: null, error: `${file} 是空文件` };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, exists: true, data: null, error: `${file} 的内容不是 JSON 对象（实际是 ${Array.isArray(data) ? '数组' : typeof data}）` };
    }
    return { ok: true, exists: true, data, error: null };
  } catch (/** @type {any} */ err) {
    return { ok: false, exists: true, data: null, error: `${file} 解析失败：${err?.message || err}` };
  }
}

/**
 * 把「读不出来的 config.json」**改名**成 `config.json.corrupt-<时间戳>`。
 * 用改名而不是复制：后续任何「写全新配置」都不会再压到用户的原始数据上。
 * @param {string} reason
 * @returns {string|null} 备份路径（无需备份时 null）
 */
export function quarantineCorruptConfig(reason) {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // 同一秒内发生两次损坏时，rename 会**覆盖**上一份备份（POSIX rename 是覆盖语义）——
  // 而备份的意义正是"一份都不许丢"。故重名时顺延编号。
  let dest = `${file}.corrupt-${stamp}`;
  for (let k = 1; fs.existsSync(dest); k += 1) dest = `${file}.corrupt-${stamp}-${k}`;
  try {
    fs.renameSync(file, dest);
  } catch {
    return null;
  }
  console.warn(
    `[MingDao] ⚠ 配置文件读不出来，已**改名备份**而不是覆盖它：\n` +
      `  原因：${reason}\n` +
      `  备份：${dest}\n` +
      `  接下来会按全新配置继续（首次运行向导 / 最小可用配置）。请从备份里把\n` +
      `  customModels / mcpServers / sync / net / costGuard 等字段手动并回新的 config.json。`
  );
  return dest;
}

/**
 * 同步读取 model-cache.json 里某服务商的线上名单（最近一次 `GET /models` 的结果）。
 * `ensureMinimalConfig` / `loadConfig` 都是同步接口，无法 await 网络请求，用这份缓存
 * 把「默认模型」对齐到 API 返回的官方名；缓存为空时才用家族代表名兜底并告警。
 * @param {string} provider
 * @returns {string[]}
 */
function cachedModelNames(provider) {
  // v0.7.0 §1.3：消费端也走 readModelCache() 单一入口——两处各读一遍、各判一次损坏，
  // 迟早会漂移成两套口径（本项缺陷正是「写半截 + 读静默回退」组合出来的）。
  const list = readModelCache()?.[provider]?.models;
  return Array.isArray(list) ? list.map(String) : [];
}

let warnedCachedFallback = false;
function warnCachedFallback(/** @type {string} */ what, /** @type {string} */ rep) {
  if (warnedCachedFallback) return;
  warnedCachedFallback = true;
  console.warn(`[MingDao] ⚠ ${what} 没有可用的 API 官方名缓存：暂用内置家族代表名 ${rep}（兜底，模型名可能不是最新的；连上 API 后会自动刷新）。`);
}

/**
 * v0.6.19（§3.67）：把配置里的**缺省**模型补成 API 名单里的官方名。
 * 只补缺省值，绝不覆盖用户显式写下的模型名/路由（用户意图优先）。
 * @param {any} cfg
 */
function applyCachedModelDefaults(/** @type {any} */ cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const provider = String(cfg.provider || 'deepseek');
  const cached = cachedModelNames(provider);
  if (!cfg.model) {
    const m = pickFamilyModel(cached, 'flash');
    if (m) cfg.model = m;
  }
  if (cfg.routing && cfg.routing.enabled) {
    if (!cfg.routing.planner) {
      const p = pickFamilyModel(cached, 'pro');
      cfg.routing.planner = p || DEFAULT_PLANNER_MODEL;
      if (!p) warnCachedFallback('routing.planner', DEFAULT_PLANNER_MODEL);
    }
    if (!cfg.routing.executor) {
      const e = pickFamilyModel(cached, 'flash');
      cfg.routing.executor = e || DEFAULT_EXECUTOR_MODEL;
      if (!e) warnCachedFallback('routing.executor', DEFAULT_EXECUTOR_MODEL);
    }
  }
  return cfg;
}

/**
 * 校验显示别名（v0.6.20 §3.69）：`config.modelLabels` 只影响界面显示，**不参与任何出网请求**。
 * 非法项忽略并 warn（不阻断启动）；非对象/空值也在 normalizeModelLabels 里统一处理。
 * 返回的是同一个对象（就地归一化），不新建配置副本。
 * @param {any} cfg
 */
function applyModelLabels(/** @type {any} */ cfg) {
  if (cfg && typeof cfg === 'object' && Object.prototype.hasOwnProperty.call(cfg, 'modelLabels')) {
    cfg.modelLabels = normalizeModelLabels(cfg.modelLabels);
  }
  return cfg;
}

/**
 * 会话读取真源（v0.7.0 B2-b 灰度开关）。
 *
 * `messages`（默认）：继续只读 `.jsonl` 消息数组——与 0.6.x 完全一致，事件侧车坏掉也不影响。
 * `events`：用事件日志重放派生消息，但**必须与消息文件对拍一致**才采用；不一致就 warn 并
 * 回退到消息数组。这只用于灰度验证「事件流能否当唯一真源」，**不是**新的默认值：
 * 翻默认要等真实会话的 `scripts/event-parity.mjs` 证据（pass 覆盖足够广、incomplete 清零）。
 *
 * 校验口径与 `config.eventLog` 一致：只认字面量 `'events'`，其余（缺省 / 大小写不符 /
 * 任意非法值）一律按 `'messages'` 处理，绝不因为一个拼错的值把读取路径切到实验分支。
 */
export const EVENT_SOURCE_MESSAGES = 'messages';
export const EVENT_SOURCE_EVENTS = 'events';
/** 默认真源：`messages`。改这里等于改所有 ENOENT/未配置用户的读取路径，必须等灰度证据。 */
export const DEFAULT_EVENT_SOURCE = EVENT_SOURCE_MESSAGES;
const EVENT_SOURCE_SET = new Set([EVENT_SOURCE_MESSAGES, EVENT_SOURCE_EVENTS]);

/**
 * 归一化 `config.eventSource`：合法枚举原样返回，其余一律回落默认值 `messages`。
 * 纯函数，读配置/写配置/直接调用 `loadSession(file, cfg)` 三条路径共用同一判据。
 * @param {any} value
 * @returns {'messages'|'events'}
 */
export function normalizeEventSource(value) {
  return EVENT_SOURCE_SET.has(value) ? value : DEFAULT_EVENT_SOURCE;
}

/**
 * 就地归一化配置对象里的 `eventSource`（字段不存在时**不新增**，保持旧配置文件字节不变）。
 * @param {any} cfg
 */
function applyEventSource(/** @type {any} */ cfg) {
  if (!isConfigObject(cfg) || cfg.eventSource === undefined) return cfg;
  cfg.eventSource = normalizeEventSource(cfg.eventSource);
  return cfg;
}

// ---------------------------------------------------------------------------
// v0.7.0 §1.3：配置写入的「基线 + 增量」。
//
// 缺陷形态：调用方 `loadConfig() → 改一个字段 → saveConfig(cfg)`，而 saveConfig 把**整份
// 快照**写回。两个进程（WebUI 设置页 + CLI / 同步命令）先后写时，后写者会用自己启动时读到的
// 旧快照覆盖前者刚写的字段——用户看到的就是「我明明填了 Key/改过模型，过一会自己变回去了」。
//
// 修法：load 时记下该对象的快照；save 时在锁内**重读磁盘**，只把「相对快照真正改变/删除的
// 字段」合并进去。这样：
//   · 并发写不同字段 → 各写各的，互不覆盖；
//   · 并发写同一字段 → 后保存者赢（这是用户此刻的明确意图，不是陈旧快照）；
//   · 删除字段（delete cfg.x / 设为 undefined）依旧生效，不会被"合并"回来。
// 无法识别基线（向导新建的完整配置、测试直接传字面量）时保持原语义：整份写入。
// ---------------------------------------------------------------------------
/** @type {WeakMap<object, any>} */
const configSnapshots = new WeakMap();

/** @param {any} v @returns {any} */
function cloneConfigValue(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** @param {any} v @returns {boolean} */
function isConfigObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** @param {any} a @param {any} b @returns {boolean} */
function configValuesEqual(a, b) {
  if (a === b) return true;
  if (!isConfigObject(a) || !isConfigObject(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !configValuesEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * 计算 before→after 的增量（对象递归，数组/标量整体替换；缺失键记为删除）。
 * @param {any} before @param {any} after @param {string[]} prefix
 * @param {{set: [string[], any][], del: string[][]}} patch
 */
function collectConfigPatch(before, after, prefix, patch) {
  if (isConfigObject(before) && isConfigObject(after)) {
    for (const k of Object.keys(after)) {
      if (Object.prototype.hasOwnProperty.call(before, k)) collectConfigPatch(before[k], after[k], [...prefix, k], patch);
      else patch.set.push([[...prefix, k], cloneConfigValue(after[k])]);
    }
    for (const k of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, k)) patch.del.push([...prefix, k]);
    }
    return;
  }
  if (!configValuesEqual(before, after)) patch.set.push([prefix, cloneConfigValue(after)]);
}

/** @param {any} base @param {string[]} keys @param {any} value */
function configSetAt(base, keys, value) {
  let cur = base;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!isConfigObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** @param {any} base @param {string[]} keys */
function configDeleteAt(base, keys) {
  let cur = base;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (!isConfigObject(cur[k])) return;
    cur = cur[k];
  }
  if (isConfigObject(cur)) delete cur[keys[keys.length - 1]];
}

/** @param {any} base @param {{set: [string[], any][], del: string[][]}} patch */
function applyConfigPatch(base, patch) {
  for (const keys of patch.del) configDeleteAt(base, keys);
  for (const [keys, value] of patch.set) configSetAt(base, keys, value);
}

/**
 * 记下「这份对象被读出来时是什么样」。
 * @param {any} cfg
 */
function rememberConfig(cfg) {
  // 记 home：测试/桌面版会切 MINGDAO_HOME，不同 home 的字段没有可比性（必须退回整份写入）
  if (isConfigObject(cfg)) configSnapshots.set(cfg, { home: mingdaoHome(), data: cloneConfigValue(cfg) });
}

/** 写 config.json（调用方必须已持锁）：原子写 + 0600。 */
function writeConfigUnlocked(/** @type {any} */ cfg) {
  ensureHome();
  const p = configPath();
  atomicWriteFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

/**
 * 锁内准备最终要落盘的配置：重读磁盘 + 合并本次增量。
 * 读不出来时先改名备份（与 loadConfigForWrite 同一纪律），绝不静默覆盖用户原文。
 * @param {any} cfg @returns {any}
 */
function prepareConfigForWrite(cfg) {
  const snapshot = configSnapshots.get(cfg);
  const sameHome = Boolean(snapshot) && snapshot.home === mingdaoHome();
  const strict = readConfigStrict();
  /** @type {any} */
  let base;
  if (strict.ok) {
    base = isConfigObject(strict.data) ? strict.data : {};
  } else {
    quarantineCorruptConfig(`保存配置时读不出来：${strict.error}`);
    base = {};
  }
  if (!sameHome) return applyEventSource(cfg); // 无基线（新配置/字面量）或换了 home → 保持原语义：整份写入
  /** @type {{set: [string[], any][], del: string[][]}} */
  const patch = { set: [], del: [] };
  collectConfigPatch(snapshot.data, cfg, [], patch);
  applyConfigPatch(base, patch);
  return applyEventSource(base);
}

/**
 * v0.7.0 §1.1：把 `config.eventLog` 同步到事件日志的进程级开关。
 *
 * 为什么必须在 config 层做一次：WebUI 的 /api/chat 会**先**把用户消息 appendMessages 落盘、
 * **后**才 createAgent；只靠 createAgent 设置开关会让 config 里的 eventLog=false 漏掉这条
 * 用户消息（半份事件流）。loadConfig/saveConfig 是配置进入进程的两个入口，在这里设一次，
 * 任何「先写会话、后建 agent」的顺序都不会漏。缺省（字段不存在）按开启处理。
 * @param {any} cfg
 */
function applyEventLogGate(cfg) {
  setEventLogEnabled(!(cfg && cfg.eventLog === false));
}

/** 读取配置对象（不存在/损坏返回 null）；返回值为用户可编辑的任意 JSON 配置，类型不定
 *
 * 注意（v0.6.3 / H-7）：null **同时**表示「不存在」与「读不出来」。凡是要**写**配置的调用点，
 * 必须先用 `readConfigStrict()` 区分这两件事，否则会把损坏配置静默覆盖掉。
 * @returns {any} */
export function loadConfig() {
  const r = readConfigStrict();
  if (!r.ok) return null;
  const cfg = applyEventSource(applyModelLabels(applyCachedModelDefaults(r.data)));
  rememberConfig(cfg); // v0.7.0 §1.3：记下基线，saveConfig 只合并增量
  applyEventLogGate(cfg); // v0.7.0 §1.1：config.eventLog=false 在「先落盘、后建 agent」路径也生效
  return cfg;
}

/**
 * 「读配置以便写回」的统一入口（审计 BUG-077）。
 *
 * H-7 只覆盖了 `init` / `ensureMinimalConfig` 两条写路径，其余写路径仍在用
 * `loadConfig() || {}` —— 而 `null` **同时**表示「不存在」与「读不出来」，于是：
 *   用户把 config.json 改坏一个字符 → 某个命令（如 `sync login`）读成 null → 当首次运行
 *   用一个全新对象 saveConfig → **原始配置被静默覆盖，且没有 .corrupt-* 备份**（实测复现）。
 * 这里把那条判据收成单一来源：写回之前必须区分「不存在」与「读不出来」，
 * 后者先**改名备份**再继续（用户可以随后手工把字段并回去）。
 *
 * @param {string} [why] 出现在告警里的用途说明（便于定位是谁触发的）
 * @returns {any} 可安全写回的配置对象（读不出来时返回空对象，但已留下备份与告警）
 */
export function loadConfigForWrite(why = '某个写配置的命令') {
  const r = readConfigStrict();
  if (r.ok) {
    const cfg = applyEventSource(r.data || {});
    rememberConfig(cfg);
    applyEventLogGate(cfg);
    return cfg;
  }
  quarantineCorruptConfig(`${why} 需要写回配置，但读不出来：${r.error}`);
  const empty = {};
  rememberConfig(empty);
  applyEventLogGate(empty);
  return empty;
}

/** 桌面版首次运行：无配置时自动创建最小可用配置（引导在 WebUI 内完成，
 * 不再要求先去终端跑 mingdao init）。CLI 的 mingdao init 向导不受影响。 */
export function ensureMinimalConfig() {
  const strict = readConfigStrict();
  if (strict.ok && strict.data) {
    const cfg = applyEventSource(applyModelLabels(strict.data));
    rememberConfig(cfg);
    return cfg;
  }
  // v0.6.3（H-7）：存在但读不出来 → 先备份再写，绝不让"首启自动建配置"吃掉用户配置
  if (strict.exists && !strict.ok) quarantineCorruptConfig(strict.error || '未知原因');
  ensureHome();
  const pp = PROVIDERS['deepseek'] || Object.values(PROVIDERS)[0];
  // v0.6.19（§3.67）：首选最近一次 API 名单里的 flash 官方名；没有缓存才用家族代表名。
  // （首次运行还没填 Key，API 拉不到，此时代表名就是合理的兜底，后续拉到官方名会自动替换。）
  const officialFlash = pickFamilyModel(cachedModelNames('deepseek'), 'flash');
  const model = officialFlash || (modelPreset(DEFAULT_MODEL) ? DEFAULT_MODEL : pp.models[0]);
  if (!officialFlash) warnCachedFallback('默认模型', model);
  const cfg = {
    provider: 'deepseek',
    model,
    baseUrl: pp.baseUrl,
    permission: 'ask',
    sandbox: 'off',
    contextBudget: 128000,
  };
  saveConfig(cfg);
  return cfg;
}

/**
 * 保存配置（**公开签名不变**：`saveConfig(cfg)`；返回 `{ok, error}`，旧调用方忽略返回值也不受影响）。
 *
 * v0.7.0 §1.3：整段「重读 → 合并增量 → 原子写」都在 `config.json.lock` 里完成。
 * 这是同步版，给 CLI / 纯同步调用链用；WebUI 请求路径请用 `saveConfigAsync()`（等待时让出事件循环）。
 *
 * 写失败**不再抛**（旧实现会抛给调用方，WebUI 设置页因此 500 或静默回滚）：
 * 返回 `{ok:false,error}` 并打一条可见 warn，调用方可展示原因，进程不崩。
 * @param {any} cfg
 * @returns {{ok: boolean, error: string|null}}
 */
export function saveConfig(cfg) {
  try {
    ensureHome();
    applyEventSource(cfg); // B2-b：写回前也归一化，保证内存基线与落盘值一致
    withStateFileLockSync(configLockFile(), () => {
      writeConfigUnlocked(prepareConfigForWrite(cfg));
      rememberConfig(cfg); // 成功后把这版对象当作下次增量比较的基线
    });
    applyEventLogGate(cfg);
    return { ok: true, error: null };
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 配置写入失败（${configPath()}）：${msg}——本次修改未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/**
 * 异步版 saveConfig（同一把 `config.json.lock`、同一套增量合并语义）：
 * 请求路径上等待锁时 `await` 让出事件循环，不冻结 WebUI 的其他会话/SSE。
 * @param {any} cfg
 * @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function saveConfigAsync(cfg) {
  try {
    ensureHome();
    applyEventSource(cfg); // B2-b：写回前也归一化，保证内存基线与落盘值一致
    await withFileLock(configLockFile(), () => {
      writeConfigUnlocked(prepareConfigForWrite(cfg));
      rememberConfig(cfg);
    });
    return { ok: true, error: null };
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 配置写入失败（${configPath()}）：${msg}——本次修改未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg };
  }
}

/**
 * 锁内「读 → 改 → 写」配置（同步版，CLI/纯同步链用）。
 *
 * 与 `loadConfig()+saveConfig()` 的区别：基线在**锁内**重读，因此不存在「读与写之间被别人插了一手」
 * 的窗口；适合必须基于最新磁盘状态做判断的写路径（例如合并数组/清理字段）。
 * 回调收到的是磁盘上的最新对象，返回值即最终写盘的配置（返回非对象时沿用原对象）。
 * @param {(cfg: any) => any} mutate
 * @returns {{ok: boolean, error: string|null, config: any}}
 */
export function updateConfigSync(/** @type {(cfg: any) => any} */ mutate) {
  try {
    ensureHome();
    return withStateFileLockSync(configLockFile(), () => {
      const strict = readConfigStrict();
      /** @type {any} */
      let cfg;
      if (strict.ok) cfg = isConfigObject(strict.data) ? strict.data : {};
      else {
        quarantineCorruptConfig(`更新配置时读不出来：${strict.error}`);
        cfg = {};
      }
      const next = typeof mutate === 'function' ? mutate(cfg) : cfg;
      const out = applyEventSource(isConfigObject(next) ? next : cfg);
      writeConfigUnlocked(out);
      rememberConfig(out);
      return { ok: true, error: null, config: out };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 配置更新失败（${configPath()}）：${msg}——本次修改未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg, config: null };
  }
}

/**
 * 异步版 `updateConfigSync`（WebUI 请求路径）：锁内重读 + 修改 + 原子写，等待期间让出事件循环。
 * @param {(cfg: any) => any} mutate
 * @returns {Promise<{ok: boolean, error: string|null, config: any}>}
 */
export async function updateConfig(/** @type {(cfg: any) => any} */ mutate) {
  try {
    ensureHome();
    return await withFileLock(configLockFile(), () => {
      const strict = readConfigStrict();
      /** @type {any} */
      let cfg;
      if (strict.ok) cfg = isConfigObject(strict.data) ? strict.data : {};
      else {
        quarantineCorruptConfig(`更新配置时读不出来：${strict.error}`);
        cfg = {};
      }
      const next = typeof mutate === 'function' ? mutate(cfg) : cfg;
      const out = applyEventSource(isConfigObject(next) ? next : cfg);
      writeConfigUnlocked(out);
      rememberConfig(out);
      return { ok: true, error: null, config: out };
    });
  } catch (err) {
    const msg = String(/** @type {any} */ (err)?.message ?? err);
    console.warn(`[MingDao] ⚠ 配置更新失败（${configPath()}）：${msg}——本次修改未保存，请检查磁盘空间/目录权限后重试。`);
    return { ok: false, error: msg, config: null };
  }
}

/** @param {any} cfg @param {any} providerName */
export function effectiveApiKey(cfg, providerName) {
  return resolveApiKey(cfg, providerName, providerPreset(providerName)?.envKey);
}

/** @param {any} io */
export async function runWizard(io) {
  io.box('MingDao Harness 初始化向导', ['① 选服务商 → ② 填 API Key（自动验证）→ ③ 选模型（可跳过）']);
  io.print('');

  const providerKeys = Object.keys(PROVIDERS);
  const provider = await io.choose(
    '① 选择模型服务商：',
    providerKeys.map((k) => ({ value: k, label: `${k} — ${/** @type {Record<string, any>} */ (PROVIDERS)[k].label}` }))
  );
  const pp = /** @type {Record<string, any>} */ (PROVIDERS)[provider];

  let baseUrl = '';
  if (provider === 'custom') {
    baseUrl = await io.ask(`API 地址（回车默认 ${pp.baseUrl}）：`);
  }
  const provisional = { provider, baseUrl: baseUrl || pp.baseUrl };
  const hasEnvKey = () => Boolean((pp.envKey && process.env[pp.envKey]) || process.env.MINGDAO_API_KEY);

  // ② 选定服务商后立即输入该服务商的 API Key，随后调用 /models 验证有效性
  let apiKey = '';
  let models = null; // 验证通过的线上模型名单
  let verifyError = null;
  for (let tries = 0; tries < 3; tries++) {
    const envDetected = hasEnvKey() ? '（检测到环境变量，回车直接使用）' : '';
    const input = await io.ask(`② ${provider} 的 API Key${envDetected}：`, { hidden: true });
    apiKey = String(input || '').trim();
    if (apiKey) {
      // v0.6.7（M-1）：写函数已 fail-closed，这里必须把失败**说出来**（否则向导会继续往下走、
      // 用户以为 Key 已保存，而实际什么都没写）。
      const sk = setStoredKey(provider, apiKey);
      if (sk && sk.ok === false) {
        io.print(`[错误] ${sk.error}`); // 不用彩色工具：config.js 不依赖 ui.js 的样式模块（避免循环依赖）
        continue;
      }
    }
    if (!apiKey && !hasEnvKey()) {
      const skipped = await io.confirm('  未输入 API Key，跳过密钥设置？');
      if (!skipped) continue;
      break;
    }
    io.print('  正在验证 API Key 有效性（调用 /models）…');
    const { fetchProviderModels } = await import('./model-discovery.js');
    const r = await fetchProviderModels(provisional, provider, { force: true });
    if (r.models?.length) {
      models = r.models;
      break;
    }
    verifyError = r.error;
    const retry = await io.confirm(`⚠ 验证失败：${r.error}（可能是密钥错误，或该网关不支持 /models 接口）。重新输入密钥？`);
    if (retry) continue;
    break; // 用户选择继续（稍后自行验证）
  }
  if (apiKey) io.print('✓ API Key 已保存到独立凭证库（权限 600），不会写入 config.json。');
  else io.print('✓ 未输入 API Key：将使用环境变量（稍后可用 mingdao key set 补齐）。');
  if (models) io.print(`✓ API Key 验证通过：该服务商线上可用模型 ${models.length} 个。`);
  else if (verifyError) io.print('（已跳过验证，稍后可在 WebUI 设置面板「刷新模型」处再次校验）');

  // ③ 选择模型（允许暂时跳过——跳过时默认用 **API 名单里的 flash 官方名**，/model 可随时换）
  let model = null;
  if (provider === 'custom') {
    const m = await io.ask('③ 模型名（可留空跳过，稍后 /model 再选）：');
    model = m.trim() || null;
  } else {
    const options = [{ value: '__skip__', label: '暂时跳过（用 API 返回的官方默认名，/model 可换）' }];
    for (const m of models || pp.models) {
      const preset = modelPreset(m);
      options.push({ value: m, label: preset ? `${m} — ${preset.label}` : `${m}（能力未知（新版本），仍可选用）` });
    }
    options.push({ value: '__custom__', label: '自定义模型名（手动输入）' });
    const choice = await io.choose('③ 选择模型：', options);
    if (choice === '__skip__') model = pickFamilyModel(models || [], 'flash');
    else if (choice === '__custom__') model = (await io.ask('模型名：')).trim() || null;
    else model = choice;
  }
  const chosenPreset = model ? modelPreset(model) : null;
  if (model) io.print(`✓ 已选择模型：${model}`);
  else io.print('✓ 已跳过模型选择：进入后自动使用该服务商默认模型，输入 /model 可随时切换。');
  if (chosenPreset?.capabilityUnknown) io.print('⚠ 该模型是 API 返回的新版本：能力未知（按家族规格保守估算，仍可选用）。');
  if (!models && provider !== 'custom') io.print('（未取得 API 模型名单：模型名用内置家族代表名——离线兜底，模型名可能不是最新的）');

  const perm = await io.choose('权限模式（写文件 / 执行命令时）：', [
    { value: 'ask', label: 'ask — 每次询问（推荐，最安全）' },
    { value: 'auto', label: 'auto — 全部自动允许（完全自主，注意风险）' },
    { value: 'readonly', label: 'readonly — 只读模式，不允许修改或执行' },
  ]);

  const sandbox = await io.choose('沙箱模式（bash 工具执行隔离，Linux + bubblewrap）：', [
    { value: 'off', label: 'off — 直接执行（默认）' },
    { value: 'readonly', label: 'readonly — 全盘只读（/tmp 可写，网络可用）' },
    { value: 'safe', label: 'safe — 只读 + 断网（工作目录与 /tmp 可写，最安全）' },
  ]);

  let routing = null;
  // v0.6.19（§3.67）：路由默认名同样以 API 名单里的官方名为准（planner→pro 家族、executor→flash 家族）；
  // 名单不可用才退回家族代表名，并在下面明确提示「兜底」。
  const plannerDefault = pickFamilyModel(models || [], 'pro') || DEFAULT_PLANNER_MODEL;
  const executorDefault = pickFamilyModel(models || [], 'flash') || DEFAULT_EXECUTOR_MODEL;
  if (modelPreset(plannerDefault) && modelPreset(executorDefault)) {
    const routeChoice = await io.choose('自动模型路由（规划类任务→pro，执行类→flash）：', [
      { value: 'on', label: 'on — 开启（省钱又高效，推荐）' },
      { value: 'off', label: 'off — 关闭（始终用当前模型）' },
    ]);
    if (routeChoice === 'on') {
      routing = { enabled: true, planner: plannerDefault, executor: executorDefault };
      if (!models) io.print(`⚠ 路由默认名走兜底（未取得 API 名单）：planner=${plannerDefault} / executor=${executorDefault}——模型名可能不是最新的。`);
    }
  }

  const preset = model ? modelPreset(model) : null;
  const defaultBudget = preset?.budgetTokens ?? 128000;
  const budgetInput = await io.ask(`上下文预算 tokens（回车默认 ${defaultBudget}）：`);
  const contextBudget = Number(budgetInput) > 0 ? Number(budgetInput) : defaultBudget;

  // 注意：config.json 不含任何密钥（可安全分享/提交），密钥只存 credentials.json。
  const cfg = /** @type {any} */ ({
    provider,
    baseUrl: baseUrl || pp.baseUrl,
    permission: perm,
    sandbox,
    contextBudget,
  });
  if (model) cfg.model = model;
  if (routing) cfg.routing = routing;
  saveConfig(cfg);
  io.print('');
  io.box('配置完成 ✓', [
    `服务商  ${provider}（${pp.label}）`,
    model ? `模型    ${model}` : '模型    （暂未选择，进入后 /model 随时切换）',
    `权限    ${perm} · 沙箱  ${sandbox}`,
    `路由    ${routing ? `自动（${routing.planner} ⇄ ${routing.executor}）` : '关闭'}`,
    `密钥    ${apiKey ? '凭证库 ' + maskKey(apiKey) : '环境变量 ' + (pp.envKey || 'MINGDAO_API_KEY')}`,
    `保存于  ${configPath()}`,
  ]);
  io.print('现在输入 mingdao 即可开始对话。');
  return cfg;
}
