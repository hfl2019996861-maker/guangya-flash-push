import assert from "node:assert/strict";
import test from "node:test";

import { extractLinks, normalizeLink } from "../src/shared/link-parser.js";

test("normalizes supported links", () => {
  assert.equal(normalizeLink("magnet:?xt=urn:btih:" + "a".repeat(40))?.type, "magnet");
  assert.equal(
    normalizeLink("magnet:?xt=urn:btmh:" + "0".repeat(64))?.type,
    "magnet"
  );
  assert.equal(
    normalizeLink("ed2k://|file|name.mp4|123|" + "A".repeat(32) + "|/")?.type,
    "ed2k"
  );
  assert.equal(normalizeLink("https://example.com/file.zip")?.type, "http");
});

test("decodes thunder wrappers", () => {
  const encoded = Buffer.from(`AAhttps://example.com/file.zipZZ`).toString("base64");
  const link = normalizeLink(`thunder://${encoded}`);
  assert.equal(link?.type, "thunder");
  assert.equal(link.inner, "https://example.com/file.zip");
});

test("rejects malformed links", () => {
  assert.equal(normalizeLink(""), null);
  assert.equal(normalizeLink(null), null);
  assert.equal(normalizeLink("magnet:?xt=urn:notahash"), null);
  assert.equal(normalizeLink("javascript:alert(1)"), null);
});

test("extracts every unique link from mixed text", () => {
  const text = [
    "first magnet:?xt=urn:btih:" + "a".repeat(40),
    "second ed2k://|file|a.mkv|1|" + "b".repeat(32) + "|/",
    "again magnet:?xt=urn:btih:" + "a".repeat(40),
    "direct https://example.com/a.zip.",
  ].join("\n");
  const links = extractLinks(text);
  assert.deepEqual(links.map((link) => link.type), ["magnet", "ed2k", "http"]);
});
