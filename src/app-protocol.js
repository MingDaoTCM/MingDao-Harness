// v0.8.2（T02/T05/T06 接线层）：DeepSeek「应用全家桶」的**本地协议常量与预算校验器**。
//
// 为什么单独一层：附件/语音的预算（数量、体积、时长、字符数）与拒答文案必须**只有一份**——
// 审计 M-03/M-04 的根因就是「CLI 一套、别处一套」的漂移规则；发请求前的本地失败也要求
// 「零网络调用」，所以校验器必须是**无 IO 的纯函数**（调用方先量体积/读头，再决定是否发网络）。
//
// 规则出处（v0.8.2 修复执行清单 T05）：
//   · Files API：单文件 100 MiB、请求内文档合计 32 MiB、单请求最多 20 个文档；
//   · ASR：仅 16-bit PCM WAV 或 Ogg Opus，最大 8 MiB、最长 120 秒；
//   · TTS：文本最多 10000 计费字符、请求体最大 64 KiB。
//
// 零运行时依赖；本模块不读文件、不发网络。

/**
 * 安全拒答的**固定文案**（CLI / Web / 前端三处共用同一份，不夹带任何被撤下的正文）。
 *
 * T02 口径：`stop_reason:'refusal'` 是「拒答」终态——已经流出的正文必须撤回，
 * 界面/终端只显示这段固定说明，绝不显示原正文。
 * @type {string}
 */
export const APP_REFUSAL_MESSAGE =
  'DeepSeek 安全策略已拒答并撤回了这次生成：本轮已产出的正文不再显示，也不会写入会话。请修改问题或材料后重试（本次调用不计为成功）。';

/** 单次请求最多可带的文档数（Files API 引用块）。 */
export const DOC_MAX_FILES = 20;
/** 单个文档体积上限：100 MiB。 */
export const DOC_MAX_BYTES = 100 * 1024 * 1024;
/** 一次请求内所有文档的合计体积上限：32 MiB。 */
export const DOCS_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
/** ASR 音频体积上限：8 MiB。 */
export const ASR_MAX_BYTES = 8 * 1024 * 1024;
/** ASR 音频时长上限：120 秒。 */
export const ASR_MAX_SECONDS = 120;
/** TTS 文本上限：10000 计费字符。 */
export const TTS_MAX_CHARS = 10000;
/** TTS 请求体上限：64 KiB（JSON 序列化后的字节数）。 */
export const TTS_MAX_BODY_BYTES = 64 * 1024;

/** 1 MiB 的字节数（避免各处再写一遍魔法数）。 */
const MIB = 1024 * 1024;

/**
 * 把字节数格式化成「12.34 MiB」——错误文案里要同时出现**实际值/上限/单位**。
 * @param {number} bytes
 * @returns {string}
 */
export function formatMiB(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '0.00 MiB';
  return `${(n / MIB).toFixed(2)} MiB`;
}

/**
 * 文档预算校验（**上传/转换之前**调用；只吃已量好的体积，不读文件）。
 *
 * 超限时 `error` 里同时给出实际值、上限与单位（DS-21/DS-22 的可读断言就钉在这上面）。
 * @param {Array<{name?: string, bytes: number}>} entries 每个待上传文件的名字与字节数
 * @returns {{ok: true, totalBytes: number} | {ok: false, error: string}}
 */
export function checkDocumentsBudget(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > DOC_MAX_FILES) {
    return {
      ok: false,
      error: `附件数量 ${list.length} 个超过上限 ${DOC_MAX_FILES} 个——请减少文件后重试（本次未读取/未上传任何文件）。`,
    };
  }
  let totalBytes = 0;
  for (const entry of list) {
    const bytes = Number(entry?.bytes);
    const size = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    const name = String(entry?.name || '（未命名文件）');
    if (size > DOC_MAX_BYTES) {
      return {
        ok: false,
        error: `文件 ${name} 大小 ${formatMiB(size)} 超过单文件上限 ${formatMiB(DOC_MAX_BYTES)}（100 MiB）——本次未读取/未上传任何文件。`,
      };
    }
    totalBytes += size;
  }
  if (totalBytes > DOCS_TOTAL_MAX_BYTES) {
    return {
      ok: false,
      error: `请求内文档合计 ${formatMiB(totalBytes)} 超过上限 ${formatMiB(DOCS_TOTAL_MAX_BYTES)}（32 MiB）——本次未上传任何文件。`,
    };
  }
  return { ok: true, totalBytes };
}

/**
 * 取音频扩展名决定 ASR 允许的容器：`'wav'`（16-bit PCM）或 `'ogg'`（Ogg Opus）。
 * 其余一律返回空串（调用方按「不支持」本地失败，绝不发网络）。
 * @param {string} filename
 * @returns {'wav'|'ogg'|''}
 */
export function asrContainerOf(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop() || '';
  if (ext === 'wav') return 'wav';
  if (ext === 'ogg' || ext === 'opus') return 'ogg';
  return '';
}

/**
 * ASR 体积预算（只吃已量好的大小；超限必须在读 body/上传之前失败）。
 * @param {number} bytes
 * @param {string} [name]
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function checkAsrSize(bytes, name = '音频') {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, error: `音频 ${name} 为空（0 字节）——没有可转写的内容。` };
  }
  if (size > ASR_MAX_BYTES) {
    return {
      ok: false,
      error: `音频 ${name} 大小 ${formatMiB(size)} 超过上限 ${formatMiB(ASR_MAX_BYTES)}（8 MiB）——本次未发起转写请求。`,
    };
  }
  return { ok: true };
}

/**
 * 读 WAV 头（RIFF/WAVE + fmt/data），返回编码与时长。
 *
 * 为什么要读到头部字段：官方 ASR 只接受 **16-bit PCM WAV**；扩展名是 `.wav` 不代表编码对，
 * 只看扩展名会把 32-bit float / ADPCM 静默发上去（T05 明确要求「扩展名之外还要验证实际编码」）。
 * @param {Uint8Array} audio
 * @returns {{ok: true, audioFormat: number, channels: number, sampleRate: number, bitsPerSample: number, durationSeconds: number} | {ok: false, error: string}}
 */
export function parseWavHeader(audio) {
  const bytes = audio;
  const readAscii = (/** @type {number} */ start, /** @type {number} */ len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[start + i]);
    return s;
  };
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 44) {
    return { ok: false, error: 'WAV 文件头不完整（小于 44 字节）——无法在本地确认它是 16-bit PCM WAV。' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, bytes.buffer.byteLength - bytes.byteOffset));
  if (readAscii(0, 4) !== 'RIFF' || readAscii(8, 4) !== 'WAVE') {
    return { ok: false, error: '不是合法的 RIFF/WAVE 文件——ASR 只接受 16-bit PCM WAV。' };
  }
  let offset = 12;
  let fmt = null;
  let dataSize = 0;
  const limit = Math.min(bytes.byteLength, 1024 * 1024); // 头搜索有界：不为畸形文件整文件扫描
  while (offset + 8 <= limit) {
    const id = readAscii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, bytes.byteLength - body));
      break;
    }
    offset = body + size + (size % 2); // RIFF 块按偶数字节对齐
  }
  if (!fmt) return { ok: false, error: 'WAV 缺少 fmt 块——无法在本地确认编码。' };
  if (fmt.audioFormat !== 1) {
    return { ok: false, error: `WAV 编码不是 16-bit PCM（audioFormat=${fmt.audioFormat}）——ASR 只接受 16-bit PCM WAV。` };
  }
  if (fmt.bitsPerSample !== 16) {
    return { ok: false, error: `WAV 位深 ${fmt.bitsPerSample}-bit 不是 16-bit——ASR 只接受 16-bit PCM WAV。` };
  }
  if (!(fmt.channels > 0) || !(fmt.sampleRate > 0)) {
    return { ok: false, error: 'WAV 头的声道数/采样率非法——无法在本地确认音频时长。' };
  }
  const durationSeconds = dataSize / (fmt.sampleRate * fmt.channels * 2);
  return { ok: true, ...fmt, durationSeconds };
}

/**
 * 读 Ogg 容器的 Opus 编码与时长（取最后一页的 granule position，扣除 OpusHead pre-skip）。
 * 读不到时长时**明确失败**——宁可本地拒绝，也不宣称「已验证」把文件发上去。
 * @param {Uint8Array} audio
 * @returns {{ok: true, durationSeconds: number} | {ok: false, error: string}}
 */
export function parseOggOpus(audio) {
  const bytes = audio;
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 27) {
    return { ok: false, error: 'Ogg 文件头不完整——无法在本地确认它是 Ogg Opus。' };
  }
  const ascii = (/** @type {number} */ start, /** @type {number} */ len) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += String.fromCharCode(bytes[start + i]);
    return s;
  };
  if (ascii(0, 4) !== 'OggS') return { ok: false, error: '不是合法的 Ogg 容器——ASR 只接受 Ogg Opus。' };
  let preSkip = 0;
  let sawOpus = false;
  const headWindow = Math.min(bytes.byteLength, 512);
  for (let i = 0; i + 8 <= headWindow; i += 1) {
    if (ascii(i, 8) === 'OpusHead') {
      sawOpus = true;
      if (i + 12 <= bytes.byteLength) preSkip = bytes[i + 10] | (bytes[i + 11] << 8);
      break;
    }
  }
  let lastGranule = -1;
  let offset = 0;
  const total = bytes.byteLength;
  while (offset + 27 <= total) {
    if (ascii(offset, 4) !== 'OggS') break;
    const segments = bytes[offset + 26];
    const tableEnd = offset + 27 + segments;
    if (tableEnd > total) break;
    let bodyLen = 0;
    for (let i = 0; i < segments; i += 1) bodyLen += bytes[offset + 27 + i];
    const pageEnd = tableEnd + bodyLen;
    if (pageEnd > total) break;
    let granule = 0;
    for (let i = 7; i >= 0; i -= 1) granule = granule * 256 + bytes[offset + 6 + i];
    if (granule >= 0) lastGranule = granule;
    for (let i = offset + 27; i + 8 <= Math.min(pageEnd, offset + 27 + 64); i += 1) {
      if (ascii(i, 8) === 'OpusHead') sawOpus = true;
    }
    offset = pageEnd;
  }
  if (!sawOpus) return { ok: false, error: 'Ogg 容器里没有 Opus 编码（OpusHead 缺失）——ASR 只接受 Ogg Opus。' };
  if (lastGranule < 0) {
    return { ok: false, error: '无法在本地确认 Ogg Opus 的时长（缺少 granule position）——为避免超限请求，本次未发起转写。' };
  }
  const durationSeconds = Math.max(0, lastGranule - preSkip) / 48000;
  return { ok: true, durationSeconds };
}

/**
 * ASR 音频内容/时长预算（**转写请求之前**调用）。
 * @param {string} filename
 * @param {Uint8Array} audio
 * @returns {{ok: true, container: 'wav'|'ogg', durationSeconds: number} | {ok: false, error: string}}
 */
export function checkAsrAudio(filename, audio) {
  const container = asrContainerOf(filename);
  if (!container) {
    return {
      ok: false,
      error: `不支持的音频格式（${String(filename || '未知文件')}）：DeepSeek ASR 只接受 16-bit PCM WAV（.wav）或 Ogg Opus（.ogg/.opus）——本次未发起转写请求。`,
    };
  }
  const parsed = container === 'wav' ? parseWavHeader(audio) : parseOggOpus(audio);
  if (!parsed.ok) return parsed;
  if (parsed.durationSeconds > ASR_MAX_SECONDS) {
    return {
      ok: false,
      error: `音频时长 ${parsed.durationSeconds.toFixed(1)} 秒超过上限 ${ASR_MAX_SECONDS} 秒——本次未发起转写请求。`,
    };
  }
  return { ok: true, container, durationSeconds: parsed.durationSeconds };
}

/**
 * TTS 预算：文本字符数 + JSON 请求体字节数（**合成请求之前**调用）。
 *
 * 字符数按 Unicode 码点计（官方「计费字符」口径；`[...text].length` 不会把 emoji 算两次）。
 * @param {string} text
 * @param {{voice?: string}} [opts] 与真实请求体一致的 voice（请求体大小与它有关）
 * @returns {{ok: true, chars: number, bodyBytes: number} | {ok: false, error: string}}
 */
export function checkTtsBudget(text, opts = {}) {
  const value = String(text ?? '');
  const chars = [...value].length;
  if (chars > TTS_MAX_CHARS) {
    return {
      ok: false,
      error: `TTS 文本 ${chars} 字符超过上限 ${TTS_MAX_CHARS} 字符——本次未发起合成请求。`,
    };
  }
  // 与 deepseek-app.js 的 synthesizeSpeech 请求体保持同形（字段顺序也一致，便于边界对齐）。
  const body = JSON.stringify({
    text: value,
    voice_id: String(opts.voice || 'stella'),
    format: 'pcm',
    filter_markdown: true,
  });
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  if (bodyBytes > TTS_MAX_BODY_BYTES) {
    return {
      ok: false,
      error: `TTS 请求体 ${bodyBytes} 字节超过上限 ${TTS_MAX_BODY_BYTES} 字节（64 KiB）——本次未发起合成请求。`,
    };
  }
  return { ok: true, chars, bodyBytes };
}

/**
 * 把应用接口的 usage（Anthropic 风格 `input_tokens`/`output_tokens`）归一成
 * `src/cachestats.js#recordUsage` 认识的 OpenAI 风格字段。
 *
 * 为什么必须归一：cache-stats / 日费用护栏只认 `prompt_tokens`/`completion_tokens`，
 * 直接把 Anthropic usage 落账会得到「0 token / 无价」的假记录（费用护栏随之失明）。
 * @param {any} usage
 * @returns {{prompt_tokens: number, completion_tokens: number, prompt_cache_hit_tokens?: number, prompt_cache_miss_tokens?: number} | null}
 *   null = 没有可记的用量
 */
export function appUsageToCost(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const u = /** @type {any} */ (usage);
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
  const cacheRead = Number(u.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens ?? 0) || 0;
  const prompt = input + cacheRead + cacheWrite;
  if (!prompt && !output) return null;
  /** @type {{prompt_tokens: number, completion_tokens: number, prompt_cache_hit_tokens?: number, prompt_cache_miss_tokens?: number}} */
  const out = { prompt_tokens: prompt, completion_tokens: output };
  if (cacheRead > 0) {
    out.prompt_cache_hit_tokens = cacheRead;
    out.prompt_cache_miss_tokens = input + cacheWrite;
  }
  return out;
}
