import {
  HiveError,
  type ChatFile,
  type DesktopBridge,
  type HiveErrorCode,
  type Grant,
  type HubUser,
  type Me,
  type Method,
  type MethodInput,
  type MethodOutput,
  type Role,
  type TokenInfo,
  type WebhookInfo,
  type WebhookInput,
  type AppRelease,
  type AppRollout,
  type MachineUpdate,
  type AlertRule,
  type AlertRuleState,
  type FeedEvent,
  type HubAlert,
  type HubCleanup,
  type HubInfo,
} from "@xdev-hive/core";

/** What the UI needs from its host. The web hub implements it over HTTP, the desktop app over IPC. */
/** An account as a project's Thành viên page shows it (roadmap 25): admins have every permission. */
export interface ProjectMember {
  id: string;
  username: string;
  displayName: string;
  admin: boolean;
  grant: Grant | null;
}

export interface HiveClient {
  call<M extends Method>(method: M, input: MethodInput<M>): Promise<MethodOutput[M]>;
  me(): Promise<Me>;
  /** Hub only: API tokens for people and agents. */
  tokens?: {
    list(): Promise<TokenInfo[]>;
    create(name: string, role: Role): Promise<{ token: string; info: TokenInfo }>;
    revoke(id: string): Promise<void>;
  };
  /** Hub, signed in with an account: the person's own password. */
  account?: {
    changePassword(current: string, next: string): Promise<Me>;
    /** Where to send the browser to link the hub's SSO provider to this account. */
    linkSso(): Promise<{ url: string }>;
  };
  /** Hub, signed in with an account: let the desktop app waiting on this machine have a token (pages/Device.tsx). */
  device?: {
    authorize(input: { port: number; state: string; challenge: string; name: string }): Promise<{ url: string }>;
  };
  /** Hub only, for hub admins: accounts and their per-project grants. */
  users?: {
    list(): Promise<HubUser[]>;
    create(input: { username: string; displayName?: string; admin?: boolean }): Promise<{ user: HubUser; password: string }>;
    update(id: string, patch: { displayName?: string; admin?: boolean; disabled?: boolean }): Promise<HubUser>;
    /** shared: the Chung grant (null: from projects); left out, it stays as it is. */
    setGrants(id: string, grants: Record<string, Grant>, shared?: Grant | null): Promise<HubUser>;
    resetPassword(id: string): Promise<string>;
  };
  /** Hub only (roadmap 25): the accounts of a project (null: Chung) and their roles, for whoever may manage its members. */
  members?: {
    list(project: string | null): Promise<ProjectMember[]>;
    set(project: string | null, userId: string, grant: Grant | null): Promise<ProjectMember>;
  };
  /** Hub only, for hub admins: chat webhooks for hub events. */
  webhooks?: {
    list(): Promise<WebhookInfo[]>;
    save(input: WebhookInput): Promise<WebhookInfo>;
    remove(id: number): Promise<void>;
    test(id: number): Promise<{ ok: boolean; error: string | null }>;
  };
  /** Hub only, for hub admins: the desktop builds the hub hands out and their rollout (roadmap 22i). */
  releases?: {
    list(): Promise<{ releases: AppRelease[]; rollout: AppRollout; machines: MachineUpdate[] }>;
    setRollout(patch: Partial<Omit<AppRollout, "updatedBy" | "updatedAt">>): Promise<AppRollout>;
    notes(version: string, notes: string): Promise<void>;
  };
  /** Hub only, for hub admins: alert rules, open and recent alerts, the overview's feed (roadmap 22m). */
  alerts?: {
    list(): Promise<{ open: HubAlert[]; recent: HubAlert[]; rules: AlertRuleState[] }>;
    feed(limit?: number): Promise<FeedEvent[]>;
    ack(id: number): Promise<HubAlert>;
    setRule(rule: AlertRule, enabled: boolean): Promise<AlertRuleState>;
  };
  /** Hub only, for hub admins: the hub itself, and a backup on request (roadmap 22n). */
  hub?: {
    info(): Promise<HubInfo>;
    backup(): Promise<{ file: string; removed: number }>;
    /** "Dọn dữ liệu": old app builds, old artifacts of done tasks, then VACUUM. */
    cleanup(): Promise<HubCleanup>;
  };
  /** Desktop only: local projects, sync and agent installers. */
  desktop?: DesktopBridge;
  /** Web hub, signed in with an account: files attached to chat messages (roadmap 17g). */
  chatFiles?: {
    /** Uploads a file for the project's chat; chat.send attaches it by id. */
    upload(project: string, file: File): Promise<ChatFile>;
    /** Where the browser reads it with its session (an <img> or a download link). */
    href(id: number): string;
  };
}

export interface HttpClientOptions {
  baseUrl?: string;
  /** API token (machines, CI, old sign-ins). Without it the browser's session cookie is used. */
  token?: string;
  onUnauthorized?: () => void;
}

/** One JSON call to the hub. Cookie calls carry the header a cross-site page cannot send. */
async function hubRequest<T>(baseUrl: string, path: string, body: unknown, token?: string): Promise<{ status: number; result: T }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : { "x-hive-csrf": "1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return hubResult<T>(res);
}

/** The hub's answer, or its error with the key the UI translates. */
async function hubResult<T>(res: Response): Promise<{ status: number; result: T }> {
  const json = (await res.json().catch(() => null)) as {
    result?: T;
    error?: { code?: string; message?: string; key?: string; vars?: Record<string, string | number> };
  } | null;
  if (!res.ok || !json || json.error) {
    const e = json?.error;
    const err = new HiveError((e?.code as HiveErrorCode) ?? "bad_request", e?.message ?? `HTTP ${res.status}`, e?.key ? { key: e.key, vars: e.vars } : undefined);
    throw Object.assign(err, { status: res.status });
  }
  return { status: res.status, result: json.result as T };
}

/** Username + password sign-in: the hub sets an HttpOnly session cookie. */
export async function signIn(username: string, password: string, baseUrl = ""): Promise<Me> {
  return (await hubRequest<Me>(baseUrl, "/api/login", { username, password })).result;
}

/** What the sign-in page offers besides a password: the hub's OpenID Connect provider, if any. */
export async function signInProviders(baseUrl = ""): Promise<{ oidc: { name: string } | null }> {
  return (await hubRequest<{ oidc: { name: string } | null }>(baseUrl, "/api/auth/providers", undefined)).result;
}

export async function signOut(baseUrl = ""): Promise<void> {
  await hubRequest(baseUrl, "/api/logout", {}).catch(() => undefined);
}

export function createHttpClient({ baseUrl = "", token, onUnauthorized }: HttpClientOptions = {}): HiveClient {
  async function request<T>(path: string, body?: unknown): Promise<T> {
    try {
      return (await hubRequest<T>(baseUrl, path, body, token)).result;
    } catch (err) {
      if ((err as { status?: number }).status === 401) onUnauthorized?.();
      throw err;
    }
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
    ...(token
      ? {}
      : {
          account: {
            changePassword: (current: string, next: string) => request<Me>("/api/password", { current, next }),
            linkSso: () => request<{ url: string }>("/api/auth/oidc/link", {}),
          },
          device: {
            authorize: (input: { port: number; state: string; challenge: string; name: string }) => request<{ url: string }>("/api/device/authorize", input),
          },
        }),
    users: {
      list: () => rpc<HubUser[]>("users.list"),
      create: (input) => rpc<{ user: HubUser; password: string }>("users.create", input),
      update: (id, patch) => rpc<HubUser>("users.update", { id, ...patch }),
      setGrants: (id, grants, shared) => rpc<HubUser>("users.setGrants", { id, grants, ...(shared === undefined ? {} : { shared }) }),
      resetPassword: async (id) => (await rpc<{ password: string }>("users.resetPassword", { id })).password,
    },
    members: {
      list: (project) => rpc<ProjectMember[]>("members.list", { project }),
      set: (project, userId, grant) => rpc<ProjectMember>("members.set", { project, userId, grant }),
    },
    releases: {
      list: () => rpc<{ releases: AppRelease[]; rollout: AppRollout; machines: MachineUpdate[] }>("releases.list"),
      setRollout: (patch) => rpc<AppRollout>("releases.setRollout", patch),
      notes: async (version, notes) => {
        await rpc("releases.notes", { version, notes });
      },
    },
    hub: {
      info: () => rpc<HubInfo>("hub.info"),
      backup: () => rpc<{ file: string; removed: number; files: number | null }>("hub.backup"),
      cleanup: () => rpc<HubCleanup>("hub.cleanup"),
    },
    alerts: {
      list: () => rpc<{ open: HubAlert[]; recent: HubAlert[]; rules: AlertRuleState[] }>("alerts.list"),
      feed: (limit?: number) => rpc<FeedEvent[]>("alerts.feed", { limit }),
      ack: (id: number) => rpc<HubAlert>("alerts.ack", { id }),
      setRule: (rule: AlertRule, enabled: boolean) => rpc<AlertRuleState>("alerts.setRule", { rule, enabled }),
    },
    webhooks: {
      list: () => rpc<WebhookInfo[]>("webhooks.list"),
      save: (input) => rpc<WebhookInfo>("webhooks.save", input),
      remove: async (id) => {
        await rpc("webhooks.remove", { id });
      },
      test: (id) => rpc<{ ok: boolean; error: string | null }>("webhooks.test", { id }),
    },
    // An <img> cannot send a token: only with the session cookie.
    ...(token
      ? {}
      : {
          chatFiles: {
            upload: async (project: string, file: File) => {
              const query = `project=${encodeURIComponent(project)}&name=${encodeURIComponent(file.name)}`;
              const res = await fetch(`${baseUrl}/api/chat/files?${query}`, {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": file.type || "application/octet-stream", "x-hive-csrf": "1" },
                body: file,
              });
              try {
                return (await hubResult<ChatFile>(res)).result;
              } catch (err) {
                if (res.status === 401) onUnauthorized?.();
                throw err;
              }
            },
            href: (id: number) => `${baseUrl}/api/chat/files/${id}`,
          },
        }),
  };
}
