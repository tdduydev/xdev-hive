// Loads what "Hôm nay" lists, once for the whole app: the sidebar shows the count, the page the items.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { may, permissionsOn, type Me, type ProjectRole } from "@xdev-hive/core";
import { allInboxSources } from "#ui/lib/inbox-source.ts";
import type { HiveClient } from "#ui/client.ts";
import { usePoll, useQuery } from "#ui/hooks.ts";
import { buildInbox, highestRole, inboxProject, readDone, readRead, writeDone, writeRead, type InboxDone, type InboxItem } from "#ui/lib/inbox.ts";
import { inScope, scopeFilter, scopeKey, scopeProjects, type Scope } from "#ui/lib/scope.ts";

export interface InboxState {
  /** Open items in the scope, newest first. */
  items: InboxItem[];
  /** Handled on this device, newest first. */
  done: InboxDone[];
  read: Set<string>;
  /** The person's highest role in the scope: it orders Hôm nay's groups (roadmap 49g). */
  role: ProjectRole;
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
  const deps = [client, me, scopeKey(scope), tick, poll, local];
  const desktop = client.desktop;
  // The desktop app on a hub lists this machine's work only (roadmap 35a): what waits on the team is the web's.
  const team = !(desktop && me.mode === "hub");
  const hub = team && me.mode === "hub";

  const proposals = useQuery(async () => (team ? client.call("proposals.list", { status: "pending" }) : []), deps);
  const cleanup = useQuery(async () => (hub ? client.call("memory.cleanupProposals", {}).catch(() => []) : []), deps);
  const source = useQuery(async () => (team && scope.kind !== "shared" ? allInboxSources(client, scopeFilter(scope), hub) : { tasks: [], runs: [] }), deps);
  const memory = useQuery(async () => (team ? client.call("memory.list", { ...memoryFilter(scope), limit: 500 }) : []), deps);
  // Gates and leaders' proposals are the hub's; one from before them has neither method.
  const plans = useQuery(async () => (hub ? client.call("runs.plans", { ...scopeFilter(scope), status: "waiting", limit: 200 }) : []), deps);
  const gates = useQuery(async () => (hub ? client.call("sdlc.gates", { ...scopeFilter(scope), limit: 100 }).catch(() => []) : []), deps);
  const leader = useQuery(async () => (hub ? client.call("chat.pending", { ...scopeFilter(scope) }).catch(() => []) : []), deps);
  const runs = useQuery(async () => (desktop ? desktop.runs({ limit: 200 }) : []), deps);
  const setup = useQuery(async () => (desktop ? desktop.setupStatus() : null), [desktop, tick, local]);
  const requests = useQuery(async () => (desktop && me.mode === "hub" ? desktop.hubRequests() : null), deps);
  const settings = useQuery(async () => (desktop ? desktop.settings() : null), [desktop]);
  // Hub admins on the web: the hub's alerts that no admin has seen yet.
  const hubAdmin = me.mode === "hub" && me.role === "admin" && !me.access;
  const alerts = useQuery(async () => (team && hubAdmin && client.alerts ? (await client.alerts.list().catch(() => null))?.open ?? null : null), deps);
  const hubInfo = useQuery(async () => (team && hubAdmin && client.hub ? client.hub.info().catch(() => null) : null), deps);

  // Every project counts when the scope is all of them; the shared data has a grant of its own.
  const role = useMemo(() => {
    const owners: Array<string | null> = scope.kind === "shared" ? [null] : (scopeProjects(scope) ?? Object.keys(me.access?.projects ?? {}));
    return highestRole((owners.length ? owners : [null]).map((o) => permissionsOn(me, o)));
  }, [me, scope]);

  const [done, setDone] = useState<InboxDone[]>(readDone);
  const [read, setRead] = useState<Set<string>>(() => new Set(readRead()));

  const items = useMemo(() => {
    const all = buildInbox({
      proposals: proposals.data,
      cleanup: cleanup.data,
      reviewTasks: source.data?.tasks,
      assignedTasks: hub ? source.data?.tasks : [],
      principal: me.name,
      memory: memory.data,
      runs: runs.data,
      hubRuns: source.data?.runs,
      setup: setup.data?.machine,
      commands: requests.data?.commands,
      machine: settings.data?.machine,
      alerts: alerts.data ?? undefined,
      hubInfo: hubInfo.data,
      plans: plans.data,
      gates: gates.data,
      leader: leader.data,
      can: (owner, permission) => may(me, owner, permission),
    });
    const handled = new Set(done.map((d) => d.key));
    return all.filter((i) => !handled.has(i.key) && inScope(scope, inboxProject(i)));
  }, [plans.data, cleanup.data, source.data, proposals.data, memory.data, runs.data, setup.data, requests.data, settings.data, alerts.data, hubInfo.data, gates.data, leader.data, me, done, scope, hub]);

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

  const first = [source, plans, proposals, memory].find((q) => q.error);
  return {
    items,
    done,
    read,
    role,
    loading: (source.loading && !source.data) || (proposals.loading && !proposals.data),
    error: first?.error ?? null,
    markRead,
    markDone,
    reopen,
    reload,
  };
}
