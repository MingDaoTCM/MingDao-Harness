// Provider 注册表与工厂。
//
// 接入模型的三条路：
// 1. 内置 OpenAI 兼容端点 —— 在 config 里配 baseUrl/apiKey 即可（覆盖绝大多数模型）；
// 2. 内置服务商预设 —— deepseek / openai / qwen / glm / moonshot / custom；
// 3. 自定义 Provider 模块 —— 在 <mingdao-home>/providers/<name>.mjs 中
//    export async function createProvider(cfg)，返回 { chat(opts) }。
//    适合 Anthropic 原生协议、本地推理框架等非 OpenAI 兼容场景。
// 详见 docs/PROVIDERS.md。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chat as openaiChat } from './openai-compatible.js';
import { modelPreset, providerPreset } from '../models.js';
import { mingdaoHome } from '../config.js';
import { resolveApiKey } from '../credentials.js';

export function resolveProviderConfig(cfg, modelName) {
  // 自定义模型（config.customModels，WebUI 可增删改）：优先于内置预设
  const cm = cfg?.customModels?.[modelName];
  if (cm) {
    const envKeys = [cm.envKey, 'MINGDAO_API_KEY'].filter(Boolean);
    const apiKey = resolveApiKey(cfg, `custom:${modelName}`, envKeys[0]) || resolveApiKey(cfg, 'custom', envKeys[0]);
    return {
      name: `custom:${modelName}`,
      kind: 'openai-compatible',
      baseUrl: cm.baseUrl || cfg?.baseUrl || '',
      apiKey,
      envHint: envKeys[0] || 'MINGDAO_API_KEY',
      isCustom: true,
      modelName,
    };
  }
  const preset = modelPreset(modelName);
  const name = preset?.provider || cfg?.provider || 'deepseek';
  const pp = providerPreset(name) || { kind: 'openai-compatible' };
  const baseUrl = cfg?.baseUrl || pp.baseUrl || '';
  const apiKey = resolveApiKey(cfg, name, pp.envKey);
  return {
    name,
    kind: pp.kind || 'openai-compatible',
    baseUrl,
    apiKey,
    envHint: pp.envKey || 'MINGDAO_API_KEY',
    isCustom: !providerPreset(name),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(err) {
  const status = err?.status;
  if (status === 429 || (status >= 500 && status <= 504)) return true;
  // 注意：不含 abort —— 用户 Ctrl+C 主动中断不应触发重试
  return /timeout|超时|ECONNRESET|fetch failed/i.test(String(err?.message || ''));
}

export async function createProvider(cfg, modelName, { timeoutMs = 300000, retries = 2 } = {}) {
  const pc = resolveProviderConfig(cfg, modelName);

  // 自定义 Provider 模块优先（仅普通自定义端点；custom:<模型名> 走 OpenAI 兼容直连）
  const customFile = path.join(mingdaoHome(), 'providers', pc.name + '.mjs');
  if (pc.isCustom && !pc.name.includes(':') && fs.existsSync(customFile)) {
    const mod = await import(pathToFileURL(customFile).href + `?v=${Date.now()}`);
    if (typeof mod.createProvider !== 'function') {
      throw new Error(`自定义 Provider 模块 ${customFile} 未导出 createProvider(cfg)。`);
    }
    const custom = await mod.createProvider(pc);
    return { ...custom, name: pc.name, config: pc };
  }

  if (!pc.baseUrl) {
    throw new Error(`服务商 "${pc.name}" 缺少 baseUrl，请运行 mingdao init 重新配置。`);
  }

  return {
    name: pc.name,
    config: pc,
    async chat(opts) {
      let attempt = 0;
      for (;;) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(new Error('请求超时')), timeoutMs);
        // 转发外部信号（用户 Ctrl+C 中断），避免被内部超时信号覆盖
        const onUserAbort = () => ac.abort(opts.signal?.reason);
        if (opts.signal?.aborted) onUserAbort();
        else opts.signal?.addEventListener('abort', onUserAbort, { once: true });
        try {
          return await openaiChat({
            ...opts,
            baseUrl: pc.baseUrl,
            apiKey: pc.apiKey,
            signal: ac.signal,
            includeUsage: cfg?.includeUsage !== false,
          });
        } catch (err) {
          // 内部超时经 abort 抛出（reason 不会成为 fetch 错误 message），需单独识别；
          // 用户 Ctrl+C 的中断不算超时、不重试
          const timedOut = err?.name === 'AbortError' && !opts.signal?.aborted;
          const transient = timedOut || isTransient(err);
          if (!transient || attempt >= retries) throw err;
          attempt += 1;
          await sleep(1000 * attempt); // 指数退避：1s / 2s
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', onUserAbort);
        }
      }
    },
  };
}

// 辅助调用（标题生成/记忆提取等）的 provider 解析（评估 P2-2）：辅助模型与当前模型
// 分属不同服务商时单独创建 provider——避免拿 deepseek-v4-flash 模型名去自定义网关请求
// 而 404 被静默吞掉（标题缺失、记忆永不沉淀且零感知）。
export async function helperProvider(cfg, helperModel, currentProvider) {
  try {
    const curName = String(currentProvider?.name || '');
    const helperName = String(resolveProviderConfig(cfg, helperModel)?.name || '');
    if (curName && curName === helperName) return currentProvider;
  } catch {}
  try {
    return await createProvider(cfg, helperModel);
  } catch {
    return currentProvider;
  }
}
