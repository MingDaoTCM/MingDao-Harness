# Pack API 变更日志（Changelog-PACK）

只记录 **Pack API**（`pack.json` / `pack.mjs` / 约束引擎 / `ctx.llm()` / CLI）的契约变更。
产品功能变更见根目录 `CHANGELOG.md`。

兼容策略：同一 major 内向后兼容（minor 只增不改）；支持窗口 = 最近 2 个 minor。
任何改动必须同步更新 `PACK-API.md` 与兼容性矩阵。

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
