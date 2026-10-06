// Loads what "Hôm nay" lists, once for the whole app: the sidebar shows the count, the page the items.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { may, type Me } from "@xdev-hive/core";
import type { HiveClient } from "#ui/client.ts";
import { usePoll, useQuery } from "#ui/hooks.ts";
import { buildInbox, inboxProject, readDone, readRead, writeDone, writeRead, type InboxDone, type InboxItem } from "#ui/lib/inbox.ts";
import { inScope, scopeFilter, scopeKey, type Scope } from "#ui/lib/scope.ts";

export interface InboxState {
  /** Open items in the scope, newest first. */
  items: InboxItem[];
  /** Handled on this device, newest first. */
  done: InboxDone[];
  read: Set<string>;
  loading: boolean;
  error: string | null;
  markRead: (key: string) => void;
  markDone: (entry: Omit<InboxDone, "at">) => void;
  reopen: (key: string) => void;
  reload: () => void;
}

const InboxContext = createContext<InboxState | null>(null);
export const InboxProvider = InboxContext.Provider;

export function useInbox(): InboxState {
  const ctx = useContext(InboxContext);
  if (!ctx) throw new Error("useInbox must be used inside the app shell");
  return ctx;
}

/** memory.list's filter for a scope: the project's (or system's) entries with the shared ones, or only shared. */
function memoryFilter(scope: Scope) {
  if (scope.kind === "shared") return { project: null };
  if (scope.kind === "all") return {};
  return { ...scopeFilter(scope), includeShared: true };
}

export function useInboxState(client: HiveClient, me: Me, scope: Scope, tick: number): InboxState {
  const poll = usePoll(30_000);
  const [local, setLocal] = useState(0);
  const deps = [client, scopeKey(scope), tick, poll, local];
  const desktop = client.desktop;
  // The desktop app on a hub lists this machine's work only (roadmap 35a): what waits on the team is the web's.
  const team = !(desktop && me.mode === "hub");
  const hub = team && me.mode === "hub";

  const proposals = useQuery(async () => (team ? client.call("proposals.list", { status: "pending" }) : []), deps);
  const review = useQuery(async () => (team ? client.call("tasks.list", { ...scopeFilter(scope) }) : []), deps);
  const memory = useQuery(async () => (team ? client.call("memory.list", { ...memoryFilter(scope), limit: 500 }) : []), deps);
  // Gates and leaders' proposals are the hub's; one from before them has neither method.
  const gates = useQuery(async () => (hub ? client.call("sdlc.gates", { ...scopeFilter(scope), limit: 100 }).catch(() => []) : []), deps);
  const leader = useQuery(async () => (hub ? client.call("chat.pending", { ...scopeFilter(scope) }).catch(() => []) : []), deps);
  const runs = useQuery(async () => (desktop ? desktop.runs({ limit: 200 }) : []), deps);
  const setup = useQuery(async () => (desktop ? desktop.setupStatus() : null), [desktop, tick, local]);
  const requests = useQuery(async () => (desktop && me.mode === "hub" ? desktop.hubRequests() : null), deps);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  // Hub admins on the web: the hub's alerts that no admin has seen yet.
  const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
  const alerts = useQuery(async () => (team && hubAdmin && client.alerts ? (await client.alerts.list().catch(() => null))?.open ?? null : null), deps);

  const [done, setDone] = useState<InboxDone[]>(readDone);
  const [read, setRead] = useState<Set<string>>(() => new Set(readRead()));

  const items = useMemo(() => {
    const all = buildInbox({
      proposals: proposals.data,
      reviewTasks: review.data,
      assignedTasks: hub ? review.data : [],
      principal: me.name,
      memory: memory.data,
      runs: runs.data,
      setup: setup.data?.machine,
      commands: requests.data?.commands,
      machine: settings.data?.machine,
      alerts: alerts.data ?? undefined,
      gates: gates.data,
      leader: leader.data,
      can: (owner, permission) => may(me, owner, permission),
    });
    const handled = new Set(done.map((d) => d.key));
    return all.filter((i) => !handled.has(i.key) && inScope(scope, inboxProject(i)));
  }, [proposals.data, review.data, memory.data, runs.data, setup.data, requests.data, settings.data, alerts.data, gates.data, leader.data, me, done, scope, hub]);

  const markRead = useCallback((key: string) => {
    setRead((cur) => {
      if (cur.has(key)) return cur;
      const next = new Set(cur).add(key);
      writeRead([...next]);
      return next;
    });
  }, []);
  const markDone = useCallback((entry: Omit<InboxDone, "at">) => {
    setDone((cur) => {
      const next = [{ ...entry, at: new Date().toISOString() }, ...cur.filter((d) => d.key !== entry.key)];
      writeDone(next);
      return next;
    });
  }, []);
  const reopen = useCallback((key: string) => {
    setDone((cur) => {
      const next = cur.filter((d) => d.key !== key);
      writeDone(next);
      return next;
    });
  }, []);
  const reload = useCallback(() => setLocal((n) => n + 1), []);

  const first = [proposals, review, memory].find((q) => q.error);
  return {
    items,
    done,
    read,
    loading: proposals.loading && !proposals.data,
    error: first?.error ?? null,
    markRead,
    markDone,
    reopen,
    reload,
  };
}
