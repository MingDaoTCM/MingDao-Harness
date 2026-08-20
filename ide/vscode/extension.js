// MingDao VS Code 深度集成：
//  - 侧边栏 Webview 面板内嵌 WebUI（iframe + CSP），复用全部前端资产
//  - 服务器按需自动启动（面板打开或命令调用时），关闭 VS Code 可自动停止
//  - 选中代码右键「MingDao: 发送选中代码」→ 草稿进入 WebUI 输入框
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
const vscode = require('vscode');
const http = require('http');
const { spawn } = require('child_process');

let serverProc = null;

function port() {
  return vscode.workspace.getConfiguration('mingdao').get('port', 3820);
}
function bin() {
  return vscode.workspace.getConfiguration('mingdao').get('binary', 'mingdao');
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
      const child = spawn(bin(), ['web', String(port())], { stdio: 'ignore' });
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
