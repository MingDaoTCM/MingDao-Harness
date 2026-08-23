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

async function askHidden(question) {
  return new Promise((resolve) => {
    // _writeToOutput 为 readline 内部接口：静音回显（密码输入），类型护栏下显式 any
    const rl = /** @type {any} */ (readline.createInterface({ input: process.stdin, output: process.stdout }));
    const orig = rl._writeToOutput;
    rl._writeToOutput = () => {};
    rl.question(question, (a) => {
      if (typeof orig === 'function') rl._writeToOutput = orig;
      rl.close();
      resolve(a.trim());
    });
  });
}

export async function handleSync(cmd, args) {
  const sub = args[0] || 'status';
  if (sub === 'login') {
    const username = args[1];
    if (!username) {
      console.log('用法：mingdao sync login <用户名> [密码] [服务器地址]（地址默认取已配置项）');
      process.exitCode = 1;
      return true;
    }
    const s0 = syncStatus();
    const url = args[3] || s0.url;
    if (!url) {
      console.log('缺少服务器地址：mingdao sync login <用户名> [密码] <http(s)://地址>');
      process.exitCode = 1;
      return true;
    }
    let password = args[2];
    if (!password) password = await askHidden('密码（至少 8 位）：');
    const insecureFlag = args[4] === '--insecure' || args[5] === '--insecure';
    const r = await syncLogin({ url, username, password, deviceName: args[4] === '--insecure' ? undefined : args[4], insecure: insecureFlag });
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
    const newPassword = args[1];
    if (!newPassword) {
      console.log('用法：mingdao sync passwd <新密码>（将提示输入旧密码）');
      process.exitCode = 1;
      return true;
    }
    const oldPassword = await askHidden('旧密码：');
    const r = await syncChangePassword({ oldPassword, newPassword });
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log('✓ 密码已修改（其他设备下次登录用新密码）');
    return true;
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
    const r = await syncPush(args[1]);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 已推送 ${r.pushed.length} 个会话${r.skipped?.length ? `（跳过 ${r.skipped.length} 个空会话）` : ''}${r.conflicts.length ? `，远端 ${r.conflicts.length} 个不同版本已备份为 .server-*（本地覆盖远端）` : ''}`);
    return true;
  }
  if (sub === 'pull') {
    const r = await syncPull(args[1]);
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
