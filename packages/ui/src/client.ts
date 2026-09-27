import {
  HiveError,
  type DesktopBridge,
  type HiveErrorCode,
  type Me,
  type Method,
  type MethodInput,
  type MethodOutput,
  type Role,
  type TokenInfo,
} from "@xdev-hive/core";

/** What the UI needs from its host. The web hub implements it over HTTP, the desktop app over IPC. */
export interface HiveClient {
  call<M extends Method>(method: M, input: MethodInput<M>): Promise<MethodOutput[M]>;
  me(): Promise<Me>;
  /** Hub only: API tokens for people and agents. */
  tokens?: {
    list(): Promise<TokenInfo[]>;
    create(name: string, role: Role): Promise<{ token: string; info: TokenInfo }>;
    revoke(id: string): Promise<void>;
  };
  /** Desktop only: local projects, sync and agent installers. */
  desktop?: DesktopBridge;
}

export interface HttpClientOptions {
  baseUrl?: string;
  token: string;
  onUnauthorized?: () => void;
}

export function createHttpClient({ baseUrl = "", token, onUnauthorized }: HttpClientOptions): HiveClient {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { result?: T; error?: { code?: string; message?: string } } | null;
    if (res.status === 401) onUnauthorized?.();
    if (!res.ok || !json || json.error) {
      throw new HiveError((json?.error?.code as HiveErrorCode) ?? "bad_request", json?.error?.message ?? `HTTP ${res.status}`);
    }
    return json.result as T;
  }
  const rpc = <T>(method: string, input?: unknown) => request<T>("/api/rpc", { method, input });

  return {
    call: (method, input) => rpc(method, input),
    me: () => request<Me>("/api/me"),
    tokens: {
      list: () => rpc<TokenInfo[]>("tokens.list"),
      create: (name, role) => rpc<{ token: string; info: TokenInfo }>("tokens.create", { name, role }),
      revoke: async (id) => {
        await rpc("tokens.revoke", { id });
      },
    },
  };
}
