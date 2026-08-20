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

export function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function saveConfig(cfg) {
  ensureHome();
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

export function effectiveApiKey(cfg, providerName) {
  return resolveApiKey(cfg, providerName, providerPreset(providerName)?.envKey);
}

export async function runWizard(io) {
  io.box('MingDao 初始化向导', ['三步完成：选服务商/模型 → 填 API Key → 选权限模式']);
  io.print('');

  const providerKeys = Object.keys(PROVIDERS);
  const provider = await io.choose(
    '① 选择模型服务商：',
    providerKeys.map((k) => ({ value: k, label: `${k} — ${PROVIDERS[k].label}` }))
  );
  const pp = PROVIDERS[provider];

  let model;
  if (provider === 'custom') {
    model = await io.ask('② 模型名（例如 deepseek-v4-flash）：');
  } else {
    const options = pp.models.map((m) => {
      const preset = modelPreset(m);
      return { value: m, label: preset ? `${m} — ${preset.label}` : m };
    });
    options.push({ value: '__custom__', label: '自定义模型名（手动输入）' });
    const choice = await io.choose('② 选择模型：', options);
    model = choice === '__custom__' ? await io.ask('模型名：') : choice;
  }

  const envDetected = pp.envKey && process.env[pp.envKey] ? `（检测到环境变量 ${pp.envKey}，回车直接使用）` : '';
  const apiKey = await io.ask(`③ API Key${envDetected}：`, { hidden: true });

  if (apiKey) {
    setStoredKey(provider, apiKey);
    io.print(`✓ API Key 已保存到独立凭证库（权限 600），不会写入 config.json。`);
  } else {
    io.print(`✓ 未输入 API Key：将使用环境变量 ${pp.envKey || 'MINGDAO_API_KEY'}。`);
  }

  let baseUrl = '';
  if (provider === 'custom') {
    baseUrl = await io.ask(`API 地址（回车默认 ${pp.baseUrl}）：`);
  }

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

  const preset = modelPreset(model);
  const defaultBudget = preset?.budgetTokens ?? 128000;
  const budgetInput = await io.ask(`上下文预算 tokens（回车默认 ${defaultBudget}）：`);
  const contextBudget = Number(budgetInput) > 0 ? Number(budgetInput) : defaultBudget;

  // 注意：config.json 不含任何密钥（可安全分享/提交），密钥只存 credentials.json。
  const cfg = {
    provider,
    model,
    baseUrl: baseUrl || pp.baseUrl,
    permission: perm,
    sandbox,
    contextBudget,
  };
  if (routing) cfg.routing = routing;
  saveConfig(cfg);
  io.print('');
  io.box('配置完成 ✓', [
    `服务商  ${provider}（${pp.label}）`,
    `模型    ${model}`,
    `权限    ${perm} · 沙箱  ${sandbox}`,
    `路由    ${routing ? '自动（pro⇄flash）' : '关闭'}`,
    `密钥    ${apiKey ? '凭证库 ' + maskKey(apiKey) : '环境变量 ' + (pp.envKey || 'MINGDAO_API_KEY')}`,
    `保存于  ${configPath()}`,
  ]);
  io.print('现在输入 mingdao 即可开始对话。');
  return cfg;
}
