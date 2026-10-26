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
//   node scripts/verify-release.mjs 0.6.1 --retry 3 --timeout-ms 30000
//
// v0.6.26（§3.95）**三态分类**——这是本脚本最重要的一条纪律：
//   · 0 `ok`：四平台同一 commit、Release 齐备、npm 已发该版本；
//   · 1 `mismatch`：**真的不一样**（SHA 不同 / Release 缺失 / npm 未发）→ 发布未完成；
//   · 2 `unreachable`：**取不到**（超时 / 网络 / DNS / HTTP 5xx / 鉴权限流）——
//     **这不是发布失败**，网络恢复后重跑即可，绝不要据此回滚。
// 旧版把这两类混成一个「✗ 未对齐」，v0.6.24 发布后关机守护因此把一次 `git ls-remote`
// 超时（`spawnSync git ETIMEDOUT`）看成「发布有问题」；而同一时刻手工连跑三次全绿。
// 误报会训练人忽略告警，而这条告警恰恰是防半发布的最后一道闸——所以必须分开。
//
// 另一条纪律（同样来自 v0.6.24）：**绝不拿未 peel 的 tag 对象去和 main 的提交比较**。
// annotated tag 的 `refs/tags/X` 是 tag 对象（如 `d2788e96`），`refs/tags/X^{}` 才是它指向的
// 提交；peel 取不到时回退比较 tag 对象，必然「不相等」→ 假失败。现在改为：先尝试
// GitHub API（`git/ref/tags/<tag>`）安全地取 peeled commit；仍取不到就按 unreachable
// （exit 2）处理，文案写明「无法确定 tag 指向的提交」。
//
// 环境（可选，缺失时退化到匿名/跳过）：MINGDAO_GITHUB_TOKEN / MINGDAO_GITEE_TOKEN / MINGDAO_GITCODE_TOKEN
//
// 检查项：
//   · GitHub  main SHA、tag SHA、Release 存在性与附件数
//   · Gitee   main SHA、tag SHA、Release 是否存在
//   · GitCode main SHA、tag SHA、Release 是否存在
//   · npm     该版本是否已发布、dist-tags.latest 是否指向它
//
// 结构：**纯函数 + 薄 I/O**。判定/计数/退出码/文案都在导出的纯函数里（`test/verify-release.js`
// 直接 import 断言），网络与 `git ls-remote` 只出现在文件末尾的薄封装中。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// ---------------------------------------------------------------------------
// 纯函数层：三态、计数、退出码、文案。单测只依赖这一层，不碰网络。
// ---------------------------------------------------------------------------

/** 三态。任何检查项都必须落到其中之一；`ok` 仅作旧的布尔兼容字段。 */
export const STATUS = Object.freeze({
  OK: 'ok',
  MISMATCH: 'mismatch',
  UNREACHABLE: 'unreachable',
});

/** 退出码。**2 不是失败**：是「取不到，请重试」。 */
export const EXIT = Object.freeze({
  OK: 0,
  MISMATCH: 1,
  UNREACHABLE: 2,
});

export const LABEL_UNREACHABLE = '取不到（网络/服务不可达）';
export const TAG_PEEL_UNKNOWN = '无法确定 tag 指向的提交';
export const SUCCESS_LINE = '✓ 四平台一致（GitHub / Gitee / GitCode 的 main 与 tag 同 SHA，Release 齐备，npm 已发该版本）';

export const DEFAULT_RETRY = 2;
export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 解析命令行。
 * @param {string[]} argv
 * @param {string} defaultVersion
 * @returns {{json: boolean, version: string, retry: number, timeoutMs: number}}
 */
export function parseArgs(argv, defaultVersion = '') {
  const readValue = (flag, fallback) => {
    const eq = argv.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const retry = Number.parseInt(readValue('--retry', String(DEFAULT_RETRY)), 10);
  const timeoutMs = Number.parseInt(readValue('--timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10);
  const version = (argv.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || defaultVersion || '').trim();
  return {
    json: argv.includes('--json'),
    version,
    retry: Number.isFinite(retry) && retry >= 0 ? retry : DEFAULT_RETRY,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

/** 超时（含被 timeout 杀掉的 SIGTERM）。单独导出，测试与变异都盯它。 */
export function isTimeoutError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || err || '');
  return /ETIMEDOUT|ESOCKETTIMEDOUT/i.test(code) || /ETIMEDOUT|timed out|timeout|SIGTERM|killed/i.test(message);
}

/** 网络/DNS/连接类错误 → unreachable。**超时也走这里**。 */
export function isUnreachableError(err) {
  if (isTimeoutError(err)) return true;
  const code = String(err?.code || '');
  const message = String(err?.message || err || '');
  return (
    /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EPIPE/i.test(`${code} ${message}`) ||
    /network|fetch failed|socket hang up/i.test(message)
  );
}

/** HTTP 状态是否属于「取不到」：0（fetch 抛错）、鉴权/限流、408/425/429、5xx。404 是 mismatch。 */
export function isUnreachableHttp(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return true;
  return [0, 401, 403, 408, 425, 429].includes(n) || n >= 500;
}

/** 一次 `git ls-remote` 读取的三态：读到 SHA=ok（是否相等由上层判）、报错=unreachable、没有=missing。 */
export function classifyRead(read) {
  if (read && read.sha) return STATUS.OK;
  // 任何读取失败都是「取不到」：TLS/代理/凭据/仓库不可访问同样属于「无法判定」，
  // 而不是「SHA 读到且不同」。把这些归成 mismatch 会重复 v0.6.24 那类误报。
  if (read && read.error) return STATUS.UNREACHABLE;
  return STATUS.MISMATCH;
}

export function readFailureDetail(error) {
  const first = String(error || '未知错误').split('\n')[0];
  return `${LABEL_UNREACHABLE}：${first}`;
}

export function httpFailureDetail(result) {
  if (result && result.error) return readFailureDetail(result.error);
  return `HTTP ${result?.status ?? '?'}`;
}

/** 展示用：SHA 只显示前 8 位；空值显示「（取不到）」（与旧版逐字一致）。 */
export function shortSha(v) {
  const a = String(v == null || v === '' ? '（取不到）' : v);
  return /^[0-9a-f]{40}$/.test(a) ? a.slice(0, 8) : a;
}

/** 兼容旧字段：没有 status 的检查项按 `ok` 归一化为 ok/mismatch。 */
export function normalizeCheck(check) {
  const status = check.status || (check.ok ? STATUS.OK : STATUS.MISMATCH);
  return { ...check, status, ok: status === STATUS.OK };
}

/**
 * 三态计数与退出码（纯函数，单测的入口）。
 * 优先级：只要有一项确认的 mismatch 就 exit 1（真问题不能被网络噪声掩盖）；
 * 否则有 unreachable → exit 2；全绿 → 0。
 * @param {Array<{status?: string, ok?: boolean, warn?: boolean}>} checks
 */
export function classifyChecks(checks) {
  const normalized = checks.map(normalizeCheck);
  const mismatches = normalized.filter((c) => c.status === STATUS.MISMATCH);
  const unreachable = normalized.filter((c) => c.status === STATUS.UNREACHABLE);
  const warnings = normalized.filter((c) => c.status === STATUS.OK && c.warn);
  const exitCode = mismatches.length ? 1 : unreachable.length ? 2 : 0;
  return { exitCode, mismatches, unreachable, warnings, checks: normalized };
}

/** 单个 main 检查项（纯函数，输入一次远端读取结果）。 */
export function makeMainCheck({ platform, localMain, read }) {
  let status = classifyRead(read);
  if (status === STATUS.OK && read.sha !== localMain) status = STATUS.MISMATCH;
  const actual = status === STATUS.OK ? read.sha : read?.error ? readFailureDetail(read.error) : '远端无此分支';
  return {
    platform,
    item: 'main',
    expected: localMain || '（本地 main 不存在）',
    actual,
    status,
    ok: status === STATUS.OK,
  };
}

/**
 * 单个 tag 检查项（纯函数）。**核心纪律：peel 取不到时绝不拿未 peel 的 SHA 去比较。**
 * 判定顺序：
 *   1. 有 `refs/tags/X^{}`（peeled）→ 直接比；
 *   2. 没有 peeled 但有未 peel 的 SHA：若它恰好等于本地提交（轻量 tag）→ ok；
 *   3. 不等：先看 API 解析结果（`apiPeel.sha`，仅当能证明是同一个 tag 对象时才安全借用）；
 *   4. API 也没有 → **unreachable**，文案「无法确定 tag 指向的提交」，不是 mismatch。
 * @param {{platform: string, tag: string, localTag: string, peeled?: {sha?: string|null, error?: string|null}, unpeeled?: {sha?: string|null, error?: string|null}, apiPeel?: {sha?: string|null, error?: string|null}|null}} input
 */
export function makeTagCheck({ platform, tag, localTag, peeled, unpeeled, apiPeel }) {
  const base = { platform, item: `tag ${tag}`, expected: localTag };
  const done = (sha) => ({
    ...base,
    actual: sha,
    status: sha === localTag ? STATUS.OK : STATUS.MISMATCH,
    ok: sha === localTag,
  });

  if (peeled?.sha) return done(peeled.sha);
  if (unpeeled?.sha) {
    if (unpeeled.sha === localTag) return done(unpeeled.sha);
    // 不是同一提交：可能是 annotated tag 的 tag 对象（未 peel）——只能靠 API 安全解析。
    if (apiPeel?.sha) return done(apiPeel.sha);
    const why = apiPeel?.error ? `API：${String(apiPeel.error).split('\n')[0]}` : 'peel 不可用';
    return {
      ...base,
      actual: `${LABEL_UNREACHABLE}：${TAG_PEEL_UNKNOWN}（${why}；远端未 peel SHA ${shortSha(unpeeled.sha)} 与本地提交 ${shortSha(localTag)} 不同，不拿 tag 对象做比较）`,
      status: STATUS.UNREACHABLE,
      ok: false,
    };
  }
  if (unpeeled?.error) {
    return { ...base, actual: readFailureDetail(unpeeled.error), status: STATUS.UNREACHABLE, ok: false };
  }
  if (peeled?.error) {
    return { ...base, actual: readFailureDetail(peeled.error), status: STATUS.UNREACHABLE, ok: false };
  }
  return { ...base, actual: `远端无 tag ${tag}`, status: STATUS.MISMATCH, ok: false };
}

/**
 * 有界重试：**只对 unreachable 重试**（指数退避），mismatch / ok 立即返回。
 * 返回 `{result, attempts}`；attempts 是真实调用次数，供单测用桩计数。
 * @param {() => Promise<{status: string}>} task
 * @param {{retries?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<any>, onRetry?: (info: {attempt: number, delay: number, error?: string}) => void}} [opts]
 */
export async function withRetry(task, { retries = DEFAULT_RETRY, baseDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry } = {}) {
  const maxRetries = Number.isFinite(retries) && retries >= 0 ? Math.floor(retries) : DEFAULT_RETRY;
  let attempts = 0;
  let result;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    attempts += 1;
    result = await task(attempts);
    if (result.status !== STATUS.UNREACHABLE) return { result, attempts };
    if (attempt < maxRetries) {
      const delay = baseDelayMs * 2 ** attempt;
      if (typeof onRetry === 'function') onRetry({ attempt: attempt + 1, delay, error: result.actual || result.error });
      await sleep(delay);
    }
  }
  return { result, attempts };
}

/** 逐项输出行（保持旧格式：`  ✓ GitHub/main  b2516996`）。 */
export function formatCheckLine(check, show = shortSha) {
  const c = normalizeCheck(check);
  const mark = c.status === STATUS.OK ? (c.warn ? '⚠' : '✓') : c.status === STATUS.UNREACHABLE ? '?' : '✗';
  const detail = `${c.platform}/${c.item}`.padEnd(22);
  const tail = c.status === STATUS.OK ? show(c.actual) : `期望 ${show(c.expected)}，实得 ${show(c.actual)}`;
  return `  ${mark} ${detail} ${tail}`;
}

/**
 * 汇总文案（纯函数）：stdout 放正常/成功，stderr 放问题。
 * **成功行与旧版逐字一致**（发版脚本靠 grep 它）。unreachable 的文案必须出现
 * 「不是发布失败」与重试建议。
 */
export function formatSummary(classified, meta = {}) {
  const out = [];
  const err = [];
  const retry = Number.isFinite(meta.retry) ? meta.retry : DEFAULT_RETRY;
  const timeoutMs = Number.isFinite(meta.timeoutMs) ? meta.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (classified.warnings.length) out.push(`⚠ ${classified.warnings.length} 项需人工确认（如 npm latest 指向别的版本）`);
  if (classified.mismatches.length) {
    err.push(`✗ 四平台未对齐：${classified.mismatches.length} 项缺失/不一致——**这不算发布完成**`);
    for (const b of classified.mismatches) err.push(`   - ${b.platform}/${b.item}：期望 ${b.expected}，实得 ${b.actual}`);
  }
  if (classified.unreachable.length) {
    err.push(`✗ 取不到（网络/服务不可达）：${classified.unreachable.length} 项——这不是发布失败，请重试`);
    for (const b of classified.unreachable) err.push(`   - ${b.platform}/${b.item}：期望 ${b.expected}，实得 ${b.actual}`);
    err.push(
      `   建议：稍等几秒后重跑 node scripts/verify-release.mjs ${meta.version || '<版本>'}；` +
        `脚本已对 unreachable 自动重试 ${retry} 次（--retry 可加大，--timeout-ms 当前 ${timeoutMs}ms）；` +
        '仍失败请检查网络/DNS 与 API 限流——**不要回滚，也不要跳过这一步**。'
    );
  }
  if (!classified.mismatches.length && !classified.unreachable.length) out.push(SUCCESS_LINE);
  return { out, err };
}

// ---------------------------------------------------------------------------
// 薄 I/O 层：git ls-remote / fetch。所有判定都交回上面的纯函数。
// ---------------------------------------------------------------------------

/** 本地 ref 的提交 SHA。用 `^{commit}` 是刻意的：轻量/annotated tag 都归一到提交，绝不留 tag 对象。 */
function localSha(rev) {
  try {
    return execFileSync('git', ['rev-parse', rev], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** 匿名 ls-remote：不依赖本地 remote 配置（换机器/新克隆也能跑）。单次有界超时，重试由 withRetry 统一做。 */
export function readGitRef(url, ref, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const out = execFileSync('git', ['ls-remote', url, ref], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = out.trim().split('\n')[0] || '';
    const sha = line.split(/\s+/)[0] || null;
    // 读到了但为空 = 这个 ref 在远端确实不存在（不是网络问题）
    return { sha, error: null };
  } catch (e) {
    return { sha: null, error: String(e?.message || e).split('\n')[0] || 'git ls-remote 失败' };
  }
}

/** 读取 + 自动重试（只在 unreachable 时）。 */
async function readWithRetry(url, ref, { timeoutMs, retryOpts }) {
  const { result, attempts } = await withRetry(async () => {
    const read = readGitRef(url, ref, { timeoutMs });
    const status = read.sha ? STATUS.OK : read.error ? STATUS.UNREACHABLE : STATUS.MISMATCH;
    return { ...read, status };
  }, retryOpts);
  return { ...result, attempts };
}

export async function fetchJson(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    const r = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, body: await r.json() };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  }
}

function httpTaskStatus(result) {
  if (result.ok) return STATUS.OK;
  return isUnreachableHttp(result.status) ? STATUS.UNREACHABLE : STATUS.MISMATCH;
}

/**
 * peel 的 API 兜底：GitHub `git/ref/tags/<tag>` → `git/tags/<sha>`。
 * **只有能证明是同一个 tag 对象时才借用**：API 返回的 object.sha 必须等于目标平台
 * 未 peel 的 SHA；否则可能拿别的仓库/旧 tag 的提交来"证明一致"，那是假绿。
 * @returns {Promise<{sha: string|null, error: string|null, status: string}>}
 */
async function resolveTagPeelViaApi(tag, unpeeledSha, { timeoutMs, retryOpts }) {
  const headers = token.github ? { Authorization: `Bearer ${token.github}` } : {};
  const { result } = await withRetry(async () => {
    const refRes = await fetchJson(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/ref/tags/${encodeURIComponent(tag)}?ts=${Date.now()}`, {
      headers,
      timeoutMs,
    });
    if (!refRes.ok) return { sha: null, error: httpFailureDetail(refRes), status: STATUS.UNREACHABLE };
    const obj = refRes.body?.object;
    if (!obj || typeof obj !== 'object') return { sha: null, error: 'GitHub API 未返回 tag 对象', status: STATUS.UNREACHABLE };
    if (obj.type === 'commit') {
      // 轻量 tag：API 直接给提交。若与目标平台未 peel 的 SHA 不同，说明不是同一个 ref，不能借用。
      if (unpeeledSha && obj.sha !== unpeeledSha) {
        return { sha: null, error: `GitHub 的 tag 提交与目标平台未 peel SHA 不同（${shortSha(obj.sha)} ≠ ${shortSha(unpeeledSha)}）`, status: STATUS.UNREACHABLE };
      }
      return { sha: obj.sha, error: null, status: STATUS.OK };
    }
    if (obj.type !== 'tag') {
      return { sha: null, error: `tag 解析到 ${obj.type}，不是提交`, status: STATUS.UNREACHABLE };
    }
    if (unpeeledSha && obj.sha !== unpeeledSha) {
      return { sha: null, error: `tag 对象与目标平台不一致（${shortSha(obj.sha)} ≠ ${shortSha(unpeeledSha)}），无法安全借用`, status: STATUS.UNREACHABLE };
    }
    const tagRes = await fetchJson(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/tags/${obj.sha}?ts=${Date.now()}`, { headers, timeoutMs });
    if (!tagRes.ok) return { sha: null, error: `git/tags/${shortSha(obj.sha)}：${httpFailureDetail(tagRes)}`, status: STATUS.UNREACHABLE };
    const target = tagRes.body?.object;
    if (!target || target.type !== 'commit') {
      return { sha: null, error: `tag 对象未指向提交（${target?.type || '未知'}）`, status: STATUS.UNREACHABLE };
    }
    return { sha: target.sha, error: null, status: STATUS.OK };
  }, retryOpts);
  return result;
}

async function checkGitHosts({ version, timeoutMs, retryOpts }) {
  const tag = `v${version}`;
  const localMain = localSha('main^{commit}') || localSha('main');
  const localTag = localSha(`${tag}^{commit}`);
  const checks = [];
  // 本地都没有这个 tag 时不能只显示「（取不到）」（两端都取不到就分不清是谁的问题），
  // 直接点明「本地没有 vX.Y.Z」——这通常意味着版本号填错或该 tag 还没打。
  if (!localTag) {
    for (const name of Object.keys(GIT_URLS)) {
      checks.push({
        platform: name,
        item: `tag ${tag}`,
        expected: '本地应存在该 tag',
        actual: `本地没有 ${tag}`,
        status: STATUS.MISMATCH,
        ok: false,
      });
    }
  }
  for (const [name, url] of Object.entries(GIT_URLS)) {
    const mainRead = await readWithRetry(url, 'refs/heads/main', { timeoutMs, retryOpts });
    checks.push(makeMainCheck({ platform: name, localMain, read: mainRead }));

    if (!localTag) continue;
    const peeled = await readWithRetry(url, `refs/tags/${tag}^{}`, { timeoutMs, retryOpts });
    let unpeeled;
    let apiPeel = null;
    if (!peeled.sha) {
      unpeeled = await readWithRetry(url, `refs/tags/${tag}`, { timeoutMs, retryOpts });
      // 未 peel 的 SHA 与本地提交不同 → 可能是 tag 对象；只有这时才值得问 API。
      if (unpeeled.sha && unpeeled.sha !== localTag) {
        apiPeel = await resolveTagPeelViaApi(tag, unpeeled.sha, { timeoutMs, retryOpts });
      }
    }
    checks.push(makeTagCheck({ platform: name, tag, localTag, peeled, unpeeled, apiPeel }));
  }
  return checks;
}

async function checkReleases({ version, timeoutMs, retryOpts }) {
  const tag = `v${version}`;
  const checks = [];

  // GitHub
  // v0.6.6 实战教训：`releases/tags/<tag>` 会被 GitHub 的 CDN **缓存住**——Release 刚由 desktop
  // 工作流创建、附件已上传（`releases/<id>/assets` 能列出全部）时，这个端点仍可能返回创建瞬间的
  // 空 `assets`。而本脚本正是"防半发布"的最后一道闸：它若把"15 个附件"读成"0 个"，
  // 就会把一个**无法收割/无法下载**的 Release 报成 ✓（本次实测就是这样）。
  // 现在：加 cache-buster；附件为空时按 id 直连 assets 端点复核；复核后仍为空则判**失败**。
  const ghHeaders = token.github ? { Authorization: `Bearer ${token.github}` } : {};
  const ghTask = async () => {
    const gh = await fetchJson(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/tags/${tag}?ts=${Date.now()}`, { headers: ghHeaders, timeoutMs });
    if (!gh.ok) {
      return {
        platform: 'GitHub',
        item: 'Release',
        expected: '存在且带安装包附件',
        actual: httpFailureDetail(gh),
        status: httpTaskStatus(gh),
        ok: false,
      };
    }
    const ghExists = gh.body && typeof gh.body === 'object' && Boolean(gh.body.tag_name);
    if (!ghExists) {
      return { platform: 'GitHub', item: 'Release', expected: '存在且带安装包附件', actual: '不存在（HTTP 200 但无 tag_name）', status: STATUS.MISMATCH, ok: false };
    }
    let ghAssets = (gh.body.assets || []).length;
    if (ghAssets === 0 && gh.body.id) {
      const alt = await fetchJson(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/releases/${gh.body.id}/assets?per_page=100&ts=${Date.now()}`, {
        headers: ghHeaders,
        timeoutMs,
      });
      if (!alt.ok) {
        return { platform: 'GitHub', item: 'Release', expected: '存在且带安装包附件', actual: httpFailureDetail(alt), status: httpTaskStatus(alt), ok: false };
      }
      if (Array.isArray(alt.body)) ghAssets = alt.body.length;
    }
    // 0 个附件＝下载页与官网收割都会失败（Gitee/GitCode 按政策不附附件，故只对 GitHub 判）
    return {
      platform: 'GitHub',
      item: 'Release',
      expected: '存在且带安装包附件',
      actual: `存在（附件 ${ghAssets} 个）${ghAssets === 0 ? ' ← 附件为空：无法收割/下载' : ''}`,
      status: ghAssets > 0 ? STATUS.OK : STATUS.MISMATCH,
      ok: ghAssets > 0,
    };
  };
  checks.push((await withRetry(ghTask, retryOpts)).result);

  // Gitee（token 走 query）
  const giteeQ = token.gitee ? `?access_token=${token.gitee}` : '';
  const giteeTask = async () => {
    const ge = await fetchJson(`https://gitee.com/api/v5/repos/${REPO.owner}/${REPO.name}/releases/tags/${tag}${giteeQ}`, { timeoutMs });
    // ⚠ Gitee 对「不存在的 Release」返回 HTTP 200 + **null 体**（实测），
    // 只看 r.ok 会把「没有发布」判成「已发布」——必须同时判 body 是否为对象。
    if (!ge.ok) {
      return { platform: 'Gitee', item: 'Release', expected: '存在', actual: httpFailureDetail(ge), status: httpTaskStatus(ge), ok: false };
    }
    const geExists = ge.body && typeof ge.body === 'object' && Boolean(ge.body.id);
    return {
      platform: 'Gitee',
      item: 'Release',
      expected: '存在',
      actual: geExists ? `存在（${String(ge.body?.name || '').slice(0, 24)}）` : '不存在（HTTP 200 + null）',
      status: geExists ? STATUS.OK : STATUS.MISMATCH,
      ok: geExists,
    };
  };
  checks.push((await withRetry(giteeTask, retryOpts)).result);

  // GitCode
  const gcHeaders = token.gitcode ? { 'private-token': token.gitcode } : {};
  const gitcodeTask = async () => {
    const gc = await fetchJson(`https://api.gitcode.com/api/v5/repos/${REPO.owner}/${REPO.name}/releases/${tag}`, { headers: gcHeaders, timeoutMs });
    if (!gc.ok) {
      return { platform: 'GitCode', item: 'Release', expected: '存在', actual: httpFailureDetail(gc), status: httpTaskStatus(gc), ok: false };
    }
    const gcExists = gc.body && typeof gc.body === 'object' && Boolean(gc.body.tag_name || gc.body.id);
    return {
      platform: 'GitCode',
      item: 'Release',
      expected: '存在',
      actual: gcExists ? `存在（${String(gc.body?.name || '').slice(0, 24)}）` : '不存在（200 但无 tag_name）',
      status: gcExists ? STATUS.OK : STATUS.MISMATCH,
      ok: gcExists,
    };
  };
  checks.push((await withRetry(gitcodeTask, retryOpts)).result);

  return checks;
}

async function checkNpm({ version, timeoutMs, retryOpts }) {
  const { result } = await withRetry(async () => {
    const r = await fetchJson(`https://registry.npmjs.org/${NPM_PKG}`, { timeoutMs });
    return { r, status: httpTaskStatus(r) };
  }, retryOpts);
  const V = version;
  if (result.status !== STATUS.OK) {
    const actual = result.r?.error ? readFailureDetail(result.r.error) : `registry HTTP ${result.r?.status ?? '?'}`;
    return [
      { platform: 'npm', item: `已发布 ${V}`, expected: '是', actual, status: result.status, ok: false },
      { platform: 'npm', item: 'dist-tags.latest', expected: V, actual, status: result.status, ok: false },
    ];
  }
  const versions = Object.keys(result.r.body?.versions || {});
  const published = versions.includes(V);
  const latest = (result.r.body?.['dist-tags'] || {}).latest || '';
  return [
    {
      platform: 'npm',
      item: `已发布 ${V}`,
      expected: '是',
      actual: published ? '是' : `否（现有 ${versions.slice(-3).join(', ')}…）`,
      status: published ? STATUS.OK : STATUS.MISMATCH,
      ok: published,
    },
    // 回填版会用 --tag backfill 发布，latest 不一定指向它 —— 只警告不判失败
    {
      platform: 'npm',
      item: 'dist-tags.latest',
      expected: `${V}（回填版可为其他）`,
      actual: latest,
      status: STATUS.OK,
      ok: true,
      warn: latest !== V,
    },
  ];
}

// ---------------------------------------------------------------------------
// CLI 入口（仅直接执行时）：薄编排 + 输出/退出码。
// ---------------------------------------------------------------------------

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const opts = parseArgs(process.argv.slice(2), pkg.version);
  const V = opts.version;
  const retryOpts = { retries: opts.retry };
  const ctx = { version: V, timeoutMs: opts.timeoutMs, retryOpts };

  const checks = [...(await checkGitHosts(ctx)), ...(await checkReleases(ctx)), ...(await checkNpm(ctx))];
  const classified = classifyChecks(checks);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version: V,
          exitCode: classified.exitCode,
          status: classified.exitCode === EXIT.OK ? STATUS.OK : classified.mismatches.length ? STATUS.MISMATCH : STATUS.UNREACHABLE,
          checks: classified.checks,
          mismatches: classified.mismatches,
          unreachable: classified.unreachable,
        },
        null,
        2
      )
    );
    process.exit(classified.exitCode);
  }

  console.log(`四平台发布一致性校验（版本 ${V}，仓库 ${REPO.owner}/${REPO.name}）\n`);
  for (const c of classified.checks) console.log(formatCheckLine(c));
  console.log('');
  const summary = formatSummary(classified, { version: V, retry: opts.retry, timeoutMs: opts.timeoutMs });
  for (const line of summary.out) console.log(line);
  for (const line of summary.err) console.error(line);
  process.exit(classified.exitCode);
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error(`${LABEL_UNREACHABLE}：校验脚本自身异常——${String(e?.stack || e)}`);
    console.error('这不是发布失败，请重试；若持续出现请把上面的堆栈贴给维护者。');
    process.exit(EXIT.UNREACHABLE);
  });
}
