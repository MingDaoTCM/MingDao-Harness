// 为 registry/index.json 的每个文件条目计算 sha256（P3-3 供应链完整性）。
// 用法：node scripts/build-registry-hashes.js（发布技能库前运行一次）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexFile = path.join(root, 'registry', 'index.json');
const libDir = path.join(root, 'skills-lib');

const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
let hashed = 0;
for (const skill of index.skills) {
  for (const f of skill.files) {
    const p = path.join(libDir, skill.name, f.path);
    const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    f.sha256 = h;
    hashed += 1;
  }
}
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n');
console.log(`已为 ${hashed} 个文件写入 sha256 → registry/index.json`);
