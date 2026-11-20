# MingDao Harness v0.10.1 发布说明

> 状态：**待发布**（tag `v0.10.1`）
> 主题：**审计遗留安全批 + 四项正确性修复 + 发版联动根治**
> 性质：**patch，纯修复**——不新增能力、不改版本语义
> 范围：`808e570`（Pack 窗口自动放宽）、`5303b36`（安全批）、`0338058`（正确性四项）

---

## 1. 安全批（5 份审计连续两版标"未修"）

### 1.1 命令包装前缀缺项（高）

`src/permissions.js` 的 `WRAPPER_PREFIXES` 此前只有
`env/sudo/doas/command/builtin/exec/nohup/time/nice/ionice/timeout/stdbuf/setsid/xargs/watch/busybox`。

**后果**：`pkexec rm -rf /`、`su -c 'rm -rf /'`、`chroot /srv rm -rf /` 这类命令**无法被归一化到真正要执行的命令**，
于是 deny 规则（例如 deny `rm -rf`）看不到它们 → 直接绕过。

**修法**：补 `su`、`runuser`、`pkexec`、`chroot`、`nsenter`、`unshare`、`capsh`：

| 前缀 | 处理 |
| --- | --- |
| `su` / `runuser` | `-c`/`--command` 的值是**命令字符串** → 按 shell 分词后再归一化（同 `env -S`）；`-s/-g/-G/-u/-w…` 吃值 |
| `pkexec` | `--user` 吃值；`--disable-internal-agent` 无值、不吞命令；命令是操作数 |
| `chroot` | `skipOperand: true` 跳过 `NEWROOT`，其后才是命令 |
| `nsenter` / `unshare` / `capsh` | 常见选项按各自规范；**不确定的选项按"吃值"处理（fail-closed）** |

原则写在注释里：**宁可多归一一层，不可少看一条命令**。

### 1.2 软 deny 大小写敏感 + 不认 `cmd /c`（高）

- 命令名与字面匹配统一**大小写不敏感**（与硬 deny 同口径）；
- 识别 `cmd /c`、`/C`、`cmd.exe /C`、`cmd /d /s /c`、`powershell -Command`，并对 `/c` 后的命令串再次分词归一。

### 1.3 `bash` 沙箱降级未披露（高）

沙箱不可用时此前只在 note 里写一句，权限提示看不到。现在**双重披露**：
stdout 首行 + note 都出现「⚠ 沙箱不可用：本次命令未隔离执行」；沙箱正常时不出现该文案。

### 1.4 `permission=auto` 绕过无令牌权限闸门（高，先核实后修）

- **证据**：`src/web/server.js:972` 直接接受 `body.permission`，`:978/:990` 交给 `resolveTurnPermission`，
  全路径不查 `authEnabled`；而 `src/routes/domains/config.js:65/190` 早已以"无令牌不得改权限"为理由返回 403。
- **修法**：无令牌（本机信任模式）时，请求体里的 `auto` **失效**，回落 config/preset，并在 banner 说明原因；
  有令牌、或 config 本就是 `auto` 的不受影响。

## 2. 正确性四项

| 项 | 问题 | 修法 |
| --- | --- | --- |
| 会话侧车 | 删会话只删 `.jsonl`，`.events.ndjson` 等侧车残留（磁盘膨胀、幽灵会话） | 同 basename 侧车**事务化**处理，失败**逆序回滚**；改名/移动工作空间时同步搬迁 |
| 配置保存 | `saveConfigAsync` 写失败仍返回 200 + `ok:true` | 返回 **500 + `ok:false`** + 原因 |
| `highlight()` | 先 `esc()` 再用原始引号正则匹配 → 字符串高亮**永不命中** | 先按原文定位、切片段再逐段转义包裹（XSS 安全不变） |
| 符号链接测试 | 非管理员 Windows 创建符号链接抛 EPERM → 套件直接崩 | 能力探测一次 + `lstat` 复核；两套件**显式打印"已跳过：本机不支持符号链接"** |

## 3. 发版联动根治（复发问题）

`packs/example-hello/pack.json` 的 `engines.mingdao` 窗口写死，导致 **v0.7.0 与 v0.10.0 各因"窗口不覆盖自己"补一次 tag**。
`test/pack-window.js` 的断言在 bump **之后**才红（本地门禁跑旧版本号），只能事后发现。

`scripts/sync-versions.mjs` 现在在 bump 时**自动放宽上界**：

```
>=0.4.6 <0.10   + 版本 0.10.0  →  >=0.4.6 <0.11     （只换 < 段，前导 >= 逐字保留）
>=0.4.6 <0.11   + 版本 0.10.0  →  不动（幂等）
^0.5.0          + 版本 0.10.0  →  不猜（原样保留）
```

`desktop:sync` 即该脚本，发布流程 `npm version && npm run desktop:sync` 会顺带改好；
`postversion` 的 `git add` 纳入 `desktop/package.json` 与 `packs`，bump 后不再残留未提交改动。

## 4. 门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` / `typecheck:strict` | 0 / 0 |
| `npm run preflight` | ✓ |
| `node test/smoke.js`（私有 TMPDIR） | ✓ |
| `node test/run-all.mjs` | **64 套全绿**（新增 5 套：`permissions-batch93` 等） |
| `npm run mutate:shard` | 4 片全中，**883 条**（新增 `batch93-security`、`batch93-v0101` 共 20 条） |
| `node scripts/doc-lint.mjs` | ✓ |

## 5. 未验证 / 边界

- **非管理员 Windows 的 EPERM 路径未在真机验证**（本机是 macOS；测试用注入 EPERM 覆盖逻辑，但没有真 Windows 账户）；
- 命令归一化仍**不可静态判定**：`find … -delete`、脚本文件（`bash foo.sh`）、`$VAR` 展开、自定义包装器；
  这是"静态分析的上限"，不是本版引入的缺陷；
- 删/改名会话时**未持有会话锁**（写入路径有锁；删除是另一个维度的竞争，已记为后续项）；
- 本版未动 Linux deb 更新链路与线路选择（v0.10.0 已发，仍需按 `docs/MANUAL-ACCEPTANCE-linux-deb.md` 真机验收）。
