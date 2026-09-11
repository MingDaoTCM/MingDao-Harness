# 发版序列（Release Train）— 补齐历史版本 + 有序推进

> 起因：2026-09-11 负责人明确发版顺序。**这是一条有序流水线，不允许跳步或并行抢跑**——
> 目的正是消除「GitHub 发了新版，官网/npm/镜像还停在旧版」的半发布状态。
> 每一步的准入与验收见 `RELEASE-CHECKLIST.md`。

---

## 〇、现状盘点（2026-09-11 实测）

| 渠道 | 当前状态 | 缺口 |
| --- | --- | --- |
| **GitHub Release** | v0.4.5 / v0.4.6 / v0.5.0 均有 9 个附件 | 正文含已废止的承诺（负责人决定**不改历史正文**，只保证以后正确） |
| **Gitee / GitCode** | 未确认（本机无 API token） | v0.4.6 及以后未确认补齐 |
| **npm** | latest = **0.4.5**，已发布到 0.4.5 为止 | **漏发 v0.4.6、v0.5.0** |
| **官网** | 下载区此前停在 **v0.4.5** | v0.4.6 内容已改好并提交（`cd5057c`），**待部署** |

---

## 一、执行顺序（负责人指定）

### 第 1 步：官网发 v0.4.6 + Gitee/GitCode 补齐 v0.4.6 发行版

> 「先在官网发 v0.4.6，gitee/gitcode 补齐发行版，不能只顾着在 GitHub 发布。」

- [ ] 1a. 确认服务器 `/opt/1panel/www/sites/mingdao-site/downloads/` 下已有 0.4.6 的 5 个包
      （**没有就先收割**：从 GitHub Release v0.4.6 的附件取；否则官网链接会 404）
- [ ] 1b. 部署官网：`cd MingDao-Harness-Site && bash deploy.sh`（已提交的 `cd5057c`）
- [ ] 1c. 线上抽验：下载页 5 个链接 200，且 `sha256` 与 GitHub Release v0.4.6 一致
- [ ] 1d. Gitee / GitCode 创建 v0.4.6 Release 并**上传附件**
      （`bash scripts/publish-mirror-releases.sh 0.4.6 RELEASE-NOTES-0.4.6.md`）
- [ ] 1e. 核对三处附件 sha256 同批

### 第 2 步：npm 补齐漏发版本

> 「检查npm是否漏发，补齐。」

**已确认漏发：v0.4.6、v0.5.0**（npm latest 停在 0.4.5）。

- [ ] 2a. **从 tag 发布，不要从 main 发布**——npm 包内容必须与 tag 对应的源码树一致：
      `git worktree add /tmp/pub-046 v0.4.6` → 在该目录 `npm publish`
- [ ] 2b. **先发旧版再发新版会短暂把 `latest` 指到旧版**，因此旧版用非 latest 标签发，
      最后显式修正 latest：
      ```bash
      npm publish --tag backfill        # 在 v0.4.6 worktree 里
      npm publish --tag backfill        # 在 v0.5.0 worktree 里
      npm dist-tag add mingdao-harness@0.5.0 latest
      ```
- [ ] 2c. 验证：`npm view mingdao-harness versions` 含 0.4.6 与 0.5.0；
      `npm view mingdao-harness dist-tags.latest` = 0.5.0
- [ ] 2d. 从 npm 装一次实测：`npx -y mingdao-harness@0.5.0 --version`
- [ ] 2e. 确认 `skills-lib/` 在 tarball 内（v0.4.6 修过「36 技能只剩 14」，别再退回去）：
      `npm pack --dry-run` 里应有 `skills-lib/`

### 第 3 步：v0.5.0 与 v0.5.1 在四平台有序发布

> 「然后再有序的在四平台发布 v0.5.0 和 v0.5.1 版本。」

- [ ] 3a. **v0.5.0**：GitHub Release 已在（附件 9 个）→ 补官网、Gitee、GitCode、npm
- [ ] 3b. **v0.5.1**：内容 = v0.5.0 之后的**修复类**改动。**已勘察，实情与原先设想不同，见下**

#### 3b 勘察结论（2026-09-11 实测，非推测）

`v0.5.0` = `7e1845b`。其后到 HEAD 的分段是：

| 段 | 提交数 | 性质 |
| --- | --- | --- |
| `v0.5.0..588b414` | **16 个** | 全是修复（标签写作 `fix(v0.4.7)`：T1/T2/T3/T10/T19/T20/T21/T22/T23/T24 + 调度生命周期双 daemon 等） |
| `a471754` | 1 个 | **新功能**：执行账本 C1 |
| `528b360` | 1 个 | **混合**：约束引擎 fail-open 修复（`constraints.js`/`packs.js`）+ C2 决策回放（`replay.js`/`permissions.js`/`ledger.js`/`smoke.js`） |
| 其后 | — | C3 出网白名单、C4 内网安装（均为新功能） |

两个要点：
1. **`v0.5.1` 不是小补丁**——它至少含 16 个修复提交（v0.4.7 修复系列 + v0.4.6 审计收口）。
   这符合预期，只是量级要有心理准备。
2. **约束 fail-open 修复与 C2 回放被写在同一个提交里**，所以「只含修复」无法靠简单
   cherry-pick 得到——必须拆分 `528b360`。

三个可选做法（都能落地，代价不同）：

| 方案 | 内容 | 代价 / 风险 |
| --- | --- | --- |
| (a) `v0.5.1` = `588b414` | 16 个修复，**不含**约束 fail-open 修复 | 最省事，但下游会继续带着一个**静默失效的红线**（T25：`arg-forbid` 正则写错时永不命中）——不建议 |
| (b) `v0.5.1` = `528b360` | 16 个修复 + 约束修复 + **C2 回放** | 零手术；代价是补丁版里带进一个新增能力（`replay.js`），语义上属 minor 而非 patch |
| (c) 拆 `528b360` 后 `v0.5.1` = 修复部分 | 16 个修复 + 约束修复，C2 留到 v0.6.0 | 语义最干净，**且符合负责人「v0.6.0 完整版（C1-C4）」的表述**；代价是要拆一个混合提交（`smoke.js` 里 72/73 两组断言也要一并拆开）并**在两棵树上各跑一遍全门禁** |

#### 3b 候选树可用性（已实测：各自独立跑完整门禁）

| 候选点 | 内容 | 门禁结果 |
| --- | --- | --- |
| `588b414` | 16 个修复（不含约束 fail-open 修复、不含 C1/C2） | ✅ 6/6 全绿 |
| `528b360` | 16 个修复 + 约束 fail-open 修复 + C2 | ✅ 6/6 全绿 |

做法：`git worktree add --detach` 到两个提交，各自 `node test/run-all.mjs`
（零运行时依赖，不需要 `node_modules`，因此候选树可独立验证）。
结论：**(a) 与 (b) 都是「能立刻打 tag」的绿色状态**；(c) 需要先拆 `528b360`，拆完两棵树都要重跑。

> 倾向：按负责人「v0.6.0 完整版（C1-C4）」的表述，应走 **(c)**。
> 拆分是机械操作（我写的这个提交，边界清楚：`constraints.js`/`packs.js` 属修复，
> `replay.js`/`permissions.js`/`ledger.js` 的 replay 子命令 + `smoke.js` 73 组属 C2），
> 但必须两棵树都验证，不能只在一棵树上绿了就发。
- [ ] 3c. 四平台同步：GitHub tag 触发构建 → 官网 → Gitee/GitCode → npm

### 第 4 步：v0.6.0 完整版（C1–C4）

> 「最后再发 v0.6.0 完整版（C1-C4）。」

已完成 **C1 执行账本** + **C2 决策回放**；待完成：

- [ ] 4a. **C3 出网白名单 + 出网事件入账**（「数据不出门」自证）——含诚实边界：
      只覆盖内核自己发起的请求，bash 里用户自己 `curl` 不走闸门
- [ ] 4b. **C4 离线/内网安装包（air-gap）+ 信创/国产推理栈 Provider 预设**
- [ ] 4c. C1 可选 Ed25519 签名（`--sign-key`，当前**未实现**，已在 `PLAN-v0.6.0.md` C1.7 登记）
- [ ] 4d. 按 `RELEASE-CHECKLIST.md` 走完整流程：自检 → 3820 人工验收 → 四平台 + 官网

---

## 二、本机缺失的凭据与访问（阻塞项）

发版序列的每一步都依赖下列通道，本机实测结果：

| 通道 | 状态 | 用途 | 需要什么 |
| --- | --- | --- | --- |
| GitHub ssh | ✅ 已授权 | 推 tag / 代码 | — |
| GitHub Release 正文改写 | ⚠️ 无本地 PAT（`gh` 未安装） | 改历史正文 | 已加 CI 作业；负责人决定**不改历史** |
| Gitee ssh | ✅ 已授权（首次需信任主机密钥） | 推 tag | — |
| GitCode ssh | ✅ 已授权（首次需信任主机密钥） | 推 tag | — |
| **Gitee / GitCode Release API** | ❌ 无 token | 建 Release + 传附件 | `MINGDAO_GITEE_TOKEN` / `MINGDAO_GITCODE_TOKEN` |
| **npm 发布** | ❌ 未登录（ENEEDAUTH） | 发 0.4.6 / 0.5.0 / 0.5.1 | `NPM_TOKEN` 或 `npm login` |
| **官网部署 + 镜像脚本** | ❌ `mingdao-server` 别名在本机不存在 | `deploy.sh`（scp）/ 镜像脚本读取服务器 `/opt/.../downloads` | `mingdao-server` 的 ssh 配置（主机/密钥） |

> 凭据一律**只从环境变量或本地 gitignored `.env` 读取，绝不入库**（与既有约定一致）。

---

## 三、已知平台限制（不要当成脚本 bug）

- **Gitee 附件单文件上限 100MB**，而 AppImage 约 103.7MB **必然被拒**。
  `publish-mirror-releases.sh` 已改为逐文件判大小、超限跳过并记入结尾清单，
  AppImage 在 gitee 上以官网直连为准（正文已带官网链接兜底）。
- **镜像上传耗时**：7 个包约 640MB，两平台并行约 3–5 小时；脚本设计为在服务器上
  `nohup` 后台跑，日志 `/tmp/mirror-release-<版本>.log`，完成标志 `MIRROR_RELEASE_DONE`。
- **npm 不可撤回**：版本号一旦发布不能复用，因此发布前必须 `npm pack --dry-run` 核对内容。

---

## 四、进度（滚动更新）

| 步骤 | 状态 |
| --- | --- |
| 1 官网 v0.4.6 | 🚧 内容已改好并提交（`cd5057c`），待服务器访问后部署 |
| 1 Gitee/GitCode v0.4.6 | ⏳ 待 token |
| 2 npm 补齐 0.4.6 / 0.5.0 | ⏳ 待 token（已确认漏发，方案已定：从 tag 发 + `--tag backfill` + 修正 latest） |
| 3 v0.5.0 四平台 | ⏳ |
| 3 v0.5.1 | ⏳ 待确认「补丁版是否可含新功能」 |
| 4 v0.6.0（C1–C4） | 🚧 C1/C2 已完成，C3/C4 待开发 |
