import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { config } from "./config.js";
import type { Session } from "./api.js";

/**
 * Keeps every screen current: reads the API's event stream (with fetch, so the session key goes in
 * a header) and refetches whenever it says "change". Reconnects with backoff if the line drops.
 * Returns whether the stream is currently connected.
 */
export function useLiveUpdates(session: Session | null, onSignedOut: () => void): boolean {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  // Held in a ref so a new callback on each render doesn't restart the stream.
  const signedOut = useRef(onSignedOut);
  signedOut.current = onSignedOut;

  useEffect(() => {
    if (session === null) return;
    const controller = new AbortController();
    void (async () => {
      let delay = 1000;
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${config.apiUrl}/stream`, {
            headers: { authorization: `Bearer ${session.key}` },
            signal: controller.signal,
          });
          if (response.status === 401) {
            signedOut.current();
            return;
          }
          if (!response.ok || response.body === null) throw new Error("stream unavailable");
          setLive(true);
          delay = 1000;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (event.includes("event: change")) void queryClient.invalidateQueries();
              if (event.includes("event: signed-out")) {
                signedOut.current();
                return;
              }
            }
          }
        } catch {
          // Dropped or refused: fall through to the retry below.
        }
        setLive(false);
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
    return () => {
      controller.abort();
      setLive(false);
    };
  }, [session, queryClient]);

  return live;
}
