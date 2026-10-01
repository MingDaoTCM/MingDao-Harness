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
// v0.6.9（文档债）：**手写条目存在时不要插入占位条目**。此前脚本无条件在顶部插一条
// `## vX（日期）\n\n- <提交主题>`；而本项目的 CHANGELOG 条目是逐版手写的（有分组与取舍说明），
// 于是自动条目会盖在真条目上面，同一版本出现两条、且上面那条只有一行。
if (new RegExp(`^## v${String(ver).replace(/\./g, '\\.')}[（(]`, 'm').test(s)) {
  console.log(`CHANGELOG 已有 v${ver} 条目（手写），跳过占位条目插入`);
} else {
  const idx = s.indexOf('\n## v');
  if (idx === -1) fs.writeFileSync(f, entry + '\n' + s);
  else fs.writeFileSync(f, s.slice(0, idx + 1) + entry + '\n' + s.slice(idx + 1));
  console.log('CHANGELOG 已插入 v' + ver + ' 条目：' + subject);
}

// v0.6.8（文档审计 F-L7）：把该版本的发布说明状态从「待发布」翻成「已发布」。
// 此前 v0.6.7 的说明在发版之后仍然写着"待发布"——发布产物自我描述不一致，读者无法判断。
// 这一步挂在 `npm version` 上：走到这里说明版本号已经定了，紧接着就是打 tag。
const notes = path.join(root, `RELEASE-NOTES-${ver}.md`);
if (fs.existsSync(notes)) {
  const t = fs.readFileSync(notes, 'utf8');
  const flipped = t.replace(/(状态：\*\*)待发布(\*\*)/, `$1已发布$2（tag \`v${ver}\`）`);
  if (flipped !== t) {
    fs.writeFileSync(notes, flipped);
    console.log(`RELEASE-NOTES-${ver}.md 状态已翻为「已发布」`);
  }
} else {
  console.log(`（未找到 RELEASE-NOTES-${ver}.md，跳过状态翻转）`);
}
