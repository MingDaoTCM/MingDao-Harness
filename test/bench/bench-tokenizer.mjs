// 评测基准（Hermes E2-3）：tokenizer 黄金值回归——离线、零 API 成本。
// 黄金值取自 DeepSeek-V3 官方 tokenizer.json + HF tokenizers 真实输出（与 smoke #16 同源）。
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src');
const { countTokens, heuristicTokens, makeTokenCounter } = await import(pathToFileURL(path.join(srcDir, 'tokenizer.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };

const GOLDEN = [
  ['的', 1], ['你好', 1], ['人工智能', 1], ['你好世界', 2],
  ['hello', 1], ['Hello world', 2], ["I don't think it's ready", 7],
  ['1234567890 3.14 42', 10], ['价格：¥1,299.00（含税）', 12],
  ['emoji 🎉🚀 与 ©® 符号', 13],
  ['const arr = [1, 22, 333, 4444];  // 注释 mixed 中文', 23],
  ['前<｜begin▁of▁sentence｜>后', 3],
];
for (const [s, want] of GOLDEN) ok(countTokens(s, 'deepseek-v4-flash') === want, `黄金值 ${JSON.stringify(s)} 应 ${want}`);

// 启发式回退（无词表模型）：英文 ≈4 字符/token、CJK ≈1 字符/token
const heur = heuristicTokens('hello world 你好');
ok(heur > 0 && Number.isFinite(heur), '启发式回退应给出有限正值');

// 内容级缓存：同文本二次计数结果一致且走缓存路径不报错
const c1 = countTokens('const x = 1; 中文混合'.repeat(50), 'deepseek-v4-flash');
const c2 = countTokens('const x = 1; 中文混合'.repeat(50), 'deepseek-v4-flash');
ok(c1 === c2 && c1 > 0, '重复计数应一致');

// 大文本（>50K 字符）不崩且结果有限
const big = 'x'.repeat(60000) + '中文'.repeat(100);
ok(Number.isFinite(countTokens(big, 'deepseek-v4-flash')), '大文本计数应有限');

// 模型切换计数器独立
const cntPro = makeTokenCounter('deepseek-v4-pro');
const cntFlash = makeTokenCounter('deepseek-v4-flash');
ok(typeof cntPro === 'function' && cntPro('测试') > 0 && cntFlash('测试') > 0, '按模型计数器可用');

console.log(`tokenizer 基准：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
