# 桌面版自动更新：检查 → 下载 → 安装（实现文档）

> 面向**要把这套链路照搬到自己项目**的下游开发者。写的是本仓 v0.6.12 实际在跑的东西：
> 客户端（[desktop/main.js](../desktop/main.js)）、来源签名校验（[desktop/update-verify.js](../desktop/update-verify.js)）、
> 打包与清单（[desktop/electron-builder.yml](../desktop/electron-builder.yml)、[desktop/gen-update-yml.mjs](../desktop/gen-update-yml.mjs)）、
> 发布链路（`scripts/*` 与官网仓库 `MingDao-Harness-Site/scripts/*`）。
>
> 两条写作纪律：① 每条关键结论都指到 `文件:行号`，或给出实际命令/日志输出；② 读不出来、没验证过的，
> 明确写 **「未核实」**，不拿推测当结论。
>
> 前置阅读：[CODE-SIGNING.md](CODE-SIGNING.md)（代码签名 vs 来源签名）、[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)（发版步骤）；
> 本文只讲**自动更新**，不讲 macOS/Windows 的代码签名与公证。

---

## 0. 一句话结论

打包版**启动时检查一次**官网自托管的 generic feed（`https://harness.mingdao.ai/updates/latest*.yml`），
发现新版本就自动下载，下载完成后在「**下载完成 → 安装**」之间加了一道
**ed25519 来源签名门禁**（三态：`install` / `warn-and-install` / `reject`），
用户点「立即重启安装」才 `quitAndInstall()`；**当前发布链路还没有签名步骤**，
所以线上实际走的是默认档 `warn-and-install`（照装，但日志与 UI 明写「本次更新未验证来源签名」）。

关键文件与职责：

| 文件 | 职责 |
| --- | --- |
| [desktop/main.js](../desktop/main.js) | 主进程：`setupAutoUpdate()`（自动路径，484–622 行）、`checkUpdatesFromMenu()`（手动路径，362–441 行）、门禁接线 `verifyDownloadedUpdate()`（459–481 行） |
| [desktop/update-verify.js](../desktop/update-verify.js) | 纯函数：验签（144–181）、三态决策（189–195）、签名取材（206–240）、文案单源（247–291）、组合入口（298–345）、内置公钥常量（54–57） |
| [desktop/electron-builder.yml](../desktop/electron-builder.yml) | 打包与 feed 基址：`files` 白名单（24–30）、`extraResources`（31–49）、`publish`（57–59）、三平台 target（78–117） |
| [desktop/gen-update-yml.mjs](../desktop/gen-update-yml.mjs) | CI 侧清单改写（GitHub 渠道 url + `blockMapSize` 保留） |
| `MingDao-Harness-Site/scripts/*` | 官网侧：`gen-update-feeds.sh`（生成 `/updates/` 三份清单，mac 双 zip 合并）、`harvest-release.mjs`（Release → `downloads/`，sha256+size 双校验） |
| [scripts/update-sign.mjs](../scripts/update-sign.mjs) / [scripts/verify-release.mjs](../scripts/verify-release.mjs) | 发布侧签名工具（**尚未接入发布链路**）/ 四平台一致性验收（含「GitHub Release 附件数 > 0」） |

---

## 1. 一分钟总览

```
【打包】本地 / CI            【分发】GitHub Release         【feed】官网服务器            【客户端】打包版应用
──────────────────          ─────────────────────         ──────────────────          ──────────────────
sync-versions.mjs
 → desktop/package.json 版本
git tag vX.Y.Z → desktop.yml 三平台构建
   ├ nsis exe(+.blockmap) / dmg+zip×2(+.blockmap)
   ├ AppImage（块映射内嵌）/ deb
   └ gen-update-yml.mjs → latest.yml、latest-linux.yml（GitHub 直链）
                                      │
                                      │ harvest-release.mjs（sha256+size 双校验、指针文件强制覆盖）
                                      ▼
                                官网 downloads/<包>   ←── 官网下载页直连（国内）
                                      │ gen-update-feeds.sh
                                      ▼
                                官网 updates/latest*.yml  ←── 客户端读这一份（electron-builder.yml:57-59）
                                      │
                                      ▼
                     启动（仅 app.isPackaged）→ checkForUpdates()
                       ├ checking-for-update  ……（未订阅，见 §2.3）
                       ├ update-not-available → 日志
                       ├ update-available     → 日志 / deb 形态弹官网引导
                       ├ download-progress    → 日志（无进度条）
                       └ update-downloaded ──► ★来源签名门禁（ed25519 三态）
                              install / warn-and-install → 弹窗 →「立即重启安装」→ quitAndInstall()
                              reject → 关 autoInstallOnAppQuit + 拒绝弹窗
```

链路里**有三份"清单"**，别混：

| 位置 | 谁生成 | url 指向 | 谁在读 |
| --- | --- | --- | --- |
| GitHub Release 附件 `latest.yml` / `latest-linux.yml` | CI（[gen-update-yml.mjs](../desktop/gen-update-yml.mjs)） | GitHub Releases 直链 | 0.1.59 及更早的 GitHub 渠道安装（历史兼容） |
| 官网 `downloads/latest.yml`、`latest-linux.yml` | 收割 + 生成器 | 官网 `/downloads/` | 官网下载页旁边的"当前最新"指针（**客户端不读**） |
| 官网 `updates/latest*.yml` | `gen-update-feeds.sh` | 官网 `/downloads/` | **桌面版客户端读这一份** |

> 这三者不一致是本仓真实踩过的坑，见 §7 表第 6 行。

---

## 2. 客户端实现（desktop/main.js）

### 2.1 挂载点与开关

```js
// desktop/main.js:639-643
app.whenReady().then(() => {
  buildMenu();
  buildTray();
  createWindow().then(() => setupAutoUpdate());
});
```

- **只在打包版跑**：`setupAutoUpdate()` 第一行就是 `if (!app.isPackaged || process.env.MINGDAO_NO_AUTOUPDATE === '1') return;`
  （main.js:485）。开发态（`npm start`）不会连线上 feed，也不会把「自己」当成可更新对象。
- 关闭开关：`MINGDAO_NO_AUTOUPDATE=1`。手动路径（菜单）也认这个变量（main.js:364-367）。
- 更新日志与主日志同一个写入器：`appLog` → `userData/logs/mingdao.log`（main.js:51-52）。

### 2.2 启动时的一次检查

```js
// desktop/main.js:486-494
import('electron-updater')
  .then((updMod) => {
    const autoUpdater = updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod;
    if (!autoUpdater || typeof autoUpdater.on !== 'function') { appLog('updater 模块导出不可用，跳过自动更新'); return; }
    const LINUX_NO_APPIMAGE = process.platform === 'linux' && !process.env.APPIMAGE; // deb 安装形态
    autoUpdater.autoDownload = !LINUX_NO_APPIMAGE;
```

三个细节值得照抄：

1. **动态 import + 多级兜底解析**（main.js:486-492）：打包环境里 ESM 动态导入 CJS 的 `electron-updater`
   时命名导出可能缺失，`updMod?.autoUpdater ?? updMod?.default?.autoUpdater ?? updMod?.default ?? updMod`
   一路退；退不出来就写日志跳过，绝不抛。手动路径同样兜底，并额外校验 `checkForUpdates`/`once` 存在（main.js:379-383）。
2. **feed 地址不写在客户端**：`electron-builder.yml` 的 `publish` 会写进打包产物的 `resources/app-update.yml`，
   运行期由 electron-updater 读它（main.js:497-503 的启动日志只是让人在日志里看见 feed 与公钥状态）。
3. **deb 形态特殊处理**：`APPIMAGE` 环境变量缺失 = deb 安装，`autoDownload = false`，只检测不下载
   （main.js:493-494）。底层原因：AppImage 差分下载强依赖 `process.env.APPIMAGE`
   （`desktop/node_modules/electron-updater/out/AppImageUpdater.js:43-45`，缺了就抛 `ERR_UPDATER_OLD_FILE_NOT_FOUND`）。

启动日志同时把**信任根**打出来，便于事后核对（真机实例，取自本机
`~/Library/Application Support/mingdao-desktop/logs/mingdao.log`）：

```
2026-10-08T11:41:33.673Z 自动更新检查启动（feed: 官网 /updates；来源签名：默认档（无签名时警告后安装），
  内置公钥 keyId=d1e7bef80ca5d508，公钥来源=pinned）
```

### 2.3 事件处理逐条

electron-updater 的事件全集见 `desktop/node_modules/electron-updater/out/types.d.ts:42`：
`login / checking-for-update / update-available / update-not-available / update-cancelled / download-progress / update-downloaded / error`。

本客户端的订阅情况（**`checking-for-update` / `update-cancelled` / `login` 三条没订**：检查阶段没有 UI
反馈、靠 30 秒超时兜底，取消未处理，feed 是公开静态文件不需要鉴权）：

| 事件 | 是否订阅 | 位置 | 做了什么 |
| --- | --- | --- | --- |
| `error` | ✅ | main.js:507-535 | 落日志；判断是否瞬时网络错误 → 重试下载（§2.5）；否则弹「更新下载失败」+ 平台相关指引 |
| `update-not-available` | ✅ | main.js:536 | 只落日志 `updater 已是最新 <版本>`，**不弹窗**（自动路径不打扰用户） |
| `update-available` | ✅ | main.js:539-563 | 置 `updateSeen = true`（重试判据要用）；落日志；deb 形态弹「去官网下载」引导，其余只写一行「开始自动下载」 |
| `download-progress` | ✅ | main.js:564 | 只落日志 `updater 下载进度 N%` |
| `update-downloaded` | ✅（async） | main.js:565-618 | 走签名门禁 → 弹窗 → 用户确认 → `quitAndInstall()` |

`update-available` 回调里有本仓一次真实事故的修复痕迹（main.js:537-538 的注释）：打包环境下该事件的
`info` 参数曾为 `undefined`，旧代码 `info.version` 在监听器内抛 `TypeError`，**中断了 autoUpdater 的
事件派发，下载永不开始**。现在的纪律：**所有监听器一律 null-safe 且绝不抛错**（`String(info?.version ?? '?')`）。

### 2.4 进度与 UI 反馈

- **没有进度条**：`download-progress` 只写日志（main.js:564）。下载期间用户唯一的可见反馈是
  「发现新版本 v…，开始自动下载…」弹窗（手动路径）或什么都没有（自动路径）。下游若在意体验，
  把 `download-progress` 经 IPC 送到渲染层即可——先要扩 `preload.cjs` 那座桥（目前只暴露 `pickDirectory`/`isDesktop`，[desktop/preload.cjs](../desktop/preload.cjs):12-16）。
- 日志是排查的唯一入口，所以每条关键状态都落一行：检查启动、发现新版本、开始下载、进度、下载完成、
  来源校验结论、拒绝时"已关闭 autoInstallOnAppQuit"。
- **下载完成后上报一次统计信标**（main.js:588-594）：`POST https://harness.mingdao.ai/updok`，
  载荷 `{kind:'update', os, ver}`，不含任何用户标识；`MINGDAO_NO_TELEMETRY=1` 或 `config.json` 的
  `telemetry:false` 可关（main.js:22-31；README.md:268-274）。

### 2.5 网络错误与重试

```js
// desktop/main.js:507-519（节选）
autoUpdater.on('error', (err) => {
  const msg = String(err?.message || err);
  appLog('updater error ' + msg);
  if (!updateSeen) return;                       // 检查阶段的错误交给手动路径/重试，不在这里弹窗
  const netErr = /ERR_NETWORK|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ENOTFOUND|EPIPE|ECONNREFUSED/i.test(msg);
  if (!downloaded && netErr && downloadRetries < 2) {
    downloadRetries += 1;
    appLog(`updater 网络错误，5s 后自动重试下载（${downloadRetries}/2）`);
    setTimeout(() => autoUpdater.downloadUpdate().catch(() => {}), 5000);
    return;
  }
  …弹窗「更新下载失败」…
});
```

- 设计意图：切网 / VPN / 代理抖动（典型 `net::ERR_NETWORK_CHANGED`）大多重试一次就好，
  **最多 2 次、固定间隔 5s**，不去打扰用户；两次都失败或者不是网络错误，才弹窗（含平台指引：
  Linux 上出现 `ENOENT` 时提示"旧 AppImage 可能被移动/删除，请到官网手动装一次"，main.js:520-534）。
- `updateSeen` / `downloaded` 两个状态位就是为这段逻辑服务的（main.js:504-506）。
- **诚实备注（未核实到成功案例）**：`网络错误，5s 后自动重试下载（1/2）` 这行只存在于代码里（main.js:516）。
  本机真机日志里**搜不到这一行**（`grep -c` 为 0）；反倒能搜到 2026-10-04 的三条 `updater error 无法连接服务器。`
  ——那是 Chromium 的**本地化**文案，**不匹配**上面那条英文/技术串正则，所以那次没有走重试。下游若要靠重试
  兜住真实网络故障，建议**同时**看 `err.code`（如 `ERR_CONNECTION_REFUSED`）而不只看 `err.message`；
  **本仓未做，也未核实 Electron 是否在该错误对象上带 `code`**。
- 顺带一提：electron-updater 自己的元数据请求对 `ECONNREFUSED` 有 3 次重试
  （`desktop/node_modules/electron-updater/out/providers/GenericProvider.js:22-40`），
  所以"检查阶段"的抖动本来就有一次库内兜底。

### 2.6 门禁：下载完成 → 安装之间

```js
// desktop/main.js:565-580（节选）
autoUpdater.on('update-downloaded', async (info) => {
  downloaded = true;
  const v = String(info?.version ?? app.getVersion());
  appLog('updater 下载完成 ' + v);
  const gate = await verifyDownloadedUpdate(info);   // ← 来源签名门禁
  appLog(gate.logLine);
  if (gate.allowInstall === false) {
    autoUpdater.autoInstallOnAppQuit = false;        // ← 关键：拒绝必须覆盖"退出时安装"
    appLog('已关闭 autoInstallOnAppQuit：被拒绝的更新不得在退出时安装');
    dialog.showMessageBox(gate.notice).catch(() => {});
    return;
  }
  …弹窗 → 用户点「立即重启安装」→ quitAndInstall()…
});
```

`verifyDownloadedUpdate()`（main.js:459-481）只做四件事，判据全部委托给
[update-verify.js](../desktop/update-verify.js)（纯函数，可被 `test/smoke.js` §135 逐条钉边界）：

1. 从 `info` 里取签名载体：`info.signature` 或 `info.files[].signature` 是否存在（main.js:462-464）；
2. `collectUpdateSignature({filePath, inlineSignature, declaredSignature})` 取签名（main.js:467）；
3. `resolveUpdatePublicKeyPem()` 取**内置**公钥（main.js:471）——不从网络取；
4. `evaluateUpdate({...})` 得到 `decision` / `allowInstall` / `logLine` / `notice`（main.js:472-480）。

`info.downloadedFile` 是 electron-updater 真实提供的字段（`out/types.d.ts:34-36`、
`out/AppUpdater.js:593-596` 里事件载荷是 `{...updateInfo, downloadedFile: updateFile}`），
所以签名旁车文件能按"下载到本机的那份字节"来验。

### 2.7 安装与重启

- **时机**：只有用户在弹窗里点了「立即重启安装」（`r.response === 0`）才调用
  `autoUpdater.quitAndInstall()`（main.js:597-617）。
- **Linux AppImage 前置检查**：安装前确认 `process.env.APPIMAGE` 指向的文件仍然存在；
  不在就换成一条针对性提示，不调 `quitAndInstall()`（main.js:602-614）。这是历史事故的修复
  （旧 AppImage 被用户移动/删除后替换失败）。
- **`autoInstallOnAppQuit`**：electron-updater 默认 `true`（`out/AppUpdater.js:114`，install-on-quit 的
  实现在 `out/BaseUpdater.js:70-80`）。也就是说：**只要你不断开这个默认值，用户点「稍后」、退出应用时
  这个包照样会装上**。所以"拒绝"分支必须显式关掉它（main.js:575-576）；本项目在
  `warn-and-install` / `install` 两档下**保留默认 true**——即使用户点了「稍后」，退出时也会安装。
  这是有意的取舍（更新已经验过或已明示），下游若想改成"必须用户点才装"，就在非拒绝分支里也置 `false`。
- 安装后不重启渲染层：`quitAndInstall()` 会退出应用并由安装器接管（macOS 走 Squirrel.Mac 替换 .app）。

### 2.8 手动检查「检查更新」：如何避免"点了没反应"

菜单项 `帮助 → 检查更新`（main.js:168）调用 `checkUpdatesFromMenu()`（main.js:362-441）。
这段代码的**全部存在意义**是消灭"点了没反应"——审计时的根因是"依赖 autoUpdater 事件回调，
任何一步异常（导入失败 / 事件不触发 / 网络挂起）都被静默吞掉"。现在的七层兜底：

| # | 兜底 | 位置 |
| --- | --- | --- |
| 1 | 环境变量禁用时明确弹窗告知 | main.js:364-367 |
| 2 | deb 形态先弹"不支持自动更新，检测到新版会引导官网" | main.js:371-374 |
| 3 | 模块解析失败 / API 缺失 → 抛错进 catch → 弹「检查失败」 | main.js:379-383 |
| 4 | **30 秒超时**兜底：无响应也弹「检查超时」 | main.js:384-386 |
| 5 | 三个事件各自 `finish()` 一次性收口（`done` 标志防重复弹窗） | main.js:368-369、387-419 |
| 6 | `checkForUpdates()` 的 **promise 结果**再兜一次：事件没触发就按 `result.updateInfo.version` 判断 | main.js:420-430 |
| 7 | catch 里区分"启动时的检查还在跑"（`/progress|already|running/i`）→ 提示"正在检查，请稍候"而非报错 | main.js:431-440 |

弹窗文案都带当前版本号（`app.getVersion()`，main.js:370），deb 形态的"发现新版本"弹窗带
「去官网下载」按钮（main.js:400-417）。**注意**：手动路径**没有** `app.isPackaged` 判断
（只有自动路径有），所以开发态点菜单会真的去 import electron-updater；dev 下它找的是
`dev-app-update.yml`（`out/AppUpdater.js:155-161`），本仓没有这个文件，预期会抛错并被 catch 成
「检查失败」弹窗——**未在 dev 下实测点击，标注"未核实"**。下游若在意，加一行 `if (!app.isPackaged)` 即可。

---

## 3. 安全层次：HTTPS → sha512 → ed25519 来源签名

### 3.1 三层各防什么、不防什么

| 层 | 机制 | 防什么 | **不防什么** |
| --- | --- | --- | --- |
| ① 传输 | HTTPS（`https://harness.mingdao.ai/updates/`） | 被动窃听、路径上的简单篡改 | 服务器/CDN/DNS/证书任一被控后的**换源**；下发什么都照收 |
| ② 完整性 | 清单里的 `sha512`（electron-updater 自带，`out/DownloadedUpdateHelper.js:113-125`） | 传输损坏、下载被截断/改字节 | **同源替换**：清单与包都来自 feed，控制 feed 的人可以两边一起换（§3.2 有实测记录） |
| ③ 来源真实性 | **ed25519 签名 + 内置公钥 pin**（[update-verify.js](../desktop/update-verify.js)） | "这个包是不是持有官方私钥的一方签的"；攻击者换包/换源都造不出签名 | 签名**缺失**时的降级（§3.7）、回滚到旧版官方包（§3.7）、能改构建产物的人 |
| （另一件事） | macOS 代码签名 + 公证 / Windows Authenticode | 系统要不要信这个 App 的制作者（Gatekeeper/SmartScreen） | 与"更新源是否官方"无关；反过来也不替代来源签名。见 [CODE-SIGNING.md](CODE-SIGNING.md) 一~四节 |

### 3.2 威胁模型：为什么 sha512 挡不住投毒 feed

`sha512` 的比较对象是「**下载到的字节**」与「**同一份 feed 提供的** `latest*.yml` 里的 sha512」——
清单与包**同源**。攻击者只要控制了 DNS / 主机 / CDN / 证书中的任意一环（URL 一个字符都不用改），
就能同时替换包与该清单里的 sha512，校验照样通过；随后 `quitAndInstall()` 执行的是攻击者的安装包。

这不是推演，是本仓探针（未入库：`/tmp/probe-update-feed.mjs`；起本机 HTTP 服务扮演"被投毒的官网
`/updates`"，用 `module.registerHooks` 把 `electron`/`electron-updater` 换成桩，被测对象是**真实的**
`desktop/main.js`）实测过的，记录在 [AUDIT-v0.6.1-第三方报告登记.md](internal/AUDIT-v0.6.1-第三方报告登记.md):1563-1584：

| # | 场景 | 实测（修前） | 结论 |
| --- | --- | --- | --- |
| ① | 投毒 feed + 攻击者自己算的 sha512（恶意包 229,381 字节） | 下载 → sha512 **MATCH** → `quitAndInstall()` 被调用 | sha512 **不构成来源信任** |
| ② | 同一份投毒清单，只改包字节（传输损坏） | sha512 mismatch → 弹「更新下载失败」→ 不安装 | 那一层确实只防传输损坏，符合预期 |

修后同一探针的三态结果（③~⑦，含"攻击者用自己密钥签的包 → reject"与"用内置公钥签的包 → install"）
见同一文件 1573-1584 行。

### 3.3 三态决策（`decideUpdatePolicy`）

```js
// desktop/update-verify.js:189-195
export function decideUpdatePolicy({ hasSignature, verifyResult, requireSignature } = {}) {
  const signed = hasSignature === true;
  const required = requireSignature === true;
  if (!signed) return required ? 'reject' : 'warn-and-install';
  if (verifyResult && verifyResult.ok === true) return 'install';
  return 'reject';
}
```

| 情形 | 决策 | 行为 |
| --- | --- | --- |
| 有签名 + 验签通过 | `install` | 文案「更新包来源签名校验通过（ed25519 · keyId=…）」，正常安装（update-verify.js:263-274） |
| 有签名 + 验签失败 | `reject` | **一律拒绝**，无"忽略"选项；UI「更新包来源不可信，已拒绝」+ 官网手动下载引导（update-verify.js:250-261） |
| 有签名 + **拿不到校验结果** | `reject` | 「无法确认来源」不等于通过；声明了 `signature` 字段但内容为空也归这一档（update-verify.js:313-317） |
| 无签名 + 默认 | `warn-and-install` | 照装，但日志与 UI 都写明「**本次更新未验证来源签名**」（update-verify.js:276-290） |
| 无签名 + `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` | `reject` | fail-closed 开关（update-verify.js:73-75） |

决策是**纯函数**（只有三个入参），所以边界能被逐条钉死——`test/smoke.js` §135 直接调它，
包括"有签名但 `verifyResult` 为 null → reject"、"两个入参都缺省 → warn-and-install"
（test/smoke.js:12715-12719）。文案也走**同一个源** `buildUpdateNotice()`
（update-verify.js:247-291），避免"同一结论两处措辞"。

### 3.4 公钥 pin 与 keyId

```js
// desktop/update-verify.js:54-57
export const UPDATE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAH3hTAqAm8Lju/y49sIDxs8/QFZAxbMgo+0Q1en5GEyc=
-----END PUBLIC KEY-----
`;
```

- **运行期绝不从网络取公钥**（从网络取 = 没 pin：投毒 feed 可以连公钥一起换）。默认只认这个常量
  （`resolveUpdatePublicKeyPem()`，update-verify.js:66-70）；`MINGDAO_UPDATE_PUBKEY_PEM` +
  `MINGDAO_UPDATE_ALLOW_PUBKEY_OVERRIDE=1` 是**显式双开关**的开发/测试覆盖，只设前者不生效，
  **发布构建不得设置**（update-verify.js:59-69；smoke §135 有对应断言）。
- `keyId` = SPKI DER 的 sha256 前 16 位（update-verify.js:83-92，与 `src/ledger.js` 的账本来源签名同一约定，
  两处 keyId 可以直接互相认）。本机实算：`node -e "import('./desktop/update-verify.js').then(m=>console.log(m.keyIdOf(m.UPDATE_PUBLIC_KEY_PEM)))"`
  → `d1e7bef80ca5d508`，与 [CODE-SIGNING.md](CODE-SIGNING.md):131 记录、真机启动日志（§2.2）三处一致。
- **诚实标注**：这把公钥对应的私钥在本轮**未保留**（生成后即弃，从未写盘/打印，update-verify.js:44-53）。
  所以"验签通过"这条路径在当前发布链路下不会被走到；机制到位的是**判据 + fail-closed 能力**，
  以及"任何**别人**签的包一律验不过 → reject"。
- 换密钥 = 所有旧签名失效、所有旧客户端拒绝新包（内置公钥还是旧的那把）。这是非对称 pin 的固有代价，
  处置见 [CODE-SIGNING.md](CODE-SIGNING.md) §5.4。

### 3.5 签名覆盖范围：产物字节，不是清单

```js
// scripts/update-sign.mjs:120-123
const bytes = fs.readFileSync(file);
const signature = crypto.sign(null, bytes, privateKey).toString('base64');
const sigFile = file + '.sig';
fs.writeFileSync(sigFile, signature + '\n');
```

- 签名对象是**安装包的原始字节**（ed25519，`crypto.sign(null, bytes, key)`，与 `src/ledger.js` 的
  封条签名同一写法）；客户端用 `crypto.verify(null, data, key, sig)` 验（update-verify.js:175）。
  **清单本身没有被签名**——`latest*.yml` 的 `sha512` 属于第 ② 层，不提供来源保证。
- 签名**载体**（客户端按优先级取材，update-verify.js:206-240）：

  | 优先级 | 载体 | 说明 |
  | --- | --- | --- |
  | ① | `latest*.yml` 内嵌 `signature:` 字段 | 面向未来。**未在真实 feed 上端到端验证**——从 6.8.9 的实现看 `update-downloaded` 的载荷是 `{...updateInfo, downloadedFile}`（`out/AppUpdater.js:593-596`），未知字段理论会透传；[CODE-SIGNING.md](CODE-SIGNING.md) §5.5 的记录是"未对真实库验证" |
  | ② | 本机旁车 `<下载到的文件>.sig` | 离线包/自签包/测试用（update-verify.js:125-137） |
  | ③ | feed 目录同名 `<包名>.sig`（HTTPS 取公开数据，8 秒超时） | **发布侧正式载体**（update-verify.js:220-237） |

  旁车名的来源是「下载到本机的那份文件的名字」，而 electron-updater 的缓存文件名取
  **URL 的 basename**（`out/AppUpdater.js:573-583`）。所以：**feed 里的 `url` 必须直接指向真实文件名**
  （本项目是 `https://harness.mingdao.ai/downloads/mingdao-setup-0.6.12-x64.exe`），
  不要用 `/download?id=…` 这类重定向式 URL，否则 `<包名>.sig` 对不上。
- 发布侧 `--sign` 还会打印 sha512，要求与 `latest*.yml` 里的 sha512 **逐字一致**（update-sign.mjs:124-129）——这是"签对了文件"的交叉自证。

### 3.6 为什么无签名时**默认放行**而不是拒绝

理由写死在源码注释里（update-verify.js:24-30），也是本轮的正式取舍：

- 当前发布链路**还没有签名步骤**，线上 feed 里没有 `.sig`（§3.7 有实测命令）。若默认 reject，
  等于**一夜之间掐死所有存量用户的自动更新**；
- 威胁模型里"官网 feed 被投毒"是**低概率高影响**，"更新永远装不上"是**必然发生**；
- 所以默认放行但**把话说清楚**：日志与 UI 都写「本次更新未验证来源签名」，
  并告诉用户高安全场景可以设 `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1`（update-verify.js:281-286）。

真机日志里可以看到默认档确实在真实升级中执行过（v0.6.11 → v0.6.12）：

```
2026-10-08T11:40:25.940Z 更新来源校验：**本次更新未验证来源签名**（feed 未提供来源签名（或签名不可得），
  签名来源=无）→ 按默认档放行（可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 改为拒绝）
```

**怎么改成强制**（下游动作清单）：① 发布链路接入签名（§5 步骤 8、§6.3）；② 客户端设
`MINGDAO_REQUIRE_UPDATE_SIGNATURE=1`，或把 `decideUpdatePolicy` 的默认档改成 `reject`
（一行，判据与文案不用动，update-verify.js:189-195）；③ 注意**旧客户端无法验新密钥**——
换密钥/收紧默认档之前，必须先发一版带新公钥的包（[CODE-SIGNING.md](CODE-SIGNING.md) §5.4）。

### 3.7 尚未关闭的缺口（如实）

1. **签名被剥离 = 降级**。控制 feed 的攻击者可以**删掉** `.sig`，把这次更新降级成"无签名"→ 默认档下
   仍然 `warn-and-install`。客户端无法区分"本来没签"与"签名被剥离"（update-verify.js:32-34）。
   真正关闭它必须"发布链路每次都签 + 客户端 REQUIRE=1"。
2. **签名不绑定版本号/包名**（回滚攻击面）。签名对象是裸字节（update-sign.mjs:121），
   `evaluateUpdate` 也不校验"签名对应的版本"。理论上控制 feed 的一方可以把**更高版本号**写进清单，
   却让 `url` 指向一份**旧的、官方签过名的**安装包 + 它对应的旧 `.sig`——验签会通过。
   electron-updater 自身只拦"清单版本号 ≤ 当前版本"（`out/AppUpdater.js:340-358`），而清单可被篡改。
   **本仓未做防回滚（未在签名里绑定版本/时间戳），也未对这条路径做实测**——标注为**未核实**的推断。
3. **发布链路未接签名**（见 §5 步骤 8、§8）：线上 `/updates/*.sig` 目前**不存在**，实测
   `curl -sS https://harness.mingdao.ai/updates/mingdao-setup-0.6.12-x64.exe.sig` 返回的是
   **官网首页 HTML**（`HTTP/2 200`、`content-type: text/html`、68630 字节、正文以 `<!doctype html>` 开头，
   即站点把缺失路径回落成了 SPA 首页，而不是 404）。客户端会把这段 HTML 判为"签名不可用"
   （`parseSignatureText` 第一行不是合法 base64 → 失败，update-verify.js:100-113），
   于是走默认档——**行为上安全，但掩盖了 404**。下游部署 feed 时，建议让缺失文件**真的返回 404**，
   别回落到 HTML。
4. **不含**密钥吊销 / 多密钥并存 / 灰度发布（见 §8）。

---

## 4. 清单与差量更新

### 4.1 三平台差异

| 平台 | target | 自动更新 | 客户端读的清单 | 差量素材 |
| --- | --- | --- | --- | --- |
| Windows | `nsis`（electron-builder.yml:78-88） | ✅ | `latest.yml` | **独立文件** `<exe>.blockmap` |
| macOS | `dmg` + `zip`（electron-builder.yml:90-104） | ✅（**必须 zip**） | `latest-mac.yml`（两个架构的 zip 合并成一份） | **独立文件** `<zip>.blockmap` |
| Linux | `AppImage` + `deb`（electron-builder.yml:106-117） | 仅 AppImage ✅；deb ❌（引导官网） | `latest-linux.yml` | **内嵌在 AppImage 尾部**，清单里必须写 `blockMapSize` |

清单文件名由 electron-updater 按平台拼：`<channel><平台后缀>.yml`，平台后缀 linux → `-linux`、
darwin → `-mac`、其余为空（`out/providers/Provider.js:33-48`、`out/util.js:30-32`）。
⚠ **未核实**：该后缀在非 x64 架构上还会追加 `-<arch>`（`Provider.js:34-38`）——也就是说 Linux arm64 会去读
`latest-linux-arm64.yml`，而本项目只生成 x64 的 `latest-linux.yml`；**未在 arm64 Linux 上验证过实际行为**。

### 4.2 `latest*.yml` 的字段

线上真实 feed（`curl https://harness.mingdao.ai/updates/latest.yml`，2026-10-08 实取）：

```yaml
version: 0.6.12
files:
  - url: https://harness.mingdao.ai/downloads/mingdao-setup-0.6.12-x64.exe
    sha512: kMHOvbXOfAgo4clXHmV/0hZ28KVKIm/wEA/adp2zi801UC86FYJeyoXfcSn872r/aHLH0c4Socej5My5kfKALQ==
    size: 80002028
path: mingdao-setup-0.6.12-x64.exe
sha512: kMHOvbXOfAgo4clXHmV/0hZ28KVKIm/wEA/adp2zi801UC86FYJeyoXfcSn872r/aHLH0c4Socej5My5kfKALQ==
releaseDate: "2026-10-08T10:09:52.000Z"
```

`latest-linux.yml` 多一个字段（同次实取）：`blockMapSize: 115489`。
`latest-mac.yml` 的 `files[]` 是**两条**（arm64 + x64 的 zip），`path`/顶层 `sha512` 指向 arm64 那条：
`MingDao.Harness-0.6.12-arm64-mac.zip`（93,803,516 字节）与 `MingDao.Harness-0.6.12-mac.zip`（101,325,026 字节），
url 都是 `https://harness.mingdao.ai/downloads/<文件名>`。

| 字段 | 含义 | 备注 |
| --- | --- | --- |
| `version` | 新版本号（semver） | electron-updater 用它比对当前版本（`out/AppUpdater.js:340-358`） |
| `files[].url` | 安装包**直链** | 本项目用官网 `/downloads/` 直链（国内快）；CI 版清单指向 GitHub Releases |
| `files[].sha512` | **base64** 的 sha512 | 不是 sha256；GitHub Release 给的是 sha256，**不能直接用**（gen-update-feeds.sh:18） |
| `files[].size` | 字节数 | 差分/进度用 |
| `files[].blockMapSize` | **仅 AppImage**：内嵌块映射长度 | 缺了只影响"是否整包重下"，不影响更新成功 |
| `path` + 顶层 `sha512` | 旧式单文件写法 | electron-updater 两处都读（`getFileList()`，`out/providers/Provider.js:104-120`），所以两份都要写 |

### 4.3 blockmap 与差量更新

- **命中条件**（三件都满足才差量，否则静默回退整包下载——这正是"隐性退化"的来源）：
  1. 本机缓存里有**上一版**的安装包（`out/AppUpdater.js:669-676` 用缓存目录里的旧文件）；
  2. 服务器上能找到**新版**的 `.blockmap`（<安装包 URL>.blockmap）；
  3. 服务器上还能找到**旧版**的 `.blockmap`——electron-updater 是把新版 URL 里的版本号**替换成当前版本号**
     再取（`out/providers/Provider.js:22-26`）。
     ⇒ **别清理历史版本的 `.blockmap`**。GitHub 渠道还有 `previousBlockmapBaseUrlOverride` 之类的绕法
     （`out/AppUpdater.js:162-169` 注释：GitHub 拿不到旧 release 的 blockmap），本项目用官网直链，不需要。
- **两种实现**：
  - Windows NSIS / macOS zip：读独立的 `<包>.blockmap`（`out/AppUpdater.js:645-676`）；
  - Linux AppImage：块映射**内嵌在文件尾部**，偏移 = `size - (blockMapSize + 4)`，末尾 4 字节是大端
    uint32 的长度（`out/differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js:9-12`；
    `out/AppImageUpdater.js:47-65`）。
- **实测素材**（2026-10-08，官网 `downloads/`）：
  `mingdao-setup-0.6.12-x64.exe.blockmap` = 84,955 字节；
  `MingDao.Harness-0.6.12-arm64-mac.zip.blockmap` = 99,345 字节；
  `latest-linux.yml` 的 `blockMapSize = 115489`。
- **收益别吹**：差分要"本机有上一版安装包 + 服务器有上一版块映射"，手工下载安装的用户没有缓存，
  仍然整包下载。本仓 0.6.1 及以前从未发布过 `.blockmap`，第一个真正吃到差分的是 **v0.6.2 → v0.6.3**
  一路自动更新上来的用户（RELEASE-CHECKLIST.md:330-333）。

### 4.4 两份生成器的分工

**CI 侧** [desktop/gen-update-yml.mjs](../desktop/gen-update-yml.mjs)（打包后跑，产物在 `dist/`）：

- 只做 Windows/Linux，macOS 直接跳过（"双架构合并版由官网发布流程在服务器生成"，:60-61）；
- 把 electron-builder 自己写的 `latest*.yml` **改写**成 GitHub 渠道 url（:14、:45-52）；
- 改写前先把 `blockMapSize` **读出来**再写回——否则覆盖即丢字段，这正是 v0.6.0 及以前
  Linux 差分一直不工作的原因（:33-43，注释里写明了）。

**服务器侧** `MingDao-Harness-Site/scripts/gen-update-feeds.sh`（发布流程最后一步）：

- 生成三份清单到 `/updates/`，url 用**官网直链**（:76-107）；
- 生成前先备份旧清单（:53-55），并**先确认 4 个安装包都在**，缺一个就退出非 0（:42-50）；
- AppImage 的 `blockMapSize` 用 python3 现场从文件尾部解出并**就地校验**（能 inflate 出 JSON 才算数，
  否则返回空 → 不写该字段 → 回退整包下载，绝不写一个假值，:60-73）；
- macOS 把两个 zip 合并成一份 `latest-mac.yml`（:94-107）；
- 结尾打印「差量更新可用性」自查，缺 `.blockmap` 只告警不中断（:115-129）——
  因为"缺差分素材"不影响更新能否成功，只影响体积。

---

## 5. 发布流程（可复制的步骤清单）

> 权威清单是 [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)；这里只抽**与自动更新相关**的步骤，并标出每一步"漏了会怎样"。命令里的 `<版本>` 形如 `0.6.12`。

**① 版本号同步（打包前）**

```bash
node scripts/sync-versions.mjs     # 根 package.json → desktop/package.json（scripts/sync-versions.mjs:8-16）
```

`app.getVersion()` 读的是 desktop 的版本号，不同步就会出现"包是新的、版本号还是旧的"。
CI 在构建前自动跑（[.github/workflows/desktop.yml](../.github/workflows/desktop.yml):55-57）。

**② 打 tag 触发三平台构建**

```bash
git tag v<版本> && git push origin v<版本>
```

`desktop.yml` 在三平台构建（matrix：`--linux AppImage deb` / `--win nsis` / `--mac dmg zip --x64` 与
`--mac dmg zip`，:24-38），Linux 腿还会跑打包冒烟 `MINGDAO_DESKTOP_SMOKE=1`（:79-87，
用途是拦"打包后模块求值失败"这类只在产物里炸的问题），然后
`node gen-update-yml.mjs`（:88-90）、上传工件（含 `*.blockmap`，:91-108）。

**③ GitHub Release（附件 = 官网收割源）**

`publish` 作业用 `gh release create/upload` 上传 `AppImage/deb/exe/dmg/zip/blockmap/latest.yml/latest-linux.yml`，
**明确排除** `latest-mac.yml` 与 `builder-debug.yml`（:148-152）；已存在的 Release 先清空旧资产再整批覆盖（:154-165）。

**④ 收割到官网 `downloads/`**

```bash
# 服务器侧（token 经 stdin 落地再删，不进 argv）
node harvest-release.mjs <版本> /opt/1panel/www/sites/mingdao-site/downloads
```

`harvest-release.mjs` 的纪律：只采 `exe|dmg|zip|AppImage|deb|blockmap` 与 `latest(-linux).yml`，
跳过 `latest-mac.yml`（由 ⑤ 在服务器上合成）；每个文件按 GitHub 的 sha256 + size **双校验**，
不符即删并**退出非 0**（:118-136、:158-161）；末尾打印差量素材自查（:138-154）。

**⑤ 生成 feed（服务器侧，最后一步，最容易漏）**

```bash
bash gen-update-feeds.sh <版本> <downloads 目录> <updates 目录> https://harness.mingdao.ai/downloads
```

**⑥ 验收（三个平台各自取 feed）**

```bash
for f in latest.yml latest-linux.yml latest-mac.yml; do
  curl -s "https://harness.mingdao.ai/updates/$f?ts=$(date +%s)" | head -3
done
grep blockMapSize /opt/.../updates/latest-linux.yml      # Linux 差分是否就绪
```

判据：三份的 `version` 都是新版本；每份 `files[].url` 指向的包**真实存在**且能被下载；
mac 那份指向的是 **zip** 而不是 dmg。

**⑦ 四平台一致性验收（防半发布）**

```bash
node scripts/verify-release.mjs <版本>       # 任一缺失即非 0 退出
```

它除了比 main/tag SHA 与 npm，还会判「GitHub Release 的**附件数 > 0**」（verify-release.mjs:154-161）
——附件为 0 的 Release 是"存在但没法下载/收割"的半成品。

**⑧ 签名（当前未接入，接入后追加）**

```bash
node scripts/update-sign.mjs --keygen --out ~/.mingdao/update-signing   # 仅一次；只打印公钥
#   公钥 PEM 贴进 desktop/update-verify.js 的 UPDATE_PUBLIC_KEY_PEM
node scripts/update-sign.mjs --sign <安装包>        # 产出 <安装包>.sig，与包同目录上传到 feed 目录
node scripts/update-sign.mjs --verify <安装包> --pub update-signing-pub.pem   # 与客户端同一实现自检
```

发布链路目前**没有**这一步（`gen-update-feeds.sh` 与 `harvest-release.mjs` 都不产出 `.sig`），
所以线上仍是 `warn-and-install`（§3.7 第 3 条有 curl 实测）。

### 5.1 指针文件必须**每次覆盖**（本项目踩过）

`latest*.yml` 是**不带版本号**的"当前最新"指针，体积都只有几百字节。`harvest-release.mjs` 的幂等判据是
"已存在且体积一致就跳过"——两个版本的 `latest.yml` 体积恰好相同时，新版本就被跳过了：

> 线上 `/downloads/latest.yml` 自 **v0.6.1 起再没更新过**（v0.6.4/0.6.5 依次"跳过"，无人察觉）。
> —— [docs/internal/AUDIT-v0.6.1-第三方报告登记.md](internal/AUDIT-v0.6.1-第三方报告登记.md):1214

修法在 `harvest-release.mjs:94-109`：**指针类文件（`latest(-linux).yml`）一律覆盖**，代价几百字节；
其余安装包仍按 size 幂等；下游照抄时把所有"不带版本号的文件名"都列进这个例外表。

### 5.2 CDN / 缓存注意（本项目踩过）

GitHub 的 `releases/tags/<tag>` 端点会被 CDN 缓存住：Release 刚由工作流创建、附件确实已上传
（`releases/<id>/assets` 能列出十几个），该端点仍可能返回**创建瞬间的空 `assets`**。后果是门禁被骗：
收割脚本报「没有可采集的附件」、`verify-release.mjs` 把无法下载的 Release 判成 ✓。
修法：**加 cache-buster `?ts=<时间戳>`**，仍为空则**按 release id 直连 `releases/<id>/assets` 复核**
（`harvest-release.mjs:44-55、63-79`；`verify-release.mjs:147-153`；`update-downloads.mjs:63-72`）。
教训：**"读不到"与"没有"必须分开**，判据要对着"我们真正在意的那件事"写
（在意的是"它是这个版本的、且能被下载"，不是"接口返回 200"）。

---

## 6. 下游落地清单

### 6.1 要照抄的

| 项 | 照抄对象 | 为什么 |
| --- | --- | --- |
| 客户端事件接线 + 状态位 | main.js:504-619 | `updateSeen`/`downloaded`/`downloadRetries` 三个位决定重试与弹窗行为 |
| 模块解析多级兜底 | main.js:379-383、486-492 | 打包环境 ESM→CJS 命名导出缺失是真事（"reading 'once'" 报错根因） |
| 监听器 null-safe | main.js:537-542 | 一个 `info.version` 就能中断事件派发、让下载永不开始 |
| 手动检查的多层兜底 | main.js:362-441 | "点了没反应"是这类功能最常见的投诉 |
| 三态判据 + 文案单源 | [update-verify.js](../desktop/update-verify.js):189-195、247-291 | 纯函数才能被逐条钉边界；文案也是契约 |
| 拒绝时关 `autoInstallOnAppQuit` | main.js:573-576 | 不关就等于没拒绝 |
| 下载前/安装前的平台检查 | main.js:493-494、602-614 | deb 不能自更新；AppImage 被移走会 ENOENT |
| 指针文件强制覆盖 + cache-buster | `harvest-release.mjs:44-109` | 幂等判据写太宽会静默停更；门禁自己被骗比没有门禁更糟 |

### 6.2 要改的（换成你自己的）

| 项 | 现在 | 你要改成 |
| --- | --- | --- |
| feed 基址 | `https://harness.mingdao.ai/updates/`（electron-builder.yml:57-59） | 你的域名；**同步改** `desktop/update-verify.js` 的 `UPDATE_FEED_BASE`（update-verify.js:42）——两处必须同源 |
| 公钥 | 内置常量 `UPDATE_PUBLIC_KEY_PEM`（update-verify.js:54-57） | `node scripts/update-sign.mjs --keygen --out <离线目录>` 生成后贴公钥；私钥离线/CI secret，**绝不入库** |
| 包名 / appId / 图标 | `com.mingdao.harness`、`MingDao Harness`（electron-builder.yml:4-5） | 你的；icon 相关的 `files` 白名单要跟着改 |
| 三平台 target | nsis / dmg+zip / AppImage+deb（:78-117） | 按需裁剪；**macOS 千万别去掉 zip** |
| 公证 | `notarize.teamId: 3VZLHJCG48`（:103-104） | 你的 Team ID（或整段删掉） |
| 遥测信标 | `POST /updok`（main.js:588-594） | 删掉，或换成你自己的统计端点（注意隐私说明与关闭开关） |
| 手动下载引导 | `https://harness.mingdao.ai/#downloads` | 你的下载页 |

### 6.3 最小可行版本（不做签名也能跑）

按 §6.1 + §6.2 改完、按 §5 走完发布流程，**不接签名**也能获得完整的"检查 → 下载 → 安装"体验：

- 安全上只剩 HTTPS + sha512 两层（§3.1）——**知道风险再决定**：能防传输损坏，防不住"换发布源"；
- 客户端会走 `warn-and-install`，UI 与日志每次都会提示"未验证来源签名"——这是**如实告知**，不是 bug；
- 想收口时再接签名：生成密钥 → 贴公钥 → 每次发版 `--sign` → `.sig` 与包同目录上传 → 客户端
  `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1`。判据早已就位，不用改逻辑。

---

## 7. 本项目踩过的坑

| # | 现象 | 根因 | 修法 / 教训 | 证据 |
| --- | --- | --- | --- | --- |
| 1 | 打包版启动即报 `Unable to load preload script: …/app.asar/preload.cjs` + `ENOENT`，原生「选择目录」静默降级成手输路径 | `electron-builder.yml` 的 `files` 是**穷举白名单**（给了 `files` 就不再套默认 `**/*`），v0.6.10 漏了 `preload.cjs` | 白名单补 `preload.cjs`（electron-builder.yml:24-30）；加结构守卫 `test/smoke.js` §138（smoke.js:13390-13406） | 真机日志原样：`[renderer] Unable to load preload script: /Applications/MingDao Harness.app/Contents/Resources/app.asar/preload.cjs`、`Error: ENOENT, preload.cjs not found in …/app.asar`（2026-10-04，`mingdao-desktop/logs/mingdao.log`） |
| 2 | 同一次把 `update-verify.js` 也漏了 | main.js **顶部静态 import** 它（main.js:15）——静态 import 的模块不在 `files` 里，打包版主进程**直接 `ERR_MODULE_NOT_FOUND` 起不来**（不是降级，是打不开） | 与 preload 一起补进白名单，并在注释里写明"同一个齿根"（electron-builder.yml:21-23）；产物级验证**未做**（只做了配置级守卫） | 代码位置如上；产物级验证标注**未核实** |
| 3 | 官网 `/downloads/latest.yml` 自 v0.6.1 起再没更新过，连续三个版本无人察觉 | 幂等判据"已存在且体积一致就跳过"，而指针文件不带版本号、体积都是几百字节 | 指针类文件一律覆盖（`harvest-release.mjs:94-109`） | AUDIT 登记表 1214 行 |
| 4 | 附件明明齐了，收割/校验却报"没有可采集的附件"，把人引去查 CI | `releases/tags/<tag>` 被 GitHub CDN 缓存成"刚创建时的空 assets" | 加 `?ts=` 破缓存 + 按 release id 走 `releases/<id>/assets` 兜底；`verify-release.mjs` 把"附件 0 个"改判**失败** | AUDIT 登记表 1212 行；`harvest-release.mjs:63-79`、`verify-release.mjs:147-161` |
| 5 | mac 用户更新报 `ZIP file not provided` | `latest-mac.yml` 指向了 **dmg**；electron-updater 在 macOS 必须下 zip 解包替换 .app | feed 生成器改用两个 zip 合并（`gen-update-feeds.sh:44-46、94-107`）；`electron-builder.yml:90-93` 显式保留 zip target | 库内判据：`out/MacUpdater.js:81-84` 在 files 里找不到 zip 就抛这个错。该错误在 0.4.5 的 feed 里就存在，说明"服务器侧手工生成 mac feed"长期没人写对（RELEASE-CHECKLIST.md:245-249） |
| 6 | 应用永远认为"已是最新"，桌面版无法在线更新 | feed 被收割到了 `/downloads/`，而客户端读的是官网 **`/updates/`**（electron-builder.yml:57-59）；两者格式也不同（直链 vs 官网直链） | 目录职责钉死：`/downloads/` 供下载页与 feed 里的 url，`/updates/` 只放清单（RELEASE-CHECKLIST.md:239-241） | RELEASE-CHECKLIST.md §3.0 ① |
| 7 | 三平台自动更新**每次都整包重下**（exe 76MB / mac zip 93–101MB / AppImage 104MB），且不报错 | CI 产物 glob 与 Release 上传都没有 `*.blockmap`；自研 feed 生成器也没写 `blockMapSize` | ① 上传/收割加 `.blockmap`；② feed 生成器补 `blockMapSize`（AppImage）；③ CI 改写清单前先把 builder 写的 `blockMapSize` 读出来再写回 | RELEASE-CHECKLIST.md:292-306（三平台机制对照表）；`gen-update-yml.mjs:33-43` |
| 8 | 客户端每次更新都提示"未验证来源签名" | 发布链路还没有签名步骤（`gen-update-yml.mjs` 与服务器脚本都不产出 `.sig`） | 机制先到位、默认档放行 + 如实告知；接入签名后设 `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` 或改默认档 | §3.6 的真机日志；`curl https://harness.mingdao.ai/updates/mingdao-setup-0.6.12-x64.exe.sig` 返回首页 HTML（200/text/html/68630 字节） |
| 9 | 真机网络抖动（`updater error 无法连接服务器。`）没有触发自动重试 | 重试判据只匹配英文/技术串（main.js:513），而 Chromium 的网络错误 `message` 是**本地化**文案；`err.code` 没被利用 | 未修（本仓现状）：日志里没有 `网络错误，5s 后自动重试下载（N/2）` 这行；下游建议同时看 `err.code` | `mingdao-desktop/logs/mingdao.log` 2026-10-04T06:47:48–49 三行；该判据是否带 `code` **未核实** |
| 10 | 开发态（未打包）点菜单「检查更新」会真的去连 feed | 自动路径有 `app.isPackaged` 拦（main.js:485），手动路径**只有** `MINGDAO_NO_AUTOUPDATE` 开关（main.js:364） | 未修；dev 下 electron-updater 找的是 `dev-app-update.yml`（`out/AppUpdater.js:155-161`），本仓没有该文件，预期抛错→被 catch 成「检查失败」弹窗 | **未在 dev 下实测点击**，标注**未核实** |
| 11 | feed 目录里缺 `.sig` 时，服务器回落到 SPA 首页（200 + HTML），而不是 404 | 站点配置（openresty）对未知路径回落首页 | 客户端行为上安全（HTML 解析不出 base64 → 判"签名不可用"→ 默认档）；但**掩盖了 404**，下游部署时应让缺失文件真返回 404 | §3.7 第 3 条的 curl 实录 |

---

## 8. 已知边界与未做（如实）

1. **没有真机"点击安装 → 重启成新版"的端到端实测记录**。本机日志能证明到"下载完成 + 来源校验结论 +
   弹窗"，成功走过 `quitAndInstall()` 并核验新版本号的现场证据**未核实**。
   `RELEASE-NOTES-0.6.11.md` 也把"Electron 真机点击未验证"列为已知边界。
2. **签名未接入发布链路**：线上 feed 无 `.sig`，实际走 `warn-and-install`（§3.7 第 3 条）。
   因此"有签名 + 验签通过 → install"这条路径**只在单测/探针里跑过**，没在真实 feed 上跑过。
3. **清单内嵌 `signature:` 字段这一载体未端到端验证**（只验证了旁车 `.sig` 与本机 `.sig`）。
4. **没有差分/回滚/灰度**：
   - 未做"签名绑定版本号"的防回滚（§3.7 第 2 条）；
   - 未做灰度/分批放量（electron-updater 支持 `stagingPercentage`，本仓未用）；
   - 无降级通道（`allowDowngrade` 未开启）。
5. **没有周期性检查**：只在启动时检查一次（main.js:619 是唯一的 `checkForUpdates()` 调用，
   全文没有 `setInterval`）。长时间挂着的应用要手动点菜单。
6. **deb 不支持自动更新**：只提示并引导官网（main.js:371-374、543-561）。
7. **Linux arm64 的 feed 文件名问题未核实**（§4.1 的 ⚠）。
8. **进度没有 UI**：只有日志（§2.4）；`preload.cjs` 当前没有进度通道。
9. **信任模型不含"能改构建产物的人"**：私钥与构建机同权时来源签名不防内鬼，它防的是**发布源被换**
   （update-verify.js:12-16）；也**未做密钥吊销 / 多密钥并存**——换密钥 = 所有旧签名失效、旧客户端拒绝新包
   （[CODE-SIGNING.md](CODE-SIGNING.md) §5.4/§5.5）。

---

## 附：本文证据的可复现命令

```bash
# 内置公钥指纹（应与启动日志里的 keyId 一致）→ d1e7bef80ca5d508
node -e "import('./desktop/update-verify.js').then(m=>console.log(m.keyIdOf(m.UPDATE_PUBLIC_KEY_PEM)))"

# 线上三份清单；以及"签名是否已上线"（当前返回首页 HTML = 未上线，见 §3.7 第 3 条）
for f in latest.yml latest-linux.yml latest-mac.yml; do
  curl -sS "https://harness.mingdao.ai/updates/$f?ts=$(date +%s)" | head -12; echo ---; done
curl -sS -D - -o /dev/null https://harness.mingdao.ai/updates/mingdao-setup-0.6.12-x64.exe.sig | head -5

# 差量素材是否在（Windows/mac 是独立文件；AppImage 看清单里的 blockMapSize）
curl -sS -D - -o /dev/null https://harness.mingdao.ai/downloads/mingdao-setup-0.6.12-x64.exe.blockmap | head -5

# 客户端视角的日志（macOS）与边界断言
grep -nE "自动更新检查启动|更新来源校验|updater |autoInstallOnAppQuit" \
  ~/Library/Application\ Support/mingdao-desktop/logs/mingdao.log | tail -30
node test/smoke.js      # §135 更新来源签名、§138 打包 files 白名单守卫
```

相关文档：[CODE-SIGNING.md](CODE-SIGNING.md)（代码签名 + §五 更新包来源签名）、
[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)（发版清单 §3.0 已暴露的流程缺口）、
[ARCHITECTURE.md](ARCHITECTURE.md)（内核架构）、
[docs/internal/AUDIT-v0.6.1-第三方报告登记.md](internal/AUDIT-v0.6.1-第三方报告登记.md) §3.40.1 / §3.47（两处现场记录）。
