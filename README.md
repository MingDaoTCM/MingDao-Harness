# MingDao-Harness（明道）

> 开源智能体框架（Agent Harness）：零运行时依赖、开箱即用，针对 DeepSeek-V4 首发优化，开放主流模型接入。命令：`mingdao`（简写 `mdh`）。

一个轻量的「模型循环 + 工具 + 权限」内核：终端（TUI）与浏览器（WebUI）两种界面复用同一核心，核心能力以 ESM 库导出、接口开放。架构详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 特性

- ⚡ **零运行时依赖**：纯 Node.js ≥ 18，无构建步骤，一条命令安装
- ✨ **产品级体验**：流式 Markdown + 代码高亮、编辑 diff 预览、思考过程暗显、`/` 命令 Tab 补全、Ctrl+C 中断、token/耗时/费用状态行（峰谷计价 + 缓存命中率）
- 🤖 **工具 Agent 循环**：`read` / `write` / `edit` / `ls` / `glob` / `grep` / `bash` + `skill` / `task`（子代理）/ `todo` / `undo`，流式输出与工具执行交替
- 🖥 **双界面**：TUI 与 `mingdao web` 一键启动的 WebUI（零依赖 HTTP+SSE，支持 PWA 装到桌面、多任务并行、全项设置面板）
- 🧩 **IDE 集成**：VS Code 侧边栏内嵌 WebUI + 选中代码右键发送；JetBrains 全家桶工具窗（JCEF）
- 🧠 **Skills 技能系统**：内置 14 个常驻技能 + 22 个可安装技能库（线上 registry，见下文）；SKILL.md 渐进式披露，不占上下文
- 🔌 **MCP 客户端**：零依赖实现 Model Context Protocol，`mcpServers` 配置即接入任意 MCP 服务器，工具自动并入 Agent 循环
- ☁️ **云同步与协作**：跨设备会话同步、多用户分享码协作、跨设备冲突图形化三选一（自建零依赖服务端）
- 📅 **任务与调度**：后台任务面板、定时/周期/依赖/链式调度（重启自愈）
- 🛡 **安全**：权限三档 `ask/auto/readonly` + 工具级规则；bash 沙箱三档 `off/readonly/safe`（bubblewrap）；API Key 与配置分离，绝不进仓库
- 📏 **DeepSeek-V4 深度优化**：内置 384K 上下文预设、精确 tokenizer（官方词表 BPE）、缓存命中计价与仪表盘、自动模型路由（pro 规划 / flash 执行）、自动重试
- 🔌 **开放模型接入**：DeepSeek / OpenAI（GPT-5 系列）/ Qwen（qwen3.7-max）/ GLM（GLM-5）/ Kimi（kimi-latest）+ 自定义 OpenAI 兼容端点（WebUI 自助添加模型与 Key）+ 自写 Provider 模块

## 快速开始

```bash
mingdao init                          # 交互式向导：服务商/模型 → API Key → 权限与沙箱
mingdao                               # 开始对话
mingdao "用 Python 写一个快速排序"     # 单次提问（适合脚本/管道）
mingdao --format json "问题"          # JSON 结构化输出（脚本集成）
mingdao --continue                    # 继续最近会话 · --resume 从列表选择恢复
mingdao web                           # 浏览器界面 http://127.0.0.1:3820
```

API Key 从 [DeepSeek 开放平台](https://platform.deepseek.com) 获取（其他内置服务商开箱即选）。密钥只存本机凭证库（权限 600），不写入仓库与配置文件。会话内输入 `/help` 查看全部命令（`/model` `/mode` `/compact` `/plan` `/memory` `/skills` `/sessions` `/status` `/cost` `/cache` `/mcp` `/route` `/verbose` `/exit`）。

## 一键安装

### Linux / macOS

```bash
curl -fsSL https://raw.githubusercontent.com/MingDaoTCM/MingDao-Harness/main/install.sh | bash
# 或
git clone https://github.com/MingDaoTCM/MingDao-Harness.git && cd MingDao-Harness && bash install.sh
```

安装脚本自动：检查 Node.js ≥ 18（缺失则经 nvm 安装）→ 安装 `mingdao` 命令（无管理员权限时装到 `~/.local/bin`）→ 提示初始化。

### Windows 10 / 11

1. 克隆或下载本项目并解压；
2. 双击 `install.bat`（自动经 winget 安装 Node.js，无需管理员权限）；
3. 完成后运行 `mingdao init` → `mingdao`。

Windows 说明：`bash` 工具自动使用 `cmd.exe`；配置目录 `C:\Users\<用户名>\.mingdao\`；推荐 Windows Terminal / PowerShell 7 获得最佳彩色显示。

## 常用命令速查

| 分类 | 命令 |
| --- | --- |
| 会话 | `mingdao --continue` / `--resume` / `sessions search <词>` / `--model <模型>` |
| 后台任务 | `mingdao run "<任务>"` · `mingdao tasks` / `tasks watch` / `tasks kill <id>` |
| 调度 | `mingdao schedule add "<任务>" --at "2026-08-21 09:00"` / `--every 2h` / `--after <任务ID>` · `schedule chain "构建" "测试" "部署"` · `schedule list/remove/pause/resume` |
| 工作空间 | `mingdao workspace add/list/use/path/remove <名称>` |
| 密钥 | `mingdao key`（脱敏状态）/ `key set <服务商>` / `key remove` / `key import` |
| MCP | 配置 `mcpServers` 后会话内 `/mcp` 查看状态 · `mingdao mcp preset list/add <名称>` 一键接入常用服务器 |
| 技能 | `mingdao skill search/install/list/uninstall/update` |
| 云同步 | `mingdao sync login/push/pull/status/passwd/share/accept/conflicts` · 自建服务端 `mingdao sync-server [端口]` |
| 其他 | `mingdao autostart on/off`（开机自启）· `mingdao web [端口]` · `mingdao init` |

## 技能系统

内置 **14 个常驻技能**（`git-commit` `code-review` `refactoring` `debugging` `testing` `pdf` `docx` `xlsx` `pptx` `frontend-design` `webapp-testing` `release-checklist` `docker` `api-design`）开箱即用，模型在相关任务时自动加载。

另有 **22 个可安装技能库**（开发 13 + 办公 9：SQL、性能、安全审计、CI/CD、邮件、会议纪要、简历、周报、文件整理等）：

```bash
mingdao skill search 文件      # 搜索（内置库 + 线上 registry）
mingdao skill install sql      # 一键安装到 ~/.mingdao/skills/（可改可删，同名覆盖内置）
mingdao skill update sql       # 按来源重装（更新）
```

- 安装来源自动识别：**库名** / **本地目录** / **SKILL.md 的 http(s) URL** / **git 仓库**；安装前 dry-run 校验格式，非法即拒绝
- 三级优先级：用户级（`~/.mingdao/skills/`）> 项目级（`.mingdao/skills/`）> 内置；SKILL.md 渐进式披露，按需加载全文
- 线上 registry 随本仓库发布（GitHub / Gitee / GitCode 三镜像自动回退、本地缓存）；企业内网可设 `MINGDAO_REGISTRY_URL` 指向自建 index.json（`node scripts/build-registry-index.js` 生成）

## 云同步与多用户协作

**服务端**（一台 Linux 服务器即可，零依赖）：

```bash
sudo mkdir -p /var/lib/mingdao-sync
sudo mingdao sync-server 443
# 公网请用 HTTPS：SYNC_CERT=/证书/fullchain.pem SYNC_KEY=/证书/privkey.pem
```

**客户端**：

```bash
mingdao sync login <用户名> <密码> https://你的服务器   # 首次自动注册 + 设备配对
mingdao sync push / pull / status                      # 推送 / 拉取 / 状态
mingdao sync passwd <新密码>                           # 修改密码
mingdao sync share <会话名>                            # 分享会话 → 输出 10 位分享码
mingdao sync accept <分享码>                           # 接受对方分享（进入自己的会话列表）
mingdao sync shares / unshare <分享码>                 # 我的分享列表 / 撤销
mingdao sync conflicts                                 # 查看跨设备冲突（三选一解决）
```

- **多设备**：同账号多设备登录，会话结束自动推送（可关）；**多用户**：分享码协作，分享者更新后对方再次接受即就地刷新，双方改动都不会被覆盖
- **冲突绝不丢数据**：冲突时自动备份为 `.server-*` / `.remote-*`，WebUI 冲突面板或 `sync conflict-resolve <会话> local|remote|both` 图形化选择
- **安全**：密码加盐哈希、设备 token 随机（服务端只存哈希）、会话名白名单、单文件 20MB 上限；WebUI 设置面板含完整同步区块

## 模型接入

- **内置预设**：DeepSeek（v4-pro / v4-flash / **v4-flash-vision-exp 多模态视觉**）、OpenAI（GPT-5 系列）、Qwen（qwen3.7-max）、GLM（GLM-5）、Kimi（kimi-latest）
- **自定义 OpenAI 兼容端点**：`mingdao init` 选 `custom`，或 WebUI 设置面板直接添加/修改/删除自定义模型（名称/标签/API 地址/Key），顶部下拉框即选即用
- **其他协议**：在 `~/.mingdao/providers/<name>.mjs` 导出 `createProvider(cfg)`，详见 [docs/PROVIDERS.md](docs/PROVIDERS.md)

## 配置与安全

- 配置文件 `~/.mingdao/config.json`：模型/权限/沙箱/上下文预算/路由/调度/MCP/同步等（**不含任何密钥**，可分享可提交）。完整字段、权限规则与 Hooks 见 [docs/CONFIG.md](docs/CONFIG.md)
- API Key 存独立凭证库 `~/.mingdao/credentials.json`（权限 600）：`mingdao key` 查看脱敏状态、`key set <服务商>` 交互式保存、`key import` 从环境变量导入；解析优先级：环境变量 > 凭证库 > 配置字段
- **沙箱**（bash 执行隔离，Linux + bubblewrap）：`off` 直接执行 / `readonly` 全盘只读 / `safe` 只读+断网；非 Linux 或未装 bubblewrap 自动降级并明示
- **权限**：`ask`（默认，写文件/命令逐次确认）/ `auto` / `readonly`，另支持 `{"mode":"ask","allow":["bash:git *"],"deny":["write"]}` 工具级规则

## 文档与目录

- 文档：[架构设计](docs/ARCHITECTURE.md) · [Provider 扩展](docs/PROVIDERS.md) · [配置详解](docs/CONFIG.md) · [桌面形态评估](docs/DESKTOP-EVALUATION.md) · [QA 报告](docs/QA-REPORT.md)
- IDE 扩展：`ide/vscode/`（侧边栏 WebUI + 右键发送）· `ide/jetbrains/`（工具窗集成）
- 桌面快捷方式：`bash scripts/desktop/install-desktop.sh`

```
src/               CLI / Agent / 工具 / 权限 / 会话 / 技能库 / MCP / 云同步 / WebUI（全部零依赖）
skills/            14 个内置常驻技能（SKILL.md）
skills-lib/        22 个可安装技能库预设
registry/          线上技能 registry 索引
test/              smoke（离线）+ e2e（真实进程/HTTP）测试
docs/              架构与扩展文档
install.sh / install.bat / install.ps1   一键安装
```

## 测试

```bash
node test/smoke.js       # 离线冒烟：工具 / SSE 解析 / Agent 循环 / 权限 / 技能 / 同步
node test/e2e-local.js   # 端到端：mock 服务器 + 完整 CLI 进程
node test/e2e-web.js     # 端到端：WebUI HTTP/SSE/权限/调度/同步
node test/e2e-schedule.js# 端到端：定时/周期/链式调度
```

## 版本

语义化版本：修复 → 末位 +1，新子系统 → 中位 +1，首个 npm 稳定发布（API 冻结）→ 1.0.0。当前 **0.1.x**（最新 `v0.1.24`）。

## License

[MIT](LICENSE)
