# MingDao Harness v0.6.10 发布说明

> 状态：**已发布**（tag `v0.6.10`）（`npm version` 时由 `scripts/bump-changelog.mjs` 自动翻转）。
> 补丁版，**零行为变化**：只把"形似密钥"的字面量从公开仓库与 npm 包里清掉。

## 为什么发这一版

下游先报了「PR #1 暴露了密钥」。查证结论是：那些是 `app-<24 位 base62>` 这类**占位样例**
（按字母表顺序拼的，不是任何真实凭据）——但在公开仓库里长得就像密钥：会被密钥扫描命中，
也会让读代码的人以为仓库漏了真钥（下游自己也是因此先报了"暴露"）。

PR #10 提出把 `sample` 改为**运行时拼装**，已合并；这一版把**其余同类字面量**也一次清完：
`test/smoke.js` 的样例与掩码期望、三个 e2e 套件的夹具密钥、内部归档文档里的样例。

## 变化

- `src/redact.js`：`sample` 用 `sampleOf(prefix)` 拼装（掩码规则与口径**一字未改**）。
- 测试夹具统一走 `FAKE(prefix, n)` 拼装；新增 `test/fixtures/fake-secrets.mjs` 记录原因。
- **GitHub 端已开启 secret scanning + push protection**：以后真有密钥被 push 会被直接拦下。

## 升级须知

无。这一版对使用者**没有可感知变化**；`npm i -g mingdao-harness` 或桌面版自动更新即可。
你本机凭证库、配置、账本、会话都不受影响。

## 验证

- 全仓 `grep` 无 `(app|dataset)-[A-Za-z0-9]{20,}` / `sk-[A-Za-z0-9]{12,}` 形态字面量；
- 门禁全绿：`tsc` 0 / strict 0-0 / `smoke` 156 组 / `e2e-local` 17 项 / `e2e-web` 24 项 /
  `e2e-schedule` 10 项 / `api-contracts` / `bench` / `mutate` **5 批 47 条全中** /
  `coverage` / `doc-lint` 8 项 / `diagnose`。

## 已知边界（如实说明）

- 这一版**只清理"形似密钥的占位样例"**；历史提交里仍保留这些占位串（它们不是真实凭据，
  因此没有做会破坏 tag/Release 的历史重写）。若将来真的误提交了**真实**密钥，
  唯一有效的处置是**先轮换**（撤销该凭据）再清理历史——轮换永远优先于清理。
- 桌面版安装包与官网下载页（`harness.mingdao.ai`）本轮未同步刷新：安装包内容与 v0.6.9 行为等价。
