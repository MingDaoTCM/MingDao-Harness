# MingDao Harness v0.4.0 发布说明

**版本：0.4.0 — 开放内核（Agent Preset · 第三方工具 · 公共 API）**

## 本次更新

1. **Agent Preset（智能体预设）**：声明式 JSON 把「系统提示 + 工具白名单 + 权限 + 模型 + 参数」
   打包成可安装、可复用、可分享的单元——不改一行源码，定制自己的智能体。
   三级发现（项目 `.mingdao/presets/` → 用户 `~/.mingdao/presets/` → 内置，同名遮蔽），
   schema 严格校验（拼错字段直接报错），白名单硬拦截（名单外工具对模型不可见、调用被拒）。
   CLI `--preset` / REPL `/preset` / WebUI 预设下拉三入口一键选用；内置「本地模型审计」示例。
2. **第三方工具注册**：`registerTool({ name, schema, run })` 程序化注册 + `config.tools`
   声明式挂载（shell 命令包装，参数经环境变量传递防注入）——自定义工具与内置工具同链路：
   权限门控、审计、省钱 schema 瘦身、预设白名单全部生效。
3. **公共 API 冻结**：`import { createAgent, createProvider, registerTool, ... } from 'mingdao-harness'`
   即可把 MingDao 嵌进自己的程序。24 个 @stable 导出有契约测试锁定，minor 版本内向后兼容；
   配套 `docs/DEVELOPER.md`（预设格式 / 工具注册 / 库嵌入最小示例 / API 速查）。
4. **战略定调**：垂直产品 × 开放内核——保持 DeepSeek 省钱 Coding Agent 的垂直深度，
   同时把内核开放给开发者做二次开发；「本地/私有化第一公民」与「DeepSeek 省钱」并列主攻
   （详见 docs/STRATEGY-NEXT.md）。延续零依赖根基：不引入插件内核、不做云平台。

## 安装

- **Windows**：`mingdao-setup-0.4.0-x64.exe`
- **Linux**：`mingdao-0.4.0-amd64.deb` 或 `mingdao-0.4.0-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.0-x64.dmg` / `mingdao-0.4.0-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.0-arm64.dmg` / `mingdao-0.4.0-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
