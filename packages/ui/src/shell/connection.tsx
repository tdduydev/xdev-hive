// Is the hub answering? The desktop asks its runner (the last heartbeat); the web pings the hub itself. When the hub
// comes back, doc saves made while it was away (the outbox in the drafts) are sent.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Me } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import { errorMessage, usePoll } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { DRAFTS_EVENT, isUnreachable, parsePaths, readDrafts, writeDrafts } from "#ui/lib/docdraft.ts";
import { useToast } from "./toast.tsx";

export interface HubLink {
  /** unknown: local mode, or not checked yet. refused: the hub answered with an error (token, duplicate…). */
  state: "ok" | "offline" | "refused" | "unknown";
  host: string;
  error: string | null;
  retrying: boolean;
  retry: () => void;
}

/** Just the host of a hub URL, for lines people read ("Đã kết nối hive.xdev.asia"). */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function useHubConnection(client: HiveClient, me: Me): HubLink {
  const t = useT();
  const toast = useToast();
  const hub = me.mode === "hub";
  const desktop = client.desktop;
  const [state, setState] = useState<HubLink["state"]>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState(() => (desktop ? "" : window.location.host));
  const [retrying, setRetrying] = useState(false);
  const was = useRef<HubLink["state"]>("unknown");

  const check = useCallback(
    async (now: boolean) => {
      if (!hub) return setState("unknown");
      if (desktop) {
        const s = await (now ? desktop.hubRetry() : desktop.hubStatus()).catch(() => null);
        if (!s) return;
        setHost(hostOf(s.url));
        setError(s.error);
        setState(s.ok === null ? "unknown" : s.ok ? "ok" : s.code === "unavailable" ? "offline" : "refused");
        return;
      }
      try {
        await client.me();
        setError(null);
        setState("ok");
      } catch (err) {
        setError(errorMessage(err));
        setState(isUnreachable(err) ? "offline" : "refused");
      }
    },
    [client, desktop, hub],
  );

  // The desktop's heartbeat is every 30 s: reading its result often costs nothing. The web pings every 30 s.
  const tick = usePoll(hub ? (desktop ? 5000 : 30_000) : null);
  useEffect(() => void check(false), [check, tick]);
  useEffect(() => {
    if (desktop || !hub) return;
    const on = () => void check(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", on);
    };
  }, [check, desktop, hub]);
  useEffect(() => {
    if (was.current !== "ok" && was.current !== "unknown" && state === "ok") toast(t("shell.backOnline", { host }));
    was.current = state;
  }, [state, host, t, toast]);

  const retry = useCallback(() => {
    setRetrying(true);
    void check(true).finally(() => setRetrying(false));
  }, [check]);
  return { state, host, error, retrying, retry };
}

/** Sends the doc saves and proposals queued while the hub was away, once it answers again. */
export function useDocOutbox(client: HiveClient, online: boolean): void {
  const t = useT();
  const toast = useToast();
  const busy = useRef(false);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const on = () => setBump((n) => n + 1);
    window.addEventListener(DRAFTS_EVENT, on);
    return () => window.removeEventListener(DRAFTS_EVENT, on);
  }, []);
  useEffect(() => {
    if (!online || busy.current) return;
    const queued = Object.entries(readDrafts()).filter(([, d]) => d.queued);
    if (!queued.length) return;
    busy.current = true;
    void (async () => {
      for (const [key, d] of queued) {
        const name = d.title || key;
        try {
          if (d.queued!.mode === "save") {
            await client.call("docs.save", {
              key,
              content: d.content,
              title: d.title.trim() || undefined,
              includeInAgents: key.startsWith("org/") ? d.includeInAgents : undefined,
              paths: /^project\/[^/]+\/(agents|decisions)$/.test(key) ? undefined : parsePaths(d.paths),
              note: d.note.trim() || undefined,
              baseVersion: d.baseVersion,
              // A new page goes where it was made.
              ...(d.baseVersion === 0 && d.parent ? { parent: d.parent } : {}),
            });
          } else {
            await client.call("proposals.create", { docKey: key, baseVersion: d.baseVersion, content: d.content, reason: d.note.trim() || t("docs.proposeDefaultReason") });
          }
          const rest = readDrafts();
          delete rest[key];
          writeDrafts(rest);
          toast(t("docs.sentToast", { doc: name }));
        } catch (err) {
          if (isUnreachable(err)) break;
          // Someone saved the doc meanwhile (or another refusal): keep the draft for a person to look at.
          const rest = readDrafts();
          if (rest[key]) {
            delete rest[key]!.queued;
            writeDrafts(rest);
          }
          toast(t("docs.sendConflict", { doc: name }), { tone: "error" });
        }
      }
      busy.current = false;
    })();
  }, [client, online, bump, t, toast]);
}
