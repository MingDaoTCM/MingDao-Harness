# MingDao Harness 桌面版（Electron 薄壳）

内置 WebUI 的桌面应用：主进程直接运行 MingDao 服务（127.0.0.1 随机端口 + 一次性访问令牌），
窗口只加载本机地址；系统托盘常驻（关闭窗口最小化到托盘）、窗口大小/位置记忆、单实例锁、
摄像头/通知等权限一律拒绝、外链走系统浏览器；打包版自动检查 GitHub Releases 更新。

## 开发运行

```bash
# 任意目录（推荐）
mingdao init              # 首次需要初始化配置
mingdao desktop           # 启动桌面版（自动定位仓库并拉起内置 WebUI）

# 等价：在仓库根目录
npm run desktop
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
并上传为 Actions 工件；安装包发布到官网后，打包版应用会自动检测更新。

**自动更新**（`electron-updater`，可用 `MINGDAO_NO_AUTOUPDATE=1` 关闭）：
- 更新源为官网自托管 feed：`https://harness.mingdao.ai/updates/`（latest.yml / latest-mac.yml / latest-linux.yml），
  国内直连，不走 GitHub；
- 每次发版需把新安装包与对应 latest*.yml 一并上传（发版清单见根 README）；
- deb 安装不支持 electron-updater（仅 AppImage / NSIS / dmg+zip）。

**更新包来源签名**（审计 K-8：`electron-updater` 自带的 sha512 与包**同源**，只防传输损坏、
不防"换了发布源/被投毒的 feed"——补的是**来源**）：
- 判据与文案在 `update-verify.js`（纯函数，`test/smoke.js` §135 钉边界），门禁接在
  `main.js` 的「下载完成 → 安装」之间：
  - 有签名 + 验签通过 → 安装；
  - **有签名 + 验签失败/拿不到证据 → 一律拒绝**（UI"更新包来源不可信，已拒绝" + 引导官网手动下载，
    并关闭 `autoInstallOnAppQuit`，否则退出应用时照样装）；
  - 无签名 → 默认 `warn-and-install`（照旧安装，但日志与 UI 明写"**本次更新未验证来源签名**"）；
    设 `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` 改为拒绝（发行方/高安全用户）。
- 公钥是**内置常量**（`update-verify.js` 的 `UPDATE_PUBLIC_KEY_PEM`，运行期不从网络取）；
  发布侧用 `node scripts/update-sign.mjs --keygen/--sign/--verify`，密钥托管与发布步骤见
  `docs/CODE-SIGNING.md` §五。
- **诚实边界**：本轮发布链路还没接入签名（feed 里没有 `.sig`），所以默认档仍是 `warn-and-install`；
  macOS/Windows 的**代码签名**（Gatekeeper/SmartScreen）是另一件事。

## 结构

- `main.js`：主进程（内置服务、窗口、托盘、菜单、自动更新）
- `update-verify.js`：更新包来源签名校验（ed25519 纯函数 + 内置公钥常量 + 三态决策 + 文案单源）
- `electron-builder.yml`：打包配置（图标自动由 build/icon.png 转换三平台格式）
- `build/icon.png` / `build/tray.png`：品牌图标（与 WebUI icon.svg 同款设计）
