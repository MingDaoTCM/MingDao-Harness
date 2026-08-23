# 明道 MingDao 桌面版（Electron 薄壳）

内置 WebUI 的桌面应用：主进程直接运行 MingDao 服务（127.0.0.1 随机端口 + 一次性访问令牌），
窗口只加载本机地址；系统托盘常驻（关闭窗口最小化到托盘）、窗口大小/位置记忆、单实例锁、
摄像头/通知等权限一律拒绝、外链走系统浏览器；打包版自动检查 GitHub Releases 更新。

## 开发运行

```bash
# 仓库根目录
npm install -g .          # 先装好 mingdao（或已有凭证与配置即可）
mingdao init              # 首次需要初始化配置
npm run desktop           # 启动桌面版（自动拉起内置 WebUI）
```

## 本地打包

```bash
cd desktop
npm install               # 国内网络：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
npm run dist:dir          # 未压缩可运行目录 dist/linux-unpacked/
npm run dist:linux        # AppImage + deb
npm run dist:win          # NSIS 安装包（Windows 上运行）
npm run dist:mac          # dmg（macOS 上运行）
```

产物在 `desktop/dist/`。CI（`.github/workflows/desktop.yml`）在打 tag 时自动构建三平台安装包
并上传为 Actions 工件；GitHub Releases 发布后，打包版应用会自动检测更新
（`electron-updater`，可用 `MINGDAO_NO_AUTOUPDATE=1` 关闭）。

## 结构

- `main.js`：主进程（内置服务、窗口、托盘、菜单、自动更新）
- `electron-builder.yml`：打包配置（图标自动由 build/icon.png 转换三平台格式）
- `build/icon.png` / `build/tray.png`：品牌图标（与 WebUI icon.svg 同款设计）
