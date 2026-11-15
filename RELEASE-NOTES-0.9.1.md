# MingDao Harness v0.9.1 发布说明

> 状态：**待发布**（tag `v0.9.1`）
> 主题：**修正 npm 包的示例 pack 窗口**（0.9.0 的 npm tarball 与 tag 树漂移）
> 性质：**patch，纯打包修正**——产品代码与 v0.9.0 **逐字节相同**（`git diff v0.9.0..v0.9.1 -- src` 应为空）
> 范围：`scripts/verify-npm-tarball.mjs`（新增门禁）、`docs/RELEASE-CHECKLIST.md`、`CHANGELOG.md`

---

## 1. 问题（0.9.0 的 npm 包）

```text
npm tarball  packs/example-hello/pack.json → "engines": { "mingdao": ">=0.4.6 <0.9" }
tag v0.9.0   packs/example-hello/pack.json → "engines": { "mingdao": ">=0.4.6 <0.10" }
sha256       5a117544…（tarball）  vs  aef70bce…（tag）
```

窗口 `>=0.4.6 <0.9` **恰好排除了 0.9.0 自己**，于是用 npm 安装的用户执行
`mingdao pack install example-hello` 会被引擎校验拒绝加载这个示例包。

**影响面**：仅 `npm i -g mingdao-harness@0.9.0` 且要装 `example-hello` 示例包的用户。
CLI / Agent / 应用模式 / 桌面安装包 / GitHub Release / feed / 镜像的 0.9.0 **都正常**。

## 2. 根因

发布过程中 tag 被重打了两次（`58dbc60` 修 pack 引擎窗口、`2ce08c7` 补
`desktop/deb-update.js` 的打包白名单），而 `npm publish` 用的是**更早**的工作树快照。

更本质的原因：**既有全部门禁检查的都是工作树，没有一条检查"用户实际从 registry 拿到的 tarball"**。
所以这个偏差在 CI、在发布验收里都是绿的。

## 3. 修法

1. 本版（0.9.1）从**正确的 tag 树**重新打包发布；
2. 新增 `scripts/verify-npm-tarball.mjs`：
   - 从 registry `npm pack` 已发布的 tarball；
   - 与 tag 树逐字节比对 5 个关键文件 + 版本号：
     `package.json`、`packs/example-hello/pack.json`、`packs/example-hello/pack.mjs`、
     `src/deepseek-app.js`、`src/app-protocol.js`；
   - 任一不一致 → **exit 1**，并提示"不要移动 tag，改发修正版本"；
   - 实测分辨力：0.9.0 命中 1 处（exit 1），0.8.2 一致（exit 0）；
3. 写入 `docs/RELEASE-CHECKLIST.md`：**npm 发布后必须跑该脚本且 exit 0**。

## 4. 与 v0.9.0 的关系

- `src/`、`desktop/`、`test/` 的产品代码 **零改动**（`git diff v0.9.0..v0.9.1 -- src desktop test` 应为空）；
- 桌面端功能与 v0.9.0 完全相同（Linux deb 自动更新已在 0.9.0 发布）；
- 本版存在的唯一意义：让 npm 渠道与其余平台**重新一致**，并装上"发布后核对"这道门禁。

## 5. 门禁（发布树）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `typecheck:strict` | 0 / 0 |
| `npm run preflight` | ✓ |
| `node test/smoke.js`（私有 TMPDIR） | ✓ |
| `node test/run-all.mjs` | 57 套 / 57 通过 |
| `npm run mutate:shard` | 4 片 / 863 条 / 0 逃逸 |
| `node scripts/doc-lint.mjs` | ✓ |
| **`node scripts/verify-npm-tarball.mjs 0.9.1`** | **必须 exit 0（本版新增，最关键的一条）** |

## 6. 未验证 / 边界

- 真实 `dpkg -i` 与 polkit 授权弹窗仍只能 Linux 桌面机人工验收（沿用 0.9.0 的边界，本版未改这部分代码）；
- `verify-npm-tarball.mjs` 只核对**关键文件**，不是全量 160 文件逐字节比对（全量比对留作后续可选项）；
- 历史版本（≤0.9.0）的 npm 包不回溯修正：0.9.0 的 npm 用户升级到 0.9.1 即可。
