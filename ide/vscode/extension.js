// MingDao VS Code 插件：启动 WebUI 服务器（复用终端）并一键在浏览器打开。
// 前置：已安装 mingdao-harness（npm install -g . 或 bash install.sh）。
// 安装本插件：把 ide/vscode 目录复制到 ~/.vscode/extensions/mingdao-vscode 后重启 VS Code。
const vscode = require('vscode');
const http = require('http');

function cfg() {
  return vscode.workspace.getConfiguration('mingdao');
}

function url() {
  return `http://127.0.0.1:${cfg().get('port', 3820)}`;
}

function startServer() {
  const bin = cfg().get('binary', 'mingdao');
  const terminal = vscode.window.createTerminal('MingDao');
  terminal.show();
  terminal.sendText(`${bin} web ${cfg().get('port', 3820)}`);
}

function openWebUI() {
  const u = url();
  const probe = http.get(u + '/api/state', (res) => {
    res.resume();
    if (res.statusCode === 200) {
      vscode.env.openExternal(vscode.Uri.parse(u));
    } else {
      vscode.window.showWarningMessage(`MingDao 服务器响应异常（HTTP ${res.statusCode}），请先执行「MingDao: 启动服务器」。`);
    }
  });
  probe.on('error', () => {
    vscode.window
      .showInformationMessage('MingDao 服务器未运行，是否启动？', '启动')
      .then((choice) => {
        if (choice === '启动') startServer();
      });
  });
  probe.setTimeout(1500, () => {
    probe.destroy();
    vscode.window.showWarningMessage('端口探测超时：请在终端执行 mingdao web 查看状态');
  });
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mingdao.openWebUI', openWebUI),
    vscode.commands.registerCommand('mingdao.startServer', startServer)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
