// 安装包目录的版本裁剪（保留最近 N 个版本，其余删除/归档）。
//
// 为什么要有它：2026-11-06 实测源站 downloads/ 已累计 **8.9GB / 15 个版本**（每版 633MB），
// 而策略写的是"保留最近 4 个版本"——**策略存在但没人执行**，磁盘就这么涨起来了。
// 这类"策略没有可执行的落点"的问题，加一条人工纪律没用，必须给一个能跑、能预览、能断言的脚本。
//
// 用法：
//   node scripts/prune-downloads.mjs <目录> --keep 4            # 预览（默认 dry-run）
//   node scripts/prune-downloads.mjs <目录> --keep 4 --apply    # 真删
//   node scripts/prune-downloads.mjs <目录> --keep 4 --archive-to /backup/downloads --apply   # 先移动再删
//
// 安全边界（刻意保守）：
//   · 只处理"看起来是版本文件"的名字（含 `x.y.z` 版本号）；不认识的文件一律不碰；
//   · 只按**版本号**分组，绝不按时间（时间会被 cp 打乱）；
//   · 默认 dry-run，必须显式 --apply 才动文件；
//   · 任何一步失败都返回非零，并由调用方决定是否发布。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 从文件名里取版本号（`mingdao-0.6.39-arm64.dmg` → `0.6.39`）；取不到返回 null。 */
export function versionOf(name) {
  const m = String(name).match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** 版本号比较（数值逐段比较，避免 `0.6.10 < 0.6.9` 的字符串陷阱）。 */
export function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 计算裁剪计划（**纯函数**，便于单测）。
 * @param {string[]} files 目录里的文件名
 * @param {{keep?: number}} [opts]
 * @returns {{keep: string[], drop: string[], unknown: string[], versions: string[]}}
 */
export function planPrune(files, { keep = 4 } = {}) {
  const n = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 4;
  /** @type {Map<string, string[]>} */
  const byVersion = new Map();
  /** @type {string[]} */
  const unknown = [];
  for (const f of files) {
    const v = versionOf(f);
    if (!v) { unknown.push(f); continue; }
    if (!byVersion.has(v)) byVersion.set(v, []);
    byVersion.get(v).push(f);
  }
  const versions = [...byVersion.keys()].sort(compareVersion).reverse(); // 新 → 旧
  const keepSet = new Set(versions.slice(0, n));
  /** @type {string[]} */
  const kept = [];
  /** @type {string[]} */
  const drop = [];
  for (const [v, list] of byVersion) {
    for (const f of list) (keepSet.has(v) ? kept : drop).push(f);
  }
  return { keep: kept.sort(), drop: drop.sort(), unknown: unknown.sort(), versions };
}

/** CLI 主流程（依赖注入 fs，便于测试时替换成内存实现）。 */
export function runPrune({ dir, keep, apply = false, archiveTo = null, io = fs }) {
  const files = io.readdirSync(dir).filter((f) => io.statSync(path.join(dir, f)).isFile());
  const plan = planPrune(files, { keep });
  const bytesOf = (/** @type {string[]} */ list) =>
    list.reduce((s, f) => s + Number(io.statSync(path.join(dir, f)).size || 0), 0);
  const dropBytes = bytesOf(plan.drop);
  const unknownBytes = bytesOf(plan.unknown);

  if (apply && archiveTo) io.mkdirSync(archiveTo, { recursive: true });
  /** @type {string[]} */
  const errors = [];
  for (const f of plan.drop) {
    try {
      if (apply && archiveTo) {
        io.renameSync(path.join(dir, f), path.join(archiveTo, f));
      } else if (apply) {
        io.unlinkSync(path.join(dir, f));
      }
    } catch (err) {
      errors.push(`${f}: ${/** @type {any} */ (err)?.message || err}`);
    }
  }
  return { plan, dropBytes, unknownBytes, errors };
}

// 与 sign-release-assets 同一个教训：Windows 上 `file://${argv[1]}` 永不相等（会静默不执行）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
  const keepIdx = args.indexOf('--keep');
  const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 4;
  const archiveIdx = args.indexOf('--archive-to');
  const archiveTo = archiveIdx >= 0 ? args[archiveIdx + 1] : null;
  const apply = args.includes('--apply');
  if (!dir || !fs.existsSync(dir)) { console.error('用法: node scripts/prune-downloads.mjs <目录> [--keep N] [--apply] [--archive-to 目录]'); process.exit(2); }
  const r = runPrune({ dir, keep, apply, archiveTo });
  const mb = (b) => (b / 1048576).toFixed(1) + 'MB';
  console.log(`版本（新→旧）：${r.plan.versions.join(', ') || '（无）'}`);
  console.log(`保留 ${r.plan.keep.length} 个文件；将${apply ? '删除' : '删除（预览）'} ${r.plan.drop.length} 个 / ${mb(r.dropBytes)}`);
  if (r.plan.unknown.length) console.log(`不认识的文件（不动）：${r.plan.unknown.length} 个 / ${mb(r.unknownBytes)}`);
  if (!apply) console.log('（dry-run：加 --apply 才真正执行）');
  if (r.errors.length) { console.error('✗ 有失败：'); for (const e of r.errors.slice(0, 10)) console.error('  · ' + e); process.exit(1); }
}
