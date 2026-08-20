// MingDao JetBrains 插件（IntelliJ IDEA / PyCharm / WebStorm 等全家桶）
// 功能：Tools 菜单一键启动服务器并打开 WebUI；服务器自动探测（已运行则直接打开）。
// 前置：已安装 mingdao-harness（mingdao / mdh 命令可用）。
package mingdao

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
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
    // 后台启动服务器（Linux/macOS）；Windows 用 cmd 启动
    val os = System.getProperty("os.name").lowercase()
    val cmd = if (os.contains("win")) {
        listOf("cmd", "/c", "start", "", s.binary, "web", s.port.toString())
    } else {
        listOf("sh", "-c", "nohup ${s.binary} web ${s.port} >/dev/null 2>&1 &")
    }
    ProcessBuilder(cmd).start()
    // 等待就绪（最多 6 秒）
    repeat(15) {
        if (healthy(project)) return
        Thread.sleep(400)
    }
}

class OpenWebUIAction : AnAction("MingDao: 打开 WebUI") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        if (!healthy(project)) {
            startServer(project)
        }
        if (healthy(project)) {
            BrowserUtil.open(baseUrl(project))
        }
    }
}

class StartServerAction : AnAction("MingDao: 启动服务器") {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        startServer(project)
    }
}
