// 配置管理：<mingdao-home>/config.json（默认 ~/.mingdao/config.json）与初始化向导。
// 优先级：命令行参数 > 环境变量 > config.json > 内置预设。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PROVIDERS, modelPreset, providerPreset } from './models.js';
import { setStoredKey, resolveApiKey, maskKey } from './credentials.js';

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

/** 读取配置对象（不存在/损坏返回 null）；返回值为用户可编辑的任意 JSON 配置，类型不定
 * @returns {any} */
export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  ensureHome();
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {}
}

export function effectiveApiKey(cfg, providerName) {
  return resolveApiKey(cfg, providerName, providerPreset(providerName)?.envKey);
}

export async function runWizard(io) {
  io.box('MingDao Harness 初始化向导', ['① 选服务商 → ② 填 API Key（自动验证）→ ③ 选模型（可跳过）']);
  io.print('');

  const providerKeys = Object.keys(PROVIDERS);
  const provider = await io.choose(
    '① 选择模型服务商：',
    providerKeys.map((k) => ({ value: k, label: `${k} — ${PROVIDERS[k].label}` }))
  );
  const pp = PROVIDERS[provider];

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
  if (modelPreset('deepseek-v4-pro') && modelPreset('deepseek-v4-flash')) {
    const routeChoice = await io.choose('自动模型路由（规划类任务→pro，执行类→flash）：', [
      { value: 'on', label: 'on — 开启（省钱又高效，推荐）' },
      { value: 'off', label: 'off — 关闭（始终用当前模型）' },
    ]);
    if (routeChoice === 'on') routing = { enabled: true, planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' };
  }

  const preset = model ? modelPreset(model) : null;
  const defaultBudget = preset?.budgetTokens ?? 128000;
  const budgetInput = await io.ask(`上下文预算 tokens（回车默认 ${defaultBudget}）：`);
  const contextBudget = Number(budgetInput) > 0 ? Number(budgetInput) : defaultBudget;

  // 注意：config.json 不含任何密钥（可安全分享/提交），密钥只存 credentials.json。
  const cfg = {
    provider,
    baseUrl: baseUrl || pp.baseUrl,
    permission: perm,
    sandbox,
    contextBudget,
  };
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
