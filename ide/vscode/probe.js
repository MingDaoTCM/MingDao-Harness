// 探测结论的**三态判定**（纯函数、零依赖、可直接 require 单测）。
//
// 为什么单独成文件（v0.6.11 开发线：第三方 v0.6.7 审计报告 **K-9** / §5.2 主线 B）：
//   修前 `extension.js` 的 `health()` 只有一个判据 `res.statusCode === 200`。于是
//     · 401/403（**令牌错**：服务在跑，只是凭据不对）
//     · ECONNREFUSED / 超时（**服务没起**：连接层失败）
//   落在同一个 `false` 上 —— 插件因此做出同一个（错误的）下一步动作：
//   「判定服务未运行 → 启动第二个注定失败的服务 → 加载公开壳页面 → 每个 /api 都 401 → 空白界面且不报错」。
//
// **实测复现**（探针 `/tmp/probe-ide-token.mjs`，2026-10-07，桩 vscode 模块 + 本机真实 HTTP 假 WebUI）：
//   · 假 WebUI 强制令牌（无令牌 → 401）时 `openWebUI()`：**spawn 次数 = 1**（真去启动了第二个服务），
//     用户看到的提示是「服务器启动失败，请运行「MingDao: 启动服务器（终端）」查看日志」——把令牌问题
//     说成了服务没起；
//   · 换成没人监听的端口（ECONNREFUSED）：提示与 401 那次**逐字相同**。
//   Kotlin 侧同源：`healthy()` 里 `conn.getInputStream()` 在 401 上会抛 IOException，被
//   `catch (_: Exception) { false }` 吞掉 → 与"连不上"混为一谈（见 MingDaoPlugin.kt 的注释）。
//
// 状态不同 ⇒ **用户该做的事不同**，这是本文件存在的全部理由：
//   ok           → 继续（加载 WebUI / 发草稿）
//   unauthorized → 不要启动服务（起了也没用），让用户**重新输入令牌**
//   unreachable  → 服务确实不在/不健康，按原路径启动，并把用户引向 `mingdao web`
//
// 判定只认 HTTP 响应码：
//   · 拿到响应码 ⇒ 连接层是通的，用响应码说话（401/403 → 令牌；2xx → 可用；其余 → 不可用）；
//   · 没拿到响应码 ⇒ 连接被拒 / 超时 / socket 被 destroy，一律 `unreachable`。
//     `error` **不参与**三态判定（三态契约里没有第四态），它只让文案更准确（见 probeAdvice）。
//     特别地：既没有响应码也没有 error 的输入不得判为 ok —— 「没有证据」不等于「通」。

/** 令牌类失败的状态码：401（缺/错令牌）与 403（Host/来源校验失败也走这里，见 src/web/routes/api.js） */
const UNAUTHORIZED_STATUS = new Set([401, 403]);

/**
 * 把一次探测的原始结果判成三态。
 * @param {{ statusCode?: number|null, error?: any }} [input] HTTP 响应码（无响应传 null/undefined）与连接层错误
 * @returns {'ok'|'unauthorized'|'unreachable'}
 */
function classifyProbe(input) {
  const statusCode = input && Number.isFinite(input.statusCode) ? input.statusCode : null;
  if (statusCode !== null) {
    if (UNAUTHORIZED_STATUS.has(statusCode)) return 'unauthorized';
    if (statusCode >= 200 && statusCode < 300) return 'ok';
    // 服务在，但状态码不是"可用"信号（5xx / 404 / …）：归入不可用，文案里点明状态码
    return 'unreachable';
  }
  // 没有任何响应码：连接层失败（ECONNREFUSED / 超时 / 被 destroy）。
  return 'unreachable';
}

/** 连接层错误是否属于"超时"（决定文案是「服务未启动？」还是「探测超时，服务可能卡住」） */
function isTimeout(error) {
  const s = String((error && (error.code || error.message)) || error || '');
  return /超时|timed?\s?out|ETIMEDOUT/i.test(s);
}

/**
 * 三态对应的**用户提示**：让用户知道下一步做什么，而不是笼统一句「连接失败」。
 *
 * 放在这里（而不是 extension.js 里）是刻意的：文案也是有行为契约的
 * （`test/smoke.js` §134 直接断言三态产出三句**不同**的话），写在纯函数模块里就能被行为测试钉住，
 * 不必退化成"检查源码文本里有这句话"。
 *
 * @param {'ok'|'unauthorized'|'unreachable'} state @param {{ statusCode?: number|null, error?: any }} [info]
 * @returns {string} 不带 "MingDao: " 前缀（调用方按提示级别拼接）
 */
function probeAdvice(state, info) {
  const statusCode = info && Number.isFinite(info.statusCode) ? info.statusCode : null;
  if (state === 'ok') return '服务已就绪。';
  if (state === 'unauthorized') {
    const shown = statusCode !== null ? statusCode : '401/403';
    return `令牌无效或已过期（HTTP ${shown}）——请重新输入：命令面板 →「MingDao: 设置访问令牌」。令牌存在 VS Code 加密存储里，不读 settings。`;
  }
  if (statusCode !== null) {
    // 有响应码 ⇒ 服务是活的，再说"服务未启动"就是误导（K-9 的教训）
    return `服务已响应但状态异常（HTTP ${statusCode}）——请查看服务端日志（mingdao web 的输出）。`;
  }
  const why = isTimeout(info && info.error) ? '（探测超时：服务可能卡住，或端口被占用）' : '';
  return `连不上服务${why}（服务未启动？运行 \`mingdao web\`，或命令「MingDao: 启动服务器（终端）」）。`;
}

module.exports = { classifyProbe, probeAdvice, isTimeout };
