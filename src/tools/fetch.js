// HTTP 只读抓取工具（v0.3.1）：GET 任意 http(s) URL，返回文本（512KB 上限，正文截 20K）。
//
// v0.6.7（三份 v0.6.6 审计报告的共同结论）：**本工具此前自己维护了一份更弱的 SSRF 实现**，
// 与 safe-fetch.js 并存 → 最弱的那份说了算：
//   · DNS 复检的 catch 是**放行**（fail-open）——"让校验阶段解析失败、连接阶段再成功"正是攻击者的手段；
//   · 校验用 `lookup()`、连接交给 undici **再解析一次** → DNS rebinding 窗口（check 公网 IP、connect 内网 IP）；
//   · `isMetadataHost` 只按主机名判，域名解析到元数据 IP 时不触发。
// 而 safe-fetch.js 早就在 BUG-057 里把这三条都修好了（fail-closed + 已校验 IP 钉给连接层 + 逐跳复检），
// 只是没同步到这里 —— 项目自己登记的「同一规则多份实现是最弱那份说了算」，第三次在同一类判定上重演。
//
// 现在：私网/元数据/DNS 判定统一从 ssrf-guard.js 取（单一来源），实际抓取**整条走 safeFetchText**，
// 本文件只保留工具契约（参数校验、512KB/20K 的呈现口径、给模型的错误措辞）。
import { safeFetchText } from '../safe-fetch.js';
import { isPrivateHost, isMetadataHost } from '../ssrf-guard.js';

// 兼容再导出：本模块曾是这两个判定的家，外部（skill-lib / model-caps / web/server / 测试）按
// `from './tools/fetch.js'` 引用过。实现已搬到 ssrf-guard.js，这里只是转发同一函数对象
// （不是第二份实现——测试里有一条断言 `isPrivateHost === ssrfGuard.isPrivateHost` 钉住这一点）。
export { isPrivateHost, isMetadataHost };

const MAX_BYTES = 512 * 1024;
const BODY_LIMIT = 20000;
const TIMEOUT_MS = 15000;

/** safeFetchText 的错误 → 本工具既有的给模型看的措辞（保持既有契约，便于下游与断言稳定）。 */
function mapError(/** @type {string} */ err) {
  if (err === '响应超过大小上限') return `响应超过 ${Math.round(MAX_BYTES / 1024)}KB 上限。`;
  if (err.startsWith('下载超时')) return '抓取失败：超时（15s）';
  if (/^(拒绝访问|域名解析失败|出网被拦截|下载失败|重定向次数超过上限|非法重定向地址|重定向到非)/.test(err)) return err;
  return '抓取失败：' + err;
}

export async function runFetch(/** @type {any} */ args, /** @type {any} */ _ctx) {
  const raw = String(args.url ?? '').trim();
  if (!raw) return { ok: false, error: '缺少 url 参数。' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'url 必须是合法的 http(s) URL。' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http/https 地址。' };
  // 单一口径：判定 + fail-closed + IP 钉扎 + 逐跳复检 + 出网闸门，全在 safeFetchText/ssrf-guard 里
  const r = await safeFetchText(u, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
  if (r.error) return { ok: false, error: mapError(String(r.error)) };
  const text = String(r.text ?? '');
  const truncated = text.length > BODY_LIMIT;
  const output = truncated ? text.slice(0, BODY_LIMIT) + '\n…[正文过长已截断，共 ' + text.length + ' 字符]' : text;
  return { ok: true, status: r.status ?? 0, contentType: r.contentType || '', output: output || '（空响应）' };
}
