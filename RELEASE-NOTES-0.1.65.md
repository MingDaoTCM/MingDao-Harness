# MingDao Harness 0.1.65 桌面版发布说明

**版本：0.1.65（同版本重建，修复版）**

## 本次修复（相对上一轮 0.1.65 安装包）

1. **长时间生成不再"假死"**：服务端每 8 秒推送进度心跳，界面实时显示
   「正在工作 X 分 Y 秒 · 已执行 N 步」，长任务全程有可见反馈。
2. **修复长任务被误杀**：原 120 秒固定时长看门狗会在健康的长生成
   （如连续写大文件）时误报「响应超时已中断」并截断工具参数。
   现改为**无活动超时**——每收到一个事件就重置，权限询问等待期间暂停计时，
   只有真正 120 秒毫无响应才中断。
3. **修复超长输出被截断**：模型单次输出超限导致 write 参数截断时，
   现在会自动注入分块指令（单个 write ≤6000 字符、先骨架后逐文件补充）。
4. **修复 Windows 鼠标滚轮无法滚动聊天**：自动跟随与"回到底部"按钮
   统一改为主滚动容器，滚轮、自动滚动、悬浮按钮行为一致。
5. **推理内容限显防卡顿**：超长思考过程全量保留，界面只渲染末尾 9KB，
   避免海量文本增量渲染导致界面卡死。
6. **界面对齐 DeepSeek Harness**：代码块新增语言横幅 + 一键复制、
   12px 圆角、思考指示呼吸灯、用户气泡与间距精修。
7. **修复第二问无反应**（上一版已修，本版保留）：提示栏复选框被
   工作计时器覆盖导致 `.checked` 读取崩溃、按钮卡红的问题。

## 安装

- **Windows**：`MingDao-Harness-Setup-0.1.65.exe`
- **Linux**：`mingdao-harness_0.1.65_amd64.deb` 或 `MingDao-Harness-0.1.65.AppImage`
- **macOS (Intel)**：`MingDao-Harness-0.1.65-x64.dmg` / `.zip`
- **macOS (Apple 芯片)**：`MingDao-Harness-0.1.65-arm64.dmg` / `.zip`

> ⚠️ 本次为**同版本重建**（版本号保持 0.1.65），自动更新不会推送，
> 请手动下载覆盖安装。

## 校验

- Windows exe sha256：`见 GitHub Release 页面`
- 全部资产 sha256 详见 harness.mingdao.ai 下载页。

## 反馈

- 官网：https://harness.mingdao.ai
- 论坛：https://harness.mingdao.ai/forum/
- 问题反馈请附 `~/.mingdao/logs/web-server.log`（Linux/macOS）或
  `%USERPROFILE%\.mingdao\logs\web-server.log`（Windows）与桌面端
  `mingdao.log`。
