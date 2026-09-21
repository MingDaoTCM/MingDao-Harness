// 配置管理：<mingdao-home>/config.json（默认 ~/.mingdao/config.json）与初始化向导。
// 优先级：命令行参数 > 环境变量 > config.json > 内置预设。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, modelPreset, providerPreset, DEFAULT_MODEL, DEFAULT_PLANNER_MODEL, DEFAULT_EXECUTOR_MODEL } from './models.js';
import { setStoredKey, resolveApiKey, maskKey } from './credentials.js';
import { atomicWriteFileSync } from './atomic-write.js';

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

/** 读取配置对象（不存在/损坏返回 null）；返回值为用户可编辑的任意 JSON 配置，类型不定
 *
 * 注意（v0.6.3 / H-7）：null **同时**表示「不存在」与「读不出来」。凡是要**写**配置的调用点，
 * 必须先用 `readConfigStrict()` 区分这两件事，否则会把损坏配置静默覆盖掉。
 * @returns {any} */
export function loadConfig() {
  const r = readConfigStrict();
  return r.ok ? r.data : null;
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
  if (r.ok) return r.data || {};
  quarantineCorruptConfig(`${why} 需要写回配置，但读不出来：${r.error}`);
  return {};
}

/** 桌面版首次运行：无配置时自动创建最小可用配置（引导在 WebUI 内完成，
 * 不再要求先去终端跑 mingdao init）。CLI 的 mingdao init 向导不受影响。 */
export function ensureMinimalConfig() {
  const strict = readConfigStrict();
  if (strict.ok && strict.data) return strict.data;
  // v0.6.3（H-7）：存在但读不出来 → 先备份再写，绝不让"首启自动建配置"吃掉用户配置
  if (strict.exists && !strict.ok) quarantineCorruptConfig(strict.error || '未知原因');
  ensureHome();
  const pp = PROVIDERS['deepseek'] || Object.values(PROVIDERS)[0];
  const model = modelPreset(DEFAULT_MODEL) ? DEFAULT_MODEL : pp.models[0];
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

/** @param {any} cfg */
export function saveConfig(cfg) {
  ensureHome();
  const p = configPath();
  atomicWriteFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); // 质检 H4：原子写（tmp+rename）
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
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
    if (apiKey) setStoredKey(provider, apiKey);
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

  // ③ 选择模型（允许暂时跳过——不写 config.model，进入后默认用该服务商首个模型，/model 可随时换）
  let model = null;
  if (provider === 'custom') {
    const m = await io.ask('③ 模型名（可留空跳过，稍后 /model 再选）：');
    model = m.trim() || null;
  } else {
    const options = [{ value: '__skip__', label: '暂时跳过（稍后 /model 再选）' }];
    for (const m of models || pp.models) {
      const preset = modelPreset(m);
      options.push({ value: m, label: preset ? `${m} — ${preset.label}` : m });
    }
    options.push({ value: '__custom__', label: '自定义模型名（手动输入）' });
    const choice = await io.choose('③ 选择模型：', options);
    if (choice === '__skip__') model = null;
    else if (choice === '__custom__') model = (await io.ask('模型名：')).trim() || null;
    else model = choice;
  }
  if (model) io.print(`✓ 已选择模型：${model}`);
  else io.print('✓ 已跳过模型选择：进入后自动使用该服务商默认模型，输入 /model 可随时切换。');

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
  if (modelPreset(DEFAULT_PLANNER_MODEL) && modelPreset(DEFAULT_EXECUTOR_MODEL)) {
    const routeChoice = await io.choose('自动模型路由（规划类任务→pro，执行类→flash）：', [
      { value: 'on', label: 'on — 开启（省钱又高效，推荐）' },
      { value: 'off', label: 'off — 关闭（始终用当前模型）' },
    ]);
    if (routeChoice === 'on') routing = { enabled: true, planner: DEFAULT_PLANNER_MODEL, executor: DEFAULT_EXECUTOR_MODEL };
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
    `路由    ${routing ? '自动（pro⇄flash）' : '关闭'}`,
    `密钥    ${apiKey ? '凭证库 ' + maskKey(apiKey) : '环境变量 ' + (pp.envKey || 'MINGDAO_API_KEY')}`,
    `保存于  ${configPath()}`,
  ]);
  io.print('现在输入 mingdao 即可开始对话。');
  return cfg;
}
