// 批二十六（用户真机 bug：桌面版点「停止」没反应，日志里连着 9 次「权限确认超时（120 秒未收到应答）」；
// 顺带：打包漏 preload.cjs）的变异验证。
//
// 修复的形状是「停止同时做两件事（置中断标志 + 解除挂起确认）+ 前端单源出口与即时反馈 + 打包白名单补文件」，
// 所以变异逐条打在这四件事上，每一条都要求 `test/smoke.js` 第 138 节当场变红
// （`expect` 用断言原文里的关键词）：
//   · 停止不再解除挂起的权限确认      → 回到修前：等 ask 的回合要晾到 120 秒超时（用户实测的形态）；
//   · 停止对真实任务变成空操作        → 前端点了跟没点一样（但接口照旧 200，最容易被漏掉的那种"静默"）；
//   · abortHandler 不再真的被调用     → AbortController 没 abort：模型请求不会断、SSE 不会关；
//   · 前端点击没有即时反馈            → 「停止中…」消失，界面看起来像卡住；
//   · 停止失败重新静默                → 失败与成功在界面上同形（修前 .catch(()=>{})）；
//   · 停止不再收掉挂起的权限确认弹窗  → 遮罩继续盖住输入区，用户够不到停止按钮；
//   · 停止请求不再单源                → 看门狗/主按钮各写一份 fetch，改一处漏一处；
//   · 打包白名单漏掉 preload.cjs      → 桌面版启动即 Unable to load preload script + ENOENT；
//   · 打包白名单漏掉 update-verify.js → main.js 静态 import 失败，主进程直接起不来（同一齿根）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('138');

// ① 服务端停止不再解除挂起的权限确认（回到修前：等 ask 的回合要晾到 120 秒超时）
M.mutate({
  name: '① 停止不再解除挂起的权限确认（回到修前：等 ask 时停止要等到 120 秒超时）',
  file: 'src/web/routes/domains/misc.js',
  from: `      let releasedAsk = false;
      if (entry?.pendingAsk) {
        const pa = entry.pendingAsk;
        entry.pendingAsk = null; // 先摘掉引用：await 续体唤醒后不得再看到这个挂起项
        try {
          pa.resolve(''); // 空串 = 拒绝（与超时同一口径：绝不因停止而放行）
          releasedAsk = true;
        } catch {}
      }`,
  to: '      let releasedAsk = false;',
  expect: ['服务端必须**同时**解除挂起的权限确认', '服务端 /api/abort 必须解除挂起的权限确认'],
  run: SEC,
});

// ② 停止对真实任务变成空操作（接口照旧 200 {stopped:0}，前端点了跟没点一样）
M.mutate({
  name: '② 停止对真实任务变成空操作（接口仍 200，但什么都没停）',
  file: 'src/web/routes/domains/misc.js',
  from: `    const stopTask = (entry) => {
      let abortedTurn = false;`,
  to: `    const stopTask = (entry) => {
      if (entry) return { abortedTurn: false, releasedAsk: false };
      let abortedTurn = false;`,
  expect: ['服务端必须确认中断（stopped≥1）', '服务端必须**同时**解除挂起的权限确认'],
  run: SEC,
});

// ③ abortHandler 不再真的被调用（只置标志位）——AbortController 没 abort，在途请求不会断
M.mutate({
  name: '③ abortHandler 不再真的被调用（内核 AbortController 没 abort）',
  file: 'src/web/routes/domains/misc.js',
  from: `          entry.abortHandler();
          abortedTurn = true;`,
  to: `          void entry.abortHandler;
          abortedTurn = true;`,
  expect: ['流式中止后 SSE 必须关闭', '中止必须真的 abort 内核 AbortController'],
  run: SEC,
});

// ④ 前端点击没有即时反馈（「停止中…」消失）
M.mutate({
  name: '④ 前端点击没有即时反馈（「停止中…」消失，界面像卡住）',
  file: 'src/web/app.js',
  from: "  if(stopping){ sendBtn.textContent='⏹ 停止中…'; sendBtn.className='danger'; sendBtn.disabled=true; return; }",
  to: "  if(false){ sendBtn.textContent='⏹ 停止中…'; sendBtn.className='danger'; sendBtn.disabled=true; return; }",
  expect: ['点停止必须立刻有可见反馈'],
  run: SEC,
});

// ⑤ 停止失败重新静默（失败与成功在界面上同形）
M.mutate({
  name: '⑤ 停止失败重新静默（失败与成功同形，用户不知道没停成）',
  file: 'src/web/app.js',
  from: "  renderBanner({text:'⚠ 停止失败：'+((res&&res.why)||'未知原因')+'。可再点一次「■ 停止」。', warn:true});",
  to: '  void res;',
  expect: ['停止失败必须有可见提示'],
  run: SEC,
});

// ⑥ 停止不再收掉挂起的权限确认弹窗（遮罩继续盖住输入区）
M.mutate({
  name: '⑥ 停止不再收掉挂起的权限确认弹窗（遮罩盖住输入区，够不到停止按钮）',
  file: 'src/web/app.js',
  from: `  stopping=true; setBtn(); renderWorkStatus();
  dismissAskModals();`,
  to: `  stopping=true; setBtn(); renderWorkStatus();`,
  expect: ['停止必须能收掉挂起的权限确认弹窗'],
  run: SEC,
});

// ⑦ 停止请求不再单源（看门狗自己再发一份 fetch——改一处漏一处的经典形态）
M.mutate({
  name: '⑦ 停止请求不再单源（看门狗另起一份 POST /api/abort）',
  file: 'src/web/app.js',
  from: '    stopTurn(curTaskId).catch(()=>{});',
  to: "    fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});",
  expect: ['停止请求必须**单源**'],
  run: SEC,
});

// ⑧ 打包白名单漏掉 preload.cjs（Bug B 复发：桌面版启动即 ENOENT，原生目录选择器静默降级）
M.mutate({
  name: '⑧ 打包白名单漏掉 preload.cjs（桌面版启动即 ENOENT）',
  file: 'desktop/electron-builder.yml',
  from: '  - preload.cjs\n',
  to: '',
  expect: ['打包配置 files 必须包含 preload.cjs'],
  run: SEC,
});

// ⑨ 打包白名单漏掉 update-verify.js（同一齿根：main.js 静态 import 失败，主进程起不来）
M.mutate({
  name: '⑨ 打包白名单漏掉 update-verify.js（主进程静态 import 失败）',
  file: 'desktop/electron-builder.yml',
  from: '  - update-verify.js\n',
  to: '',
  expect: ['打包配置 files 必须包含 update-verify.js'],
  run: SEC,
});

// ⑩ 设置面板「登记工作空间」改回只读手输框（v0.6.8 的漏接：只接了主界面，用户点登记什么都不弹）
M.mutate({
  name: '⑩ 设置面板「登记」改回只读手输框（不弹目录选择器）',
  file: 'src/web/app.js',
  from: `$('#wsAdd').onclick=()=>{
  if(!$('#wsName').value.trim()){ uiAlert('请先填写工作空间名称，再选择目录'); $('#wsName').focus(); return; }
  const typed=$('#wsDir').value.trim();
  // 手输了目录 → 直接登记；没输 → **直接弹选择器**（不再要求用户先知道绝对路径）
  if(typed){ addWorkspaceFromSettings(typed); return; }
  openDirPicker(null, (dir)=>{ addWorkspaceFromSettings(dir); }); // dir=null（「不指定（当前目录）」/取消）→ 仍按当前目录登记
};`,
  to: `$('#wsAdd').onclick=()=>{
  const typed=$('#wsDir').value.trim();
  if(!$('#wsName').value.trim()) return;
  addWorkspaceFromSettings(typed);
};`,
  expect: ['设置面板的「登记工作空间」必须调用 openDirPicker', '名称为空时不得静默 return'],
  run: SEC,
});

// ⑪ 「选择目录…」按钮绕开统一入口（直接调内置弹窗，桌面版就用不上原生对话框了）
M.mutate({
  name: '⑪ 「选择目录…」按钮绕开 openDirPicker（桌面版不再弹原生对话框）',
  file: 'src/web/app.js',
  from: "$('#wsDirPick').onclick=()=>{ openDirPicker($('#wsDir').value.trim()||null,",
  to: "$('#wsDirPick').onclick=()=>{ openDirPickerWeb($('#wsDir').value.trim()||null,",
  expect: ['「选择目录…」按钮也必须调 openDirPicker'],
  run: SEC,
});

if (!M.report()) process.exit(1);
