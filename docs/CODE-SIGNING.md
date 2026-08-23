# 桌面版代码签名与公证指南

消除 Windows SmartScreen 警告与 macOS Gatekeeper「仍要打开」提示的完整流程。
**当前构建为未签名**（官网已注明绕过方法）；按本指南拿到证书后，把对应密钥配成
环境变量即可，无需改代码。

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
- **不想签**：现状即可用（官网已附绕过说明），仅多一步手动确认。

---

*配置文件位置：`desktop/electron-builder.yml`（azureSignOptions 注释）、`.github/workflows/desktop.yml`（env 段）。*
