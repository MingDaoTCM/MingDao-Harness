// 帮助文本的唯一来源（v0.4.7 P3 T22）。
//
// 此前 CLI（src/cli.js）与 REPL（src/commands/repl.js）各存一份 ~50 行的 HELP_LINES，
// 已经真实分叉出三处差异：CLI 有 `--preset` 与 `diagnose`，REPL 有 `/preset`，
// 且互不知晓对方的改动——新增命令时只改一处，另一处永远缺一行，用户看到的帮助取决于
// 他是在 shell 里还是会话内敲的 help。
//
// 现在只有一份正文，两个入口用 variant 声明自己多出来的那几行。差异是**显式的**：
// 想知道两个入口的帮助有何不同，读这一个文件即可。

import fs from 'node:fs';
import { C } from './ui.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/**
 * 生成帮助行。差异项必须在此显式声明，不再各自维护副本。
 * @param {{variant?: 'cli'|'repl', home?: string}} [opts]
 * @returns {Array<[string, string|null]>} [文本, 颜色码]
 */
export function helpLines({ variant = 'cli', home = '' } = {}) {
  const isRepl = variant === 'repl';
  // 仅 CLI 入口才存在的行（REPL 里这些命令要退回 shell 才能用）
  const cliOnly = /** @type {Array<[string, string|null]>} */ (isRepl
    ? []
    : [
        ['  mingdao --preset <名>      应用智能体预设（工具白名单/权限/参数，v0.4.0 契约化）', null],
      ]);
  const diagnoseRow = /** @type {Array<[string, string|null]>} */ (isRepl
    ? []
    : [['  mingdao diagnose           一键生成诊断报告（脱敏打包日志/审计/配置，便于反馈排查）', null]]);
  // 仅会话内才存在的行
  const replOnly = /** @type {Array<[string, string|null]>} */ (isRepl
    ? [['  /preset      列出/切换智能体预设（v0.4.0 契约化）', null]]
    : []);

  return [
    [`MingDao Harness · AI 智能体框架 v${pkg.version}（命令：mingdao，简写 mdh）`, C.bold + C.cyan],
    ['', null],
    ['用法', C.bold + C.yellow],
    ['  mingdao                    交互式对话（TUI）', null],
    ['  mingdao "你的问题"         单次提问（适合脚本与管道）', null],
    ['  mingdao --format json "…"  单次提问，输出结构化 JSON', null],
    ['  mingdao web [端口]        启动 WebUI（默认 http://127.0.0.1:3820）', null],
    ['  mingdao sessions search <词> 全文检索历史会话', null],
    ['  mingdao run "<任务>"     后台启动任务（tasks 面板管理）', null],
    ['  mingdao tasks [watch|kill <id>] 查看/实时刷新/停止后台任务', null],
    ['  mingdao schedule add/list/remove/pause/resume/chain 定时任务与依赖编排', null],
    ['  mingdao autostart on|off    开机自启（登录后自动启动服务器）', null],
    ['  mingdao workspace add/list/use/path/remove 工作空间（项目目录登记与快速切换）', null],
    ['  mingdao --continue         继续最近一次会话', null],
    ['  mingdao --journal          新会话带上最近会话日志（默认不注入，新会话全新开始）', null],
    ['  mingdao --resume           从会话列表选择恢复', null],
    ['  mingdao --model <模型名>   指定模型，例如 deepseek-v4-pro', null],
    ...cliOnly,
    ['  mingdao init               初始化配置向导', null],
    ['  mingdao update [--check]   一键自更新（git 安装形态；--check 只对比版本）', null],
    ['  mingdao rollback           回滚到上次 update 之前的提交', null],
    ['  mingdao audit [数量]       查看工具调用审计日志（默认最近 20 条）', null],
    ...diagnoseRow,
    ['  mingdao desktop            启动桌面版（Electron，任意目录可用，托盘常驻）', null],
    ['  mingdao --help / --version 帮助 / 版本', null],
    ['', null],
    ['凭证管理（API Key 独立存储，绝不写入 config.json / 仓库）', C.bold + C.yellow],
    ['  mingdao key                查看凭证状态（脱敏显示）', null],
    ['  mingdao key set <服务商>   交互式保存 API Key（隐藏输入）', null],
    ['  mingdao key remove <服务商> 删除凭证', null],
    ['  mingdao key import         从环境变量导入所有可用 Key', null],
    ['', null],
    ['云同步与技能库（跨设备会话同步 / 技能安装）', C.bold + C.yellow],
    ['  mingdao sync login <用户名> [密码] <服务器地址> 登录云同步（自动注册）', null],
    ['  mingdao sync push|pull|status|logout  推送 / 拉取 / 状态 / 退出', null],
    ['  mingdao sync-server [端口] 自建云同步服务器（数据目录 /var/lib/mingdao-sync）', null],
    ['  mingdao skill search|install|uninstall|update <名称> 技能库（内置 + 线上 registry）', null],
    ['', null],
    ['会话内命令', C.bold + C.yellow],
    ['  /help        显示帮助          /clear   清空上下文', null],
    ['  /model <名>  切换模型          /mode    pro/flash 快捷切换', null],
    ...replOnly,
    ['  /compact     压缩上下文        /plan    计划模式（先计划后执行）', null],
    ['  /init        生成 AGENTS.md    /memory add <内容> 追加用户记忆', null],
    ['  /skills      列出技能          /status  会话状态 · /cost 累计费用', null],
    ['  /sessions    历史会话/检索    /route on|off 自动路由开关', null],
    ['  /mcp         MCP 服务器状态  /verbose 思考开关 · /title <别名> 会话命名', null],
    ['  /usage       上轮用量          /exit    退出 · /save 会话文件', null],
    ['  /exit        退出              Tab 补全命令 · Ctrl+C 中断生成', null],
    ['', null],
    [`配置目录: ${home}`, C.dim],
  ];
}
