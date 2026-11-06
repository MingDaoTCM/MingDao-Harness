# MingDao Harness v0.6.38 发布说明

> 状态：**已发布**（tag `v0.6.38`）
> 主题：**修 macOS CI 两条确定性测试缺陷（无产品行为变化）**
> 范围：`v0.6.37..HEAD` 1 个提交（`b670aef`，仅 `test/`）。
> 影响面：**无界面 / API / 账本 / 同步 / 行为变化**；纯测试与变异判据改动。

---

## 〇、与 v0.6.37 的关系（先读）

v0.6.37 已正常发布（GitHub / Gitee / GitCode / npm / 官网 / 国内镜像，`verify-release` exit 0）。
但它的 **macOS CI 腿在变异自审（step 44）红**，两次都指向同一处。这不是产品缺陷，也不是"慢 runner 的运气"，
而是**测试期望缺口**：

- `batch47 ④`：变异把瞬时重试预算改成 **50ms**，而注入的 EACCES 退避是 5+10+20=**35ms**。
  慢 runner 上"35ms + 开销"超过 50ms，套件在**更早**一条断言（"遇 EACCES 不得直接失败"）先红；
  该文案不在本条的 `expect` 里 → 被判为"逃逸"。
- `batch60 ⑩`：去重无锁的判据只靠"同一刻放行"的并发交错，快机器上**可能不复现**（0.6.37 macOS 首跑 exit=0）。

本版只改 `test/`，把这两条变成**确定性**判据；产品代码一行未改。

---

## 一、用户可见

**无变化。** 没有新功能、没有界面/文案/命令/配置变化，也没有更新行为变化。

发布树 5 张界面截图（1440×900，Electron 真实渲染）sha256 与 v0.6.37 **逐字节一致**，见 §三。

---

## 二、开发者可见

### 2.1 `batch47 ④`：预算 50ms → 300ms（`b670aef`）

- 变异目标仍是 `src/atomic-write.js` 的 `TRANSIENT_RETRY_BUDGET_MS = 2000` → **300**：
  仍远小于 2s（缺陷语义不变），但足够跨过 5+10+20=35ms 的退避窗口，让**本意**那条断言
  （"瞬时拒绝的重试预算应接近 2s"）来红，而不是更早的 EACCES 断言。
- `expect` 同时收录两条可能的失败文案（`some` 语义：任一命中即算抓到），避免别的机器上再出现同类竞态。
- 复跑 **9/9**。

### 2.2 `batch60 ⑩`：新增确定性锁等待判据（`b670aef`）

- 新判据不靠并发交错：子进程**先持有记忆文件的锁、再报 READY**（600ms 忙等），父进程随后调
  `dedupeMemory()`，断言它**必须等待**（实测 **625ms**）。
- 无锁变异会立刻返回（个位数毫秒）→ 当场红，与机器快慢无关。
- `test/state-integrity.js` 从 **10 项 → 11 项**；`batch60` 复跑 **11/11**。

### 2.3 测试与门禁

- 全量变异仍为 **66/66 批、735 条**；`run-all` 仍 **35 套**（`state-integrity` 套件内新增 1 项断言，
  不新增套件）。
- `update-signing` / 密钥环 / 签名脚本 / 官网 404 / 国内镜像等 0.6.37 内容**均未改动**。

### 2.4 签名状态（不变）

- 本版**仍不发布 `.sig`**，也不设置 `UPDATE_SIGNING_ENABLED`；`/updates/*.sig` 不应存在。
- 密钥环（旧钥 `legacy-2025` + 新钥 `2026-11`）与签名脚本沿用 0.6.37；签发顺延到下一版。

---

## 三、门禁（`b670aef`）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误**（exit 0） |
| `npm run typecheck:strict` | 当前 **0** 条 / 基线 **0** 条（✅ 未恶化） |
| `node test/smoke.js` | **156 组断言全通过**（exit 0） |
| `node test/run-all.mjs` | **35/35 套通过，0 失败** |
| `node test/mutate/run.mjs` | **66/66 批、735 条全中**（有效判定，0 逃逸） |
| `node scripts/doc-lint.mjs` | 全绿（⑥ 变异总数：实际 735 = README 735） |
| `node src/cli.js diagnose` | 自检通过，报告已脱敏 |

### 3.1 发布树截图（1440×900，Electron 真实渲染）

`node scripts/ui-shot.mjs --out /tmp/shots-0638`。

| 页面 | `/tmp/shots-0638` sha256 | 与 v0.6.37 一致 |
| --- | --- | --- |
| `home.png` | `00a68c1358e623b33d794da23944680c1e6350968ca2d3640caa54570fed1b5e` | ✅ 一致 |
| `settings.png` | `1c27e00102ad098ef28baa24419098162f05e291a53b0b2a90e49a4aa8dac414` | ✅ 一致 |
| `palette.png` | `f9369ef19cd7659da12711abcb34225cc549b30c35a572dec363a2406f018dcb` | ✅ 一致 |
| `session.png` | `f285c44022a3a0d7c1c23d1da6724c2455394176b956c3ebfae89fffa3ed3e11` | ✅ 一致 |
| `sheet.png` | `cdc5ea7cb88b5c68482b56361955374f131ac8748d9d5d64ccdd950812dcb6ca` | ✅ 一致 |

> 本版 `src/web/` 零改动；比对基准为 `/tmp/shots-0637`（0.6.37 发布树实测）。

---

## 四、已知边界

- 本版**只修测试判据**，不改变任何运行时行为；若 `b670aef` 的 macOS CI 仍红在同一处，
  说明还有未识别的平台差异，**不应发布**（见发版报告中的 CI 实测）。
- macOS CI 的五腿结果以 GitHub Actions 对 `b670aef` / tag 的实测为准；本地为 macOS，不能替代 CI。
- 本版仍不发布 `.sig`；更新来源签名的密码学校验仍从**下一版**开始。
- Windows 代码签名（Authenticode）仍未接入，与更新来源签名是两件事。
