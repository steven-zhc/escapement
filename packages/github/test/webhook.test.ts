/**
 * The webhook verdict.
 *
 * Pure, so no server and no database. What is being asserted is the security
 * boundary: this endpoint is the one part of the system reachable from the
 * public internet, and without the signature it is a way to make somebody
 * else's machine run agents.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, verifyWebhook } from "../src/index.ts";

const SECRET = "shhh";

const sign = (body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const headers = (body: string, event: string, over: Record<string, string | undefined> = {}) => ({
  [SIGNATURE_HEADER]: sign(body),
  [EVENT_HEADER]: event,
  [DELIVERY_HEADER]: "delivery-1",
  ...over,
});

const issue = (action: string) =>
  JSON.stringify({ action, repository: { name: "nextloom-ai-admin" } });

describe("verifying a delivery", () => {
  it("accepts a correctly signed issues event and says what changed", () => {
    const body = issue("opened");
    const v = verifyWebhook(body, headers(body, "issues"), SECRET);

    expect(v).toEqual({
      ok: true,
      act: true,
      project: "nextloom-ai-admin",
      reason: "issues.opened",
      delivery: "delivery-1",
    });
  });

  it("refuses a body that was tampered with after signing", () => {
    const body = issue("opened");
    const signed = headers(body, "issues");
    // Same signature, different body — which is exactly what an attacker with
    // a captured delivery has.
    const v = verifyWebhook(issue("closed"), signed, SECRET);

    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a delivery signed with the wrong secret", () => {
    const body = issue("opened");
    const v = verifyWebhook(body, { ...headers(body, "issues"), [SIGNATURE_HEADER]: sign(body, "wrong") }, SECRET);
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a delivery with no signature at all", () => {
    const body = issue("opened");
    const v = verifyWebhook(body, { ...headers(body, "issues"), [SIGNATURE_HEADER]: undefined }, SECRET);
    expect(v).toEqual({ ok: false, reason: "no-signature" });
  });

  /**
   * A signature of the wrong length must not reach `timingSafeEqual`, which
   * throws on mismatched buffers — and a thrown exception is a timing signal of
   * its own.
   */
  it("refuses a truncated signature without throwing", () => {
    const body = issue("opened");
    const v = verifyWebhook(body, { ...headers(body, "issues"), [SIGNATURE_HEADER]: "sha256=ab" }, SECRET);
    expect(v).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("acts on a label change, because labels are what decide eligibility", () => {
    const body = issue("labeled");
    const v = verifyWebhook(body, headers(body, "issues"), SECRET);
    expect(v.ok && v.act).toBe(true);
  });

  /**
   * A force-push already invalidates a gate verdict by arithmetic — the verdict
   * names the sha it was about. Acting on a push would mean re-asking GitHub on
   * every commit anybody makes, for nothing.
   */
  it("verifies a push and then does nothing with it", () => {
    const body = JSON.stringify({ repository: { name: "nextloom-ai-admin" } });
    const v = verifyWebhook(body, headers(body, "push"), SECRET);

    expect(v.ok).toBe(true);
    expect(v.ok && v.act).toBe(false);
  });

  it("refuses a body that is not JSON", () => {
    const body = "not json";
    const v = verifyWebhook(body, headers(body, "issues"), SECRET);
    expect(v).toEqual({ ok: false, reason: "malformed" });
  });
});
