// 命令族：mingdao tasks / schedule（自 cli.js 拆出，评估 P0-1 拆包）
import {
  listSchedules,
  addSchedule,
  removeSchedule,
  pauseSchedule,
  resumeSchedule,
  chainSchedules,
  reconcileSchedules,
  formatScheduleRow,
  daemonAlive,
  stopDaemon,
} from '../schedule.js';
import { listTasks, killTask, formatTaskRow } from '../tasks.js';
import { ensureHome } from '../config.js';

function printTasks(home) {
  const tasks = listTasks(home);
  if (!tasks.length) {
    console.log('暂无任务。启动：mingdao run "<任务>"');
    return;
  }
  console.log(`任务面板（共 ${tasks.length} 个，新→旧）`);
  for (const t of tasks.slice(0, 20)) console.log('  ' + formatTaskRow(t));
  const running = tasks.filter((t) => t.status === 'running').length;
  console.log(running ? `\n${running} 个运行中 · mingdao tasks watch 实时刷新 · kill <id> 停止` : '\n无运行中任务');
}

async function watchTasks(home) {
  if (!process.stdout.isTTY) {
    printTasks(home);
    return;
  }
  for (;;) {
    const tasks = listTasks(home);
    console.log('\n\x1b[2J\x1b[H' + `任务面板 ${new Date().toLocaleTimeString()}`);
    if (!tasks.length) console.log('  暂无任务。启动：mingdao run "<任务>"');
    for (const t of tasks.slice(0, 20)) console.log('  ' + formatTaskRow(t));
    const running = tasks.filter((t) => t.status === 'running');
    if (!running.length) {
      console.log('\n全部任务已结束');
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function handleTasks(cmd, args) {
  const home0 = ensureHome();
  reconcileSchedules(home0);
  const sub = args[0];
  if (sub === 'kill') {
    const id = args[1];
    if (!id) {
      console.log('用法：mingdao tasks kill <id>');
      process.exitCode = 1;
      return true;
    }
    console.log(killTask(home0, id) ? `已请求停止任务 ${id}` : '任务不存在');
    return true;
  }
  if (sub === 'watch') {
    await watchTasks(home0);
    return true;
  }
  printTasks(home0);
  return true;
}

export async function handleSchedule(cmd, args) {
  const home0 = ensureHome();
  reconcileSchedules(home0);
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'daemon') {
    if (rest[0] === 'stop') {
      stopDaemon(home0);
      console.log('✓ 调度守护进程已停止（有待执行任务时任意 schedule 命令会自动再拉起）');
    } else {
      console.log(daemonAlive(home0) ? '调度守护进程：运行中 ✓' : '调度守护进程：未运行（有任务时自动拉起）');
    }
    return true;
  }
  if (sub === 'add') {
    let question = '';
    let at = null;
    let every = null;
    let anchor = null;
    let after = [];
    let permission = null;
    let model = null;
    let offpeak = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--at') at = rest[++i];
      else if (a === '--every') every = rest[++i];
      else if (a === '--anchor') anchor = rest[++i];
      else if (a === '--after') after = String(rest[++i]).split(',').map((x) => x.trim()).filter(Boolean);
      else if (a === '--permission') permission = rest[++i];
      else if (a === '--model') model = rest[++i];
      else if (a === '--offpeak') offpeak = true;
      else if (question === '') question = a;
    }
    if (!question) {
      console.log('用法：mingdao schedule add "<任务>" [--at "YYYY-MM-DD HH:MM" | --every 2h [--anchor 09:00]] [--after 任务ID,...] [--permission auto] [--model 名] [--offpeak 高峰顺延至 14:00 后]');
      process.exitCode = 1;
      return true;
    }
    const r = addSchedule(home0, question, { at, every, after, permission, model, cwd: process.cwd(), anchor, offpeak });
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 调度任务已创建 ${r.id}`);
    console.log(`  查看：mingdao schedule list · 删除：mingdao schedule remove ${r.id}`);
    return true;
  }
  if (sub === 'list') {
    const jobs = listSchedules(home0);
    if (!jobs.length) {
      console.log('暂无调度任务。创建：mingdao schedule add "<任务>" --at "2026-08-21 09:00" 或 --every 2h');
      return true;
    }
    console.log(`调度队列（共 ${jobs.length} 个，按下次运行排序）`);
    for (const j of jobs.slice(0, 30)) console.log('  ' + formatScheduleRow(j));
    return true;
  }
  if (sub === 'remove') {
    const id = rest[0];
    if (!id) {
      console.log('用法：mingdao schedule remove <id>');
      process.exitCode = 1;
      return true;
    }
    console.log(removeSchedule(home0, id) ? `已删除调度任务 ${id}` : '任务不存在');
    return true;
  }
  if (sub === 'pause') {
    const id = rest[0];
    if (!id) {
      console.log('用法：mingdao schedule pause <id>');
      process.exitCode = 1;
      return true;
    }
    console.log(pauseSchedule(home0, id) ? `已暂停 ${id}（mingdao schedule resume ${id} 恢复）` : '任务不存在或不可暂停');
    return true;
  }
  if (sub === 'resume') {
    const id = rest[0];
    if (!id) {
      console.log('用法：mingdao schedule resume <id>');
      process.exitCode = 1;
      return true;
    }
    console.log(resumeSchedule(home0, id) ? `已恢复 ${id}` : '任务不存在或未暂停');
    return true;
  }
  if (sub === 'chain') {
    if (rest.length < 2) {
      console.log('用法：mingdao schedule chain "任务A" "任务B" "任务C"（按顺序执行，后者依赖前者成功）');
      process.exitCode = 1;
      return true;
    }
    const r = chainSchedules(home0, rest);
    if (r.error) {
      console.log('[错误] ' + r.error);
      process.exitCode = 1;
      return true;
    }
    console.log(`✓ 链式队列已创建：${r.ids.join(' → ')}`);
    return true;
  }
  console.log('用法：mingdao schedule add|list|remove|pause|resume|chain');
  return true;
}
