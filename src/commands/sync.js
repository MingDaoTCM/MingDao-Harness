// 命令族：mingdao sync（自 cli.js 拆出，评估 P0-1 拆包）
import readline from 'node:readline';
import {
  syncStatus,
  syncLogin,
  syncLogout,
  syncPush,
  syncPull,
  syncRemoteList,
  syncChangePassword,
  syncShareCreate,
  syncShareList,
  syncShareAccept,
  syncShareRevoke,
  listSyncConflicts,
  resolveSyncConflict,
} from '../sync.js';

/**
 * 隐藏输入提问器：**一个实例共用一个 readline 接口**，可连续问多题。
 *
 * 为什么不能每题各建一个接口（v0.6.2 实测踩到）：`rl.close()` 会连带丢掉 stdin 上
 * 还没被读走的数据。于是「旧密码 → 新密码 → 再输一次」这种连续提问在**管道输入**下
 * 第二问就拿不到数据：进程静默退出、输出为空，退出码却是 0
 * （e2e 实测 `{code:0, out:"", err:""}`——最坏的一种失败：看起来成功，其实什么都没做）。
 *
 * 用法：`const ask = createHiddenAsker(); try { … await ask.ask('…') … } finally { ask.close(); }`
 */
function createHiddenAsker() {
  // _writeToOutput 为 readline 内部接口：静音**回显**（密码输入），类型护栏下显式 any
  const rl = /** @type {any} */ (readline.createInterface({ input: process.stdin, output: process.stdout }));
  const orig = rl._writeToOutput;
  rl._writeToOutput = () => {};
  // 自己挂常驻 'line' 监听并入队：**不能**逐题 rl.question()。
  // 非 TTY（管道/CI）下 readline 只在「有挂起问题」时才把行交给回调——
  // 两问之间哪怕只有一个微任务间隙，下一行也会在无人接收时被丢掉：
  // 表现为第一问答上了、第二问永远等不到，进程静默退出且退出码 0
  // （e2e 实测 {code:0, out:"", err:""}，是"看起来成功其实什么都没做"的最坏形态）。
  const queue = /** @type {string[]} */ ([]);
  const waiters = /** @type {((v: string) => void)[]} */ ([]);
  rl.on('line', (/** @type {any} */ line) => {
    const v = String(line ?? '').trim();
    const w = waiters.shift();
    if (w) w(v);
    else queue.push(v);
  });
  return {
    /** @param {string} question */
    ask(question) {
      // 提示语自己 write：静音 _writeToOutput 是为了不回显输入，但它同时也吞掉了提示语
      // （Node 的 question() 走同一个出口），于是用户此前看不到「密码：」这类提示。
      try {
        process.stdout.write(question);
      } catch {}
      if (queue.length) return Promise.resolve(/** @type {string} */ (queue.shift()));
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() {
      if (typeof orig === 'function') rl._writeToOutput = orig;
      rl.close();
    },
  };
}

/** 单问便捷包装（登录等只用一次的场景） */
async function askHidden(/** @type {any} */ question) {
  const ask = createHiddenAsker();
  try {
    return await ask.ask(question);
  } finally {
    ask.close();
  }
}

export async function handleSync(/** @type {any} */ cmd, /** @type {any} */ args) {
  const sub = args[0] || 'status';
  if (sub === 'login') {
    const username = args[1];
    if (!username) {
      console.log('用法：mingdao sync login <用户名> [服务器地址] [--insecure]（密码将隐藏输入，绝不走命令行参数）');
      process.exitCode = 1;
      return true;
    }
    // 质检 A2：密码绝不接受位置参数（明文出现在 ps/shell history）——隐藏输入或 stdin 单行
    if (args[2] && !String(args[2]).startsWith('http')) {
      console.log('[错误] 出于安全考虑，密码不再支持命令行参数——运行 mingdao sync login <用户名> <地址> 后按提示隐藏输入。');
      process.exitCode = 1;
      return true;
    }
    const s0 = syncStatus();
    const url = args[2] && String(args[2]).startsWith('http') ? args[2] : s0.url;
    if (!url) {
      console.log('缺少服务器地址：mingdao sync login <用户名> <http(s)://地址>');
      process.exitCode = 1;
      return true;
    }
    const insecureFlag = args.includes('--insecure');
    let password = await askHidden('密码（至少 8 位）：');
    if (!password) {
      console.log('[错误] 未输入密码');
      process.exitCode = 1;
      return true;
    }
    const r = await syncLogin({ url, username, password, deviceName: undefined, insecure: insecureFlag });
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    if (insecureFlag) {
      console.log('  已启用 insecure（跳过证书校验，正式证书就绪后请在 config.sync 删除 insecure 字段）');
    }
    console.log(`✓ 已登录 ${r.username}（设备 ${r.deviceName}）→ ${r.url}`);
    console.log('  推送：mingdao sync push · 拉取：mingdao sync pull · 会话结束自动同步（config.sync.auto）');
    return true;
  }
  if (sub === 'logout') {
    syncLogout();
    console.log('✓ 已退出同步（配置保留，凭证已清除）');
    return true;
  }
  if (sub === 'passwd') {
    // P2-6（第三方审计）：新密码**绝不接受位置参数**。
    // 位置参数会让明文出现在 ps aux / shell history / CI 日志里——而同文件的
    // `sync login` 早已明确拒绝这种做法（上面那条质检 A2）。同一文件两套口径本身就是缺陷，
    // 这里对齐为「只走隐藏输入」。以 `-` 开头的仍放行（那是 flag，不是密码）。
    if (args[1] && !String(args[1]).startsWith('-')) {
      console.log('[错误] 出于安全考虑，新密码不再支持命令行参数（会明文出现在 ps/shell history）——运行 mingdao sync passwd 后按提示隐藏输入。');
      process.exitCode = 1;
      return true;
    }
    // 显式 help 分支：否则 `passwd --help` 会走到隐藏输入上干等 stdin（测试里直接挂住）
    if (args[1] === '--help' || args[1] === '-h') {
      console.log('用法：mingdao sync passwd');
      console.log('  旧密码与新密码均**隐藏输入**（两次确认），不接受命令行传密码——');
      console.log('  位置参数会让明文出现在 ps aux / shell history / CI 日志里。');
      return true;
    }
    // 三次提问必须共用同一个 readline 接口（见 createHiddenAsker 的注释：
    // 每题各建一个会在管道输入下丢掉后续数据，表现为"成功但什么都没做"）
    const ask = createHiddenAsker();
    try {
      const oldPassword = await ask.ask('旧密码：');
      if (!oldPassword) {
        console.log('[错误] 未输入旧密码');
        process.exitCode = 1;
        return true;
      }
      const newPassword = await ask.ask('新密码（至少 8 位）：');
      if (!newPassword) {
        console.log('[错误] 未输入新密码');
        process.exitCode = 1;
        return true;
      }
      if (newPassword.length < 8) {
        console.log('[错误] 新密码至少 8 位');
        process.exitCode = 1;
        return true;
      }
      // 改密码不像登录那样"试一次就知道了"：输错就得再走一遍流程，所以本地确认一次
      const again = await ask.ask('再输一次新密码：');
      if (again !== newPassword) {
        console.log('[错误] 两次输入不一致，未做任何改动');
        process.exitCode = 1;
        return true;
      }
      const r = await syncChangePassword({ oldPassword, newPassword });
      if (r.error) {
        console.log('[错误] ' + r.error);
        process.exitCode = 1;
        return true;
      }
      console.log('✓ 密码已修改（其他设备下次登录用新密码）');
      return true;
    } finally {
      ask.close();
    }
  }
  if (sub === 'share') {
    const name = args[1];
    if (!name) {
      console.log('用法：mingdao sync share <会话文件名>（列出：mingdao sync shares）');
      process.exitCode = 1;
      return true;
    }
    const r = await syncShareCreate(name);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已创建分享（会话 ${r.name}）`);
    console.log(`  分享码：${r.shareId}`);
    console.log(`  对方接受：mingdao sync accept ${r.shareId}`);
    return true;
  }
  if (sub === 'shares') {
    const r = await syncShareList();
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`我分享的（${r.mine.length}）：`);
    for (const s of r.mine) console.log(`  ${s.shareId.padEnd(12)} ${s.name} · 被接受 ${s.pulls} 次`);
    console.log(`我接受的（${r.accepted.length}）：`);
    for (const s of r.accepted) console.log(`  ${s.shareId.padEnd(12)} ${s.owner} 的 ${s.name} → 本地 ${s.savedAs}`);
    if (!r.mine.length && !r.accepted.length) console.log('  暂无分享');
    return true;
  }
  if (sub === 'accept') {
    const shareId = args[1];
    if (!shareId) {
      console.log('用法：mingdao sync accept <分享码>');
      process.exitCode = 1;
      return true;
    }
    const r = await syncShareAccept(shareId);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已接受分享 → 本地会话 ${r.savedAs}${r.conflict ? '（与你已有的同名会话不同，已另存副本）' : ''}`);
    return true;
  }
  if (sub === 'unshare') {
    const shareId = args[1];
    if (!shareId) {
      console.log('用法：mingdao sync unshare <分享码>');
      process.exitCode = 1;
      return true;
    }
    const r = await syncShareRevoke(shareId);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已撤销分享 ${shareId}（已接受者保留副本）`);
    return true;
  }
  if (sub === 'conflicts') {
    const list = listSyncConflicts();
    if (!list.length) {
      console.log('暂无冲突备份');
      return true;
    }
    console.log(`冲突备份（${list.length} 个会话）· 解决：mingdao sync conflict-resolve <会话名> local|remote|both`);
    for (const c of list) {
      const localLabel = c.localExists ? '本地有' : '本地无';
      const newest = c.entries[0];
      console.log(`  ${c.base.padEnd(44)} ${localLabel} · 备份 ${c.entries.length} 个（最新 ${newest.side}-${newest.ts}）`);
    }
    return true;
  }
  if (sub === 'conflict-resolve') {
    const base = args[1];
    const choice = args[2];
    if (!base || !['local', 'remote', 'both'].includes(choice)) {
      console.log('用法：mingdao sync conflict-resolve <会话文件名> local|remote|both');
      console.log('  local  保留本地，删除备份 · remote  采用远端版本覆盖本地 · both  两者都保留（备份转正）');
      process.exitCode = 1;
      return true;
    }
    const r = resolveSyncConflict(base, choice);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已解决：${r.base} → ${choice === 'local' ? '保留本地' : choice === 'remote' ? '采用 ' + r.applied : '保留两者（' + r.kept + '）'}`);
    return true;
  }
  if (sub === 'push') {
    const r = /** @type {any} */ (await syncPush(args[1]));
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已推送 ${r.pushed.length} 个会话${r.skipped?.length ? `（跳过 ${r.skipped.length} 个空会话）` : ''}${r.conflicts.length ? `，远端 ${r.conflicts.length} 个不同版本已备份为 .server-*（本地覆盖远端）` : ''}`);
    return true;
  }
  if (sub === 'pull') {
    const r = /** @type {any} */ (await syncPull(args[1]));
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已拉取 ${r.pulled.length} 个会话${r.conflicts.length ? `，${r.conflicts.length} 个与本地不同：远端内容已存为 .remote-*（本地保留）` : ''}`);
    return true;
  }
  const st = syncStatus();
  if (!st.configured) {
    console.log('未配置云同步。登录：mingdao sync login <用户名> [密码] <http(s)://服务器地址>');
    return true;
  }
  console.log(`同步服务器  ${st.url}`);
  console.log(`账号        ${st.username || '（未登录）'} · 设备 ${st.deviceName || '（未登录）'}`);
  console.log(`状态        ${st.loggedIn ? '✓ 已登录' : '✗ 未登录'} · 自动同步 ${st.auto ? '开' : '关'}`);
  if (st.loggedIn) {
    const remote = await syncRemoteList();
    if (remote.error) {
      console.log(`远端会话    ${remote.error}`);
    } else {
      console.log(`远端会话    ${remote.sessions.length} 个`);
      for (const s of remote.sessions.slice(0, 10)) {
        console.log(`  ${s.name.padEnd(42)} ${new Date(s.mtime).toLocaleString()} · ${(s.size / 1024).toFixed(1)}KB`);
      }
    }
  }
  return true;
}
