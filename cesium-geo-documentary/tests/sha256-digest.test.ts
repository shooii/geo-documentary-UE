import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSha256Digest, sameSha256Digest } from "../packages/content-engine/hash.js";

const DIGEST = "621b7f9e386bbc1349c46303abbf8378edecd5596ad9cb08bfbe37b428833d35";
const OTHER = "94b0dbb8261a0c604af65750a84472c050c8d05f38f1645eb7042b567f0f51d0";

test("normalizeSha256Digest strips the optional sha256: prefix", () => {
  assert.equal(normalizeSha256Digest(DIGEST), DIGEST);
  assert.equal(normalizeSha256Digest(`sha256:${DIGEST}`), DIGEST);
  assert.equal(normalizeSha256Digest(`SHA256:${DIGEST}`), null, "prefix is case-sensitive");
});

test("normalizeSha256Digest rejects anything that is not a 64-hex digest", () => {
  assert.equal(normalizeSha256Digest(""), null);
  assert.equal(normalizeSha256Digest(undefined), null);
  assert.equal(normalizeSha256Digest(42), null);
  assert.equal(normalizeSha256Digest(DIGEST.slice(0, 63)), null, "too short");
  assert.equal(normalizeSha256Digest(`${DIGEST}0`), null, "too long");
  assert.equal(normalizeSha256Digest(`z${DIGEST.slice(1)}`), null, "non-hex char");
  assert.equal(normalizeSha256Digest(`sha256:${DIGEST.slice(0, 10)}`), null, "prefixed but short");
});

test("sameSha256Digest accepts identical digests regardless of prefix", () => {
  assert.equal(sameSha256Digest(DIGEST, DIGEST), true, "both bare");
  assert.equal(sameSha256Digest(`sha256:${DIGEST}`, DIGEST), true, "prefixed vs bare");
  assert.equal(sameSha256Digest(DIGEST, `sha256:${DIGEST}`), true, "bare vs prefixed");
  assert.equal(sameSha256Digest(`sha256:${DIGEST}`, `sha256:${DIGEST.toUpperCase()}`), true, "case-insensitive hex");
});

test("sameSha256Digest rejects different or corrupt digests", () => {
  assert.equal(sameSha256Digest(DIGEST, OTHER), false, "genuinely different hash");
  assert.equal(sameSha256Digest(DIGEST, undefined), false, "missing hash");
  assert.equal(sameSha256Digest("garbage", "garbage"), false, "two equal but invalid strings must not pass");
  assert.equal(sameSha256Digest(`sha256:${DIGEST}`, `sha256:${OTHER}`), false, "prefixed but different");
});
