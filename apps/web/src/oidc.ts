// Sign-in through an OpenID Connect provider (GitLab, Entra, Google…): authorization code flow with PKCE,
// state and nonce. The ID token comes straight from the token endpoint over TLS, which OIDC Core (3.1.3.7)
// accepts in place of checking its signature; its issuer, audience, expiry and nonce are still checked.
import { createHash, randomBytes } from "node:crypto";
import { HiveError, type HiveErrorCode } from "@xdev-hive/core";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Button label: "GitLab", "Microsoft"… */
  name: string;
  scopes: string;
  /** Must match the redirect URI registered with the provider. */
  redirectUri: string;
}

/** The person as the provider tells it. Never matched to an existing account by name or email. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  username: string | null;
  name: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Error keys the callback can send back to the page (?sso_error=…); the page shows only these. */
export const SSO_ERRORS = [
  "errors.ssoState", "errors.ssoProvider", "errors.ssoToken", "errors.ssoClaims", "errors.ssoDisabled", "errors.ssoLinkedElsewhere",
  // A terminal step-up through the provider (69c).
  "errors.terminal.stepUpStale", "errors.terminal.stepUpWrongAccount", "errors.terminal.stepUpRequired",
] as const;
export type SsoError = (typeof SSO_ERRORS)[number];

const fail = (key: SsoError, message: string, code: HiveErrorCode = "unauthorized") => new HiveError(code, message, { key });

const loopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** HIVE_OIDC_*: null unless issuer, client id and secret are all set. The issuer must be https (loopback is for tests). */
export function oidcSettings(env: NodeJS.ProcessEnv, publicUrl: string | null): OidcSettings | null {
  const issuer = env.HIVE_OIDC_ISSUER?.trim().replace(/\/+$/, "");
  const clientId = env.HIVE_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.HIVE_OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  const url = new URL(issuer);
  if (url.protocol !== "https:" && !loopback(url)) throw new Error("HIVE_OIDC_ISSUER must be an https:// URL");
  const base = (publicUrl ?? "").replace(/\/+$/, "");
  if (!base) throw new Error("SSO needs the hub's public URL: set HIVE_PUBLIC_URL (or HIVE_ALLOWED_HOSTS)");
  return {
    issuer,
    clientId,
    clientSecret,
    name: env.HIVE_OIDC_NAME?.trim() || "SSO",
    scopes: env.HIVE_OIDC_SCOPES?.trim() || "openid profile email",
    redirectUri: `${base}/api/auth/oidc/callback`,
  };
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  token_endpoint_auth_methods_supported?: string[];
}

/**
 * A signed-in person proving themselves again (the remote terminal's step-up, 69c) instead of signing in: the
 * provider is asked for a fresh login, and the callback gets back what the hub put here.
 */
export interface OidcReauth<T = unknown> {
  userId: string;
  context: T;
}

interface Pending {
  nonce: string;
  verifier: string;
  /** Linking the provider account to this signed-in user instead of signing in. */
  linkUserId: string | null;
  reauth: OidcReauth | null;
  /** Hub path to land on afterwards (the desktop's sign-in page). */
  returnTo: string;
  /** When the hub sent the person to the provider: a reauthentication must have happened after it. */
  startedAt: number;
  expires: number;
}

/** Only a path on the hub itself: "/…" but not "//host" or "/\\host". */
export const safeReturn = (v: unknown): string =>
  typeof v === "string" && v.length <= 1000 && /^\/(?![/\\])/.test(v) && !/[\u0000-\u001f]/.test(v) ? v : "/";

const b64url = (buf: Buffer) => buf.toString("base64url");
/** A sign-in has this long between leaving for the provider and coming back. */
const PENDING_MS = 10 * 60_000;
const MAX_PENDING = 1000;
const DISCOVERY_MS = 60 * 60_000;
/** Clock difference tolerated between the hub and the provider. */
const SKEW_S = 120;

export class OidcClient {
  readonly settings: OidcSettings;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  #discovery: { value: Discovery; at: number } | null = null;

  constructor(settings: OidcSettings, opts: { fetch?: FetchLike; now?: () => number } = {}) {
    this.settings = settings;
    this.#fetch = opts.fetch ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  async #discover(): Promise<Discovery> {
    if (this.#discovery && this.#now() - this.#discovery.at < DISCOVERY_MS) return this.#discovery.value;
    let doc: Partial<Discovery>;
    try {
      const res = await this.#fetch(`${this.settings.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      doc = (await res.json()) as Partial<Discovery>;
    } catch (err) {
      throw fail("errors.ssoProvider", `OIDC discovery failed: ${(err as Error).message}`, "bad_request");
    }
    // The issuer the provider names must be the one configured, or its tokens are someone else's.
    if (doc.issuer?.replace(/\/+$/, "") !== this.settings.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
      throw fail("errors.ssoProvider", "OIDC discovery document does not match the configured issuer", "bad_request");
    }
    const value = doc as Discovery;
    this.#discovery = { value, at: this.#now() };
    return value;
  }

  /** Where to send the browser, and the state its cookie must carry back. */
  async start(opts: { linkUserId?: string; returnTo?: string; reauth?: OidcReauth } = {}): Promise<{ url: string; state: string }> {
    const d = await this.#discover();
    const now = this.#now();
    for (const [k, p] of this.#pending) if (p.expires < now) this.#pending.delete(k);
    if (this.#pending.size >= MAX_PENDING) this.#pending.delete(this.#pending.keys().next().value!);
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    this.#pending.set(state, {
      nonce, verifier, linkUserId: opts.linkUserId ?? null, reauth: opts.reauth ?? null, returnTo: safeReturn(opts.returnTo), startedAt: now,
      expires: now + PENDING_MS,
    });
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      scope: this.settings.scopes,
      state,
      nonce,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      // A step-up must not ride on the provider's own session (a silent SSO redirect): ask for a login now, and for
      // auth_time to tell when it happened (OIDC Core 3.1.2.1 makes auth_time required with max_age).
      ...(opts.reauth ? { prompt: "login", max_age: "0" } : {}),
    }).toString();
    return { url: url.toString(), state };
  }

  /**
   * Exchanges the code; each state works once. For a reauthentication, a provider that does not prove the person
   * signed in after the hub sent them (no auth_time, or an older one) fails it: there is no fallback.
   */
  async finish(state: string, code: string): Promise<{ identity: OidcIdentity; linkUserId: string | null; reauth: OidcReauth | null; authTime: number | null; returnTo: string }> {
    const pending = this.#pending.get(state);
    this.#pending.delete(state);
    if (!pending || pending.expires < this.#now()) throw fail("errors.ssoState", "Unknown or expired sign-in attempt");
    const d = await this.#discover();
    const { clientId, clientSecret, redirectUri } = this.settings;
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: pending.verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    // client_secret_basic is the default when the provider lists nothing.
    const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (methods.includes("client_secret_basic")) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`;
    } else {
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
    }
    let tokens: { id_token?: unknown };
    try {
      const res = await this.#fetch(d.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tokens = (await res.json()) as { id_token?: unknown };
    } catch (err) {
      throw fail("errors.ssoToken", `Token exchange failed: ${(err as Error).message}`);
    }
    if (typeof tokens.id_token !== "string") throw fail("errors.ssoToken", "The provider sent no ID token (is the openid scope allowed?)");
    const { identity, authTime } = this.#claims(tokens.id_token, d.issuer, pending.nonce);
    if (pending.reauth && (authTime === null || authTime < pending.startedAt / 1000 - SKEW_S))
      throw new HiveError("unauthorized", "The provider did not confirm a fresh sign-in (auth_time)", { key: "errors.terminal.stepUpStale" });
    return { identity, linkUserId: pending.linkUserId, reauth: pending.reauth, authTime, returnTo: pending.returnTo };
  }

  #claims(idToken: string, issuer: string, nonce: string): { identity: OidcIdentity; authTime: number | null } {
    let c: Record<string, unknown>;
    try {
      c = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      throw fail("errors.ssoClaims", "Unreadable ID token");
    }
    const now = this.#now() / 1000;
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    const problem =
      c.iss !== issuer
        ? "issuer"
        : !aud.includes(this.settings.clientId)
          ? "audience"
          : aud.length > 1 && c.azp !== this.settings.clientId
            ? "authorized party"
            : typeof c.exp !== "number" || c.exp < now - SKEW_S
              ? "expiry"
              : typeof c.iat === "number" && c.iat > now + SKEW_S
                ? "issued in the future"
                : c.nonce !== nonce
                  ? "nonce"
                  : typeof c.sub !== "string" || !c.sub
                    ? "subject"
                    : null;
    if (problem) throw fail("errors.ssoClaims", `ID token failed the ${problem} check`);
    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    return {
      identity: {
        issuer,
        subject: c.sub as string,
        // An address the provider did not verify is only a label here: nothing is matched on it.
        email: c.email_verified === false ? null : text(c.email),
        username: text(c.preferred_username) ?? text(c.nickname),
        name: text(c.name),
      },
      authTime: typeof c.auth_time === "number" && Number.isFinite(c.auth_time) ? c.auth_time : null,
    };
  }
}
