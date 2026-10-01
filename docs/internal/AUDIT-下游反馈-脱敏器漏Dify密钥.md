# AUDIT 下游反馈：脱敏器漏掉 Dify 的 `app-` 密钥（v0.6.7）

> 来源：下游（MingDao-TCM-Harness / 明道中医问诊台）在"密钥分发"场景下实测发现。
> 交付方式：本文件与修复一起放在分支 `fix/redact-dify-app-key`，请在上游审阅后合并。

## 一句话

`src/redact.js` 的密钥前缀表覆盖 GitHub / AWS / Slack / Google / `sk-`，**没有 Dify 的 `app-`** ——
于是同一份日志里 DeepSeek 的 key 被掩成 `sk-***`、**Dify 的 key 原样漏出**。
下游是"每位测试人员私下单独发一把密钥"的分发方式，漏这一条等于把该方式废掉。

## 最小复现

```bash
node -e "import('./src/redact.js').then(m=>console.log(m.redactSecrets('dify=app-<24 位 base62> deepseek=sk-<24 位 base62>')))"
```

修复前：

```
dify=app-<24 位 base62> deepseek=sk-***      ← app- 原样漏出
```

修复后：

```
dify=app-*** deepseek=sk-***                          ← 两者同口径
```

## 为什么危险（比"少一条规则"更麻烦的两点）

1. **半掩的假象**：`sk-` 会被正确掩掉，所以贴日志的人（和看日志的人）会以为"已经脱敏了"，
   而真正要防的那把 key 就夹在同一行的下一段里。这比整份都不掩更容易漏出去。
2. **下游的分发方式依赖它**：下游给不同测试人员发不同密钥、以便追溯滥用。
   一旦某人把 `~/.mingdao/diagnose-*.txt`、审计行或一段报错贴到公开渠道，
   泄漏的正是"那一把可追溯到个人"的密钥。

## 影响面（会用 `redactSecrets` 的产物）

`src/audit.js` 已 `export { redactSecrets }`（v0.3.1 P1-1 起统一单一来源），所以修复自动覆盖：

- 审计日志（`audit.jsonl`，本机持久化明文）
- 网关/WebUI 日志与错误消息
- **诊断包**（`diagnose-*.txt`，用户会主动贴到公开渠道的那种产物）
- 会话原文上传前的脱敏（v0.6.3 起接入）

## 修复（已在本分支实施）

`src/redact.js`：

```js
// Dify 的 API Key 形如 `app-` + 一长串 base62（本文件已按公开仓库纪律隐去字面量）。
// 刻意**不含** `-`/`_`：否则 `app-deployment-config-2024` 这类普通标识会被误掩，
// 而脱敏器一旦误伤就会被人关掉。
const APP_KEY = /\bapp-[A-Za-z0-9]{20,}/g;
...
s = s.replace(APP_KEY, 'app-***'); // 保留 app- 前缀（与 sk-*** 同口径）
s = s.replace(KEY_PREFIX, '***');
```

保留 `app-` 前缀而不是整体掩成 `***`，与既有 `sk-***` 同一口径 ——
排查时能看出"配了哪一类 key"，又不暴露内容。

## 测试（已在 `test/smoke.js` 的脱敏段落补三条）

```js
assert.ok(!redactSecrets('dify=app-<24 位 base62>').includes('app-<24 位 base62>'),
  'Dify app- key 必须被掩码');
assert.ok(redactSecrets('app-<24 位 base62>').includes('app-***'), '掩码后应保留 app- 前缀');
assert.ok(redactSecrets('app-deployment-config-2024').includes('app-deployment-config-2024'),
  '普通短横线标识不得被误掩（误伤会让人关掉脱敏）');
```

`node test/smoke.js` → **全部通过：156 组断言**。

## 给上游的落地清单

1. 合并 `fix/redact-dify-app-key`（或手工应用上面两处改动）；
2. 跑 `node test/smoke.js` 确认 156 组通过；
3. 如果有面向下游的发布说明，登记一条"脱敏器补齐 Dify `app-` 前缀"——
   下游跟版本时据此确认自己拿到的是修好的内核。

## 附：这类缺口的结构性成因（供参考，不要求本次处理）

前缀表是**按厂商逐个维护**的，所以每接入一个新厂商就多一个漏点，而且漏了不会报错。
本文件的教训与 v0.6.3 那次（PEM/JWT/赋值式全漏）是同一类：
**"表里有规则"不等于"规则认得你正在用的那种 key"**。
若将来要收敛，可考虑：对"长随机串 + 已知前缀"之外再补一条"高熵判定"兜底，
或让 Pack/Provider 声明自己会用到哪些密钥前缀，由内核汇总进表。
