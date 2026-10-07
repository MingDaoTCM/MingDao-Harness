# 桌面版代码签名与公证指南

消除 Windows SmartScreen 警告与 macOS Gatekeeper「仍要打开」提示的完整流程。
**当前构建为未签名**（官网已注明绕过方法）；按本指南拿到证书后，把对应密钥配成
环境变量即可，无需改代码。

> 自动更新包的**来源签名**是**另一件事**（防"更新源被投毒"，不是防 SmartScreen），见 §五：
> 代码已就位且判据 fail-closed，但**发布链路尚未接入**——默认档为 `warn-and-install`
> （照旧安装，但 UI/日志明确写出"本次更新未验证来源签名"）。

---

## 一、Windows 代码签名（二选一）

### 方案 A：OV/EV 代码签名证书（传统方式）

| 项 | OV（组织验证） | EV（扩展验证） |
| --- | --- | --- |
| SmartScreen 效果 | 新证书初期仍提示，随下载量积累信誉后消失 | **签发即过**（即时信誉） |
| 价格 | 约 ¥1000–2500/年 | 约 ¥3000–6000/年 |
| 主体要求 | 需要**企业/个体工商户**营业执照（个人买不到） | 同左 |

购买渠道（国内可直接开票）：亚洲诚信（TrustAsia）/ Sectigo / DigiCert / GlobalSign 的
国内代理，搜索「OV 代码签名证书」即可。CA 会发 **USB Key（U 盾）或加密后的 .pfx**。

拿到证书后导出为 **.pfx（含私钥）**，转成 base64 配置环境变量：

```bash
base64 -w0 your-cert.pfx > cert.b64   # Windows 用 certutil -encode
# GitHub Secrets → CSC_LINK = cert.b64 内容（含换行也可）
#               → CSC_KEY_PASSWORD = pfx 导出密码
```

### 方案 B：Azure Trusted Signing（个人开发者推荐）

个人无法申请 OV/EV 时的官方方案（微软 2024 年推出，**$9.99/月**，无需企业主体、无硬件）：

1. 注册 Azure 账号 → 订阅 → 搜索「**Trusted Signing**」服务创建签名账户；
2. 创建 **Certificate Profile**（类型 Public Trust），记录 endpoint（形如
   `https://xxx.codesigning.azure.net/`）与 `CertificateProfileName`；
3. 在 Azure Entra 注册一个应用并给其签名账户的
   `Code Signing Certificate Profile Signer` 角色，取得 tenant/client/secret；
4. 配置 `desktop/electron-builder.yml` 的 `win.azureSignOptions`（见该文件注释）并设置
   环境变量 `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`。

> 提示：Azure Trusted Signing 签出的也是可信证书，SmartScreen 信誉随使用积累。

---

## 二、macOS 签名 + 公证

1. 注册 [Apple Developer Program](https://developer.apple.com/programs/)（**$99/年**，个人即可）；
2. 在 https://developer.apple.com/account/resources/certificates 创建
   **Developer ID Application** 证书 → 下载后在「钥匙串访问」导出为 **.p12（含私钥）**；
3. 在 https://appleid.apple.com 的「登录与安全」生成 **App 专用密码**；
4. 配置环境变量（electron-builder 检测到后自动签名 + 公证，零代码改动）：

| 环境变量 | 值 |
| --- | --- |
| `CSC_LINK` | p12 的 base64（`base64 -w0 cert.p12`） |
| `CSC_KEY_PASSWORD` | p12 导出密码 |
| `APPLE_ID` | 你的 Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 第 3 步生成的 App 专用密码 |
| `APPLE_TEAM_ID` | https://developer.apple.com/account 右上角显示的 Team ID |

---

## 三、CI（GitHub Actions）接线

把上述环境变量按名字建到仓库 **Settings → Secrets and variables → Actions**
（`CSC_LINK` 直接贴 base64 全文）。`desktop.yml` 已预留 env 引用（见 `env:` 段），
密钥存在后**下次打 tag 自动签名/公证**。密钥只进 GitHub Secrets，绝不进仓库。

macOS 作业的 `--mac dmg` 在检测到 `CSC_LINK` + Apple 凭证时自动完成签名与
`notarytool` 公证（`hardenedRuntime` 由 electron-builder 默认开启）。

---

## 四、常见问题

- **签了名 SmartScreen 还提示**：OV/新证书需积累下载信誉（通常数周）；EV 即时生效。
  也可到微软 [Windows Defender SmartScreen](https://www.microsoft.com/wdsi/filesubmission)
  提交文件加快信誉建立。
- **公证失败**：常见原因是 p12 不含私钥、App 专用密码错误、或 hardened runtime 缺少
  entitlements。electron-builder 会在 CI 日志打印 notarytool 完整输出。
- **验证是否签上**：Windows 右键 exe →「数字签名」；macOS `codesign -dv
  --verbose=4 MingDao.app` 与 `spctl -a -vv MingDao.app`。
- **「代码签名 OV」与「域名 OV」是同一个证书吗？** 不是。两者只共享 OV（组织验证）
  概念：域名 OV 是 SSL/TLS 证书（绑定域名、EKU=Server Authentication、给 HTTPS 用）；
  代码签名 OV 绑定组织身份（EKU=Code Signing 1.3.6.1.5.5.7.3.3、给软件签名用），
  常以 USB Key 交付，互不可替代。下单务必确认 EKU 为 Code Signing。
- **不想签**：现状即可用（官网已附绕过说明），仅多一步确认。

---

## 五、更新包的**来源签名**（ed25519，与代码签名是两件事）

> **先分清两件事**：上面一~四节是**代码签名**（证书 + Gatekeeper / SmartScreen，回答"这个 App 的
> 制作者是谁、系统要不要拦"）；本节是**更新包的来源签名**（回答"这个自动更新包是不是官网发的"）。
> 两者互不替代：代码签名不能阻止应用从被投毒的更新源装一个**同样签了名**的包，来源签名也不负责
> 消除 SmartScreen 提示。
>
> **本轮状态（诚实标注）**：代码已就位并 fail-closed，但**发布链路尚未接入签名**——
> `desktop/gen-update-yml.mjs` 与服务器发布脚本都没有签名步骤，feed 里**没有** `.sig` 文件。
> 因此客户端当前实际走的是**默认档 `warn-and-install`**：照旧安装，但在日志与 UI 里明确写出
> 「**本次更新未验证来源签名**」。要让"没签名就拒绝"生效，发行方需要：① 按下面步骤接入签名；
> ② 在客户端设 `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1`（或改成默认值）。

### 5.1 为什么不是"再算一次 sha512"

`electron-updater` 自带的 sha512 校验，比的是「下载到的字节」与「**同一份 feed 提供的** `latest*.yml`
里的 sha512」——清单与包**同源**。控制 feed 的一方（DNS / 主机 / CDN / 证书任一被攻破）可以同时换掉包
与清单里的 sha512，校验照样通过，随后 `quitAndInstall()` 执行攻击者的安装包。

这不是推测，是本仓探针（未入库：`/tmp/probe-update-feed.mjs`，本机 HTTP 投毒 feed + 桩 `electron-updater`，
跑的是**真实的** `desktop/main.js`）实测过的：投毒 feed + 攻击者自己算的 sha512 → 下载 → 校验 MATCH →
安装被调用；只改字节不改清单（传输损坏）→ sha512 mismatch → 不安装。**即 sha512 只防传输损坏，不防换源。**

来源签名补的正是后者：签名用**只有发行方持有**的私钥生成，客户端只内置**公钥**。攻击者控制了 feed
也造不出签名（他自己签的包会被内置公钥判无效）。

### 5.2 密钥托管（私钥留在离线机 / CI secret）

| 项 | 约定 |
| --- | --- |
| 算法 | ed25519（`node:crypto`，零依赖；与 `src/ledger.js` 的账本来源签名同一套约定） |
| 私钥位置 | **离线机**或 CI secret（如 `MINGDAO_UPDATE_SIGN_KEY` 指向的文件）。**绝不入库、绝不打印、绝不进聊天/工单/截图**（`--keygen` 只打印公钥） |
| 私钥文件权限 | `600`（`--keygen` 自动设置；Windows 无 POSIX 权限位，用目录权限隔离） |
| 公钥位置 | 贴进 `desktop/update-verify.js` 的 `UPDATE_PUBLIC_KEY_PEM` 常量（**内置常量**，运行期不从网络取——从网络取公钥等于没 pin） |
| 密钥轮换 | 换密钥 = 所有旧签名失效。`--keygen` **拒绝覆盖**已存在的密钥文件（必须先手工移走），避免"悄悄换了信任根" |
| 本轮内置的那把公钥 | `keyId=d1e7bef80ca5d508`。它对应的私钥在本轮**未保留**（生成后即弃，从未写盘/打印）——所以"验签通过"这条路径在当前发布链路下不会被走到；它保证的是：**任何别人签的包一律验不过** |

### 5.3 发布步骤（发行方启用签名时）

```bash
# ① 生成密钥对（在离线机 / 受控环境；私钥写仓库之外，脚本会拒绝写进仓库）
node scripts/update-sign.mjs --keygen --out ~/.mingdao/update-signing
#    → 把打印出来的**公钥** PEM 贴进 desktop/update-verify.js 的 UPDATE_PUBLIC_KEY_PEM

# ② 每次发版：对每个平台的安装包签名（产出 <包>.sig）
node scripts/update-sign.mjs --sign desktop/dist/mingdao-setup-<ver>-x64.exe
node scripts/update-sign.mjs --sign desktop/dist/mingdao-<ver>-x86_64.AppImage
#    → 打印的 sha512 必须与 latest*.yml 里的 sha512 **逐字一致**（不一致说明签错了文件）

# ③ 发布前自检（与客户端**同一实现**，避免"发布侧说通过、客户端说无效"）
node scripts/update-sign.mjs --verify desktop/dist/mingdao-setup-<ver>-x64.exe --pub update-signing-pub.pem

# ④ 上传：安装包 + 它的 .sig **一起**放进 feed 目录（官网 /updates/，与 latest*.yml 同级）
```

判据与文案在 `desktop/update-verify.js`（纯函数，`test/smoke.js` §135 逐条钉边界）：

| 情形 | 决策 | 行为 |
| --- | --- | --- |
| 有签名 + 验签通过 | `install` | 提示"来源签名校验通过（ed25519 · keyId=…）"，正常安装 |
| **有签名 + 验签失败 / 拿不到证据** | `reject` | **一律拒绝**：UI"更新包来源不可信，已拒绝"+ 引导官网手动下载；并**关闭 `autoInstallOnAppQuit`**（否则退出应用时照样装） |
| 无签名 + 默认 | `warn-and-install` | 照旧安装，但日志与 UI 都写明"**本次更新未验证来源签名**"、并说明当前发布链路没有签名步骤 |
| 无签名 + `MINGDAO_REQUIRE_UPDATE_SIGNATURE=1` | `reject` | fail-closed：发行方/高安全用户的开关 |

**为什么不默认 reject**：当前发布链路还没有签名，默认 reject 等于一夜之间掐死所有存量用户的自动更新。
威胁模型里"feed 被投毒"是低概率高影响，"更新永远装不上"是必然发生——所以默认放行但**如实告知**，
把 fail-closed 开关交给发行方。发布链路接入签名后，把 `decideUpdatePolicy` 的默认档改成 `reject`
即可（一行，判据与文案不用动）。

### 5.4 失败处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 用户看到"**更新包来源不可信，已拒绝**" | 签名无效（包被改 / 由别的密钥签发）或 `REQUIRE=1` 而没有签名 | 让用户到官网手动下载；发行方核对 `latest*.yml` 里的 sha512 与 `--sign` 打印的 sha512 是否一致、feed 里是否放上了对应的 `.sig` |
| 用户看到"更新已就绪（**未验证来源签名**）" | 默认档 + feed 没有 `.sig` | 属预期（见 5.1 的本轮状态）；要消除它就得接入签名并设 `REQUIRE=1` |
| 明明签了名，客户端还是说"未验证来源签名" | `.sig` 没上传 / 文件名不是 `<安装包名>.sig` / feed 目录与 `UPDATE_FEED_BASE` 不一致 | 核对 feed 目录里 `<包名>.sig` 是否存在；改了 `electron-builder.yml` 的 `publish.url` 时，`desktop/update-verify.js` 的 `UPDATE_FEED_BASE` 必须一起改 |
| 换了密钥后**所有**客户端都拒绝 | 正常且期望：内置公钥还是旧的那把 | 用 `--keygen` 生成新密钥 → 替换 `UPDATE_PUBLIC_KEY_PEM` → 发一次带签名的新版本（旧版本客户端无法验新密钥，这是非对称 pin 的固有代价） |
| 私钥文件/口令疑似泄露 | —— | **立即轮换**（`--keygen` 新密钥 + 替换公钥常量），并公告旧版本客户端的验签行为；仓库里若出现过私钥，视为已泄露（`git log` 里删不掉） |

### 5.5 边界（不在本机制范围内）

- **签名缺失时的降级无法区分**：控制 feed 的攻击者可以**删掉** `.sig`，把这次更新降级成"无签名"。
  默认档下这仍然会走到 `warn-and-install`。要真正关闭它，必须让发布链路**每次都签**并且客户端
  `REQUIRE=1`。这是"默认不掐死存量更新"这一取舍的必然后果，已写进源码注释与登记文档。
- **签名载体**：客户端按 ① `latest*.yml` 内嵌 `signature:` 字段 → ② 本机旁车 `<包>.sig` →
  ③ feed 目录 `<包名>.sig`（HTTPS 取公开数据）的顺序取材。**当前实测过的是旁车 `.sig`**；
  内嵌字段要依赖 `electron-updater` 把未知 yml 字段透传到 `update-downloaded` 的 `info`
  （本仓未对真实库验证），故发布流程以旁车为准。
- `MINGDAO_UPDATE_PUBKEY_PEM` + `MINGDAO_UPDATE_ALLOW_PUBKEY_OVERRIDE=1` 是**显式双开关**的开发/测试
  覆盖（两个都要给才生效）。**发布构建不得设置**；只设前者不会替换内置公钥。
- 不含 macOS/Windows 的**代码签名**与公证（见第一~四节），也不含"官网下载页手动安装包"的来源校验
  （用户手动下载时走的是浏览器 TLS + 系统 SmartScreen/Gatekeeper）。
- 不含密钥吊销 / 多密钥并存验签（换密钥即全量失效，见上表）。
- 私钥与构建机同权时，本层不防"能改构建产物的人"——它防的是**发布源被换**。

---

*配置文件位置：`desktop/electron-builder.yml`（azureSignOptions 注释）、`.github/workflows/desktop.yml`（env 段）。*
*来源签名实现：`desktop/update-verify.js`（判据/文案单源）、`desktop/main.js`（门禁接线）、`scripts/update-sign.mjs`（发布侧工具）、`test/smoke.js` §135、`test/mutate/batch21-update-sign.mjs`。*
