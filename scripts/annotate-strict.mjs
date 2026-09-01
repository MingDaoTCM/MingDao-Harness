// strict 注解辅助器（Phase C C3）：按 tsc full 报错的精确行列，在隐式 any 参数/变量声明前
// 插入 /** @type {any} */（纯注释，零运行时影响）。只处理命令行给定的文件集合；
// TS7006/TS7034/TS7005 自动修，迭代至清零；其余类型（TS7053/TS2339/TS2345/TS7023）留给人工。
// 用法：node scripts/annotate-strict.mjs <file1> <file2> ...
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法: node scripts/annotate-strict.mjs <文件...>');
  process.exit(1);
}
const want = new Set(files.map((f) => path.resolve(f)));

function tscErrors() {
  try {
    execFileSync('npx', ['tsc', '-p', 'tsconfig.full.json', '--noEmit'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return '';
  } catch (err) {
    // tsc 有错误时以非零码退出，错误清单在 stdout
    return String((err && (err.stdout || err.stderr)) || '');
  }
}

const AUTO_RE = /^(src\/[^(]+)\((\d+),(\d+)\): error TS(7006|7034|7005):/gm;
const ANNOT = '/** @type {any} */ ';

function applyRound() {
  const raw = tscErrors();
  const edits = new Map(); // file -> [{line, col}]
  for (const m of raw.matchAll(AUTO_RE)) {
    const f = path.resolve(m[1]);
    if (!want.has(f)) continue;
    const line = Number(m[2]);
    const col = Number(m[3]);
    const arr = edits.get(f) || [];
    arr.push({ line, col });
    edits.set(f, arr);
  }
  if (!edits.size) return 0;
  let applied = 0;
  for (const [f, items] of edits) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    // 同一行可能有多个插入点：从右往左插，避免列偏移
    const byLine = new Map();
    for (const it of items) {
      const arr = byLine.get(it.line) || [];
      arr.push(it.col);
      byLine.set(it.line, arr);
    }
    for (const [line, cols] of [...byLine.entries()].sort((a, b) => b[0] - a[0])) {
      const idx = line - 1;
      if (idx < 0 || idx >= lines.length) continue;
      const uniq = [...new Set(cols)].sort((a, b) => b - a);
      for (const col of uniq) {
        const pos = col - 1;
        const ch = lines[idx][pos];
        // 列必须指向标识符开头（字母/_/$），否则跳过（避免插进错误位置）
        if (ch !== undefined && /[A-Za-z_$]/.test(ch)) {
          lines[idx] = lines[idx].slice(0, pos) + ANNOT + lines[idx].slice(pos);
          applied += 1;
        }
      }
    }
    fs.writeFileSync(f, lines.join('\n'));
  }
  return applied;
}

let total = 0;
for (let round = 0; round < 6; round++) {
  const n = applyRound();
  total += n;
  if (n === 0) break;
}
console.log(`自动注解：插入 ${total} 处 @type{any}`);

// 剩余错误统计（限目标文件）
const raw = tscErrors();
const perFile = new Map();
for (const m of raw.matchAll(/^(src\/[^(]+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) {
  const f = path.resolve(m[1]);
  if (!want.has(f)) continue;
  perFile.set(f, (perFile.get(f) || 0) + 1);
}
if (perFile.size) {
  console.log('剩余（需人工的类型错误）：');
  for (const [f, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${f}`);
  const lines = raw.split('\n').filter((l) => {
    const m = /^src\/([^(]+)\(/.exec(l);
    return m && want.has(path.resolve(m[1])) && !/TS(7006|7034|7005)/.test(l);
  });
  for (const l of lines.slice(0, 60)) console.log('   ' + l);
} else {
  console.log('✅ 目标文件全部清零');
}
