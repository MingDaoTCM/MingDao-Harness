# MingDao Harness v0.6.36 发布说明

> 状态：**已发布**（tag `v0.6.36`）
> 主题：**更新来源签名密钥环 + 弹窗文案分层（仍不发布 `.sig`）；官网下载/更新 404 修复**
> 范围：`v0.6.35..HEAD` 4 个提交（`70613cd`、`3406ae6`、`6891756`、`c9b86d8`）+ 站点仓 2 个提交（`7ad37a9`、`b704ed6`）。
> 影响面：**无产品行为变化**；仅更新弹窗文案改写；官网 `/downloads/*` 与 `/updates/*` 的缺失文件由 200 改为真实 404。

---

## 一、升级须知

### 1. 用户可见（三条）

**① macOS 更新弹窗文案不再被误读为「没公证」。**
此前弹窗写「本次更新未验证来源签名（发布链路尚未接入签名）」，用户读成「这个包没签名 / 没公证」。
现在仍是两行，但明确分层：

```
本次更新未验证来源签名（发布链路下一版接入）——已按默认策略安装；macOS 的 Apple 公证不受影响（Apple 已校验并公证，可正常安装）。
它防的是"更新源被投毒"；高安全场景可设 MINGDAO_REQUIRE_UPDATE_SIGNATURE=1 拒绝；详情见日志与官网。
```

**未接入的是「更新来源签名」，不是 Apple 公证。** 两者是两层不同的信任：

| 机制 | 管什么 | 本版状态 |
| --- | --- | --- |
| Apple 公证（Developer ID + notarize + staple） | `.app` 能不能在 macOS 上运行 | **一直有，不受影响** |
| 更新来源签名（ed25519 `.sig`） | 更新包是否由发布私钥签发（防 feed 被投毒换源） | 客户端已认识新旧两把公钥；**本版仍不发布 `.sig`** |

**② 官网下载 / 更新链接现在「缺文件就真 404」。**
此前 nginx 的 SPA 回退让任何未知路径都返回 `200 + HTML`：`/downloads/nope.dmg` 会「下载成功」得到
一个 HTML；`/updates/latest.yml.sig` 也会假装存在——缺文件被伪装成成功，连发版探针都会被骗。
现在 `/downloads/` 与 `/updates/` 使用 `try_files $uri =404`，缺失即 404；其余页面路由不变。

**③ 其余无行为变化。**
没有新增按钮/设置项/命令，没有改 API、账本、同步或会话格式。发布树 5 张界面截图 sha256
与本版前端未改动的上一版**逐字节一致**（见 §三）。唯一可能的感知是：若某个下载链接指向不存在的
文件，浏览器会明确报 404，而不是给你一个不能用的 HTML。

### 2. 开发者可见

**2.1 公钥密钥环（`desktop/update-verify.js`）**

- `UPDATE_PUBLIC_KEYS` 内置两把 ed25519 公钥：旧钥 `legacy-2025`（`UPDATE_PUBLIC_KEY_PEM`）与
  新钥 `2026-11`；`verifyArtifactSignatureWithKeyring({ filePath|bytes, signatureB64, keys? })`
  逐把尝试，**任一验过即通过**并返回命中的 `keyId`。
- 为什么不能一步到位：`decideUpdatePolicy()` 对「有签名但验不过」是 **reject**。若直接换新钥签发，
  存量客户端只有旧公钥 → 永久拒绝更新。因此**分两版**：本版扩密钥环（仍不签发），
  下一版 0.6.37 再签发 `.sig`，此时旧客户端已通过本版认识新钥。
- 私钥**不入库**：`~/.mingdao/update-signing-key.pem`（0600）；CI 侧经 `secrets.UPDATE_SIGNING_KEY` 注入，
  由仓库变量 `UPDATE_SIGNING_ENABLED=true` 控制是否执行签名（**本版保持关闭**）。

**2.2 签名脚本（`scripts/sign-release-assets.mjs`）**

- 只签安装包（`.exe/.dmg/.zip/.AppImage/.deb`）与 `latest(-linux|-mac)?.yml`，其它文件忽略；
  产物 `<文件名>.sig`，内容 `ed25519:<base64>`（与 `parseSignatureText` 对齐）。
- 缺私钥时 CLI **非零退出**并说明原因——不允许静默产出「无签名」的发布物。
- 用法：`UPDATE_SIGNING_KEY_FILE=~/.mingdao/update-signing-key.pem node scripts/sign-release-assets.mjs <产物目录>`。

**2.3 两版上线规程（`docs/CODE-SIGNING.md §六`）**

| 版本 | 客户端 | 发布侧 |
| --- | --- | --- |
| **v0.6.36（本版）** | 内置新旧两把公钥（密钥环），任一验过即通过 | **不发布 `.sig`**；签名脚本就绪，CI 开关关闭 |
| **v0.6.37（下一版）** | 无需再改代码 | 用新私钥签 `.sig`，发布到 GitHub Release **与** `/updates/<文件名>.sig`；打开 CI 开关 |

- `.sig` 客户端读取位置：`https://harness.mingdao.ai/updates/<安装包文件名>.sig`（`collectUpdateSignature` 第三来源）。
- 回滚：撤下 `/updates/*.sig` 即可（删文件，不动代码）。

**2.4 收割代理与断点续传（站点仓 `scripts/harvest-release.mjs`，`7ad37a9`）**

- `HARVEST_PROXY=https://ghfast.top/` 让下载走镜像代理（默认空 = 直连，行为不变）。
- 断点续传：目标文件已存在时用 `Range: bytes=<已有长度>-` 续传；大小不符则重下，不再整包重来。
- 实测 **633MB 从 1.5–6 小时降到 <3 分钟**。

**2.5 测试与 CI（含一处测试基础设施修复）**

- 新增 `test/update-signing.js` **10 项**：密钥环多钥（旧/新均能验）、篡改/坏签名/环外钥必拒、
  内置环 ≥2 把且均为 ed25519、签名脚本只签产物且可被环验、安装包改动后失效、缺钥 CLI 非零退出、
  文案两行且区分公证/来源签名、install 写明 keyId、reject 写明原因且不允许安装。
- 新增 `test/mutate/batch77-update-signing.mjs` **8 条**变异；已接入 `test/run-all.mjs`（**35 套**）
  与 CI（Linux 腿 `update-signing` 步骤）。变异总数 **727 → 735**。
- **测试基础设施修复（`c9b86d8`，发布前门禁复跑时抓到）**：`batch47/54/67/77` 四个批次文件末尾
  漏了 `const ok = M.report(); process.exit(ok ? 0 : 1);`——任何逃逸或"变异点未找到"都 exit 0，
  这 4 个批次的"全中"**永远不会失败**；`batch77 ⑧` 的锚点也停在旧文案（`3406ae6` 后从未真正变异）。
  修复：补齐 4 处收尾、锚点跟随；`test/mutate/run.mjs` 加**开跑前结构预检**（缺 `M.report()` 或
  `process.exit(` 直接拒绝开跑并点名）。反向验证：删 report → 拒绝开跑；`batch67 ①` 锚点改不存在
  → 该批 **exit=1、5/6 + 变异点未找到**（修复前 exit 0）。4 批复跑 9/9、10/10、6/6、8/8，
  **没有**暴露新的真逃逸；全量 **66/66 批、735 条全中（有效判定）**。

**2.6 深圳拨测 / 备份节点（`6891756`）**

- `deploy/nodes/mdh-probe.py`：大陆视角 cron 拨测（首页 / feed / 当前版 Range / 缺文件 404，
  安装包名从 feed 动态取，不写死版本号），补上"香港自测 = 自证"看不到的大陆链路。
- `deploy/nodes/mdh-backup.sh`：香港 → 深圳异地备份 nginx 配置（含 404 手工改动）、站点静态与
  安装包 sha256 清单，保留 14 份；说明见 `docs/DEPLOY-NODES.md`。
- 深圳节点**不**做公网下载站（大陆服务器绑域名需 ICP 备案），有备案后可升级为国内镜像。

### 3. 未做（明确不碰）

- **`.sig` 尚未发布**：本版绝不发布任何 `.sig`，也不设置 `UPDATE_SIGNING_ENABLED`；
  存量客户端不会遇到「有签名但验不过 → 永久拒绝」的问题。签发在 **v0.6.37**。
- **Windows 代码签名仍未接入**（Authenticode/SmartScreen），与更新来源签名是两件事。
- 本版不改产品逻辑、不改前端、不改 API/账本/同步/会话格式。

---

## 二、门禁（发布前全量复跑）

（在 `c9b86d8`（最终门禁 SHA）上逐项复跑；原始输出见发版报告。）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误**（exit 0） |
| `npm run typecheck:strict` | 当前 **0** 条 / 基线 **0** 条（✅ 未恶化） |
| `node test/smoke.js`（单独） | **156 组断言全通过**（exit 0） |
| `node test/smoke.js`（私有 `TMPDIR`） | **156 组断言全通过**（exit 0） |
| `node test/run-all.mjs` | **35/35 套通过，0 失败** |
| `node test/mutate/run.mjs` | **66/66 批、735 条全中**（有效判定，0 逃逸） |
| `npm run coverage` | exit 0（**只报告**，不判失败）；code-lines **69.5%**（18920/27240，低于基线 72.5%，仅提示）/ all-lines 50.1% / functions 72.1% |
| `node scripts/doc-lint.mjs` | 全绿（⑥ 变异总数：实际 735 = README 735） |
| `node src/cli.js diagnose` | 自检通过，报告已脱敏 |

---

## 三、发布树截图（1440×900，Electron 真实渲染）

`node scripts/ui-shot.mjs --out /tmp/shots-0636`（1440×900，Electron 真实渲染）。

| 页面 | `/tmp/shots-0636` sha256 | 与 v0.6.35 一致 |
| --- | --- | --- |
| `home.png` | `00a68c1358e623b33d794da23944680c1e6350968ca2d3640caa54570fed1b5e` | ✅ 一致 |
| `settings.png` | `1c27e00102ad098ef28baa24419098162f05e291a53b0b2a90e49a4aa8dac414` | ✅ 一致 |
| `palette.png` | `f9369ef19cd7659da12711abcb34225cc549b30c35a572dec363a2406f018dcb` | ✅ 一致 |
| `session.png` | `f285c44022a3a0d7c1c23d1da6724c2455394176b956c3ebfae89fffa3ed3e11` | ✅ 一致 |
| `sheet.png` | `cdc5ea7cb88b5c68482b56361955374f131ac8748d9d5d64ccdd950812dcb6ca` | ✅ 一致 |

> 本版前端（`src/web/`）零改动；比对基准为从 `v0.6.35` tag 工作树实测的 `/tmp/shots-0635`
> （5 张 sha256 与 `RELEASE-NOTES-0.6.35.md` 记录的值也完全一致）。

---

## 四、已知边界

- 「更新来源签名」在 **v0.6.36 仍未生效**：客户端能识别两把公钥，但发布侧不提供 `.sig`，
  因此实际校验结果仍是「未验证来源签名」；真正的密码学来源校验从 **v0.6.37** 开始。
- 密钥环的向后兼容边界：旧客户端（≤0.6.35）只内置旧公钥，**在 0.6.37 发布 `.sig` 后仍会被拒绝**，
  除非它先升到 0.6.36。因此 0.6.37 上线时需实测「0.6.35 → 0.6.36 → 0.6.37」路径。
- 官网 404 只覆盖 `/downloads/` 与 `/updates/`；其它未知路径仍回 SPA 首页（人类路由，200 可接受）。
- nginx 修复在服务器已生效（`docker exec 1Panel-openresty-baFL nginx -s reload`），
  站点仓只记录配置来源与验收清单。
- **历史"变异全中"结论的边界**：修复前 `batch47/54/67/77` 四个批次缺收尾，**永远不会红**；
  因此本版之前（含 0.6.35）宣称的"66/66 全中"对这 4 批不具判定力（其余 62 批不受影响）。
  本版已补齐并**重跑全量**，735 条是有效判定；同类缺陷已由 `run.mjs` 结构预检挡住。
- 覆盖率 code-lines 69.5% **低于基线 72.5%**：该指标按设计**只报告不判失败**（套件 spawn 子进程
  导致 V8 聚合不稳定，恢复闸门的前提见 `docs/DEVELOPER.md §7.4`），不是本版功能回退。
- 本机为 macOS；Windows 标准账户实机验收与三平台 CI 结果见发版报告。
