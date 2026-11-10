// SSE 写入背压套件（v0.7.1 审计报告1 M-6 / 报告2 M-08）。
//
// 运行：node test/sse-backpressure.js（失败非 0；纯桩 res，不启动服务器、不发网络请求）。
//
// 覆盖：write 返回 false → 暂停 + 注册 drain；drain 后恢复且 streamSeq 连续；
// 写入异常显式记录并停止后续写；慢客户端积压超上限断开；帧格式/streamSeq 不变；停止后 drain 不复活。
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { createSseWriter, SSE_MAX_BUFFERED_FRAMES } = await import(pathToFileURL(path.join(srcDir, 'web', 'server.js')).href);

let passed = 0;
let failed = 0;
/**
 * @param {string} name
 * @param {() => any} fn
 */
function t(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ sse-backpressure：${name}`);
  } catch (/** @type {any} */ e) {
    failed += 1;
    console.error(`  ✗ sse-backpressure：${name} —— ${String(e?.message || e)}`);
  }
}

/** 桩 res：记录 write 次数/成功帧、drain 监听、end/destroy；write 返回值和抛错可配。 */
function makeRes(overrides = {}) {
  const state = {
    writeResult: true,
    throwOnWrite: /** @type {Error|null} */ (null),
    writeAttempts: 0,
    ended: false,
    destroyed: false,
    ...overrides,
  };
  /** @type {string[]} */
  const writes = [];
  /** @type {Function[]} */
  const drainListeners = [];
  const res = {
    writableLength: 0,
    write(/** @type {string} */ arg) {
      state.writeAttempts += 1;
      if (state.throwOnWrite) throw state.throwOnWrite;
      writes.push(arg);
      return state.writeResult;
    },
    on(/** @type {string} */ event, /** @type {Function} */ fn) {
      if (event === 'drain') drainListeners.push(fn);
      return res;
    },
    end() {
      state.ended = true;
    },
    destroy() {
      state.destroyed = true;
    },
  };
  return { res, writes, drainListeners, state };
}

/** 从 `id: <n>\ndata: <json>\n\n` 帧里解析出 data 对象。 */
const dataOf = (/** @type {string} */ frame) => JSON.parse(frame.slice(frame.indexOf('data: ') + 'data: '.length).trim());

console.log('\n[sse-backpressure · 暂停 / 恢复]');

t('① write 返回 false → 暂停后续写入并注册 drain', () => {
  const { res, writes, drainListeners, state } = makeRes({ writeResult: false });
  const send = createSseWriter(res, 't1');
  send({ type: 'a' });
  send({ type: 'b' });
  assert.equal(writes.length, 1, 'write 返回 false 后必须暂停后续写入（只写第一帧）');
  assert.equal(drainListeners.length, 1, 'write 返回 false 必须注册 drain 监听以恢复');
  assert.equal(state.writeAttempts, 1, '暂停期间不得再调用 res.write');
});

t('② drain 后恢复写入，且 streamSeq 连续不空洞', () => {
  const { res, writes, drainListeners, state } = makeRes({ writeResult: false });
  const send = createSseWriter(res, 't2');
  send({ type: 'a' }); // seq1：写出 → false → paused
  send({ type: 'b' }); // seq2：暂停期间排队
  state.writeResult = true; // 缓冲排空 → drain
  drainListeners.forEach((fn) => /** @type {Function} */ (fn)());
  assert.equal(writes.length, 2, 'drain 后必须排空积压帧并恢复写入');
  assert.equal(dataOf(writes[1]).streamSeq, 2, '暂停期间 streamSeq 仍连续（不因排队出现空洞）');
  send({ type: 'c' }); // seq3：恢复后直接写
  assert.equal(writes.length, 3, 'drain 恢复后后续帧直接写入');
  assert.equal(dataOf(writes[2]).streamSeq, 3, '恢复后 streamSeq 继续 +1');
});

console.log('\n[sse-backpressure · 异常与断开]');

t('③ 写入异常被显式记录且停止后续写入', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (/** @type {string} */ ...a) => warns.push(a.join(' '));
  const { res, state } = makeRes({ throwOnWrite: new Error('EPIPE') });
  const send = createSseWriter(res, 't3');
  try {
    send({ type: 'a' });
    send({ type: 'b' });
  } finally {
    console.warn = orig;
  }
  assert.equal(warns.length, 1, '写入异常必须显式记录（warn 一次且仅一次）');
  assert.ok(warns[0].includes('写入异常'), '写入异常日志必须点明原因（不再空 catch 吞掉）');
  assert.equal(state.writeAttempts, 1, '写入异常后必须停止后续写入（不再尝试第二次）');
  assert.equal(state.ended, true, '写入异常必须结束该连接以释放资源');
});

t('④ 慢客户端积压超上限 → 断开并停止写入', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (/** @type {string} */ ...a) => warns.push(a.join(' '));
  const { res, state } = makeRes({ writeResult: false });
  const send = createSseWriter(res, 't4');
  try {
    for (let i = 0; i < SSE_MAX_BUFFERED_FRAMES + 5; i++) send({ type: 'f', i });
  } finally {
    console.warn = orig;
  }
  assert.equal(state.ended, true, '背压超限必须断开慢客户端');
  assert.ok(warns.some((w) => w.includes('背压超限')), '背压超限必须 warn（不再静默无界缓存）');
  const before = state.writeAttempts;
  send({ type: 'after' });
  assert.equal(state.writeAttempts, before, '断开后必须停止写入');
});

console.log('\n[sse-backpressure · 帧格式 / 收尾]');

t('⑤ 帧格式与 streamSeq/taskId 逐字不变', () => {
  const { res, writes } = makeRes({ writeResult: true });
  const send = createSseWriter(res, 'taskX');
  send({ type: 'a' });
  send({ type: 'b' });
  assert.equal(writes.length, 2, '正常路径必须逐帧写出');
  assert.ok(writes[0].startsWith('id: 1\ndata: '), '帧格式必须保持 `id: <streamSeq>\\ndata: <json>\\n\\n`');
  assert.equal(dataOf(writes[0]).streamSeq, 1, '第 1 帧 streamSeq 必须为 1');
  assert.equal(dataOf(writes[0]).taskId, 'taskX', '帧内必须保留 taskId');
  assert.equal(dataOf(writes[0]).type, 'a', '帧内必须保留业务字段');
  assert.equal(dataOf(writes[1]).streamSeq, 2, '第 2 帧 streamSeq 必须为 2');
});

t('⑥ 停止后 drain 到来也不复活（不产生额外写入）', () => {
  const { res, drainListeners, state } = makeRes({ throwOnWrite: new Error('broken') });
  const send = createSseWriter(res, 't6');
  const orig = console.warn;
  console.warn = () => {};
  try {
    send({ type: 'a' }); // 抛错 → stop
  } finally {
    console.warn = orig;
  }
  const before = state.writeAttempts;
  drainListeners.forEach((fn) => /** @type {Function} */ (fn)()); // 迟到的 drain
  send({ type: 'b' });
  assert.equal(state.writeAttempts, before, '停止后的 drain 不得复活写入');
});

console.log(`\nsse-backpressure：${passed} 项通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
