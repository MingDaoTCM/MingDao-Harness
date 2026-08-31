// 覆盖率汇总（质检 Phase 3）：解析 .coverage/ 下 V8 覆盖率 JSON，输出行覆盖率；
// 低于阈值（默认 55%）以非零码退出（CI 门禁）。零依赖。
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
    const file = url.replace('file://', '');
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
const threshold = Number(process.env.MINGDAO_COVERAGE_THRESHOLD || 55);
perFile.sort((a, b) => b[1] - a[1]);
console.log(`行覆盖率（src 已执行文件）：${pct}%（${coveredLines}/${totalLines} 行）· 阈值 ${threshold}%`);
console.log('覆盖率最低的 8 个文件：');
for (const [f, l, h] of perFile.slice(-8)) console.log(`  ${l ? Math.round((h / l) * 100) : 0}%  ${f}（${h}/${l}）`);
if (pct < threshold) {
  console.error(`覆盖率低于阈值 ${threshold}%`);
  process.exit(1);
}
