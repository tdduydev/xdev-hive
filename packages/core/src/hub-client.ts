import { HiveError, type ErrorText, type HiveErrorCode } from "./errors.ts";
import type { Me } from "./bridge.ts";
import type { HiveBackend, Method, MethodInput, MethodOutput } from "./methods.ts";
import { sourceHeader } from "./source.ts";
import type { Actor } from "./types.ts";

/** The message key of a hub error answer, if it has one. */
const textOf = (error: { key?: unknown; vars?: unknown } | undefined): ErrorText | undefined =>
  typeof error?.key === "string" ? { key: error.key, vars: error.vars as ErrorText["vars"] } : undefined;

const CODES: Record<number, HiveErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
};

/**
 * Signs in once with a hub account (username + password) and gets a token for this machine. The token
 * belongs to that account: agents on the machine see the projects the account is granted, no more.
 * A hub that cannot be reached is HiveError "unavailable", as for every other call, not fetch's bare TypeError.
 */
export async function requestDeviceToken(
  url: string,
  input: { username: string; password: string; machine: string },
): Promise<{ token: string; user: NonNullable<Me["user"]> }> {
  const hub = url.replace(/\/+$/, "");
  const res = await reach(hub, `${hub}/api/device-token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: input.username,
      password: input.password,
      name: input.machine.replace(/[^\w.-]/g, "-").slice(0, 60) || "desktop",
    }),
  });
  const body = (await hubBody(res, hub)) as
    | { result?: { token: string; user: NonNullable<Me["user"]> }; error?: { code?: string; message?: string; key?: string; vars?: unknown } }
    | null;
  if (!res.ok || !body?.result) {
    throw new HiveError((body?.error?.code as HiveErrorCode) ?? CODES[res.status] ?? "bad_request", body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
  }
  return body.result;
}

/**
 * Talks to a Hive hub over `POST /api/rpc`. The hub decides the role from the token;
 * `actor.name` is only sent as a label (`x-hive-agent`) so writes show which agent made them.
 */
export class HubBackend implements HiveBackend {
  readonly url: string;
  readonly #token: string;
  readonly #shutdown = new AbortController();
  #quitQueue: ((id: string, method: string, input: unknown, actor: Actor) => void) | null = null;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.#token = token;
  }

  /** End all pending and future hub calls by the quit deadline; local bookkeeping can continue. */
  stopForQuit(): void {
    setTimeout(() => this.#shutdown.abort(), 10_000);
  }

  setQuitQueue(queue: (id: string, method: string, input: unknown, actor: Actor) => void): void {
    this.#quitQueue = queue;
  }

  async replayReport(id: string, method: "tasks.update" | "runs.report", input: MethodInput<typeof method>, actor: Actor): Promise<unknown> {
    const capability = await reach(this.url, `${this.url}/api/me`, {
      signal: this.#shutdown.signal,
      headers: { authorization: `Bearer ${this.#token}`, "x-hive-agent": actor.name },
    });
    if (!capability.ok) throw new HiveError(CODES[capability.status] ?? "unavailable", `Hub responded ${capability.status}`);
    if (capability.headers.get("x-hive-report-idempotency") !== "1") {
      throw new HiveError("unavailable", "The hub cannot safely replay a report yet.");
    }
    return this.#call(method, input, actor, id);
  }

  /** Who the hub thinks we are (name and role come from the token). */
  async me(label: string): Promise<Me> {
    const res = await reach(this.url, `${this.url}/api/me`, {
      signal: this.#shutdown.signal,
      headers: { authorization: `Bearer ${this.#token}`, "x-hive-agent": label },
    });
    const body = (await hubBody(res, this.url)) as { result?: Me; error?: { code?: string; message?: string; key?: string; vars?: unknown } } | null;
    if (!res.ok || !body?.result) {
      throw new HiveError((body?.error?.code as HiveErrorCode) ?? CODES[res.status] ?? "bad_request", body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
    }
    return body.result;
  }

  async call<M extends Method>(method: M, input: MethodInput<M>, actor: Actor): Promise<MethodOutput[M]> {
    return this.#call(method, input, actor);
  }

  async #call<M extends Method>(method: M, input: MethodInput<M>, actor: Actor, replayId?: string): Promise<MethodOutput[M]> {
    const report = method === "tasks.update" || method === "runs.report";
    const id = replayId ?? (report ? crypto.randomUUID() : undefined);
    try {
      const res = await reach(this.url, `${this.url}/api/rpc`, {
        signal: this.#shutdown.signal,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#token}`,
          "x-hive-agent": actor.name,
          ...(actor.source ? { "x-hive-source": sourceHeader(actor.source) } : {}),
          // The hub keeps it on the audit row of every write the agent makes (roadmap 27c).
          ...(actor.run ? { "x-hive-run": actor.run } : {}),
          ...(id ? { "x-hive-idempotency": id } : {}),
        },
        body: JSON.stringify({ method, input }),
      }, method === "artifacts.put" || method === "docs.assetPut" ? 45_000 : 15_000);
      const body = (await hubBody(res, this.url)) as
        | { result?: MethodOutput[M]; error?: { code?: string; message?: string; key?: string; vars?: unknown } }
        | null;
      if (!res.ok || !body || body.error) {
        const code = (body?.error?.code as HiveErrorCode | undefined) ?? CODES[res.status] ?? "bad_request";
        throw new HiveError(code, body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
      }
      return body.result as MethodOutput[M];
    } catch (err) {
      if (report && id && this.#shutdown.signal.aborted && err instanceof HiveError && err.code === "unavailable") {
        this.#quitQueue?.(id, method, input, actor);
      }
      throw err;
    }
  }
}

/** The machine retains its credential; only this short-lived credential reaches a run's MCP process. */
export async function issueRunCredential(
  hub: { url: string; token: string },
  machine: string,
  input: { project: string; task: string; run: string; minutes: number; readOnly: boolean },
): Promise<string> {
  const url = hub.url.replace(/\/+$/, "");
  const res = await reach(url, `${url}/api/run-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hub.token}`, "x-hive-agent": `runner.${machine}` },
    body: JSON.stringify({ ...input, machine }),
  });
  const body = (await hubBody(res, url)) as { result?: { token?: string }; error?: { code?: string; message?: string } } | null;
  if (!res.ok || !body?.result?.token) throw new HiveError(CODES[res.status] ?? "bad_request", body?.error?.message ?? `Hub responded ${res.status}`);
  return body.result.token;
}

export async function revokeRunCredential(hub: { url: string; token: string }, machine: string, run: string): Promise<void> {
  const url = hub.url.replace(/\/+$/, "");
  await reach(url, `${url}/api/run-credentials`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${hub.token}`, "x-hive-agent": `runner.${machine}` },
    body: JSON.stringify({ machine, run }),
  });
}

export async function issueMcpCredential(hub: { url: string; token: string }, project: string | undefined, readOnly: boolean): Promise<string> {
  const url = hub.url.replace(/\/+$/, "");
  const res = await reach(url, `${url}/api/mcp-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hub.token}` },
    body: JSON.stringify({ project, readOnly }),
  });
  const body = (await hubBody(res, url)) as { result?: { token?: string }; error?: { message?: string; key?: string; vars?: unknown } } | null;
  // The key and vars travel too: the MCP tells an archived or deleted project apart from any other refusal by them.
  if (!res.ok || !body?.result?.token) throw new HiveError(CODES[res.status] ?? "bad_request", body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
  return body.result.token;
}

/**
 * fetch, with a hub that cannot be reached (refused, DNS, offline, TLS) as HiveError "unavailable": the desktop
 * shows it as a lost connection and keeps drafts to send later, instead of as a failed request.
 */
async function reach(hub: string, url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new HiveError("unavailable", `Cannot reach the hub ${hub}: ${reason}`, { key: "errors.hubUnreachable", vars: { reason } });
  }
}

async function hubBody(res: Response, hub: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    // A timeout can arrive after headers, while the response body is still stalled.
    if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new HiveError("unavailable", `Cannot reach the hub ${hub}: ${err.message}`, { key: "errors.hubUnreachable", vars: { reason: err.message } });
    }
    return null;
  }
}
