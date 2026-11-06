#!/usr/bin/env python3
"""MDH 国内拨测：从大陆视角检查香港源站的关键端点，异常时落一条"故障行"并维护状态。

为什么需要：香港源站自己测自己是"自证"——大陆用户遇到的慢/不可达（国际链路抖动、DNS 污染、
运营商 QoS）在源站上完全看不出来。这台深圳机提供**大陆视角**。

判据（全部必须同时满足才视为健康）：
  1. 首页 200 且 2s 内返回；
  2. 更新 feed 200 且内容含 version:；
  3. 下载端点支持 Range（206）——桌面端更新依赖它做续传；
  4. 不存在的下载路径必须 404（否则"缺文件"会伪装成"下载成功"）；
  5. 同步服务健康端点 200（若配置了）。

输出：/var/log/mdh/probe.log（每次一行 JSON）+ /var/log/mdh/probe-state.json（最近状态）。
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = os.environ.get('MDH_BASE', 'https://harness.mingdao.ai')
LOG_DIR = '/var/log/mdh'
STATE = os.path.join(LOG_DIR, 'probe-state.json')
TIMEOUT = 15

CHECKS = [
    ('home', f'{BASE}/', 200, None, 2.0),
    ('feed', f'{BASE}/updates/latest.yml', 200, 'version:', 3.0),
    ('missing_404', f'{BASE}/downloads/__probe_missing__.dmg', 404, None, 3.0),
]


def current_download_url():
    """从 feed 里读出**当前版本**的安装包名，再测 Range——不能写死版本号，
    否则每次发版后拨测都会红（会训练大家忽略告警）。"""
    try:
        with urllib.request.urlopen(f'{BASE}/updates/latest.yml', timeout=TIMEOUT) as r:
            text = r.read().decode('utf-8', 'replace')
    except Exception:
        return None
    for line in text.splitlines():
        if line.startswith('path:'):
            name = line.split(':', 1)[1].strip()
            if name:
                return f'{BASE}/downloads/{name}'
    return None


def fetch(name, url, want, contains, budget, headers=None):
    t0 = time.time()
    req = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read(4096) if contains else b''
            code = r.status
    except urllib.error.HTTPError as e:
        code, body = e.code, b''
    except Exception as e:  # noqa: BLE001 - 任何异常都算不可达
        return {'name': name, 'ok': False, 'error': f'{type(e).__name__}: {e}', 'ms': int((time.time() - t0) * 1000)}
    ms = int((time.time() - t0) * 1000)
    ok = code == want and (not contains or contains.encode() in body) and ms / 1000 <= budget
    return {'name': name, 'ok': ok, 'code': code, 'ms': ms,
            'why': '' if ok else f'code={code}(want {want}) ms={ms}(budget {int(budget*1000)}) contains={contains}'}


def main():
    os.makedirs(LOG_DIR, exist_ok=True)
    results = []
    dl = current_download_url()
    checks = list(CHECKS)
    if dl:
        checks.insert(2, ('download_range', dl, 206, None, 5.0))
    else:
        results.append({'name': 'download_range', 'ok': False, 'error': 'feed 里取不到 path:'})
    for name, url, want, contains, budget in checks:
        if name == 'download_range':
            results.append(fetch(name, url, want, contains, budget, {'Range': 'bytes=0-1023'}))
        else:
            results.append(fetch(name, url, want, contains, budget))
    bad = [r for r in results if not r['ok']]
    line = {'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'ok': not bad, 'checks': results}
    with open(os.path.join(LOG_DIR, 'probe.log'), 'a') as f:
        f.write(json.dumps(line, ensure_ascii=False) + '\n')
    # 状态翻转时单独记一行，便于 `grep FLIP` 直接看到"什么时候坏的/好的"
    prev = {}
    try:
        prev = json.load(open(STATE))
    except Exception:
        pass
    if prev.get('ok') != line['ok']:
        with open(os.path.join(LOG_DIR, 'probe-flip.log'), 'a') as f:
            f.write(json.dumps({'ts': line['ts'], 'from': prev.get('ok'), 'to': line['ok'],
                                'bad': [r['name'] for r in bad]}, ensure_ascii=False) + '\n')
    json.dump({'ts': line['ts'], 'ok': line['ok']}, open(STATE, 'w'))
    if bad:
        print(f'✗ {len(bad)}/{len(results)} 项异常: ' + ', '.join(f"{r['name']}({r.get('why') or r.get('error')})" for r in bad))
        return 1
    print('✓ 全部通过 ' + ' '.join(f"{r['name']}={r['ms']}ms" for r in results))
    return 0


if __name__ == '__main__':
    sys.exit(main())
