// Signs this machine in to a hub through the browser (RFC 8252 loopback redirect), so an account that
// only signs in with SSO can use the app: listen on 127.0.0.1, open the hub's page, wait for the
// one-time code, trade it with the PKCE verifier for a machine token. No Electron imports.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HiveError, type Me } from "@xdev-hive/core";

export interface BrowserSignIn {
  hubUrl: string;
  machine: string;
  /** Opens the page in the person's browser (shell.openExternal). */
  open(url: string): Promise<void>;
  /** The page the browser lands on afterwards: done, or why not. */
  page(outcome: "done" | "denied"): string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** Resolves with the machine token once the person allowed it on the hub, rejects on deny, timeout or abort. */
export async function signInThroughBrowser(opts: BrowserSignIn): Promise<{ token: string; user: NonNullable<Me["user"]> }> {
  const hubUrl = opts.hubUrl.replace(/\/+$/, "");
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const fetchImpl = opts.fetch ?? fetch;

  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        // Anything else (a favicon, a stray request, someone else's state) is not the answer.
        if (url.pathname !== "/callback" || url.searchParams.get("state") !== state) {
          res.writeHead(404).end();
          return;
        }
        // Settled once the page is out: closing the server earlier would cut it off.
        const answer = (outcome: "done" | "denied", then: () => void) => {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(opts.page(outcome), then);
        };
        const got = url.searchParams.get("code");
        if (got) answer("done", () => resolve(got));
        else answer("denied", () => reject(new HiveError("forbidden", "Đăng nhập bị từ chối trên trang hub.", { key: "errors.deviceDenied" })));
      });
      server.once("error", (err) => reject(err));
      server.listen(0, "127.0.0.1", () => {
        const port = (server!.address() as AddressInfo).port;
        const params = new URLSearchParams({ port: String(port), state, challenge, name: opts.machine });
        opts.open(`${hubUrl}/#/device?${params.toString()}`).catch(reject);
      });
      timer = setTimeout(
        () => reject(new HiveError("bad_request", "Hết thời gian chờ đăng nhập trên trình duyệt.", { key: "errors.deviceTimeout" })),
        opts.timeoutMs ?? 5 * 60_000,
      );
      onAbort = () => reject(new HiveError("bad_request", "Đã huỷ đăng nhập qua trình duyệt.", { key: "errors.deviceCancelled" }));
      if (opts.signal?.aborted) onAbort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });

    const res = await fetchImpl(`${hubUrl}/api/device-token/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, verifier }),
    });
    const body = (await res.json().catch(() => null)) as { result?: { token: string; user: NonNullable<Me["user"]> }; error?: { message?: string; key?: string } } | null;
    if (!res.ok || !body?.result) {
      throw new HiveError("unauthorized", body?.error?.message ?? `Hub responded ${res.status}`, { key: body?.error?.key ?? "errors.deviceCode" });
    }
    return body.result;
  } finally {
    clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    server?.close();
    server?.closeAllConnections?.();
  }
}

/** The small page the browser shows once the app has its answer (no scripts, no outside resources). */
export function landingPage(title: string, text: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center;color:#333"><div style="max-width:28rem;text-align:center"><h2>${esc(title)}</h2><p>${esc(text)}</p></div></body></html>`;
}
