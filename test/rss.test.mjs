import test from "node:test";
import assert from "node:assert/strict";
import { parseItems } from "../src/rss.mjs";

test("parses multiple RSS items and keeps their source", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>First story with a useful headline</title><link>https://example.com/1</link><description>Short summary.</description></item>
    <item><title>Second story with another useful headline</title><link>https://example.com/2</link><description>Another summary.</description></item>
  </channel></rss>`;
  const items = parseItems(xml, "Fixture Feed");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "First story with a useful headline");
  assert.equal(items[1].link, "https://example.com/2");
  assert.equal(items[0].source, "Fixture Feed");
});

test("prefers the longest content field and strips CDATA and HTML", () => {
  const body = "A detailed article body with enough information for the reader.";
  const xml = `<rss><item><title>Story</title><link>https://example.com/story</link>
    <description>Short description</description>
    <content:encoded><![CDATA[<p>${body}</p>]]></content:encoded>
  </item></rss>`;
  const [item] = parseItems(xml, "Test");
  assert.ok(item.description.includes(body));
  assert.ok(!item.description.includes("<p>"));
  assert.ok(!item.description.includes("CDATA"));
});

test("extracts image media and ignores items without title or link", () => {
  const xml = `<rss>
    <item><title>Story with image</title><link>https://example.com/story</link><media:thumbnail url="https://example.com/image.jpg"/></item>
    <item><title>Missing link</title></item>
  </rss>`;
  const items = parseItems(xml, "Test");
  assert.equal(items.length, 1);
  assert.equal(items[0].imageUrl, "https://example.com/image.jpg");
});

test("returns an empty list for empty or malformed non-item input", () => {
  assert.deepEqual(parseItems("", "Test"), []);
  assert.deepEqual(parseItems("<rss><channel>nothing here</channel></rss>", "Test"), []);
});
