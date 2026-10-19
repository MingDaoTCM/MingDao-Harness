# MingDao Harness v0.6.20 发布说明

> 状态：**已发布**（tag `v0.6.20`）
> 主题：**紧急回滚界面重排，恢复 v0.6.18 的可用 UI**
> ——`src/web/index.html` / `src/web/app.js` 逐字节回到 v0.6.18；与 UI 无关的改进（端口治理、
> 本地内存恢复、变异全局锁等）全部保留。真机现象、根因、处置与重新上线前置条件见
> `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` **§3.79**。

## 为什么发这一版

v0.6.19（§3.78 界面骨架重排 + §3.77 UI P2）在**真机翻车**：

| # | 真机现象 | 后果 |
| --- | --- | --- |
| 1 | **界面凌乱**：三栏骨架与旧样式叠加，间距/列宽/层级错位，缩放时侧栏/右栏互相挤压 | 页面基本不可读，负责人被阻塞 |
| 2 | **菜单/设置消失**：模型/预设/权限移入会话设置弹层，但弹层/右栏面板在真机上不出现；侧栏会话列表与设置入口同样不可见 | 找不到入口，无法切换模型/权限 |
| 3 | **按钮失灵**：设置、新对话、发送、右栏标签等点击无响应 | 连"恢复默认"都点不了 |
| 4 | **主按钮/主题异常**：`button.primary` 仍硬编码亮色，暗/亮切换下低对比甚至"白底白字" | 关键操作看不清 |

**处置结论：不再在坏骨架上打补丁。** 回滚到 v0.6.18 是唯一能让界面恢复的可靠手段，
因此本版是一个**只回滚、不夹带新 UI** 的紧急热修。

## 回滚了什么

- **`src/web/index.html`、`src/web/app.js` 回到 `v0.6.18`**：
  `git diff v0.6.18 -- src/web/index.html src/web/app.js` 为空（逐字节一致）。
- 随回滚下线：
  - §3.78 的三栏骨架、右栏四标签页、顶栏瘦身、底部合并、设计稿 CSS 整段搬运；
  - §3.77 的设置三列、六类危险操作二次确认、dialog 无障碍、语言选择（`i18n.js` 文件保留但不再引用）。
- **移除失效的测试与变异批次**（它们断言的是被回滚的骨架/交互）：
  - `test/smoke.js` 删除 §153 整节；
  - 删除 `test/ui-p2.js`，并从 `test/run-all.mjs`、`.github/workflows/ci.yml` 移除注册；
  - 删除 `test/mutate/batch43-ui-shell.mjs`（12 条，锚定新骨架）；
  - 连带删除 `test/mutate/batch42-ui-p2.mjs`（15 条，锚定回滚后已不存在的 P2 代码，
    且只跑 `test/ui-p2.js`，保留必然「变异点未找到」）；
  - 变异总数 **369 → 342**（32 批 → 30 批），`test/mutate/README.md` 按 `doc-lint` 实测值写。

## 保留了什么

- `src/web/i18n.js`：**暂不引用**，作为后续重建的资产保留（零依赖，zh/en 同键）。
- `src/web/server.js` 的 `/api/state.defaults`：**纯新增只读字段**，不参与判定、不写盘，
  向后兼容；当前前端不消费它。
- 所有与 UI 无关的改进：
  - 测试固定端口 → `listen(0)` 运行时端口 + `doc-lint ⑨` 结构守卫（§3.76）；
  - 本地引擎内存/显存不足自动降级重试一次（§3.74）；
  - 变异验证跨 worktree 全局锁与 fail-safe（§3.75）；
  - 调度熔断用例的进程内确定性驱动（Windows 腿回归修正）等。

## 为什么是回滚，而不是继续修

1. **单次前端改动约 3,000 行**（实测 `src/web/` diff **2,561 行**：`index.html +1,116/−211`、
   `app.js +797/−63`、`i18n.js +349`、`server.js +25`）。布局、组件、P2 交互、i18n 一次落地，
   任何一个初始化顺序问题都会放大成整页不可用。
2. **没有视觉验证**：`smoke §153` 是字符串/选择器/设计稿解析断言，`test/ui-p2.js` 是桩 DOM +
   纯函数切片，**都不渲染页面**。它们在真机一片凌乱时仍然全绿——这一版就是。
3. **设计稿 CSS 整段覆盖**：设计稿约 760 行规则体直接追加，与旧规则并存而不是替换：
   - `header` **三处定义**同时存在（旧 52px 基准、旧窄屏媒体查询、新 `header.topbar`），
     级联结果依赖声明顺序，旧属性把新顶栏撑开/裁切；
   - `button.primary{background:#F9FAFB;color:#0F1115}` **硬编码亮色**，未走主题令牌；
   - 面板默认隐藏（`#runPanel` 的 `hidden`、`#subPanel/#tasksPanel/#dashPanel` 的行内
     `display:none`），显隐统一交给新的 `syncPanelLayout()` / `railPanelDisplay()`；
     该链路在真机上未按预期执行时，**所有面板一起消失**。

## 新增 Electron 截图工具（§3.80）

- 新增 `scripts/ui-shot.mjs`：起真实 `src/cli.js web`（临时 `MINGDAO_HOME` + token），用**真实
  Electron** 加载页面并 `capturePage()` 输出 `home.png` / `settings.png` / `palette.png` /
  `session.png`；支持 `--viewport wide|mid|narrow`（1440/1000/880）、`--theme dark|light`、
  `--mobile`、`--out`；服务、参数、Electron、页面报错、截图失败分别以非 0 退出。
- `docs/DEVELOPER.md` 新增 §六：**UI 改动必须先用 `node scripts/ui-shot.mjs` 截图自查**，
  至少覆盖三档宽度与暗/亮两主题，截图不对不提交。
- 本次已在回滚后的工作树上实测：wide（1440×900）与 narrow（880×900）各 4 张、light/mid
  （1000×900）各 4 张，均为有效 PNG；`--electron /nonexistent` 退出 3、`--viewport huge` 退出 2。
- **本版起 UI 改动必须先跑 `node scripts/ui-shot.mjs` 截图自查，工具见 `docs/DEVELOPER.md §六`。**

## 界面重排将在有 Electron 截图验证后重新上线

重新上线的前置条件是硬要求，不是建议：

1. **Electron 真实窗口截图验证**：覆盖 **≥1280 / 1000 / 880** 三档宽度、暗/亮两主题，
   逐页打开顶栏 / 侧栏 / 右栏四标签 / 会话设置 / 危险确认 / 空态；截图随 PR 与发布说明存档，
   截图不通过不得发布。
2. **不接受字符串断言代替渲染验证**：`smoke` 只能作为回归底线，不能作为 UI 可用的证据。
3. **不要整段覆盖设计稿 CSS**：`header` 只保留一处基准定义，主按钮只用主题令牌，
   面板默认态由单一函数决定；初始化失败要回退到可用布局，而不是「全部隐藏」。
4. 重建后的首个版本仍需通过全量门禁（typecheck / smoke / e2e / 变异 / doc-lint）。

## 升级须知

1. **从 v0.6.19 升级后界面会回到 v0.6.18 的样子**：这是本版的目的，不是回归缺陷。
2. **§3.77/§3.78 的 P2 交互不再可用**：设置三列、六类危险操作二次确认、dialog 焦点陷阱、
   界面语言切换随回滚下线；等重建版上线后再恢复。
3. **`/api/state.defaults` 仍在**：只读、向后兼容，不影响任何判定；旧前端忽略未知字段。
4. **`src/web/i18n.js` 随包发布但未被引用**：不影响启动与体积（349 行静态文件）。
5. **手动降级路径保留**：v0.6.18 的安装包/校验文件仍在 GitHub Release 与官网下载目录，
   需要回到更早的 UI 可直接下载 0.6.18（本版不删除历史产物）。

## 验证

- `npm run typecheck` → **0**
- `node test/smoke.js`（单独跑）→ **156 组断言全通过**
- `node test/e2e-local.js` → **17 项**；`node test/e2e-web.js` → **24 项**；
  `node test/e2e-schedule.js` → **11 项**；`node test/api-contracts.js` → **8 项**
- `node test/mutate/run.mjs --allow-dirty` → **30/30 批、342/342 条全中、0 逃逸**
  （跑前 `pgrep -f "test/mutate"` 为空；全局锁 `os.tmpdir()/mingdao-mutate.lock/` 正常获取/释放）
- `node scripts/doc-lint.mjs` → 全通过（⑥ 实际 **342** = README 342；⑨ 固定端口 **0 处**）
- 回滚核验：`git diff v0.6.18 -- src/web/index.html src/web/app.js` → **空**
- 发布提交只含五个发布文件（CHANGELOG / RELEASE-NOTES / `package.json` / `package-lock.json` /
  `desktop/package.json`）；`git diff --name-only <门禁SHA>..<tagSHA> -- src test` → **0 行**

## 已知边界（如实登记）

- **截图工具是「看得见」的证据，不是交互测试**：本次在回滚后的工作树上跑了 wide / narrow /
  light / mid 四类截图（1440/880/1000），确认回滚后的页面能真实渲染；但**没有逐按钮点击与键盘
  全流程验收**，`smoke` 仍是回归底线。截图还暴露出 v0.6.18 既有的窄屏边界：1000px 时顶栏右侧
  「历史会话」被裁切、<880 左侧被裁切——本版按「回滚优先、不碰 `src/web/**`」如实登记，未修。
- **§3.79 只登记了负责人反馈的归纳，没有当时的截图/录屏**：现场证据缺失，无法逐像素复盘。
- **`batch42` 的移除超出了任务书最初列出的清单**：任务书预期 31 批 / 357 条，但 `batch42`
  只跑已删除的 `test/ui-p2.js` 且锚点全部指向已回滚的 P2 代码，保留会使门禁必红；
  实际为 **30 批 / 342 条**，`doc-lint` 与 README 均按实测值记录。
- **i18n 资产暂未接线**：`i18n.js` 保留但没有任何引用；后续重建时需重新接入并补测试。
- **`/api/state.defaults` 暂无前端消费者**：只读字段保留，等重建版使用。
- **本版没有新增任何 UI 功能**：除回滚与测试清理外，不改产品行为。
