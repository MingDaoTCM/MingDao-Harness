// 批三十六（v0.6.18 §3.68：P0 界面改造）的变异验证。
//
// 先复现：状态条信息散在 5 处（消息内 💭 气泡 / #workStatus / #statusBar / #costBadge / 完成后的 #hint），
// 各自刷新频率不同；错误原文被 .banner 的 textContent 折成一段；权限确认仍是 position:fixed 遮罩，
// 代码自己写着"遮罩挡住了输入区的停止按钮"（于是在弹窗里再放一个停止按钮绕道）。
// 本批把每一项修复逐个改回缺陷，test/smoke.js §148 的断言必须当场红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('148');

// ① 状态条少一个字段（六项口径退回"缺首帧"——用户又得去消息气泡里找 TTFT）
M.mutate({
  name: '① 状态条删掉 TTFT 字段（六项变五项）',
  file: 'src/web/index.html',
  from: '    <span class="rs-field" data-k="ttft">首帧 <b id="rsTtft">—</b></span>\n',
  to: '',
  expect: ['常驻状态条必须且只能有六个字段'],
  run: SEC,
});

// ② 0 次工具调用被省略（"没显示" ≠ "0 次"，用户会以为工具计数坏了）
M.mutate({
  name: '② 状态条把 0 次工具调用显示成空白',
  file: 'src/web/app.js',
  from: "function fmtRunTools(n){ const k=Math.max(0,Math.round(Number(n)||0)); return k===0 ? '0 次工具调用' : k+' 次工具调用'; }",
  to: "function fmtRunTools(n){ const k=Math.max(0,Math.round(Number(n)||0)); return k ? k+' 次工具调用' : ''; }",
  expect: ['0 次工具调用必须显式写出来'],
  run: SEC,
});

// ③ 恢复死代码：又去查根本不存在的 #liveBar（"加了一处又一处、没人收口"的化石）
M.mutate({
  name: '③ 恢复 renderLiveBar 死代码（查不存在的 #liveBar）',
  file: 'src/web/app.js',
  from: '// —— 状态条渲染（**唯一**刷新出口',
  to: "function renderLiveBar(){ const el=$('#liveBar'); if(!el) return; el.style.display='flex'; }\n// —— 状态条渲染（**唯一**刷新出口",
  expect: ['#liveBar 在 index.html 里根本不存在'],
  run: SEC,
});

// ④ 错误卡退回单行 textContent（原文换行/建议分段/折叠/复制一起消失）
M.mutate({
  name: '④ 错误卡改成单行 textContent（折叠原文与独立建议全丢）',
  file: 'src/web/app.js',
  from: "  const d=document.createElement('div'); d.className='err-card'; d.innerHTML=errCardHtml(text);",
  to: "  const d=document.createElement('div'); d.className='err-card'; d.textContent=text;",
  expect: ['错误卡必须用三段式 errCardHtml() 渲染'],
  run: SEC,
});

// ⑤ 内联确认改回全屏遮罩（历史 bug 的结构根因：遮住输入区与「■ 停止」）
M.mutate({
  name: '⑤ 权限确认改回 position:fixed 全屏遮罩',
  file: 'src/web/app.js',
  from: "  const card=document.createElement('div'); card.className='perm-card';",
  to: "  const card=document.createElement('div'); card.className='modal-mask'; card.style.cssText='position:fixed;inset:0';",
  expect: ['内联确认块不得再创建 .modal-mask 全屏遮罩'],
  run: SEC,
});

// ⑥ 「始终允许本会话」做成不起作用（按钮在、点了不记规则 → 下一次照弹）
M.mutate({
  name: '⑥ 「始终允许本会话」不写会话级 allow（点了等于没点）',
  file: 'src/web/app.js',
  from: '      if(plan.remember) sessionAllowedAsks.add(key);',
  to: '      if(plan.remember) void key;',
  expect: ['「始终允许本会话」必须真的写进 sessionAllowedAsks'],
  run: SEC,
});

// ⑦ permissionSource 写死成 config（显式选择/预设来源又被冒充——§3.64 的同类形态）
M.mutate({
  name: '⑦ /api/state.permissionSource 写死成 config',
  file: 'src/web/server.js',
  from: '    lastTurnPermissionSource = chatCfg.permissionSource; // /api/state.permissionSource（同一来源，不另算）',
  to: "    lastTurnPermissionSource = 'config';",
  expect: ['显式选择必须被如实标成 explicit'],
  run: SEC,
});

// ⑧ §144 临时文件改回仓库根（断言失败就污染 git status）
M.mutate({
  name: '⑧ §144 临时标记改回仓库根（失败即留下 .tmp-p144-<pid>.txt）',
  file: 'test/smoke.js',
  from: "  const marker144 = path.join(markerDir144, 'write-ok.txt');",
  to: "  const marker144 = path.join(srcDir, '..', '.tmp-p144-' + process.pid + '.txt');",
  expect: ['§144 marker 必须来自 os.tmpdir()'],
  run: SEC,
});

// ⑨ 错误卡删掉复制按钮（长错误只能手选，排障成本回来了）
M.mutate({
  name: '⑨ 错误卡删掉「复制」按钮',
  file: 'src/web/app.js',
  from: "    +'<div class=\"err-foot\"><button class=\"err-copy\">复制</button></div>';",
  to: "    +'';",
  expect: ['长错误必须提供「复制」按钮'],
  run: SEC,
});

// ⑩ 120s 超时语义被改掉（超时不再按拒绝，或卡片永远不落定）
M.mutate({
  name: '⑩ 前端 120s 超时改成 0（超时语义与「按拒绝处理」一起失效）',
  file: 'src/web/app.js',
  from: 'const ASK_UI_TIMEOUT_MS = 120000;',
  to: 'const ASK_UI_TIMEOUT_MS = 0;',
  expect: ['前端倒计时必须保留 120s 语义'],
  run: SEC,
});

// ⑪ 阶段口径丢掉「执行工具」（工具跑起来时状态条又显示"等首帧"）
M.mutate({
  name: '⑪ 阶段收敛把「执行工具」错归成「等首帧」',
  file: 'src/web/app.js',
  from: "  if(/执行工具|等待权限确认|待发请求|子\\s?Agent|工具/.test(p)) return '执行工具';",
  to: "  if(/执行工具|等待权限确认|待发请求|子\\s?Agent|工具/.test(p)) return '等首帧';",
  expect: ['「执行工具 bash」必须收敛成「执行工具」'],
  run: SEC,
});

// ⑫ 上下文估算去掉 ≈（把估算值伪装成精确值）
M.mutate({
  name: '⑫ 上下文占用去掉 ≈（估算冒充精确）',
  file: 'src/web/app.js',
  from: "  return (approx?'≈ ':'')+fmtTok(used)+' / '+(total?fmtTok(total):'?')+' tokens';",
  to: "  return fmtTok(used)+' / '+(total?fmtTok(total):'?')+' tokens';",
  expect: ['生成中的上下文占用必须标 ≈'],
  run: SEC,
});

if (!M.report()) process.exit(1);
