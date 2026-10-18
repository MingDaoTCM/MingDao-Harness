// 批三十九（v0.6.20 §3.71：**模型显示别名接到界面**）的变异验证。
//
// 先复现：后端 §3.69 已在 /api/models 每条给出 id / label / detail（label 来自
// config.modelLabels，没有映射时回退 id），但界面两处下拉仍写 `o.value=m.name;
// o.textContent=m.name`——用户看到的是 API id，配好的官方宣传名怎么也不出现；
// 更危险的是把 label 塞进 value / 请求体（官方 API 只认 deepseek-flash 这类 id，传宣传名会 400）。
// 本批把每一处修复逐个改回缺陷，test/smoke.js §150 的断言必须当场红。
//
// 覆盖（任务书要求 ≥5 条，本批 7 条）：
//   下拉 value 退回 m.name / 可见文本改用 id / title 丢掉「API id:」/
//   会话设置 hint 逻辑写反（该显示的藏起来、该藏的显示）/
//   请求体 model 改成 label / 设置页说明被删 / ⌘K 模型项退回 m.name（与下拉显示不一致）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('150');

// ① 下拉 value 退回 m.name（stub 条目只有 id/label——正是 /api/models 的契约；value 变空，
//    选择键与实际 id 脱节）
M.mutate({
  name: '① 下拉 value 退回 m.name（不再取 API id）',
  file: 'src/web/app.js',
  from: 'o.value=m.id||m.name;',
  to: 'o.value=m.name;',
  expect: ['下拉项的 value 必须是 API id'],
  run: SEC,
});

// ② 可见文本改用 id（用户又看不到 config.modelLabels 的显示名——本任务要补的那一步被抹掉）
M.mutate({
  name: '② 下拉可见文本改用 id（别名不显示）',
  file: 'src/web/app.js',
  from: "o.textContent=m.label||m.id||m.name;",
  to: 'o.textContent=m.id||m.name;',
  expect: ['下拉项可见文本必须是显示名'],
  run: SEC,
});

// ③ title 丢掉「API id:」（只剩名字，用户无法随时对上 API 实际 id）
M.mutate({
  name: '③ 下拉 title 不再含「API id: <id>」',
  file: 'src/web/app.js',
  from: "o.title=m.label+' · API id: '+(m.id||m.name)+(m.detail&&m.detail!==m.label?' · '+m.detail:'');",
  to: 'o.title=m.label;',
  expect: ['下拉项 title 必须含「API id'],
  run: SEC,
});

// ④ 会话设置 hint 逻辑写反（label!==id 时藏、相等时反而显示——提示永远误导）
M.mutate({
  name: '④ #ssModelAliasHint 显示条件写反',
  file: 'src/web/app.js',
  from: 'md.label !== (md.id || md.name)',
  to: 'md.label === (md.id || md.name)',
  expect: ['显示名与 API id 不同时，#ssModelAliasHint 必须显示'],
  run: SEC,
});

// ⑤ 请求体 model 改成 label（显示名真的被发去 /api/config → config.model → 出网 400）
M.mutate({
  name: '⑤ 切模型的 /api/config 请求体改用 label（出网会变宣传名）',
  file: 'src/web/app.js',
  from: '  await applyConfig({ model: name }, sel || undefined);',
  to: '  await applyConfig({ model: runState.modelLabel }, sel || undefined);',
  expect: ['选择模型后 /api/config 的 model 必须是 API id'],
  run: SEC,
});

// ⑥ 设置页说明被删（用户不知道「模型 id 以 API 返回为准、显示名怎么配」——不新增控件的那条说明消失）
M.mutate({
  name: '⑥ 设置页删掉 config.modelLabels 说明',
  file: 'src/web/index.html',
  from: '    <div class="cfg-hint">模型 id 以 API 返回为准；官方宣传名可在 <code>config.modelLabels</code> 里映射为显示名（请求仍用 API id）。</div>\n',
  to: '',
  expect: ['设置页必须说明「模型 id 以 API 返回为准'],
  run: SEC,
});

// ⑦ ⌘K 模型项退回 m.name（下拉显示宣传名、⌘K 显示 API id——用户以为是两个模型）
M.mutate({
  name: '⑦ ⌘K 模型项退回 m.name（与下拉显示不一致）',
  file: 'src/web/app.js',
  from: "    const mtext = m && m.id ? String(m.label || m.id) : String((m && (m.name || m.label)) || m || '');",
  to: "    const mtext = String((m && m.name) || m || '');",
  expect: ['⌘K 里模型项文本必须显示 label'],
  run: SEC,
});

if (!M.report()) process.exit(1);
