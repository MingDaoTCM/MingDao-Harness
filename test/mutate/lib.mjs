// 变异验证脚手架（v0.6.7，第三方报告一 S-3② 的落地）：
// 「把修复逐个改回缺陷，断言必须当场失败」此前是**手工过程**——报告指出这与项目
// 「守卫必须可回归」的自我要求不一致。这里把它变成可复跑的工具：
//
//   node test/mutate/run.mjs            # 跑全部批次
//   node test/mutate/run.mjs batch12    # 只跑某一批
//
// 用法（写某一批时）：
//   const M = await makeMutator();            // 或 makeMutator({ rebuild: <节号> })
//   等一等的原语：
//     M.section('124')                        // 跑 test/smoke.js 第 124 节（自动抽成独立脚本后执行）
//     M.suite('test/e2e-schedule.js')         // 跑一整个套件
//     M.mutate({ name, file, from, to, expect: ['关键词'], run: () => M.section('126') })
//
// 约定：`expect` 是**断言原文里的关键词**——关键词对不上就算"逃逸"（很可能只是失败的断言不是你修的那条）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const smokePath = path.join(repoRoot, 'test', 'smoke.js');
const outDir = path.join(repoRoot, 'test', 'mutate', '.generated');

/**
 * 行尾归一化：CRLF（含游离 CR）→ LF。
 *
 * v0.6.8（Windows 腿修复）：Git for Windows 的 `core.autocrlf` 默认是 true，而本仓库没有
 * `.gitattributes`——windows-latest 上 checkout 出来的工作树里，**每个文本文件都是 CRLF**，
 * 而本文件的 `from` 锚点一律按 LF 书写（多行锚点用 '\n' 连接）。读文件不归一化，多行锚点就
 * 永远 `includes()` 不到：批十二~十五会静默退化成"变异点未找到 7 处 / 批次 0/4 全中"，
 * 看起来像"守卫全挂了"，实际是脚手架自己读错了行尾（假红）。
 *
 * 本地复现（macOS 上同样可行）：把 src/ssrf-guard.js、src/agent.js、src/cost-guard.js、
 * src/batch.js、src/credentials.js、ide/vscode/extension.js 转成 CRLF 后跑
 * `node test/mutate/run.mjs`，失败项与数量与 CI 的 Windows 日志逐字一致。
 */
export function normalizeEol(s) {
  return String(s).replace(/\r\n?/g, '\n');
}

/** 抽出 smoke.js 的某一节（含软链探测辅助函数与最小前置），生成可独立运行的脚本。 */
export function extractSection(num) {
  fs.mkdirSync(outDir, { recursive: true });
  const smoke = normalizeEol(fs.readFileSync(smokePath, 'utf8'));
  const start = smoke.indexOf(`// ---------- ${num}.`);
  if (start < 0) throw new Error(`未能定位第 ${num} 节`);
  // v0.6.8（报告一 M-6）：边界取**从本节起的下一个节头**（或文件末的收尾标记），
  // 而不是"文件里第一处 `delete process.env.MINGDAO_HOME;`"——后者若出现在本节之前，
  // slice(start, end) 会得到空串：生成脚本里一条断言都没有，节"通过"得毫无意义
  // （变异验证会因此变成假绿，正是它本该防的事）。
  const nextHeader = smoke.indexOf('\n// ---------- ', start + 1);
  const tailMark = smoke.indexOf('\ndelete process.env.MINGDAO_HOME;', start + 1);
  const candidates = [nextHeader, tailMark].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : smoke.length;
  if (end <= start) throw new Error(`第 ${num} 节的边界计算异常`);
  const hStart = smoke.indexOf('// 建一个**真正的**符号链接');
  const hEnd = smoke.indexOf('// ---------- 1. token 估算');
  const helpers = hStart >= 0 && hEnd > hStart ? smoke.slice(hStart, hEnd) : '';
  const file = path.join(outDir, `sec${num}.mjs`);
  fs.writeFileSync(
    file,
    `import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const srcDir = ${JSON.stringify(path.join(repoRoot, 'src'))};
const repoRoot = path.dirname(srcDir); // v0.6.8：节里可能引用仓库根（脚本/desktop/ide 守卫）
const require = (await import('node:module')).createRequire(import.meta.url); // 生成的脚本是 ESM，CJS 加载 preload 时需要它
const { dispatch } = await import(pathToFileURL(path.join(srcDir, 'tools', 'index.js')).href);
const { saveConfig, loadConfig } = await import(pathToFileURL(path.join(srcDir, 'config.js')).href);
const { createAgent } = await import(pathToFileURL(path.join(srcDir, 'agent.js')).href);
const { createIO } = await import(pathToFileURL(path.join(srcDir, 'ui.js')).href);
function ok(n) { console.log('  \\u2713 ' + n); }
function safeRmSync(...a) { try { fs.rmSync(...a); } catch {} }
process.env.MINGDAO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sec-home-'));
${helpers}
${smoke.slice(start, end)}
console.log('第 ${num} 节：全部通过');
process.exit(0);
`
  );
  return file;
}

/** @param {ReturnType<typeof makeMutator>} M */
export function makeMutator(opts = {}) {
  const quiet = opts.quiet === true;
  const results = [];
  const M = {
    results,
    /** 跑 smoke 的某一节（每次按当前源码重新抽取，避免跑到陈旧副本） */
    section(num) {
      const file = extractSection(String(num));
      return spawnSync(process.execPath, [file], { cwd: repoRoot, encoding: 'utf8' });
    },
    /** 跑一整个套件（相对仓库根） */
    suite(rel, extraEnv = {}) {
      return spawnSync(process.execPath, [rel], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, MINGDAO_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'mdh-mut-')), ...extraEnv },
      });
    },
    /**
     * 做一次变异：改坏 → 跑 → 无论结果如何都还原。
     * @param {{name: string, file: string, from: string, to: string, expect: string[], run: () => any}} m
     */
    mutate(m) {
      const f = path.join(repoRoot, m.file);
      const raw = fs.readFileSync(f, 'utf8');
      // v0.6.8（Windows 腿）：匹配前把工作树的行尾归一化成 LF（见 normalizeEol 的注释）。
      // 归一化只用于**匹配与写入**；还原时写回 raw——跑完工作树的字节必须与跑之前完全一致
      // （Windows 上就是 CRLF 原样），否则变异验证会污染工作区，比不跑还危险。
      const orig = normalizeEol(raw);
      if (!orig.includes(m.from)) {
        const crlf = raw.includes('\r\n');
        results.push({
          name: m.name,
          ok: false,
          why: `变异点未找到：${JSON.stringify(m.from.slice(0, 60))}${crlf ? '（该文件是 CRLF，已按 LF 归一化后仍未匹配）' : ''}`,
        });
        if (!quiet) console.log(`✗ ${m.name}\n    变异点未找到（${m.file}）`);
        return false;
      }
      fs.writeFileSync(f, orig.replace(m.from, m.to));
      let out;
      try {
        out = m.run();
      } finally {
        fs.writeFileSync(f, raw); // 先还原原始字节，再判结果
      }
      const text = String(out?.stdout || '') + String(out?.stderr || '');
      const hit = out?.status !== 0 && m.expect.some((k) => text.includes(k));
      results.push({ name: m.name, ok: hit });
      if (!quiet) {
        if (hit) console.log(`✓ ${m.name}`);
        else console.log(`✗ 逃逸：${m.name}（exit=${out?.status}）\n${text.slice(-500)}`);
      }
      return hit;
    },
    /** 打印并返回是否全中（给批脚本当退出码用） */
    report() {
      const caught = results.filter((r) => r.ok).length;
      console.log(`\n变异验证：${caught}/${results.length} 被抓到`);
      if (results.some((r) => !r.ok)) {
        for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.name}${r.why ? ` — ${r.why}` : ''}`);
      }
      return caught === results.length;
    },
  };
  return M;
}
