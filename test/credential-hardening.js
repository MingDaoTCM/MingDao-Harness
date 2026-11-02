// 凭据外泄加固回归（v0.6.29 安全批 B1/B2/B3）。
//
// 三条问题各自独立，但根因是同一个：**同一件事有多份口径，最弱的那份说了算**。
//   B1 跨源重定向剥凭据头：net-guard 已写对，safe-fetch 自己又写了一套"只跟不剥"；
//   B2 脱敏词表 / 子进程 env 名单：PGPASSWORD 只进了 env 侧，日志侧原样明文；
//   B3 账本"写入即脱敏"：逐叶子值执行，`{api_key:'…'}` 的键名与值被拆开 → 明文落盘。
//
// 本套件按**行为**断言为主；结构断言只用于证明"单一来源"本身（第二份名单必须扫得出来）。
//
// 运行：node test/credential-hardening.js

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
// 公开仓库不放密钥字面量：样例运行时拼装。
const FAKE = (/** @type {string} */ p, /** @type {number} */ n = 24) => p + 'x'.repeat(n);

let passed = 0;
function ok(/** @type {string} */ name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 起一个真实 HTTP 服务（随机端口，避免 CI 并发冲突）。 */
function listen(/** @type {any} */ handler) {
  return new Promise((/** @type {any} */ resolve, /** @type {any} */ reject) => {
    const srv = http.createServer(handler);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ srv, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

/** 捕获一次调用期间写往 stderr 的日志（"降级/跳转必须可见"的断言面）。 */
async function captureStderr(/** @type {() => Promise<any>} */ fn) {
  /** @type {string[]} */
  const chunks = [];
  const orig = process.stderr.write;
  // @ts-expect-error 测试替身：只关心文本
  process.stderr.write = (/** @type {any} */ c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    const value = await fn();
    return { value, logs: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

/** 去掉注释后再扫源码，避免注释里的历史名字被当成"第二份名单"。 */
function codeOnly(/** @type {string} */ src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

function walkJs(/** @type {string} */ dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJs(f));
    else if (e.name.endsWith('.js')) out.push(f);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// B1：跨源重定向必须剥凭据头；allowPrivate 只对首跳生效
// ─────────────────────────────────────────────────────────────────────────────
async function testB1() {
  const SF = await import(pathToFileURL(path.join(srcDir, 'safe-fetch.js')).href);
  const NG = await import(pathToFileURL(path.join(srcDir, 'net-guard.js')).href);
  const sfSrc = fs.readFileSync(path.join(srcDir, 'safe-fetch.js'), 'utf8');
  const VICTIM = FAKE('sk-', 32);

  // ① PoC 原场景：首跳 allowPrivate（本地模型端点），302 指向**另一个回环端口**。
  //    修复前：目标收到完整 `Authorization: Bearer sk-VICTIM…`；修复后：目标一次都没被请求。
  {
    /** @type {any} */ let stolen = null;
    let hits = 0;
    const B = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      hits += 1;
      stolen = { auth: req.headers['authorization'] ?? null, cookie: req.headers['cookie'] ?? null, apiKey: req.headers['x-api-key'] ?? null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"data":[]}');
    });
    const A = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      res.writeHead(302, { Location: `${B.base}/steal` });
      res.end();
    });
    try {
      const r = await SF.safeFetchText(`${A.base}/v1/models`, {
        allowPrivate: true,
        headers: { Authorization: `Bearer ${VICTIM}`, Cookie: 'session=abc', 'X-Api-Key': VICTIM },
      });
      assert.ok(r.error && /重定向目标被拒绝|内网|本机/.test(r.error), `B1 PoC：指向回环的重定向必须被拒，实际：${JSON.stringify(r)}`);
      assert.equal(hits, 0, 'B1 PoC：重定向目标不得收到任何请求（allowPrivate 只在首跳生效）');
      assert.equal(stolen?.auth ?? null, null, 'B1 PoC：重定向目标收到的 Authorization 必须是 null');
      assert.equal(stolen?.cookie ?? null, null, 'B1 PoC：重定向目标收到的 Cookie 必须是 null');
      ok('B1-① PoC：allowPrivate 首跳 → 302 到另一回环端口被拒，目标未收到 Authorization/Cookie');
    } finally {
      A.srv.close();
      B.srv.close();
    }
  }

  // ② 同源重定向：凭据必须**保留**（登录跳转/补斜杠是正常语义），且跳转日志可见。
  {
    /** @type {any} */ let seen = null;
    const S = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/next' });
        res.end();
        return;
      }
      seen = { auth: req.headers['authorization'] ?? null, cookie: req.headers['cookie'] ?? null };
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
    });
    try {
      const captured = await captureStderr(() =>
        SF.safeFetchText(`${S.base}/start`, { allowPrivate: true, headers: { Authorization: `Bearer ${VICTIM}`, Cookie: 'c=1' } })
      );
      assert.equal(captured.value.text, 'OK', `B1 同源：应正常取回，实际 ${JSON.stringify(captured.value)}`);
      assert.equal(seen?.auth, `Bearer ${VICTIM}`, 'B1 同源：Authorization 必须保留（跨源才剥）');
      assert.equal(seen?.cookie, 'c=1', 'B1 同源：Cookie 必须保留');
      ok('B1-② 同源重定向保留 Authorization/Cookie（跨源才剥）');
      assert.match(captured.logs, /重定向 1\/10/, 'B1：跳转链长度必须打到可见日志');
      assert.match(captured.logs, /重定向链结束：共 1 跳/, 'B1：重定向结束时应报告总跳数');
      ok('B1-③ 跳转次数（1/10）与链长（共 1 跳）都写进可见日志');
    } finally {
      S.srv.close();
    }
  }

  // ③ 首跳 allowPrivate，但重定向到**其它内网主机/云元数据** → 必须拒绝（不得沿链路透传）。
  {
    const A = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      res.writeHead(302, { Location: 'http://10.0.0.5:9/steal' });
      res.end();
    });
    const M = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    });
    try {
      const r1 = await SF.safeFetchText(`${A.base}/x`, { allowPrivate: true });
      assert.ok(r1.error && /重定向目标被拒绝/.test(r1.error) && /内网\/本机/.test(r1.error), `B1-④ 内网重定向必须被拒，实际：${JSON.stringify(r1)}`);
      ok('B1-④ 首跳 allowPrivate 不沿链路透传：302 到 10.0.0.5 被拒（内网）');
      const r2 = await SF.safeFetchText(`${M.base}/x`, { allowPrivate: true });
      assert.ok(r2.error && /重定向目标被拒绝/.test(r2.error) && /元数据/.test(r2.error), `B1-⑤ 元数据重定向必须被拒，实际：${JSON.stringify(r2)}`);
      ok('B1-⑤ 首跳 allowPrivate 不沿链路透传：302 到 169.254.169.254 被拒（云元数据）');
      
    } finally {
      A.srv.close();
      M.srv.close();
    }
  }

  // ④ 跨源/端口/协议降级的**唯一判定**：命中即按反向白名单裁头，同源原样保留。
  {
    const headers = {
      Authorization: `Bearer ${VICTIM}`,
      Cookie: 'a=b',
      'X-Api-Key': 'k-123456',
      'Proxy-Authorization': 'Basic zzz',
      Accept: 'application/json',
      'User-Agent': 'mingdao-test',
    };
    const cross = NG.prepareRedirectHeaders(headers, 'https://a.example/x', 'https://b.example/y');
    assert.equal(cross.strip, true, 'B1-④ 跨主机必须剥凭据头');
    assert.equal(cross.reason, 'host-change', 'B1-④ 跨主机的理由应为 host-change');
    const kept = new Headers(cross.headers);
    for (const h of ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']) {
      assert.equal(kept.get(h), null, `B1-④ 跨源后不得携带 ${h}`);
    }
    assert.equal(kept.get('accept'), 'application/json', 'B1-④ 无身份语义的头应保留（Accept）');
    assert.equal(kept.get('user-agent'), 'mingdao-test', 'B1-④ 无身份语义的头应保留（User-Agent）');

    const port = NG.redirectCredentialDecision('http://a.example:8080/x', 'http://a.example:9090/y');
    assert.deepEqual(port, { strip: true, reason: 'port-change' }, 'B1-④ 端口变化也算跨源');
    const down = NG.redirectCredentialDecision('https://a.example/x', 'http://a.example/y');
    assert.deepEqual(down, { strip: true, reason: 'protocol-downgrade' }, 'B1-④ https→http 降级必须剥凭据');
    const same = NG.redirectCredentialDecision('https://a.example/x', 'https://a.example/y');
    assert.deepEqual(same, { strip: false, reason: 'same-origin' }, 'B1-④ 同源不得剥凭据');
    assert.equal(NG.prepareRedirectHeaders(headers, 'https://a.example/x', 'https://a.example/y').headers, headers, 'B1-④ 同源应原样返回，不复制/裁剪');
    ok('B1-⑥ 跨主机重定向按反向白名单剥头：Authorization/Cookie/X-Api-Key/Proxy-Authorization 全剥，Accept/User-Agent 保留');
    ok('B1-⑦ 端口变化也算跨源（reason=port-change）');
    ok('B1-⑧ https→http 协议降级必须剥凭据（reason=protocol-downgrade）');
    ok('B1-⑨ 同源重定向不剥凭据（返回原 headers 对象）');
  }

  // ⑤ 默认跳数上限 = 10：跟随 10 次，第 11 次（即第 11 个响应仍是 3xx）中止。
  {
    let hits = 0;
    const S = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      hits += 1;
      res.writeHead(302, { Location: '/loop' });
      res.end();
    });
    try {
      const captured = await captureStderr(() => SF.safeFetchText(`${S.base}/loop`, { allowPrivate: true }));
      assert.ok(captured.value.error && /上限（10 跳）/.test(captured.value.error), `B1-⑤ 必须命中 10 跳上限，实际：${JSON.stringify(captured.value)}`);
      assert.equal(hits, 11, 'B1-⑤ 允许 10 次跳转（共 11 次请求），第 11 个重定向被中止');
      assert.match(captured.logs, /重定向 10\/10/, 'B1-⑤ 第 10 跳必须有可见日志');
      ok('B1-⑩ 重定向上限为 10 跳（跟随 10 次后中止），第 10 跳日志可见');
    } finally {
      S.srv.close();
      S.srv.closeAllConnections?.();
    }
  }

  // ⑥ 重定向到非 http(s) 仍拒绝（不能因为新增私网复检而丢掉这条）。
  {
    const S = await listen((/** @type {any} */ req, /** @type {any} */ res) => {
      res.writeHead(302, { Location: 'file:///etc/passwd' });
      res.end();
    });
    try {
      const r = await SF.safeFetchText(`${S.base}/x`, { allowPrivate: true });
      assert.ok(r.error && /非 http\(s\)/.test(r.error), `B1-⑪ 非 http(s) 重定向必须拒绝，实际：${JSON.stringify(r)}`);
      ok('B1-⑪ 重定向到 file:// 仍被拒（不会因逐跳复检丢失协议白名单）');
    } finally {
      S.srv.close();
    }
  }

  // ⑦ 结构：safe-fetch 不得再写第二套跟随/剥头逻辑；必须复用 net-guard 的判定。
  {
    assert.match(sfSrc, /prepareRedirectHeaders\(/, 'B1-⑫ safe-fetch 必须调用 net-guard.prepareRedirectHeaders（单一来源）');
    assert.match(sfSrc, /hop === 0 \|\| cur\.origin === firstOrigin/, 'B1-⑫ allowPrivate 必须限制在首跳/首跳同源');
    ok('B1-⑫ 结构：safe-fetch 复用 net-guard 判定，allowPrivate 限定首跳/首跳同源');
    assert.ok(!/redirect\s*:\s*['"]follow/.test(codeOnly(sfSrc)), 'B1-⑬ safe-fetch 不得退回自动跟随（redirect:follow）');
    assert.ok(!/proxy-authorization|['"]x-api-key['"]|['"]cookie['"]/i.test(codeOnly(sfSrc)), 'B1-⑬ safe-fetch 不得自建凭据头名单');
    ok('B1-⑬ 结构：不给 undici 自动跟随，也不在 safe-fetch 里自建凭据头名单');
    assert.match(sfSrc, /cur\.protocol === 'https:' && next\.protocol === 'http:'/, 'B1-⑭ 必须有 https→http 的降级分支');
    assert.match(sfSrc, /logRedirect\(`⚠ 协议降级/, 'B1-⑭ 协议降级必须写可见日志（不能静默降级）');
    ok('B1-⑭ 结构：https→http 降级分支存在且必须调用可见日志');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B2：敏感名 / 值形态单一来源（日志脱敏 + 子进程 env 名单同一份）
// ─────────────────────────────────────────────────────────────────────────────
async function testB2() {
  const R = await import(pathToFileURL(path.join(srcDir, 'redact.js')).href);
  const BASH = await import(pathToFileURL(path.join(srcDir, 'tools', 'bash.js')).href);

  // ① 核验报告 §5.1 的三条实测：PGPASSWORD / MY_CRED / 大写 SK- 都必须被掩码。
  const cases = [
    ['PGPASSWORD=hunter2hunter2', 'PGPASSWORD=***', 'PGPASSWORD（整词无下划线的凭据名）'],
    ['MY_CRED=plain-value-123', 'MY_CRED=***', 'MY_CRED（cred 段）'],
    [`SK-${'ABCDEFGHIJ'.repeat(3)}`, 'sk-***', '大写 SK- 前缀'],
    ['SSH_PASSPHRASE=super-secret-pass', 'SSH_PASSPHRASE=***', 'SSH_PASSPHRASE（passphrase 段）'],
    ['OPENAI_KEY=abcdef1234567890', 'OPENAI_KEY=***', 'OPENAI_KEY（key 段）'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIsecret1234567890', 'AWS_SECRET_ACCESS_KEY=***', 'AWS_SECRET_ACCESS_KEY（中间段）'],
    ['DATABASE_URL=postgres://user:pass@host/db', 'DATABASE_URL=***', 'DATABASE_URL（连接串 env 名单）'],
    ['MY_DATABASE_URL=postgres://u:p@host/db', 'MY_DATABASE_URL=***', 'MY_DATABASE_URL（连接串兜底）'],
    ['{"api_key": "plainsecretvalue123"}', '"api_key": "***"', 'JSON 引号键'],
  ];
  let caseNo = 0;
  for (const [line, expect, label] of cases) {
    caseNo += 1;
    const out = R.redactSecrets(line);
    assert.ok(!out.includes(line) || !/[A-Za-z0-9]{5,}/.test(line.slice(line.indexOf('=') + 1)), `B2：${label} 的值必须被掩码，实际：${out}`);
    assert.ok(out.includes(expect), `B2：${label} 掩码形态应为 ${expect}，实际：${out}`);
    ok(`B2-${String(caseNo).padStart(2, '0')} ${label} 被掩码为 ${expect}`);
  }

  // ② 值形态表本身：每行 sample 必须被本行规则认出（新增厂商漏配会当场红）。
  for (const row of R.SECRET_VALUE_PATTERNS) {
    const out = R.redactSecrets(`K=${row.sample} tail`);
    assert.ok(!out.includes(row.sample), `B2：前缀表 [${row.vendor}] 的 sample 必须被掩码`);
  }
  ok('B2-⑩ 值形态表（SECRET_VALUE_PATTERNS）逐行自洽，样例均被本行规则掩码');

  // ③ 子进程 env 判定：与脱敏器**同一个函数对象**（不是复制一份实现）。
  assert.equal(BASH.isSensitiveEnv, R.isSensitiveEnvName, 'B2：bash.isSensitiveEnv 必须就是 redact.isSensitiveEnvName（同一函数对象）');
  for (const name of ['PGPASSWORD', 'MY_CRED', 'SSH_PASSPHRASE', 'DATABASE_URL', 'MY_DATABASE_URL', 'OPENAI_KEY', 'ANTHROPIC_KEY', 'AWS_SECRET_ACCESS_KEY']) {
    assert.equal(BASH.isSensitiveEnv(name), true, `B2：${name} 必须被判为敏感 env`);
  }
  assert.equal(BASH.isSensitiveEnv('PATH'), false, 'B2：PATH 不得被误过滤');
  assert.equal(BASH.isSensitiveEnv('SSH_AUTH_SOCK'), false, 'B2：SSH_AUTH_SOCK 是连接句柄，显式放行');
  ok('B2-⑪ env 判定与脱敏器是同一个函数对象（bash.isSensitiveEnv === redact.isSensitiveEnvName）');
  ok('B2-⑫ PGPASSWORD/MY_CRED/SSH_PASSPHRASE/DATABASE_URL/MY_DATABASE_URL/OPENAI_KEY/ANTHROPIC_KEY/AWS_SECRET_ACCESS_KEY 全敏感；PATH/SSH_AUTH_SOCK 放行');

  // ④ 真正落到子进程环境：这些变量不得出现。
  {
    const names = ['PGPASSWORD', 'MY_CRED', 'DATABASE_URL', 'MY_DATABASE_URL', 'OPENAI_KEY'];
    /** @type {Map<string, string|undefined>} */
    const backup = new Map();
    for (const n of names) {
      backup.set(n, process.env[n]);
      process.env[n] = `secret-${n.toLowerCase()}`;
    }
    try {
      const env = BASH.buildChildEnv({ cfg: {} }, true);
      for (const n of names) assert.equal(env[n], undefined, `B2：${n} 不得出现在子进程 env（buildChildEnv）`);
    } finally {
      for (const [n, v] of backup) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
    ok('B2-⑬ buildChildEnv 实际剔除 PGPASSWORD/MY_CRED/DATABASE_URL/MY_DATABASE_URL/OPENAI_KEY');
  }

  // ⑤ 结构断言一：这四个消费方都从 redact.js（唯一来源）取，不得自建名单。
  const sources = {
    redact: fs.readFileSync(path.join(srcDir, 'redact.js'), 'utf8'),
    bash: fs.readFileSync(path.join(srcDir, 'tools', 'bash.js'), 'utf8'),
    credentials: fs.readFileSync(path.join(srcDir, 'credentials.js'), 'utf8'),
    ledger: fs.readFileSync(path.join(srcDir, 'ledger.js'), 'utf8'),
  };
  assert.match(sources.redact, /export const SENSITIVE_ENV_NAMES/, 'B2：唯一来源必须导出 SENSITIVE_ENV_NAMES');
  assert.match(sources.redact, /export const SECRET_VALUE_PATTERNS/, 'B2：唯一来源必须导出 SECRET_VALUE_PATTERNS');
  assert.match(sources.redact, /export function isSensitiveEnvName/, 'B2：唯一来源必须导出判定函数');
  // 名单项本身也要钉住：只断言"能掩 PGPASSWORD"会因两条规则互为备份而漏掉单侧删除。
  assert.ok(R.SENSITIVE_ENV_NAMES.has('PGPASSWORD'), 'B2：PGPASSWORD 必须在环境名单里（env 侧）');
  assert.ok(R.SENSITIVE_ENV_NAMES.has('DATABASE_URL'), 'B2：DATABASE_URL 必须在环境名单里（env 侧）');
  assert.ok(R.SECRET_NAME_SEGMENTS.has('pgpassword'), 'B2：PGPASSWORD 必须在脱敏词表里（日志侧）');
  assert.ok(R.SECRET_NAME_SEGMENTS.has('cred'), 'B2：MY_CRED 的 cred 段必须在脱敏词表里');
  assert.match(sources.bash, /isSensitiveEnvName/, 'B2：bash 必须从唯一来源导入判定');
  assert.ok(!/SENSITIVE_ENV_NAMES|SENSITIVE_ENV_CONN_URL|SENSITIVE_ENV_PAIR/.test(codeOnly(sources.bash)), 'B2：bash 不得再持有第二份 env 名单');
  assert.match(sources.credentials, /redactSecrets[^;]*from '\.\/redact\.js'/, 'B2：credentials 的值级脱敏必须复用同一套规则');
  assert.match(sources.ledger, /isSecretObjectKey[^;]*from '\.\/redact\.js'/, 'B2：ledger 的键名判定必须取用同一张表');
  ok('B2-⑭ 结构：redact.js 是唯一来源；bash 不再持有名单；credentials/ledger 均从它导入');

  // ⑥ 结构断言二：扫源码文本——任何文件都不得自建第二份敏感名名单。
  {
    /** @type {string[]} */
    const offenders = [];
    const banned = ['PGPASSWORD', 'DATABASE_URL', 'POSTGRES_URL', 'MYSQL_URL', 'REDIS_URL', 'SSH_PASSPHRASE'];
    for (const f of walkJs(srcDir)) {
      const rel = path.relative(srcDir, f).split(path.sep).join('/');
      if (rel === 'redact.js') continue; // 唯一来源本身
      const code = codeOnly(fs.readFileSync(f, 'utf8'));
      for (const name of banned) {
        // 只认真实出现在字符串字面量里的名单项；变量名/注释不算。
        if (new RegExp(`['"]${name}['"]`).test(code)) offenders.push(`${rel} → ${name}`);
      }
    }
    assert.deepEqual(offenders, [], `B2：不得自建第二份敏感名名单，实际：${offenders.join('；')}`);
    ok('B2-⑮ 结构：扫 src/**/*.js 未发现第二份敏感 env 名名单（仅 redact.js 允许持有）');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B3：账本结构感知脱敏（对象键名整值掩码 + 值级双保险 + 导出路径）
// ─────────────────────────────────────────────────────────────────────────────
async function testB3() {
  const L = await import(pathToFileURL(path.join(srcDir, 'ledger.js')).href);
  const PLAIN = 'plainsecretvalue123';

  // ① 审计 H-14 的原始复现对象。
  {
    const out = L.redactDeep({ api_key: PLAIN, password: 'hunter2', nested: { token: 'abcdef123456' } });
    assert.deepEqual(out, { api_key: '***', password: '***', nested: { token: '***' } }, `B3-① 键名命中必须整值掩码，实际：${JSON.stringify(out)}`);
    ok('B3-① redactDeep({api_key,password,nested.token}) 全部整值掩码（审计 H-14 原复现）');
  }

  // ② 键名归一：大小写、`-`/`_`、复合名（X-Api-Key）都要命中。
  {
    const input = { 'API-KEY': 'v1', apiKey: 'v2', apikey: 'v3', 'X-Api-Key': 'v4', private_key: 'v5', PRIVATEKEY: 'v6', Cookie: 'v7', Authorization: 'v8' };
    const out = L.redactDeep(input);
    for (const k of Object.keys(input)) assert.equal(out[k], '***', `B3-② 键名归一后 ${k} 必须被掩码`);
    ok('B3-② 键名归一：API-KEY/apiKey/apikey/X-Api-Key/private_key/PRIVATEKEY/Cookie/Authorization 全部命中');
  }

  // ③ 嵌套数组 / 对象值整棵掩码。
  {
    const out = L.redactDeep({ items: [{ credential: 'cred-123' }, { authorization: 'Bearer abc' }], credentials: { whatever: 'plain' } });
    assert.equal(out.items[0].credential, '***', 'B3-③ 数组内对象的键名同样要判');
    assert.equal(out.items[1].authorization, '***', 'B3-③ 数组内 authorization 同样要判');
    assert.equal(out.credentials, '***', 'B3-③ 命中键名时**整棵值**替换，不能只看内层有无害键');
    ok('B3-③ 嵌套数组与"值为对象"的凭据容器都被整值掩码');
  }

  // ④ 不得误伤：token 计量字段、模型名、计数必须原样保留（否则账本会变成"什么都看不见"）。
  {
    const input = { model: 'deepseek-v4-flash', count: 3, firstTokenMs: 42, usage: { prompt_tokens: 5, completion_tokens: 2 } };
    const out = L.redactDeep(input);
    assert.deepEqual(out, input, `B3-④ 非凭据字段不得被误掩，实际：${JSON.stringify(out)}`);
    ok('B3-④ 非凭据字段（model/count/firstTokenMs/usage.prompt_tokens）不被误掩');
  }

  // ⑤ 值级脱敏双保险：键名无害、但值里嵌着 `PGPASSWORD=…` 仍要掩。
  {
    const out = L.redactDeep({ note: 'PGPASSWORD=hunter2hunter2' });
    assert.ok(!out.note.includes('hunter2hunter2'), 'B3-⑤ 值级规则必须仍然生效（双保险）');
    ok('B3-⑤ 值级脱敏保留为第二道保险（键名无害时也能掩掉值内密钥）');
  }

  // ⑥ 写入路径：账本 *.jsonl 不得出现明文。
  const prevHome = process.env.MINGDAO_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-cred-hardening-'));
  process.env.MINGDAO_HOME = home;
  try {
    const runId = L.newRunId();
    const led = L.createLedger(runId);
    led.runStart({ model: 'test-model', session: 's.jsonl' });
    const line = led.toolCall({ name: 'mcp__x', args: { api_key: PLAIN, password: 'hunter2', headers: { Authorization: 'Bearer abcdef123456' } } });
    assert.ok(line && !line.includes(PLAIN), 'B3-⑥ 写入行不得包含 api_key 明文');
    assert.ok(line && !line.includes('hunter2'), 'B3-⑥ 写入行不得包含 password 明文');
    const raw = fs.readFileSync(path.join(L.ledgerDir(), `${runId}.jsonl`), 'utf8');
    assert.ok(!raw.includes(PLAIN) && !raw.includes('hunter2'), 'B3-⑥ 落盘账本不得包含明文');
    assert.ok(raw.includes('***'), 'B3-⑥ 落盘账本应保留掩码标记');
    ok('B3-⑥ 写入路径：tool.call 的 api_key/password/Authorization 明文不进 ledger/*.jsonl');

    // ⑦ 导出路径（json）：写入已脱敏 + 导出再跑一遍，双路径都不得回显明文。
    const exp = L.exportRun(runId, { format: 'json' });
    assert.ok(exp.ok, 'B3-⑦ 导出应成功');
    assert.ok(!exp.text.includes(PLAIN), 'B3-⑦ JSON 导出不得包含 api_key 明文');
    assert.ok(!exp.text.includes('hunter2'), 'B3-⑦ JSON 导出不得包含 password 明文');
    assert.ok(exp.text.includes('"api_key": "***"'), 'B3-⑦ JSON 导出应保留键并提供 *** 掩码');
    ok('B3-⑦ 导出路径（ledger export json）同样不出现明文，键名保留为 ***');
  } finally {
    process.env.MINGDAO_HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────
console.log('凭据外泄加固回归（B1 重定向凭据 / B2 单一来源 / B3 账本结构感知脱敏）');
await testB1();
await testB2();
await testB3();
console.log(`\ncredential-hardening：${passed} 组全部通过`);
process.exit(0);
