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
- **按地区自动选线路（v0.9.2）**：候选香港 `harness.mingdao.ai` 与深圳 `harness.southdns.com`
  （两者提供相同的 `/updates/*` 与 `/downloads/*`）。启动检查更新时各发一个极小 GET
  （`/updates/latest.yml`，3s 超时）比 **time to first byte**，选最快的；结果缓存 24h 到
  `userData/endpoint.json`。排障可用 `MINGDAO_UPDATE_BASE=https://…` 强制指定（不探测、不写缓存）。
  选中的 base 应用于 deb feed、deb 安装包、`.sig`、electron-updater 的 `setFeedURL` 与「去官网下载」链接；
  探测全失败回退香港；镜像缺文件（403/404/410 或 DNS 失败）自动回退香港**再试一次**。
  日志固定一行 `stage=endpoint endpoint=sz|hk probe=xxms source=…`。
- 每次发版需把新安装包与对应 latest*.yml 一并上传（发版清单见根 README）；
- **deb 安装形态**（`/opt/MingDao Harness/`）不走 electron-updater（它只支持 AppImage / NSIS / dmg+zip），
  改由 `deb-update.js` 走**独立 feed** `latest-linux-deb.yml`：
  检测新版 → 下载 `.deb` → **sha512 + 来源签名双校验** → `pkexec dpkg -i`（弹一次管理员授权）→ 提示重启；
  校验任一不过即删除文件并拒绝安装；提权失败/用户取消会给出可复制的 `sudo dpkg -i <path>` 与安装包路径。
  系统**没有 `pkexec`**（精简发行版）时不再卡在 spawn 错误里：先 `which pkexec` 探测，没有就直接弹
  「手动安装」对话框（安装包路径 + `sudo dpkg -i` + 下载页），并可用「打开日志」把证据带回。
  真实的提权安装与 polkit 弹窗只能在 Linux 桌面机人工验收（CI 不装系统包）。

**更新诊断日志（v0.9.2）**：`~/.mingdao/logs/desktop.log`（`MINGDAO_HOME` 可改家目录）。
每条更新流程按 `stage=feed/confirm/download/save/verify/sig/install` 记行；下载时**每整十百分比**记一行，
窗口标题同时显示 `MingDao Harness — 正在下载更新 42%`（Linux 任务栏进度条在多数桌面环境不显示，标题是可见兜底）。
下载有**总超时 5 分钟 + 空闲超时 30 秒**（连续 30s 无数据 → 中止并提示「网络停滞」）；
对端中止/连接提前关闭也会立即失败。任何更新失败对话框都带「打开日志」按钮。

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
- `deb-update.js`：deb 安装形态的更新纯函数（feed 解析 / 版本比较 / sha512 / 签名 URL / 安装计划）
- `endpoint.js`：更新线路选择纯函数（香港/深圳候选、探测排序、24h 缓存、env 覆盖、镜像 404 回退链）
- `update-verify.js`：更新包来源签名校验（ed25519 纯函数 + 内置公钥常量 + 三态决策 + 文案单源）
- `electron-builder.yml`：打包配置（图标自动由 build/icon.png 转换三平台格式）
- `build/icon.png` / `build/tray.png`：品牌图标（与 WebUI icon.svg 同款设计）
