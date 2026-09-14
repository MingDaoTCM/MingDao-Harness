// 四平台发布一致性校验（GitHub / Gitee / GitCode / npm）。
//
// 为什么必须有：本项目此前只把「三平台」挂在嘴上，npm 靠人记得手工发——
// 于是负责人不得不专门提醒「应该推送四平台，要包括 npm，以后记住」。
// **口头约定记不住，脚本才记得住。** 本脚本把「四个渠道是否同一版本、同一个 commit」
// 变成一条命令、一个非 0 退出码，挂在发布清单的验收步骤里。
//
// 用法：
//   node scripts/verify-release.mjs                 # 版本取 package.json
//   node scripts/verify-release.mjs 0.6.1
//   node scripts/verify-release.mjs 0.6.1 --json    # 机器可读
//
// 环境（可选，缺失时退化到匿名/跳过）：MINGDAO_GITHUB_TOKEN / MINGDAO_GITEE_TOKEN / MINGDAO_GITCODE_TOKEN
//
// 检查项：
//   · GitHub  main SHA、tag SHA、Release 存在性与附件数
//   · Gitee   main SHA、tag SHA、Release 是否存在
//   · GitCode main SHA、tag SHA、Release 是否存在
//   · npm     该版本是否已发布、dist-tags.latest 是否指向它
// 任一缺失 → 退出非 0（半发布状态必须显式失败，不能靠人眼看）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const V = (args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).trim();
const TAG = `v${V}`;

const REPO = { owner: 'MingDaoTCM', name: 'MingDao-Harness' };
const NPM_PKG = 'mingdao-harness';

const GIT_URLS = {
  GitHub: 'https://github.com/MingDaoTCM/MingDao-Harness.git',
  Gitee: 'https://gitee.com/MingDaoTCM/MingDao-Harness.git',
  GitCode: 'https://gitcode.com/MingDaoTCM/MingDao-Harness.git',
};

const token = {
  github: process.env.MINGDAO_GITHUB_TOKEN || '',
  gitee: process.env.MINGDAO_GITEE_TOKEN || '',
  gitcode: process.env.MINGDAO_GITCODE_TOKEN || '',
};

/** 本地 main 与 tag 的 SHA —— 四平台都必须与它一致 */
function localSha(rev) {
  try {
    return execFileSync('git', ['rev-parse', rev], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** 匿名 ls-remote：不依赖本地 remote 配置（换机器/新克隆也能跑） */
/**
 * 取远端 ref 的 SHA。**必须有界重试**：v0.6.2 发布时实测遇到一次瞬时失败
 * （同一 remote 的 tag 读到了、main 却读成 null），脚本当场报
 * 「✗ 四平台未对齐——这不算发布完成」。一次抖动的网络读不该在发版收尾时喊狼来了：
 * **误报会训练人忽略这条告警**，而它恰恰是防止半发布的最后一道闸。
 * 三次尝试（间隔 1s/2s）仍失败才算「取不到」。
 * @returns {{sha: string|null, error: string|null}}
 */
function remoteShaDetail(url, ref) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      try {
        execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${attempt * 1000})`], { timeout: 5000, stdio: 'ignore' });
      } catch {}
    }
    try {
      const out = execFileSync('git', ['ls-remote', url, ref], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
      const line = out.trim().split('\n')[0] || '';
      const sha = line.split(/\s+/)[0] || null;
      // 读到了但为空 = 这个 ref 在远端确实不存在（不是网络问题），不再重试
      if (!sha) return { sha: null, error: null };
      return { sha, error: null };
    } catch (e) {
      lastErr = String(e?.message || e).split('\n')[0];
    }
  }
  return { sha: null, error: lastErr || 'git ls-remote 失败' };
}

function remoteSha(url, ref) {
  return remoteShaDetail(url, ref).sha;
}

async function api(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

const checks = [];

async function checkGitHosts() {
  const localMain = localSha('main');
  const localTag = localSha(`${TAG}^{}`) || localSha(TAG);
  // 本地都没有这个 tag 时不能只显示「（取不到）」（两端都取不到就分不清是谁的问题），
  // 直接点明「本地没有 vX.Y.Z」——这通常意味着版本号填错或该 tag 还没打。
  if (!localTag) {
    for (const name of Object.keys(GIT_URLS)) {
      checks.push({ platform: name, item: `tag ${TAG}`, expected: '本地应存在该 tag', actual: `本地没有 ${TAG}`, ok: false });
    }
  }
  for (const [name, url] of Object.entries(GIT_URLS)) {
    const m = remoteShaDetail(url, 'refs/heads/main');
    // 「取不到」（网络/限流）与「读到了但不一样」（真的没推）必须区分开：
    // 前者重试后再报，且提示是"稍后重跑"；后者是实打实的未对齐
    checks.push({
      platform: name,
      item: 'main',
      expected: localMain,
      actual: m.sha || (m.error ? `取不到（${m.error}）` : '远端无此分支'),
      ok: Boolean(m.sha) && m.sha === localMain,
    });
    {
      const t1 = remoteShaDetail(url, `refs/tags/${TAG}^{}`);
      const t2 = t1.sha ? t1 : remoteShaDetail(url, `refs/tags/${TAG}`);
      if (localTag) {
        checks.push({
          platform: name,
          item: `tag ${TAG}`,
          expected: localTag,
          actual: t2.sha || (t2.error ? `取不到（${t2.error}）` : `远端无 tag ${TAG}`),
          ok: Boolean(t2.sha) && t2.sha === localTag,
        });
      }
    }
  }
}

async function checkReleases() {
  // GitHub
  const gh = await api(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/tags/${TAG}`, token.github ? { Authorization: `Bearer ${token.github}` } : {});
  const ghExists = gh.ok && gh.body && typeof gh.body === 'object' && Boolean(gh.body.tag_name);
  checks.push({
    platform: 'GitHub',
    item: 'Release',
    expected: '存在',
    actual: ghExists ? `存在（附件 ${(gh.body.assets || []).length} 个）` : `HTTP ${gh.status}`,
    ok: ghExists,
  });
  // Gitee（token 走 query）
  const giteeQ = token.gitee ? `?access_token=${token.gitee}` : '';
  const ge = await api(`https://gitee.com/api/v5/repos/${REPO.owner}/${REPO.name}/releases/tags/${TAG}${giteeQ}`);
  // ⚠ Gitee 对「不存在的 Release」返回 HTTP 200 + **null 体**（实测），
  // 只看 r.ok 会把「没有发布」判成「已发布」——必须同时判 body 是否为对象。
  const geExists = ge.ok && ge.body && typeof ge.body === 'object' && Boolean(ge.body.id);
  checks.push({
    platform: 'Gitee',
    item: 'Release',
    expected: '存在',
    actual: geExists ? `存在（${String(ge.body?.name || '').slice(0, 24)}）` : ge.ok ? '不存在（HTTP 200 + null）' : `HTTP ${ge.status}`,
    ok: geExists,
  });
  // GitCode
  const gc = await api(`https://api.gitcode.com/api/v5/repos/${REPO.owner}/${REPO.name}/releases/${TAG}`, token.gitcode ? { 'private-token': token.gitcode } : {});
  const gcExists = gc.ok && gc.body && typeof gc.body === 'object' && Boolean(gc.body.tag_name || gc.body.id);
  checks.push({
    platform: 'GitCode',
    item: 'Release',
    expected: '存在',
    actual: gcExists ? `存在（${String(gc.body?.name || '').slice(0, 24)}）` : gc.ok ? '不存在（200 但无 tag_name）' : `HTTP ${gc.status}`,
    ok: gcExists,
  });
}

async function checkNpm() {
  const r = await api(`https://registry.npmjs.org/${NPM_PKG}`);
  if (!r.ok) {
    checks.push({ platform: 'npm', item: `已发布 ${V}`, expected: '是', actual: `registry HTTP ${r.status}`, ok: false });
    checks.push({ platform: 'npm', item: 'dist-tags.latest', expected: V, actual: '（取不到）', ok: false });
    return;
  }
  const versions = Object.keys(r.body.versions || {});
  const published = versions.includes(V);
  const latest = (r.body['dist-tags'] || {}).latest || '';
  checks.push({ platform: 'npm', item: `已发布 ${V}`, expected: '是', actual: published ? '是' : `否（现有 ${versions.slice(-3).join(', ')}…）`, ok: published });
  // 回填版会用 --tag backfill 发布，latest 不一定指向它 —— 只警告不判失败
  checks.push({
    platform: 'npm',
    item: 'dist-tags.latest',
    expected: `${V}（回填版可为其他）`,
    actual: latest,
    ok: true,
    warn: latest !== V,
  });
}

await checkGitHosts();
await checkReleases();
await checkNpm();

if (asJson) {
  console.log(JSON.stringify({ version: V, checks }, null, 2));
} else {
  console.log(`四平台发布一致性校验（版本 ${V}，仓库 ${REPO.owner}/${REPO.name}）\n`);
  const w = '  ';
  // SHA 显示前 8 位，长文本原样（Release 存在性带附件数，截断就看不出信息了）
  const show = (v) => {
    const a = String(v == null || v === '' ? '（取不到）' : v);
    return /^[0-9a-f]{40}$/.test(a) ? a.slice(0, 8) : a;
  };
  for (const c of checks) {
    const mark = c.ok ? (c.warn ? '⚠' : '✓') : '✗';
    const detail = `${c.platform}/${c.item}`.padEnd(22);
    const tail = c.ok ? show(c.actual) : `期望 ${show(c.expected)}，实得 ${show(c.actual)}`;
    console.log(`${w}${mark} ${detail} ${tail}`);
  }
  const bad = checks.filter((c) => !c.ok);
  const warns = checks.filter((c) => c.ok && c.warn);
  console.log('');
  if (warns.length) console.log(`⚠ ${warns.length} 项需人工确认（如 npm latest 指向别的版本）`);
  if (bad.length) {
    console.error(`✗ 四平台未对齐：${bad.length} 项缺失/不一致——**这不算发布完成**`);
    for (const b of bad) console.error(`   - ${b.platform}/${b.item}：期望 ${b.expected}，实得 ${b.actual}`);
    process.exit(1);
  }
  console.log('✓ 四平台一致（GitHub / Gitee / GitCode 的 main 与 tag 同 SHA，Release 齐备，npm 已发该版本）');
}
process.exit(checks.every((c) => c.ok) ? 0 : 1);
