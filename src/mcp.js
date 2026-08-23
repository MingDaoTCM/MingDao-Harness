// MCP (Model Context Protocol) 客户端 —— 零依赖实现 stdio 传输 + JSON-RPC 2.0。
// 配置（config.json）：
//   "mcpServers": {
//     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
//     "fetch":      { "command": "npx", "args": ["-y", "mcp-server-fetch"] }
//   }
// 工具命名：mcp__<服务器>__<工具>，与内置工具合并后交给模型；/mcp 查看状态。

import fs from 'node:fs';
import { spawn } from 'node:child_process';

// 客户端版本读 package.json（评估 P3-9：此前硬编码 '0.6.0' 与真实版本脱节）
const CLIENT_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const REQUEST_TIMEOUT_MS = 60000;
const HANDSHAKE_TIMEOUT_MS = 20000;

let nextId = 1;

export class McpClient {
  constructor(name, { command, args = [], env = {} }, workingDir) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.workingDir = workingDir;
    this.tools = [];
    this.child = null;
    this.pending = new Map();
    this.buf = '';
    this.ready = false;
    this.error = null;
    this.stderrTail = '';
  }

  async start() {
    if (this.child) return this;
    this.child = spawn(this.command, this.args, {
      cwd: this.workingDir,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // 自成进程组：stop 时整组清理（npx 孙进程不成孤儿）
    });
    this.child.stdout.on('data', (d) => this._onData(d));
    this.child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.child.on('error', (err) => {
      this.error = `启动失败：${err.message}`;
      this._failAll(this.error);
    });
    this.child.on('close', (code) => {
      if (!this.stopped) {
        this.error = this.error || `进程退出（code ${code}）${this.stderrTail ? '：' + this.stderrTail.slice(-300) : ''}`;
        this._failAll(this.error);
      }
    });
    try {
      await this._handshake();
      await this._listTools();
    } catch (err) {
      this.error = String(err?.message || err);
      throw err;
    }
    return this;
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    if (this.buf.length > 20 * 1024 * 1024) {
      // 恶意/异常服务器灌入超量数据：放弃解析，避免内存膨胀
      this.error = this.error || 'MCP 服务器输出超限';
      this.buf = '';
      this.stop();
      return;
    }
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP [${this.name}] ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
      // 通知类消息（如 notifications/*）忽略
    }
  }

  _failAll(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error(`MCP 服务器 ${this.name} 未运行`));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP [${this.name}] 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP [${this.name}] 写入失败：${err.message}`));
      }
    });
  }

  notify(method, params = {}) {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {}
  }

  async _handshake() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP [${this.name}] 握手超时`)), HANDSHAKE_TIMEOUT_MS);
      this.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mingdao', version: CLIENT_VERSION },
      })
        .then(() => {
          this.notify('notifications/initialized');
          this.ready = true;
          clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  async _listTools() {
    const res = await this.request('tools/list', {});
    this.tools = Array.isArray(res?.tools) ? res.tools : [];
  }

  prefixedName(toolName) {
    return `mcp__${this.name}__${toolName}`;
  }

  toolSchemas() {
    return this.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: {
          name: this.prefixedName(t.name),
          description: `[MCP:${this.name}] ${t.description || t.name}`,
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      }));
  }

  isReadonly(toolName) {
    const t = this.tools.find((x) => x.name === toolName);
    return Boolean(t?.annotations?.readOnlyHint);
  }

  async callTool(toolName, args) {
    const res = await this.request('tools/call', { name: toolName, arguments: args });
    if (res?.isError) {
      const text = (res.content || []).map((c) => c.text || '').join('\n');
      return { ok: false, error: text || 'MCP 工具返回错误' };
    }
    let parts = (res?.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}] ${JSON.stringify(c)}`));
    let text = parts.join('\n') || '(无输出)';
    if (text.length > 100 * 1024) text = text.slice(0, 100 * 1024) + `\n…[MCP 输出过长已截断，原文共 ${text.length} 字符]`;
    return { ok: true, output: text };
  }

  stop() {
    this.stopped = true;
    try {
      // 整组清理：npx 等命令拉起的孙进程不成孤儿
      if (this.child?.pid) process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      try {
        this.child?.kill('SIGKILL');
      } catch {}
    }
    this._failAll('MCP 服务器已停止');
  }
}

// 多服务器管理器：部分服务器启动失败不影响其余
export async function startMcpServers(mcpCfg, workingDir) {
  const clients = new Map();
  const entries = Object.entries(mcpCfg || {});
  await Promise.all(
    entries.map(async ([name, cfg]) => {
      if (!cfg || typeof cfg.command !== 'string' || !cfg.command.trim()) return;
      const client = new McpClient(name, cfg, workingDir);
      clients.set(name, client);
      try {
        await client.start();
      } catch (err) {
        client.error = String(err?.message || err);
      }
    })
  );
  // 精确工具名映射：名字含 __ 的服务器/工具也不会被贪婪正则切错
  const managerExact = new Map();
  for (const [serverName, c] of clients) {
    if (c.error) continue;
    for (const t of c.tools || []) {
      if (t?.name) managerExact.set(`mcp__${serverName}__${t.name}`, { server: serverName, tool: t.name });
    }
  }
  const manager = {
    clients,
    toolSchemas() {
      const out = [];
      for (const c of clients.values()) {
        if (!c.error) out.push(...c.toolSchemas());
      }
      return out;
    },
    lookup(prefixedName) {
      const exact = managerExact.get(prefixedName);
      if (exact) {
        const c = clients.get(exact.server);
        if (!c || c.error) return null;
        return { client: c, toolName: exact.tool };
      }
      return null;
    },
    async call(prefixedName, args) {
      const found = this.lookup(prefixedName);
      if (!found) return { ok: false, error: `MCP 工具不可用：${prefixedName}` };
      return found.client.callTool(found.toolName, args);
    },
    isReadonly(prefixedName) {
      const found = this.lookup(prefixedName);
      return found ? found.client.isReadonly(found.toolName) : false;
    },
    status() {
      const rows = [];
      for (const [name, c] of clients) {
        rows.push({
          name,
          ok: !c.error,
          tools: c.tools.length,
          error: c.error || '',
        });
      }
      return rows;
    },
    stop() {
      for (const c of clients.values()) c.stop();
    },
  };
  return manager;
}
