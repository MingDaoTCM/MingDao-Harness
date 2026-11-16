# v0.10.0 修复与迭代记录（用户三项报障）

> 基线：v0.9.1（`aaa9090`）
> 用户报障：① Linux deb 自动更新"确认后没反应"；② 桌面更新/下载慢，且没有按地区自动选线路；
> ③ 缓存命中率低于 90%（DeepSeek Harness 在 99.5% 以上），与"省钱"卖点不符。
> 状态：**已修复，未发版**（用户要求攒到下一版一起发）

---

## ① deb 自动更新"确认后没反应"

### 根因（代码级，非猜测）

`desktop/main.js` 里所有弹窗都走了同一个封装：

```js
const show = (opts) => dialog.showMessageBox(mainWindow ?? undefined, opts).catch(() => ({ response: 1 }));
```

Electron 的签名是 `showMessageBox([browserWindow,] options)`。**当 `mainWindow` 为 null 时传 `undefined`，
Electron 会把 `undefined` 当成 options**（拿不到 buttons/title），抛错又被 `.catch` 吞成 `{response:1}`。
而 `response:1` 恰好在"下载并安装/稍后"这个对话框里等于**用户点了「稍后」** →
流程在日志里只留一句"用户选择稍后"，界面上什么都没有。**这正是"确认后没反应"的机制。**

叠加上四个放大因素：
1. `httpsGetBuffer` 只有 5 分钟**总超时**，没有空闲检测：跨境下载卡住时用户要干等 5 分钟；
2. 进度只靠 `setProgressBar`，而多数 Linux 桌面环境**不显示**它 → 看起来像没开始；
3. `pkexec` 直接 spawn、没有探测：精简发行版上没有它时只会静默失败；
4. 失败弹窗只有「知道了」，用户无法把日志发回来。

### 修法

- `showBox` 按"有无父窗口"分别调用，异常**记录并抛出**而不是吞成"稍后"；
- 空闲超时 30s（"网络停滞"）+ `aborted`/`close` 处理；
- 进度写进**窗口标题**（`正在下载更新 42%`）+ `~/.mingdao/logs/desktop.log` 每整十百分比一行；
- 先 `which pkexec` 再决定走授权安装还是直接给"手动安装"对话框；
- 所有失败弹窗加「打开日志」按钮；每步日志带 `stage=feed|confirm|download|save|verify|sig|install`。

### 只能在 Linux 真机验证

`pkexec`/polkit 密码框、`dpkg -i` 实际安装、窗口标题进度可见性、深/港真实速度差异。

---

## ② 桌面更新/下载按地区自动选线路（此前根本没实现）

此前 feed 与下载**固定走香港** `harness.mingdao.ai`，所谓"自动选线路"只是口头承诺。

### 实现

新增 `desktop/endpoint.js`（纯函数可测）：

| 项 | 规则 |
| --- | --- |
| 候选 | 香港 `https://harness.mingdao.ai`、深圳 `https://harness.southdns.com` |
| 探测 | 各发一个极小 GET（`/updates/latest.yml`，3s 超时），比 **TTFB** |
| 缓存 | 24h，存 `app.getPath('userData')/endpoint.json` |
| 覆盖 | 环境变量 `MINGDAO_UPDATE_BASE` 强制指定（排障用） |
| 回退 | 探测全失败 → 香港；深圳返回 403/404/410/DNS 失败 → **自动回退香港一次** |

应用范围：deb feed / deb 安装包 / `.sig` / electron-updater 的 `setFeedURL` / "去官网下载"链接。
日志记 `endpoint=sz|hk probe=xxms`。

---

## ③ 缓存命中率（真机实测，不猜）

### 先说结论

1. **确实有一个真 bug**：`schemaTier`（只读档收缩 + 已用工具剥描述）默认开启，
   **每回合重新 `createAgent()` 时清零**，导致工具 schema 在同一会话的回合边界上翻来覆去；
   而 **tools 位于缓存前缀最前面** —— 它一变，整段历史按未命中价重计（命中价约 1/10）。
   实测：只换 tools、消息一字不差 → 命中 384/601（63.9%），其中差的那 10.6 个百分点就是白扔的钱。
2. **剩下的差距不全是我们的问题**：实测「**逐字节相同**的重复请求」在 deepseek-flash 上也只命中
   1280/1513 = **84.6%**，两次完全一样。那 233 token 是端点侧的**固定未缓存尾段**（缓存单元粒度），
   在 1~2K 的小 prompt 上占 15%，在真实 20K+ 会话里 **<1%**。
   所以"命中率"这个数字本身**强依赖 prompt 大小**，拿小会话的 85% 去比 20K 会话的 99.5% 不公平。

### 修法

- `schemaTier` 改为**显式开启**（默认 false）：这两项省下的几百 schema token 远不够赔一次整段重计；
- 剥描述集合改为从**消息历史派生**（`usedToolNamesFromMessages`），不再依赖进程内 Set（WebUI 每回合新建 agent）；
- 请求只发协议字段（`wireMessages`）：落盘补的本地 `ts` 不再出门，「发送时」与「下回合读回」字节一致；
- reasoning 裁剪抽成纯函数 `sanitizeReasoningContent()`（行为逐字不变，可断言）。

### 自证工具（这次最重要的产出）

- `scripts/measure-cache.mjs`（开发用，手动跑，6 次请求，几分钱）：打印
  ①同一请求重复 ②只换 tools ③MDH 真实 system+tools ④模拟追加 四段命中率与结论；
- `test/cache-stability.js`（25 项，零网络）：system prompt/sha256、工具集跨回合字节、
  trim 幂等、reasoning 裁剪确定性、wire 只含协议字段、压缩不改 system/tools、
  两个 agent 实例（两次用户回合）tools 字节完全相同。

### 还没做（下一步）

- UI 状态栏的「缓存命中」建议展示**两个口径**：`命中 / 总 prompt`（现状）与
  `前缀复用率 = 命中 / 可缓存前缀`，并把"端点固定尾段"写进 tooltip——否则用户会误判成实现问题；
- 在**真实 20K+ 会话**上量一次（`--full`），确认大 prompt 下命中率回到 97%+；
- 压缩（compact）会整体改写前缀：压缩后第一轮必然全 miss，这是设计使然，可在仪表盘标注；
- 子代理/并行批次的命中占比未单独统计。

---

## 发版安排

- 用户要求：**先修复或记住，不发版，等下一版一起发**；
- 本批改动只在 main 上累积，不 tag、不改版本号、不推 Release；
- 下个版本建议 **v0.10.0（minor）**：deb 更新可用性 + 线路选择属于用户可见能力变化；缓存修复属性能修正。
