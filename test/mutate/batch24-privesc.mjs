// 批二十四（审计 M-1 §2.1 第 4 条：Pack 反向提权）的变异验证
//
// 修复的形状是「两个对象 + 白名单 + 冻结 + 绑定门面」，所以变异必须逐条打在这四件事上，
// 每一条都要求 `test/pack-ctx-privesc.js` 当场变红（`expect` 用断言原文里的关键词）：
//   · 去掉冻结            → 「工具 ctx 冻结」这条行为断言红；
//   · 去掉裁剪            → 「字段只有白名单」红；
//   · 裁剪与冻结都去掉    → **回到修前的提权现场**：「本该被拒的 bash 仍然被拒」红；
//   · permission 门面不冻结 / 直接暴露内核对象 → 「只读引用」两条红；
//   · 第三方档不再收紧    → Pack 工具重新拿到 permission / spawnTask；
//   · 把内核 ctx 也一起冻结（agent.js）→ ④ 的冻结探针红。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SUITE = () => M.suite('test/pack-ctx-privesc.js');

M.mutate({
  name: '① 工具 ctx 不再冻结（工具又能给自己的 ctx 挂字段/改门面）',
  file: 'src/tools/index.js',
  from: '  const frozen = Object.freeze(out);',
  to: '  const frozen = out;',
  expect: ['工具拿到的 ctx 必须是冻结的'],
  run: SUITE,
});

M.mutate({
  name: '② 裁剪去掉：工具直接拿到内核 ctx（只是顺手冻上）——白名单形同虚设',
  file: 'src/tools/index.js',
  from: '  const frozen = Object.freeze(out);',
  to: '  const frozen = Object.freeze(src);',
  expect: ['不得留下任何执行痕迹', '必须只有白名单'],
  run: SUITE,
});

M.mutate({
  name: '③ 裁剪与冻结一起去掉（回到修前：工具 ctx 就是内核 ctx，一行改写即可提权）',
  file: 'src/tools/index.js',
  from: '  const frozen = Object.freeze(out);',
  to: '  const frozen = src;',
  expect: ['不得留下任何执行痕迹', '本该被拒的 bash 调用必须仍然被拒'],
  run: SUITE,
});

M.mutate({
  name: '④ permission 门面直接暴露内核对象（工具的改写直达权限引擎）',
  file: 'src/tools/index.js',
  from: '    const perm = permissionFacade(src.permission);\n    if (perm) out.permission = perm;',
  to: '    out.permission = src.permission;',
  expect: ['permission 门面必须冻结'],
  run: SUITE,
});

M.mutate({
  name: '⑤ permission 门面可写（冻结去掉：改写虽不影响内核，但"只读引用"这条不变量没了）',
  file: 'src/tools/index.js',
  from: '  return Object.freeze(facade);',
  to: '  return facade;',
  expect: ['permission 门面必须冻结', '改写工具面的 permission.check 必须抛错'],
  run: SUITE,
});

M.mutate({
  name: '⑥ 第三方档不再收紧：Pack / registerTool 的工具重新拿到 permission 与 spawnTask',
  file: 'src/tools/index.js',
  from: '    const customCtx = makeToolCtx(ctx, { thirdParty: true });',
  to: '    const customCtx = makeToolCtx(ctx);',
  expect: ['必须只有白名单', '第三方工具不得拿到 spawnTask'],
  run: SUITE,
});

M.mutate({
  name: '⑦ 内核 ctx 也一起冻结（两个对象混为一谈，"内核那一份保持可写"的设计被破坏）',
  file: 'src/agent.js',
  from: '    const ctx = makeCtx();\n    const toolCtx = makeToolCtx(ctx);',
  to: '    const ctx = Object.freeze(makeCtx());\n    const toolCtx = makeToolCtx(ctx);',
  expect: ['内核 ctx 不得被冻结'],
  run: SUITE,
});

if (!M.report()) process.exit(1);
