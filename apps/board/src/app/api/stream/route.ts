/**
 * Live updates for the board.
 *
 * The board runs on localhost for one person, so Server-Sent Events are the
 * right shape: one direction, text, and it reconnects on its own. Postgres
 * already broadcasts every append on the `escapement` channel, so this endpoint
 * is a bridge, not a poller — `interval` should not exist anywhere in this
 * system.
 *
 * Not wired up: it needs the store's `subscribe`, which needs a database.
 * Until then it holds the connection open and sends nothing, so the client's
 * reconnect logic can be built and tested against it.
 */
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encode = (s: string) => new TextEncoder().encode(s);
      controller.enqueue(encode(": connected\n\n"));

      // Proxies and browsers drop an idle event stream; a comment frame is the
      // conventional way to keep it alive without inventing an event type.
      const keepAlive = setInterval(() => controller.enqueue(encode(": ping\n\n")), 25_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(keepAlive);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
