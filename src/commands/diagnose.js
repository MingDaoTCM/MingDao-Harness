// 命令族：mingdao diagnose（v0.3.0 P2-5）：一键打包诊断信息（脱敏），便于贴反馈渠道排查。
// 只读 + 单文件输出：环境/版本/config(脱敏)/日志尾/审计尾/工作空间，凭证库只注明存在不读内容。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIO, style, C } from '../ui.js';
import { mingdaoHome, ensureHome, loadConfig } from '../config.js';
import { credentialsPath } from '../credentials.js';
import { listAudit, redactSecrets } from '../audit.js';
import { listWorkspaces } from '../workspace.js';
import { detectSandbox } from '../tools/bash.js';

// 更严格的脱敏：sk-/ghp_ token、key/token/secret/password=值、私网 IP、家目录路径
function redactSensitive(/** @type {any} */ text) {
  let s = redactSecrets(text);
  s = s.replace(/(ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, 'ghp_***');
  s = s.replace(/((?:api[_-]?key|token|secret|password|passwd|access_token)\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1***');
  s = s.replace(/\b(?:10|127)(?:\.\d{1,3}){3}\b|\b192\.168(?:\.\d{1,3}){2}\b|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/g, '[私网IP]');
  const home = os.homedir();
  if (home && home.length > 1) s = s.split(home).join('~');
  return s;
}

function tailFile(/** @type {any} */ file, /** @type {number} */ lines = 60) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.split('\n').filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

export async function handleDiagnose(/** @type {any} */ _cmd, /** @type {any} */ _args) {
  const io = createIO();
  try {
    ensureHome();
    const home = mingdaoHome();
    let version = '未知';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
      version = pkg.version || '未知';
    } catch {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(home, `diagnose-${stamp}.txt`);
    const L = /** @type {string[]} */ ([]);
    const push = (/** @type {string} */ s) => L.push(s);

    push('# MingDao Harness 诊断报告');
    push('生成时间：' + new Date().toISOString());
    push('');
    push('## 环境');
    push(`- 版本：${version}`);
    push(`- Node：${process.version} · 平台：${process.platform} · 架构：${process.arch}`);
    push(`- 系统：${os.type()} ${os.release()}`);
    push(`- 工作目录：${redactSensitive(process.cwd())}`);
    push(`- 沙箱（bubblewrap）：${detectSandbox()}`);

    push('');
    push('## 配置（config.json，已脱敏）');
    const cfg = loadConfig();
    push(cfg ? redactSensitive(JSON.stringify(cfg, null, 2)) : '（不存在或读取失败）');

    push('');
    push('## 凭证库');
    push(`${redactSensitive(credentialsPath())}：${fs.existsSync(credentialsPath()) ? '已存在（内容不打包）' : '无'}`);

    push('');
    push('## 服务端日志（logs/web-server.log 尾部 60 行）');
    const srvLog = tailFile(path.join(home, 'logs', 'web-server.log'), 60);
    push(srvLog ? redactSensitive(srvLog) : '（无日志）');

    push('');
    push('## 审计（最近 20 条，已脱敏）');
    const audits = listAudit(20);
    if (!audits.length) push('（无审计记录）');
    for (const a of audits) {
      push(redactSensitive(JSON.stringify(a)));
    }

    push('');
    push('## 工作空间');
    const wss = listWorkspaces();
    if (!wss.length) push('（未登记工作空间）');
    for (const w of wss) {
      push(`- ${w.name} → ${redactSensitive(w.dir || '')}`);
    }

    fs.writeFileSync(outFile, L.join('\n') + '\n');
    io.print(style(`✓ 诊断报告已生成：${outFile}`, C.green));
    io.print(style('请把该文件内容贴到反馈渠道排查；密钥/token/私网路径已脱敏。', C.dim));
  } catch (/** @type {any} */ err) {
    io.print(style('[错误] ' + (err?.message || err), C.red));
  } finally {
    io.close();
  }
  return true;
}
