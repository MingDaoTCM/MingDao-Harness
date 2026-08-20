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
    beginTurn() {},
    endTurn() {},
    startSpinner() {},
    stopSpinner() {},
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
      send({ type: 'tool', name, args, result, durationMs });
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
        cost: estimateCostLabel(modelName, usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0),
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
