# v0.4.0 规划：阶段 A「契约化」——把 MingDao 变成可二次开发的开放内核

> 依据：docs/STRATEGY-NEXT.md（已确认：垂直产品 × 开放内核；本地/私有化第一公民与 DeepSeek 省钱并列双主攻；v0.4.0 先做契约化）。
> 原则：不新增重架构、不动零依赖根基；把**已存在**的扩展点从「能用」升级为「有契约、有文档、有示例、有测试」的一等公民。
> 节奏：小版本分批，每批全绿 + 发布前自检；实现后不发布，等用户在 3820 验收确认。

## 一、现状盘点（扩展点已存在，缺契约）

- 公共 API 面：`src/index.js` 已导出 `createAgent` / `createProvider` / 工具 / 上下文 / 权限 / 模型 / 会话 / 计价 / tokenizer 等（42 行导出，无 semver 承诺、无开发者文档）。
- 扩展点：自定义 Provider 模块（`<home>/providers/*.mjs`）、hooks（PreToolUse/PostToolUse）、用户级/项目级技能、MCP 客户端、`customModels`——全部可用，但契约散落、无统一示例。

## 二、本版目标

1. **公共 API 冻结与文档**：`docs/DEVELOPER.md`（API 参考 + 最小示例集），`src/index.js` 导出面逐项标注稳定性（stable / experimental）。
2. **Agent Preset（智能体预设）**：声明式文件 = { 系统提示, 工具集白名单, 权限策略, 记忆策略, 模型建议 }，放 `<home>/presets/` 或 `<项目>/.mingdao/presets/`；CLI（`mingdao --preset <名>`）与 WebUI 一键选用。
3. **第三方工具注册**：`registerTool({ name, schema, run })` 程序化注册 + `config.tools` 声明式挂载，工具进审计/权限/省钱 schema 链路。
4. **契约测试**：预设加载、工具注册、公共 API 面的自动化断言入 smoke。

## 三、任务分解（实现顺序）

1. `src/presets.js`（新）：预设目录发现/加载/校验（JSON，schema 校验 + 错误可读）；内置一个示例预设（如「本地模型审计」：system 提示 + 只读工具集 + auto 权限 + 语义记忆）。
2. `src/index.js`：导出 `loadPresets`/`resolvePreset`/`buildPresetConfig`；导出稳定性注释分 stable/experimental 两组。
3. `src/tools/index.js`：`registerTool` + `listRegisteredTools`；`config.tools` 声明式工具挂载（name/schema/command 三态：内置函数引用 / bash 命令包装 / 自定义 Provider 函数）；注入 dispatch + 权限引擎 + 审计。
4. CLI：`mingdao --preset <名>` 参数 + REPL `/preset`；WebUI 模型选择器旁加预设下拉（复用 /api/models-config 模式新增 /api/presets）。
5. `docs/DEVELOPER.md`：API 参考表（stable/experimental 标注）+ 5 个最小示例（自定义工具 / 自定义 Provider / 自定义权限 / 自定义记忆 / embed 进自己的程序）。
6. 测试：smoke 新增「presets：发现/校验/应用」「第三方工具：注册/调度/审计归属/权限拦截」「公共 API：导出面断言」；api-contracts 新增 /api/presets 契约。
7. 全绿（smoke/e2e/bench/strict/typecheck）+ 自检 → 3820 验收 → 等确认后发布。

## 四、验收标准

- `npm i mingdao-harness` 后按 DEVELOPER.md 三步跑通一个自定义智能体（预设 + 自定义工具）。
- 预设文件语义与 DSH profile 对齐但零依赖、JSON 声明式。
- 全绿测试门禁 + strict 0/0 + 发布前自检；用户在 3820 验收后再发布。

## 五、非目标（顺延后续版本）

- 预设市场/registry 分发（阶段 B）、本地模型一键接入预设（阶段 B）、企业私有化包（阶段 C）。
- 不引入 Cordis/插件内核；不做云平台/账号体系。
