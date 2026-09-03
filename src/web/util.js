// 纯前端工具（零状态，仅依赖 DOM/标准 API）：选择器、转义、Markdown 渲染、格式化。
// 从 app.js 拆分（v0.2.8 C2）：这些函数被消息渲染/轨迹/设置等多处复用，独立成模块便于维护与测试。

export const $ = (s) => document.querySelector(s);

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function highlight(code, lang) {
  const kws = new Set(
    'const let var function return if else for while import from export class new await async try catch throw null undefined true false def elif raise with as lambda None True False self echo exit if then else fi done local function'.split(
      ' '
    )
  );
  const re = /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|`[^`]*`|\b\d[\d._]*\b|[A-Za-z_$][\w$]*)/g;
  return esc(code).replace(re, (tok) => {
    if (tok.startsWith('//') || tok.startsWith('#')) return '<span class="hl-c">' + tok + '</span>';
    if (/^["'`]/.test(tok)) return '<span class="hl-s">' + tok + '</span>';
    if (/^\d/.test(tok)) return '<span class="hl-n">' + tok + '</span>';
    if (kws.has(tok)) return '<span class="hl-kw">' + tok + '</span>';
    return tok;
  });
}

export function renderMarkdown(text) {
  // 块级解析（美化：加粗标题 / 段落 / 真列表 / 引用 / 分割线，参照 DeepSeek-Harness 会话排版）
  const lines = String(text).split('\n');
  let out = '';
  let code = null;
  let codeLang = '';
  const flushCode = () => {
    if (code !== null) {
      out +=
        '<div class="codeblock"><div class="cb-banner"><span class="cb-lang"><span class="cb-dot"></span>' +
        (esc(codeLang) || 'code') +
        '</span><span class="cb-copy" style="cursor:pointer">复制</span></div><pre><code class="lang-' +
        esc(codeLang) +
        '">' +
        highlight(code.join('\n'), codeLang) +
        '</code></pre></div>';
      code = null;
    }
  };
  let para = [];
  let list = null; // {type:'ul'|'ol', items:[]}
  const flushPara = () => {
    if (para.length) {
      out += '<p>' + para.join('<br>') + '</p>';
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out += '<' + list.type + '>' + list.items.map((i) => '<li>' + i + '</li>').join('') + '</' + list.type + '>';
      list = null;
    }
  };
  // 行内元素（审计 P1-3：内容与 codeLang 均经 esc 转义防 XSS）
  const inline = (l) => {
    let s = esc(l);
    s = s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\*([^*\s][^*]*)\*/g, '<i>$1</i>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s'"<>)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  };
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('```')) {
      if (code === null) {
        flushList();
        flushPara();
        code = [];
        codeLang = t.slice(3).trim().split(/\s+/)[0] || '';
      } else flushCode();
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (t === '') {
      flushList();
      flushPara();
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushList();
      flushPara();
      const level = Math.min(h[1].length, 4);
      out += '<h' + level + '>' + inline(h[2]) + '</h' + level + '>';
      continue;
    }
    const ul = t.match(/^([-*+])\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(inline(ul[2]));
      continue;
    }
    const ol = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(inline(ol[2]));
      continue;
    }
    if (/^>\s?/.test(t)) {
      flushList();
      flushPara();
      out += '<blockquote>' + inline(t.replace(/^>\s?/, '')) + '</blockquote>';
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushList();
      flushPara();
      out += '<hr>';
      continue;
    }
    flushList();
    para.push(inline(t));
  }
  flushCode();
  flushList();
  flushPara();
  return out;
}

export function scrollBottom() {
  const sc = document.querySelector('main');
  if (sc) sc.scrollTop = sc.scrollHeight;
}

export function expandableBody(previewHtml, fullHtml) {
  const b = document.createElement('div');
  b.className = 'body';
  const prev = document.createElement('div');
  const full = document.createElement('div');
  prev.innerHTML = previewHtml;
  full.innerHTML = fullHtml;
  full.style.display = 'none';
  const btn = document.createElement('button');
  btn.textContent = '展开全文';
  btn.style.cssText = 'padding:1px 8px;font-size:11px;margin-top:4px';
  btn.onclick = () => {
    const open = full.style.display !== 'none';
    full.style.display = open ? 'none' : 'block';
    btn.textContent = open ? '展开全文' : '收起';
    scrollBottom();
  };
  b.appendChild(prev);
  b.appendChild(full);
  b.appendChild(btn);
  return b;
}

export function resultText(r) {
  if (r == null || r === undefined) return '';
  if (typeof r === 'string') return r;
  if (r.output) return String(r.output);
  if (r.stdout || r.stderr) return String(r.stdout || '') + String(r.stderr || '');
  return JSON.stringify(r);
}

export function truncText(t, n) {
  t = String(t || '');
  return t.length > n ? t.slice(0, n) + '\n…（截断，共 ' + t.length + ' 字）' : t;
}

export function fmtDur(ms) {
  if (!ms) return '0s';
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  return m > 0 ? m + 'm' + String(sec % 60).padStart(2, '0') + 's' : sec + 's';
}

export function fmtTok(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

export function fmtT(n) {
  n = Number(n || 0);
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
