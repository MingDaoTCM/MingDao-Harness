## 这个 PR 做什么

（一句话。修 bug 请写"复现 → 根因 → 修法"。）

## 复现（修 bug 必填）

```
命令 / 探针 / 失败的断言，以及修复前的实际输出
```

## 修复前后的行为

| | 修复前 | 修复后 |
| --- | --- | --- |
| | | |

## 门禁

- [ ] `npm run typecheck` 与 `npm run typecheck:strict`
- [ ] `node test/smoke.js`（新增了第 ___ 节）
- [ ] `node test/mutate/run.mjs`（新增 ___ 条变异，全部被抓到）
- [ ] `node test/e2e-local.js` / `e2e-web.js` / `e2e-schedule.js` / `test/api-contracts.js`
- [ ] `npm run bench`
- [ ] `node scripts/doc-lint.mjs`（改了文档/API/命令表时）

## 已知边界（没覆盖什么）

（本项目最看重的部分：如实写清这次**没有**覆盖的场景、平台或输入。）
