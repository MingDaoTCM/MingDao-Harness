// 工作空间 / 路径围栏行为套件（v0.7.0 §1.2「变异补盲」）：`src/workspace.js` 此前 0 条变异。
//
//   node test/workspace-fence.js
//
// 这里刻意把「围栏」按真实实现拆成三层，每层都用**行为**断言：
//   ① `src/workspace.js`：工作空间注册表 / 会话→目录映射 / 路径归一 / 跨进程锁 / 写失败可见
//   ② `src/tools/fs-tools.js` 的 `withinRoot` 与 read/write：`..`、绝对路径、符号链接、
//      **悬空符号链接**（v0.6.5 的真实逃生通道）、链接成环
//   ③ `src/web/routes/domains/workspace.js`：登记闸门与目录浏览的 realpath 围栏
//      （只按字符串前缀比较的话，一个 `ln -s /` 就能越界枚举）
//
// 断言带 `W<n>：` 前缀；变异批次 batch74 用这些关键词证明红的是对应变异。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);

process.env.MINGDAO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-ws-boot-'));
const ws = await load('workspace.js');
const { withinRoot, read, write } = await load('tools/fs-tools.js');
const { handle } = await load('web/routes/domains/workspace.js');

const cleanups = [];
const tmp = (/** @type {string} */ tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `mingdao-ws-${tag}-`));
  cleanups.push(d);
  return d;
};
/** 切到一个隔离的 MINGDAO_HOME（注册表/会话映射都写在这里）。 */
function setHome(/** @type {string} */ tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `mingdao-ws-home-${tag}-`));
  cleanups.push(home);
  process.env.MINGDAO_HOME = home;
  return home;
}
const ok = (/** @type {string} */ n) => console.log(`  ✓ ${n}`);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {any} cond @param {string} tag @param {string} detail */
function check(cond, tag, detail) {
  assert.ok(cond, `${tag}：${detail}`);
}
const ctxFor = (/** @type {string} */ cwd) => ({ cwd, cfg: { fsAllowDirs: [] }, readCache: new Map(), undoStore: { backups: new Map() } });
/** @param {any} r */
const errorText = (r) => String(r?.error || r?.output || '');

try {
  // -------------------------------------------------------------------------
  // W1 注册表基本行为：add / list / path / currentWorkspace
  // -------------------------------------------------------------------------
  {
    setHome('basic');
    const dir = tmp('basic-dir');
    const r = await ws.addWorkspace('proj-one', dir);
    check(r.ok === true && r.dir === dir, 'W1：addWorkspace 必须返回登记后的绝对目录', JSON.stringify(r));
    check(ws.workspacePath('proj-one') === dir, 'W1：workspacePath 必须能取回目录', String(ws.workspacePath('proj-one')));
    check(ws.listWorkspaces().some((w) => w.name === 'proj-one'), 'W1：listWorkspaces 必须列出已登记项', JSON.stringify(ws.listWorkspaces()));
    check(ws.currentWorkspace(dir)?.name === 'proj-one', 'W1：currentWorkspace 必须按目录认出来', JSON.stringify(ws.currentWorkspace(dir)));
    ok('W1 注册表：add/list/path/current');
  }

  // -------------------------------------------------------------------------
  // W2 输入校验与错误可见：空名 / 路径分隔符 / 目录不存在
  // -------------------------------------------------------------------------
  {
    setHome('validate');
    const dir = tmp('validate-dir');
    const r1 = await ws.addWorkspace('   ', dir);
    check(r1.error === '名称不能为空', 'W2：空名必须报错', JSON.stringify(r1));
    const r2 = await ws.addWorkspace('a/b', dir);
    check(String(r2.error || '').includes('路径分隔符'), 'W2：含路径分隔符的名称必须报错', JSON.stringify(r2));
    const missing = path.join(tmp('validate-missing'), 'nope');
    const r3 = await ws.addWorkspace('ghost', missing);
    check(String(r3.error || '').includes('目录不存在'), 'W2：不存在的目录必须报错且带路径', JSON.stringify(r3));
    check(ws.listWorkspaces().length === 0, 'W2：校验失败不得留下半截登记', JSON.stringify(ws.listWorkspaces()));
    ok('W2 输入校验：错误可见且不产生副作用');
  }

  // -------------------------------------------------------------------------
  // W3 挂载点归一：相对路径必须落成绝对路径（否则 UI 里同目录会登记成两个）
  // -------------------------------------------------------------------------
  {
    setHome('normalize');
    const dir = tmp('normalize-dir');
    const rel = path.relative(process.cwd(), dir);
    const r = await ws.addWorkspace('rel-proj', rel);
    check(r.ok === true, 'W3：相对路径登记必须成功', JSON.stringify(r));
    check(path.isAbsolute(r.dir), 'W3：登记的目录必须是绝对路径', String(r.dir));
    check(r.dir === path.resolve(rel), 'W3：登记的目录必须归一（消解 .. 与重复分隔符）', `${r.dir} vs ${path.resolve(rel)}`);
    check(r.dir === dir, 'W3：归一后的路径必须等于真实目录', `${r.dir} vs ${dir}`);
    check(ws.currentWorkspace(rel)?.name === 'rel-proj', 'W3：按相对 cwd 反查工作空间也必须命中（currentWorkspace 要先归一）', JSON.stringify(ws.currentWorkspace(rel)));
    ok('W3 挂载点归一：相对路径 → 绝对路径');
  }

  // -------------------------------------------------------------------------
  // W4 覆盖登记：目录更新但 createdAt 保留（"何时加进来的"不因改目录而重置）
  // -------------------------------------------------------------------------
  {
    setHome('overwrite');
    const d1 = tmp('overwrite-1');
    const d2 = tmp('overwrite-2');
    await ws.addWorkspace('same', d1);
    const created = ws.loadWorkspaces()['same'].createdAt;
    await sleep(15);
    const r = await ws.addWorkspace('same', d2);
    const entry = ws.loadWorkspaces()['same'];
    check(r.ok === true && entry.dir === d2, 'W4：同名再次登记必须覆盖目录', JSON.stringify(entry));
    check(entry.createdAt === created, 'W4：覆盖目录不得重置 createdAt', `${entry.createdAt} vs ${created}`);
    check(entry.lastUsed > created, 'W4：覆盖登记必须刷新 lastUsed', `${entry.lastUsed} vs ${created}`);
    ok('W4 覆盖登记：目录更新、createdAt 保留');
  }

  // -------------------------------------------------------------------------
  // W5 改名：成功 / 不存在 / 重名 / 原名空操作
  // -------------------------------------------------------------------------
  {
    setHome('rename');
    const dir = tmp('rename-dir');
    await ws.addWorkspace('old-name', dir);
    const r1 = await ws.renameWorkspace('old-name', 'new-name');
    check(r1.ok === true, 'W5：改名必须成功', JSON.stringify(r1));
    check(ws.workspacePath('new-name') === dir && ws.workspacePath('old-name') === null, 'W5：改名后旧名必须消失', JSON.stringify(ws.loadWorkspaces()));
    const r2 = await ws.renameWorkspace('missing', 'whatever');
    check(String(r2.error || '').includes('不存在'), 'W5：改名不存在的项必须报错', JSON.stringify(r2));
    await ws.addWorkspace('dup', dir);
    const r3 = await ws.renameWorkspace('new-name', 'dup');
    check(String(r3.error || '').includes('已存在'), 'W5：改名为已存在的名称必须报错', JSON.stringify(r3));
    const r4 = await ws.renameWorkspace('new-name', 'new-name');
    check(ws.workspacePath('new-name') === dir, 'W5：原名改名必须是无操作（不得自删）', JSON.stringify(r4));
    ok('W5 改名：成功/不存在/重名/自改名');
  }

  // -------------------------------------------------------------------------
  // W6 删除：存在返回 true，不存在返回 false（不是错误）
  // -------------------------------------------------------------------------
  {
    setHome('remove');
    const dir = tmp('remove-dir');
    await ws.addWorkspace('gone-soon', dir);
    check((await ws.removeWorkspace('gone-soon')) === true, 'W6：删除已存在项必须返回 true', '');
    check((await ws.removeWorkspace('gone-soon')) === false, 'W6：删除不存在项必须返回 false', '');
    check(ws.workspacePath('gone-soon') === null, 'W6：删除后不得还能取到目录', String(ws.workspacePath('gone-soon')));
    ok('W6 删除：存在 true / 不存在 false');
  }

  // -------------------------------------------------------------------------
  // W7 sort：按 lastUsed 降序（不是按名字，也不是按插入顺序）
  // -------------------------------------------------------------------------
  {
    const home = setHome('sort');
    const dir = tmp('sort-dir');
    fs.writeFileSync(
      path.join(home, 'workspaces.json'),
      JSON.stringify({
        aaa: { dir, createdAt: 1, lastUsed: 100 },
        bbb: { dir, createdAt: 1, lastUsed: 300 },
        ccc: { dir, createdAt: 1, lastUsed: 200 },
      })
    );
    const names = ws.listWorkspaces().map((w) => w.name);
    check(names.join(',') === 'bbb,ccc,aaa', 'W7：最近使用的工作空间必须排在最前（lastUsed 降序）', names.join(','));
    ok('W7 排序：lastUsed 降序');
  }

  // -------------------------------------------------------------------------
  // W8 会话→目录映射：相对路径归一 / 改名迁移 / 删除
  // -------------------------------------------------------------------------
  {
    setHome('session');
    const dir = tmp('session-dir');
    const rel = path.relative(process.cwd(), dir);
    await ws.setSessionWorkspace('sess-1', rel);
    check(ws.getSessionWorkspace('sess-1') === path.resolve(rel), 'W8：会话目录必须归一为绝对路径', String(ws.getSessionWorkspace('sess-1')));
    await ws.moveSessionWorkspace('sess-1', 'sess-2');
    check(ws.getSessionWorkspace('sess-2') === path.resolve(rel), 'W8：会话改名后目录必须跟着走', String(ws.getSessionWorkspace('sess-2')));
    check(ws.getSessionWorkspace('sess-1') === null, 'W8：会话改名后旧键必须删除', String(ws.getSessionWorkspace('sess-1')));
    check((await ws.removeSessionWorkspace('sess-2')) === true, 'W8：删除会话映射必须返回 true', '');
    check((await ws.removeSessionWorkspace('sess-2')) === false, 'W8：删除不存在的会话映射必须返回 false', '');
    check(ws.getSessionWorkspace('sess-2') === null, 'W8：删除后不得还能取到目录', String(ws.getSessionWorkspace('sess-2')));
    ok('W8 会话映射：归一 / 迁移 / 删除');
  }

  // -------------------------------------------------------------------------
  // W9 跨进程锁：外部持有 workspaces.json.lock 时 addWorkspace 必须等，不能直接读-改-写
  // -------------------------------------------------------------------------
  {
    const home = setHome('lock');
    const lockPath = path.join(home, 'workspaces.json.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), cmd: 'workspace-fence.js' }));
    let settled = false;
    const pending = ws.addWorkspace('waits-for-lock', tmp('lock-dir')).then((r) => {
      settled = true;
      return r;
    });
    await sleep(250);
    check(settled === false, 'W9：addWorkspace 必须在跨进程锁内（外部持锁时应等待）', `250ms 内就完成了：${settled}`);
    fs.unlinkSync(lockPath);
    const r = await pending;
    check(r.ok === true && ws.workspacePath('waits-for-lock') !== null, 'W9：锁释放后登记必须完成', JSON.stringify(r));
    ok('W9 跨进程锁：外部持锁会等待，释放后完成');
  }

  // -------------------------------------------------------------------------
  // W10 写失败可见：注册表不可写时返回 {error}，不得假成功
  // -------------------------------------------------------------------------
  {
    const home = setHome('writefail');
    const dir = tmp('writefail-dir');
    fs.mkdirSync(path.join(home, 'workspaces.json')); // 目标路径被目录占住 → 原子写 rename 必失败
    const r = await ws.addWorkspace('cannot-write', dir);
    check(Boolean(r && r.error), 'W10：注册表写入失败必须返回 error（不得报 ok）', JSON.stringify(r));
    check(String(r.error).includes('写入失败'), 'W10：写失败原因必须可操作（包含"写入失败"）', String(r.error));
    ok('W10 写失败可见：返回 error 而不是假成功');
  }

  // -------------------------------------------------------------------------
  // W11 withinRoot：`..` / 绝对路径 / 符号链接 / 悬空链接 / 成环
  // -------------------------------------------------------------------------
  {
    const root = tmp('fence-root');
    const outside = tmp('fence-outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
    fs.mkdirSync(path.join(root, 'inside'));
    fs.writeFileSync(path.join(root, 'inside', 'ok.txt'), 'inside-ok');
    // 符号链接逃逸（真实建链接；建不出链接的平台直接失败而不是静默跳过）
    fs.symlinkSync(outside, path.join(root, 'escape'), 'dir');
    // 悬空符号链接：目标在根外且不存在
    fs.symlinkSync(path.join(outside, 'new-target.txt'), path.join(root, 'dangling-out'), 'file');
    // 悬空但指向根内：必须放行（新建文件路径）
    fs.symlinkSync(path.join(root, 'inside', 'new-file.txt'), path.join(root, 'dangling-in'), 'file');
    // 链接成环：fail-closed
    fs.symlinkSync('cycle', path.join(root, 'cycle'), 'file');

    check(withinRoot(root, path.join(root, 'inside', 'ok.txt')) === true, 'W11：根内文件必须放行', '');
    check(withinRoot(root, path.join(root, 'inside', 'not-created.txt')) === true, 'W11：根内新文件（父目录存在）必须放行', '');
    check(withinRoot(root, path.join(root, '..', 'x.txt')) === false, 'W11：.. 逃逸必须拒绝', '');
    check(withinRoot(root, path.join(outside, 'secret.txt')) === false, 'W11：绝对路径越界必须拒绝', '');
    check(withinRoot(root, path.join(root, 'escape', 'secret.txt')) === false, 'W11：符号链接逃逸必须拒绝（realpath 一层不能少）', '');
    check(withinRoot(root, path.join(root, 'dangling-out')) === false, 'W11：悬空符号链接指向根外必须拒绝', '');
    check(withinRoot(root, path.join(root, 'dangling-in')) === true, 'W11：悬空符号链接指向根内必须放行', '');
    check(withinRoot(root, path.join(root, 'cycle')) === false, 'W11：链接成环必须 fail-closed（有界拒绝）', '');
    ok('W11 withinRoot：.. / 绝对路径 / 软链 / 悬空 / 成环');
  }

  // -------------------------------------------------------------------------
  // W12 read 工具：越界必须拒绝且错误可见
  // -------------------------------------------------------------------------
  {
    const workdir = tmp('read-work');
    const outside = tmp('read-outside');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
    fs.symlinkSync(outside, path.join(workdir, 'link-dir'), 'dir');
    const ctx = ctxFor(workdir);

    const r1 = read({ path: path.relative(workdir, path.join(outside, 'secret.txt')) }, ctx);
    check(r1.ok === false && errorText(r1).includes('路径越界'), 'W12：read ../ 越界必须拒绝且报错可见', JSON.stringify(r1));
    const r2 = read({ path: 'link-dir/secret.txt' }, ctx);
    check(r2.ok === false && errorText(r2).includes('路径越界'), 'W12：read 经符号链接越界必须拒绝且报错可见', JSON.stringify(r2));
    check(!String(r2.output || '').includes('outside-secret'), 'W12：越界读取不得把内容返回给模型', String(r2.output || ''));
    ok('W12 read 围栏：越界拒绝且错误可见');
  }

  // -------------------------------------------------------------------------
  // W13 write 经悬空符号链接逃逸：拒绝落盘，且根外目标文件不得被创建
  // -------------------------------------------------------------------------
  {
    const workdir = tmp('write-work');
    const outside = tmp('write-outside');
    const target = path.join(outside, 'pwned.txt');
    fs.symlinkSync(target, path.join(workdir, 'dangle'), 'file');
    const r = write({ path: 'dangle', content: 'pwn' }, ctxFor(workdir));
    check(r.ok === false && errorText(r).includes('路径越界'), 'W13：write 经悬空链接越界必须拒绝', JSON.stringify(r));
    check(!fs.existsSync(target), 'W13：被拒绝的写入不得在根外创建文件', target);
    ok('W13 write 围栏：悬空链接逃逸被拒且无副作用');
  }

  // -------------------------------------------------------------------------
  // W14 Web 登记闸门：符号链接指向允许根之外必须拒；允许根内必须放行
  // -------------------------------------------------------------------------
  {
    const home = setHome('web-add');
    const workRoot = tmp('web-root');
    const link = path.join(workRoot, 'link-to-etc');
    fs.symlinkSync('/etc', link, 'dir');
    const deps = { cfg: {}, state: { workingDir: workRoot }, startupCwd: workRoot };
    const shared = {
      MAX_API_BODY: 1024 * 1024,
      json: (/** @type {any} */ res, /** @type {number} */ status, /** @type {any} */ obj) => {
        res.status = status;
        res.body = obj;
      },
      readBody: async (/** @type {any} */ req) => req.body,
    };
    const call = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body = null, /** @type {string} */ search = '') => {
      const req = { body };
      const res = { status: 0, body: null };
      const hit = await handle({ req, res, method, p, url: new URL(`http://x${p}${search}`) }, deps, shared);
      return { hit, status: res.status, body: res.body };
    };

    const bad = await call('POST', '/api/workspaces', { action: 'add', name: 'zz-etc', dir: link, create: false });
    check(bad.status === 400, 'W14：符号链接指向允许根之外时必须拒绝登记', JSON.stringify(bad));
    check(String(bad.body?.error || '').includes('不在允许范围'), 'W14：拒绝理由必须可见（不在允许范围）', JSON.stringify(bad.body));

    const goodDir = path.join(workRoot, 'proj');
    const good = await call('POST', '/api/workspaces', { action: 'add', name: 'zz-inside', dir: goodDir, create: true });
    check(good.status === 200 && good.body?.ok === true, 'W14：允许根内的目录必须可以登记', JSON.stringify(good));
    check(fs.existsSync(goodDir), 'W14：允许根内的目录必须按请求创建', goodDir);
    check(ws.workspacePath('zz-inside') !== null, 'W14：登记必须真的写进注册表', JSON.stringify(ws.loadWorkspaces()));
    ok('W14 Web 登记闸门：软链越界拒绝 / 根内放行');
  }

  // -------------------------------------------------------------------------
  // W15 Web 目录浏览围栏：软链指向 /etc 必须 403；允许根内必须 200
  // -------------------------------------------------------------------------
  {
    const home = setHome('web-browse');
    const workRoot = tmp('browse-root');
    const inside = path.join(workRoot, 'visible');
    fs.mkdirSync(inside);
    const link = path.join(workRoot, 'link-to-etc');
    fs.symlinkSync('/etc', link, 'dir');
    const deps = { cfg: {}, state: { workingDir: workRoot }, startupCwd: workRoot };
    const shared = {
      MAX_API_BODY: 1024 * 1024,
      json: (/** @type {any} */ res, /** @type {number} */ status, /** @type {any} */ obj) => {
        res.status = status;
        res.body = obj;
      },
      readBody: async (/** @type {any} */ req) => req.body,
    };
    const call = async (/** @type {string} */ search) => {
      const res = { status: 0, body: null };
      const hit = await handle({ req: {}, res, method: 'GET', p: '/api/fs-browse', url: new URL(`http://x/api/fs-browse${search}`) }, deps, shared);
      return { hit, status: res.status, body: res.body };
    };

    const bad = await call(`?dir=${encodeURIComponent(link)}`);
    check(bad.status === 403, 'W15：目录浏览的软链逃逸必须 403', JSON.stringify(bad));
    check(String(bad.body?.error || '').includes('不在可浏览范围'), 'W15：403 理由必须可见', JSON.stringify(bad.body));

    const good = await call(`?dir=${encodeURIComponent(workRoot)}`);
    check(good.status === 200 && good.body?.ok === true, 'W15：允许根内目录必须可浏览', JSON.stringify(good));
    check((good.body?.entries || []).some((e) => e.name === 'visible'), 'W15：浏览结果必须列出根内子目录', JSON.stringify(good.body?.entries));
    ok('W15 Web 浏览围栏：软链 403 / 根内 200');
  }

  console.log('\nworkspace-fence：15 项全部通过');
} finally {
  for (const dir of cleanups) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
