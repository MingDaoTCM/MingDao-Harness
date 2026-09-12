# 发版清单（Release Checklist）

> 多版本补齐的**执行顺序**见 `RELEASE-TRAIN.md`（先补历史版本再有序推进，不跳步）。
> npm 首次发布/补发见该文件第 2 步（必须**从 tag** 发布，并用 `--tag backfill` 避免 latest 回退）。

> 起因：2026-09-11 明确发版纪律。**本清单是发版的唯一准入流程**——任何一步没做，就不算发布完成。
> 纪律的核心是两条：**发布前必须由人验收**，以及**发布是三个平台 + 官网的同一批产物**，
> 不允许「GitHub 发了、镜像和官网还是旧版本」这种半发布状态。

---

## 〇.0 最近一次发布复盘（v0.6.0，2026-09-12）

本次发布**我自己犯了两个错**，都记在这里：

1. **升版本时漏了 `desktop/package.json`** —— 被 smoke 里那条「桌面版版本必须与根一致」的
   静态护栏当场拦下（v0.4.6 审计加的版本漂移防护）。护栏起了作用，说明它值得保留。
2. **更该记的是操作失误**：我把 `node test/smoke.js | tail -1` 串进了 `&&` 链——
   **管道取的是 `tail` 的退出码**，于是 smoke 明明失败、链条照跑，我对着坏提交打了 tag，
   随后不得不删 tag 重打。教训：**判成败要看 `$?`，不要用管道尾部命令代替**；
   写成 `cmd > out 2>&1; echo $?` 或 `set -o pipefail`。

另外新增了 `MingDao-Harness-Site/scripts/update-downloads.mjs`：下载区的机械字段（版本/链接/体积/
sha256/apt 命令/平台标签）自动更新，替代手工逐个替换；数据源取 GitHub Release 的 `digest`，
保证 GitHub / 服务器 / 官网三方一致。

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

### 1.1 推送后必须查 CI（硬规则，2026-09-11 教训）

**每次 `git push` 之后都要确认 CI 结果**，不能假定「本地绿了就是绿了」。本节规则来自一次真实事故：
v0.6.0 C4 起 windows 腿连续 **5 个提交**变红而无人发现——本地是 macOS，跑不到 Windows 分支；
而我没有在推送后查看结果，于是红了一个多小时才被这轮梳理发现。

```bash
# 查最近一次运行的五条腿（含 windows）
curl -s "https://api.github.com/repos/MingDaoTCM/MingDao-Harness/commits/<sha>/check-runs" \
  -H "Accept: application/vnd.github+json" | python3 -c "
import json,sys
for c in json.load(sys.stdin)['check_runs']:
    print(c['name'], c['status'], c['conclusion'])"
```

**日志下载不了怎么办**：`/actions/jobs/{id}/logs` 需要权限（403）。但**注解接口匿名可读**，
因此 ci.yml 的冒烟步骤已改成失败时把断言原文做成 `::error title=冒烟失败（OS / node）::<消息>`：

```bash
curl -s "https://api.github.com/repos/.../check-runs/<check_run_id>/annotations"
```

这条在 T32 的定位中当天就派上用场——没读日志就拿到了失败断言原文。

> 另一条教训（同一次事故）：跨平台断言的能力探测要对应**被测对象是否适用**，
> 而不是「能不能启动解释器」。GitHub 的 windows runner **自带 Git Bash**，
> 所以「有 bash」根本不等于「POSIX 安装器适用」。

### 1.2 发布前凭据泄露核查（每版都做，尤其涉及密钥的操作之后）

发布流程本身会经手 token（gitee/gitcode/npm），因此每版都要核查一次**它们没有进入任何产物或历史**。

```bash
cd MingDao-Harness && set -a && . ./.env && set +a

# ① 工作树（含被忽略文件）里除 .env 自身外不得出现
for n in MINGDAO_GITEE_TOKEN MINGDAO_GITCODE_TOKEN NPM_TOKEN; do
  v=$(eval echo \$$n); [ -n "$v" ] || continue
  grep -rl -F "$v" . 2>/dev/null | grep -v '^\./\.env$' | head
done

# ② git 历史里不得出现
for n in MINGDAO_GITEE_TOKEN MINGDAO_GITCODE_TOKEN NPM_TOKEN; do
  v=$(eval echo \$$n); [ -n "$v" ] || continue
  git grep -F "$v" $(git rev-list --all | head -200) 2>/dev/null | head
done

# ③ 不被跟踪、也不进 npm 包
git ls-files --error-unmatch .env >/dev/null 2>&1 && echo "✗ 被跟踪" || echo "✓ 未被跟踪"
npm pack --dry-run 2>&1 | grep -c '\.env'      # 期望 0

# ④ 诊断包脱敏（用户最可能外发的产物）：把密钥放进环境后生成报告，报告里不得出现
export DEEPSEEK_API_KEY="$NPM_TOKEN" MINGDAO_API_KEY="$MINGDAO_GITEE_TOKEN"
node src/cli.js diagnose    # 然后 grep 报告：三个 token 都不得出现
```

**v0.6.0 发布前实测结果**：① 三项均未出现；② 最近 200 个提交的历史中均未出现；
③ `.env` 未被跟踪、`npm pack` 中 `.env` 条目数 0；④ 诊断报告中三个 token 均未出现。

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

### 3.0 已暴露的**流程缺口**——均已补进本清单

v0.6.0 / v0.6.1 上线后负责人与用户发现下面几个问题，都是**流程漏了一步**，不是代码缺陷：

**① 桌面版无法在线更新** —— 我把自动更新的 feed 收割到了 `/downloads/`，
但桌面版读的是官网 **`/updates/`**（`desktop/main.js` 里写明 `feed: 官网 /updates`）。
`/updates/*.yml` 还停在 0.4.5，于是应用永远认为「已是最新」。
两者格式也不同：`/downloads/` 用 GitHub 直链（CI 生成），`/updates/` 用**官网直链**（发布流程生成）。

```bash
# 已在官网仓库提供生成器，**别再手写**（手写过两次，两次都错）：
ssh mingdao-server 'bash /tmp/gen-update-feeds.sh <版本> <downloads 目录> <updates 目录> https://harness.mingdao.ai/downloads'
#   源文件：MingDao-Harness-Site/scripts/gen-update-feeds.sh（scp 到服务器再跑）
#
#   /updates/latest.yml         → Windows NSIS exe
#   /updates/latest-linux.yml   → Linux AppImage（deb 不支持 electron-updater）
#   /updates/latest-mac.yml     → macOS **两个 zip**（arm64 + x64 合并成一份）
```

> ⚠ **macOS 必须是 zip，不能是 dmg**。v0.6.0 上线后用户报
> 「`ZIP file not provided`」，根因就是 mac feed 指向了 dmg——electron-updater 在 macOS 上
> 要下载 **zip** 解包替换 .app，dmg 只能手动安装。**0.4.5 的 feed 也是 dmg，所以这个错误一直存在**
> （该步由「服务器侧发布流程」生成，长期没人写对）。相应地在**收割步骤**里也要把两个
> `MingDao.Harness-<版本>-{arm64-,}mac.zip` 一并放进 downloads，否则 feed 指向的文件不存在。

```bash
# 验收（三个平台各自取 feed → 下载 → 核对字节 sha512 与 size）：
for f in latest.yml latest-linux.yml latest-mac.yml; do
  curl -s https://harness.mingdao.ai/updates/$f | head -1        # 必须是新版本
done
# 注意：从 HTTP 头取 content-length 要用 `tr -d '\r'` 去掉 CR，否则 "$size" = "$act" 会假失败（我踩过）
```
**验收**：三份 `/updates/*.yml` 的 `version` 都是新版本，且 `curl https://harness.mingdao.ai/updates/latest.yml | head -1` 即为新版本。

**② 代码只推了 tag、没推分支** —— gitee/gitcode 的 `main` 仍停在旧提交（只有 tag 是新的），
用户在镜像上看到的是过期代码；同时 Gitee 的「最新版」标注也因此对不上。

```bash
# 发布时必须把分支与 tag 一起推（tag 触发 CI 构建，分支供人阅读/克隆）
git push <mirror> main:main
git push <mirror> refs/tags/v<版本>:refs/tags/v<版本>
```
**验收**：三平台的 `git ls-remote <url> refs/heads/main` 与本地 `main` 同 SHA；
`git ls-remote <url> 'refs/tags/v<版本>^{}'` 解析到的提交也一致。

**③ 差量更新素材漏采（v0.6.2 起）** —— 此前**三个平台的自动更新每次都整包重下**
（exe 76MB / mac zip 93–101MB / AppImage 104MB）。根因不是功能没做，而是发布链路把
差量素材丢了：CI 的产物 glob 和 Release 上传的 `find` 都没有 `*.blockmap`，
自研的 feed 生成器也没写 `blockMapSize`。三平台机制**各不相同**，别按一个套路处理：

| 平台 | 差量素材 | feed 里需要的字段 |
| --- | --- | --- |
| Windows NSIS `exe` | **独立文件** `<exe URL>.blockmap` | 无 |
| macOS `zip` | **独立文件** `<zip URL>.blockmap` | 无 |
| Linux `AppImage` | **内嵌在文件尾部** | **必须** `blockMapSize` |

依据 electron-updater `providers/Provider.js#getBlockMapFiles`（按 `<安装包 URL>.blockmap`
取；旧版本块映射按「把 URL 里的新版本号替换成当前版本号」取）与
`differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader.js`
（`偏移 = size - (blockMapSize + 4)`，**末尾 4 字节是大端 uint32 的块映射长度**）。
缺素材**不会让更新失败**——electron-updater 捕获异常后回退整包下载——所以这是一个
**静默**降级，不特意查就发现不了。

```bash
# 采集：用脚本，别再手写 /tmp/harvest-<版本>.sh（手写漏过 mac zip，见 ①）
#   scp MingDao-Harness-Site/scripts/harvest-release.mjs mingdao-server:/tmp/
ssh mingdao-server 'MINGDAO_GITHUB_TOKEN=xxx node /tmp/harvest-release.mjs <版本> /opt/1panel/www/sites/mingdao-site/downloads'
#   · 采安装包 + *.blockmap + latest.yml/latest-linux.yml，跳过 latest-mac.yml 与 builder-debug.yml
#   · 每个文件按 GitHub 的 sha256(digest) + size 双校验，不符即删并退出非 0
#   · 末尾会打印「差量更新素材」自查（缺哪个平台的 .blockmap 会直接点名）

# 生成 feed（生成器自身也会打印同一份自查）
ssh mingdao-server 'bash /tmp/gen-update-feeds.sh <版本> <downloads> <updates> https://harness.mingdao.ai/downloads'
```

**验收**：生成器输出里 Windows/mac 三项 `.blockmap` 都是 `✓`，
且 `grep blockMapSize /updates/latest-linux.yml` 有值；`/updates/latest-linux.yml` 的分区
应形如 `size: …` 后紧跟 `blockMapSize: …`。

> 收益的时间线要说清楚：差量下载需要**本机已缓存上一版的安装包**，且需要**上一版的块映射**
> 在服务器上。而 0.6.1 及以前从未发布过 `.blockmap`，所以第一个真正吃到差量的是
> **从 v0.6.2 升到 v0.6.3** 的「一路自动更新上来的」用户；手工下载安装的用户没有缓存，
> 仍然整包下载。别在发布说明里写成「更新体积立刻变小」。

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
