# MingDao Harness

> 开源智能体框架（Agent Harness）：**零运行时依赖、开箱即用**，针对 DeepSeek-V4 首发深度优化，开放主流模型接入。一条命令安装，终端与浏览器双界面，命令：`mingdao`（简写 `mdh`）。
>
> 项目简称 **MDH**（MingDao Harness），自 v0.4.3 起文档/日志/发布说明统一使用。

轻量的「模型循环 + 工具 + 权限」内核，能力以 ESM 库导出、接口全部开放。架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 为什么选 MingDao

- ⚡ **真正的零依赖**：纯 Node.js ≥ 18，无任何 npm 运行时依赖、无构建步骤——装完即用，不拖 node_modules
- 💰 **DeepSeek-V4 深度省钱**：1M 上下文预设（单次输出上限 384K）、**缓存命中计价**（命中价仅为未命中的 1/30）+ 命中率仪表盘、峰谷计价（高峰＝北京工作日 9:00–12:00、14:00–18:00，闲时半价自动识别）、自动路由（pro 规划 / flash 执行 + 分类缓存 + 会话粘滞）、精确 tokenizer（官方词表 BPE）、滞回自动压缩、**Batch API 半价批处理**（`mingdao batch`）、**避峰调度**（`--offpeak` 高峰顺延到最近闲时 12:00/18:00）、**费用护栏**（每日上限防超支）
- 🖥 **双界面 + IDE 全家桶**：产品级 TUI（流式 Markdown、代码高亮、编辑 diff、Ctrl+C 中断、Tab 补全）与 `mingdao web` 一键 WebUI（PWA 可装桌面、多任务并行、全项设置面板）；VS Code 侧边栏与 JetBrains 工具窗深度集成
- 🧠 **36 个技能开箱即用**：14 个内置常驻 + 22 个可安装技能库（线上 registry 逐文件 sha256 校验防供应链篡改，`mingdao skill install sql` 一键装，可自建企业内 registry）
- 🔌 **生态即插即用**：MCP 客户端（零依赖实现，`mcpServers` 配置即接入任意 MCP 服务器）+ Hooks 钩子 + 9 个 MCP 生态预设
- ☁️ **云同步与多用户协作**：跨设备会话同步、分享码协作、跨设备冲突图形化三选一；服务端零依赖单文件，一台 Linux 服务器即可自建
- 🛡 **安全默认**：权限三档（ask/auto/readonly）+ 工具级规则、bash 沙箱三档（bubblewrap）、API Key 与配置分离（绝不进仓库）、附件/正则/路径全部有界、**工具调用审计日志**（`mingdao audit` 追溯每次执行与拒绝）
- 🖼 **多模态**：DeepSeek-V4-Flash-Vision-Exp 视觉模型内置，WebUI 直接上传图片；模型列表以官方 `/models` 线上名单为准，新模型发布自动出现
- ♻ **长会话不丢上下文**：超预算自动压缩——早期段落由 executor 模型压成摘要注入（`/compact` 可手动），绝不静默失忆
- 🔎 **历史会话秒搜**：增量索引全文检索（中文 bigram 分词，`mingdao sessions search` / WebUI 搜索框共用）；WebUI **会话级工作空间**——每个会话记住自己的项目目录，多任务并行互不串目录
- 🌍 **真·跨平台**：Linux / macOS / Windows 全程实测，三平台 CI 矩阵（Ubuntu 18/20/22 + Windows + macOS）常驻守护，Windows 下 journal/测试全绿

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

### 任意平台（npm）

```bash
npm install -g mingdao-harness   # 之后 mingdao / mdh 即可用（升级：npm update -g mingdao-harness）
```

### Linux / macOS

一行安装（自动装 Node 并安装 `mingdao` 命令）。**三平台内容完全一致——你在哪个平台浏览，就用哪一行**（Gitee / GitCode 国内速度快，GitHub 面向海外）：

```bash
# Gitee（国内推荐）
curl -fsSL -o /tmp/mingdao-install.sh https://gitee.com/MingDaoTCM/MingDao-harness/raw/main/install.sh && bash /tmp/mingdao-install.sh gitee

# GitCode（国内推荐；其 raw 接口对 curl 有反爬拦截，改用克隆式）
git clone https://gitcode.com/MingDaoTCM/MingDao-Harness.git MingDao-Harness && cd MingDao-Harness && bash install.sh

# GitHub（海外）
curl -fsSL -o /tmp/mingdao-install.sh https://raw.githubusercontent.com/MingDaoTCM/MingDao-Harness/main/install.sh && bash /tmp/mingdao-install.sh github
```

> **为什么不是 `curl … | bash`**：管道形式下 curl 失败（网络中断/被反爬拦截）时不会输出任何内容，
> 右侧 bash 读到 EOF 后**以 0 退出**——终端什么都不打印，用户会以为装好了。先下载再执行可以用
> `&&` 卡住失败，也能看到真实报错。
>
> 若某平台的 raw 脚本下载被反爬拦截，改用克隆式安装（见下方「手动克隆」）。

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

### 桌面版（Electron）

```bash
mingdao desktop          # 任意目录启动桌面版（首次运行会提示安装 Electron，带镜像指引）
npm run desktop          # 等价写法（需在仓库目录内）
```

- 内置服务零端口暴露（127.0.0.1 随机端口 + 一次性令牌）、系统托盘常驻、窗口状态记忆、
  权限一律拒绝、外链走系统浏览器、打包版自动更新；
- 安装包：Linux `AppImage`/`deb`（本地 `npm run desktop:dist` 已实测构建）、Windows NSIS、
  macOS dmg；打 tag 后 CI 自动构建三平台安装包（详见 `desktop/README.md`）。

### 从源码运行（开发）

```bash
git clone https://gitee.com/MingDaoTCM/MingDao-harness.git MingDao-Harness && cd MingDao-Harness   # 其余平台见上方「手动克隆」
node src/cli.js        # 直接运行，无需安装
```

开发者护栏（提交前建议执行；CI 会强制跑全套）：

```bash
npm install            # 仅装 devDependencies（typescript + @types/node），运行时依旧零依赖
npm run typecheck      # tsc --checkJs 类型护栏（覆盖 agent/cli/commands/provider/cachestats 等核心模块）
node test/smoke.js && node test/e2e-local.js && node test/e2e-web.js && node test/e2e-schedule.js
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

### 垂域 Pack（v0.5.0 · Pack API v1）

把**某个行业的智能体**打包成一个可安装、可校验、可版本化的单元——不改内核源码：

```bash
mingdao pack new tcm            # 生成脚手架（manifest + 入口 + 领域提示词）
mingdao pack verify ./packs/tcm # 静态校验 + 运行时契约校验（CI 门禁，非 0 退出即失败）
mingdao pack list / info tcm    # 查看已加载 Pack 与贡献面
mingdao cost --by pack          # 垂域费用分账
```

一个 Pack 可以贡献四类东西：

| 贡献 | 作用 |
| --- | --- |
| **工具** | 领域工具，注册为 `pack__<pack>__<tool>`，与内置工具同走权限 / 审计 / schema 瘦身链路 |
| **约束（领域红线）** | `tool-deny` / `tool-arg-require` / `arg-forbid` / `output-forbid` / `completeness` / `confirm`，在内核三个时机**强制**（不是提示词里的一句话），命中写审计 |
| **领域提示词段** | 注入系统提示（确定性排序、字节稳定，不破坏前缀缓存） |
| **费用归因** | Pack 内模型调用走 `ctx.llm()`，自动入账 + 四维归因（`pack`/`tool`/`purpose`/`model`） |

三级遮蔽：`<项目>/.mingdao/packs/` > `~/.mingdao/packs/` > 内置 `packs/`；坏 Pack 只告警、不阻塞启动。
契约与示例见 [docs/PACK-API.md](docs/PACK-API.md)、内置中立示例 `packs/example-hello/`。

### 模型与 Key

- 内置：DeepSeek（v4-pro / v4-flash / v4-flash-vision-exp）、OpenAI（GPT-5 系列）、Qwen（qwen3.7-max）、GLM（GLM-5）、Kimi（kimi-latest）
- **动态模型列表**：下拉框只显示已设置 Key 的服务商，名单以官方 `/models` 接口线上拉取为准（缓存 1 小时，设置面板可手动「刷新模型」），新模型发布自动出现
- 自定义 OpenAI 兼容端点：WebUI 设置面板直接添加/修改/删除（名称/标签/API 地址/Key，可标 `vision` 支持图片）
- 其他协议：`~/.mingdao/providers/<name>.mjs` 写 `createProvider(cfg)`，见 [docs/PROVIDERS.md](docs/PROVIDERS.md)

### 安全

- **权限三档**：`ask`（默认，写文件/命令逐次确认）/ `auto` / `readonly`；工具级规则 `{"mode":"ask","allow":["bash:git *"],"deny":["write"]}`
- **沙箱三档**（Linux + bubblewrap）：`off` / `readonly` 全盘只读 / `safe` 只读+断网；非 Linux 自动降级并明示
- **密钥分离**：Key 存 `~/.mingdao/credentials.json`（600 权限，`mingdao key` 管理），`config.json` 无密钥可分享可提交
- **共享令牌 = 同一用户**（v0.4.7 明确边界）：WebUI 的访问令牌是**部署级**的，不区分使用者。
  局域网内多人共用同一令牌时，任务面板/中断/会话彼此可见——这是当前设计的边界，不是缺陷修复
  范围内的遗漏。需要多用户隔离时请一人一实例（不同端口 + 不同 `MINGDAO_HOME`）
- **内网 / 信创部署**（v0.6.0）：`bash install.sh --offline`（Linux/macOS）与 `install.ps1 -Offline`（Windows）
  均可在**完全断网**环境安装（不装 Node、不碰 npm，
  直接软链；本项目运行时零依赖）；内置 `vllm` / `ollama` / `oneapi` 预设覆盖国产推理栈与内网网关
  （绝大多数提供 OpenAI 兼容层）。**本机/内网端点免除「必须有 API Key」的硬校验**（这类端点通常不校验，
  很多也不发放密钥）——但公网端点仍然必须有 Key，不因内网便利而放松。
  离线包由 `bash scripts/build-offline-bundle.sh` 生成（含内网操作说明与校验值）
- **出网白名单**（v0.6.0）：`config.net.allow` 声明允许的出网目标（精确主机 / `*.子域` / IPv4 CIDR），
  `mode: warn|block` 决定越界是记账放行还是拒绝；`mingdao net report` 导出「本机访问过哪些外部地址」用于自证。
  **边界**：覆盖内核经由 HTTP 出口与自更新 `git` 联系的目标；**不覆盖** MCP 服务器、
  `config.tools`/Pack 工具自起的子进程、桌面版 Electron 外壳的更新检查，以及用户在 `bash` 里自己敲的命令
  ——它证明「内核没有偷偷外传」，不等于「这台机器绝对没有外传」。
  需要进程级强制请用出网代理/防火墙，本闸门是**内核自证**工具而非沙箱（详见 [docs/CONFIG.md](docs/CONFIG.md) 出网白名单一节）
- **PID 归属校验分平台**（v0.4.7 明确边界）：`killTask` / `stopDaemon` 在动手前会确认
  「这个 pid 确实还是我启动的那个进程」，避免 pid 被系统回收复用后误杀无关进程。
  Linux 读 `/proc/<pid>/cmdline`、macOS 走 `ps`，两者都能精确校验；**Windows 两者皆无**
  （不为这一处判定引入 PowerShell/WMI 依赖），此时退回 best-effort 按存活处理，并把限制写在这里。
  需要精确校验的场景请部署在 Linux / macOS 上

## 配置与扩展

配置字段、权限规则、Hooks、MCP、云同步、自定义 Provider 的完整说明见 [docs/CONFIG.md](docs/CONFIG.md)；架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；Provider 扩展见 [docs/PROVIDERS.md](docs/PROVIDERS.md)。

## 常见问题

| 问题 | 解决 |
| --- | --- |
| 提示「没有可用 API Key」 | `mingdao key set <服务商>`（或 WebUI 设置面板设 Key）；Key 从对应平台获取。脚本里用 `echo "$KEY" \| mingdao key set <服务商>`，避免密钥落到 argv（`ps` 可见） |
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
