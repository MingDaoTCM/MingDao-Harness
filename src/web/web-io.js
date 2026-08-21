// WebUI 的 io 适配器：把 Agent 核心使用的 io 接口事件翻译为 SSE 事件（由 server.js 推送）。
// 权限确认/选择类交互通过 askHandler 转发到浏览器模态框，等待 POST /api/permission 应答。

import { estimateCostLabel } from '../pricing.js';

export function createWebIO({ send, askHandler, setAbortHandler }) {
  const io = {
    isTTY: false,
    showReasoning: true,
    _pending: null,
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
    box(title, lines) {
      send({ type: 'banner', title, lines });
    },
    // 每轮生成开始/结束：前端据此显示持续的「正在思考…」动态指示
    beginTurn() {},
    endTurn() {},
    startSpinner() {
      if (!io._turnActive) {
        io._turnActive = true;
        send({ type: 'turnStart' });
      }
    },
    stopSpinner() {
      io._turnActive = false;
    },
    writeText(t) {
      send({ type: 'text', delta: String(t) });
    },
    writeReasoning(t) {
      if (!io.showReasoning) return;
      send({ type: 'reasoning', delta: String(t) });
    },
    printCodeBlock(code, lang) {
      send({ type: 'code', code, lang });
    },
    renderTool(name, args, result, durationMs) {
      send({ type: 'tool', name, args, result, durationMs, seq: io._toolSeq });
    },
    // 工具开始执行：前端先渲染带旋转状态的卡片，完成后原地更新（seq 配对）
    renderToolStart(name, args) {
      io._toolSeq = (io._toolSeq || 0) + 1;
      send({ type: 'toolStart', name, args, seq: io._toolSeq });
    },
    renderToolDenied(name, args) {
      send({ type: 'toolDenied', name, args });
    },
    renderTodo(todos) {
      send({ type: 'todo', todos });
    },
    printUsageLine({ modelName, usage, durationMs }) {
      send({
        type: 'usage',
        modelName,
        usage,
        durationMs,
        cost: estimateCostLabel(modelName, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, usage),
      });
    },
    onSigint(fn) {
      if (setAbortHandler) setAbortHandler(fn);
      return () => {
        if (setAbortHandler) setAbortHandler(null);
      };
    },
    ask(question, opts = {}) {
      return askHandler({ question, hidden: Boolean(opts.hidden) });
    },
    async askMultiline(prompt) {
      return askHandler({ question: prompt });
    },
    async confirm(question) {
      const a = await askHandler({ question: question + ' ', confirm: true });
      return /^y(es)?$/i.test(String(a));
    },
    async choose(label, options) {
      return askHandler({ label, options });
    },
    close() {},
  };
  return io;
}
