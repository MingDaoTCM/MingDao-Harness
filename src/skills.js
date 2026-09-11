// Skills 技能系统（借鉴 OpenAI Codex CLI 的渐进式披露与 DeepSeek-Harness 的 SKILL.md 格式）：
//  - 三级来源（同名覆盖优先级从高到低）：
//      user    <mingdao-home>/skills/          用户级，本机全局
//      project <项目>/.mingdao/skills/         项目级，随仓库共享
//      builtin <安装包>/skills/                内置技能，随 MingDao 发布
//  - 每个技能一个目录，内含 SKILL.md（frontmatter 可含 description）
//  - 技能清单（名称+描述）自动注入系统提示；模型按需调用 skill 工具加载全文
//  - 避免把全部技能内容塞进上下文，节省 token（渐进式披露）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mingdaoHome, loadConfig } from './config.js';
import { skillDirHash, readSourceMeta } from './skill-lib.js';

const BUILTIN_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export function skillDirs(/** @type {any} */ workingDir) {
  return [
    { dir: path.join(mingdaoHome(), 'skills'), source: 'user' },
    { dir: path.join(workingDir, '.mingdao', 'skills'), source: 'project' },
    { dir: BUILTIN_DIR, source: 'builtin' },
  ];
}

// v0.4.7：技能描述长度上限。描述会**每轮**拼进系统提示（buildSystemPrompt → skillsRegistryBlock），
// 此前无任何截断——实测一个 2MB 单行 description 会让技能块变成 2MB，每轮全额计费。
const MAX_SKILL_DESC = 200;
/** @param {any} s */
function capDesc(s) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > MAX_SKILL_DESC ? t.slice(0, MAX_SKILL_DESC) + '…' : t;
}

function readDescription(/** @type {any} */ skillMd) {
  try {
    const text = fs.readFileSync(skillMd, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const d = fm[1].match(/^description:\s*(.+)$/m);
      if (d) return capDesc(d[1].trim());
    }
    const h = text.match(/^#\s+(.+)$/m);
    return h ? capDesc(h[1].trim()) : '';
  } catch {
    return '';
  }
}

// 完整性校验（P3-3）：带指纹（sha256）来源记录的技能，内容与安装时不一致 → 拒绝加载。
//
// v0.4.7（T3）诚实边界：这个检查**只能**发现「安装之后本地被改动」——指纹（`.mingdao-source.json`）
// 与技能内容在同一个目录里，因此它对「仓库投毒」这类场景**零收益**：克隆下来的仓库可以不带指纹
// （直接放行），也可以带一个自算的指纹（同样放行）。真正的来源可信只能靠 registry 侧签名 +
// 固定指纹白名单，那是另一条路线。此前注释声称「防仓库投毒」属过度承诺，现改正；
// 项目级技能在系统提示里标注「来源不可验证」，并由 skillsRegistryBlock 给出一次性提示。
function isTampered(/** @type {any} */ dir) {
  const meta = readSourceMeta(dir);
  if (!meta?.sha256) return false; // 旧版安装（无指纹）不拦截
  try {
    return skillDirHash(dir) !== meta.sha256;
  } catch {
    return true;
  }
}

// 被篡改的用户级技能清单（CLI/WebUI 提示用；这些技能已被 listSkills 排除加载）
export function tamperedSkillNames(/** @type {any} */ workingDir) {
  const dir = path.join(mingdaoHome(), 'skills');
  const /** @type {any} */ out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return /** @type {any} */ out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillDir = path.join(dir, e.name);
    try {
      if (!fs.lstatSync(path.join(skillDir, 'SKILL.md')).isFile()) continue;
    } catch {
      continue;
    }
    if (isTampered(skillDir)) {
      const meta = readSourceMeta(skillDir);
      out.push({ name: e.name, source: meta?.source || 'user', sha256: meta?.sha256?.slice(0, 16) || null });
    }
  }
  return out;
}

export function listSkills(/** @type {any} */ workingDir) {
  const seen = new Set();
  const out = [];
  // v0.4.7（T3）：config.disableProjectSkills=true 时整层跳过项目级技能——
  // 项目级技能随仓库分发、来源不可验证，受监管/敏感场景可直接关断。
  let skipProject = false;
  try {
    skipProject = loadConfig()?.disableProjectSkills === true;
  } catch {}
  for (const { dir, source } of skillDirs(workingDir)) {
    if (skipProject && source === 'project') continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const skillMd = path.join(dir, e.name, 'SKILL.md');
      try {
        if (!fs.lstatSync(skillMd).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(e.name); // 优先级：user > project > builtin，先出现的生效
      // P3-3：技能指纹不符 → 拒绝加载（绝不静默执行**被改动过**的提示词）。
      // 注意（v0.4.7 T3）：这只覆盖「安装后本地被改」；对 project 级技能，指纹与内容同在
      // 仓库目录内，攻击者可以不带指纹或自签一个 → 不构成防投毒。故 project 级仅作此校验并
      // 在提示里标注来源不可验证；user 级由 registry 安装时写入指纹，这里的校验才真正有意义。
      if ((source === 'user' || source === 'project') && isTampered(path.join(dir, e.name))) continue;
      out.push({
        name: e.name,
        dir: path.join(dir, e.name),
        path: skillMd,
        description: readDescription(skillMd),
        source,
      });
    }
  }
  return out;
}

export function loadSkill(/** @type {any} */ workingDir, /** @type {any} */ name) {
  const s = listSkills(workingDir).find((x) => x.name === name);
  if (!s) return null;
  try {
    return { ...s, content: fs.readFileSync(s.path, 'utf8') };
  } catch {
    return null;
  }
}

function sourceLabel(/** @type {any} */ source) {
  if (source === 'user') return '（用户级）';
  if (source === 'builtin') return '（内置）';
  // v0.4.7（T3）：项目级技能随仓库分发、来源不可验证（指纹可缺失或自签），
  // 必须在注入系统提示时就标明，让模型与用户都知道这不是可信来源。
  if (source === 'project') return '（项目级·来源不可验证）';
  return '';
}

// 项目级技能的一次性提示（每进程一次，避免每轮刷屏）
let projectSkillWarned = false;

// 注入系统提示的技能清单（仅名称+描述）
export function skillsRegistryBlock(/** @type {any} */ workingDir) {
  // v0.4.7（T3）：项目级技能来自被打开的仓库，来源不可验证（见 isTampered 的诚实边界）。
  // 一次性提示并给出关断开关——不静默即可，也不默认破坏既有流程。
  if (!projectSkillWarned) {
    try {
      const projSkills = listSkills(workingDir).filter((s) => s.source === 'project');
      if (projSkills.length) {
        projectSkillWarned = true;
        console.warn(
          `[MingDao] ⚠ 本仓库携带 ${projSkills.length} 个项目级技能（${projSkills.map((s) => s.name).join('、')}）：` +
            '来源不可验证（指纹可缺失或自签），其描述会进入系统提示。若不确定来源，请删除 .mingdao/skills/ 或设置 config.disableProjectSkills: true。'
        );
      }
    } catch {}
  }
  const skills = listSkills(workingDir);
  if (!skills.length) return '';
  return (
    '\n\n## 可用技能（Skills）\n当任务与某技能相关时，先调用 skill 工具加载对应 SKILL.md 再动手：\n' +
    skills.map((s) => `- ${s.name}${sourceLabel(s.source)}：${s.description || '（无描述）'}`).join('\n')
  );
}
