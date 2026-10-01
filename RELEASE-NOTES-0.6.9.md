# MingDao Harness v0.6.9 发布说明

> 状态：**已发布**（tag `v0.6.9`）。
> 补丁版：下游反馈的脱敏缺口 + 第三方 v0.6.7 文档审计逐条清偿 + 变异脚手架的平台假设修复。
> 变异验证 **6/6**（累计 **47** 条）；逐条复现见 `docs/internal/AUDIT-v0.6.1-第三方报告登记.md` §3.43。

## 最该先看的三条

1. **脱敏器漏掉了 Dify 的 `app-` 密钥**（下游实测反馈）。同一份日志里 `sk-` 被掩了、`app-` 原样漏出
   ——**半掩比不掩更危险**，贴日志的人会以为已经脱敏。影响审计日志、WebUI 日志与**诊断包**。
   修法不止补一行：前缀表收敛成单一来源 `SECRET_PREFIXES`，**每行必须带 `sample`**，
   由表驱动断言证明"这一行真的认得它声称认得的形态"（同类缺口 v0.6.3 已吃过一次）。
   同厂商的 `dataset-`（知识库 Key）一并补上。
2. **`docs/ARCHITECTURE.md` 重建**：旧版只提 12/88 个模块、把已发布功能写成"路线图"、
   还把内置 762KB 官方 BPE 词表的精确分词写成"启发式"。新版 290 行覆盖 **88/88** 模块 + 数据流 +
   **12 条已知边界**，并新增 CI 守卫（漏一个模块即红）。
3. **文档不再随 npm 包分发内部过程文档**：19 个计划/评估/审计文档移入 `docs/internal/`，
   `files` 只列用户面 8 个 + 2 个英文文档（此前 `npm i -g` 会装上 ~500KB 内部策略与审计散文）。

## 其余

- **英文入口**：`README.en.md`（含**安全模型表：机制 + 边界逐行**）与英文 `SECURITY.md`
  （私密披露渠道、范围、8 条部署加固清单、已知边界）；语言政策写进两个 README。
- **`PROVIDERS.md` 不再教用户把 Key 写进 `config.json`**；`PACK-API.md` 给未实现的 `require-citation` 打了标。
- **`@stable` API 表由代码生成**（`scripts/gen-api-table.mjs`）：旧表只列 32/70 且没有 Pack API v1。
- **`--help` 补齐** `batch`/`cost`/`pack`/`mcp`/`ledger replay`/`sync passwd|share|accept|conflicts`。
- **`install.sh`**：头注释不再推荐 `curl … | bash`，且**运行期拒绝**这种调用（给正确命令）。
- **CI 在 Windows 上变异验证整批假红**的根因修掉了（多行锚点按 LF 写、检出是 CRLF）；
  同时新增 `.gitattributes`（`* text=auto eol=lf`）——CRLF 检出已四次造成假红，这次根治。
- **新增文档守卫 `scripts/doc-lint.mjs`（8 项，接入 CI）**：链接 / 子命令覆盖 / PACK kind / 模型 id /
  ARCHITECTURE 覆盖 / 变异总数 / API 表 / 只读工具集合。

## 升级须知

1. **文档路径变化**：内部过程文档（`PLAN-*` / `STRATEGY-*` / `EVALUATION-*` / `AUDIT-*` / `HANDOVER` /
   `QA-REPORT` / `RELEASE-TRAIN` / `ROADMAP-NEXT` / `CHANGELOG-PACK` / `QUALITY-REVIEW-*`）移到了
   `docs/internal/`。你若有脚本或书签指向旧路径，请更新（全仓引用已同步改写）。
2. **npm 包内容变化**：`docs/` 不再整体分发，只含 `ARCHITECTURE/CONFIG/PROVIDERS/PACK-API/DEVELOPER/
   MIGRATION-DEYI-v0.5/CODE-SIGNING/SAVINGS-BENCHMARK`。
3. **`curl … | bash` 现在会被拒绝**（退出码 2）：请改用
   `curl -fsSL <地址> -o install.sh && bash install.sh <gitee|gitcode|github>`；
   确需管道调用可设 `MINGDAO_INSTALL_ALLOW_PIPE=1`。
4. **行尾**：仓内新增 `.gitattributes`（LF）。Windows 上重新检出即可，无需手工处理。
5. **脱敏边界**：`app-`/`dataset-` 后接 20 位以上纯字母数字会被掩码（含 `my-app-<长串>` 这种情况）——
   fail-closed 的刻意取舍，已写成断言。

## 验证

- 变异验证 **6/6**（`node test/mutate/run.mjs`，累计 **47** 条；总数由文档守卫比对）；
- 全门禁绿：`tsc` 0 错误、strict 棘轮 0/0、`smoke`、`e2e-local`/`e2e-web`/`e2e-schedule`、
  `api-contracts`、`bench`、`coverage`、`diagnose`，以及新增的 `scripts/doc-lint.mjs` 8 项守卫；
- 行为级复现：表驱动样例全掩 + 下游原场景（`dify=app-*** deepseek=sk-***`）+ 不误伤普通短横线标识。

## 已知边界（如实说明）

- **英文面只做了"评估与部署所需的最小面"**：`docs/CONFIG.en.md` 全文翻译、英文 CLI 帮助、i18n 框架未做。
- **不做高熵兜底**：前缀表仍要求"有人加一行"；未加的新厂商仍会漏（这是与误报之间的取舍，写在 §130 与 SECURITY.md）。
- **约 189 个断言仍是结构守卫**（检查源码文本），本批新增的文档守卫同样属于此类（其对象本就是文档）——
  行为化改造是 v0.7.0 的测试框架迁移范围。
- 仍未做：`agent.js` 拆分、`node:test` 迁移、Pack 子进程隔离、`ledger --sign-key`、
  Electron 更新包签名校验、IDE 令牌安全存储、出网闸门对子进程的补强。
