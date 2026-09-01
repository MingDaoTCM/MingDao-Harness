// WebUI 的 io 适配器：把 Agent 核心使用的 io 接口事件翻译为 SSE 事件（由 server.js 推送）。
// 权限确认/选择类交互通过 askHandler 转发到浏览器模态框，等待 POST /api/permission 应答。

import { estimateCostLabel } from '../pricing.js';

/**
 * @param {{ send: any, askHandler: any, setAbortHandler: any }} param0
 */
export function createWebIO({ send, askHandler, setAbortHandler }) {
  const io = {
    isTTY: false,
    showReasoning: true,
    _pending: null,
    _toolCount: 0,
    _taskCount: 0, // 子代理（task 工具）次数：进度心跳与轨迹面板用
    _deliverables: /** @type {any[]} */ ([]),
    _activeTools: /** @type {any[]} */ ([]), // {seq, key}：并行批次下 toolStart↔tool 按 name+args 配对（审计 P2-7）
    // 交付物与步数统计：写/编辑成功的文件路径（去重）
    stats() {
      return { toolCount: io._toolCount, taskCount: io._taskCount, deliverables: [...new Set(io._deliverables)] };
    },
    /** @param {any} v */
    setShowReasoning(v) {
      io.showReasoning = !!v;
    },
    ensureRl() {
      throw new Error('Web 模式没有终端输入流');
    },
    setHistory() {},
    print(text = '') {
      send({ type: 'banner', text });
    },
    /**
     * @param {any} title
     * @param {any} lines
     */
    box(title, lines) {
      send({ type: 'banner', title, lines });
    },
    // 每轮生成开始/结束：前端据此显示持续的「正在思考…」动态指示
    // 审计（阶段切换静默）：turnStart 带累计工具步数；stopSpinner 在回合真正结束时
    // 发 turnEnd——客户端据此显示「第 N 回合完成，进入下一回合…」，阶段边界不再静默
    beginTurn() {},
    endTurn() {},
    startSpinner() {
      if (!/** @type {any} */ (io)._turnActive) {
        /** @type {any} */ (io)._turnActive = true;
        send({ type: 'turnStart', toolSteps: io._toolCount });
      }
    },
    stopSpinner() {
      if (/** @type {any} */ (io)._turnActive) {
        /** @type {any} */ (io)._turnActive = false;
        send({ type: 'turnEnd', toolSteps: io._toolCount });
      }
    },
    /** @param {any} t */
    writeText(t) {
      send({ type: 'text', delta: String(t) });
    },
    /** @param {any} t */
    writeReasoning(t) {
      if (!io.showReasoning) return;
      send({ type: 'reasoning', delta: String(t) });
    },
    /**
     * @param {any} code
     * @param {any} lang
     */
    printCodeBlock(code, lang) {
      send({ type: 'code', code, lang });
    },
    /**
     * @param {any} name
     * @param {any} args
     * @param {any} result
     * @param {any} durationMs
     */
    renderTool(name, args, result, durationMs) {
      io._toolCount += 1;
      if (name === 'task') io._taskCount += 1;
      if ((name === 'write' || name === 'edit') && args?.path && result && result.ok !== false) {
        io._deliverables.push(String(args.path));
      }
      // 审计 P2-7：按 name+args 找回 toolStart 的 seq（并行批次下各卡片配对正确）
      const key = name + ':' + JSON.stringify(args || {});
      const idx = io._activeTools.findIndex((/** @type {any} */ a) => a.key === key);
      const seq = idx !== -1 ? io._activeTools.splice(idx, 1)[0].seq : (/** @type {any} */ (io)._toolSeq || 0) + 1;
      send({ type: 'tool', name, args, result, durationMs, seq });
    },
    // 工具开始执行：前端先渲染带旋转状态的卡片，完成后原地更新（seq 配对）
    /**
     * @param {any} name
     * @param {any} args
     */
    renderToolStart(name, args) {
      /** @type {any} */ (io)._toolSeq = (/** @type {any} */ (io)._toolSeq || 0) + 1;
      io._activeTools.push({ seq: /** @type {any} */ (io)._toolSeq, key: name + ':' + JSON.stringify(args || {}) });
      send({ type: 'toolStart', name, args, seq: /** @type {any} */ (io)._toolSeq });
    },
    /**
     * @param {any} name
     * @param {any} args
     * @param {any} reason
     */
    renderToolDenied(name, args, reason) {
      // 质检 L2：被拒的 toolStart 也要从 _activeTools 移除——否则条目无界增长、
      // 且后续同名同参工具可能 findIndex 命中陈旧 seq 导致卡片配对错位
      const key = name + ':' + JSON.stringify(args || {});
      const idx = io._activeTools.findIndex((a) => a.key === key);
      if (idx !== -1) io._activeTools.splice(idx, 1);
      send({ type: 'toolDenied', name, args, reason: reason || '未授权' });
    },
    /** @param {any} todos */
    renderTodo(todos) {
      send({ type: 'todo', todos });
    },
    /** @param {{ modelName: any, usage: any, durationMs: any }} param0 */
    printUsageLine({ modelName, usage, durationMs }) {
      send({
        type: 'usage',
        modelName,
        usage,
        durationMs,
        cost: estimateCostLabel(modelName, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, usage),
      });
    },
    /** @param {any} fn */
    onSigint(fn) {
      if (setAbortHandler) setAbortHandler(fn);
      return () => {
        if (setAbortHandler) setAbortHandler(null);
      };
    },
    /**
     * @param {any} question
     * @param {any} opts
     */
    ask(question, opts = {}) {
      return askHandler({ question, hidden: Boolean(opts.hidden) });
    },
    /** @param {any} prompt */
    async askMultiline(prompt) {
      return askHandler({ question: prompt });
    },
    /** @param {any} question */
    async confirm(question) {
      const a = await askHandler({ question: question + ' ', confirm: true });
      return /^y(es)?$/i.test(String(a));
    },
    /**
     * @param {any} label
     * @param {any} options
     */
    async choose(label, options) {
      return askHandler({ label, options });
    },
    close() {},
  };
  return io;
}
