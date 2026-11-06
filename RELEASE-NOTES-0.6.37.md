# MingDao Harness v0.6.37 发布说明

> 状态：**已发布**（tag `v0.6.37`）
> 主题：**v0.6.36 内容首发**（更新来源签名密钥环 + 签名脚本 + 弹窗文案分层；官网 404；收割代理/续传；深圳节点）
> **+ 三处发布链路修复**（macOS runner 退役、Windows CLI 守卫、事件锁 EPERM）。
> 范围：`v0.6.35..HEAD`（`70613cd`、`3406ae6`、`6891756`、`c9b86d8`、`926cfb9`、`929409b`；`9afae53` 是未发布的 v0.6.36 版本提交）
> + 站点仓 3 个提交（`7ad37a9`、`b704ed6`、`b310eca`）。
> 影响面：**无界面/API/账本/同步变化**；弹窗文案改写；官网 `/downloads/*` 与 `/updates/*` 缺失文件由 200 改为真 404；
> 新增国内镜像 `harness.southdns.com`；Windows 事件锁错误处理修正（内部行为，无输出变化）。

---

## 〇、v0.6.36 未发布（先读）

`v0.6.36` 的 tag（`9afae53`）**已推三平台**，但 **GitHub 于 2026-11-02 退役 macOS 14 runner 镜像**：
`macos-14` 的两个构建 job 在 1 秒内 `cancelled`（`The configuration 'macos-14-arm64-us-default' is not supported`），
`publish` 因此 `skipped`。结果：**没有 GitHub Release、没有 npm 包、官网未改、无任何下载**。

按「tag 打过不再移动」的纪律，本版从 `926cfb9` 以 **0.6.37** 发布：内容 = v0.6.36 全部 + 下列三处修复。
`v0.6.36` 的 tag 保留（公开事实），但**不要**把它当作已发布版本；下载 / npm 请用 `0.6.37`。

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

**④ 国内镜像上线：`https://harness.southdns.com`（深圳节点 + 已备案域名）。**
`/downloads/` 反代香港源站并做 nginx 本地缓存（8G / 30 天淘汰，`proxy_force_ranges on` 支持续传），
`/updates/` 直通且 `no-store`，缺文件 **404 透传**。实测首页 151ms、feed 324ms、首次拉 97.5MB **6.9 秒**、
二次 `X-MDH-Cache: HIT`、`/downloads/nope.dmg` → 404。海外用户仍用香港源站（官网下载区上方新增镜像入口）。

**⑤ 其余无行为变化。**
没有新增按钮/设置项/命令，没有改 API、账本、同步或会话格式。发布树 5 张界面截图 sha256
与 v0.6.35 **逐字节一致**（见 §三）。唯一可能的感知是：若某个下载链接指向不存在的文件，
浏览器会明确报 404，而不是给你一个不能用的 HTML。

### 2. 开发者可见

**2.1 公钥密钥环（`desktop/update-verify.js`）**

- `UPDATE_PUBLIC_KEYS` 内置两把 ed25519 公钥：旧钥 `legacy-2025`（`UPDATE_PUBLIC_KEY_PEM`）与
  新钥 `2026-11`；`verifyArtifactSignatureWithKeyring({ filePath|bytes, signatureB64, keys? })`
  逐把尝试，**任一验过即通过**并返回命中的 `keyId`。
- 为什么不能一步到位：`decideUpdatePolicy()` 对「有签名但验不过」是 **reject**。若直接换新钥签发，
  存量客户端只有旧公钥 → 永久拒绝更新。因此**分两版**：本版（0.6.37）扩密钥环、仍不签发；
  **0.6.38** 再签发 `.sig`，届时 0.6.37 客户端已认识新钥。
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
| **v0.6.37（本版）** | 内置新旧两把公钥（密钥环），任一验过即通过 | **不发布 `.sig`**；签名脚本就绪，CI 开关关闭 |
| **v0.6.38（下一版）** | 无需再改代码 | 用新私钥签 `.sig`，发布到 GitHub Release **与** `/updates/<文件名>.sig`；打开 CI 开关 |

- `.sig` 客户端读取位置：`https://harness.mingdao.ai/updates/<安装包文件名>.sig`（`collectUpdateSignature` 第三来源）。
- 回滚：撤下 `/updates/*.sig` 即可（删文件，不动代码）。
- v0.6.36 的 tag 未发布，**不构成**"旧版客户端"路径；密钥环随本版 0.6.37 到达用户。

**2.4 收割代理与断点续传（站点仓 `scripts/harvest-release.mjs`，`7ad37a9`）**

- `HARVEST_PROXY=https://ghfast.top/` 让下载走镜像代理（默认空 = 直连，行为不变）。
- 断点续传：目标文件已存在时用 `Range: bytes=<已有长度>-` 续传；大小不符则重下，不再整包重来。
- 实测 **633MB 从 1.5–6 小时降到 <3 分钟**。

**2.5 测试与 CI（含一处测试基础设施修复）**

- 新增 `test/update-signing.js` **10 项**：密钥环多钥（旧/新均能验）、篡改/坏签名/环外钥必拒、
  内置环 ≥2 把且均为 ed25519、签名脚本只签产物且可被环验、安装包改动后失效、缺钥 CLI 非零退出、
  文案两行且区分公证/来源签名、install 写明 keyId、reject 写明原因且不允许安装。
- 新增 `test/mutate/batch77-update-signing.mjs` **8 条**变异；已接入 `test/run-all.mjs`（**35 套**）
  与 CI。变异总数 **727 → 735**。
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
- 深圳节点**不**在无备案的情况下对外提供 80/443 服务；拿到备案域名后，本版起升级为国内镜像（见 2.8）。

**2.7 v0.6.37 的三处修复（v0.6.36 卡住的根因，`926cfb9`）**

1. **macOS runner 退役（外部）**：`desktop.yml` 两个 mac job `macos-14` → **`macos-15`**（同为 arm64
   公共池，Intel 仍 Rosetta 交叉构建 x64）。依据：GitHub Actions macOS 14 runner image retirement
   （2026-10-01 公告、2026-11-02 退役）。**这是 v0.6.36 无 mac 产物、Release 被 skip 的直接原因。**
2. **Windows CLI 守卫 bug**：`scripts/sign-release-assets.mjs` 用 ``file://${process.argv[1]}`` 判断
   「是否被当脚本执行」，Windows 上 `D:\…` 拼出的 URL 与 `file:///D:/…` **永不相等** → CLI 整段不执行、
   静默 exit 0。改用 `pathToFileURL(process.argv[1]).href`。这正是 Windows 腿 `update-signing ⑦b` 红、
   `batch77 ⑦` 逃逸的根因。
3. **事件日志锁的 Windows 语义**：`openSync(lock,'wx')` 在「锁已被别人创建」时 Windows 可能报 **EPERM**
   而非 EEXIST；`src/session-events.js` 现把 EEXIST/EPERM/EACCES/EBUSY 统一按竞争处理（仍有超时兜底），
   修掉 Windows 腿 `batch76` 的 5 条逃逸。
4. **CI 覆盖**：`update-signing` 步骤从「只 Linux」改为 **Linux + Windows**——它正是靠 Windows 路径才抓出
   上述 CLI bug，只在 Linux 跑等于永不发现。

**2.8 国内镜像 `harness.southdns.com`（`929409b`）**

- 深圳节点（下行 18.3MB/s）+ 已备案域名；`/downloads/` 反代香港源站 + **nginx 本地缓存**
  （8G 上限、30 天未用淘汰），`proxy_force_ranges on` 让缓存对象也支持 Range（桌面端断点续传）；
  `/updates/` 直通、`no-store`（feed 必须新鲜）；`/` 直通；缺文件 **404 透传**。
- 证书 Let's Encrypt（certbot webroot），`certbot.timer` 自动续期；`certbot renew --dry-run` 已通过。
- 实测：首页 151ms、feed 324ms、首次拉 97.5MB **6.9 秒**（~14MB/s）、二次 `X-MDH-Cache: HIT`、
  `/downloads/nope.dmg` → **404**。
- 拨测新增 `mirror_home` / `mirror_feed` / `mirror_range` 三项；镜像挂了用户仍可用香港源站，
  但体验掉一档，所以要进拨测。

### 3. 未做（明确不碰）

- **`.sig` 尚未发布**：本版绝不发布任何 `.sig`，也不设置 `UPDATE_SIGNING_ENABLED`；
  存量客户端不会遇到「有签名但验不过 → 永久拒绝」的问题。签发在 **v0.6.38**。
- **Windows 代码签名仍未接入**（Authenticode/SmartScreen），与更新来源签名是两件事。
- 本版不改前端、不改 API/账本/同步/会话格式；产品代码仅 `src/session-events.js` 的 Windows 错误码处理。

---

## 二、门禁（发布前全量复跑）

（在 `929409b`（最终门禁 SHA）上逐项复跑；原始输出见发版报告。）
> `926cfb9..929409b` 只改 `deploy/`、`docs/` 与发布说明，`src` / `test` 零改动，门禁结果继续有效。

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | **0 错误**（exit 0） |
| `npm run typecheck:strict` | 当前 **0** 条 / 基线 **0** 条（✅ 未恶化） |
| `node test/smoke.js`（单独） | **156 组断言全通过**（exit 0） |
| `node test/smoke.js`（私有 `TMPDIR`） | **156 组断言全通过**（exit 0） |
| `node test/run-all.mjs` | **35/35 套通过，0 失败** |
| `node test/mutate/run.mjs` | **66/66 批、735 条全中**（有效判定，0 逃逸） |
| `npm run coverage` | exit 0（**只报告**，不判失败）；code-lines **69.4%**（18912/27240，低于基线 72.5%，仅提示）/ all-lines 50.1% / functions 72% |
| `node scripts/doc-lint.mjs` | 全绿（⑥ 变异总数：实际 735 = README 735） |
| `node src/cli.js diagnose` | 自检通过，报告已脱敏 |

---

## 三、发布树截图（1440×900，Electron 真实渲染）

`node scripts/ui-shot.mjs --out /tmp/shots-0637`（1440×900，Electron 真实渲染）。

| 页面 | `/tmp/shots-0637` sha256 | 与 v0.6.35 一致 |
| --- | --- | --- |
| `home.png` | `00a68c1358e623b33d794da23944680c1e6350968ca2d3640caa54570fed1b5e` | ✅ 一致 |
| `settings.png` | `1c27e00102ad098ef28baa24419098162f05e291a53b0b2a90e49a4aa8dac414` | ✅ 一致 |
| `palette.png` | `f9369ef19cd7659da12711abcb34225cc549b30c35a572dec363a2406f018dcb` | ✅ 一致 |
| `session.png` | `f285c44022a3a0d7c1c23d1da6724c2455394176b956c3ebfae89fffa3ed3e11` | ✅ 一致 |
| `sheet.png` | `cdc5ea7cb88b5c68482b56361955374f131ac8748d9d5d64ccdd950812dcb6ca` | ✅ 一致 |

> 本版前端（`src/web/`）零改动；比对基准为从 `v0.6.35` tag 工作树实测的 `/tmp/shots-0635`
> （5 张 sha256 与 `RELEASE-NOTES-0.6.35.md` 记录的值也完全一致；0.6.36 树同样一致）。

---

## 四、已知边界

- **v0.6.36 是未发布版本**：tag 已推但无 Release / 无 npm / 无下载；不要用 `0.6.36` 的包名找产物。
- 「更新来源签名」在 **v0.6.37 仍未生效**：客户端能识别两把公钥，但发布侧不提供 `.sig`，
  因此实际校验结果仍是「未验证来源签名」；真正的密码学来源校验从 **v0.6.38** 开始。
- 密钥环的向后兼容边界：旧客户端（≤0.6.35）只内置旧公钥，**在 0.6.38 发布 `.sig` 后会被拒绝**，
  除非它先升到 0.6.37。因此 0.6.38 上线时需实测「0.6.35 → 0.6.37 → 0.6.38」路径。
- **macOS runner**：本版起用 `macos-15`；本文件发布时以 Desktop 工作流实测 mac-x64 / mac-arm64
  两个 job 均 success 且产物齐全为准（见发版报告）。
- **国内镜像**是香港源站的缓存层：首次拉取是 MISS（回源），二次才 HIT；`/updates/` 必须保持
  `no-store`，否则自动更新会拿到旧 feed。镜像故障不影响香港源站与 GitHub。
- 官网 404 只覆盖 `/downloads/` 与 `/updates/`；其它未知路径仍回 SPA 首页（人类路由，200 可接受）。
  镜像站同样要求 `harness.southdns.com/downloads/nope.dmg` → 404。
- nginx 修复在服务器已生效（`docker exec 1Panel-openresty-baFL nginx -s reload`），
  站点仓只记录配置来源与验收清单。
- **历史"变异全中"结论的边界**：修复前 `batch47/54/67/77` 四个批次缺收尾，**永远不会红**；
  因此 v0.6.35 及更早宣称的"全中"对这 4 批不具判定力（其余 62 批不受影响）。
  本版已补齐并**重跑全量**，735 条是有效判定；同类缺陷已由 `run.mjs` 结构预检挡住。
- 覆盖率 code-lines 低于基线：该指标按设计**只报告不判失败**（套件 spawn 子进程导致 V8 聚合不稳定，
  恢复闸门的前提见 `docs/DEVELOPER.md §7.4`），不是本版功能回退。
- 本机为 macOS；Windows 标准账户实机验收与三平台 CI 结果见发版报告。
