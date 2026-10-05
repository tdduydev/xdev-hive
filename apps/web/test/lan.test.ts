// The hub behind the LAN proxy of deploy/compose.lan.yaml (roadmap 43): a browser there reaches it by IP or
// machine name on a port, over plain HTTP, and the proxy is what decides the client's address and scheme.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { SqliteHive } from "@xdev-hive/core/node";
import { allowedHostsFor, createHubApp } from "#web/app.ts";
import { TokenStore } from "#web/tokens.ts";
import { LoginThrottle, UserStore } from "#web/users.ts";

const LAN_HOSTS = "10.86.140.52, hc-duytd20-linux";
let port = 0;
let close: () => void;
let password = "";

before(async () => {
  const hive = new SqliteHive(":memory:");
  hive.seed("hub");
  const users = new UserStore(hive.db);
  password = users.create({ username: "lan", displayName: "Lan" }).password;
  const app = createHubApp({
    hive,
    tokens: new TokenStore(hive.db),
    users,
    allowedHosts: allowedHostsFor("hive.xdev.asia", "0.0.0.0", LAN_HOSTS),
    // As in compose.yaml: the hub is only reached through a proxy, so it believes its X-Forwarded-* headers.
    trustProxy: true,
    throttle: new LoginThrottle(2, 60_000),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  port = (server.address() as AddressInfo).port;
  close = () => server.close();
});
after(() => close());

/** fetch() keeps the Host header to itself, so these go out through node:http. */
function send(path: string, { host, headers = {}, body }: { host: string; headers?: Record<string, string>; body?: unknown }) {
  return new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method: payload === undefined ? "GET" : "POST", setHost: false },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, cookie: res.headers["set-cookie"]?.[0] ?? "", body: text }));
      },
    );
    req.on("error", reject);
    req.setHeader("host", host);
    if (payload !== undefined) {
      req.setHeader("content-type", "application/json");
      req.setHeader("x-hive-csrf", "1");
    }
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    req.end(payload);
  });
}

describe("the hub on a LAN port", () => {
  it("answers to a LAN name or address with the port in the Host header", async () => {
    assert.equal((await send("/api/health", { host: "10.86.140.52:7780" })).status, 200, "the address a LAN browser shows");
    assert.equal((await send("/api/health", { host: "hc-duytd20-linux:7780" })).status, 200);
    assert.equal((await send("/api/health", { host: "hive.xdev.asia" })).status, 200, "the public hostname still works");
    assert.equal((await send("/api/health", { host: "127.0.0.1:7780" })).status, 200, "health check of the container");
    assert.equal((await send("/api/health", { host: "10.86.140.53:7780" })).status, 403, "another machine on the same network");
    assert.equal((await send("/api/health", { host: "attacker.example.com" })).status, 403);
  });

  it("leaves Secure off the session cookie of a sign-in over http, and keeps it over https", async () => {
    const lan = await send("/api/login", {
      host: "10.86.140.52:7780",
      headers: { "x-forwarded-proto": "http", origin: "http://10.86.140.52:7780" },
      body: { username: "lan", password },
    });
    assert.equal(lan.status, 200, lan.body);
    assert.match(lan.cookie, /^hive_session=hs_[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(lan.cookie, /Secure/, "a http page never sends a Secure cookie back: sign-in would not hold");

    const proxied = await send("/api/login", {
      host: "hive.xdev.asia",
      headers: { "x-forwarded-proto": "https", origin: "https://hive.xdev.asia" },
      body: { username: "lan", password },
    });
    assert.equal(proxied.status, 200, proxied.body);
    assert.match(proxied.cookie, /; Secure$/);
  });

  // Why Caddyfile.lan drops the client's X-Forwarded-For before proxying: the hub counts wrong sign-ins per
  // address, so a machine that could name its own address would get as many tries as it likes.
  it("counts wrong passwords per X-Forwarded-For address", async () => {
    const attempt = (forwardedFor: string) =>
      send("/api/login", {
        host: "10.86.140.52:7780",
        headers: { "x-forwarded-for": forwardedFor, origin: "http://10.86.140.52:7780" },
        body: { username: "lan", password: "wrong-password" },
      });
    assert.equal((await attempt("10.86.140.77")).status, 401);
    assert.equal((await attempt("10.86.140.77, 10.86.140.52")).status, 401, "the first address of the list is the client");
    assert.equal((await attempt("10.86.140.77")).status, 403, "two wrong tries: that address waits");
    assert.equal((await attempt("10.86.140.78")).status, 401, "another address still has its tries");
  });
});

describe("allowed hosts of a LAN hub", () => {
  it("adds the LAN names after the public one and drops a port written into the list", () => {
    assert.deepEqual(allowedHostsFor("hive.xdev.asia", "0.0.0.0", LAN_HOSTS), [
      "hive.xdev.asia",
      "10.86.140.52",
      "hc-duytd20-linux",
      "localhost",
      "127.0.0.1",
      "[::1]",
    ]);
    assert.deepEqual(
      allowedHostsFor("", "0.0.0.0", "10.86.140.52:7780"),
      ["10.86.140.52", "localhost", "127.0.0.1", "[::1]"],
      "a hub on the LAN alone, address copied from the browser with its port",
    );
    assert.deepEqual(allowedHostsFor("Hive.XDev.Asia", "0.0.0.0"), ["hive.xdev.asia", "localhost", "127.0.0.1", "[::1]"]);
    assert.equal(allowedHostsFor("", "0.0.0.0", ""), undefined, "neither one configured: no check (the server warns)");
  });
});
