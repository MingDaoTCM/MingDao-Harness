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

变异总数：794（由 `scripts/doc-lint.mjs` 守卫：文档里的数字必须等于各 `batch*.mjs` 里真实的 `name:` 条数，漂移即 CI 红）。

> v0.7.0（§1.1 B2-a）：新增 `batch85-completeness`（9 条）——rewrite 不写事件、写了但不带
> messages、replay 忽略 messages.replace、事件写失败拖垮 rewrite、eventLog=false 仍写、
> reason 丢失、replace 当作追加、大消息截断、先写事件后写会话（785 → 794）。

> v0.6.41（§1.1 B1 客户端）：新增 `batch84-seq-gap`（8 条）——跳号也 accept、重复帧当新帧、
> null 帧判 resync（旧服务端兼容破坏）、streamSeq 不回填、重取失败静默、首帧非 1 也 accept、
> gap 算差 1、`resyncPlan` 没有会话也选 snapshot（768 → 776）。

> v0.6.41（§1.1 B1 服务端）：新增 `batch83-event-cursor`（9 条）——streamSeq 全局递增（跨 task 共享）、
> streamSeq 从 0 起、跳号不检测、`after` 过滤用 `>=`、目录穿越不拦、旧会话返回 404、`lastEventSeq` 恒 0、
> 心跳帧不带 streamSeq、把工具配对 seq 覆盖成 streamSeq（双游标合流）（776 → 785）。

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
>
> v0.6.23（§3.87）：新增 `batch48-ts`（10 条）——不补 ts、ts 不是 ISO、已有 ts 被覆盖、补在副本上
> 导致重复写入刷新、压缩重写刷新时间、Web 自建第二份实现、Web 绕过 `appendMessages`、读取路径
> 回填 ts、读取路径改写旧文件、非法 ts 读取崩溃（397 → 407）。
>
> v0.6.26（§3.92）：新增 `batch52-layout-bp`（11 条）——右栏收起点改回 1180、JS `narrowRun` 判据回退、
> <900 正文补偿归零/缩到 30px、窄条恢复占流、1101–1180 右栏被 `display:none`、左/右抽屉丢失、
> 正文补偿加 `min-width` 与 `overflow-x:auto` 造成横向滚动、收起规则去掉 `narrow-run` 收口
> （§3.91 的 `batch52-memory-v2` 11 条先落地；439 + 11 + 11 = 461）。
>
> v0.6.28（§3.96）：新增 `batch56-layout-ttft`（8 条）——恢复 #trajRail 空窄条/`.rail-btn` 样式、
> 删除 header 的 z-index、面板 z-index 反超 header、面板 top 写死 52px、删除 JS 写入 `--hdr-h`、
> TTFT 恢复每轮都打、<900 正文恢复 48px 窄条补偿（484 → 492）。

## 日常 vs 发版：`--changed` 只跑受影响的批次（v0.6.41 起）

全量 **73 批 / 794 条**要 **20+ 分钟**（用 `npm run mutate:shard` 并行约 **8 分钟**），但绝大多数与本次改动无关。日常提交用：

```bash
node test/mutate/run.mjs --changed HEAD~1        # 只跑"锚点落在改动文件上"的批次
node test/mutate/run.mjs --changed HEAD~1 --select-only   # 只看会跑哪些，不执行
```

实测选择效果（改一个文件时）：

| 改动 | 选中批次 |
| --- | --- |
| `src/web/viewmodel.js` | 6 / 73 |
| `src/agent.js` | 17 / 73 |
| `src/session-events.js` | 5 / 73 |
| 只改 `README.md` | 0 / 73 |

**规则是保守的**：只要改动里出现 `test/**`（断言/expect 可能影响任意批次）→ 自动**退回全量**。
结构预检（批次必须有 `report/exit`）仍然检查**全部**批次，不会因为"这次没选中"漏掉坏批次。

> **发版前必须跑一次全量**（不带 `--changed`）；`--changed` 只服务于迭代。

## 三种跑法（v0.6.41 起）

| 场景 | 命令 | 实测耗时 |
| --- | --- | --- |
| **提交前**（2 秒，只查结构） | `npm run preflight` | **0.03 秒** |
| **日常迭代**（只跑受影响的批次） | `npm run mutate:changed` | 1–6 分钟（6–17/70 批） |
| **发版前**（全量，必须） | `node test/mutate/run.mjs`（73 批 794 条） | ~25 分钟 |
| **发版前（推荐，并行）** | `npm run mutate:shard`（默认 4 片） | **约 8 分钟**（实测 73 批全中） |

`shard.mjs` 的做法：按批次体积做 LPT 分桶 → 每片一个 **独立 `git worktree`**（HEAD）+ 独立
`MINGDAO_MUTATE_LOCK_DIR` + 独立 `TMPDIR` → 同时跑 → 汇总。
注意它跑的是**已提交**的代码（worktree 检出 HEAD）；要跑未提交改动设 `SHARD_ALLOW_DIRTY=1`（会用 `git diff` 打补丁）。
