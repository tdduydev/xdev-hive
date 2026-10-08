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
const backend = config.mode === "hub"
  ? process.env.HIVE_RUN_TOKEN
    ? new HubBackend(config.hub.url, process.env.HIVE_RUN_TOKEN)
    : mcpHubBackend(config.hub, process.env.HIVE_PROJECT, process.env.HIVE_READONLY === "1")
  : resolveBackend(config);
// HIVE_READONLY=1: set by the runner for profiles marked read-only.
const readOnly = process.env.HIVE_READONLY === "1";
const actor = stdioActor(config.mode, config.machine, os.userInfo().username, process.env);
const server = createHiveMcpServer(backend, actor, { defaultProject: process.env.HIVE_PROJECT, readOnly });
await server.connect(new StdioServerTransport());
console.error(`[xdev-hive] MCP ready (${config.mode} mode) as ${actor.name}`);
