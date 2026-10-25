function clean(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractMedia(block) {
  const match = block.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*(?:url|href)=["']([^"']+)["']/i);
  return match ? match[1] : "";
}

export function parseItems(xml, source) {
  const items = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const get = (tag) => {
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expression = new RegExp("<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)<\\/" + escaped + "\\s*>", "i");
      const found = block.match(expression);
      if (!found) return "";
      return clean(found[1].replace(/^\s*<!\[CDATA\[/i, "").replace(/\]\]\s*$/i, ""));
    };
    const link = get("link") || ((block.match(/<link>([^<]+)/i) || [])[1] || "");
    const title = get("title");
    const description = [get("content:encoded"), get("content"), get("description"), get("summary")]
      .sort((a, b) => b.length - a.length)[0] || "";
    if (title && link) {
      items.push({
        source, title, description, link,
        pubDate: get("pubDate") || get("published") || get("updated"),
        imageUrl: extractMedia(block)
      });
    }
  }
  return items;
}
