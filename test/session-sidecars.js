// 会话删除/改名的**侧车生命周期**回归（v0.10.1，v0.8.1 审计报告2 M-06）。
//
// 缺陷（实测）：`POST /api/session` 的 delete 只 `unlink(.jsonl)`、rename 只 `rename(.jsonl)`。
// 一个会话在磁盘上其实有 6 个伴生文件：
//   sessions/<name>.jsonl、sessions/<name>.jsonl.lock
//   sessions/<name>.events.ndjson、sessions/<name>.events.ndjson.lock
//   taskstates/<name>.jsonl.json、taskstates/<name>.jsonl.json.lock
// 只删主文件 → 磁盘只增不减；`scripts/event-parity.mjs` 会看到「有事件侧车、没会话」的幽灵；
// 只改名主文件 → 旧侧车成孤儿，新会话从旧事件 seq 继续。
//
// 本套件钉住四件事：
//   ① 删除后 6 个文件全部不存在（含任务检查点/两把锁），且不留删除临时目录；
//   ② 删除时工作空间映射一并清掉；
//   ③ 改名后事件侧车/任务检查点跟着走（内容不变）、旧路径全消失（锁是瞬时文件，改名即清）、
//      工作空间映射迁移；
//   ④ 删除/改名**中途失败** → 返回 500 + 原文件保持原状（绝不删一半/搬一半）。
//
// 运行：node test/session-sidecars.js（离线；临时 MINGDAO_HOME）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sidecars-'));
process.env.MINGDAO_HOME = home;
delete process.env.MINGDAO_EVENT_LOG;
delete process.env.MINGDAO_EVENT_SOURCE;

const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);
const E = await load('session-events.js');
E.setEventLogEnabled(true);
const WS = await load('workspace.js');
const Routes = await load('web/routes/domains/sessions.js');

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const sessionsDir = path.join(home, 'sessions');
const taskStatesDir = path.join(home, 'taskstates');
fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(taskStatesDir, { recursive: true, mode: 0o700 });

/** 会话主文件与全部侧车（与 src/session-files.js#sessionFileFamily 同口径，测试独立列一份）。 */
function family(name) {
  const main = path.join(sessionsDir, name);
  const event = E.eventFileFor(main);
  const task = path.join(taskStatesDir, `${name}.json`);
  return { main, event, task, files: [main, `${main}.lock`, event, `${event}.lock`, task, `${task}.lock`] };
}

/** 造一个「写入了消息 + 事件 + 任务检查点 + 两把锁残留」的完整会话。 */
function makeFullSession(/** @type {string} */ name) {
  const fam = family(name);
  fs.writeFileSync(fam.main, JSON.stringify({ role: 'user', content: '你好' }) + '\n', { mode: 0o600 });
  const ev = E.appendEvent(fam.event, { type: 'message.append', data: { message: { role: 'user', content: '你好' } } });
  assert.equal(ev.ok, true, `appendEvent 应成功：${JSON.stringify(ev)}`);
  fs.writeFileSync(fam.task, JSON.stringify({ goal: '续跑目标', status: 'cap' }) + '\n');
  // 模拟崩溃/并发残留的两把锁（生命周期由 rename/delete 负责清理）。
  fs.writeFileSync(`${fam.main}.lock`, JSON.stringify({ pid: 1 }));
  fs.writeFileSync(`${fam.event}.lock`, JSON.stringify({ pid: 1 }));
  fs.writeFileSync(`${fam.task}.lock`, JSON.stringify({ pid: 1 }));
  return fam;
}

/** 直接调用会话域路由。 */
async function call(/** @type {any} */ body) {
  const ctx = {
    req: { body },
    res: {},
    method: 'POST',
    p: '/api/session',
    url: new URL('http://127.0.0.1/api/session'),
  };
  const deps = { home, state: { workingDir: home }, draftTexts: new Map(), cfg: {} };
  /** @type {{status:number, body:any}} */
  const out = { status: 0, body: null };
  const shared = {
    MAX_API_BODY: 1024 * 1024,
    json: (/** @type {any} */ _res, /** @type {number} */ status, /** @type {any} */ obj) => {
      out.status = status;
      out.body = obj;
      return true;
    },
    readBody: async (/** @type {any} */ req) => req.body,
  };
  const hit = await Routes.handle(ctx, deps, shared);
  assert.equal(hit, true, 'POST /api/session 必须命中会话域');
  return out;
}

/** @param {string[]} files */
function allExist(files) {
  return files.every((f) => fs.existsSync(f));
}
/** @param {string[]} files */
function allGone(files) {
  return files.every((f) => !fs.existsSync(f));
}

// ===========================================================================
// ① 删除：6 个文件全清 + 工作空间映射清掉 + 不留删除临时目录
// ===========================================================================
{
  const name = 'del-full.jsonl';
  const fam = makeFullSession(name);
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-ws-'));
  await WS.setSessionWorkspace(name, targetDir);
  assert.notEqual(WS.getSessionWorkspace(name), null, '删除前工作空间映射应存在');

  const r = await call({ action: 'delete', file: name });
  assert.equal(r.status, 200, `删除应成功：${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true, '删除响应应 ok:true');
  assert.ok(allGone(fam.files), `删除后 6 个文件都不应存在，实际残留：${fam.files.filter((f) => fs.existsSync(f))}`);
  assert.equal(WS.getSessionWorkspace(name), null, '删除后会话工作空间映射应清掉');
  const trash = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('.session-del-'));
  assert.deepEqual(trash, [], `删除成功后不得留下临时目录：${trash.join(', ')}`);
  ok('① 删除：主文件/事件侧车/两把锁/任务检查点全清，映射清掉，无临时目录');
}

// ===========================================================================
// ② 改名：侧车跟着走（内容不变）、旧路径全消失、工作空间映射迁移
// ===========================================================================
{
  const name = 'rename-full.jsonl';
  const fam = makeFullSession(name);
  const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-ws-'));
  await WS.setSessionWorkspace(name, targetDir);
  const eventBefore = fs.readFileSync(fam.event, 'utf8');
  const taskBefore = fs.readFileSync(fam.task, 'utf8');

  const r = await call({ action: 'rename', file: name, title: '改名后的会话' });
  assert.equal(r.status, 200, `改名应成功：${JSON.stringify(r.body)}`);
  const newName = String(r.body.file || '');
  assert.ok(newName.includes('改名后的会话'), `改名后文件名应含新标题，实际：${newName}`);
  const renamed = family(newName);
  assert.ok(fs.existsSync(renamed.main), '改名后新主文件必须存在');
  assert.ok(fs.existsSync(renamed.event), '改名后事件侧车必须跟着搬走');
  assert.ok(fs.existsSync(renamed.task), '改名后任务检查点必须跟着搬走');
  assert.ok(allGone(fam.files), `改名后旧路径必须全部消失，实际残留：${fam.files.filter((f) => fs.existsSync(f))}`);
  assert.equal(fs.readFileSync(renamed.event, 'utf8'), eventBefore, '改名不得改动事件侧车内容');
  assert.equal(fs.readFileSync(renamed.task, 'utf8'), taskBefore, '改名不得改动任务检查点内容');
  const mapped = WS.getSessionWorkspace(newName);
  assert.ok(mapped && path.resolve(mapped) === path.resolve(targetDir), `工作空间映射应迁移到新会话名：${JSON.stringify(mapped)}`);
  assert.equal(WS.getSessionWorkspace(name), null, '改名后旧会话名的映射应消失');
  ok('② 改名：事件侧车/任务检查点跟着走且内容不变，锁清掉，旧路径全消失，映射迁移');
}

// ===========================================================================
// ③ 目标 basename 已有孤儿侧车：不得覆盖，改随机后缀
// ===========================================================================
{
  const name = 'rename-collide.jsonl';
  const fam = makeFullSession(name);
  const orphan = path.join(sessionsDir, '改名冲突.events.ndjson');
  fs.writeFileSync(orphan, '{"seq":99}\n');
  const r = await call({ action: 'rename', file: name, title: '改名冲突' });
  assert.equal(r.status, 200, `有同名孤儿侧车时应换随机后缀而不是失败：${JSON.stringify(r.body)}`);
  const newName = String(r.body.file || '');
  assert.notEqual(newName, '改名冲突.jsonl', '目标名被孤儿侧车占用时必须换随机后缀，绝不覆盖别人的侧车');
  assert.equal(fs.readFileSync(orphan, 'utf8'), '{"seq":99}\n', '孤儿侧车不得被覆盖');
  assert.ok(allGone(fam.files), '搬迁后旧路径必须全部消失');
  fs.rmSync(orphan, { force: true });
  ok('③ 改名冲突：目标侧车已存在 → 换随机后缀，不覆盖孤儿');
}

// ===========================================================================
// ④ 删除中途失败：返回 500 且原文件全部还在（绝不删一半）
// ===========================================================================
{
  const name = 'del-fail.jsonl';
  const fam = makeFullSession(name);
  const realRename = fs.renameSync;
  let calls = 0;
  // @ts-ignore 注入：第 2 次 rename 失败（主文件已搬进临时目录、侧车还没搬完）
  fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => {
    calls += 1;
    if (calls === 2) {
      const e = /** @type {any} */ (new Error('EIO: 注入删除中途失败'));
      e.code = 'EIO';
      throw e;
    }
    return realRename.call(fs, from, to);
  };
  let r;
  try {
    r = await call({ action: 'delete', file: name });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.status, 500, `删除中途失败必须返回 500，实际 ${r.status}`);
  assert.equal(r.body.ok, false, '失败响应必须 ok:false');
  assert.ok(String(r.body.error || '').includes('删除会话失败'), `失败原因必须可读，实际：${r.body.error}`);
  assert.ok(allExist(fam.files), `失败后原文件必须全部还原，实际缺失：${fam.files.filter((f) => !fs.existsSync(f))}`);
  const trash = fs.readdirSync(sessionsDir).filter((f) => f.startsWith('.session-del-'));
  assert.deepEqual(trash, [], '失败回滚后不得留下删除临时目录');
  ok('④ 删除中途失败：500 + 原文件全部还原 + 无临时目录');
}

// ===========================================================================
// ⑤ 改名中途失败：返回 500 且原会话（含侧车）保持原状
// ===========================================================================
{
  const name = 'rename-fail.jsonl';
  const fam = makeFullSession(name);
  const realRename = fs.renameSync;
  let calls = 0;
  // @ts-ignore 注入：第 2 次 rename 失败（主文件已搬到新名字、侧车还没搬完）
  fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => {
    calls += 1;
    if (calls === 2) {
      const e = /** @type {any} */ (new Error('EIO: 注入改名中途失败'));
      e.code = 'EIO';
      throw e;
    }
    return realRename.call(fs, from, to);
  };
  let r;
  try {
    r = await call({ action: 'rename', file: name, title: '改坏了' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.status, 500, `改名中途失败必须返回 500，实际 ${r.status}`);
  assert.ok(allExist(fam.files), `失败后原会话 6 个文件必须全部还原，实际缺失：${fam.files.filter((f) => !fs.existsSync(f))}`);
  assert.equal(fs.existsSync(path.join(sessionsDir, '改坏了.jsonl')), false, '失败后不得留下新名字的主文件');
  assert.equal(fs.existsSync(E.eventFileFor(path.join(sessionsDir, '改坏了.jsonl'))), false, '失败后不得留下新名字的事件侧车');
  ok('⑤ 改名中途失败：500 + 原文件全部还原 + 新路径无残留');
}

console.log(`\nsession-sidecars：${passed} 项通过`);
