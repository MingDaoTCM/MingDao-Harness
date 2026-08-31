---
name: release-checklist
description: 准备发布新版本、打包交付前使用
---

# 发布检查清单

按顺序逐项确认，全部通过才可发布：

1. **测试**：全量测试通过，记录命令与结果（`npm test` / `pytest` 等）。
2. **版本**：版本号统一（package.json / 配置 / 文档互相一致），遵循语义化版本。
3. **变更说明**：changelog 用用户语言描述新增/修复/破坏性变更。
4. **构建验证**：实际构建/打包一次，并在干净环境验证产物可安装可运行。
5. **桌面版打包冒烟（0.2.2 事故护栏，发版必经）**：主进程模块求值必须真实跑通打包产物——
   - CI 已内置：desktop.yml 在 Linux 腿用 xvfb 运行 `dist/linux-unpacked/mingdao --no-sandbox`（`MINGDAO_DESKTOP_SMOKE=1`），模块求值通过输出 `MINGDAO_DESKTOP_SMOKE_OK` 并退出 0，否则 workflow 失败；
   - 本地有显示器时可加验：`cd desktop && MINGDAO_DESKTOP_SMOKE=1 dist/linux-unpacked/mingdao --no-sandbox`（AppImage 加 `--appimage-extract-and-run`）；
   - 教训：0.2.2 三平台启动即崩（main.js 顶层调用 createLogWriter 漏导入），打包期不报错、运行期才炸——静态护栏（test/smoke.js「桌面主进程静态护栏」组）与打包冒烟双保险。
6. **敏感信息**：密钥、token、内网地址、个人信息不得进入仓库与产物（`grep -rE 'sk-[A-Za-z0-9]{20,}' .`）。
7. **回滚方案**：明确如何回退到上一版本（旧包/旧 tag 可恢复）。
8. **发布后冒烟**：发布完成后立即做一次端到端验证。

## 桌面版发布流水线（官网分发 + 镜像 + 转运附件回收）

1. `npm version <v>`（preversion 自动跑 smoke/e2e/bench，version 钩子自动插 changelog，postversion 自动提交）→ 推 3 远端 + tag。
2. `npm publish` → GitHub desktop.yml CI 全绿（含打包冒烟）。
3. 服务器收割：`/tmp/harvest-<ver>.sh`（下载 7 安装包 + 2 yml，sha512 交叉校验 MATCH，再生成官网 3 份 feed）。
4. 官网 site/index.html 刷新版本/大小/sha256 校验行并部署；BBS 随 deploy.sh 重启。
5. gitee/gitcode 创建 Release（正文指向官网，无附件）。
6. 官网同步确认后：`MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs <版本号>` 删除 GitHub 转运附件（先 --dry-run）。

## 输出

给出「检查表 + 每项结论（✅/❌）+ 未通过项的修复建议」，发布动作本身必须等用户确认。
