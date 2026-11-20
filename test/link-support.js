// 符号链接能力探测 helper 自身的单测（v0.10.1，v0.8.1 审计报告3 H-3）。
//
// 守卫必须有守卫：如果探测本身写错，`workspace-fence` / `event-parity` 要么重新在
// Windows 上崩（探测没兜住 EPERM），要么把符号链接用例**静默全跳过**（把"不支持"当成
// "通过"）。本套件用注入桩把两种坏形态都钉住：
//   ① EPERM → 返回"不支持"，且**只探测一次**（后续 supported() 不再重试）；
//   ② 不抛错但产物是普通文件（沙箱/受限账户的降级形态）→ 也必须判"不支持"；
//   ③ 真能建链 → 判"支持"（否则所有软链用例会被无条件跳过，覆盖悄悄归零）；
//   ④ 跳过提示必须含统一文案「已跳过：本机不支持符号链接」，不得静默。
//
// 运行：node test/link-support.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LINK_UNSUPPORTED_NOTE, createLinkSupport, makeRealSymlink, probeSymlinkSupport } from './_link-support.js';

/** @param {string} name */
let passed = 0;
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

// ---------------------------------------------------------------------------
// ① makeRealSymlink：成功 / EPERM / "没抛错但降级成普通文件" / 建链路径不存在
// ---------------------------------------------------------------------------
{
  const ioReal = { symlinkSync: () => {}, lstatSync: () => ({ isSymbolicLink: () => true }) };
  assert.equal(makeRealSymlink('/t', '/l', 'file', ioReal), true, '真建成时必须返回 true（否则软链用例会被无条件跳过）');
  const ioDegraded = { symlinkSync: () => {}, lstatSync: () => ({ isSymbolicLink: () => false }) };
  assert.equal(makeRealSymlink('/t', '/l', 'file', ioDegraded), false, '不抛错但产物是普通文件时必须判失败（评估 §4.1 的降级形态）');
  const eperm = /** @type {any} */ (new Error('EPERM: operation not permitted, symlink'));
  eperm.code = 'EPERM';
  const ioEperm = { symlinkSync: () => { throw eperm; }, lstatSync: () => ({ isSymbolicLink: () => true }) };
  assert.equal(makeRealSymlink('/t', '/l', 'file', ioEperm), false, 'EPERM（Windows 非管理员常见形态）必须返回 false 而不是抛错');
  ok('① makeRealSymlink：成功 true / 降级 false / EPERM false');
}

// ---------------------------------------------------------------------------
// ② probeSymlinkSupport：完整桩 io 下，EPERM → false；正常 → true；临时目录必须清理
// ---------------------------------------------------------------------------
{
  const mkProbeIo = (/** @type {boolean} */ canLink) => {
    const calls = { rm: 0 };
    return {
      calls,
      mkdtempSync: () => '/tmp/mingdao-link-probe-stub',
      writeFileSync: () => {},
      rmSync: () => {
        calls.rm += 1;
      },
      symlinkSync: () => {
        if (!canLink) {
          const e = /** @type {any} */ (new Error('EPERM: operation not permitted, symlink'));
          e.code = 'EPERM';
          throw e;
        }
      },
      lstatSync: () => ({ isSymbolicLink: () => canLink }),
    };
  };
  const ioBad = mkProbeIo(false);
  assert.equal(probeSymlinkSupport({ io: ioBad }), false, '桩 io 注入 EPERM 时探测必须返回 false');
  assert.equal(ioBad.calls.rm, 1, '探测失败也必须清理临时目录（finally）');
  const ioGood = mkProbeIo(true);
  assert.equal(probeSymlinkSupport({ io: ioGood }), true, '桩 io 能建链时必须返回 true');
  ok('② probeSymlinkSupport：EPERM false / 正常 true / 临时目录必清理');
}

// ---------------------------------------------------------------------------
// ③ createLinkSupport：EPERM → 不支持、只探测一次、makeLink 不再尝试建链、skip 打印统一文案
// ---------------------------------------------------------------------------
{
  let probes = 0;
  let symlinkCalls = 0;
  const logs = [];
  const io = {
    symlinkSync: () => {
      symlinkCalls += 1;
    },
    lstatSync: () => ({ isSymbolicLink: () => true }),
  };
  const links = createLinkSupport({
    probe: () => {
      probes += 1;
      const e = /** @type {any} */ (new Error('EPERM: operation not permitted, symlink'));
      e.code = 'EPERM';
      throw e;
    },
    io,
    log: (...args) => logs.push(args.join(' ')),
  });
  assert.equal(links.supported(), false, '注入 EPERM 后 supported() 必须返回 false');
  assert.equal(links.attempts, 1, '首次探测必须只记录 1 次尝试');
  for (let i = 0; i < 5; i += 1) assert.equal(links.supported(), false, '重复询问必须仍返回 false');
  assert.equal(probes, 1, '能力探测必须**只探测一次**（首次失败后记住本机不支持）');
  assert.equal(links.makeLink('/t', '/l'), false, '不支持时 makeLink 必须直接 false');
  assert.equal(symlinkCalls, 0, '不支持时不得再调用 fs.symlinkSync（避免每条用例重复踩 EPERM）');
  links.skip('W11 符号链接逃逸');
  assert.equal(logs.length, 1, 'skip 必须打印且只打印一次');
  assert.ok(logs[0].includes(LINK_UNSUPPORTED_NOTE), `skip 必须含统一文案「${LINK_UNSUPPORTED_NOTE}」，实际：${logs[0]}`);
  assert.ok(logs[0].includes('W11 符号链接逃逸'), 'skip 必须点名被跳过的用例');
  ok('③ EPERM：不支持且只探测一次；makeLink 不再尝试；skip 打印统一文案');
}

// ---------------------------------------------------------------------------
// ④ createLinkSupport：支持时 makeLink 真正建链（真 tmp 目录）；失败不重复探测
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-link-unit-'));
  try {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'x');
    let probes = 0;
    const links = createLinkSupport({
      probe: () => {
        probes += 1;
        return true;
      },
    });
    assert.equal(links.supported(), true, 'probe 返回 true 时必须判支持');
    const link = path.join(dir, 'link.txt');
    assert.equal(links.makeLink(target, link, 'file'), true, '支持时 makeLink 必须真的建出符号链接');
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'makeLink 成功后产物必须是符号链接');
    // 具体某条链接建不出来（父目录不存在）→ false，但不能把本机能力改判为不支持、也不重复探测。
    assert.equal(links.makeLink(target, path.join(dir, 'no-such-dir', 'l'), 'file'), false, '建链失败必须返回 false 而不是抛错');
    assert.equal(probes, 1, '单条建链失败不得触发重新探测能力');
    ok('④ 支持时真的建链；单条失败不重复探测');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// ⑤ 真实环境探测：能建链的机器必须 true（不能因为加了探测把正常用例也跳过）；
//    建不出的机器（Windows 非管理员等）打印统一跳过文案，套件保持绿而不是红。
// ---------------------------------------------------------------------------
{
  const supported = probeSymlinkSupport();
  if (!supported) {
    console.log(`  ⚠ ${LINK_UNSUPPORTED_NOTE} —— 真实机能力探测（本环境建不出符号链接；依赖软链的用例会显式跳过）`);
  } else {
    assert.equal(supported, true, '本机能建链时真实探测必须返回 true');
  }
  ok('⑤ 真实机探测：能建链 → true；建不出 → 明确跳过文案（套件不红）');
}

console.log(`\nlink-support：${passed} 项通过`);
