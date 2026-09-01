// 技能域（Phase C C1）：/api/skills /api/skill-library /api/mcp-presets
// 技能列表/安装/卸载、内置技能库 + 线上注册表搜索、MCP 生态预设接入。
import { listSkills, tamperedSkillNames } from '../../../skills.js';
import { libraryList, installSkill, uninstallSkill, installedUserSkillNames } from '../../../skill-lib.js';
import { presetList, buildPreset } from '../../../mcp-presets.js';
import { saveConfig } from '../../../config.js';

/**
 * 技能域路由。命中返回 true，未命中返回 false。
 * @param {{req:any,res:any,method:any,p:any,url:any}} ctx
 * @param {any} deps
 * @param {{json:any,readBody:any,MAX_API_BODY:any}} shared
 */
export async function handle({ req, res, method, p, url }, deps, shared) {
  const { json, readBody, MAX_API_BODY } = shared;
  const { cfg, state } = deps;

  if (method === 'GET' && p === '/api/skills') {
    json(res, 200, { ok: true, skills: listSkills(state.workingDir), tampered: tamperedSkillNames(state.workingDir) });
    return true;
  }

  if (method === 'GET' && p === '/api/mcp-presets') {
    json(res, 200, { ok: true, presets: presetList() });
    return true;
  }

  if (method === 'POST' && p === '/api/mcp-presets') {
    const body = await readBody(req, MAX_API_BODY);
    const name = String(body.name || '').trim();
    const r = buildPreset(name, body.arg, state.workingDir);
    if (r.error) return json(res, 400, { error: r.error });
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[name] = r.config;
    saveConfig(cfg);
    json(res, 200, { ok: true, name, note: '重启 mingdao web 后生效（/mcp 查看状态）' });
    return true;
  }

  if (method === 'GET' && p === '/api/skill-library') {
    const q = url.searchParams.get('q') || '';
    const force = url.searchParams.get('refresh') === '1';
    const local = q
      ? libraryList().filter((s) => s.name.includes(q) || (s.description || '').includes(q))
      : libraryList();
    const { searchRegistry } = await import('../../../skill-registry.js');
    const remote = await searchRegistry(q || '', { force, allowNetwork: force });
    const localNames = new Set(local.map((s) => s.name));
    const registryEntries = remote.skills
      ? remote.skills.filter((/** @type {any} */ s) => !localNames.has(s.name)).map((/** @type {any} */ s) => ({ ...s, dir: null }))
      : [];
    json(res, 200, {
      ok: true,
      library: local.map((s) => ({ name: s.name, description: s.description, source: 'builtin-lib', installed: s.installed })).concat(
        registryEntries.map((/** @type {any} */ s) => ({ name: s.name, description: s.description, source: 'registry', installed: s.installed }))
      ),
      installed: [...installedUserSkillNames()],
      registry: remote.error ? { error: remote.error } : { host: remote.host, updatedAt: remote.updatedAt, stale: remote.stale || false },
    });
    return true;
  }

  if (method === 'POST' && p === '/api/skills') {
    const body = await readBody(req, MAX_API_BODY);
    if (body.action === 'install') {
      const r = /** @type {any} */ (await installSkill(body.arg || body.name || ''));
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name, names: r.names });
    }
    if (body.action === 'uninstall') {
      const r = uninstallSkill(body.name);
      if (r.error) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, name: r.name });
    }
    return json(res, 400, { error: '未知操作：install|uninstall' });
  }

  return false;
}
