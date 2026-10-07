// 批二十三（v0.6.11：M-8 收口第一批 —— **多行源码文本匹配**）的变异验证
//
// 背景：M-8 指出全仓约 189 条断言在"检查源码文本"而不是"检查行为"——无害重排即红、
// 真实回归落在匹配文本内则绿。本批只啃最脆的一类：**跨行源码文本匹配**，逐处做
//   ① 行为化（注入桩后观察行为）；或 ② 保留但加固（行尾归一化 + 结构化提取 + 如实标注绊线）。
//
// 每条变异的 `expect` 都是**新断言原文里的关键词**——关键词对不上就算逃逸。
// 逐条与登记 §3.49 的处号一一对应。
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const SEC = (n) => () => M.section(n);

// ── ①§93 忙锁键随会话改名迁移（加固：行尾归一化 + 标注绊线）──
M.mutate({
  name: '① §93 会话改名后不迁移忙锁键（删掉 claimSessionKey 调用）',
  file: 'src/web/server.js',
  from: '              claimSessionKey(session.file); // 忙锁键同步迁移，否则新文件名发起的回合不会被判「忙」\n',
  to: '',
  expect: ['会话改名后必须调用 claimSessionKey(session.file)'],
  run: SEC('93'),
});

// ── ②§103 spawnDaemon 必须无条件撤回子进程（加固）──
M.mutate({
  name: '② §103 pidfile 写失败后不杀刚拉起的 daemon（删掉 child.kill(SIGKILL)）',
  file: 'src/schedule.js',
  from: "      try {\n        child.kill('SIGKILL');\n      } catch {}\n",
  to: '',
  expect: ['无条件**杀掉刚拉起的守护进程'],
  run: SEC('103'),
});

// ── ③§103 spawnDaemon 必须如实返回 false（加固）──
M.mutate({
  name: '③ §103 pidfile 写失败却仍报成功（spawned 不置 false）',
  file: 'src/schedule.js',
  from: '      spawned = false;\n    }\n    child.unref();',
  to: '      spawned = true;\n    }\n    child.unref();',
  // 这一条被**同一处的行为断言**接住（spawnDaemon 真的返回了 true），文本绊线只是冗余的第二道；
  expect: ['pidfile 写不进去时必须返回 false'],
  run: SEC('103'),
});

// ── ④§115 自动压缩必须让读取去重缓存失效（行为化）──
M.mutate({
  name: '④ §115 压缩后不清读取缓存（clear 放进永不执行的分支）——旧文本守卫对此**全绿**',
  file: 'src/agent.js',
  from: '            agentReadCache.clear();\n            try {',
  to: '            if (false) agentReadCache.clear();\n            try {',
  expect: ['自动压缩之后，同一个 agent 再读同一文件必须重新给出**正文**'],
  run: SEC('115'),
});

M.mutate({
  name: '④b §115 清缓存挪到 onCompact **之后**（顺序反了：回调里读文件只会拿到占位串）',
  file: 'src/agent.js',
  from: '            agentReadCache.clear();\n            try {\n              onCompact?.(messages);\n            } catch {}',
  to: '            try {\n              onCompact?.(messages);\n            } catch {}\n            agentReadCache.clear();',
  expect: ['onCompact 被调用时读取去重缓存必须**已经清空**'],
  run: SEC('115'),
});

// ── ⑤§118 lastSeen 写锁必须 await 且包 try/catch（加固）──
M.mutate({
  name: '⑤ §118 lastSeen 写盘不再包 try/catch（写失败会把整个同步服务带走）',
  file: 'src/sync-server.js',
  from: '      try {\n        await withWriteLock(() => {\n          const devices = readJson(devicesFile(), {});\n          if (devices[dev.username]?.[dev.deviceId]) {\n            devices[dev.username][dev.deviceId] = dev.device;\n            writeJson(devicesFile(), devices);\n          }\n        });\n      } catch (/** @type {any} */ e) {\n        // lastSeen 写失败不影响本次请求的语义（它只是"最近在线"标记），但必须留痕而不是崩掉进程\n        log(\'lastSeen-write-failed\', dev.username, String(e?.message || e));\n      }',
  to: '      await withWriteLock(() => {\n        const devices = readJson(devicesFile(), {});\n        if (devices[dev.username]?.[dev.deviceId]) {\n          devices[dev.username][dev.deviceId] = dev.device;\n          writeJson(devicesFile(), devices);\n        }\n      });',
  expect: ['lastSeen 的写锁必须被 await'],
  run: SEC('118'),
});

// ── ⑥§118 改密必须与设备表写互斥（加固）──
M.mutate({
  name: '⑥ §118 改密不再与设备表写互斥（去掉 withWriteLock）',
  file: 'src/sync-server.js',
  from: '  return withWriteLock(() => {\n    // v0.6.3（P0-4）：改密会',
  to: '  return (() => {\n    // v0.6.3（P0-4）：改密会',
  expect: ['改密（吊销全部设备）必须与设备表写互斥'],
  run: SEC('118'),
});

// ── ⑦§118 避峰切片等待器的默认片长必须有界（加固）──
M.mutate({
  name: '⑦ §118 切片等待器默认片长放大到 600s（接管延迟被拉长）',
  file: 'src/schedule.js',
  from: 'sliceMs = 60000)',
  to: 'sliceMs = 600000)',
  expect: ['默认单片不得超过 60s'],
  run: SEC('118'),
});

// ── ⑧§119 BUG-029 重试循环头部必须复查总量护栏（行为化）──
M.mutate({
  name: '⑧ §119 总量护栏到点后只告警不中断（退避期间照样再发一次请求）——旧文本守卫对此**全绿**',
  file: 'src/providers/index.js',
  from: '        if (totalExpired) {\n          throw new Error(`请求总时长超限（${Math.round(totalMs / 1000)}s），已中断（不再重试）`);\n        }',
  to: "        if (totalExpired) {\n          console.warn('请求总时长超限，但继续重试');\n        }",
  // 先炸的是「错误文案」那条（再发一次就会拿到上游 500 而不是总量超限），故关键词取它；
  // 它后面紧跟着的 `stub.hits.length === 1` 是同一处的第二道。
  expect: ['退避 sleep 期间总量到点时'],
  run: SEC('119'),
});

// ── ⑨§119 BUG-024 账本 cost 事件的模型归属（行为化）──
M.mutate({
  name: '⑨ §119 账本 cost 事件写回用户配置的模型（降级后归属错模型）',
  file: 'src/agent.js',
  from: '            model: activeModel,\n            usage,',
  to: '            model: modelName,\n            usage,',
  expect: ['账本 cost 事件的 model 必须是**本回合实际使用**的模型'],
  run: SEC('119'),
});

// ── ⑩§120 installFromGit 的临时目录必须在 finally 里清（行为化）──
M.mutate({
  name: '⑩ §120 installFromGit 中途失败后留下临时目录（清理挪出 finally）',
  file: 'src/skill-lib.js',
  from: '  return { names: installed.map((i) => i.name), dirs: installed.map((i) => i.dir), skipped };\n  } finally {\n    try {\n      fs.rmSync(tmp, { recursive: true, force: true });\n    } catch {}\n  }\n}',
  to: '  fs.rmSync(tmp, { recursive: true, force: true });\n  return { names: installed.map((i) => i.name), dirs: installed.map((i) => i.dir), skipped };\n  } finally {\n  }\n}',
  expect: ['installFromGit 中途失败后**不得留下临时目录**'],
  run: SEC('120'),
});

// ── ⑪§125 run-all 的同步抛错兜底（行为化）──
M.mutate({
  name: '⑪ §125 spawn 同步抛错时汇总器照样崩（catch 保留日志但重新抛出）——旧文本守卫对此**全绿**',
  file: 'test/run-all.mjs',
  from: '      resolve({ suite, ok: false, out: String(err?.message || err) });\n      return;\n    }',
  to: '      throw err;\n    }',
  expect: ['同步抛错**不得**让汇总器崩溃'],
  run: SEC('125'),
});

// ── ⑫§128 share-accept 的文件写必须原子（加固：结构化取函数体）──
M.mutate({
  name: '⑫ §128 share-accept 的原子写改回裸 writeFileSync（就地刷新 + 冲突副本两处一起）',
  file: 'src/sync-server.js',
  from: [
    '      atomicWriteFileSync(target, content, { mode: 0o600 }); // 接受者未修改副本：就地刷新到最新',
    '    } else if (existing !== null && existing !== content) {',
    '      // 目标名已有不同内容：另存时间戳副本（绝不覆盖）',
    '      savedAs = prevName.replace(/\\.jsonl$/, `.shared-${Date.now()}.jsonl`);',
    '      fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });',
    '      atomicWriteFileSync(path.join(sessionsDir(username), savedAs), content, { mode: 0o600 }); // v0.6.7（M-7）：改原子写',
  ].join('\n'),
  to: [
    '      fs.writeFileSync(target, content, { mode: 0o600 }); // 接受者未修改副本：就地刷新到最新',
    '    } else if (existing !== null && existing !== content) {',
    '      // 目标名已有不同内容：另存时间戳副本（绝不覆盖）',
    '      savedAs = prevName.replace(/\\.jsonl$/, `.shared-${Date.now()}.jsonl`);',
    '      fs.mkdirSync(sessionsDir(username), { recursive: true, mode: 0o700 });',
    '      fs.writeFileSync(path.join(sessionsDir(username), savedAs), content, { mode: 0o600 }); // v0.6.7（M-7）：改原子写',
  ].join('\n'),
  // 就地刷新那一处被改坏后，doShareAccept 里 else 分支还有一处 `atomicWriteFileSync(target`，
  // 所以先炸的是「冲突副本」那条（两处一起改的变异，本就要两条合起来才完整）。
  expect: ['share-accept 的冲突副本也必须用原子写'],
  run: SEC('128'),
});

// ── ⑬§128 锁内不得直接做进程调用（加固）──
M.mutate({
  name: '⑬ §128 removeSchedule 里重新直接在锁内 killTask（M-6 复发）',
  file: 'src/schedule.js',
  from: '  const job0 = readSchedule(home, id);\n  if (!job0) return false;\n  stopJobProcesses(home, job0);',
  to: '  const job0 = readSchedule(home, id);\n  if (!job0) return false;\n  if (job0.lastTaskId) killTask(home, job0.lastTaskId);\n  stopJobProcesses(home, job0);',
  expect: ['removeSchedule 的锁内不得再直接做进程调用'],
  run: SEC('128'),
});

// ── ⑭§129 覆盖率分母为 0 必须失败（行为化）──
M.mutate({
  name: '⑭ §129 覆盖率分母为 0 时不再退 1（打印 0% 假装是质量结论）',
  file: 'scripts/coverage-report.mjs',
  from: "  console.error('这通常意味着：coverage 未运行、或 V8 覆盖率数据里的路径无法映射到 src/。按失败处理。');\n  process.exit(1);",
  to: "  console.error('这通常意味着：coverage 未运行、或 V8 覆盖率数据里的路径无法映射到 src/。按失败处理。');\n  if (false) process.exit(1);",
  expect: ['分母为 0 时不得打印'],
  run: SEC('129'),
});

// ── ⑮§129 棘轮工具缺失必须显式失败（行为化）──
M.mutate({
  name: '⑮ §129 typescript 缺失时棘轮不再显式失败（"工具缺失"被算成 0 错误）——旧文本守卫对此**全绿**',
  file: 'scripts/strict-ratchet.mjs',
  from: '  if (!fs.existsSync(tscJs)) {',
  to: '  if (!fs.existsSync(tscJs) && false) {',
  expect: ['typescript 缺失必须显式失败'],
  run: SEC('129'),
});

if (!M.report()) process.exit(1);
