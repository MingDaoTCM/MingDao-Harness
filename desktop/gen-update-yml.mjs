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

function entry(file) {
  const p = path.join(dist, file);
  if (!fs.existsSync(p)) return null;
  const st = fs.statSync(p);
  return {
    url: `${base}/${file}`,
    sha512: crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64'),
    size: st.size,
  };
}

function writeYml(name, pathName, e) {
  if (!e) return;
  const yml =
    ['version: ' + ver, 'files:', '  - url: ' + e.url, '    sha512: ' + e.sha512, '    size: ' + e.size, 'path: ' + pathName, 'sha512: ' + e.sha512, 'releaseDate: "' + new Date().toISOString() + '"'].join('\n') + '\n';
  fs.writeFileSync(path.join(dist, name), yml);
  console.log('[update-yml] 生成 ' + name + ' → v' + ver);
}

if (process.platform === 'win32') {
  writeYml('latest.yml', `mingdao-setup-${ver}-x64.exe`, entry(`mingdao-setup-${ver}-x64.exe`));
} else if (process.platform === 'linux') {
  writeYml('latest-linux.yml', `mingdao-${ver}-x86_64.AppImage`, entry(`mingdao-${ver}-x86_64.AppImage`));
} else {
  console.log('[update-yml] macOS：跳过（官网 feed 由发布流程生成合并版 latest-mac.yml）');
}
