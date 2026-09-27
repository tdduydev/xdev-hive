#!/usr/bin/env node
// Entry for `hive-mcp`: every coding agent (Claude Code, Codex, Gemini…) spawns this over stdio.
// stdout is the MCP channel, so all logging goes to stderr.
import os from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentActorName, loadConfig, resolveBackend } from "@xdev-hive/core/node";
import { createHiveMcpServer } from "./server.ts";

const config = loadConfig();
const backend = resolveBackend(config);
const agent = (process.env.HIVE_AGENT ?? "agent").replace(/[^\w.-]/g, "").slice(0, 40) || "agent";
const name = agentActorName(agent, config.mode, config.machine, os.userInfo().username);

const server = createHiveMcpServer(backend, { name, role: "agent" }, { defaultProject: process.env.HIVE_PROJECT });
await server.connect(new StdioServerTransport());
console.error(`[xdev-hive] MCP ready (${config.mode} mode) as ${name}`);
