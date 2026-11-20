/**
 * Normalize a sha256 digest that may carry the optional `sha256:` prefix used
 * by stableNarrationTextHash(), returning the bare 64-char lowercase hex.
 *
 * The Edge WordBoundary stream records a bare hex digest in the word-timestamps
 * payload while duration.json's narrationTextHash keeps the `sha256:` prefix.
 * Both encodings describe the same digest; callers must compare the normalized
 * form, but still reject any value that is not a well-formed sha256 hex (a
 * missing/corrupt hash must never pass as "same source").
 *
 * Returns null for anything that is not a valid sha256 digest, so callers can
 * treat null as a hard failure rather than accidentally comparing two bad
 * strings as equal.
 */
export function normalizeSha256Digest(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-fA-F]{64}$/.test(bare) ? bare.toLowerCase() : null;
}

/** True only when both values are valid sha256 digests of the same text. */
export function sameSha256Digest(left: unknown, right: unknown): boolean {
  const a = normalizeSha256Digest(left);
  const b = normalizeSha256Digest(right);
  return a !== null && b !== null && a === b;
}
