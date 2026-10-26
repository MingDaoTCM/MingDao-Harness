# MingDao Harness v0.6.27 发布说明

> 状态：**已发布**（tag `v0.6.27`）
> 主题：**verify-release 三态 + 顶栏精简/兼容节点清理 + Windows 夹具修复**
> ——三件事，都是「把上一轮留下的债收干净」：① 发版收尾的 `verify-release` 不再把一次网络
> 超时说成「四平台不一致」，改为 **`ok=0` / `mismatch=1` / `unreachable=2`**；② 删除 v0.6.25
> 留下的两个 hidden 兼容节点，顶栏可见入口 **13 → 11**、可交互控件 **10 → 8**，会话管理移入
> 左栏「最近会话」；③ `memory-recovery` 的「不可写目录」夹具不再用 `chmod`（Windows 上无效），
> 改为 fs 门面注入，所有平台同一路径。细节见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.93 / §3.94 / §3.95**。

## 一、`verify-release` 三态（§3.95，`scripts/verify-release.mjs`）

**证据**：v0.6.24 发布后关机守护报出
「✗ 四平台未对齐：GitHub/main 期望 1696b02f…，实得 取不到（spawnSync git ETIMEDOUT）」，
而同一时刻负责人手工连跑三次全绿——**一次网络超时被渲染成了「发布不一致」**。同版还出现过
peel 失败后回退未 peel 的 tag 对象（`d2788e96`）去和 main 比较，必然不等，同样是假失败。
误报会训练人忽略这条告警，而它恰恰是防半发布的最后一道闸。

### 1.1 三态与退出码

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | `ok`：四平台同一 commit，Release 齐备，npm 已发该版本 | 通过 |
| `1` | `mismatch`：**真的不一致**（SHA 不同 / Release 或附件缺失 / npm 未发） | 按输出逐项补齐；**不要**当网络问题重试 |
| `2` | `unreachable`：超时 / 网络 / DNS / HTTP 5xx / 鉴权限流 / **任何 git 读取失败** | **这不是发布失败，请重试**；不是回滚信号 |

- `mismatch` 文案保持「四平台未对齐……这不算发布完成」；`unreachable` 文案写
  「取不到（网络/服务不可达）……**这不是发布失败，请重试**」；
- 两者同时存在时以 **mismatch 优先**（真问题不能被网络噪声掩盖）；
- `--retry N`（默认 2）：**只对 unreachable** 重试（1s/2s 指数退避），ok/mismatch 一次即返回；
- `--timeout-ms N`（默认 20000）：单次 `git ls-remote` / HTTP 请求超时。

### 1.2 peel 失败不再回退比较 tag 对象

拿不到 `refs/tags/<tag>^{}` 时：先看未 peel 的 SHA 是否恰好等于本地提交（轻量 tag）；不等则经
GitHub API（`git/ref/tags/<tag>` → 必要时 `git/tags/<sha>`）取 peeled 提交，且**只有 API 的 tag
对象 SHA 与目标平台未 peel SHA 一致时才借用**（防拿别的仓库/旧 tag 假绿）；仍取不到按
`unreachable`（exit 2），文案写「无法确定 tag 指向的提交」。

### 1.3 保持兼容

成功输出**逐字不变**：
`✓ 四平台一致（GitHub / Gitee / GitCode 的 main 与 tag 同 SHA，Release 齐备，npm 已发该版本）`，
发版脚本的 grep 不受影响；逐项行格式也不变（unreachable 用 `?` 与 mismatch 的 `✗` 区分）。

### 1.4 测试与变异

- 新建独立套件 `test/verify-release.js`（不连网、不起服务）**6 项**：全绿→0 且成功文案一致 /
  一个 mismatch→1 / 一个 unreachable→2 / peel 失败→2（含 API 借用与轻量 tag 三种分支）/
  `--retry` 桩计数与退避 / 超时与读失败归类（HTTP 404 仍 mismatch）。
- 新建 `test/mutate/batch55-verify-release.mjs`：**7/7 全中**。
- 套件接入 `test/run-all.mjs` 与 CI **仅 Linux 腿**（带失败注解）。

## 二、界面清理与顶栏精简（§3.94，`src/web/index.html` + `src/web/app.js`）

**证据**：v0.6.25 为保住旧变异锚点保留了两个 hidden 兼容节点（`#legacyRailCompat` /
`#newChatCompat`）；同时左栏会话列表上线后，顶栏「历史会话」`#sessions` 与「会话管理」
`#sessMgrBtn` 与左栏重复。本轮只删冗余、不删能力。

### 2.1 删掉的 id / 能力承接

| 删除的 id | 能力由谁承接 |
| --- | --- |
| `#newChatCompat`（包裹层） | 左栏 `#sideNavNew`（唯一可见新建入口）+ `#newChat`（hidden，⌘K/左栏复用同一 handler） |
| `#legacyRailCompat` | 右栏四标签 `#rtTrace` / `#rtSub`（及其面板 `#tabTrace` / `#tabSub`） |
| `#trajRailBtn` / `#subRailBtn`（兼容节点内的空 span） | 同上（右栏「轨迹」「子Agent」标签） |
| 顶栏可见的 `#sessMgrBtn`（节点保留 hidden） | 左栏 `#sideNavSessMgr`（✎，复用 `openSessModal`） |
| 顶栏可见的 `#sessions`（节点保留 hidden） | 左栏 `#sideNavSessions` 列表（点击写回 `#sessions` 并派发 change） |

- 删 `#legacyRailCompat` 的同时，移除 `#tasksBtn` / `#costBadge` handler 里对两个已删按钮的
  `classList.remove('on')`——否则空引用会先抛错、标签切不动（这是删节点后真正的行为回归点）；
- 会话管理移入左栏「最近会话」标题右侧；顶栏「历史会话」保留但加 `hidden`；
- **顶栏可见入口 13 → 11（可交互控件 10 → 8）**：1440 截图中原先被 `.hdr-right` 横向溢出挤出的
  「任务」按钮在腾出空间后露出；未引入设计稿 CSS、未改 `.app` 网格/顶栏高度/主题/字号。

### 2.2 测试与变异

- `test/smoke.js` 新增 **§162**（6 组：兼容节点及其子按钮不存在 / 新建入口唯一 /
  右栏四标签绑定不丢 / 会话管理在左栏且复用 `openSessModal` / 顶栏 8 可交互 + 11 可见项且
  `#sessions`/`#sessMgrBtn`/`#newChat` 均 hidden / 既有能力回归）；
- §159② 的包裹层断言同步改为「已删除 + `#newChat` 直接 hidden」；
- 既有锚点同步：batch43① / 44⑤ / 45⑦ / 49② / 51③（缺陷语义未放宽）；
- 新建 `test/mutate/batch54-cleanup.mjs`：**10/10 全中**。

## 三、Windows CI 夹具修复（§3.93，`test/memory-recovery.js`）

**证据**：v0.6.26 的 windows 腿红在 `test/memory-recovery.js` ⑧：
`AssertionError: 不可写时错误文案必须有 warn（写入失败）`。根因是夹具假设——`fs.chmodSync(home, 0o500)`
在 **Windows（尤其 admin runner）上不阻止写入**（目录忽略只读位），写入成功→没有 warn→断言红；
套件崩在 ⑧，batch40 的 ⑦–⑩ 因根本没跑到而连带被判「逃逸」。产品代码无回归。

**修法（测试侧，无产品改动）**：⑧ 改为给 `endpoint-limits.json` 的**原子写临时文件注入 fs 门面**——
只匹配 `dirname === home && basename.startsWith('.endpoint-limits.json.') && endsWith('.tmp')`，
第一次写抛 `EACCES`；注入在 `finally` 第一行还原，再用真实 fs 恢复学习文件备份，不污染后续用例。
所有平台走同一条路径，不再依赖 POSIX 权限位；`src/**` 一行未改。

**测试与变异**：`test/smoke.js` 新增 **§161** 结构守卫（禁 chmod / 平台跳过 / `/tmp` 硬编码，
要求门面作用域、两条 warn 断言与 `finally` 还原仍在）；新建
`test/mutate/batch53-portable-fixtures.mjs` **6/6 全中**；`batch40` **11/11**（⑦–⑩ 重新被
「抓到」）；`batch52-memory-v2` 复跑 **11/11**（改夹具没有放松既有判据）。

## 四、变异总数与门禁

- `test/mutate/README.md`：变异总数 **461 → 484**（batch53 +6 / batch54 +10 / batch55 +7；
  `doc-lint` ⑥ 校验文档数字 = 各 `batch*.mjs` 的真实 `name:` 条数）。
- 全量变异：**44/44 批次、484 条全中、0 逃逸**（跑完自动还原，无残留）。
- 本机 18 项门禁逐项通过（明细见 v0.6.27 发布报告）；`smoke` 与 `verify-release` 套件均单独跑。

## 五、验证（本机 macOS，最终 HEAD）

- `npm run typecheck` → **0**；`npm run typecheck:strict` → **当前 0 / 基线 0**
- `node test/smoke.js` 单独跑 → 全部通过（含新增 **§161 / §162**）
- `e2e-local` 17 / `e2e-web` 24 / `e2e-schedule` 11 / `api-contracts` 8 → 全通过
- `pack-ctx-privesc` 4 组 / `ledger-source` 11 组 / `model-names` 8 组 /
  `memory-recovery` 11 项 / `ui-sessions` 5 项 → 全通过
- `node test/verify-release.js` → **6 项**通过
- `node test/mutate/selfcheck.mjs` → 14/14；`npm run bench` → 5 套基准全通过
- `node test/mutate/run.mjs` → **44/44 批、484/484 条全中**
- `node scripts/doc-lint.mjs` → 全通过；`node src/cli.js diagnose` → 报告正常、密钥脱敏
- 发布提交只含五个发布文件；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**

## 六、已知边界（逐条如实登记）

- **`#newChat` / `#sessions` / `#sessMgrBtn` 仍以 `hidden` 形式保留**：`test/smoke.js` §158 仍静态
  断言顶栏九个入口存在（本轮不改该断言），因此这三个节点只是隐藏、不渲染、不进入用户路径；
  **计划下一轮连同 §158 的九入口断言一起清理**。能力已由左栏承接（见 §2.1 表）。
- **`verify-release` 的 exit 2 表示网络不可达，不是发布失败**：发版/守护脚本看到 **2 应重试**
  （脚本自身默认已重试 2 次），**不要回滚**；只有 exit 1（mismatch）才说明真的不一致。
  若连续 exit 2，先确认网络与 GitHub API 额度，**不要**据此判定「四平台没对齐」。
- **1180 视口顶栏右侧仍需横向滚动**：`hdr-right` 是 `overflow-x:auto` 的可滚动容器（v0.6.21 既定），
  本版只是减少了两个重复入口，未重排顶栏；1180 下最右侧控件仍可能需要横向滚动才能看到。
- **Windows 真机未验证**：本版修的是 Windows CI 的测试夹具，证据以
  `test (windows-latest, 20)` 腿绿为准；未在标准 Windows 账户（未开 Developer Mode / 非管理员）
  上重跑 `npm test`，也未逐按钮点选验收。若真机仍红，请贴断言原文（不要只 rerun）。
- **`memory-recovery` 的注入只覆盖原子写门面**：fs 门面仅拦截 `endpoint-limits.json` 的原子写
  临时文件，**不覆盖**其它 IO（读文件、日志、会话落盘等）；「写失败 → warn → 不阻断会话」这条
  路径是真实的，但其它 IO 失败不在本夹具的覆盖范围内。
- **peel 借用只接受一致 tag 对象**：GitHub API 结果仅在 tag 对象 SHA 与目标平台一致时借用；
  Gitee/GitCode 若与 GitHub 的 tag 对象不一致，宁可 exit 2 也不拿 API 结果硬判，避免假绿。
- **未改**产品逻辑（`src/**`、`test/**` 的发布提交 diff 为 0）、`presets/**`、`desktop/**`
  （版本号除外）、`ide/**`；不新增后端接口、网络请求或轮询。

## 七、升级须知

1. 从 v0.6.26 升级**无迁移**：界面只是少了三个隐藏节点与顶栏两个可见入口，能力位置见 §2.1。
2. 会话管理：左栏「最近会话」标题右侧的 ✎ 打开原「会话管理（重命名/删除）」弹层。
3. 轨迹 / 子Agent：右栏四个标签仍是唯一详情入口（默认轨迹）。
4. 发版脚本若解析 `verify-release` 退出码，请按 §1.1 的三态处理（0/1/2），不要一律当失败。
5. 本版不删除任何历史产物；需要回退可继续安装 v0.6.26 / v0.6.25。
