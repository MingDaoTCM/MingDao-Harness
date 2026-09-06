# MingDao Harness v0.4.2 发布说明

**版本：0.4.2 — 预设下拉体验修复 + 本地模型长任务 507 截断缓解**

## 本次更新

### Agent Preset 下拉体验（修复桌面版「预设空」+ 可用性）

1. **桌面版预设下拉为空修复**：桌面版打包漏了内置预设目录 `presets/`，导致 `builtinPresetDir()`
   指向的目录不存在、`listPresets()` 恒空——「预设…」下拉点开无任何可选项。已补进打包配置。
2. **悬停提示秒现**：预设下拉此前未接入自绘 tooltip，退回浏览器原生 title（约 1–2 秒才出）。
   现与权限/模型/思考下拉一致，悬停即显。
3. **选中即知作用**：选中某个预设会即时弹出说明——「这是什么 + 覆盖了哪些字段（工具白名单数 /
   权限 / 模型 / 参数）」，不再需要先选中才能从 tooltip 里看到描述。
4. **显式退出**：占位符「预设…」改为「无预设」，选回即取消预设并提示「已恢复默认配置」。
5. **内置预设权限修正**：内置「本地模型审计」预设 permission `auto → readonly`——语义更准（本就
   是只读审计），且避免默认「询问」模式下被 v0.4.1 提权拦截静默忽略（ask→readonly 属降权，正常生效）。

### 本地模型长任务「507 截断」缓解

依据 v0.4.1 截断排查报告，本地模型跑长审计任务后期会触发服务端 `507 memory_refusal`（多路大
prefill 打满单进程内存预算），进而空输出收尾。本版应用侧三处缓解：

6. **只读子代理串行化**：子代理目标为本地模型时，只读子代理不再并行派发（此前无并发上限），
   避免多路大 prefill 同时冲内存；远程模型仍并行，`read/ls/glob/grep` 只读工具仍并行。
7. **本地模型压缩提前**：上下文压缩触发线默认远程 80% 不变，本地模型默认 **60%**——内存预算
   有限时不必等到 80% 再压（`config.compactTrigger` 显式设置时仍以你为准）。
8. **507 提示可操作化**：API 返回 507 时附带「本地模型内存不足：请压缩上下文、减少并发子任务，
   或重启模型服务释放内存」，而非裸状态码。

## 安装

- **Windows**：`mingdao-setup-0.4.2-x64.exe`
- **Linux**：`mingdao-0.4.2-amd64.deb` 或 `mingdao-0.4.2-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.4.2-x64.dmg` / `mingdao-0.4.2-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.4.2-arm64.dmg` / `mingdao-0.4.2-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
