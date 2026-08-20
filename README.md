# MingDao-Harness（明道）

> 开源智能体框架（Agent Harness）。零依赖、开箱即用，**针对 DeepSeek-V4 系列首发优化**，开放主流模型接入。命令：`mingdao`（简写 `mdh`）。

MingDao 在学习了 Claude Code、OpenAI Codex、DeepSeek-Harness、CodeWhale 的架构后设计：一个轻量的「模型循环 + 工具 + 权限」内核，TUI 起步，接口全部开放。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 版本策略

遵循语义化版本（SemVer）且保持克制：**修复 → 末位 +1**（0.2.7 → 0.2.8），**新子系统/大功能 → 中位 +1**（0.2 → 0.3），**首个 npm 稳定发布（API 冻结）→ 1.0.0**。当前 0.2.x 代表「功能活跃、接口可能调整」的诚实状态——不会出现一天一个大版本。

## 特性

- ⚡ **零运行时依赖**：纯 Node.js ≥ 18，无构建步骤，安装即用
- ✨ **产品级 TUI**：流式 Markdown 渲染（标题/列表/引用/代码块语法高亮）、文件编辑 **diff 预览**、bash 退出码徽章、思考过程暗显、生成中动画、**Ctrl+C 中断生成**、`/` 命令 **Tab 补全**、会话历史上下键、token/耗时/**费用估算**状态行（峰谷计价）
- 🤖 **工具调用 Agent 循环**：`read` / `write` / `edit` / `ls` / `glob` / `grep` / `bash` + `skill` / `task` / `todo` / `undo`（11 个工具），流式输出与工具执行交替
- 🧩 **Skills 技能系统**：SKILL.md 渐进式披露（清单注入系统提示，按需加载全文）；**内置 14 个常用技能**，支持用户级 + 项目级 + 内置三级来源与同名覆盖
- 👥 **子代理**：`task` 工具把独立子任务委托给全新上下文子代理并回收汇报
- 🪝 **Hooks 钩子**：PreToolUse（可阻止执行）/ PostToolUse，shell 命令 + JSON stdin/stdout 协议
- 🔌 **MCP 客户端**：零依赖实现 Model Context Protocol（stdio + JSON-RPC），`mcpServers` 配置即接入任意 MCP 服务器（实测官方 `server-everything` 13 个工具），工具并入 Agent 循环、只读标注自动放行、`/mcp` 查看状态
- 📏 **精确 tokenizer**：内置 DeepSeek 官方词表（128k vocab）字节级 BPE 计数，与真实 API 口径偏差 <8%；非 DeepSeek 模型回退启发式估算
- 🖥 **WebUI**：`mingdao web` 一键启动网页界面（零依赖 HTTP+SSE），流式输出、代码高亮、diff 预览、工具卡片、权限确认弹窗、会话切换，复用同一 Agent 核心
- 🥷 **沙箱执行**：bash 工具三档隔离（`off`/`readonly` 全盘只读/`safe` 只读+断网），基于 Linux bubblewrap，不可用环境优雅降级并明示
- 🧭 **自动模型路由**：规划类任务自动切 `deepseek-v4-pro`、执行类走 `deepseek-v4-flash`（启发式+分类器两级判定，子代理固定执行模型），`/route` 一键开关
- 🔎 **会话检索**：`mingdao sessions search <词>` / `/sessions <关键词>` / WebUI 搜索框，全文检索历史会话并返回匹配片段
- 🏷 **会话标题自动生成**：新会话首轮完成后自动生成中文标题并重命名（可 `"autoTitle": false` 关闭）
- 🧵 **多会话并行任务面板**：WebUI 支持最多 8 个并发任务，各自流式输出、独立权限确认与中断，任务面板实时展示状态
- 📲 **PWA**：WebUI 支持「安装到桌面」——浏览器地址栏安装后即可像本地应用一样双击打开
- 🧩 **VS Code 插件**：`ide/vscode/` 一键启动服务器并打开 WebUI（命令面板搜 MingDao）
- 📋 **会话与任务管理**：`--resume` 会话选择器、`/compact` 上下文压缩、`/plan` 计划模式（先计划后执行）、`/init` 生成 AGENTS.md、`/memory` 用户记忆、todo 清单可视化、`undo` 撤销
- 🎯 **DeepSeek-V4 优化**：内置 `deepseek-v4-pro` / `deepseek-v4-flash` 正式版预设（384K 上下文、温度、输出上限、推理内容流式展示），自动重试与超时
- 🔌 **开放模型接入**：内置 DeepSeek / OpenAI / Qwen / GLM / Kimi / 自定义 OpenAI 兼容端点，支持自写 Provider 模块（[docs/PROVIDERS.md](docs/PROVIDERS.md)）
- 🛡 **权限三档**：`ask`（默认，写文件/命令逐次确认）/ `auto` / `readonly`，另支持工具级 `allow`/`deny` 规则
- 🔐 **密钥与配置分离**：API Key 存独立凭证库（权限 600、脱敏管理、`mingdao key` 命令族）；`config.json` 与仓库零密钥，任何人安装后配置自己的 Key
- 💾 **会话持久化**：JSONL 自动保存，`mingdao --continue` 续聊
- 📝 **上下文预算管理**：精确 tokenizer 计数 + 尾部保留裁剪（配对完整性清洗）
- 📋 **AGENTS.md**：自动读取工作目录的 AGENTS.md 注入系统提示（Claude Code / Codex 约定）
- 🧩 **可编程**：核心能力以 ESM 库形式导出（`import { createAgent } from 'mingdao-harness'`）

## 一键安装

### Linux / macOS

```bash
git clone https://github.com/MingDaoTCM/MingDao-Harness.git   # 或下载源码包
cd MingDao-Harness
bash install.sh        # 自动装 Node.js（缺失时）→ 安装 mingdao 命令
```

发布后可一行安装：

```bash
curl -fsSL https://raw.githubusercontent.com/MingDaoTCM/MingDao-Harness/main/install.sh | bash
```

安装脚本会：① 检查 Node.js ≥ 18.17（缺失时通过 nvm 自动安装）→ ② 全局安装 `mingdao` 命令（无管理员权限时自动装到 `~/.local/bin`）→ ③ 给出下一步提示。

### Windows 10 / 11

**一键安装**（推荐给普通用户）：

1. 解压/克隆本项目；
2. **双击 `install.bat`**——脚本会自动通过内置 winget 安装 Node.js（若缺失），然后安装 `mingdao` 命令（安装到用户目录，无需管理员权限）。

或者手动执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 或 PowerShell 内直接：
npm install -g .        # 前提：已装 Node.js 18+
mingdao init
mingdao
```

Windows 平台说明：

- `bash` 工具在 Windows 自动使用 `cmd.exe` 执行（无需安装 Git Bash）；
- 配置/密钥目录：`C:\Users\<你的用户名>\.mingdao\`（`credentials.json` 只属于你的用户目录，勿共享）；
- Windows 的 NTFS 无 POSIX 权限位，密钥文件依靠用户目录 ACL 保护（其他用户默认不可读）；
- 建议使用 Windows Terminal / PowerShell 7 获得最佳彩色显示体验；`npx mingdao-harness` 同样可用。

### 从源码运行（开发）

```bash
git clone <repo> && cd MingDao-Harness
node src/cli.js          # 直接运行，无需安装
npm test                 # node test/smoke.js
```

## WebUI（mingdao web）

```bash
mingdao web          # 默认 http://127.0.0.1:3820
mingdao web 9000     # 指定端口
```

- 浏览器中对话：流式 Markdown 渲染、代码高亮、编辑 diff、工具执行卡片、思考过程折叠、权限确认弹窗（ask 模式）、历史会话切换、生成中断
- 复用同一 Agent 核心与配置（模型/权限/MCP/技能全部生效）；服务器零依赖（node:http + SSE）
- 多设备/远程使用：`"web": {"host": "0.0.0.0", "port": 3820}`（注意端口安全，仅本机使用请保持默认 127.0.0.1）
- **并行任务**：连续发送多条消息即并发执行（上限 8），右上角「任务」打开任务面板查看状态/中断单个任务
- **PWA 安装**：Chrome/Edge 地址栏右侧「安装」图标 → 桌面出现 MingDao 图标，双击即用
- 接口：`GET /api/state`、`POST /api/chat`（SSE）、`POST /api/permission`、`POST /api/abort`、`GET /api/sessions`、`GET /api/tasks`

## IDE 集成（VS Code 插件）

```bash
mkdir -p ~/.vscode/extensions/mingdao-vscode
cp -r ide/vscode/. ~/.vscode/extensions/mingdao-vscode/
```

重启 VS Code 后，命令面板（Ctrl+Shift+P）执行 **MingDao: 打开 WebUI**——自动探测/启动服务器并打开浏览器。详见 `ide/vscode/README.md`。

## 沙箱执行与自动路由

**沙箱**（`"sandbox": "off" | "readonly" | "safe"`，Linux + bubblewrap）：

| 档位 | 文件系统 | 网络 | 适用 |
| --- | --- | --- | --- |
| `off` | 无隔离（默认） | 可用 | 日常使用 |
| `readonly` | 全盘只读，仅 /tmp 可写 | 可用 | 信任度一般的命令 |
| `safe` | 全盘只读 + 工作目录、/tmp 可写 | **断开** | 下载/执行不可信代码、外部工具 |

非 Linux 或未安装 bubblewrap（`apt install bubblewrap` / `dnf install bubblewrap`）时自动降级为 off 并在结果中注明；TUI 横幅与 `/status` 实时显示当前沙箱状态。

**自动路由**（`"routing": {"enabled": true, "planner": "deepseek-v4-pro", "executor": "deepseek-v4-flash"}`）：

- 长文本+规划关键词（设计/架构/重构/审查…）→ 启发式直接路由到 planner；中等长度走 executor 模型做一次极简分类（约几十 token）；短指令直接执行模型
- 子代理（task）固定走 executor——主线程规划、子线程执行，省成本又分工明确
- 会话内 `/route on|off` 开关；路由发生时显示 `⤷ 自动路由 → 模型（原因）`

## 快速开始

```bash
mingdao init                    # ① 交互式向导：选服务商/模型、填 API Key、选权限模式
mingdao                         # ② 开始对话
mingdao "用 Python 写一个快速排序"    # 单次提问（适合脚本/管道）
mingdao --format json "问题"     # 单次提问，输出结构化 JSON（脚本集成）
mingdao --continue              # 继续最近一次会话
mingdao --resume                # 从会话列表选择恢复
mingdao --model deepseek-v4-pro # 指定模型
```

单次提问退出码：`0` 成功 / `1` 达到步骤上限或已中断 / `2` 出错。JSON 输出字段：`{ok, text, reasoning, usage, durationMs, steps, finish, aborted, truncated, session}`，出错时 `{ok:false, error}`。

API Key 从 [DeepSeek 开放平台](https://platform.deepseek.com) 获取。**密钥与配置分离**：配置存 `~/.mingdao/config.json`（无密钥，可分享/提交），密钥存独立凭证库 `~/.mingdao/credentials.json`（权限 600，仅本机）。

会话内命令：`/help` `/clear` `/model <名>` `/mode pro|flash` `/compact` `/plan` `/init` `/memory add <内容>` `/skills` `/sessions` `/title <别名>` `/usage` `/status` `/cost` `/verbose` `/save` `/exit`；`Tab` 补全命令与模型名，`↑↓` 浏览历史，`Ctrl+C` 中断当前生成，多行输入以行尾 `\` 续行。

## 密钥管理（独立凭证模块）

密钥**绝不**写入 `config.json`、**绝不**进入项目仓库——安装包与源码中不含任何密钥，每个人安装后配置自己的 Key：

```bash
mingdao key                      # 查看凭证状态（脱敏显示，如 sk-b82…10e9）
mingdao key set deepseek         # 交互式保存（隐藏输入，推荐）
mingdao key set deepseek sk-xxx  # 或直接传参（注意 shell 历史）
mingdao key remove deepseek      # 删除凭证
mingdao key import               # 从环境变量（DEEPSEEK_API_KEY 等）批量导入
```

解析优先级：**环境变量 > 本地凭证库 `~/.mingdao/credentials.json` > `config.json` 显式字段**（兼容旧版本）。`mingdao init` 向导中输入的 Key 也会自动存入凭证库。

## 配置说明（~/.mingdao/config.json，不含密钥）

```json
{
  "provider": "deepseek",          // 服务商：deepseek/openai/qwen/glm/moonshot/custom/自定义模块名
  "model": "deepseek-v4-flash",    // 模型名
  "baseUrl": "https://api.deepseek.com/v1",
  "permission": "ask",             // ask | auto | readonly
  "contextBudget": 128000          // 上下文预算 tokens（deepseek-v4-flash 默认 128k）
}
```

可选字段：`temperature`、`maxOutputTokens`、`includeUsage`（流式响应是否请求 usage/token 统计，默认 true；个别网关不支持 `stream_options` 时可设为 false）；`permission` 也可以是 `{"mode":"ask","allow":["bash","bash:git *"],"deny":["write"]}`（支持「工具名:参数前缀」规则）；Hooks：

```json
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "write|edit|bash", "cmd": "node ~/hooks/pre.js" }],
    "PostToolUse": [{ "matcher": "*", "cmd": "curl -X POST http://localhost:9000/audit" }]
  }
}
```

此文件无任何密钥，团队内可安全共享、可提交仓库。技能放 `~/.mingdao/skills/<名>/SKILL.md`（用户级）或 `<项目>/.mingdao/skills/<名>/SKILL.md`（项目级）。

## MCP 支持（接入任意 MCP 服务器）

在 `config.json` 里配置 `mcpServers`（Claude Code 同款格式），MingDao 后台连接，工具自动并入 Agent 循环（命名 `mcp__<服务器>__<工具>`）：

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/你的/目录"] },
    "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
  }
}
```

- 会话内 `/mcp` 查看各服务器状态与工具数；单个服务器启动失败不影响其他服务器与正常对话
- 带 `readOnlyHint` 标注的工具自动放行，其余按权限模式处理（ask 模式逐次确认）
- 可接入：文件系统、数据库、浏览器、Git、Docker、企业内部服务等任意 MCP 生态工具

## 内置技能（借鉴 DeepSeek-Harness 的 SKILL.md 格式）

安装包自带 14 个常用技能，开箱即用，模型在相关任务时自动加载：

| 技能 | 用途 |
| --- | --- |
| `git-commit` | 生成规范提交信息（Conventional Commits） |
| `code-review` | 代码/PR 审查清单（正确性 > 生命周期 > 安全） |
| `refactoring` | 安全重构（小步、可回退、测试护栏） |
| `debugging` | 系统化调试（复现/二分/假设验证） |
| `testing` | 单元测试编写（四类用例） |
| `pdf` / `docx` / `xlsx` / `pptx` | 文档与表格处理（工具选型 + 工作流） |
| `frontend-design` | 前端设计原则，避免"AI 味"页面 |
| `webapp-testing` | 本地 Web 应用测试（curl + Playwright） |
| `release-checklist` | 发布检查清单 |
| `docker` | Dockerfile / compose 最佳实践 |
| `api-design` | REST API 设计规范 |

三级来源与覆盖优先级：**用户级（~/.mingdao/skills/）> 项目级（.mingdao/skills/）> 内置（安装包 skills/）**。想改内置技能的行为，在用户级建同名目录写自己的 SKILL.md 即可；`/skills` 查看全部，`skill` 工具按需加载全文。

## 接入其他模型

- **OpenAI 兼容端点**（覆盖绝大多数模型）：`mingdao init` 选 `custom` 填地址即可；
- **内置预设**：OpenAI / 通义千问 / GLM / Kimi 开箱即选；
- **非 OpenAI 兼容协议**（如 Anthropic 原生）：在 `~/.mingdao/providers/<name>.mjs` 写一个 `createProvider(cfg)` 模块，详见 [docs/PROVIDERS.md](docs/PROVIDERS.md)。

## 面向 DeepSeek-V4 的优化

| 能力 | 说明 |
| --- | --- |
| 384K 上下文 | 预设 `contextWindow: 384000`（正式版规格，2026-08-17 起商用），`contextBudget` 按需调高 |
| 精确 tokenizer | 内置 DeepSeek 词表字节级 BPE 计数（与真实 API 偏差 <8%），预算裁剪更精准 |
| 推理流展示 | `reasoning_content` 增量渲染（dim 样式），不打断正文流 |
| 模型分工 | flash（预算 128k/温度 0.6）日常问答，pro（预算 200k/温度 0.4）复杂规划，一键 `/model` 切换 |
| 峰谷定价 | 用量统计展示 prompt/completion tokens，方便按峰谷时段（高峰 9:00–14:00 为闲时 2 倍）安排任务 |
| 自动重试 | 429/5xx/超时指数退避重试（借鉴 DeepSeek-Harness `llm-retry`） |

## 目录结构

```
src/
  cli.js             CLI 入口（向导/凭证/单次提问/REPL 命令族）
  agent.js           模型↔工具调用循环（子代理/钩子/todo/undo 状态）
  providers/         OpenAI 兼容客户端 + Provider 工厂（重试/超时/自定义模块）
  tools/             read/write/edit/ls/glob/grep/bash + skill/task/todo/undo
  skills.js          Skills 技能系统（渐进式披露）
  hooks.js           PreToolUse/PostToolUse 生命周期钩子
  mcp.js             MCP 客户端（stdio + JSON-RPC）
  routing.js         自动模型路由（启发式 + 分类器）
  tokenizer.js       精确 tokenizer（DeepSeek 词表 BPE）
  assets/            词表数据（tokenizer-data.json.gz，745KB）
  context.js         token 估算与预算裁剪
  permissions.js     权限引擎（模式 + 规则匹配）
  config.js          配置与向导（不含密钥）
  credentials.js     独立凭证库（Key 存储/解析/脱敏，权限 600）
  session.js         JSONL 会话持久化（预览/选择器）
  ui.js              TUI（流式渲染/高亮/diff/补全/中断/费用）
  web/               WebUI（server.js + web-io.js + index.html，零依赖 HTTP+SSE）
  index.js           公共 API 导出
test/
  smoke.js           离线冒烟测试（stub provider + 真实工具）
  e2e-local.js       本地 mock 服务器端到端测试
docs/                架构与扩展文档
install.sh           一键安装脚本
```

## 测试

```bash
node test/smoke.js       # 离线：工具/SSE 解析/Agent 循环/权限/配置/会话
node test/e2e-local.js   # 真实 HTTP：mock 服务器 + 完整 CLI 进程
```

## 路线图

- [ ] VS Code 深度集成（侧边栏内嵌面板、选中代码右键发送给 MingDao）
- [ ] 桌面应用（可选：当前 PWA 已覆盖主要体验）
- [ ] 多会话 CLI 面板与任务队列

## License

MIT
