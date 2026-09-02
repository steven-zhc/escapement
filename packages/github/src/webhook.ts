/**
 * Verifying a GitHub delivery, and deciding whether it means anything.
 *
 * Pure: it takes a body, some headers and a secret, and returns a verdict. The
 * appending is the caller's job, which is what lets this be tested without a
 * database and without an HTTP server.
 *
 * ## The signature check is the whole security boundary
 *
 * A webhook endpoint is the one part of this system reachable from the public
 * internet, and anybody can POST to it. Without the signature it is a way to
 * make somebody else's machine run agents. So the comparison is
 * constant-time — `timingSafeEqual`, on buffers of equal length, which is why
 * the length is checked first rather than left to throw — and a delivery that
 * fails is dropped and counted rather than logged with its body.
 *
 * ## Idempotence
 *
 * GitHub retries a delivery several times on any non-2xx, and will happily
 * send the same `X-GitHub-Delivery` again. Since the only effect of a delivery
 * here is "ask GitHub what the queue is", a duplicate is close to harmless —
 * but it still wakes the conductor, and waking it four times for one issue is
 * how a rate limit gets hit. The delivery id is carried on the event so the
 * caller can drop one it has already seen.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-hub-signature-256";
export const EVENT_HEADER = "x-github-event";
export const DELIVERY_HEADER = "x-github-delivery";

export type WebhookVerdict =
  /** Verified, and it means the queue may have changed. */
  | { ok: true; act: true; project: string; reason: string; delivery: string }
  /** Verified, and it means nothing to us. */
  | { ok: true; act: false; reason: string; delivery: string }
  /** Not verified. Nothing is done, and the reason never quotes the body. */
  | { ok: false; reason: "no-signature" | "bad-signature" | "malformed" };

/**
 * Which `issues` actions can change what is runnable.
 *
 * `labeled` and `unlabeled` are in here because the recipe decides eligibility
 * from labels — an issue becoming a `bug` is an issue becoming runnable, and it
 * is the case somebody will actually use.
 */
const ISSUE_ACTIONS = new Set([
  "opened",
  "reopened",
  "closed",
  "labeled",
  "unlabeled",
  "edited",
]);

export function verifyWebhook(
  body: string,
  headers: Record<string, string | undefined>,
  secret: string,
): WebhookVerdict {
  const signature = headers[SIGNATURE_HEADER];
  const delivery = headers[DELIVERY_HEADER] ?? "";
  if (!signature) return { ok: false, reason: "no-signature" };

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length first: `timingSafeEqual` throws on a mismatch, and a thrown
  // exception is a timing signal of its own.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: { action?: string; repository?: { name?: string } };
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const event = headers[EVENT_HEADER] ?? "";
  const project = payload.repository?.name;
  if (!project) return { ok: true, act: false, reason: `${event}: no repository`, delivery };

  if (event === "issues" && payload.action && ISSUE_ACTIONS.has(payload.action)) {
    return { ok: true, act: true, project, reason: `issues.${payload.action}`, delivery };
  }

  // `push` deliberately does nothing. A force-push already invalidates a gate
  // verdict by arithmetic — the verdict names the sha it was about — so there
  // is nothing for a push to trigger that is not already handled, and acting on
  // one would mean re-asking GitHub on every commit anybody makes.
  return { ok: true, act: false, reason: `${event}.${payload.action ?? ""}`, delivery };
}
