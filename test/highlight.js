// 代码高亮的字符串分支回归（v0.10.1，v0.8.1 审计报告3 M-3）。
//
// 缺陷（实测）：`highlight()` 先 `esc(code)` 再拿**原始引号**正则去匹配——`esc` 已把 `"`→`&quot;`、
// `'`→`&#39;`，于是字符串高亮分支永不命中：引号里的内容会被当成普通标识符（甚至被注释分支
// 吃掉），既没高亮，也让「高亮正确性」这条 UI 契约形同虚设。
//
// 修复口径：**先在原文上切 token，再对每一段单独转义**。本套件钉住：
//   ① 单/双引号、反引号、含中文、含反斜杠转义的字符串都必须落进 `hl-s`；
//   ② 任何用户内容（含 `<script>`、引号、中文）都必须转义，输出里不得出现可执行标签；
//   ③ 不含字符串的代码不得被误标成字符串；注释/关键字/数字的既有高亮不回归；
//   ④ 与 renderMarkdown 的代码块链路一致（用户贴进来的脚本块同样安全且高亮）。
//
// 运行：node test/highlight.js
import assert from 'node:assert/strict';
import { highlight, renderMarkdown } from '../src/web/util.js';

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ===========================================================================
// ① 各类字符串必须被高亮（包裹 hl-s），且引号已转义
// ===========================================================================
{
  const cases = [
    ['双引号', 'const s = "hello";', '&quot;hello&quot;'],
    ['单引号', "const s = 'hello';", '&#39;hello&#39;'],
    ['反引号', 'const s = `hello`;', '`hello`'],
    ['中文', 'const s = "中文内容";', '中文内容'],
    ['反斜杠转义的双引号', 'const s = "a\\"b";', 'hl-s'],
    ['反斜杠转义的单引号', "const s = 'it\\'s';", 'hl-s'],
  ];
  for (const [label, code, needs] of cases) {
    const out = highlight(code, 'js');
    assert.ok(out.includes('hl-s'), `${label}字符串必须被高亮（输出里没有 hl-s）：${out}`);
    assert.ok(out.includes(needs), `${label}字符串内容/转义形态必须保留：期望含 ${needs}，实际 ${out}`);
  }
  ok('① 双引号/单引号/反引号/中文/反斜杠转义字符串均高亮');
}

// ===========================================================================
// ② XSS 安全：任何用户内容都必须转义，且只转义一次（不得出现 &amp;quot; 二次转义）
// ===========================================================================
{
  const out = highlight('const s = "<script>alert(\'x\')</script>";', 'js');
  assert.ok(!out.includes('<script>'), `不得输出未转义的 <script>：${out}`);
  assert.ok(out.includes('&lt;script&gt;'), `用户标签必须转义成实体：${out}`);
  assert.ok(out.includes('hl-s'), '含标签的字符串仍应被高亮');
  assert.ok(out.includes('&quot;'), '双引号必须转义');
  assert.ok(!out.includes('&amp;quot;'), `不得二次转义（&amp;quot; 说明 esc 被套了两层）：${out}`);

  // 字符串外的裸 HTML 同样必须转义（普通文本段）。
  const plain = highlight('<img src=x onerror=alert(1)>', 'html');
  assert.ok(!plain.includes('<img'), `字符串外内容也不得原样输出标签：${plain}`);
  assert.ok(plain.includes('&lt;img'), `字符串外内容必须转义：${plain}`);
  ok('② XSS：字符串内外都转义、只转义一次、高亮不破坏转义');
}

// ===========================================================================
// ③ 不误伤：无字符串代码不得出现 hl-s；注释/关键字/数字高亮不回归
// ===========================================================================
{
  const noString = highlight('const total = count + 42;', 'js');
  assert.ok(!noString.includes('hl-s'), `不含字符串的代码不得出现字符串高亮：${noString}`);
  assert.ok(noString.includes('hl-kw'), '关键字仍应高亮');
  assert.ok(noString.includes('hl-n'), '数字仍应高亮');

  const comment = highlight('// 这是注释里的一句话\nconst x = 1;', 'js');
  assert.ok(comment.includes('hl-c'), '注释仍应高亮');
  assert.ok(comment.includes('hl-kw'), '注释后的关键字仍应高亮');

  // 注释里的引号必须被注释分支整体吃掉，不能把后面的代码误判成字符串。
  const quotedInComment = highlight('// "未闭合\nconst y = 2;', 'js');
  assert.ok(quotedInComment.includes('hl-c'), '带引号的注释仍走注释高亮');
  assert.ok(!quotedInComment.includes('hl-s'), `注释里的引号不得开启字符串高亮：${quotedInComment}`);
  assert.ok(highlight('', 'js') === '', '空输入必须返回空串');
  ok('③ 无字符串代码不误标；注释/关键字/数字高亮保持');
}

// ===========================================================================
// ④ renderMarkdown 代码块链路：同样高亮且转义
// ===========================================================================
{
  const html = renderMarkdown('```js\nconst s = "<b>hi</b>";\n```');
  assert.ok(html.includes('class="codeblock"'), '代码块容器仍在');
  assert.ok(html.includes('hl-s'), '代码块里的字符串必须被高亮');
  assert.ok(html.includes('&lt;b&gt;hi&lt;/b&gt;'), `代码块内容必须转义：${html}`);
  assert.ok(!html.includes('<b>hi</b>'), '代码块不得出现原始的 <b> 标签');
  ok('④ renderMarkdown 代码块：字符串高亮 + 内容转义');
}

console.log(`\nhighlight：${passed} 项通过`);
