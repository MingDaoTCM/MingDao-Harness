# 桌面双击启动（过渡方案）

按 [docs/DESKTOP-EVALUATION.md](../../docs/DESKTOP-EVALUATION.md) 的结论：在满足立项条件前，用以下零成本脚本获得「双击即用」体验（独立窗口由 PWA 承担，本方案负责一键启动服务器 + 打开界面）。

| 平台 | 文件 | 用法 |
| --- | --- | --- |
| Linux | `mingdao-web.desktop` + `install-desktop.sh` | `bash install-desktop.sh`（可选 `--autostart` 开机自启）→ 应用菜单搜 MingDao |
| Windows | `start-mingdao.bat` | 发送到桌面快捷方式，双击即用 |
| macOS | `mingdao-web.command` | `chmod +x mingdao-web.command` 后双击（首次需右键→打开） |

说明：

- 端口默认 3820，改动请编辑对应文件
- 服务器常驻内存占用极小（Node 单进程）；想彻底退出：`pkill -f "mingdao web"`（Linux/macOS）或任务管理器结束 node 进程（Windows）
- 需要系统托盘/自动更新等能力时，按评估文档的触发条件立项桌面应用
