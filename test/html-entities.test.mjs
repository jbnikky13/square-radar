import test from "node:test";
import assert from "node:assert/strict";
import { decodeHtmlEntities } from "../src/html-entities.mjs";

test("decodes hexadecimal and decimal apostrophes", () => {
  assert.equal(decodeHtmlEntities("Kwon&#x27;s and users&#39; funds"), "Kwon's and users' funds");
});

test("decodes named punctuation and common entities", () => {
  assert.equal(decodeHtmlEntities("&apos; &rsquo; &ldquo;hello&rdquo; &amp;"), "' ’ “hello” &");
});

test("handles double-encoded entities", () => {
  assert.equal(decodeHtmlEntities("We&amp;#x27;ve"), "We've");
});

test("leaves unknown and invalid entities unchanged", () => {
  assert.equal(decodeHtmlEntities("&unknown; &#x110000;"), "&unknown; &#x110000;");
});
