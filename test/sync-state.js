// 云同步状态机行为套件（v0.7.0 §1.2「变异补盲」）：`src/sync.js` 此前 0 条变异。
//
//   node test/sync-state.js
//
// 这套件只用**本机临时目录 + 桩 HTTP 服务端**，不连网、不碰真实 ~/.mingdao。
// 覆盖的是 sync.js 里最容易写错、且单进程顺序调用永远看不到的语义：
//   · 推送记账：remoteMtime + **localMtime**（丢了 localMtime → 每轮全量重传）
//   · 增量跳过：本地没变 → 一次网络往返都不发；本地变了 → 必须重推（不能只信远端记账）
//   · 冲突备份：只有「本地记过远端版本 + 远端被别的设备改过 + 内容不同」才备份；
//     首次推送不得凭空造 `.server-` 副本
//   · 状态增量合并（T19）：只合并本次变更的键，**磁盘上其它会话的记账必须留着**；
//     同一会话是整键替换（旧字段不残留）
//   · 拉取：远端 mtime 未变 → 不下载；本地有不同内容 → 保留本地 + `.remote-` 副本
//   · 边界：空会话 / 超过 20MB / 非法远端会话名 / 上传前脱敏
//
// 断言都带 `E<n>：` 前缀——变异批次（batch72）用这些关键词证明"红的是我改的那条"。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);

// 先钉住 home，再 import（config/credentials 在调用时读进程环境）
process.env.MINGDAO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-state-boot-'));

const sync = await load('sync.js');

const cleanups = [];
const ok = (/** @type {string} */ n) => console.log(`  ✓ ${n}`);
/** @param {any} cond @param {string} tag @param {string} detail */
function check(cond, tag, detail) {
  assert.ok(cond, `${tag}：${detail}`);
}
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 桩同步服务端（内存态；mtime 用单调递增的整数，避免同毫秒冲突）
// ---------------------------------------------------------------------------
/** @type {Map<string, {content: string, mtime: number}>} */
const remote = new Map();
/** @type {{path: string, name: string}[]} */
const requests = [];
let clock = 1_700_000_000_000;
let pushDelayMs = 0;

const server = http.createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    /** @type {any} */
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      body = {};
    }
    const route = String(req.url || '').replace(/^\/+/, '');
    requests.push({ path: route, name: String(body.name || '') });
    const send = (/** @type {number} */ status, /** @type {any} */ obj) => {
      // v0.6.33（Node 18 腿假红）：桩服务端**禁用 keep-alive**。
      // 若沿用默认的 5s keep-alive，E8 写 19MB 会话会耗掉数秒，客户端连接池里的空闲 socket
      // 正好被服务端按 keepAliveTimeout 关掉，下一次 pull 复用这条已关闭的 socket →
      // `read ECONNRESET`（实测 Node 18.20.8 本机必现、ubuntu-18 CI 腿必红）。
      // 这里不是放宽断言：被测的是 sync.js 的同步语义，不是 HTTP 连接复用策略。
      res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (route === 'api/sessions/list') {
        send(200, { sessions: [...remote.entries()].map(([name, v]) => ({ name, mtime: v.mtime })) });
        return;
      }
      if (route === 'api/sessions/pull') {
        const v = remote.get(String(body.name));
        if (!v) return send(404, { error: 'not found' });
        send(200, { ok: true, content: v.content, mtime: v.mtime });
        return;
      }
      if (route === 'api/sessions/push') {
        if (pushDelayMs) await sleep(pushDelayMs);
        clock += 1;
        remote.set(String(body.name), { content: String(body.content ?? ''), mtime: clock });
        send(200, { ok: true, mtime: clock });
        return;
      }
      send(404, { error: `no route ${route}` });
    } catch (e) {
      send(500, { error: String(/** @type {any} */ (e)?.message || e) });
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const port = /** @type {any} */ (server.address()).port;
const base = `http://127.0.0.1:${port}`;

/** 新建一个隔离的 MINGDAO_HOME（config + credentials + sessions），并切换过去。 */
function newHome(/** @type {string} */ tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `mingdao-sync-state-${tag}-`));
  cleanups.push(home);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ sync: { url: base, username: 'tester', auto: true } }, null, 2)
  );
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ sync: { token: 'test-token', deviceId: 'dev-test' } }, null, 2), {
    mode: 0o600,
  });
  process.env.MINGDAO_HOME = home;
  return home;
}

/** 写一个会话文件并把 mtime 推到确定的时刻。 */
function writeSession(/** @type {string} */ home, /** @type {string} */ name, /** @type {string} */ content, /** @type {number} */ mtimeOffset = 0) {
  const dir = path.join(home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  const when = new Date(Date.now() + mtimeOffset);
  fs.utimesSync(file, when, when);
  return file;
}
/** @param {string} file */
function mtimeOf(file) {
  return fs.statSync(file).mtimeMs;
}
/** @param {string} home */
function readStateOf(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'sync-state.json'), 'utf8'));
  } catch {
    return {};
  }
}
/** @param {string} home @param {RegExp} re */
function sessionsMatching(home, re) {
  try {
    return fs.readdirSync(path.join(home, 'sessions')).filter((f) => re.test(f));
  } catch {
    return [];
  }
}
/** @param {string} route */
const countRoute = (route) => requests.filter((r) => r.path === route).length;

try {
  // -------------------------------------------------------------------------
  // E1 未配置 / 未登录：必须**可操作**地报错，而不是发请求或静默
  // -------------------------------------------------------------------------
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sync-state-e1-'));
    cleanups.push(home);
    process.env.MINGDAO_HOME = home;
    const before = requests.length;
    const r1 = await sync.syncPush();
    check(r1.error === '未配置同步服务器（mingdao sync login <用户名>）', 'E1：未配置同步服务器时必须明确报错', `实际：${JSON.stringify(r1)}`);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ sync: { url: base, username: 'tester' } }, null, 2));
    const r2 = await sync.syncPull();
    check(r2.error === '未登录（mingdao sync login <用户名>）', 'E1：未登录时必须明确报错', `实际：${JSON.stringify(r2)}`);
    check(requests.length === before, 'E1：未配置/未登录不得发出任何网络请求', `新增 ${requests.length - before} 条`);
    ok('E1 未配置/未登录：明确报错且零网络请求');
  }

  // -------------------------------------------------------------------------
  // E2 首次推送：会话落远端，状态同时记 remoteMtime 与 localMtime
  // -------------------------------------------------------------------------
  const homeA = newHome('a');
  const fileA = writeSession(homeA, 'a.jsonl', 'hello world\n');
  {
    const r = await sync.syncPush('a.jsonl');
    check(r.ok === true && r.pushed.includes('a.jsonl'), 'E2：首次推送必须成功', JSON.stringify(r));
    const st = readStateOf(homeA)['a.jsonl'];
    check(st && typeof st.remoteMtime === 'number', 'E2：推送后必须记下 remoteMtime', JSON.stringify(st));
    check(st && typeof st.localMtime === 'number', 'E2：推送后必须记下 localMtime（丢了它每轮都会全量重传）', JSON.stringify(st));
    check(Math.abs(st.localMtime - mtimeOf(fileA)) < 1, 'E2：localMtime 必须等于本地文件 mtime', `${st.localMtime} vs ${mtimeOf(fileA)}`);
    check(remote.get('a.jsonl')?.content === 'hello world\n', 'E2：远端内容必须等于本地内容', JSON.stringify(remote.get('a.jsonl')));
    ok('E2 首次推送：内容 + remoteMtime + localMtime 三件事都记下');
  }

  // -------------------------------------------------------------------------
  // E3 增量跳过：本地未变 → 不再发 pull/push（只留状态里的记账）
  // -------------------------------------------------------------------------
  {
    const beforePull = countRoute('api/sessions/pull');
    const beforePush = countRoute('api/sessions/push');
    const r = await sync.syncPush('a.jsonl');
    check(r.ok === true && r.pushed.length === 0 && r.skipped.includes('a.jsonl'), 'E3：本地未变必须跳过推送', JSON.stringify(r));
    check(countRoute('api/sessions/pull') === beforePull, 'E3：跳过时不得再拉远端（增量推送）', `pull 新增 ${countRoute('api/sessions/pull') - beforePull} 条`);
    check(countRoute('api/sessions/push') === beforePush, 'E3：跳过时不得再推送', `push 新增 ${countRoute('api/sessions/push') - beforePush} 条`);
    ok('E3 增量推送：本地未变 → 零网络往返');
  }

  // -------------------------------------------------------------------------
  // E4 本地变了就必须重推（不能只信「远端记过账」）
  // -------------------------------------------------------------------------
  {
    writeSession(homeA, 'a.jsonl', 'hello world v2\n', 5000);
    const r = await sync.syncPush('a.jsonl');
    check(r.ok === true && r.pushed.includes('a.jsonl'), 'E4：本地内容变化后必须重推', JSON.stringify(r));
    check(remote.get('a.jsonl')?.content === 'hello world v2\n', 'E4：远端必须收到新内容', JSON.stringify(remote.get('a.jsonl')));
    const st = readStateOf(homeA)['a.jsonl'];
    check(Math.abs(st.localMtime - mtimeOf(fileA)) < 1, 'E4：重推后 localMtime 必须更新', `${st.localMtime} vs ${mtimeOf(fileA)}`);
    ok('E4 本地改动：重推并更新 localMtime');
  }

  // -------------------------------------------------------------------------
  // E5 首次推送不造虚假 `.server-` 备份（审计 B7）
  // -------------------------------------------------------------------------
  const homeB = newHome('b');
  {
    remote.set('b.jsonl', { content: 'remote-v0\n', mtime: (clock += 1) });
    writeSession(homeB, 'b.jsonl', 'local-v1\n');
    const r = await sync.syncPush('b.jsonl');
    check(r.ok === true && r.pushed.includes('b.jsonl'), 'E5：首次推送必须成功', JSON.stringify(r));
    check(r.conflicts.length === 0, 'E5：首次推送不得判冲突', JSON.stringify(r.conflicts));
    check(sessionsMatching(homeB, /^b\.server-/).length === 0, 'E5：首次推送不得产生 .server- 备份', sessionsMatching(homeB, /^b\.server-/).join(','));
    ok('E5 首次推送：不产生虚假 .server- 备份');
  }

  // -------------------------------------------------------------------------
  // E6 真冲突：远端被别的设备改过 + 本地也改了 → 先备份远端，再用本地覆盖
  // -------------------------------------------------------------------------
  {
    remote.set('b.jsonl', { content: 'remote-v2-from-other-device\n', mtime: (clock += 1) });
    writeSession(homeB, 'b.jsonl', 'local-v2\n', 9000);
    const r = await sync.syncPush('b.jsonl');
    check(r.ok === true && r.pushed.includes('b.jsonl'), 'E6：冲突时仍以本地覆盖远端', JSON.stringify(r));
    check(r.conflicts.includes('b.jsonl'), 'E6：远端被别的设备改过时必须记为冲突', JSON.stringify(r.conflicts));
    const backups = sessionsMatching(homeB, /^b\.server-/);
    check(backups.length === 1, 'E6：冲突必须留下 1 份 .server- 备份', backups.join(','));
    check(fs.readFileSync(path.join(homeB, 'sessions', backups[0]), 'utf8') === 'remote-v2-from-other-device\n', 'E6：.server- 备份必须是被覆盖掉的远端内容', fs.readFileSync(path.join(homeB, 'sessions', backups[0]), 'utf8'));
    check(remote.get('b.jsonl')?.content === 'local-v2\n', 'E6：远端最终是本地内容', JSON.stringify(remote.get('b.jsonl')));
    ok('E6 冲突：备份远端 + 本地覆盖，两份都不丢');
  }

  // -------------------------------------------------------------------------
  // E7 空会话不推送（刚创建、还没写消息）
  // -------------------------------------------------------------------------
  {
    const home = newHome('empty');
    writeSession(home, 'empty.jsonl', '   \n\n');
    const beforePush = countRoute('api/sessions/push');
    const r = await sync.syncPush('empty.jsonl');
    check(r.ok === true && r.skipped.includes('empty.jsonl'), 'E7：空会话必须跳过', JSON.stringify(r));
    check(countRoute('api/sessions/push') === beforePush, 'E7：空会话不得发出 push 请求', `push 新增 ${countRoute('api/sessions/push') - beforePush} 条`);
    ok('E7 空会话：跳过且不发请求');
  }

  // -------------------------------------------------------------------------
  // E8 超过 20MB 上限的会话：明确报错跳过，不把半截内容传上去
  // -------------------------------------------------------------------------
  {
    const home = newHome('big');
    writeSession(home, 'big.jsonl', 'a'.repeat(19 * 1024 * 1024 + 1));
    const r = await sync.syncPush('big.jsonl');
    check(String(r.error || '').includes('20MB'), 'E8：超过 20MB 必须明确报错（包含 20MB 字样）', JSON.stringify(r));
    check(!remote.has('big.jsonl'), 'E8：超限会话不得被上传', JSON.stringify(remote.has('big.jsonl')));
    ok('E8 超限会话：明确拒绝并跳过');
  }

  // -------------------------------------------------------------------------
  // E9 上传前脱敏：远端拿到掩码，本地原文不动
  // -------------------------------------------------------------------------
  {
    const home = newHome('redact');
    const file = writeSession(home, 'secret.jsonl', 'key=sk-abcdef123456 tail\n');
    const r = await sync.syncPush('secret.jsonl');
    check(r.ok === true && r.redacted.includes('secret.jsonl'), 'E9：含密钥的会话必须标记为已脱敏', JSON.stringify(r));
    const sent = remote.get('secret.jsonl')?.content || '';
    check(sent.includes('***') && !sent.includes('sk-abcdef123456'), 'E9：远端必须是掩码后的内容（原始密钥不得上传）', JSON.stringify(sent));
    check(fs.readFileSync(file, 'utf8').includes('sk-abcdef123456'), 'E9：本地会话原文不得被改写', fs.readFileSync(file, 'utf8'));
    ok('E9 上传脱敏：远端掩码、本地原文');
  }

  // -------------------------------------------------------------------------
  // E10 拉取：远端会话落本地，并记下 remoteMtime
  // -------------------------------------------------------------------------
  const homeC = newHome('pull');
  {
    remote.set('p.jsonl', { content: 'remote-p-v1\n', mtime: (clock += 1) });
    const r = await sync.syncPull('p.jsonl');
    check(r.ok === true && r.pulled.includes('p.jsonl'), 'E10：拉取必须成功', JSON.stringify(r));
    check(fs.readFileSync(path.join(homeC, 'sessions', 'p.jsonl'), 'utf8') === 'remote-p-v1\n', 'E10：本地必须写入远端内容', fs.readFileSync(path.join(homeC, 'sessions', 'p.jsonl'), 'utf8'));
    const st = readStateOf(homeC)['p.jsonl'];
    check(st && st.remoteMtime === remote.get('p.jsonl')?.mtime, 'E10：拉取后必须记下远端 mtime', JSON.stringify(st));
    ok('E10 拉取：落盘 + 记 remoteMtime');
  }

  // -------------------------------------------------------------------------
  // E11 断点续传（增量拉取）：远端 mtime 未变 → 不再下载
  // -------------------------------------------------------------------------
  {
    const before = countRoute('api/sessions/pull');
    const r = await sync.syncPull('p.jsonl');
    check(r.ok === true && r.pulled.length === 0, 'E11：远端未变时必须跳过下载', JSON.stringify(r));
    check(countRoute('api/sessions/pull') === before, 'E11：跳过时不得再发 pull 请求（断点续传）', `pull 新增 ${countRoute('api/sessions/pull') - before} 条`);
    ok('E11 增量拉取：远端未变 → 零下载');
  }

  // -------------------------------------------------------------------------
  // E12 远端变了 → 重新下载并更新记账
  // -------------------------------------------------------------------------
  {
    fs.rmSync(path.join(homeC, 'sessions', 'p.jsonl'), { force: true }); // 本地副本丢失（换机/被清理）
    remote.set('p.jsonl', { content: 'remote-p-v2\n', mtime: (clock += 1) });
    const r = await sync.syncPull('p.jsonl');
    check(r.ok === true && r.pulled.includes('p.jsonl'), 'E12：远端变化后必须重新下载', JSON.stringify(r));
    check(fs.readFileSync(path.join(homeC, 'sessions', 'p.jsonl'), 'utf8') === 'remote-p-v2\n', 'E12：本地内容必须更新', fs.readFileSync(path.join(homeC, 'sessions', 'p.jsonl'), 'utf8'));
    check(readStateOf(homeC)['p.jsonl']?.remoteMtime === remote.get('p.jsonl')?.mtime, 'E12：remoteMtime 必须更新', JSON.stringify(readStateOf(homeC)['p.jsonl']));
    ok('E12 远端更新：重新下载 + 更新记账');
  }

  // -------------------------------------------------------------------------
  // E13 拉取冲突：本地不同内容 → 本地不动，远端写入 `.remote-` 副本
  // -------------------------------------------------------------------------
  {
    const local = path.join(homeC, 'sessions', 'p.jsonl');
    fs.writeFileSync(local, 'local-p-edited\n');
    const when = new Date(Date.now() + 12000);
    fs.utimesSync(local, when, when);
    remote.set('p.jsonl', { content: 'remote-p-v3\n', mtime: (clock += 1) });
    const r = await sync.syncPull('p.jsonl');
    check(r.ok === true && r.conflicts.includes('p.jsonl'), 'E13：本地内容不同必须记为冲突', JSON.stringify(r));
    check(fs.readFileSync(local, 'utf8') === 'local-p-edited\n', 'E13：冲突时本地内容必须原样保留', fs.readFileSync(local, 'utf8'));
    const backups = sessionsMatching(homeC, /^p\.remote-/);
    check(backups.length === 1, 'E13：冲突必须留下 1 份 .remote- 副本', backups.join(','));
    check(fs.readFileSync(path.join(homeC, 'sessions', backups[0]), 'utf8') === 'remote-p-v3\n', 'E13：.remote- 副本必须是远端内容', fs.readFileSync(path.join(homeC, 'sessions', backups[0]), 'utf8'));
    ok('E13 拉取冲突：本地保留 + .remote- 副本');
  }

  // -------------------------------------------------------------------------
  // E14 非法远端会话名（恶意服务器）：绝不落盘
  // -------------------------------------------------------------------------
  {
    remote.set('../evil.jsonl', { content: 'pwn\n', mtime: (clock += 1) });
    const r = await sync.syncPull();
    check(r.ok === true, 'E14：含非法名的清单仍应正常返回', JSON.stringify(r));
    check(!fs.existsSync(path.join(homeC, 'evil.jsonl')), 'E14：非法会话名必须被拒绝落盘（不得写出 sessions 目录）', path.join(homeC, 'evil.jsonl'));
    ok('E14 非法远端名：拒绝落盘');
  }

  // -------------------------------------------------------------------------
  // E15 状态增量：合并保留其它会话记账；同一会话整键替换（旧字段不残留）
  // -------------------------------------------------------------------------
  {
    const home = newHome('merge');
    writeSession(home, 'm.jsonl', 'merge-content\n');
    fs.writeFileSync(
      path.join(home, 'sync-state.json'),
      JSON.stringify({ 'other.jsonl': { remoteMtime: 42, note: 'must-survive' }, 'm.jsonl': { remoteMtime: 1, localMtime: 1, stale: 'drop-me' } }, null, 2)
    );
    const r = await sync.syncPush('m.jsonl');
    check(r.ok === true, 'E15：推送必须成功', JSON.stringify(r));
    const st = readStateOf(home);
    check(st['other.jsonl']?.remoteMtime === 42 && st['other.jsonl']?.note === 'must-survive', 'E15：状态增量必须保留磁盘上其它会话的记账（整份替换会丢别人的 remoteMtime）', JSON.stringify(st));
    check(st['m.jsonl'] && st['m.jsonl'].stale === undefined, 'E15：同一会话是整键替换，旧字段不得残留', JSON.stringify(st['m.jsonl']));
    check(typeof st['m.jsonl']?.localMtime === 'number', 'E15：整键替换后仍必须带上 localMtime', JSON.stringify(st['m.jsonl']));
    ok('E15 状态增量：合并保留其它键 + 本键整键替换');
  }

  // -------------------------------------------------------------------------
  // E16 并发 push/pull（CLI 手动 sync 与后台 worker 同时跑）：两侧记账都不丢
  // -------------------------------------------------------------------------
  {
    const home = newHome('concurrent');
    writeSession(home, 'c1.jsonl', 'c1-content\n');
    remote.set('c2.jsonl', { content: 'c2-remote\n', mtime: (clock += 1) });
    pushDelayMs = 400;
    const pushPromise = sync.syncPush('c1.jsonl');
    await sleep(120);
    const pullResult = await sync.syncPull('c2.jsonl');
    const pushResult = await pushPromise;
    pushDelayMs = 0;
    check(pullResult.ok === true && pullResult.pulled.includes('c2.jsonl'), 'E16：并发中的 pull 必须成功', JSON.stringify(pullResult));
    check(pushResult.ok === true && pushResult.pushed.includes('c1.jsonl'), 'E16：并发中的 push 必须成功', JSON.stringify(pushResult));
    const st = readStateOf(home);
    check(typeof st['c1.jsonl']?.remoteMtime === 'number', 'E16：并发 pull 之后 push 的记账不得丢', JSON.stringify(st));
    check(typeof st['c2.jsonl']?.remoteMtime === 'number', 'E16：并发 push 之后 pull 的记账不得丢（整份覆盖会丢它）', JSON.stringify(st));
    ok('E16 并发 push/pull：两侧状态增量都保留');
  }

  console.log(`\nsync-state：16 项全部通过`);
} finally {
  server.close();
  for (const dir of cleanups) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}
