// `mingdao app` 命令回归（v0.8.0）。
//
// 为什么单独一套：这条命令的价值是「少几轮往返 + 输出形态可脚本化」——参数解析、purpose 判定、
// 流式渲染、--json 结构、退出码，任何一处错了都不会报错，只会静默变形（搜索行重复、
// 引用丢失、失败还 exit 0）。所以逐条钉死，且**全部零网络**：网络/文件 IO 全走注入点。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appMod = await import(new URL('../src/commands/app.js', import.meta.url).href);
const cfgMod = await import(new URL('../src/config.js', import.meta.url).href);
const {
  parseAppArgs,
  purposeForFile,
  blockTypeForFile,
  normalizeAppBaseUrl,
  resolveAppModel,
  buildAppMessages,
  formatSearchEvent,
  formatCitationSummary,
  formatTitleLine,
  formatAppResult,
  handleApp,
} = appMod;
const { normalizeAppApi, DEFAULT_APP_API, loadConfig, saveConfig, configPath } = cfgMod;

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** @param {any[]} argv */
function parse(argv) {
  return parseAppArgs(argv);
}

/** 临时 MINGDAO_HOME 包裹器（配置归一化测试用）。 */
function withTempHome(/** @type {(home: string) => any} */ fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-app-cfg-'));
  const prevHome = process.env.MINGDAO_HOME;
  process.env.MINGDAO_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prevHome === undefined) delete process.env.MINGDAO_HOME;
    else process.env.MINGDAO_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/**
 * 跑一次 handler，收集 stdout 与退出码（结束后恢复进程退出码，避免污染后续用例）。
 * @param {any[]} argv
 * @param {any} [overrides]
 */
async function runApp(argv, overrides = {}) {
  const prev = process.exitCode;
  process.exitCode = 0;
  let output = '';
  const out = {
    /** @param {string} text */
    write: (text) => {
      output += text;
    },
    /** @param {string} [text] */
    print: (text = '') => {
      output += `${text}\n`;
    },
  };
  const ret = await handleApp('app', argv, { ...overrides, out });
  const exitCode = Number(process.exitCode || 0);
  process.exitCode = prev;
  return { ret, exitCode, output };
}

/** 正常服务商配置（含 /v1 —— 命令必须自己剥掉）。 */
const PC_OK = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test', envHint: 'DEEPSEEK_API_KEY' };
const CFG = { provider: 'deepseek', model: 'deepseek-flash' };

// ---------- ① 参数解析（纯函数） ----------
{
  const d = parse([]);
  assert.equal(d.error, '');
  assert.equal(d.question, '');
  assert.equal(d.search, false, '默认不联网搜索');
  assert.equal(d.readUrl, true, '默认阅读链接');
  assert.equal(d.think, false, '默认不深度思考');
  assert.equal(d.json, false);
  assert.deepEqual(d.files, []);
  assert.equal(d.voice, null);
  assert.equal(d.asr, null);
  assert.equal(d.tts, null);
  assert.equal(d.out, null);
  ok('① 默认值：search=false / readUrl=true / thinking=false / 无文件');
}
{
  const p = parse(['为什么', '天是蓝的', '--search', '--think', '--no-url', '--json']);
  assert.equal(p.question, '为什么 天是蓝的', '多个位置参数应拼成问题');
  assert.equal(p.search, true);
  assert.equal(p.think, true);
  assert.equal(p.readUrl, false, '--no-url 关阅读');
  assert.equal(p.json, true);
  ok('② 开关解析：--search / --think / --no-url / --json');
}
{
  const p = parse(['问', '--file', 'a.pdf', '--file', 'b.md', '--out', '/tmp/o.pcm', '--voice', 'tide']);
  assert.deepEqual(p.files, ['a.pdf', 'b.md'], '--file 可多次');
  assert.equal(p.out, '/tmp/o.pcm');
  assert.equal(p.voice, 'tide');
  const inline = parse(['--voice=stella', '--out=o.pcm', '--file=c.png']);
  assert.equal(inline.voice, 'stella');
  assert.equal(inline.out, 'o.pcm');
  assert.deepEqual(inline.files, ['c.png']);
  ok('③ --file×2 / --voice / --out（含 --x=y 内联写法）');
}
{
  assert.equal(parse(['--asr', 'talk.wav']).asr, 'talk.wav');
  assert.equal(parse(['--tts', '朗读我']).tts, '朗读我');
  assert.equal(parse(['--tts', '']).tts, '', '空文本也要能被识别为「给了 --tts」');
  assert.match(parse(['--voice']).error, /需要一个值/);
  assert.match(parse(['--file']).error, /需要一个值/);
  assert.match(parse(['--voice', 'bad']).error, /stella 或 tide/);
  assert.match(parse(['--bogus']).error, /未知参数/);
  assert.match(parse(['-x']).error, /未知参数/);
  assert.equal(parse(['--help']).help, true);
  assert.equal(parse(['-h']).help, true);
  ok('④ --asr / --tts 模式 + 缺值/未知参数/非法 voice 报错 + --help');
}

// ---------- ② purpose 判定 ----------
{
  assert.equal(purposeForFile('a.pdf'), 'rich_layout_recognition');
  assert.equal(purposeForFile('a.PDF'), 'rich_layout_recognition', '扩展名大小写不敏感');
  assert.equal(purposeForFile('doc.docx'), 'rich_layout_recognition');
  assert.equal(purposeForFile('deck.pptx'), 'rich_layout_recognition');
  assert.equal(purposeForFile('pic.png'), 'rich_layout_recognition');
  assert.equal(purposeForFile('photo.jpeg'), 'rich_layout_recognition');
  assert.equal(purposeForFile('notes.md'), 'user_data');
  assert.equal(purposeForFile('data.csv'), 'user_data');
  assert.equal(purposeForFile('a.xyz'), 'user_data', '未知扩展名 → user_data');
  assert.equal(purposeForFile('noext'), 'user_data');
  ok('⑤ purpose 判定：pdf/doc/ppt/图片 → rich_layout_recognition；md/未知 → user_data');
}
{
  assert.equal(blockTypeForFile('pic.png'), 'image');
  assert.equal(blockTypeForFile('a.pdf'), 'document');
  assert.equal(blockTypeForFile('a.md'), 'document');
  ok('⑥ 内容块类型：图片 → image，其余 → document');
}
{
  assert.equal(normalizeAppBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com');
  assert.equal(normalizeAppBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com');
  assert.equal(normalizeAppBaseUrl('  https://api.deepseek.com  '), 'https://api.deepseek.com');
  assert.equal(normalizeAppBaseUrl('https://gw.example.com/openai/v1'), 'https://gw.example.com/openai');
  assert.equal(normalizeAppBaseUrl(''), '');
  ok('⑦ baseUrl 归一化：剥掉 OpenAI 兼容层的 /v1（否则应用端点 404）');
}
{
  const m = buildAppMessages('问', [{ type: 'document', fileId: 'file-1', name: 'a.pdf' }]);
  assert.deepEqual(m, [{ role: 'user', content: [{ type: 'text', text: '问' }, { type: 'document', source: { type: 'file', file_id: 'file-1' } }] }]);
  assert.deepEqual(buildAppMessages('纯问', []), [{ role: 'user', content: '纯问' }], '无文件时保持纯字符串');
  assert.deepEqual(buildAppMessages('', [{ type: 'image', fileId: 'f' }]), [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'f' } }] }]);
  ok('⑧ messages 拼装：text 块 + document/image 块（file_id 引用），无文件退回字符串');
}

// ---------- ③ appApi 配置归一化（默认关） ----------
{
  const d = normalizeAppApi(undefined);
  assert.deepEqual(d, { ...DEFAULT_APP_API });
  assert.equal(d.enabled, false, '缺省 → 默认关闭');
  assert.equal(normalizeAppApi('not-an-object').enabled, false);
  assert.equal(normalizeAppApi([]).enabled, false);
  assert.equal(normalizeAppApi(null).enabled, false);
  ok('⑨ appApi 缺省/非法容器 → 默认关闭（enabled=false），默认值与 DEFAULT_APP_API 一致');
}
{
  const bad = normalizeAppApi({
    enabled: 'true',
    search: 'true',
    thinking: 1,
    readUrl: 'false',
    title: 'false',
    safetyLevel: 'bogus',
    model: '',
  });
  assert.equal(bad.enabled, false, '字符串 "true" 不算 true');
  assert.equal(bad.search, false);
  assert.equal(bad.thinking, false);
  assert.equal(bad.readUrl, false, '显式给的非 true 值按 false 处理');
  assert.equal(bad.title, false);
  assert.equal(bad.safetyLevel, 'high', '非法 safetyLevel 回落 high');
  assert.equal(bad.model, 'deepseek-flash', '非法 model 回落 deepseek-flash');
  assert.equal(normalizeAppApi({ model: 123 }).model, 'deepseek-flash');
  assert.equal(normalizeAppApi({ model: '   ' }).model, 'deepseek-flash');
  assert.equal(normalizeAppApi({ safetyLevel: 'LOW' }).safetyLevel, 'high', '只认小写字面量 high|low|off');
  ok('⑩ 非法值归一化：字符串布尔不算 true / safetyLevel 白名单 / model 回落 deepseek-flash');
}
{
  const good = normalizeAppApi({
    enabled: true,
    model: '  deepseek-flash  ',
    search: true,
    readUrl: true,
    thinking: true,
    safetyLevel: 'low',
    title: true,
  });
  assert.deepEqual(good, {
    enabled: true,
    model: 'deepseek-flash',
    search: true,
    readUrl: true,
    thinking: true,
    safetyLevel: 'low',
    title: true,
  });
  assert.equal(normalizeAppApi({}).readUrl, true, 'readUrl 缺省默认 true');
  assert.equal(normalizeAppApi({}).title, true, 'title 缺省默认 true');
  assert.equal(normalizeAppApi({}).safetyLevel, 'high');
  ok('⑪ 合法值原样保留（去空格），readUrl/title 缺省默认 true');
}
{
  withTempHome((home) => {
    // 旧配置（完全没有 appApi）：loadConfig 不得凭空新增字段，也不得改写文件字节
    const legacy = { provider: 'deepseek', model: 'deepseek-flash', permission: 'ask' };
    const file = path.join(home, 'config.json');
    const before = `${JSON.stringify(legacy, null, 2)}\n`;
    fs.writeFileSync(file, before);
    const cfg = loadConfig();
    assert.equal(Object.prototype.hasOwnProperty.call(cfg, 'appApi'), false, '未配置时 loadConfig 不得新增 appApi 字段');
    assert.equal(cfg.model, 'deepseek-flash');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '读配置不得改写文件（默认关闭 = 现有行为一字不变）');
  });
  ok('⑫ 未配置 appApi：loadConfig 不新增字段、配置文件字节不变（默认关闭）');
}
{
  withTempHome((home) => {
    const file = path.join(home, 'config.json');
    const before = `${JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', appApi: { enabled: 'yes', search: 'true', safetyLevel: 'nope', model: 5 } }, null, 2)}\n`;
    fs.writeFileSync(file, before);
    const cfg = loadConfig();
    assert.equal(cfg.appApi.enabled, false);
    assert.equal(cfg.appApi.search, false);
    assert.equal(cfg.appApi.safetyLevel, 'high');
    assert.equal(cfg.appApi.model, 'deepseek-flash');
    assert.equal(fs.readFileSync(file, 'utf8'), before, '归一化只在内存进行，不擅自改用户配置文件');
  });
  ok('⑬ 已有非法 appApi：读出来归一化（内存），磁盘原文不动');
}
{
  withTempHome(() => {
    saveConfig({ provider: 'deepseek', model: 'deepseek-flash', appApi: { enabled: 'true', safetyLevel: 'nope', model: 7 } });
    const disk = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    assert.equal(disk.appApi.enabled, false, '写回前必须归一化（非法值不得落盘）');
    assert.equal(disk.appApi.safetyLevel, 'high');
    assert.equal(disk.appApi.model, 'deepseek-flash');
  });
  ok('⑭ saveConfig：appApi 归一化后才落盘（非法值不进入 config.json）');
}
{
  assert.equal(resolveAppModel({ model: 'deepseek-v4-pro' }), 'deepseek-v4-pro', '未配置 appApi 时沿用 cfg.model');
  assert.equal(resolveAppModel({ model: 'deepseek-v4-pro', appApi: { model: 'deepseek-flash' } }), 'deepseek-flash', 'appApi.model 优先');
  assert.equal(resolveAppModel({ model: 'deepseek-v4-pro', appApi: { model: 1 } }), 'deepseek-flash', 'appApi.model 非法 → 回落默认');
  assert.equal(resolveAppModel({}), 'deepseek-flash');
  ok('⑮ 模型优先级：appApi.model（归一化后）> cfg.model > deepseek-flash');
}

// ---------- ④ handleApp：失败必须非零退出并说明原因 ----------
{
  const r = await runApp(['你好'], {
    cfg: CFG,
    resolveProviderConfig: () => ({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '', envHint: 'DEEPSEEK_API_KEY' }),
  });
  assert.equal(r.ret, true);
  assert.notEqual(r.exitCode, 0, '未配置 Key 必须非零退出');
  assert.match(r.output, /mingdao init/, '要给出可操作提示（mingdao init）');
  assert.match(r.output, /mingdao key set/, '并提示 key set 这条路');
  ok('⑯ 无 API Key：提示 mingdao init / key set，退出码非零（不静默成功）');
}
{
  const r = await runApp([], { cfg: CFG, resolveProviderConfig: () => PC_OK });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /缺少问题/);
  ok('⑰ 缺问题：用法提示 + 非零退出');
}
{
  const r = await runApp(['--voice', 'bad'], { cfg: CFG, resolveProviderConfig: () => PC_OK });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /stella 或 tide/);
  ok('⑱ 非法参数：报错 + 非零退出（不发起请求）');
}
{
  const r = await runApp(['--help'], { cfg: CFG, resolveProviderConfig: () => PC_OK });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /mingdao app/);
  assert.match(r.output, /--asr/);
  assert.match(r.output, /--tts/);
  ok('⑲ --help：打印完整用法并 exit 0');
}

// ---------- ⑤ --json 输出结构（注入假 streamAppChat） ----------
{
  /** @type {any} */
  let seen = null;
  const fake = async (/** @type {any} */ opts) => {
    seen = opts;
    return {
      ok: true,
      text: '答案',
      thinking: '思路',
      title: '服务端标题',
      searches: [{ queries: ['q'], results: [{ url: 'https://e.com' }] }],
      citations: [{ url: 'https://e.com', title: 'E' }],
      fetches: [],
      usage: { input_tokens: 1, output_tokens: 2 },
      stopReason: 'end_turn',
    };
  };
  const r = await runApp(['问题', '--json'], { cfg: CFG, resolveProviderConfig: () => PC_OK, streamAppChat: fake });
  assert.equal(r.exitCode, 0);
  const payload = JSON.parse(r.output);
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['citations', 'fetches', 'searches', 'stopReason', 'text', 'thinking', 'title', 'usage'],
    '--json 恰好输出约定的 8 个字段'
  );
  assert.equal(payload.text, '答案');
  assert.equal(payload.thinking, '思路');
  assert.equal(payload.title, '服务端标题');
  assert.equal(payload.stopReason, 'end_turn');
  assert.deepEqual(payload.usage, { input_tokens: 1, output_tokens: 2 });
  assert.equal(seen.baseUrl, 'https://api.deepseek.com', '请求必须用剥掉 /v1 的 API 根');
  assert.equal(seen.apiKey, 'sk-test');
  assert.equal(seen.model, 'deepseek-flash');
  assert.equal(seen.search, false);
  assert.equal(seen.readUrl, true);
  assert.equal(seen.thinking, false);
  assert.equal(seen.safetyLevel, 'high');
  assert.equal(seen.title, true);
  assert.equal(seen.hasFiles, false);
  assert.equal(seen.onDelta, undefined, '--json 模式不做流式渲染');
  ok('⑳ --json：8 字段结构 + 请求参数（根地址/密钥/开关）全部正确，零网络');
}

// ---------- ⑥ 流式渲染格式 ----------
{
  const fake = async (/** @type {any} */ opts) => {
    opts.onDelta({ type: 'thinking', text: '先想' });
    opts.onDelta({ type: 'text', text: '答案' });
    opts.onDelta({ type: 'search', queries: ['a', 'b'], results: [] });
    opts.onDelta({ type: 'search', queries: ['a', 'b'], results: [{ url: 'x' }, { url: 'y' }] });
    opts.onDelta({ type: 'fetch', action: 'result', url: 'https://r.com', title: 'R' });
    return {
      ok: true,
      text: '答案',
      thinking: '先想',
      title: 'T1',
      searches: [],
      citations: [
        { url: 'https://a.com', title: '甲' },
        { url: 'https://a.com', title: '甲' },
      ],
      fetches: [],
      usage: null,
      stopReason: 'end_turn',
    };
  };
  const r = await runApp(['问', '--search', '--think'], { cfg: CFG, resolveProviderConfig: () => PC_OK, streamAppChat: fake });
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /思考：先想/, '思考用暗色前缀「思考：」');
  assert.match(r.output, /答案/, '正文直接输出');
  const searchLines = r.output.split('\n').filter((line) => line.startsWith('🔍'));
  assert.equal(searchLines.length, 1, '一次搜索只打一行（发起块 + 结果块合并，不重复）');
  assert.match(searchLines[0], /a · b/);
  assert.match(searchLines[0], /命中 2 条/, '搜索行必须带命中数');
  assert.match(r.output, /🌐 阅读：R/);
  assert.match(r.output, /引用：/);
  assert.match(r.output, /\[1\] 甲 — https:\/\/a\.com/, '引用汇总格式：[序号] 标题 — URL（重复项去重）');
  assert.equal(/\[2\]/.test(r.output), false, '同一引用重复出现时只编号一次');
  ok('㉑ 流式渲染：思考前缀 / 正文 / 搜索行（含命中数） / 阅读行 / 引用去重');
}
{
  // 引用去重 + 标题行（用纯函数钉格式，避免依赖上面用例的偶然性）
  const shaped = formatAppResult({
    text: '正文',
    thinking: '',
    title: 'T',
    searches: [],
    citations: [
      { url: 'https://a.com', title: '甲' },
      { url: 'https://a.com', title: '甲' },
      { url: 'https://b.com', title: '乙' },
    ],
    fetches: [],
    usage: null,
    stopReason: 'end_turn',
  });
  assert.deepEqual(shaped.lines, ['引用：', '[1] 甲 — https://a.com', '[2] 乙 — https://b.com', '标题：T']);
  assert.equal(shaped.json.title, 'T');
  assert.equal(formatCitationSummary([]).length, 0);
  assert.equal(formatSearchEvent({ queries: ['q'], results: [{}, {}] }), '🔍 q（命中 2 条）');
  assert.equal(formatTitleLine('T'), '标题：T');
  ok('㉒ formatAppResult / formatCitationSummary / formatSearchEvent / formatTitleLine 格式钉死');
}

// ---------- ⑦ 流内失败：半截正文要保留 ----------
{
  const fake = async (/** @type {any} */ opts) => {
    opts.onDelta({ type: 'thinking', text: '想了一半' });
    opts.onDelta({ type: 'text', text: '半截' });
    return {
      ok: false,
      error: '内容存在风险',
      text: '半截',
      thinking: '想了一半',
      title: '',
      searches: [],
      citations: [],
      fetches: [],
      usage: null,
      stopReason: '',
    };
  };
  const r = await runApp(['问'], { cfg: CFG, resolveProviderConfig: () => PC_OK, streamAppChat: fake });
  assert.notEqual(r.exitCode, 0, '流内失败必须非零退出');
  assert.match(r.output, /半截/, '已产出的正文必须已经打出来（不能吞掉）');
  assert.match(r.output, /想了一半/);
  assert.match(r.output, /内容存在风险/, '必须说明原因');
  ok('㉓ 流内失败：已产出正文/思考照常显示 + 原因说明 + 非零退出');
}

// ---------- ⑧ 文件上传接线 ----------
{
  /** @type {any[]} */
  const uploads = [];
  /** @type {any} */
  let chatOpts = null;
  const r = await runApp(['分析这些文件', '--file', 'report.pdf', '--file', 'notes.md', '--file', 'pic.png'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    readFile: () => new Uint8Array([1, 2, 3]),
    uploadAppFile: async (/** @type {any} */ args) => {
      uploads.push(args);
      return { ok: true, fileId: `file-${uploads.length}` };
    },
    streamAppChat: async (/** @type {any} */ opts) => {
      chatOpts = opts;
      return { ok: true, text: '已读', thinking: '', title: '', searches: [], citations: [], fetches: [], usage: null, stopReason: 'end_turn' };
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(uploads.length, 3);
  assert.equal(uploads[0].purpose, 'rich_layout_recognition');
  assert.equal(uploads[1].purpose, 'user_data');
  assert.equal(uploads[2].purpose, 'rich_layout_recognition');
  assert.equal(chatOpts.hasFiles, true, '带文件时请求要带 hasFiles=true（beta 头）');
  assert.deepEqual(chatOpts.messages[0].content[0], { type: 'text', text: '分析这些文件' });
  assert.deepEqual(chatOpts.messages[0].content[1], { type: 'document', source: { type: 'file', file_id: 'file-1' } });
  assert.deepEqual(chatOpts.messages[0].content[2], { type: 'document', source: { type: 'file', file_id: 'file-2' } });
  assert.deepEqual(chatOpts.messages[0].content[3], { type: 'image', source: { type: 'file', file_id: 'file-3' } });
  ok('㉔ --file：purpose 按扩展名选择、file_id 以 document/image 块拼进 user 消息、hasFiles=true');
}
{
  const r = await runApp(['问', '--file', 'a.pdf'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    readFile: () => new Uint8Array([1]),
    uploadAppFile: async () => ({ ok: false, error: '解析失败' }),
    streamAppChat: async () => {
      throw new Error('上传失败后不得继续请求');
    },
  });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /解析失败/);
  ok('㉕ 上传失败：说明原因 + 非零退出，且不继续发起对话请求');
}
{
  const r = await runApp(['问', '--file', 'missing.pdf'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    readFile: () => {
      throw new Error('ENOENT: no such file');
    },
    streamAppChat: async () => {
      throw new Error('读文件失败后不得继续请求');
    },
  });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /读取文件失败/);
  ok('㉖ 本地文件读不到：说明原因 + 非零退出');
}

// ---------- ⑨ ASR / TTS ----------
{
  /** @type {any} */
  let asrArgs = null;
  const r = await runApp(['--asr', 'talk.wav'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    readFile: () => new Uint8Array([7]),
    transcribeAudio: async (/** @type {any} */ args) => {
      asrArgs = args;
      return { ok: true, text: '转写结果' };
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim(), '转写结果', 'ASR 只转写、不对话');
  assert.equal(asrArgs.filename, 'talk.wav');
  assert.equal(asrArgs.mime, 'audio/wav');
  assert.equal(asrArgs.apiKey, 'sk-test');
  ok('㉗ --asr：读取音频 → transcribeAudio → 打印文本（不进入对话）');
}
{
  /** @type {any} */
  let ttsArgs = null;
  /** @type {any} */
  let written = null;
  const r = await runApp(['--tts', '朗读我', '--voice', 'tide', '--out', '/tmp/app-out.pcm'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    synthesizeSpeech: async (/** @type {any} */ args) => {
      ttsArgs = args;
      return { ok: true, pcm: new Uint8Array([1, 2, 3, 4]) };
    },
    writeFile: (/** @type {string} */ file, /** @type {any} */ data) => {
      written = { file, data };
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(ttsArgs.text, '朗读我');
  assert.equal(ttsArgs.voice, 'tide');
  assert.equal(written.file, '/tmp/app-out.pcm');
  assert.deepEqual([...written.data], [1, 2, 3, 4]);
  assert.match(r.output, /24000Hz/, '要打印采样率说明（裸 PCM 24kHz）');
  ok('㉘ --tts：只合成 → 写入 --out（拍平 PCM），并打印采样率说明');
}
{
  /** @type {any} */
  let written = null;
  const r = await runApp(['--tts', 'x'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    synthesizeSpeech: async () => ({ ok: true, pcm: new Uint8Array([9]) }),
    writeFile: (/** @type {string} */ file) => {
      written = file;
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(written, './out.pcm', '--out 缺省写 ./out.pcm');
  ok('㉙ --tts 缺省输出：./out.pcm');
}
{
  /** @type {any} */
  let ttsArgs = null;
  const r = await runApp(['问题', '--voice', 'stella'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    streamAppChat: async () => ({ ok: true, text: '正文内容', thinking: '', title: '', searches: [], citations: [], fetches: [], usage: null, stopReason: 'end_turn' }),
    synthesizeSpeech: async (/** @type {any} */ args) => {
      ttsArgs = args;
      return { ok: true, pcm: new Uint8Array([5]) };
    },
    writeFile: () => {},
  });
  assert.equal(r.exitCode, 0);
  assert.equal(ttsArgs.text, '正文内容', '聊天后 --voice 合成的是正文');
  assert.equal(ttsArgs.voice, 'stella');
  ok('㉚ 聊天 + --voice：把模型正文合成 PCM 写入文件');
}
{
  const r = await runApp(['--tts', 'x'], {
    cfg: CFG,
    resolveProviderConfig: () => PC_OK,
    synthesizeSpeech: async () => ({ ok: false, error: '语音不可用' }),
    writeFile: () => {},
  });
  assert.notEqual(r.exitCode, 0);
  assert.match(r.output, /语音不可用/);
  ok('㉛ TTS 失败：说明原因 + 非零退出');
}

// ---------- ⑩ appApi 配置影响命令默认值 ----------
{
  /** @type {any} */
  let chatOpts = null;
  const r = await runApp(['问'], {
    cfg: { provider: 'deepseek', model: 'deepseek-v4-pro', appApi: { model: 'deepseek-flash', search: true, readUrl: false, thinking: true, safetyLevel: 'low', title: true } },
    resolveProviderConfig: () => PC_OK,
    streamAppChat: async (/** @type {any} */ opts) => {
      chatOpts = opts;
      return { ok: true, text: '', thinking: '', title: '', searches: [], citations: [], fetches: [], usage: null, stopReason: 'end_turn' };
    },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(chatOpts.model, 'deepseek-flash', 'appApi.model > cfg.model');
  assert.equal(chatOpts.search, true, 'appApi.search 作为默认值生效');
  assert.equal(chatOpts.readUrl, false);
  assert.equal(chatOpts.thinking, true);
  assert.equal(chatOpts.safetyLevel, 'low');
  assert.equal(chatOpts.title, true);
  ok('㉜ appApi 配置：model/search/readUrl/thinking/safetyLevel 作为命令默认值，命令开关可覆盖');
}

console.log(`\nmingdao app 命令：${passed} 项通过`);
