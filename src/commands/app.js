// `mingdao app` 命令族（v0.8.0）：DeepSeek「应用全家桶」的 CLI 入口。
//
// 为什么单独一条命令、而不是塞进 Agent 工具循环：服务端工具（web_search / read_url）与
// 客户端工具**互斥**，两者同时声明会被上游拒绝；而这条路径的价值恰恰是「一次请求内多步完成」，
// 省掉「模型 → 工具 → 再发一次全上下文」的往返（会话越长省得越多）。
// 动作类 Agent 回合仍走 tools + OpenAI 兼容路径，`src/agent.js` 一行未改。
//
// 三个模式：
//   mingdao app "问题" [--search] [--think] [--no-url] [--file <路径>] [--json] [--out <文件>] [--voice stella|tide]
//   mingdao app --asr <音频文件>                                    只转写，不对话
//   mingdao app --tts "文本" [--voice …] [--out out.pcm]            只合成
//
// 退出码：0 = 成功；1 = 参数 / 配置 / 密钥 / 请求 / 语音 / 文件读写失败。
// **失败绝不静默 exit 0**：半截回答（流内 error）会先把已产出的正文/思考打出来，再说明原因并退非零。
//
// 零运行时依赖；网络与文件 IO 全部经 `overrides` 注入，单测不触网、不写用户目录。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, normalizeAppApi } from '../config.js';
import { resolveProviderConfig } from '../providers/index.js';
import {
  APP_DEFAULT_MODEL,
  TTS_SAMPLE_RATE,
  streamAppChat,
  uploadAppFile,
  transcribeAudio,
  synthesizeSpeech,
} from '../deepseek-app.js';
import { C, sanitizeTerminal, style } from '../ui.js';

const HELP = `用法：
  mingdao app "问题" [--search] [--think] [--no-url] [--file <路径>] [--json] [--out <文件>] [--voice stella|tide]
  mingdao app --asr <音频文件>                     只转写，不对话
  mingdao app --tts "文本" [--voice …] [--out out.pcm]  只合成（默认写 ./out.pcm）

说明：
  --search   开启服务端联网搜索（含「边想边搜」）
  --think    开启深度思考
  --no-url   关闭服务端阅读链接（默认开）
  --file     可多次；按扩展名决定 purpose：PDF/Word/PPT/图片 → rich_layout_recognition，
             其余（md/txt/csv/未知扩展名）→ user_data；上传后以 file_id 拼进最后一条 user 消息
  --json     输出 {text, thinking, title, searches, citations, fetches, usage, stopReason}
  --voice    stella|tide，聊天后把正文合成裸 PCM（24kHz 单声道 16-bit 小端）
  --out      PCM 输出路径（默认 ./out.pcm）

配置（可选）：config.json 的 appApi 提供默认值（model/search/readUrl/thinking/safetyLevel/title），
未配置时命令默认 search=false、readUrl=true、thinking=false、safetyLevel=high。
未配置 API Key 时先运行 mingdao init 或 mingdao key set deepseek。`;

/** 需要服务端「版面解析」的文件扩展名（PDF/Word/PPT/图片）——其余走 user_data。 */
const RICH_LAYOUT_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);

/** 以图片块（而非文档块）拼进消息的扩展名。 */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff']);

/** 常见扩展名 → MIME（只影响 multipart 的 Content-Type，未知扩展名回落 octet-stream）。 */
const MIME_BY_EXT = /** @type {Record<string, string>} */ ({
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
});

/** 音频扩展名 → MIME（ASR 上传用）。 */
const AUDIO_MIME_BY_EXT = /** @type {Record<string, string>} */ ({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
});

/**
 * 取小写扩展名（不含点）；无扩展名返回空串。
 * @param {string} filename
 * @returns {string}
 */
function extOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

/**
 * 按扩展名选 Files API 的 `purpose`。
 * 规则：PDF/Word/PPT/图片 → `rich_layout_recognition`（服务端版面解析）；其余 → `user_data`。
 * @param {string} filename
 * @returns {'rich_layout_recognition'|'user_data'}
 */
export function purposeForFile(filename) {
  return RICH_LAYOUT_EXTS.has(extOf(filename)) ? 'rich_layout_recognition' : 'user_data';
}

/**
 * 上传后用哪种内容块引用文件：图片 → `image`，其余 → `document`。
 * @param {string} filename
 * @returns {'document'|'image'}
 */
export function blockTypeForFile(filename) {
  return IMAGE_EXTS.has(extOf(filename)) ? 'image' : 'document';
}

/**
 * 把 OpenAI 兼容的 baseUrl 还原成应用接口的 API 根。
 *
 * 为什么必须做：`models.js` 里 DeepSeek 预设的 baseUrl 是 `https://api.deepseek.com/v1`
 * （OpenAI 兼容层在其后拼 `/chat/completions`），而应用接口的路径是
 * `{root}/anthropic/v1/messages` 与 `{root}/v1/tools/asr`——直接拿带 `/v1` 的 baseUrl 会拼成
 * `/v1/anthropic/v1/messages`（404）。所以这里去掉末尾的 `/v1`。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeAppBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/**
 * 解析本次请求用的模型：`cfg.appApi.model` 有值（哪怕非法 → 归一化回落）时优先，
 * 否则用 `cfg.model`，再否则用应用接口默认模型。
 * @param {any} cfg
 * @returns {string}
 */
export function resolveAppModel(cfg) {
  const raw = cfg && typeof cfg === 'object' ? cfg.appApi : undefined;
  const hasModel =
    Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, 'model');
  if (hasModel) return normalizeAppApi(raw).model;
  const fallback = cfg && typeof cfg === 'object' && typeof cfg.model === 'string' ? cfg.model.trim() : '';
  return fallback || APP_DEFAULT_MODEL;
}

/**
 * 把问题与已上传文件拼成 Messages 的 `messages`。
 * 有文件时用内容块数组（text 块 + document/image 块）；没有文件时保持纯字符串（与官方示例一致）。
 * @param {string} question
 * @param {Array<{type: 'document'|'image', fileId: string, name?: string}>} files
 * @returns {Array<{role: 'user', content: string|any[]}>}
 */
export function buildAppMessages(question, files) {
  const text = String(question || '').trim();
  if (!Array.isArray(files) || files.length === 0) {
    return [{ role: 'user', content: text }];
  }
  /** @type {any[]} */
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const f of files) {
    content.push({ type: f.type, source: { type: 'file', file_id: f.fileId } });
  }
  return [{ role: 'user', content }];
}

/**
 * 解析 `mingdao app` 的参数（纯函数，便于逐条钉边界）。
 *
 * 返回对象的 `error` 非空表示参数非法（调用方按用法错误退 1，不得继续发起请求）。
 * @param {any[]} argv 命令名之后的参数（`app` 本身不在内）
 * @returns {{help: boolean, error: string, question: string, search: boolean, think: boolean, readUrl: boolean, json: boolean, files: string[], out: string|null, voice: 'stella'|'tide'|null, asr: string|null, tts: string|null}}
 */
export function parseAppArgs(argv) {
  const args = Array.isArray(argv) ? argv.map((a) => String(a)) : [];
  const out = {
    help: false,
    error: '',
    question: '',
    search: false,
    think: false,
    readUrl: true,
    json: false,
    files: /** @type {string[]} */ ([]),
    out: /** @type {string|null} */ (null),
    voice: /** @type {'stella'|'tide'|null} */ (null),
    asr: /** @type {string|null} */ (null),
    tts: /** @type {string|null} */ (null),
  };
  /** @type {string[]} */
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      out.help = true;
      continue;
    }
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(arg);
    if (!m) {
      // 单个 `-` 视为普通文本；其余 `-x` / `--x` 一律当未知参数报错（拼错不能被静默忽略）。
      if (arg.startsWith('-') && arg !== '-') {
        out.error = `未知参数：${arg}`;
        return out;
      }
      positional.push(arg);
      continue;
    }
    const flag = m[1];
    /** @param {string} name @returns {string|null} 取一个值；缺失时写 error 并返回 null */
    const takeValue = (name) => {
      if (m[2] !== undefined) return m[2];
      const next = args[i + 1];
      if (next === undefined) {
        out.error = `${name} 需要一个值`;
        return null;
      }
      i += 1;
      return String(next);
    };
    if (flag === 'search') out.search = true;
    else if (flag === 'think') out.think = true;
    else if (flag === 'no-url') out.readUrl = false;
    else if (flag === 'json') out.json = true;
    else if (flag === 'file') {
      const v = takeValue('--file');
      if (v === null) return out;
      out.files.push(v);
    } else if (flag === 'out') {
      const v = takeValue('--out');
      if (v === null) return out;
      out.out = v;
    } else if (flag === 'voice') {
      const v = takeValue('--voice');
      if (v === null) return out;
      if (v !== 'stella' && v !== 'tide') {
        out.error = `--voice 只能是 stella 或 tide（收到 ${v}）`;
        return out;
      }
      out.voice = v;
    } else if (flag === 'asr') {
      const v = takeValue('--asr');
      if (v === null) return out;
      out.asr = v;
    } else if (flag === 'tts') {
      const v = takeValue('--tts');
      if (v === null) return out;
      out.tts = v;
    } else {
      out.error = `未知参数：--${flag}`;
      return out;
    }
  }
  out.question = positional.join(' ').trim();
  return out;
}

/**
 * 一行搜索提示：`🔍 a · b（命中 N 条）`。
 * @param {{queries?: any[], kind?: string, results?: any[]}} event
 * @returns {string}
 */
export function formatSearchEvent(event) {
  const queries = Array.isArray(event?.queries) ? event.queries.map((q) => String(q)) : [];
  const results = Array.isArray(event?.results) ? event.results : [];
  const label = queries.length ? queries.join(' · ') : '（未提供查询词）';
  return `🔍 ${label}（命中 ${results.length} 条）`;
}

/**
 * 一行阅读提示（只在拿到结果帧时打，避免「发起读取」和「读取完成」各打一行）。
 * @param {{url?: string, title?: string, error?: string}} event
 * @returns {string}
 */
export function formatFetchEvent(event) {
  const target = String(event?.title || event?.url || '').trim() || '（未知地址）';
  const failed = event?.error ? `（失败：${event.error}）` : '';
  return `🌐 阅读：${target}${failed}`;
}

/**
 * 引用汇总（去重后编号）：`[1] 标题 — URL`。
 * @param {any[]} citations
 * @returns {string[]}
 */
export function formatCitationSummary(citations) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {any[]} */
  const uniq = [];
  for (const c of Array.isArray(citations) ? citations : []) {
    const key = `${String(c?.url || '')}\u0000${String(c?.title || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(c);
  }
  if (!uniq.length) return lines;
  lines.push('引用：');
  uniq.forEach((c, i) => {
    const title = String(c?.title || '').trim() || '（无标题）';
    const url = String(c?.url || '').trim();
    lines.push(`[${i + 1}] ${title}${url ? ` — ${url}` : ''}`);
  });
  return lines;
}

/**
 * 服务端标题行。
 * @param {string} title
 * @returns {string}
 */
export function formatTitleLine(title) {
  return `标题：${String(title || '').trim()}`;
}

/**
 * 把聚合结果拆成「--json 的结构化对象」+「人类可读的尾部行」。
 * `json` 的键与 `--json` 文档一致：text/thinking/title/searches/citations/fetches/usage/stopReason。
 * @param {any} result
 * @returns {{json: {text: string, thinking: string, title: string, searches: any[], citations: any[], fetches: any[], usage: any, stopReason: string}, lines: string[]}}
 */
export function formatAppResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const citations = Array.isArray(r.citations) ? r.citations : [];
  const json = {
    text: String(r.text || ''),
    thinking: String(r.thinking || ''),
    title: String(r.title || ''),
    searches: Array.isArray(r.searches) ? r.searches : [],
    citations,
    fetches: Array.isArray(r.fetches) ? r.fetches : [],
    usage: r.usage ?? null,
    stopReason: String(r.stopReason || ''),
  };
  /** @type {string[]} */
  const lines = [];
  lines.push(...formatCitationSummary(citations));
  if (json.title) lines.push(formatTitleLine(json.title));
  return { json, lines };
}

/**
 * 把流式增量渲染到指定 write（正文直接输出、思考用暗色前缀、搜索/阅读各占一行）。
 * 说明：服务端对一次搜索会先发 `server_tool_use`（无结果）再发结果块，这里把前者暂存、
 * 等后者到达时合成**一行**（命中数才有意义）；流结束时用 `flush()` 兜底打出 0 命中。
 * @param {(text: string) => void} write
 * @returns {((event: any) => void) & {flush: () => void}}
 */
export function createDeltaPrinter(write) {
  let thinkingStarted = false;
  let textStarted = false;
  let atLineStart = true;
  /** @type {{queries: string[]}|null} */
  let pendingSearch = null;
  /** @param {string} text */
  const emit = (text) => {
    if (!text) return;
    write(text);
    atLineStart = text.endsWith('\n');
  };
  const startNewLine = () => {
    if (!atLineStart) {
      write('\n');
      atLineStart = true;
    }
  };
  /** @type {((event: any) => void) & {flush: () => void}} */
  const onDelta = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'thinking') {
      const text = sanitizeTerminal(String(event.text || ''));
      if (!text) return;
      if (!thinkingStarted) {
        startNewLine();
        emit(style('思考：', C.dim));
        thinkingStarted = true;
      }
      emit(style(text, C.dim));
      return;
    }
    if (event.type === 'text') {
      const text = sanitizeTerminal(String(event.text || ''));
      if (!text) return;
      if (!textStarted) {
        if (thinkingStarted) startNewLine();
        textStarted = true;
      }
      emit(text);
      return;
    }
    if (event.type === 'search') {
      const results = Array.isArray(event.results) ? event.results : [];
      const queries = Array.isArray(event.queries) ? event.queries.map((/** @type {any} */ q) => String(q)) : [];
      if (!results.length) {
        pendingSearch = { queries };
        return;
      }
      pendingSearch = null;
      startNewLine();
      emit(`${formatSearchEvent({ queries, results })}\n`);
      return;
    }
    if (event.type === 'fetch' && event.action === 'result') {
      startNewLine();
      emit(`${formatFetchEvent(event)}\n`);
    }
    // title/usage/stop 不在这里打：标题按要求在正文后单独一行（见 formatAppResult）。
  };
  onDelta.flush = () => {
    if (!pendingSearch) return;
    startNewLine();
    emit(`${formatSearchEvent({ queries: pendingSearch.queries, results: [] })}\n`);
    pendingSearch = null;
  };
  return onDelta;
}

/**
 * 命令依赖注入点（单测用；生产路径全部走真实实现）。
 * @typedef {Object} AppOverrides
 * @property {() => any} [loadConfig]
 * @property {(cfg: any, model: string) => any} [resolveProviderConfig]
 * @property {{write: (text: string) => void, print: (text?: string) => void}} [out]
 * @property {any} [streamAppChat]
 * @property {any} [uploadAppFile]
 * @property {any} [transcribeAudio]
 * @property {any} [synthesizeSpeech]
 * @property {(file: string) => any} [readFile]
 * @property {(file: string, data: any) => void} [writeFile]
 * @property {any} [cfg] 直接注入配置（跳过 loadConfig）
 */

/** @param {any} err @returns {string} */
function describeError(err) {
  return String(/** @type {any} */ (err)?.message || err);
}

/**
 * 统一的失败出口：说明原因 + 置非零退出码（**绝不静默 exit 0**）。
 * @param {{print: (text?: string) => void}} out
 * @param {string} message
 */
function fail(out, message) {
  out.print(`[错误] ${message}`);
  process.exitCode = 1;
}

/**
 * `mingdao app` 命令入口。
 * @param {string} cmd 分发到的命令名（不是 `app` 时返回 false，按普通提问继续）
 * @param {any[]} args 命令名之后的参数
 * @param {AppOverrides} [overrides] 依赖注入（单测用；省略即真实网络/文件系统）
 * @returns {Promise<boolean>} true = 已处理
 */
export async function handleApp(cmd, args, overrides = {}) {
  if (cmd !== 'app') return false;
  const out =
    overrides.out || {
      /** @param {string} text */
      write: (text) => process.stdout.write(text),
      /** @param {string} [text] */
      print: (text = '') => process.stdout.write(`${text}\n`),
    };
  const parsed = parseAppArgs(Array.isArray(args) ? args : []);
  if (parsed.help) {
    out.print(HELP);
    process.exitCode = 0;
    return true;
  }
  if (parsed.error) {
    fail(out, parsed.error);
    return true;
  }

  // —— 配置与凭证 ——
  /** @type {any} */
  let cfg;
  try {
    cfg = overrides.cfg !== undefined ? overrides.cfg : (overrides.loadConfig || loadConfig)() || {};
  } catch (err) {
    fail(out, `读取配置失败：${describeError(err)}`);
    return true;
  }
  const appCfg = normalizeAppApi(cfg?.appApi);
  const model = resolveAppModel(cfg);
  const resolveConfig = overrides.resolveProviderConfig || resolveProviderConfig;
  /** @type {any} */
  let pc;
  try {
    pc = resolveConfig(cfg, model) || {};
  } catch (err) {
    fail(out, `解析服务商配置失败：${describeError(err)}`);
    return true;
  }
  const baseUrl = normalizeAppBaseUrl(pc.baseUrl);
  const apiKey = String(pc.apiKey || '');
  if (!apiKey) {
    out.print(style('未找到 API Key：应用全家桶接口需要鉴权（x-api-key / Bearer）。', C.red));
    out.print('  · 运行 mingdao key set deepseek 保存密钥，或');
    out.print('  · 运行 mingdao init 重新配置，或');
    out.print(`  · 设置环境变量 ${pc.envHint || 'DEEPSEEK_API_KEY'}（或 MINGDAO_API_KEY）。`);
    process.exitCode = 1;
    return true;
  }
  if (!baseUrl) {
    fail(out, '缺少 API 地址（baseUrl）：请运行 mingdao init 重新配置。');
    return true;
  }

  const readFile = overrides.readFile || ((/** @type {string} */ file) => fs.readFileSync(file));
  const writeFile = overrides.writeFile || ((/** @type {string} */ file, /** @type {any} */ data) => fs.writeFileSync(file, data));

  /**
   * 读入一个文件为字节；失败时打印原因并返回 null（调用方直接返回 true 结束命令）。
   * @param {string} file
   * @returns {Uint8Array|null}
   */
  const readBytes = (file) => {
    try {
      const data = readFile(file);
      return data instanceof Uint8Array ? data : new Uint8Array(data);
    } catch (err) {
      fail(out, `读取文件失败（${file}）：${describeError(err)}`);
      return null;
    }
  };

  /**
   * 合成语音并写入 PCM 文件。
   * @param {string} text
   * @returns {Promise<{target: string, bytes: number}|null>} 成功返回写入路径与字节数
   */
  const speakToFile = async (text) => {
    const target = parsed.out || './out.pcm';
    /** @type {any} */
    let r;
    try {
      r = await (overrides.synthesizeSpeech || synthesizeSpeech)({
        baseUrl,
        apiKey,
        text,
        voice: parsed.voice || 'stella',
      });
    } catch (err) {
      fail(out, `语音合成失败：${describeError(err)}`);
      return null;
    }
    if (!r?.ok || !r?.pcm) {
      fail(out, `语音合成失败：${r?.error || '未返回音频数据'}`);
      return null;
    }
    try {
      writeFile(target, r.pcm);
    } catch (err) {
      fail(out, `写入 ${target} 失败：${describeError(err)}`);
      return null;
    }
    if (!parsed.json) {
      out.print(`✓ 已写入 ${target}（裸 PCM ${TTS_SAMPLE_RATE}Hz 单声道 16-bit 小端）`);
    }
    return { target, bytes: r.pcm.length };
  };

  // —— 模式 ①：--asr 只转写，不对话 ——
  if (parsed.asr) {
    const audio = readBytes(parsed.asr);
    if (!audio) return true;
    /** @type {any} */
    let r;
    try {
      r = await (overrides.transcribeAudio || transcribeAudio)({
        baseUrl,
        apiKey,
        audio,
        filename: path.basename(parsed.asr),
        mime: AUDIO_MIME_BY_EXT[extOf(parsed.asr)] || 'application/octet-stream',
      });
    } catch (err) {
      fail(out, `语音转写失败：${describeError(err)}`);
      return true;
    }
    if (!r?.ok) {
      fail(out, `语音转写失败：${r?.error || '未知错误'}`);
      return true;
    }
    const text = String(r.text || '');
    if (parsed.json) out.print(JSON.stringify({ text }, null, 2));
    else out.print(text);
    process.exitCode = 0;
    return true;
  }

  // —— 模式 ②：--tts 只合成，不对话 ——
  if (parsed.tts !== null) {
    const spoke = await speakToFile(parsed.tts);
    if (!spoke) return true;
    if (parsed.json) {
      out.print(JSON.stringify({ ok: true, out: spoke.target, bytes: spoke.bytes, sampleRate: TTS_SAMPLE_RATE }, null, 2));
    }
    process.exitCode = 0;
    return true;
  }

  // —— 模式 ③：对话（--file 可带多个文件） ——
  if (!parsed.question) {
    fail(out, '缺少问题。用法：mingdao app "问题" [--search] [--think] [--file <路径>]（--help 查看完整用法）');
    return true;
  }

  /** @type {Array<{type: 'document'|'image', fileId: string, name: string}>} */
  const attachments = [];
  for (const file of parsed.files) {
    const data = readBytes(file);
    if (!data) return true;
    const filename = path.basename(file);
    const purpose = purposeForFile(file);
    /** @type {any} */
    let r;
    try {
      r = await (overrides.uploadAppFile || uploadAppFile)({
        baseUrl,
        apiKey,
        data,
        filename,
        purpose,
        mime: MIME_BY_EXT[extOf(file)] || 'application/octet-stream',
      });
    } catch (err) {
      fail(out, `文件上传失败（${file}）：${describeError(err)}`);
      return true;
    }
    if (!r?.ok || !r?.fileId) {
      fail(out, `文件上传失败（${file}）：${r?.error || '未返回 file_id'}`);
      return true;
    }
    attachments.push({ type: blockTypeForFile(file), fileId: String(r.fileId), name: filename });
    if (!parsed.json) {
      out.print(style(`📎 已上传 ${filename}（purpose=${purpose}，file_id=${r.fileId}）`, C.dim));
    }
  }

  const messages = buildAppMessages(parsed.question, attachments);
  // 配置提供默认值，命令开关只能「开」（--search/--think）或「关」（--no-url）——
  // 未配置 appApi 时归一化结果与命令文档默认值一致（search=false / readUrl=true / thinking=false）。
  const search = parsed.search || appCfg.search;
  const thinking = parsed.think || appCfg.thinking;
  const readUrl = parsed.readUrl && appCfg.readUrl;

  let outputOpen = false;
  /** @param {string} text */
  const write = (text) => {
    if (!text) return;
    outputOpen = !text.endsWith('\n');
    out.write(text);
  };
  const onDelta = parsed.json ? undefined : createDeltaPrinter(write);

  /** @type {any} */
  let result;
  try {
    result = await (overrides.streamAppChat || streamAppChat)({
      baseUrl,
      apiKey,
      model,
      messages,
      thinking,
      search,
      readUrl,
      safetyLevel: appCfg.safetyLevel,
      title: appCfg.title,
      hasFiles: attachments.length > 0,
      onDelta,
    });
  } catch (err) {
    if (outputOpen) out.write('\n');
    fail(out, `应用接口调用失败：${describeError(err)}`);
    return true;
  }
  if (onDelta) onDelta.flush();

  const ok = result?.ok === true;
  const shaped = formatAppResult(result || {});
  if (parsed.json) {
    if (ok) {
      out.print(JSON.stringify(shaped.json, null, 2));
    } else {
      out.print(
        JSON.stringify(
          {
            ok: false,
            error: String(result?.error || '应用接口失败'),
            text: shaped.json.text,
            thinking: shaped.json.thinking,
            title: shaped.json.title,
            stopReason: shaped.json.stopReason,
          },
          null,
          2
        )
      );
    }
  } else {
    if (outputOpen) out.write('\n');
    for (const line of shaped.lines) out.print(line);
  }

  // 流内 error / 上游拒绝：已产出的正文与思考已经实时打出来了（半截回答要让用户看见），
  // 这里只补充原因并按非零退出；绝不能因为「有部分正文」就当成功。
  if (!ok) {
    fail(out, `应用接口失败：${String(result?.error || '未知错误')}`);
    return true;
  }

  // —— 可选：聊天后把正文合成 PCM（--voice 但没给 --tts 时） ——
  if (parsed.voice) {
    const spoke = await speakToFile(shaped.json.text);
    if (!spoke) return true;
  }
  process.exitCode = 0;
  return true;
}
