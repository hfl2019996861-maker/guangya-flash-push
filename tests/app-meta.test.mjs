import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, GITHUB_URL } from "../src/shared/app-meta.js";

test("compares release versions", () => {
  assert.equal(compareVersions("v2.10.0", "v2.9.0"), 1);
  assert.equal(compareVersions("2.1.6", "2.1.5"), 1);
  assert.equal(compareVersions("2.1.6", "v2.1.6"), 0);
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
});

test("uses the configured repository", () => {
  assert.match(GITHUB_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
});
