// 符号链接**能力探测**（v0.10.1，v0.8.1 审计报告3 H-3）。
//
// 问题：非管理员 / 未开开发者模式的 Windows 上 `fs.symlinkSync()` 会抛 EPERM。此前
// `test/workspace-fence.js` 与 `test/event-parity.js` 直接调用它 → 整套红，而不是把
// 「本机没有这个能力」如实跳过。CI 的 Windows runner 有管理员权限能建链，开发机却红，
// 平台能力差异让套件结果不可信。
//
// 本模块把探测收敛成一处：
//   · `makeRealSymlink()`：建完必须 `lstat().isSymbolicLink()` **复核**——有些沙箱/受限账户
//     不抛错，却把建链请求静默降级成普通空文件；"没抛错"不等于"建出了链接"。
//   · `createLinkSupport()`：**惰性探测一次并记住结果**（首次失败后不再反复尝试）；
//     `supported()` 返回本机能力，`makeLink()` 在不支持时直接返回 false，
//     `skip()` 打印统一的「已跳过：本机不支持符号链接 —— 哪条用例」，绝不静默跳过。
//
// 探测与断言都可用注入的 `io`/`probe` 做单测（`test/link-support.js` 注入 EPERM 验证
// "返回不支持且只探测一次"，注入 264/受限形态验证降级识别）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 统一的跳过文案（套件里出现这一整句即可被 grep/审计辨认）。 */
export const LINK_UNSUPPORTED_NOTE = '已跳过：本机不支持符号链接';

/**
 * 建一条链接并复核产物**真的是**符号链接。
 *
 * @param {string} target @param {string} linkPath @param {'file'|'dir'|'junction'} [type]
 * @param {any} [io] fs 实现（默认 node:fs；单测可注入桩）
 * @returns {boolean}
 */
export function makeRealSymlink(target, linkPath, type = 'file', io = fs) {
  try {
    io.symlinkSync(target, linkPath, /** @type {any} */ (type));
    return io.lstatSync(linkPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 做一次**真实**能力探测：临时目录里建一条链接，返回本机能否建出真正的符号链接。
 * @param {{io?: any, tmpRoot?: string}} [opts]
 * @returns {boolean}
 */
export function probeSymlinkSupport({ io = fs, tmpRoot = os.tmpdir() } = {}) {
  /** @type {string|null} */
  let dir = null;
  try {
    dir = io.mkdtempSync(path.join(tmpRoot, 'mingdao-link-probe-'));
    const target = path.join(dir, 'target.txt');
    io.writeFileSync(target, 'x');
    return makeRealSymlink(target, path.join(dir, 'link'), 'file', io);
  } catch {
    return false;
  } finally {
    if (dir) {
      try {
        io.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 探测目录清不掉不影响结论 */
      }
    }
  }
}

/**
 * 惰性能力探测句柄。首次调用 `supported()`/`makeLink()` 时才真正探测，之后记住结果
 * （Windows 的 EPERM 每条用例都重试一遍没有意义，还会拖慢套件）。
 *
 * @param {{probe?: () => boolean, io?: any, log?: (...args:any[]) => void}} [opts]
 * @returns {{
 *   readonly attempts: number,
 *   readonly probed: boolean,
 *   supported: () => boolean,
 *   makeLink: (target: string, linkPath: string, type?: 'file'|'dir'|'junction') => boolean,
 *   skip: (what: string) => void,
 * }}
 */
export function createLinkSupport({ probe = () => probeSymlinkSupport(), io = fs, log = console.log } = {}) {
  let probed = false;
  let supported = false;
  let attempts = 0;
  const supportedNow = () => {
    if (!probed) {
      probed = true;
      attempts += 1;
      try {
        supported = probe() === true;
      } catch {
        supported = false;
      }
    }
    return supported;
  };
  return {
    get attempts() {
      return attempts;
    },
    get probed() {
      return probed;
    },
    supported: supportedNow,
    makeLink(target, linkPath, type = 'file') {
      if (!supportedNow()) return false;
      return makeRealSymlink(target, linkPath, type, io);
    },
    skip(what) {
      log(`  ⚠ ${LINK_UNSUPPORTED_NOTE} —— ${what}`);
    },
  };
}
