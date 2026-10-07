#!/usr/bin/env node
// Entry for `hive-mcp`: every coding agent (Claude Code, Codex, Gemini…) spawns this over stdio.
// stdout is the MCP channel, so all logging goes to stderr.
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentActorName, agentSource, configIssueText, HubBackend, readConfig, readRun, resolveBackend, type Actor } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "./server.ts";
import { mcpHubBackend } from "#mcp/hub-backend.ts";

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
const agent = (process.env.HIVE_AGENT ?? "agent").replace(/[^\w.-]/g, "").slice(0, 40) || "agent";
const name = agentActorName(agent, config.mode, config.machine, os.userInfo().username);

const source = agentSource(config.machine, process.env);
// HIVE_RUN: set by the runner (installer.ts runMcpServers); on a hub it goes as x-hive-run, the audit log's run column.
const run = readRun(process.env.HIVE_RUN);
// On a hub, the hub decides the label and the account from the token; without one, this machine's user is the person.
const local: Partial<Actor> = config.mode === "local" ? { agent, onBehalf: os.userInfo().username } : {};
// HIVE_CHAT_REPLY: the app's leader chat in local mode (roadmap 48) writes that reply, so it gets the leader's
// proposals instead of the board. On a hub the reply's token says so, never a variable.
const chatReply = config.mode === "local" && /^[1-9]\d{0,15}$/.test(process.env.HIVE_CHAT_REPLY ?? "") ? Number(process.env.HIVE_CHAT_REPLY) : undefined;
// HIVE_READONLY=1: set by the runner for profiles marked read-only.
const readOnly = process.env.HIVE_READONLY === "1";
const actor: Actor = { name, role: "agent", source, ...local, ...(run ? { run } : {}), ...(chatReply ? { chatReply } : {}) };
const server = createHiveMcpServer(backend, actor, { defaultProject: process.env.HIVE_PROJECT, readOnly });
await server.connect(new StdioServerTransport());
console.error(`[xdev-hive] MCP ready (${config.mode} mode) as ${name}`);
