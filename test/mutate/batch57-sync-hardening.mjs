// 批五十七（v0.6.29 §3.97：同步服务加固 H-02 / H-03 / M-01 / M-02 / M-14）的变异验证。
//
// 四条修复各自的关键点全部改回缺陷，`test/sync-hardening.js` 必须当场红：
//   H-02 损坏当空库 / 所有读错误都初始化 / schema 校验被跳过 / 不备份 / 备份覆盖 / 原件被 rename 走；
//   H-03 配对不核 credentialVersion / 改密不核预期版本；
//   M-01 URL 解析移出 try / 畸形目标不写响应；
//   M-02 账号桶退回 IP+账号 / 账号预检被短路 / 成功认证不清零；
//   M-14 默认监听退回 0.0.0.0 / 注册默认退回 open / 回环首启引导被删。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeMutator } from './lib.mjs';
const M = makeMutator();
const RUN = () => M.suite('test/sync-hardening.js');

// ① H-02：JSON 解析失败退回空对象（"损坏当空库"的原缺陷）
M.mutate({
  name: '① 损坏 JSON 被当成空库（解析失败 return {}）',
  file: 'src/sync-server.js',
  from: `  } catch (/** @type {any} */ err) {
    throw new StateCorruptError(file, \`JSON 解析失败：\${err?.message || err}\`);
  }`,
  to: `  } catch (/** @type {any} */ err) {
    return {};
  }`,
  expect: ['写接口必须失败'],
  run: RUN,
});

// ② H-02：把 ENOENT 与其他读取错误混为一谈（权限错误也初始化）
//
// Windows 上**不可验证**：套件构造「非 ENOENT 读失败」的夹具是 000 权限，而 Windows 的 chmod
// 只切换只读属性、不阻止读取（套件 §H-02 权限用例本身已按平台能力跳过）。没有观测面就不该
// 让这条变异在 Windows 上"逃逸"、把整条腿染红——如实跳过并打印原因。
/**
 * 「000 权限 ⇒ 读失败」这个夹具是**平台与身份相关**的：
 *  - Windows：chmod 只切只读属性，不阻止读取；
 *  - root（容器/CI 常见）：chmod 000 对 root 无效，照样能读。
 * 旧版只按 `process.platform === 'win32'` 跳过 → 在 root 容器里会**静默地把这条变异算成
 * "没被抓到"**（第三方核验报告 N-18：root 逃逸）。
 * 现在改为**能力探测**：真的造一个 000 目录试读，读得到就显式跳过并打印原因（不是静默通过）。
 */
function canConstructPermissionFailure() {
  if (process.platform === 'win32') return { ok: false, why: 'Windows 无 000 权限语义' };
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-probe-'));
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '{"a":1}');
    fs.chmodSync(dir, 0o000);
    let readable = false;
    try { fs.readFileSync(path.join(dir, 'x.json'), 'utf8'); readable = true; } catch { readable = false; }
    return readable ? { ok: false, why: '当前身份（root？）下 chmod 000 不阻止读取' } : { ok: true, why: '' };
  } catch (e) {
    return { ok: false, why: `探测失败：${String(e?.message || e)}` };
  } finally {
    if (dir) { try { fs.chmodSync(dir, 0o700); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}

const mutateUnlessUnconstructible = (m) => {
  const probe = canConstructPermissionFailure();
  if (!probe.ok) {
    console.log(`⚠ 跳过：${m.name}（${probe.why}；构造不出"非 ENOENT 读失败"，套件同一用例亦跳过）`);
    return;
  }
  M.mutate(m);
};

mutateUnlessUnconstructible({
  name: '② 只有 ENOENT 可初始化的约束被放宽（任何读失败 return {}）',
  file: 'src/sync-server.js',
  from: `    if (err && err.code === 'ENOENT') return {};`,
  to: `    if (err) return {};`,
  expect: ['写接口必须失败'],
  run: RUN,
});

// ③ H-02：读侧最小 schema 校验被整段跳过（数组/字段类型错误不再拒绝）
M.mutate({
  name: '③ 读侧 schema 校验被跳过（validateState 结果丢弃）',
  file: 'src/sync-server.js',
  from: `  const bad = validateState(kind, data);
  if (bad) throw new StateCorruptError(file, bad);
  return data;`,
  to: `  const bad = null;
  if (bad) throw new StateCorruptError(file, bad);
  return data;`,
  expect: ['users schema：配对必须 500'],
  run: RUN,
});

// ④ H-02：损坏时不备份（原文件虽保留，但没有可恢复的快照）
M.mutate({
  name: '④ 损坏状态不做备份',
  file: 'src/sync-server.js',
  from: `  const backup = quarantineStateFile(err.file, err.reason);`,
  to: `  const backup = null;`,
  expect: ['必须留下不重名备份'],
  run: RUN,
});

// ⑤ H-02：备份用 rename（原件从原路径消失，等于被"备份"覆盖掉）
M.mutate({
  name: '⑤ 备份改为 rename（原件被移走）',
  file: 'src/sync-server.js',
  from: `    fs.copyFileSync(file, dest);`,
  to: `    fs.renameSync(file, dest);`,
  expect: ['ENOENT'],
  run: RUN,
});

// ⑥ H-02：备份不再避让同名（同一秒的第二次损坏覆盖第一份备份）
M.mutate({
  name: '⑥ 备份不重名保证被删（后一份覆盖前一份）',
  file: 'src/sync-server.js',
  from: `  for (let k = 1; fs.existsSync(dest); k += 1) dest = \`\${file}.corrupt-\${stamp}-\${k}\`;`,
  to: `  for (let k = 1; false; k += 1) dest = \`\${file}.corrupt-\${stamp}-\${k}\`;`,
  expect: ['两次不同损坏必须有两份备份'],
  run: RUN,
});

// ⑦ H-03：配对入锁后不再核对 credentialVersion（竞态配对重新可用）
M.mutate({
  name: '⑦ doPair 去掉 credentialVersion 核对',
  file: 'src/sync-server.js',
  from: `    if ((uNow.credentialVersion || 0) !== expectedVersion) {
      return { unauthorized: '密码已变更，请用新密码重新配对' };
    }`,
  to: `    if (false) {
      return { unauthorized: '密码已变更，请用新密码重新配对' };
    }`,
  expect: ['竞态配对必须被拒'],
  run: RUN,
});

// ⑧ H-03：改密入锁后不核对预期旧版本（两个并发改密都能成功）
M.mutate({
  name: '⑧ doChangePassword 去掉预期版本核对',
  file: 'src/sync-server.js',
  from: `    if ((u.credentialVersion || 0) !== expectedVersion) {
      return { conflict: '密码已被其他请求修改，请用最新密码重试' };
    }`,
  to: `    if (false) {
      return { conflict: '密码已被其他请求修改，请用最新密码重试' };
    }`,
  expect: ['并发改密必须一个 200、一个 409'],
  run: RUN,
});

// ⑨ M-01：URL 解析移出 try（畸形目标落到外层 → 500，而不是 400）
M.mutate({
  name: '⑨ URL 解析移出 try（畸形目标变成 500）',
  file: 'src/sync-server.js',
  from: `    /** @type {URL} */
    let u;
    try {
      u = parseRequestTarget(req.url); // v0.6.29 M-01：URL 解析收在 try 内
    } catch {
      return rejectRequestTarget(req, res);
    }
    p = u.pathname;`,
  to: `    /** @type {URL} */
    const u = parseRequestTarget(req.url);
    p = u.pathname;`,
  expect: ['必须回 400'],
  run: RUN,
});

// ⑩ M-01：畸形目标不写响应（连接悬挂）
M.mutate({
  name: '⑩ 畸形 request-target 不写响应（连接悬挂）',
  file: 'src/sync-server.js',
  from: `    return json(res, 400, { error: '非法请求目标（request-target 无法解析）' });`,
  to: `    return undefined;`,
  expect: ['不得悬挂'],
  run: RUN,
});

// ⑪ M-02：账号桶键重新带上 IP（跨 IP 即可重置配额）
M.mutate({
  name: '⑪ 账号桶退回 IP+账号（跨 IP 重置配额）',
  file: 'src/sync-server.js',
  from: `      const acct = normalizeAccount(body.username);
      // M-02：账号桶跨 IP 共享、只累计失败并退避。命中即拒（不进入 scrypt，省 CPU 也防爆破）。
      const acctWait = accountWaitMs('/api/pair', acct);`,
  to: `      const acct = normalizeAccount(body.username) + '@' + clientIp(req);
      const acctWait = accountWaitMs('/api/pair', acct);`,
  expect: ['第 6 次必须 429'],
  run: RUN,
});

// ⑫ M-02：账号预检被短路（账号桶只记账不拒绝）
M.mutate({
  name: '⑫ 账号桶预检被短路（只记账不拒绝）',
  file: 'src/sync-server.js',
  from: `      const acctWait = accountWaitMs('/api/pair', acct);
      if (acctWait) return json(res, 429, { error: '该账号尝试过于频繁，请稍后再试', retryAfterMs: acctWait });`,
  to: `      const acctWait = 0;
      if (acctWait) return json(res, 429, { error: '该账号尝试过于频繁，请稍后再试', retryAfterMs: acctWait });`,
  expect: ['第 6 次必须 429'],
  run: RUN,
});

// ⑬ M-02：成功认证不清零账号桶（正常用户被历史失败拖累）
M.mutate({
  name: '⑬ 成功认证后不清零账号桶',
  file: 'src/sync-server.js',
  from: `      if (r.ok) resetAccount('/api/pair', acct);`,
  to: `      if (false) resetAccount('/api/pair', acct);`,
  expect: ['成功认证后账号桶必须清零'],
  run: RUN,
});

// ⑭ M-14：默认监听退回 0.0.0.0（未配置就暴露到所有网卡）
M.mutate({
  name: '⑭ 默认监听地址退回 0.0.0.0',
  file: 'src/sync-server.js',
  from: `const HOST = process.env.SYNC_HOST || '127.0.0.1';`,
  to: `const HOST = process.env.SYNC_HOST || '0.0.0.0';`,
  expect: ['默认监听地址必须是 127.0.0.1'],
  run: RUN,
});

// ⑮ M-14：注册默认退回 open（自助注册重新默认开放）
M.mutate({
  name: '⑮ 注册默认退回 open',
  file: 'src/sync-server.js',
  from: `const REGISTRATION = String(REGISTRATION_ENV || 'closed').trim().toLowerCase();`,
  to: `const REGISTRATION = String(REGISTRATION_ENV || 'open').trim().toLowerCase();`,
  expect: ['非回环绑定默认必须拒绝注册'],
  run: RUN,
});

// ⑯ M-14：本机首启的**显式**引导被删（默认 closed 后本机自建直接锁死）
// v0.6.30（N-10）：引导不再从请求推断回环来源，而是 MINGDAO_SYNC_ALLOW_LOOPBACK_REGISTRATION=1
// + 本机直连；这里把整条显式放行路径删掉，套件的「显式允许后应 200」必须当场红。
M.mutate({
  name: '⑯ 删除显式「本机直连自助注册」引导',
  file: 'src/sync-server.js',
  from: `  if (REGISTRATION_AUTO && ALLOW_LOOPBACK_REGISTRATION && isDirectLoopback(req)) return 'open';`,
  to: `  if (false) return 'open';`,
  expect: ['显式 ALLOW_LOOPBACK_REGISTRATION=1 时本机直连应可注册'],
  run: RUN,
});

if (!M.report()) process.exit(1);
