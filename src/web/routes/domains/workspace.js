// 工作空间域（Phase C C1）：/api/workspaces /api/fs-browse
// 工作空间登记/切换/重命名/删除；受限目录浏览（基目录白名单）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  currentWorkspace,
  listWorkspaces,
  addWorkspace,
  removeWorkspace,
  renameWorkspace,
  setWorkspaceDir,
  workspacePath,
  touchWorkspace,
  setSessionWorkspace,
} from '../../../workspace.js';

/**
 * 工作空间域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { cfg, state, startupCwd } = deps;

  // v0.4.7（T1）：允许的目录根集中一处，登记闸门与浏览围栏共用同一份判定，避免两处漂移。
  // Windows 收紧为桌面/文档/下载（家目录覆盖整个用户配置树）；其余平台为家目录。
  const baseRoots = [
    ...(process.platform === 'win32' && process.env.USERPROFILE
      ? [path.join(process.env.USERPROFILE, 'Desktop'), path.join(process.env.USERPROFILE, 'Documents'), path.join(process.env.USERPROFILE, 'Downloads')]
      : [os.homedir()]),
    // 系统临时目录也是常见的工作空间位置（CI、一次性任务、沙箱），纳入允许根；
    // 它不会让「登记 / 或 /etc」变得可行，围栏依然成立。
    os.tmpdir(),
  ];
  const normPath = (/** @type {string} */ x) => (process.platform === 'win32' ? x.toLowerCase() : x);

  // v0.6.3（P0-3）：围栏必须按**真实路径**判定，否则一个符号链接就够了。
  // 原实现只用 path.resolve（纯字符串消解 `..`）做前缀比较，而后续 statSync/readdirSync 会
  // **跟随符号链接**：`ln -s / /tmp/root` 之后 `?dir=/tmp/root` 通过前缀检查、stat 落到 `/`，
  // 于是任意目录枚举；再用 `POST /api/workspaces {dir:'/tmp/root'}` 登记，Agent 的
  // bash/write/edit 就整体跑到围栏之外。`os.tmpdir()` 被无条件算作允许根，门槛更低。
  //
  // 两处都归一化才有意义：目标 realpath + 根 realpath（macOS 的 /Users、Linux 的 /home
  // 常是符号链接，只归一化一边会把合法目录误判越界）。
  /** 归一化到真实路径；目标不存在时回退到「最近的存在祖先」的 realpath 再接回剩余段 */
  const realpathDeep = (/** @type {string} */ p0) => {
    let cur = path.resolve(String(p0));
    /** @type {string[]} */
    const rest = [];
    for (;;) {
      try {
        const real = fs.realpathSync(cur);
        return rest.length ? path.join(real, ...rest.slice().reverse()) : real;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(String(p0)); // 连根都读不到：退回原路径
        rest.push(path.basename(cur));
        cur = parent;
      }
    }
  };
  const allowedRoots = () =>
    [...baseRoots, startupCwd, state.workingDir, ...(Array.isArray(cfg?.web?.browseRoots) ? cfg.web.browseRoots : [])]
      .filter(Boolean)
      .map((r) => normPath(realpathDeep(String(r))));
  /** 目标目录是否落在允许根内（含根自身）——按 realpath 比较，符号链接逃逸会在这里被拒 */
  const withinAllowed = (/** @type {string} */ dir) => {
    const d = normPath(realpathDeep(dir));
    return allowedRoots().some((r) => d === r || d.startsWith(r + path.sep));
  };
  // 显式放开（默认 false）：确需登记家目录之外的位置（外置卷/网络盘）时由用户显式开启
  const allowAnyDir = cfg?.web?.allowAnyWorkspaceDir === true;

  if (method === 'GET' && p === '/api/workspaces') {
    json(res, 200, { ok: true, workspaces: listWorkspaces(), current: currentWorkspace(state.workingDir)?.name || null, cwd: state.workingDir });
    return true;
  }

  if (method === 'POST' && p === '/api/workspaces') {
    const body = await readBody(req, MAX_API_BODY);
    const name = String(body.name || '').trim();
    if (body.action === 'add') {
      if (!name) return json(res, 400, { error: '名称不能为空' });
      const target = realpathDeep(path.resolve(body.dir || state.workingDir)); // P0-3：登记前先消解符号链接
      // v0.4.7（T1）：登记工作空间 == 授权它可被目录浏览（fs-browse 的基目录含 state.workingDir）。
      // 若允许登记任意绝对路径，围栏就能被「先 add 再 set」一步自行解除（登记 / 即可枚举全盘）。
      // 因此登记与自动建目录都限定在允许根内；需要家目录之外的位置请显式配置
      // web.allowAnyWorkspaceDir: true（或把该目录加入 web.browseRoots）。
      if (!allowAnyDir && !withinAllowed(target)) {
        return json(res, 400, {
          error: `目录 ${target} 不在允许范围内（家目录 / 启动目录 / 当前工作目录 / web.browseRoots）。确需登记该位置请配置 web.allowAnyWorkspaceDir: true。`,
        });
      }
      // 目录为空/不存在时自动新建（默认开，create:false 关闭）——仅在允许根内创建
      if (body.create !== false) {
        try {
          fs.mkdirSync(target, { recursive: true });
        } catch (/** @type {any} */ e) {
          return json(res, 400, { error: `无法创建目录：${target}（${e.message}）` });
        }
      }
      const r = await addWorkspace(name, target);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name, dir: r.dir, created: body.create !== false });
    }
    if (body.action === 'rename') {
      const r = await renameWorkspace(name, body.newName);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name });
    }
    if (body.action === 'set') {
      // 切换全局工作空间（新会话默认目录；可带 dir 修改目录）；目录缺失自动重建。
      // 携带 file 时同时把当前会话的工作空间切过去（P3-4：会话跟随显式切换）。
      if (body.dir) {
        // v0.4.7（T1）：改目录同样受允许根约束——否则「先登记一个合法目录，再 set 到 /」即可绕过上面的闸门
        const t2 = realpathDeep(path.resolve(String(body.dir))); // P0-3：同上
        if (!allowAnyDir && !withinAllowed(t2)) {
          return json(res, 400, {
            error: `目录 ${t2} 不在允许范围内（家目录 / 启动目录 / 当前工作目录 / web.browseRoots）。确需切换请配置 web.allowAnyWorkspaceDir: true。`,
          });
        }
        const r = await setWorkspaceDir(name, body.dir);
        if (r.error) return json(res, 400, { error: r.error });
      }
      const dir = workspacePath(name);
      if (!dir) return json(res, 400, { error: `工作空间 ${name} 不存在` });
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (/** @type {any} */ e) {
        return json(res, 400, { error: `无法创建目录：${dir}（${e.message}）` });
      }
      await touchWorkspace(name);
      state.workingDir = dir;
      // 不再 process.chdir：运行中任务的 cwd 在创建时已固定，全局切换只影响新会话
      if (body.file) await setSessionWorkspace(String(body.file), dir, /** @type {any} */ (name));
      return json(res, 200, { ok: true, name, dir, current: name });
    }
    if (body.action === 'remove') {
      if (!name) return json(res, 400, { error: '缺少名称' });
      const rm = await removeWorkspace(name);
      if (rm && /** @type {any} */ (rm).error) return json(res, 500, { error: /** @type {any} */ (rm).error });
      return json(res, 200, { ok: rm === true });
    }
    return json(res, 400, { error: '未知操作：add|rename|set|remove' });
  }

  // 目录浏览器（「新建工作空间」选择电脑磁盘目录用）：本机运行时即用户电脑的目录树；
  // 只列子目录（不含隐藏目录），供前端逐级导航选择
  if (method === 'GET' && p === '/api/fs-browse') {
    let dir = String(url.searchParams.get('dir') || '').trim();
    if (!path.isAbsolute(dir)) return json(res, 400, { error: '需要绝对路径' });
    // 评估 6.1（v0.4.3）：先 path.resolve 消解 .. 段，再做前缀比较与 stat/readdir——此前字符串
    // 前缀比较用未规范化的 dir，`/home/u/../../etc` 能通过 startsWith('/home/u/') 但 stat 解析到 /etc。
    dir = realpathDeep(dir); // v0.6.3（P0-3）：消解符号链接——`path.resolve` 只消解 `..`，挡不住 `ln -s /`
    // 质检 A3：目录浏览限定基目录，拒绝越界。Windows（CodeArts 报告）：家目录覆盖整个用户配置树
    // （AppData 等）——收紧为 桌面/文档/下载 三常用目录 + 启动目录 + 工作目录 + web.browseRoots 显式授权；
    // 路径比较在 win32 下大小写归一（D:\\ vs d:\\ 不再误拒）。
    // v0.4.7（T1）：基目录判定与工作空间登记闸门共用同一份 allowedRoots/normPath（此前两处各写一份，
    // 且登记侧不设闸门 → 围栏可被一次 API 调用自行解除）
    const browseRoots = allowedRoots();
    const norm = normPath;
    const ndir = norm(dir);
    const inRoot = browseRoots.some((r) => ndir === r || ndir.startsWith(r + path.sep));
    if (!inRoot) return json(res, 403, { error: '目录不在可浏览范围内（授权目录或 web.browseRoots 显式添加）' });
    try {
      const st = fs.statSync(dir);
      if (!st.isDirectory()) return json(res, 400, { error: '不是目录' });
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        // P0-3：符号链接条目一律不列出。**如实说明**：`Dirent.isDirectory()` 走的是 lstat 语义，
        // 对符号链接本就返回 false，所以这一条 `!e.isSymbolicLink()` 是双保险而**不是**主要防线
        // （实测：去掉它也列不出链接条目）。真正的防线是上面的 realpath 判定——
        // 即便有人把链接路径直接喂进来，也会因为 realpath 落在允许根之外而被 403。
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
        .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
        .slice(0, 300);
      let parent = path.dirname(dir);
      // 父目录同样不得越出基目录（与上面的判定共用同一个 realpath 版 withinAllowed，避免两处漂移）
      if (!withinAllowed(parent)) parent = /** @type {any} */ (null);
      json(res, 200, { ok: true, path: dir, parent: parent === dir ? null : parent, entries });
    } catch (/** @type {any} */ err) {
      json(res, 400, { error: String(err?.message || err) });
    }
    return true;
  }

  return false;
}
