import { hostname } from "node:os";
import * as vscode from "vscode";
import { hubUrl, setHubUrl } from "@/auth/hub-url.ts";
import { listen } from "@/auth/loopback.ts";
import { pkce, tokenOrg } from "@/auth/pkce.ts";
import type { TokenStore } from "@/auth/store.ts";
import { t } from "@/lib/i18n.ts";
import "@/auth/strings.ts";

async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(t("auth.failed"));
  }
}

export interface HiveSession extends vscode.AuthenticationSession {
  hubUrl: string;
  orgId: string;
  orgName: string;
  role: string;
}

export class HiveAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changes.event;
  private session: HiveSession | undefined;
  private pending: Promise<HiveSession[]> | undefined;
  private login: Promise<HiveSession> | undefined;
  private cancelLogin: (() => void) | undefined;
  private generation = 0;
  private disposed = false;
  private readonly expired = new Set<string>();

  private readonly store: TokenStore;
  private readonly resolveHub: typeof hubUrl;
  constructor(store: TokenStore, resolveHub = hubUrl) {
    this.store = store;
    this.resolveHub = resolveHub;
  }

  private publish(next?: HiveSession): void {
    const old = this.session;
    this.session = next;
    if (!old && !next) return;
    if (
      old?.id === next?.id &&
      old?.accessToken === next?.accessToken &&
      old?.account.label === next?.account.label &&
      old?.role === next?.role
    )
      return;
    this.changes.fire({
      added: next && !old ? [next] : [],
      removed: old && !next ? [old] : [],
      changed: old && next ? [next] : [],
    });
  }

  async request(hub: string, path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("x-hive-org", tokenOrg(token) ?? "");
    const generation = this.generation;
    let response: Response;
    try {
      response = await fetch(`${hub}/api${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new Error(t("auth.network"));
    }
    if (response.status === 401) {
      if (generation === this.generation) await this.invalidate(hub);
      throw new Error(t("auth.expired"));
    }
    if (!response.ok) throw new Error(t("auth.failed"));
    return response;
  }

  private async identify(hub: string, token: string): Promise<HiveSession> {
    const orgId = tokenOrg(token);
    if (!orgId) throw new Error(t("auth.failed"));
    const me = await json<{ id: string; name: string; email: string }>(await this.request(hub, "/v1/me", token));
    const org = await json<{ id: string; name: string; role: string }>(
      await this.request(hub, `/v1/orgs/${orgId}`, token),
    );
    if (!me.id || !me.name || org.id !== orgId || !["owner", "admin", "member"].includes(org.role))
      throw new Error(t("auth.failed"));
    return {
      id: `${hub}:${me.id}:${orgId}`,
      account: { id: me.id, label: `${me.name} · ${org.name}` },
      accessToken: token,
      scopes: [],
      hubUrl: hub,
      orgId,
      orgName: org.name,
      role: org.role,
    };
  }

  getSessions(): Promise<HiveSession[]> {
    if (!this.pending) {
      const pending = this.restore().finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
      this.pending = pending;
    }
    return this.pending;
  }

  private async restore(): Promise<HiveSession[]> {
    const generation = this.generation;
    const hub = await this.resolveHub();
    if (!hub) {
      this.publish();
      return [];
    }
    const token = await this.store.read(hub);
    if (generation !== this.generation || this.disposed) return this.session ? [this.session] : [];
    if (!token) {
      this.publish();
      return [];
    }
    // Mỗi cửa sổ kiểm lại keychain để thấy thay đổi từ CLI và desktop.
    const next = await this.identify(hub, token);
    if (generation === this.generation && !this.disposed) this.publish(next);
    return this.session ? [this.session] : [];
  }

  reload(): Promise<HiveSession[]> {
    ++this.generation;
    this.cancelLogin?.();
    this.publish();
    this.pending = undefined;
    return this.getSessions();
  }

  createSession(): Promise<HiveSession> {
    this.login ??= this.signIn().finally(() => {
      this.login = undefined;
    });
    return this.login;
  }

  private async signIn(): Promise<HiveSession> {
    const hub = (await this.resolveHub()) ?? (await setHubUrl());
    if (!hub) throw new Error(t("auth.noHub"));
    if (this.disposed) throw new Error(t("auth.cancelled"));
    const generation = ++this.generation;
    const proof = pkce();
    const callback = await listen(proof.state);
    this.cancelLogin = callback.dispose;
    try {
      const local = `http://127.0.0.1:${callback.port}/callback`;
      const forwarded = vscode.env.remoteName
        ? (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString()
        : local;
      const external = new URL(forwarded);
      const port = Number(external.port);
      if (
        external.protocol !== "http:" ||
        !["127.0.0.1", "localhost"].includes(external.hostname) ||
        !Number.isInteger(port) ||
        port < 1024 ||
        port > 65535 ||
        external.pathname !== "/callback" ||
        external.search ||
        external.hash
      )
        throw new Error(t("auth.remote"));
      const url = new URL(`${hub}/desktop/connect`);
      const machine =
        hostname()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 63) || "vscode";
      url.search = new URLSearchParams({
        port: String(port),
        state: proof.state,
        challenge: proof.challenge,
        machine,
        purpose: "cli",
      }).toString();
      if (!(await vscode.env.openExternal(vscode.Uri.parse(url.toString())))) throw new Error(t("auth.failed"));
      const code = await callback.code;
      let response: Response;
      try {
        response = await fetch(`${hub}/api/v1/desktop/connect/exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, verifier: proof.verifier }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        throw new Error(t("auth.network"));
      }
      if (!response.ok) throw new Error(t("auth.failed"));
      const data = await json<{ personalToken?: string }>(response);
      if (typeof data.personalToken !== "string" || !tokenOrg(data.personalToken)) throw new Error(t("auth.failed"));
      const next = await this.identify(hub, data.personalToken);
      if (generation !== this.generation || this.disposed) throw new Error(t("auth.cancelled"));
      await this.store.write(hub, next.accessToken);
      this.expired.delete(hub);
      this.publish(next);
      return next;
    } finally {
      this.cancelLogin = undefined;
      callback.dispose();
    }
  }

  async invalidate(hub = this.session?.hubUrl): Promise<void> {
    if (!hub || this.expired.has(hub)) return;
    this.expired.add(hub);
    ++this.generation;
    this.cancelLogin?.();
    this.publish();
    if (hub) await this.store.remove(hub);
    void vscode.window.showInformationMessage(t("auth.expired"), t("auth.again")).then((choice) => {
      if (choice === t("auth.again")) void vscode.commands.executeCommand("xdevHive.signIn");
    });
  }

  async removeSession(id: string): Promise<void> {
    if (this.session?.id !== id) return;
    const choice = await vscode.window.showWarningMessage(
      t("auth.signOut"),
      { modal: true },
      t("auth.local"),
      t("auth.all"),
    );
    if (!choice || this.session?.id !== id) return;
    ++this.generation;
    this.cancelLogin?.();
    await this.store.remove(this.session.hubUrl, choice === t("auth.all"));
    this.publish();
  }

  dispose(): void {
    this.disposed = true;
    ++this.generation;
    this.cancelLogin?.();
    this.session = undefined;
    this.changes.dispose();
  }
}
