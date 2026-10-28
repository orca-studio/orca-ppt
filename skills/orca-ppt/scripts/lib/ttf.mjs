// 读 TrueType 字体的名字，把它包成 PowerPoint 认的嵌入字体。纯函数，不碰文件系统。
//
// PowerPoint 的嵌入字体（ppt/fonts/*.fntdata）是 EOT（Embedded OpenType）：原样放 .ttf 它不认，
// 会换成别的字体；套一个不压缩、不加密的 EOT 头就能用（Mac 版 PowerPoint 实测）。
// EOT 头的格式见 W3C 的 EOT 提交稿（https://www.w3.org/Submission/EOT/），头部各字段是小端，字体本身照旧。

function tables(buf) {
  const count = buf.readUInt16BE(4);
  const out = {};
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    out[buf.toString("latin1", at, at + 4)] = { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) };
  }
  return out;
}

/** 名字表里第 id 条，优先 Windows 平台英文（UTF-16BE），没有就取 Mac 平台的 */
function nameOf(buf, id) {
  const t = tables(buf).name;
  if (!t) return "";
  const count = buf.readUInt16BE(t.offset + 2);
  const strings = t.offset + buf.readUInt16BE(t.offset + 4);
  let mac = "";
  for (let i = 0; i < count; i++) {
    const at = t.offset + 6 + i * 12;
    const [platform, , language, nameId, length, offset] = [0, 2, 4, 6, 8, 10].map((d) => buf.readUInt16BE(at + d));
    if (nameId !== id) continue;
    const raw = buf.subarray(strings + offset, strings + offset + length);
    if (platform === 3 && language === 0x409) return Buffer.from(raw).swap16().toString("utf16le");
    if (platform === 1 && !mac) mac = raw.toString("latin1");
  }
  return mac;
}

/** { family, subfamily }：PowerPoint 按 family 找字体，subfamily 是 Regular / Bold / Italic / Bold Italic */
export function fontNames(buf) {
  return { family: nameOf(buf, 1), subfamily: nameOf(buf, 2) };
}

/** 把 .ttf 包成不压缩、不加密的 EOT 2.1，返回 Buffer */
export function eot(buf) {
  const t = tables(buf);
  const os2 = t["OS/2"].offset;
  const u16 = (v) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return b;
  };
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return b;
  };
  const str = (id) => {
    const s = Buffer.from(nameOf(buf, id), "utf16le");
    return Buffer.concat([u16(s.length), s]);
  };
  const version = buf.readUInt16BE(os2);
  const body = Buffer.concat([
    u32(0x00020001), // Version
    u32(0), // Flags：不压缩、不加密
    buf.subarray(os2 + 32, os2 + 42), // PANOSE
    Buffer.from([1, buf.readUInt16BE(os2 + 62) & 1]), // Charset（DEFAULT_CHARSET）、Italic
    u32(buf.readUInt16BE(os2 + 4)), // Weight
    u16(buf.readUInt16BE(os2 + 8)), // fsType
    u16(0x504c), // MagicNumber
    ...[42, 46, 50, 54].map((d) => u32(buf.readUInt32BE(os2 + d))), // UnicodeRange1-4
    ...(version >= 1 ? [78, 82].map((d) => u32(buf.readUInt32BE(os2 + d))) : [u32(0), u32(0)]), // CodePageRange1-2
    u32(buf.readUInt32BE(t.head.offset + 8)), // CheckSumAdjustment
    u32(0), u32(0), u32(0), u32(0), // Reserved1-4
    u16(0), str(1), // FamilyName
    u16(0), str(2), // StyleName
    u16(0), str(5), // VersionName
    u16(0), str(4), // FullName
    u16(0), u16(0), // Padding5、RootStringSize
  ]);
  return Buffer.concat([u32(8 + body.length + buf.length), u32(buf.length), body, buf]);
}

const WEIGHT_NAMES = { 100: "Thin", 200: "ExtraLight", 300: "Light", 400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold", 800: "ExtraBold", 900: "Black" };

/**
 * 字体在 PowerPoint 里叫什么：400 / 700 就是家族名（粗体靠 Bold 那一档），别的字重带上字重名
 * （「Inter SemiBold」）。返回 { family, subfamily }
 */
export function pptxName(family, weight, italic) {
  const bold = weight === 700;
  return {
    family: weight === 400 || bold ? family : `${family} ${WEIGHT_NAMES[weight] ?? weight}`,
    subfamily: [bold ? "Bold" : "", italic ? "Italic" : ""].filter(Boolean).join(" ") || "Regular",
  };
}

const sum = (b) => {
  let s = 0;
  for (let i = 0; i < b.length; i += 4) s = (s + (b.length - i >= 4 ? b.readUInt32BE(i) : Buffer.concat([b.subarray(i), Buffer.alloc(4)]).readUInt32BE(0))) >>> 0;
  return s;
};

/**
 * 改字体的名字（名字表的 1 家族、2 子族、4 全名、6 PostScript 名），去掉 16/17/21/22 这几条另起的家族名，
 * 别的表原样搬过来，重算校验和。返回新的 Buffer
 */
export function renameFont(buf, { family, subfamily }) {
  const t = tables(buf);
  const name = t.name.offset;
  const count = buf.readUInt16BE(name + 2);
  const strings = name + buf.readUInt16BE(name + 4);
  const replaced = new Set([1, 2, 4, 6, 16, 17, 21, 22]);
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = name + 6 + i * 12;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((d) => buf.readUInt16BE(at + d));
    if (!replaced.has(id)) records.push({ platform, encoding, language, id, data: buf.subarray(strings + offset, strings + offset + length) });
  }
  const full = subfamily === "Regular" ? family : `${family} ${subfamily}`;
  const values = { 1: family, 2: subfamily, 4: full, 6: `${family}-${subfamily}`.replace(/[^A-Za-z0-9-]/g, "") };
  for (const [id, text] of Object.entries(values)) {
    records.push({ platform: 1, encoding: 0, language: 0, id: +id, data: Buffer.from(text, "latin1") });
    records.push({ platform: 3, encoding: 1, language: 0x409, id: +id, data: Buffer.from(text, "utf16le").swap16() });
  }
  records.sort((a, b) => a.platform - b.platform || a.encoding - b.encoding || a.language - b.language || a.id - b.id);
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let offset = 0;
  records.forEach((r, i) => {
    [r.platform, r.encoding, r.language, r.id, r.data.length, offset].forEach((v, d) => head.writeUInt16BE(v, 6 + i * 12 + d * 2));
    offset += r.data.length;
  });
  const replacement = { name: Buffer.concat([head, ...records.map((r) => r.data)]) };

  // 重新拼整个字体：表目录按标签排，每张表四字节对齐
  const tags = Object.keys(t).sort();
  const data = tags.map((tag) => Buffer.from(replacement[tag] ?? buf.subarray(t[tag].offset, t[tag].offset + t[tag].length)));
  const headIndex = tags.indexOf("head");
  data[headIndex].writeUInt32BE(0, 8); // checkSumAdjustment 先清零
  const n = tags.length;
  const selector = Math.floor(Math.log2(n));
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(buf.readUInt32BE(0), 0);
  dir.writeUInt16BE(n, 4);
  dir.writeUInt16BE(2 ** selector * 16, 6);
  dir.writeUInt16BE(selector, 8);
  dir.writeUInt16BE(n * 16 - 2 ** selector * 16, 10);
  const parts = [dir];
  let at = dir.length;
  tags.forEach((tag, i) => {
    const d = data[i];
    dir.write(tag, 12 + i * 16, 4, "latin1");
    dir.writeUInt32BE(sum(d), 12 + i * 16 + 4);
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(d.length, 12 + i * 16 + 12);
    const padded = Buffer.concat([d, Buffer.alloc((4 - (d.length % 4)) % 4)]);
    parts.push(padded);
    at += padded.length;
  });
  const out = Buffer.concat(parts);
  const headAt = out.readUInt32BE(12 + headIndex * 16 + 8);
  out.writeUInt32BE((0xb1b0afba - sum(out)) >>> 0, headAt + 8);
  return out;
}
