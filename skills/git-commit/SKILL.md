---
name: git-commit
description: 生成规范的 Git 提交信息（Conventional Commits），或用户要求写 commit message / 提交代码时使用
---

# Git 提交规范

## 格式

```
<type>(<scope>): <subject>

<body>（可选，说明动机而非过程）
```

- type：`feat` 新功能 / `fix` 修复 / `docs` 文档 / `refactor` 重构 / `test` 测试 / `chore` 杂务 / `style` 格式 / `perf` 性能 / `ci` 流水线
- subject：≤50 字的中文祈使句，不加句号
- 一条 commit 只做一件事；混在一起的改动先拆分

## 工作流

1. `git status` / `git diff --stat` 查看改动范围
2. 需要时 `git diff <file>` 细看关键改动
3. 按规范撰写，用 `git commit -m` 提交前把完整信息展示给用户确认

## 示例

```
feat(export): 支持导出 Markdown 报告

新增 --format md 选项，复用现有模板渲染管线。
```
