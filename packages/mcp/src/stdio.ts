#!/usr/bin/env node
// Entry for `hive-mcp`: every coding agent (Claude Code, Codex, Gemini…) spawns this over stdio.
// stdout is the MCP channel, so all logging goes to stderr.
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configIssueText, HubBackend, readConfig, resolveBackend } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "./server.ts";
import { mcpHubBackend } from "#mcp/hub-backend.ts";
import { stdioActor } from "#mcp/stdio-actor.ts";

const { config, issues } = readConfig();
for (const issue of issues) console.error(`[xdev-hive] config.json ${configIssueText(issue)}`);
if (config.mode === "hub" && process.env.HIVE_RUN && !process.env.HIVE_RUN_TOKEN)
  throw new Error("A hub run requires its own credential.");
// The runner's credential takes precedence over the machine credential in config.json.
const mcpHub = config.mode === "hub" && !process.env.HIVE_RUN_TOKEN
  // HIVE_SYSTEM: a CLI opened on a whole system (GROUP-cli); its tools take project on every call.
  ? mcpHubBackend(config.hub, process.env.HIVE_PROJECT, process.env.HIVE_READONLY === "1", process.env.HIVE_PROJECT ? undefined : process.env.HIVE_SYSTEM)
  : undefined;
const backend = config.mode === "hub"
  ? mcpHub ?? new HubBackend(config.hub.url, process.env.HIVE_RUN_TOKEN!)
  : resolveBackend(config);
// HIVE_READONLY=1: set by the runner for profiles marked read-only.
const readOnly = process.env.HIVE_READONLY === "1";
const actor = stdioActor(config.mode, config.machine, os.userInfo().username, process.env);
const server = createHiveMcpServer(backend, actor, { defaultProject: process.env.HIVE_PROJECT, readOnly, ...(process.env.HIVE_PROJECT || !process.env.HIVE_SYSTEM ? {} : { system: process.env.HIVE_SYSTEM }) });
await server.connect(new StdioServerTransport());
console.error(`[xdev-hive] MCP ready (${config.mode} mode) as ${actor.name}`);
// Not awaited: an unreachable hub must not hold up the agent's start. The tools explain the same thing on every call.
if (mcpHub && process.env.HIVE_PROJECT) {
  void mcpHub.check().then((closed) => {
    if (closed) console.error(`[xdev-hive] WARNING: ${closed.message}`);
  }, () => undefined);
}
