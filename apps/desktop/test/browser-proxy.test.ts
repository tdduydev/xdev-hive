import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolArgv, toolEnv } from "@xdev-hive/core";
import { egressPlan } from "#desktop/main/runner/egress.ts";
import { APP_TOOLS, claudeToolServer, codexToolArgs, readyBrowserSecrets } from "#desktop/main/runner/tools.ts";

// Opt in because this starts real Chrome and npx; the ordinary suite verifies runner wiring with fake Docker.
it("Playwright MCP navigates through Hive's restricted proxy and cannot reach a denied page", {
  skip: process.env.HIVE_BROWSER_PROXY_SMOKE !== "1",
  timeout: 90_000,
}, async () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "hive-browser-proxy-"));
  let allowedHits = 0;
  let deniedHits = 0;
  const allowedPage = createServer((_req, res) => {
    allowedHits++;
    res.setHeader("content-type", "text/html");
    res.end("<h1>Allowed browser proxy page</h1>");
  });
  const deniedPage = createServer((_req, res) => {
    deniedHits++;
    res.setHeader("content-type", "text/html");
    res.end("<h1>Denied origin was reached directly</h1>");
  });
  let proxy: Server | undefined;
  let client: Client | undefined;
  const previous = { allow: process.env.HIVE_EGRESS_ALLOW, listen: process.env.HIVE_EGRESS_NO_LISTEN };
  const listen = async (server: Server) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return (server.address() as AddressInfo).port;
  };
  const close = async (server: Server | undefined) => {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const allowedPort = await listen(allowedPage);
    const deniedPort = await listen(deniedPage);
    process.env.HIVE_EGRESS_ALLOW = `127.0.0.1:${allowedPort},registry.npmjs.org`;
    process.env.HIVE_EGRESS_NO_LISTEN = "1";
    // Exercise the same allowlist/forwarding server shipped in the agent image, with no external website.
    const mod = await import(path.join(import.meta.dirname, "../../../docker/agent/egress.mjs"));
    proxy = mod.server;
    const proxyUrl = `http://127.0.0.1:${await listen(proxy!)}`;
    const network = egressPlan("R-proxy-smoke", "unused", []);
    const [command, ...args] = toolArgv([APP_TOOLS.browser.mcp!.command, ...APP_TOOLS.browser.mcp!.args], APP_TOOLS.browser);
    assert.ok(command);
    readyBrowserSecrets(APP_TOOLS.browser, runDir, {});
    const env = {
      ...process.env,
      ...toolEnv(APP_TOOLS.browser, runDir),
      // Use an isolated profile and keep all downloads and files inside the test's temporary directory.
      HOME: runDir,
      XDG_CONFIG_HOME: runDir,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      PLAYWRIGHT_MCP_PROXY_SERVER: "",
      ...(process.env.HIVE_BROWSER_SMOKE_NO_SANDBOX === "1" ? { PLAYWRIGHT_MCP_SANDBOX: "false" } : {}),
    } as Record<string, string>;
    client = new Client({ name: "hive-browser-proxy", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command, args, env, stderr: "inherit" }));
    const direct = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${deniedPort}` } });
    assert.ok(!direct.isError, JSON.stringify(direct));
    assert.ok(deniedHits > 0, "HTTP_PROXY alone leaves Chrome able to bypass the restricted proxy");
    await client.close();
    client = undefined;
    const beforeDenied = deniedHits;

    // The runner puts this variable explicitly in Claude's env and Codex's MCP env overrides.
    const browser = { ...APP_TOOLS.browser, env: { ...APP_TOOLS.browser.env, PLAYWRIGHT_MCP_PROXY_SERVER: network.env.PLAYWRIGHT_MCP_PROXY_SERVER! } };
    const server = claudeToolServer(browser, { runDir }) as { env: Record<string, string> };
    assert.equal(server.env.PLAYWRIGHT_MCP_PROXY_SERVER, network.env.HTTPS_PROXY);
    assert.ok(codexToolArgs([browser], { runDir }).some((a) => a.startsWith("mcp_servers.browser.env=") && a.includes('PLAYWRIGHT_MCP_PROXY_SERVER="http://egress:3128"')));
    client = new Client({ name: "hive-browser-proxy", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command, args, env: {
      ...env, ...server.env, PLAYWRIGHT_MCP_PROXY_SERVER: proxyUrl,
      PLAYWRIGHT_MCP_PROXY_BYPASS: "<-loopback>",
    }, stderr: "inherit" }));
    const allowed = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${allowedPort}` } });
    assert.ok(!allowed.isError, JSON.stringify(allowed));
    // With an output dir MCP can return a snapshot link, so query the visible heading to verify the loaded page.
    const heading = await client.callTool({ name: "browser_evaluate", arguments: { function: "() => document.querySelector('h1').textContent" } });
    assert.match(JSON.stringify(heading), /Allowed browser proxy page/);
    assert.ok(allowedHits > 0);
    const denied = await client.callTool({ name: "browser_navigate", arguments: { url: `http://127.0.0.1:${deniedPort}` } });
    const body = await client.callTool({ name: "browser_evaluate", arguments: { function: "() => document.body.textContent" } });
    assert.ok(denied.isError || /not allowed from this run/.test(JSON.stringify(body)), JSON.stringify(denied));
    assert.equal(deniedHits, beforeDenied, "the browser cannot bypass the proxy to the denied origin");
  } finally {
    await client?.close();
    await Promise.all([close(proxy), close(allowedPage), close(deniedPage)]);
    if (previous.allow === undefined) delete process.env.HIVE_EGRESS_ALLOW;
    else process.env.HIVE_EGRESS_ALLOW = previous.allow;
    if (previous.listen === undefined) delete process.env.HIVE_EGRESS_NO_LISTEN;
    else process.env.HIVE_EGRESS_NO_LISTEN = previous.listen;
    rmSync(runDir, { recursive: true, force: true });
  }
});
