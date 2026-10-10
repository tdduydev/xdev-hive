// The leader chat in the app (roadmap 48): files go up and come down through the main process, which holds the
// machine's token (on a hub) or the database (local mode), and a reply that ended while the window was away is told.
// No Electron imports, so tests reach it.
import { CHAT_FILE_SCHEME, HiveError, type ChatFile, type ChatRequest, type HiveErrorCode } from "@xdev-hive/core";
import { tr } from "#desktop/main/i18n.ts";

export interface HubAccess {
  url: string;
  token: string;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The hub's answer or its error, with the key the page translates. `label` is the x-hive-agent the app's calls carry:
 * the hub names the uploader by it, and chat.send attaches only the sender's own uploads.
 */
export async function hubChatUpload(hub: HubAccess, label: string, project: string, name: string, bytes: Uint8Array, fetch: Fetch): Promise<ChatFile> {
  const query = `project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`;
  const res = await fetch(`${hub.url.replace(/\/+$/, "")}/api/chat/files?${query}`, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: { authorization: `Bearer ${hub.token}`, "x-hive-agent": label, "content-type": "application/octet-stream" },
    // A copy in an ArrayBuffer of its own: what fetch's body takes, whatever buffer the bytes came in.
    body: new Uint8Array(bytes).buffer,
  });
  const json = (await res.json().catch(() => null)) as { result?: ChatFile; error?: { code?: string; message?: string; key?: string; vars?: Record<string, string | number> } } | null;
  if (!res.ok || !json?.result) {
    const e = json?.error;
    throw new HiveError((e?.code as HiveErrorCode) ?? "bad_request", e?.message ?? `HTTP ${res.status}`, e?.key ? { key: e.key, vars: e.vars } : undefined);
  }
  return json.result;
}

/** The file id of a `hive-file://chat/<id>` address; null for anything else. */
export function chatFileId(url: string): number | null {
  const m = new RegExp(`^${CHAT_FILE_SCHEME}://chat/(\\d{1,15})/?$`).exec(url);
  return m ? Number(m[1]) : null;
}

/** The name a hub gave a file it serves (`filename*=UTF-8''…`), or null. */
export function servedName(disposition: string | null): string | null {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(disposition ?? "");
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}

/**
 * What the app says when a reply it wrote ended: only for the person at this machine (the message is theirs) and only
 * while the window is away, since an open Chat page shows it already.
 */
export function chatNotice(
  req: Pick<ChatRequest, "project" | "text" | "requestedBy">,
  status: "done" | "failed",
  o: { me: string | null; windowShown: boolean },
): { title: string; body: string } | null {
  if (o.windowShown || !o.me || req.requestedBy !== o.me) return null;
  const line = req.text.trim().split("\n")[0]!;
  const message = line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return {
    title: tr(status === "done" ? "desktop.chatDoneTitle" : "desktop.chatFailedTitle", { project: req.project }),
    body: tr(status === "done" ? "desktop.chatDoneBody" : "desktop.chatFailedBody", { message }),
  };
}
