// `scripts/verify-release.mjs` 的三态分类单测（v0.6.26 §3.95）。
//
// 为什么单独一套：这条脚本是发版收尾的**最后一道闸**，而它自己刚从两次误报里出来：
// ① v0.6.24 把一次 `git ls-remote` 超时渲染成「四平台未对齐」（exit 1），负责人据差点误判发布坏了；
// ② peel 失败后回退比较未 peel 的 tag 对象（`d2788e96`），与 main 的提交比较必然不等 → 假失败。
// 本套件不连网、不起服务：只 import 脚本导出的纯函数，用桩计数钉住
// 「mismatch 不重试 / unreachable 才重试 / 超时归 unreachable / peel 失败不回退比较」。
//
// 运行：node test/verify-release.js
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(pathToFileURL(path.join(root, 'scripts', 'verify-release.mjs')).href);
const { STATUS, EXIT, SUCCESS_LINE, classifyChecks, formatSummary, makeMainCheck, makeTagCheck, withRetry, parseArgs, isTimeoutError, isUnreachableError, isUnreachableHttp } = M;

let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ 校验[${name}]`);
};

const A = 'b25169968d618811f83d531327ad5ca62c262f33';
const B = 'd2788e96aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const C = '1696b02fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** 全绿基线：三平台 main/tag 同 SHA + Release 齐备 + npm 已发。 */
const greenChecks = () => [
  { platform: 'GitHub', item: 'main', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'GitHub', item: 'tag v0.6.26', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'Gitee', item: 'main', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'Gitee', item: 'tag v0.6.26', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'GitCode', item: 'main', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'GitCode', item: 'tag v0.6.26', expected: A, actual: A, status: STATUS.OK, ok: true },
  { platform: 'GitHub', item: 'Release', expected: '存在且带安装包附件', actual: '存在（附件 14 个）', status: STATUS.OK, ok: true },
  { platform: 'Gitee', item: 'Release', expected: '存在', actual: '存在（v0.6.26）', status: STATUS.OK, ok: true },
  { platform: 'GitCode', item: 'Release', expected: '存在', actual: '存在（v0.6.26）', status: STATUS.OK, ok: true },
  { platform: 'npm', item: '已发布 0.6.26', expected: '是', actual: '是', status: STATUS.OK, ok: true },
  { platform: 'npm', item: 'dist-tags.latest', expected: '0.6.26（回填版可为其他）', actual: '0.6.26', status: STATUS.OK, ok: true, warn: false },
];

// —— ① 全绿 → 0，成功文案必须与旧版逐字一致 ——
{
  const c = classifyChecks(greenChecks());
  assert.equal(c.exitCode, EXIT.OK, '全绿必须 exit 0');
  assert.equal(c.mismatches.length, 0, '全绿不应有 mismatch');
  assert.equal(c.unreachable.length, 0, '全绿不应有 unreachable');
  const s = formatSummary(c, { version: '0.6.26', retry: 2, timeoutMs: 20000 });
  assert.ok(s.out.includes(SUCCESS_LINE), `成功输出必须保持「${SUCCESS_LINE}」（发版脚本靠 grep 它）`);
  assert.equal(s.err.length, 0, '全绿不应写 stderr');
  ok('① 全绿 → exit 0，成功文案保持 ✓ 四平台一致…');
}

// —— ② 一个 mismatch → 1（是真的不一致，不是网络） ——
{
  const bad = greenChecks();
  bad[1] = { ...bad[1], actual: C, status: STATUS.MISMATCH, ok: false };
  const c = classifyChecks(bad);
  assert.equal(c.exitCode, EXIT.MISMATCH, '一个 mismatch 必须 exit 1');
  assert.equal(c.mismatches.length, 1, 'mismatch 必须计数 1');
  assert.equal(c.unreachable.length, 0, 'mismatch 不得混入 unreachable');
  const text = formatSummary(c, { version: '0.6.26' }).err.join('\n');
  assert.ok(text.includes('四平台未对齐'), 'mismatch 文案必须说「不一致/未对齐」');
  assert.ok(text.includes('这不算发布完成'), 'mismatch 必须明确「这不算发布完成」');
  assert.ok(!text.includes('不是发布失败'), 'mismatch 不得被说成「不是发布失败」');
  ok('② 一个 mismatch → exit 1（文案「不一致、不算发布完成」）');
}

// —— ③ 一个 unreachable → 2，文案必须说「不是发布失败」并给重试建议 ——
{
  const net = greenChecks();
  net[0] = {
    platform: 'GitHub',
    item: 'main',
    expected: A,
    actual: '取不到（网络/服务不可达）：spawnSync git ETIMEDOUT',
    status: STATUS.UNREACHABLE,
    ok: false,
  };
  const c = classifyChecks(net);
  assert.equal(c.exitCode, EXIT.UNREACHABLE, '一个 unreachable 必须 exit 2（不是 1）');
  assert.equal(c.unreachable.length, 1, 'unreachable 必须计数 1');
  assert.equal(c.mismatches.length, 0, 'unreachable 不得混入 mismatch');
  const text = formatSummary(c, { version: '0.6.26', retry: 2, timeoutMs: 20000 }).err.join('\n');
  assert.ok(text.includes('不是发布失败'), 'unreachable 文案必须写明「不是发布失败」');
  assert.ok(text.includes('重试'), 'unreachable 文案必须给出重试建议');
  assert.ok(!text.includes('四平台未对齐'), 'unreachable 不得被渲染成「未对齐」');
  ok('③ 一个 unreachable → exit 2，文案含「不是发布失败」与重试建议');
}

// —— ④ peel 失败 → 2，绝不回退比较 tag 对象 ——
{
  // 正常 peeled：按提交比，同 → ok
  const peeledOk = makeTagCheck({ platform: 'GitHub', tag: 'v0.6.26', localTag: A, peeled: { sha: A, error: null } });
  assert.equal(peeledOk.status, STATUS.OK, 'peeled SHA 相同应 ok');

  // peel 拿不到、未 peel 得到 tag 对象 B：不得判 mismatch，必须 unreachable
  const peelFail = makeTagCheck({
    platform: 'Gitee',
    tag: 'v0.6.26',
    localTag: A,
    peeled: { sha: null, error: null },
    unpeeled: { sha: B, error: null },
  });
  assert.equal(peelFail.status, STATUS.UNREACHABLE, 'peel 失败必须按 unreachable（exit 2），不得回退比较 tag 对象');
  assert.notEqual(peelFail.status, STATUS.MISMATCH, 'peel 失败不得产生「不一致」（tag 对象 ≠ 提交是必然的，不是发布问题）');
  assert.ok(String(peelFail.actual).includes('无法确定 tag 指向的提交'), 'peel 失败文案必须说明「无法确定 tag 指向的提交」');
  assert.notEqual(String(peelFail.actual), B, '不得把未 peel 的 tag 对象当作实得 SHA 去比较');
  const cPeel = classifyChecks([peelFail]);
  assert.equal(cPeel.exitCode, EXIT.UNREACHABLE, 'peel 失败必须 exit 2');
  assert.equal(cPeel.mismatches.length, 0, 'peel 失败不得产生 mismatch');

  // API 拿到 peeled 提交：按提交判断（同 → ok，不同 → 真 mismatch）
  const viaApi = makeTagCheck({ platform: 'GitHub', tag: 'v0.6.26', localTag: A, peeled: { sha: null }, unpeeled: { sha: B }, apiPeel: { sha: A } });
  assert.equal(viaApi.status, STATUS.OK, 'API 取到 peeled SHA 后应按提交比较（同 → ok）');
  const apiDiff = makeTagCheck({ platform: 'GitHub', tag: 'v0.6.26', localTag: A, peeled: { sha: null }, unpeeled: { sha: B }, apiPeel: { sha: C } });
  assert.equal(apiDiff.status, STATUS.MISMATCH, 'API 解析出的提交真的不同时，必须 exit 1');
  const apiFail = makeTagCheck({ platform: 'GitHub', tag: 'v0.6.26', localTag: A, peeled: { sha: null }, unpeeled: { sha: B }, apiPeel: { sha: null, error: 'HTTP 503' } });
  assert.equal(apiFail.status, STATUS.UNREACHABLE, 'API 也取不到时仍按 unreachable');

  // 轻量 tag：未 peel 的 SHA 恰好是提交 → ok（不算 peel 失败）
  const lightweight = makeTagCheck({ platform: 'Gitee', tag: 'v0.6.26', localTag: A, peeled: { sha: null }, unpeeled: { sha: A } });
  assert.equal(lightweight.status, STATUS.OK, '轻量 tag 的未 peel SHA 就是提交，应 ok');

  // 真·不同提交（peeled 读到且不同）仍然要能报 mismatch
  const realDiff = makeTagCheck({ platform: 'GitHub', tag: 'v0.6.26', localTag: A, peeled: { sha: C } });
  assert.equal(realDiff.status, STATUS.MISMATCH, 'peeled 提交真的不同必须 mismatch');
  ok('④ peel 失败 → exit 2（不回退比较 tag 对象；API 可取则按提交判断）');
}

// —— ⑤ --retry 只对 unreachable 生效（桩计数） ——
{
  const count = { ok: 0, mismatch: 0, unreachable: 0, flaky: 0 };
  const sleep = async () => {};
  const rOk = await withRetry(async () => {
    count.ok += 1;
    return { status: STATUS.OK };
  }, { retries: 3, baseDelayMs: 10, sleep });
  assert.equal(rOk.attempts, 1, 'ok 不允许重试');
  assert.equal(count.ok, 1, 'ok 只应调用一次');

  const rMismatch = await withRetry(async () => {
    count.mismatch += 1;
    return { status: STATUS.MISMATCH };
  }, { retries: 3, baseDelayMs: 10, sleep });
  assert.equal(rMismatch.attempts, 1, 'mismatch 不允许重试（重试只服务于网络抖动）');
  assert.equal(count.mismatch, 1, 'mismatch 只应调用一次');

  const rUnreachable = await withRetry(async () => {
    count.unreachable += 1;
    return { status: STATUS.UNREACHABLE };
  }, { retries: 2, baseDelayMs: 10, sleep });
  assert.equal(rUnreachable.attempts, 3, 'unreachable 必须按 --retry 重试（1 次初始 + 2 次重试）');
  assert.equal(count.unreachable, 3, 'unreachable 应实际调用 3 次');

  const delays = [];
  const rFlaky = await withRetry(async () => {
    count.flaky += 1;
    return count.flaky < 3 ? { status: STATUS.UNREACHABLE } : { status: STATUS.OK };
  }, { retries: 2, baseDelayMs: 100, sleep: async (ms) => delays.push(ms) });
  assert.equal(rFlaky.attempts, 3, '抖动两次后成功应共 3 次');
  assert.deepEqual(delays, [100, 200], '重试必须指数退避（100ms → 200ms）');

  assert.equal(parseArgs([], '0.6.26').retry, 2, '--retry 默认 2');
  assert.equal(parseArgs(['--retry', '5'], '0.6.26').retry, 5, '--retry N 应生效');
  assert.equal(parseArgs(['--retry=4'], '0.6.26').retry, 4, '--retry=N 也应生效');
  assert.equal(parseArgs(['--timeout-ms=1234'], '0.6.26').timeoutMs, 1234, '--timeout-ms N 应生效');
  assert.equal(parseArgs([], '0.6.26').timeoutMs, 20000, '--timeout-ms 应有默认值');
  ok('⑤ --retry 只对 unreachable 生效（mismatch/ok 不重试；指数退避）');
}

// —— ⑥ 超时归类为 unreachable（不是 mismatch） ——
{
  assert.ok(isTimeoutError({ code: 'ETIMEDOUT', message: 'spawnSync git ETIMEDOUT' }), 'ETIMEDOUT 必须识别为超时');
  assert.ok(isTimeoutError('spawnSync git ETIMEDOUT'), '字符串形式的超时也必须识别');
  assert.ok(isUnreachableError({ code: 'ETIMEDOUT' }), '超时必须归入 unreachable');
  assert.ok(isUnreachableError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' }), 'DNS 失败必须归入 unreachable');

  const timeoutMain = makeMainCheck({ platform: 'GitHub', localMain: A, read: { sha: null, error: 'spawnSync git ETIMEDOUT' } });
  assert.equal(timeoutMain.status, STATUS.UNREACHABLE, '超时必须归类为 unreachable（不是 mismatch）');
  assert.ok(String(timeoutMain.actual).includes('取不到（网络/服务不可达）'), '超时文案必须标「取不到（网络/服务不可达）」');
  assert.equal(classifyChecks([timeoutMain]).exitCode, EXIT.UNREACHABLE, '超时 → exit 2');

  assert.equal(isUnreachableHttp(0), true, 'fetch 抛错（status 0）是 unreachable');
  assert.equal(isUnreachableHttp(503), true, 'HTTP 503 是 unreachable');
  assert.equal(isUnreachableHttp(429), true, 'HTTP 429（限流）是 unreachable');
  assert.equal(isUnreachableHttp(404), false, 'HTTP 404 是「Release 缺失」，必须 mismatch');
  // 任何 git 读失败都是「取不到」：TLS/代理/凭据问题不是「远端 SHA 与本地不同」，
  // 归成 mismatch 会重复 v0.6.24 那类误报（读失败 ≠ 读到不同 SHA）。
  assert.equal(makeMainCheck({ platform: 'Gitee', localMain: A, read: { sha: null, error: 'fatal: could not read Username' } }).status, STATUS.UNREACHABLE, '任何 git 读失败（含 TLS/代理/凭据）都归 unreachable，不是 mismatch');
  ok('⑥ 超时/读失败 → unreachable/exit 2（HTTP 5xx 同；404 仍是 mismatch）');
}

console.log(`\n发布校验三态测试全部通过：${passed} 项 ✓`);
