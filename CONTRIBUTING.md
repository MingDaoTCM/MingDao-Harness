# 贡献指南（MingDao Harness）

感谢你愿意花时间。这个项目的核心资产是**可验证的正确性**——所以下面的要求基本都围绕"怎么证明你的改动是对的"。

## 环境

- Node.js **≥ 18.17**（CI 跑 18 / 20 / 22 与 Windows、macOS 的 20）
- `npm ci`（只有 `devDependencies`：typescript 与 @types/node；**运行时零依赖**，别引入运行时依赖）

## 提交前必须跑（与 CI 一致）

```bash
npm run typecheck            # tsc -p tsconfig.full.json，必须 0 错误
npm run typecheck:strict     # strict 棘轮：错误数不得高于基线
node test/smoke.js           # 离线冒烟（~156 组断言）
node test/e2e-local.js       # 真实进程 / HTTP / 会话
node test/e2e-web.js
node test/e2e-schedule.js
node test/api-contracts.js   # HTTP 契约
npm run bench                # 省钱/路由/计费的基准回归
node test/mutate/run.mjs     # 变异验证：断言必须能抓到"把修复改坏"
node scripts/doc-lint.mjs    # 文档守卫：链接/命令表/kind/模型 id/架构文档/API 表
```

## 改 bug 的四步（本项目的硬要求）

1. **先复现**：写一段最小复现（命令行、探针脚本或失败用例），先看它红。
2. **定级与说明**：说清影响面与失败方向（宁可误拦不可漏放？还是反之）。
3. **修**：优先**收口到单一来源**。本项目最常见的缺陷形态是"同一规则多份实现 → 最弱的那份说了算"，
   以及"检测到局部事实 → 升级成全局结论"。修之前先问：这条判据是不是已经有第二份实现了？
4. **回归 + 变异**：
   - 在 `test/smoke.js` 末尾新增一节（`// ---------- NNN. ...`），先写**行为级**断言，
     确实无法行为级验证的才写结构守卫，并注明原因；
   - 在 `test/mutate/batch*.mjs` 加一条变异（`name` / `file` / `from` / `to` / `expect` / `run`），
     `expect` 里的关键词必须是断言失败信息里的**原样子串**（注意别带 markdown 的 `**`，会匹配不上）；
   - 跑 `node test/mutate/run.mjs`，**没被抓到的变异等于断言没意义**。

## 文档

- 规范文档是**中文**（`README.md`、`docs/*.md`）；`README.en.md` 只覆盖"评估与部署所需的最小面"。
- 内部过程文档放 `docs/internal/`（不随 npm 包分发）。
- 改了 API / 约束 kind / 模型 id / 目录结构，记得跑 `node scripts/doc-lint.mjs`——
  它会检查架构文档是否覆盖全部 `src` 模块、开发者指南的 API 表是否与 `src/index.js` 一致等。

## 安全

不要在 issue / PR 里贴真实 API Key、令牌或诊断包（诊断包虽已脱敏，仍请先自查）。
发现安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道，不要开公开 issue。

## PR

- 一个 PR 一件事；标题写清"修了什么、为什么"。
- 描述里给出：复现命令、修复前后的行为、跑过哪些门禁、**有没有已知边界没覆盖**。
- 项目最看重的不是"改得多"，而是"**说清楚哪里没覆盖**"——如实标注边界比粉饰更受欢迎。
