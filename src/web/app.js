import { $, esc, highlight, renderMarkdown, scrollBottom, expandableBody, resultText, truncText, fmtDur, fmtTok, fmtT } from './util.js';
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES } from './constants.js';

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
  if (startDir) { pickerDir = startDir; loadDirList(); }
  else {
    // 无指定起点：从服务器当前工作目录开始浏览
    fetch('/api/workspaces', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
      pickerDir = (j && j.cwd) || '/';
      loadDirList();
    }).catch(() => { pickerDir = '/'; loadDirList(); });
  }
  $('#dirModal').style.display = 'flex';
}
$('#dirPickOk').onclick = () => { const cb = pickerCb; pickerCb = null; $('#dirModal').style.display = 'none'; if (cb) cb(pickerDir); };
$('#dirPickNone').onclick = () => { const cb = pickerCb; pickerCb = null; $('#dirModal').style.display = 'none'; if (cb) cb(null); };
$('#dirPickCancel').onclick = () => { pickerCb = null; $('#dirModal').style.display = 'none'; };
const chatEl = $('#chat'), input = $('#input'), sendBtn = $('#sendBtn');
let activeAiMsg=null, bgRunning=0, curSteps=0, curWorkT0=0, curTools=0, curTasks=0; // 本轮进度（活动条/状态条/轨迹共用）
let bgTasks=[]; // 后台任务列表快照（chip tooltip 详情用，updateTasksPanel 每 2s 刷新）
let curPhase='模型推理中'; // 阶段语义（服务端 progress 事件下发）
const sessionSubs=[]; // 本会话全部子代理（task 工具）条目：{seq, question, result, msg}
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



function newAiMsg(){ const el=document.createElement('div'); el.className='msg-ai'; chatEl.appendChild(el); scrollBottom(); return el; }
function aiContent(msg){ const c=msg.querySelector('.content'); return c || (()=>{const d=document.createElement('div');d.className='content';msg.appendChild(d);return d;})(); }
function addReasoning(msg){ const d=document.createElement('details'); d.className='reasoning'; d.innerHTML='<summary>思考过程</summary><div class="body"></div>'; msg.appendChild(d); return d.querySelector('.body'); }

function addUser(text){ const el=document.createElement('div'); el.className='msg-user'; el.innerHTML='<div class="bubble">'+esc(text)+'</div>'; chatEl.appendChild(el); scrollBottom(); }

const runningTools = new Map();
function renderToolStartEvent(ev){
  const card=document.createElement('div'); card.className='tool';
  const ico = {'read':'📄','write':'✏️','edit':'✎','bash':'⚙','grep':'🔎','glob':'🔎','ls':'📁','task':'👥','skill':'🧩','todo':'☑','undo':'↩'}[ev.name]||'🔌';
  const args = ev.name==='bash'? (ev.args&&ev.args.command):(ev.args&&(ev.args.path||ev.args.pattern||ev.args.name||''))||'';
  card.innerHTML='<div class="head"><span class="ico">'+ico+'</span><span class="name">'+esc(ev.name)+'</span><span class="args">'+esc(args)+'</span><span class="st" style="animation:blink 1.2s infinite">执行中…</span></div>';
  insertBeforeActiveMsg(card);
  runningTools.set(ev.seq, card);
  scrollBottom();
}
function renderToolEvent(ev){
  const card=document.createElement('div'); card.className='tool';
  const ico = {'read':'📄','write':'✏️','edit':'✎','bash':'⚙','grep':'🔎','glob':'🔎','ls':'📁','task':'👥','skill':'🧩','todo':'☑','undo':'↩'}[ev.name]||'🔌';
  const args = ev.name==='bash'? (ev.args&&ev.args.command):(ev.args&&(ev.args.path||ev.args.pattern||ev.args.name||''))||'';
  const r = ev.result||{};
  const ok = ev.result===undefined || r.ok!==false;
  card.innerHTML='<div class="head"><span class="ico">'+ico+'</span><span class="name">'+esc(ev.name)+'</span><span class="args">'+esc(args)+'</span><span class="st '+(ok?'ok':'bad')+'">'+(ev.result===undefined?'…':(ok?'✓':'✖'))+(ev.durationMs!=null?' '+ev.durationMs+'ms':'')+'</span></div>';
  insertBeforeActiveMsg(card);
  const bodyWrap=(el)=>{ if(el) card.appendChild(el); };
  if(ev.name==='skill'){
    // 技能内容只供模型使用，不整篇倒给用户：一行摘要
    const out=String(r.output||''); const desc=(out.match(/^description:\s*(.+)$/m)||[])[1]||'';
    const b=document.createElement('div'); b.className='body';
    b.innerHTML='<span style="color:var(--dim)">已加载技能 <b>'+esc(ev.args&&ev.args.name||'')+'</b>'+(desc?'：'+esc(desc.slice(0,80)):'')+'（全文 '+out.length+' 字，供模型参考）</span>';
    bodyWrap(b);
  }else if(ev.name==='edit'&&r.diff){
    const b=document.createElement('div'); b.className='body diff';
    const a=(r.diff.before||'').split('\n'), bb=(r.diff.after||'').split('\n');
    const n=Math.max(a.length,bb.length); const cap=40;
    const line=(x)=>'<span class="l ctx"> '+esc(x??'')+'</span>';
    const line2=(x)=>'<span class="l del">- '+esc(x)+'</span>';
    const line3=(x)=>'<span class="l add">+ '+esc(x)+'</span>';
    let prev='', full='';
    for(let i=0;i<n;i++){
      const html=(a[i]===bb[i])?line(a[i]??''):((a[i]!==undefined?line2(a[i]):'')+(bb[i]!==undefined?line3(bb[i]):''));
      if(i<cap) prev+=html; full+=html;
    }
    if(n>cap){ b.appendChild(expandableBody(prev+'<div style="color:var(--faint)">…（共 '+n+' 行差异）</div>', full)); }
    else b.innerHTML=prev;
    bodyWrap(b);
  }else if(ev.name==='write'&&r.ok){
    const lines=String(ev.args&&ev.args.content||'').split('\n');
    const b=document.createElement('div'); b.className='body';
    b.innerHTML='<pre>'+esc(lines.slice(0,8).join('\n'))+(lines.length>8?'\n…（共 '+lines.length+' 行）':'')+'</pre>';
    bodyWrap(b);
  }else if(ev.name==='bash'&&r.ok){
    const badge='<b style="color:'+(r.exitCode===0?'var(--accent)':'var(--err)')+'">'+(r.timedOut?'⏱ 超时':'exit '+r.exitCode)+'</b>';
    const out=(r.stdout?'<pre>'+esc(String(r.stdout).slice(-1200))+'</pre>':'')+(r.stderr?'<pre style="color:#ff9d97">'+esc(String(r.stderr).slice(-600))+'</pre>':'');
    const full=badge+out;
    if((String(r.stdout||'').length+String(r.stderr||'').length)>1800) bodyWrap(expandableBody(badge+'<div style="color:var(--faint)">…（输出较长）</div>', full));
    else { const b=document.createElement('div'); b.className='body'; b.innerHTML=full; bodyWrap(b); }
  }else if(ev.name==='ls'&&r.ok){
    const out=String(r.output||''); const lines=out.split('\n').filter((x)=>x.trim());
    const names=lines.slice(0,3).map((x)=>x.trim()).join('、');
    const prev='<span style="color:var(--dim)">列出 <b>'+lines.length+'</b> 项'+(names?'：'+esc(names):'')+(lines.length>3?' 等':'')+'</span>';
    if(lines.length>3) bodyWrap(expandableBody(prev, '<pre>'+esc(out)+'</pre>'));
    else { const b=document.createElement('div'); b.className='body'; b.innerHTML=prev; bodyWrap(b); }
  }else if(r.output){
    const out=String(r.output);
    const max=400;
    if(out.length>max){
      bodyWrap(expandableBody('<pre>'+esc(out.slice(0,max))+'…</pre>', '<pre>'+esc(out)+'</pre>'));
    }else{
      const b=document.createElement('div'); b.className='body'; b.innerHTML='<pre>'+esc(out)+'</pre>'; bodyWrap(b);
    }
  }else if(r.error){
    const b=document.createElement('div'); b.className='body'; b.innerHTML='<span style="color:var(--err)">'+esc(r.error)+'</span>'; bodyWrap(b);
  }
  msg.appendChild(card);
  if(ev.name==='todo'&&ev.result&&ev.result.todos) renderTodos(ev.result.todos, msg);
  scrollBottom();
}
function renderTodos(todos,msg){
  const ul=document.createElement('ul'); ul.className='todo';
  for(const t of todos){ const li=document.createElement('li'); li.className=t.status==='completed'?'done':t.status==='in_progress'?'doing':''; li.innerHTML=(t.status==='completed'?'✓ ':'○ ')+esc(t.content); ul.appendChild(li); }
  msg.appendChild(ul);
}
function renderBanner(ev){ const d=document.createElement('div'); d.className='banner'+(ev.warn?' banner-warn':''); d.textContent=ev.text||ev.title||''; insertBeforeActiveMsg(d); scrollBottom(); }
// 工具卡/横幅/代码块统一插到「本轮 AI 消息」之前：结论与交付物永远位于消息最底部
function insertBeforeActiveMsg(el){ if(activeAiMsg && activeAiMsg.parentNode){ chatEl.insertBefore(el, activeAiMsg); } else { chatEl.appendChild(el); } }

function askModal(ev){
  return new Promise(resolve=>{
    const root=$('#modalRoot');
    const mask=document.createElement('div'); mask.className='modal-mask';
    const m=document.createElement('div'); m.className='modal';
    m.innerHTML='<h3>权限确认</h3><div class="q">'+esc(ev.question)+'</div><div class="opts"></div><div class="row"><button class="danger" data-a="n">拒绝</button><button class="primary" data-a="y">允许</button></div>';
    if(ev.options&&ev.options.length){ m.querySelector('.opts').style.display='flex'; ev.options.forEach(o=>{ const b=document.createElement('button'); b.dataset.a=o.value; b.textContent=o.label||o.value; b.onclick=()=>finish(o.value); m.querySelector('.opts').appendChild(b); }); m.querySelector('.row').style.display='none'; }
    m.querySelectorAll('[data-a]').forEach(b=>{ if(!b.onclick) b.onclick=()=>finish(b.dataset.a); });
    function finish(a){ mask.remove(); resolve(a); }
    mask.appendChild(m); root.appendChild(mask);
  });
}

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
  // 回合看门狗（无活动超时，非总时长——审计：此前 120s 定时炸弹误杀长时间健康生成，
  // 如模型持续输出大文件代码时到点被掐断：write 参数截断 + 「响应超时已中断」）：
  // 每收到一个 SSE 事件即重置；ask 权限等待期间暂停计时（用户思考不设限），
  // 回复后的下一个事件自动重新武装。仅当 120 秒内真正没有任何事件（挂死）才强制中断。
  let watchdog=null; let killedByWatchdog=false;
  const disarm=()=>{ if(watchdog){ clearTimeout(watchdog); watchdog=null; } };
  const arm=()=>{ disarm(); watchdog=setTimeout(()=>{
    killedByWatchdog=true;
    try{ turnCtrl.abort(); }catch{}
    fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).catch(()=>{});
  },120000); };
  arm();
  input.value=''; input.style.height='44px';
  const payload={message:text,file:currentSession};
  // v0.4.0 Agent Preset：选择器选中的预设随本轮发送（服务端按会话应用一次）
  const presetVal=$('#presetSel')?.value;
  if(presetVal) payload.preset=presetVal;
  // 带上文开关：勾选后系统提示注入最近会话日志（默认不注入——新会话全新开始，避免串到历史会话上下文）
  if($('#journalChk')?.checked) payload.withJournal=true;
  if(attachments.length) payload.attachments=attachments;
  const sentAttachments=attachments;
  attachments=[]; renderAttachments();
  addUser(text||(sentAttachments.map(a=>(a.type==='image'?'🖼 ':'📄 ')+a.name).join(' ')));
  const msg=newAiMsg(); const content=aiContent(msg); let raw='';
  activeAiMsg=msg; msg._traj=[]; msg._steps=0; curSteps=0; curWorkT0=Date.now(); renderWorkStatus();
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
  try{
    const resp=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:turnCtrl.signal});
    if(!resp.ok){ const j=await resp.json().catch(()=>({})); onActivity(); msg.innerHTML='<div class="errline">'+esc(j.error||('HTTP '+resp.status))+'</div>'; updateTasksPanel(); return; }
    await handleEvents(resp.body, ev=>{
      if(ev.taskId){ taskId=ev.taskId; curTaskId=taskId; } // 质检 L1：主停止按钮只断本任务
      if(ev.type==='ask') disarm(); else arm(); // 有活动→重置；权限等待→暂停计时
      if(ev.type==='progress'){ const p=ev.seconds||0; if(ev.phase) curPhase=String(ev.phase); curTools=Number(ev.steps)||0; curTasks=Number(ev.tasks)||0; showThink(); think.textContent='💭 正在工作 '+Math.floor(p/60)+' 分 '+Math.round(p%60)+' 秒 · 第 '+msg._steps+' 回合 · '+curPhase+' · 已执行 '+ev.steps+' 步…'; renderWorkStatus(); }
      if(ev.type==='text'){ curPhase='模型输出中'; onActivity(); raw+=ev.delta; update(); }
      else if(ev.type==='reasoning'){ if(!reason){ reason=addReasoning(msg); reason.dataset.full=''; } if(!reason.parentElement.open) reason.parentElement.open=true; reason.parentElement.querySelector('summary').classList.add('live'); reason.dataset.full+=ev.delta; const full=reason.dataset.full; reason.textContent=(full.length>9000?full.slice(-9000)+'\n…（思考内容较长，仅显示末尾；已 '+full.length+' 字符）':full); reason.scrollTop=reason.scrollHeight; scroll(); }
      else if(ev.type==='turnStart'){ stepsCount+=1; curSteps+=1; msg._steps=curSteps; curPhase='模型推理中'; msg._traj.push({kind:'turn', t:Date.now()}); showThink(); think.textContent='💭 第 '+msg._steps+' 回合：模型推理中…'; renderWorkStatus(); scroll(); }
      else if(ev.type==='turnEnd'){ curPhase='回合完成，进入下一回合'; showThink(); think.textContent='⏸ 第 '+msg._steps+' 回合完成（累计 '+(ev.toolSteps||0)+' 工具步）· 进入下一回合…'; renderWorkStatus(); }
      else if(ev.type==='toolStart'){ stepsCount+=1; curSteps+=1; curPhase=ev.name==='task'?'子代理执行中':'执行工具中'; msg._steps=curSteps; msg._traj.push({kind:'tool', seq:ev.seq, name:ev.name, args:ev.args, t:Date.now(), done:false}); onActivity(); update(); renderToolStartEvent(ev); renderWorkStatus(); }
      else if(ev.type==='code'){ onActivity(); const pre=document.createElement('pre'); pre.innerHTML='<code>'+highlight(ev.code,ev.lang)+'</code>'; insertBeforeActiveMsg(pre); scroll(); }
      else if(ev.type==='tool'){ onActivity(); update(); const pending=runningTools.get(ev.seq); if(pending){ pending.remove(); runningTools.delete(ev.seq); } const tj=msg._traj.find(x=>x.kind==='tool'&&x.seq===ev.seq); if(tj){ tj.done=true; tj.result=ev.result; tj.durationMs=ev.durationMs; tj.card=pending||null; } if(ev.name==='task'){ sessionSubs.push({seq:ev.seq, question:String(ev.args?.question||ev.args?.prompt||''), result:ev.result, durationMs:ev.durationMs, msg}); renderSubPanel(); } renderToolEvent(ev); }
      else if(ev.type==='toolDenied'){ onActivity(); const tj=msg._traj.find(x=>x.kind==='tool'&&x.seq===ev.seq); if(tj){ tj.done=true; tj.denied=ev.reason||'未授权'; } const d=document.createElement('div'); d.className='errline'; d.textContent='✖ '+(ev.reason==='未授权'||!ev.reason?'未授权':ev.reason)+'：'+ev.name; msg.appendChild(d); scroll(); }
      else if(ev.type==='banner'){ renderBanner(ev); }
      else if(ev.type==='ask'){ update(); askModal(ev).then(a=>fetch('/api/permission',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:ev.id,answer:a,taskId})}).then(()=>arm()).catch(()=>{})); }
      else if(ev.type==='usage'){ onActivity(); const u=document.createElement('div'); u.className='usage'; u.textContent=''+ev.modelName+' · ↑'+ev.usage.prompt_tokens+' ↓'+ev.usage.completion_tokens+' tokens · '+((ev.durationMs||0)/1000).toFixed(1)+'s'+ev.cost; msg.insertBefore(u, content); scroll(); }
      else if(ev.type==='error'){ console.log('[MingDao] error 事件：' + ev.message); onActivity(); const d=document.createElement('div'); d.className='errline'; d.textContent=ev.message; msg.appendChild(d); scroll(); }
      else if(ev.type==='done'){ console.log('[MingDao] done 事件：session=' + ev.session); onActivity(); if(ev.budget){ const b=ev.budget; if(hintTextEl) hintTextEl.textContent='预算 '+Math.round(b.used/1000)+'K/'+Math.round(b.total/1000)+'K（'+Math.round(b.used/b.total*100)+'%）· 本轮完成 · 提示栏右侧为今日费用与命中率'; } refreshStatusBar(); if(ev.stats&&ev.stats.deliverables&&ev.stats.deliverables.length){ const card=document.createElement('div'); card.className='deliver'; card.innerHTML='<div class="t">📦 交付物（'+ev.stats.deliverables.length+' 个文件）</div>'+ev.stats.deliverables.map(f=>'<div class="i">'+esc(f)+(f.toLowerCase().endsWith('.html')?' <span style="color:var(--accent2)">— 浏览器打开即可运行</span>':'')+'</div>').join(''); msg.appendChild(card); } if(ev.note){ const d=document.createElement('div'); d.className='errline'; d.style.color='var(--warn)'; d.textContent=ev.note; msg.appendChild(d); } currentSession=ev.session; update(); refreshSessions(); updateTasksPanel(); }
    });
  }catch(e){ onActivity(); const d=document.createElement('div'); d.className='errline'; d.textContent=(e&&e.name==='AbortError')?(killedByWatchdog?'响应超时已中断（120 秒无任何响应），请重试':'已中断'):(e&&e.message)||'网络错误'; msg.appendChild(d); scroll(); }
  finally{ clearInterval(hintTimer); disarm(); generating=false; setBtn(); curTaskId=null; curPhase='模型推理中'; console.log('[MingDao] 回合收尾：generating=false，按钮恢复发送'); hintEl.classList.remove('working'); if(hintTextEl) hintTextEl.textContent=defaultHint; pending=false; content.innerHTML=renderMarkdown(raw); attachTrajMeta(msg); activeAiMsg=null; curWorkT0=0; renderWorkStatus(); scroll(); updateTasksPanel(); }
}

let curTaskId=null; // 本轮 SSE 任务 id（质检 L1：主停止按钮只断本任务，不再误伤其他 tab）
function abort(){ fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(curTaskId?{taskId:curTaskId}:{})}).then(()=>updateTasksPanel()).catch(()=>{}); }

// —— 输入框上方工作状态条（审计：长任务静默硬伤 → 实时进度可见） ——
function renderWorkStatus(){
  renderLiveBar();
  const el=$('#workStatus'); if(!el) return;
  let html='';
  let tip='';
  if(generating){
    const secs=curWorkT0?Math.round((Date.now()-curWorkT0)/1000):0;
    html='<span class="ws-busy"><span class="spinner"></span><span class="ws-phase">'+esc(curPhase)+'</span><span>⏳ 第 '+curSteps+' 步 · '+Math.floor(secs/60)+' 分 '+Math.round(secs%60)+' 秒 · '+curTools+' 工具步'+(curTasks>0?' · '+curTasks+' 个子代理':'')+'</span></span>';
  } else if(bgRunning>0){
    // 后台任务 chip（非顶部，位于输入框上方）：计数 + 最新任务 + 悬浮详情 tooltip，点击打开详情面板
    const running=bgTasks.filter((/** @type {any} */ t)=>t.status==='running');
    const latest=running.length?running[running.length-1]:null;
    tip=bgTasks.map((/** @type {any} */ t)=>(t.kind==='schedule'?'⏰':'🛠')+' '+String(t.message||t.id||'').slice(0,40)+' · '+t.status).join('\n');
    html='<span class="ws-bg">🛠 '+bgRunning+' 个后台任务运行中'+(latest?' · '+esc(String(latest.message||'').slice(0,22)):'')+' — 点击查看详情</span>';
  }
  el.style.display=html?'flex':'none';
  el.innerHTML=html;
  const bg=el.querySelector('.ws-bg'); if(bg){ bg.onclick=()=>{ const tp=$('#tasksPanel'); tp.style.display = tp.style.display==='none'?'flex':'none'; if(tp.style.display==='flex'){ $('#trajPanel').style.display='none'; $('#subPanel').style.display='none'; updateTasksPanel(); } syncPanelLayout(); }; attachTip(bg, tip); }
}
// 顶部常驻活动条（静默完美解决层）：生成期间始终可见，滚动不影响
function renderLiveBar(){
  const el=$('#liveBar'); if(!el) return;
  if(!generating){ el.style.display='none'; el.innerHTML=''; return; }
  const secs=curWorkT0?Math.round((Date.now()-curWorkT0)/1000):0;
  el.style.display='flex';
  el.innerHTML='<span class="spinner"></span><span class="lb-phase">正在执行：'+esc(curPhase)+'</span>'+
    '<span class="lb-stat">第 '+curSteps+' 步 · 已 '+Math.floor(secs/60)+' 分 '+Math.round(secs%60)+' 秒 · '+curTools+' 工具步'+(curTasks>0?' · '+curTasks+' 个子代理':'')+'</span>';
}
// 轨迹元行：任务完成后附在本轮消息顶部（步数/子代理数，点击打开轨迹面板）
function attachTrajMeta(msg){
  if(!msg || !msg._traj || !msg._traj.length) return;
  const tools=msg._traj.filter(x=>x.kind==='tool');
  const subs=tools.filter(x=>x.name==='task');
  const meta=document.createElement('div'); meta.className='msg-meta';
  const b=document.createElement('button'); b.className='trajBtn';
  b.textContent='🧭 轨迹：'+(msg._steps||tools.length)+' 步 · '+subs.length+' 个子代理';
  b.onclick=()=>openTraj(msg);
  meta.appendChild(b);
  msg.insertBefore(meta, msg.firstChild);
}
function openTraj(msg){
  const list=$('#tjList'); list.innerHTML='';
  const tools=msg._traj.filter(x=>x.kind==='tool');
  const subs=tools.filter(x=>x.name==='task');
  $('#tjSummary').textContent='（'+(msg._steps||tools.length)+' 步 · '+subs.length+' 个子代理）';
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
    const subLabel=isSub?'子代理：':'';
    div.innerHTML='<div class="tj-head"><span>'+ico+'</span><span style="white-space:nowrap">'+esc(subLabel+e.name)+'</span><span class="tj-args">'+esc(String(args).slice(0,80))+'</span><span style="margin-left:auto;color:var(--faint)">'+(e.done?(e.denied?'✖ '+esc(e.denied):'✓'+(e.durationMs!=null?' '+e.durationMs+'ms':'')):'执行中…')+'</span></div>';
    const body=document.createElement('div'); body.className='tj-body';
    if(isSub){
      body.textContent='任务：'+(e.args&&(e.args.question||e.args.prompt))+'\n\n结果：'+truncText(resultText(e.result), 1500);
    }else if(e.result!==undefined){
      body.textContent='参数：'+truncText(JSON.stringify(e.args||{}), 500)+'\n\n结果：'+truncText(resultText(e.result), 1500);
    }else{
      body.textContent='参数：'+truncText(JSON.stringify(e.args||{}), 500);
    }
    div.appendChild(body);
    div.onclick=(ev)=>{ if(ev.target.closest('.tj-body')) return; div.classList.toggle('open'); };
    // 点击标题定位到聊天中的对应工具卡
    list.appendChild(div);
  }
  $('#trajPanel').style.display='flex';
  $('#tasksPanel').style.display='none'; // 仅任务面板（右侧）与轨迹互斥；子代理面板可与轨迹同显
  $('#trajRailBtn').classList.add('on');
  syncPanelLayout();
}
// 面板布局同步（2026-09-02）：轨迹/子代理/任务面板打开时以 body class 推开内容区，
// 聊天文本与附件行不再被固定面板遮挡；面板宽度随屏宽自动收窄（CSS 媒体查询）。
function syncPanelLayout(){
  const open=(id)=>document.getElementById(id)?.style.display==='flex';
  document.body.classList.toggle('traj-open', open('trajPanel'));
  document.body.classList.toggle('sub-open', open('subPanel'));
  document.body.classList.toggle('tasks-open', open('tasksPanel'));
  document.body.classList.toggle('dash-open', open('dashPanel'));
}
$('#tjClose').onclick=()=>{ $('#trajPanel').style.display='none'; $('#trajRailBtn').classList.remove('on'); syncPanelLayout(); };
$('#trajRailBtn').onclick=()=>{
  const p=$('#trajPanel');
  const willShow=p.style.display==='none';
  if(willShow){ const m=lastMsgWithTraj(); if(!m){ uiAlert('本轮还没有可展示的轨迹（先发起一个任务）'); return; } openTraj(m); }
  else p.style.display='none';
  $('#trajRailBtn').classList.toggle('on', willShow);
  syncPanelLayout();
};
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
    body.textContent='任务：'+sub.question+'\n\n结果：'+truncText(resultText(sub.result), 1500);
    div.appendChild(body);
    div.onclick=(e)=>{ if(e.target.closest('.sb-body')) return; div.classList.toggle('open'); };
    list.appendChild(div);
  }
  if(!count) list.innerHTML='<div class="empty" style="color:var(--faint);font-size:12px;padding:10px">本会话还没有子代理（task 工具会派生子代理）</div>';
}
const toggleSubPanel=()=>{
  const p=$('#subPanel');
  const willShow=p.style.display==='none';
  p.style.display=willShow?'flex':'none';
  $('#subRailBtn').classList.toggle('on', willShow);
  if(willShow){ $('#tasksPanel').style.display='none'; renderSubPanel(); } // 轨迹（左侧）可与子代理（右侧）同显
  syncPanelLayout();
};
$('#subRailBtn').onclick=toggleSubPanel;
$('#sbClose').onclick=()=>{ $('#subPanel').style.display='none'; $('#subRailBtn').classList.remove('on'); syncPanelLayout(); };
// —— 任务面板（多会话并行） ——
function setBtn(){
  sendBtn.textContent = generating ? '■ 停止' : '发送';
  sendBtn.className = generating ? 'danger' : 'primary';
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
    if(t.status==='running'){ const b=document.createElement('button'); b.textContent='中断'; b.className='danger'; b.style.cssText='margin-left:auto;padding:2px 8px;font-size:11px'; b.onclick=()=>fetch('/api/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:t.id})}).catch(()=>{}); div.querySelector('.tp-meta').appendChild(b); }
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
  const bd=j.breakdown||{}; const gd=j.guard||null;
  let t='📊 今日 ≈¥'+(bd.today||0).toFixed(4);
  if(bd.rate!=null) t+=' · 命中 '+(bd.rate*100).toFixed(0)+'%';
  if(gd&&gd.limit>0&&gd.cost!=null) t+=' · 护栏 '+(gd.cost/gd.limit*100).toFixed(0)+'%';
  $('#costBadge').textContent=t;
  if($('#dashPanel').style.display==='flex') renderDashboard(j);
}
refreshCostBadge(); setInterval(refreshCostBadge, 15000);
$('#costBadge').onclick=()=>{ const p=$('#dashPanel'); const show=p.style.display==='none'; p.style.display=show?'flex':'none'; if(show){ $('#subPanel').style.display='none'; $('#trajPanel').style.display='none'; $('#tasksPanel').style.display='none'; $('#subRailBtn').classList.remove('on'); $('#trajRailBtn').classList.remove('on'); refreshCostBadge(); } syncPanelLayout(); };
$('#dashClose').onclick=()=>{ $('#dashPanel').style.display='none'; syncPanelLayout(); };
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
$('#tasksBtn').onclick=()=>{ const p=$('#tasksPanel'); p.style.display = p.style.display==='none'?'flex':'none'; if(p.style.display==='flex'){ $('#subPanel').style.display='none'; $('#trajPanel').style.display='none'; $('#trajRailBtn').classList.remove('on'); $('#subRailBtn').classList.remove('on'); updateTasksPanel(); } syncPanelLayout(); };
$('#tpClose').onclick=()=>{ $('#tasksPanel').style.display='none'; syncPanelLayout(); };

async function refreshSessions(q){ const u=q?'/api/sessions?q='+encodeURIComponent(q):'/api/sessions'; const r=await fetch(u).catch(()=>null); if(!r)return; const j=await r.json(); const sel=$('#sessions'); sel.innerHTML='<option value="">历史会话</option>'; for(const s of j.sessions){ const o=document.createElement('option'); o.value=s.file; o.textContent=s.label; sel.appendChild(o); } if(currentSession&&!q) sel.value=currentSession; }
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
async function init(){
  try{
    const r=await fetch('/api/state',{cache:'no-store'}); const j=await r.json();
    const ms=$('#modelSel'); ms.innerHTML='';
    const groups={}; const order=[];
    for(const m of (j.models||[])){ const g=m.providerLabel||'其他'; if(!groups[g]){groups[g]=[];order.push(g);} groups[g].push(m); }
    for(const g of order){
      const og=document.createElement('optgroup'); og.label=g;
      for(const m of groups[g]){ const o=document.createElement('option'); o.value=m.name; o.textContent=m.name; o.title=m.label; if(m.name===j.model) o.selected=true; og.appendChild(o); }
      ms.appendChild(og);
    }
    if(!(j.models||[]).length){ const o=document.createElement('option'); o.value=j.model; o.textContent=j.model; ms.appendChild(o); }
    $('#permSel').value=j.permission||'ask';
    $('#sbxSel').value=j.sandbox||'off';
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
    const psel=$('#presetSel'); if(psel&&pj.presets){ for(const p of pj.presets){ const o=document.createElement('option'); o.value=p.name; o.textContent=p.label+'（'+(p.source==='project'?'项目':p.source==='user'?'用户':'内置')+'）'; o.title=p.description||p.name; psel.appendChild(o); } }
  }catch(e){}
  try{
    const dr=await fetch('/api/draft?file='+encodeURIComponent(currentSession||''),{cache:'no-store'}); const dj=await dr.json();
    if(dj.text){ input.value=dj.text; input.style.height=Math.min(input.scrollHeight,200)+'px'; input.focus(); }
  }catch(e){}
}
// 设置多级菜单：左侧分组导航 ↔ 右侧面板切换（记住上次所在分组）
let cfgPanel='models';
function showCfgPanel(name){
  cfgPanel=name;
  document.querySelectorAll('.cfg-nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.panel===name));
  document.querySelectorAll('.cfg-panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===name));
}
document.querySelectorAll('.cfg-nav-btn').forEach(b=>{ b.onclick=()=>showCfgPanel(b.dataset.panel); });
$('#cfgBtn').onclick=()=>{ $('#cfgModal').style.display='flex'; showCfgPanel(cfgPanel); };
$('#cfgCancel').onclick=()=>{ $('#cfgModal').style.display='none'; };
// —— 工作空间头部下拉（⚙ 右侧：切换 / 新建 / 管理） ——
async function refreshWsSel(){
  const r=await fetch('/api/workspaces',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json();
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
  if(v){
    // 携带当前会话：显式切换时该会话的工作空间一并切过去（P3-4 会话级工作空间）
    const payload={action:'set',name:v};
    if(currentSession) payload.file=currentSession;
    const r=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const j=await r.json().catch(()=>({error:'请求失败'}));
    if(j.ok) renderBanner({text:'✓ 已切换到工作空间 '+j.name+'（'+j.dir+'），后续工具在此目录执行'}); else { uiAlert(j.error||'切换失败'); }
    refreshWsSel(); reloadModels();
  }
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
async function refreshWorkspaces(){
  const r=await fetch('/api/workspaces',{cache:'no-store'}).catch(()=>null); if(!r) return;
  const j=await r.json(); const list=$('#wsList'); list.innerHTML='';
  if(!j.workspaces||!j.workspaces.length){ list.innerHTML='<div style="color:var(--faint);font-size:12px;padding:6px 2px">暂无登记的工作空间</div>'; return; }
  for(const w of j.workspaces){
    const div=document.createElement('div'); div.style.cssText='display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px';
    div.innerHTML='<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.name)+(w.name===j.current?' <span style="color:var(--accent)">●当前</span>':'')+'</span><span style="flex:1.4;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left">'+esc(w.dir||'')+'</span>';
    const ed=document.createElement('button'); ed.textContent='改目录'; ed.style.cssText='padding:1px 8px;font-size:11px'; ed.onclick=()=>{ openDirPicker(w.dir||null, async (d)=>{ if(d==null) return; const rr=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'set',name:w.name,dir:d})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshWorkspaces(); refreshWsSel(); reloadModels(); } else uiAlert(jj.error||'修改失败'); }); };
    const rn=document.createElement('button'); rn.textContent='重命名'; rn.style.cssText='padding:1px 8px;font-size:11px'; rn.onclick=async()=>{ const t=await uiPrompt('新名称：', w.name); if(!t) return; const rr=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rename',name:w.name,newName:t})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ refreshWorkspaces(); refreshWsSel(); } else uiAlert(jj.error||'重命名失败'); };
    const rm=document.createElement('button'); rm.textContent='删除'; rm.className='danger'; rm.style.cssText='padding:1px 8px;font-size:11px'; rm.onclick=async()=>{ if(!await uiConfirm('删除工作空间 '+w.name+'？')) return; await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',name:w.name})}); refreshWorkspaces(); refreshWsSel(); reloadModels(); };
    div.appendChild(ed); div.appendChild(rn); div.appendChild(rm); list.appendChild(div);
  }
}
$('#wsAdd').onclick=async ()=>{
  const name=$('#wsName').value.trim(); if(!name) return;
  const dir=$('#wsDir').value.trim();
  const r=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',name,dir})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok){ $('#wsName').value=''; $('#wsDir').value=''; refreshWorkspaces(); refreshWsSel(); reloadModels(); } else uiAlert(j.error||'添加失败');
};
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
  for(const p of mcpPresetData){ const o=document.createElement('option'); o.value=p.name; o.textContent=p.name+' — '+p.label; o.title=p.command+' '+p.args.join(' '); sel.appendChild(o); }
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
      for(const m of groups[g]){ const o=document.createElement('option'); o.value=m.name; o.textContent=m.name; o.title=m.label; if(m.name===j.model) o.selected=true; og.appendChild(o); }
      ms.appendChild(og);
    }
    if(!(j.models||[]).length){ const o=document.createElement('option'); o.value=j.model; o.textContent=j.model; ms.appendChild(o); }
    const env=('路由'+(j.routing?'开':'关')+' · 沙箱'+((j.sandbox&&j.sandbox!=='off')?(j.sandboxSupported?j.sandbox:'降级'):'off'));
    $('#envBadge').textContent=env; $('#envBadge').style.display='';
    applyReasoningUI(j.reasoning);
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
    const ed=document.createElement('button'); ed.textContent='修改'; ed.style.cssText='padding:1px 8px;font-size:11px'; ed.onclick=async()=>{ const u=await uiPrompt('API 地址：', c.baseUrl); if(u===null) return; const l=await uiPrompt('标签：', c.label); if(l===null) return; fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'updateCustom',name:c.name,baseUrl:u,label:l})}).then(rr=>rr.json()).then(jj=>{ if(jj.ok){ refreshModelsCfg(); reloadModels(); } else uiAlert(jj.error||'修改失败'); }); };
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
  const r=await fetch('/api/models-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'setBaseUrl',baseUrl:$('#baseUrlOverride').value.trim()})});
  const j=await r.json().catch(()=>({error:'请求失败'}));
  if(j.ok) uiAlert('✓ API 地址已保存（立即生效）'); else uiAlert(j.error||'保存失败');
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
$('#cfgSave').onclick=()=>{ const to={}; const ft=Number($('#toFirstToken').value), si=Number($('#toStreamIdle').value), tt=Number($('#toTotal').value); if(ft>0) to.firstTokenMs=Math.round(ft*1000); if(si>0) to.streamIdleMs=Math.round(si*1000); if(tt>0) to.totalMs=Math.round(tt*1000); const payload={sandbox:$('#sbxSel').value, routing:$('#routeChk').checked, contextBudget:Number($('#budgetInput').value), autostart:$('#autoStartChk').checked, notify:$('#notifyChk').checked}; if(Object.keys(to).length) payload.timeout=to; applyConfig(payload); $('#cfgModal').style.display='none'; };
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
$('#modelSel').addEventListener('change', e=>{ applyConfig({model:e.target.value}, e.target); });
$('#permSel').addEventListener('change', e=>{ applyConfig({permission:e.target.value}, e.target); });
// v0.3.0 P0-3：会话边界收尾（切换/新对话时提取项目记忆+日志，fire-and-forget 不阻塞 UI）
function finalizeCurrentSession(){
  if(!currentSession) return;
  fetch('/api/session-finalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:currentSession})}).catch(()=>{});
}
async function loadSession(file){ if(currentSession && currentSession!==file) finalizeCurrentSession(); currentSession=file; chatEl.innerHTML=''; const r=await fetch('/api/session?file='+encodeURIComponent(file)); const j=await r.json(); for(const m of j.messages||[]){ if(typeof m.content==='string'&&m.content.startsWith('（系统提示）')) continue; if(m.role==='user') addUser(m.content); else { const el=newAiMsg(); aiContent(el).innerHTML=renderMarkdown(m.content); } } if(j.workspace){ const sel=$('#wsSel'); const has=[...sel.options].some(o=>o.value===j.workspace); if(has){ sel.value=j.workspace; } else { refreshWsSel(); } renderBanner({text:'↩ 已回到该会话的工作空间：'+j.workspace}); } if(j.taskState&&(j.taskState.status==='cap'||j.taskState.status==='interrupted')){ renderBanner({text:'⚠ 该会话有未完成任务（步数上限中断）——直接发送消息即可从断点续跑，已完成文件不会重复做。', warn:true}); } scrollBottom(); }

sendBtn.onclick=()=>{ if(generating){ abort(); } else { send(); } };
input.addEventListener('keydown',e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); } });
input.addEventListener('input',()=>{ input.style.height='44px'; input.style.height=Math.min(input.scrollHeight,200)+'px'; });
$('#newChat').onclick=()=>{ finalizeCurrentSession(); currentSession=null; chatEl.innerHTML=''; refreshSessions(); };
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
    const dl=document.createElement('button'); dl.textContent='删除'; dl.className='danger'; dl.style.cssText='padding:1px 8px;font-size:11px'; dl.onclick=async()=>{ if(!await uiConfirm('删除会话 '+s.file+'？此操作不可恢复。')) return; const rr=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',file:s.file})}); const jj=await rr.json().catch(()=>({error:'失败'})); if(jj.ok){ if(currentSession===s.file) currentSession=null; refreshSessions(); openSessModal(); } else uiAlert(jj.error||'删除失败'); };
    div.appendChild(rn); div.appendChild(dl); list.appendChild(div);
  }
}
$('#sessions').onchange=e=>{ if(e.target.value){ loadSession(e.target.value); } else { finalizeCurrentSession(); currentSession=null; chatEl.innerHTML=''; } };
if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(()=>{}); }
init();
