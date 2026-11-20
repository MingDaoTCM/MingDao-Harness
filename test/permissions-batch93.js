// v0.10.1 遗留安全批回归（v0.8.1 审计 H-1 / H-2 / H-3 + 自审 H-10）。
//
// 这四项在 v0.8.2 / 0.9.x / 0.10.0 都因"控制改动面"被延后（v0.8.1 报告「遗留未修」表连续两版点名）：
//   H-1 [高] 沙箱降级只在 note 里写一句，**权限确认/用户界面看不到"本次未隔离执行"**；
//   H-2 [高] 软 deny（auto 档唯一防线）大小写敏感、不认 `cmd /c` / `cmd.exe /C` / powershell -Command；
//   H-3 [高] WRAPPER_PREFIXES 缺 su/runuser/pkexec/chroot/nsenter 等——`pkexec rm -rf /`、
//            `su -c 'rm -rf /'`、`chroot /srv rm -rf /` 归一后 argv[0] 仍是包装器，deny 全部失配；
//   H-10[高] `POST /api/chat` 的 `permission=auto` 绕过无令牌权限闸门（本套件同时给出核实证据：
//            修复前该链路真的能把 auto 送进 createPermission）。
//
// 为什么单开一套：这三处修改横跨 permissions.js / tools/bash.js / web/server.js 三个文件，
// 且 H-3 需要**表驱动**（每个新前缀至少一条 deny 命中 + 一条不误伤）。独立套件可单独跑，
// 也是 test/mutate/batch93-security.mjs 的判定入口。
//
// 运行：node test/permissions-batch93.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);

let passed = 0;
/** @type {string[]} */
const failures = [];

/** @param {string} name */
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * 跑一条断言；失败**不中断**后面的用例（要一次看全所有红，变异批次才能按关键词判逃逸）。
 * @param {string} name
 * @param {() => any} fn
 */
async function check(/** @type {string} */ name, /** @type {() => any} */ fn) {
  try {
    await fn();
    ok(name);
  } catch (/** @type {any} */ e) {
    failures.push(`${name}：${String(e?.message || e)}`);
    console.log(`  ✗ ${name}：${String(e?.message || e)}`);
  }
}

const PERM = await load('permissions.js');
const BASH = await load('tools/bash.js');
const TOOLS = await load('tools/index.js');
const SERVER = await load('web/server.js');

/**
 * 软 deny 判据：mode=auto + deny 规则，**不**开 denyStrict——正是 v0.8.1 审计点名的那种
 * "auto 档下 deny 是唯一防线、一失配就零确认执行"的配置。
 */
const SOFT = { mode: 'auto', deny: ['bash:rm *'] };
/** @param {string} cmd @param {any} [cfg] */
const decide = (cmd, cfg = SOFT) => PERM.evaluatePermission(cfg, 'bash', { command: cmd }).decision;

// ─────────────────────────────────────────────────────────────────────────────
// A. H-3：提权型包装器前缀（每个新前缀都必须有「deny 规则仍命中真实命令」的用例）
// ─────────────────────────────────────────────────────────────────────────────
async function testWrapperPrefixes() {
  /** @type {[string, string][]} */
  const mustDeny = [
    // su：-c/--command 的值是一条命令串，必须再分词归一（引号里的命令同样要看穿）
    ["su -c 'rm -rf /'", 'su -c 的值必须按命令串再归一'],
    ["su root -c 'rm -rf /'", '用户名操作数在选项之前时 -c 的值同样必须归一'],
    ["su -s /bin/sh --command 'rm -rf /'", 'su 长选项 --command 与吃值的 -s 必须都正确处理'],
    // runuser：与 su 同族
    ["runuser -u www -c 'rm -rf /'", 'runuser -c 的值必须按命令串再归一'],
    ['runuser -u www -- rm -rf /', 'runuser 选项后的真命令必须归一'],
    // pkexec：命令是操作数；--user 吃值、--disable-internal-agent 不吃值
    ['pkexec rm -rf /', 'pkexec 后的 PROGRAM 必须归一'],
    ['pkexec --user root rm -rf /', 'pkexec --user 吃值后必须继续找到 PROGRAM'],
    ['pkexec --disable-internal-agent rm -rf /', 'pkexec 的无值选项不得吞掉 PROGRAM'],
    // chroot：NEWROOT 是操作数（skipOperand），COMMAND 及其后才是真命令
    ['chroot /srv rm -rf /', 'chroot 的 NEWROOT 是操作数，COMMAND 必须归一'],
    ['chroot --userspec=root:root /srv rm -rf /', 'chroot 的 --userspec 吃值、NEWROOT 仍要跳过'],
    // nsenter / unshare / capsh
    ['nsenter -t 123 rm -rf /', 'nsenter 选项后的 program 必须归一'],
    ['nsenter -t 123 -m /proc/1/ns/mnt rm -rf /', 'nsenter 可选参数带值时必须继续找到 program'],
    ['nsenter -t 1 -m rm -rf /', 'nsenter 可选参数不带值时不得吞掉 program（两条分支都要试）'],
    ['unshare -r rm -rf /', 'unshare 的无值开关后必须归一'],
    ['unshare --map-root-user rm -rf /', 'unshare 长选项后必须归一'],
    ["capsh --user=root -- -c 'rm -rf /'", 'capsh -- 之后的 -c 命令串必须归一'],
  ];
  let i = 0;
  for (const [cmd, why] of mustDeny) {
    i += 1;
    await check(`A-${String(i).padStart(2, '0')} 新前缀 deny 命中：${cmd}`, () => {
      assert.equal(decide(cmd), 'deny', `${why}；实际 ${decide(cmd)}（命令：${cmd}）`);
    });
  }

  // 归一化后必须真的取到"真命令"本身（而不是只因为整串里出现 rm 字样被字面命中）
  await check("A-17 canonicalizeCommand 取到真命令：su -c / chroot / pkexec", () => {
    const su = PERM.canonicalizeCommand("su -c 'rm -rf /'").map((c) => c.argv[0]);
    assert.ok(su.includes('rm'), `su -c 的命令串必须被拆成 argv[0]=rm：${JSON.stringify(su)}`);
    const chroot = PERM.canonicalizeCommand('chroot /srv rm -rf /').map((c) => c.argv[0]);
    assert.ok(chroot.includes('rm'), `chroot 必须跳过 NEWROOT 取到 rm：${JSON.stringify(chroot)}`);
    assert.ok(!chroot.includes('/srv'), `NEWROOT 不得被当成命令：${JSON.stringify(chroot)}`);
    const pkexec = PERM.canonicalizeCommand('pkexec --disable-internal-agent rm -rf /').map((c) => c.argv[0]);
    assert.ok(pkexec.includes('rm'), `pkexec 的无值选项不得吞掉 rm：${JSON.stringify(pkexec)}`);
    const capsh = PERM.canonicalizeCommand("capsh -- -c 'rm -rf /'").map((c) => c.argv[0]);
    assert.ok(capsh.includes('rm'), `capsh -- 之后的 -c 命令串必须被拆成 argv[0]=rm：${JSON.stringify(capsh)}`);
  });

  // 不得误伤：合法命令 / 引号里的字面量
  /** @type {[string, string][]} */
  const mustAllow = [
    ["su -c 'echo ok'", 'su 执行无害命令不得被 deny 误伤'],
    ['runuser -u www -- ls', 'runuser 执行无害命令不得被误伤'],
    ['pkexec echo hi', 'pkexec 执行无害命令不得被误伤'],
    ['pkexec --user root ls', 'pkexec --user 后接无害命令不得被误伤'],
    ['chroot /srv ls', 'chroot 执行无害命令不得被误伤'],
    ['nsenter -t 1 true', 'nsenter 执行无害命令不得被误伤'],
    ['unshare -r echo hi', 'unshare 执行无害命令不得被误伤'],
    ['capsh --print', 'capsh 只打印能力不得被误伤'],
    ["capsh --user=root -- -c 'id -u'", 'capsh 执行无害命令不得被误伤'],
    ['echo "su -c \'rm -rf /\'"', '引号内的字面量不是被执行的命令'],
  ];
  let j = 0;
  for (const [cmd, why] of mustAllow) {
    j += 1;
    await check(`A-${String(18 + j - 1).padStart(2, '0')} 不误伤：${cmd}`, () => {
      assert.equal(decide(cmd), 'allow', `${why}；实际 ${decide(cmd)}（命令：${cmd}）`);
    });
  }

  // denyStrict 下同样要命中（新前缀不得只在软 deny 生效）
  await check('A-28 denyStrict 下新前缀同样命中', () => {
    const strict = { mode: 'auto', deny: ['bash:rm *'], denyStrict: true };
    for (const cmd of ["su -c 'rm -rf /'", 'pkexec rm -rf /', 'chroot /srv rm -rf /', 'runuser -u www -- rm -rf /']) {
      assert.equal(PERM.evaluatePermission(strict, 'bash', { command: cmd }).decision, 'deny', `denyStrict 下必须命中：${cmd}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// B. H-2：软 deny 大小写不敏感 + Windows `cmd /c` / powershell -Command
// ─────────────────────────────────────────────────────────────────────────────
async function testSoftDenyWindowsShell() {
  /** @type {[string, string][]} */
  const mustDeny = [
    ['cmd /c "rm -rf /"', 'cmd /c 之后的命令串必须归一'],
    ['cmd /C "rm -rf /"', 'cmd /C 大写同样必须归一'],
    ['CMD /C "rm -rf /"', '命令名大写（Windows 不区分大小写）同样必须归一'],
    ['cmd.exe /c "rm -rf /"', 'cmd.exe 带扩展名同样必须归一'],
    ['cmd.exe /C rm -rf /', 'cmd.exe /C 未加引号同样必须归一'],
    ['cmd /d /s /c "rm -rf /"', '/c 之前的 /d /s 开关不得挡住归一化'],
    ['powershell -Command "rm -rf /"', 'powershell -Command（大小写不敏感）必须归一'],
    ['BASH -c "rm -rf /"', 'POSIX shell 名大写同样必须归一'],
    ["SH -lc 'rm -rf /'", 'POSIX shell 名大写 + 捆绑 -lc 同样必须归一'],
    ['RM -RF /', '字面 deny 匹配必须大小写不敏感（Windows 口径）'],
  ];
  let i = 0;
  for (const [cmd, why] of mustDeny) {
    i += 1;
    await check(`B-${String(i).padStart(2, '0')} 软 deny 命中：${cmd}`, () => {
      assert.equal(decide(cmd), 'deny', `${why}；实际 ${decide(cmd)}（命令：${cmd}）`);
    });
  }

  // 不得把普通命令误判为包装执行：只对 denyStrict 的"包装形态整体拒绝"才生效
  await check('B-11 cmd /c 执行无害命令不得被误伤', () => {
    for (const cmd of ['cmd /c "echo hi"', 'CMD /C echo hi', 'powershell -Command Get-Date', "BASH -c 'echo hi'"]) {
      assert.equal(decide(cmd), 'allow', `无害命令不得被误伤：${cmd}`);
    }
  });

  // denyStrict + 无关 deny 规则：cmd 的包装执行形态必须整体拒绝（SHELL_WRAPPER 补 cmd.exe / 前置开关）
  await check('B-12 denyStrict 下 cmd.exe /c 与 cmd /d /s /c 包装形态整体拒绝', () => {
    const strict = { mode: 'auto', deny: ['bash:reboot *'], denyStrict: true };
    for (const cmd of ['cmd /c "echo hi"', 'cmd.exe /C echo hi', 'cmd /d /s /c "echo hi"', 'powershell.exe -Command echo hi']) {
      const v = PERM.evaluatePermission(strict, 'bash', { command: cmd });
      assert.equal(v.decision, 'deny', `denyStrict 下包装执行形态必须整体拒绝：${cmd}`);
      assert.equal(v.reason, 'deny-strict-wrapper', `拒绝原因必须是包装形态：${cmd}（实际 ${v.reason}）`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C. H-1：bash 沙箱降级必须用户可见（stdout 首行 + note），正常路径不得出现
// ─────────────────────────────────────────────────────────────────────────────
async function testSandboxDisclosure() {
  await check('C-01 披露文案纯函数：降级时给出、正常时为空', () => {
    assert.equal(BASH.sandboxDegradedDisclosure('safe', 'off'), BASH.SANDBOX_DEGRADED_NOTICE, '请求 safe 但实际 off 必须披露');
    assert.ok(BASH.SANDBOX_DEGRADED_NOTICE.includes('未隔离执行'), '披露文案必须写明"未隔离执行"（用户看得懂）');
    assert.equal(BASH.sandboxDegradedDisclosure('readonly', 'off'), BASH.SANDBOX_DEGRADED_NOTICE, '请求 readonly 但实际 off 同样必须披露');
    assert.equal(BASH.sandboxDegradedDisclosure('off', 'off'), '', '本来就没请求沙箱不得出现披露');
    assert.equal(BASH.sandboxDegradedDisclosure('', 'off'), '', '空模式不得出现披露');
    assert.equal(BASH.sandboxDegradedDisclosure('safe', 'safe'), '', '沙箱真的生效时不得出现披露');
    assert.equal(BASH.sandboxDegradedDisclosure('readonly', 'readonly'), '', 'readonly 沙箱生效时不得出现披露');
  });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-sbx93-'));
  try {
    await check('C-02 沙箱不可用：结果 stdout 首行 + note 必须披露"未隔离执行"', async () => {
      // 用 `MINGDAO_SANDBOX=none` **强制**走"沙箱不可用"路径，不再按宿主能力分支。
      // 根因（v0.10.1 重打 tag 的直接原因之二）：旧写法按 `detectSandbox()==='bwrap'` 分叉，
      // 而 GitHub ubuntu runner 自带 bwrap → 降级路径在 CI 上永不执行 →
      // 变异⑧「删掉 stdout 披露」在 Linux 三腿静默逃逸（本机 macOS 无 bwrap，本地全中）。
      const prevInject = process.env.MINGDAO_SANDBOX;
      process.env.MINGDAO_SANDBOX = 'none';
      try {
        const r = await TOOLS.dispatch('bash', { command: 'echo sandbox-disclosure-probe' }, { cwd: tmp, cfg: { sandbox: 'safe' } });
        assert.equal(r.ok, true, `bash 应执行成功：${JSON.stringify(r).slice(0, 200)}`);
        assert.ok(String(r.stdout).includes('sandbox-disclosure-probe'), '命令本身必须真的执行');
        assert.equal(r.sandbox, 'off', '无 bwrap 时必须如实报告降级为 off');
        assert.ok(String(r.stdout).startsWith(BASH.SANDBOX_DEGRADED_NOTICE), `降级披露必须是 stdout 首行（用户可见），实际：${JSON.stringify(String(r.stdout).slice(0, 120))}`);
        assert.ok(String(r.note || '').includes('未隔离执行'), `note 必须同时带上披露（状态可查），实际：${JSON.stringify(r.note)}`);
      } finally {
        if (prevInject === undefined) delete process.env.MINGDAO_SANDBOX;
        else process.env.MINGDAO_SANDBOX = prevInject;
      }
    });

    await check('C-02b 反例：沙箱真的可用时不得出现降级披露（本机无 bwrap 时显式跳过）', async () => {
      // 与 C-02 配对的反例：环境支持沙箱时必须走"正常路径"，不出现任何降级噪音。
      // CI ubuntu（自带 bwrap）会真正执行这一支；macOS/无 bwrap 的机器显式跳过（不静默）。
      if (BASH.detectSandbox() !== 'bwrap') {
        console.log('  ⚠ 已跳过：本机沙箱不可用（需 Linux + bubblewrap）——C-02b 反例');
        return;
      }
      const r = await TOOLS.dispatch('bash', { command: 'echo sandbox-normal-probe' }, { cwd: tmp, cfg: { sandbox: 'safe' } });
      assert.equal(r.ok, true, `bash 应执行成功：${JSON.stringify(r).slice(0, 200)}`);
      assert.equal(r.sandbox, 'safe', '沙箱可用时 sandbox 状态必须是请求的 safe');
      assert.equal(String(r.stdout).includes('沙箱不可用'), false, '沙箱可用时不得出现降级披露');
      assert.equal(String(r.note || '').includes('沙箱不可用'), false, '沙箱可用时 note 不得出现降级披露');
    });

    await check('C-03 正常路径（未请求沙箱）不得出现降级披露', async () => {
      const r = await TOOLS.dispatch('bash', { command: 'echo plain-probe' }, { cwd: tmp, cfg: { sandbox: 'off' } });
      assert.equal(r.ok, true, 'bash 应执行成功');
      assert.ok(String(r.stdout).includes('plain-probe'), '命令输出必须保留');
      assert.equal(String(r.stdout).includes('沙箱不可用'), false, '未请求沙箱时不得出现"沙箱不可用"文案');
      assert.equal(r.note, undefined, '未请求沙箱时不得凭空产生 note');
    });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// D. H-10：/api/chat 的 permission=auto 不得绕过无令牌权限闸门
// ─────────────────────────────────────────────────────────────────────────────
/** 桩 provider：离线，只回一段文本（不触发工具循环）。 */
function makeStubProvider() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: '桩回复' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    });
  });
  return server;
}

async function testChatPermissionGate() {
  await check('D-01 纯函数：无令牌不得把请求体权限提升到 auto，有令牌/配置本来就 auto 才放行', () => {
    const reject = SERVER.chatPermissionBodyRejection({ explicit: 'auto', authEnabled: false, baselineMode: 'ask' });
    assert.ok(reject && reject.includes('令牌'), `无令牌 + 请求体 auto 必须拒绝并说明原因，实际：${JSON.stringify(reject)}`);
    assert.equal(SERVER.chatPermissionBodyRejection({ explicit: 'auto', authEnabled: true, baselineMode: 'ask' }), null, '有令牌时显式 auto 应放行');
    assert.equal(SERVER.chatPermissionBodyRejection({ explicit: 'auto', authEnabled: false, baselineMode: 'auto' }), null, 'config.json 本来就写 auto 时请求体 auto 不算提权');
    assert.equal(SERVER.chatPermissionBodyRejection({ explicit: 'readonly', authEnabled: false, baselineMode: 'ask' }), null, '收紧到 readonly 任何时候都允许');
    assert.equal(SERVER.chatPermissionBodyRejection({ explicit: 'ask', authEnabled: false, baselineMode: 'auto' }), null, '收紧到 ask 任何时候都允许');
    assert.equal(SERVER.chatPermissionBodyRejection({ explicit: 'bogus', authEnabled: false, baselineMode: 'ask' }), null, '非法值不是提权（由 resolveTurnPermission 忽略）');
  });

  await check('D-01b resolveTurnPermission：无令牌时显式 auto 不生效（回落 config），banner 必须说明原因', () => {
    const refused = SERVER.resolveTurnPermission({ explicit: 'auto', configPermission: 'ask', authEnabled: false });
    assert.equal(refused.mode, 'ask', `无令牌 + 显式 auto 必须回落 config 的 ask，实际 ${refused.mode}`);
    assert.equal(refused.source, 'config', `来源必须是 config（记录"这个值是谁定的"），实际 ${refused.source}`);
    assert.ok(refused.banner.includes('令牌'), `banner 必须说明被拒原因（否则用户以为 auto 生效了），实际：${refused.banner}`);
    const granted = SERVER.resolveTurnPermission({ explicit: 'auto', configPermission: 'ask', authEnabled: true });
    assert.equal(granted.mode, 'auto', '有令牌时显式 auto 必须生效');
    assert.equal(granted.source, 'webui', '有令牌时来源必须是 WebUI 显式选择');
    const fileAuto = SERVER.resolveTurnPermission({ explicit: 'auto', configPermission: 'auto', authEnabled: false });
    assert.equal(fileAuto.mode, 'auto', 'config.json 本来写 auto 时请求体 auto 不算提权（文件设置是已授权来源）');
  });

  const prevHome = process.env.MINGDAO_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-p93-'));
  process.env.MINGDAO_HOME = home;
  const stub = makeStubProvider();
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = /** @type {any} */ (stub.address()).port;
  const { saveConfig } = await load('config.js');
  saveConfig({
    provider: 'custom',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${stubPort}/v1`,
    permission: 'ask',
    autoTitle: false,
    maxRounds: 1,
    contextBudget: 32000,
  });
  fs.writeFileSync(path.join(home, 'credentials.json'), JSON.stringify({ custom: 'sk-test-' + 'y'.repeat(24) }), { mode: 0o600 });
  /** @type {any} */
  let srv = null;
  /** @type {any} */
  let srvAuth = null;
  try {
    srv = await SERVER.runWebServer({ host: '127.0.0.1', port: 0, authToken: null });
    const base = `http://127.0.0.1:${srv.address().port}`;
    /** 发一次 chat 并读完 SSE，返回原文（字符串便于按关键词断言）。 */
    const chat = async (/** @type {any} */ payload, /** @type {any} */ headers = {}) => {
      const resp = await fetch(base + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      return { status: resp.status, text: await resp.text() };
    };

    await check('D-02 无令牌：POST /api/chat {permission:"auto"} 不得提权（降级回落 + banner 说明）', async () => {
      const r = await chat({ message: '提升权限试试', permission: 'auto' });
      assert.equal(r.status, 200, `SSE 通道已建立（HTTP 200），实际 ${r.status}`);
      assert.ok(r.text.includes('"type":"done"'), `回合应正常跑完（被拒绝的是"提权"，不是整个对话），实际：${r.text.slice(0, 300)}`);
      assert.ok(r.text.includes('令牌'), `banner 必须说明"需要访问令牌"的原因，实际：${r.text.slice(0, 400)}`);
      assert.ok(r.text.includes('本会话权限：ask'), `无令牌时显式 auto 必须回落 config 的 ask（不得按 auto 跑），实际：${r.text.slice(0, 400)}`);
    });

    await check('D-03 无令牌：收紧到 readonly 的请求仍被接受（闸门只拦提权）', async () => {
      const r = await chat({ message: '只读跑一下', permission: 'readonly' });
      assert.equal(r.status, 200, 'SSE 通道应建立');
      assert.ok(!r.text.includes('不能通过 /api/chat 请求体把权限提升为 auto'), '收紧权限不得被 H-10 闸门误伤');
      assert.ok(r.text.includes('"type":"done"'), `收紧权限的回合应正常跑完，实际：${r.text.slice(0, 300)}`);
    });

    // 有令牌的对照：同样请求体 auto 应被接受（闸门不得过宽）
    srvAuth = await SERVER.runWebServer({ host: '127.0.0.1', port: 0, authToken: 'p93-token' });
    const baseAuth = `http://127.0.0.1:${srvAuth.address().port}`;
    await check('D-04 有令牌：请求体 permission=auto 仍被接受（闸门只针对无令牌本机信任模式）', async () => {
      const resp = await fetch(baseAuth + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MingDao-Token': 'p93-token' },
        body: JSON.stringify({ message: '有令牌选自动', permission: 'auto' }),
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      assert.equal(resp.status, 200, 'SSE 通道应建立');
      assert.ok(!text.includes('不能通过 /api/chat 请求体把权限提升为 auto'), `有令牌时不得再拒绝提权，实际：${text.slice(0, 300)}`);
      assert.ok(text.includes('"type":"done"'), `有令牌的 auto 回合应正常跑完，实际：${text.slice(0, 300)}`);
      assert.ok(text.includes('本会话权限：auto') && text.includes('来源：WebUI 显式选择'), `有令牌时显式 auto 必须真的生效（banner 档位/来源），实际：${text.slice(0, 400)}`);
    });
  } finally {
    for (const s of [srv, srvAuth]) {
      try {
        if (s) await new Promise((r) => s.close(r));
      } catch {}
    }
    stub.closeAllConnections?.();
    await new Promise((r) => stub.close(r)).catch(() => {});
    if (prevHome === undefined) delete process.env.MINGDAO_HOME;
    else process.env.MINGDAO_HOME = prevHome;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
for (const [name, fn] of /** @type {[string, () => Promise<void>][]} */ ([
  ['A 提权型包装器前缀', testWrapperPrefixes],
  ['B 软 deny 大小写 / cmd /c', testSoftDenyWindowsShell],
  ['C 沙箱降级披露', testSandboxDisclosure],
  ['D /api/chat 权限提权闸门', testChatPermissionGate],
])) {
  console.log(`\n[${name}]`);
  await fn();
}

if (failures.length) {
  console.error(`\n✗ permissions-batch93 失败 ${failures.length} 条：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\npermissions-batch93：${passed} 组/条断言全部通过`);
}
