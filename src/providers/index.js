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
import { resolveApiKey, getStoredKey } from '../credentials.js';
import { isLocalBaseUrl } from '../model-caps.js';

export function resolveProviderConfig(/** @type {any} */ cfg, /** @type {any} */ modelName) {
  // 自定义模型（config.customModels，WebUI 可增删改）：优先于内置预设
  const cm = cfg?.customModels?.[modelName];
  if (cm) {
    // P1 修复（v0.4.6）：自定义模型的密钥解析不得成为「任意环境变量外泄」通道。
    // 此前 envKeys = [cm.envKey, 'MINGDAO_API_KEY']，而 envKey 与 baseUrl 都完全由调用方指定
    // （WebUI 的 addCustom 接受任意输入）——于是任何能加一个自定义模型的人，都能把宿主环境里的
    // 任意变量（AWS_SECRET_ACCESS_KEY / GITHUB_TOKEN / …）当作 Bearer 发到自己的端点；
    // 即使不填 envKey 也会回落 MINGDAO_API_KEY，把用户的主密钥送出去。两条路一起封：
    //   ① envKey 必须是「像模型密钥」的名字（大写、以 _API_KEY/_KEY 结尾、不含 SECRET/TOKEN/…）；
    //   ② 未声明（或被拒）时不读任何环境变量，只认凭证库——环境变量必须被显式点名才可用。
    const rawEnvKey = String(cm.envKey || '').trim();
    const safeEnvKey =
      /^[A-Z][A-Z0-9_]{2,63}$/.test(rawEnvKey) &&
      /(_API_KEY|_KEY)$/.test(rawEnvKey) &&
      !/(SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE|PASSWD)/.test(rawEnvKey)
        ? rawEnvKey
        : '';
    if (rawEnvKey && !safeEnvKey) {
      console.warn(
        `[MingDao] 自定义模型 ${modelName} 的 envKey「${rawEnvKey}」不是合法的模型密钥变量名，已忽略。` +
          `如需用环境变量提供密钥，请用形如 MY_GATEWAY_API_KEY 的名字；否则请用 mingdao key set custom:${modelName} 存入凭证库。`
      );
    }
    const envVal = safeEnvKey ? process.env[safeEnvKey] || '' : '';
    const storedKey = getStoredKey(`custom:${modelName}`) || getStoredKey('custom') || '';
    const apiKey = envVal || storedKey || '';
    return {
      name: `custom:${modelName}`,
      kind: 'openai-compatible',
      baseUrl: cm.baseUrl || cfg?.baseUrl || '',
      apiKey,
      envHint: safeEnvKey || `custom:${modelName}`,
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

const sleep = (/** @type {any} */ ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(/** @type {any} */ err) {
  const status = err?.status;
  if (status === 429 || (status >= 500 && status <= 504)) return true;
  // 注意：不含 abort —— 用户 Ctrl+C 主动中断不应触发重试
  return /timeout|超时|ECONNRESET|fetch failed/i.test(String(err?.message || ''));
}

export async function createProvider(/** @type {any} */ cfg, /** @type {any} */ modelName, /** @type {{ timeoutMs?: number, retries?: number }} */ { timeoutMs, retries = 2 } = {}) {
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

  // v0.3.2 本地模型自适应：本地推理框架（CPU/GPU 有限）长上下文 prefill 极慢（诊断实测 127k 上下文
  // 首 token 需 196s+，q8 dequant 下 prefill 仅 ~165 tok/s）。默认超时按是否本地分层：
  //  - 首 token 等待：本地 600s / 远程 300s（覆盖慢 prefill，而非 189s 被掐断）
  //  - 流式空闲：有帧后 120s 无新帧即断（真正挂死才断，慢速吐字不误杀）
  //  - 总量：本地 30min / 远程 10min（长生成不误杀）
  // 均可用 cfg.timeout.firstTokenMs / streamIdleMs / totalMs 覆盖。
  const isLocal = isLocalBaseUrl(pc.baseUrl);
  const tCfg = cfg?.timeout || {};
  const firstTokenMs = Number(tCfg.firstTokenMs) > 0 ? Number(tCfg.firstTokenMs) : (isLocal ? 600000 : 300000);
  const streamIdleMs = Number(tCfg.streamIdleMs) > 0 ? Number(tCfg.streamIdleMs) : 120000;
  const totalMs = Number(tCfg.totalMs) > 0 ? Number(tCfg.totalMs) : (Number(timeoutMs) > 0 ? Number(timeoutMs) : (isLocal ? 1800000 : 600000));

  return {
    name: pc.name,
    config: pc,
    async chat(/** @type {any} */ opts) {
      let attempt = 0;
      // P1-7（v0.4.5）：总量护栏提到重试循环外层——此前每 attempt 重建 totalTimer，重试序列最坏
      // 放大 retries+1 倍（本地 3×30min=90min）。总时长覆盖整个重试序列，单次首 token/流式空闲仍按 attempt 计。
      let totalExpired = false;
      let currentAc = /** @type {AbortController | null} */ (null);
      const totalTimer = setTimeout(() => {
        totalExpired = true;
        try {
          currentAc?.abort(new Error(`请求总时长超限（${Math.round(totalMs / 1000)}s），已中断`));
        } catch {}
      }, totalMs);
      for (;;) {
        const ac = new AbortController();
        currentAc = ac;
        let timedOut = false; // 审计 P2-6：用标志而非 name/字符串匹配识别内部超时（首 token/流式空闲）
        // 首 token 等待：prefill 阶段无任何帧到达即断（覆盖长上下文慢 prefill）
        let firstTokenTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (setTimeout(() => {
          timedOut = true;
          ac.abort(new Error(`首 token 等待超限（${Math.round(firstTokenMs / 1000)}s，本地模型长上下文 prefill 可能很慢）——可调大 config.timeout.firstTokenMs，或拆分任务/压缩上下文`));
        }, firstTokenMs));
        // 流式空闲：有帧后 120s 无新帧即断；每收到一帧重置
        let idleTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            ac.abort(new Error(`流式响应空闲超限（${Math.round(streamIdleMs / 1000)}s 无新数据）`));
          }, streamIdleMs);
        };
        const onActivity = () => {
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = null;
          }
          armIdle();
        };
        // 转发外部信号（用户 Ctrl+C 中断），避免被内部超时信号覆盖
        const onUserAbort = () => ac.abort(opts.signal?.reason);
        if (opts.signal?.aborted) onUserAbort();
        else opts.signal?.addEventListener('abort', onUserAbort, { once: true });
        let leaving = true; // 本次 attempt 是否退出（成功/不再重试）；将重试则置 false，总量计时器保留覆盖下一 attempt
        try {
          return await openaiChat({
            ...opts,
            baseUrl: pc.baseUrl,
            apiKey: pc.apiKey,
            signal: ac.signal,
            includeUsage: cfg?.includeUsage !== false,
            onActivity,
          });
        } catch (err) {
          // 内部超时经 abort 抛出，用标志识别（审计 P2-6）；用户 Ctrl+C 的中断不算超时、不重试。
          // 总量超时（totalExpired）覆盖整个序列，超了直接抛不再重试。
          const transient = !totalExpired && ((timedOut && !opts.signal?.aborted) || isTransient(err));
          if (!transient || attempt >= retries) throw err;
          leaving = false; // 将重试：本次不退出，总量计时器继续覆盖下一 attempt
          attempt += 1;
          // 首 token 等待超时通常不是偶发网络抖动（是模型/上下文慢），重试价值低但保留一次机会；
          // 其余瞬态错误指数退避 + 尊重 Retry-After（评估 P3-1）：基础 1s/2s，封顶 30s
          let backoff = 1000 * attempt;
          const ra = Number((/** @type {any} */ (err))?.headers?.get?.('retry-after'));
          if (Number.isFinite(ra) && ra > 0) backoff = Math.max(backoff, ra * 1000);
          backoff = Math.min(backoff, 30000);
          await sleep(backoff);
        } finally {
          if (leaving) clearTimeout(totalTimer); // 成功/最终失败即清——避免悬挂 totalMs 计时器（每请求一个）
          if (firstTokenTimer) clearTimeout(firstTokenTimer);
          if (idleTimer) clearTimeout(idleTimer);
          opts.signal?.removeEventListener('abort', onUserAbort);
        }
      }
    },
  };
}

// 辅助调用（标题生成/记忆提取等）的 provider 解析（评估 P2-2）：辅助模型与当前模型
// 分属不同服务商时单独创建 provider——避免拿 deepseek-v4-flash 模型名去自定义网关请求
// 而 404 被静默吞掉（标题缺失、记忆永不沉淀且零感知）。
export async function helperProvider(/** @type {any} */ cfg, /** @type {any} */ helperModel, /** @type {any} */ currentProvider) {
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
