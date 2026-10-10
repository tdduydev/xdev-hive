import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { applyHubTls, caFingerprint } from "@xdev-hive/core/node";
import { trustHub, upgradeHubToHttps } from "#desktop/main/hub-trust.ts";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

describe("trustHub / upgradeHubToHttps", { skip: !hasOpenssl() }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-trust-"));
  const run = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Test CA", "-days", "2");
  run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "l.key", "-out", "l.csr", "-subj", "/CN=hub");
  execFileSync("sh", ["-c", `echo subjectAltName=IP:127.0.0.1 > ext && openssl x509 -req -in l.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out l.crt -days 2 -extfile ext`], { cwd: dir, stdio: "pipe" });
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const ca = read("ca.crt");
  let server: https.Server;
  let url: string;
  before(async () => {
    server = https.createServer({ key: read("l.key"), cert: read("l.crt") }, (req, res) => {
      if (req.url === "/ca.crt") return void res.end(ca);
      res.setHeader("x-hive-lan-https-port", "7743").statusCode = req.headers.authorization === "Bearer tok" ? 200 : 401;
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("asks the user for a CA the system does not trust, and saves it with its fingerprint", async () => {
    applyHubTls({ url: "http://x" });
    const asked: string[] = [];
    const hub = await trustHub({ url, token: "tok", ca: "", caSha256: "" }, async (_u, sha) => (asked.push(sha), true));
    assert.deepEqual(asked, [caFingerprint(ca)]);
    assert.equal(hub.caSha256, caFingerprint(ca));
    assert.equal(hub.token, "tok");
  });
  it("does not ask again once saved, and refusing trusts nothing", async () => {
    let asks = 0;
    const saved = { url, token: "tok", ca, caSha256: caFingerprint(ca) };
    await trustHub(saved, async () => (asks++, true));
    assert.equal(asks, 0);
    applyHubTls({ url: "http://x" });
    await assert.rejects(trustHub({ url, token: "tok", ca: "", caSha256: "" }, async () => false), /not confirmed/);
  });
  it("a plain http address stays unchanged by upgrade when the hub names no port", async () => {
    const http = (await import("node:http")).createServer((_q, r) => r.end("{}"));
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const u = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    assert.equal(await upgradeHubToHttps({ url: u, token: "tok", ca: "", caSha256: "" }, async () => true), null);
    http.close();
  });
});
