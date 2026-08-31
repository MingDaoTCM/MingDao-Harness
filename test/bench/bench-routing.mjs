// 评测基准（Hermes E2-2）：路由准确率标注集 + 升级检测离线回归。
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const { heuristicRoute, routeTask } = await import(pathToFileURL(path.join(srcDir, 'routing.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };
const RC = { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' };
const P = RC.planner, E = RC.executor; // 启发式返回模型名

// —— 启发式标注集（plan / execute / null）——
const LABELS = [
  ['帮我设计一个分布式缓存方案', P],
  ['这个报错怎么修：TypeError: x is not a function', P],
  ['ls 一下当前目录', E],
  ['你好', E],
  ['帮我生成一个完整的贪吃蛇游戏网页', P], // 生成类
  ['写一份项目周报文档', P],              // 生成类
  ['把这句话翻译成英文', E],                 // 走分类器
];
for (const [text, want] of LABELS) {
  const got = heuristicRoute(text, RC);
  ok(got === want, `启发式「${text.slice(0, 18)}」期望 ${want} 实际 ${got}`);
}

// —— 升级检测（Hermes C2）：粘滞 executor + 复杂度信号 ——
const fakeProvider = { chat: async () => ({ text: '{"verdict":"execute"}' }) };
const cfg = { routing: { enabled: true, planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' } };
{
  // 粘滞 + 低复杂度 → 保持 executor
  const r = await routeTask({ cfg, provider: fakeProvider, currentModel: 'deepseek-v4-flash', text: '继续处理这批数据文件并逐一核对输出结果，确认每一项指标都符合预期情况，然后把汇总整理好的内容妥善保存到指定位置以免丢失。整体流程保持不变，无需改动其他部分。', sticky: 'deepseek-v4-flash', sessionStats: { steps: 2, truncated: 0 } });
  ok(r.model === 'deepseek-v4-flash', '低复杂度粘滞应保持 flash（实际 ' + r.model + '）');
}
{
  // 粘滞 + 步数超阈值 → 升级 planner
  const r = await routeTask({ cfg, provider: fakeProvider, currentModel: 'deepseek-v4-flash', text: '继续处理这批数据文件并逐一核对输出结果，确认每一项指标都符合预期情况，然后把汇总整理好的内容妥善保存到指定位置以免丢失。整体流程保持不变，无需改动其他部分。', sticky: 'deepseek-v4-flash', sessionStats: { steps: 12, truncated: 0 } });
  ok(r.model === 'deepseek-v4-pro', '步数超阈值应升级 planner（实际 ' + r.model + '）');
}
{
  // 粘滞 + 截断超阈值 → 升级 planner
  const r = await routeTask({ cfg, provider: fakeProvider, currentModel: 'deepseek-v4-flash', text: '继续处理这批数据文件并逐一核对输出结果，确认每一项指标都符合预期情况，然后把汇总整理好的内容妥善保存到指定位置以免丢失。整体流程保持不变，无需改动其他部分。', sticky: 'deepseek-v4-flash', sessionStats: { steps: 3, truncated: 2 } });
  ok(r.model === 'deepseek-v4-pro', '截断超阈值应升级 planner（实际 ' + r.model + '）');
}
{
  // 分类器给不出结论 → 保守走 planner（第三态）
  const weird = { chat: async () => ({ text: '{"note":"?"}' }) };
  const r = await routeTask({ cfg, provider: weird, currentModel: 'deepseek-v4-flash', text: 'x'.repeat(120) + ' 一个比较复杂的问题' });
  ok(r.model === 'deepseek-v4-pro', '分类器不确定应保守走 planner（实际 ' + r.model + '）');
}

console.log(`routing 基准：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
