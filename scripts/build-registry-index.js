// 生成技能库线上 registry 索引：registry/index.json
// 运行：node scripts/build-registry-index.js
// 产出提交到 main 分支，客户端经 raw.githubusercontent / gitee / gitcode 读取。
// 也可设置 MINGDAO_REGISTRY_URL 指向自建静态托管（企业内网 registry 同理）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const libDir = path.join(root, 'skills-lib');
const outFile = path.join(root, 'registry', 'index.json');

const skills = [];
let skipped = 0;
for (const e of fs.readdirSync(libDir, { withFileTypes: true })) {
  if (!e.isDirectory()) continue;
  const dir = path.join(libDir, e.name);
  const skillMd = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) {
    skipped += 1;
    console.warn(`跳过 ${e.name}：缺少 SKILL.md`);
    continue;
  }
  const text = fs.readFileSync(skillMd, 'utf8');
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const name = fm?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim() || e.name;
  const description = fm?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim() || '';
  if (!name || !description) {
    skipped += 1;
    console.warn(`跳过 ${e.name}：frontmatter 缺 name/description`);
    continue;
  }
  const files = [];
  const walk = (dirPath, rel) => {
    for (const f of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (f.isDirectory()) {
        walk(path.join(dirPath, f.name), rel ? `${rel}/${f.name}` : f.name);
      } else if (f.isFile() && !f.name.startsWith('.')) {
        const p = rel ? `${rel}/${f.name}` : f.name;
        files.push({ path: p, size: fs.statSync(path.join(dirPath, f.name)).size });
      }
    }
  };
  walk(dir, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  skills.push({ name, description, files });
}

skills.sort((a, b) => a.name.localeCompare(b.name));

const index = {
  version: 1,
  updatedAt: new Date().toISOString(),
  total: skills.length,
  skills,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(index, null, 2) + '\n');
console.log(`已生成 ${outFile}：${skills.length} 个技能（跳过 ${skipped} 个）`);
