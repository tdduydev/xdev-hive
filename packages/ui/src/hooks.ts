import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { may, systemOf, type HiveSystem, type Me, type Permission, type WriteSource } from "@xdev-hive/core";
import { activeIntl, hasKey, translate, type MessageKey } from "./i18n/translate.ts";
import type { HiveClient } from "./client.ts";
import type { Scope } from "./lib/scope.ts";
import { visibleInterval } from "#ui/lib/visible-interval.ts";

export interface HiveContextValue {
  client: HiveClient;
  me: Me;
  /** Ask the shell to refresh counters (pending proposals badge) and the project list. */
  bump: () => void;
  /** The project scope picked in the sidebar (see lib/scope.ts). */
  scope: Scope;
  setScope: (scope: Scope) => void;
  /** Project keys seen anywhere: docs, tasks, memory, this machine's repos, systems. */
  projects: string[];
  /** The team's systems (roadmap 19b), with the projects this person sees. */
  systems: HiveSystem[];
}

export const HiveContext = createContext<HiveContextValue | null>(null);

export function useHive(): HiveContextValue {
  const ctx = useContext(HiveContext);
  if (!ctx) throw new Error("useHive must be used inside <HiveApp>");
  return ctx;
}

/** An error in the interface language when it carries a known message key (hub, desktop), else its own message. */
export function errorMessage(err: unknown): string {
  const { key, vars } = (err ?? {}) as { key?: unknown; vars?: Record<string, string | number> };
  if (typeof key === "string" && hasKey(key)) return translate(key as MessageKey, vars);
  return err instanceof Error ? err.message : String(err);
}

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Refresh queries while visible, and once when returning to a hidden page. */
export function usePoll(ms: number | null): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (ms === null) return;
    return visibleInterval(ms, () => setTick((n) => n + 1));
  }, [ms]);
  return tick;
}

/** Read once, now: for a reader of the address who has to see the same value twice (TaskWorkPage). */
export const hashParam = (name: string) => new URLSearchParams(window.location.hash.split("?")[1] ?? "").get(name);

/**
 * A parameter of the page's address (#/tasks?task=T-1), for a link from another page to one item. `clear` takes it
 * out of the address once the page showed the item, so closing it and following the same link again works.
 */
export function useHashParam(name: string): [string | null, () => void] {
  const [value, setValue] = useState(() => hashParam(name));
  useEffect(() => {
    const onHash = () => setValue(hashParam(name));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [name]);
  const clear = useCallback(() => {
    // The tab is the frame's (roadmap 49b: Đợt chạy is a tab of Agent đang chạy), so a page in a tab keeps it.
    const tab = hashParam("tab");
    window.history.replaceState(null, "", `${window.location.hash.split("?")[0] || "#/"}${tab ? `?tab=${encodeURIComponent(tab)}` : ""}`);
    setValue(null);
  }, []);
  return [value, clear];
}

export function useQuery<T>(fn: () => Promise<T>, deps: unknown[]): QueryState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      (value) => {
        if (!alive) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Wraps an async action with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

/**
 * What the signed-in person may do with a project's data (null = the shared data), by the rules the hub
 * enforces. Used to hide controls; the hub still checks every call.
 */
/** Whether I may do something in a project (owner) or in the shared data (owner null), by roadmap 25's permissions. */
export function useCan(): (owner: string | null, need: Permission) => boolean {
  const { me } = useHive();
  return useCallback((owner: string | null, need: Permission) => may(me, owner, need), [me]);
}

/** Project keys seen anywhere (loaded once by the shell). */
export function useProjects(): string[] {
  return useHive().projects;
}

/**
 * Project keys that are at rest and have nothing left on them (roadmap 38g): the shell leaves them out of the scope
 * picker and of every project list. A hub from before has no such method, so there are none then.
 */
export function useRetiredProjects(client: HiveClient, tick: number): Set<string> {
  const { data } = useQuery(async () => {
    const retired = await client.call("projects.retired", {}).catch(() => []);
    return new Set(retired.filter((r) => r.hidden).map((r) => r.project));
  }, [client, tick]);
  return data ?? EMPTY_SET;
}
const EMPTY_SET: Set<string> = new Set();

/** Loads the project list for the shell: docs, tasks, memory and this machine's repos. */
export function useProjectList(client: HiveClient, tick: number): string[] {
  const { data } = useQuery(async () => {
    const [docs, tasks, memory, settings] = await Promise.all([
      client.call("docs.list", {}),
      client.call("tasks.list", {}),
      client.call("memory.list", { limit: 500 }),
      client.desktop?.settings(),
    ]);
    const names = new Set<string>();
    // A system's docs and memory (sys:<name>, roadmap 19c) are not a project's.
    for (const d of docs) if (d.project && !systemOf(d.project)) names.add(d.project);
    for (const t of tasks) names.add(t.project);
    for (const m of memory) if (m.project && !systemOf(m.project)) names.add(m.project);
    for (const p of settings?.projects ?? []) names.add(p.name);
    return [...names].sort();
  }, [client, tick]);
  return data ?? [];
}

/** An API-price estimate in US dollars: cents for small amounts, whole cents above a dollar. */
export function formatUsd(value: number): string {
  return new Intl.NumberFormat(activeIntl(), { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(activeIntl()).format(value);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(activeIntl(), { dateStyle: "short", timeStyle: "short" });
}

/** The date alone, as formatTime writes it. */
export function formatDay(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString(activeIntl(), { dateStyle: "short" }) : "—";
}

/** " · via MCP · duy-mbp · run R-1fa9 · task T-7", or "" when the write has no source. `shownTask` is not repeated. */
export function sourceText(source: WriteSource | null | undefined, shownTask?: string | null): string {
  if (!source) return "";
  const parts = [
    translate(`source.via.${source.via}`),
    source.machine,
    source.run ? translate("source.run", { id: source.run }) : null,
    source.task && source.task !== shownTask ? translate("source.task", { id: source.task }) : null,
  ];
  return parts.filter(Boolean).map((p) => ` · ${p}`).join("");
}
