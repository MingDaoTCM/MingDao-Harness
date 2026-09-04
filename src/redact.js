// 统一脱敏（v0.3.1 P1-1 修复）：审计/日志/会话/诊断/错误消息共用同一套规则，消除「各层自扫门前雪」。
//  - redactSecrets：密钥脱敏（常见前缀 + Bearer + URL 内嵌凭据），保留路径便于排查 → 审计/日志用
//  - redactSensitive：在 redactSecrets 之上再加私网 IP + 家目录路径掩码 → 诊断包/对外输出用
import os from 'node:os';

// 常见密钥前缀（GitHub/OpenAI/AWS/Slack/Google 等）；sk- 保留前缀、其余整体掩码
const KEY_PREFIX = /(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})/g;

export function redactSecrets(/** @type {any} */ text) {
  let s = String(text ?? '');
  s = s.replace(/(sk-[A-Za-z0-9_-]{6,})/g, 'sk-***'); // 保留 sk- 前缀（兼容审计标记）
  s = s.replace(KEY_PREFIX, '***');
  s = s.replace(/(Authorization\s*:\s*Bearer\s+)[^\s"',}]+/gi, '$1***');
  s = s.replace(/((?:api[_-]?key|token|secret|password|passwd|access_token)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1***');
  s = s.replace(/([?&](?:key|token|secret|api_key|access_token)=)[^&\s"']+/gi, '$1***');
  return s;
}

export function redactSensitive(/** @type {any} */ text) {
  let s = redactSecrets(text);
  s = s.replace(/\b(?:10|127)(?:\.\d{1,3}){3}\b|\b192\.168(?:\.\d{1,3}){2}\b|\b169\.254(?:\.\d{1,3}){2}\b|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b|\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b/g, '[私网IP]');
  s = s.replace(/(?:fe80:[\da-f:]+|::1|::)/gi, '[链路本地/回环IPv6]');
  const home = os.homedir();
  if (home && home.length > 1) s = s.split(home).join('~');
  return s;
}
