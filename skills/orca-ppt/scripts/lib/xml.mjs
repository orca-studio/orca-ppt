// 够读 PPTX 部件用的 XML 解析：元素、属性、文字。不认 DTD，不展开实体以外的东西。
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENTITIES[e] ?? m),
  );

/** 返回根元素：{ name, attrs, children: [元素…], text } */
export function parseXml(src) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const top = stack.at(-1);
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (top.name !== m[2]) throw new Error(`XML 标签没对上：</${m[2]}>，应该是 </${top.name}>`);
      stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: "" };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error(`XML 没闭合：<${stack.at(-1).name}>`);
  return root.children[0];
}

/** 深度优先找所有叫 name 的后代（含自己）。 */
export function findAll(el, name, out = []) {
  if (el.name === name) out.push(el);
  for (const c of el.children) findAll(c, name, out);
  return out;
}
export const find = (el, name) => findAll(el, name)[0];
export const child = (el, name) => el.children.find((c) => c.name === name);
