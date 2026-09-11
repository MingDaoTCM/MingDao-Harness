// GitHub Release 附件清理（构建转运资产回收）—— **已于 2026-09-11 废止，默认不再删除**
//
// 为什么保留这个文件而不是删掉：留下废止的原因，比留下一个「谁都不知道为什么没有它」的空缺好。
//
// 政策变更（2026-09-11）：安装包**长期保留**在 Release 上。
//   旧政策（2026-08-28）：附件只作官网收割的「构建转运」，官网同步后由本脚本删除，
//   使 Release 只留指向官网的正文。已废止——用户应能直接从任一平台（GitHub / gitee / gitcode）
//   下载，而不是被引导去单一入口；同时「附件会消失」也让第三方镜像与包管理器无法稳定引用。
//
// 现在的行为：**默认拒绝删除任何东西**并打印本说明。只有在明确知道自己在做什么、
// 且确实需要清理某个 Release 的附件时，才显式加 --force-delete-assets 放行。
//
// 用法：
//   MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs 0.2.2 --dry-run              # 只列出（安全）
//   MINGDAO_GITHUB_TOKEN=<PAT> node scripts/github-release-cleanup.mjs 0.2.2 --force-delete-assets  # 真删（需显式放行）
//
// 约定(与 release 流程一致)：token 只从环境变量 MINGDAO_GITHUB_TOKEN 读取，绝不写入仓库文件。
// 正文在 desktop.yml 发布时已写入，本脚本只动附件、不改正文。

const DRY = process.argv.includes('--dry-run');
// v0.6.0：政策改为「安装包长期保留」后，本脚本的默认动作（删除全部附件）成了一个只差一次误执行
// 就会抹掉全部发行包的开关。因此默认直接拒绝，必须显式 --force-delete-assets 才动手。
const FORCE = process.argv.includes('--force-delete-assets');
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
if (!DRY && !FORCE) {
  console.error('已拒绝执行：2026-09-11 起发行政策改为「安装包长期保留在 Release 上」，本脚本不再删除附件。');
  console.error('  只查看清单：加 --dry-run');
  console.error('  确实要删：  加 --force-delete-assets（会删除该 Release 的全部安装包附件）');
  process.exit(2);
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
