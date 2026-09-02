// MingDao JetBrains 插件（IntelliJ IDEA / PyCharm / WebStorm 等全家桶）
// 深度集成：
//  - 工具窗（JCEF）内嵌 WebUI：右侧工具窗直接使用完整网页版
//  - 选中代码右键发送（/api/draft 草稿通道，WebUI 输入框自动填入）
//  - Tools 菜单：打开 WebUI / 启动服务器
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
package mingdao

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefBrowser
import java.net.HttpURLConnection
import java.net.URL

class MingDaoSettings(private val project: Project) {
    private val props = com.intellij.ide.util.PropertiesComponent.getInstance(project)
    var port: Int
        get() = props.getInt("mingdao.port", 3820)
        set(value) = props.setValue("mingdao.port", value, 3820)
    var binary: String
        get() = props.getValue("mingdao.binary") ?: "mingdao"
        set(value) = props.setValue("mingdao.binary", value)
}

fun baseUrl(project: Project): String {
    val s = project.service<MingDaoSettings>()
    return "http://127.0.0.1:${s.port}"
}

fun healthy(project: Project): Boolean {
    return try {
        val conn = URL(baseUrl(project) + "/api/state").openConnection()
        conn.connectTimeout = 800
        conn.readTimeout = 800
        conn.getInputStream().use { it.readBytes() }
        true
    } catch (_: Exception) {
        false
    }
}

fun startServer(project: Project) {
    val s = project.service<MingDaoSettings>()
    val os = System.getProperty("os.name").lowercase()
    val cmd = if (os.contains("win")) {
        listOf("cmd", "/c", "start", "", s.binary, "web", s.port.toString())
    } else {
        listOf("sh", "-c", "nohup ${s.binary} web ${s.port} >/dev/null 2>&1 &")
    }
    ProcessBuilder(cmd).start()
    repeat(15) {
        if (healthy(project)) return
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
        conn.outputStream.use { it.write("{\"text\":\"$escaped\"}".toByteArray()) }
        val code = (conn as? HttpURLConnection)?.responseCode ?: 200
        conn.inputStream.use { it.readBytes() }
        code in 200..299
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
        if (!healthy(project)) startServer(project)
        val browser = JBCefBrowser(baseUrl(project))
        val content = ContentFactory.getInstance().createContent(browser.component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}

class OpenWebUIAction : AnAction("MingDao: 打开 WebUI") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (!healthy(project)) startServer(project)
        if (healthy(project)) BrowserUtil.open(baseUrl(project))
    }
}

class StartServerAction : AnAction("MingDao: 启动服务器") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        startServer(project)
    }
}

class SendSelectionAction : AnAction("MingDao: 发送选中代码") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val text = editor.selectionModel.selectedText ?: return
        if (!healthy(project)) startServer(project)
        if (postDraft(project, text)) {
            focusToolWindow(project)
        }
    }
}
