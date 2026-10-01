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
  const body = (await res.json().catch(() => null)) as
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

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.#token = token;
  }

  /** Who the hub thinks we are (name and role come from the token). */
  async me(label: string): Promise<Me> {
    const res = await reach(this.url, `${this.url}/api/me`, {
      headers: { authorization: `Bearer ${this.#token}`, "x-hive-agent": label },
    });
    const body = (await res.json().catch(() => null)) as { result?: Me; error?: { code?: string; message?: string; key?: string; vars?: unknown } } | null;
    if (!res.ok || !body?.result) {
      throw new HiveError((body?.error?.code as HiveErrorCode) ?? CODES[res.status] ?? "bad_request", body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
    }
    return body.result;
  }

  async call<M extends Method>(method: M, input: MethodInput<M>, actor: Actor): Promise<MethodOutput[M]> {
    const res = await reach(this.url, `${this.url}/api/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
        "x-hive-agent": actor.name,
        ...(actor.source ? { "x-hive-source": sourceHeader(actor.source) } : {}),
      },
      body: JSON.stringify({ method, input }),
    });
    const body = (await res.json().catch(() => null)) as
      | { result?: MethodOutput[M]; error?: { code?: string; message?: string; key?: string; vars?: unknown } }
      | null;
    if (!res.ok || !body || body.error) {
      const code = (body?.error?.code as HiveErrorCode | undefined) ?? CODES[res.status] ?? "bad_request";
      throw new HiveError(code, body?.error?.message ?? `Hub responded ${res.status}`, textOf(body?.error));
    }
    return body.result as MethodOutput[M];
  }
}

/**
 * fetch, with a hub that cannot be reached (refused, DNS, offline, TLS) as HiveError "unavailable": the desktop
 * shows it as a lost connection and keeps drafts to send later, instead of as a failed request.
 */
async function reach(hub: string, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const reason = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new HiveError("unavailable", `Cannot reach the hub ${hub}: ${reason}`, { key: "errors.hubUnreachable", vars: { reason } });
  }
}
