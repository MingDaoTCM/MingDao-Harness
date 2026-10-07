# MingDao JetBrains 插件（IntelliJ 全家桶）

把 MingDao 的 WebUI 一键接入 JetBrains IDE：Tools 菜单「MingDao: 打开 WebUI」自动探测/启动服务器并打开浏览器。

## 构建与安装

前置：JDK 17 + 已安装 `mingdao-harness`（`mingdao`/`mdh` 可用）。

```bash
cd ide/jetbrains
gradle buildPlugin             # 产物：build/distributions/mingdao-jetbrains-<版本>.zip
```

> 本仓库**未提交 Gradle wrapper**（`gradlew`），因此请使用系统安装的 `gradle`（或用
> `gradle wrapper` 自行生成 wrapper 后再用 `./gradlew`）。产物版本号取自
> `build.gradle.kts` 的 `version`，不在此处硬编码（v0.4.7 修正：此前文档写死 0.5.0 且
> 与 build.gradle.kts 的 0.6.0 不一致；同时给出无法执行的 `./gradlew` 命令）。

安装：IDE → Settings → Plugins → ⚙ → Install Plugin from Disk → 选择 zip。开发调试：

```bash
gradle runIde                  # 启动带插件的沙箱 IDE
```

说明：`build.gradle.kts` 默认面向 IntelliJ IDEA Community（IC）；PyCharm/WebStorm 请把 `intellij.type` 改为 `PC`/`WS` 等并调整版本号。

## 功能

- **MingDao: 打开 WebUI**：探测服务（三态，见下），未运行才后台启动，就绪后浏览器打开（带令牌时地址带 `?token=`）
- **MingDao: 启动服务器**：仅启动（后台静默）
- 端口与命令可在 IDE 注册表设置（`mingdao.port` / `mingdao.binary`）

## 访问令牌与探测三态（v0.6.11，报告 K-9）

`mingdao web --auth-token <令牌>`（或 `MINGDAO_WEB_TOKEN` / `config.json` 的 `web.token`）会开启访问令牌，
此后**每个 `/api` 请求都要带令牌**。

- **令牌存在 IDE 的凭据库 `PasswordSafe` 里**（macOS Keychain / Windows KeePass / Linux libsecret），
  service name 由 `generateServiceName("MingDao", "webToken")` 生成；请求以 `X-MingDao-Token` 头发送，
  工具窗地址带 `?token=`。**不再放 `MingDaoSettings`** —— 它持久化在项目配置（`PropertiesComponent`）里，
  会随项目/工作区走。旧键 `mingdao.token` 若存在，会在动作触发时被**一次性迁移**进 `PasswordSafe` 并清除。
- 探测结果分**三态**（`Probe.OK` / `UNAUTHORIZED` / `UNREACHABLE`），三态对应三种**不同**的提示：

| 探测结果 | 状态 | 提示与下一步 |
| --- | --- | --- |
| HTTP 2xx | `OK` | 「服务已就绪。」继续 |
| HTTP 401 / 403 | `UNAUTHORIZED` | 「令牌无效或已过期（HTTP 401/403）——请重新输入访问令牌」，**并就地弹出输入框**（存入 PasswordSafe）；**不会去启动第二个服务** |
| 连接被拒 / 超时 / 其它状态码 | `UNREACHABLE` | 「连不上服务（服务未启动？运行 `mingdao web`，或 Tools → MingDao: 启动服务器）」 |

  修前 `healthy()` 里 `conn.getInputStream()` 在 401 上会抛 `IOException`，被
  `catch (_: Exception) { false }` 一并吞掉 —— 于是「令牌错」与「服务没起」是同一个 false，
  插件会去启动第二个注定失败的服务，然后加载公开的壳页面（每个 `/api` 都 401，界面空白且不报错）。
  现在统一用 `conn.responseCode` 判定。

## 状态说明

本插件已含工具窗深度集成（JCEF 内嵌 WebUI + 选中代码发送），Kotlin 代码经审阅但未在真实 IDE 中构建验证（本仓库环境无 IntelliJ SDK）；构建或运行报错请反馈。

**守卫方式（如实说明）**：v0.6.11 的令牌存储与三态判定在 CI 里**无法编译**（没有 IntelliJ SDK），
因此 `test/smoke.js` §134 对这一段用的是**源码级守卫**（正则钉住：`PasswordSafe.instance.get/set`、
`CredentialAttributes`/`generateServiceName`、`MingDaoSettings` 类体内无 token 字段、
401/403 → `UNAUTHORIZED`、三种提示文案互不相同、请求带 `X-MingDao-Token`、地址带 `?token=`），
**不是行为测试**；真正的行为验证需要一台能跑 `gradle runIde` 的机器。未做的边界还有：
输入框不做掩码、`PasswordSafe` 调用放在后台线程但调用方仍在 EDT 等待（彻底非阻塞需改造成 suspend/BGT）。
