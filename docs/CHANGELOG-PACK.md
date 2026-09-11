# Pack API 变更日志（Changelog-PACK）

只记录 **Pack API**（`pack.json` / `pack.mjs` / 约束引擎 / `ctx.llm()` / CLI）的契约变更。
产品功能变更见根目录 `CHANGELOG.md`。

兼容策略：同一 major 内向后兼容（minor 只增不改）；支持窗口 = 最近 2 个 minor。
任何改动必须同步更新 `PACK-API.md` 与兼容性矩阵。

## v1.1（2026-09-11，随内核 v0.6.0）— 约束引擎勘误与收紧

**兼容性**：`result-forbid` 属**补实现**（PACK-API.md 的 v1 表格本就列出它，但 kind 集合与引擎都没有）；
pattern 校验收紧会让**本来就写错**的 Pack 从「静默装载成功」变为「装载失败」——这是刻意的行为变更，
下面说明理由。正常写法不受影响。

- **修 fail-open**：`arg-forbid` 给了非法正则时，求值失败 → `re` 为 null → 红线**永不命中**，
  且不进 `invalid`、装载也不报错。作者以为有红线、实际没有——这与约束引擎自己声明的
  「fail-closed：求值异常一律按阻断处理」直接矛盾。`output-forbid` 的同类情况则是被丢进
  `invalid` 后从生效集合消失，同样是红线静默消失。现已改为：装载时拒绝坏 pattern；
  运行期对作用域类 kind（`arg-forbid`/`result-forbid`）按 fail-closed 只阻断该工具并说明配置有误。
- **修「缺 pattern 比写的严」**：缺失 pattern 会退化成 `new RegExp('')`（匹配一切），
  即「忘了写」变成「该参数任何取值都拦」，且理由印出 `/undefined/`。现由装载校验直接拒绝。
- **补 `arg-forbid` 的 `arg` 必填校验**：此前只校验 `tool`，漏写 `arg` 时引擎读 `args[undefined]`
  并与字符串 `"undefined"` 做匹配，属于「看起来在跑、其实判错对象」。
- **实现 `result-forbid`**（契约已列、实现缺席）：结果序列化后命中 pattern 即拒绝该结果并要求重采。
- **kind 集合单一来源**：`packs.js` 曾另有一份 `CONSTRAINT_KINDS` 副本，已与引擎 `KINDS` 漂移；
  现统一为引擎那一个（`CONSTRAINT_KINDS` 保留为别名）。
- **契约缺口登记**：`require-citation` 与 `mingdao constraint test <pack>` 在 PACK-API.md 中列出但
  尚未实现，已在 `PACK-API.md §4.1` 明确标注「请勿依赖」，不再作为承诺留在文档里。

## v1（2026-09-11，随内核 v0.5.0 冻结）

**首次冻结。** 范围：

- `pack.json` manifest：`apiVersion` / `name` / `version` / `engines.mingdao` / `permissions` / `contributes`
- `pack.mjs` contributions：`tools` / `promptSections` / `constraints` / `memorySchema`
- 约束引擎 kind：`tool-deny` / `tool-arg-require` / `arg-forbid` / `output-forbid` / `completeness` / `confirm`
- 约束执行时机：PreToolUse / PostToolUse / 输出前
- `ctx.llm()` 统一模型出口（自动入账 + 四维归因）
- CLI：`mingdao pack list|verify|new|info|test`
- 兼容窗口：内核 0.5.x / 0.6.x 支持 `apiVersion: 1`

**已拍板的三条约束**（见 `PACK-API.md` §9）：Pack 不得覆盖内置 Provider；`block-and-rewrite` 计费归 Pack；Pack 内 `fetch` 允许但需白名单 + 入账 + 静态告警。
