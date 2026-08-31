// CHANGELOG 发布自动化（质检 Phase 3）：npm version 时自动在 CHANGELOG 顶部插入新版本条目
// （版本号 + 日期 + 最近一次提交主题），保证变更日志与发布节奏一致。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ver = process.env.npm_package_version;
const subject = (() => {
  try {
    return execSync('git log -1 --pretty=%s', { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '发布 ' + ver;
  }
})();
const date = new Date().toISOString().slice(0, 10);
const entry = `## v${ver}（${date}）\n\n- ${subject}\n`;
const f = path.join(root, 'CHANGELOG.md');
const s = fs.readFileSync(f, 'utf8');
const anchor = '本项目的变更日志';
// 在首个「## v」条目前插入
const idx = s.indexOf('\n## v');
if (idx === -1) {
  fs.writeFileSync(f, entry + '\n' + s);
} else {
  fs.writeFileSync(f, s.slice(0, idx + 1) + entry + '\n' + s.slice(idx + 1));
}
console.log('CHANGELOG 已插入 v' + ver + ' 条目：' + subject);
