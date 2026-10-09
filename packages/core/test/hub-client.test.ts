import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { HiveError, HubBackend, requestDeviceToken } from "#core/index.ts";

/** A port nothing listens on: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** A fake hub: each test sets what the next answer is, and reads back the request it got. */
let hubUrl = "";
let stop: () => void;
let answer: { status: number; body: string } = { status: 200, body: "{}" };
let seen: { url: string; headers: IncomingMessage["headers"]; body: string } | null = null;
const reply = (status: number, body: unknown) => {
  answer = { status, body: typeof body === "string" ? body : JSON.stringify(body) };
};

before(async () => {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen = { url: req.url ?? "", headers: req.headers, body };
      res.writeHead(answer.status, { "content-type": "application/json" }).end(answer.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  stop = () => server.close();
});
after(() => stop());

const user = { id: 1, username: "duy", name: "Duy", role: "admin" };

describe("hub client", () => {
  it("treats a stalled response body as an unavailable hub", async (t) => {
    t.mock.method(globalThis, "fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new DOMException("body stalled", "AbortError"); },
    }) as unknown as Response);
    const hub = new HubBackend(hubUrl, "token");
    await assert.rejects(hub.me("desktop"), (err: unknown) => err instanceof HiveError && err.code === "unavailable" && err.key === "errors.hubUnreachable");
  });

  it("reports a hub it cannot reach as unavailable, with the catalogue key", async () => {
    const hub = new HubBackend(`http://127.0.0.1:${await closedPort()}`, "t".repeat(40));
    await assert.rejects(
      () => hub.call("docs.list", {}, { name: "duy", role: "admin" }),
      (err: unknown) => err instanceof HiveError && err.code === "unavailable" && err.key === "errors.hubUnreachable" && typeof err.vars?.reason === "string",
    );
    await assert.rejects(() => hub.me("desktop"), (err: unknown) => err instanceof HiveError && err.code === "unavailable");
  });

  it("calls a method with the token, the agent label and the source", async () => {
    const hub = new HubBackend(`${hubUrl}//`, "secret-token");
    assert.equal(hub.url, hubUrl, "trailing slashes dropped");
    reply(200, { result: [] });
    assert.deepEqual(await hub.call("docs.list", {}, { name: "claude-1", role: "agent" }), []);
    assert.equal(seen?.url, "/api/rpc");
    assert.equal(seen?.headers.authorization, "Bearer secret-token");
    assert.equal(seen?.headers["x-hive-agent"], "claude-1");
    assert.equal(seen?.headers["x-hive-source"], undefined, "no source, no header");
    assert.equal(seen?.headers["x-hive-run"], undefined);
    assert.deepEqual(JSON.parse(seen?.body ?? ""), { method: "docs.list", input: {} });
    reply(200, { result: [] });
    await hub.call("docs.list", {}, { name: "claude-1", role: "agent", run: "R-abc123" });
    assert.equal(seen?.headers["x-hive-run"], "R-abc123", "the run of the shim's HIVE_RUN, for the audit log");
  });

  it("keeps the key and vars of a hub error, so the interface shows it in the person's language", async () => {
    const hub = new HubBackend(hubUrl, "t".repeat(40));
    reply(409, { error: { code: "conflict", message: "Version 3 is not the latest (4).", key: "errors.docStale", vars: { base: 3, latest: 4 } } });
    await assert.rejects(
      () => hub.call("docs.list", {}, { name: "duy", role: "admin" }),
      (err: unknown) =>
        err instanceof HiveError && err.code === "conflict" && err.message === "Version 3 is not the latest (4)." && err.key === "errors.docStale" && err.vars?.latest === 4,
    );
    // An error with no key (an older hub) stays without one, its code taken from the HTTP status.
    reply(403, { error: { message: "Not allowed." } });
    await assert.rejects(
      () => hub.call("docs.list", {}, { name: "duy", role: "admin" }),
      (err: unknown) => err instanceof HiveError && err.code === "forbidden" && err.key === undefined,
    );
  });

  it("turns an answer that is not JSON into an error named by the HTTP status", async () => {
    const hub = new HubBackend(hubUrl, "t".repeat(40));
    reply(502, "<html>Bad gateway</html>");
    await assert.rejects(
      () => hub.call("docs.list", {}, { name: "duy", role: "admin" }),
      (err: unknown) => err instanceof HiveError && err.code === "bad_request" && err.message === "Hub responded 502",
    );
    reply(404, "not json");
    await assert.rejects(() => hub.me("desktop"), (err: unknown) => err instanceof HiveError && err.code === "not_found" && err.message === "Hub responded 404");
    // A 200 that is not JSON is no answer either.
    reply(200, "ok");
    await assert.rejects(() => hub.call("docs.list", {}, { name: "duy", role: "admin" }), (err: unknown) => err instanceof HiveError && err.message === "Hub responded 200");
  });

  it("asks the hub who the token belongs to", async () => {
    const hub = new HubBackend(hubUrl, "t".repeat(40));
    reply(200, { result: { user } });
    assert.deepEqual(await hub.me("desktop"), { user });
    assert.equal(seen?.url, "/api/me");
    assert.equal(seen?.headers["x-hive-agent"], "desktop");
    reply(401, { error: { code: "unauthorized", message: "Token revoked.", key: "errors.tokenRevoked" } });
    await assert.rejects(() => hub.me("desktop"), (err: unknown) => err instanceof HiveError && err.code === "unauthorized" && err.key === "errors.tokenRevoked");
  });

  it("signs in once for a machine token, naming the machine safely", async () => {
    reply(200, { result: { token: "new-token", user } });
    assert.deepEqual(await requestDeviceToken(`${hubUrl}/`, { username: "duy", password: "pw", machine: "Duy's Mac mini" }), { token: "new-token", user });
    assert.equal(seen?.url, "/api/device-token");
    assert.deepEqual(JSON.parse(seen?.body ?? ""), { username: "duy", password: "pw", name: "Duy-s-Mac-mini" });
    reply(200, { result: { token: "t2", user } });
    await requestDeviceToken(hubUrl, { username: "duy", password: "pw", machine: "" });
    assert.equal(JSON.parse(seen?.body ?? "").name, "desktop", "an empty machine name gets one");
  });

  it("keeps the key of a refused sign-in, and names a non-JSON refusal by its status", async () => {
    reply(401, { error: { code: "unauthorized", message: "Wrong username or password.", key: "errors.badLogin", vars: { user: "duy" } } });
    await assert.rejects(
      () => requestDeviceToken(hubUrl, { username: "duy", password: "bad", machine: "m" }),
      (err: unknown) => err instanceof HiveError && err.code === "unauthorized" && err.key === "errors.badLogin" && err.vars?.user === "duy",
    );
    reply(403, "<html>Forbidden</html>");
    await assert.rejects(
      () => requestDeviceToken(hubUrl, { username: "duy", password: "pw", machine: "m" }),
      (err: unknown) => err instanceof HiveError && err.code === "forbidden" && err.message === "Hub responded 403" && err.key === undefined,
    );
    reply(500, "boom");
    await assert.rejects(
      () => requestDeviceToken(hubUrl, { username: "duy", password: "pw", machine: "m" }),
      (err: unknown) => err instanceof HiveError && err.code === "bad_request",
    );
  });

  it("reports a sign-in to a hub it cannot reach as unavailable", async () => {
    const port = await closedPort();
    await assert.rejects(
      () => requestDeviceToken(`http://127.0.0.1:${port}`, { username: "duy", password: "pw", machine: "m" }),
      (err: unknown) => err instanceof HiveError && err.code === "unavailable" && err.key === "errors.hubUnreachable",
    );
  });
});
