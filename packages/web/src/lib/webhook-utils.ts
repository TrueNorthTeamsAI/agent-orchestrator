/**
 * Webhook utilities — HMAC-SHA256 signature verification and helpers.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify HMAC-SHA256 signature.
 * @param body - Raw request body
 * @param signature - Signature from header
 * @param secret - Shared secret
 * @param prefix - Signature prefix to strip (e.g. "sha256=" for GitHub)
 */
export function verifySignature(
  body: string,
  signature: string | null,
  secret: string,
  prefix: string = "",
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = prefix ? signature.replace(prefix, "") : signature;

  if (expected.length !== actual.length) return false;

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
