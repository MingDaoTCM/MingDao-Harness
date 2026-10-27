// 批五十九（v0.6.29 H-04 / minimax M-8、M-9、M-13、L-9）的变异验证。
//
// 判定入口：test/provider-hardening.js（独立套件，含 A/B 两个真实桩端点 + 真 Web 服务器）。
// 每条都把修复改回缺陷，套件必须当场红；`expect` 是失败断言原文里的关键词。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/provider-hardening.js');

// ① H-04：恢复「只按模型名缓存 + 失效时不清 provider」的旧行为。
// 这是 H-04 的完整缺陷形态：缓存键不含 baseUrl/凭证/超时，切换后仍取到旧实例。
M.mutate({
  name: '① H-04 恢复按模型名缓存且不回退旧实例',
  file: 'src/web/server.js',
  from: [
    '    return `${providerGeneration}\\u0000${String(pc.baseUrl || \'\')}\\u0000${keyDigest}\\u0000${timeout}`;',
    '  };',
    '  const providerCacheKey = (/** @type {any} */ m) => `${m}\\u0000${providerFingerprint(m)}`;',
    '  const probeCacheKey = (/** @type {any} */ m) => `${m}\\u0000${providerFingerprint(m)}`;',
    '  /**',
    '   * 配置代际失效：provider 实例 + 本地端点预检备忘一起清。',
    '   * 预检结果含 endpoint/TTFT，旧端点的结论绝不能套到新端点上（否则自适应超时也会跟着错代际）。',
    '   * @param {string} [reason]',
    '   */',
    '  const invalidateProviderCache = (reason = \'配置变更\') => {',
    '    providerGeneration += 1;',
    '    const instances = providerCache.size;',
    '    const probes = probeByModel.size;',
    '    providerCache.clear();',
  ].join('\n'),
  to: [
    '    return `${providerGeneration}\\u0000${keyDigest}\\u0000${timeout}`;',
    '  };',
    '  const providerCacheKey = (/** @type {any} */ m) => m;',
    '  const probeCacheKey = (/** @type {any} */ m) => m;',
    '  /**',
    '   * 配置代际失效（mutated：不再清 provider 实例）',
    '   * @param {string} [reason]',
    '   */',
    '  const invalidateProviderCache = (reason = \'配置变更\') => {',
    '    providerGeneration += 1;',
    '    const instances = providerCache.size;',
    '    const probes = probeByModel.size;',
    '    // mutated: providerCache.clear(); 被移除，旧实例继续命中',
  ].join('\n'),
  expect: ['切换后新任务必须到 B'],
  run: SUITE,
});

// ② M-8：多行 data 不再用 \n 连接（拼成空串）
M.mutate({
  name: '② M-8 多行 data: 不按 \\n 拼接',
  file: 'src/providers/openai-compatible.js',
  from: "    const data = dataLines.join('\\n'); // SSE 规范：事件内多行 data 以 \\n 连接",
  to: "    const data = dataLines.join(''); // mutated",
  expect: ['多行 data 必须用'],
  run: SUITE,
});

// ③ M-8：坏帧计数被吞（回到静默丢弃）
M.mutate({
  name: '③ M-8 坏帧不计数（静默丢弃）',
  file: 'src/providers/openai-compatible.js',
  from: '    badFrames += 1;',
  to: '    // mutated: 坏帧计数被吞',
  expect: ['坏帧必须被**计数**'],
  run: SUITE,
});

// ④ M-8：[DONE] 不再立即派发 → 其后无空行分隔的 usage 尾帧被拼成坏帧
M.mutate({
  name: '④ M-8 [DONE] 后 usage 尾帧丢失',
  file: 'src/providers/openai-compatible.js',
  from: [
    "    if (value === '[DONE]') {",
    '      // [DONE] 不可能跨行：立即派发，保证其后紧跟的 usage 尾帧（部分网关不发空行）仍能解析。',
    '      dataLines.push(value);',
    '      dispatchEvent();',
    '      return;',
    '    }',
  ].join('\n'),
  to: ['    // mutated: [DONE] 不再立即派发'].join('\n'),
  expect: ['usage 尾帧必须仍被捕获'],
  run: SUITE,
});

// ⑤ M-9：异常/正常退出都不 cancel reader（连接泄漏）
M.mutate({
  name: '⑤ M-9 finally 不 cancel reader',
  file: 'src/providers/openai-compatible.js',
  from: [
    '  } finally {',
    '    // M-9：成功/失败/中断/坏帧一律释放连接。cancel 是幂等的，重复调用无害；',
    '    // 但**绝不能**只在正常路径调用——那正是连接泄漏的来源。',
    '    try { await reader.cancel(); } catch {}',
    '  }',
  ].join('\n'),
  to: ['  } finally {', '    // mutated: 不 cancel', '  }'].join('\n'),
  expect: ['reader.cancel()'],
  run: SUITE,
});

// ⑥ M-13：删掉 Hugging Face 前缀行
M.mutate({
  name: '⑥ M-13 删除 hf_ 前缀行',
  file: 'src/redact.js',
  from: "  { vendor: 'Hugging Face', re: /\\bhf_[A-Za-z0-9]{20,}/g, mask: 'hf_***', sample: sampleOf('hf_') },",
  to: "  // mutated: hf_ 行被删除",
  expect: ['能认出 hf_ 的行'],
  run: SUITE,
});

// ⑦ M-13：Shopify 前缀正则收紧 → 24 位样例不再被认出（"有规则但不认得你的 key"）
M.mutate({
  name: '⑦ M-13 shpat_ 正则收紧到 40 位',
  file: 'src/redact.js',
  from: '/\\bshpat_[A-Za-z0-9]{20,}/g',
  to: '/\\bshpat_[A-Za-z0-9]{40,}/g',
  expect: ['能认出 shpat_ 的行'],
  run: SUITE,
});

// ⑧ M-13：删掉 xAI 前缀行
M.mutate({
  name: '⑧ M-13 删除 xai- 前缀行',
  file: 'src/redact.js',
  from: "  { vendor: 'xAI', re: /\\bxai-[A-Za-z0-9]{20,}/g, mask: 'xai-***', sample: sampleOf('xai-') },",
  to: '  // mutated: xai- 行被删除',
  expect: ['能认出 xai- 的行'],
  run: SUITE,
});

// ⑨ M-13：PGPASSWORD 从敏感 env 名单移除（无下划线的整词凭据）
M.mutate({
  name: '⑨ M-13 移除 PGPASSWORD 敏感 env',
  file: 'src/tools/bash.js',
  from: "  'PGPASSWORD',\n",
  to: '',
  expect: ['PGPASSWORD 必须被判为敏感 env'],
  run: SUITE,
});

// ⑩ M-13：连接串兜底正则失效 → MY_DATABASE_URL / CACHE_REDIS_URI 透传
M.mutate({
  name: '⑩ M-13 连接串 env 正则失效',
  file: 'src/tools/bash.js',
  from: "const SENSITIVE_ENV_CONN_URL = /^(?:[A-Z0-9]+_)*(?:DATABASE|MYSQL|POSTGRES|POSTGRESQL|PG|REDIS|MONGO|MONGODB|AMQP|RABBITMQ|KAFKA|ELASTIC|CLICKHOUSE)_(?:URL|URI|DSN)$/i;",
  to: 'const SENSITIVE_ENV_CONN_URL = /^NEVER_MATCH$/i; // mutated',
  expect: ['MY_DATABASE_URL 必须被判为敏感 env'],
  run: SUITE,
});

// ⑪ M-13：段词表删掉 passphrase → SSH_PASSPHRASE 重新透传（且日志不再脱敏）
M.mutate({
  name: '⑪ M-13 段词表删除 passphrase',
  file: 'src/redact.js',
  from: "  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'session', 'passphrase',",
  to: "  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'session',",
  expect: ['SSH_PASSPHRASE 必须被判为敏感 env'],
  run: SUITE,
});

// ⑫ L-9：HTTP 掩码又回前 6 位
M.mutate({
  name: '⑫ L-9 HTTP 掩码回前 6 位',
  file: 'src/credentials.js',
  from: "  return '…' + s.slice(-4);",
  to: "  return s.slice(0, 6) + '…' + s.slice(-4); // mutated",
  expect: ['HTTP 掩码形态应为'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
