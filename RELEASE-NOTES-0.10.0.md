# MingDao Harness v0.10.0 发布说明

> 状态：**待发布**（tag `v0.10.0`）
> 主题：**用户三项报障修复**——deb 更新真正可用 / 更新按地区自动选线路 / 缓存命中修正
> 性质：**minor**（deb 更新链路与线路选择属用户可见能力变化）
> 范围：`340c8f3`（deb 更新根因 + 线路选择）、`c096c0e`（缓存前缀稳定）、`514bc0d`（变异锚点）、
> `c582f23`（计划/根因记录）、`e4226b6`（状态栏口径 + 实测数字进文档）

---

## 1. 用户报障一：deb 自动更新"确认后没反应"

### 根因（代码级）

`desktop/main.js` 里所有弹窗走同一个封装：

```js
const show = (opts) => dialog.showMessageBox(mainWindow ?? undefined, opts).catch(() => ({ response: 1 }));
```

Electron 的签名是 `showMessageBox([browserWindow,] options)`。**`mainWindow` 为 null 时传 `undefined`，
Electron 会把 `undefined` 当成 options** → 抛错 → 被 `.catch` 吞成 `{ response: 1 }` →
而 `1` 在"下载并安装 / 稍后"这个对话框里**恰好等于「稍后」** → 流程静默终止，
日志只留一句"用户选择稍后"，界面上什么都没发生。

### 修复

| 项 | 修法 |
| --- | --- |
| 弹窗异常被吞 | 按有无父窗口分别调用；异常**记录日志并抛出**，不再伪装成"稍后" |
| 卡住要干等 5 分钟 | 新增 **30 秒空闲超时**（连续无数据即中止并提示"网络停滞"）+ `aborted`/`close` 处理 |
| 进度看不见 | 进度写进**窗口标题**（`正在下载更新 42%`），并在 `~/.mingdao/logs/desktop.log` 每整十百分比记一行；`setProgressBar` 保留（支持的桌面环境仍显示） |
| `pkexec` 不存在时静默失败 | 先 `which pkexec`，没有再走"手动安装"对话框（安装包路径 + `sudo dpkg -i <path>` + 官网链接） |
| 失败无证据 | 所有失败弹窗加**「打开日志」**按钮 |
| 无法定位阶段 | 每步日志带 `stage=feed|confirm|download|save|verify|sig|install` |

## 2. 用户报障二：更新/下载慢，且没有按地区选线路

此前 feed 与下载**固定走香港**，所谓"自动选线路"只在文档里、代码里没有实现。

新增 `desktop/endpoint.js`：

```
候选  香港 https://harness.mingdao.ai  /  深圳 https://harness.southdns.com
探测  各发一个极小 GET（/updates/latest.yml，3s 超时），比 TTFB
缓存  24h → app.getPath('userData')/endpoint.json
覆盖  MINGDAO_UPDATE_BASE 环境变量强制指定（排障）
回退  探测全失败 → 香港；深圳 403/404/410/DNS 失败 → 自动回退香港一次
```

应用于：deb feed、deb 安装包下载、`.sig` 下载、electron-updater 的 `setFeedURL`、"去官网下载"链接。
日志记 `endpoint=sz|hk probe=xxms`，反馈问题时可直接看出走了哪条线。

## 3. 用户报障三：缓存命中率低于 90%

### 真 bug

`schemaTier`（只读档收缩 + 已用工具剥描述）**默认开启**，而 WebUI 每回合重新 `createAgent()`，
把"已用工具"集合清零 → **工具 schema 在同一会话的回合边界反复翻转**。
而 tools 位于缓存前缀最前面 → 一翻转，整段历史按未命中价重计（命中价约 1/10）。

真实端点实测（非流式，请求间隔 5s）：**只换 tools、消息一字不差 → 命中 384/601 = 63.9%**，
比同一请求重复低 10.6 个百分点。

### 修复

- `schemaTier` 改为**显式开启**（默认 false）——省几百 schema token 远不够赔一次整段重算；
- 剥描述集合改为从**消息历史**派生（`usedToolNamesFromMessages`），不再依赖进程内 Set；
- 请求只发协议字段（`wireMessages`）：落盘补的本地 `ts` 不再出门，"发送时"与"下回合读回"字节一致；
- reasoning 裁剪抽成纯函数 `sanitizeReasoningContent()`（行为逐字不变，可断言同一输入同一字节）。

### 实测口径（重要，避免误判）

`scripts/measure-cache.mjs`（开发用，手动跑，6 次请求，几分钱）：

| prompt 大小 | 同一请求重复的命中率 |
| --- | --- |
| 687 token | 74.5% |
| 2728 token（MDH 真实 system+tools） | **93.8%** |
| **16129 token**（`--pad 20000`） | **99.2%**（未命中仅 134 token） |

**结论**：DeepSeek 侧存在一个**固定的未缓存尾段**（约 130~170 token，缓存单元粒度）。
它在 1~2K 的小 prompt 上占百分之十几，在 16K+ 会话里 <1%。
所以"命中率"这个数字**强依赖 prompt 大小**，用小会话比 20K 会话不公平——但**工具 schema 翻转是真 bug**，已修。

## 4. 状态栏口径诚实化

- 文案：`缓存命中 93.8%（120.0K/127.9K tok）`（百分比 + 绝对量）；
- tooltip：`命中/总 prompt。新会话首个请求、压缩后首轮、以及端点固定未缓存尾段（约 130~170 token）都会拉低它；16K 上下文实测 99.2%。`
- 省钱仪表盘里同一句话（`CACHE_HIT_TITLE` 单一来源）；
- **不改** `hit/(hit+miss)` 的计算公式，不伪造拿不到分母的"前缀复用率"。

## 5. 自验工具

```bash
node scripts/measure-cache.mjs              # 6 次请求，单次 ≤2000 token，几分钱
node scripts/measure-cache.mjs --full       # 用真实 home 的完整 system prompt
node scripts/measure-cache.mjs --pad 20000  # 撑到 ~16K token，验证固定尾段被稀释
node scripts/measure-cache.mjs --dry-run    # 只打印计划，不花钱
```

## 6. 门禁

`typecheck 0` / `strict 0` / `preflight ✓` / `smoke ✓`（私有 TMPDIR）/ `run-all` **59 套全绿** /
变异 **4 片 20 批全中** / `doc-lint ✓`。
新增 `test/cache-stability.js`（25 项）、`test/desktop-endpoint.js`（17 项）、`test/deb-update.js` 扩到 20 项。

## 7. 未验证边界（必须如实读）

- **`pkexec` / polkit 授权弹窗、真实 `dpkg -i` 安装、窗口标题进度可见性、深/港真实速度差异**，
  只能在 **Linux 桌面机人工验收**（CI 不安装系统包）。发布后请按 `docs/MANUAL-ACCEPTANCE-linux-deb.md` 逐条走一遍；
- 线路选择只影响**桌面端的更新/下载**；官网页面本身的下载按钮仍是香港直连（页面由 nginx 承载，不在本版范围）；
- 覆盖率闸门仍关闭（趋势参考）；
- 审计遗留的安全项（`permissions.js` 的 `su/pkexec/chroot` 包装前缀、软 deny 大小写、bash 沙箱降级披露、
  `permission=auto` 闸门）列为**下一版（v0.10.1）**，本版未动——不在这个版本里夹带安全改动，避免混因。
