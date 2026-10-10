// The preload rejects with a plain object, since contextBridge copies nothing of an Error but its message: code, key
// and vars (what the page translates and branches on) were lost, and every error of the app showed as the main
// process wrote it. Here, on the page's side of the bridge, it becomes an Error again with all of them.

interface BridgedError { hiveError: true; code?: string; message?: string; key?: string; vars?: unknown }

const isBridged = (e: unknown): e is BridgedError => typeof e === "object" && e !== null && (e as { hiveError?: unknown }).hiveError === true;

export function rehydrateError(e: unknown): unknown {
  if (!isBridged(e)) return e;
  return Object.assign(new Error(e.message ?? "Error"), { code: e.code, key: e.key, vars: e.vars });
}

function wrap<T extends object>(api: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(api)) {
    out[name] = typeof value === "function"
      ? (...args: unknown[]) => {
          const r = (value as (...a: unknown[]) => unknown)(...args);
          return r instanceof Promise ? r.catch((e: unknown) => Promise.reject(rehydrateError(e))) : r;
        }
      : value;
  }
  return out as T;
}

/** The client the preload exposes, with its errors turned back into Errors; its `desktop` part too. */
export function withHiveErrors<T extends { desktop?: object }>(client: T): T {
  const top = wrap(client);
  return client.desktop ? { ...top, desktop: wrap(client.desktop) } : top;
}
