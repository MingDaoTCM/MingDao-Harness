// Batch API 半价通道（四报告共识 A1/OfficeACE P0：批量任务省 50%）：
// 单轮批量任务（无工具、无流式）走 OpenAI 兼容批处理协议：
//   POST {base}/files（multipart，purpose=batch）→ input_file_id
//   POST {base}/batches {input_file_id, endpoint, completion_window:'24h'} → batchId
//   轮询 GET {base}/batches/{id} → completed → 下载结果（DeepSeek 风格 /files/result，回退 OpenAI /files/{id}/content）
// 端点不可用（404/405）→ 明确报错告知网关不支持批处理，绝不静默假装成功。
// 计费：闲时全未命中 × BATCH_DISCOUNT（0.5），结果记入 cache-stats（batch:true）供 /cost 汇总。

import fs from 'node:fs';
import path from 'node:path';
import { resolveProviderConfig } from './providers/index.js';
import { estimateBatchCost, BATCH_DISCOUNT } from './pricing.js';
import { recordCacheStats } from './cachestats.js';
import { buildSystemPrompt } from './prompts.js';

const DEFAULT_WINDOW = '24h';
const DEFAULT_ENDPOINT = '/v1/chat/completions';

// 批处理端点基址：config.batchBaseUrl 优先；否则取当前服务商 baseUrl 去掉 /v1 后缀
function batchBase(cfg, model) {
  const explicit = String(cfg?.batchBaseUrl || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const pc = resolveProviderConfig(cfg, model);
  return String(pc.baseUrl || '').replace(/\/+$/, '').replace(/\/v1\/?$/, '');
}

async function api(base, apiKey, methodPath, payload, httpMethod = 'POST') {
  const res = await fetch(base + methodPath, {
    method: httpMethod,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j?.error?.message || j?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return j;
}

async function uploadFile(base, apiKey, jsonl) {
  const form = new FormData();
  form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'mingdao-batch.jsonl');
  form.append('purpose', 'batch');
  const res = await fetch(base + '/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(j?.error?.message || j?.message || `上传失败 HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return j.id;
}

async function downloadResults(base, apiKey, batch) {
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

// 执行一次批处理。questions: string[]。返回 { ok, outputFile, results, usage, cost, batchId }
export async function runBatch({ cfg, model, questions, workingDir = process.cwd(), maxTokens = 4096, temperature, signal, onStatus }) {
  const list = (questions || []).map((q) => String(q).trim()).filter(Boolean);
  if (!list.length) return { error: '没有可批处理的问题（每行一个问题）' };
  const pc = resolveProviderConfig(cfg, model);
  if (!pc.apiKey) return { error: `模型 ${model} 没有可用 API Key（mingdao key set ${pc.name}）` };
  const base = batchBase(cfg, model);
  const apiKey = pc.apiKey;
  const systemPrompt = buildSystemPrompt({ workingDir });
  const bodyTemplate = {
    model,
    messages: null, // 逐行填充
    max_tokens: maxTokens,
    temperature: temperature ?? cfg?.temperature ?? 0.6,
    stream: false,
  };
  const jsonl =
    list
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
    // 轮询（间隔可用 MINGDAO_BATCH_POLL_MS 覆盖，测试用）；连续失败 10 次 → 报错，绝不无限重试
    const interval = Math.max(500, Number(process.env.MINGDAO_BATCH_POLL_MS) || 5000);
    const t0 = Date.now();
    let st = batch.status;
    let failures = 0;
    for (;;) {
      if (signal?.aborted) return { error: '已取消轮询（任务仍在服务端运行）', batchId: batch.id };
      if (Date.now() - t0 > 24 * 3600 * 1000) return { error: '批处理超过 24h 窗口', batchId: batch.id };
      let j = null;
      try {
        j = await api(base, apiKey, `/batches/${batch.id}`, undefined, 'GET');
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= 10) return { error: `轮询失败：${err?.message || err}（任务仍在服务端，ID ${batch.id}）`, batchId: batch.id };
        await new Promise((r) => setTimeout(r, interval));
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
      if (st !== 'in_progress' && st !== 'validating' && st !== 'finalizing') {
        // 未知状态：继续等待但报告
        onStatus?.(`状态：${st}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    onStatus?.('下载结果…');
    const results = await downloadResults(base, apiKey, batch);
    // 汇总 usage 与费用（batch 半价）
    let prompt = 0;
    let completion = 0;
    const outputs = [];
    for (const r of results) {
      const body = r?.response?.body || {};
      prompt += body.usage?.prompt_tokens || 0;
      completion += body.usage?.completion_tokens || 0;
      const content = body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? (r?.response?.status_code !== 200 ? `（错误 ${r?.response?.status_code}）` : '');
      outputs.push({ id: r.custom_id, content: String(content || '').trim() });
    }
    const usage = { prompt_tokens: prompt, completion_tokens: completion };
    const cost = estimateBatchCost(model, prompt, completion);
    const outFile = path.join(workingDir, `mingdao-batch-result-${Date.now()}.jsonl`);
    fs.writeFileSync(outFile, outputs.map((o) => JSON.stringify(o)).join('\n') + '\n');
    recordCacheStats({ model, prompt, completion, hit: null, miss: null, cost, saved: null, batch: true });
    onStatus?.(`完成：${outputs.length} 条结果`);
    return { ok: true, batchId: batch.id, outputFile: outFile, results: outputs, usage, cost, discount: BATCH_DISCOUNT };
  } catch (err) {
    // 批处理端点不支持（404/405 等）→ 明确告知，不静默
    return { error: `批处理不可用：${err?.message || err}（该服务商可能不支持 Batch API，可用 config.batchBaseUrl 指定支持的网关）` };
  }
}
