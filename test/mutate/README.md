# 变异验证（mutate）

「把修复逐个改回缺陷，回归断言必须当场失败」——本目录把这件**手工过程**变成可复跑的工具
（第三方报告一 §S-3② 指出：项目在发布说明里写「变异验证 7/7」，但全仓没有脚本，
**谁也复现不了**；这与项目自己「守卫必须可回归」的要求不一致）。

```bash
node test/mutate/run.mjs            # 跑全部批次
node test/mutate/run.mjs batch12    # 只跑某一批
```

- `lib.mjs`：脚手架（`makeMutator()` → `mutate({file, from, to, expect, run})`；
  `section('126')` 会把 `test/smoke.js` 的某一节**抽成独立脚本**后单独跑，便于快速迭代）。
- `batchNN-*.mjs`：每批一个文件，条目写清「改坏什么 → 期望哪条断言抓到（关键词）」。
- `.generated/`：抽出来的节脚本（可随时重建，不入库）。

**判据**：`expect` 里是**断言原文的关键词**。关键词对不上就算「逃逸」——很可能失败的断言
并不是你修的那一条（本项目已经踩过：断言第一版根本抓不到变异，收紧后重验才算数）。

## 变异总数

变异总数：397（由 `scripts/doc-lint.mjs` 守卫：文档里的数字必须等于各 `batch*.mjs` 里真实的 `name:` 条数，漂移即 CI 红）。

> v0.6.20（§3.79）：界面重排回滚到 v0.6.18，`batch42-ui-p2`（15 条）与 `batch43-ui-shell`（12 条）
> 断言的 P2/新骨架已不在代码里，随 `test/ui-p2.js` 一并移除（369 → 342）。
>
> v0.6.21（§3.81）：新增 `batch43-header-sheet`（10 条）——顶栏既有入口被删、会话设置里的
> 模型/预设选择器被删、模型 change 解绑、crumb 不刷新、⌘K 模型命令改用 label、`#sessSheet`
> 打不开、`ui-shot --open` 失效、`sheet.png` 不再截（342 → 352）。
>
> v0.6.21（§3.82）：新增 `batch44-run-tabs`（10 条）——标签切不动、默认标签错、任务面板被搬出
> 右栏、`#tpList` id 丢失、顶栏「任务」不切页、右栏不打开、任务标签不刷新 `updateTasksPanel`、
> 仪表盘不接 `renderDashboard`、切标签销毁节点、标签按钮 id 丢失（352 → 362）。
>
> v0.6.21（§3.83）：新增 `batch45-visual`（14 条）——对比度回退/漏点名 rp-foot/改 --dim token、
> 顶栏 `.hdr-right` 不再 overflow-x:auto、min-width:0 回退、`#envBadge` 不让位、历史会话被移出
> 容器、`#crumb` 不限宽、标签少一个 `seg` 类、`.rp-tabs` 分段控件外框回退、选中态回退、弹层 `.ss-body` 间距回退、
> `.ss-effective` 间距回退、弹层宽度回退（362 → 376）。
>
> v0.6.22（§3.84）：新增 `batch46-sessions`（12 条）——今天/昨天边界错、旧会话缺 ts 报错、
> 页面显示 undefined、分组顺序错、打开管理面板重算分组、分组标题文案错、跨天时间丢日期、
> `/api/sessions` 缺 updatedAt、title 未复用、缺失 ts 返回空串、messageCount 口径错、引入 setInterval（376 → 388）。
>
> v0.6.23（§3.86）：新增 `batch47-lock-retry`（9 条）——锁获取把 EACCES 当致命、把 EPERM 当致命、
> 重试耗尽折成「锁超时」、瞬时预算缩到 50ms、rename 不重试、tmp 写入不重试、写失败被静默吞掉、
> 成功返回值少了 `error:null`、锁成功后不释放（388 → 397）。
