// 批十二（v0.6.7 出网单一口径）的变异验证：把每处修复逐个改回缺陷，§126 的断言必须当场失败。
// 先复现 → 再修 → 断言 → **把修复改回去看断言是否真的抓得住**。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('126');

// ① C-1/P1：fetch 工具退回"自校验 DNS + 自 fetch"（fail-open + 不钉 IP）——本批的主缺陷形态
M.mutate({
  name: '① fetch 工具退回自实现的弱 SSRF（DNS catch 放行）',
  file: 'src/ssrf-guard.js',
  from: '  } catch {\n    return {\n      blocked: true,\n      reason: `域名解析失败（${h}）——已按 fail-closed 拒绝本次请求（SSRF 防护不会因解析异常而放行）。`,',
  to: '  } catch {\n    return {\n      blocked: false,\n      reason: "",',
  expect: ['fail-closed'],
  run: SEC,
});

// ② H-1：zone-id / 无法解析的 IPv6 退回 fail-open（return false）
M.mutate({
  name: '② isPrivateHost：zone-id 与解析不出的 IPv6 退回 fail-open',
  file: 'src/ssrf-guard.js',
  from: "  if (h.includes('%')) return true; // zone-id：无法安全判定 → 当私有（fail-closed）",
  to: "  if (h.includes('%')) return false;",
  expect: ['zone-id'],
  run: SEC,
});
M.mutate({
  name: '②b isPrivateHost：无法解析的 IPv6 退回放行',
  file: 'src/ssrf-guard.js',
  from: '    if (!g) return true; // 解析不了：按私有处理（此前 return false = 放行）',
  to: '    if (!g) return false;',
  expect: ['无法解析的 IPv6'],
  run: SEC,
});

// ③ 钉扎：判定不再回传 pinned（连接层于是会自己再解析一次 → rebinding 窗口重开）
M.mutate({
  name: '③ 判定层不再回传钉扎地址（pinned）',
  file: 'src/ssrf-guard.js',
  from: '  return { blocked: false, reason: \'\', pinned, kind: \'dns\' };',
  to: '  return { blocked: false, reason: \'\', pinned: null, kind: \'dns\' };',
  expect: ['钉扎'],
  run: SEC,
});

// ④ M1：safe-fetch 不再过出网闸门（config.net 的自证盲区重开）
M.mutate({
  name: '④ safe-fetch 不过出网闸门（报告三 M1 的盲区）',
  file: 'src/safe-fetch.js',
  from: '      const gate = guardEgress(cur.href);',
  to: '      const gate = { blocked: false, message: \'\' };',
  expect: ['必须被拦'],
  run: SEC,
});

// ⑤ P2-3：net-guard 退回"有 init 就整体覆盖"（Request 的 method/body/headers 丢失 → 空 GET）
M.mutate({
  name: '⑤ net-guard 对 fetch(Request, init) 丢失 Request 语义（退回空 GET）',
  file: 'src/net-guard.js',
  from: '      if (isRequestInput) {',
  to: '      if (false && isRequestInput) {',
  expect: ['Request+init', 'body 不能丢'],
  run: SEC,
});

// ⑥ M-4：跨源头裁剪退回黑名单（x-api-key 这类自定义凭据头会泄漏给重定向目标）
M.mutate({
  name: '⑥ 跨源头裁剪退回黑名单（只删 authorization/cookie 三个）',
  file: 'src/net-guard.js',
  from: "    if (CROSS_ORIGIN_KEEP_HEADERS.has(String(k).toLowerCase())) keep.push([k, v]);",
  to: "    if (!['authorization', 'cookie', 'proxy-authorization'].includes(String(k).toLowerCase())) keep.push([k, v]);",
  expect: ['x-api-key 不得跨 origin 保留'],
  run: SEC,
});

// ⑦ 结构守卫：把 DNS 判定偷偷复制回 fetch 工具（第二份实现）必须被 §126⑧ 抓到
M.mutate({
  name: '⑦ 在 fetch 工具里塞回第二份 DNS 判定（结构守卫必须抓到）',
  file: 'src/tools/fetch.js',
  from: "export { isPrivateHost, isMetadataHost };",
  to: "export { isPrivateHost, isMetadataHost };\nconst _secondImpl = async (u) => { const a = await lookup(u); return await fetch(u); };",
  expect: ['DNS 解析只允许在 ssrf-guard.js', '不得自己再解析 DNS', '第二份 SSRF 实现'],
  run: SEC,
});

if (!M.report()) process.exit(1);
