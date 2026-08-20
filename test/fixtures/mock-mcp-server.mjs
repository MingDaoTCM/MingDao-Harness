#!/usr/bin/env node
// 测试用最小 MCP 服务器：stdio + NDJSON JSON-RPC 2.0
// 工具：echo（写）、readonly_peek（只读标注）
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: '回显输入文本',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
            {
              name: 'readonly_peek',
              description: '只读查看',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    } else if (msg.method === 'tools/call') {
      const text = msg.params?.arguments?.text || '';
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'echo:' + text }] },
      });
    } else if (msg.method === 'notifications/initialized') {
      // 客户端通知，忽略
    } else {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
