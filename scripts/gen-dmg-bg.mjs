// 零依赖生成 dmg 背景图（desktop/build/dmg-bg.png，540×380）：
// 深色底 + 淡色「左 → 右」拖动箭头提示（App 拖进 Applications）。纯 Node（node:zlib）PNG 编码。
// 用法：node scripts/gen-dmg-bg.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const W = 540;
const H = 380;
const bg = [15, 17, 21]; // #0f1115
const arrow = [61, 220, 151]; // --green #3ddc97（主色），低透明度与底融合

// —— 形状定义（数学扫描线，无字体无图像库） ——
// 水平箭头：杆身 y∈[170,190]，x∈[120,390]；三角头指向右：顶点 (400,150)/(400,210)/(465,180)
function inArrow(x, y) {
  if (y >= 172 && y <= 188 && x >= 120 && x <= 395) return true;
  const tx = 400, ty1 = 148, ty2 = 212, tipX = 462, tipY = 180;
  // 三角形（三点内测试：边向量叉积同号）
  const cross = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  const d1 = cross(tx, ty1, tx, ty2, x, y);
  const d2 = cross(tx, ty2, tipX, tipY, x, y);
  const d3 = cross(tipX, tipY, tx, ty1, x, y);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// 目标位圆环提示：左 (140,255) 放 App、右 (400,255) 放 Applications（细圆环）
function inRing(cx, cy, r, w, x, y) {
  const d = Math.hypot(x - cx, y - cy);
  return d >= r - w && d <= r + w;
}
function inSpot(x, y) {
  return inRing(140, 255, 46, 2, x, y) || inRing(400, 255, 46, 2, x, y);
}

// —— RGBA 像素 ——
const px = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let r = bg[0], g = bg[1], b = bg[2], a = 255;
    if (inArrow(x, y)) {
      const t = 0.35;
      r = Math.round(bg[0] * (1 - t) + arrow[0] * t);
      g = Math.round(bg[1] * (1 - t) + arrow[1] * t);
      b = Math.round(bg[2] * (1 - t) + arrow[2] * t);
    } else if (inSpot(x, y)) {
      const t = 0.22;
      r = Math.round(bg[0] * (1 - t) + arrow[0] * t);
      g = Math.round(bg[1] * (1 - t) + arrow[1] * t);
      b = Math.round(bg[2] * (1 - t) + arrow[2] * t);
    }
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
}

// —— PNG 编码（IHDR/IDAT/IEND，CRC32 自实现） ——
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// 每行前置 filter byte 0
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'build', 'dmg-bg.png');
fs.writeFileSync(out, png);
console.log('✓ 已生成', out, png.length, '字节');
