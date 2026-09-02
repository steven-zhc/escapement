"use client";

/**
 * Keeps the board current without a refresh, and without polling.
 *
 * An append reaches Postgres, the trigger notifies, `/api/stream` forwards it,
 * and this asks Next to re-render the route. That last step is deliberate: the
 * board is a *projection*, and folding events into client state here would be a
 * second reducer that can disagree with the first one. Re-reading is cheaper
 * than being subtly wrong.
 *
 * `EventSource` reconnects on its own and sends `Last-Event-ID`, so resume is
 * the browser's job and the server's — not this component's. What it does keep
 * is the last seq, so a tab that has been asleep asks for the right place even
 * on a first connection.
 *
 * Several tabs each get their own stream, and all of them update. Nothing here
 * coordinates them, because nothing has to: each one is reading the same
 * projection.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * How long to coalesce a burst before re-reading.
 *
 * A run appends steadily — a touched file, a gate verdict — and
 * one round trip per event would make the board re-render dozens of times a
 * second while saying the same thing. This is not polling: nothing fires unless
 * an event arrived.
 */
const COALESCE_MS = 250;

export function Live() {
  const router = useRouter();
  const [state, setState] = useState<"connecting" | "live" | "trouble">("connecting");
  const lastSeq = useRef<string>("0");

  useEffect(() => {
    const source = new EventSource(`/api/stream?from=${lastSeq.current}`);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), COALESCE_MS);
    };

    source.addEventListener("open", () => setState("live"));

    source.addEventListener("append", (e) => {
      setState("live");
      try {
        const data = JSON.parse((e as MessageEvent).data) as { seq: string };
        // Kept so a first connection after a sleep resumes from here. The
        // browser handles it on an automatic reconnect via Last-Event-ID.
        if (data.seq) lastSeq.current = data.seq;
      } catch {
        // A frame we cannot read still means something changed.
      }
      refresh();
    });

    source.addEventListener("trouble", () => setState("trouble"));

    // Fires on a dropped connection too; the browser retries on its own, so
    // this reports rather than reconnects.
    source.addEventListener("error", () => setState("trouble"));

    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [router]);

  return (
    <span className={`chip ${state === "live" ? "live" : "idle"}`} title={`stream: ${state}`}>
      {state === "live" ? "live" : state}
    </span>
  );
}
