// CI 打包后执行（working-directory: desktop）：生成 electron-updater 更新清单并放入 dist/，
// 由后续步骤上传到 GitHub Release。
//  - Windows → latest.yml（NSIS exe）
//  - Linux   → latest-linux.yml（AppImage；deb 不支持 electron-updater）
//  - macOS   → 跳过：latest-mac.yml 需双架构合并，且 0.1.60+ 安装已走官网 generic feed
//    （harness.mingdao.ai/updates/latest-mac.yml，发布流程在服务器上生成）
// 本清单供「0.1.59 及更早的 github 渠道安装」从 GitHub Releases 自动更新。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ver = JSON.parse(fs.readFileSync(path.join('package.json'), 'utf8')).version;
const dist = 'dist';
const base = `https://github.com/MingDaoTCM/MingDao-Harness/releases/download/v${ver}`;

function entry(file, blockMapSize = null) {
  const p = path.join(dist, file);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  const e = {
    url: `${base}/${file}`,
    sha512: crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64'),
    size: st.size,
  };
  // AppImage 的差量更新全靠这个字段：块映射内嵌在文件尾部，electron-updater 按
  // 偏移 = size - (blockMapSize + 4) 定位（differentialDownloader/
  // FileWithEmbeddedBlockMapDifferentialDownloader）。缺了它只能整包重下 ~104MB。
  // Windows NSIS 与 macOS zip **不用**这个字段——它们读独立的 `<安装包>.blockmap`。
  if (blockMapSize != null) e.blockMapSize = blockMapSize;
  return e;
}

// electron-builder 自己也会在 dist/ 写一份 latest*.yml（generic provider，url 指向官网）。
// 本脚本把它**改写**成 GitHub 渠道的 url；改写前必须先把 builder 写好的 blockMapSize 读出来，
// 否则覆盖后该字段就丢了——这正是 v0.6.0 及以前 Linux 差量一直不工作的原因。
function readBlockMapSize(ymlName) {
  try {
    const m = fs.readFileSync(path.join(dist, ymlName), 'utf8').match(/^\s+blockMapSize:\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : null;
  } catch {
    return null; // builder 没生成 / 本就无此字段 → 不写该字段，与历史行为完全一致
  }
}

function writeYml(name, pathName, e) {
  if (!e) return;
  const lines = ['version: ' + ver, 'files:', '  - url: ' + e.url, '    sha512: ' + e.sha512, '    size: ' + e.size];
  if (e.blockMapSize != null) lines.push('    blockMapSize: ' + e.blockMapSize);
  lines.push('path: ' + pathName, 'sha512: ' + e.sha512, 'releaseDate: "' + new Date().toISOString() + '"');
  fs.writeFileSync(path.join(dist, name), lines.join('\n') + '\n');
  console.log('[update-yml] 生成 ' + name + ' → v' + ver + (e.blockMapSize != null ? `（blockMapSize=${e.blockMapSize}，可差量更新）` : '（无 blockMapSize）'));
}

if (process.platform === 'win32') {
  const f = `mingdao-setup-${ver}-x64.exe`;
  writeYml('latest.yml', f, entry(f, readBlockMapSize('latest.yml')));
} else if (process.platform === 'linux') {
  const f = `mingdao-${ver}-x86_64.AppImage`;
  writeYml('latest-linux.yml', f, entry(f, readBlockMapSize('latest-linux.yml')));
} else {
  console.log('[update-yml] macOS：跳过（官网 feed 由发布流程生成合并版 latest-mac.yml）');
}
