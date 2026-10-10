import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  applyHubTls, caFingerprint, fetchHubCa, httpsUpgradeUrl, hubFetch, normalizeFingerprint, pinHubCa, pinnedHubCa, requestDeviceToken,
} from "../src/node.ts";

/** A CA and a certificate it signed for 127.0.0.1 (as Caddy's `tls internal` does for the LAN address), made with openssl. */
function makePki() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hive-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  const ext = path.join(dir, "ext.cnf");
  writeFileSync(ext, "subjectAltName=IP:127.0.0.1\n");
  run("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-subj", "/CN=Test LAN CA", "-days", "2");
  run("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=hub");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "2", "-extfile", ext);
  const read = (f: string) => readFileSync(path.join(dir, f), "utf8");
  const other = makeOtherCa(dir);
  return { ca: read("ca.crt"), key: read("leaf.key"), cert: read("leaf.crt"), otherCa: other };
}

function makeOtherCa(dir: string): string {
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "o.key", "-out", "o.crt", "-subj", "/CN=Other CA", "-days", "2"], { cwd: dir, stdio: "pipe" });
  return readFileSync(path.join(dir, "o.crt"), "utf8");
}

describe("httpsUpgradeUrl", () => {
  it("moves an http address to the HTTPS port the hub told, same host", () => {
    assert.equal(httpsUpgradeUrl("http://192.0.2.52:7780", "7743"), "https://192.0.2.52:7743");
    assert.equal(httpsUpgradeUrl("http://my-server:7780/", "8443"), "https://my-server:8443");
  });
  it("does nothing without a port, for an https address or a bad value", () => {
    assert.equal(httpsUpgradeUrl("http://192.0.2.52:7780", null), null);
    assert.equal(httpsUpgradeUrl("https://hub.example.com", "7743"), null);
    assert.equal(httpsUpgradeUrl("http://192.0.2.52:7780", "7743/x"), null);
    assert.equal(httpsUpgradeUrl("not a url", "7743"), null);
  });
});

describe("fingerprints", () => {
  it("reads the forms people paste", () => {
    const hex = "ab".repeat(32);
    assert.equal(normalizeFingerprint(hex.toUpperCase().replace(/(..)(?!$)/g, "$1:")), hex);
    assert.equal(normalizeFingerprint(`SHA256 ${hex}`), hex);
    assert.equal(normalizeFingerprint("abcd"), null);
  });
});

describe("pinned hub CA", { skip: !opensslThere() }, () => {
  const pki = makePki();
  let server: https.Server;
  let url: string;
  before(async () => {
    server = https.createServer({ key: pki.key, cert: pki.cert }, (req, res) => {
      if (req.url === "/ca.crt") return void res.end(pki.ca);
      if (req.url === "/api/device-token") {
        let body = "";
        req.on("data", (c) => (body += c));
        return void req.on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ result: { token: "t", user: { name: JSON.parse(body).username } } })));
      }
      res.setHeader("x-hive-lan-https-port", "7743").end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("is refused without the pin", async () => {
    applyHubTls({ url: "http://x" });
    await assert.rejects(hubFetch(`${url}/`));
  });
  it("is served with the pin, and only to that hub", async () => {
    pinHubCa(url, pki.ca, caFingerprint(pki.ca));
    assert.equal(await (await hubFetch(`${url}/`)).text(), "ok");
    assert.equal((await hubFetch(`${url}/`)).headers.get("x-hive-lan-https-port"), "7743");
    await assert.rejects(hubFetch(`https://localhost:${new URL(url).port}/`), "another origin is not pinned");
  });
  it("a different CA does not verify the hub", async () => {
    pinHubCa(url, pki.otherCa);
    await assert.rejects(hubFetch(`${url}/`));
  });
  it("a pem that does not hash to the fingerprint is not pinned", () => {
    applyHubTls({ url, ca: pki.ca, caSha256: "0".repeat(64) });
    assert.equal(pinnedHubCa(url), undefined);
    applyHubTls({ url, ca: pki.ca, caSha256: caFingerprint(pki.ca) });
    assert.equal(pinnedHubCa(url), pki.ca);
  });
  it("fetchHubCa reads /ca.crt without trust and reports its SHA-256", async () => {
    applyHubTls({ url: "http://x" });
    const got = await fetchHubCa(url);
    assert.equal(got.sha256, caFingerprint(pki.ca));
  });
  it("hub client calls go through the pin", async () => {
    applyHubTls({ url, ca: pki.ca, caSha256: caFingerprint(pki.ca) });
    const r = await requestDeviceToken(url, { username: "u", password: "p", machine: "m" });
    assert.equal(r.token, "t");
  });
});

function opensslThere(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
