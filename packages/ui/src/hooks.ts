import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Me } from "@xdev-hive/core";
import type { HiveClient } from "./client.ts";
import type { Scope } from "./lib/scope.ts";

export interface HiveContextValue {
  client: HiveClient;
  me: Me;
  /** Ask the shell to refresh counters (pending proposals badge) and the project list. */
  bump: () => void;
  /** The project scope picked in the sidebar (see lib/scope.ts). */
  scope: Scope;
  setScope: (scope: Scope) => void;
  /** Project keys seen anywhere: docs, tasks, memory, this machine's repos. */
  projects: string[];
}

export const HiveContext = createContext<HiveContextValue | null>(null);

export function useHive(): HiveContextValue {
  const ctx = useContext(HiveContext);
  if (!ctx) throw new Error("useHive must be used inside <HiveApp>");
  return ctx;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface QueryState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
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

/** Project keys seen anywhere (loaded once by the shell). */
export function useProjects(): string[] {
  return useHive().projects;
}

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
    for (const d of docs) if (d.project) names.add(d.project);
    for (const t of tasks) names.add(t.project);
    for (const m of memory) if (m.project) names.add(m.project);
    for (const p of settings?.projects ?? []) names.add(p.name);
    return [...names].sort();
  }, [client, tick]);
  return data ?? [];
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}
