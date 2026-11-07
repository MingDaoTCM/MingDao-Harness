# 部署节点与各自职责（v0.6.36）

两台阿里云机器，**按"谁最适合做什么"分工**，而不是让闲置机器空转。

## 节点清单

| 节点 | 位置 | 配置 | 公网带宽（实测） | 职责 |
| --- | --- | --- | --- | --- |
| `harness.mingdao.ai`（源站） | 阿里云**香港** `8.210.103.117` | — | 下行充足 | 官网静态站、安装包下载、更新 feed、`/updates/*.sig`（将来） |
| `47.115.136.85`（国内节点） | 阿里云**深圳** | 2C / 1G / 49G（空 41G） | **下行 18.3MB/s**；→香港上传 **14MB/s**；→GitHub 直连不通，经代理 869KB/s | 国内拨测、异地备份、（将来）国内镜像 |

## 深圳节点做了什么（`deploy/nodes/`）

### 1. 国内拨测 `mdh-probe.py`（cron: 每 5 分钟）

**为什么不能只从香港测**：香港源站自己测自己是"自证"——大陆用户遇到的慢/不可达（国际链路抖动、
运营商 QoS、DNS 污染）在源站视角完全看不出来。只有从大陆机器发起，才是用户的真实视角。

判据（全部通过才健康）：
- 首页 200 且 ≤2s；
- `latest.yml` 200 且含 `version:`；
- **当前版本**安装包支持 Range（206）——桌面端断点续传依赖它；
- **不存在的下载路径必须 404**——否则"缺文件"会伪装成"下载成功"（v0.6.36 修掉的正是这个）。

安装包名从 feed 的 `path:` 动态取，**不写死版本号**（写死会让每次发版后拨测变红，进而训练大家忽略告警）。

产物：`/var/log/mdh/probe.log`（每次一行 JSON）、`probe-flip.log`（健康状态翻转时才记一行）。

### 2. 异地备份 `mdh-backup.sh`（cron: 每天 03:30）

用 **tar over ssh** 而不是 rsync：**香港生产机没装 rsync**（实测 `which rsync` → 无），
为备份去给生产机装包不值得。备份内容按"丢了最麻烦"排序：

1. nginx 站点配置（`conf.d`，含 404 修复与论坛反代这些**手工改动**）；
2. 站点静态（html/updates/stats，排除 `downloads`）；
3. 下载清单（146 个安装包的 sha256 与体积）——包可重下，"哪版有哪些包"必须留证；
4. `BACKUP_FULL=1` 时才拉全量安装包（633MB/版）。

保留最近 14 份。

## 国内镜像 `harness.southdns.com`（已备案，v0.6.37 上线）

原先"不做公网下载站"的唯一原因是**备案**。现在有了备案域名 `harness.southdns.com`（解析到深圳机），
深圳节点升级为**国内镜像**：

| 路径 | 行为 |
| --- | --- |
| `/downloads/` | 反代香港源站 + **本地 nginx 缓存**（`proxy_cache`，8G 上限，30 天未用淘汰）；`proxy_force_ranges on` 让缓存对象也支持 Range（桌面端续传要用） |
| `/updates/` | 直通代理、`no-store`（feed 必须新鲜，否则自动更新拿到旧版本号） |
| `/` | 直通代理（页面与源站一致） |
| 缺文件 | **404 透传**（不重演"缺文件=200 HTML"） |

实测（`harness.southdns.com`）：
- 首页 151ms、feed 324ms、Range 1697ms（首次回源）；
- 首次拉 97.5MB 安装包 **6.9 秒**（~14MB/s），第二次 `X-MDH-Cache: HIT`；
- `/downloads/nope.dmg` → **404**。

证书：Let's Encrypt（certbot，webroot 验证），`certbot.timer` 自动续期；`--deploy-hook` 把证书
复制到 openresty 容器的挂载目录并 reload。`certbot renew --dry-run` 已通过。

首页下载区上方加了一行镜像入口（海外用户仍用香港源站）。

## 关于"中转下载"的结论（v0.6.36 实测）

曾怀疑需要中转来解决"GitHub → 香港 0.7KB/s"。实测结论：**那是瞬时拥塞，不是常态**。

| 链路 | 实测 |
| --- | --- |
| 香港 → GitHub 直连 | **1.6MB/s**（拥堵时曾 0.7KB/s） |
| 香港 → ghfast 代理 | **2.07MB/s** |
| 深圳 → ghfast 代理 | 869KB/s |
| 深圳 → 香港上传 | **14MB/s** |

所以采集不需要中转：`HARVEST_PROXY=https://ghfast.top/ node scripts/harvest-release.mjs <版本> <目录>`
（已支持断点续传），633MB 实测 < 3 分钟。深圳节点保留为**故障时的备选通道**（真拥塞时可改由它拉取再回传）。

---

## 四、OSS（香港）——安装包的唯一集散地（v0.6.39 起）

### 4.1 为什么必须上 OSS

2026-11-06 实测：香港 ECS 的公网带宽被打满后，**所有入向路径都只有 ~0.1MB/s**
（GitHub Actions 推、深圳中转推、本机推，全部如此），633MB 传了 1 小时未完成。
而 **OSS 香港的内网端点**对同地域 ECS 是 **18.5MB/s**（同一对象，差 185 倍）。

### 4.2 端点必须分两种（这一条最容易错）

| 使用者 | 端点 | 实测 |
| --- | --- | --- |
| 本机 / GitHub Actions | `https://<bucket>.oss-<region>.aliyuncs.com`（公网） | **2.44MB/s** |
| 同地域 ECS（香港） | `https://<bucket>.oss-<region>-internal.aliyuncs.com`（内网） | **18.5MB/s** |

**用公网端点给 ECS 拉文件 = 白付公网带宽且慢 185 倍。**

**但内网端点只对「同地域」ECS 有效**（实测）：

| 发起方 | 内网端点 | 公网端点 |
| --- | --- | --- |
| 香港 ECS（同地域） | ✅ 200 / 18.5MB/s | ✅ 2.44MB/s |
| 深圳 ECS（跨地域） | ❌ 超时（12s 不通） | ✅ 200（但 5s 才拿到 1KB，跨地域很慢） |

所以：**跨地域节点不要指望内网端点**，让它「本地优先、缺失才 302」比让它去跨地域拉文件更实际。
（对象存储的「经典网络」与「VPC 内网」在该地域用的是同一个 internal 端点。）

### 4.3 三个已经踩过的坑

1. **新 bucket 默认开「阻止公共访问」**：此时 `PutBucketAcl public-read` 报
   `Put public bucket acl is not allowed`（不是 RAM 权限问题）。先
   `PUT /?publicAccessBlock`（XML body `<BlockPublicAccess>false</BlockPublicAccess>`），再设 ACL。
2. **对象键必须扁平**：`downloads/<文件名>`（文件名自带版本号）。用 `downloads/<版本>/` 会让
   nginx 的 302 落到 404。需要改结构时用 **服务端 CopyObject**（不耗流量）。
3. **签名细节**：`CanonicalizedOSSHeaders` 里冒号后**不带空格**（`x-oss-acl:public-read`），
   否则 `SignatureDoesNotMatch`；`?publicAccessBlock` 需要 XML body 与 `Content-Type: application/xml`。

### 4.4 现在的下载链路

```
用户 → harness.mingdao.ai/downloads/<文件>
        ├─ 302 → OSS 香港（源站不再出任何下载流量）
        └─ 大陆用户由 harness.southdns.com（深圳）**本地优先**直供 18MB/s，
           本地没有的同样 302 → OSS
```

- 发布侧：`MirrorSync` 工作流把 Release 资产直接传 OSS（Actions 出网快，实测 **100 秒内**跑完）；
- 服务器侧：不再互传安装包；源站只保留最近 1 版做回滚（本次清理 **9.3GB → 633MB**）；
- 本地磁盘治理：`node scripts/prune-downloads.mjs <目录> --keep N [--apply]`（默认 dry-run）。

### 4.5 凭据

`~/.mingdao/oss.env`（0600，**不入库**）：`OSS_BUCKET / OSS_ENDPOINT / OSS_AK / OSS_SK`；
CI 侧用同名 GitHub Secrets（`OSS_*`）。RAM 子账号只需 `oss:PutObject / GetObject / ListObjects`，
若要改 ACL 另需 `oss:PutBucketAcl`（**仅一次性操作时才需要，平时可以收回**）。
