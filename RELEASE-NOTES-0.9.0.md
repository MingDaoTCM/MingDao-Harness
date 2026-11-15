# MingDao Harness v0.9.0 发布说明

> 状态：**已发布**（tag `v0.9.0`，2026-11-15）
> 主题：**Linux deb 安装形态自动更新**（minor：新能力）
> 范围：`41c96e1`（客户端 deb 自动更新 + 16 项单测）、`6c382f4`（desktop 文档）、`batch92`（变异守卫）、
> 站点仓库 `7371d83`（`latest-linux-deb.yml` 生成 + 0.8.2 回填）

---

## 1. 为什么做这个

v0.8.2 之前，deb 安装形态的用户在"检查更新"里只会看到一句话：

> deb 安装不支持自动更新（electron-updater 仅支持 AppImage），请到官网下载。

根因是 `electron-updater` 的 Linux 自更新**只支持 AppImage**（靠 `APPIMAGE` 环境变量定位自身文件）。
deb 装在 `/opt` 下、归 root 所有，普通用户无权替换——所以这条路径此前是**明示不支持**，不是漏做。

## 2. 现在怎么做

```
检查更新
  → 拉 https://harness.mingdao.ai/updates/latest-linux-deb.yml   （独立 feed，15s 超时）
  → 语义化版本比较（含 -beta 预发布小于同号正式版）
  → 弹「发现新版本 vX（当前 vY）」→ 下载并安装 / 稍后
  → 下载 .deb 到临时目录（≤400 MiB，带任务栏进度）
  → 校验一：sha512（标准 base64，与 feed 逐字比对）
  → 校验二：来源签名 ed25519（UPDATE_PUBLIC_KEYS 密钥环，取 /updates/<path>.sig）
  → 任一不过：删除文件 + 「未通过校验，未安装」    ← 绝不安装
  → 校验通过：「安装需要管理员授权（会弹出系统密码框）」
  → pkexec dpkg -i <file>
      ├ 退出码 0 → 「安装完成，重启后生效」→ 立即重启 / 稍后
      └ 非 0（取消/无 polkit）→ 「安装未完成（退出码 N）」+ 可复制 sudo dpkg -i <path> + 包路径 + 官网链接
```

**为什么不复用 `latest-linux.yml`**：那个 feed 的 `files:` 是给 `electron-updater` 选包的，
塞进 deb 条目会干扰它对 AppImage 的判断。所以单独一份 `latest-linux-deb.yml`，
由站点仓库的 `gen-update-feeds.sh` 生成（缺 deb 时告警跳过，不让脚本失败）。

**为什么能复用签名链**：.sig 我们本来就为每个安装包发布了（7 个，含 deb），
客户端直接用既有 `UPDATE_PUBLIC_KEYS` 验，不需要新的密钥或流程。

**版本窗口顺带维护**：bump 到 0.9.0 会改变 `engines.mingdao` 的语义——旧窗口 `>=0.4.6 <0.9` 不覆盖 0.9.0，
会让官方示例 Pack 自身校验失败（v0.7.0 同类事故，已有 `test/pack-window.js` 守卫）。本版把小节里的
`packs/example-hello/pack.json` 窗口放宽为 `>=0.4.6 <0.10`，smoke 夹具同步；这是版本元数据维护，
不是产品逻辑变更。

## 3. 已回填 0.8.2

`latest-linux-deb.yml` 已为 **0.8.2** 生成并上线：

```
version: 0.8.2 · path: mingdao-0.8.2-amd64.deb · size: 76034518
sha512: p12Rqjzq3e0Qbwav…（与 OSS 上的包逐字一致）
sig: /updates/mingdao-0.8.2-amd64.deb.sig → 200
```

所以 **0.8.2 的 deb 用户能直接收到 0.9.0 的更新**，不需要手动重装一次。

## 4. 门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `typecheck:strict` | 0 / 0 |
| `npm run preflight` | ✓ |
| `node test/smoke.js`（私有 TMPDIR） | ✓ |
| `node test/run-all.mjs` | **57 套 / 57 通过**（新增 `deb-update`） |
| `node test/deb-update.js` | 16 项 |
| `node test/update-signing.js` | 14 项 |
| `npm run mutate:shard` | 4 片全中（含新增 `batch92-deb-update`） |
| `node scripts/doc-lint.mjs` | ✓ |

## 5. 未验证 / 边界（必须如实读）

- **真实的 `dpkg -i` 没有在 CI 验证过**：CI 不安装系统包，本版只覆盖"要不要装"的纯逻辑
  （feed 解析 / 版本比较 / sha512 / 签名解析 / 安装计划形状）与源码接线；
  **提权安装、polkit 密码框、`pkexec` 退出码 126/127 的回落文案，需要在 Linux 桌面机人工验收**；
- **做不到零交互**：替换 root 拥有的 deb 包必须提权，一定会有一次管理员授权（除非系统配置了免密 polkit）——
  这是 Linux 包管理权限模型，不是实现取舍；
- `pkexec` 不在（少数精简发行版）时只能走"复制命令"回落；
- AppImage / Windows / macOS 的更新路径**一行未改**；
- 历史版本（≤0.8.1）的 deb feed 未回填（只有 0.8.2 起可用）。

## 6. 人工验收步骤（Linux 桌面机）

1. 用 deb 安装 0.8.2，确认 `/opt/MingDao Harness/` 存在；
2. 启动应用 → 检查更新 → 应弹「发现新版本 v0.9.0」；
3. 确认下载 → 观察进度 → 应弹「已校验通过。安装需要管理员授权」；
4. 取消一次密码框 → 应弹「安装未完成（退出码 126/127）」+ `sudo dpkg -i <path>`；
5. 再试一次并授权 → 安装成功 → 立即重启 → `mingdao --version` 应为 0.9.0；
6. 人为把 feed 的 sha512 改错一位（或用未签名包）→ 必须拒绝安装并删除文件。
