import { $, esc, highlight, renderMarkdown, scrollBottom, expandableBody, resultText, truncText, textBody, fmtDur, fmtTok, fmtT } from './util.js';
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from './constants.js';
import { LANG_STORAGE_KEY, applyI18n, detectLang, getLang, initI18n, setLang, storedLang, t, translate } from './i18n.js';

// P2-4（v0.6.19 §3.76）：界面文案默认跟随 navigator.language，localStorage（mingdao-lang）可覆盖。
// initI18n 只改 <html lang> 与 data-i18n* 节点；动态区域在各自渲染函数里用 t()。
function safeStorage(){
  try { return window.localStorage; } catch { return null; }
}
function navLang(){
  try { return navigator.language || navigator.userLanguage || ''; } catch { return ''; }
}
const INITIAL_LANG = initI18n({ storage: safeStorage(), root: document.documentElement, navLang: navLang() });

// 访问令牌（P1-3）：地址带 ?token= 时记入 sessionStorage 并从地址栏移除（防截图/历史外泄），
// 之后所有同源请求统一附加 X-MingDao-Token 头；无令牌时行为与旧版一致。
const AUTH_TOKEN = (() => {
  try {
    const q = new URLSearchParams(location.search).get('token');
    if (q) {
      sessionStorage.setItem('mingdao-token', q);
      history.replaceState(null, '', location.pathname);
      return q;
    }
    return sessionStorage.getItem('mingdao-token') || null;
  } catch { return null; }
})();
if (AUTH_TOKEN) {
  const rawFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    init.headers = Object.assign({}, init.headers, { 'X-MingDao-Token': AUTH_TOKEN });
    return rawFetch(input, init);
  };
}

// —— 自绘悬浮气泡 tooltip（替换原生 title：出现快、样式与暗色主题一致） ——
let tipEl = null;
function ensureTip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'mdtip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(text, anchor) {
  if (!text || !anchor) return;
  const t = ensureTip();
  t.textContent = text;
  t.style.display = 'block';
  const r = anchor.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}
function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
function attachTip(el, text) {
  if (!el || !text) return;
  el.removeAttribute('title'); // 去掉原生 title，避免双提示
  const get = typeof text === 'function' ? text : () => text;
  el.addEventListener('mouseenter', () => showTip(get(), el));
  el.addEventListener('mouseleave', hideTip);
  el.addEventListener('focus', () => showTip(get(), el));
  el.addEventListener('blur', hideTip);
  el.addEventListener('mousedown', hideTip); // 打开下拉/点击时隐藏，避免遮挡
}
window.addEventListener('scroll', hideTip, true);

// 输入区下拉 / 附件按钮：把原生 title 换成自绘气泡（文本取自原 title，一次性读取后移除）
function initTips() {
  const perm = $('#permSel'); if (perm) attachTip(perm, perm.getAttribute('title'));
  const reas = $('#reasoningSel'); if (reas) attachTip(reas, reas.getAttribute('title'));
  const model = $('#modelSel'); if (model) attachTip(model, () => { const o = model.options[model.selectedIndex]; return (o && o.title) ? o.title : '切换模型'; });
  const preset = $('#presetSel'); if (preset) attachTip(preset, () => { const o = preset.options[preset.selectedIndex]; return (o && o.title) ? o.title : '智能体预设：一键切换工具白名单/权限/参数组合（选「无预设」恢复默认）'; });
  const at = $('#attachBtn'); if (at) attachTip(at, at.getAttribute('title'));
}
initTips();

// —— 弹窗三件套（Electron 不实现 window.prompt/confirm/alert：prompt 恒返回 null、confirm 恒 false、
// alert 静默无反应——桌面版「⚙ 设置里点设Key 没反应」即由此而来）。统一替换为应用内模态框。
function modalBox(inner){
  const mask=document.createElement('div'); mask.className='modal-mask';
  const m=document.createElement('div'); m.className='modal'; m.innerHTML=inner;
  mask.appendChild(m); document.body.appendChild(mask);
  return {mask, m};
}
function uiPrompt(title, def, opts){
  opts=opts||{};
  return new Promise((resolve)=>{
    const {mask, m}=modalBox('<h3>'+esc(String(title??''))+'</h3><input class="uiPromptInput" '+(opts.hidden?'type="password" ':'')+'style="width:100%;background:var(--bg3);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-size:13.5px;margin-top:10px"><div class="row" style="margin-top:12px"><button class="danger" data-a="c">取消</button><button class="primary" data-a="y">确定</button></div>');
    const inp=m.querySelector('input');
    if(def!==undefined&&def!==null) inp.value=String(def);
    const done=(v)=>{ mask.remove(); resolve(v); };
    m.querySelector('[data-a=y]').onclick=()=>done(inp.value);
    m.querySelector('[data-a=c]').onclick=()=>done(null);
    inp.addEventListener('keydown',(e)=>{ if(e.key==='Enter') done(inp.value); if(e.key==='Escape') done(null); });
    setTimeout(()=>inp.focus(),0);
  });
}
function uiConfirm(title){
  return new Promise((resolve)=>{
    const {mask, m}=modalBox('<h3>'+esc(String(title??''))+'</h3><div class="row" style="margin-top:12px"><button class="danger" data-a="c">取消</button><button class="primary" data-a="y">确定</button></div>');
    m.querySelector('[data-a=y]').onclick=()=>{ mask.remove(); resolve(true); };
    m.querySelector('[data-a=c]').onclick=()=>{ mask.remove(); resolve(false); };
  });
}
function uiAlert(title){
  const {mask, m}=modalBox('<h3>'+esc(String(title??''))+'</h3><div class="row" style="margin-top:12px"><button class="primary" data-a="y">确定</button></div>');
  m.querySelector('[data-a=y]').onclick=()=>mask.remove();
}
// —— 目录选择器（新建工作空间 / 改目录）：浏览服务器磁盘目录树 ——
let pickerCb = null, pickerDir = '/';
function loadDirList(){
  $('#dirPath').textContent = pickerDir;
  const box = $('#dirList');
  fetch('/api/fs-browse?dir=' + encodeURIComponent(pickerDir), { cache: 'no-store' })
    .then((r) => r.json())
    .then((j) => {
      box.innerHTML = '';
      if (!j.ok) {
        const e = document.createElement('div'); e.className = 'dir-entry'; e.style.color = 'var(--err)';
        e.textContent = j.error || '无法读取该目录'; box.appendChild(e); return;
      }
      if (j.parent != null) {
        const up = document.createElement('div'); up.className = 'dir-entry'; up.textContent = '⬆ …（上级目录）';
        up.onclick = () => { pickerDir = j.parent; loadDirList(); };
        box.appendChild(up);
      }
      if (!(j.entries || []).length) {
        const e = document.createElement('div'); e.className = 'dir-entry'; e.style.color = 'var(--faint)';
        e.textContent = '（无子目录）'; box.appendChild(e);
      }
      for (const en of j.entries || []) {
        const d = document.createElement('div'); d.className = 'dir-entry'; d.textContent = '📁 ' + en.name;
        d.onclick = () => { pickerDir = en.path; loadDirList(); };
        box.appendChild(d);
      }
    })
    .catch(() => {
      box.innerHTML = '<div class="dir-entry" style="color:var(--err)">请求失败（请重试）</div>';
    });
}
function openDirPicker(startDir, cb){
  pickerCb = cb;
  // v0.6.8（负责人要求）：登记/添加/改目录时**优先弹系统原生目录选择器**，且默认停在
  // **当前用户的家目录**——用户点一下就能选中自己的项目目录，不必先知道绝对路径。
  const native = window.__MDH_DESKTOP__ && window.__MDH_DESKTOP__.pickDirectory;
  if (native) {
    // 桌面版：原生对话框（返回 null = 用户取消 → 什么都不做）
    Promise.resolve(window.__MDH_DESKTOP__.pickDirectory(startDir || null))
      .then((picked) => { pickerCb = null; if (picked && cb) cb(String(picked)); })
      .catch(() => openDirPickerWeb(startDir, cb));
    return;
  }
  openDirPickerWeb(startDir, cb);
}

/** 浏览器 / 原生选择器不可用时的回退：内置目录浏览弹窗（同样默认落在用户家目录） */
function openDirPickerWeb(startDir, cb){
  pickerCb = cb;
  if (startDir) { pickerDir = startDir; loadDirList(); }
  else {
    // 无指定起点：**用户家目录**（服务端 /api/workspaces 会带上 home；旧的 cwd 只作兜底）
    fetch('/api/workspaces', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      pickerDir = (j && (j.home || j.cwd)) || '/';
      loadDirList();
    }).catch(() => { pickerDir = '/'; loadDirList(); });
  }
  $('#dirModal').style.display = 'flex';
}
$('#dirPickHome').onclick = () => {
  fetch('/api/workspaces', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    if (j && j.home) { pickerDir = j.home; loadDirList(); }
  }).catch(() => {});
};
$('#dirPickOk').onclick = () => { const cb = pickerCb; pickerCb = null; $('#dirModal').style.display = 'none'; if (cb) cb(pickerDir); };
$('#dirPickNone').onclick = () => { const cb = pickerCb; pickerCb = null; $('#dirModal').style.display = 'none'; if (cb) cb(null); };
$('#dirPickCancel').onclick = () => { pickerCb = null; $('#dirModal').style.display = 'none'; };
const chatEl = $('#chat'), input = $('#input'), sendBtn = $('#sendBtn');
let presetData = []; // v0.4.0 Agent Preset：预设列表缓存（含 description/tools/permission，供下拉提示与选中反馈）
let activeAiMsg=null, bgRunning=0, curSteps=0, curWorkT0=0, curTools=0, curTasks=0; // 本轮进度（状态条/轨迹共用）
let bgTasks=[]; // 后台任务列表快照（chip tooltip 详情用，updateTasksPanel 每 2s 刷新）
let curPhase='模型推理中'; // 阶段语义（服务端 progress 事件下发）
// P0-1（v0.6.18 §3.68）：**唯一**的本轮运行状态快照。状态条六个字段全部从这里渲染，
// 不再各自维护 curTtft/curTps/…（散着放就会出现"两处数字打架"）。
// 数据只来自既有 SSE（progress/usage/done）+ /api/state 的 contextBudget，不新增轮询。
const runState = {
  phase: '空闲',
  rawPhase: '',
  aborted: false,
  ttftMs: null,
  tokensPerSec: null,
  toolCalls: 0,
  contentChars: 0,
  contextUsed: 0,
  contextTotal: 128000,
  contextApprox: true,
  cost: '',
  detail: '',
  permissionSource: '',
  permissionMode: '',
  // P1-4：右栏「本轮运行」的模型来源。turnModel 取本**轮** usage.modelName，
  // modelName 是当前配置选择；模型名称与 label 都来自 /api/state.models（label 由服务端透出）。
  modelName: '',
  modelLabel: '',
  turnModel: '',
  presetName: '无预设',
};
let ctxLimit = 128000; // /api/state.contextBudget（上下文上限）
let lastBudgetUsed = 0; // 上一回合 done.budget.used：生成中用"上一轮 used + 本轮字符估算"（诚实标 ≈）
// 状态条的悬浮详情：最近一次工具 / 子 Agent / 本地队列 / 权限来源（不占常驻行）
if ($('#runStrip')) attachTip($('#runStrip'), () => runState.detail || '运行状态：阶段 · 首帧 · 吞吐 · 上下文 · 工具步数 · 本轮费用');
const sessionSubs=[]; // 本会话全部子代理（task 工具）条目：{seq, question, result, msg, round, toolCalls, modelRounds, lastProgressAgoMs, status}
let turnSeq=0; // 本会话的轮次序号（对话流一行摘要 / 右栏轨迹分组的同一键）
let pendingSubagent=null; // 正在运行的 task 子代理快照（progress.subagent 刷新；任务完成后固化进 sessionSubs）
// 回到底部悬浮按钮：滚动容器为 main；上滚超过 300px 时出现，点击平滑回底
(function(){
  const scroller = document.querySelector('main');
  const btn = $('#scrollBottomBtn');
  if (scroller && btn) {
    const farFromBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 300;
    scroller.addEventListener('scroll', () => { btn.style.display = farFromBottom() ? 'flex' : 'none'; });
    btn.onclick = () => { scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); };
  }
})();
// 代码块「复制」按钮（事件委托：横幅随 markdown 渲染动态出现）
chatEl.addEventListener('click', (e) => {
  const b = e.target.closest('.cb-copy'); if (!b) return;
  const pre = b.closest('.codeblock')?.querySelector('pre');
  const t = pre ? pre.textContent : '';
  const done = () => { b.textContent = '已复制'; setTimeout(() => { b.textContent = '复制'; }, 1200); };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(done).catch(() => {});
});
let generating = false; // 生成中：发送按钮复用为停止按钮
let currentSession = null, thinking = null;



function newAiMsg(){
  const el=document.createElement('div'); el.className='msg-ai turn';
  const head=document.createElement('div'); head.className='turn-head';
  head.innerHTML='<span class="ai-dot" aria-hidden="true">M</span><b>助手</b><span class="chip mono">'+esc(runState.turnModel||runState.modelName||'')+'</span>';
  el.appendChild(head);
  chatEl.appendChild(el); scrollBottom(); return el;
}
function aiContent(msg){ const c=msg.querySelector('.content'); return c || (()=>{const d=document.createElement('div');d.className='content';msg.appendChild(d);return d;})(); }
function addReasoning(msg){ const d=document.createElement('details'); d.className='reasoning'; d.innerHTML='<summary>思考过程</summary><div class="body"></div>'; msg.appendChild(d); return d.querySelector('.body'); }

function addUser(text){ const el=document.createElement('div'); el.className='msg-user'; el.innerHTML='<div class="bubble">'+esc(text)+'</div>'; chatEl.appendChild(el); renderEmptyState(); scrollBottom(); }

const runningTools = new Map();
// P1-1 工具时间线（v0.6.19 §3.70）保留为轨迹详情的渲染原语（toolStepNode/paintToolStep/
// toolTimelineSummary）；§3.73 起对话流不再挂载内联卡——每轮只留一行摘要，详情进右栏/末尾区块。
function renderToolStartEvent(ev){
  traceToolStarted(activeAiMsg, ev);
}
function renderToolEvent(ev){
  traceToolFinished(activeAiMsg, ev);
}
function renderToolDeniedEvent(ev){
  traceToolDenied(activeAiMsg, ev);
}
function renderTodos(todos,msg){
  const ul=document.createElement('ul'); ul.className='todo';
  for(const t of todos){ const li=document.createElement('li'); li.className=t.status==='completed'?'done':t.status==='in_progress'?'doing':''; li.innerHTML=(t.status==='completed'?'✓ ':'○ ')+esc(t.content); ul.appendChild(li); }
  msg.appendChild(ul);
}
// —— 错误卡：三段式（纯函数；smoke §148 直接 eval 这段做行为断言） ——
// 上游原文保留换行（<pre> + white-space:pre-wrap），默认折叠只显示首行摘要；
// 处置建议独立成一行（.err-hint，white-space:pre-line），与原文明分；长错误可一键复制。
function errCardParts(text){
  const rawText=String(text||'').replace(/\r\n?/g,'\n');
  const lines=rawText.split('\n');
  let hintIdx=-1;
  for(let i=0;i<lines.length;i++){ if(/^\s*(?:💡|提示[:：]|处置建议[:：])/.test(lines[i])){ hintIdx=i; break; } }
  const hint=hintIdx>=0?lines[hintIdx].trim():'';
  const raw=(hintIdx>=0?lines.slice(0,hintIdx):lines).join('\n').trim()||rawText.trim();
  const head=(lines[0]||'').trim();
  const tag=/上游|upstream/i.test(rawText)?'上游':/超时|timeout/i.test(rawText)?'内核':'错误';
  return {head,hint,raw,tag};
}
function errCardHtml(text){
  const p=errCardParts(text);
  const summary=p.head.length>120?p.head.slice(0,120)+'…':p.head;
  return '<div class="err-head"><span class="err-summary">'+esc(summary)+'</span><span class="tag">'+esc(p.tag)+'</span>'
    +'<button class="err-toggle" aria-expanded="false">展开原文</button></div>'
    +(p.hint?'<p class="err-hint">'+esc(p.hint)+'</p>':'')
    +'<div class="err-raw" hidden><pre>'+esc(p.raw)+'</pre></div>'
    +'<div class="err-foot"><button class="err-copy">复制</button></div>';
}
function copyToClipboard(text){
  const t=String(text||'');
  const fallback=()=>{ try{ const ta=document.createElement('textarea'); ta.value=t; ta.style.cssText='position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }catch{} };
  if(navigator.clipboard?.writeText) return navigator.clipboard.writeText(t).catch(fallback);
  fallback(); return Promise.resolve();
}
function renderErrCard(text, opts){
  const d=document.createElement('div'); d.className='err-card'; d.innerHTML=errCardHtml(text);
  const raw=d.querySelector('.err-raw'); const toggle=d.querySelector('.err-toggle');
  if(toggle&&raw) toggle.onclick=()=>{ const open=raw.hidden; raw.hidden=!open; toggle.setAttribute('aria-expanded',String(open)); toggle.textContent=open?'收起原文':'展开原文'; };
  const cp=d.querySelector('.err-copy');
  if(cp) cp.onclick=()=>{ copyToClipboard(raw&&raw.querySelector('pre')?raw.querySelector('pre').textContent:'').then(()=>{ cp.textContent='已复制'; setTimeout(()=>{cp.textContent='复制';},1200); }); };
  insertBeforeActiveMsg(d); scrollBottom();
}
function isFoldableError(text){
  const t=String(text||'');
  return /^\s*(?:⚠|✖)/.test(t) && (t.includes('\n') || t.length>160) && !/已停止本轮|停止请求已被服务端确认/.test(t);
}
function renderBanner(ev){
  const text=String(ev.text||ev.title||'');
  // 长错误走上图的三段式卡；普通横幅（已停止/已保存/预设提示…）保持原样，不制造"满屏都是错误"
  if(isFoldableError(text)){ renderErrCard(text, ev); return; }
  const d=document.createElement('div'); d.className='banner'+(ev.warn?' banner-warn':''); d.textContent=text; insertBeforeActiveMsg(d); scrollBottom();
}
// 工具卡/横幅/代码块统一插到「本轮 AI 消息」之前：结论与交付物永远位于消息最底部
function insertBeforeActiveMsg(el){ if(activeAiMsg && activeAiMsg.parentNode){ chatEl.insertBefore(el, activeAiMsg); } else { chatEl.appendChild(el); } }

// P0-2 内联权限确认（v0.6.18 §3.68）：**不再用 .modal-mask 全屏遮罩**。
// 卡片插在对话流里（普通文档流），输入区 / 附件 / 停止按钮 / 滚动全程可用；
// 三档动作：本次放行 / 拒绝 / 始终允许本会话。停止仍优先于 120s 超时：
// dismissAskModals() 以 aborted=true 落定，**不** POST /api/permission（服务端已按拒绝收尾）。
const ASK_UI_TIMEOUT_MS = 120000;
const sessionAllowedAsks = new Set(); // 会话级 allow：键 = 确认问题原文（工具 + 参数）
const askQueue = []; // 同一轮多个确认串行展示（只有队首可点，不再叠加遮罩）
let activeAsk = null;

// —— 内联权限确认：判据（纯函数；smoke §148 直接 eval 这段做行为断言） ——
function askSignature(ev){ return String((ev&&ev.question)||'').trim(); }
function askAnswerPlan(answer){
  if(answer==='always') return {post:'y', remember:true};
  if(answer==='allow'||answer==='y'||answer===true) return {post:'y', remember:false};
  return {post:'n', remember:false}; // deny / Esc / 超时：一律按拒绝回传
}
function askCardHtml(ev){
  const q=String((ev&&ev.question)||'');
  const opts=Array.isArray(ev&&ev.options)&&ev.options.length?ev.options:null;
  const acts=opts
    ? opts.map((/** @type {any} */ o)=>'<button class="btn" data-a="'+esc(o.value)+'">'+esc(o.label||o.value)+'</button>').join('')+'<button class="btn danger" data-a="deny">拒绝</button>'
    : '<button class="btn primary" data-a="allow">本次放行</button><button class="btn danger" data-a="deny">拒绝</button><button class="btn ghost perm-always" data-a="always">始终允许本会话</button>';
  return '<div class="perm-head permcard-head">🔐 需要你确认<span class="perm-scope">本会话</span></div>'
    +'<div class="perm-q cmd">'+esc(q)+'</div>'
    +'<div class="perm-acts">'+acts+'<button class="btn ghost perm-stop" data-stop="1" title="停止本轮（与输入区的「■ 停止」同一条出口）">■ 停止本轮</button></div>'
    +'<div class="perm-note">「始终允许本会话」只对<b>本会话</b>内相同确认（同一工具与参数）自动放行，不写入 config.json；刷新页面或新会话后失效。键盘：y = 本次放行，n = 拒绝，Esc = 拒绝。</div>'
    +'<div class="perm-count" data-count>等待 02:00 后按「拒绝」处理</div>';
}

// —— 内联权限确认：队列与渲染（普通文档流，不遮任何东西） ——
function askModal(ev){
  return new Promise(resolve=>{
    const entry=/** @type {any} */ ({ ev, resolve, settled:false, card:null, timer:null });
    entry.dismiss=()=>settleAsk(entry,'','aborted'); // 停止路径：不问自答，按「拒绝」落定
    askQueue.push(entry);
    mountNextAsk();
  });
}
function settleAsk(entry, answer, kind){
  if(!entry||entry.settled) return;
  entry.settled=true;
  if(entry.timer){ clearInterval(entry.timer); entry.timer=null; }
  const i=askQueue.indexOf(entry); if(i>=0) askQueue.splice(i,1);
  if(entry.card){ try{ entry.card.remove(); }catch{} entry.card=null; }
  if(activeAsk===entry) activeAsk=null;
  const aborted=kind==='aborted'; const timeout=kind==='timeout';
  entry.resolve({ answer: aborted?'':(timeout?'deny':answer), aborted, timeout });
  mountNextAsk();
}
function mountNextAsk(){
  if(activeAsk) return;
  while(askQueue.length){ const e=askQueue.shift(); if(!e.settled){ activeAsk=e; break; } }
  const entry=activeAsk; if(!entry) return;
  const card=document.createElement('div'); card.className='perm-card';
  card.classList.add('permcard');
  card.setAttribute('role','group'); card.setAttribute('aria-label','权限确认（不遮挡输入区）');
  card.innerHTML=askCardHtml(entry.ev);
  entry.card=card;
  const count=card.querySelector('[data-count]');
  const startedAt=Date.now();
  const tick=()=>{
    const left=Math.max(0, Math.ceil((ASK_UI_TIMEOUT_MS-(Date.now()-startedAt))/1000));
    if(count) count.textContent=left>0
      ? '等待 '+String(Math.floor(left/60)).padStart(2,'0')+':'+String(left%60).padStart(2,'0')+' 后按「拒绝」处理'
      : '已超时（120s），本次操作按「拒绝」处理';
    if(left<=0){
      card.classList.add('perm-timeout');
      card.querySelectorAll('button').forEach((/** @type {any} */ b)=>{ b.disabled=true; });
      settleAsk(entry,'deny','timeout');
    }
  };
  tick(); entry.timer=setInterval(tick,1000);
  card.querySelectorAll('[data-a]').forEach((/** @type {any} */ b)=>{ b.onclick=()=>settleAsk(entry,b.dataset.a); });
  const sb=card.querySelector('[data-stop]'); if(sb) sb.onclick=()=>stopTurnFromButton();
  chatEl.appendChild(card); scrollBottom();
}
function dismissAskModals(){
  // 停止优先于权限确认：把挂起/排队的内联确认全部收掉（aborted=true → 不 POST，服务端按拒绝落定），
  // 这样既不会残留可点按钮，也不会让停止等到 120s ask 超时。
  const all=[...askQueue]; if(activeAsk) all.push(activeAsk);
  for(const e of all){ try{ e.dismiss(); }catch{} }
}
// 键盘：y / n 仍可用（焦点不在输入框时），Esc 关卡片并按「拒绝」处理。
document.addEventListener('keydown', (e)=>{
  if(e.isComposing) return;
  const entry=activeAsk; if(!entry) return;
  const tag=String((e.target&&e.target.tagName)||'').toLowerCase();
  const typing=/^(input|textarea|select)$/.test(tag)||Boolean(e.target&&e.target.isContentEditable);
  if(e.key==='Escape'){ e.preventDefault(); settleAsk(entry,'deny','esc'); return; }
  if(typing) return;
  if(e.key==='y'||e.key==='Y'){ e.preventDefault(); settleAsk(entry,'allow'); }
  else if(e.key==='n'||e.key==='N'){ e.preventDefault(); settleAsk(entry,'deny'); }
});

async function handleEvents(stream, onEvent){
  const reader=stream.getReader(); const dec=new TextDecoder(); let buf='';
  for(;;){ const {done,value}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true});
    let nl; while((nl=buf.indexOf('\n'))>=0){ const line=buf.slice(0,nl).trim(); buf=buf.slice(nl+1); if(!line.startsWith('data:'))continue; try{ onEvent(JSON.parse(line.slice(5))); }catch{} }
  }
}

// —— 附件（图片 / 文本文件） ——
let attachments=[];
$('#attachBtn').onclick=()=>{ $('#fileInput').click(); };
$('#fileInput').addEventListener('change', async e=>{
  for(const f of e.target.files||[]){
    if(attachments.length>=MAX_ATTACHMENTS){ uiAlert('最多 '+MAX_ATTACHMENTS+' 个附件'); break; }
    if(f.type.startsWith('image/')){
      if(f.size>MAX_IMAGE_BYTES){ uiAlert(f.name+' 超过 5MB'); continue; }
      const dataUrl=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsDataURL(f); });
      attachments.push({type:'image',name:f.name,dataUrl});
    }else if(f.type.startsWith('text/')||/\.(txt|md|json|js|py|log|csv|html|css)$/i.test(f.name)){
      if(f.size>MAX_TEXT_BYTES){ uiAlert(f.name+' 超过 200KB'); continue; }
      const content=await new Promise(r=>{ const fr=new FileReader(); fr.onload=()=>r(fr.result); fr.readAsText(f); });
      attachments.push({type:'text',name:f.name,content});
    }else{
      uiAlert(f.name+'：暂只支持图片与文本文件');
    }
  }
  e.target.value='';
  renderAttachments();
});
function renderAttachments(){
  const list=$('#attachList'); list.innerHTML='';
  if(!attachments.length){ list.style.display='none'; return; }
  list.style.display='flex';
  for(let i=0;i<attachments.length;i++){
    const a=attachments[i];
    const chip=document.createElement('span'); chip.className='atchip';
    chip.textContent=(a.type==='image'?'🖼 ':'📄 ')+a.name+' ✕';
    chip.title='点击移除';
    chip.onclick=()=>{ attachments.splice(i,1); renderAttachments(); };
    list.appendChild(chip);
  }
}

async function send(){
  const text=input.value.trim();
  console.log('[MingDao] send 点击：generating=' + generating + ' text=' + text.length + ' attachments=' + attachments.length);
  if(generating){
    // 审计（长任务静默硬伤）：任务执行中追问「是否完成」→ 界面立即如实应答当前进度，
    // 不再静默吞掉输入；停止职责由「■ 停止」按钮承担（输入框内容保留不丢）。
    const secs=curWorkT0?Math.round((Date.now()-curWorkT0)/1000):0;
    const d=document.createElement('div'); d.className='msg-sys';
    d.innerHTML='⏳ 上一个任务仍在执行（第 '+curSteps+' 步 · 已 '+Math.floor(secs/60)+' 分 '+Math.round(secs%60)+' 秒），<b>尚未完成</b>。完成后总结与交付物会自动出现在本轮消息底部；如需立即中断请点「■ 停止」。';
    chatEl.appendChild(d); scroll();
    return;
  }
  if(!text && !attachments.length) return;
  const turnCtrl=new AbortController();
  turnAbortCtrl=turnCtrl; // 模块级引用：停止的兜底路径要能断开本轮 SSE（服务端 res.on('close') 同样会收尾）
  // 回合看门狗（无活动超时，非总时长——审计：此前 120s 定时炸弹误杀长时间健康生成，
  // 如模型持续输出大文件代码时到点被掐断：write 参数截断 + 「响应超时已中断」）：
  // 每收到一个 SSE 事件即重置；ask 权限等待期间暂停计时（用户思考不设限），
  // 回复后的下一个事件自动重新武装。仅当 120 秒内真正没有任何事件（挂死）才强制中断。
  // §138：看门狗与主按钮走**同一个**停止出口 stopTurn()（单源）——此前两处各写一份 fetch，
  // 改一处漏一处（例如"解除挂起的权限确认"只补在按钮上）。
  let watchdog=null; let killedByWatchdog=false;
  const disarm=()=>{ if(watchdog){ clearTimeout(watchdog); watchdog=null; } };
  const arm=()=>{ disarm(); watchdog=setTimeout(()=>{
    killedByWatchdog=true;
    try{ turnCtrl.abort(); }catch{}
    stopTurn(curTaskId).catch(()=>{});
  },120000); };
  arm();
  input.value=''; input.style.height='44px'; updateDraftBadge();
  const payload={message:text,file:currentSession};
  // v0.4.0 Agent Preset：选择器选中的预设随本轮发送（服务端按会话应用一次）
  const presetVal=$('#presetSel')?.value;
  if(presetVal) payload.preset=presetVal;
  // v0.6.12（用户实测：选了「自动」仍被按只读跑）：**权限模式必须随本轮请求显式带上**。
  // 此前 permSel 只走 applyConfig→POST /api/config 把 permission 写进 config.json，chat 请求体里
  // 从不带 permission —— 服务端因此分不清"用户此刻选了 auto"与"config.json 里躺着 auto"，
  // 预设（如 local-audit 声明 permission=readonly）便会静默压过用户的选择：每调用一次非只读工具
  // 都弹「只读模式将拦截 …」。服务端优先级：显式选择 > 预设 > config.json（server.js 的
  // resolveTurnPermission）。config.json 的对象形态（allow/deny）由服务端保留，这里只发 mode。
  const permVal=$('#permSel')?.value;
  if(permVal) payload.permission=permVal;
  // 带上文开关：勾选后系统提示注入最近会话日志（默认不注入——新会话全新开始，避免串到历史会话上下文）
  if($('#journalChk')?.checked) payload.withJournal=true;
  if(attachments.length) payload.attachments=attachments;
  const sentAttachments=attachments;
  attachments=[]; renderAttachments();
  addUser(text||(sentAttachments.map(a=>(a.type==='image'?'🖼 ':'📄 ')+a.name).join(' ')));
  const msg=newAiMsg(); const content=aiContent(msg); let raw='';
  activeAiMsg=msg; msg._traj=[]; msg._steps=0; msg._round=++turnSeq; msg._startedAt=Date.now(); msg._endedAt=null; pendingSubagent=null; curSteps=0; curWorkT0=Date.now();
  // P0-1：本轮开始 → 运行状态条归零（上一轮的费用/首帧/工具数不许泄漏到本轮；上下文基数保留）
  runState.rawPhase='发请求（等首帧）'; runState.phase='等首帧'; runState.aborted=false;
  runState.ttftMs=null; runState.tokensPerSec=null; runState.toolCalls=0; runState.contentChars=0;
  runState.contextApprox=true; runState.contextUsed=lastBudgetUsed; runState.contextTotal=ctxLimit;
  runState.cost=''; runState.detail=''; runState.turnModel='';
  renderWorkStatus();
  let reason=null; let taskId=null;
  // 等待输出时的可见状态：脉动「正在思考…」（每轮生成重新显示）
  const think=document.createElement('div'); think.className='think'; think.textContent='💭 正在思考…'; msg.appendChild(think);
  const showThink=()=>{ if(!think.parentNode) msg.appendChild(think); };
  // 工作指示：提示栏实时显示已工作时长与执行步数，让用户时刻感受到智能体在干活
  // 审计（第二问根因）：文本只写 #hintText，绝不 textContent 覆盖 #hint——那会把其中的
  // #journalChk 复选框从 DOM 抹掉，第二问读 .checked 抛异常 → 按钮卡红 → 全部发送静默
  let stepsCount=0; const workT0=Date.now();
  const hintEl=$('#hint'); const hintTextEl=$('#hintText'); const defaultHint=hintTextEl?hintTextEl.textContent:'';
  hintEl.classList.add('working');
  const hintTimer=setInterval(()=>{ if(hintTextEl) hintTextEl.textContent='⏳ 正在工作 '+Math.round((Date.now()-workT0)/1000)+'s · 已执行 '+stepsCount+' 步 — 可点「■ 停止」中断'; renderWorkStatus(); },1000);
  generating=true; setBtn(); // 本地在途状态（前置 DOM 段完成后才置位，异常不影响按钮）
  const scroller=document.querySelector('main');
  const nearBottom=()=> scroller? (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90) : true;
  const scroll=()=>{ if(nearBottom()&&scroller) scroller.scrollTop = scroller.scrollHeight; };
  let pending=false;
  const update=()=>{ if(pending) return; pending=true; requestAnimationFrame(()=>{ pending=false; content.innerHTML=renderMarkdown(raw); scroll(); }); };
  const onActivity=()=>{ if(think.parentNode) think.remove(); if(reason&&reason.parentElement){ reason.parentElement.open=false; reason.parentElement.querySelector('summary').classList.remove('live'); } };
  updateTasksPanel();
  // 权限确认应答（§138）：弹窗返回 {answer, aborted}——`aborted=true` 表示这条确认是被「停止」
  // 解除的（服务端已按「拒绝」落定），此时**不再**回 POST /api/permission：回了只会拿到 409，
  // 而那正是此前"点了允许却什么都没发生"的静默失败形态。
  // P0-2：内联卡片的应答出口（会话级 allow 也在这里生效）。返回的 answer 已归一化成 y/n：
  //   allow→y；deny/Esc/超时→n；always→y 并写入 sessionAllowedAsks（同一确认后续不再弹卡）。
  const postAskAnswer=(ev,answer)=>fetch('/api/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ev.id,answer,taskId:ev.taskId||taskId})})
    // 「无活动看门狗」在 ask 等待期间是停掉的：无论应答成功与否都要重新武装（与修前一致），
    // 否则一次应答失败就会让本轮的挂死失去最后一道超时保护
    .then(r=>{ arm(); if(!r.ok) throw new Error('HTTP '+r.status); })
    .catch(err=>{ const d=document.createElement('div'); d.className='errline'; d.textContent='✖ 权限应答没能送达服务端（'+((err&&err.message)||'网络错误')+'）——请重新发送上一条消息；服务端在 120 秒无应答后会按「拒绝」处理。'; msg.appendChild(d); scroll(); });
  const handleAskEvent=(ev)=>{
    const key=askSignature(ev);
    // 「始终允许本会话」= 会话级 allow：同一确认不再弹卡，直接按「本次放行」回传。
    // 作用域只在本页面/本会话内（不写 config.json）；刷新或新会话后自然失效。
    if(sessionAllowedAsks.has(key)){
      renderBanner({text:'✓ 已按「始终允许本会话」自动放行：'+String(ev.question||'').slice(0,80)});
      return postAskAnswer(ev,'y');
    }
    askModal(ev).then(res=>{
      if(res.aborted) return; // 停止优先于超时/应答：服务端已按拒绝落定，不能再回 POST（只会 409）
      const plan=askAnswerPlan(res.answer);
      if(plan.remember) sessionAllowedAsks.add(key);
      if(res.timeout) renderBanner({text:'⚠ 权限确认等待超时（120s），本次操作已按「拒绝」处理。',warn:true});
      return postAskAnswer(ev, plan.post);
    });
  };
  try{
    const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:turnCtrl.signal});
    if(!resp.ok){ const j=await resp.json().catch(()=>({})); onActivity(); msg.innerHTML='<div class="errline">'+esc(j.error||('HTTP '+resp.status))+'</div>'; updateTasksPanel(); return; }
    await handleEvents(resp.body, ev=>{
      if(ev.taskId){ taskId=ev.taskId; curTaskId=taskId; } // 质检 L1：主停止按钮只断本任务
      if(ev.type==='ask') disarm(); else arm(); // 有活动→重置；权限等待→暂停计时
      if(ev.type==='progress'){ const p=ev.seconds||0; if(ev.phase) curPhase=String(ev.phase); curTools=Number(ev.steps)||0; curTasks=Number(ev.tasks)||0; showThink();
        // P0-1：同一个 runState 同时喂状态条六字段与悬浮详情（服务端 progress ≈1s 一次，无新增轮询）
        applyRunProgress(runState, ev, lastBudgetUsed);
        // v0.6.13（A）：本地模型场景把「在等首帧 / 在解码 / 在等哪个工具 / TTFT / tok/s / 0 次工具调用」直接摆在状态行上——
        // 真机实测的痛点是"跑了几小时，界面上什么都看不出来"。0 次工具调用必须显式显示为 0，不能省略。
        const bits=[];
        bits.push('模型请求 '+(ev.modelRounds||0)+' 轮');
        bits.push('工具调用 '+(ev.toolCalls||0)+' 次');
        if(ev.ttftMs!=null) bits.push('首帧 '+(ev.ttftMs/1000).toFixed(1)+'s');
        if(ev.tokensPerSec!=null) bits.push('≈'+Number(ev.tokensPerSec).toFixed(1)+' tok/s');
        if(ev.contentChars) bits.push('正文 '+ev.contentChars+' 字');
        if(ev.pendingTool) bits.push('等待工具 '+ev.pendingTool.name+' 已 '+Math.round((ev.pendingTool.ms||0)/1000)+'s');
        // v0.6.13（问题 3）：等 `task` 子代理时把**子代理自己的进度**摆出来——
        // 真机现场界面/日志只有"等待工具 task 已 620s"，与"卡死 620s"完全同形。
        if(ev.subagent) bits.push('子 Agent'+(ev.subagent.label?'「'+ev.subagent.label+'」':'')+'已跑 '+(ev.subagent.modelRounds||0)+' 轮 / '+(ev.subagent.toolCalls||0)+' 次工具调用'+(ev.subagent.ms!=null?'（最后进展 '+Math.round(ev.subagent.ms/1000)+'s 前）':''));
        // v0.6.15（§3.59）：本地端点串行化必须在界面上看得见（真机内存压力来自父回合 + 子代理并发）
        if(ev.localQueue) bits.push('本地端点已串行化（防内存压力）：等待 '+(ev.localQueue.active||0)+' 个在途请求、并发上限 '+(ev.localQueue.limit||1));
        if(ev.stalled) bits.push('已判定无进展，正在中止');
        runState.detail=bits.join(' · ');
        think.textContent='💭 正在工作 '+Math.floor(p/60)+' 分 '+Math.round(p%60)+' 秒 · 第 '+msg._steps+' 回合 · '+curPhase+' · '+bits.join(' · ')+'…';
        renderWorkStatus();
        // §3.73：子代理运行中随既有 progress.subagent 实时更新右侧/末尾那一行（不新增轮询）。
        if (ev.subagent && pendingSubagent) pendingSubagent = mergeSubagentProgress(pendingSubagent, ev.subagent);
        updateTraceSummary(activeAiMsg);
        if (ev.subagent) renderSubagentSections(); }
      if(ev.type==='text'){ curPhase='模型输出中'; runState.rawPhase='解码中（收到增量）'; runState.phase='解码中'; runState.contentChars=raw.length; onActivity(); raw+=ev.delta; update(); }
      else if(ev.type==='reasoning'){ if(!reason){ reason=addReasoning(msg); reason.dataset.full=''; } if(!reason.parentElement.open) reason.parentElement.open=true; reason.parentElement.querySelector('summary').classList.add('live'); reason.dataset.full+=ev.delta; const full=reason.dataset.full; reason.textContent=(full.length>9000?full.slice(-9000)+'\n…（思考内容较长，仅显示末尾；已 '+full.length+' 字符）':full); reason.scrollTop=reason.scrollHeight; scroll(); }
      else if(ev.type==='turnStart'){ stepsCount+=1; curSteps+=1; msg._steps=curSteps; curPhase='模型推理中'; runState.rawPhase='发请求（等首帧）'; runState.phase='等首帧'; msg._traj.push({kind:'turn', t:Date.now()}); showThink(); think.textContent='💭 第 '+msg._steps+' 回合：模型推理中…'; renderWorkStatus(); scroll(); }
      else if(ev.type==='turnEnd'){ curPhase='回合完成，进入下一回合'; showThink(); think.textContent='⏸ 第 '+msg._steps+' 回合完成（累计 '+(ev.toolSteps||0)+' 工具步）· 进入下一回合…'; renderWorkStatus(); }
      else if(ev.type==='toolStart'){ stepsCount+=1; curSteps+=1; curPhase=ev.name==='task'?'子 Agent 执行中':'执行工具中'; runState.rawPhase=curPhase; runState.phase='执行工具'; msg._steps=curSteps; msg._traj.push({kind:'tool', seq:ev.seq, name:ev.name, args:ev.args, t:Date.now(), done:false}); onActivity(); update(); renderToolStartEvent(ev); renderWorkStatus(); }
      else if(ev.type==='code'){ onActivity(); const pre=document.createElement('pre'); pre.innerHTML='<code>'+highlight(ev.code,ev.lang)+'</code>'; insertBeforeActiveMsg(pre); scroll(); }
      else if(ev.type==='tool'){ onActivity(); update(); runningTools.delete(ev.seq); const tj=msg._traj.find(x=>x.kind==='tool'&&x.seq===ev.seq); if(tj){ tj.done=true; tj.result=ev.result; tj.durationMs=ev.durationMs; } renderToolEvent(ev); }
      else if(ev.type==='toolDenied'){ onActivity(); const tj=msg._traj.find(x=>x.kind==='tool'&&x.seq===ev.seq); if(tj){ tj.done=true; tj.denied=ev.reason||'未授权'; } renderToolDeniedEvent(ev); const d=document.createElement('div'); d.className='errline'; d.textContent='✖ '+(ev.reason==='未授权'||!ev.reason?'未授权':ev.reason)+'：'+ev.name; msg.appendChild(d); scroll(); }
      else if(ev.type==='banner'){ renderBanner(ev); }
      else if(ev.type==='ask'){ runState.rawPhase='等待权限确认'; runState.phase='执行工具'; update(); renderWorkStatus(); handleAskEvent(ev); }
      else if(ev.type==='usage'){ onActivity(); runState.cost=String(ev.cost||'');
        // P1-4：本**轮**实际用到的模型（服务端 usage.modelName）——不是"当前选择"的猜测。
        if(ev.modelName){ runState.turnModel=String(ev.modelName); const ce=modelsCache.find((m)=>m&&(m.id||m.name)===runState.turnModel); runState.modelLabel=ce?String(ce.label||ce.id||ce.modelName||ce.name||''):runState.modelLabel; }
        renderWorkStatus(); const u=document.createElement('div'); u.className='usage'; u.textContent=''+ev.modelName+' · ↑'+ev.usage.prompt_tokens+' ↓'+ev.usage.completion_tokens+' tokens · '+((ev.durationMs||0)/1000).toFixed(1)+'s'+ev.cost; msg.insertBefore(u, content); scroll(); }
      else if(ev.type==='error'){ console.log('[MingDao] error 事件：' + ev.message); onActivity();
        // §138 Bug C：服务端已按超时把这条确认作废（pendingAsk 清空），前端若继续挂着那个弹窗，
        // 用户再点「允许」只会拿到 409 且毫无提示，弹窗还会一个个叠起来（界面"像卡住"）。
        // 这里把作废的确认收掉：该确认已经死了，界面上不该再留一个能点的假弹窗。
        if(/权限确认超时/.test(String(ev.message||''))) dismissAskModals();
        if(isFoldableError(ev.message)){ renderErrCard(String(ev.message), {warn:true}); }
        else { const d=document.createElement('div'); d.className='errline'; d.textContent=ev.message; msg.appendChild(d); scroll(); } }
      else if(ev.type==='done'){
        // v0.6.13（问题 4）：把**结局**写进控制台。桌面壳的日志就是渲染进程的 console（转存到
        // ~/Library/Application Support/mingdao-desktop/logs/mingdao.log），此前那里只有
        // 「回合收尾：generating=false，按钮恢复发送」——同一时刻内核写的是 `status=stalled`，
        // 事后取证完全对不上（真机 2026-10-09T03:13:16 两条日志并列就是证据）。
        const endStatus=ev.stalled?(ev.stallCause==='inherited'?'stalled(父回合整轮无进展)':'stalled(长时间无进展)'):ev.aborted?'aborted':(ev.truncated?'capped':'done');
        console.log('[MingDao] done 事件：session=' + ev.session + ' status=' + endStatus + ' durationMs=' + (ev.durationMs||0));
        onActivity();
        if(ev.budget){ const b=ev.budget; lastBudgetUsed=Number(b.used)||0; runState.contextUsed=Math.max(0,Number(b.used)||0); runState.contextTotal=Number(b.total)||runState.contextTotal; runState.contextApprox=false; if(hintTextEl) hintTextEl.textContent='预算 '+Math.round(b.used/1000)+'K/'+Math.round(b.total/1000)+'K（'+Math.round(b.used/b.total*100)+'%）· 本轮完成 · 提示栏右侧为今日费用与命中率'; }
        // P0-1：结局写进状态条——stalled/aborted 必须显示「已中止」，不得回落成「空闲」冒充正常完成
        runState.aborted=Boolean(ev.stalled||ev.aborted);
        runState.rawPhase=runState.aborted?'已中止':'空闲';
        runState.phase=runState.aborted?'已中止':'空闲';
        renderWorkStatus();
        refreshStatusBar();
        if(ev.stats&&ev.stats.deliverables&&ev.stats.deliverables.length){ const card=document.createElement('div'); card.className='deliver'; card.innerHTML='<div class="t">📦 交付物（'+ev.stats.deliverables.length+' 个文件）</div>'+ev.stats.deliverables.map(f=>'<div class="i">'+esc(f)+(f.toLowerCase().endsWith('.html')?' <span style="color:var(--accent2)">— 浏览器打开即可运行</span>':'')+'</div>').join(''); msg.appendChild(card); }
        // v0.6.13（问题 4）：stalled 必须**用户可见**，而且与 capped/aborted 区分开（复用既有 done.note 渲染）。
        // 内核已发了一条同文案的告警 banner（服务端 `if (r.stalled) send({type:'banner'…})`），
        // 这里再在消息下方留一条——用户滚动回看时不必去翻日志才知道"这轮为什么停了"。
        if(ev.stalled){ const d=document.createElement('div'); d.className='errline'; d.style.color='var(--warn)'; d.textContent='⏹ 本轮因长时间无进展已中止（不是步数上限 capped、也不是你点的停止 aborted）——'+(ev.note||'详情见上方告警条。'); msg.appendChild(d); }
        else if(ev.note){ const d=document.createElement('div'); d.className='errline'; d.style.color='var(--warn)'; d.textContent=ev.note; msg.appendChild(d); }
        currentSession=ev.session; update(); refreshSessions(); updateTasksPanel(); }
    });
  }catch(e){ onActivity(); // 诊断（v0.4.2 network error 排查）：静默中断此前无任何日志，无法区分
    if((e&&e.name==='AbortError')||killedByWatchdog) runState.aborted=true;
    // 「手点停止 / 看门狗 / fetch 流静默断裂」。v0.4.3 修：第二参改 JSON 字符串——Electron 日志
    // 对对象只会落 [object Object]，异常细节丢失。
    const diag = { name: e && e.name, message: e && e.message, err: String(e), taskId, rawLen: raw.length, steps: stepsCount, elapsedS: Math.round((Date.now() - workT0) / 1000) };
    console.error('[MingDao] chat 流异常 ' + JSON.stringify(diag));
    const d=document.createElement('div'); d.className='errline';
    // 统一 catch 文案（v0.4.3）：非用户中断/看门狗时，无论有无 e.message 都优先给「可续跑」的友好提示，
    // 具体错误形态已进日志（fetch failed 等不再绕开续跑提示）。
    d.textContent=(e&&e.name==='AbortError')?(killedByWatchdog?'响应超时已中断（120 秒无任何响应），请重试':'已中断'):('连接中断，本轮未完成。已执行的工作已保存检查点——直接发送「继续」即可从断点续跑（' + Math.round((Date.now() - workT0) / 1000) + 's · ' + stepsCount + ' 步）。');
    msg.appendChild(d); scroll(); }
  finally{ clearInterval(hintTimer); disarm(); clearTimeout(stopFallbackTimer); stopFallbackTimer=null; stopping=false; turnAbortCtrl=null; generating=false; setBtn(); curTaskId=null; curPhase='模型推理中'; console.log('[MingDao] 回合收尾：generating=false，按钮恢复发送'); hintEl.classList.remove('working'); if(hintTextEl) hintTextEl.textContent=defaultHint; pending=false; msg._endedAt=Date.now(); finalizePendingSubagent(msg); content.innerHTML=renderMarkdown(raw); attachTrajMeta(msg); renderTracePanels(); activeAiMsg=null; curWorkT0=0; if(!runState.aborted){ runState.rawPhase='空闲'; runState.phase='空闲'; } else { runState.rawPhase='已中止'; runState.phase='已中止'; } renderWorkStatus(); scroll(); updateTasksPanel(); }
}

let curTaskId=null; // 本轮 SSE 任务 id（质检 L1：主停止按钮只断本任务，不再误伤其他 tab）
let turnAbortCtrl=null; // 本轮 /api/chat 的 AbortController（停止的兜底路径：断开 SSE → 服务端 res.on('close') 收尾）
let stopping=false; // 「停止中…」在途（按钮即时反馈 + 防连点）
let stopFallbackTimer=null; // 停止已发出但流迟迟不收尾时的兜底计时器

/**
 * 停止的**唯一出口**（§138 单源）：主停止按钮 / 回合看门狗 / 任务面板「中断」三处都走这里，
 * 服务端只有 `POST /api/abort` 一条路。
 * 返回 {ok, why}：ok=true 表示服务端**确认**了中断（stopped 或 releasedAsk > 0），
 * 而不是"请求发出去了"——修前这里一律 `.catch(()=>{})`，失败与成功在界面上完全同形（静默无响应）。
 * @param {string|null} taskId
 */
async function stopTurn(taskId){
  try{
    const r=await fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(taskId?{taskId}:{})});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) return {ok:false, why:'HTTP '+r.status+(j&&j.error?('：'+j.error):'')};
    const n=Number(j.stopped||0)+Number(j.releasedAsk||0);
    if(n>0) return {ok:true, stopped:Number(j.stopped||0), releasedAsk:Number(j.releasedAsk||0)};
    if(j.found===false) return {ok:false, why:'该任务已结束（服务端没有这个任务）', gone:true};
    if(j.status&&j.status!=='running') return {ok:false, why:'该任务已结束（'+j.status+'）', gone:true};
    return {ok:false, why:'服务端未确认中断（可能中断路径没生效）'};
  }catch(e){ return {ok:false, why:'停止请求没能送达服务端（'+((e&&e.message)||'网络错误')+'）'}; }
}

/**
 * 主按钮的停止：**立刻**进入「停止中…」→ 真正调用停止 → 失败必须说出来。
 * 等待权限确认期间同样可用：先把挂起的确认弹窗收掉（服务端会同步按「拒绝」落定），
 * 否则遮罩继续盖住界面，用户点什么都"没反应"。
 */
async function stopTurnFromButton(){
  if(stopping) return;
  runState.aborted=true; runState.rawPhase='已中止'; runState.phase='已中止';
  stopping=true; setBtn(); renderWorkStatus();
  dismissAskModals();
  let res=null;
  for(let i=0;i<3 && !(res&&(res.ok||res.gone));i++){
    res=await stopTurn(curTaskId);
    if(!(res&&res.ok)) await new Promise(r=>setTimeout(r,400));
  }
  if(res&&res.ok){
    renderBanner({text:'■ 已停止本轮'+(res.releasedAsk?'（含挂起的权限确认，按「拒绝」处理）':'')+'…'});
    // 兜底：服务端确认了中断，但若 8 秒内流仍未收尾，直接断开本轮 SSE。
    // 服务端 res.on('close') 走的是同一套收尾（置 aborted + 解除挂起确认），这是第二条真实路径。
    clearTimeout(stopFallbackTimer);
    stopFallbackTimer=setTimeout(()=>{
      if(!generating) return;
      try{ turnAbortCtrl?.abort(); }catch{}
      renderBanner({text:'⚠ 停止请求已被服务端确认，但本轮连接仍未收尾——已强制断开连接。', warn:true});
    },8000);
    return;
  }
  stopping=false; setBtn(); renderWorkStatus();
  renderBanner({text:'⚠ 停止失败：'+((res&&res.why)||'未知原因')+'。可再点一次「■ 停止」。', warn:true});
}

// —— 输入框上方工作状态条（P0-1 起由下面的 #runStrip 常驻状态条取代；保留本行作为既有守卫的定位锚点）
// —— 运行状态条：字段口径（纯函数；smoke §148 直接 eval 这段做行为断言） ——
// 阶段只有五档（等首帧 / 解码中 / 执行工具 / 已中止 / 空闲）——服务端的 phase 文案更细
// （发请求（等首帧）/ 解码中（收到增量）/ 执行工具 bash / 排队等待本地端点…），这里收敛成用户能一眼读懂的五档。
function normalizeRunPhase(rawPhase, isGenerating, aborted){
  if(aborted) return '已中止';
  if(!isGenerating) return '空闲';
  const p=String(rawPhase||'');
  if(/已中止|已停止|aborted|stalled/.test(p)) return '已中止';
  if(/解码/.test(p)) return '解码中';
  if(/执行工具|等待权限确认|待发请求|子\s?Agent|工具/.test(p)) return '执行工具';
  return '等首帧';
}
function fmtRunTtft(ms){ return ms==null || !Number.isFinite(Number(ms)) ? '—' : (Number(ms)/1000).toFixed(1)+'s'; }
function fmtRunTps(v){ return v==null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1); }
function fmtRunTools(n){ const k=Math.max(0,Math.round(Number(n)||0)); return k===0 ? '0 次工具调用' : k+' 次工具调用'; }
function fmtRunCost(cost){ const m=String(cost||'').match(/≈¥[0-9.]+/); return m ? m[0] : ''; }
function fmtRunCtx(st){
  const total=Number(st.contextTotal)||0;
  const used=Math.max(0,Math.round(Number(st.contextUsed)||0));
  if(!total && !used) return '—';
  // 生成中没有实时 used tokens（内核 budget 只在 done 算）：用「上一轮 used + 本轮字符估算」，
  // 必须标 ≈；done 带回 budget 后才是精确值（去掉 ≈）。
  const approx=st.contextApprox !== false;
  return (approx?'≈ ':'')+fmtTok(used)+' / '+(total?fmtTok(total):'?')+' tokens';
}
function runStripView(st, isGenerating){
  return {
    phase: normalizeRunPhase(st.rawPhase, isGenerating !== false, st.aborted),
    ttft: fmtRunTtft(st.ttftMs),
    tps: fmtRunTps(st.tokensPerSec),
    ctx: fmtRunCtx(st),
    tools: fmtRunTools(st.toolCalls),
    cost: fmtRunCost(st.cost) || '—',
  };
}
/** 把一条 progress 事件并进运行状态（桩 SSE 与真实 SSE 走同一条路径）。 */
function applyRunProgress(st, ev, baseUsed){
  st.rawPhase=String(ev.phase||'');
  st.phase=normalizeRunPhase(st.rawPhase, true, false);
  if(ev.ttftMs!=null) st.ttftMs=Number(ev.ttftMs)||0;
  st.tokensPerSec=ev.tokensPerSec!=null ? Number(ev.tokensPerSec) : null;
  st.toolCalls=Number(ev.toolCalls)||0;
  st.contentChars=Number(ev.contentChars)||0;
  st.contextApprox=true;
  st.contextUsed=Math.max(0, Number(baseUsed)||0) + Math.round(st.contentChars/1.5);
  return st;
}
function permissionSourceLabel(source){
  return ({explicit:'显式选择',preset:'预设',config:'config 默认',cli:'命令行',default:'内置默认'})[String(source||'')] || '未知';
}

// —— 状态条渲染（**唯一**刷新出口；合并原 #workStatus / 顶部活动条 / 消息内气泡三处） ——
function renderWorkStatus(){
  const el=$('#runStrip'); if(!el) return;
  const view=runStripView(runState, generating);
  const set=(id,text)=>{ const n=$(id); if(n) n.textContent=text; };
  set('#rsPhase', view.phase);
  set('#rsTtft', view.ttft);
  set('#rsTps', view.tps);
  set('#rsCtx', view.ctx);
  set('#rsTools', view.tools);
  set('#rsCost', view.cost);
  const ctxBar=$('#rsCtxBar');
  if(ctxBar){
    const usedCtx=Math.max(0, Number(runState.contextUsed)||0);
    const totalCtx=Number(runState.contextTotal)||0;
    ctxBar.style.width=(totalCtx?Math.min(100, Math.round((usedCtx/totalCtx)*100)):0)+'%';
  }
  const rsDot=$('#rsDot');
  if(rsDot) rsDot.className='pdot rs-dot '+(view.phase==='已中止'?'stop':(generating?'acting':'idle'));
  el.classList.toggle('rs-busy', generating && view.phase!=='已中止');
  el.classList.toggle('rs-acting', view.phase==='执行工具');
  el.classList.toggle('rs-aborted', view.phase==='已中止');
  const detail=[];
  if(runState.detail) detail.push(runState.detail);
  if(runState.permissionMode) detail.push('权限 '+runState.permissionMode+'（来源：'+permissionSourceLabel(runState.permissionSource)+'）');
  const d=$('#rsDetail'); if(d) d.textContent=detail.join(' · ');
  el.setAttribute('aria-label','运行状态：'+view.phase+' · 首帧 '+view.ttft+' · 吞吐 '+view.tps+' tok/s · 上下文 '+view.ctx+' · 工具 '+view.tools+' · 本轮费用 '+view.cost);
  // 后台任务 chip：保留原「🛠 N 个后台任务运行中 — 点击查看详情」语义，收进同一行（空闲时才显示）
  const bg=$('#rsBg');
  if(bg){
    if(bgRunning>0 && !generating){
      const running=bgTasks.filter((/** @type {any} */ t)=>t.status==='running');
      const latest=running.length?running[running.length-1]:null;
      bg.style.display=''; bg.textContent='🛠 '+bgRunning+' 个后台任务运行中'+(latest?' · '+String(latest.message||'').slice(0,22):'')+' — 点击查看详情';
      bg.onclick=()=>{ const tp=$('#tasksPanel'); tp.style.display = tp.style.display==='none'?'flex':'none'; if(tp.style.display==='flex'){ $('#trajPanel').style.display='none'; $('#subPanel').style.display='none'; updateTasksPanel(); } syncPanelLayout(); };
    } else { bg.style.display='none'; bg.onclick=null; }
  }
  // P1-4：右栏「本轮运行」与状态条**同源**——renderRunPanel() 内部只走 runPanelView()→runStripView()，
  // 没有第二套计算/第二个数据源。状态条每次刷新（progress/usage/done）右栏随同一帧更新。
  renderRunPanel();
}

// ============================================================================
// P1 纯函数（v0.6.19 §3.70；smoke §149 直接 eval 这段做行为断言，不碰 DOM）：
// 工具时间线视图 / 本轮运行面板视图 / 命令面板过滤与构建 / 设置搜索 / 主题 / 断点 /
// 会话设置文案。DOM 渲染在下面各自的小节里，只消费这些结果。
// ============================================================================

// —— 工具时间线：同一轮多个调用聚合成一张卡（默认前 3 步 + 失败步，整卡可折叠） ——
const TOOL_TL_DEFAULT_VISIBLE = 3;
const TOOL_OUTPUT_PREVIEW = 900;
/** 工具参数的**一行**摘要（完整参数在展开区里用 JSON 显示）。 */
function toolArgsSummary(name, args) {
  const a = args || {};
  if (name === 'bash') return String(a.command || '');
  if (name === 'task') return String(a.question || a.prompt || a.description || '');
  return String(a.path || a.pattern || a.name || a.query || a.url || a.file || '');
}
/** 工具结果的一行摘要（不是正文；正文在展开区）。 */
function toolResultSummary(ev) {
  if (!ev || ev.result === undefined) return '执行中…';
  const r = ev.result || {};
  if (r.ok === false) return r.error ? String(r.error).split('\n')[0] : '失败';
  if (ev.name === 'bash') return r.timedOut ? '超时' : 'exit ' + (r.exitCode != null ? r.exitCode : 0);
  if (ev.name === 'skill') {
    const m = String(r.output || '').match(/^description:\s*(.+)$/m);
    return m ? m[1].slice(0, 100) : '已加载技能';
  }
  if (ev.name === 'write') return r.bytes != null ? r.bytes + ' 字节' : '已写入';
  if (ev.name === 'edit') return '已修改';
  if (ev.name === 'read') return r.lines != null ? r.lines + ' 行' : '读取完成';
  if (ev.name === 'todo') return '更新任务清单';
  const out = String(r.output || r.stdout || r.stderr || '');
  return out.split('\n')[0].slice(0, 120);
}
/** 工具输出的完整文本（展开区用）。 */
function toolOutputText(ev) {
  const r = (ev && ev.result) || {};
  if (ev && ev.name === 'skill') return String(r.output || '');
  if (r.diff) {
    const before = String(r.diff.before || '').split('\n');
    const after = String(r.diff.after || '').split('\n');
    const n = Math.max(before.length, after.length);
    const out = [];
    for (let i = 0; i < n; i++) {
      if (before[i] === after[i]) out.push(' ' + (before[i] || ''));
      else {
        if (before[i] !== undefined) out.push('- ' + before[i]);
        if (after[i] !== undefined) out.push('+ ' + after[i]);
      }
    }
    return out.join('\n');
  }
  if (ev && ev.name === 'bash') return [r.stdout, r.stderr].filter(Boolean).join('\n') || ('exit ' + (r.exitCode != null ? r.exitCode : 0));
  if (r.output != null) return String(r.output);
  if (r.error != null) return String(r.error);
  return ev && ev.result !== undefined ? JSON.stringify(r, null, 2) : '';
}
/** 长输出折叠判据：给出完整文本、预览、行数与字节数（用户要知道被折了多少）。 */
function toolOutputStats(text, limit) {
  const full = String(text == null ? '' : text);
  const max = Number(limit) || TOOL_OUTPUT_PREVIEW;
  const lines = full === '' ? 0 : full.split('\n').length;
  let bytes = full.length;
  try { bytes = new TextEncoder().encode(full).length; } catch { bytes = full.length; }
  const truncated = full.length > max || lines > 40;
  const preview = !truncated ? full : (full.length > max ? full.slice(0, max) : full.split('\n').slice(0, 40).join('\n'));
  return { full, preview, lines, bytes, truncated };
}
/** 单步视图（失败高亮类名 / 状态图标 / 一行摘要 / 完整参数与输出）。 */
function toolStepView(ev, done) {
  const isDone = done !== undefined ? Boolean(done) : ev.result !== undefined || ev.denied;
  const failed = Boolean(ev.denied) || (ev.result !== undefined && ev.result && ev.result.ok === false);
  const out = toolOutputStats(toolOutputText(ev));
  return {
    seq: ev.seq,
    name: String(ev.name || 'tool'),
    args: toolArgsSummary(ev.name, ev.args),
    argsJson: JSON.stringify(ev.args || {}, null, 2),
    durationMs: ev.durationMs != null ? Number(ev.durationMs) : null,
    dur: ev.durationMs != null ? fmtToolDur(ev.durationMs) : (isDone ? '—' : '执行中…'),
    done: isDone,
    failed,
    stIcon: !isDone ? '…' : failed ? '✖' : '✓',
    stCls: !isDone ? '' : failed ? 'bad' : 'ok',
    result: ev.denied ? String(ev.denied || '未授权') : toolResultSummary(ev),
    output: out,
    liClass: 'tl-step' + (failed ? ' fail' : ''),
  };
}
function fmtToolDur(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
}
/** 时间线汇总：步数 / 失败数 / 总耗时 / 头行文案。 */
function toolTimelineSummary(items) {
  const list = items || [];
  const failed = list.filter((s) => s.failed).length;
  const totalMs = list.reduce((a, s) => a + (Number(s.durationMs) || 0), 0);
  const detail = list.length + ' 步' + (failed ? ' · ' + failed + ' 个失败' : '');
  return {
    count: list.length,
    failed,
    totalMs,
    countText: detail,
    sumText: totalMs ? fmtToolDur(totalMs) : '',
  };
}
/** 默认可见步：前 3 步 + 所有失败步（失败步免展开可见）。 */
function toolTimelineVisibility(items, expanded) {
  const list = items || [];
  if (expanded) return list.map((_, i) => i);
  const keep = new Set();
  for (let i = 0; i < Math.min(TOOL_TL_DEFAULT_VISIBLE, list.length); i++) keep.add(i);
  list.forEach((s, i) => { if (s.failed) keep.add(i); });
  return [...keep].sort((a, b) => a - b);
}

// —— 右侧「本轮运行」：六项字段与状态条同源（都从 runStripView 派生） ——
function runPanelView(st, isGenerating) {
  const base = runStripView(st, isGenerating);
  return {
    phase: base.phase,
    ttft: base.ttft,
    tps: base.tps,
    ctx: base.ctx,
    tools: base.tools,
    cost: base.cost,
    model: st.turnModel || st.modelName || '—',
    modelLabel: st.modelLabel || '',
    modelSource: '设置 › 模型与密钥',
    preset: st.presetName || '无预设',
    permission: st.permissionMode || 'ask',
    permissionSource: st.permissionSource || 'default',
    permissionSourceLabel: permissionSourceLabel(st.permissionSource),
  };
}

// —— 命令面板：构建 / 过滤 / 键盘选择（纯函数；执行动作由调用方注入） ——
function paletteFilter(list, q) {
  const terms = String(q == null ? '' : q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return (list || []).slice();
  return (list || []).filter((c) => {
    const hay = [c.group, c.label, c.hint, c.scope, c.keywords].join(' ').toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
function paletteNext(key, index, length) {
  const n = Number(length) || 0;
  if (!n) return 0;
  if (key === 'ArrowDown') return Math.min(Number(index) + 1, n - 1);
  if (key === 'ArrowUp') return Math.max(Number(index) - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return Number(index) || 0;
}
/** 构建命令列表。compactAvailable=false（Web 端当前没有 /api/compact）时**不列** /compact。 */
function buildPaletteCommands(src, act) {
  const s = src || {};
  const a = act || {};
  const out = [];
  const add = (group, label, extra) => out.push(Object.assign({ group, label, hint: '', scope: '', keywords: '', run: null }, extra || {}));
  add('会话', '新对话', { keywords: 'new chat 新会话', run: a.newChat });
  for (const sess of s.sessions || []) {
    add('会话', String(sess.label || sess.file), { hint: '切换会话', keywords: String(sess.file || ''), run: () => a.switchSession && a.switchSession(sess.file) });
  }
  for (const w of s.workspaces || []) {
    add('工作空间', String(w.name || w), { hint: w.name === s.currentWorkspace ? '当前' : '切换', keywords: String(w.dir || ''), run: () => a.switchWorkspace && a.switchWorkspace(w.name || w) });
  }
  add('工作空间', '选择目录 / 新建工作空间…', { hint: '目录选择器', keywords: '新建 workspace add', run: a.newWorkspace });
  for (const m of s.models || []) {
    // §3.71：⌘K 与模型下拉显示同一个显示名；执行/选择仍用 API id。旧快照没有 id 时才退回 name 展示。
    const mid = String((m && (m.id || m.name)) || m || '');
    const mtext = m && m.id ? String(m.label || m.id) : String((m && (m.name || m.label)) || m || '');
    add('模型', mtext, { hint: 'API id: ' + mid, scope: '全局', keywords: [m.label, m.id, m.name, m.providerLabel].filter(Boolean).join(' '), run: () => a.setModel && a.setModel(mid) });
  }
  add('预设', '无预设', { hint: '恢复默认', scope: '本轮', keywords: 'none preset', run: () => a.setPreset && a.setPreset('') });
  for (const p of s.presets || []) {
    add('预设', String(p.label || p.name), { hint: p.permission ? '声明权限 ' + p.permission : '切换预设', scope: '本轮', keywords: String(p.description || ''), run: () => a.setPreset && a.setPreset(p.name) });
  }
  const perms = [['ask', '询问（逐次确认）'], ['auto', '自动（直接执行）'], ['readonly', '只读（禁止修改/执行）']];
  for (const [value, label] of perms) {
    add('权限', label, { hint: '切换权限档', scope: '全局+本轮', keywords: 'permission ' + value, run: () => a.setPermission && a.setPermission(value) });
  }
  add('命令', '停止本轮', { hint: 'Esc', keywords: 'stop abort 停止', run: a.stop });
  add('命令', '快捷键表', { hint: '⌘/', keywords: 'keyboard shortcut', run: a.openShortcuts });
  add('命令', '收起 / 展开本轮运行面板', { hint: '右栏', keywords: 'run panel 运行面板', run: a.toggleRunPanel });
  add('命令', '切换明暗主题', { hint: '主题', keywords: 'theme dark light 明暗', run: a.toggleTheme });
  add('命令', '诊断与日志路径', { hint: '排障', keywords: 'diagnostics logs 日志 诊断', run: a.openDiagnostics });
  // 诚实边界：Web 端没有 /api/compact（只有 CLI 的 /compact）——没有就隐藏，不造新后端。
  if (s.compactAvailable) add('命令', '压缩上下文（/compact）', { hint: '压缩', keywords: 'compact 压缩 上下文', run: a.compact });
  const settings = [['模型与端点', 'model'], ['运行与超时', 'runtime'], ['权限与沙箱', 'permissions'], ['外观', 'appearance']];
  for (const [label, panel] of settings) {
    add('设置', label, { hint: '打开设置', scope: '设置', keywords: 'settings 设置 ' + panel, run: () => a.openSettings && a.openSettings(panel) });
  }
  return out;
}
function paletteItemHtml(cmd) {
  const esc1 = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return '<span class="label"><b>' + esc1(cmd.label) + '</b></span>'
    + (cmd.scope ? '<span class="scope">' + esc1(cmd.scope) + '</span>' : '')
    + (cmd.hint ? '<span class="hint">' + esc1(cmd.hint) + '</span>' : '');
}

// —— 会话设置：模型 label + API id 副标题 / 权限生效值与来源 ——
function modelDisplay(m) {
  // v0.6.20（§3.71）：id 是 API 实际模型名（请求/选择键），label 才是给人看的显示名。
  const id = String((m && (m.id || m.name)) || m || '');
  const name = id;
  const label = String((m && m.label) || name);
  return { id, name, label, subtitle: 'API id: ' + name };
}
function permissionDisplay(mode, source) {
  return 'permission=' + String(mode || 'ask') + '（来源：' + String(source || 'default') + '）';
}
function sessionEffectiveLine(v) {
  const x = v || {};
  return '本轮实际生效：' + (x.modelLabel || x.model || '—') + ' · 权限 ' + (x.permission || 'ask')
    + '（来源：' + (x.sourceLabel || 'default') + '） · 预设 ' + (x.preset || '无预设');
}

// —— 设置搜索：按标题 / 说明 / placeholder / data-kw 过滤；不匹配项必须带 hidden ——
function matchSettingsQuery(text, q) {
  const terms = String(q == null ? '' : q).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = String(text == null ? '' : text).toLowerCase();
  return terms.every((t) => hay.includes(t));
}
function settingsRowSearchText(el) {
  if (!el) return '';
  const parts = [el.textContent || '', el.getAttribute ? el.getAttribute('data-kw') || '' : '', el.getAttribute ? el.getAttribute('title') || '' : ''];
  if (el.querySelectorAll) {
    el.querySelectorAll('input,select,textarea,button').forEach((n) => {
      parts.push(n.placeholder || '', n.title || '', n.textContent || '');
    });
  }
  return parts.join(' ').toLowerCase();
}
function applySettingsFilter(rows, q) {
  const searching = String(q == null ? '' : q).trim().length > 0;
  let hits = 0;
  for (const row of rows || []) {
    const el = row && row.el ? row.el : row;
    if (!el) continue;
    const text = row && row.text != null ? row.text : settingsRowSearchText(el);
    const ok = !searching || matchSettingsQuery(text, q);
    el.hidden = searching ? !ok : false;
    if (el.classList) el.classList.toggle('search-hit', searching && ok);
    if (searching && ok) hits += 1;
  }
  return hits;
}

// —— 空态：无消息且非生成中才显示；示例任务只填入输入框，不发送 ——
function shouldShowEmpty(chatChildCount, isGenerating) {
  return Number(chatChildCount) === 0 && !isGenerating;
}

// —— 主题：显式偏好优先；未显式选择时跟随系统 prefers-color-scheme ——
const THEME_KEY = 'mingdao-theme';
function resolveTheme(pref, systemPrefersDark) {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark ? 'dark' : 'light';
}
function storedThemePref(storage) {
  try {
    const v = storage && storage.getItem ? storage.getItem(THEME_KEY) : null;
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch { return 'system'; }
}
function applyThemePreference(pref, deps) {
  const p = pref === 'light' || pref === 'dark' ? pref : 'system';
  const theme = resolveTheme(p, Boolean(deps && deps.systemPrefersDark));
  if (deps && deps.root) deps.root.setAttribute('data-theme', theme);
  if (deps && deps.storage) {
    try { deps.storage.setItem(THEME_KEY, p); } catch { /* 隐私模式/配额满：不阻断界面 */ }
  }
  return { pref: p, theme };
}

// —— 轨迹 / 子 Agent 视图（v0.6.21 §3.73；smoke §151 直接 eval 这段做行为断言） ——
// 唯一统计口径：对话流每轮那一行摘要与右栏「轨迹」都走 traceRoundView / traceSummaryText，
// 由 traceRoundForMsg 统一装配。**不允许**两处各算一套（§151 断言两处都调用同一函数）。
function fmtTraceDur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + 's';
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return m + 'm' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return h + 'h' + (rm ? rm + 'm' : '');
}
/** 子代理一行的视图：名称 · 轮次 · 工具次数 · 最后进展 · 状态（缺失字段如实显示 —，不编造）。 */
function subagentRowView(sub) {
  const s = sub || {};
  const toolCalls = s.toolCalls == null || !Number.isFinite(Number(s.toolCalls)) ? null : Math.max(0, Math.round(Number(s.toolCalls)));
  const modelRounds = s.modelRounds == null || !Number.isFinite(Number(s.modelRounds)) ? null : Math.max(0, Math.round(Number(s.modelRounds)));
  const ago = s.lastProgressAgoMs == null || !Number.isFinite(Number(s.lastProgressAgoMs)) ? null : Math.max(0, Math.round(Number(s.lastProgressAgoMs)));
  const running = Boolean(s.running);
  const failed = !running && (s.status === 'failed' || Boolean(s.result && s.result.ok === false));
  const status = running ? 'running' : failed ? 'failed' : 'done';
  const round = Math.max(0, Math.round(Number(s.round) || 0));
  return {
    key: 'sub:' + String(s.seq == null ? '?' : s.seq),
    seq: s.seq,
    round,
    roundText: round ? '第 ' + round + ' 轮' : '—',
    name: String(s.label || s.description || s.question || '子代理').slice(0, 80),
    question: String(s.question || ''),
    toolCalls,
    toolText: toolCalls == null ? '工具次数 —' : toolCalls + ' 次工具',
    modelRounds,
    roundsText: modelRounds == null ? '自身轮次 —' : modelRounds + ' 轮',
    progress: ago == null ? '最后进展 —' : '最后进展 ' + (ago < 1000 ? '<1s' : Math.round(ago / 1000) + 's') + ' 前',
    status,
    statusText: running ? '运行中' : failed ? '失败' : '完成',
    statusCls: running ? 'run' : failed ? 'bad' : 'ok',
    running,
    durationMs: s.durationMs == null ? null : Number(s.durationMs),
    result: s.result,
  };
}
/** 一轮的完整视图（工具步 + 子代理 + 摘要文案）；对话流与右栏消费同一个对象。 */
function traceRoundView(round) {
  const r = round || {};
  const now = Number(r.now) || Date.now();
  const tools = (r.tools || []).map((t) => toolStepView(t, t.done));
  const subs = (r.subs || []).map(subagentRowView);
  const started = Number(r.startedAt) || 0;
  const ended = r.endedAt != null ? Number(r.endedAt) : now;
  const durationMs = started ? Math.max(0, ended - started) : 0;
  const durationText = started ? fmtTraceDur(durationMs) : '';
  const parts = ['本轮 ' + tools.length + ' 次工具调用'];
  if (subs.length) parts.push(subs.length + ' 个子代理');
  if (durationText) parts.push(durationText);
  return {
    round: Math.max(0, Math.round(Number(r.round) || 0)),
    tools,
    subs,
    toolCount: tools.length,
    subCount: subs.length,
    failed: tools.filter((t) => t.failed).length,
    durationMs,
    durationText,
    summary: parts.join(' · '),
  };
}
function traceSummaryText(view) { return String((view && view.summary) || ''); }
/** 每轮的数据装配：只读 msg._traj 与传入的 sessionSubs/pending，不读 runState、不另算。 */
function traceRoundData(msg, subs, pending, now) {
  const m = msg || {};
  const round = Math.max(0, Math.round(Number(m._round) || 0));
  const tools = (m._traj || []).filter((t) => t.kind === 'tool');
  const list = (subs || []).filter((s) => s && (s.msg === msg || (round && Number(s.round) === round)));
  if (pending && pending.msg === msg && pending.running && !list.some((s) => s.seq != null && s.seq === pending.seq)) list.push(pending);
  return { round, startedAt: m._startedAt, endedAt: m._endedAt, now, tools, subs: list };
}
/** 子代理运行中的实时快照（progress 事件已有字段；不新增轮询）。 */
function mergeSubagentProgress(pending, sub) {
  if (!pending || !sub) return pending;
  const toolCalls = sub.toolCalls != null ? Number(sub.toolCalls) : pending.toolCalls;
  const modelRounds = sub.modelRounds != null ? Number(sub.modelRounds) : pending.modelRounds;
  return Object.assign({}, pending, {
    toolCalls: Number.isFinite(toolCalls) ? toolCalls : pending.toolCalls,
    modelRounds: Number.isFinite(modelRounds) ? modelRounds : pending.modelRounds,
    lastProgressAgoMs: sub.ms != null ? Number(sub.ms) : pending.lastProgressAgoMs,
    label: String(sub.label || pending.label || '子代理'),
    running: true,
    status: 'running',
  });
}
/** 窄窗口（<1180 右栏收起）且右栏不可见时，轨迹落到对话流末尾的可折叠区块。 */
function traceDockVisible(width, panelVisible) {
  return layoutClassesFor(width).narrowRun && !panelVisible;
}
/** 点摘要时的定位目标：窄屏 → 末尾区块；宽屏/抽屉已开 → 右侧面板。 */
function traceFocusTarget(width, panelVisible) {
  return traceDockVisible(width, panelVisible) ? 'dock' : 'panel';
}

// —— 窄屏断点：<900 侧栏收起；<1180 右栏收起（同一判据供 initResponsive 与断言使用） ——
function layoutClassesFor(width) {
  const w = Number(width) || 0;
  return { narrow: w < 900, narrowRun: w < 1180 };
}

// ============================================================================
// P2 纯函数（v0.6.19 §3.76）
//   设置三列（默认 / 当前 / 影响）、六类危险操作的二次确认闸门、对话框无障碍
//   （role/aria-modal/焦点陷阱/Esc/焦点归还）、aria-live 状态节流、对比度自检。
// test/ui-p2.js 直接 eval 这一整段做行为断言；DOM 接线在下面的 P2 DOM 段。
// 注意：本段**不得**在顶层调用 t()/translate()/document（slice 后要能独立编译）。
// ============================================================================

// —— 设置项三列：key → 一句「影响」（前端映射表；英文文案在 i18n.js 的 impact.*） ——
const SETTING_KEYS = ['permission', 'sandbox', 'routing', 'contextBudget', 'timeout', 'autostart', 'notify', 'theme', 'language'];
const SETTING_IMPACT = {
  permission: '切到 auto 会跳过逐次确认，工具直接执行；切到 readonly 会拒绝所有写操作。',
  sandbox: '关掉沙箱后 bash 直接在本机执行；readonly/safe 会限制只读与断网，但需要 Linux + bubblewrap。',
  routing: '开启后规划类任务走 pro、执行类走 flash；关闭则始终用当前模型，成本与延迟更可预测。',
  contextBudget: '改小 contextBudget 会减少可容纳历史，长任务更易触发压缩；改大受模型窗口与实际引擎上限约束。',
  timeout: '首 token / 流式空闲 / 总量调小会更早判定超时；留空表示按本地/云端模型自适应。',
  autostart: '开启后登录系统即自动启动本地服务；关闭后需要手动运行 mingdao web。',
  notify: '关闭后后台任务完成或失败不再发桌面通知，只能回到界面查看。',
  theme: '只改变界面明暗，不影响模型与成本；选「跟随系统」时随系统偏好切换。',
  language: '只改变界面文案语言，不改变日志、错误原文与会话内容。',
  memory: '长期记忆会在每次会话中注入；清空后偏好与约定全部丢失，且不可恢复。',
};
// 与 /api/state.defaults 同值的兜底：服务端字段读不到时仍能诚实显示「默认」列（来源写在设置页）。
const SETTING_DEFAULTS_FALLBACK = {
  permission: 'ask',
  sandbox: 'off',
  routing: false,
  contextBudget: 128000,
  timeout: { firstTokenMs: null, streamIdleMs: null, totalMs: null },
  autostart: false,
  notify: true,
  reasoningEffort: 'high',
  theme: 'system',
  language: 'auto',
};
/** 默认值表：优先用 /api/state.defaults（只读透出），缺字段按同一份兜底补。 */
function settingDefaultsFromState(state) {
  const src = state && state.defaults && typeof state.defaults === 'object' ? state.defaults : {};
  const out = Object.assign({}, SETTING_DEFAULTS_FALLBACK);
  for (const k of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(src, k) && src[k] !== undefined) out[k] = src[k];
  }
  out.timeout = Object.assign({}, SETTING_DEFAULTS_FALLBACK.timeout, src.timeout || {});
  if (src.reasoningEffort !== undefined) out.reasoningEffort = src.reasoningEffort;
  return out;
}
/**
 * 设置项的展示值（不编造：未知值原样显示）。
 * @param {string} key
 * @param {any} value
 * @param {{lang?: string, translate?: Function}} [opts]
 * @returns {string}
 */
function settingDisplayValue(key, value, opts) {
  const o = opts || {};
  const zh = o.lang !== 'en';
  const tx = (/** @type {string} */ k, /** @type {string} */ fallback) => {
    try {
      const s = typeof o.translate === 'function' ? o.translate(zh ? 'zh' : 'en', k) : '';
      return s || fallback;
    } catch { return fallback; }
  };
  if (key === 'timeout') {
    const t0 = value && typeof value === 'object' ? value : {};
    const n = (/** @type {any} */ v) => (v == null || !Number.isFinite(Number(v)) || Number(v) <= 0 ? null : Number(v));
    const a = n(t0.firstTokenMs), b = n(t0.streamIdleMs), c = n(t0.totalMs);
    if (a == null && b == null && c == null) return tx('settings.auto', zh ? '自适应（留空）' : 'Auto (blank)');
    return [a == null ? null : '首帧 ' + Math.round(a / 1000) + 's', b == null ? null : '空闲 ' + Math.round(b / 1000) + 's', c == null ? null : '总量 ' + Math.round(c / 1000) + 's']
      .filter(Boolean).join(' · ');
  }
  if (typeof value === 'boolean') return value ? tx('settings.on', zh ? '开' : 'On') : tx('settings.off', zh ? '关' : 'Off');
  if (value == null || value === '') return '—';
  return String(value);
}
/**
 * 单个设置项的三列视图（默认 / 当前 / 影响）。
 * @param {string} key
 * @param {{defaults?: any, values?: any, lang?: string, translate?: Function}} [opts]
 * @returns {{key: string, defaultText: string, currentText: string, impact: string, changed: boolean}}
 */
function settingValueView(key, opts) {
  const o = opts || {};
  const defaults = o.defaults && typeof o.defaults === 'object' ? o.defaults : SETTING_DEFAULTS_FALLBACK;
  const values = o.values && typeof o.values === 'object' ? o.values : defaults;
  const hasCurrent = Object.prototype.hasOwnProperty.call(values, key);
  const defaultValue = Object.prototype.hasOwnProperty.call(defaults, key) ? defaults[key] : undefined;
  const currentValue = hasCurrent ? values[key] : defaultValue;
  const lang = o.lang === 'en' ? 'en' : 'zh';
  let impact = '';
  try {
    impact = (typeof o.translate === 'function' ? o.translate(lang, 'impact.' + key) : '') || SETTING_IMPACT[key] || '';
  } catch {
    impact = SETTING_IMPACT[key] || '';
  }
  return {
    key,
    defaultText: settingDisplayValue(key, defaultValue, o),
    currentText: settingDisplayValue(key, currentValue, o),
    impact,
    changed: settingDisplayValue(key, defaultValue, o) !== settingDisplayValue(key, currentValue, o),
  };
}
/**
 * 全部设置项的三列视图（HTML 里有几个 data-setting，这里就应覆盖几个）。
 * @param {{keys?: string[], defaults?: any, values?: any, lang?: string, translate?: Function}} [opts]
 * @returns {ReturnType<typeof settingValueView>[]}
 */
function settingColumnsView(opts) {
  const o = opts || {};
  const keys = Array.isArray(o.keys) && o.keys.length ? o.keys : SETTING_KEYS;
  return keys.map((k) => settingValueView(k, o));
}

// —— 六类危险操作：先确认、后执行（取消 → 绝不执行） ——
const DANGER_ACTIONS = {
  removeWorkspace: {
    titleKey: 'danger.removeWorkspace.title',
    consequenceKey: 'danger.removeWorkspace.consequence',
    titleFallback: '删除工作空间',
    consequenceFallback: '将从工作空间列表中移除该登记项；目录本身与其中的文件不会被删除，但依赖该空间的历史会话会失去一键切换入口。',
  },
  deleteSession: {
    titleKey: 'danger.deleteSession.title',
    consequenceKey: 'danger.deleteSession.consequence',
    titleFallback: '删除会话',
    consequenceFallback: '会话记录文件将被永久删除，无法恢复；若删的是当前会话，界面会回到空态。',
  },
  clearMemory: {
    titleKey: 'danger.clearMemory.title',
    consequenceKey: 'danger.clearMemory.consequence',
    titleFallback: '清空记忆',
    consequenceFallback: '长期记忆文件将被清空，注入每次会话的偏好与约定全部丢失，且不可恢复。',
  },
  resetConfig: {
    titleKey: 'danger.resetConfig.title',
    consequenceKey: 'danger.resetConfig.consequence',
    titleFallback: '恢复默认配置',
    consequenceFallback: '权限、沙箱、路由、上下文预算、超时、开机自启、通知将回到内置默认值；模型与 API Key 不受影响。',
  },
  permissionAuto: {
    titleKey: 'danger.permissionAuto.title',
    consequenceKey: 'danger.permissionAuto.consequence',
    titleFallback: '切换到「自动」权限',
    consequenceFallback: '之后写文件与执行命令不再逐次确认；模型可能在你未看清内容时修改文件或运行命令。',
  },
  sandboxOff: {
    titleKey: 'danger.sandboxOff.title',
    consequenceKey: 'danger.sandboxOff.consequence',
    titleFallback: '关闭沙箱',
    consequenceFallback: 'bash 将不再受只读/断网限制，直接在本机执行；沙箱提供的最外层隔离同时失效。',
  },
};
const DANGER_KEYS = ['removeWorkspace', 'deleteSession', 'clearMemory', 'resetConfig', 'permissionAuto', 'sandboxOff'];
/**
 * 危险操作的标题 / 后果 / 按钮文案（未知 key 返回 null；绝不返回 undefined 文案）。
 * @param {string} key
 * @param {Function} [translateFn] 形如 translate(lang, key)
 * @param {string} [lang]
 * @returns {{key: string, title: string, consequence: string, confirmLabel: string, cancelLabel: string, note: string}|null}
 */
function dangerMeta(key, translateFn, lang) {
  const a = DANGER_ACTIONS[key];
  if (!a) return null;
  const l = lang === 'en' ? 'en' : 'zh';
  const tr = (/** @type {string} */ k, /** @type {string} */ fallback) => {
    try {
      const s = typeof translateFn === 'function' ? translateFn(l, k) : '';
      return s || fallback;
    } catch { return fallback; }
  };
  return {
    key,
    title: tr(a.titleKey, a.titleFallback),
    consequence: tr(a.consequenceKey, a.consequenceFallback),
    confirmLabel: tr('danger.confirm', '确认'),
    cancelLabel: tr('danger.cancel', '取消'),
    note: tr('danger.note', '需要点击「确认」才会执行；按回车不会确认，Esc 取消。'),
  };
}
/** 这两个档位切换是否属于危险操作（同值切换不算）。 */
function dangerGateNeeded(key, from, to) {
  if (key === 'permissionAuto') return String(to) === 'auto' && String(from) !== 'auto';
  if (key === 'sandboxOff') return String(to) === 'off' && String(from) !== 'off';
  return false;
}
/**
 * 危险操作统一入口：**先** await confirm(meta)，取消则直接返回且不执行；确认后才 execute。
 * @param {string} key
 * @param {{confirm: Function, execute: Function, translate?: Function, lang?: string}} deps
 * @returns {Promise<{ok: boolean, cancelled: boolean, result?: any}>}
 */
async function runDanger(key, deps) {
  const d = deps || {};
  const meta = dangerMeta(key, d.translate, d.lang);
  if (!meta) return { ok: false, cancelled: true };
  const answer = await d.confirm(meta);
  const confirmed = answer === true || Boolean(answer && answer.confirmed === true);
  if (!confirmed) return { ok: false, cancelled: true };
  const result = await d.execute(key, meta);
  return { ok: true, cancelled: false, result };
}

// —— 对话框无障碍：role / aria-modal / 焦点陷阱 / Esc / 焦点归还 ——
/** 对话框内可聚焦元素（按 DOM 顺序）。 */
function dialogFocusables(el) {
  if (!el || typeof el.querySelectorAll !== 'function') return [];
  try {
    return Array.from(el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'))
      .filter((n) => n && !n.hidden);
  } catch { return []; }
}
/** Tab / Shift+Tab 的目标下标（纯函数；index<0 表示焦点在对话框外）。 */
function trapTabTarget(shift, index, count) {
  const n = Number(count) || 0;
  if (n <= 0) return -1;
  const i = Number(index);
  if (!Number.isFinite(i) || i < 0) return shift ? n - 1 : 0;
  return shift ? (i - 1 + n) % n : (i + 1) % n;
}
/** 给元素补 dialog 语义（role=dialog + aria-modal=true + aria-label）。 */
function applyDialogSemantics(el, label) {
  if (!el || typeof el.setAttribute !== 'function') return el;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  if (label) el.setAttribute('aria-label', String(label));
  return el;
}
/**
 * 安装对话框行为：焦点陷阱（Tab/Shift+Tab 循环）、Esc 关闭、关闭后焦点回到触发元素。
 * @param {any} el
 * @param {{document?: any, opener?: any, label?: string, initialFocus?: any, onClose?: Function}} [opts]
 * @returns {{close: Function, focusables: Function, element: any}}
 */
function installDialog(el, opts) {
  const o = opts || {};
  const doc = o.document || (typeof document !== 'undefined' ? document : null);
  const opener = o.opener || (doc && doc.activeElement) || null;
  applyDialogSemantics(el, o.label);
  let closed = false;
  const focusables = () => dialogFocusables(el);
  const onKey = (/** @type {any} */ e) => {
    if (closed || !e) return;
    if (e.key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      close(false);
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      if (e.preventDefault) e.preventDefault();
      const active = doc && doc.activeElement;
      const idx = list.indexOf(active);
      const next = trapTabTarget(Boolean(e.shiftKey), idx, list.length);
      const target = list[next];
      if (target && typeof target.focus === 'function') {
        try { target.focus(); } catch { /* 桩 DOM */ }
      }
    }
  };
  if (doc && typeof doc.addEventListener === 'function') doc.addEventListener('keydown', onKey, true);
  const initial = o.initialFocus || focusables()[0] || null;
  if (initial && typeof initial.focus === 'function') {
    try { initial.focus(); } catch { /* 桩 DOM */ }
  }
  /** 关闭并归还焦点（onClose 只调用一次）。 */
  function close(result) {
    if (closed) return;
    closed = true;
    if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('keydown', onKey, true);
    if (typeof o.onClose === 'function') {
      try { o.onClose(result); } catch { /* 关闭路径不再抛 */ }
    }
    if (opener && typeof opener.focus === 'function') {
      try { opener.focus(); } catch { /* 桩 DOM */ }
    }
  }
  return { close, focusables, element: el };
}

// —— aria-live：只在状态变化时播报（同一状态重复渲染不打扰读屏） ——
function liveSnapshot(view) {
  const v = view || {};
  return JSON.stringify({
    phase: String(v.phase || ''),
    tools: Number(v.toolCount) || 0,
    failed: Number(v.failed) || 0,
    subs: (v.subs || []).map((/** @type {any} */ s) => String((s && s.status) || '')).join(','),
  });
}
/**
 * @param {string} prevSnapshot
 * @param {any} view
 * @returns {{changed: boolean, snapshot: string, text: string}}
 */
function liveAnnouncement(prevSnapshot, view) {
  const snap = liveSnapshot(view);
  if (snap === prevSnapshot) return { changed: false, snapshot: snap, text: '' };
  const v = view || {};
  const parts = [String(v.phase || '空闲')];
  if (Number(v.toolCount)) parts.push(Number(v.toolCount) + ' 次工具调用');
  if (Number(v.failed)) parts.push(Number(v.failed) + ' 个失败');
  const subs = v.subs || [];
  const running = subs.filter((/** @type {any} */ s) => s && s.status === 'running').length;
  if (subs.length) parts.push(subs.length + ' 个子代理' + (running ? '（' + running + ' 运行中）' : ''));
  let prefix = '本轮状态：';
  try { prefix = (typeof translate === 'function' && translate(getLang(), 'a11y.livePrefix')) || prefix; } catch { /* 保持中文 */ }
  return { changed: true, snapshot: snap, text: prefix + parts.join(' · ') };
}

// —— 对比度自检（WCAG 相对亮度；只给建议，**不改**主题令牌） ——
const CONTRAST_TOKENS = {
  bg: '#151517', bg2: '#1B1B1C', bg3: '#353638', panel: '#2C2C2E',
  text: '#F9FAFB', dim: '#ADB2B8', faint: '#81858C',
  bgLight: '#FFFFFF', bg3Light: '#EFEFF1', panelLight: '#FFFFFF', textLight: '#18181B', dimLight: '#52525B', faintLight: '#71717A',
};
function hexToRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}
function relativeLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = [r, g, b].map((x) => {
    const c = x / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrastRatio(fg, bg) {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/**
 * 暗/亮两套 token 的正文 / 次要文本对比度。
 * @returns {{fg: string, bg: string, ratio: number, pass: boolean, advice: string}[]}
 */
function contrastAudit() {
  const t0 = CONTRAST_TOKENS;
  const pairs = [
    ['text', 'bg'], ['text', 'panel'], ['text', 'bg3'],
    ['dim', 'bg'], ['dim', 'bg2'], ['dim', 'bg3'], ['dim', 'panel'],
    ['faint', 'bg'], ['faint', 'bg2'], ['faint', 'bg3'], ['faint', 'panel'],
    ['textLight', 'bgLight'], ['dimLight', 'bgLight'], ['dimLight', 'bg3Light'], ['faintLight', 'bg3Light'],
  ];
  return pairs.map(([fg, bg]) => {
    const ratio = contrastRatio(t0[fg], t0[bg]);
    const pass = ratio >= 4.5;
    return {
      fg, bg, ratio, pass,
      advice: pass ? '' : '比值为 ' + ratio + ':1，低于 4.5:1；建议该组合改用 var(--dim)（同色阶，正文/次要文本达标），或把 --faint 只用在 --bg/--bg2 上。',
    };
  });
}

// ============================================================================
// P1 DOM 接线（v0.6.19 §3.70）：主题 / 断点 / 工具时间线 / 右栏 / 命令面板 /
// 快捷键表 / 会话设置 / 空态 / 设置搜索 / 诊断。全部消费上面纯函数的结果。
// ============================================================================
let sessionsCache = [];
let workspacesCache = [];
let currentWorkspaceName = '';
let modelsCache = [];
let homeDir = '';
let workingDirCache = '';
let compactAvailable = false; // Web 端当前没有 /api/compact；为 true 时才显示压缩入口
let runPanelOpen = false;
let responsiveInitialized = false;
// §3.78：右栏标签页（轨迹 / 子Agent / 任务 / 仪表盘）——原 5 个并列面板收编到同一栏。
// RAIL_PANEL_IDS 映射到**原面板 id**（不重命名、不删节点），handler 仍按既有 id 查询。
const RAIL_TABS = ['traj', 'sub', 'tasks', 'dash'];
const RAIL_PANEL_IDS = { traj: 'trajPanel', sub: 'subPanel', tasks: 'tasksPanel', dash: 'dashPanel' };
let railTab = 'traj';
let lastNarrowRun = null;
// —— 轨迹收纳状态（§3.73）：两个折叠区 + 展开过的轮次/工具/子代理（重渲染后保持展开） ——
const traceFoldState = { trace: true, subs: true };
const openTraceRounds = new Set();
const openTraceTools = new Set();
const openTraceSubs = new Set();
let traceAutoOpened = false;

// —— 主题：偏好写 localStorage；显式 light/dark 优先，'system' 跟随系统并实时响应 ——
function themeSystemPrefersDark() {
  try { return window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false; } catch { return false; }
}
function updateThemeButton(theme) {
  const btn = $('#themeBtn');
  if (btn) {
    btn.textContent = theme === 'dark' ? '🌙' : '☀️';
    btn.setAttribute('aria-label', theme === 'dark' ? '当前暗色，切换为亮色' : '当前亮色，切换为暗色');
  }
}
function setThemePreference(pref) {
  const r = applyThemePreference(pref, { root: document.documentElement, storage: window.localStorage, systemPrefersDark: themeSystemPrefersDark() });
  updateThemeButton(r.theme);
  const sel = $('#themeSel'); if (sel) sel.value = r.pref;
  return r;
}
function initTheme() {
  setThemePreference(storedThemePref(window.localStorage));
  try {
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq) {
      const onSystem = () => { if (storedThemePref(window.localStorage) === 'system') setThemePreference('system'); };
      if (mq.addEventListener) mq.addEventListener('change', onSystem);
      else if (mq.addListener) mq.addListener(onSystem);
    }
  } catch { /* 老浏览器没有 matchMedia：保持当前主题 */ }
  const btn = $('#themeBtn');
  if (btn) btn.onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    setThemePreference(cur === 'dark' ? 'light' : 'dark');
  };
  const sel = $('#themeSel');
  if (sel) sel.onchange = () => setThemePreference(sel.value);
}
initTheme();

// —— 右栏「本轮运行」：<1180 收起为抽屉；宽屏默认展开；不做任何新轮询 ——
function syncRunPanel() {
  const el = $('#runPanel'); if (!el) return;
  // 右边缘只留一个抽屉：子 Agent / 任务 / 省钱仪表盘打开时先让运行面板让位
  // （syncPanelLayout 统一算，避免"两个面板各写一份互斥逻辑"）。
  syncPanelLayout();
  const chip = $('#runChip'); if (chip) chip.setAttribute('aria-expanded', runPanelOpen ? 'true' : 'false');
  const col = $('#rpCollapse'); if (col) { col.textContent = '›'; col.title = '收起右栏'; }
}
function setRunPanel(open) { runPanelOpen = Boolean(open); syncRunPanel(); }
function toggleRunPanel() { setRunPanel(!runPanelOpen); }
function applyResponsiveLayout(width) {
  const w = width == null ? (Number(window.innerWidth) || 0) : Number(width) || 0;
  const cls = layoutClassesFor(w);
  document.body.classList.toggle('narrow-side', cls.narrow);
  document.body.classList.toggle('narrow-run', cls.narrowRun);
  // §3.78：<900 侧栏抽屉只在窄屏存在；宽屏恢复时自动关掉，避免盖住正文。
  if (!cls.narrow) document.body.classList.remove('side-drawer');
  // §3.78：宽 → 窄（跨过 1180）时右栏回到"收起 + 运行 chip"，不默认盖在正文上。
  if (cls.narrowRun && lastNarrowRun === false) runPanelOpen = false;
  lastNarrowRun = cls.narrowRun;
  syncRunPanel();
}
function initResponsive() {
  if (!responsiveInitialized) {
    runPanelOpen = !layoutClassesFor(window.innerWidth || 0).narrowRun;
    responsiveInitialized = true;
  }
  applyResponsiveLayout();
  window.addEventListener('resize', () => applyResponsiveLayout());
  const chip = $('#runChip'); if (chip) chip.onclick = toggleRunPanel;
  const col = $('#rpCollapse'); if (col) col.onclick = () => setRunPanel(false);
  // §3.78：<900 侧栏抽屉开关（设计稿在 980 图标化；任务要求"侧栏变抽屉"，见 §3.78 登记）
  const sideToggle = $('#sideToggle');
  if (sideToggle) sideToggle.onclick = () => {
    const on = document.body.classList.toggle('side-drawer');
    sideToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  };
}
initResponsive();
// §3.73：绑定两个折叠区 + 末尾区块总开关（渲染入口在下面的轨迹收纳块）。
initTraceUI();

// —— 工具时间线 DOM：一张卡 + 可复用行（开始/完成不换节点） ——
function toolStepNode(step) {
  const li = document.createElement('li'); li.className = step.liClass;
  const row = document.createElement('button'); row.type = 'button'; row.className = 'tl-row'; row.setAttribute('aria-expanded', 'false');
  const no = document.createElement('span'); no.className = 'tl-no'; no.textContent = '0';
  const st = document.createElement('span'); st.className = 'tl-st ' + (step.stCls || ''); st.textContent = step.stIcon;
  st.setAttribute('aria-live', 'polite'); // P2-3：步骤状态变化时读屏播报（容器另有节流播报）
  const tool = document.createElement('span'); tool.className = 'tl-tool'; tool.textContent = step.name;
  const args = document.createElement('span'); args.className = 'tl-args'; args.textContent = step.args;
  const dur = document.createElement('span'); dur.className = 'tl-dur'; dur.textContent = step.dur;
  const tri = document.createElement('span'); tri.className = 'tl-tri'; tri.setAttribute('aria-hidden', 'true');
  [no, st, tool, args, dur, tri].forEach((n) => row.appendChild(n));
  const res = document.createElement('div'); res.className = 'tl-res'; res.textContent = step.result;
  const out = document.createElement('div'); out.className = 'tl-out'; out.hidden = true;
  const argsFull = document.createElement('div'); argsFull.className = 'tl-args-full';
  const meta = document.createElement('div'); meta.className = 'tl-out-meta';
  const pre = document.createElement('pre');
  const more = document.createElement('button'); more.type = 'button'; more.className = 'tl-out-more'; more.textContent = '展开全文';
  out.appendChild(argsFull); out.appendChild(meta); out.appendChild(pre); out.appendChild(more);
  li.appendChild(row); li.appendChild(res); li.appendChild(out);
  row.onclick = () => {
    const open = out.hidden;
    out.hidden = !open;
    li.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
  };
  const entry = { li, row, out, no, st, tool, args, dur, res, argsFull, meta, pre, more, step, fullOpen: false };
  more.onclick = () => { pre.textContent = step.output.full; more.hidden = true; entry.fullOpen = true; };
  return entry;
}
function paintToolStep(entry, step) {
  if (!entry) return;
  entry.step = step;
  entry.li.className = step.liClass;
  entry.st.className = 'tl-st ' + (step.stCls || '');
  entry.st.textContent = step.stIcon;
  entry.tool.textContent = step.name;
  entry.args.textContent = step.args || '';
  entry.dur.textContent = step.dur || '';
  entry.res.textContent = step.result || '';
  entry.argsFull.textContent = '参数：' + step.argsJson;
  entry.meta.textContent = step.output.truncated
    ? '共 ' + step.output.lines + ' 行 · ' + step.output.bytes + ' 字节（已折叠，点下方展开全文）'
    : step.output.lines + ' 行 · ' + step.output.bytes + ' 字节';
  if (!entry.fullOpen) {
    entry.pre.textContent = step.output.preview;
    entry.more.hidden = !step.output.truncated;
  }
}
function ensureToolTimeline(msg) {
  if (!msg) return null;
  if (msg._toolTimeline) return msg._toolTimeline;
  const card = document.createElement('div'); card.className = 'toolcard';
  const head = document.createElement('div'); head.className = 'toolcard-head';
  const ico = document.createElement('span'); ico.textContent = '🧭'; ico.setAttribute('aria-hidden', 'true');
  const title = document.createElement('b'); title.textContent = '工具时间线';
  const count = document.createElement('span'); count.className = 'tl-count'; count.textContent = '0 步';
  const sum = document.createElement('span'); sum.className = 'tl-sum';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'tl-toggle'; toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '收起';
  [ico, title, count, sum, toggle].forEach((n) => head.appendChild(n));
  const list = document.createElement('ol'); list.className = 'tl-steps';
  const more = document.createElement('button'); more.type = 'button'; more.className = 'tl-more'; more.hidden = true;
  card.appendChild(head); card.appendChild(list); card.appendChild(more);
  const tl = { card, head, count, sum, toggle, list, more, items: [], steps: new Map(), entries: new Map(), expanded: false };
  toggle.onclick = () => {
    const collapsed = card.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.textContent = collapsed ? '展开' : '收起';
  };
  more.onclick = () => { tl.expanded = true; refreshToolTimeline(tl); };
  msg._toolTimeline = tl;
  if (msg.parentNode) msg.parentNode.insertBefore(card, msg);
  else chatEl.appendChild(card);
  return tl;
}
function refreshToolTimeline(tl) {
  if (!tl) return;
  const sum = toolTimelineSummary(tl.items);
  tl.count.textContent = sum.countText;
  tl.sum.textContent = sum.sumText;
  const visible = new Set(toolTimelineVisibility(tl.items, tl.expanded));
  tl.items.forEach((s, i) => {
    const entry = tl.entries.get(s.seq);
    if (entry) {
      paintToolStep(entry, s);
      entry.no.textContent = String(i + 1);
      entry.li.hidden = !visible.has(i);
    }
  });
  const hidden = tl.items.length - visible.size;
  tl.more.hidden = hidden <= 0;
  tl.more.textContent = '展开其余 ' + hidden + ' 步';
  tl.card.classList.toggle('has-fail', sum.failed > 0);
}
function timelineToolStart(msg, ev) {
  const target = msg || activeAiMsg;
  if (!target) return;
  const tl = ensureToolTimeline(target); if (!tl) return;
  const step = toolStepView(ev, false);
  const entry = toolStepNode(step);
  tl.items.push(step); tl.steps.set(ev.seq, step); tl.entries.set(ev.seq, entry);
  tl.list.appendChild(entry.li);
  refreshToolTimeline(tl);
  scrollBottom();
}
function timelineToolDone(msg, ev) {
  const target = msg || activeAiMsg;
  if (!target) return;
  const tl = ensureToolTimeline(target); if (!tl) return;
  let step = tl.steps.get(ev.seq);
  if (!step) {
    step = toolStepView(ev, true);
    const entry = toolStepNode(step);
    tl.items.push(step); tl.steps.set(ev.seq, step); tl.entries.set(ev.seq, entry);
    tl.list.appendChild(entry.li);
  } else {
    Object.assign(step, toolStepView(ev, true));
  }
  refreshToolTimeline(tl);
  scrollBottom();
}
function timelineToolDenied(msg, ev) {
  const target = msg || activeAiMsg;
  if (!target) return;
  const tl = ensureToolTimeline(target); if (!tl) return;
  const fake = { seq: ev.seq, name: ev.name, args: ev.args, denied: ev.reason || '未授权', result: { ok: false, error: ev.reason || '未授权' } };
  const step = tl.steps.get(ev.seq);
  if (step) Object.assign(step, toolStepView(fake, true));
  else {
    const s = toolStepView(fake, true); const entry = toolStepNode(s);
    tl.items.push(s); tl.steps.set(ev.seq, s); tl.entries.set(ev.seq, entry); tl.list.appendChild(entry.li);
  }
  refreshToolTimeline(tl);
}

// —— 右栏渲染（六项 + 模型/权限来源；每次随状态条同一帧刷新） ——
function renderRunPanel() {
  const el = $('#runPanel'); if (!el) return;
  const v = runPanelView(runState, generating);
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  set('#rpPhase', v.phase);
  set('#rpTtft', v.ttft);
  set('#rpTps', v.tps);
  set('#rpCtx', v.ctx);
  const ctxTotalN=Number(runState.contextTotal)||0;
  const ctxUsedN=Math.max(0, Number(runState.contextUsed)||0);
  set('#rpCtxTotal', ctxTotalN?(fmtTok(ctxUsedN)+' / '+fmtTok(ctxTotalN)):'');
  set('#rpTools', v.tools);
  set('#rpCost', v.cost);
  set('#rpModel', v.modelLabel || v.model);
  set('#rpModelId', 'API id: ' + v.model);
  set('#rpModelSrc', '来源：' + v.modelSource);
  set('#rpPreset', v.preset);
  set('#rpPerm', v.permission);
  set('#rpPermSrc', '来源：' + v.permissionSource + '（' + v.permissionSourceLabel + '）');
  const total = Number(runState.contextTotal) || 0;
  const used = Math.max(0, Number(runState.contextUsed) || 0);
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const bar = $('#rpCtxBar'); if (bar) bar.style.width = pct + '%';
  const time = $('#rpTime');
  if (time) time.textContent = generating && curWorkT0 ? Math.max(0, Math.round((Date.now() - curWorkT0) / 1000)) + 's' : '—';
  const stop = $('#rpStop');
  if (stop) { stop.disabled = !generating || stopping; stop.textContent = stopping ? '■ 停止中…' : '■ 停止'; }
  const compact = $('#rpCompact');
  if (compact) compact.hidden = !compactAvailable; // 没有 /api/compact 就不显示，不造后端
  const foot = $('#rpFootNote');
  if (foot) foot.textContent = compactAvailable ? '停止与压缩：与状态条同一条停止出口' : '停止：与状态条同一条停止出口（Web 端无 /compact）';
}
$('#rpStop').onclick = () => stopTurnFromButton();
$('#rpCompact').onclick = () => renderBanner({ text: '⚠ Web 端没有 /compact 端点（只有 CLI 有），本入口未启用。', warn: true });

// ============================================================================
// §3.73 轨迹 / 子 Agent 收纳：
//   · 对话流：每轮只留**一行**摘要（.trace-row > .trace-summary），不再内联工具卡；
//   · 宽屏：详情在右栏「轨迹 / 子Agent」两个可折叠区；
//   · 窄屏（<1180 右栏收起）：同样的两块在对话流末尾的 #traceDock 里（JS 切换 hidden）。
//   · 统计口径：对话流摘要与右栏轮头都调用 traceRoundForMsg → traceRoundView，只有一套。
// ============================================================================
function traceRoundForMsg(msg, now) {
  return traceRoundView(traceRoundData(msg, sessionSubs, pendingSubagent, now));
}
function collectTraceViews() {
  return [...document.querySelectorAll('#chat .msg-ai')]
    .map((m) => traceRoundForMsg(m))
    .filter((v) => v.toolCount || v.subCount);
}
function ensureTraceSummary(msg) {
  if (!msg) return null;
  if (msg._traceRow) return msg._traceRow;
  const row = document.createElement('div');
  row.className = 'trace-row'; row.dataset.traceRow = '1';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'trace-summary';
  btn.dataset.round = String(msg._round || 0);
  btn.dataset.src = 'traceRoundForMsg';
  btn.onclick = () => focusTraceRound(msg._round);
  row.appendChild(btn);
  msg._traceRow = row;
  msg.appendChild(row);
  return row;
}
/** 对话流每轮的那**一行**摘要：文案与右栏轮头同源（traceSummaryText(traceRoundView(...))）。 */
function updateTraceSummary(msg) {
  if (!msg) return;
  const v = traceRoundForMsg(msg);
  if (!v.toolCount && !v.subCount) { if (msg._traceRow) msg._traceRow.hidden = true; return; }
  const row = ensureTraceSummary(msg);
  row.hidden = false;
  const btn = row.querySelector('.trace-summary') || row.firstChild;
  const summary = traceSummaryText(v);
  btn.textContent = '🧭 ' + summary + '  ›';
  btn.dataset.summary = summary;
  btn.dataset.round = String(v.round);
  btn.setAttribute('aria-label', '定位本轮轨迹：' + summary);
  row.classList.toggle('has-fail', v.failed > 0);
  msg.appendChild(row); // 收在本轮正文末尾（不在正文之间堆卡）
}
function traceToolStarted(msg, ev) {
  if (msg && ev && ev.name === 'task') {
    const question = String((ev.args && (ev.args.question || ev.args.prompt)) || '');
    pendingSubagent = {
      seq: ev.seq, msg, round: Number(msg._round) || 0,
      label: String((ev.args && ev.args.description) || question.slice(0, 60) || '子代理'),
      question, toolCalls: 0, modelRounds: 0, lastProgressAgoMs: null, running: true, status: 'running',
    };
  }
  updateTraceSummary(msg);
  renderTracePanels();
}
function traceToolFinished(msg, ev) {
  if (msg && ev && ev.name === 'task') {
    const question = String((ev.args && (ev.args.question || ev.args.prompt)) || '');
    const snap = pendingSubagent && pendingSubagent.seq === ev.seq ? pendingSubagent : null;
    sessionSubs.push({
      seq: ev.seq,
      label: String((snap && snap.label) || (ev.args && ev.args.description) || question.slice(0, 60) || '子代理'),
      question,
      result: ev.result,
      durationMs: ev.durationMs,
      msg,
      round: Number(msg._round) || 0,
      toolCalls: snap ? snap.toolCalls : null,
      modelRounds: snap ? snap.modelRounds : null,
      lastProgressAgoMs: snap ? snap.lastProgressAgoMs : null,
      status: ev.result && ev.result.ok === false ? 'failed' : 'done',
    });
    if (snap) pendingSubagent = null;
    renderSubPanel();
  }
  updateTraceSummary(msg);
  renderTracePanels();
}
function traceToolDenied(msg, ev) {
  if (msg && ev && ev.name === 'task') {
    const question = String((ev.args && (ev.args.question || ev.args.prompt)) || '');
    const snap = pendingSubagent && pendingSubagent.seq === ev.seq ? pendingSubagent : null;
    sessionSubs.push({
      seq: ev.seq, label: String((snap && snap.label) || question.slice(0, 60) || '子代理'), question,
      result: { ok: false, error: ev.reason || '未授权' }, durationMs: ev.durationMs, msg,
      round: Number(msg._round) || 0, toolCalls: snap ? snap.toolCalls : null,
      modelRounds: snap ? snap.modelRounds : null, lastProgressAgoMs: snap ? snap.lastProgressAgoMs : null,
      status: 'failed',
    });
    if (snap) pendingSubagent = null;
    renderSubPanel();
  }
  updateTraceSummary(msg);
  renderTracePanels();
}
/** 回合收尾时仍在跑的子代理：如实落成失败行（不让它从界面上凭空消失）。 */
function finalizePendingSubagent(msg) {
  const p = pendingSubagent;
  if (!p || (msg && p.msg !== msg)) return;
  sessionSubs.push({
    seq: p.seq, label: p.label, question: p.question,
    result: { ok: false, error: '本轮结束时子代理仍未回传结果' }, durationMs: null, msg: p.msg,
    round: p.round, toolCalls: p.toolCalls, modelRounds: p.modelRounds,
    lastProgressAgoMs: p.lastProgressAgoMs, status: 'failed',
  });
  pendingSubagent = null;
  renderSubPanel();
}
function syncTraceFoldButtons() {  document.querySelectorAll('[data-fold]').forEach((btn) => {
    const key = btn.dataset.fold;
    const open = traceFoldState[key] !== false;
    btn.setAttribute('aria-expanded', String(open));
    const body = document.getElementById(btn.getAttribute('aria-controls'));
    if (body) body.hidden = !open;
  });
}
function toggleTraceFold(key) {
  traceFoldState[key] = !(traceFoldState[key] !== false);
  syncTraceFoldButtons();
}
function traceScrollParent(root) {
  if (!root || !root.closest) return null;
  return root.closest('.rp-body') || root.closest('#tdBody');
}
function renderTraceRoundList(root, views) {
  if (!root) return;
  const scroller = traceScrollParent(root);
  const top = scroller ? scroller.scrollTop : 0;
  root.innerHTML = '';
  if (!views.length) {
    const empty = document.createElement('div'); empty.className = 'tr-empty';
    empty.textContent = '还没有可展示的轨迹——发起任务后这里按轮分组。';
    root.appendChild(empty);
    return;
  }
  for (const v of views) root.appendChild(buildTraceRoundNode(v));
  if (scroller) scroller.scrollTop = top;
}
function buildTraceRoundNode(v) {
  const box = document.createElement('div');
  box.className = 'tr-round' + (v.failed ? ' has-fail' : '');
  box.dataset.round = String(v.round);
  const head = document.createElement('button');
  head.type = 'button'; head.className = 'tr-round-head';
  const no = document.createElement('span'); no.className = 'tr-round-no'; no.textContent = '第 ' + v.round + ' 轮';
  const sum = document.createElement('span'); sum.className = 'tr-round-sum';
  sum.textContent = traceSummaryText(v);
  sum.dataset.summary = traceSummaryText(v); sum.dataset.src = 'traceRoundForMsg';
  head.appendChild(no); head.appendChild(sum);
  const body = document.createElement('div'); body.className = 'tr-round-body';
  if (v.tools.length) {
    const list = document.createElement('ol'); list.className = 'tl-steps tr-steps';
    for (const step of v.tools) {
      const entry = toolStepNode(step);
      paintToolStep(entry, step);
      const key = v.round + ':' + String(step.seq);
      if (openTraceTools.has(key)) { entry.out.hidden = false; entry.li.classList.add('open'); entry.row.setAttribute('aria-expanded', 'true'); }
      entry.row.addEventListener('click', () => {
        if (!entry.out.hidden) openTraceTools.add(key); else openTraceTools.delete(key);
      });
      list.appendChild(entry.li);
    }
    body.appendChild(list);
  } else {
    const d = document.createElement('div'); d.className = 'tr-empty'; d.textContent = '本轮没有工具调用'; body.appendChild(d);
  }
  const open = openTraceRounds.has(v.round);
  if (open) box.classList.add('open');
  head.setAttribute('aria-expanded', String(open));
  head.onclick = () => {
    const next = !box.classList.contains('open');
    box.classList.toggle('open', next);
    head.setAttribute('aria-expanded', String(next));
    if (next) openTraceRounds.add(v.round); else openTraceRounds.delete(v.round);
  };
  box.appendChild(head); box.appendChild(body);
  return box;
}
function renderTraceSubList(root, views) {
  if (!root) return;
  const scroller = traceScrollParent(root);
  const top = scroller ? scroller.scrollTop : 0;
  root.innerHTML = '';
  const rows = [];
  for (const v of views) for (const s of v.subs) rows.push(s);
  if (!rows.length) {
    const empty = document.createElement('div'); empty.className = 'tr-empty';
    empty.textContent = '本会话还没有子 Agent（task 工具会派生子 Agent）';
    root.appendChild(empty);
    return;
  }
  for (const s of rows) root.appendChild(buildTraceSubNode(s));
  if (scroller) scroller.scrollTop = top;
}
function buildTraceSubNode(s) {
  const box = document.createElement('div');
  box.className = 'tr-sub ' + (s.statusCls || '');
  box.dataset.seq = String(s.seq == null ? '' : s.seq);
  box.dataset.round = String(s.round);
  const head = document.createElement('button');
  head.type = 'button'; head.className = 'tr-sub-head';
  const name = document.createElement('span'); name.className = 'tr-sub-name'; name.textContent = '🤖 ' + s.name;
  const round = document.createElement('span'); round.className = 'tr-sub-meta'; round.textContent = s.roundText;
  const tools = document.createElement('span'); tools.className = 'tr-sub-meta'; tools.textContent = s.toolText;
  const progress = document.createElement('span'); progress.className = 'tr-sub-meta'; progress.textContent = s.progress;
  const state = document.createElement('span'); state.className = 'tr-sub-state ' + (s.statusCls || ''); state.textContent = s.statusText;
  state.setAttribute('aria-live', 'polite'); // P2-3：子代理状态变化时读屏播报（暂停/失败/完成）
  [name, round, tools, progress, state].forEach((n) => head.appendChild(n));
  const body = document.createElement('div'); body.className = 'tr-sub-body';
  const q = document.createElement('div'); q.className = 'tr-sub-q'; q.textContent = '任务：' + (s.question || '—');
  const stats = document.createElement('div'); stats.className = 'tr-sub-stats';
  stats.textContent = '子代理自身：' + s.roundsText + ' · ' + s.toolText + ' · ' + s.progress
    + '（实时快照来自既有 progress.subagent，未新增轮询）';
  const rl = document.createElement('div'); rl.className = 'tr-sub-rl'; rl.textContent = '结果：';
  body.appendChild(q); body.appendChild(stats); body.appendChild(rl);
  if (s.running) { const w = document.createElement('div'); w.className = 'tr-sub-wait'; w.textContent = '仍在运行——工具次数与最后进展随 progress 事件更新…'; body.appendChild(w); }
  else body.appendChild(textBody(resultText(s.result)));
  const open = openTraceSubs.has(s.key);
  if (open) box.classList.add('open');
  head.setAttribute('aria-expanded', String(open));
  head.onclick = () => {
    const next = !box.classList.contains('open');
    box.classList.toggle('open', next);
    head.setAttribute('aria-expanded', String(next));
    if (next) openTraceSubs.add(s.key); else openTraceSubs.delete(s.key);
  };
  box.appendChild(head); box.appendChild(body);
  return box;
}
function renderTracePanels() {
  const views = collectTraceViews();
  const totalTools = views.reduce((a, v) => a + v.toolCount, 0);
  const totalSubs = views.reduce((a, v) => a + v.subCount, 0);
  const totalFailed = views.reduce((a, v) => a + v.failed, 0);
  const meta = views.length ? views.length + ' 轮 · ' + totalTools + ' 次工具 · ' + totalSubs + ' 个子代理' : '—';
  ['#rpTraceMeta', '#tdTraceMeta'].forEach((sel) => { const n = $(sel); if (n) n.textContent = meta; });
  ['#rpSubMeta', '#tdSubMeta'].forEach((sel) => { const n = $(sel); if (n) n.textContent = totalSubs ? totalSubs + ' 个' : '—'; });
  const dockMeta = $('#tdMeta'); if (dockMeta) dockMeta.textContent = meta;
  if (!traceAutoOpened && views.length) { openTraceRounds.add(views[views.length - 1].round); traceAutoOpened = true; }
  renderTraceRoundList($('#rpTraceList'), views);
  renderTraceRoundList($('#tdTraceList'), views);
  renderTraceSubList($('#rpSubList'), views);
  renderTraceSubList($('#tdSubList'), views);
  syncTraceFoldButtons();
  // P2-3：aria-live 只在**状态变化**时播报（同一状态重复渲染不打扰读屏）。
  try {
    updateLiveRegion({
      phase: runStripView(runState, generating).phase,
      toolCount: totalTools,
      failed: totalFailed,
      subs: views.reduce((a, v) => a.concat(v.subs), []),
    });
  } catch { /* 桩 DOM / 启动早期：无障碍播报不得影响主流程 */ }
}
/** 子代理运行中只刷新子代理两块（progress≈1s；不重建工具列表，少打扰）。 */
function renderSubagentSections() {
  const views = collectTraceViews();
  const totalSubs = views.reduce((a, v) => a + v.subCount, 0);
  ['#rpSubMeta', '#tdSubMeta'].forEach((sel) => { const n = $(sel); if (n) n.textContent = totalSubs ? totalSubs + ' 个' : '—'; });
  renderTraceSubList($('#rpSubList'), views);
  renderTraceSubList($('#tdSubList'), views);
}
function syncTraceDock() {
  const dock = $('#traceDock'); if (!dock) return;
  const show = traceDockVisible(window.innerWidth || 0, !$('#runPanel').hidden);
  dock.hidden = !show;
  if (show) renderTracePanels();
}
function focusTraceRound(round) {
  const n = Math.max(0, Math.round(Number(round) || 0)); if (!n) return;
  const target = traceFocusTarget(window.innerWidth || 0, !$('#runPanel').hidden);
  if (target === 'dock') {
    const dock = $('#traceDock'); if (dock) dock.hidden = false;
    const body = $('#tdBody'); if (body) body.hidden = false;
    const toggle = $('#tdToggle'); if (toggle) toggle.setAttribute('aria-expanded', 'true');
  } else {
    setRunPanel(true);
  }
  traceFoldState.trace = true;
  openTraceRounds.add(n);
  renderTracePanels();
  const root = target === 'dock' ? $('#tdTraceList') : $('#rpTraceList');
  const el = root ? root.querySelector('[data-round="' + n + '"]') : null;
  if (el) {
    el.classList.add('focus');
    try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* 老浏览器/无布局：跳过平滑滚动 */ }
    setTimeout(() => el.classList.remove('focus'), 1600);
  }
}
function initTraceUI() {
  document.querySelectorAll('[data-fold]').forEach((btn) => { btn.onclick = () => toggleTraceFold(btn.dataset.fold); });
  const toggle = $('#tdToggle');
  if (toggle) toggle.onclick = () => {
    const body = $('#tdBody'); if (!body) return;
    const show = body.hidden;
    body.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
  };
  syncTraceFoldButtons();
  renderTracePanels();
}
/** 新对话/切换会话：轮次、子代理、展开状态一起归零（旧会话的轨迹不得串到新会话）。 */
function resetTraceState() {
  turnSeq = 0;
  pendingSubagent = null;
  sessionSubs.length = 0;
  openTraceRounds.clear();
  openTraceTools.clear();
  openTraceSubs.clear();
  traceAutoOpened = false;
  renderTracePanels();
  try { renderSubPanel(); } catch { /* 子代理面板未初始化时忽略 */ }
}

// —— 会话设置弹层：模型 / 预设 / 权限（生效值 + 来源） ——
function permissionModeLabel(mode) {
  return ({ ask: '询问', auto: '自动', readonly: '只读' })[String(mode || '')] || String(mode || '—');
}
function currentModelEntry() {
  const name = (($('#modelSel') && $('#modelSel').value) || runState.modelName || '').trim();
  const found = modelsCache.find((m) => m && (m.id || m.name) === name);
  return found || { name, label: runState.modelLabel || name };
}
function renderSessionSettings() {
  const md = modelDisplay(currentModelEntry());
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  set('#ssModelLabel', md.label);
  set('#ssModelId', md.subtitle);
  set('#ssModelSrc', t('sess.modelSource'));
  const hint = $('#ssModelAliasHint');
  if (hint) hint.hidden = !(md && md.label && md.label !== (md.id || md.name));
  const permSel = $('#permSel');
  const mode = runState.permissionMode || (permSel && permSel.value) || 'ask';
  const source = runState.permissionSource || 'default';
  set('#ssPermSrc', permissionDisplay(mode, source));
  document.querySelectorAll('#ssPermSeg [data-perm]').forEach((b) => b.classList.toggle('on', b.dataset.perm === mode));
  const psel = $('#presetSel');
  const presetLabel = psel && psel.value
    ? ((presetData.find((p) => p.name === psel.value) || {}).label || psel.value)
    : '无预设';
  runState.presetName = presetLabel;
  set('#ssEffective', sessionEffectiveLine({ model: md.name, modelLabel: md.label, permission: mode, sourceLabel: permissionSourceLabel(source), preset: presetLabel }));
  set('#chipModel', md.label || md.name || '模型');
  set('#chipPerm', permissionModeLabel(mode));
  const field = $('#ssReasoningField');
  const reas = $('#reasoningSel');
  if (field && reas) field.hidden = reas.style.display === 'none';
}
let sessSheetDialog = null;
function openSessionSheet() {
  renderSessionSettings();
  const s = $('#sessSheet'); if (!s) return;
  s.hidden = false;
  const btn = $('#sessSettingsBtn'); if (btn) btn.setAttribute('aria-expanded', 'true');
  // P2-3：role=dialog + aria-modal + 焦点陷阱 + Esc 关闭 + 关闭后焦点回触发元素。
  sessSheetDialog = installDialog(s, {
    opener: (typeof document !== 'undefined' ? document.activeElement : null),
    label: t('sess.title'),
    initialFocus: $('#ssClose'),
    onClose: () => {
      sessSheetDialog = null;
      s.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
    },
  });
}
function closeSessionSheet() {
  if (sessSheetDialog) {
    const d = sessSheetDialog;
    sessSheetDialog = null;
    d.close();
    return;
  }
  const s = $('#sessSheet'); if (!s) return;
  s.hidden = true;
  const btn = $('#sessSettingsBtn'); if (btn) btn.setAttribute('aria-expanded', 'false');
}
$('#sessSettingsBtn').onclick = () => {
  const s = $('#sessSheet');
  if (!s) return;
  if (s.hidden) openSessionSheet(); else closeSessionSheet();
};
$('#ssClose').onclick = closeSessionSheet;
$('#ssDone').onclick = closeSessionSheet;
document.querySelectorAll('[data-open-settings]').forEach((b) => { b.onclick = () => openSessionSheet(); });
document.querySelectorAll('#ssPermSeg [data-perm]').forEach((b) => { b.onclick = () => setPermissionEverywhere(b.dataset.perm); });

async function setModelEverywhere(name) {
  const sel = $('#modelSel');
  if (sel) sel.value = name;
  runState.modelName = name;
  const entry = modelsCache.find((m) => m && (m.id || m.name) === name);
  runState.modelLabel = entry ? String(entry.label || name) : name;
  renderSessionSettings();
  await applyConfig({ model: name }, sel || undefined);
  renderRunPanel();
  renderSessionSettings();
}
async function setPermissionEverywhere(mode) {
  const prev = runState.permissionMode || (($('#permSel') && $('#permSel').value) || 'ask');
  // P2-2：切到 auto 属于危险操作——先说明后果，取消则保持原档（并复位分段控件）。
  if (dangerGateNeeded('permissionAuto', prev, mode)) {
    const gate = await confirmDanger('permissionAuto', async () => {});
    if (gate.cancelled) {
      if ($('#permSel')) $('#permSel').value = prev;
      renderSessionSettings();
      return false;
    }
  }
  const sel = $('#permSel');
  if (sel) sel.value = mode;
  runState.permissionMode = mode;
  runState.permissionSource = 'explicit';
  renderSessionSettings();
  renderWorkStatus();
  await applyConfig({ permission: mode }, sel || undefined);
  renderSessionSettings();
  return true;
}
function setPresetEverywhere(name) {
  const sel = $('#presetSel');
  if (sel) sel.value = name || '';
  presetPicked();
  renderSessionSettings();
  renderRunPanel();
}

// —— 命令面板：数据全部来自既有 API 快照（打开时刷新一次，不是轮询） ——
let paletteOpen = false, paletteSelected = 0, paletteItems = [], paletteButtons = [], paletteOpener = null, paletteDialog = null;
function paletteSources() {
  return {
    sessions: sessionsCache,
    workspaces: workspacesCache,
    currentWorkspace: currentWorkspaceName,
    models: modelsCache,
    presets: presetData,
    compactAvailable,
  };
}
function paletteActions() {
  return {
    newChat: () => $('#newChat').click(),
    switchSession: (file) => { const sel = $('#sessions'); if (!sel) return; sel.value = file; sel.dispatchEvent(new Event('change')); },
    switchWorkspace: (name) => applyWorkspaceSwitch(name),
    newWorkspace: () => { const sel = $('#wsSel'); if (!sel) return; sel.value = '__add__'; sel.dispatchEvent(new Event('change')); },
    setModel: (name) => setModelEverywhere(name),
    setPreset: (name) => setPresetEverywhere(name),
    setPermission: (mode) => setPermissionEverywhere(mode),
    stop: () => stopTurnFromButton(),
    openShortcuts: () => openShortcutSheet(),
    toggleRunPanel: () => toggleRunPanel(),
    toggleTheme: () => { const cur = document.documentElement.getAttribute('data-theme'); setThemePreference(cur === 'dark' ? 'light' : 'dark'); },
    openSettings: (panel) => openSettingsPanel(panel),
    openDiagnostics: () => openDiagnostics(),
    compact: () => renderBanner({ text: '⚠ Web 端没有 /compact 端点（只有 CLI 有），本入口未启用。', warn: true }),
  };
}
function paintPalette() {
  paletteButtons.forEach((b, i) => b.setAttribute('aria-selected', String(i === paletteSelected)));
  const active = paletteButtons[paletteSelected];
  const inp = $('#paletteInput');
  if (inp) inp.setAttribute('aria-activedescendant', active ? active.id : '');
  if (active && active.scrollIntoView) { try { active.scrollIntoView({ block: 'nearest' }); } catch { /* 桩 DOM 无布局 */ } }
}
function renderPalette() {
  const list = $('#paletteList'); if (!list) return;
  const q = ($('#paletteInput') && $('#paletteInput').value) || '';
  paletteItems = paletteFilter(buildPaletteCommands(paletteSources(), paletteActions()), q);
  paletteButtons = [];
  list.innerHTML = '';
  if (!paletteItems.length) {
    const empty = document.createElement('div'); empty.className = 'palette-empty';
    empty.textContent = '没有匹配项 —— 试试「模型 / 会话 / 权限 / 设置」';
    list.appendChild(empty);
    paletteSelected = 0;
    paintPalette();
    return;
  }
  let group = '';
  paletteItems.forEach((cmd, i) => {
    if (cmd.group !== group) {
      group = cmd.group;
      const g = document.createElement('div'); g.className = 'pgroup-label'; g.textContent = group;
      list.appendChild(g);
    }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'pitem'; b.id = 'pitem-' + i;
    b.setAttribute('role', 'option'); b.setAttribute('aria-selected', 'false');
    b.innerHTML = paletteItemHtml(cmd);
    b.onclick = () => runPaletteCommand(i);
    b.onmousemove = () => { if (paletteSelected !== i) { paletteSelected = i; paintPalette(); } };
    list.appendChild(b);
    paletteButtons.push(b);
  });
  if (paletteSelected >= paletteItems.length) paletteSelected = Math.max(0, paletteItems.length - 1);
  paintPalette();
}
async function openPalette() {
  paletteOpener = document.activeElement;
  paletteOpen = true;
  const mask = $('#paletteMask'); if (mask) mask.hidden = false;
  const inp = $('#paletteInput'); if (inp) inp.value = '';
  paletteSelected = 0;
  renderPalette();
  try { await refreshSessions(); } catch { /* 网络失败：仍显示缓存命令 */ }
  try { await refreshWsSel(); } catch { /* 同上 */ }
  if (paletteOpen) {
    renderPalette();
    // P2-3：命令面板的 dialog 语义/焦点陷阱/Esc/焦点归还（HTML 已有 role/aria-modal，这里补齐行为）。
    const box = document.querySelector('#paletteMask .palette');
    if (box) {
      paletteDialog = installDialog(box, {
        opener: paletteOpener,
        label: t('palette.title'),
        initialFocus: $('#paletteInput'),
        onClose: () => {
          paletteDialog = null;
          const m = $('#paletteMask'); if (m) m.hidden = true;
          paletteOpen = false;
        },
      });
    }
    try { $('#paletteInput').focus(); } catch { /* ignore */ }
  }
}
function closePalette() {
  if (paletteDialog) {
    const d = paletteDialog;
    paletteDialog = null;
    paletteOpen = false;
    d.close();
    return;
  }
  const mask = $('#paletteMask'); if (mask) mask.hidden = true;
  paletteOpen = false;
  if (paletteOpener && paletteOpener.focus) { try { paletteOpener.focus(); } catch { /* ignore */ } }
}
function togglePalette() { if (paletteOpen) closePalette(); else openPalette(); }
function runPaletteCommand(i) {
  const cmd = paletteItems[i]; if (!cmd) return;
  closePalette();
  try {
    const p = cmd.run && cmd.run();
    if (p && typeof p.catch === 'function') p.catch((err) => renderBanner({ text: '⚠ 命令执行失败：' + ((err && err.message) || '未知错误'), warn: true }));
  } catch (err) {
    renderBanner({ text: '⚠ 命令执行失败：' + ((err && err.message) || '未知错误'), warn: true });
  }
}
$('#paletteBtn').onclick = () => openPalette();
$('#paletteInput').addEventListener('input', () => { paletteSelected = 0; renderPalette(); });
$('#paletteInput').addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    paletteSelected = paletteNext(e.key, paletteSelected, paletteItems.length);
    paintPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPaletteCommand(paletteSelected);
  }
});
$('#paletteMask').addEventListener('mousedown', (e) => { if (e.target === $('#paletteMask')) closePalette(); });

// —— 快捷键表 ——
function openShortcutSheet() { const m = $('#shortcutMask'); if (m) m.hidden = false; }
function closeShortcutSheet() { const m = $('#shortcutMask'); if (m) m.hidden = true; }
function toggleShortcutSheet() { const m = $('#shortcutMask'); if (!m) return; if (m.hidden) openShortcutSheet(); else closeShortcutSheet(); }
$('#shortcutClose').onclick = closeShortcutSheet;
$('#shortcutMask').addEventListener('mousedown', (e) => { if (e.target === $('#shortcutMask')) closeShortcutSheet(); });

// —— 空态三步引导：示例只填入，不发送 ——
function fillExampleTask(text) {
  input.value = String(text == null ? '' : text);
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 桩 DOM 无 Event */ }
  try { input.focus(); } catch { /* ignore */ }
  try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
  renderEmptyState();
}
function renderEmptyState() {
  const es = $('#emptyState'); if (!es) return;
  const show = shouldShowEmpty(chatEl.children.length, generating);
  es.hidden = !show;
  if (!show) return;
  const md = modelDisplay(currentModelEntry());
  const set = (id, text) => { const n = $(id); if (n) n.textContent = text; };
  set('#esModel', md.name ? md.label + ' · ' + md.subtitle : '还没有可用模型：在 ⚙ 设置 › 模型与端点填 Key');
  set('#esWs', currentWorkspaceName ? currentWorkspaceName : '未登记工作空间：点「选择目录…」登记（也可先跳过）');
  const hasModel = Boolean(md.name);
  const hasWs = Boolean(currentWorkspaceName);
  const hasInput = Boolean(String(input.value || '').trim());
  const step = (name) => document.querySelector('#emptyState [data-step="' + name + '"]');
  const mark = (name, done, stateText) => {
    const li = step(name); if (li && li.classList) li.classList.toggle('done', Boolean(done));
    set('#es' + name.charAt(0).toUpperCase() + name.slice(1) + 'State', stateText || (done ? '已就绪' : '待办'));
  };
  mark('model', hasModel, hasModel ? '已就绪' : '待办');
  mark('workspace', hasWs, hasWs ? '已就绪' : '可跳过');
  mark('input', hasInput, hasInput ? '已填写' : '待办');
}
$('#emptyState').addEventListener('click', (e) => {
  const ex = e.target.closest ? e.target.closest('[data-example]') : null;
  if (ex) { fillExampleTask(ex.getAttribute('data-example')); return; }
  const act = e.target.closest ? e.target.closest('[data-es-act]') : null;
  if (!act) return;
  if (act.getAttribute('data-es-act') === 'model') openSessionSheet();
  else {
    const sel = $('#wsSel');
    if (sel) { try { sel.focus(); } catch { /* ignore */ } }
    renderBanner({ text: '工作空间在顶栏下拉里切换；点「＋ 新建工作空间…」可用系统目录选择器登记。' });
  }
});
input.addEventListener('input', () => renderEmptyState());

// —— 设置搜索：输入即过滤字段（不匹配项带 hidden），命中项高亮 ——
function collectSettingRows() {
  return [...document.querySelectorAll('#cfgModal .cfg-row, #cfgModal .cfg-hint, #cfgModal .cfg-searchable')].map((el) => ({ el, text: settingsRowSearchText(el) }));
}
function runSettingsSearch(q) {
  const rows = collectSettingRows();
  const hits = applySettingsFilter(rows, q);
  const count = $('#cfgSearchCount');
  if (count) count.textContent = String(q || '').trim() ? hits + ' 项匹配' : '';
  const searching = String(q || '').trim().length > 0;
  if (searching) {
    const first = rows.find((r) => !r.el.hidden && r.el.closest && r.el.closest('.cfg-panel'));
    if (first) showCfgPanel(first.el.closest('.cfg-panel').dataset.panel || cfgPanel);
    document.querySelectorAll('#cfgModal .cfg-nav-btn').forEach((b) => {
      const panel = b.dataset.panel;
      const any = rows.some((r) => !r.el.hidden && r.el.closest && r.el.closest('.cfg-panel') && r.el.closest('.cfg-panel').dataset.panel === panel);
      b.classList.toggle('no-hit', !any);
    });
  } else {
    document.querySelectorAll('#cfgModal .cfg-nav-btn').forEach((b) => b.classList.remove('no-hit'));
    showCfgPanel(cfgPanel);
  }
}
$('#cfgSearch').addEventListener('input', (e) => runSettingsSearch(e.target.value));

// —— 诊断 / 日志路径（不新增后端；路径来自 /api/state 的 home/workingDir） ——
function openDiagnostics() {
  const box = $('#diagRows'); if (!box) return;
  box.innerHTML = '';
  const home = homeDir || '~/.mingdao';
  const items = [
    ['日志目录', home.replace(/\/$/, '') + '/logs/'],
    ['Web 日志', home.replace(/\/$/, '') + '/logs/web-server.log'],
    ['配置文件', home.replace(/\/$/, '') + '/config.json'],
    ['工作目录', workingDirCache || '—'],
    ['当前工作空间', currentWorkspaceName || '—'],
  ];
  for (const [k, v] of items) {
    const row = document.createElement('div'); row.className = 'diag-row';
    const kk = document.createElement('span'); kk.className = 'diag-k'; kk.textContent = k;
    const vv = document.createElement('span'); vv.className = 'diag-v'; vv.textContent = v;
    const cp = document.createElement('button'); cp.type = 'button'; cp.textContent = '复制';
    cp.onclick = () => copyToClipboard(v).then(() => { cp.textContent = '已复制'; setTimeout(() => { cp.textContent = '复制'; }, 1200); });
    row.appendChild(kk); row.appendChild(vv); row.appendChild(cp);
    box.appendChild(row);
  }
  // P2-3：对比度自检（WCAG 相对亮度）。**只给建议，不改主题令牌**——主题是设计决策，不在运行时偷偷换色。
  const audit = contrastAudit();
  const failed = audit.filter((c) => !c.pass);
  const head = document.createElement('div'); head.className = 'diag-k'; head.style.cssText = 'margin-top:10px';
  head.textContent = failed.length ? '对比度未达标 ' + failed.length + ' 项（建议）' : '对比度：正文/次要文本全部 ≥4.5:1';
  box.appendChild(head);
  for (const c of failed) {
    const row = document.createElement('div'); row.className = 'diag-row';
    const kk = document.createElement('span'); kk.className = 'diag-k'; kk.textContent = c.fg + ' / ' + c.bg;
    const vv = document.createElement('span'); vv.className = 'diag-v'; vv.textContent = c.ratio + ':1 · ' + c.advice;
    row.appendChild(kk); row.appendChild(vv);
    box.appendChild(row);
  }
  $('#diagModal').style.display = 'flex';
}
$('#diagClose').onclick = () => { $('#diagModal').style.display = 'none'; };

// —— 全局键盘：⌘K / ⌘/ / Esc 分层 / ⌘Enter（输入法组合期一律忽略） ——
document.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.defaultPrevented) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); togglePalette(); return; }
  if (mod && (e.key === '/' || e.key === '?')) { e.preventDefault(); toggleShortcutSheet(); return; }
  if (mod && e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); send(); return; }
  if (e.key === 'Escape') {
    if (paletteOpen) { e.preventDefault(); closePalette(); return; }
    const sm = $('#shortcutMask'); if (sm && !sm.hidden) { e.preventDefault(); closeShortcutSheet(); return; }
    const ss = $('#sessSheet'); if (ss && !ss.hidden) { e.preventDefault(); closeSessionSheet(); return; }
    if ($('#diagModal').style.display === 'flex') { e.preventDefault(); $('#diagModal').style.display = 'none'; return; }
    if ($('#cfgModal').style.display === 'flex') { e.preventDefault(); $('#cfgModal').style.display = 'none'; return; }
    if ($('#dirModal').style.display === 'flex') { e.preventDefault(); $('#dirModal').style.display = 'none'; return; }
    if (document.body.classList.contains('side-drawer')) { e.preventDefault(); closeSideDrawer(); return; }
    if (document.body.classList.contains('run-drawer')) { e.preventDefault(); setRunPanel(false); return; }
    if (activeAsk) return; // 内联确认自己的 Esc 处理器负责（拒绝，不是停止）
    if (generating) { e.preventDefault(); stopTurnFromButton(); return; }
  }
});

function attachTrajMeta(msg){
  // §3.73：不再插入 #chat 里的旧轨迹按钮卡；每轮只留一行摘要。
  updateTraceSummary(msg);
}
function openTraj(msg){
  const list=$('#tjList'); list.innerHTML='';
  const tools=msg._traj.filter(x=>x.kind==='tool');
  const subs=tools.filter(x=>x.name==='task');
  $('#tjSummary').textContent='（'+(msg._steps||tools.length)+' 步 · '+subs.length+' 个子 Agent）';
  let turnN=0;
  for(const e of msg._traj){
    if(e.kind==='turn'){ turnN+=1;
      const t=document.createElement('div'); t.className='tj-turn'; t.textContent='第 '+turnN+' 回合'; list.appendChild(t);
      continue;
    }
    const isSub=e.name==='task';
    const ico={'read':'📄','write':'✏️','edit':'✎','bash':'⚙','grep':'🔎','glob':'🔎','ls':'📁','task':'🤖','skill':'🧩','todo':'☑','undo':'↩'}[e.name]||'🔌';
    const args = e.name==='bash' ? (e.args&&e.args.command) : (e.args&&(e.args.path||e.args.pattern||e.args.name||e.args.question||''))||'';
    const div=document.createElement('div'); div.className='tj-item'+(isSub?' tj-sub':'');
    const subLabel=isSub?'子 Agent：':'';
    div.innerHTML='<div class="tj-head"><span>'+ico+'</span><span style="white-space:nowrap">'+esc(subLabel+e.name)+'</span><span class="tj-args">'+esc(String(args).slice(0,80))+'</span><span style="margin-left:auto;color:var(--faint)">'+(e.done?(e.denied?'✖ '+esc(e.denied):'✓'+(e.durationMs!=null?' '+e.durationMs+'ms':'')):'执行中…')+'</span></div>';
    const body=document.createElement('div'); body.className='tj-body';
    if(isSub){
      const q=document.createElement('div'); q.textContent='任务：'+(e.args&&(e.args.question||e.args.prompt)); body.appendChild(q);
      const rl=document.createElement('div'); rl.textContent='结果：'; body.appendChild(rl);
      body.appendChild(textBody(resultText(e.result))); // v0.6.2：可展开，不再静默截断到 1500 字
    }else if(e.result!==undefined){
      const ap=document.createElement('div'); ap.textContent='参数：'+truncText(JSON.stringify(e.args||{}), 500); body.appendChild(ap);
      const ar=document.createElement('div'); ar.textContent='结果：'; body.appendChild(ar);
      body.appendChild(textBody(resultText(e.result))); // v0.6.2：可展开，不再静默截断到 1500 字
    }else{
      body.textContent='参数：'+truncText(JSON.stringify(e.args||{}), 500);
    }
    div.appendChild(body);
    div.onclick=(ev)=>{ if(ev.target.closest('.tj-body')) return; div.classList.toggle('open'); };
    // 点击标题定位到聊天中的对应工具卡
    list.appendChild(div);
  }
  railTab='traj';
  syncPanelLayout();
}
// §3.78 面板布局同步：右栏四个标签页 + 断点抽屉。原来的 traj-open/sub-open/tasks-open/dash-open
// 各自推开正文的写法全部收口到这里——同一时刻只显示一个标签页，不再叠两个右侧面板。
/** 标签页显隐（纯函数；smoke §153 直接断言，不碰 DOM）。 */
function railPanelDisplay(tab, panelTab, runOpen) {
  return runOpen && tab === panelTab ? 'flex' : 'none';
}
function showRailTab(name) {
  if (!RAIL_TABS.includes(name)) return;
  railTab = name;
  if (!runPanelOpen) setRunPanel(true); else syncPanelLayout();
  if (name === 'tasks') { try { updateTasksPanel(); } catch { /* 未初始化时忽略 */ } }
  if (name === 'dash') { try { refreshCostBadge(); } catch { /* 未初始化时忽略 */ } }
  if (name === 'sub') { try { renderSubPanel(); } catch { /* 未初始化时忽略 */ } }
  if (name === 'traj' || name === 'sub') { try { renderTracePanels(); } catch { /* 未初始化时忽略 */ } }
}
function initRailTabs() {
  document.querySelectorAll('#rpTabs [data-tab]').forEach((btn) => {
    btn.onclick = () => showRailTab(btn.dataset.tab);
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = RAIL_TABS.indexOf(railTab);
      const n = (i + (e.key === 'ArrowRight' ? 1 : RAIL_TABS.length - 1)) % RAIL_TABS.length;
      showRailTab(RAIL_TABS[n]);
      const next = document.querySelector('#rpTabs [data-tab="' + RAIL_TABS[n] + '"]');
      if (next) next.focus();
    });
  });
}
function closeSideDrawer() { document.body.classList.remove('side-drawer'); }
function syncPanelLayout(){
  const wide = !layoutClassesFor(window.innerWidth || 0).narrowRun;
  const open = Boolean(runPanelOpen);
  const rp = $('#runPanel'); if (rp) rp.hidden = !open;
  document.body.classList.toggle('run-open', open && wide);
  document.body.classList.toggle('run-drawer', open && !wide);
  document.body.classList.toggle('rail-collapsed', !open);
  for (const tab of RAIL_TABS) {
    const el = document.getElementById(RAIL_PANEL_IDS[tab]);
    if (el) el.style.display = railPanelDisplay(railTab, tab, open);
    const btn = document.querySelector('#rpTabs [data-tab="' + tab + '"]');
    if (btn) {
      const on = railTab === tab;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    }
  }
  // §3.73：窄屏右栏收起时，轨迹/子Agent 在对话流末尾显示；右栏（抽屉）一开就让位。
  syncTraceDock();
}
$('#tjClose').onclick=()=>{ setRunPanel(false); };
$('#trajRailBtn').onclick=()=>showRailTab('traj');
function lastMsgWithTraj(){
  const msgs=[...document.querySelectorAll('#chat .msg-ai')].reverse();
  for(const m of msgs){ if(m._traj && m._traj.length) return m; }
  return msgs.length ? msgs[0] : null;
}
function renderSubPanel(){
  const count=sessionSubs.length;
  const badge=$('#subBadge'); if(badge){ badge.style.display=count>0?'':'none'; badge.textContent=count>99?'99+':String(count); }
  $('#sbCount').textContent=count>0?('（'+count+' 个）'):'';
  if($('#subPanel').style.display!=='flex') return;
  const list=$('#sbList'); list.innerHTML='';
  for(const sub of [...sessionSubs].reverse()){
    const div=document.createElement('div'); div.className='sb-item';
    div.innerHTML='<div class="sb-q">🤖 '+esc(sub.question.slice(0,60))+'</div><div class="sb-meta">'+(sub.durationMs!=null?sub.durationMs+'ms · ':'')+((sub.result&&sub.result.ok===false)?'失败':'完成')+'</div>';
    const body=document.createElement('div'); body.className='sb-body';
    const sq=document.createElement('div'); sq.textContent='任务：'+sub.question; body.appendChild(sq);
    const sl=document.createElement('div'); sl.textContent='结果：'; body.appendChild(sl);
    body.appendChild(textBody(resultText(sub.result))); // v0.6.2：子代理汇报可展开全文（用户报过被截断）
    div.appendChild(body);
    div.onclick=(e)=>{ if(e.target.closest('.sb-body')) return; div.classList.toggle('open'); };
    list.appendChild(div);
  }
  if(!count) list.innerHTML='<div class="empty" style="color:var(--faint);font-size:12px;padding:10px">本会话还没有子 Agent（task 工具会派生子 Agent）</div>';
}
$('#subRailBtn').onclick=()=>showRailTab('sub');
$('#sbClose').onclick=()=>{ setRunPanel(false); };
// —— 任务面板（多会话并行） ——
function setBtn(){
  // §138：停止点击后立刻有可见反馈（「停止中…」+ 禁用防连点），回合真正收尾后由 finally 复位。
  syncStripStop();
  if(stopping){ sendBtn.textContent='⏹ 停止中…'; sendBtn.className='danger'; sendBtn.disabled=true; return; }
  sendBtn.disabled=false;
  sendBtn.textContent = generating ? '■ 停止' : '发送';
  sendBtn.className = generating ? 'send danger' : 'send primary';
}
/** §3.78：底部状态条里的 .stopbtn 与主按钮同一状态（同一条停止出口）。 */
function syncStripStop(){
  const s=$('#stripStop'); if(!s) return;
  s.disabled=!generating||stopping;
  s.textContent=stopping?'■ 停止中…':'■ 停止';
  s.style.display=(generating||stopping)?'':'none';
}
const lastBgStatus = new Map(); // 后台任务状态跟踪（完成/失败转换 → 聊天横幅反馈）
async function updateTasksPanel(){
  const r=await fetch('/api/tasks').catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#tpList'); list.innerHTML='';
  // 质检（等待状态静默）：后台任务（worker/调度）并入计数与面板；状态转换时在聊天区弹可见横幅
  bgRunning=(Number(j.running)||0)+(Number(j.bgRunning)||0);
  bgTasks=j.background||[];
  for(const t of (j.background||[])){
    const prev=lastBgStatus.get(t.id);
    if(prev && prev.status==='running' && t.status!=='running'){
      if(t.status==='done') renderBanner({text:'✅ 后台任务「'+esc(String(t.message||'').slice(0,30)||'任务')+'」已完成'+(t.durationMs!=null?'（用时 '+(t.durationMs/1000).toFixed(1)+' 秒）':'')});
      else if(t.status==='capped') renderBanner({text:'⚠ 已达步数上限，任务未完成（可续跑）——直接发送消息即可从断点继续。', warn:true});
      else if(t.status==='failed') renderBanner({text:'✖ 后台任务「'+esc(String(t.message||'').slice(0,30)||'任务')+'」失败：'+esc(String(t.error||'').slice(0,60))});
    }
    lastBgStatus.set(t.id,{status:t.status});
  }
  renderWorkStatus();
  $('#tpCount').textContent='（'+j.running+' 运行中 / 上限 '+j.maxConcurrent+'）';
  // 审计（第二问无反应修复）：generating 改为「本轮在途」本地状态，由 send/finally 维护，
  // 不再由 /api/tasks 轮询推导——任务面板瞬时波动或一次轮询失败曾让按钮永久卡在停止态，
  // 后续发送全部静默。面板仅展示，不参与按钮状态。
  for(const t of j.tasks){
    const div=document.createElement('div'); div.className='tp-item';
    const dot = t.status==='running'?'tp-run':(t.status==='done'?'tp-done':'tp-bad');
    const secs = t.status==='running'?'…':' '+(t.durationMs/1000).toFixed(1)+'s';
    div.innerHTML='<div class="tp-title">'+esc(t.message||'任务')+'</div><div class="tp-meta"><span class="tp-dot '+dot+'"></span>'+t.status+secs+'</div>';
    if(t.status==='running'){ const b=document.createElement('button'); b.textContent='中断'; b.className='danger'; b.style.cssText='margin-left:auto;padding:2px 8px;font-size:11px'; b.onclick=async()=>{ const r=await stopTurn(t.id); if(!r.ok) renderBanner({text:'⚠ 中断「'+String(t.message||t.id).slice(0,30)+'」失败：'+r.why, warn:true}); updateTasksPanel(); }; div.querySelector('.tp-meta').appendChild(b); }
    list.appendChild(div);
  }
  for(const t of (j.background||[])){
    const div=document.createElement('div'); div.className='tp-item';
    const dot = t.status==='running'?'tp-run':(t.status==='done'?'tp-done':'tp-bad');
    const secs = t.status==='running'?'…':(t.durationMs!=null?' '+(t.durationMs/1000).toFixed(1)+'s':'');
    const kindLabel = t.kind==='schedule'?'⏰ ':(t.kind==='worker'?'🛠 ':'');
    div.innerHTML='<div class="tp-title">'+kindLabel+esc(t.message||t.id||'任务')+'</div><div class="tp-meta"><span class="tp-dot '+dot+'"></span>'+t.status+secs+'</div>';
    list.appendChild(div);
  }
}
setInterval(updateTasksPanel, 2000);
// 费用徽标：今日费用 / 缓存命中率 / 护栏（15s 刷新）；点击展开省钱仪表盘
async function refreshCostBadge(){
  const r=await fetch('/api/cache-stats',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json().catch(()=>null); if(!j) return;
  const bd=j.breakdown||{}; const gd=j.guard||null; const sm=j.summary||{};
  // v0.4.3：本地/自定义模型无定价时费用恒 0——此前显示「¥0.0000」被误读为「无统计」。
  // 有用量但累计费用为 0 即判定为无计价模型，明确标注而非含糊 ¥0。
  let t;
  if ((sm.turns||0) > 0 && (bd.totalCost||0) === 0) {
    t='📊 本地模型不计费 · 累计 ↑'+(sm.prompt||0)+' ↓'+(sm.completion||0)+' tokens';
  } else {
    t='📊 今日 ≈¥'+(bd.today||0).toFixed(4);
    if(bd.rate!=null) t+=' · 命中 '+(bd.rate*100).toFixed(0)+'%';
    if(gd&&gd.limit>0&&gd.cost!=null) t+=' · 护栏 '+(gd.cost/gd.limit*100).toFixed(0)+'%';
  }
  $('#costBadge').textContent=t;
  if($('#dashPanel').style.display==='flex') renderDashboard(j);
}
refreshCostBadge(); setInterval(refreshCostBadge, 15000);
$('#costBadge').onclick=()=>showRailTab('dash');
$('#dashClose').onclick=()=>{ setRunPanel(false); };
// 底部状态栏：轮次/步数/LLM 与工具时长/首 token 平均/吞吐/缓存命中/输入输出 tokens
async function refreshStatusBar(){
  const r=await fetch('/api/cache-stats',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json().catch(()=>null); if(!j) return;
  const s=j.summary||{};
  const ft = s.firstTokenAvgMs!=null ? (s.firstTokenAvgMs/1000).toFixed(0)+'s' : '—';
  const tps = s.tokensPerSec!=null ? Math.round(s.tokensPerSec)+' tok/s' : '—';
  const rate = s.rate!=null ? (s.rate*100).toFixed(1)+'%' : '—';
  $('#statusBar').textContent = s.turns+' 轮 · '+s.steps+' 步 | LLM '+fmtDur(s.llmMs)+' · 工具调用 '+fmtDur(s.toolMs)+' | 首 token 平均 '+ft+' · '+tps+' | 缓存命中 '+rate+' | 输入 '+fmtTok(s.prompt)+' tok · 输出 '+fmtTok(s.completion)+' tok';
}
refreshStatusBar(); setInterval(refreshStatusBar, 15000);
$('#tasksBtn').onclick=()=>showRailTab('tasks');
$('#tpClose').onclick=()=>{ setRunPanel(false); };

async function refreshSessions(q){
  const u=q?'/api/sessions?q='+encodeURIComponent(q):'/api/sessions';
  const r=await fetch(u).catch(()=>null); if(!r)return;
  const j=await r.json();
  sessionsCache=Array.isArray(j.sessions)?j.sessions:[];
  const sel=$('#sessions'); sel.innerHTML='<option value="">历史会话</option>';
  for(const s of sessionsCache){ const o=document.createElement('option'); o.value=s.file; o.textContent=s.label; sel.appendChild(o); }
  if(currentSession&&!q) sel.value=currentSession;
  renderSessionNav();
  updateCrumb();
}
/** §3.78 侧栏会话列表：消费既有 sessionsCache / #sessions change handler（不新增接口）。 */
function renderSessionNav(){
  const nav=$('#sessionNav'); if(!nav) return;
  const list=Array.isArray(sessionsCache)?sessionsCache:[];
  nav.innerHTML='';
  if(!list.length){ nav.innerHTML='<div class="sess-empty">暂无会话（发一条消息后自动出现）</div>'; return; }
  for(const s of list){
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='sess'+(currentSession===s.file?' active':'');
    btn.dataset.file=s.file;
    btn.title=s.label||s.file;
    if(currentSession===s.file) btn.setAttribute('aria-current','true');
    const t=document.createElement('span'); t.className='t'; t.textContent=s.label||s.file;
    btn.appendChild(t);
    btn.onclick=()=>{ const sel=$('#sessions'); if(sel){ sel.value=s.file; sel.dispatchEvent(new Event('change')); } closeSideDrawer(); };
    nav.appendChild(btn);
  }
}
/** §3.78 顶栏「工作空间 › 当前会话」：只读既有状态，不新增请求。 */
function updateCrumb(){
  const ws=$('#wsSel');
  const opt=ws&&ws.selectedIndex>=0?ws.options[ws.selectedIndex]:null;
  const w=$('#crumbWs'); if(w) w.textContent=(opt?(opt.textContent||'').replace(/^●\s*/,''):'')||'工作空间';
  const cur=(sessionsCache||[]).find((x)=>x.file===currentSession);
  const c=$('#crumbSession'); if(c) c.textContent=cur?(cur.label||cur.file):'新对话';
}
let searchTimer=null;
$('#sessionSearch').addEventListener('input',e=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>refreshSessions(e.target.value.trim()),300); });
// 思考模式 / 推理等级（v0.2.8）：与模型选择并列在输入区，按当前模型独立。
// 仅 reasoning 模型显示该下拉（关/低/高/最高）；切换模型时随 /api/state 的 reasoning 字段刷新。
function applyReasoningUI(reasoning){
  const sel=$('#reasoningSel');
  if(!sel) return;
  const supported = Boolean(reasoning && reasoning.supported);
  sel.style.display = supported ? '' : 'none';
  if(!supported) return;
  const effort = reasoning && reasoning.effort ? reasoning.effort : 'high';
  sel.value = ['off','low','high','max'].includes(effort) ? effort : 'high';
}
$('#reasoningSel').onchange=()=>{ applyConfig({reasoningEffort:$('#reasoningSel').value}); };
// v0.4.0 Agent Preset：选中预设时给出「这是什么 / 覆盖了什么」的即时反馈（否则用户不知道各选项作用）
$('#presetSel').onchange=()=>{ presetPicked(); };
function presetPicked(){
  const val=$('#presetSel')?.value||'';
  const p=presetData.find((x)=>x.name===val);
  if(!p){ // 选回「无预设」= 退出预设模式
    runState.presetName='无预设'; renderSessionSettings(); renderRunPanel();
    renderBanner({ text: '已取消预设，恢复默认配置（不注入预设定制段/白名单/权限覆盖）。' }); return;
  }
  const over=[];
  if(Array.isArray(p.tools)) over.push('工具白名单 '+p.tools.length+' 个');
  if(p.permission) over.push('权限 '+p.permission);
  if(p.model) over.push('模型 '+p.model);
  if(p.maxRounds) over.push('maxRounds '+p.maxRounds);
  if(p.maxOutputTokens) over.push('maxOutput '+p.maxOutputTokens);
  if(p.temperature!==undefined) over.push('温度 '+p.temperature);
  if(p.contextBudget) over.push('预算 '+p.contextBudget);
  const summary=over.length?'（覆盖：'+over.join(' · ')+'）':'';
  // v0.6.12：预设声明的权限与你此刻选的权限档不一致时**当场说清楚谁说了算**。
  // 用户实测的困惑正是这里：预设 local-audit 声明 readonly，而他在「权限模式」里选的是自动——
  // 界面上两处各说各话，谁也不提示冲突，于是他看到的是"我选了自动却按只读跑"。
  const permNow=$('#permSel')?.value||'';
  const conflict=(p.permission&&permNow&&p.permission!==permNow)
    ? ' ⚠ 该预设声明权限 '+p.permission+'，与你当前选择的「'+permNow+'」不同——本轮按你的显式选择 '+permNow+' 执行（要按预设跑，请把权限模式切到 '+p.permission+'）。'
    : '';
  runState.presetName=p.label||p.name||'无预设';
  renderSessionSettings(); renderRunPanel();
  renderBanner({ text: '🧩 已选预设「'+(p.label||p.name)+'」：'+(p.description||'（无描述）')+summary+'。随本次发送生效，其余设置保持不变。'+conflict, warn: Boolean(conflict) });
}
async function init(){
  try{
    const r=await fetch('/api/state',{cache:'no-store'}); const j=await r.json();
    const ms=$('#modelSel'); ms.innerHTML='';
    const groups={}; const order=[];
    for(const m of (j.models||[])){ const g=m.providerLabel||'其他'; if(!groups[g]){groups[g]=[];order.push(g);} groups[g].push(m); }
    for(const g of order){
      const og=document.createElement('optgroup'); og.label=g;
      // §3.71：value=API id（选择键）、可见文本=显示名、title 保留来源说明（label/detail）+ API id；§139 仍要求 title 以 m.label 开头。
      for(const m of groups[g]){ const o=document.createElement('option'); o.value=m.id||m.name; o.textContent=m.label||m.id||m.name; o.title=m.label+' · API id: '+(m.id||m.name)+(m.detail&&m.detail!==m.label?' · '+m.detail:''); if((m.id||m.name)===j.model) o.selected=true; og.appendChild(o); }
      ms.appendChild(og);
    }
    if(!(j.models||[]).length){ const o=document.createElement('option'); o.value=j.model; o.textContent=j.model; ms.appendChild(o); }
    modelsCache=Array.isArray(j.models)?j.models:[];
    homeDir=String(j.home||'');
    workingDirCache=String(j.workingDir||'');
    compactAvailable=Boolean(j.compact||j.compactEndpoint||j.capabilities&&j.capabilities.compact);
    runState.modelName=String(j.model||'');
    const curEntry=modelsCache.find((m)=>m&&(m.id||m.name)===runState.modelName);
    runState.modelLabel=curEntry?String(curEntry.label||curEntry.id||curEntry.name||''):runState.modelName;
    $('#permSel').value=j.permission||'ask';
    // P0-4：/api/state 现在带 permissionSource（explicit/preset/config/cli/default）——
    // 状态条悬浮详情与会话设置里都能显示 "permission=auto（来源：显式选择/预设/config 默认）"。
    ctxLimit=Number(j.contextBudget)||ctxLimit;
    runState.contextTotal=ctxLimit; runState.permissionMode=String(j.permission||'ask'); runState.permissionSource=String(j.permissionSource||'');
    renderWorkStatus();
    renderSessionSettings();
    $('#sbxSel').value=j.sandbox||'off';
    settingDefaultsCache=settingDefaultsFromState(j);
    lastSandboxMode=j.sandbox||'off';
    $('#sbxHint').textContent=j.sandboxSupported?'':'当前环境未检测到 bubblewrap，readonly/safe 将自动降级为 off';
    $('#routeChk').checked=Boolean(j.routing);
    $('#budgetInput').value=j.contextBudget||128000;
    const to=j.timeout||{};
    $('#toFirstToken').value=to.firstTokenMs?Math.round(to.firstTokenMs/1000):'';
    $('#toStreamIdle').value=to.streamIdleMs?Math.round(to.streamIdleMs/1000):'';
    $('#toTotal').value=to.totalMs?Math.round(to.totalMs/1000):'';
    $('#autoStartChk').checked=Boolean(j.autostart);
    $('#notifyChk').checked=j.notify!==false;
    applyReasoningUI(j.reasoning);
    const env = ('路由'+(j.routing?'开':'关')+' · 沙箱'+((j.sandbox&&j.sandbox!=='off')?(j.sandboxSupported?j.sandbox:'降级'):'off'));
    $('#envBadge').textContent=env; $('#envBadge').style.display='';
    // 首次使用引导：无 API Key 时明确提示去设置（桌面版自动初始化后必走这里）
    if (j.keyReady === false) {
      renderBanner({ text: '🔑 欢迎使用 MingDao Harness！还没有配置 API Key：请点击右上角 ⚙ 设置 →「模型与 API Key」选择模型并填入密钥（DeepSeek 平台申请）后即可对话。' });
    }
  }catch(e){
    const ms=$('#modelSel'); if(!ms.options.length){ const o=document.createElement('option'); o.textContent='加载失败，刷新重试'; ms.appendChild(o); }
  }
  refreshSessions();
  refreshWsSel();
  try{
    // v0.4.0 Agent Preset：加载预设列表进下拉（项目 → 用户 → 内置）
    const pr=await fetch('/api/presets',{cache:'no-store'}).catch(()=>null); const pj=pr?await pr.json():{presets:[]};
    presetData = Array.isArray(pj.presets) ? pj.presets : [];
    const psel=$('#presetSel'); if(psel&&presetData.length){ for(const p of presetData){ const o=document.createElement('option'); o.value=p.name; o.textContent=p.label+'（'+(p.source==='project'?'项目':p.source==='user'?'用户':'内置')+'）'; o.title=p.description||p.name; psel.appendChild(o); } }
  }catch(e){}
  try{
    const dr=await fetch('/api/draft?file='+encodeURIComponent(currentSession||''),{cache:'no-store'}); const dj=await dr.json();
    if(dj.text){ input.value=dj.text; input.style.height=Math.min(input.scrollHeight,200)+'px'; input.focus(); updateDraftBadge(); }
  }catch(e){}
  renderSessionSettings();
  renderEmptyState();
  renderRunPanel();
  refreshSettingColumns();
  renderTracePanels();
}

// v0.4.7（T24）：IDE「发送选中代码」此前不生效——扩展 POST /api/draft 时只带 text（写进**全局槽**），
// 而 WebUI 只在 init() 里按**会话槽**读取一次；扩展聚焦面板并不会重新加载页面，草稿永远读不到。
// 这里在窗口重新获得焦点时兜底读一次全局槽（读取即清除，不影响会话槽语义）。
window.addEventListener('focus',async()=>{
  try{
    if(typeof generating!=='undefined'&&generating) return;
    if(!input||String(input.value||'').trim()) return; // 输入框已有内容则不覆盖
    const d=await (await fetch('/api/draft',{cache:'no-store'})).json();
    if(d&&d.text){ input.value=d.text; input.style.height=Math.min(input.scrollHeight,200)+'px'; input.focus(); }
  }catch(e){}
});
// 设置多级菜单：左侧分组导航 ↔ 右侧面板切换（记住上次所在分组）
let cfgPanel='models';
function showCfgPanel(name){
  cfgPanel=name;
  document.querySelectorAll('.cfg-nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.panel===name));
  document.querySelectorAll('.cfg-panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===name));
}
document.querySelectorAll('.cfg-nav-btn').forEach(b=>{ b.onclick=()=>showCfgPanel(b.dataset.panel); });
/** P1-2：命令面板「打开设置」与深链复用同一入口（可指定分组）。 */
function openSettingsPanel(panel){
  $('#cfgModal').style.display='flex';
  showCfgPanel(panel||cfgPanel);
  refreshSettingColumns(); // P2-1：每次打开都按当前 config 刷新「默认 / 当前 / 影响」三列
}
$('#cfgBtn').onclick=()=>openSettingsPanel(cfgPanel);
$('#cfgCancel').onclick=()=>{ $('#cfgModal').style.display='none'; };
// —— 工作空间头部下拉（⚙ 右侧：切换 / 新建 / 管理） ——
async function refreshWsSel(){
  const r=await fetch('/api/workspaces',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json();
  workspacesCache=Array.isArray(j.workspaces)?j.workspaces:[];
  currentWorkspaceName=j.current||'';
  renderEmptyState();
  const sel=$('#wsSel'); sel.innerHTML='';
  const cur=document.createElement('option'); cur.value=''; cur.textContent='工作空间'+(j.current?'：'+j.current:'');
  sel.appendChild(cur);
  for(const w of j.workspaces||[]){
    const o=document.createElement('option'); o.value=w.name; o.textContent=(w.name===j.current?'● ':'')+w.name;
    if(w.name===j.current) o.selected=true;
    sel.appendChild(o);
  }
  const add=document.createElement('option'); add.value='__add__'; add.textContent='＋ 新建工作空间…';
  sel.appendChild(add);
  const mgr=document.createElement('option'); mgr.value='__manage__'; mgr.textContent='管理（重命名/删除/改目录）…';
  sel.appendChild(mgr);
  updateCrumb();
}
/** 命令面板与顶栏下拉共用的工作空间切换（携带当前会话，语义与旧路径一致）。 */
async function applyWorkspaceSwitch(name){
  if(!name) return;
  const payload={action:'set',name};
  if(currentSession) payload.file=currentSession;
  const r=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok) renderBanner({text:'✓ 已切换到工作空间 '+j.name+'（'+j.dir+'），后续工具在此目录执行'}); else { uiAlert(j.error||'切换失败'); }
  refreshWsSel(); reloadModels();
}
$('#wsSel').addEventListener('change', async e=>{
  const v=e.target.value;
  if(v==='__add__'){
    const name=await uiPrompt('新工作空间名称：'); if(!name){ refreshWsSel(); return; }
    openDirPicker(null, (dir)=>{
      fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',name,dir:dir||undefined})})
        .then((r)=>r.json()).then((j)=>{
          if(j.ok) renderBanner({text:'✓ 已登记工作空间 '+j.name+' → '+j.dir+'（目录已自动创建）'}); else uiAlert(j.error||'创建失败');
          refreshWsSel(); reloadModels();
        });
    });
    return;
  }
  if(v==='__manage__'){
    $('#cfgModal').style.display='flex'; showCfgPanel('workspace'); refreshWorkspaces();
    refreshWsSel();
    return;
  }
  if(v) await applyWorkspaceSwitch(v);
});
$('#cfgBtn').addEventListener('click', ()=>{ refreshModelsCfg(); refreshSyncUI(); refreshSyncShares(); refreshSyncConflicts(); refreshSchList(); refreshWorkspaces(); loadMemoryUI(); refreshMcpPresets(); refreshSkillLib(''); });
$('#schWhen').onchange=e=>{ const v=e.target.value; $('#schAtRow').style.display=v==='at'?'':'none'; $('#schEveryRow').style.display=v==='every'?'':'none'; $('#schAfterRow').style.display=v==='after'?'':'none'; $('#schChainRow').style.display=v==='chain'?'':'none'; };
async function refreshSchList(){
  const r=await fetch('/api/schedule',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#schList'); list.innerHTML='';
  if(!j.jobs||!j.jobs.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px 2px">暂无调度任务</div>'; return; }
  for(const s of j.jobs){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    const mark=s.status==='running'?'▶':s.status==='paused'?'⏸':s.status==='done'?'✓':s.status==='skipped'?'⊘':'⏳';
    const when=s.kind==='every'?('每 '+(s.interval>=86400000?(s.interval/86400000)+'d':s.interval>=3600000?(s.interval/3600000)+'h':s.interval>=60000?(s.interval/60000)+'m':(s.interval/1000)+'s')):s.kind==='once'?(s.nextRunAt?new Date(s.nextRunAt).toLocaleString():''):('依赖 '+ (s.after||[]).join(','));
    div.innerHTML='<span>'+mark+'</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(s.question)+'</span><span style="color:var(--faint);white-space:nowrap">'+esc(when)+' · '+s.runs+'次</span>';
    if((s.history||[]).length){ const hb=document.createElement('button'); hb.textContent='历史('+s.history.length+')'; hb.style.cssText='padding:1px 8px;font-size:11px'; const hist=document.createElement('div'); hist.style.cssText='display:none;padding:4px 0 4px 18px;font-size:11.5px;color:var(--dim)'; for(const h of s.history.slice(-8).reverse()){ hist.innerHTML+='<div>· '+new Date(h.at).toLocaleTimeString()+' '+(h.status==='done'?'✓':'✖')+' '+(h.durationMs!=null?(h.durationMs/1000).toFixed(1)+'s':'')+' '+esc((h.text||'').slice(0,60))+'</div>'; } hb.onclick=()=>{ hist.style.display=hist.style.display==='none'?'block':'none'; }; div.parentElement.insertBefore(hist, div.nextSibling); div.appendChild(hb); }
    if(s.status!=='done'&&s.status!=='skipped'){ const pa=document.createElement('button'); pa.textContent=s.status==='paused'?'恢复':'暂停'; pa.style.cssText='padding:1px 8px;font-size:11px'; pa.onclick=()=>schAction(s.status==='paused'?'resume':'pause', s.id); div.appendChild(pa); }
    const rm=document.createElement('button'); rm.textContent='删除'; rm.className='danger'; rm.style.cssText='padding:1px 8px;font-size:11px'; rm.onclick=()=>schAction('remove', s.id); div.appendChild(rm);
    list.appendChild(div);
  }
}
async function schAction(action,id){ await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,id})}); refreshSchList(); }
$('#schAdd').onclick=async ()=>{
  const q=$('#schQuestion').value.trim(); if(!q) return;
  const kind=$('#schWhen').value;
  const payload={action:'add',question:q};
  if($('#schOffpeak').checked) payload.offpeak=true;
  if(kind==='at'){ const v=$('#schAt').value; if(!v) return; payload.at=v.replace('T',' '); }
  else if(kind==='every'){ payload.every=$('#schEvery').value; }
  else if(kind==='chain'){ const v=$('#schChain').value.trim(); if(!v) return; const qs=v.split('\n').map(x=>x.trim()).filter(Boolean); if(qs.length<2){ uiAlert('链式需要至少两行任务'); return; } payload.action='chain'; payload.questions=qs; }
  else { const v=$('#schAfter').value.trim(); if(!v) return; payload.after=[v]; }
  const r=await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#schQuestion').value=''; refreshSchList(); } else { uiAlert(j.error||'添加失败'); }
};
// —— 工作空间 ——
async function refreshWorkspaces(){  const r=await fetch('/api/workspaces',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#wsList'); list.innerHTML='';
  if(!j.workspaces||!j.workspaces.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px 2px">暂无登记的工作空间</div>'; return; }
  for(const w of j.workspaces){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    div.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.name)+(w.name===j.current?' <span style="color:var(--accent)">●当前</span>':'')+'</span><span style="flex:1.4;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left">'+esc(w.dir||'')+'</span>';
    const ed=document.createElement('button'); ed.textContent='改目录'; ed.style.cssText='padding:1px 8px;font-size:11px'; ed.onclick=()=>{ openDirPicker(w.dir||null, async (d)=>{ if(d==null) return; const rr=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set',name:w.name,dir:d})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshWorkspaces(); refreshWsSel(); reloadModels(); } else uiAlert(jj.error||'修改失败'); }); };
    const rn=document.createElement('button'); rn.textContent='重命名'; rn.style.cssText='padding:1px 8px;font-size:11px'; rn.onclick=async()=>{ const t=await uiPrompt('新名称：', w.name); if(!t) return; const rr=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rename',name:w.name,newName:t})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshWorkspaces(); refreshWsSel(); } else uiAlert(jj.error||'重命名失败'); };
    const rm=document.createElement('button'); rm.textContent='删除'; rm.className='danger'; rm.style.cssText='padding:1px 8px;font-size:11px'; rm.onclick=async()=>{ const gate=await confirmDanger('removeWorkspace', async()=>{ await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',name:w.name})}); }); if(gate.cancelled) return; refreshWorkspaces(); refreshWsSel(); reloadModels(); };
    div.appendChild(ed); div.appendChild(rn); div.appendChild(rm); list.appendChild(div);
  }
}
// 登记工作空间（设置面板 → 工作空间）：**目录一律走 openDirPicker**（桌面版原生对话框 →
// 浏览器内置目录弹窗回退），与主界面「＋ 新建工作空间…」（#wsSel 的 __add__ 分支）同一条路径。
// v0.6.8 接原生选择器时**只接了主界面**：这条路径直接读 #wsDir 手输框，用户点「登记」什么都不弹
// （负责人实测）。守卫见 test/smoke.js §138（防的就是"只接了一处、漏了另一处"这类漏接）。
async function addWorkspaceFromSettings(dir){
  const name=$('#wsName').value.trim();
  if(!name){ uiAlert('请先填写工作空间名称'); return; } // 不静默无反应
  // dir 为空（手输框留空 / 选择器里点「不指定（当前目录）」）→ 不带该字段，服务端按当前工作目录登记
  const payload={action:'add',name}; if(dir) payload.dir=dir;
  const r=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#wsName').value=''; $('#wsDir').value=''; refreshWorkspaces(); refreshWsSel(); reloadModels(); } else uiAlert(j.error||'添加失败');
}
$('#wsAdd').onclick=()=>{
  if(!$('#wsName').value.trim()){ uiAlert('请先填写工作空间名称，再选择目录'); $('#wsName').focus(); return; }
  const typed=$('#wsDir').value.trim();
  // 手输了目录 → 直接登记；没输 → **直接弹选择器**（不再要求用户先知道绝对路径）
  if(typed){ addWorkspaceFromSettings(typed); return; }
  openDirPicker(null, (dir)=>{ addWorkspaceFromSettings(dir); }); // dir=null（「不指定（当前目录）」/取消）→ 仍按当前目录登记
};
// 目录框旁的「选择目录…」：选中即回填文本框（点「不指定」/取消则保持原样）
$('#wsDirPick').onclick=()=>{ openDirPicker($('#wsDir').value.trim()||null, (dir)=>{ if(dir==null) return; $('#wsDir').value=dir; renderBanner({text:'✓ 已选择目录：'+dir}); }); };
$('#wsDir').addEventListener('focus', ()=>{ $('#wsDir').title='可点右侧「选择目录…」用系统对话框选，或直接手输绝对路径'; });
// —— 长期记忆 ——
function memFlash(msg, good){ const m=$('#memMsg'); m.textContent=msg; m.style.color=good?'var(--accent)':'var(--err)'; setTimeout(()=>{m.textContent='';},4000); }
async function loadMemoryUI(){
  const r=await fetch('/api/memory',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); if(j.ok) $('#memArea').value=j.content||'';
}
$('#memSave').onclick=async ()=>{
  const r=await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:$('#memArea').value})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  memFlash(j.ok?'✓ 已保存':('✖ '+(j.error||'保存失败')), Boolean(j.ok));
};
$('#memDedupe').onclick=async ()=>{
  const r=await fetch('/api/memory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dedupe'})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ memFlash('✓ 去重完成，移除 '+j.removed+' 行', true); loadMemoryUI(); } else memFlash('✖ '+(j.error||'去重失败'), false);
};
// —— 省钱仪表盘（v0.3.1：从设置移出，顶部费用徽标点击展开，真·仪表盘） ——
function renderRateGauge(rate){
  const r=48, cx=60, cy=60, circ=2*Math.PI*r;
  const p=Math.max(0,Math.min(1,Number(rate)||0));
  const color = p>=0.8 ? 'var(--accent)' : p>=0.5 ? 'var(--accent2)' : 'var(--warn)';
  $('#rateGauge').innerHTML =
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="var(--bg3)" stroke-width="13"/>'+
    '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="13" stroke-linecap="round" stroke-dasharray="'+(circ*p).toFixed(1)+' '+(circ*(1-p)).toFixed(1)+'" transform="rotate(-90 '+cx+' '+cy+')"/>';
  $('#rateGaugeNum').textContent=(p*100).toFixed(1)+'%';
}
function trendChart(days){
  if(!days||!days.length) return '<div style="color:var(--faint);font-size:11.5px;padding:6px">暂无费用记录</div>';
  const W=360, H=88, P=8;
  const max=Math.max(...days.map((/** @type {any} */ d)=>Number(d.cost)||0), 1e-9);
  const pts=days.map((/** @type {any} */ d, /** @type {number} */ i)=>{
    const x=P+i*(W-2*P)/Math.max(days.length-1,1);
    const y=H-P-(Number(d.cost)||0)/max*(H-2*P);
    return [x,y];
  });
  const line=pts.map((/** @type {any} */ p)=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area='M'+pts[0][0].toFixed(1)+','+(H-P)+' L'+pts.map((/** @type {any} */ p)=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' L')+' L'+pts[pts.length-1][0].toFixed(1)+','+(H-P)+' Z';
  const last=pts[pts.length-1];
  return '<div style="font-size:10.5px;color:var(--faint);margin-bottom:4px">最高 ¥'+max.toFixed(4)+' · '+days[0].day+' → '+days[days.length-1].day+'</div>'
    +'<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;height:auto">'
    +'<defs><linearGradient id="dg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--accent2);stop-opacity:.35"/><stop offset="1" style="stop-color:var(--accent2);stop-opacity:0"/></linearGradient></defs>'
    +'<path d="'+area+'" fill="url(#dg)"/>'
    +'<polyline points="'+line+'" fill="none" stroke="var(--accent2)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>'
    +'<circle cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="3" fill="var(--accent)"/>'
    +'</svg>';
}
function barList(items, isCost){
  if(!items||!items.length) return '<div style="color:var(--faint);font-size:11.5px;padding:4px">暂无记录</div>';
  const max=Math.max(...items.map((/** @type {any} */ i)=>Number(i.val)||0), 1e-9);
  return items.map((/** @type {any} */ i)=>{
    const pct=Math.max(3,Math.round((Number(i.val)||0)/max*100));
    const v=isCost ? '¥'+(Number(i.val)||0).toFixed(4) : fmtDur(i.val);
    return '<div class="dbar"><div class="t"><span class="n" title="'+esc(i.name)+'">'+esc(String(i.name||'—').slice(0,26))+'</span><span class="v">'+v+(i.sub?' · '+i.sub:'')+'</span></div><div class="track"><div class="fill" style="width:'+pct+'%"></div></div></div>';
  }).join('');
}
function renderDashboard(j){
  const s=j.summary||{}; const bd=j.breakdown||{};
  const rate=bd.rate!=null?bd.rate:(s.rate!=null?s.rate:0);
  const saved=Number(s.saved||0);
  $('#kpiToday').textContent='¥'+Number(bd.today||0).toFixed(4);
  $('#kpiRate').textContent=(rate*100).toFixed(1)+'%';
  $('#kpiSaved').textContent='¥'+saved.toFixed(4);
  $('#kpiTurns').textContent=(s.turns||0)+' / '+(s.steps||0);
  renderRateGauge(rate);
  $('#trendChart').innerHTML=trendChart((bd.byDay||[]).slice(-14));
  $('#dashModels').innerHTML=barList((bd.byModel||[]).slice(0,5).map((/** @type {any} */ m)=>({name:m.model, val:m.cost, sub:m.turns+' 轮'})), true);
  $('#dashTools').innerHTML=barList((bd.byTool||[]).slice(0,5).map((/** @type {any} */ t)=>({name:t.tool, val:t.ms, sub:t.calls+' 次'})), false);
  $('#dashRecent').innerHTML=(j.recent||[]).slice(0,6).map((/** @type {any} */ e)=>{
    const hit=e.hit!=null&&e.miss!=null&&(e.hit+e.miss)>0?e.hit/(e.hit+e.miss):null;
    return '<div class="dr"><span class="m">'+esc(e.model||'')+'</span><span class="p">'+(hit==null?'—':(hit*100).toFixed(0)+'%')+'</span><span class="c">¥'+Number(e.cost||0).toFixed(4)+'</span></div>';
  }).join('') || '<div style="color:var(--faint);font-size:11.5px">暂无记录</div>';
}
// —— MCP 生态预设 ——
let mcpPresetData=[];
async function refreshMcpPresets(){
  const r=await fetch('/api/mcp-presets',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); if(!j.ok) return;
  mcpPresetData=j.presets||[]; const sel=$('#mcpPresetSel'); sel.innerHTML='';
  for(const p of mcpPresetData){ const o=document.createElement('option'); o.value=p.name; o.textContent=p.name+' — '+p.label+(p.unavailableReason?'（不可用）':''); o.title=p.unavailableReason||((p.command||'npx')+' '+(p.args||[]).join(' ')); sel.appendChild(o); }
  sel.onchange=()=>{ const p=mcpPresetData.find(x=>x.name===sel.value); $('#mcpArg').placeholder=p&&p.argLabel?('参数：'+p.argLabel):'本预设无需参数'; };
  sel.onchange();
}
$('#mcpAdd').onclick=async ()=>{
  const name=$('#mcpPresetSel').value; if(!name) return;
  const arg=$('#mcpArg').value.trim();
  const r=await fetch('/api/mcp-presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arg})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok) uiAlert('✓ 已接入 '+name+'（重启 mingdao web 后生效，/mcp 查看状态）'); else uiAlert(j.error||'接入失败');
};
// —— 技能库 ——
let skillSearchTimer=null;
$('#skillSearch').addEventListener('input',e=>{ clearTimeout(skillSearchTimer); skillSearchTimer=setTimeout(()=>refreshSkillLib(e.target.value.trim()),300); });
async function refreshSkillLib(q, force){
  let u=q?'/api/skill-library?q='+encodeURIComponent(q):'/api/skill-library';
  if(force) u+=(q?'&':'?')+'refresh=1';
  const r=await fetch(u,{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#skillLibList'); list.innerHTML='';
  if(j.registry&&j.registry.error){
    const err=document.createElement('div'); err.style.cssText='color:var(--warn);font-size:11.5px;padding:4px 2px';
    err.textContent='✗ 线上 registry 不可达（仅显示内置库）：'+j.registry.error; list.appendChild(err);
  }else if(j.registry){
    const meta=document.createElement('div'); meta.style.cssText='color:var(--faint);font-size:11.5px;padding:4px 2px';
    meta.textContent='线上索引 '+new Date(j.registry.updatedAt).toLocaleString()+(j.registry.stale?'（缓存，已过期）':'');
    list.appendChild(meta);
  }
  if(!j.library||!j.library.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px 2px">没有匹配的技能</div>'; return; }
  for(const s of j.library){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    const badge=s.source==='registry'?'<span style="color:var(--accent2);font-size:10px">线上</span>':'<span style="color:var(--faint);font-size:10px">内置库</span>';
    div.innerHTML='<span style="flex:1;min-width:0"><b>'+esc(s.name)+'</b> '+badge+' <span style="color:var(--faint)">'+esc(s.description||'')+'</span></span>';
    const b=document.createElement('button');
    if(s.installed){ b.textContent='卸载'; b.className='danger'; } else { b.textContent='安装'; }
    b.style.cssText='padding:1px 8px;font-size:11px';
    b.onclick=async()=>{
      const body=s.installed?{action:'uninstall',name:s.name}:{action:'install',name:s.name};
      const rr=await fetch('/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const jj=await rr.json().catch(()=>({error:'请求失败'}));
      if(jj.ok) refreshSkillLib($('#skillSearch').value.trim()); else uiAlert(jj.error||'操作失败');
    };
    div.appendChild(b); list.appendChild(div);
  }
}
$('#skillRegRefresh').onclick=()=>{ refreshSkillLib($('#skillSearch').value.trim(), true); };
// —— 模型与 API Key ——
async function reloadModels(){
  try{
    const r=await fetch('/api/state',{cache:'no-store'}); const j=await r.json();
    const ms=$('#modelSel'); ms.innerHTML='';
    const groups={}; const order=[];
    for(const m of (j.models||[])){ const g=m.providerLabel||'其他'; if(!groups[g]){groups[g]=[];order.push(g);} groups[g].push(m); }
    for(const g of order){
      const og=document.createElement('optgroup'); og.label=g;
      // §3.71：value=API id（选择键）、可见文本=显示名、title 保留来源说明（label/detail）+ API id；§139 仍要求 title 以 m.label 开头。
      for(const m of groups[g]){ const o=document.createElement('option'); o.value=m.id||m.name; o.textContent=m.label||m.id||m.name; o.title=m.label+' · API id: '+(m.id||m.name)+(m.detail&&m.detail!==m.label?' · '+m.detail:''); if((m.id||m.name)===j.model) o.selected=true; og.appendChild(o); }
      ms.appendChild(og);
    }
    if(!(j.models||[]).length){ const o=document.createElement('option'); o.value=j.model; o.textContent=j.model; ms.appendChild(o); }
    modelsCache=Array.isArray(j.models)?j.models:[];
    homeDir=String(j.home||homeDir);
    workingDirCache=String(j.workingDir||workingDirCache);
    compactAvailable=Boolean(j.compact||j.compactEndpoint||j.capabilities&&j.capabilities.compact);
    runState.modelName=String(j.model||runState.modelName||'');
    const curEntry=modelsCache.find((m)=>m&&(m.id||m.name)===runState.modelName);
    runState.modelLabel=curEntry?String(curEntry.label||curEntry.id||curEntry.name||''):runState.modelName;
    const env=('路由'+(j.routing?'开':'关')+' · 沙箱'+((j.sandbox&&j.sandbox!=='off')?(j.sandboxSupported?j.sandbox:'降级'):'off'));
    $('#envBadge').textContent=env; $('#envBadge').style.display='';
    if(j.contextBudget){ ctxLimit=Number(j.contextBudget)||ctxLimit; runState.contextTotal=ctxLimit; }
    runState.permissionMode=String(j.permission||'ask'); runState.permissionSource=String(j.permissionSource||'');
    settingDefaultsCache=settingDefaultsFromState(j);
    lastSandboxMode=String(j.sandbox||lastSandboxMode||'off');
    applyReasoningUI(j.reasoning);
    renderWorkStatus();
    renderSessionSettings();
    refreshSettingColumns();
  }catch(e){}
}
async function refreshModelsCfg(){
  const r=await fetch('/api/models-config',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); if(!j.ok) return;
  const pk=$('#pkList'); pk.innerHTML='';
  for(const p of j.providers){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    const state=p.keyState==='stored'?'<span style="color:var(--accent)">已存 '+esc(p.keyMasked||'')+'</span>':p.keyState==='env'?'<span style="color:var(--dim)">环境变量 '+esc(p.envKey||'')+'</span>':'<span style="color:var(--err)">未设置</span>';
    div.innerHTML='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>'+esc(p.name)+'</b> '+esc(p.label)+'</span><span style="white-space:nowrap">'+state+'</span>';
    const set=document.createElement('button'); set.textContent='设Key'; set.style.cssText='padding:1px 8px;font-size:11px';
    set.onclick=async()=>{ const k=await uiPrompt('API Key（'+p.name+'）：', null, {hidden:true}); if(k===null) return; const rr=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setProviderKey',provider:p.name,key:k})}); const jj=await rr.json().catch(()=>({error:'请求失败'})); if(jj.ok){ refreshModelsCfg(); reloadModels(); if(jj.modelsNote) uiAlert(jj.modelsNote); } else uiAlert(jj.error||'设置失败'); };
    if(p.keyState==='stored'&&p.name!=='custom'){ const rf=document.createElement('button'); rf.textContent='刷新模型'; rf.style.cssText='padding:1px 8px;font-size:11px'; rf.onclick=async()=>{ const rr=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refreshModels',provider:p.name})}); const jj=await rr.json().catch(()=>({error:'请求失败'})); if(jj.ok){ reloadModels(); uiAlert('✓ 已拉取 '+jj.models.length+' 个线上模型'+(jj.fromCache?'（缓存）':'')); } else uiAlert(jj.error||'刷新失败'); }; div.appendChild(rf); }
    if(p.keyState==='stored'){ const rm=document.createElement('button'); rm.textContent='删除'; rm.className='danger'; rm.style.cssText='padding:1px 8px;font-size:11px'; rm.onclick=async()=>{ if(!await uiConfirm('删除 '+p.name+' 的 Key？')) return; await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'removeProviderKey',provider:p.name})}); refreshModelsCfg(); reloadModels(); }; div.appendChild(rm); }
    div.appendChild(set); pk.appendChild(div);
  }
  const cl=$('#cmList'); cl.innerHTML='';
  if(!(j.customModels||[]).length) cl.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px 2px">暂无自定义模型</div>';
  for(const c of j.customModels){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    const kstate=c.keyState==='stored'?'<span style="color:var(--accent)">'+esc(c.keyMasked||'')+'</span>':'<span style="color:var(--err)">无Key</span>';
    div.innerHTML='<span style="flex:1;min-width:0"><b>'+esc(c.name)+'</b> <span style="color:var(--faint)">'+esc(c.label)+' · '+esc(c.baseUrl)+'</span></span><span style="white-space:nowrap">'+kstate+'</span>';
    const sk=document.createElement('button'); sk.textContent='设Key'; sk.style.cssText='padding:1px 8px;font-size:11px'; sk.onclick=async()=>{ const k=await uiPrompt('API Key（'+c.name+'）：', null, {hidden:true}); if(k===null) return; fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setCustomKey',name:c.name,key:k})}).then(rr=>rr.json()).then(jj=>{ if(jj.ok) refreshModelsCfg(); else uiAlert(jj.error||'设置失败'); }); };
    const test=document.createElement('button'); test.textContent='测试'; test.style.cssText='padding:1px 8px;font-size:11px'; test.onclick=async()=>{ test.disabled=true; test.textContent='测试中…'; try{ const rr=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'testCustom',name:c.name})}); const jj=await rr.json().catch(()=>({error:'请求失败'})); if(jj.ok){ await uiAlert('✅ 连接成功（'+jj.latencyMs+'ms）：'+esc(jj.reply||'空回复')); } else { await uiAlert('✖ 连接失败：'+esc(jj.error||'未知错误')); } } finally { test.disabled=false; test.textContent='测试'; } };
    const ed=document.createElement('button'); ed.textContent='修改'; ed.style.cssText='padding:1px 8px;font-size:11px'; ed.onclick=async()=>{ const u=await uiPrompt('API 地址：', c.baseUrl); if(u===null) return; const l=await uiPrompt('标签：', c.label); if(l===null) return; // v0.4.1：本地模型上下文窗口/最大输出可在设置里直接改（此前只能改 baseUrl+label，本地模型补 contextWindow 需手改 config.json）
    const cw=await uiPrompt('上下文窗口 tokens（本地模型必填，如 131072；留空=不变）', c.contextWindow||''); if(cw===null) return; const mo=await uiPrompt('最大输出 tokens（可选，如 8192；留空=不变）', c.maxOutputTokens||''); if(mo===null) return;     // v0.6.5（审计 P1-20 同类第二入口）：改已有自定义模型的 API 地址会把它的已存 Key 发往新地址，
    // 服务端返回 {needKey:true} → 补输该模型的 Key 后重试一次（与"设Key"同款隐藏输入）。
    const sendEd=(extra)=>fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'updateCustom',name:c.name,baseUrl:u,label:l,contextWindow:Number(cw)||undefined,maxOutputTokens:Number(mo)||undefined,...extra})}).then(rr=>rr.json()).catch(()=>({error:'请求失败'}));
    let jjEd=await sendEd({});
    if(jjEd&&jjEd.needKey){ const k=await uiPrompt('改 API 地址会把该模型已存储的 Key 发往新地址，请输入它的 API Key 以确认：',null,{hidden:true}); if(k===null||!k) return; jjEd=await sendEd({apiKey:k}); }
    if(jjEd&&jjEd.ok){ refreshModelsCfg(); reloadModels(); } else uiAlert((jjEd&&jjEd.error)||'修改失败'); };
    const rm=document.createElement('button'); rm.textContent='删除'; rm.className='danger'; rm.style.cssText='padding:1px 8px;font-size:11px'; rm.onclick=async()=>{ if(!await uiConfirm('删除自定义模型 '+c.name+'？')) return; const rr=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'removeCustom',name:c.name})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshModelsCfg(); reloadModels(); } else uiAlert(jj.error||'删除失败'); };
    div.appendChild(sk); div.appendChild(test); div.appendChild(ed); div.appendChild(rm); cl.appendChild(div);
  }
  $('#baseUrlOverride').value=j.baseUrlOverride||'';
}
$('#cmAdd').onclick=async ()=>{
  const name=$('#cmName').value.trim();
  const url=$('#cmUrl').value.trim();
  if(!name||!url){ uiAlert('模型名与 API 地址必填'); return; }
  const r=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'addCustom',name,label:$('#cmLabel').value.trim(),baseUrl:url,key:$('#cmKey').value,contextWindow:Number($('#cmCtx').value)||undefined,maxOutputTokens:Number($('#cmMaxOut').value)||undefined})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#cmName').value=''; $('#cmLabel').value=''; $('#cmUrl').value=''; $('#cmKey').value=''; $('#cmCtx').value=''; $('#cmMaxOut').value=''; refreshModelsCfg(); reloadModels(); } else uiAlert(j.error||'添加失败');
};
$('#baseUrlSave').onclick=async ()=>{
  // v0.6.5（独立审计 P1）：改 API 地址＝把已存储的 Key 发往新目的地，属凭证级操作。
  // 服务端在「该服务商已有 Key 且目的地 origin 变了」时返回 {needKey:true}，这里补输 Key 后重试一次。
  const baseUrl=$('#baseUrlOverride').value.trim();
  const post=(extra)=>fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setBaseUrl',baseUrl,...extra})}).then(r=>r.json()).catch(()=>({error:'请求失败'}));
  let j=await post({});
  if(j&&j.needKey){
    const k=await uiPrompt('改 API 地址会把已存储的 Key 发往新地址，请输入该服务商的 API Key 以确认：',null,{hidden:true});
    if(k===null||!k) return;
    j=await post({apiKey:k});
  }
  if(j&&j.ok) uiAlert('✓ API 地址已保存（立即生效）'); else uiAlert((j&&j.error)||'保存失败');
};
// —— 云同步 ——
async function refreshSyncUI(){
  const r=await fetch('/api/sync',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json();
  $('#syncUrl').value=j.url||'https://session.mingdao.ai/'; $('#syncUser').value=j.username||''; $('#syncDevice').value=j.deviceName||''; $('#syncAutoChk').checked=Boolean(j.auto);
  const st=$('#syncStatus');
  if(!j.configured) st.innerHTML='<span style="color:var(--faint)">未配置：填服务器地址并登录（服务器端运行 mingdao sync-server）</span>';
  else if(!j.loggedIn) st.innerHTML='<span style="color:var(--warn)">已配置 '+esc(j.url)+' · 未登录（输入密码登录）</span>';
  else {
    let line='<span style="color:var(--accent)">✓ 已登录 '+esc(j.username)+'（'+esc(j.deviceName)+'）→ '+esc(j.url)+'</span>';
    if(j.remote&&j.remote.sessions) line+=' · 远端 '+j.remote.sessions.length+' 个会话';
    if(j.remote&&j.remote.error) line+=' · <span style="color:var(--err)">'+esc(j.remote.error)+'</span>';
    st.innerHTML=line;
  }
}
$('#syncLogin').onclick=async ()=>{
  const url=$('#syncUrl').value.trim(); const username=$('#syncUser').value.trim(); const password=$('#syncPass').value;
  if(!url||!username||!password){ uiAlert('服务器地址、用户名、密码均必填'); return; }
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',url,username,password,deviceName:$('#syncDevice').value.trim()})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#syncPass').value=''; refreshSyncUI(); } else uiAlert(j.error||'登录失败');
};
$('#syncPush').onclick=async ()=>{
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'push'})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  uiAlert(j.ok?('✓ 已推送 '+j.pushed+' 个会话'+(j.conflicts?'，'+j.conflicts+' 个远端版本已备份 .server-*':'')):j.error);
  refreshSyncUI(); refreshSyncConflicts();
};
$('#syncLogout').onclick=async ()=>{ await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'logout'})}); refreshSyncUI(); };
$('#syncAutoChk').onchange=e=>{ applyConfig({syncAuto:e.target.checked}); };
// —— 分享与协作 / 冲突 ——
async function refreshSyncShares(){
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'shares'})}).catch(()=>null); if(!r) return;
  const j=await r.json();
  const ml=$('#shareList'); ml.innerHTML='';
  if(j.ok&&j.mine&&j.mine.length){
    for(const s of j.mine){
      const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px';
      div.innerHTML='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"><b>'+esc(s.shareId)+'</b> <span style="color:var(--faint)">'+esc(s.name)+' · 被接受 '+s.pulls+' 次</span></span>';
      const b=document.createElement('button'); b.textContent='撤销'; b.className='danger'; b.style.cssText='padding:1px 8px;font-size:11px';
      b.onclick=async()=>{ const rr=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unshare',shareId:s.shareId})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok) refreshSyncShares(); else uiAlert(jj.error||'撤销失败'); };
      div.appendChild(b); ml.appendChild(div);
    }
  } else { ml.innerHTML='<div style="color:var(--faint);font-size:12px;padding:4px 2px">暂无分享（分享后此处显示分享码）</div>'; }
  const al=$('#shareAccepted'); al.innerHTML='';
  if(j.ok&&j.accepted&&j.accepted.length){
    for(const s of j.accepted){
      const div=document.createElement('div'); div.style.cssText='padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--dim)';
      div.textContent='· '+s.owner+' 的 '+s.name+' → 本地 '+s.savedAs;
      al.appendChild(div);
    }
  } else { al.innerHTML='<div style="color:var(--faint);font-size:12px;padding:4px 2px">未接受任何分享</div>'; }
}
$('#shareCreate').onclick=async ()=>{
  const name=$('#shareName').value.trim(); if(!name){ uiAlert('输入会话文件名'); return; }
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'share',name})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#shareName').value=''; refreshSyncShares(); } else uiAlert(j.error||'创建失败');
};
$('#shareAccept').onclick=async ()=>{
  const code=$('#acceptCode').value.trim(); if(!code){ uiAlert('输入分享码'); return; }
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'accept',shareId:code})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#acceptCode').value=''; refreshSyncShares(); refreshSessions(); } else uiAlert(j.error||'接受失败');
};
$('#passwdBtn').onclick=async ()=>{
  const oldPass=$('#oldPass').value, newPass=$('#newPass').value;
  if(!oldPass||!newPass){ uiAlert('旧密码与新密码均必填'); return; }
  const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'passwd',oldPassword:oldPass,newPassword:newPass})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#oldPass').value=''; $('#newPass').value=''; uiAlert('✓ 密码已修改'); } else uiAlert(j.error||'修改失败');
};
async function refreshSyncConflicts(){
  const r=await fetch('/api/sync-conflicts',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#conflictList'); list.innerHTML='';
  if(!j.conflicts||!j.conflicts.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:4px 2px">暂无冲突</div>'; return; }
  for(const c of j.conflicts){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    div.innerHTML='<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c.base)+' <span style="color:var(--faint)">'+(c.localExists?'本地有':'本地无')+' · 备份 '+c.entries.length+'</span></span>';
    const mk=(label,choice,cls)=>{ const b=document.createElement('button'); b.textContent=label; if(cls) b.className=cls; b.style.cssText='padding:1px 8px;font-size:11px'; b.onclick=async()=>{ const rr=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'resolveConflict',base:c.base,choice})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok) refreshSyncConflicts(); else uiAlert(jj.error||'解决失败'); }; return b; };
    div.appendChild(mk('保留本地','local')); div.appendChild(mk('采用远端','remote','danger')); div.appendChild(mk('都保留','both'));
    list.appendChild(div);
  }
}
$('#cfgSave').onclick=async()=>{ const to={}; const ft=Number($('#toFirstToken').value), si=Number($('#toStreamIdle').value), tt=Number($('#toTotal').value); if(ft>0) to.firstTokenMs=Math.round(ft*1000); if(si>0) to.streamIdleMs=Math.round(si*1000); if(tt>0) to.totalMs=Math.round(tt*1000); const sbx=$('#sbxSel').value; // P2-2：若选择时被 Esc/取消绕过了沙箱确认，保存路径再拦一次（取消则不落盘）
  if(dangerGateNeeded('sandboxOff', lastSandboxMode, sbx)){ const gate=await confirmDanger('sandboxOff', async()=>{}); if(gate.cancelled){ $('#sbxSel').value=lastSandboxMode; return; } }
  lastSandboxMode=sbx; const payload={sandbox:sbx, routing:$('#routeChk').checked, contextBudget:Number($('#budgetInput').value), autostart:$('#autoStartChk').checked, notify:$('#notifyChk').checked}; if(Object.keys(to).length) payload.timeout=to; applyConfig(payload); refreshSettingColumns(); $('#cfgModal').style.display='none'; };
async function applyConfig(payload, revertTarget){
  const r=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  const m=$('#cfgMsg');
  if(j.ok){
    if(payload.model!==undefined) m.textContent='✓ 已切换 '+j.model;
    else if(payload.permission!==undefined) m.textContent='✓ 权限 '+j.permission;
    else m.textContent='✓ 设置已保存';
    m.style.color='var(--accent)';
    reloadModels(); // 路由/沙箱等状态徽章实时刷新
  }else{
    m.textContent='✖ '+j.error; m.style.color='var(--err)';
    if(revertTarget){
      const st=await fetch('/api/state',{cache:'no-store'});
      const sj=await st.json();
      revertTarget.value=revertTarget.id==='modelSel'?sj.model:sj.permission;
    }
  }
  m.style.display=''; setTimeout(()=>{m.style.display='none';},4000);
}
$('#modelSel').addEventListener('change', e=>{ runState.modelName=e.target.value; runState.modelLabel=(modelsCache.find((m)=>m&&(m.id||m.name)===e.target.value)||{}).label||e.target.value; applyConfig({model:e.target.value}, e.target); renderSessionSettings(); renderRunPanel(); });
$('#permSel').addEventListener('change', e=>{ setPermissionEverywhere(e.target.value); });
// v0.3.0 P0-3：会话边界收尾（切换/新对话时提取项目记忆+日志，fire-and-forget 不阻塞 UI）
function finalizeCurrentSession(){
  if(!currentSession) return;
  fetch('/api/session-finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:currentSession})}).catch(()=>{});
}
async function loadSession(file){ if(currentSession && currentSession!==file) finalizeCurrentSession(); currentSession=file; chatEl.innerHTML=''; resetTraceState(); const r=await fetch('/api/session?file='+encodeURIComponent(file)); const j=await r.json(); for(const m of j.messages||[]){ if(typeof m.content==='string'&&m.content.startsWith('（系统提示）')) continue; if(m.role==='user') addUser(m.content); else { const el=newAiMsg(); aiContent(el).innerHTML=renderMarkdown(m.content); } } if(j.workspace){ const sel=$('#wsSel'); const has=[...sel.options].some(o=>o.value===j.workspace); if(has){ sel.value=j.workspace; } else { refreshWsSel(); } renderBanner({text:'↩ 已回到该会话的工作空间：'+j.workspace}); } if(j.taskState&&(j.taskState.status==='cap'||j.taskState.status==='interrupted')){ renderBanner({text:'⚠ 该会话有未完成任务（步数上限中断）——直接发送消息即可从断点续跑，已完成文件不会重复做。', warn:true}); } scrollBottom(); renderEmptyState(); updateCrumb(); renderSessionNav(); closeSideDrawer(); }

// ============================================================================
// P2 DOM 接线（v0.6.19 §3.76）
//   设置三列 / 六类危险操作确认框 / 语言切换 / 对比度自检 / aria-live 播报。
// ============================================================================
let settingDefaultsCache = settingDefaultsFromState(null);
let lastSandboxMode = 'off';

function secToMs(/** @type {any} */ v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}
/** 当前设置值：全部从既有控件/状态读取（不另存一份配置）。 */
function currentSettingValues() {
  return {
    permission: ($('#permSel') && $('#permSel').value) || runState.permissionMode || 'ask',
    sandbox: ($('#sbxSel') && $('#sbxSel').value) || lastSandboxMode || 'off',
    routing: Boolean($('#routeChk') && $('#routeChk').checked),
    contextBudget: Number($('#budgetInput') && $('#budgetInput').value) || settingDefaultsCache.contextBudget,
    timeout: {
      firstTokenMs: secToMs($('#toFirstToken') && $('#toFirstToken').value),
      streamIdleMs: secToMs($('#toStreamIdle') && $('#toStreamIdle').value),
      totalMs: secToMs($('#toTotal') && $('#toTotal').value),
    },
    autostart: Boolean($('#autoStartChk') && $('#autoStartChk').checked),
    notify: Boolean($('#notifyChk') && $('#notifyChk').checked),
    theme: storedThemePref(safeStorage()),
    language: storedLang(safeStorage()) || 'auto',
  };
}
/** 把三列写进设置面板（结构由 index.html 的 .cfg-cols 提供）。 */
function refreshSettingColumns() {
  const values = currentSettingValues();
  const views = settingColumnsView({ defaults: settingDefaultsCache, values, lang: getLang(), translate });
  for (const v of views) {
    const box = document.querySelector('[data-cols="' + v.key + '"]');
    if (!box) continue;
    const put = (sel, text) => { const n = box.querySelector(sel); if (n) n.textContent = text; };
    put('.cfg-default', v.defaultText);
    put('.cfg-current', v.currentText);
    put('.cfg-impact', v.impact);
    if (box.classList) box.classList.toggle('changed', v.changed);
    if (box.setAttribute) box.setAttribute('data-changed', String(v.changed));
  }
}
// —— 危险操作确认框：说明后果 + 必须点「确认」（回车不确认） ——
let dangerDialogHandle = null;
function openDangerDialog(meta) {
  return new Promise((resolve) => {
    const mask = $('#dangerMask');
    const dialog = $('#dangerDialog');
    if (!mask || !dialog || !meta) { resolve(false); return; }
    const title = $('#dangerTitle'); if (title) title.textContent = meta.title;
    const body = $('#dangerBody'); if (body) body.textContent = meta.consequence;
    const note = $('#dangerNote'); if (note) note.textContent = meta.note;
    const ok = $('#dangerOk'); if (ok) ok.textContent = meta.confirmLabel;
    const cancel = $('#dangerCancel'); if (cancel) cancel.textContent = meta.cancelLabel;
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    mask.hidden = false;
    let settled = false;
    const finish = (/** @type {boolean} */ value) => {
      if (settled) return;
      settled = true;
      mask.hidden = true;
      if (dangerDialogHandle) { const h = dangerDialogHandle; dangerDialogHandle = null; h.close(true); }
      resolve(value);
    };
    if (ok) ok.onclick = () => finish(true);
    if (cancel) cancel.onclick = () => finish(false);
    dangerDialogHandle = installDialog(dialog, {
      opener,
      label: meta.title,
      initialFocus: cancel,
      onClose: () => {
        if (settled) return;
        settled = true;
        mask.hidden = true;
        resolve(false);
      },
    });
  });
}
/**
 * 确认 + 执行（取消 → execute 绝不调用）。所有危险操作共用这一条出口。
 * @param {string} key
 * @param {Function} execute
 * @returns {Promise<{ok: boolean, cancelled: boolean, result?: any}>}
 */
function confirmDanger(key, execute) {
  return runDanger(key, { confirm: openDangerDialog, execute, translate, lang: getLang() });
}
/** 设置项「恢复默认」的 payload（模型与密钥不在其中）。 */
function resetConfigPayload() {
  const d = settingDefaultsCache;
  return {
    permission: d.permission || 'ask',
    sandbox: d.sandbox || 'off',
    routing: Boolean(d.routing),
    contextBudget: Number(d.contextBudget) || 128000,
    timeout: { firstTokenMs: null, streamIdleMs: null, totalMs: null },
    autostart: Boolean(d.autostart),
    notify: d.notify !== false,
  };
}
function applyResetConfigControls() {
  const d = settingDefaultsCache;
  if ($('#sbxSel')) $('#sbxSel').value = d.sandbox || 'off';
  if ($('#routeChk')) $('#routeChk').checked = Boolean(d.routing);
  if ($('#budgetInput')) $('#budgetInput').value = Number(d.contextBudget) || 128000;
  if ($('#toFirstToken')) $('#toFirstToken').value = '';
  if ($('#toStreamIdle')) $('#toStreamIdle').value = '';
  if ($('#toTotal')) $('#toTotal').value = '';
  if ($('#autoStartChk')) $('#autoStartChk').checked = Boolean(d.autostart);
  if ($('#notifyChk')) $('#notifyChk').checked = d.notify !== false;
  lastSandboxMode = d.sandbox || 'off';
  refreshSettingColumns();
}

// —— aria-live：只在状态变化时写 #a11yLive（同一状态重复渲染直接返回 false） ——
let lastLiveSnapshot = '';
function updateLiveRegion(view) {
  const r = liveAnnouncement(lastLiveSnapshot, view);
  if (!r.changed) return false;
  lastLiveSnapshot = r.snapshot;
  const n = $('#a11yLive'); if (n) n.textContent = r.text;
  return true;
}

// —— 语言切换：写 localStorage 并立即生效（默认跟随 navigator.language） ——
function applyLanguageChoice(/** @type {string} */ pref) {
  const storage = safeStorage();
  let lang;
  if (pref === 'auto') {
    try { if (storage) storage.removeItem(LANG_STORAGE_KEY); } catch { /* 隐私模式 */ }
    lang = detectLang(navLang());
    setLang(lang, { root: document.documentElement });
  } else {
    lang = setLang(pref, { storage, root: document.documentElement, navLang: navLang() });
  }
  const sel = $('#langSel'); if (sel) sel.value = pref === 'auto' ? 'auto' : lang;
  refreshSettingColumns();
  renderSessionSettings();
  renderWorkStatus();
  renderRunPanel();
  return lang;
}
const langSel = $('#langSel');
if (langSel) {
  langSel.value = storedLang(safeStorage()) || 'auto';
  langSel.onchange = () => applyLanguageChoice(langSel.value);
}
$('#memClear') && ($('#memClear').onclick = async () => {
  const gate = await confirmDanger('clearMemory', async () => {
    const r = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }) });
    return r.json().catch(() => ({}));
  });
  if (gate.cancelled) return;
  const j = gate.result || {};
  if (j.ok) { if ($('#memArea')) $('#memArea').value = ''; memFlash(t('settings.memCleared'), true); }
  else memFlash(t('settings.memClearFail') + (j.error || '失败'), false);
});
$('#cfgReset') && ($('#cfgReset').onclick = async () => {
  const gate = await confirmDanger('resetConfig', async () => applyConfig(resetConfigPayload()));
  if (gate.cancelled) return;
  applyResetConfigControls();
  const m = $('#cfgMsg');
  if (m) { m.textContent = t('settings.resetDone'); m.style.color = 'var(--accent)'; m.style.display = ''; setTimeout(() => { m.style.display = 'none'; }, 4000); }
});
// 沙箱：从非 off 切到 off 先确认；取消则回到上一个值（选择时拦截，保存时不再重复问）。
const sbxEl = $('#sbxSel');
if (sbxEl) {
  sbxEl.addEventListener('change', async () => {
    const next = sbxEl.value;
    if (dangerGateNeeded('sandboxOff', lastSandboxMode, next)) {
      const gate = await confirmDanger('sandboxOff', async () => {});
      if (gate.cancelled) { sbxEl.value = lastSandboxMode; return; }
    }
    lastSandboxMode = next;
  });
}


sendBtn.onclick=()=>{ if(generating){ stopTurnFromButton(); } else { send(); } };
const stripStopEl=$('#stripStop'); if(stripStopEl) stripStopEl.onclick=()=>stopTurnFromButton();
input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
input.addEventListener('input',()=>{ input.style.height='44px'; input.style.height=Math.min(input.scrollHeight,200)+'px'; updateDraftBadge(); });
/** §3.78 设计稿 .draft-badge：输入框有未发送文字时显示（真实草稿状态，不伪造）。 */
function updateDraftBadge(){ const d=$('#draftBadge'); if(d) d.hidden=!String(input.value||'').trim(); }
$('#newChat').onclick=()=>{ finalizeCurrentSession(); currentSession=null; chatEl.innerHTML=''; resetTraceState(); renderEmptyState(); updateCrumb(); renderSessionNav(); closeSideDrawer(); refreshSessions(); };
$('#sessMgrBtn').onclick=openSessModal;
$('#sessClose').onclick=()=>{ $('#sessModal').style.display='none'; };
async function openSessModal(){
  $('#sessModal').style.display='flex';
  const r=await fetch('/api/sessions',{cache:'no-store'}); const j=await r.json();
  const list=$('#sessList'); list.innerHTML='';
  if(!j.sessions.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px">暂无会话</div>'; return; }
  for(const s of j.sessions){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);font-size:12.5px';
    div.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(s.label)+'</span>';
    const rn=document.createElement('button'); rn.textContent='重命名'; rn.style.cssText='padding:1px 8px;font-size:11px'; rn.onclick=async()=>{ const t=await uiPrompt('新标题：', s.file.replace(/\.jsonl$/,'')); if(!t) return; const rr=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rename',file:s.file,title:t})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshSessions(); openSessModal(); } else uiAlert(jj.error||'重命名失败'); };
    const dl=document.createElement('button'); dl.textContent='删除'; dl.className='danger'; dl.style.cssText='padding:1px 8px;font-size:11px'; dl.onclick=async()=>{ const gate=await confirmDanger('deleteSession', async()=>{ const rr=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',file:s.file})}); return rr.json().catch(()=>({error:'失败'})); }); if(gate.cancelled) return; const jj=gate.result||{}; if(jj.ok){ if(currentSession===s.file){ currentSession=null; chatEl.innerHTML=''; renderEmptyState(); } refreshSessions(); openSessModal(); } else uiAlert(jj.error||'删除失败'); };
    div.appendChild(rn); div.appendChild(dl); list.appendChild(div);
  }
}
$('#sessions').onchange=e=>{ if(e.target.value){ loadSession(e.target.value); } else { finalizeCurrentSession(); currentSession=null; chatEl.innerHTML=''; resetTraceState(); renderEmptyState(); updateCrumb(); renderSessionNav(); } };
if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(()=>{}); }
init();
