// 配置保存失败必须可见（v0.10.1，v0.8.1 审计报告2 M-07）。
//
// 缺陷（实测）：`saveConfigAsync()` 本身已返回 `{ok:false,error}`，但 4 个写配置的接口
// （`POST /api/config` 与 `/api/models-config` 的 addCustom/updateCustom/removeCustom/setBaseUrl）
// 全部 `await saveConfigAsync(cfg)` 后**无条件** 200 + `ok:true`。磁盘满/目录只读/锁超时时，
// 用户看到「保存成功」，实际一个字节都没落盘；重启后设置全部回滚。
//
// 本套件钉住：
//   ① 真实 fs 写失败（rename 注入 EACCES）→ 接口返回 500 + `ok:false` + 可操作原因；
//   ② 响应体不得回显底层原始错误串（防把配置内容/凭证片段或路径之外的敏感信息带出去）；
//   ③ 4 类写入口里抽 3 个代表（config / setBaseUrl / addCustom）都必须走同一条失败路径；
//   ④ 写成功时响应形状不变（仍 200 + ok:true + 既有字段）。
//
// 运行：node test/config-save-failure.js（离线；临时 MINGDAO_HOME）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mingdao-savefail-'));
process.env.MINGDAO_HOME = home;

const load = (/** @type {string} */ rel) => import(pathToFileURL(path.join(srcDir, rel)).href);
const Routes = await load('web/routes/domains/config.js');
const Config = await load('config.js');
const configPath = Config.configPath();

let passed = 0;
/** @param {string} name */
const ok = (name) => {
  passed += 1;
  console.log(`  ✓ ${name}`);
};

/** 建一次路由调用所需的 deps/shared（可覆盖 saveConfigAsync）。 */
function harness(/** @type {any} */ overrides = {}) {
  const cfg = { provider: 'deepseek', model: 'deepseek-v4-flash', permission: 'ask', sandbox: 'off', contextBudget: 128000 };
  const deps = /** @type {any} */ ({
    cfg,
    home,
    state: { modelName: 'deepseek-v4-flash', workingDir: home },
    providerCache: { clear: () => {} },
    invalidateProviderCache: () => {},
    getProviderFor: async () => ({ chat: async () => ({ text: '' }) }),
    mcpFacade: { status: () => [] },
    authEnabled: false,
    ...overrides,
  });
  /** @type {{status:number, body:any}} */
  const out = { status: 0, body: null };
  const shared = {
    MAX_API_BODY: 1024 * 1024,
    json: (/** @type {any} */ _res, /** @type {number} */ status, /** @type {any} */ obj) => {
      out.status = status;
      out.body = obj;
      return true;
    },
    readBody: async (/** @type {any} */ req) => req.body,
    validateRemoteUrl: async () => ({ error: null }),
  };
  /** @param {string} p @param {any} body @param {string} method */
  const call = async (p, body, method = 'POST') => {
    const ctx = { req: { body }, res: {}, method, p, url: new URL(`http://127.0.0.1${p}`) };
    const hit = await Routes.handle(ctx, deps, shared);
    assert.equal(hit, true, `${method} ${p} 必须命中配置域`);
    return out;
  };
  return { call, out, deps, cfg };
}

const FAIL = async () => ({ ok: false, error: "EACCES: permission denied, open '/home/u/.mingdao/config.json'" });

// ===========================================================================
// ① 真实 fs 写失败（rename 注入 EACCES）：POST /api/config 必须 500 + ok:false
// ===========================================================================
{
  const h = harness();
  const realRename = fs.renameSync;
  // @ts-ignore 注入：原子写的最后一步 rename(tmp → config.json) 失败，等价于目录只读/磁盘满。
  fs.renameSync = (/** @type {any} */ from, /** @type {any} */ to) => {
    if (String(to) === configPath) {
      const e = /** @type {any} */ (new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`));
      e.code = 'EACCES';
      throw e;
    }
    return realRename.call(fs, from, to);
  };
  let r;
  try {
    r = await h.call('/api/config', { sandbox: 'readonly' });
  } finally {
    fs.renameSync = realRename;
  }
  assert.equal(r.status, 500, `真实写失败必须 500，实际 ${r.status}`);
  assert.equal(r.body.ok, false, '失败响应必须 ok:false（此前是 200 + ok:true）');
  assert.ok(String(r.body.error || '').includes('配置保存失败'), `响应体必须给出原因，实际：${r.body.error}`);
  assert.ok(!String(r.body.error || '').includes('EACCES'), '响应体不得原样回显底层错误（只给 errno 级别的可操作原因）');
  assert.equal(fs.existsSync(configPath), false, '写失败时不得留下半截 config.json');
  ok('① 真实 fs 写失败 → /api/config 500 + ok:false + 可读原因');
}

// ===========================================================================
// ② 注入敏感串的失败原因：不得把底层 message 透传到响应体
// ===========================================================================
{
  const h = harness({ saveConfigAsync: async () => ({ ok: false, error: 'ENOSPC 写入 /home/u/.mingdao/config.json 时夹带 sk-secret-LEAK' }) });
  const r = await h.call('/api/config', { sandbox: 'readonly' });
  assert.equal(r.status, 500, '注入 ENOSPC 失败必须 500');
  assert.equal(r.body.ok, false);
  const text = JSON.stringify(r.body);
  assert.ok(text.includes('磁盘空间不足'), `errno 应被翻译成可操作原因，实际：${text}`);
  assert.ok(text.includes('配置保存失败'), '必须明确写出「配置保存失败」');
  assert.ok(!text.includes('sk-secret-LEAK'), '底层错误里的敏感内容不得出现在响应体');
  assert.ok(!text.includes('/home/u/.mingdao'), '底层路径也不得原样透传（saveConfigAsync 已在服务端日志记录完整原因）');
  ok('② 注入 ENOSPC：原因可读、敏感串与底层路径不外泄');
}

// ===========================================================================
// ③ 其他写入口同样失败可见：setBaseUrl / addCustom
// ===========================================================================
{
  const h = harness({ saveConfigAsync: FAIL });
  const a = await h.call('/api/models-config', { action: 'setBaseUrl', baseUrl: '' });
  assert.equal(a.status, 500, 'setBaseUrl 写失败必须 500（此前 200）');
  assert.equal(a.body.ok, false, 'setBaseUrl 失败响应必须 ok:false');

  const h2 = harness({ saveConfigAsync: FAIL });
  const b = await h2.call('/api/models-config', { action: 'addCustom', name: 'fail-custom', label: 'x', baseUrl: 'https://example.com/v1' });
  assert.equal(b.status, 500, 'addCustom 写失败必须 500（此前 200）');
  assert.equal(b.body.ok, false, 'addCustom 失败响应必须 ok:false');
  assert.ok(String(b.body.error || '').includes('配置保存失败'), `addCustom 失败原因必须可读，实际：${b.body.error}`);
  ok('③ setBaseUrl / addCustom 写失败同样 500 + ok:false');
}

// ===========================================================================
// ④ 保存成功：响应形状不变（仍 200 + ok:true + 既有字段）
// ===========================================================================
{
  const h = harness({ saveConfigAsync: async () => ({ ok: true, error: null }) });
  const r = await h.call('/api/config', { sandbox: 'readonly' });
  assert.equal(r.status, 200, `保存成功必须仍 200，实际 ${r.status}`);
  assert.equal(r.body.ok, true, '保存成功仍 ok:true');
  for (const key of ['model', 'permission', 'sandbox', 'contextBudget', 'notify']) {
    assert.ok(key in r.body, `成功响应必须保留既有字段 ${key}，实际：${JSON.stringify(r.body)}`);
  }
  const m = await h.call('/api/models-config', { action: 'setBaseUrl', baseUrl: '' });
  assert.equal(m.status, 200, 'setBaseUrl 保存成功仍 200');
  assert.equal(m.body.ok, true, 'setBaseUrl 成功仍 ok:true');
  ok('④ 保存成功：200 + ok:true + 既有字段形状不变');
}

console.log(`\nconfig-save-failure：${passed} 项通过`);
