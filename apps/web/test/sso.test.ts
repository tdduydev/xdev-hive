import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "../src/app.ts";
import { OidcClient, oidcSettings } from "../src/oidc.ts";
import { TokenStore } from "../src/tokens.ts";
import { UserStore } from "../src/users.ts";

const CLIENT_ID = "hive-test";
const CLIENT_SECRET = `secret-${randomBytes(8).toString("hex")}`;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ── A tiny provider: discovery and a token endpoint that hands out the ID token a test prepared ──
interface Grant {
  claims: Record<string, unknown>;
  challenge: string;
}
let issuer = "";
const grants = new Map<string, Grant>();
let discoveryIssuer: string | null = null;
const provider = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.url === "/.well-known/openid-configuration") {
      return send(200, {
        issuer: discoveryIssuer ?? issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      });
    }
    if (req.url === "/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const auth = Buffer.from((req.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      if (auth !== `${CLIENT_ID}:${CLIENT_SECRET}`) return send(401, { error: "invalid_client" });
      const grant = grants.get(form.get("code") ?? "");
      grants.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!grant || createHash("sha256").update(verifier).digest("base64url") !== grant.challenge) return send(400, { error: "invalid_grant" });
      return send(200, { access_token: "at", token_type: "Bearer", id_token: `${b64({ alg: "RS256" })}.${b64(grant.claims)}.sig` });
    }
    send(404, {});
  });
});

let base = "";
let hub: ReturnType<ReturnType<typeof createHubApp>["listen"]>;
let users: UserStore;
let hive: SqliteHive;

before(async () => {
  provider.listen(0, "127.0.0.1");
  await new Promise((r) => provider.once("listening", r));
  issuer = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  hive = new SqliteHive(":memory:");
  users = new UserStore(hive.db);
  // The redirect URI does not matter to the fake provider; the hub's own address is set once it listens.
  const settings = oidcSettings({ HIVE_OIDC_ISSUER: issuer, HIVE_OIDC_CLIENT_ID: CLIENT_ID, HIVE_OIDC_CLIENT_SECRET: CLIENT_SECRET, HIVE_OIDC_NAME: "GitLab" }, "http://hub.test")!;
  const app = createHubApp({ hive, tokens: new TokenStore(hive.db), users, allowedHosts: ["127.0.0.1", "localhost"], oidc: new OidcClient(settings) });
  hub = app.listen(0, "127.0.0.1");
  await new Promise((r) => hub.once("listening", r));
  base = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
});
after(() => {
  hub.close();
  provider.close();
});

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;

/** Leaves for the provider (start or link), "signs in" there with these claims, comes back. */
async function roundTrip(claims: (p: { nonce: string }) => Record<string, unknown>, opts: { session?: string; cookie?: string | null; returnTo?: string } = {}) {
  const start = opts.session
    ? await fetch(`${base}/api/auth/oidc/link`, {
        method: "POST",
        headers: { cookie: `hive_session=${opts.session}`, "x-hive-csrf": "1", "content-type": "application/json" },
        body: "{}",
      })
    : await fetch(`${base}/api/auth/oidc/start${opts.returnTo ? `?return=${encodeURIComponent(opts.returnTo)}` : ""}`, { redirect: "manual" });
  const to = new URL(opts.session ? ((await start.clone().json()) as { result: { url: string } }).result.url : start.headers.get("location")!);
  const state = cookieOf(start, "hive_oidc")!;
  assert.equal(to.searchParams.get("state"), state);
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  const code = randomBytes(6).toString("hex");
  grants.set(code, { claims: claims({ nonce: to.searchParams.get("nonce")! }), challenge: to.searchParams.get("code_challenge")! });
  const cookie = opts.cookie === undefined ? state : opts.cookie;
  const back = await fetch(`${base}/api/auth/oidc/callback?code=${code}&state=${state}`, { redirect: "manual", headers: cookie ? { cookie: `hive_oidc=${cookie}` } : {} });
  return { location: back.headers.get("location"), session: cookieOf(back, "hive_session"), state };
}
const now = () => Math.floor(Date.now() / 1000);
const good = (sub: string, extra: Record<string, unknown> = {}) => (p: { nonce: string }) => ({
  iss: issuer,
  aud: CLIENT_ID,
  sub,
  nonce: p.nonce,
  iat: now(),
  exp: now() + 300,
  ...extra,
});
const me = async (session: string) => (await (await fetch(`${base}/api/me`, { headers: { cookie: `hive_session=${session}` } })).json()) as { result: any };

describe("SSO (OpenID Connect)", () => {
  it("tells the sign-in page about the provider", async () => {
    assert.deepEqual(((await (await fetch(`${base}/api/auth/providers`)).json()) as { result: unknown }).result, { oidc: { name: "GitLab" } });
  });

  it("signs in a new person as an account with no project, and the same account next time", async () => {
    const first = await roundTrip(good("u-lan", { preferred_username: "Lan.Nguyen", name: "Lan Nguyễn", email: "lan@example.com" }));
    assert.equal(first.location, "/");
    const who = (await me(first.session!)).result;
    assert.equal(who.user.username, "lan.nguyen");
    assert.equal(who.user.displayName, "Lan Nguyễn");
    assert.equal(who.user.admin, false);
    assert.equal(who.user.mustChangePassword, false);
    assert.deepEqual(who.access, { projects: {} }, "no project until an admin grants one");
    assert.deepEqual(who.sso, { name: "GitLab", linked: true });

    const again = await roundTrip(good("u-lan", { preferred_username: "lan.nguyen" }));
    assert.equal((await me(again.session!)).result.user.id, who.user.id);
    assert.equal(users.list().filter((u) => u.username.startsWith("lan")).length, 1);
    const [entry] = await hive.call("admin.audit", { limit: 1 }, { name: "t", role: "admin" });
    assert.equal(entry!.action, "auth.login");
  });

  it("never takes over an existing account by name or email", async () => {
    users.create({ username: "duy", password: `pw-${randomBytes(8).toString("hex")}` });
    const r = await roundTrip(good("u-other-duy", { preferred_username: "duy", email: "duythq@example.com" }));
    assert.equal((await me(r.session!)).result.user.username, "duy-2");
    const noName = await roundTrip(good("u-viet", { email: "Nguyễn.Văn.Đức@example.com" }));
    assert.equal((await me(noName.session!)).result.user.username, "nguyen.van.duc");
  });

  it("links a signed-in account, after which SSO signs in to it", async () => {
    const temp = `pw-${randomBytes(8).toString("hex")}`;
    const next = `pw-${randomBytes(8).toString("hex")}`;
    const { user } = users.create({ username: "minh", password: temp });
    users.changePassword(user.id, temp, next);
    const session = users.startSession(user.id).token;
    assert.deepEqual((await me(session)).result.sso, { name: "GitLab", linked: false });

    const linked = await roundTrip(good("u-minh"), { session });
    assert.equal(linked.location, "/");
    assert.equal(linked.session, null, "linking keeps the session it had");
    assert.equal((await me(session)).result.sso.linked, true);
    const viaSso = await roundTrip(good("u-minh"));
    assert.equal((await me(viaSso.session!)).result.user.id, user.id);

    // The provider account of Lan cannot be added to Minh's.
    const taken = await roundTrip(good("u-lan"), { session });
    assert.equal(taken.location, "/?sso_error=errors.ssoLinkedElsewhere");
  });

  it("refuses a return that is not this browser's, a replay, and bad ID tokens", async () => {
    assert.equal((await roundTrip(good("u-x"), { cookie: null })).location, "/?sso_error=errors.ssoState");
    assert.equal((await roundTrip(good("u-x"), { cookie: "someone-else" })).location, "/?sso_error=errors.ssoState");
    for (const bad of [
      { nonce: "wrong" },
      { aud: "another-client" },
      { aud: [CLIENT_ID, "another-client"] },
      { iss: "https://evil.example" },
      { exp: now() - 3600 },
      { sub: "" },
    ]) {
      const r = await roundTrip((p) => ({ ...good("u-x")(p), ...bad }));
      assert.equal(r.location, "/?sso_error=errors.ssoClaims", JSON.stringify(bad));
      assert.equal(r.session, null);
    }
    // A state is used once: the same return again is refused.
    const ok = await roundTrip(good("u-replay"));
    const replay = await fetch(`${base}/api/auth/oidc/callback?code=x&state=${ok.state}`, { redirect: "manual", headers: { cookie: `hive_oidc=${ok.state}` } });
    assert.equal(replay.headers.get("location"), "/?sso_error=errors.ssoState");
    const denied = await fetch(`${base}/api/auth/oidc/callback?error=access_denied&state=x`, { redirect: "manual" });
    assert.equal(denied.headers.get("location"), "/?sso_error=errors.ssoProvider");
    assert.equal(users.list().some((u) => u.username === "u-x"), false);
  });

  it("comes back to the page it left from, on the hub only", async () => {
    const device = "/#/device?port=53123&state=abcdefabcdefabcdef";
    assert.equal((await roundTrip(good("u-back"), { returnTo: device })).location, device);
    assert.equal((await roundTrip(good("u-back"), { returnTo: "//evil.example/x" })).location, "/");
  });

  it("keeps a disabled account out", async () => {
    const first = await roundTrip(good("u-gone", { preferred_username: "gone" }));
    const id = (await me(first.session!)).result.user.id;
    users.update(id, { disabled: true });
    assert.equal((await roundTrip(good("u-gone"))).location, "/?sso_error=errors.ssoDisabled");
  });

  it("stops when the provider's discovery names another issuer, or the secret is wrong", async () => {
    discoveryIssuer = "https://evil.example";
    const client = new OidcClient(oidcSettings({ HIVE_OIDC_ISSUER: issuer, HIVE_OIDC_CLIENT_ID: CLIENT_ID, HIVE_OIDC_CLIENT_SECRET: CLIENT_SECRET }, "http://hub.test")!);
    await assert.rejects(client.start(), (e: unknown) => (e as { key?: string }).key === "errors.ssoProvider");
    discoveryIssuer = null;
    const wrong = new OidcClient(oidcSettings({ HIVE_OIDC_ISSUER: issuer, HIVE_OIDC_CLIENT_ID: CLIENT_ID, HIVE_OIDC_CLIENT_SECRET: "nope" }, "http://hub.test")!);
    const { state } = await wrong.start();
    await assert.rejects(wrong.finish(state, "code"), (e: unknown) => (e as { key?: string }).key === "errors.ssoToken");
  });

  it("reads its settings from the environment", () => {
    assert.equal(oidcSettings({}, "https://hive.example.com"), null);
    const s = oidcSettings({ HIVE_OIDC_ISSUER: "https://gitlab.example.com/", HIVE_OIDC_CLIENT_ID: "id", HIVE_OIDC_CLIENT_SECRET: "s" }, "https://hive.example.com")!;
    assert.deepEqual(s, {
      issuer: "https://gitlab.example.com",
      clientId: "id",
      clientSecret: "s",
      name: "SSO",
      scopes: "openid profile email",
      redirectUri: "https://hive.example.com/api/auth/oidc/callback",
    });
    assert.throws(() => oidcSettings({ HIVE_OIDC_ISSUER: "http://gitlab.example.com", HIVE_OIDC_CLIENT_ID: "id", HIVE_OIDC_CLIENT_SECRET: "s" }, "https://x"), /https/);
  });
});

describe("hub without SSO", () => {
  it("offers no provider and has no SSO routes", async () => {
    const plain = new SqliteHive(":memory:");
    const app = createHubApp({ hive: plain, tokens: new TokenStore(plain.db), users: new UserStore(plain.db), allowedHosts: ["127.0.0.1"] });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.deepEqual(((await (await fetch(`${url}/api/auth/providers`)).json()) as { result: unknown }).result, { oidc: null });
    assert.equal((await fetch(`${url}/api/auth/oidc/start`, { redirect: "manual" })).status, 404);
    server.close();
  });
});
