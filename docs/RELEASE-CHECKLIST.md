# 发版清单（Release Checklist）

> 多版本补齐的**执行顺序**见 `RELEASE-TRAIN.md`（先补历史版本再有序推进，不跳步）。
> npm 首次发布/补发见该文件第 2 步（必须**从 tag** 发布，并用 `--tag backfill` 避免 latest 回退）。

> 起因：2026-09-11 明确发版纪律。**本清单是发版的唯一准入流程**——任何一步没做，就不算发布完成。
> 纪律的核心是两条：**发布前必须由人验收**，以及**发布是三个平台 + 官网的同一批产物**，
> 不允许「GitHub 发了、镜像和官网还是旧版本」这种半发布状态。

---

## 〇、铁律（三条，先记住）

1. **未自检不发版**：全门禁必须绿（见 §1）。
2. **未经人工验收不发版**：必须先在 `http://127.0.0.1:3820` 起 WebUI 让负责人实际点一遍并明确确认，
   确认之前**不创建 tag、不推 tag、不建 Release**。
3. **三平台 + 官网同一批产物**：GitHub / Gitee / GitCode 的 Release 附件与官网下载页指向
   **同一次构建**（同一批 sha256）；缺任何一处都算未发布完成。

> 附件政策（2026-09-11 修订）：**安装包长期保留**，不再从 Release 删除。
> 因此 `scripts/github-release-cleanup.mjs` 默认拒绝执行（需 `--force-delete-assets` 才动手），
> 任何「同步后清理附件」的旧步骤都不要再跑。

---

## 一、发布前自检（必做，全绿才继续）

```bash
cd MingDao-Harness
export MINGDAO_HOME=$(mktemp -d)     # 绝不动真实 ~/.mingdao

npm run typecheck                    # 期望 0 错误
npm run typecheck:strict             # 期望 当前 0 / 基线 0
node test/smoke.js                   # 期望 全部通过（当前 98 组断言）
node test/e2e-local.js               # 期望 全通过
node test/e2e-web.js                 # 期望 全通过
node test/e2e-schedule.js            # 期望 全通过
node test/api-contracts.js           # 期望 全通过
npm run bench                        # 期望 5 个基准 0 失败
node src/cli.js diagnose             # 自检报告（脱敏）
```

补充检查：
- [ ] `package.json` 版本号 = 本次要发布的版本；`CHANGELOG.md` 有对应条目
- [ ] `RELEASE-NOTES-<版本>.md` 已写好（三平台正文共用）
- [ ] `node src/cli.js --version` 与版本号一致
- [ ] 工作区干净（`git status` 无未提交改动），且已推到 `origin/main`

---

## 二、本机人工验收（必做，未确认不得进入 §三）

```bash
cd MingDao-Harness
MINGDAO_HOME=~/.mingdao node src/cli.js web 3820     # 或后台托管：见下
```

- 地址：**http://127.0.0.1:3820**
- 由负责人实际点一遍关键路径（对话、设置、任务面板、Pack 相关界面等），确认无误后**明确回复确认**。
- 验收期间发现问题 → 修 → 回到 §1 重新自检 → 再验收。
- 只有拿到确认，才允许执行 §三。

---

### 2.1 建议实测项（v0.6.0 新增能力，逐条可复现）

界面上点得到：
- [ ] 对话正常（模型调用、流式输出、工具卡片）
- [ ] 设置面板：模型/密钥展示正确
- [ ] 任务面板、调度面板可打开

命令行可复现（新能力，建议逐条跑一遍）：
```bash
mingdao --version
mingdao ledger list                 # 每跑完一次对话就应出现一条账本
mingdao ledger show                 # 人读明细：run.start/model.round/tool.call/…/run.end
mingdao ledger verify               # 哈希链校验（试着改一行账本，应报「前序哈希不匹配」）
mingdao ledger export --format md --out /tmp/led.md   # 导出物应搜不到密钥/私网 IP/家目录
mingdao ledger replay               # 按当前规则重判历史调用（输出四类差异）
mingdao net policy                  # 未配置时应显示「闸门未安装」——零影响
mingdao net report                  # 出网自证（含「只覆盖内核请求」的边界说明）
mingdao pack list                   # 垂域 Pack
mingdao audit                       # 原审计日志行为不变
```
日志与约束：
- [ ] 若配置了 `config.net`（`mode:block` + 空 allow），模型调用应被**明确拒绝**并给出放行指引，
      且 `mingdao net report` 里能看到这次拦截
- [ ] 若挂载了带约束的 Pack，命中红线时输出被改写，且 `mingdao ledger show` 里有 `constraint` 事件

> 验收通过 = 明确回复确认。**确认之前不创建 tag、不推 tag、不建 Release。**

## 三、发布（拿到确认后）

### 3.1 打 tag 并推送（触发桌面版构建与 GitHub Release）

```bash
git tag v<版本> && git push origin v<版本>
```

`desktop.yml` 会在三平台构建并上传安装包到 GitHub Release；正文由工作流写入
（指向本页附件 + 官网校验值，**不再声明附件会被移除**）。

- [ ] GitHub Release 已生成，7 个安装包 + `latest*.yml` 附件齐全
- [ ] Release 正文正确（含官网链接，且无「临时暂存/自动移除」字样）

### 3.2 官网同步安装包与内容

```bash
cd MingDao-Harness-Site
# 1) 服务器 downloads/ 已收到本版本 7 个包（官网收割流程）
# 2) site/index.html 的下载区更新：文件名、体积、sha256 全部换成新版本
# 3) 更新日志 / 版本号相关内容同步
bash deploy.sh
```

- [ ] `site/index.html` 中版本号、每个包的 `href`、体积、`sha256` 均为**本版本**
- [ ] 首页无残留旧版本号（如 `0.4.5`）
- [ ] `bash deploy.sh` 成功，线上页面可访问

### 3.3 Gitee / GitCode 同步发行（含附件）

```bash
cd MingDao-Harness
MINGDAO_GITEE_TOKEN=xxx MINGDAO_GITCODE_TOKEN=yyy \
  bash scripts/publish-mirror-releases.sh <版本> RELEASE-NOTES-<版本>.md
```

- [ ] 两个平台均已有对应 tag（与 GitHub 同 commit）
- [ ] 两个平台的 Release 正文与 GitHub 一致
- [ ] 附件已上传；**gitee 单文件上限 100MB**，AppImage（>100MB）会被脚本跳过并记入日志，
      该包以官网直连为准（正文已带官网链接兜底）
- [ ] 上传耗时较长（约 640MB，3–5 小时），确认脚本在服务器后台跑完且日志出现 `MIRROR_RELEASE_DONE`

### 3.4 收尾核对（防半发布）

- [ ] GitHub / Gitee / GitCode 三处 Release 均存在且正文一致
- [ ] 三处附件为**同一批 sha256**（与官网下载页一致）
- [ ] 官网下载页三平台链接均可用（抽测每个平台至少一个包）
- [ ] `git push` 后 `origin/main` 与本机一致；tag 已推送

---

## 四、常见坑（都踩过）

| 坑 | 现象 | 规避 |
| --- | --- | --- |
| 用 `curl \| bash` 安装 | 下载失败时静默"成功" | 官网已改为「先下载再执行」，安装命令不要回退 |
| 附件被清理 | 第三方镜像/包管理器引用失效 | 政策已废止清理；`github-release-cleanup.mjs` 默认拒删 |
| 只发了 GitHub | 国内用户下载困难、官网是新版本而镜像还是旧版本 | §3.2 / §3.3 必须做，且用 §3.4 核对 |
| gitee AppImage 上传失败 | 单文件 >100MB 被拒，若整轮失败会连带其它包 | 脚本已逐文件判大小并跳过，看日志确认 |
| 在真实 `~/.mingdao` 上跑测试 | 污染用户配置与会话 | 自检一律 `MINGDAO_HOME=$(mktemp -d)` |
| 提交信息里的反引号/`$()` | bash 抢先展开，命令被破坏 | 提交信息用单引号 heredoc |
