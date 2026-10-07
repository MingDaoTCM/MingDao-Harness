# MingDao VS Code 插件

把 MingDao 的 WebUI 带入 VS Code：一键启动服务器、一键在浏览器打开，以及选中代码右键「发送给 MingDao」。

> v0.4.7 修正：此前写「在路线图中」，但侧边栏内嵌面板与「发送选中代码」都已交付；
> 其中「发送选中代码」在本版修好了一个真实缺陷——扩展把草稿写进全局槽，而 WebUI 只在页面
> 初始化时按会话槽读取一次，导致代码始终没进输入框（现改为窗口重新获得焦点时兜底读全局槽）。

## 安装

前提：已安装 `mingdao-harness`（`mingdao` / `mdh` 命令可用）。

```bash
mkdir -p ~/.vscode/extensions/mingdao-vscode
cp -r ide/vscode/. ~/.vscode/extensions/mingdao-vscode/
# 重启 VS Code 或执行「Developer: Reload Window」
```

Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\.vscode\extensions\mingdao-vscode | Out-Null
Copy-Item ide\vscode\* $env:USERPROFILE\.vscode\extensions\mingdao-vscode\ -Recurse
```

## 使用

- 命令面板（Ctrl+Shift+P）→ **MingDao: 打开 WebUI**：探测本地服务器，未启动则提示一键启动，然后浏览器打开
- **MingDao: 启动服务器（终端）**：在集成终端中运行 `mingdao web`，日志可见
- **MingDao: 设置访问令牌** / **MingDao: 清除访问令牌**：写入/清除 VS Code 加密存储里的访问令牌（见下）
- 设置（settings.json）：`mingdao.port`（默认 3820）、`mingdao.binary`（默认 `mingdao`，可用 `mdh`）

## 访问令牌（v0.6.11，报告 K-9）

`mingdao web --auth-token <令牌>`（或 `MINGDAO_WEB_TOKEN` / `config.json` 的 `web.token`）会开启访问令牌，
此后**每个 `/api` 请求都要带令牌**。插件的处理方式：

- **令牌只存在 VS Code 的加密存储（`context.secrets` / SecretStorage）里**，用命令
  「**MingDao: 设置访问令牌**」写入。插件**不再从 settings 读令牌**。
- 为什么不能放 settings：`package.json` 里 `mingdao.*` 未声明 `scope` 时默认是 `window`，
  **工作区级可覆盖**，而工作区级设置来自**被打开仓库**里的 `.vscode/settings.json`。
  实测（探针 `/tmp/probe-ide-token.mjs`）：仓库写 `"mingdao.token": "repo-supplied-token"` 后，
  `getConfiguration('mingdao').get('token')` **对 package.json 里根本没声明的键也照样返回工作区值**。
  把「访问本机 WebUI 的凭据」放在那里，等于把凭据交给仓库。
- **`mingdao.token` 已弃用**（`package.json` 里标了 `deprecationMessage`，`scope=application`，
  因此**不能被工作区覆盖**）。若旧值写在**用户级** settings.json 里，插件启动时会**一次性迁移**进
  SecretStorage 并**清空该设置**，然后提示「已迁移」；写在**工作区级**的旧值一律**忽略**（只提示），
  不迁移也不改动仓库自己的文件。
- 令牌会随请求以 `X-MingDao-Token` 头发给 `127.0.0.1`，并拼进内嵌 WebUI 的 `?token=`（SPA 读进
  sessionStorage 后从地址栏移除，见 `src/web/app.js`）。

### 探测三态：401 与「连不上」不再是一句话

修前 `health()` 只看 `statusCode === 200`，于是「令牌错（401）」与「服务没起（ECONNREFUSED）」
是同一句提示——插件还会**去启动第二个注定失败的服务**（实测探针：401 时 `spawn` 次数 = 1），
然后加载公开的壳页面，每个 `/api` 都 401，界面空白且不报错。现在分成三态
（判定是纯函数 `probe.js` 的 `classifyProbe`，可单测）：

| 探测结果 | 状态 | 用户看到的下一步 |
| --- | --- | --- |
| HTTP 2xx | `ok` | 继续（加载 WebUI / 发送草稿） |
| HTTP 401 / 403 | `unauthorized` | 「令牌无效或已过期（HTTP 401）——请重新输入：命令面板 →「MingDao: 设置访问令牌」」，**且不会去启动第二个服务** |
| 连接被拒 / 超时 / 其它状态码 | `unreachable` | 连不上：「服务未启动？运行 `mingdao web`，或命令「MingDao: 启动服务器（终端）」」；若服务**有响应**但状态码异常（如 500）则提示查看服务端日志，不再说「服务未启动」 |

## 说明

- 本插件通过 HTTP 与本地 WebUI 协作，模型、权限、MCP、技能等全部沿用 `~/.mingdao` 配置
- 首次使用前运行 `mingdao init` 完成配置
- **未验证边界**：本仓的 CI 里没有 VS Code 测试宿主，插件代码靠 `test/smoke.js` §134 用**桩 vscode 模块**
  + 真实本地 HTTP 做行为断言（迁移、三态、端口注入、请求头），**没有**在真实 VS Code 里跑过端到端；
  真机验证需要 `code --extensionDevelopmentPath=ide/vscode`。
