// 批九十三（v0.10.1 遗留安全批）：v0.8.1 审计 H-1 / H-2 / H-3 与自审 H-10 的变异验证。
//
// 目标：把这批修复逐条改回缺陷，`test/permissions-batch93.js` 必须当场红，且失败输出里出现
// 该条 `expect` 关键词（关键词 = 断言原文，防止"红是红了，但不是你改坏的那条"）。
//
// 为什么需要这一批：这四项在 v0.8.1 报告里连续两个版本标「未修」，而它们全部属"控制存在、
// 边界被高估"——deny 规则看不见真实命令（包装前缀）、软 deny 不认 Windows 写法、沙箱降级不披露、
// 请求体可绕过无令牌权限闸门。修复本身只有几十行，没有变异守卫就会在下一版悄悄改回去。
//
// 覆盖（10 条）：
//   H-3 包装前缀：su 整项被删（-c 命令串不再归一）/ runuser 整项被删 / chroot 不跳 NEWROOT /
//     pkexec 的无值选项 --disable-internal-agent 被当成吃值（吞掉 PROGRAM）；
//   H-2 软 deny：命令名大小写归一被去掉（CMD）/ cmd 的 /c 识别改成大小写敏感（/C 漏）/
//     powershell -Command 分支被删；
//   H-1 沙箱降级：结果 stdout 不再带披露 / 披露函数对"未请求沙箱"也返回文案；
//   H-10 权限闸门：无令牌下的请求体 auto 闸门被短路（恒放行）。
//
// 用法：node test/mutate/batch93-security.mjs（或 node test/mutate/run.mjs batch93-security）
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SUITE = () => M.suite('test/permissions-batch93.js');
const PERM = 'src/permissions.js';
const BASH = 'src/tools/bash.js';
const SERVER = 'src/web/server.js';

// ① su 整项被删：`su -c 'rm -rf /'` 归一后 argv[0] 变回 su，deny 规则失配 → 直达执行。
M.mutate({
  name: '① su 前缀整项被删（-c 的命令串不再归一）',
  file: PERM,
  from: `  su: {
    shortValue: ['-s', '-g', '-G', '-u', '-w'],
    longValue: ['--shell', '--group', '--supplementary-group', '--supp-group', '--user', '--whitelist-environment'],
    commandValue: { short: ['-c', '-C'], long: ['--command', '--session-command'] },
  },`,
  // 注意：不能把 su 改成空对象 `su: {}`——空 spec 仍会被当成"包装器"跳过 su 本身，
  // `su -c '<引号里带空格的串>'` 反而还能匹配到（第一版变异就是这么逃逸的）；这里整项删除。
  to: '',
  expect: ['su -c 的值必须按命令串再归一'],
  run: SUITE,
});

// ② runuser 整项被删：`runuser -u www -c 'rm -rf /'` / `runuser -u www -- rm -rf /` 同样失去归一化。
M.mutate({
  name: '② runuser 前缀整项被删',
  file: PERM,
  from: `  runuser: {
    shortValue: ['-s', '-g', '-G', '-u', '-w'],
    longValue: ['--shell', '--group', '--supplementary-group', '--supp-group', '--user', '--whitelist-environment'],
    commandValue: { short: ['-c', '-C'], long: ['--command', '--session-command'] },
  },`,
  to: '  runuser: {}, // 变异：runuser 不再是包装前缀',
  expect: ['runuser -c 的值必须按命令串再归一'],
  run: SUITE,
});

// ③ chroot 不再跳过 NEWROOT：`chroot /srv rm -rf /` 会被当成执行 `/srv`，真命令 rm 永远看不到。
M.mutate({
  name: '③ chroot 的 skipOperand 被去掉（NEWROOT 不再跳过）',
  file: PERM,
  from: "  chroot: { longValue: ['--userspec', '--groups'], skipOperand: true },",
  to: "  chroot: { longValue: ['--userspec', '--groups'] }, // 变异：不跳过 NEWROOT",
  expect: ['chroot 的 NEWROOT 是操作数，COMMAND 必须归一'],
  run: SUITE,
});

// ④ pkexec 的无值选项被登记成吃值：`pkexec --disable-internal-agent rm -rf /` 会把 rm 当成选项值吞掉。
M.mutate({
  name: '④ pkexec 把无值选项 --disable-internal-agent 当成吃值',
  file: PERM,
  from: "  pkexec: { longValue: ['--user'] },",
  to: "  pkexec: { longValue: ['--user', '--disable-internal-agent'] }, // 变异：无值选项当成吃值",
  expect: ['pkexec 的无值选项不得吞掉 PROGRAM'],
  run: SUITE,
});

// ⑤ 命令名大小写归一被去掉：`CMD /C "rm -rf /"` 不再被识别为 shell（Windows 不区分大小写）。
M.mutate({
  name: '⑤ 去掉命令名大小写归一（CMD / BASH 不再识别）',
  file: PERM,
  from: '    const baseLower = base.toLowerCase();',
  to: '    const baseLower = base; // 变异：命令名大小写敏感',
  expect: ['命令名大写（Windows 不区分大小写）同样必须归一'],
  run: SUITE,
});

// ⑥ cmd 的 /c 识别改回大小写敏感：`cmd /C "rm -rf /"`（Windows 上合法写法）不被归一。
M.mutate({
  name: '⑥ cmd 的 /c 识别改回大小写敏感（/C 漏判）',
  file: PERM,
  from: "        if (baseLower === 'cmd') return /^\\/[A-Za-z]*c[A-Za-z]*$/i.test(t);",
  to: "        if (baseLower === 'cmd') return /^\\/[A-Za-z]*c[A-Za-z]*$/.test(t); // 变异：/C 大小写敏感",
  expect: ['cmd /C 大写同样必须归一'],
  run: SUITE,
});

// ⑦ powershell 命令分支被删：`powershell -Command "rm -rf /"` 不再归一（审计 H-2 点名的另一半）。
M.mutate({
  name: '⑦ 删掉 powershell -Command 分支',
  file: PERM,
  from: "        if (baseLower === 'powershell' || baseLower === 'pwsh') return /^-[A-Za-z]*c[A-Za-z]*$/i.test(t);",
  to: '        if (false) return false; // 变异：powershell -Command 不再识别',
  expect: ['powershell -Command（大小写不敏感）必须归一'],
  run: SUITE,
});

// ⑧ 降级披露不再进结果：用户界面（CLI/WebUI 只读 stdout/stderr）重新看不见"本次未隔离执行"。
M.mutate({
  name: '⑧ 沙箱降级披露不再写进结果 stdout',
  file: BASH,
  from: '  const withDisclosure = (text) => (disclosure ? `${disclosure}\\n${text}` : text);',
  to: '  const withDisclosure = (text) => text; // 变异：不把降级披露写进结果',
  expect: ['降级披露必须是 stdout 首行（用户可见）'],
  run: SUITE,
});

// ⑨ 披露函数对"未请求沙箱"也返回文案：正常路径出现"沙箱不可用"噪音，披露可信度被稀释。
M.mutate({
  name: '⑨ 披露函数对未请求沙箱也返回文案（正常路径被污染）',
  file: BASH,
  from: "  return m && m !== 'off' && s === 'off' ? SANDBOX_DEGRADED_NOTICE : '';",
  to: '  return SANDBOX_DEGRADED_NOTICE; // 变异：正常路径也披露',
  expect: ['本来就没请求沙箱不得出现披露'],
  run: SUITE,
});

// ⑩ 无令牌请求体 auto 闸门被短路：`POST /api/chat {"permission":"auto"}` 重新能提升权限（H-10 复发）。
M.mutate({
  name: '⑩ 无令牌权限闸门被短路（请求体 auto 恒放行）',
  file: SERVER,
  from: '  const mode = PERMISSION_MODES.has(String(explicit)) ? String(explicit) : null;',
  to: '  const mode = PERMISSION_MODES.has(String(explicit)) ? String(explicit) : null;\n  return null; // 变异：H-10 闸门失效，请求体 auto 直接放行',
  expect: ['无令牌 + 请求体 auto 必须拒绝并说明原因'],
  run: SUITE,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
