// 会话域（Phase C C1）：/api/sessions /api/session /api/events /api/draft
// 会话列表/搜索、载入（聚焦工作空间）、重命名/删除、按会话隔离的草稿槽；
// v0.7.0 §1.1 切片 B1：`GET /api/events?file=&after=` 按 seq 游标只读事件日志（SSE 续订 / 跳号整窗重取）。
import fs from 'node:fs';
import path from 'node:path';
import { eventFileFor, readAfter } from '../../../session-events.js';
import {
  listSessions,
  loadSession,
  searchSessionsAsync,
  relativeTime,
  sessionPreview,
} from '../../../session.js';
import { sanitizeTitle, renameSessionFile, titleModel } from '../../../titles.js';
import { loadTaskState } from '../../../task-state.js';
import {
  workspaceForDir,
  touchWorkspace,
  getSessionWorkspace,
  moveSessionWorkspace,
  removeSessionWorkspace,
} from '../../../workspace.js';

/**
 * v0.6.22（§3.84）：会话列表的**只增**元数据。
 *
 * 只读文件、绝不改写；坏行/不可读文件按 0 条处理，不得让整个列表接口 500——
 * 真机上确实存在历史遗留的半截 JSONL（进程被 kill 时最后一行可能不完整）。
 * 标题沿用既有事实来源：会话文件名（自动标题 / 手工重命名都会落到文件名）。
 * @param {string} file 会话文件绝对路径
 * @param {string} name 会话文件名
 * @returns {{messageCount:number,title:string}}
 */
function sessionMeta(file, name) {
  let messageCount = 0;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m && typeof m === 'object' && ['system', 'user', 'assistant', 'tool'].includes(m.role)) messageCount += 1;
      } catch {
        // 单行损坏只跳过该行：旧会话/半截写入都不能把整个列表打挂。
      }
    }
  } catch {
    // 文件在 readdir 之后被删除/无权限：计数按 0，元数据仍可返回。
  }
  return { messageCount, title: name.replace(/\.jsonl$/, '') };
}

/**
 * 会话域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { home, state, draftTexts } = deps;
  // v0.4.7：草稿槽上限（超出按插入顺序淘汰最旧）——防单个已认证客户端无界增长
  const MAX_DRAFTS = 64;

  if (method === 'GET' && p === '/api/sessions') {
    const q = url.searchParams.get('q');
    // v0.6.22（§3.84）：每项**只增** updatedAt / messageCount / title 三个字段；
    // file / mtime / label 的既有语义与顺序不变（前端 crumb、命令面板、同步等仍按旧字段消费）。
    const decorate = (/** @type {any} */ s, /** @type {string} */ label) => {
      const meta = sessionMeta(path.join(home, 'sessions', path.basename(s.name)), s.name);
      return {
        file: s.name,
        mtime: s.mtime,
        label,
        updatedAt: new Date(s.mtime).toISOString(),
        messageCount: meta.messageCount,
        title: meta.title,
      };
    };
    const found = q
      // v0.6.30（E3）：请求路径必须走异步版——索引进程锁争用时不能冻结事件循环。
      ? (await searchSessionsAsync(home, q, { limit: 30 })).map((/** @type {any} */ s) => decorate(s, `${relativeTime(s.mtime)} · ${s.snippet}`))
      : listSessions(home).slice(0, 30).map((s) => decorate(s, `${relativeTime(s.mtime)} · ${sessionPreview(s.file)}`));
    json(res, 200, { ok: true, sessions: found });
    return true;
  }

  if (method === 'GET' && p === '/api/session') {
    const file = url.searchParams.get('file');
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    try {
      const loaded = loadSession(path.join(home, 'sessions', path.basename(file)));
      // 载入会话时聚焦其工作空间（P3-4）：全局默认切到该会话的目录，前端下拉同步显示
      const wsDir = getSessionWorkspace(path.basename(file));
      const ws = workspaceForDir(wsDir);
      if (wsDir && path.resolve(wsDir) !== path.resolve(state.workingDir)) {
        state.workingDir = wsDir; // 审计 P2-5：仅在目录不同时才切换，减少全局状态抖动
        if (ws) await touchWorkspace(ws.name);
      }
      json(res, 200, {
        ok: true,
        // v0.6.22（§3.84）：只增 ts。旧会话消息没有 ts → **null**（前端据此不显示时间），
        // 绝不在这里用文件 mtime 冒充消息时间，也绝不因缺字段报错。
        messages: loaded.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role, content: m.content ?? '', ts: typeof m.ts === 'string' && m.ts ? m.ts : null })),
        workspace: ws?.name || null,
        // v0.3.0 P0-2：未完成检查点（供前端提示续跑）
        taskState: loadTaskState(path.basename(file)),
        // v0.7.0 §1.1 切片 B1：**事件游标**（event seq）——该会话事件日志的最大 seq；无日志为 0。
        // 注意：这是「每个会话跨轮单调」的事件日志编号，**不是** SSE 帧的 streamSeq（每个 task 从 1 起），
        // 两者互不推导；前端不得拿它去校验帧号（见 server.js#createSseWriter 的双游标说明）。
        lastEventSeq: readAfter(eventFileFor(path.join(home, 'sessions', path.basename(file))), 0).lastSeq,
      });
    } catch {
      json(res, 404, { error: '会话不存在' });
    }
    return true;
  }

  // v0.7.0 §1.1 切片 B1：按 **event seq** 游标读取会话事件日志（不是 SSE 帧的 streamSeq！）。
  //
  // 双游标（见 server.js#createSseWriter）：本端点与 `lastEventSeq` 用的是「每个会话跨轮单调」的
  // 事件日志 seq；SSE 帧上的 `streamSeq` 是「每个 task 从 1 起」的流游标——两者互不推导，
  // 客户端用 streamSeq 检测漏帧、用本端点的 after/event seq 整窗重取事件。
  //
  // 契约：
  //   · `after` 缺省 = 0（返回全部）；非数字 / 负数 → 400（**严格**，不把垃圾解析成 0：
  //     否则客户端一次拼错 URL 就会静默收到全量重放，跳号检测反而更难查）；
  //   · `file` 只接受 basename：含 / \ 或就是 . / .. → 400（事件日志与会话同目录，放开即目录穿越）；
  //   · 会话 `.jsonl` 不存在 → 404（问的是「这个会话」，会话本身没有）；
  //   · 会话存在但事件文件不存在（旧会话 / eventLog 关闭）→ **200** + `{lastSeq:0, events:[]}`，
  //     不是 404——事件日志是旁路，缺它不代表会话不可读。
  if (method === 'GET' && p === '/api/events') {
    const file = String(url.searchParams.get('file') || '');
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    if (/[\\/]/.test(file) || file === '.' || file === '..') {
      return json(res, 400, { error: 'file 只接受会话文件名（不得含路径）' });
    }
    const afterRaw = url.searchParams.get('after');
    let after = 0;
    if (afterRaw !== null) {
      if (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(Number(afterRaw))) {
        return json(res, 400, { error: 'after 必须是非负整数' });
      }
      after = Number(afterRaw);
    }
    const full = path.join(home, 'sessions', file);
    if (!fs.existsSync(full)) return json(res, 404, { error: '会话不存在' });
    const read = readAfter(eventFileFor(full), after);
    if (!read.ok) return json(res, 500, { error: `读取事件日志失败：${read.error || '未知原因'}` });
    // `seqKind:'event'`：机器可读地声明 lastSeq/events[].seq 是**事件日志**编号（不是 streamSeq）。
    return json(res, 200, { ok: true, file, seqKind: 'event', lastSeq: read.lastSeq, events: read.events });
  }

  if (method === 'POST' && p === '/api/session') {
    const body = await readBody(req, MAX_API_BODY);
    const file = path.basename(String(body.file || ''));
    const full = path.join(home, 'sessions', file);
    if (!file || !fs.existsSync(full)) return json(res, 404, { error: '会话不存在' });
    if (body.action === 'rename') {
      const title = sanitizeTitle(String(body.title || '会话'));
      const renamed = renameSessionFile(fs, path, home, { file: full }, title);
      if (!renamed) return json(res, 500, { error: '重命名失败（可能存在同名会话）' });
      await moveSessionWorkspace(file, path.basename(renamed));
      return json(res, 200, { ok: true, file: path.basename(renamed) });
    }
    if (body.action === 'delete') {
      try {
        fs.unlinkSync(full);
        await removeSessionWorkspace(file);
        return json(res, 200, { ok: true });
      } catch (/** @type {any} */ err) {
        return json(res, 500, { error: String(err?.message || err) });
      }
    }
    return json(res, 400, { error: '未知操作：rename|delete' });
  }

  // v0.3.0 P0-3：会话收尾（前端「新对话/切换会话」时调用）——在会话边界提取项目记忆+日志，
  // 而非逐轮提取，避免项目记忆文件在会话中途变化破坏前缀缓存（省钱核心）。
  if (method === 'POST' && p === '/api/session-finalize') {
    const body = await readBody(req, MAX_API_BODY);
    const file = path.basename(String(body.file || ''));
    if (!file) return json(res, 400, { error: '缺少 file 参数' });
    // v0.4.7（T21）：会话文件不存在应 404；且**不回传底层错误信息**——此前会把
    // 「ENOENT: ... open '/Users/xxx/.mingdao/sessions/42'」这类绝对路径直接吐给调用方。
    if (!fs.existsSync(path.join(home, 'sessions', file))) {
      return json(res, 404, { error: `会话不存在：${file}` });
    }
    try {
      const loaded = loadSession(path.join(home, 'sessions', file));
      if (loaded.messages.length) {
        const wsDir = getSessionWorkspace(file) || state.workingDir;
        const { finalizeSession } = await import('../../../memory.js');
        const lastAsst = [...loaded.messages].reverse().find((/** @type {any} */ m) => m.role === 'assistant');
        await finalizeSession({
          cfg: deps.cfg,
          provider: deps.provider,
          model: titleModel(deps.cfg, state.modelName),
          home,
          workingDir: wsDir,
          messages: loaded.messages,
          turns: loaded.messages.filter((/** @type {any} */ m) => m.role === 'user').length,
          lastText: lastAsst?.content || '',
        });
      }
      // 清掉该会话的项目记忆快照：下次重新打开会用最新记忆重建系统提示
      if (deps.sessionMemoryCache) deps.sessionMemoryCache.delete(file);
      json(res, 200, { ok: true });
    } catch (/** @type {any} */ e) {
      json(res, 500, { error: '会话收尾失败（详见服务端日志）' });
      try {
        console.error('[MingDao] session-finalize 失败：' + String(e?.message || e));
      } catch {}
    }
    return true;
  }

  if (method === 'GET' && p === '/api/draft') {
    // 质检 A5：按会话维度读取（无 file 参数用全局槽，兼容旧客户端）
    const key = String(url.searchParams.get('file') || '');
    const text = draftTexts.get(key) || '';
    draftTexts.delete(key); // 读取即清除
    json(res, 200, { ok: true, text });
    return true;
  }

  if (method === 'POST' && p === '/api/draft') {
    const body = await readBody(req, MAX_API_BODY);
    const key = String(body.file || '');
    // v0.4.7：草稿槽必须有界。key 完全由调用方指定（每次请求可以是新 key），此前 Map 永不淘汰——
    // 实测 150 次请求（每次 200KB）让 RSS +40MB 且不回收。改为 LRU 上限（重新 set 会移到队尾）。
    draftTexts.delete(key);
    draftTexts.set(key, String(body.text ?? '').slice(0, 200000));
    while (draftTexts.size > MAX_DRAFTS) {
      const oldest = draftTexts.keys().next().value;
      if (oldest === undefined) break;
      draftTexts.delete(oldest);
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}
