// 覆盖率汇总（质检 Phase 3）：解析 .coverage/ 下 V8 覆盖率 JSON，输出行覆盖率；
// 低于阈值（默认 60%）以非零码退出（CI 门禁）。零依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.coverage');
if (!fs.existsSync(dir)) {
  console.error('未找到 .coverage/（先运行 npm run coverage）');
  process.exit(1);
}
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

// 每个 src 文件：行起始偏移表 + 覆盖区间集合
const fileStats = new Map(); // file -> { lineStarts: number[], offsets: [s,e][] }
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const entry of d.result || []) {
    const url = String(entry.url || '');
    if (!url.startsWith('file://')) continue;
    // v0.6.8（报告一 K-5，**高**）：用 `fileURLToPath` 而不是 `replace('file://','')`。
    // 后者在 Windows 上留下 `/D:/…`（前面多一个斜杠 → 路径永远不存在 → 分母为 0、
    // 脚本打印 `0%（0/0 行）` 并 exit 1），对含空格/中文的路径也不会做百分号解码。
    let file;
    try {
      file = fileURLToPath(url);
    } catch {
      continue;
    }
    const rel = path.relative(root, file);
    if (rel !== 'src' && !rel.startsWith('src' + path.sep)) continue;
    try {
      let st = fileStats.get(file);
      if (!st) {
        const content = fs.readFileSync(file, 'utf8');
        const lineStarts = [0];
        for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
        st = { lineStarts, offsets: [] };
        fileStats.set(file, st);
      }
      for (const fn of entry.functions || []) {
        for (const r of fn.ranges || []) {
          if (typeof r.startOffset === 'number' && typeof r.endOffset === 'number' && r.count > 0) {
            st.offsets.push([r.startOffset, r.endOffset]);
          }
        }
      }
    } catch {}
  }
}

// v0.6.8（报告一 K-6，**高**）：**分母必须是全部 src 文件**，而不是"V8 数据里出现过的文件"。
// 此前未加载的文件被直接从分母剔除 —— 于是"少测一个文件"反而让覆盖率变好看
// （报告点名这正是"检测到局部事实 → 升级成全局结论"的同类反模式）。
const allSrc = [];
(function walk(/** @type {string} */ d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.isFile() && e.name.endsWith('.js')) allSrc.push(f);
  }
})(path.join(root, 'src'));
const loadedSet = new Set([...fileStats.keys()].map((f) => path.resolve(f)));
const unloaded = allSrc.filter((f) => !loadedSet.has(path.resolve(f)));
for (const f of unloaded) {
  const content = fs.readFileSync(f, 'utf8');
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  fileStats.set(f, { lineStarts, offsets: [] });
}

let totalLines = 0, coveredLines = 0;
const perFile = [];
for (const [file, st] of fileStats) {
  let lines = st.lineStarts.length;
  let hit = 0;
  for (let li = 0; li < st.lineStarts.length; li++) {
    const lineStart = st.lineStarts[li];
    const lineEnd = li + 1 < st.lineStarts.length ? st.lineStarts[li + 1] - 1 : Number.MAX_SAFE_INTEGER;
    if (st.offsets.some(([s, e]) => e > lineStart && s < lineEnd)) hit += 1;
  }
  totalLines += lines;
  coveredLines += hit;
  perFile.push([path.relative(root, file), lines, hit]);
}
const pct = totalLines ? Math.round((coveredLines / totalLines) * 1000) / 10 : 0;
const threshold = Number(process.env.MINGDAO_COVERAGE_THRESHOLD || 60);
perFile.sort((a, b) => b[1] - a[1]);
// 分母为 0 == 数据采不到（Windows 路径问题、coverage 没跑、目录结构变了）→ 必须失败，
// 而不是打印一个 0% 让人以为"覆盖率低"。工具/数据不可用 ≠ 质量结论。
if (totalLines === 0 || allSrc.length === 0) {
  console.error(`未采集到任何可统计的 src 文件（src 文件 ${allSrc.length} 个，统计 ${fileStats.size} 个）。`);
  console.error('这通常意味着：coverage 未运行、或 V8 覆盖率数据里的路径无法映射到 src/。按失败处理。');
  process.exit(1);
}
console.log(`行覆盖率（分母 = src 全部 ${allSrc.length} 个文件）：${pct}%（${coveredLines}/${totalLines} 行）· 阈值 ${threshold}%`);
if (unloaded.length) {
  console.log(`未加载文件 ${unloaded.length} 个（按 0 计入分母）：`);
  for (const f of unloaded.slice(0, 10)) console.log('  · ' + path.relative(root, f));
  if (unloaded.length > 10) console.log(`  · …另有 ${unloaded.length - 10} 个`);
}
console.log('覆盖率最低的 8 个文件：');
for (const [f, l, h] of perFile.slice(-8)) console.log(`  ${l ? Math.round((h / l) * 100) : 0}%  ${f}（${h}/${l}）`);
if (pct < threshold) {
  console.error(`覆盖率低于阈值 ${threshold}%`);
  process.exit(1);
}
