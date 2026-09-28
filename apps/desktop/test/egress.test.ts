import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcp, type AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { AGENT_TEMPLATES, type AgentProfile } from "@xdev-hive/core";
import { deniedHosts, egressAllow, egressPlan } from "../src/main/runner/egress.ts";

const profile = (allow: string[] = []): AgentProfile => ({ ...AGENT_TEMPLATES.codex, container: { image: "xdev-hive-agent", network: "restricted", allow } });

describe("allowed hosts and the run's network", () => {
  it("allows the defaults, the hub, the team's GitLab and what the profile adds", () => {
    const allow = egressAllow(profile(["Registry.Corp.Example", "git.corp.example:8443"]), { hub: "https://hive.xdev.asia", gitlab: "https://gitlab.fis.vn:8443/" });
    for (const h of [".anthropic.com", ".openai.com", ".googleapis.com", "registry.npmjs.org", "pypi.org", "github.com", "hive.xdev.asia", "gitlab.fis.vn:8443", "registry.corp.example", "git.corp.example:8443"]) {
      assert.ok(allow.includes(h), h);
    }
    assert.deepEqual(egressAllow(profile(), { hub: "not a url", gitlab: null }).includes("not a url"), false);
  });

  it("plans the network, the proxy and its teardown for one run", () => {
    const plan = egressPlan("R-ab12", "xdev-hive-agent", ["x"]);
    assert.deepEqual(plan.setup, [
      ["network", "create", "--internal", "hive-R-ab12-net"],
      ["run", "-d", "--rm", "--init", "--name", "hive-R-ab12-egress", "--user", "node", "-e", "HIVE_EGRESS_ALLOW", "xdev-hive-agent", "node", "/opt/xdev-hive/egress.mjs"],
      ["network", "connect", "--alias", "egress", "hive-R-ab12-net", "hive-R-ab12-egress"],
    ]);
    assert.deepEqual(plan.teardown, [["rm", "-f", "hive-R-ab12-egress"], ["network", "rm", "hive-R-ab12-net"]]);
    assert.deepEqual(plan.runArgs, ["--network", "hive-R-ab12-net"]);
    assert.equal(plan.env.HTTPS_PROXY, "http://egress:3128");
    assert.equal(plan.env.no_proxy, "localhost,127.0.0.1");
  });

  it("reads what the proxy refused", () => {
    assert.deepEqual(deniedHosts("egress proxy on 3128, 5 allowed\ndenied evil.example:443\ndenied a.b:80\ndenied evil.example:443\n"), [
      { host: "evil.example:443", count: 2 },
      { host: "a.b:80", count: 1 },
    ]);
  });
});

// ── the proxy itself (docker/agent/egress.mjs), against servers on this machine ──
describe("egress proxy", () => {
  let web: Server;
  let tls: ReturnType<typeof createTcp>;
  let proxy: Server;
  let webPort = 0;
  let tlsPort = 0;
  let proxyPort = 0;
  let allowed: (host: string, port: number) => boolean;

  before(async () => {
    web = createServer((_req, res) => res.end("hello from web"));
    web.listen(0, "127.0.0.1");
    // Stands in for a TLS server: whatever goes through the tunnel comes back.
    tls = createTcp((s) => s.pipe(s));
    tls.listen(0, "127.0.0.1");
    await Promise.all([new Promise((r) => web.once("listening", r)), new Promise((r) => tls.once("listening", r))]);
    webPort = (web.address() as AddressInfo).port;
    tlsPort = (tls.address() as AddressInfo).port;
    process.env.HIVE_EGRESS_ALLOW = `127.0.0.1:${webPort},127.0.0.1:${tlsPort},.example.com,exact.org`;
    process.env.HIVE_EGRESS_NO_LISTEN = "1";
    const mod = await import(path.join(import.meta.dirname, "../../../docker/agent/egress.mjs"));
    allowed = mod.allowed;
    proxy = mod.server;
    proxy.listen(0, "127.0.0.1");
    await new Promise((r) => proxy.once("listening", r));
    proxyPort = (proxy.address() as AddressInfo).port;
  });
  after(() => {
    web.close();
    tls.close();
    proxy.close();
  });

  it("matches names and ports", () => {
    assert.equal(allowed("api.example.com", 443), true);
    assert.equal(allowed("example.com", 80), true);
    assert.equal(allowed("evilexample.com", 443), false, "a suffix match needs the dot");
    assert.equal(allowed("exact.org", 443), true);
    assert.equal(allowed("sub.exact.org", 443), false);
    assert.equal(allowed("exact.org", 22), false, "80 and 443 unless the entry names a port");
    assert.equal(allowed(`127.0.0.1`, webPort), true);
    assert.equal(allowed(`127.0.0.1`, webPort + 1 === tlsPort ? webPort + 2 : webPort + 1), false);
  });

  const tunnel = (target: string) =>
    new Promise<string>((resolve) => {
      const s = connect(proxyPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let got = "";
      s.on("data", (b) => {
        got += b.toString();
        if (got.startsWith("HTTP/1.1 200") && got.includes("\r\n\r\n") && !got.includes("ping")) s.write("ping");
        if (got.includes("ping") || got.startsWith("HTTP/1.1 403")) {
          s.destroy();
          resolve(got);
        }
      });
      s.on("error", () => resolve(got));
    });

  it("tunnels to an allowed host and refuses others", async () => {
    const ok = await tunnel(`127.0.0.1:${tlsPort}`);
    assert.match(ok, /^HTTP\/1\.1 200 Connection Established\r\n\r\nping$/);
    const no = await tunnel("evil.test:443");
    assert.match(no, /^HTTP\/1\.1 403 Forbidden/);
  });

  it("forwards plain HTTP to an allowed host only", async () => {
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        const req = request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.end();
      });
    assert.deepEqual(await get(`http://127.0.0.1:${webPort}/x`), { status: 200, body: "hello from web" });
    assert.equal((await get("http://evil.test/")).status, 403);
  });
});
