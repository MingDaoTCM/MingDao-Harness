// 示例 Pack：最小可用形态（1 工具 + 1 约束 + 1 提示词段）。
// 垂域团队照抄本文件即可起步；真实领域逻辑放在自己的仓库/目录里。
import fs from 'node:fs';
import path from 'node:path';

export const apiVersion = 1;

export function createPack(ctx) {
  return {
    tools: [
      {
        name: 'count_lines',
        description: '统计某个文本文件的行数与字符数（示例工具，只读）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '文件路径' } },
          required: ['path'],
        },
        readOnly: true,
        async run(args) {
          const p = String(args?.path || '');
          if (!p) return { ok: false, error: '缺少 path 参数' };
          try {
            const text = fs.readFileSync(path.resolve(p), 'utf8');
            return { ok: true, output: `行数 ${text.split('\n').length}，字符数 ${text.length}` };
          } catch (e) {
            return { ok: false, error: `读取失败：${e?.message || e}` };
          }
        },
      },
    ],

    // 领域红线：输出里出现结论性措辞即拦截（真实垂域按需替换 pattern）
    constraints: [
      {
        id: 'no-conclusion',
        kind: 'output-forbid',
        pattern: '确诊为|治愈|保证有效',
        action: 'block-and-rewrite',
      },
    ],

    promptSections: [
      { id: 'domain', order: 100, content: fs.readFileSync(path.join(ctx.packDir, 'prompts', 'domain.md'), 'utf8') },
    ],
  };
}
