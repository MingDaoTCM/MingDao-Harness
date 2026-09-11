# MingDao Harness v0.4.6 发布说明

> 状态：**已发布**（tag `v0.4.6`；GitHub Release 保留全部安装包附件，官网直连分发）。
> 主题：**迁移至 macOS 后首次全量审计的根因修复**——含 1 项 P0、19 项 P1，以及一次**省钱口径自纠**。
> 完整审计报告见 [AUDIT-v0.4.6.md](AUDIT-v0.4.6.md)（六路并行审计 + 独立复核，逐项 `file:line` 与复现证据）。

---

## ⚠️ 省钱口径自纠（请重点看这一条）

**「综合省 64%」是虚高的，真实值是 51%。** 两处方法学错误：

1. **④ Schema 瘦身 / ⑤ 只读阶段收缩用的是启发式计数**，而这两项是针对 DeepSeek 的省钱主张，应当用随包官方词表的**精确**计数。工具 Schema 是 JSON，结构字符占比 46%，两种计数偏差 1.1–1.8 倍。
2. **⑤ 的基准里维护了一份过期的只读档工具副本**（6 个工具），而实现的只读档自 v0.4.4 起已包含 `task`（描述很长）——真实只读档是「全量的 71%」，即只省 **29%**，不是 52%。

现两项均改为精确计数，只读档集合从 `agent.js` 单源导出，并新增**类别化断言**防止再次虚高。同步修正了 `docs/SAVINGS-BENCHMARK.md` 与 `docs/STRATEGY-NEXT.md`。

| 杠杆 | 旧报 | 真实 |
| --- | --- | --- |
| ④ 工具 Schema 瘦身 | 省 52.1%（1145→549） | **省 48.9%**（1145→585） |
| ⑤ 只读阶段收缩 | 省 52.0%（1145→550） | **省 28.9%**（1145→814） |
| 综合（简单平均） | 省 63% | **省 51%** |

其余 6 个杠杆（缓存 1/30、峰谷半价、Batch 半价、结果截断、精确词表、推理分级）数值不变且可复现。

---

## 修复

### 安全

- **WebUI 权限确认越权代答（P1）**：`/api/permission` 只凭可枚举的 `taskId` 取挂起确认、从不校验 ask id——任何能访问 API 的一方都能替他人正在挂起的「写文件/执行命令」确认直接答「允许」，绕过默认 ask 档唯一的人工闸门。现强制校验服务端下发、仅经该任务 SSE 送达的 ask id（改 `crypto.randomBytes` 生成）。
- **任意环境变量外泄（P1）**：自定义模型的 `envKey`/`baseUrl` 完全由调用方指定，密钥解析会把宿主环境任意变量（`AWS_SECRET_ACCESS_KEY`、`GITHUB_TOKEN`…）当 Bearer 发到攻击者端点；不填 envKey 也回落主密钥。现 envKey 收敛为白名单模式且未声明时**不读任何环境变量**。
- **SSRF 绕过（P1）**：URL 解析器把 `[::ffff:127.0.0.1]` 规范化成 `[::ffff:7f00:1]`，旧判定只认点分四段 → 判为公网，可抓回环 WebUI / 内网服务 / 云元数据。现按数值展开 IPv6 八组判定（覆盖 IPv4-mapped / IPv4-compatible / NAT64 / 链路本地 / 唯一本地），并删除 `server.js` 的重复实现改为单一来源。
- **`deny` 规则 fail-open（P1）**：防 allow 提权的字符白名单被同一函数用于 deny → 命令含 `& ; | @ = ' "` 即失配，auto 档下 deny 形同不存在。现 deny 按命令原文匹配，allow 白名单保留。
- **sync-server 限流绕过（P1）**：桶键用含查询串的 `req.url` → 每个请求加随机 `?x=` 即可绕过（可无限速爆破 + scrypt 阻塞 DoS）。现按 pathname 计数。
- **预设提权防护对对象形态失效（P2）**：`permission` 为文档推荐的 `{mode,allow,deny}` 时被判为 `ask` → 当前只读档可被项目级预设**静默提权**为 ask。现归一化 mode，识别不出时取最保守值。
- **点击劫持防护缺失（P3）**：CSP 的 `frame-ancestors` 不支持 meta 标签，服务端又未下发 HTTP 头 → 任意网页可 iframe 嵌 WebUI 把点击导向权限弹窗「允许」。现统一下发 `frame-ancestors 'none'` / `X-Frame-Options` / `nosniff` / `Referrer-Policy`。
- **审计日志泄漏 URL 内嵌凭据（P2）**：`scheme://user:pass@host`、`glpat-…` 原样落入 `audit.jsonl` 与诊断包（注释声称覆盖、规则里却没有）。现补掩码规则。
- **`config.tools` 子进程不筛敏感环境变量（P3）**：它是唯一不筛的子进程入口（bash/hooks/MCP 都筛）。现复用同一 `buildChildEnv`。
- **TLS 静默降级（P2）**：只配 `SYNC_CERT`/`SYNC_KEY` 之一时拒绝启动（此前静默起明文 HTTP）；非回环明文绑定追加醒目告警。

### 正确性

- **`git` 工具 100% 失效（P1）**：`await execFile(...)` 拿到的是 ChildProcess（非 thenable），输出恒为 `[object Object][object Object]`、退出码与错误全被吞。现 `promisify(execFile)`，`log/status/blame` 返回真实内容、坏 revision 透传 exitCode 128。
- **`edit` 静默写坏文件（P1）**：`new_string` 里的 `$&`/`$'`/`$$` 被当成替换模式（写 shell/模板字符串/正则时静默产生错误内容，甚至复制文件尾部）。现改用函数式替换值。
- **read-after-write 命中旧缓存（P1）**：同回合「read → write → read」第三步返回写入前内容，模型误判写入未生效。现有副作用工具执行后整片作废只读缓存。
- **自动压缩吞掉整段会话（P1）**：`compactTrigger < 0.6` 或 force 时除 system 外全部压成摘要（含最新用户指令），WebUI 还会永久写回会话文件。现夹紧触发线并保证至少保留最近一轮原文。
- **`reasoning_content` 不计入预算（P1）**：思考型会话预算低估达 61 倍。现计入。
- **冲突备份对产品不可见（P1）**：producer 与 consumer 的文件名正则不一致 → 「冲突三选一」100% 失效，且备份被当普通会话推送到其他设备变成幽灵会话。现统一为共享正则并将会话列表/同步排除备份。
- **进程崩溃（P1）**：hooks / MCP 子进程 stdin 无 error 监听，载荷 >64KB 且子进程先退出时 EPIPE 未捕获异常会带走整个进程（WebUI 下所有会话一起死）。现补监听。
- **macOS 长任务无最终答复（P1）**：步数上限的兜底总结因 renderer 已置空而静默丢弃。现重新开启渲染段。
- **子代理费用完全不计（P1）**：子代理 token 从不并入父回合 → CLI/REPL 恒漏计。现并入，且不再对子代理透传 onUsage（避免重复入账）。
- **`undo` 越界回落（P2）**：指定越界 path 时静默「撤销最近一次」，回滚**无关文件**并回报成功。现直接返回边界错误。
- **hook `matcher` 不支持 `|`（P2）**：CONFIG.md 官方示例写 `"write|edit|bash"`，实现只按 `,` 切分 → 按文档写的策略钩子永不触发（fail-open）。现两者都支持。
- **`grep` ReDoS 可绕过（P2）**：`(a|aa)+$` 逃过「嵌套量词」启发式 → 20KB 行同步回溯 >180s，冻结整个 Node 进程。现新增「同前缀歧义分支 + 量词」判定（不误伤 `(foo|bar)+`）+ 5s 总时间预算。
- **`fetch` 上限在整包下载后才判（P2）**：实测服务端写满 30MB 才报错。现先看 Content-Length 再边读边累计，超限立即 cancel。
- **深嵌套 schema 崩溃（P2）**：恶意 MCP `inputSchema` 抛 RangeError 且该会话此后每轮报错。现加深度上限。
- **`SSH_AUTH_SOCK` 被误剥离（P3）**：导致 bash 内 git-over-SSH / ssh-agent 失效。现显式放行。
- **`maxOutputCeiling` 只定义不生效（P3）**：README 的「单次输出上限 384K」在框架里拿不到。现作为显式 `maxOutputTokens` 的硬上限。

### 省钱与费用

- **费用护栏对 9/12 内置模型完全失效（P0）**：`effectivePricing` 在读 `pricing.overrides` 之前就因无内置价返回 null → 无价 → `cost` 记 null（当 0 累计）→ 今日费用看不到消费 → 护栏永不拦截；护栏提示的补救办法恰是这条不生效的路径。gpt-5/qwen/glm/kimi/本地/动态发现模型全部中招。现 overrides 与内置/外部价等价作为来源，并要求仅靠 overrides 供价时 input+output 均为有限正数。
- **启发式计数不是「保守上界」（P1）**：纯标点低估 3 倍、单字母词/随机字母数字 2 倍、纯数字 1.3 倍（10 类样本 6 类偏低），而文档一直声称它是上界 → 非 DeepSeek 模型的预算/压缩/批量预检系统性偏小。现按字符类别 + 连续串估算（标点 1:1、数字 1/2、字母串 ≥1、空白不重复计），11 类样本只剩 3 类轻微低估（≤9%），并**修正了文档里的虚假表述**。
- **峰谷单价按落账时刻判定（P2）**：跨 12:00/18:00 边界的请求错记一档（1M prompt 的 pro 调用 ¥9 vs ¥4.5）。现以请求**发起**时刻为锚点。
- **cache-stats 轮转可丢当天费用（P2）**：只保留最后 1 万行 → `todayCost` 变小、日费用护栏被静默重置。现保留「当天全部 + 最近 KEEP_LINES」。
- **日界/避峰时区错位（P2）**：`beijingToDate` 硬编码 UTC+8，而 `beijingParts` 用可配置时区 → 覆盖 `pricing.timezone` 后日界与 `--offpeak` 顺延错 12 小时。现按目标时区真实偏移换算。
- **Batch `--max-cost` 静默失效（P2）**：无价模型的 Batch 估算返回 0 → 预算拦截恒不触发、`/cost` 把未知显示成免费。现返回 null 并 fail-closed 中止提交。

### 打包、平台与工程

- **`skills-lib/` 未随包分发（P1）**：npm 包与桌面版都缺这个目录，而运行时按 `../skills-lib` 读取（ENOENT 静默吞）→ README/官网主打的「36 个技能」在两条主分发渠道只剩 14 个。现补入 `package.json#files` 与 Electron `extraResources`，并新增静态护栏断言。
- **桌面版版本漂移（P1）**：`desktop/package.json` 停在 0.2.0，而 README 教用户的 `npm run dist:linux|win|mac` 不跑版本同步 → 本地打包产出 0.2.0。现为 4 个 `dist:*` 加 `predist:*` 前置同步。
- **macOS 自启必然失败（P2）**：plist 用 `/bin/sh -c "mingdao web 3820"`，launchd 极简 PATH 下找不到命令，且从不 `launchctl` 注册 → 静默不自启。现改用绝对路径 + 注入 PATH + `launchctl bootstrap/bootout`。
- **日志轮转写放大（P2）**：达上限后每次追加都整文件重写（实测 2000 次追加 ≈1GB I/O），且中文日志因字节/码元单位混用几乎不截断。现按字节定位行边界并轮转到半上限（3000 次追加仅 5 次轮转），顺带把历史 644 日志收权为 600。
- **CI strict 棘轮空转（P2）**：`npm ci` 排在棘轮之后，`npx tsc` 找不到 typescript 时按「0 错误」报 ✅。现 `npm ci` 前置，且棘轮在 tsc 不可用时以退出码 2 显式失败。

### 官网（独立仓库）

- 论坛**板块名未转义**进列表页 `<h2>`（仅搜索分支转了义）→ 可持久化 XSS；
- 论坛限速在 openresty 反代下按 `127.0.0.1` 聚合 → 退化为**全站共享**配额（11 次登录/分钟即锁死全站）；
- `deploy.sh` 不部署 `site/site-stats.mjs`，与 README「服务器以本仓库为唯一事实来源」矛盾。

---

## 测试

- `node test/run-all.mjs` → **6/6 套通过**；smoke 由 74 组提升至 **81 组断言**
- `npm run typecheck` → 0 错误；`scripts/strict-ratchet.mjs` → 0 / 0
- `npm run bench` → **214 断言**全绿（省钱基准：综合 **51%**）
- 新增回归覆盖：写后再读、子代理计费、日志轮转与收权、限流不可绕过、随包资源目录齐全 + 桌面版本一致、冲突备份可见性、`git` 真实语义、IPv4-mapped IPv6 SSRF、无价模型 Batch 费用、URL 凭据脱敏、`undo` 越界报错、hook `|` matcher、预设对象形态提权、`SSH_AUTH_SOCK`、深 schema、`grep` ReDoS、时区感知日界/避峰、峰谷计价锚点、输出上限封顶、自启绝对路径
- **测试自身编码缺陷行为的两处也已修正**：smoke 曾断言 `git status` 在非 git 目录**成功**（只有坏实现才成立），tokenizer 断言锁定旧口径——两者都会让回归测试反过来保护 bug

## 待办

> **发布后更新（2026-09-11）**：本节列出的是 **v0.4.6 当时**的状况。其中影响面最大的三条
> **均已修复**——T15（重复 daemon 并发执行同一任务）与 T14（pause/remove 停不住在途运行）由
> `fix(v0.4.7): 调度生命周期根因` 修复，T10（同会话并发回合未串行化）由
> `fix(v0.4.7): 同一会话并发回合串行化` 修复。完整收口情况见 AUDIT 文档的「后续轮次进展」索引。
> 此处如实保留原文，是为了让读者能看出「当时我们公开承认过什么」。

仍登记 14 项（详见 [AUDIT-v0.4.6.md](AUDIT-v0.4.6.md) 第三节）。影响面最大的三条：

1. **重复 daemon → 同一调度任务被并发执行两次**（T15，lease 自检未取消已启动协程、pidfile 无原子认领）；
2. **调度 pause/remove 无法停止在途运行**（T14，daemon 模式不记录运行中任务 id）；
3. **同会话并发回合未串行化**（T10，可能整文件覆盖丢另一路消息）。

建议 v0.4.7 优先消化这三条，其余（WebUI 任务归属/工作空间围栏、辅助模型调用入账、TUI 边角）随后。
