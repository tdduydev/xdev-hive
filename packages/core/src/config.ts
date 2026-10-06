import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentProfileSchema, DEFAULT_AGENT_PROFILES, runnerSettingsSchema } from "./agents.ts";
import { githubSettingsSchema } from "./github.ts";
import { gitlabSettingsSchema } from "./gitlab.ts";
import type { ConfigIssue } from "./bridge.ts";
import { HubBackend } from "./hub-client.ts";
import { MACHINE_ID, machineIdFrom, PROJECT_NAME } from "./keys.ts";
import type { HiveBackend } from "./methods.ts";
import { SqliteHive } from "./sqlite.ts";

export const projectSchema = z.object({
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
});

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
  projects: z.array(projectSchema).default([]),
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
  return readConfig(file).config;
}

/** "agents[claude-2].account: …": one line of main.log (or stderr) per part of config.json that was not used. */
export function configIssueText(issue: ConfigIssue): string {
  const where = `${issue.section}${issue.id === null ? "" : `[${issue.id}]`}${issue.field ? `.${issue.field}` : ""}`;
  return `${where}: ${issue.message} (${issue.action === "skipped" ? "skipped" : "default used"})`;
}

/**
 * Reads config.json part by part (BUG-config-silent, 6/10): six profiles with `"account": null` failed the whole file,
 * and the app on the runner Mac mini sat behind an error box with no heartbeat for four hours. A profile or project that
 * does not parse is left out, any other key that does not parse falls back to its default, and each is in `issues` for
 * the caller to log and show. Throws only when the file is not a JSON object at all.
 */
export function readConfig(file = configPath()): { config: HiveConfig; issues: ConfigIssue[] } {
  const { config, issues } = parseConfig(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
  return { config, issues };
}

const LISTS = [
  { section: "agents", key: "id", schema: agentProfileSchema },
  { section: "projects", key: "name", schema: projectSchema },
] as const;

function parseConfig(raw: unknown): { config: HiveConfig; issues: ConfigIssue[]; skipped: Record<string, unknown[]> } {
  if (!isRecord(raw)) throw new Error("config.json is not a JSON object");
  const input: Record<string, unknown> = { ...raw };
  const issues: ConfigIssue[] = [];
  const skipped: Record<string, unknown[]> = {};
  for (const { section, key, schema } of LISTS) {
    if (!Array.isArray(input[section])) continue;
    const seen = new Set<string>();
    const skip = (item: unknown, issue: ConfigIssue) => {
      issues.push(issue);
      (skipped[section] ??= []).push(item);
      return [];
    };
    input[section] = (input[section] as unknown[]).flatMap((item, i) => {
      const value = isRecord(item) ? dropNulls(item, schema.shape) : item;
      const named = isRecord(item) ? item[key] : undefined;
      const id = typeof named === "string" ? named : `#${i}`;
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        return skip(item, { section, id, field: first?.path.join(".") ?? "", message: first?.message ?? parsed.error.message, action: "skipped" });
      }
      // A second entry with the same id would fail the whole list (agent ids must be unique): the first one stays.
      if (seen.has(id)) return skip(item, { section, id, field: key, message: "duplicate", action: "skipped" });
      seen.add(id);
      return [value];
    });
  }
  // Each pass drops the top-level keys that failed; the schema has a dozen keys, so this ends.
  for (;;) {
    const parsed = configSchema.safeParse(input);
    if (parsed.success) return { config: parsed.data, issues, skipped };
    const failed = new Map<string, (typeof parsed.error.issues)[number]>();
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (!failed.has(key)) failed.set(key, issue);
    }
    // An issue with no key (the root itself) cannot be dropped; it was checked above.
    if (failed.has("") || [...failed.keys()].every((key) => !(key in input))) throw parsed.error;
    for (const [key, issue] of failed) {
      issues.push({ section: key, id: null, field: issue.path.slice(1).join("."), message: issue.message, action: "default" });
      delete input[key];
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Older apps (and hand edits) wrote `null` for fields that may only be left out, e.g. `"account": null`: read it as
 * left out instead of failing the profile.
 */
function dropNulls(item: Record<string, unknown>, shape: Record<string, z.ZodType>): Record<string, unknown> {
  const out = { ...item };
  for (const [key, value] of Object.entries(item)) {
    const field = shape[key];
    if (value === null && field && !field.safeParse(null).success && field.safeParse(undefined).success) delete out[key];
  }
  return out;
}

/** What config.json holds now, for saveConfig: null when there is none, "unreadable" when it is not a JSON object. */
function previousParts(file: string): ReturnType<typeof parseConfig> | "unreadable" | null {
  if (!existsSync(file)) return null;
  try {
    return parseConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return "unreadable";
  }
}

/**
 * Written with 0600 because it may hold a hub token. Profiles and projects readConfig left out are written back as they
 * were, so a settings change does not delete what the person still has to fix; a key that fell back to its default (or
 * a file that was not JSON) is overwritten, so the file as it was goes to config.json.bak first.
 */
export function saveConfig(config: HiveConfig, file = configPath()): HiveConfig {
  const valid = configSchema.parse(config);
  let out: Record<string, unknown> = valid;
  const before = previousParts(file);
  // Only when this write loses something: the skipped entries are written back below, a defaulted key is not.
  if (before === "unreadable" || before?.issues.some((issue) => issue.action === "default")) {
    copyFileSync(file, `${file}.bak`);
    chmodSync(`${file}.bak`, 0o600);
  }
  if (before && before !== "unreadable") {
    out = { ...valid };
    for (const { section, key } of LISTS) {
      // One the person has since made again in the app replaces the broken one, which would otherwise stay a warning.
      const ids = new Set((valid[section] as Array<Record<string, unknown>>).map((entry) => entry[key]));
      const kept = before.skipped[section]?.filter((item) => !(isRecord(item) && ids.has(item[key])));
      if (kept?.length) out[section] = [...valid[section], ...kept];
    }
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
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
