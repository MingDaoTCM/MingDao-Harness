// 评测基准（Hermes E2-2）：路由准确率标注集 + 升级检测离线回归。
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const { heuristicRoute, routeTask } = await import(pathToFileURL(path.join(srcDir, 'routing.js')).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error('  ✖', msg); } };
const RC = { planner: 'deepseek-v4-pro', executor: 'deepseek-v4-flash' };
const P = RC.planner, E = RC.executor; // 启发式返回模型名

// —— 启发式标注集（plan / execute / null）100 条（Phase B B5 扩充：7 → 100）——
const N = null; // 需要分类器兜底
const LABELS = [
  // 生成类 → planner（20 条）
  ['帮我设计一个分布式缓存方案', P],
  ['帮我生成一个完整的贪吃蛇游戏网页', P],
  ['写一份项目周报文档', P],
  ['帮我写一篇关于 AI Agent 的技术分享 PPT 大纲', P],
  ['开发一个待办事项网站', P],
  ['实现一个完整的 markdown 预览小工具', P],
  ['编写一份详细的项目验收报告', P],
  ['制作一个个人简历网页', P],
  ['生成一份数据清洗脚本的详细说明文档', P],
  ['帮我做一个俄罗斯方块小游戏', P],
  ['创建一份团队介绍页面', P],
  ['写一个五子棋网页版', P],
  ['做一个完整的天气查询应用', P],
  ['编写一个命令行记账工具的详细设计文档', P],
  ['生成一份产品需求文档 PRD', P],
  ['实现一个完整的文件重命名小工具', P],
  ['帮我写一份季度总结报告', P],
  ['开发一个简单的聊天室网页', P],
  ['制作一份技术方案演示 PPT', P],
  ['生成一个完整的单位换算器网页', P],
  // 规划/分析类 → planner（35 条）
  ['这个报错怎么修：TypeError: x is not a function', P],
  ['帮我分析一下这个项目的性能瓶颈', P],
  ['设计一个数据库分库分表方案', P],
  ['评估一下迁移到微服务架构的风险', P],
  ['审查这段代码的安全隐患', P],
  ['重构这个模块应该怎么规划', P],
  ['优化一下这个 SQL 查询的性能', P],
  ['排查内存泄漏的分析思路是什么', P],
  ['Redis 缓存雪崩的解决方案有哪些', P],
  ['这个架构的设计模式选型合理吗', P],
  ['技术债清单怎么梳理，重构优先级如何安排', P],
  ['帮我 review 一下这个 PR 的设计', P],
  ['重构这个函数有什么好的方案', P],
  ['架构评审需要关注哪些点', P],
  ['设计一个限流方案', P],
  ['分析这段日志找根因', P],
  ['这个库的选型评估怎么做', P],
  ['帮我规划一下模块拆分的优化方案', P],
  ['并发竞争问题怎么修复', P],
  ['设计模式在这里适用吗', P],
  ['系统容量评估怎么做', P],
  ['帮我分析一下竞品的功能设计', P],
  ['排查线上 502 的常规思路与修复手段', P],
  ['这个数据迁移方案可行吗', P],
  ['重构一个遗留系统从哪里入手', P],
  ['接口设计评审要点', P],
  ['分析一下这个算法的复杂度', P],
  ['优化前端首屏加载的方案', P],
  ['报错信息看不懂怎么排查', P],
  ['这个 N+1 查询问题怎么修复', P],
  ['微服务拆分方案设计', P],
  ['帮我评估一下这个开源库', P],
  ['系统架构图怎么画更合理', P],
  ['分析一下为什么这段代码这么慢', P],
  ['设计一个幂等方案', P],
  // 长文本规划类（长度 ≥ 40 且 PLAN_HINTS 命中）→ planner（10 条）
  ['请帮我规划一下接下来三天的开发任务安排，包括每天要完成的功能模块、对应的测试要点以及可能遇到的风险和应对措施。', P],
  ['我想请你帮忙排查一个问题：项目在部署到生产环境之后偶尔会出现连接超时，日志里只有模糊的错误信息，需要从头梳理调用链。', P],
  ['我们团队目前的代码审查流程比较随意，想请你帮忙规划一套完整的 review 规范，覆盖提交粒度、审查清单和自动化工具。', P],
  ['最近系统经常在高峰期出现卡顿，请帮我分析可能的原因，包括数据库、缓存、网关和服务本身的负载情况。', P],
  ['请帮我设计一个定时任务系统的整体方案，包括任务调度、失败重试、分布式锁和监控告警几个部分。', P],
  ['有一段历史代码非常难维护，我想重构它，请先帮我分析它的职责边界并给出分步重构计划。', P],
  ['我们想把单体应用逐步拆分成微服务，请帮我评估这个过程的成本和风险，并给出阶段划分建议。', P],
  ['请帮我优化这个页面的性能，先分析首屏渲染慢的原因，再给出具体的优化手段和验证方法。', P],
  ['双十一大促前需要做一次容量评估，请帮我规划压测方案，包括压测场景、指标阈值和回滚预案。', P],
  ['请帮我审查这份技术方案文档的可行性，重点关注数据一致性、故障恢复和灰度发布这几个部分。', P],
  // 简单执行类 → executor（25 条）
  ['你好', E],
  ['ls 一下当前目录', E],
  ['把这句话翻译成英文', E],
  ['今天天气怎么样', E],
  ['1+1 等于几', E],
  ['解释一下什么是闭包', E],
  ['JSON 和 YAML 有什么区别', E],
  ['把这段文字润色一下', E],
  ['给我推荐几本编程书', E],
  ['HTTP 和 HTTPS 的区别', E],
  ['怎么用 git 撤销上一次提交', E],
  ['帮我查一下这个命令的用法', E],
  ['总结一下这段文字', E],
  ['process.nextTick 是什么', E],
  ['把全角标点换成半角', E],
  ['这段代码格式化一下', E],
  ['npm 和 pnpm 的区别', E],
  ['数组去重有哪些方法', E],
  ['给我讲讲 Docker 是什么', E],
  ['把这句话翻译成日语', E],
  ['markdown 表格怎么转 CSV', E],
  ['查看当前目录大小', E],
  ['帮我算一下 15% 折扣后的价格', E],
  ['正则匹配邮箱怎么写', E],
  ['git stash 怎么用', E],
  // 需要分类器兜底 → null（10 条：PLAN_HINTS 命中但短且无强关键词）
  ['怎么修', N],
  ['排查', N],
  ['技术债', N],
  ['roadmap 怎么定', N],
  ['review 一下', N],
  ['plan 一下', N],
  ['refactor', N],
  ['疑难问题', N],
  ['疑难', N],
  ['选型', N],
];
for (const [text, want] of LABELS) {
  const got = heuristicRoute(text, RC);
  ok(got === want, `启发式「${text.slice(0, 18)}」期望 ${String(want)} 实际 ${String(got)}`);
}
ok(LABELS.length === 100, `标注集应为 100 条（实际 ${LABELS.length}）`);

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
