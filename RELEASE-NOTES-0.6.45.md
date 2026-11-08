# MingDao Harness v0.6.45 发布说明

> 状态：**已发布**（tag `v0.6.45`）
> 主题：**更新来源签名接入发布链路（阶段二）**
> 范围：`v0.6.44..HEAD` 的 4 个提交——`5d1dd2f`（Desktop 构建工具链下载失败自动切 npmmirror
> 重试）、`1635954`（`publish-update-sigs.mjs` + 签名发布计划纯函数 + 文档/文案）、
> `d4bbc18`（`batch77 ⑦⑧` 变异锚点跟随本版文案）、`e5d5a2c`（0.7.0 翻默认的覆盖性证据：
> 新增 `scripts/make-event-fixtures.mjs` + `docs/EVENT-SOURCE-EVIDENCE.md`，**不改 `src/` 产品逻辑**）。
>
> **关于 tag 里多出的一个提交**：本版发布期间 `main` 上并入了
> `test(events): 0.7.0 翻默认覆盖性证据`（仅 `docs/EVENT-SOURCE-EVIDENCE.md` 与新脚本
> `scripts/make-event-fixtures.mjs`，**不参与门禁、不改 `src/test`**）。它不是「历史写错了」，
> 而是下个版本翻默认前的证据材料；`git diff d4bbc18..v0.6.45 -- src test` 仍为 **0**。
> 影响面：**自动更新的来源校验行为**（≥0.6.36 不再提示、≤0.6.35 被拒），以及发布侧新增一步
> 「把 `.sig` 发到 `/updates/`」。对话、工具、账本、调度、会话格式**均未改变**。
> **用户可见：有**（仅限自动更新时的来源签名提示 / 拒绝）。

---

## 〇、先读：本版到底改了什么

更新包的**来源签名**不是新机制：CI 从 v0.6.39 起就给每个安装包签 `.sig`，客户端的密钥环
（`desktop/update-verify.js#UPDATE_PUBLIC_KEYS`）也从 v0.6.36 起内置了 `current` 公钥。
缺的只是**最后一米**——客户端按 `https://harness.mingdao.ai/updates/<包名>.sig` 取签名，
而 `.sig` 此前只躺在 GitHub Release 里，站点上一直是 404。

本版把这一米接上：

- 新增 `scripts/publish-update-sigs.mjs <版本>`：从 Release 取本版 `.sig` → 发到源站 `/updates/`；
- 纯函数 `planSignaturePublish` 保证**只发本版安装包**的签名（清单签名 `latest*.yml.sig`
  不进 `/updates/`）；
- 0.6.44 的 7 个签名已先行手工发布并验证；本版发布时脚本成为标准步骤（写进发布清单）。

---

## 一、用户可见

### 1.1 ≥0.6.36 的客户端：不再提示「未验证来源签名」

这些客户端内置了 `current` 公钥。更新时：

1. 从 `latest*.yml` 拿到安装包名；
2. 按 `<包名>.sig` 从 `/updates/` 取来源签名；
3. 用内置 `current` 公钥验签**通过** → 走 `install`，正常下载安装。

弹窗里那条「本次更新未验证来源签名（发布链路下一版接入）」**不会再出现**。

### 1.2 ≤0.6.35 的客户端：会拒绝更新，需手动下载一次

**原因**：`current` 公钥是 **0.6.36 起**才内置的。≤0.6.35 的客户端只认 `legacy-2025` 这把
公钥——而它的私钥在本轮启用新密钥时**已按约定丢弃**（从未写盘/打印），因此**无法**为
这些老客户端补一份它们能验过的签名。它们拿到本版签名只会得到「验签失败」，按 fail-closed
判据显示：

> 更新包来源不可信，已拒绝

并引导手动下载。**这是已知且已确认的代价**，不是故障。

**怎么办**：手动下载安装一次本版，之后（0.6.45 及以后）自动更新恢复正常：

- 官网下载区：<https://harness.mingdao.ai/#downloads>
- GitHub Release：<https://github.com/MingDaoTCM/MingDao-Harness/releases/tag/v0.6.45>

装好 0.6.45 后，后续版本的 `.sig` 都能用内置 `current` 公钥验过。

### 1.3 文案修正

删掉源码/文案里过时的「发布链路下一版接入」；签名缺失时的提示改为「没能取得本版更新的
发布签名」，并保留「已按默认策略安装」的说明（默认档不变，见 §四）。

---

## 二、运维：签名发布脚本

### 2.1 用法

发版产物落到 GitHub Release 之后（Desktop 工作流跑完），执行：

```bash
cd MingDao-Harness
MINGDAO_GITHUB_TOKEN=... MDH_SITE_HOST=mingdao-server \
  node scripts/publish-update-sigs.mjs 0.6.45
```

- `--dry-run`：只列出将要上传的 `.sig`，不上传；
- `--dir <目录>`：从本地目录取 `.sig`（离线 / Release 取不到 / 已下载时）；
- `MDH_SITE_HOST` 默认 `mingdao-server`；目标目录固定为
  `/opt/1panel/www/sites/mingdao-site/updates/`（与 nginx 站点一致，脚本导出常量并有单测钉住）。

脚本会打印计划清单，然后 `scp` 上传并 `chmod 644`。**只发本版安装包签名**：

| 发 | 不发 |
| --- | --- |
| `mingdao-setup-<ver>-x64.exe.sig` | `latest.yml.sig` |
| `mingdao-<ver>-arm64.dmg.sig` / `-x64.dmg.sig` | `latest-linux.yml.sig` |
| `mingdao-<ver>-x86_64.AppImage.sig` | `latest-mac.yml.sig` |
| `mingdao-<ver>-amd64.deb.sig` | |
| `MingDao.Harness-<ver>-arm64-mac.zip.sig` / `-mac.zip.sig` | |

### 2.2 验收（必做）

```bash
# ① 7 个安装包签名都 200
for f in mingdao-setup-0.6.45-x64.exe mingdao-0.6.45-arm64.dmg mingdao-0.6.45-x64.dmg \
         mingdao-0.6.45-x86_64.AppImage mingdao-0.6.45-amd64.deb \
         MingDao.Harness-0.6.45-arm64-mac.zip MingDao.Harness-0.6.45-mac.zip; do
  printf '%s ' "$f"; curl -s -o /dev/null -w '%{http_code}\n' "https://harness.mingdao.ai/updates/$f.sig"
done

# ② 端到端验签：feed 里的包名 → 下载 → 取 sig → 用内置 current 公钥验签
#    （与客户端同一实现：node scripts/update-sign.mjs --verify <包> --pub <内置公钥>）
# ③ 三份清单签名仍须 404：latest.yml.sig / latest-linux.yml.sig / latest-mac.yml.sig
```

> 清单签名**必须保持 404**：客户端只对下载到的安装包验签；把清单签名放上去，会让
> 「删 `/updates/*.sig` = 关闭验签」的回滚语义变模糊。

### 2.3 回滚

```bash
ssh mingdao-server 'rm -f /opt/1panel/www/sites/mingdao-site/updates/*.sig'
```

立即回到「无签名 → 提示后照常安装」（warn-and-install）。回滚是**安全**的：删除签名只会
降级到默认档，不会让已经能验签的客户端拒绝更新。

---

## 三、未做 / 已知边界

- **默认档仍是 `warn-and-install`**：签名缺失（发布侧故障 / 网络取不到 / feed 被剥离签名）时
  宁可提示后放行，也不把用户挡在更新之外。本版**没有**把默认档改成 fail-closed。
- `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` **仍然可用**：设置后无签名一律拒绝（fail-closed），
  面向发行方 / 高安全用户。
- **≤0.6.35 没有回退通道**：`legacy-2025` 私钥已丢弃，无法补签名；只能手动下载一次。
- **Windows Authenticode 未接入**：与更新来源签名是两件事，SmartScreen 提示不变。
- **签名缺失的降级不可区分**：控制 feed 的攻击者仍可删掉 `.sig` 把更新降级成「无签名」，
  默认档下会走到 warn-and-install。要真正关闭需默认 reject + 发布链路每次都签，本版不做。
- **人工点验（checklist §2，3820 WebUI）未做**：本会话为自动执行，无人类点按钮确认。
- **Windows 实机（§1.3）未跑**：本机 macOS；CI `windows-latest` 腿覆盖了新增步骤。

---

## 四、门禁（发布树）

在**发布提交**上逐项运行（`git diff d4bbc18..v0.6.45 -- src test` = **0 字节**，即门禁树与
tag 树的 `src/` `test/` 完全一致）：

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 错误（exit 0） |
| `npm run typecheck:strict` | 当前 0 条 / 基线 0 条（exit 0） |
| `npm run preflight` | ✓ 预检通过（批次结构 / 变异残留 / 计数一致），exit 0 |
| `node test/smoke.js`（单独 + 私有 `TMPDIR`） | 两次均全通过，exit 0 |
| `node test/run-all.mjs` | **46/46 套通过，0 失败**（exit 0） |
| `npm run mutate:shard`（4 片全量） | **4/4 片全中；74 批 / 803 条，0 逃逸**（exit 0） |
| `node scripts/event-parity.mjs --home ~/.mingdao` | 对拍 exit 0（等价 1 / 不可回溯 3 / 不一致 0 / 跳过 71，共 75） |
| `npm run coverage` | 只报告，exit 0；行覆盖率 **68.6%**（19137/27898）、all-lines 49.1%、functions 68.7% |
| `node scripts/doc-lint.mjs` | 全绿（10 项检查，exit 0） |
| `node src/cli.js diagnose` | exit 0（密钥 / token / 私网路径已脱敏） |

发布前工作树干净、三平台 main 已对齐；tag `v0.6.45` 指向发布提交。

---

## 五、升级建议

- **≥0.6.36**：直接让应用自动更新即可；本版起弹窗不再提「未验证来源签名」。
- **≤0.6.35**：自动更新会被拒绝（原因见 §1.2），请手动下载安装一次；之后恢复自动更新。
- **运维**：本版发布后**必须**执行 §2.1 的签名发布，否则客户端仍会退回
  「未验证来源签名」提示（默认档），不会拒绝但也不会获得来源校验。
