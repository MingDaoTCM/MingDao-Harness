# 发布产物分发手册（下游项目可直接抄）

> 适用场景：**构建在 GitHub（或任何境外 CI），用户和一台节点在国内/香港**。
> 本手册全部数字来自 MingDao Harness 2026-11-06 的实测，不是估算。
> 目标：把"发一版要等 1–3 小时"压到"**几分钟**"，并且让**大陆用户就近下载**。

---

## 0. 一页结论

| 链路 | 实测速度 | 用途 |
| --- | --- | --- |
| 本机（国内）→ 香港 ECS | **0.1 MB/s** | ❌ 永远不要用它发版 |
| GitHub Actions → 香港 ECS | **0.1 MB/s** | ❌ 同上（ECS 入向被打满时） |
| 深圳 ECS → 香港 ECS | 14 MB/s（好时）/ **0.07 MB/s**（坏时） | ⚠️ 不稳定，别依赖 |
| **本机 → OSS 公网端点** | **2.44 MB/s** | ✅ 手工补发 |
| **OSS → 同地域 ECS（内网端点）** | **18.5 MB/s** | ✅ 服务器拉取 |
| **OSS → 用户（公网，弹性）** | 看用户带宽 | ✅ 正式分发给用户 |
| **深圳 → 大陆用户（本地磁盘直供）** | **18 MB/s** | ✅ 大陆加速 |

**一句话架构**：

```
构建（CI） ──► OSS（单一集散地，多地冗余）
                 │
                 ├─► 香港源站：/downloads/ 一律 302 到 OSS（自己不出下载流量）
                 ├─► 深圳镜像：本地有就直供（大陆最快），没有就 302 到 OSS
                 └─► 用户网页：加载时**实测两条链路**，谁快用谁
```

**三条铁律**（违反任何一条，前面的优化全部作废）：

1. **不要用"你手上那台机器"去衡量任何链路**——实测中同一条命令在两个时点分别是 14MB/s 和 73KB/s。
2. **加速步骤不能排在可能失败的步骤之后**——一次签名失败把后面的"直推"整段跳过，等于没做。
3. **服务器访问 OSS 必须用内网端点**（`…-internal.aliyuncs.com`），公网端点会重新吃 ECS 公网带宽。

---

## 1. 先搞清楚瓶颈在哪（三步定位法）

发版慢的时候，按顺序测这三段，**不要猜**：

```bash
# ① 出网：构建机/CI → 目标存储
time curl -sL -o /dev/null -r 0-20000000 <一个 20MB 的发布包 URL>

# ② 入网：目标存储 → 你的服务器（在服务器上跑，不要在本机跑！）
ssh server 'time curl -sL -o /dev/null -r 0-20000000 <同一 URL>'

# ③ 分发：服务器 → 用户（用第三方节点测，别用自己那台）
#    本机测出来的数字只代表"你到服务器"这一段
```

**踩过的坑**：我们曾把"本机 → 香港 0.1MB/s"当成"香港带宽小"，
后来在服务器上测 OSS **内网**是 18.5MB/s——问题根本不在服务器，在**那条国际公网路径**。

---

## 2. 目标架构（四个组件）

### 2.1 组件总览

| 组件 | 职责 | 必需？ |
| --- | --- | --- |
| **对象存储**（OSS/S3/R2） | 安装包的**唯一集散地**；CI 直传、服务器与用户都从这里取 | ✅ 必需 |
| **CI 直传** | 构建完直接上传对象存储，不经过任何 ECS | ✅ 必需 |
| **国内镜像节点** | 大陆用户就近下载（本地磁盘直供）；缺文件时回源对象存储 | 有大陆用户则必需 |
| **就近选择**（前端） | 页面上实测两条链路，自动把下载按钮指向更快的那边 | 推荐 |

### 2.2 为什么"对象存储 + 302"是核心

- ECS 的公网带宽是**固定且昂贵**的，一旦被下载打满，连 SSH/CI 推送都会跟着掉速；
- 对象存储的带宽是**弹性按量**的，价格约 ¥0.5/GB 出流量，几百次下载也就几元；
- 302 让 ECS **只做重定向**，下载流量完全不经过它。

> 早期方案是"服务器互相 scp 安装包"。**在公网被打满时这条路会退化成 0.1MB/s**，
> 所以只保留为**应急兜底**（见 §4.6），不要作为主路径。

---

## 3. 可直接抄的实现

### 3.1 CI 直传对象存储（GitHub Actions 版）

关键点：**独立工作流**、按 tag 触发、不依赖 SSH。

```yaml
# .github/workflows/mirror-sync.yml
name: MirrorSync
on:
  workflow_dispatch:
    inputs:
      tag: { required: true, type: string }

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4

      - name: 下载 Release 资产
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
        run: |
          set -euo pipefail
          mkdir -p dist
          gh release download "${{ inputs.tag }}" -R "${{ github.repository }}" -D dist --clobber
          echo "资产数：$(ls dist | wc -l)"; du -sh dist

      - name: 上传到对象存储
        env:
          OSS_BUCKET:   ${{ secrets.OSS_BUCKET }}
          OSS_ENDPOINT: ${{ secrets.OSS_ENDPOINT }}   # 公网端点（CI 用）
          OSS_AK:       ${{ secrets.OSS_AK }}
          OSS_SK:       ${{ secrets.OSS_SK }}
        run: node scripts/oss-sync.mjs put dist downloads

      - name: 冒烟（匿名可下载）
        run: |
          set -euo pipefail
          f=$(ls dist/*.dmg | head -1 | xargs basename)
          code=$(curl -s -o /dev/null -w '%{http_code}' -r 0-1023 \
            "https://${{ secrets.OSS_BUCKET }}.oss-cn-hongkong.aliyuncs.com/downloads/$f")
          echo "$f → HTTP $code"
          [ "$code" = "206" ] || { echo "::error title=oss-smoke::匿名下载失败（$code）"; exit 1; }
```

**为什么单独一个工作流**：如果把它塞进 Desktop 的 publish job 里，**前面任何一步红（比如签名）都会让它 skipped**。
我们实际踩过：签名报 422 → 直推被跳过 → 又退回本机慢传。

### 3.2 零依赖上传/下载客户端（60 行，不用装 SDK）

若项目坚持零运行时依赖，OSS 的 V1 签名足够简单：

```js
// scripts/oss-sync.mjs（节选，完整版见仓库）
const stringToSign = `${method}\n${md5}\n${contentType}\n${date}\n${canonicalHeaders}${resource}`;
const signature = crypto.createHmac('sha1', sk).update(stringToSign, 'utf8').digest('base64');
// 请求头：Date / Content-Type / Authorization: OSS <AK>:<signature>
// resource = /<bucket>/<key>（**逐段 encodeURIComponent**）
// 虚拟主机风格：URL = https://<bucket>.<endpoint>/<key>（路径里不再带 bucket！）
```

CLI 形态：

```bash
node scripts/oss-sync.mjs put <本地目录> <OSS 前缀>
node scripts/oss-sync.mjs ls  <OSS 前缀>
node scripts/oss-sync.mjs get <OSS 键>  <本地文件>
```

**凭据**：`~/.mingdao/oss.env`（0600，**绝不入库**）+ CI 侧同名 Secrets。
RAM 子账号最小权限：`oss:PutObject / GetObject / ListObjects`。

### 3.3 服务器回源：内网端点（最容易错的一条）

```bash
# 香港 ECS 上（同地域）
export OSS_ENDPOINT=https://<bucket>.oss-cn-hongkong-internal.aliyuncs.com
node scripts/oss-sync.mjs get downloads/<文件> ./<文件>
```

| 端点 | 谁用 | 实测 |
| --- | --- | --- |
| `oss-cn-hongkong.aliyuncs.com` | 本机 / CI | 2.44 MB/s |
| `oss-cn-hongkong-internal.aliyuncs.com` | **同地域 ECS** | **18.5 MB/s** |

判断是否同地域：`curl -s http://100.100.100.200/latest/meta-data/region-id`（阿里云）。
内网端点解析到 `100.115.x.x`，走内网、**不计公网流量**。

### 3.4 国内镜像：本地优先 + 302 兜底

```nginx
# 深圳节点
location ^~ /downloads/ {
    root /www/mirror-downloads;      # 本地目录结构要和 URL 对齐：/www/mirror-downloads/downloads/xxx
    try_files $uri @oss;             # 本地有 → 直接 206（大陆 18MB/s）
}
location @oss {
    return 302 https://<bucket>.oss-cn-hongkong.aliyuncs.com$request_uri;
}

# 香港源站：一律 302，自己不出下载流量
location ^~ /downloads/ {
    rewrite ^/downloads/(.*)$ https://<bucket>.oss-cn-hongkong.aliyuncs.com/downloads/$1 redirect;
}
```

**两个细节**：

1. 用 `redirect`（302）**不要用 `permanent`(301)**——301 会被浏览器长期缓存，将来换 CDN 甩不掉；
2. `root` 是**目录前缀**，`$uri=/downloads/x.dmg` 会去找 `<root>/downloads/x.dmg`，
   把文件放错一层就会出现"302 到自己"的死循环。

### 3.5 就近选择（页面内实测，不显示任何提示文字）

不依赖 IP 库、不看时区，**直接测两条链路的吞吐**：

```js
// 页面加载后：并行各取 256KB，谁先回完用谁；结果记 7 天
const MIRROR = 'https://cn-mirror.example.com';
const sample = '/downloads/<当前版本包>';

function probe(base) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => { ctrl.abort(); resolve({ base, ok: false }); }, 3000);
    fetch(base + sample, { cache: 'no-store', headers: { Range: 'bytes=0-262143' }, signal: ctrl.signal })
      .then((r) => { clearTimeout(timer); resolve({ base, ok: r.ok || r.status === 206, ms: performance.now() - t0 }); })
      .catch(() => { clearTimeout(timer); resolve({ base, ok: false }); });
  });
}

let decided = false;
const pick = (r) => {
  if (decided || !r.ok) return;
  decided = true;
  const use = r.base === MIRROR ? 'mirror' : 'origin';
  localStorage.setItem('dl_choice', use);
  localStorage.setItem('dl_choice_at', String(Date.now()));
  document.querySelectorAll('a.dbtn[href*="/downloads/"]').forEach((a) => {
    if (location.hostname === 'cn-mirror.example.com') return;  // 已在镜像站：保持相对链接
    const p = new URL(a.getAttribute('href'), location.href).pathname;
    a.setAttribute('href', use === 'mirror' ? MIRROR + p : p);
  });
};
probe('').then(pick);
probe(MIRROR).then(pick);
```

配套的手工开关（排障用）：`?mirror=1` 强制镜像、`?mirror=0` 强制源站，并记住选择。

**为什么不用 IP 库/时区**：香港、台湾、新加坡同样用 `Asia/Shanghai` 和 `zh-CN`；
浏览器端 GeoIP 要依赖第三方接口（隐私 + 可能被墙，反而更慢）。

---

## 4. 踩坑清单（每条都是真实事故）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 4.1 | 上传 OSS 报 `NoSuchBucket` | 买了存储包 ≠ 建了 bucket | `PUT /` 创建（需 `oss:PutBucket`），或控制台建好 |
| 4.2 | `PutBucketAcl public-read` 报 `not allowed` | 新 bucket 默认开**「阻止公共访问」**（不是 RAM 权限） | 先 `PUT /?publicAccessBlock`（XML body `<BlockPublicAccess>false</BlockPublicAccess>`），再设 ACL |
| 4.3 | `SignatureDoesNotMatch` | `CanonicalizedOSSHeaders` 冒号后多一个空格 | 写成 `x-oss-acl:public-read`（无空格、小写、按字典序） |
| 4.4 | `?publicAccessBlock` 报 `MalformedXML` | 该 API 要 XML body，不是 header | 发 `<PublicAccessBlockConfiguration>…` |
| 4.5 | 302 后 404 | 对象键分层 `downloads/<版本>/`，但 URL 是 `downloads/<文件>` | 键用**扁平**结构；改结构用**服务端 CopyObject**（不耗流量） |
| 4.6 | 镜像 302 到自己，死循环 | `root` 层级错：文件在 `<root>/x.dmg`，nginx 找 `<root>/downloads/x.dmg` | 目录补一层 `downloads/`，或改用 `alias` |
| 4.7 | 浏览器一直拿到旧重定向 | 用了 301 | 用 302 |
| 4.8 | CI 整份 workflow 被判 Invalid | **step 级 `if` 不能用 `secrets` 上下文** | job 级 `env` 折算成 `HAS_XXX`，step 判 `env.HAS_XXX == 'true'` |
| 4.9 | 签名步骤"成功"但签了 0 个文件 | `download-artifact` 把文件解到 `<dir>/<artifact-name>/` 子目录，脚本只扫单层 | 脚本**默认递归**；并断言"签出数量 > 0" |
| 4.10 | 上传 Release 报 `422 name already exists` | 两个平台各产一份同名 `latest-mac.yml`，都签成 `.sig` | **只签安装包**，清单由服务端生成器统一产出 |
| 4.11 | 加速步骤没生效 | 它排在可能失败的步骤之后，前一步红 → 整段 skipped | 拆成独立工作流，失败互不牵连 |
| 4.12 | 本机测速"很快"，实际发版很慢 | 突发带宽前几秒 8MB/s、之后被限到 0.2MB/s | 只用**持续传输**的数字做判断；测 ≥20MB |

---

## 5. 验收清单（发版后逐条跑）

```bash
# ① 头一跳是 302（不是 404、不是 301）
curl -s -o /dev/null -w '%{http_code}\n' https://<源站>/downloads/<包>
# ② 跟随到底能拿到字节（206）
curl -sL -o /dev/null -r 0-1023 -w 'final=%{http_code} hops=%{num_redirects}\n' https://<源站>/downloads/<包>
# ③ 镜像：本地直供应是 206 且 0 跳
curl -sL -o /dev/null -r 0-1023 -w 'final=%{http_code} hops=%{num_redirects}\n' https://<镜像>/downloads/<包>
# ④ 缺文件必须 404（不能回退成 200 + HTML）
curl -s -o /dev/null -w '%{http_code}\n' https://<源站>/downloads/__nope__.dmg
# ⑤ 差量更新素材在（否则自动更新静默退化成整包下载）
curl -sL -o /dev/null -r 0-1023 -w '%{http_code}\n' https://<源站>/downloads/<包>.blockmap
# ⑥ 三份更新清单版本号一致
for f in latest.yml latest-linux.yml latest-mac.yml; do curl -s https://<源站>/updates/$f | head -1; done
```

**四条判定规则**：

- 头一跳必须是 **302**；是 301 说明用了 `permanent`；
- 跟随到底必须是 **200/206**；是 404 说明对象键或路径层级错；
- 缺文件必须是 **404**；是 200 说明站点把未知路径回退成 HTML（这是最危险的伪成功）；
- `.blockmap` 必须可下；缺它不会阻断更新，但每次都会**静默退化为整包下载**。

---

## 6. 反模式（别做）

| 反模式 | 后果 |
| --- | --- |
| 用本机 `scp` 给境外/香港节点发安装包 | 0.1MB/s，一晚上发不完；且会**占满服务器入向**，CI 与 SSH 一起掉速 |
| 把"上传/推送"和"构建/签名"放在同一个 job 的后面 | 前面任何一步红，整段加速被跳过（4.11） |
| 服务器用公网端点读对象存储 | 白付公网流量，还慢 185 倍 |
| 用 IP 地址对外提供下载 | 不专业；IP 变更即失效；还绕不过备案要求 |
| 依赖"服务器之间互传"作为主路径 | 服务器间链路会随机塌到 0.07MB/s（实测） |
| 只测一次就下结论 | 同一条命令两个时点差 190 倍 |

---

## 7. 成本参考（阿里云，2026-11）

| 项 | 单价参考 | 本项目月量级 |
| --- | --- | --- |
| 标准存储-本地冗余（香港） | ≈¥0.16/GB/月 | ~1.3GB → **¥0.2** |
| 出流量 | ≈¥0.5/GB | ~20GB → **¥10** |
| 请求费 | 极低 | 忽略 |
| 存储包 | 最小规格通常 500GB | **别买**（我们只需个位数 GB） |

> 结论：**别买存储包**，按量付费更省；真正花钱的是**出流量**，月出流量上百 GB 再考虑流量包。

---

## 8. 移植到下游项目：最小步骤

1. **建对象存储 bucket**（与源站**同地域**），关掉「阻止公共访问」，设公共读；
2. **拷两个脚本**：`scripts/oss-sync.mjs`（上传/下载/列举）、`scripts/prune-downloads.mjs`（本地磁盘版本裁剪）；
3. **加一个 `MirrorSync` 工作流**（§3.1），按 tag 手动触发；
4. **改源站 nginx**：`/downloads/` 302 到对象存储（§3.4）；
5. （有大陆节点）**加镜像节点**：本地优先 + 302 兜底（§3.4）；
6. （可选）**页面加就近选择脚本**（§3.5）；
7. **把 §5 的验收清单接进发版检查**——这六条能拦住 90% 的分发事故；
8. 在发版脚本里加一条**版本数上限**（本地只留最近 N 版），并定期跑 `prune-downloads --apply`。

---

## 附录：本仓库相关文件

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/mirror-sync.yml` | CI → 对象存储（按 tag 手动触发 + 匿名冒烟） |
| `scripts/oss-sync.mjs` | 零依赖 OSS 客户端（`put / ls / get`） |
| `scripts/prune-downloads.mjs` | 本地安装包版本裁剪（默认 dry-run，含单元测试与变异） |
| `deploy/nodes/relay-push.sh` | 本机 → 国内节点 → 源站 的应急中转（没有 CI/对象存储时用） |
| `deploy/nodes/mdh-probe.py` | 国内视角拨测（源站 + 镜像 + 缺文件 404） |
| `docs/DEPLOY-NODES.md` | 两台节点的角色划分与实测数据 |
| `docs/DESKTOP-AUTO-UPDATE.md` | 更新清单（`latest*.yml`）生成规则与差量更新 |

> 本手册只讲"**怎么把产物送到用户手里**"。更新清单的字段（sha512/blockMapSize）与签名边界见
> `docs/DESKTOP-AUTO-UPDATE.md` 与 `docs/CODE-SIGNING.md`。
