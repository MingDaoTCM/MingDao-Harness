// 开发脚本：把根 package.json 的版本同步到 desktop/package.json（发版联动，审计 Kimi 6.4）。
// 用法：node scripts/sync-versions.mjs（CI 桌面构建前自动执行；本地 npm run desktop:dist 前亦执行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dp = path.join(root, 'desktop', 'package.json');
const deskPkg = JSON.parse(fs.readFileSync(dp, 'utf8'));
if (deskPkg.version === rootPkg.version) {
  console.log(`desktop 版本已同步：${rootPkg.version}`);
} else {
  deskPkg.version = rootPkg.version;
  fs.writeFileSync(dp, JSON.stringify(deskPkg, null, 2) + '\n');
  console.log(`desktop/package.json 版本已同步为 ${rootPkg.version}`);
}
