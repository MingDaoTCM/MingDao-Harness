// MingDao VS Code 深度集成：
//  - 侧边栏 Webview 面板内嵌 WebUI（iframe + CSP），复用全部前端资产
//  - 服务器按需自动启动（面板打开或命令调用时），关闭 VS Code 可自动停止
//  - 选中代码右键「MingDao: 发送选中代码」→ 草稿进入 WebUI 输入框
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
//
// v0.6.11（第三方 v0.6.7 报告 **K-9** / §5.2 主线 B）：两件事一起做。
//
// ① **令牌存 `context.secrets`（SecretStorage，IDE 自己的加密存储），不再从 settings 读。**
//    先复现（探针 /tmp/probe-ide-token.mjs，2026-10-07，桩 vscode 模块 + 本机真实 HTTP 假 WebUI）：
//      · `ide/vscode/package.json` 的 `configuration.properties` 里**一个 `scope` 都没声明** ——
//        VS Code 的默认 scope 是 `window`，即**工作区级可覆盖**，而工作区级设置来自被打开仓库里的
//        `.vscode/settings.json`（K-2 已因此修过 `mingdao.binary`）；
//      · `getConfiguration('mingdao').get('token')` 对 **package.json 里根本没声明** 的键也照样返回
//        工作区值（探针实测拿到 "repo-supplied-token"），`inspect('token')` 同时给出
//        `workspaceValue` 与用户级 `globalValue`。
//    结论（如实写清，别把话说大）：
//      · 「工作区级设置可被被打开的仓库写入」**成立**，且 `get()`/`inspect()` 都会返回它；
//      · 但「本插件此前从 settings 读令牌并当凭据用」**复现不了**：本文件里 `token` 出现 0 次，
//        全历史 `git log --all -S token -- ide/` 为空 —— 修前的问题是**根本没有令牌支持**
//        （K-9 原话：插件"对令牌失明"），不是"把工作区里的令牌当成了凭据"。
//        所以这里的令牌存储是**新增面**；下面的"旧设置迁移"是对"用户手写过 `mingdao.token`"的
//        **防御性覆盖**，不是迁移真实存在的旧功能，也没有真实用户数据被迁移过。
//      · 同一机制下确实有一条**活的**注入面：`mingdao.port` 的工作区值此前直达
//        `terminal.sendText()`（探针实测 `sendText = "mingdao web 1; touch /tmp/pwned-by-repo #"`），
//        与 K-2 同类 —— 本版一并按"数值化"收口（见 port()）。
// ② **探测分三态**（ok / unauthorized / unreachable），提示各自指出下一步：
//    401/403 说"令牌无效或已过期，请重新输入"，连不上说"服务未启动？运行 `mingdao web`"。
//    判定与文案在 `./probe.js` 的纯函数里（可行为测试），本文件只做 IO 与呈现。
const vscode = require('vscode');
const http = require('http');
const { spawn } = require('child_process');
const path = require('node:path');
const { classifyProbe, probeAdvice } = require('./probe.js');

/** SecretStorage 的键（不属于任何 settings 文件，不随工作区/同步走） */
const SECRET_KEY = 'mingdao.webToken';
/** 旧写法：settings.json 里的 `mingdao.token`。只用于**一次性迁移**，绝不作为取令牌的正常路径 */
const LEGACY_SETTING = 'token';
const PROBE_TIMEOUT_MS = 1200;

let serverProc = null;
/** activate 时记下扩展上下文（SecretStorage 在它上面）；显式传参优先，便于测试注入 */
let extContext = null;

/**
 * WebUI 端口。
 *
 * v0.6.11：**必须数值化**。这个值会被 `startServerCmd()` 拼进集成终端的命令行字符串，而
 * `getConfiguration('mingdao').get('port')` 会返回**工作区级**的值（见文件头①的实测）：
 * 仓库只要写
 *   { "mingdao.port": "1; touch /tmp/pwned #" }
 * 用户点一次「MingDao: 启动服务器（终端）」就在自己的终端里执行了仓库给的命令（K-2 同类）。
 * `package.json` 里的 `"type": "number"` 只是**声明式校验**（设置界面上的提示），不是边界
 * —— 插件必须自己收口：这里只接受 1–65535 的整数，其余一律回退默认端口并明确告知用户。
 */
function port() {
  const raw = vscode.workspace.getConfiguration('mingdao').get('port', 3820);
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n >= 1 && n <= 65535 && !Array.isArray(raw)) return n;
  vscode.window.showWarningMessage('MingDao: 已忽略非法的 mingdao.port（须为 1-65535 的整数），改用 3820。');
  return 3820;
}

function bin() {
  // v0.6.8（报告一 K-2，**高**）：**只读用户级（全局）设置**。
  //
  // 此前是 `get('binary', 'mingdao')` —— 它会返回**工作区级**的值，而工作区级设置来自
  // 被打开仓库里的 `.vscode/settings.json`：恶意仓库只要写上
  //   { "mingdao.binary": "./payload.sh" }
  // 用户在仓库里点一次「启动 MingDao 服务」就执行了仓库自带的任意程序（RCE）。
  // 这里 `inspect()` 只取 `globalValue`（用户自己设置的值），工作区/远程值一律忽略。
  const cfg = vscode.workspace.getConfiguration('mingdao');
  const g = cfg.inspect ? cfg.inspect('binary') : null;
  const v = (g && g.globalValue) || 'mingdao';
  const s = String(v).trim();
  if (!s) return 'mingdao';
  // 明确拒绝在工作区目录内执行相对路径程序（正常用户只会写 'mingdao' 或绝对路径）
  if (!path.isAbsolute(s) && s !== 'mingdao' && /[\\/]/.test(s)) {
    vscode.window.showWarningMessage('MingDao: 已忽略工作区内的相对 binary 设置（安全策略），改用 mingdao。');
    return 'mingdao';
  }
  return s;
}

function base() {
  return `http://127.0.0.1:${port()}`;
}

/**
 * 取令牌：**只**从 `context.secrets`（SecretStorage）读，**绝不**从 settings 读。
 * 工作区级设置可被被打开的仓库写入（见文件头①），把它当访问本机 WebUI 的凭据等于把凭据交给仓库。
 * @param {any} [context] 扩展上下文（缺省用 activate 记下的那个；测试可注入桩）
 * @returns {Promise<string>}
 */
async function token(context) {
  const ctx = context || extContext;
  if (!ctx || !ctx.secrets || typeof ctx.secrets.get !== 'function') return '';
  try {
    return String((await ctx.secrets.get(SECRET_KEY)) || '').trim();
  } catch {
    return ''; // 凭据库不可用：当作"没有令牌"，让 401 文案把用户引向「设置访问令牌」
  }
}

/** @param {string} tok */
function authHeaders(tok) {
  // 服务端接受 X-MingDao-Token / ?token= / Authorization: Bearer（src/web/server.js:requestToken）
  return tok ? { 'X-MingDao-Token': tok } : {};
}

/**
 * 单次探测：**只**回原始结果 `{ statusCode, error }`，不做任何判定（判定是 probe.js 的纯函数）。
 * @param {string} tok @returns {Promise<{statusCode: number|null, error: any}>}
 */
function fetchProbe(tok) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {{statusCode: number|null, error: any}} */ r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = http.get(base() + '/api/state', { headers: authHeaders(tok) }, (res) => {
      res.resume();
      done({ statusCode: res.statusCode ?? null, error: null });
    });
    req.on('error', (error) => done({ statusCode: null, error }));
    req.setTimeout(PROBE_TIMEOUT_MS, () => {
      req.destroy();
      done({ statusCode: null, error: new Error(`探测超时（${PROBE_TIMEOUT_MS}ms）`) });
    });
  });
}

/**
 * 探测 → 三态 + 可展示的下一步建议。
 * @param {any} [context]
 * @returns {Promise<{state: 'ok'|'unauthorized'|'unreachable', statusCode: number|null, error: any, advice: string}>}
 */
async function probeState(context) {
  const tok = await token(context);
  const info = await fetchProbe(tok);
  const state = classifyProbe(info);
  return { state, statusCode: info.statusCode, error: info.error, advice: probeAdvice(state, info) };
}

/**
 * 确保服务可用。返回 `{ ok, probe }`；**不 ok 时调用方必须把 `probe.advice` 原样呈现给用户**。
 *
 * K-9 的核心行为差异（探针实测过修前会怎样）：
 *   · `unauthorized` → **绝不启动第二个服务**。服务在跑、只是令牌不对，再起一个只会得到
 *     "端口被占用"或另一个同样 401 的实例，并把用户引向"服务没起来"的错误方向；
 *   · `unreachable`  → 才按原路径启动，并把用户引向 `mingdao web`。
 * @param {any} [context]
 */
async function ensureServer(context) {
  const first = await probeState(context);
  if (first.state === 'ok') return { ok: true, probe: first };
  if (first.state === 'unauthorized') return { ok: false, probe: first };
  if (serverProc) return { ok: false, probe: first };
  // shell: false（显式）：参数以数组传递，永不经过 shell 解析
  const child = spawn(bin(), ['web', String(port())], { stdio: 'ignore', shell: false });
  serverProc = child;
  return await new Promise((resolve) => {
    child.on('error', () => {
      serverProc = null;
      resolve({ ok: false, probe: first });
    });
    child.on('exit', () => {
      serverProc = null;
    });
    let tries = 0;
    const iv = setInterval(async () => {
      tries += 1;
      const p = await probeState(context);
      if (p.state === 'ok' || p.state === 'unauthorized' || tries >= 15) {
        clearInterval(iv);
        resolve({ ok: p.state === 'ok', probe: p });
      }
    }, 400);
  });
}

/**
 * 发草稿。返回原始探测形状 + 三态，调用方据此给不同的提示。
 * @param {string} text @param {any} [context]
 */
async function sendDraft(text, context) {
  const tok = await token(context);
  const info = await new Promise((resolve) => {
    let settled = false;
    const done = (/** @type {{statusCode: number|null, error: any}} */ r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const req = http.request(
      base() + '/api/draft',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(tok) } },
      (res) => {
        res.resume();
        done({ statusCode: res.statusCode ?? null, error: null });
      }
    );
    req.on('error', (error) => done({ statusCode: null, error }));
    req.setTimeout(PROBE_TIMEOUT_MS * 2, () => {
      req.destroy();
      done({ statusCode: null, error: new Error('发送超时') });
    });
    req.end(JSON.stringify({ text }));
  });
  return { state: classifyProbe(info), statusCode: info.statusCode, error: info.error };
}

/**
 * WebUI 地址：有令牌时带上 `?token=`。
 * 壳页面（`/`）是公开的，SPA 会把 `?token=` 读进 sessionStorage 并从地址栏移除
 * （见 `src/web/app.js:4-14`）；不带令牌时加载出来的壳每个 /api 都会 401（正是 K-9 的现场）。
 * `encodeURIComponent` 已把引号/尖括号编码，作为 HTML 属性值是安全的。
 * @param {any} [context]
 */
async function webuiUrl(context) {
  const tok = await token(context);
  return tok ? `${base()}/?token=${encodeURIComponent(tok)}` : `${base()}/`;
}

/**
 * 一次性迁移：settings.json 里的旧 `mingdao.token` → SecretStorage，然后**清空该设置**。
 *
 * 只迁移**用户级（global）**的旧值。工作区级值来自被打开仓库的 `.vscode/settings.json`
 * （实测：`get()`/`inspect()` 对未声明的键同样返回工作区值），把它迁进 secrets 等于让仓库
 * 决定此后长期使用的凭据、并把它持久化进用户级加密存储 —— 所以工作区级旧值**不迁移、
 * 不清空**（那是仓库自己的文件），只提示用户"已忽略"。
 * 没有 `inspect()`（无法分辨来源作用域）时**什么都不做**：宁可让用户手动设置一次，
 * 也不冒险把一个可能是仓库给的值存成长期凭据。
 * @param {any} context
 */
async function migrateLegacyToken(context) {
  const cfg = vscode.workspace.getConfiguration('mingdao');
  if (typeof cfg.inspect !== 'function') return;
  const info = cfg.inspect(LEGACY_SETTING);
  const globalValue = String((info && info.globalValue) || '').trim();
  const workspaceValue = (info && (info.workspaceValue || info.workspaceFolderValue)) || null;
  if (workspaceValue) {
    vscode.window.showWarningMessage(
      'MingDao: 已忽略工作区设置里的 mingdao.token（工作区级设置来自被打开的仓库，不能作为访问本机 WebUI 的凭据）。请用命令「MingDao: 设置访问令牌」。'
    );
  }
  if (!globalValue) return;
  const existing = await token(context);
  if (existing) {
    // 加密存储里已有令牌：只清掉旧设置，**不覆盖**用户当前在用的值
    await cfg.update(LEGACY_SETTING, undefined, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      'MingDao: 已清空设置里的 mingdao.token（令牌已存在于 VS Code 加密存储；如需更换请运行「MingDao: 设置访问令牌」）。'
    );
    return;
  }
  await context.secrets.store(SECRET_KEY, globalValue);
  await cfg.update(LEGACY_SETTING, undefined, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(
    'MingDao: 已把设置里的 mingdao.token 迁移进 VS Code 加密存储（SecretStorage）并清空该设置 —— 令牌不再从 settings 读取。'
  );
}

/**
 * 命令：设置访问令牌（存入 SecretStorage）。
 * @param {any} [context]
 */
async function setToken(context) {
  const ctx = context || extContext;
  const entered = await vscode.window.showInputBox({
    title: 'MingDao: 设置访问令牌',
    prompt: '粘贴 mingdao web 的访问令牌（存入 VS Code 加密存储 SecretStorage，不写入任何 settings 文件）',
    password: true,
    ignoreFocusOut: true,
  });
  if (entered === undefined) return; // 用户取消
  const value = String(entered).trim();
  if (!value) {
    await clearToken(ctx);
    return;
  }
  await ctx.secrets.store(SECRET_KEY, value);
  const probe = await probeState(ctx);
  if (probe.state === 'ok') vscode.window.showInformationMessage('MingDao: 令牌已保存，服务探测正常。');
  else vscode.window.showWarningMessage(`MingDao: 令牌已保存，但${probe.advice}`);
}

/**
 * 命令：清除访问令牌。
 * @param {any} [context]
 */
async function clearToken(context) {
  const ctx = context || extContext;
  await ctx.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage('MingDao: 已清除 VS Code 加密存储里的访问令牌。');
}

async function openPanel() {
  await vscode.commands.executeCommand('mingdao.chatView.focus');
}

/** @param {any} [context] */
async function sendSelection(context) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('没有打开的编辑器');
    return;
  }
  const text = editor.document.getText(editor.selection);
  if (!text) {
    vscode.window.showInformationMessage('先选中代码再发送');
    return;
  }
  const ready = await ensureServer(context);
  if (!ready.ok) {
    vscode.window.showWarningMessage(`MingDao: ${ready.probe.advice}`);
    return;
  }
  const res = await sendDraft(text, context);
  if (res.state === 'ok') {
    await openPanel();
    return;
  }
  // 发送这一步的失败：三态与探测同口径（401 说令牌、连不上说 mingdao web）
  vscode.window.showErrorMessage(`MingDao: 发送选中代码失败 —— ${probeAdvice(res.state, res)}`);
}

function startServerCmd() {
  const terminal = vscode.window.createTerminal('MingDao');
  terminal.show();
  terminal.sendText(`${bin()} web ${port()}`);
}

/** @param {any} [context] */
async function openWebUI(context) {
  const ready = await ensureServer(context);
  if (ready.ok) {
    vscode.env.openExternal(vscode.Uri.parse(await webuiUrl(context)));
    return;
  }
  vscode.window.showWarningMessage(`MingDao: ${ready.probe.advice}`);
}

class ChatViewProvider {
  /** @param {any} context */
  constructor(context) {
    this.context = context;
  }
  /** @param {any} view */
  async resolveWebviewView(view) {
    const url = await webuiUrl(this.context);
    view.webview.options = { enableScripts: false };
    view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${base()} http://localhost:* http://127.0.0.1:*;">
<style>html,body{margin:0;padding:0;height:100%}iframe{border:none;width:100%;height:100%}</style>
</head><body><iframe src="${url}"></iframe></body></html>`;
    ensureServer(this.context);
  }
}

/** @param {any} context */
function activate(context) {
  extContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand('mingdao.openWebUI', () => openWebUI(context)),
    vscode.commands.registerCommand('mingdao.startServer', startServerCmd),
    vscode.commands.registerCommand('mingdao.sendSelection', () => sendSelection(context)),
    vscode.commands.registerCommand('mingdao.setToken', () => setToken(context)),
    vscode.commands.registerCommand('mingdao.clearToken', () => clearToken(context)),
    vscode.window.registerWebviewViewProvider(
      'mingdao.chatView',
      new ChatViewProvider(context),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  // 一次性迁移：异步、失败不影响激活（失败时下次激活会重试，因为旧设置没被清掉）
  migrateLegacyToken(context).catch(() => {});
}

function deactivate() {
  // 只有显式 false 才保留服务器：非布尔值（工作区可写）一律按"停掉"处理（安全默认）
  if (serverProc && vscode.workspace.getConfiguration('mingdao').get('autoStopServer', true) !== false) {
    try {
      serverProc.kill('SIGTERM');
    } catch {}
    serverProc = null;
  }
}

module.exports = { activate, deactivate };
// 仅供 test/smoke.js §134 用**桩 vscode 模块**加载后做行为断言（不属于扩展 API）。
module.exports.__test = {
  SECRET_KEY,
  LEGACY_SETTING,
  port,
  bin,
  base,
  token,
  probeState,
  ensureServer,
  sendDraft,
  webuiUrl,
  migrateLegacyToken,
  setToken,
  clearToken,
  classifyProbe,
};
