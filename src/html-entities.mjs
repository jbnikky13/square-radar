const NAMED_ENTITIES = Object.freeze({
  amp: "&", apos: "'", quot: '"', lt: "<", gt: ">",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
  copy: "©", reg: "®", trade: "™",
  euro: "€", pound: "£", yen: "¥", cent: "¢"
});

function decodeEntity(entity) {
  if (entity[0] === "#") {
    const hex = entity[1]?.toLowerCase() === "x";
    const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)) return null;
    try { return String.fromCodePoint(value); } catch { return null; }
  }
  return Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : null;
}

// Decode RSS/article text, including hexadecimal and decimal numeric references.
// A second pass handles common double-encoded feeds without unbounded recursion.
export function decodeHtmlEntities(value) {
  let text = String(value ?? "");
  for (let pass = 0; pass < 2; pass++) {
    const decoded = text.replace(/&(#x[\da-f]+|#\d+|[a-z][a-z\d]+);/gi, (match, entity) => {
      const replacement = decodeEntity(entity);
      return replacement === null ? match : replacement;
    });
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}
