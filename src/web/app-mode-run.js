// v0.8.1：WebUI「应用模式」的服务端编排（从 web/server.js 的 handleChat 切出）。
//
// 为什么单独成文件：`test/structure-limits.js` 对 `runWebServer` / `handleChat` 有**只许降不许升**
// 的行数红线（单函数 >500 行即结构债务）。应用模式的收尾/落盘/标题改动约 100 行，直接内联会把
// 两个函数的实测行数顶出基线；切出来后 handleChat 只保留**一行分派**，行为完全等价。
//
// 与 Agent 路径的关系：应用接口的服务端工具（`deepseek_web_search` / `deepseek_read_url`）与
// 客户端工具**不能同时声明**，所以这条路径不经过 `src/agent.js` 的工具循环（该文件一行未改）。
// 一次请求内完成「搜索 → 阅读 → 回答 → 标题」，省掉「模型 → 工具 → 再发一次全上下文」的往返。
//
// 本模块只做编排，不做纯计算（delta→帧、历史裁剪在 `web/app-mode.js`）。
// 与 agent 路径共用：会话 claim（busySessions）、幂等收尾 finishChat()、§3.87 的唯一落盘入口
// appendMessages()、以及会话改名（renameSessionFile）。SSE 帧一律走 `send()`（entry.send）封装，
// 因此 taskId / streamSeq 与既有流完全同款（断线续订/跳号检测不需要第二套编号）。

import { appFrameOf, buildAppMessages, appModelOf, APP_NO_KEY_MESSAGE } from './app-mode.js';
import { streamAppChat } from '../deepseek-app.js';
import { resolveProviderConfig } from '../providers/index.js';

/**
 * 执行一轮 WebUI 应用模式对话。调用方（handleChat）负责：已通过 `body.appMode === true &&
 * appModeEnabled(cfg)` 双闸门、已占用会话 claim 并注册好幂等收尾 finishChat。
 *
 * @param {{
 *   cfg: any, body: any, session: any, built: any, userMessage: string, home: string, taskId: string,
 *   send: (obj: any) => void, srvlog: (line: string) => void, entry: any, res: any,
 *   fs: any, path: any,
 *   withSessionLock: (file: any, fn: () => any) => Promise<any>,
 *   appendMessages: (file: any, messages: any[]) => any,
 *   renameSessionFile: (fs: any, pathMod: any, home: any, session: any, title: any) => any,
 *   moveSessionWorkspace: (oldName: string, newName: string) => Promise<any> | any,
 *   claimSessionKey: (key: any) => void,
 *   chatFailure: (message: any, prefix?: any) => any,
 *   finishChat: (cause?: any) => void,
 * }} deps
 * @returns {Promise<void>}
 */
export async function runAppModeChat(deps) {
  const {
    cfg, body, session, built, userMessage, home, taskId, send, srvlog, entry, res,
    fs, path, withSessionLock, appendMessages, renameSessionFile, moveSessionWorkspace, claimSessionKey,
    chatFailure, finishChat,
  } = deps;
  try {
    const appModel = appModelOf(cfg);
    const appCfg = /** @type {any} */ (cfg?.appApi) || {};
    const pc = resolveProviderConfig(cfg, appModel) || {};
    // 可注入点（v0.8.1）：`MINGDAO_APP_BASEURL` 显式优先于 provider 配置——自托管网关/测试桩用
    // （不写配置文件）。缺省仍走 config.json / provider 预设的 baseUrl。
    const appBaseUrl = String(process.env.MINGDAO_APP_BASEURL || pc.baseUrl || '');
    const appApiKey = String(pc.apiKey || '');
    if (!appApiKey) {
      // 与 CLI 同一口径：缺 Key 说明去哪填，而不是把 401 原文丢给用户。
      entry.status = 'failed';
      send({ type: 'error', message: APP_NO_KEY_MESSAGE });
      finishChat();
      return;
    }
    // 上游请求的 AbortController：客户端断开（res close）→ 中止生成，避免白烧 token。
    // finishChat 幂等，连接关闭后的收尾仍由它统一负责（与 agent 路径同一收尾出口）。
    const appAbort = new AbortController();
    res.on('close', () => {
      try {
        appAbort.abort();
      } catch {}
    });
    srvlog(`chat 应用模式 ${taskId} model=${appModel} search=${body.search === true} think=${body.think === true}`);
    // 历史裁剪：服务端工具路径只发文本消息（tool/system/附件数组一律不进 Messages 请求）。
    const appMessages = buildAppMessages(session.messages, userMessage, { maxTurns: 8 });
    const r = await streamAppChat({
      baseUrl: appBaseUrl,
      apiKey: appApiKey,
      model: appModel,
      // 不传 agent 的系统提示：它描述的是客户端工具（本路径没有这些工具，服务端工具与它们互斥）；
      // 与 `mingdao app` 命令同一口径（CLI 也不传 system）。
      system: '',
      messages: appMessages,
      thinking: body.think === true,
      search: body.search === true,
      // 默认值与 config.DEFAULT_APP_API 一致：readUrl/title 默认开，safetyLevel 默认 high。
      readUrl: appCfg.readUrl !== false,
      safetyLevel: appCfg.safetyLevel || 'high',
      title: appCfg.title !== false,
      onDelta: (/** @type {any} */ d) => {
        const f = appFrameOf(d);
        if (f) send(f);
      },
      signal: appAbort.signal,
    });
    if (r.ok) {
      // 成功才把「user + assistant」两条落进会话（与 agent 路径同一把锁 / 同一个写入口）。
      /** @type {any} */
      const persistUser = { role: 'user', content: built.persistText };
      /** @type {any} */
      const persistAssistant = { role: 'assistant', content: r.text || '' };
      await withSessionLock(session.file, () => appendMessages(session.file, [persistUser, persistAssistant]));
      // 应用接口在一次请求里顺带返回会话标题：只在会话还是「默认时间戳名」时采用，
      // 绝不覆盖用户自己起的名字（与 Web 自动标题共用 renameSessionFile）。
      if (r.title && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(path.basename(session.file))) {
        try {
          const oldName = path.basename(session.file);
          const renamed = renameSessionFile(fs, path, home, session, r.title);
          if (renamed) {
            await moveSessionWorkspace(oldName, path.basename(renamed));
            claimSessionKey(session.file); // 忙锁键随改名迁移（否则新文件名发起的回合不判「忙」）
          }
        } catch {}
      }
      entry.status = 'done';
      entry.durationMs = Date.now() - entry.startedAt;
      srvlog('chat 应用模式完成 ' + taskId + ' text=' + String(r.text || '').length + ' ' + entry.durationMs + 'ms');
      send({
        type: 'done',
        ok: true,
        session: path.basename(session.file),
        text: r.text || '',
        usage: r.usage,
        durationMs: entry.durationMs,
      });
      finishChat();
      return;
    }
    // 失败：正文/思考已经通过 onDelta 发完（先发完再报错），这里只补一条错误；
    // prefix='' 表示沿用 streamAppChat 的错误原文（不加「对话失败：」前缀，与 CLI 输出同款）。
    finishChat(chatFailure(r.error || '应用模式请求失败', ''));
  } catch (/** @type {any} */ err) {
    // 未预期异常：仍走唯一收尾出口（置 failed / 发 error / 释放 claim / 结束响应）。
    finishChat(err);
  }
}
