---
name: git-workflow
description: Git 团队协作工作流（分支/PR/合并/冲突解决/回滚）
---

# Git 团队协作工作流

任务涉及分支管理、Pull Request、合并、冲突或回滚时使用。

## 步骤

1. 先 `git status` / `git log --oneline -10` 了解现状，不猜测。
2. 功能开发：新分支命名 `feat/<描述>`，修复 `fix/<描述>`（kebab-case）。
3. 提交粒度：一次提交只做一件事；提交信息用约定式提交（参考 git-commit 技能）。
4. 合并前先 `git fetch` 再对比 `origin/main`，有分歧先 rebase/merge 解决。
5. 冲突解决：逐文件查看 `<<<<<<<` 标记，保留双方意图，解决后 `git add` 再完成合并。

## 检查点

- 不直接向 main/master 提交（除非用户明确要求）；
- 不执行 `git push --force` 到共享分支；
- 危险操作（reset --hard、删除远程分支）先说明后果并等确认。

## 输出

给出「现状 → 建议步骤 → 已执行命令与结果」，每步命令附一句说明。
