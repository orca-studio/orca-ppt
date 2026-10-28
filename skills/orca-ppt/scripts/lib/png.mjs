// 读 PNG 看它有没有透明的地方。纯函数，不碰文件系统。
//
// 导出 PPTX 时截的图都是 PNG（带透明）。整块不透明的（整页的照片、油画背景）改存 JPG，小七八倍；
// 带透明的（抠图的物件、灯）只能留 PNG。
import { inflateSync } from "node:zlib";

/** 每个像素都不透明：没有 alpha 通道，或者 alpha 全是 255。只认 8 位、不隔行的 PNG（浏览器截图就是这样） */
export function opaque(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const [depth, color, , , interlace] = buf.subarray(24, 29);
  if (color === 2 || color === 0) return true; // RGB、灰度：没有 alpha
  if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 4)) return false; // 认不了的按透明算，留 PNG
  const bpp = color === 6 ? 4 : 2;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const data = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    const row = Buffer.from(data.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    // 反过滤（PNG 规范 9.2）：每个字节加回左边、上边或左上的值
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      if (filter === 1) row[x] += a;
      else if (filter === 2) row[x] += b;
      else if (filter === 3) row[x] += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
    }
    for (let x = bpp - 1; x < stride; x += bpp) if (row[x] !== 255) return false;
    prev = row;
  }
  return true;
}
