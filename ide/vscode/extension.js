// MingDao VS Code 深度集成：
//  - 侧边栏 Webview 面板内嵌 WebUI（iframe + CSP），复用全部前端资产
//  - 服务器按需自动启动（面板打开或命令调用时），关闭 VS Code 可自动停止
//  - 选中代码右键「MingDao: 发送选中代码」→ 草稿进入 WebUI 输入框
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
const vscode = require('vscode');
const http = require('http');
const { spawn } = require('child_process');
const path = require('node:path');

let serverProc = null;

function port() {
  return vscode.workspace.getConfiguration('mingdao').get('port', 3820);
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

function health(cb) {
  const req = http.get(base() + '/api/state', (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on('error', () => cb(false));
  req.setTimeout(1200, () => {
    req.destroy();
    cb(false);
  });
}

function ensureServer() {
  return new Promise((resolve) => {
    health((ok) => {
      if (ok) return resolve(true);
      if (serverProc) return resolve(false);
      // shell: false（显式）：参数以数组传递，永不经过 shell 解析
      const child = spawn(bin(), ['web', String(port())], { stdio: 'ignore', shell: false });
      serverProc = child;
      child.on('error', () => {
        serverProc = null;
        resolve(false);
      });
      child.on('exit', () => {
        serverProc = null;
      });
      let tries = 0;
      const iv = setInterval(() => {
        tries += 1;
        health((ready) => {
          if (ready) {
            clearInterval(iv);
            resolve(true);
          } else if (tries >= 15) {
            clearInterval(iv);
            resolve(false);
          }
        });
      }, 400);
    });
  });
}

function sendDraft(text) {
  return new Promise((resolve) => {
    const req = http.request(
      base() + '/api/draft',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.end(JSON.stringify({ text }));
  });
}

async function openPanel() {
  await vscode.commands.executeCommand('mingdao.chatView.focus');
}

async function sendSelection() {
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
  await ensureServer();
  const ok = await sendDraft(text);
  if (ok) {
    await openPanel();
  } else {
    vscode.window.showErrorMessage('发送失败：MingDao 服务器未就绪');
  }
}

function startServerCmd() {
  const terminal = vscode.window.createTerminal('MingDao');
  terminal.show();
  terminal.sendText(`${bin()} web ${port()}`);
}

async function openWebUI() {
  const ok = await ensureServer();
  if (ok) vscode.env.openExternal(vscode.Uri.parse(base()));
  else vscode.window.showWarningMessage('服务器启动失败，请运行「MingDao: 启动服务器（终端）」查看日志');
}

class ChatViewProvider {
  resolveWebviewView(view) {
    view.webview.options = { enableScripts: false };
    view.webview.html = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${base()} http://localhost:* http://127.0.0.1:*;">
<style>html,body{margin:0;padding:0;height:100%}iframe{border:none;width:100%;height:100%}</style>
</head><body><iframe src="${base()}/"></iframe></body></html>`;
    ensureServer();
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mingdao.openWebUI', openWebUI),
    vscode.commands.registerCommand('mingdao.startServer', startServerCmd),
    vscode.commands.registerCommand('mingdao.sendSelection', sendSelection),
    vscode.window.registerWebviewViewProvider(
      'mingdao.chatView',
      new ChatViewProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

function deactivate() {
  if (serverProc && vscode.workspace.getConfiguration('mingdao').get('autoStopServer', true)) {
    try {
      serverProc.kill('SIGTERM');
    } catch {}
    serverProc = null;
  }
}

module.exports = { activate, deactivate };
