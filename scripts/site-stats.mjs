// 官网访问量与安装包下载计数（宿主 cron 每 5 分钟运行）
// 数据源：openresty 容器内 /var/log/nginx/harness.access.log（main 格式，harness.mingdao.ai 专属）
// 输出：/opt/1panel/www/sites/mingdao-site/stats.json（原子写）
// 幂等设计：按「天」聚合后与状态文件做 max 合并——重复解析/日志轮转/重跑都不会重复计数；
// 历史天数永久保留在状态文件，logrotate 删除旧日志不影响累计值。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CONTAINER = '1Panel-openresty-baFL';
const LOG = '/var/log/nginx/harness.access.log';
const STATE_FILE = '/opt/mingdao/site-stats-state.json';
const OUT_FILE = '/opt/1panel/www/sites/mingdao-site/stats.json';

const LINE_RE =
  /^(\S+) \S+ \S+ \[([^\]]+)\] "([A-Z]+) ([^"\s]+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"(?: "([^"]*)")?/;
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const BOT_RE =
  /bot|crawler|spider|semrush|ahrefs|baiduspider|sogou|yandex|bingpreview|monitor|uptimerobot|pingdom|headless|python-requests|Go-http-client|curl\/|wget\/|libwww|facebookexternalhit|twitterbot|feedfetcher|bytespider|petalbot/i;
const DL_RE = /^\/downloads\/([^\/?#]+\.(?:exe|dmg|deb|AppImage|zip))$/;

function dayKey(timeLocal) {
  // [24/Aug/2026:07:10:29 +0800] → 2026-08-24（按日志自身时区，服务在 +08）
  const m = /^(\d{1,2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})/.exec(timeLocal);
  if (!m) return null;
  const [, d, mon, y] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `${y}-${mm}-${d.padStart(2, '0')}`;
}

function readLogs() {
  const chunks = [];
  const candidates = [
    { f: LOG, cmd: ['cat', LOG] },
    { f: LOG + '.1', cmd: ['cat', LOG + '.1'] },
    { f: LOG + '.1.gz', cmd: ['zcat', LOG + '.1.gz'] },
    { f: LOG + '.2', cmd: ['cat', LOG + '.2'] },
    { f: LOG + '.2.gz', cmd: ['zcat', LOG + '.2.gz'] },
  ];
  for (const c of candidates) {
    try {
      chunks.push(execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', c.cmd.join(' ') + ' 2>/dev/null'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8'));
    } catch {}
  }
  return chunks.join('\n');
}

function main() {
  let state = { days: {} };
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}

  const days = state.days || {};
  const raw = readLogs();
  let parsed = 0;
  // 幂等：每次从全部可用日志「重建」当日计数（跨文件同一天自动累加），再整体覆盖状态文件——
  // 重复运行 / 重读同一日志绝不会 +1 两次；日志轮转后旧天不在日志里则保留状态中的历史值。
  const parsedDays = {};
  for (const line of raw.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, ip, timeLocal, method, reqPath, status, , , ua] = m;
    const dk = dayKey(timeLocal);
    if (!dk) continue;
    const day = (parsedDays[dk] ||= { pv: 0, ips: {}, dl: {} });
    const isBot = BOT_RE.test(ua || '');
    const isPage = method === 'GET' && (reqPath === '/' || reqPath === '/index.html') && (status === '200' || status === '304');
    if (isPage && !isBot) {
      day.pv += 1;
      day.ips[ip] = true;
    }
    const dl = DL_RE.exec(reqPath || '');
    if (dl && method === 'GET' && (status === '200' || status === '206')) {
      day.dl[dl[1]] = (day.dl[dl[1]] || 0) + 1;
    }
    parsed += 1;
  }
  for (const [dk, d] of Object.entries(parsedDays)) days[dk] = d;

  // 剪枝：IP 集合只保留近 7 天（今日 UV 用），pv/dl 永久保留
  const keys = Object.keys(days).sort();
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  for (const k of keys) if (k < cutoff) delete days[k].ips;

  fs.writeFileSync(STATE_FILE, JSON.stringify({ days }, null, 2));

  // 汇总输出
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
  const downloads = {};
  let pvTotal = 0;
  let pvToday = 0;
  for (const [k, d] of Object.entries(days)) {
    pvTotal += d.pv || 0;
    if (k === today) pvToday = d.pv || 0;
    for (const [f, n] of Object.entries(d.dl || {})) {
      downloads[f] ||= { total: 0, today: 0 };
      downloads[f].total += n;
      if (k === today) downloads[f].today = n;
    }
  }
  const out = {
    generatedAt: new Date().toISOString(),
    pvTotal,
    pvToday,
    uvToday: Object.keys(days[today]?.ips || {}).length,
    downloads,
  };
  const tmp = OUT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, OUT_FILE);
  console.log(`[site-stats] 解析 ${parsed} 行 · 累计访问 ${pvTotal} · 今日 ${pvToday}（UV ${out.uvToday}）· 下载文件 ${Object.keys(downloads).length} 种`);
}

main();
