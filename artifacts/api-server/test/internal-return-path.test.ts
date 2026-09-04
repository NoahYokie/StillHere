import assert from "node:assert/strict";
import { getValidInternalReturnPath } from "../../stillhere-web/src/lib/internal-return-path";

const validPaths = [
  "/family",
  "/watched/list",
  "/inbox?tab=requests#pending",
];

for (const path of validPaths) {
  assert.equal(getValidInternalReturnPath(path), path);
}

const invalidPaths = [
  null,
  "",
  "family",
  "https://example.com",
  "javascript:alert(1)",
  "//example.com/path",
  "/%2Fexample.com/path",
  "/javascript:alert(1)",
  "/\\example.com/path",
  "/bad%escape",
  "/family\n/inbox",
];

for (const path of invalidPaths) {
  assert.equal(getValidInternalReturnPath(path), null, `expected ${String(path)} to be rejected`);
}

console.log("internal return path tests passed");
