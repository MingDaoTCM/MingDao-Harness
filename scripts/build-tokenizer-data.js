// 离线构建脚本（一次性）：把 HF tokenizer.json 压缩为运行时所需的紧凑数据。
// 用法：node scripts/build-tokenizer-data.js [tokenizer.json 路径]
// 输出：assets/tokenizer-data.json.gz（merges 字节对 + added_tokens 内容）

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] || path.join(root, 'assets', 'deepseek-tokenizer.json');
const out = path.join(root, 'assets', 'tokenizer-data.json.gz');

const j = JSON.parse(fs.readFileSync(src, 'utf8'));

// merges: ["a b", ...] —— 每对按 rank 顺序拆分。保持 HF 原始表示（GPT-2 byte_to_unicode
// 映射后的可打印字符），不做二次转换；运行时 countPiece 用同一映射表把字节转成该表示后查表。
const merges = (j.model?.merges || []).map((m) => {
  const idx = m.indexOf(' ');
  return [m.slice(0, idx), m.slice(idx + 1)];
});
// added tokens：只保留内容（最长优先匹配用），特殊 token 与用户 token 均可命中
const added = (j.added_tokens || []).map((t) => String(t.content)).filter(Boolean);

const data = { merges, added };
const gz = zlib.gzipSync(Buffer.from(JSON.stringify(data), 'utf8'), { level: 9 });
fs.writeFileSync(out, gz);

console.log(`✓ 已生成 ${path.relative(root, out)}（${(gz.length / 1024).toFixed(0)} KB）`);
console.log(`  merges: ${merges.length} 对 · added_tokens: ${added.length} 个`);
