# MingDao Harness v0.6.39 发布说明

> 状态：**已发布**（tag `v0.6.39`）
> 主题：**输入队列 + CI 直推产物 + 更新签名阶段一**
> 范围：`v0.6.38..HEAD` 3 个提交（`a2886bd`、`d1768dd`、`c75de8b` + 本版发布前的 CI 修正）。
> 影响面：Web UI 一处交互增强（生成中继续输入 → 排队）；桌面版**分发链路**两处 CI 能力
> （直推源站、更新来源签名阶段一）。**无 API / 账本 / 数据格式 / 配置变化。**

---

## 〇、先读：两件"第一次真实生效"的 CI 能力

本版之前，桌面产物靠"CI 构建 → GitHub Release → 服务器从 GitHub 收割"两跳；更新包来源签名
只有代码与判据、发布链路**从未签过**。本版把这两件事接上，但都**刻意留了边界**：

| 能力 | 本版做什么 | 本版**不**做什么 |
| --- | --- | --- |
| 直推源站 | publish 用 `DEPLOY_SSH_KEY` 把安装包 scp 到源站 `downloads/`（失败不判红） | 不直推 `latest*.yml`；失败仍由收割兜底 |
| 更新来源签名 | `UPDATE_SIGNING_KEY` 存在时签安装包与 `latest*.yml`，`.sig` **只进 GitHub Release** | **站点 `/updates/` 绝不放 `.sig`**（阶段二再做） |

> ⚠ `/updates/` 为什么不放：`decideUpdatePolicy` 对"有签名但验不过"是 **reject**。
> 存量客户端（≤0.6.35）内置的是旧公钥，现在把用新私钥签的 `.sig` 放上站点，它们会
> **永久拒绝更新**，只能手动重装。把 `.sig` 先关在 Release 里（可审计、客户端不读）是唯一安全做法。

---

## 一、用户可见

### 1.1 生成中继续输入 → 自动排队（`a2886bd`）

**以前**：生成中按 Enter 只弹一条「⏳ 上一个任务仍在执行…尚未完成」，输入留在框里但不会被执行，
用户很容易以为消息丢了。

**现在**：

- 生成中按 Enter → 这条输入**进入队列**，输入框清空，状态栏提示「已加入队列（共 N 条），本轮结束后自动发送」；
- 输入框上方出现队列条：每个 chip 显示 **序号 + 截断文本（42 字符）+ ✕**；
- 点 chip 的**文本** → 该条放回输入框编辑，同时从队列移除（避免"编辑完发两次"）；
- 点 **✕** → 从队列删除；
- 本轮结束（正常完成或出错）→ **自动依次发送**队首，继续排空；
- 点「■ 停止」中止时 → **队列保留、不自动发**。中止的语义是"停下"，此时接着发下一条会违背用户意图；
  用户可自行编辑/删除/重新发送；
- 上限 **20 条**；空文本不入队；满员会给出可读提示。

边界：队列是**当前页面的一次性内存状态**（刷新即丢），不是持久任务队列——它表达的是"这一刻的输入意图"。

### 1.2 无其他界面变化

队列条默认隐藏，未排队时界面与 0.6.38 完全一致（发布树 5 张截图的 sha256 与 0.6.38 全同，见 §三）。

---

## 二、开发者可见

### 2.1 队列的纯逻辑与测试

- `src/web/viewmodel.js` 新增（纯函数，DOM 只负责渲染）：
  - `enqueueMessage(queue, text, id)`：空文本拒绝（`empty`）、满 20 拒绝（`full`）；
  - `dequeueMessage(queue, id)`：按 **id** 移除（不是按索引）；不存在时原样返回；
  - `shouldDrainQueue({queue, generating, aborted})`：**`aborted` 永远为 false**，这是"中止不排空"的唯一判据；
  - `queueView` / `queueLabel`：序号与 42 字符截断；
  - `QUEUE_MAX = 20`、`QUEUE_LABEL_MAX = 42`。
- `test/viewmodel.js` **110 → 134 条**；新增 `test/mutate/batch78-queue.mjs` **8 条**（满员/空文本/按 id/
  中止不排空/截断/序号等）。
- 全量变异：**67 批 / 744 条**（`c75de8b` 的签名脚本改动 +2 条：`batch77 ⑨` 与总数更新）。

### 2.2 CI 直推产物到源站（`DEPLOY_SSH_KEY`）

`desktop.yml` 的 `publish` 新增步骤「直推产物到源站（可选，失败不判红）」：

- **Secret 名称**：`DEPLOY_SSH_KEY`（私钥全文）、`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_DIR`；
- 目标：`$DEPLOY_DIR/downloads/`，推安装包（exe/dmg/zip/AppImage/deb）与 `*.blockmap`；
- `continue-on-error: true`：失败**不判红**，官网收割（`HARVEST_PROXY` + 续传）仍是兜底；
- 为什么：从 GitHub 收割实测低到 0.7KB/s，633MB 要几小时；Actions 出网到香港通常 5–20MB/s，
  直推把这一跳从小时级降到分钟级；
- 本版**不直推** `latest*.yml`：双架构合并版必须由服务器侧 `gen-update-feeds.sh` 生成。

### 2.3 更新来源签名阶段一（`UPDATE_SIGNING_KEY`）

- 触发条件：仓库 Secret `UPDATE_SIGNING_KEY`（ed25519 私钥 PEM）**存在**即执行；
- 动作：对 Release 里的安装包与 `latest.yml` / `latest-linux.yml` 签名，产出 `<文件名>.sig`
  （内容 `ed25519:<base64>`），**只上传到 GitHub Release**；
- **边界**：站点 `/updates/` 下不得出现任何 `.sig`。客户端按
  `https://harness.mingdao.ai/updates/<安装包名>.sig` 取签名；阶段一放上去会让旧公钥客户端永久拒绝更新；
- **阶段二切换条件**：0.6.36+（含密钥环）覆盖绝大多数活跃用户后，把 Release 里的 `.sig`
  复制到站点 `/updates/` 即可，**不需要改代码**。切换前必须实测 0.6.35 / 0.6.37 / 0.6.38
  客户端能从 0.6.39 正常更新；若旧版拒绝，**立即删除 `/updates/*.sig`**（回滚只需删文件）。
  详见 `docs/CODE-SIGNING.md` §6；
- **发布前修正**（`c75de8b` + 本版 workflow 改动）：
  1. 原写法 `if: ${{ secrets.UPDATE_SIGNING_KEY != '' }}` 在 GitHub 的 **step 级 `if` 里是非法上下文**
     （`secrets` 只能用于 job 级 `env` 等位置），整份 workflow 会被判 Invalid、Desktop 根本不启动。
     改为 job 级 env 折算 `HAS_UPDATE_SIGNING_KEY` / `HAS_DEPLOY_SSH_KEY`，step 判 `env.*`；
  2. `download-artifact` 把产物解到 `artifacts/<name>/`，而签名脚本原先只扫单层 → 「签名完成：0 个」且
     `exit 0`。`c75de8b` 让 `listSignableFiles()` **默认递归**、`.sig` **保留相对目录**（不同平台的
     `latest.yml` 不会互相覆盖），`flat: true` 时重名报 `skipped`；
  3. 直推的 `artifacts/*.exe` 同样匹配不到子目录，且失败被 `|| true` 吞掉 → 改用 `find` 收集文件，
     成功后打印 `DIRECT_PUSH_DONE`、失败打印 `::warning`。

### 2.4 `ui-shot --eval`

```bash
node scripts/ui-shot.mjs --out /tmp/shots --eval "document.querySelector('#queueStrip').style.display='flex'"
```

- 在**第一次截图之前**执行给定 JS（同一进程、同一页面），因此会影响本次运行的全部 5 张截图；
- 用于构造"只能由交互产生"的界面状态（队列条需要"生成中"才能出现）；
- 默认基线（不带 `--eval`）与 0.6.38 逐字节一致。

### 2.5 复盘文档

`docs/REVIEW-v0.7-vs-DSH-Octop.md`：对照 DSH 与 Octop 实码，纠正了两处归属错误
（`tool_search` 属 Octop、DSH 没有；SSE `after_seq` 属 Octop、DSH 用 cursor 重取），
并列出 0.6.40 的插话（steer）路线。**不属于发布说明正文**，仅供开发者参考。

---

## 三、门禁（发布树）

在最终门禁 SHA 上逐项运行，全部 exit 0：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条 |
| `node test/smoke.js` | 156 组断言通过（单独 + 私有 `TMPDIR` 两次） |
| `node test/run-all.mjs` | **35/35 套通过，0 失败** |
| `node test/mutate/run.mjs` | **67/67 批、744 条全中，0 逃逸** |
| `npm run coverage` | 只报告，exit 0（数据见下） |
| `node scripts/doc-lint.mjs` | 全绿 |
| `node src/cli.js diagnose` | exit 0（密钥/token/私网路径已脱敏） |

覆盖率（只报告，不判失败）：

```
行覆盖率（分母 = src 全部 94 个文件）：68.7%（18764/27313 行）· 阈值 72.5%
  · code-lines  68.7%（18764/27313 行）  基线 72.5%  ⛔ 低于基线 3.8pp（仅报告）
  · all-lines   49.5%（18764/37899 行）  基线 52.3%  ✅
  · functions   70.1%（2924/4173 个）     基线 75.4%  ✅
```

### 3.1 发布树截图（1440×900，Electron 真实渲染）

`node scripts/ui-shot.mjs --out /tmp/shots-0639`；与 `/tmp/shots-0638` 逐张比 sha256。
队列条默认隐藏，预期**全同**：

| 页面 | `/tmp/shots-0639` sha256 | 与 v0.6.38 |
| --- | --- | --- |
| `home.png` | `00a68c1358e623b33d794da23944680c1e6350968ca2d3640caa54570fed1b5e` | ✅ 一致 |
| `settings.png` | `1c27e00102ad098ef28baa24419098162f05e291a53b0b2a90e49a4aa8dac414` | ✅ 一致 |
| `palette.png` | `f9369ef19cd7659da12711abcb34225cc549b30c35a572dec363a2406f018dcb` | ✅ 一致 |
| `session.png` | `f285c44022a3a0d7c1c23d1da6724c2455394176b956c3ebfae89fffa3ed3e11` | ✅ 一致 |
| `sheet.png` | `cdc5ea7cb88b5c68482b56361955374f131ac8748d9d5d64ccdd950812dcb6ca` | ✅ 一致 |

---

## 四、未做 / 已知边界

- **插话（steer）不在本版**：0.6.40 做服务端 `/api/steer`、步边界消费、插话不结束本轮。
  本版只有"排队"一条 lane，输入不能打断当前步。
- **`.sig` 站点发布在阶段二**：本版 `/updates/*.sig` 必须保持 **404**；阶段一只有 Release 里有 `.sig`。
- **Windows Authenticode 仍未接入**：与更新来源签名是两件事，SmartScreen 提示不变（官网已给绕过说明）。
- **队列不持久化**：页面刷新/关闭即丢；这是有意的（"这一刻的意图"），不是任务系统。
- 直推若失败不影响发布：收割仍是兜底，但首次运行需要看原始输出确认真的推成功。
