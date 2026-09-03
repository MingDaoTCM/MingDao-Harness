// WebUI HTTP API 编排器（Phase C C1：按域拆分）。
// 职责：访问控制（token/Host/CSRF）→ 静态壳资源 → 按域分发路由。
// 域实现见 ./domains/（config/sessions/skills/schedule/sync/workspace/misc），
// 每个域导出 handle(ctx, deps, shared)：命中返回 true，未命中返回 false。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as configDomain from './domains/config.js';
import * as sessionsDomain from './domains/sessions.js';
import * as skillsDomain from './domains/skills.js';
import * as scheduleDomain from './domains/schedule.js';
import * as syncDomain from './domains/sync.js';
import * as workspaceDomain from './domains/workspace.js';
import * as miscDomain from './domains/misc.js';

// 域分发顺序：路径互不重叠，顺序只影响可读性（杂项域兜底最后）
const DOMAINS = [configDomain, sessionsDomain, skillsDomain, scheduleDomain, syncDomain, workspaceDomain, miscDomain];

/** @param {any} deps */
export function createApiDispatch(deps) {
  const { json, readBody, validateRemoteUrl, isPrivateHost, authEnabled, tokenMatches, requestToken, trustedHost, INDEX_HTML } = deps;
  const MAX_API_BODY = 1024 * 1024; // 质检 A4：普通 JSON 接口 1MB；chat 保持 readBody 默认 40MB
  const shared = { json, readBody, MAX_API_BODY, validateRemoteUrl, isPrivateHost };

  const dispatch = async (/** @type {any} */ req, /** @type {any} */ res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    // 访问控制（P1-3/P1-4）：token 校验覆盖数据与操作接口；壳页面与 PWA 静态资源公开
    // （壳不含任何数据，SPA 需要先加载才能读取 ?token=）；Host 白名单覆盖一切请求
    const isStaticAsset =
      p === '/' || p === '/index.html' || p === '/app.js' || p === '/util.js' || p === '/constants.js' || p === '/favicon.ico' || p === '/icon.svg' || p === '/icon-192.png' || p === '/icon-512.png' || p === '/manifest.webmanifest' || p === '/sw.js';
    if (authEnabled && !isStaticAsset && !tokenMatches(requestToken(req, url))) {
      return json(res, 401, { error: '未授权：缺少或无效的访问令牌（地址需带 ?token=…，或请求头携带 X-MingDao-Token）' });
    }
    if (!trustedHost(req.headers.host)) {
      return json(res, 403, { error: 'Host 校验失败：请通过绑定地址访问（DNS rebinding 防护）' });
    }

    // CSRF 防护：跨源请求一律拒绝；POST 仅接受 JSON（拦截表单/纯文本跨站盲提交）
    if (method !== 'GET' && method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (new URL(origin).host !== req.headers.host) return json(res, 403, { error: '跨源请求被拒绝' });
        } catch {
          return json(res, 403, { error: '非法 Origin' });
        }
      }
      const ct = String(req.headers['content-type'] || '');
      if (!ct.includes('application/json') && !ct.includes('text/plain')) {
        return json(res, 415, { error: '仅接受 JSON 请求体' });
      }
      if (ct.includes('text/plain')) {
        // text/plain 是经典 CSRF 向量（无需预检）：直接拒绝，要求 application/json
        return json(res, 415, { error: '请使用 application/json' });
      }
    }

    // —— 静态壳资源（公开；不经过域分发） ——
    // 质检 Q2/S5：SPA 外部 JS——从磁盘读取（与 index.html 同目录）。
    // v0.2.8 C2：app.js 拆分为 ES Modules（app.js / util.js / constants.js），统一从此处伺服。
    const WEB_JS_FILES = new Set(['app.js', 'util.js', 'constants.js']);
    if (method === 'GET' && WEB_JS_FILES.has(p.slice(1))) {
      try {
        const js = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', p.slice(1)), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(js);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(p.slice(1) + ' 加载失败');
      }
      return;
    }
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      try {
        const html = fs.readFileSync(INDEX_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch {
        json(res, 500, { error: '前端文件缺失' });
      }
      return;
    }
    // 统一品牌图标：浏览器标签页 /favicon.ico 直接返回 192 PNG
    if (method === 'GET' && (p === '/favicon.ico' || p === '/icon-192.png' || p === '/icon-512.png')) {
      try {
        // 图标真身在 src/web/icons/（routes 目录内无 icons/；Phase 2 拆分时路径未随迁——契约测试捕获）
        const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons', p === '/icon-512.png' ? 'icon-512.png' : 'icon-192.png');
        const buf = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
      } catch {
        json(res, 404, { error: 'icon missing' });
      }
      return;
    }
    // PWA 资源
    if (method === 'GET' && p === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      res.end(
        JSON.stringify({
          name: 'MingDao Harness',
          short_name: 'MingDao',
          description: 'MingDao-Harness 智能体框架 WebUI',
          start_url: '/',
          display: 'standalone',
          background_color: '#0f1115',
          theme_color: '#0f1115',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        })
      );
      return;
    }
    if (method === 'GET' && p === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      res.end(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f1115"/><path d="M18 20h6v24h-6zM29 20h6v24h-6zM40 20h6v24h-6z" fill="#3ddc97"/><circle cx="43" cy="18" r="5" fill="#22b8cf"/></svg>`
      );
      return;
    }
    if (method === 'GET' && p === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      // 缓存键去掉 query（?token= 不落缓存）；mingdao-v5：随 token 认证版本升版本号，强制替换旧 SW 缓存
      res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!=='mingdao-v5').map(k=>caches.delete(k)))).then(()=>clients.claim())));self.addEventListener('fetch',e=>{if(e.request.method==='GET'&&new URL(e.request.url).origin===location.origin&&!e.request.url.includes('/api/')){const u=new URL(e.request.url);u.search='';e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('mingdao-v5').then(cache=>cache.put(u.toString(),c));return r;}).catch(()=>caches.match(u.toString()).then(m=>m||caches.match('/'))));}});`);
      return;
    }

    // —— 域分发 ——
    const ctx = { req, res, method, p, url };
    for (const domain of DOMAINS) {
      if (await domain.handle(ctx, deps, shared)) return;
    }

    json(res, 404, { error: 'Not found' });
  };

  return dispatch;
}
