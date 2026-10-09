// 批三十（v0.6.13 探针误报：真机 10:13:58 判"不可达"、同一回合首帧 8.7s 正常跑）
// 的变异验证。修复形状是"一条分类判据 + 一处超时口径 + 一处保鲜期 + 一条降级纪律"，
// 所以变异逐条打在这四点上（全部指向 §141）：
//
// 真机证据（~/.mingdao/logs/web-server.log）：
//   :413 07:03:02 `预检 mtplx-… unreachable`（进程启动时引擎没起来 → 结论被存进**没有 TTL** 的进程内备忘）；
//   :799 10:13:58.900 `chat 预检 tf91d8ab0ddfec0bd unreachable ❌ 不可达：fetch failed（本地引擎没起来？先确认端口/进程）`
//        —— 距 `chat 开始`(:798 .877) 只 23ms、且没有 `预检 <模型>` 行（没重测，直接念旧结论），
//        而引擎自 07:08:59 起可用、本回合首帧 8.7s（:803）跑了 21 分钟（:844）。用户照这句话去重启了引擎。
//
// 变异清单（每条都要让 §141 当场红，关键词取断言原文）：
//   ① 失败原因退化成"一律不可达"（连接被拒不再单独成类）      → §141 必须红；
//   ② 超时与连接被拒混为一谈                                  → §141 必须红；
//   ③ ensureProbe 不再吞异常（探针失败直接抛给回合 = 阻断）    → §141 必须红；
//   ④ 回合级预检的 try/catch 拿掉（chat 预检失败阻断回合）      → §141 必须红；
//   ⑤ 失败文案不再写"预检失败不阻断本回合"（降级语义不可见）    → §141 必须红；
//   ⑥ 失败结论按成功 TTL 长期复用（7 小时前的结论照样念）       → §141 必须红；
//   ⑦ 三次尝试背靠背（去掉退避：引擎"正在启动"被误判不可达）    → §141 必须红；
//   ⑧ 首帧超时在 body 读取阶段被吞掉（超时不再覆盖首帧）        → §141 必须红；
//   ⑨ HTTP 404 不再单独分类（退回"工具调用未能判定"）           → §141 必须红；
//   ⑩ 探针改打 /models（换掉 chat 路径 → "只实现 chat 的端点"被探针打扰）→ §141 必须红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('141');

M.mutate({
  name: '① 失败原因退化成"一律不可达"（连接被拒不再单独成类 → 真机那条文案）',
  file: 'src/model-discovery.js',
  from: `  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return { kind: 'refused', detail: 'ECONNREFUSED', label: '连接被拒（端口没人监听）', hint: '本地引擎没起来/端口不对：先确认端口与进程。' };
  }`,
  to: `  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(msg)) {
    return { kind: 'other', detail: 'fetch failed', label: '不可达', hint: '本地引擎没起来？先确认端口/进程' };
  }`,
  expect: ['ECONNREFUSED 必须判为"连接被拒"', '必须把"连接被拒"单独判出来（reason=refused）'],
  run: SEC,
});

M.mutate({
  name: '② 超时与"连接被拒"混为一谈（端口通、只是没等到首帧）',
  file: 'src/model-discovery.js',
  from: `    return { kind: 'timeout', detail: code || 'timeout', label: '超时', hint: '端口是通的，但没在探针上限内等到首帧：引擎在 prefill，或**正在启动**——不代表主请求会失败。' };`,
  to: `    return { kind: 'refused', detail: code || 'timeout', label: '连接被拒（端口没人监听）', hint: '本地引擎没起来/端口不对：先确认端口与进程。' };`,
  expect: ['探针自己的首帧超时必须判为 timeout', '首帧超过探针上限必须判为"超时"'],
  run: SEC,
});

M.mutate({
  name: '③ ensureProbe 不再吞异常（探针失败直接抛给回合 = 阻断回合发起）',
  file: 'src/web/server.js',
  from: `    } catch (/** @type {any} */ e) {
      srvlog(\`预检 \${m} 失败（忽略，按默认超时继续）：\${String(e?.message || e)}\`);
    }`,
  to: `    } catch (/** @type {any} */ e) {
      throw e;
    }`,
  expect: ['ensureProbe 必须**吞掉**探针异常'],
  run: SEC,
});

M.mutate({
  name: '④ 回合级预检的 try/catch 拿掉（chat 预检一失败就中断本回合）',
  file: 'src/web/server.js',
  from: `      } catch (/** @type {any} */ e) {
        // 预检失败**不得**影响本回合发起（"尽力而为：失败只降级不阻断"）——这里只留一行日志。
        srvlog(\`chat 预检失败（忽略，按既有默认继续） \${taskId} \${String(e?.message || e)}\`);
      }`,
  to: `      } catch (/** @type {any} */ e) {
        throw e;
      }`,
  expect: ['回合级预检必须自带 try/catch（失败只降级，不得中断本回合发起）'],
  run: SEC,
});

M.mutate({
  name: '⑤ 失败文案不再写"预检失败不阻断本回合"（降级语义从用户可见处消失）',
  file: 'src/model-discovery.js',
  from: `  return \`\${head}——\${hint}（探针：\${tries} 次尝试 × \${attemptSec}s、含退避；**预检是尽力而为，失败只降级、不阻断本回合**）\`;`,
  to: `  return \`\${head}——\${hint}\`;`,
  expect: ['失败文案必须写明"预检失败不阻断本回合"'],
  run: SEC,
});

M.mutate({
  name: '⑥ 失败结论按成功 TTL 长期复用（7 小时前的"不可达"照样念给用户）',
  file: 'src/model-discovery.js',
  from: `  const ttl = probeVerdictFailed(memo.value) ? PROBE_FAIL_TTL_MS : PROBE_TTL_MS;`,
  to: `  const ttl = PROBE_TTL_MS;`,
  expect: ['真机根因：7 小时前的"不可达"结论**不得**再复用', '失败结论只能保鲜'],
  run: SEC,
});

M.mutate({
  name: '⑦ 三次尝试背靠背（去掉退避 → 引擎"正在启动"被误判不可达）',
  file: 'src/model-discovery.js',
  from: `      if (i > 0) {
        const backoff = PROBE_BACKOFF_MS[Math.min(i - 1, PROBE_BACKOFF_MS.length - 1)];
        if (left() > backoff) await new Promise((r) => setTimeout(r, backoff));
      }`,
  to: `      if (false) { /* 变异：去掉退避 */ }`,
  expect: ['引擎"正在启动"不得被误判不可达', '必须真的退避等到端口起来'],
  run: SEC,
});

M.mutate({
  name: '⑧ 首帧超时在 body 读取阶段被吞掉（超时不再覆盖首帧，回到"回了头就一直挂着"）',
  file: 'src/model-discovery.js',
  from: `    if (timeoutErr && (e === timeoutErr || e?.probeTimeout === true)) throw timeoutErr;`,
  to: `    if (false) throw timeoutErr; /* 变异：吞掉首帧超时 */`,
  expect: ['首帧超过探针上限必须判为', '回了头、卡在 prefill', '必须在时间预算内返回（首帧超时必须覆盖 body 读取）'],
  run: SEC,
});

M.mutate({
  name: '⑨ HTTP 404 不再单独分类（退回"工具调用未能判定（多为被 max_tokens 截断）"）',
  file: 'src/model-discovery.js',
  from: `  if (s === 404 || s === 405 || s === 501) {`,
  to: `  if (false) {`,
  expect: ['404 必须判为"端点未实现该探针请求"', 'POST 404 必须单独判出来（端点未实现该探针请求）'],
  run: SEC,
});

M.mutate({
  name: '⑩ 探针改打 /models（换掉 chat 路径——只实现 chat 的端点被探针打扰，真机踩过的形态）',
  file: 'src/model-discovery.js',
  from: `        opened = await open(
          \`\${base}/chat/completions\`,
          {
            method: 'POST',`,
  to: `        opened = await open(
          \`\${base}/models\`,
          {
            method: 'POST',`,
  expect: ['只实现 chat 的端点必须判为可用', '只实现 chat 的端点：探针一个 GET 都不该发'],
  run: SEC,
});

if (!M.report()) process.exit(1);
