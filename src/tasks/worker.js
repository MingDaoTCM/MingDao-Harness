// 后台任务 worker（Phase C C2）：独立进程执行一轮任务并写状态文件。
// 由 cli.js 的内部入口 `mingdao run-worker <id> ...` 启动（startTask 拉起的子进程）。
// 无交互：ask 权限降级 readonly；支持避峰顺延、MCP、自动标题、费用入账、完成通知与自动同步。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ensureHome } from '../config.js';
import { createProvider, resolveProviderConfig, helperProvider } from '../providers/index.js';
import { startMcpServers } from '../mcp.js';
import { patchTask } from '../tasks.js';
import { notifyTaskDone } from '../notify.js';
import { createAgent } from '../agent.js';
import { createPermission } from '../permissions.js';
import { buildSystemPrompt } from '../prompts.js';
import { createSession, appendMessages, rewriteSession } from '../session.js';
import { recordUsage } from '../cachestats.js';
import { maybeAutoSync } from '../sync.js';
import { isPeakHour, deferToOffpeak } from '../pricing.js';
import { createIO } from '../ui.js';
import { generateTitle, renameSessionFile, titleModel } from '../titles.js';

/**
 * 执行一轮后台任务：加载配置 → 建 agent → 跑回合 → 回写状态文件。
 * @param {string} id 任务 id
 * @param {string} question 任务内容
 * @param {{permission?: any, model?: any, offpeak?: any}} opts
 */
export async function runWorkerTask(id, question, { permission, model, offpeak }) {
  const home = ensureHome();
  const finish = (/** @type {any} */ patch) => patchTask(home, id, patch);
  let mcpFacade = null;
  let cfg = null; // 提到 try 外：catch 分支也要读 cfg.notify
  try {
    cfg = loadConfig();
    if (!cfg) throw new Error('未初始化配置，请先运行 mingdao init');
    const modelName = model || cfg.model || 'deepseek-v4-flash';
    const pc = resolveProviderConfig(cfg, modelName);
    if (!pc.apiKey) throw new Error(`模型 ${modelName} 没有可用 API Key`);
    const workingDir = process.cwd();
    // 后台无交互：ask 权限降级为 readonly 并注明（需要写权限请 mingdao run --permission auto）
    let perm = permission || cfg.permission || 'ask';
    let note = '';
    if (perm === 'ask') {
      perm = 'readonly';
      note = 'ask 权限下后台任务按只读执行';
    }
    // 避峰（评估 A2/Kimi P-1）：高峰时段（北京工作日 9:00–12:00、14:00–18:00）
    // 自动顺延到最近闲时起点（12:00 / 18:00）执行，输入价省 50%
    if (offpeak && isPeakHour(new Date())) {
      const defer = deferToOffpeak(new Date());
      finish({ note: `避峰等待至北京时间 ${defer.toISOString().slice(11, 16)}（闲时起执行，输入价省 50%）` });
      await new Promise((r) => setTimeout(r, defer.getTime() - Date.now() + 2000));
      finish({ note: '' });
    }
    const provider = await createProvider(cfg, modelName);
    const io = createIO({ quiet: true });
    // v0.4.0 契约化：后台任务同样挂载 config.tools 声明式工具（幂等）
    const { mountConfigTools } = await import('../tools/index.js');
    mountConfigTools(cfg);
    const permissionObj = createPermission(perm, io);
    /** @type {any} */
    let mcpManager = null;
    if (cfg.mcpServers && Object.keys(cfg.mcpServers).length) {
      mcpFacade = {
        toolSchemas: () => (mcpManager ? mcpManager.toolSchemas() : []),
        call: (/** @type {any} */ n, /** @type {any} */ a) => (mcpManager ? mcpManager.call(n, a) : Promise.reject(new Error('MCP 未就绪'))),
        isReadonly: (/** @type {any} */ n) => (mcpManager ? mcpManager.isReadonly(n) : false),
        stop: () => {
          if (mcpManager) mcpManager.stop();
        },
      };
      startMcpServers(cfg.mcpServers, workingDir).then((m) => (mcpManager = m)).catch(() => {});
    }
    const sessionRef = /** @type {{name: any}} */ ({ name: null });
    let persistedCount = 0;
    const agent = createAgent({
      provider,
      permission: permissionObj,
      io,
      modelName,
      workingDir,
      cfg,
      mcp: mcpFacade || undefined,
      sessionRef,
      onCompact: (/** @type {any} */ msgs) => {
        rewriteSession(session.file, msgs);
        persistedCount = msgs.length;
      },
    });
    const session = createSession(home);
    sessionRef.name = path.basename(session.file);
    const messages = [
      { role: 'system', content: buildSystemPrompt({ modelName, workingDir }) },
      { role: 'user', content: question },
    ];
    appendMessages(session.file, messages);
    persistedCount = messages.length;
    const t0 = Date.now();
    const res = await agent.runTurn(messages);
    appendMessages(session.file, messages.slice(persistedCount));
    if (cfg.autoTitle !== false && res.text) {
      try {
        const tModel = titleModel(cfg, modelName);
        const title = await generateTitle(await helperProvider(cfg, tModel, provider), tModel, question);
        if (title) renameSessionFile(fs, path, home, session, title);
      } catch {}
    }
    const finalStatus = res.truncated ? 'failed' : res.aborted ? 'killed' : 'done';
    recordUsage(res.perf?.usedModel || modelName, res.usage, /** @type {any} */ (res.perf));
    finish({
      status: finalStatus,
      text: (res.text || '').slice(0, 2000),
      usage: res.usage,
      durationMs: Date.now() - t0,
      session: path.basename(session.file),
      note,
    });
    if (cfg.notify !== false && !process.env.MINGDAO_TASK_QUIET_NOTIFY) notifyTaskDone(question, finalStatus === 'killed' ? 'failed' : finalStatus);
    try {
      await maybeAutoSync();
    } catch {}
    process.exitCode = res.truncated ? 1 : 0;
  } catch (/** @type {any} */ err) {
    finish({ status: 'failed', error: String(err?.message || err) });
    if (cfg?.notify !== false && !process.env.MINGDAO_TASK_QUIET_NOTIFY) notifyTaskDone(question, 'failed');
    process.exitCode = 2;
  } finally {
    if (mcpFacade) mcpFacade.stop();
  }
}
