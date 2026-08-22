# MingDao-Harness（明道）

> 开源智能体框架（Agent Harness）：**零运行时依赖、开箱即用**，针对 DeepSeek-V4 首发深度优化，开放主流模型接入。一条命令安装，终端与浏览器双界面，命令：`mingdao`（简写 `mdh`）。

轻量的「模型循环 + 工具 + 权限」内核，能力以 ESM 库导出、接口全部开放。架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 为什么选 MingDao

- ⚡ **真正的零依赖**：纯 Node.js ≥ 18，无任何 npm 运行时依赖、无构建步骤——装完即用，不拖 node_modules
- 💰 **DeepSeek-V4 深度省钱**：384K 上下文预设、**缓存命中计价**（命中价仅为未命中的 1/30）+ 命中率仪表盘、峰谷计价、自动路由（pro 规划 / flash 执行）、精确 tokenizer（官方词表 BPE）
- 🖥 **双界面 + IDE 全家桶**：产品级 TUI（流式 Markdown、代码高亮、编辑 diff、Ctrl+C 中断、Tab 补全）与 `mingdao web` 一键 WebUI（PWA 可装桌面、多任务并行、全项设置面板）；VS Code 侧边栏与 JetBrains 工具窗深度集成
- 🧠 **36 个技能开箱即用**：14 个内置常驻 + 22 个可安装技能库（线上 registry 逐文件 sha256 校验防供应链篡改，`mingdao skill install sql` 一键装，可自建企业内 registry）
- 🔌 **生态即插即用**：MCP 客户端（零依赖实现，`mcpServers` 配置即接入任意 MCP 服务器）+ Hooks 钩子 + 9 个 MCP 生态预设
- ☁️ **云同步与多用户协作**：跨设备会话同步、分享码协作、跨设备冲突图形化三选一；服务端零依赖单文件，一台 Linux 服务器即可自建
- 🛡 **安全默认**：权限三档（ask/auto/readonly）+ 工具级规则、bash 沙箱三档（bubblewrap）、API Key 与配置分离（绝不进仓库）、附件/正则/路径全部有界、**工具调用审计日志**（`mingdao audit` 追溯每次执行与拒绝）
- 🖼 **多模态**：DeepSeek-V4-Flash-Vision-Exp 视觉模型内置，WebUI 直接上传图片；模型列表以官方 `/models` 线上名单为准，新模型发布自动出现
- ♻ **长会话不丢上下文**：超预算自动压缩——早期段落由 executor 模型压成摘要注入（`/compact` 可手动），绝不静默失忆

## 快速开始（3 步）

```bash
mingdao init                          # ① 向导：选服务商/模型 → 填 API Key → 选权限与沙箱
mingdao                               # ② 开始对话
mingdao web                           # ③ 或浏览器界面 http://127.0.0.1:3820
```

常用一行式：

```bash
mingdao "用 Python 写一个快速排序"      # 单次提问（脚本/管道友好）
mingdao --format json "问题"           # JSON 结构化输出（机器集成）
mingdao --continue                    # 继续最近会话 · --resume 从列表恢复
mingdao --model deepseek-v4-pro       # 指定模型
```

API Key 从 [DeepSeek 开放平台](https://platform.deepseek.com) 获取。密钥只存本机凭证库（权限 600），不写入仓库与配置文件。

## 安装指南

### Linux / macOS

一行安装（自动装 Node 并安装 `mingdao` 命令）。**三平台内容完全一致——你在哪个平台浏览，就用哪一行**（Gitee / GitCode 国内速度快，GitHub 面向海外）：

```bash
# Gitee（国内推荐）
curl -fsSL https://gitee.com/MingDaoTCM/MingDao-harness/raw/main/install.sh | bash -s -- gitee

# GitCode（国内推荐；其 raw 接口对 curl 有反爬拦截，改用克隆式）
git clone https://gitcode.com/MingDaoTCM/MingDao-Harness.git MingDao-Harness && cd MingDao-Harness && bash install.sh

# GitHub（海外）
curl -fsSL https://raw.githubusercontent.com/MingDaoTCM/MingDao-Harness/main/install.sh | bash -s -- github
```

> 若某平台的 raw 脚本下载被反爬拦截，把 `| bash` 换成克隆式安装即可（见下方「手动克隆」）。

或手动克隆（建议在本平台克隆，速度最快；目录名统一为 `MingDao-Harness`）：

```bash
git clone https://gitee.com/MingDaoTCM/MingDao-harness.git MingDao-Harness     # Gitee
git clone https://gitcode.com/MingDaoTCM/MingDao-Harness.git MingDao-Harness  # GitCode
git clone https://github.com/MingDaoTCM/MingDao-Harness.git MingDao-Harness   # GitHub
cd MingDao-Harness && bash install.sh
```

- 无管理员权限时自动安装到 `~/.local/bin`；装完 `mingdao init` 开始使用
- 卸载：删除 `mingdao` / `mdh` 命令即可，数据目录 `~/.mingdao/` 按需保留

### Windows 10 / 11

1. 在本平台克隆或下载本项目并解压（上方三条克隆地址任选其一，国内建议 Gitee / GitCode）；
2. 双击 `install.bat`（自动经 winget 安装 Node.js，无需管理员权限）；
3. 运行 `mingdao init` → `mingdao`。

说明：`bash` 工具自动使用 `cmd.exe`；配置目录 `C:\Users\<用户名>\.mingdao\`；推荐 Windows Terminal / PowerShell 7 获得最佳彩色显示。

### 从源码运行（开发）

```bash
git clone https://gitee.com/MingDaoTCM/MingDao-harness.git MingDao-Harness && cd MingDao-Harness   # 其余平台见上方「手动克隆」
node src/cli.js        # 直接运行，无需安装
```

### 验证安装

```bash
mingdao --version      # 显示版本号即成功
node -v                # 需 ≥ 18.17
```

## 使用指南

### 终端会话

会话内命令（输入 `/help` 查看全部）：`/model <名>` 切模型 · `/mode pro|flash` 快捷切换 · `/compact` 手动压缩上下文（超预算时另有**自动压缩**：早期段落被 executor 模型压成摘要注入，替代静默丢弃） · `/plan` 先计划后执行 · `/memory add <内容>` 长期记忆 · `/skills` 技能列表 · `/sessions` 历史检索 · `/status` `/cost` `/cache` 状态与费用 · `/mcp` MCP 状态 · `/route` 自动路由开关 · `/exit` 退出。支持 Tab 补全、↑↓ 历史、Ctrl+C 中断、行尾 `\` 多行输入。

### 后台任务与调度

```bash
mingdao run "重构 src 下的工具层" --permission auto   # 后台任务（独立进程）
mingdao tasks / tasks watch / tasks kill <id>        # 任务面板
mingdao schedule add "生成周报" --at "2026-08-21 09:00"   # 定时一次
mingdao schedule add "同步数据" --every 2h                # 周期（可 --anchor 09:00 每日锚点）
mingdao schedule chain "构建" "测试" "部署"               # 链式依赖
mingdao schedule list/remove/pause/resume               # 管理；重启自愈
```

### 自更新（`mingdao update`）

```bash
mingdao update          # 一键升级：从 Gitee/GitCode/GitHub 三镜像取最新（哪个可达用哪个）→ 自动跑冒烟测试 → 失败自动回滚
mingdao update --check  # 只对比版本，不改动工作区
mingdao rollback        # 回滚到上次 update 之前的提交（升级验证失败也可一键退回）
```

git 安装形态（仓库 + 全局链接）开箱即用；npm 形态按提示用 `npm update -g` 升级。

### WebUI（`mingdao web`）

- 流式对话：Markdown 渲染、代码高亮、编辑 diff、工具卡片、思考实况、实时滚动
- **上传入口**：输入框 📎 上传图片（视觉模型，如 `deepseek-v4-flash-vision-exp`）与文本文件
- 多任务并行（上限 8）、权限确认弹窗、会话管理、PWA 安装到桌面
- ⚙ 设置面板全项管理：模型与 API Key（动态模型列表）、权限/沙箱、调度、工作空间、记忆、缓存仪表盘、技能库、云同步
- 远程/手机访问：配置 `"web": {"host": "0.0.0.0"}` 后自动启用访问令牌（打印 `?token=` 链接；`mingdao web --auth-token <令牌>` 可固定）；默认 `127.0.0.1` 本机免令牌

### IDE 集成

- **VS Code**：`ide/vscode/` 复制到扩展目录 → 侧边栏内嵌完整 WebUI、选中代码右键「发送选中代码」、服务器随面板自动启停
- **JetBrains**：`ide/jetbrains/` 工具窗（JCEF）集成，`./gradlew buildPlugin` 构建后安装
- **桌面快捷方式**：`bash scripts/desktop/install-desktop.sh`

### 工作空间

WebUI 顶部（⚙ 右侧）下拉切换/新建（目录缺失自动创建，服务端工作目录随切换）；CLI：

```bash
mingdao workspace add 项目A ~/projects/a   # 登记（list/use/path/remove 管理）
cd "$(mingdao workspace path 项目A)"        # 一键进入
```

### 技能系统（36 个开箱即用）

内置 14 个常驻技能（`git-commit` `code-review` `debugging` `testing` `pdf` `docx` `xlsx` `pptx` `docker` 等）+ 22 个可安装技能库：

```bash
mingdao skill search 文件      # 搜索（内置库 + 线上 registry）
mingdao skill install sql      # 一键安装到 ~/.mingdao/skills/（可改可删）
mingdao skill list/uninstall/update
```

安装来源自动识别：库名 / 本地目录 / SKILL.md 的 URL / git 仓库；安装前 dry-run 校验格式。三级优先级：用户级 > 项目级（`.mingdao/skills/`）> 内置。企业内网可设 `MINGDAO_REGISTRY_URL` 指向自建 registry。

### 云同步与多用户协作

**服务端**（一台 Linux 服务器，零依赖单文件）：

```bash
sudo mkdir -p /var/lib/mingdao-sync
sudo mingdao sync-server 443
# 公网务必 HTTPS：SYNC_CERT=/证书/fullchain.pem SYNC_KEY=/证书/privkey.pem
```

**客户端**：

```bash
mingdao sync login <用户名> <密码> https://你的服务器   # 首次自动注册 + 设备配对
mingdao sync push / pull / status                      # 推送 / 拉取 / 状态
mingdao sync passwd <新密码>                           # 改密码（吊销全部设备，需重新登录）
mingdao sync share <会话名>                            # 分享会话 → 16 位分享码
mingdao sync accept <分享码>                           # 接受分享（再次接受即刷新）
mingdao sync conflicts                                 # 跨设备冲突三选一（保留本地/采用远端/都保留）
```

多设备自动同步（会话结束静默推送）；冲突绝不丢数据（自动 `.server-*` / `.remote-*` 备份 + 图形化选择）；WebUI 设置面板含完整同步/分享/冲突区块。

### 模型与 Key

- 内置：DeepSeek（v4-pro / v4-flash / v4-flash-vision-exp）、OpenAI（GPT-5 系列）、Qwen（qwen3.7-max）、GLM（GLM-5）、Kimi（kimi-latest）
- **动态模型列表**：下拉框只显示已设置 Key 的服务商，名单以官方 `/models` 接口线上拉取为准（缓存 1 小时，设置面板可手动「刷新模型」），新模型发布自动出现
- 自定义 OpenAI 兼容端点：WebUI 设置面板直接添加/修改/删除（名称/标签/API 地址/Key，可标 `vision` 支持图片）
- 其他协议：`~/.mingdao/providers/<name>.mjs` 写 `createProvider(cfg)`，见 [docs/PROVIDERS.md](docs/PROVIDERS.md)

### 安全

- **权限三档**：`ask`（默认，写文件/命令逐次确认）/ `auto` / `readonly`；工具级规则 `{"mode":"ask","allow":["bash:git *"],"deny":["write"]}`
- **沙箱三档**（Linux + bubblewrap）：`off` / `readonly` 全盘只读 / `safe` 只读+断网；非 Linux 自动降级并明示
- **密钥分离**：Key 存 `~/.mingdao/credentials.json`（600 权限，`mingdao key` 管理），`config.json` 无密钥可分享可提交

## 配置与扩展

配置字段、权限规则、Hooks、MCP、云同步、自定义 Provider 的完整说明见 [docs/CONFIG.md](docs/CONFIG.md)；架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；Provider 扩展见 [docs/PROVIDERS.md](docs/PROVIDERS.md)。

## 常见问题

| 问题 | 解决 |
| --- | --- |
| 提示「没有可用 API Key」 | `mingdao key set <服务商>`（或 WebUI 设置面板设 Key）；Key 从对应平台获取 |
| 模型下拉框是空的 | 说明没有任何服务商设置了 Key——设 Key 后自动拉取线上模型列表（可点「刷新模型」） |
| 沙箱提示降级 | 需要 Linux 且安装 bubblewrap（`apt install bubblewrap` / `dnf install bubblewrap`） |
| Windows 颜色异常 | 使用 Windows Terminal 或 PowerShell 7 |
| 同步服务器自签证书报错 | 登录时加 `--insecure` 过渡；正式环境请配置 Let's Encrypt 证书 |
| 上传图片报「模型不支持」 | 切换到 `deepseek-v4-flash-vision-exp` 或给自定义模型加 `vision` 标记 |
| 局域网/公网访问 WebUI | `mingdao web --auth-token <令牌>`（或 `MINGDAO_WEB_TOKEN` / `web.token`）；未配置且非回环绑定时自动生成随机令牌并打印 `?token=` 链接，所有数据接口强制校验令牌与 Host 头 |

## 目录结构

```
src/               CLI / Agent 循环 / 工具 / 权限 / 技能库 / MCP / 云同步 / WebUI（全部零依赖）
skills/            14 个内置常驻技能
skills-lib/        22 个可安装技能库预设
registry/          线上技能 registry 索引
test/              smoke（离线）+ e2e（真实进程/HTTP）测试
docs/              架构与扩展文档
install.sh / install.bat / install.ps1   一键安装
```

## 测试

```bash
node test/smoke.js         # 离线冒烟：工具 / SSE / Agent 循环 / 权限 / 技能 / 同步
node test/e2e-local.js     # 端到端：mock 服务器 + 完整 CLI 进程
node test/e2e-web.js       # 端到端：WebUI HTTP/SSE/权限/调度/同步
node test/e2e-schedule.js  # 端到端：定时/周期/链式调度
```

## License

[MIT](LICENSE)
