// 批二十五（用户真机 bug：权限选「自动」、勾只读预设后每次调用工具都弹「只读模式将拦截 …」）的变异验证
//
// 修复的形状是「一条优先级链 + 一处单源判定 + 一句可见说明 + 前端真的发字段」，所以变异逐条打在这四件事上，
// 每一条都要求 `test/smoke.js` 第 137 节当场变红（`expect` 用断言原文里的关键词）：
//   · 服务端不再读 body.permission        → 回到修前：显式选择被预设静默压过；
//   · 预设声明重新压过显式选择            → 同上（bug 的另一种写法）；
//   · 反提权标记被抹掉 / 反提权整体放松   → 预设又能偷偷放宽档位（P0 面）；
//   · 可见说明丢来源 / 不再随流下发       → 用户再次"选了自动却按只读跑，而且没人告诉他"；
//   · 对象形态切档丢 deny                 → 用户自己写的禁令静默消失（v0.6.3 P1-3 同款）；
//   · 前端不再发权限字段 / 接线不再用结果 → 单源判定被架空（算了不用）。
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const SEC = () => M.section('137');

M.mutate({
  name: '① 服务端不再读 body.permission（回到修前：显式选择被预设静默压过）',
  file: 'src/web/server.js',
  from: '    const explicitPermission = PERMISSION_MODES.has(String(body.permission)) ? String(body.permission) : null;',
  to: '    const explicitPermission = null;',
  expect: ['服务端必须读取请求体的 permission'],
  run: SEC,
});

M.mutate({
  name: '② 预设声明的 permission 重新压过显式选择（bug 的另一种写法）',
  file: 'src/web/server.js',
  from: "    return build(permission, 'webui', presetNote, escalated);",
  to: "    return build(declared ?? permission, 'webui', presetNote, escalated);",
  expect: ['显式选择必须压过预设声明的权限'],
  run: SEC,
});

M.mutate({
  name: '③ 抹掉反提权标记（预设想提权也不再上报）',
  file: 'src/web/server.js',
  from: '    const escalated = Boolean(declared && RANK[declared] > RANK[explicitMode]);',
  to: '    const escalated = false;',
  expect: ['预设试图提权必须被标记出来'],
  run: SEC,
});

M.mutate({
  name: '④ 无显式选择时的反提权整体放松（预设声明的档位照单全收）',
  file: 'src/web/server.js',
  from: '  const ov = presetPermissionOverride(preset, configPermission);',
  to: '  const ov = { permission: declared, escalated: false };',
  expect: ['无显式选择时，预设 auto 也不得把 ask 放宽成 auto'],
  run: SEC,
});

M.mutate({
  name: '⑤ 可见说明丢掉"来源"（用户只知道档位，不知道是谁定的）',
  file: 'src/web/server.js',
  from: '（来源：${sourceLabel}）',
  to: '',
  expect: ['可见说明必须写明档位来源'],
  run: SEC,
});

M.mutate({
  name: '⑥ 可见说明算出来却不再随 SSE 流下发',
  file: 'src/web/server.js',
  from: '            : turnPerm.banner,',
  to: "            : '',",
  expect: ['可见说明（turnPerm.banner）必须真的随 SSE 流下发'],
  run: SEC,
});

M.mutate({
  name: '⑦ 对象形态切档时丢掉用户自己写的 deny 规则',
  file: 'src/web/server.js',
  from: '    const permission = configPermission && typeof configPermission === \'object\' ? { ...configPermission, mode: explicitMode } : explicitMode;',
  to: '    const permission = explicitMode;',
  expect: ['config.json 的对象形态里 deny 规则必须原样保留'],
  run: SEC,
});

M.mutate({
  name: '⑧ 接线断了：chatCfg.permission 不再来自 resolveTurnPermission 的结果',
  file: 'src/web/server.js',
  from: '    chatCfg = { ...chatCfg, permission: turnPerm.permission };',
  to: '    chatCfg = { ...chatCfg, permission: chatCfg.permission };',
  expect: ['权限引擎吃到的 chatCfg.permission 必须来自 resolveTurnPermission'],
  run: SEC,
});

M.mutate({
  name: '⑨ 前端不再把权限模式随 chat 请求发出（只写 config.json 的老路）',
  file: 'src/web/app.js',
  from: '  if(permVal) payload.permission=permVal;',
  to: '  if(permVal) payload.permissionMode=permVal;',
  expect: ['前端必须把权限模式随 chat 请求发出'],
  run: SEC,
});

if (!M.report()) process.exit(1);
