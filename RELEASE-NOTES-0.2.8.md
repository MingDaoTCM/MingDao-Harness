# MingDao Harness v0.2.8 发布说明

**版本：0.2.8**

## 本次更新

1. **任务收尾总结对齐 DeepSeek-Harness**：跑满工具步数上限前自动注入收尾指令，
   末轮仍调用工具时不再静默结束——自动补一次 no-tool 总结，交付物清单随总结文字输出；
   兜底提示文案同步改写。
2. **会话索引分片**：检索索引按会话名 sha1 分 256 片（>1000 会话不再单文件全量解析，
   增量只重写脏片，旧单文件自动迁移）。
3. **常量单源化**：并发上限 / 5MB 图片 / 200KB 文本附件上限收敛到统一常量模块，
   前端预检与服务端校验不再漂移。
4. **WebUI ES Modules 拆分**：`app.js` 拆出纯工具模块与共享常量，可维护性提升。
5. **思考模式 / 推理等级按模型独立**：`reasoningByModel[模型]` 覆盖（旧全局配置兼容），
   每个模型记住自己的思考档位；`/think` 命令同步按模型写。
6. **界面对齐 DeepSeek-Harness**：模型（紧凑选择器）、权限、思考下拉下移到输入区
   （发送键左侧），顶栏瘦身；权限/思考中文选项；自绘悬浮气泡 tooltip 替换原生 title
   （权限/模型/思考/附件/后台任务 chip）；轨迹/子代理「关闭」按钮字号缩小不换行。
7. **文档门禁**：QA-REPORT 断言规模快照、CONFIG 补降级/思考档位、CI 类型门禁统一
   `tsconfig.full.json`。

## 安装

- **Windows**：`mingdao-setup-0.2.8-x64.exe`
- **Linux**：`mingdao-0.2.8-amd64.deb` 或 `mingdao-0.2.8-x86_64.AppImage`
- **macOS (Intel)**：`mingdao-0.2.8-x64.dmg` / `mingdao-0.2.8-x64-mac.zip`
- **macOS (Apple 芯片)**：`mingdao-0.2.8-arm64.dmg` / `mingdao-0.2.8-arm64-mac.zip`

> 桌面版安装包统一由官网分发（国内直连极速）：https://harness.mingdao.ai/#downloads
> 校验值与更新日志以官网为准。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端 `mingdao.log`。
