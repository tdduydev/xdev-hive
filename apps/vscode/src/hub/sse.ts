import type { HubClient } from "@/hub/client.ts";
import { HubError } from "@/hub/errors.ts";

export interface RunStreamEvent {
  event: string;
  data: string;
  id?: string;
}
export interface StreamOptions {
  signal: AbortSignal;
  lastEventId?: string;
  retryMs?: number;
  maxRetryMs?: number;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export async function streamRun(
  client: Pick<HubClient, "request">,
  runId: string,
  onEvent: (event: RunStreamEvent) => void | Promise<void>,
  options: StreamOptions,
): Promise<void> {
  let cursor = options.lastEventId ?? "";
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const response = await client.request(`/api/v1/runs/${encodeURIComponent(runId)}/stream`, {
        headers: { accept: "text/event-stream", ...(cursor ? { "Last-Event-ID": cursor } : {}) },
        signal: options.signal,
      });
      if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
        await response.body?.cancel();
        throw new HubError(502);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let event = "message";
      let data: string[] = [];
      let id: string | undefined;
      try {
        while (!options.signal.aborted) {
          const part = await reader.read();
          if (part.done) break;
          buffer += decoder.decode(part.value, { stream: true });
          let match = /\r\n|\r|\n/.exec(buffer);
          while (match) {
            // CRLF có thể nằm giữa hai chunk.
            if (match[0] === "\r" && match.index === buffer.length - 1) break;
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (line === "") {
              if (data.length) {
                await onEvent({ event, data: data.join("\n"), ...(id === undefined ? {} : { id }) });
                if (id !== undefined) cursor = id;
                failures = 0;
                if (event === "end") return;
              }
              event = "message";
              data = [];
              id = undefined;
            } else if (!line.startsWith(":")) {
              const colon = line.indexOf(":");
              const field = colon < 0 ? line : line.slice(0, colon);
              const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
              if (field === "event") event = value;
              if (field === "data") data.push(value);
              if (field === "id" && !value.includes("\0")) id = value;
            }
            match = /\r\n|\r|\n/.exec(buffer);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch (error) {
      if (options.signal.aborted) return;
      if (error instanceof HubError && [400, 401, 403, 404].includes(error.status)) throw error;
    }
    await delay(
      Math.min((options.retryMs ?? 1000) * 2 ** Math.min(failures++, 20), options.maxRetryMs ?? 30_000),
      options.signal,
    );
  }
}
