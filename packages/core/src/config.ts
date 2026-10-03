import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentProfileSchema, DEFAULT_AGENT_PROFILES, runnerSettingsSchema } from "./agents.ts";
import { githubSettingsSchema } from "./github.ts";
import { gitlabSettingsSchema } from "./gitlab.ts";
import { HubBackend } from "./hub-client.ts";
import { MACHINE_ID, machineIdFrom, PROJECT_NAME } from "./keys.ts";
import type { HiveBackend } from "./methods.ts";
import { SqliteHive } from "./sqlite.ts";

export const configSchema = z.object({
  mode: z.enum(["local", "hub"]).default("local"),
  /** Part of every hub lease this machine takes (see agentActorName). Defaults to the hostname, then pinned by the desktop app. */
  machine: z
    .string()
    .regex(MACHINE_ID, "machine: chữ thường, số, dấu - (tối đa 24)")
    .default(() => machineIdFrom(os.hostname())),
  /** Local SQLite file. Defaults to `local.db` next to config.json. */
  dbPath: z.string().nullable().default(null),
  hub: z.object({ url: z.string().default(""), token: z.string().default("") }).default({ url: "", token: "" }),
  projects: z
    .array(
      z.object({
        name: z.string().regex(PROJECT_NAME),
        repo: z.string().min(1),
        /** GitLab project path (group/sub/project) when it cannot be read from the git remote. */
        gitlabProject: z.string().max(300).optional(),
        /** GitHub repository (owner/repo): the project's MRs are GitHub pull requests. Read from the remote when it is on GitHub. */
        githubRepo: z.string().max(200).optional(),
        /** MR target branch; default is the GitLab project's default branch. */
        targetBranch: z.string().max(200).optional(),
        /**
         * Other projects of this machine a run of this one may read (roadmap 38h): old code a task needs for
         * context. Names, not paths, so a repo that moves follows its project. Read-only: never written to.
         */
        references: z.array(z.string().regex(PROJECT_NAME)).max(10).optional(),
      }),
    )
    .default([]),
  /** Interface language the desktop app last used (tray, notifications); the renderer sets it. */
  locale: z.string().max(16).default("vi"),
  memoryRequiresApproval: z.boolean().default(false),
  sync: z.object({ autoCommit: z.boolean().default(true) }).default({ autoCommit: true }),
  agents: z
    .array(agentProfileSchema)
    .default(DEFAULT_AGENT_PROFILES)
    .refine((list) => new Set(list.map((a) => a.id)).size === list.length, "agent ids must be unique"),
  runner: runnerSettingsSchema.default(runnerSettingsSchema.parse({})),
  /**
   * Claude Code long-lived tokens (claude setup-token) for profiles that run in a container, by profile id.
   * A container cannot read the macOS Keychain. Never sent to the interface; runs get it as CLAUDE_CODE_OAUTH_TOKEN.
   */
  agentTokens: z.record(z.string(), z.string().max(4000)).default({}),
  /**
   * Tools of the hub's catalog this machine's user allowed (roadmap 28b), by id: the toolHash of the commands they saw.
   * A changed command (a new version) runs only once allowed again.
   */
  toolTrust: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).default({}),
  gitlab: gitlabSettingsSchema.default(gitlabSettingsSchema.parse({})),
  github: githubSettingsSchema.default(githubSettingsSchema.parse({})),
});

export type HiveConfig = z.output<typeof configSchema>;
export type HiveProject = HiveConfig["projects"][number];

export function configPath(): string {
  return process.env.HIVE_CONFIG ?? path.join(os.homedir(), ".xdev-hive", "config.json");
}

export function loadConfig(file = configPath()): HiveConfig {
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return configSchema.parse(raw);
}

/** Written with 0600 because it may hold a hub token. */
export function saveConfig(config: HiveConfig, file = configPath()): HiveConfig {
  const valid = configSchema.parse(config);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return valid;
}

/**
 * Writes the machine name into an existing config.json that only has the hostname default,
 * so leases survive the hostname changing (macOS may take it from DHCP).
 */
export function pinMachine(config: HiveConfig, file = configPath()): void {
  if (!existsSync(file)) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as { machine?: unknown };
  if (raw.machine === undefined) saveConfig(config, file);
}

export function localDbPath(config: HiveConfig, file = configPath()): string {
  return config.dbPath ?? path.join(path.dirname(file), "local.db");
}

export function resolveBackend(config: HiveConfig, file = configPath()): HiveBackend {
  if (config.mode === "hub") {
    if (!config.hub.url || !config.hub.token) throw new Error("Hub mode needs hub.url and hub.token in config.json");
    return new HubBackend(config.hub.url, config.hub.token);
  }
  const hive = new SqliteHive(localDbPath(config, file), { memoryRequiresApproval: config.memoryRequiresApproval, local: true });
  hive.seed();
  return hive;
}
