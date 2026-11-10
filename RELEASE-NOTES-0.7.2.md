# MingDao Harness v0.7.2 发布说明

> 状态：**已发布**（tag `v0.7.2`）
> 主题：**修复桌面更新无法自动关闭**
> 范围：`v0.7.1..HEAD` 的 2 个提交——`dc8a9cf`（桌面更新安装时显式置位退出标记）、
> `0378e2b`（发布清单：签名必须先于 feed/update-downloads）。
> 影响面：**桌面端 macOS 自动更新「立即重启安装」路径**。
> 对话、工具、账本、调度、同步、认证的对外行为**均未改变**。
> **用户可见：有**（更新安装会真正自动退出并完成）。

---

## 〇、先读：本版改了什么

macOS 上点「立即重启安装」后应用不退出、需手动关闭才能继续安装。根因是两条并存：
「拒绝更新」路径曾把 `autoInstallOnAppQuit` 置 false，以及托盘 close 处理器在 `quitting`
未置位时把窗口 `hide` 而非 `close`。本版在放行分支显式置位两处，保证「重启安装」一定先真正退出。

---

## 一、用户可见

### 1.1 更新安装会真正自动退出并完成

- macOS 点「立即重启安装」后，应用现在会**自动退出**并完成安装，不再需要手动关闭。
- 修法（`desktop/main.js` 放行分支）：
  ```js
  autoUpdater.autoInstallOnAppQuit = true;
  quitting = true;
  autoUpdater.quitAndInstall();
  ```

---

## 二、根因（两条并存）

1. **`autoInstallOnAppQuit` 遗留 false**：一旦曾因「拒绝更新」被置 false，
   `quitAndInstall()` 会直接调 `install()` 而不 `app.quit()` → 运行中的 .app 无法被替换
   （macOS 替换 bundle 需要进程先退）。
2. **托盘 close 处理器 hide 而非 close**：`quitting` 未置位时，关闭窗口被处理成 `hide`
   而非 `close`，应用仍在运行。

`before-quit` 里的 `quitting = true` 是兜底；放行分支显式置位是为了覆盖「`quitAndInstall`
内部直接 `install()`、不经 `app.quit()` 触发 `before-quit`」的那条路径。

---

## 三、发布流程

- `docs/RELEASE-CHECKLIST.md` 新增顺序硬约束：**签名发布必须排在 `gen-update-feeds` 与
  `update-downloads` 之前**（v0.7.1 空窗事故：feed 已翻到新版、`.sig` 仍 404 → 客户端弹
  「未验证来源签名」）。

---

## 四、已知遗留（诚实写，照旧）

- **S-3 事件 append 仍用同步锁**；**S-5 会话写锁也用同步锁**——这两条热路径的同步锁是
  审计点名要异步化的，**本轮为控风险未做**。
- **覆盖率门禁仍关闭**（只报告趋势，不拦发布）。
- **strict 靠 1270 处 `@type {any}`**（逐步消除中，棘轮只许降不许升）。
- **agent.js 仍未拆分**（体量与职责边界是审计点名的结构债）。
- **`.sig` 默认档仍是 `warn-and-install`**：签名缺失（发布侧故障 / 网络取不到）时提示后放行，
  不把用户挡在更新之外；`MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` 仍可切 fail-closed。

---

## 五、未做

- **Windows Authenticode**：与更新来源签名是两件事，SmartScreen 提示不变。
- **版本语义重整**：未把 0.x 语义重整为 1.x。
- **Pack 子进程隔离**：Pack 仍在同进程 / 同权限域执行（审计点名的隔离加固）。

---

## 六、门禁（发布树）

在**发布提交**上逐项运行（`git diff dc8a9cf..<tag> -- src test` = 0 字节，即门禁树与
tag 树的 `src/` `test/` 完全一致，见发布收尾报告）。本版 `src/` `test/` 零改动，故按
发版清单跑核心项即可：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 均全通过，exit 0 |
| `node test/update-signing.js` | **14 项通过**，exit 0 |
| `node test/run-all.mjs` | **52/52 套通过，0 失败**（exit 0） |
| `node scripts/doc-lint.mjs` | 全绿（exit 0） |

发布前工作树干净、三平台 main 已对齐；tag `v0.7.2` 指向发布提交。

---

## 七、升级建议

- **≥0.6.36 且已装 0.6.45 之后版本**：直接自动更新即可（本版是桌面退出行为修复，不涉及验签路径）。
- **≤0.6.35**：自动更新仍会被拒（`legacy-2025` 私钥已丢弃，无法补签名），手动下载一次本版后恢复。
- **运维**：本版发布后**必须**执行签名发布（`publish-update-sigs.mjs 0.7.2`），否则客户端退回
  「未验证来源签名」提示（默认档）。
