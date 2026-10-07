// MingDao JetBrains 插件（IntelliJ IDEA / PyCharm / WebStorm 等全家桶）
// 深度集成：
//  - 工具窗（JCEF）内嵌 WebUI：右侧工具窗直接使用完整网页版
//  - 选中代码右键发送（/api/draft 草稿通道，WebUI 输入框自动填入）
//  - Tools 菜单：打开 WebUI / 启动服务器
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
//
// v0.6.11（第三方 v0.6.7 报告 **K-9** / §5.2 主线 B）：
//  ① 访问令牌改存 IDE 的 `PasswordSafe`（凭据库：macOS Keychain / Windows KeePass / Linux libsecret），
//     不再落 `MingDaoSettings`（它持久化到项目配置 `PropertiesComponent`）。旧键做一次性迁移。
//     **如实说明（复现结论）**：本仓 `git log --all -S token -- ide/` 为空 —— 历史代码里
//     **从来没有** 过令牌字段或令牌读取，所以这不是"把项目配置里的令牌搬到凭据库"，
//     而是**新增令牌支持**；下面的旧键迁移是对"用户手写过 `mingdao.token`"的**防御性覆盖**，
//     没有真实用户数据被迁移过。K-9 的原文是插件"对令牌失明"，不是"读错了地方"。
//  ② 探测结论分三态 `Probe.OK / UNAUTHORIZED / UNREACHABLE`，三者**下一步动作不同**：
//     `UNAUTHORIZED` 只让用户重新输入令牌（**绝不启动第二个服务**），`UNREACHABLE` 才去启动服务。
//     修前 `healthy()` 把 `getInputStream()` 在 401 上抛的 IOException 一起吞进
//     `catch (_: Exception) { false }` —— 于是"令牌错"与"服务没起"是同一个 false（K-9 根因）。
//
// **这段代码的守卫是源码级的，不是行为测试**：本仓没有 IntelliJ SDK，CI 里**无法编译**
// （见 ide/jetbrains/README.md「状态说明」）。`test/smoke.js` §134 用正则钉住：用了
// `PasswordSafe.instance.get/set` + `CredentialAttributes` + `generateServiceName`、
// `MingDaoSettings` 里没有 token 字段、401/403 映射到 UNAUTHORIZED、三种提示文案互不相同、
// 请求带 `X-MingDao-Token`、JCEF 地址带 `?token=`。真正的行为验证需要一台能跑 `gradle runIde` 的机器。
package mingdao

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.ide.BrowserUtil
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Callable
import java.util.concurrent.TimeUnit

/**
 * 项目级设置（持久化在 `PropertiesComponent`，随项目/工作区走）。
 *
 * v0.6.11（K-9）：**这个类里刻意不放任何凭据字段** —— 访问令牌存 IDE 凭据库 PasswordSafe
 * （见下方 webToken()/storeWebToken()）。项目配置会随仓库/工作区走，把访问本机 WebUI 的
 * 凭据放进去，等于把凭据交给被打开的项目。`test/smoke.js` §134 用正则钉住这一点
 * （类体内不得出现 token 字样）—— 这条守卫是源码级的，不是行为测试（本仓无法编译 Kotlin）。
 */
class MingDaoSettings(private val project: Project) {
    private val props = PropertiesComponent.getInstance(project)
    var port: Int
        get() = props.getInt("mingdao.port", 3820)
        set(value) = props.setValue("mingdao.port", value, 3820)
    var binary: String
        get() = props.getValue("mingdao.binary") ?: "mingdao"
        set(value) = props.setValue("mingdao.binary", value)
}

// ---------- 访问令牌：PasswordSafe（IDE 凭据库），不落项目配置 ----------

private const val LEGACY_TOKEN_KEY = "mingdao.token"

private val TOKEN_ATTRS: CredentialAttributes = CredentialAttributes(generateServiceName("MingDao", "webToken"))

/**
 * PasswordSafe 的调用是**阻塞**的，文档明确要求不得在 EDT 上调用（macOS 会弹钥匙串授权）。
 * 这里放到后台线程执行；调用方仍在 EDT 上等待结果（本插件其余 IO 也是同款阻塞风格）——
 * 彻底非阻塞需要把动作改造成 suspend/BGT，本仓无法编译验证，留给能跑 IDE 的后续。
 */
private fun <T> onPooledThread(block: () -> T): T? = try {
    ApplicationManager.getApplication().executeOnPooledThread(Callable { block() }).get(5, TimeUnit.SECONDS)
} catch (_: Exception) {
    null
}

/** 读令牌：只从 PasswordSafe 读。凭据库不可用（无头/被拒绝）时当作"没有令牌"，让 401 文案引导用户去设置。 */
fun webToken(): String = onPooledThread {
    PasswordSafe.instance.get(TOKEN_ATTRS)?.getPasswordAsString()?.trim().orEmpty()
} ?: ""

/** 写令牌；传空串即删除该条凭据。 */
fun storeWebToken(value: String) {
    val v = value.trim()
    onPooledThread { PasswordSafe.instance.set(TOKEN_ATTRS, if (v.isEmpty()) null else Credentials("mingdao", v)) }
}

/**
 * 一次性迁移：项目配置里的旧 `mingdao.token` → PasswordSafe，然后**清掉该键**。
 * 该键在历史代码里从未存在过（`git log --all -S token -- ide/` 为空）——防御性覆盖，见文件头。
 */
fun migrateLegacyToken(project: Project) {
    val props = PropertiesComponent.getInstance(project)
    val legacy = props.getValue(LEGACY_TOKEN_KEY)?.trim().orEmpty()
    if (legacy.isEmpty()) return
    if (webToken().isEmpty()) storeWebToken(legacy)
    props.unsetValue(LEGACY_TOKEN_KEY)
}

// ---------- 探测三态 ----------

/** 探测结论。三态的**下一步动作**不同，见 probeState 的注释。 */
enum class Probe { OK, UNAUTHORIZED, UNREACHABLE }

fun baseUrl(project: Project): String {
    val s = project.service<MingDaoSettings>()
    return "http://127.0.0.1:${s.port}"
}

/** WebUI 地址：有令牌时带 `?token=`（SPA 读进 sessionStorage 后从地址栏移除，见 src/web/app.js）。 */
fun webUrl(project: Project): String {
    val t = webToken()
    return if (t.isEmpty()) baseUrl(project) + "/" else baseUrl(project) + "/?token=" + URLEncoder.encode(t, "UTF-8")
}

/**
 * 探测服务：`ok` / `unauthorized`（HTTP 401/403，令牌问题）/ `unreachable`（连不上、超时、或服务在但状态异常）。
 *
 * 关键修法（K-9 根因）：用 `conn.responseCode` 判定，**不要**先碰 `getInputStream()` ——
 * 401 时 `getInputStream()` 会抛 IOException，被 `catch (_: Exception) { false }` 吞掉后
 * 与"连接被拒"混成同一态，于是插件会去启动第二个注定失败的服务。
 */
fun probeState(project: Project): Probe {
    val token = webToken()
    return try {
        val conn = URL(baseUrl(project) + "/api/state").openConnection() as HttpURLConnection
        conn.connectTimeout = 800
        conn.readTimeout = 800
        if (token.isNotEmpty()) conn.setRequestProperty("X-MingDao-Token", token)
        val code = conn.responseCode
        when {
            code == 401 || code == 403 -> Probe.UNAUTHORIZED
            code in 200..299 -> Probe.OK
            else -> Probe.UNREACHABLE
        }
    } catch (_: Exception) {
        Probe.UNREACHABLE
    }
}

/** 三态对应的用户提示：三种状态三句话，每句都指明**下一步做什么**。 */
fun probeMessage(state: Probe): String = when (state) {
    Probe.OK -> "服务已就绪。"
    Probe.UNAUTHORIZED -> "令牌无效或已过期（HTTP 401/403）——请重新输入访问令牌（Tools → MingDao 的任一动作会提示输入；令牌存入 IDE 的 PasswordSafe，不写项目配置）。"
    Probe.UNREACHABLE -> "连不上服务（服务未启动？运行 `mingdao web`，或 Tools → MingDao: 启动服务器）。"
}

/** 401 时：提示 + **就地重新输入令牌**（不启动服务）。输入框不做掩码（本仓无法编译验证掩码输入 API）。 */
fun handleUnauthorized(project: Project, state: Probe) {
    if (state != Probe.UNAUTHORIZED) return
    val yes = Messages.showYesNoDialog(project, probeMessage(state) + "\n\n现在输入访问令牌？", "MingDao 访问令牌", null)
    if (yes != Messages.YES) return
    val entered = Messages.showInputDialog(project, "访问令牌（存入 IDE 凭据库 PasswordSafe）：", "MingDao: 设置访问令牌", null)
    if (entered.isNullOrBlank()) return
    storeWebToken(entered)
    val again = probeState(project)
    Messages.showInfoMessage(project, if (again == Probe.OK) "令牌已保存，服务就绪。" else probeMessage(again), "MingDao")
}

fun startServer(project: Project) {
    val s = project.service<MingDaoSettings>()
    // v0.6.8（报告一 K-2，**高**）：**绝不把 binary 拼进 shell 字符串**。
    //
    // 此前 POSIX 分支是 `sh -c "nohup ${s.binary} web ${s.port} >/dev/null 2>&1 &"` ——
    // settings（可由项目级配置写入）里给 binary 填 `x; rm -rf ~ #` 就是一次真实命令注入；
    // Windows 分支经 `cmd /c` 同样会被再次解析。现在一律用 argv 数组直接 exec：
    // 参数不再经过任何 shell，注入面归零；输出丢弃、进程独立于 IDE 存活（无需 nohup）。
    val binary = s.binary.trim()
    require(binary.isNotEmpty()) { "MingDao: binary 未配置" }
    val cmd = listOf(binary, "web", s.port.toString())
    ProcessBuilder(cmd)
        .redirectOutput(ProcessBuilder.Redirect.DISCARD)
        .redirectError(ProcessBuilder.Redirect.DISCARD)
        .start()
    repeat(15) {
        if (probeState(project) == Probe.OK) return
        Thread.sleep(400)
    }
}

fun postDraft(project: Project, text: String): Boolean {
    return try {
        // 完整 JSON 转义（CodeBuddy 报告：此前漏 \n/\r/控制字符，多行选中必产出非法 JSON，发送静默失败）
        val sb = StringBuilder()
        for (ch in text) {
            when (ch) {
                '\\' -> sb.append("\\\\")
                '"' -> sb.append("\\\"")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
            }
        }
        val escaped = sb.toString()
        val conn = URL(baseUrl(project) + "/api/draft").openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        val token = webToken()
        if (token.isNotEmpty()) conn.setRequestProperty("X-MingDao-Token", token)
        conn.outputStream.use { it.write("{\"text\":\"$escaped\"}".toByteArray()) }
        // K-9：用 responseCode 判定，**不要**在 4xx 上碰 inputStream（401 会抛 IOException，
        // 被下面的 catch 吞掉就与"连不上"混成同一个 false）
        conn.responseCode in 200..299
    } catch (_: Exception) {
        false
    }
}

fun focusToolWindow(project: Project) {
    val tw = ToolWindowManager.getInstance(project).getToolWindow("mingdao.toolWindow")
    tw?.show()
}

class MingDaoToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        migrateLegacyToken(project)
        val state = probeState(project)
        if (state == Probe.UNAUTHORIZED) handleUnauthorized(project, state)
        if (state == Probe.UNREACHABLE) startServer(project)
        val browser = JBCefBrowser(webUrl(project))
        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

class OpenWebUIAction : AnAction("MingDao: 打开 WebUI") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        migrateLegacyToken(project)
        val state = probeState(project)
        if (state == Probe.UNAUTHORIZED) {
            // 令牌问题：**不启动第二个服务**（起了也一样 401），只让用户重新输入
            handleUnauthorized(project, state)
            return
        }
        if (state == Probe.UNREACHABLE) startServer(project)
        val after = probeState(project)
        if (after == Probe.OK) {
            BrowserUtil.open(webUrl(project))
        } else {
            Messages.showWarningMessage(project, probeMessage(after), "MingDao")
        }
    }
}

class StartServerAction : AnAction("MingDao: 启动服务器") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        migrateLegacyToken(project)
        val state = probeState(project)
        if (state == Probe.UNAUTHORIZED) {
            handleUnauthorized(project, state)
            return
        }
        startServer(project)
        val after = probeState(project)
        if (after != Probe.OK) Messages.showWarningMessage(project, probeMessage(after), "MingDao")
    }
}

class SendSelectionAction : AnAction("MingDao: 发送选中代码") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val text = editor.selectionModel.selectedText ?: return
        migrateLegacyToken(project)
        val state = probeState(project)
        if (state == Probe.UNAUTHORIZED) {
            handleUnauthorized(project, state)
            return
        }
        if (state == Probe.UNREACHABLE) startServer(project)
        val after = probeState(project)
        if (after != Probe.OK) {
            Messages.showWarningMessage(project, probeMessage(after), "MingDao")
            return
        }
        if (postDraft(project, text)) {
            focusToolWindow(project)
        } else {
            // 发送这一步失败：重新探测一次，给三态里对应那句（401 说令牌、连不上说 mingdao web）
            Messages.showWarningMessage(project, probeMessage(probeState(project)), "MingDao")
        }
    }
}
