import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { createHubApp } from "../src/app.ts";
import { safeReturn } from "../src/oidc.ts";
import { TokenStore } from "../src/tokens.ts";
import { UserStore } from "../src/users.ts";

let base = "";
let close: () => void;
let users: UserStore;
let tokens: TokenStore;
let session = "";
let userId = "";

before(async () => {
  const hive = new SqliteHive(":memory:");
  users = new UserStore(hive.db);
  tokens = new TokenStore(hive.db);
  const temp = `pw-${randomBytes(8).toString("hex")}`;
  const { user } = users.create({ username: "lan", password: temp });
  users.changePassword(user.id, temp, `pw-${randomBytes(8).toString("hex")}`);
  users.setGrants(user.id, { app: "contribute" });
  userId = user.id;
  session = users.startSession(user.id).token;
  const server = createHubApp({ hive, tokens, users, allowedHosts: ["127.0.0.1"] }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { result?: any; error?: { key?: string } } };
};
const asLan = { cookie: `hive_session=${session}`, "x-hive-csrf": "1" };
const authorize = (challenge: string, extra: Record<string, unknown> = {}, headers = asLan) =>
  post("/api/device/authorize", { port: 53123, state: "s".repeat(32), challenge, name: "duy mbp/1", ...extra }, headers);

describe("desktop sign-in through the browser", () => {
  it("sends a one-time code to the loopback address, traded with the verifier for a token of the account", async () => {
    const { verifier, challenge } = pkce();
    const { status, body } = await authorize(challenge);
    assert.equal(status, 200);
    const url = new URL(body.result.url);
    assert.equal(url.origin, "http://127.0.0.1:53123");
    assert.equal(url.pathname, "/callback");
    assert.equal(url.searchParams.get("state"), "s".repeat(32));
    const code = url.searchParams.get("code")!;

    const exchanged = await post("/api/device-token/exchange", { code, verifier });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.result.user.username, "lan");
    assert.equal(exchanged.body.result.info.name, "duy-mbp-1", "machine name cleaned");
    const me = (await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${exchanged.body.result.token}` } })).json()) as { result: any };
    assert.deepEqual([me.result.user.username, me.result.access], ["lan", { projects: { app: "contribute" } }]);

    const again = await post("/api/device-token/exchange", { code, verifier });
    assert.equal(again.status, 401, "a code works once");
    assert.equal(again.body.error?.key, "errors.deviceCode");
  });

  it("gives nothing for the wrong verifier, and burns the code", async () => {
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge)).body.result.url).searchParams.get("code")!;
    assert.equal((await post("/api/device-token/exchange", { code, verifier: pkce().verifier })).status, 401);
    assert.equal((await post("/api/device-token/exchange", { code, verifier })).status, 401);
  });

  it("replaces the machine's earlier token when it signs in again", async () => {
    const one = pkce();
    const first = await post("/api/device-token/exchange", { code: new URL((await authorize(one.challenge, { name: "box" })).body.result.url).searchParams.get("code"), verifier: one.verifier });
    const two = pkce();
    await post("/api/device-token/exchange", { code: new URL((await authorize(two.challenge, { name: "box" })).body.result.url).searchParams.get("code"), verifier: two.verifier });
    assert.equal(tokens.list(userId).filter((t) => t.name === "box").length, 1);
    assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${first.body.result.token}` } })).status, 401);
  });

  it("checks the request and who asks", async () => {
    const { challenge } = pkce();
    for (const bad of [{ port: 80 }, { port: 70000 }, { port: "53123" }, { state: "short" }, { challenge: "x" }]) {
      const r = await authorize(challenge, bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.equal(r.body.error?.key, "errors.deviceRequest");
    }
    assert.equal((await authorize(challenge, {}, { cookie: `hive_session=${session}` } as typeof asLan)).status, 403, "cookie writes need the CSRF header");
    assert.equal((await authorize(challenge, {}, {} as typeof asLan)).status, 401);
    const noAccount = tokens.create("ci", "admin").token;
    const r = await authorize(challenge, {}, { authorization: `Bearer ${noAccount}` } as unknown as typeof asLan);
    assert.equal(r.body.error?.key, "errors.tokenNoAccount");
  });

  it("gives no token to an account disabled in between", async () => {
    const temp = `pw-${randomBytes(8).toString("hex")}`;
    const { user } = users.create({ username: "minh", password: temp });
    users.changePassword(user.id, temp, `pw-${randomBytes(8).toString("hex")}`);
    const cookie = { cookie: `hive_session=${users.startSession(user.id).token}`, "x-hive-csrf": "1" };
    const { verifier, challenge } = pkce();
    const code = new URL((await authorize(challenge, {}, cookie)).body.result.url).searchParams.get("code");
    users.update(user.id, { disabled: true });
    assert.equal((await post("/api/device-token/exchange", { code, verifier })).status, 401);
  });

  it("keeps SSO return paths on the hub", () => {
    assert.equal(safeReturn("/#/device?port=5000&state=abc"), "/#/device?port=5000&state=abc");
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "evil", "/\nx", undefined, "/".padEnd(2000, "a")]) assert.equal(safeReturn(bad), "/");
  });
});
