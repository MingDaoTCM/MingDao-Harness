// 批九十三（v0.10.1 patch）：v0.8.1 审计遗留四项正确性/健壮性缺陷的变异验证。
//
// 目标：把本版四处修复逐条改回缺陷，对应回归套件必须当场红，且失败输出里出现该条
// `expect` 关键词（关键词 = 断言原文，防止「红是红了，但不是你改坏的那条」）。
//
// 覆盖（10 条）：
//   ①~④ 会话文件族（src/session-files.js / 会话路由）：侧车清单漏项、删除回滚被拆、
//        改名回滚被拆、删除退化成只 unlink 主文件；
//   ⑤  配置保存失败被吞（src/web/routes/domains/config.js）：仍回 200；
//   ⑥  高亮不再转义普通文本段（src/web/util.js）→ XSS 回归；
//   ⑦  高亮字符串分支失效（esc 后再匹配原始引号的老缺陷）；⑦b token 本身不转义；
//   ⑧  符号链接能力探测不再缓存（每条用例重复踩 EPERM）；
//   ⑨  探测把「不支持」当「支持」（软链用例重新在 Windows 上崩）。
//
// 用法：node test/mutate/batch93-v0101.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SIDECARS = () => M.suite('test/session-sidecars.js');
const SAVE_FAIL = () => M.suite('test/config-save-failure.js');
const HIGHLIGHT = () => M.suite('test/highlight.js');
const LINK = () => M.suite('test/link-support.js');

// ① 侧车清单退回「只有主文件」：删除主文件后事件日志/两把锁/任务检查点全部残留。
M.mutate({
  name: '① 会话删除只清主文件（侧车清单漏项）',
  file: 'src/session-files.js',
  from: '    files: [main, `${main}.lock`, event, `${event}.lock`, taskState, `${taskState}.lock`],',
  to: '    files: [main], // 变异：侧车清单漏项',
  expect: ['删除后 6 个文件都不应存在'],
  run: SIDECARS,
});

// ② 删除中途失败时不再回滚：主文件被搬进临时目录、侧车还在 → 半删状态。
M.mutate({
  name: '② 会话删除中途失败不回滚（留下半删状态）',
  file: 'src/session-files.js',
  from: '      moved.push({ from, to });\n    }\n  } catch (err) {\n    const rollbackError = rollbackMoved(io, moved);',
  to: "      moved.push({ from, to });\n    }\n  } catch (err) {\n    const rollbackError = ''; // 变异：不回滚",
  expect: ['失败后原文件必须全部还原'],
  run: SIDECARS,
});

// ③ 改名中途失败时不再回滚：主文件已到新名字、侧车还在旧名字 → 孤儿 + 半改名。
M.mutate({
  name: '③ 会话改名中途失败不回滚（留下半改名）',
  file: 'src/session-files.js',
  from: '  } catch (err) {\n    const rollbackError = rollbackMoved(io, moved);\n    if (trash) {',
  to: "  } catch (err) {\n    const rollbackError = ''; // 变异：不回滚\n    if (trash) {",
  expect: ['失败后原会话 6 个文件必须全部还原'],
  run: SIDECARS,
});

// ④ 删除路由退回只 unlink 主文件（v0.8.1 报告2 M-06 的原始形态）。
M.mutate({
  name: '④ 删除路由退回只 unlink 主文件',
  file: 'src/web/routes/domains/sessions.js',
  from: '      const removed = deleteSessionFamily(full);',
  to: '      const removed = { ok: true, error: null }; // 变异：只删主文件\n      fs.unlinkSync(full);',
  expect: ['删除后 6 个文件都不应存在'],
  run: SIDECARS,
});

// ⑤ 配置保存失败仍继续走成功响应：结果被丢弃 → 200 + ok:true（报告2 M-07 的原始形态）。
M.mutate({
  name: '⑤ 配置保存失败仍回 200（结果被丢弃）',
  file: 'src/web/routes/domains/config.js',
  from: '    cfg.permission = next.permission;\n    // v0.10.1（报告2 M-07）：写盘失败必须如实 500 + ok:false，绝不能仍回 200（磁盘满/只读时用户会以为生效）。\n    if (!(await persistConfig())) return true;',
  to: '    cfg.permission = next.permission;\n    await persistConfig(); // 变异：忽略失败结果，继续走成功响应',
  expect: ['真实写失败必须 500'],
  run: SAVE_FAIL,
});

// ⑥ 高亮对普通文本段不再转义：用户贴进来的 `<script>` 原样输出（XSS）。
M.mutate({
  name: '⑥ 高亮普通文本段不转义（XSS）',
  file: 'src/web/util.js',
  from: '    out += esc(src.slice(last, at));',
  to: '    out += src.slice(last, at); // 变异：文本段不转义',
  expect: ['字符串外内容也不得原样输出标签', '字符串外内容必须转义'],
  run: HIGHLIGHT,
});

// ⑦ 字符串高亮分支失效：引号内容不再包 hl-s（老实现 esc 后再匹配原始引号的等价形态）。
M.mutate({
  name: '⑦ 字符串高亮分支失效（不包 hl-s）',
  file: 'src/web/util.js',
  from: "    else if (/^[\"'`]/.test(tok)) out += '<span class=\"hl-s\">' + safe + '</span>';",
  to: "    else if (false) out += '<span class=\"hl-s\">' + safe + '</span>'; // 变异：字符串分支失效",
  expect: ['必须被高亮（输出里没有 hl-s）'],
  run: HIGHLIGHT,
});

// ⑦b 高亮对 token 本身不再转义：字符串里的 `<script>` 原样输出（XSS）。
M.mutate({
  name: '⑦b 高亮 token 不转义（字符串里的 <script> 直出）',
  file: 'src/web/util.js',
  from: '    const safe = esc(tok);',
  to: '    const safe = tok; // 变异：token 不转义',
  expect: ['字符串内容/转义形态必须保留', '不得输出未转义的 <script>'],
  run: HIGHLIGHT,
});

// ⑧ 能力探测不再缓存：每条软链用例都重新探测（Windows EPERM 每条重踩一次）。
M.mutate({
  name: '⑧ 符号链接能力探测不再缓存（每次都重新探测）',
  file: 'test/_link-support.js',
  from: '    if (!probed) {\n      probed = true;',
  to: '    if (true) {\n      probed = true; // 变异：每次都重新探测',
  expect: ['首次探测必须只记录 1 次尝试', '能力探测必须**只探测一次**'],
  run: LINK,
});

// ⑨ 探测把「不支持」当「支持」：EPERM 后 supported() 仍返回 true，软链用例重新在 Windows 上崩。
M.mutate({
  name: '⑨ 探测把 EPERM 当支持（跳过失效）',
  file: 'test/_link-support.js',
  from: '      } catch {\n        supported = false;\n      }',
  to: '      } catch {\n        supported = true; // 变异：失败也当支持\n      }',
  expect: ['注入 EPERM 后 supported() 必须返回 false'],
  run: LINK,
});

if (!M.report()) process.exit(1);
