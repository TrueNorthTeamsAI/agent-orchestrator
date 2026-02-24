import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySignature } from "../webhook-utils.js";

describe("verifySignature", () => {
  const secret = "test-webhook-secret";
  const body = '{"action":"labeled","issue":{"number":42}}';

  function sign(payload: string, key: string, prefix = ""): string {
    const hmac = createHmac("sha256", key).update(payload).digest("hex");
    return `${prefix}${hmac}`;
  }

  it("verifies valid GitHub signature (with sha256= prefix)", () => {
    const sig = sign(body, secret, "sha256=");
    expect(verifySignature(body, sig, secret, "sha256=")).toBe(true);
  });

  it("verifies valid Plane signature (bare hex)", () => {
    const sig = sign(body, secret);
    expect(verifySignature(body, sig, secret)).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(verifySignature(body, "sha256=invalid", secret, "sha256=")).toBe(false);
  });

  it("rejects null signature", () => {
    expect(verifySignature(body, null, secret)).toBe(false);
  });

  it("rejects signature with wrong secret", () => {
    const sig = sign(body, "wrong-secret", "sha256=");
    expect(verifySignature(body, sig, secret, "sha256=")).toBe(false);
  });
});
