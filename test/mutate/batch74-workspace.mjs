// 批七十四（v0.7.0 §1.2「变异补盲」）：工作空间注册表 + 路径围栏变异。
//
// 模块边界说明（如实）：`src/workspace.js` 本身是注册表/会话映射，**不含**路径围栏；
// 围栏的真实实现在 `src/tools/fs-tools.js`（withinRoot / boundedPath）与
// `src/web/routes/domains/workspace.js`（登记闸门与目录浏览）。所以本批覆盖三处，
// 目标统一是"越界必须拒绝且报错可见"：
//   · 路径归一（相对目录、会话目录）
//   · 跨进程锁、排序、会话迁移的删除语义
//   · 写失败必须可见（假成功比失败更危险）
//   · 围栏少一层 realpath / 不判软链 / 悬空链接逃生 / 成环 fail-closed
//
// 每条都在 `test/workspace-fence.js` 上真跑，必须红且失败输出含对应 `W<n>：` 关键词。
// 用法：node test/mutate/batch74-workspace.mjs
import { makeMutator } from './lib.mjs';

const M = makeMutator();
const RUN = () => M.suite('test/workspace-fence.js');

// ① addWorkspace 退回无锁读-改-写：与 CLI/WebUI 并发时丢登记
M.mutate({
  name: '① addWorkspace 退回无锁（并发丢登记）',
  file: 'src/workspace.js',
  from: '  return withFileLock(workspacesFile() + \'.lock\', () => {',
  to: '  return ((fn) => fn())(() => { // 变异：退回无锁',
  expect: ['W9：addWorkspace 必须在跨进程锁内'],
  run: RUN,
});

// ② 挂载点不做路径归一：相对目录原样入库（UI 里同目录登记成两个）
M.mutate({
  name: '② addWorkspace 不做路径归一（相对目录原样入库）',
  file: 'src/workspace.js',
  from: '  const target = path.resolve(dir || process.cwd());',
  to: '  const target = String(dir || process.cwd()); // 变异：不做路径归一',
  expect: ['W3：登记的目录必须是绝对路径'],
  run: RUN,
});

// ③ 注册表写失败被吞：调用方以为登记成功（假成功）
M.mutate({
  name: '③ 注册表写失败被吞（假成功）',
  file: 'src/workspace.js',
  from: ['  } catch (err) {', '    return { ok: false, error: String(/** @type {any} */ (err)?.message ?? err) };', '  }'].join('\n'),
  to: ['  } catch (err) {', '    return { ok: true, error: null }; // 变异：写失败被吞', '  }'].join('\n'),
  expect: ['W10：注册表写入失败必须返回 error'],
  run: RUN,
});

// ④ 会话→目录映射不归一：相对路径原样落盘，下个回合可能落到别的目录
M.mutate({
  name: '④ setSessionWorkspace 不做路径归一',
  file: 'src/workspace.js',
  from: '    map[sessionName] = { dir: path.resolve(dir), name: wsName || workspaceForDir(dir)?.name || null, at: Date.now() };',
  to: '    map[sessionName] = { dir: String(dir), name: wsName || workspaceForDir(dir)?.name || null, at: Date.now() }; // 变异：不归一',
  expect: ['W8：会话目录必须归一为绝对路径'],
  run: RUN,
});

// ⑤ 会话改名只增不删：旧键残留，两个会话名指向同一目录
M.mutate({
  name: '⑤ moveSessionWorkspace 不删除旧键',
  file: 'src/workspace.js',
  from: ['    map[newName] = map[oldName];', '    delete map[oldName];'].join('\n'),
  to: '    map[newName] = map[oldName]; // 变异：不删旧键',
  expect: ['W8：会话改名后旧键必须删除'],
  run: RUN,
});

// ⑥ 列表按名字排序而非 lastUsed：最近使用的项目沉底
M.mutate({
  name: '⑥ 工作空间列表按名字排序（lastUsed 失效）',
  file: 'src/workspace.js',
  from: '    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));',
  to: '    .sort((a, b) => String(a.name).localeCompare(String(b.name))); // 变异：按名排序',
  expect: ['W7：最近使用的工作空间必须排在最前'],
  run: RUN,
});

// ⑦ currentWorkspace 不归一 cwd：按相对路径反查永远认不出当前项目
M.mutate({
  name: '⑦ currentWorkspace 不归一 cwd',
  file: 'src/workspace.js',
  from: '  const target = path.resolve(cwd);',
  to: '  const target = String(cwd); // 变异：不归一 cwd',
  expect: ['W3：按相对 cwd 反查工作空间也必须命中'],
  run: RUN,
});

// ⑧ fs-tools 少一层 realpath：`ln -s 根外 根内/link` 的一条软链即可读写根外
M.mutate({
  name: '⑧ withinRoot 少一层 realpath（软链不再展开）',
  file: 'src/tools/fs-tools.js',
  from: '    return normCmp(io.realpathSync(p));',
  to: '    return normCmp(p); // 变异：不做 realpath',
  expect: ['W11：符号链接逃逸必须拒绝'],
  run: RUN,
});

// ⑨ 悬空符号链接不判：realpath 失败就上跳到父目录，write 跟随链接写出根外（v0.6.5 原缺陷）
M.mutate({
  name: '⑨ 悬空符号链接不判（write 跟随链接写出根外）',
  file: 'src/tools/fs-tools.js',
  from: [
    '    if (lst && lst.isSymbolicLink()) {',
    '      let dest = null;',
    '      try {',
    '        dest = io.readlinkSync(cur);',
    '      } catch {',
    '        return false;',
    '      }',
    '      return withinRoot(root, path.resolve(path.dirname(cur), String(dest)), depth + 1, io);',
    '    }',
  ].join('\n'),
  to: '    // 变异：悬空符号链接不再判定，直接上跳到父目录',
  expect: ['W11：悬空符号链接指向根外必须拒绝'],
  run: RUN,
});

// ⑩ Web 登记闸门不再校验允许根：任意绝对路径都能登记，围栏被一次 API 调用解除
M.mutate({
  name: '⑩ Web 登记闸门不再校验允许根',
  file: 'src/web/routes/domains/workspace.js',
  from: '    return allowedRoots().some((r) => d === r || d.startsWith(r + path.sep));',
  to: '    return true; // 变异：不再校验允许根',
  expect: ['W14：符号链接指向允许根之外时必须拒绝登记'],
  run: RUN,
});

// ⑪ Web 的 realpathDeep 退回纯字符串路径：`ln -s /` 即可登记/浏览全盘（P0-3 回归）
M.mutate({
  name: '⑪ Web 围栏不再消解符号链接（P0-3 回归）',
  file: 'src/web/routes/domains/workspace.js',
  from: '        const real = fs.realpathSync(cur);',
  to: '        const real = cur; // 变异：不消解符号链接',
  expect: ['W14：符号链接指向允许根之外时必须拒绝登记'],
  run: RUN,
});

const ok = M.report();
process.exit(ok ? 0 : 1);
