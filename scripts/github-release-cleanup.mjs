// GitHub Release 附件自动清理（构建转运资产回收）
//
// 背景：GitHub Release 的安装包附件只作为官网收割的「构建转运」暂存——CI 上传后由服务器从
// https://github.com/.../releases/download/<tag> 下载收割，官网 feed / 校验值就以服务器资产为准。
// 官网已同步后，本脚本删除这些转运附件，使 GitHub Release 只保留指向官网的正文（避免第三方直接
// 走 GitHub 下载、也减少仓库附件体积）。
//
// 用法：
//   MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs 0.2.2
//   MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs 0.2.2 --dry-run   # 只列出不删
//
// 约定(与 release 流程一致)：token 只从环境变量 MINGDAO_GITHUB_TOKEN 读取，绝不写入仓库文件。
// 正文(指向官网)在 desktop.yml 发布时已写入，本脚本只删附件、不改正文。
//
// 删除哪些附件：Release 上的全部 assets——它们都是构建转运产物（7 个安装包 + latest*.yml）。
// 用 dry-run 先看清单，确认无误再真删。

const DRY = process.argv.includes('--dry-run');
const V = process.argv.filter((a) => /^\d+\.\d+\.\d+/.test(a))[0];
const TOKEN = process.env.MINGDAO_GITHUB_TOKEN;

if (!V) {
  console.error('用法: MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs <版本号> [--dry-run]');
  process.exit(1);
}
if (!TOKEN) {
  console.error('缺少 MINGDAO_GITHUB_TOKEN 环境变量');
  process.exit(1);
}

const REPO = 'MingDaoTCM/MingDao-Harness';
const TAG = `v${V}`;
const API = `https://api.github.com/repos/${REPO}`;

async function gh(path, method = 'GET', body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${method} ${path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  let rel;
  try {
    rel = await gh(`/releases/tags/${TAG}`);
  } catch (e) {
    // 归档或不存在
    console.error(`获取 Release ${TAG} 失败：${e.message}`);
    process.exit(1);
  }
  const assets = rel.assets || [];
  console.log(`Release ${TAG}：${assets.length} 个附件`);
  if (assets.length === 0) {
    console.log('无需清理（已是空附件）');
    return;
  }

  for (const a of assets) {
    const act = DRY ? '[dry] 将删除' : '删除';
    console.log(`${act} ${a.name} (${(a.size / 1048576).toFixed(1)}MB)`);
    if (!DRY) {
      await gh(`/releases/assets/${a.id}`, 'DELETE');
    }
  }
  console.log(DRY ? `dry-run 完成：共 ${assets.length} 个附件（未实际删除）` : `已清理 ${TAG} 全部 ${assets.length} 个转运附件`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
