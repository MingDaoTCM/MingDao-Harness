// Batch API 半价通道（四报告共识 A1/OfficeACE P0：批量任务省 50%）：
// 单轮批量任务（无工具、无流式）走 OpenAI 兼容批处理协议：
//   POST {base}/files（multipart，purpose=batch）→ input_file_id
//   POST {base}/batches {input_file_id, endpoint, completion_window:'24h'} → batchId
//   轮询 GET {base}/batches/{id} → completed → 下载结果（DeepSeek 风格 /files/result，回退 OpenAI /files/{id}/content）
// 端点不可用（404/405）→ 明确报错告知网关不支持批处理，绝不静默假装成功。
// 计费：闲时全未命中 × BATCH_DISCOUNT（0.5），结果记入 cache-stats（batch:true）供 /cost 汇总。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveProviderConfig } from './providers/index.js';
import { estimateBatchCost, BATCH_DISCOUNT } from './pricing.js';
import { recordCacheStats } from './cachestats.js';
import { approxTokens } from './context.js';

const DEFAULT_WINDOW = '24h';
const DEFAULT_ENDPOINT = '/v1/chat/completions';

// 批处理端点基址：config.batchBaseUrl 优先；否则取当前服务商 baseUrl 去掉 /v1 后缀
function batchBase(/** @type {any} */ cfg, /** @type {any} */ model) {
  const explicit = String(cfg?.batchBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const pc = resolveProviderConfig(cfg, model);
  // 审计 P2-10：DeepSeek 的批处理端点在根路径（/files /batches），其余 OpenAI 兼容网关在 /v1 下
  const base = String(pc.baseUrl || '').replace(/\/+$/, '');
  return pc.name === 'deepseek' ? base.replace(/\/v1\/?$/, '') : base;
}

/** @returns {Promise<any>} */
async function api(/** @type {any} */ base, /** @type {any} */ apiKey, /** @type {any} */ methodPath, /** @type {any} */ payload, httpMethod = 'POST') {
  const res = await fetch(base + methodPath, {
    method: httpMethod,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const j = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok) {
    const e = /** @type {Error & { status?: number }} */ (new Error(j?.error?.message || j?.message || `HTTP ${res.status}`));
    e.status = res.status;
    throw e;
  }
  return j;
}

/**
 * 请求服务端**真正取消**批次（OpenAI 兼容：POST /batches/{id}/cancel）。
 *
 * 为什么必须有这一步：本地「停止轮询」不等于「停止计费」。此前用户按 Ctrl+C 后，
 * 轮询停了、进程退了，但服务端批次照跑照结算（Batch 是 0.5× 但**全量 token**）。
 * 对一个主打「成本确定性」的项目来说，这是最不该有的缺口——用户以为停了，钱照扣。
 * 服务端不一定实现该端点（返回 404/400 都出现过），因此失败必须如实上报，
 * 而不是让用户以为已经停了。
 * @returns {Promise<boolean>} 服务端是否接受了取消
 */
async function cancelServerBatch(/** @type {any} */ base, /** @type {any} */ apiKey, /** @type {any} */ id) {
  try {
    await api(base, apiKey, `/batches/${id}/cancel`, {}, 'POST');
    return true;
  } catch {
    return false;
  }
}

async function uploadFile(/** @type {any} */ base, /** @type {any} */ apiKey, /** @type {any} */ jsonl) {
  const form = new FormData();
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'mingdao-batch.jsonl');
  form.append('purpose', 'batch');
  const res = await fetch(base + '/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const j = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok) {
    const e = /** @type {Error & { status?: number }} */ (new Error(j?.error?.message || j?.message || `上传失败 HTTP ${res.status}`));
    e.status = res.status;
    throw e;
  }
  return j.id;
}

async function downloadResults(/** @type {any} */ base, /** @type {any} */ apiKey, /** @type {any} */ batch) {
  // DeepSeek 风格：直接取结果文件；回退 OpenAI 风格：按 output_file_id 取内容
  const attempts = [
    `/batches/${batch.id}/files/result`,
    ...(batch.output_file_id ? [`/files/${batch.output_file_id}/content`] : []),
  ];
  for (const m of attempts) {
    const res = await fetch(base + m, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) continue;
    const text = await res.text();
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  throw new Error('批处理结果文件不可用（端点不支持或文件已过期）');
}

/** 执行一次批处理。questions: string[]。返回 { ok, outputFile, results, usage, cost, batchId, deduped }
 * 省钱 B2：①文本哈希去重（重复问题只提交一次，结果回填全部位置）；②单问超窗口预检（提交前报错，不烧钱）；
 * ③maxCost 预算上限（提交前按估算费用拦截，超出直接中止不提交）。
 * @param {{ cfg: any, model: any, questions: any, workingDir?: string, maxTokens?: number, temperature?: any, signal?: any, onStatus?: any, maxCost?: number }} opts */
export async function runBatch({ cfg, model, questions, workingDir = process.cwd(), maxTokens = 4096, temperature, signal, onStatus, maxCost = 0 }) {
  const list = (questions || []).map((/** @type {any} */ q) => String(q).trim()).filter(Boolean);
  if (!list.length) return { error: '没有可批处理的问题（每行一个问题）' };
  const pc = resolveProviderConfig(cfg, model);
  if (!pc.apiKey) return { error: `模型 ${model} 没有可用 API Key（mingdao key set ${pc.name}）` };
  const base = batchBase(cfg, model);
  const apiKey = pc.apiKey;
  // 审计（workbuddy P2-1）：批量任务无缓存语义，每个问题的 system 都按 input 全价计费——
  // 不再携带完整系统提示（技能清单/用户记忆/AGENTS.md 对无工具批任务毫无意义，1000 问
  // 可白烧 50-80 万 token）；改用一行精简角色提示，剩余能力损失为零。
  const systemPrompt = '你是 MingDao Harness 编程助手。直接针对每个问题给出准确、完整的答案，不要复述问题、不要解释过程。';

  // —— 省钱 B2：文本哈希去重（trim 后逐字节一致视为重复）——
  const positions = /** @type {Map<string, number[]>} */ (new Map()); // hash → [输入行下标...]
  const unique = /** @type {string[]} */ ([]);
  list.forEach((/** @type {string} */ q, /** @type {number} */ i) => {
    const h = crypto.createHash('sha256').update(q).digest('hex');
    if (!positions.has(h)) {
      positions.set(h, [i]);
      unique.push(q);
    } else {
      positions.get(h)?.push(i);
    }
  });
  const posByUniqueIdx = unique.map((/** @type {string} */ q) => positions.get(crypto.createHash('sha256').update(q).digest('hex')) || []);
  const deduped = list.length - unique.length;
  if (deduped > 0) onStatus?.(`去重：${deduped} 条重复问题合并（${list.length} → ${unique.length} 条实际提交）`);

  // —— 省钱 B2：单问超窗口预检（估算输入 + max_tokens 超过模型窗口 95% 即报错，绝不提交烧钱）——
  // v0.4.1 P1 修复：接入 resolveModelCaps 取真实 contextWindow（此前用 preset.budgetTokens 当窗口，
  // 本地小模型 32k 窗口会套 128000 默认 → 超窗口预检完全失效，提交后烧钱且失败）。
  const { resolveModelCaps } = await import('./model-caps.js');
  const windowTokens = resolveModelCaps(cfg, model).contextWindow;
  const sysTokens = approxTokens(systemPrompt);
  for (let i = 0; i < unique.length; i++) {
    const est = sysTokens + approxTokens(unique[i]);
    if (est + maxTokens > windowTokens * 0.95) {
      return {
        error: `第 ${posByUniqueIdx[i][0] + 1} 个问题超窗口：估算输入 ${est} + max_tokens ${maxTokens} > 模型窗口 ${windowTokens}（可 --max-tokens 调小或拆分问题）`,
      };
    }
  }

  // —— 省钱 B2：--max-cost 预算上限（提交前估算拦截）——
  let estimatedCost = /** @type {number|null} */ (0);
  if (maxCost > 0) {
    const estPrompt = unique.reduce((s, q) => s + sysTokens + approxTokens(q), 0);
    const estCompletion = unique.length * Math.min(maxTokens, 2048); // 保守按平均 2K 输出估算
    estimatedCost = estimateBatchCost(model, estPrompt, estCompletion);
    // v0.4.6：无价模型估算为 null（未知）——--max-cost 是「预算保障」，未知即无法保障，
    // 必须 fail-closed 中止提交；此前 null 被当 0、拦截恒不触发（与 P0-4 同类静默失效）。
    if (estimatedCost == null) {
      return {
        error: `模型 ${model} 没有价格数据，无法估算 Batch 费用，--max-cost 预算保障失效，已中止提交。请先在 config.pricing.overrides 配置该模型价格，或去掉 --max-cost（自行承担预算风险）后重试。`,
        estimatedCost: null,
      };
    }
    if (estimatedCost > maxCost) {
      return {
        error: `预计费用 ≈¥${estimatedCost.toFixed(4)}（已按半价）超过 --max-cost ¥${maxCost}，已中止提交。可缩小问题集或调高上限。`,
        estimatedCost,
      };
    }
  }

  const bodyTemplate = {
    model,
    messages: null, // 逐行填充
    max_tokens: maxTokens,
    temperature: temperature ?? cfg?.temperature ?? 0.6,
    stream: false,
  };
  const jsonl =
    unique
      .map((q, i) =>
        JSON.stringify({
          custom_id: `md-${i}`,
          method: 'POST',
          url: cfg?.batchEndpoint || DEFAULT_ENDPOINT,
          body: { ...bodyTemplate, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: q }] },
        })
      )
      .join('\n') + '\n';

  try {
    onStatus?.('上传输入文件…');
    const fileId = await uploadFile(base, apiKey, jsonl);
    onStatus?.('创建批处理任务…');
    const batch = await api(base, apiKey, '/batches', {
      input_file_id: fileId,
      endpoint: cfg?.batchEndpoint || DEFAULT_ENDPOINT,
      completion_window: cfg?.batchWindow || DEFAULT_WINDOW,
    });
    onStatus?.(`任务已创建：${batch.id}`);
    // 轮询：指数退避（审计 workbuddy P3-3）——基础间隔 5s（MINGDAO_BATCH_POLL_MS 可覆盖，测试用），
    // ×1.5 逐次翻倍、30s 封顶：24h 窗口内轮询请求量从 ~1.7 万次降到 ~3 千次；
    // 连续失败 10 次 → 报错，绝不无限重试。每次轮询报告进度（含已处理 X/Y）。
    const baseInterval = Math.max(500, Number(process.env.MINGDAO_BATCH_POLL_MS) || 5000);
    const t0 = Date.now();
    let st = batch.status;
    let failures = 0;
    let polls = 0;
    for (;;) {
      if (signal?.aborted) {
        // 本地取消必须尽力转化为服务端取消，否则用户以为停了、账单照涨
        const cancelled = await cancelServerBatch(base, apiKey, batch.id);
        return {
          error: cancelled
            ? '已取消（已请求服务端停止该批次）'
            : '已停止本地轮询，但服务端取消未成功——该批次可能仍在运行并计费。请到服务商后台确认。',
          batchId: batch.id,
          cancelled,
        };
      }
      if (Date.now() - t0 > 24 * 3600 * 1000) {
        // 超窗口同样要尝试停掉，避免留下一个无人接管却在计费的批次
        const cancelled = await cancelServerBatch(base, apiKey, batch.id);
        return {
          error: `批处理超过 24h 窗口${cancelled ? '（已请求服务端停止）' : '（服务端取消失败，批次可能仍在计费）'}`,
          batchId: batch.id,
          cancelled,
        };
      }
      let j = null;
      try {
        j = await api(base, apiKey, `/batches/${batch.id}`, undefined, 'GET');
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= 10) return { error: `轮询失败：${(/** @type {any} */ (err))?.message || err}（任务仍在服务端，ID ${batch.id}）`, batchId: batch.id };
        await new Promise((r) => setTimeout(r, Math.min(baseInterval * 1.5 ** failures, 30000)));
        continue;
      }
      st = j.status;
      if (st === 'completed') {
        batch.output_file_id = j.output_file_id;
        break;
      }
      if (['failed', 'expired', 'cancelled', 'canceled'].includes(st)) {
        const detail = j?.errors?.data?.[0]?.message || j?.errors?.message || '';
        return { error: `批处理失败：${st}${detail ? '（' + detail + '）' : ''}`, batchId: batch.id };
      }
      polls += 1;
      const rc = j?.request_counts || {};
      const done = rc.completed != null && rc.total != null ? `${rc.completed}/${rc.total}` : '';
      onStatus?.(`状态：${st}${done ? `（已处理 ${done}）` : ''}`);
      await new Promise((r) => setTimeout(r, Math.min(baseInterval * 1.5 ** polls, 30000)));
    }
    onStatus?.('下载结果…');
    const results = await downloadResults(base, apiKey, batch);
    // 汇总 usage 与费用（batch 半价）；结果按 custom_id 回填到全部重复位置（省钱 B2）
    let prompt = 0;
    let completion = 0;
    const outputs = /** @type {Array<{id: string, content: string}>} */ (new Array(list.length));
    for (const r of results) {
      const body = r?.response?.body || {};
      prompt += body.usage?.prompt_tokens || 0;
      completion += body.usage?.completion_tokens || 0;
      const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? (r?.response?.status_code !== 200 ? `（错误 ${r?.response?.status_code}）` : '');
      const m = /^md-(\d+)$/.exec(String(r.custom_id || ''));
      const ui = m ? Number(m[1]) : -1;
      const idxs = ui >= 0 && ui < posByUniqueIdx.length ? posByUniqueIdx[ui] : [];
      for (const pos of idxs) {
        outputs[pos] = { id: String(pos), content: String(content || '').trim() };
      }
    }
    // 防御：服务端漏回的 custom_id 用占位补全，保证输出行数与输入行数一一对应
    for (let i = 0; i < outputs.length; i++) {
      if (!outputs[i]) outputs[i] = { id: String(i), content: '' };
    }
    const usage = { prompt_tokens: prompt, completion_tokens: completion };
    const cost = estimateBatchCost(model, prompt, completion);
    const outFile = path.join(workingDir, `mingdao-batch-result-${Date.now()}.jsonl`);
    fs.writeFileSync(outFile, outputs.map((o) => JSON.stringify(o)).join('\n') + '\n');
    recordCacheStats({ model, prompt, completion, hit: null, miss: null, cost, saved: null, batch: true });
    onStatus?.(`完成：${outputs.length} 条结果${deduped ? `（去重合并 ${deduped} 条）` : ''}`);
    return { ok: true, batchId: batch.id, outputFile: outFile, results: outputs, usage, cost, discount: BATCH_DISCOUNT, deduped, estimatedCost };
  } catch (err) {
    // 批处理端点不支持（404/405 等）→ 明确告知，不静默
    return { error: `批处理不可用：${(/** @type {any} */ (err))?.message || err}（该服务商可能不支持 Batch API，可用 config.batchBaseUrl 指定支持的网关）` };
  }
}
