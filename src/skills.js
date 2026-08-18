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
import { mingdaoHome } from './config.js';

const BUILTIN_DIR = fileURLToPath(new URL('../skills', import.meta.url));

export function skillDirs(workingDir) {
  return [
    { dir: path.join(mingdaoHome(), 'skills'), source: 'user' },
    { dir: path.join(workingDir, '.mingdao', 'skills'), source: 'project' },
    { dir: BUILTIN_DIR, source: 'builtin' },
  ];
}

function readDescription(skillMd) {
  try {
    const text = fs.readFileSync(skillMd, 'utf8');
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const d = fm[1].match(/^description:\s*(.+)$/m);
      if (d) return d[1].trim();
    }
    const h = text.match(/^#\s+(.+)$/m);
    return h ? h[1].trim() : '';
  } catch {
    return '';
  }
}

export function listSkills(workingDir) {
  const seen = new Set();
  const out = [];
  for (const { dir, source } of skillDirs(workingDir)) {
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
        if (!fs.statSync(skillMd).isFile()) continue;
      } catch {
        continue;
      }
      seen.add(e.name); // 优先级：user > project > builtin，先出现的生效
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

export function loadSkill(workingDir, name) {
  const s = listSkills(workingDir).find((x) => x.name === name);
  if (!s) return null;
  try {
    return { ...s, content: fs.readFileSync(s.path, 'utf8') };
  } catch {
    return null;
  }
}

function sourceLabel(source) {
  if (source === 'user') return '（用户级）';
  if (source === 'builtin') return '（内置）';
  return '';
}

// 注入系统提示的技能清单（仅名称+描述）
export function skillsRegistryBlock(workingDir) {
  const skills = listSkills(workingDir);
  if (!skills.length) return '';
  return (
    '\n\n## 可用技能（Skills）\n当任务与某技能相关时，先调用 skill 工具加载对应 SKILL.md 再动手：\n' +
    skills.map((s) => `- ${s.name}${sourceLabel(s.source)}：${s.description || '（无描述）'}`).join('\n')
  );
}
