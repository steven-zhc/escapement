/**
 * The one endpoint reachable from outside.
 *
 * A verified `issues` delivery appends `QueueChanged`, and the daemon — which
 * already wakes on appends — asks GitHub what the queue is now. One mechanism
 * rather than two: the webhook does not need a socket to the daemon, and the
 * daemon does not need to know a webhook exists.
 *
 * **It lives on the board, and that does not contradict [0013].** The board is
 * a reader and a controller: it renders `task_view` and it appends decisions.
 * This appends a fact. What it never does is hold a run, which is the actual
 * dividing line.
 *
 * ## It is an optimisation, not a dependency
 *
 * This machine has no public address, so a delivery only arrives through a
 * tunnel somebody has set up. The daemon sweeps GitHub on a long interval
 * regardless, so a webhook that never arrives costs latency and nothing else —
 * which is the property that makes it safe to leave unconfigured.
 */
import { verifyWebhook, DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER } from "@escapement/github";
import { CONTROL_STREAM } from "@escapement/daemon";
import { eventStore } from "@escapement/store";
import { parsePayload } from "@escapement/core";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const secret = process.env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) {
    // Not configured is not an error to shout about — the sweep covers it — but
    // returning 200 would tell GitHub the delivery landed when it did not.
    return new Response("webhooks are not configured", { status: 503 });
  }

  const body = await request.text();
  const verdict = verifyWebhook(
    body,
    {
      [SIGNATURE_HEADER]: request.headers.get(SIGNATURE_HEADER) ?? undefined,
      [EVENT_HEADER]: request.headers.get(EVENT_HEADER) ?? undefined,
      [DELIVERY_HEADER]: request.headers.get(DELIVERY_HEADER) ?? undefined,
    },
    secret,
  );

  if (!verdict.ok) {
    // The reason, never the body. An unverified delivery is attacker-controlled
    // and logging it is how a log becomes an injection surface.
    console.warn(`webhook rejected: ${verdict.reason}`);
    return new Response(verdict.reason, { status: 401 });
  }

  if (!verdict.act) return new Response(`ignored: ${verdict.reason}`, { status: 200 });

  const events = await eventStore.read(CONTROL_STREAM);
  // GitHub retries on any non-2xx and re-sends the same delivery id. A repeat
  // is nearly harmless — the effect is "ask GitHub again" — but it still wakes
  // the conductor, and waking it four times for one issue is how a rate limit
  // is reached.
  const seen = events.some(
    (e) => e.type === "QueueChanged" && (e.data as { delivery?: string }).delivery === verdict.delivery,
  );
  if (seen) return new Response("already delivered", { status: 200 });

  await eventStore.append(CONTROL_STREAM, events.length, [
    {
      type: "QueueChanged",
      actor: "github",
      data: parsePayload("QueueChanged", {
        project: verdict.project,
        reason: verdict.reason,
        delivery: verdict.delivery,
      }),
    },
  ]);

  return new Response("ok", { status: 200 });
}
