# MingDao Harness v0.6.33 发布说明

> 状态：**已发布**（tag `v0.6.33`）
> 主题：**v0.7.0 地基第二批：前端可测化（viewmodel）+ 变异补盲**
> 范围：**无新功能**。`v0.6.32..HEAD` 共 4 个提交，改的是"测试能不能证明行为"。
> 影响面：前端内部结构、测试与门禁。**界面行为与像素零变化**，无 API 变更，无数据格式迁移。

---

## 一、升级须知（先读，三条）

### 1. 用户看不到任何变化——这是本版最关键的验收

前端把 4 个纯计算函数从 `app.js` 搬到新文件 `src/web/viewmodel.js`，`app.js` 只负责渲染。
**搬家前后的 5 张真实界面截图（1440×900，Electron 真实渲染）sha256 完全一致**：

| 页面 | sha256（搬家前 == 搬家后，逐字节一致） |
| --- | --- |
| `home.png` | `00a68c1358e623b33d794da23944680c1e6350968ca2d3640caa54570fed1b5e` |
| `settings.png` | `1c27e00102ad098ef28baa24419098162f05e291a53b0b2a90e49a4aa8dac414` |
| `palette.png` | `f9369ef19cd7659da12711abcb34225cc549b30c35a572dec363a2406f018dcb` |
| `session.png` | `f285c44022a3a0d7c1c23d1da6724c2455394176b956c3ebfae89fffa3ed3e11` |
| `sheet.png` | `cdc5ea7cb88b5c68482b56361955374f131ac8748d9d5d64ccdd950812dcb6ca` |

（`node scripts/ui-shot.mjs --out /tmp/shots-0633`，1440×900，Electron 真实渲染；与 `/tmp/shots-vm-before`
的 5 张比对：字节数与 sha256 全部相同。）

本版**不提功能、不修 UI 缺陷**。它带来的只是"以后 UI 改错能被测出来"。

### 2. 唯一的运行时代码"越界"：静态白名单放了 `viewmodel.js`

`src/web/routes/api.js` 的静态资源白名单新增 `viewmodel.js`。原因：浏览器 ESM `import` 的
`viewmodel.js` 请求不带 `?token=`，不放行会 **401**，实测表现为**设置面板打不开**。
这是必要改动，不是扩大权限面：它仅允许读取一个公开的前端脚本，鉴权规则本身未变。

### 3. 无需迁移，回滚代价低

- 无状态文件格式变化、无配置项新增、无 CLI 行为变化。
- 回滚方式：回退 `src/web/app.js`、`src/web/viewmodel.js`、`src/web/routes/api.js` 即回到旧前端结构。
- 桌面端只跟随版本号，安装包内容与 v0.6.32 功能等价。

---

## 二、用户可见变化

**零。** 界面布局、交互、文案、渲染结果与 v0.6.32 完全相同（5 张截图 sha256 一致）。
CLI 输出、账本、Pack、网络策略均未改动。

---

## 三、开发者可见变化（口径、测试与门禁）

| 项 | v0.6.32 | **v0.6.33** |
| --- | --- | --- |
| code-lines 覆盖率（主指标） | 68.4% | **73.9%**（19869/26873） |
| all-lines | 49.7% | **53.5%**（19869/37129） |
| functions | 87.8% | **81.7%**（1874/2294）——**分母变大**，见下 |
| `src/web/app.js` 覆盖 | **0%**（2876 行全裸奔） | **46.9%**（首次进入 V8 分母） |
| 新文件 `src/web/viewmodel.js` | 不存在 | **447 行，覆盖 92.3%** |
| 前端正则守卫 | 40 条 `grep 源码` | **→ 行为断言**（直接调用函数断言输出） |
| 测试套件 | 26 套 | **30 套**（+`sync-state` / `packs-capabilities` / `workspace-fence` / `viewmodel`） |
| 变异条目 | 669 | **700**（batch72/73/74 共 31 条） |
| 变异盲区（>150 行且 0 条变异） | 15 个 | **13 个**，并进 CI **ratchet（`--fail-over 13`）** |
| CI | — | **4 个新套件步骤 + 盲区 ratchet，均挂 Linux 腿** |

> **functions 从 87.8% 降到 81.7% 不是退步。** `app.js` 首次被真实 import 进统计，
> 函数分母 **1828 → 2294**（+466），分子只统计到能执行到的函数。基线 note 已写明这一点，
> ratchet 以 code-lines 为主指标。

### 3.1 四个纯函数搬家 + 110 条对拍（`ce2a2a7`）

- 新增 `src/web/viewmodel.js`：`sideNavLayout`、`errCardParts`、`runStripView`、`traceRoundView`
  及其依赖（`fmtRun*` / `toolStepView` / `subagentRowView` 等）。**纯计算层：不读 DOM、不读全局**。
- `src/web/app.js` 相应减去约 254 行，只保留渲染与事件绑定。
- `test/viewmodel.js`（425 行、**110 条断言**）：`REF_*` 是搬家前 `app.js` 的原实现（逐字复制），
  与 `viewmodel.js` 导出用**同一批输入**跑 `deepEqual` 对拍，并逐个钉死输出字段名
  （`data-k` 六项 → `Object.keys(runStripView)`；`width240` → `sideNavLayout(1440,false).width`；
  `rpModel` → `runPanelView.modelLabel`）。

### 3.2 40 条源码正则守卫 → 行为断言（`ce2a2a7`）

`test/smoke.js` 里 40 条"grep 源码文本"的守卫改成**直接调用函数、断言行为**。
正则守卫既会把"加一行注释"判成假红，也抓不到"值算错了但文本没变"——本版让它们开始能证伪。

### 3.3 变异补盲：3 个行为套件 + 3 批变异（`27fcf51` / `48bc098`）

| 套件 | 条目 | 覆盖对象 |
| --- | --- | --- |
| `test/sync-state.js` | 16 | 同步状态增量、冲突解决、跨进程一致性 |
| `test/packs-capabilities.js` | 16 | Pack 能力声明与版本约束 |
| `test/workspace-fence.js` | 15 | 工作目录围栏（realpath / 跨进程锁） |

对应 `batch72`（10 条）/ `batch73`（10 条）/ `batch74`（11 条），**全中、0 逃逸**。

### 3.4 盲区 ratchet（`27fcf51` + `48bc098`）

新增 `scripts/mutation-coverage.mjs`：列出"代码行 > 150 且 0 条变异"的模块。
盲区 **15 → 13**，并进 CI：`--fail-over 13`，**不允许新增盲区**。
抬基线必须与"给该模块补批次"同一次提交（与覆盖率 ratchet 同规矩）。

### 3.5 接线与文档（`48bc098` / `eab78e8`）

- 3 个补盲套件 + `viewmodel` 进 `run-all`（**30 套**）与 CI（Linux 腿）；盲区 ratchet 进 CI。
- `docs/ARCHITECTURE.md` 补 `web/viewmodel.js`（模块 90 → **91**）；变异总数校正为 **700**；
  `docs/DEVELOPER.md` 补变异补盲的做法与门槛。

---

## 四、未做（明确边界）

- **§1.1 事件溯源**（会话事件日志 / SSE 单调 seq）**未开始**，是下一批。
- **§1.5 内核切分**（`agent.js` 文案层外移、`server.js` 拆分、单函数 ≤500 行）**未开始**。
- **`docs/ROADMAP-v0.7.md` 的 0.7.1–0.7.3 全部未动**（工具契约、人机协作、多 agent）。
- `viewmodel` 测试经 `run-all` 的独立套件与 `smoke` 的直测进入覆盖率；
  **未给 `viewmodel` 单独接 `run-all` 之外的入口**（CI 步骤是显式单跑，覆盖率仍走 `npm run coverage`）。
- 新套件与 ratchet 只挂 **Linux 腿**，Windows/macOS 上这些步骤 `skipped`；
  跨平台行为由各平台 `run-all` / 变异全量间接覆盖，**未在 Windows 实机点验这三个套件**。
- 覆盖率数字是 **macOS arm64 / Node 24.20** 实测；其他平台可能略差（±容差内）。
- 本版无 UI 改动，截图零变化是**预期**而非"没测"；像素级差异（字体/DPR）不在本版验收范围。

---

## 五、验证（发布前门禁实测，tag 前那棵树）

在门禁 SHA（`eab78e8`）上按 RELEASE-CHECKLIST §1 全量复跑，全部 exit 0：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误** |
| `npm run typecheck:strict` | 当前 **0** 条 / 基线 **0** 条（✅ 未恶化） |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | **156 组断言全通过** |
| `node test/run-all.mjs` | **30/30 套通过，0 失败** |
| `node test/mutate/run.mjs` | **63/63 批、700 条全中**（0 逃逸） |
| `npm run coverage` | code-lines **73.9%** / all-lines **53.5%** / functions **81.7%**；**ratchet 通过** |
| `node scripts/doc-lint.mjs` | 全绿（⑥ 变异总数：实际 700 = README 700） |
| `node scripts/mutation-coverage.mjs --fail-over 13` | 盲区 **13**，未超基线 |
| `node src/cli.js diagnose` | 自检通过，报告已脱敏 |

三平台代码、npm 包、官网下载页与 GitHub Release 为同一 tag 产物。

---

## 六、已知边界

- `viewmodel.js` 是**纯计算层**，但 `app.js` 仍有大量 DOM 绑定代码（约 2600 行）未测；
  `app.js` 46.9% 表示"被 import 后能执行到的行"，不等于 UI 交互已被测试覆盖。
- 40 条守卫行为化后，仍保留少量"源码形态"守卫（结构不变量无法用行为表达，如"必须保留 finally 块"）。
- 盲区基线 13 个是**存量如实登记**，不是"这 13 个模块不重要"；后续批次继续补。
- `scripts/mutation-coverage.mjs` 用**行数阈值 + `name:` 计数**做启发式，不解析变异是否有效。
