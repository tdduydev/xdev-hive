// The tool catalog (roadmap 28a): MCP servers, Claude Code plugins, hooks and CLIs that runs may use, with the pinned
// version machines set up. Browser-safe: the Tool page runs the same checks as the hub, to show an error under its field
// before anything is sent.
import { z } from "zod";
import type { ErrorText } from "./errors.ts";
import { findHidden } from "./hidden.ts";
import { findSecret } from "./secrets.ts";
import { TOOL_AGENTS, TOOL_HANDLERS, TOOL_HOOK_EVENTS, TOOL_KINDS, TOOL_REGISTRIES, type ToolEntry } from "./types.ts";

/** Also an MCP server's name in a run's config and in the agent policy, so the same shape as agentPolicy's mcp names. */
export const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A release, never a range or a tag that moves: 1.6.0, v1.0.13, 2.0.0-rc.1. */
export const TOOL_VERSION = /^v?\d+\.\d+\.\d+([-+.][0-9A-Za-z.-]+)?$/;
export const TOOL_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** Stands for the pinned package in a command, so the version is written once (see packageSpec). */
export const PACKAGE_PLACEHOLDER = "{package}";

const argv = z.array(z.string().min(1).max(500)).max(40);

/** Shapes and sizes only; what the Tool page shows under a field comes from toolProblem. */
export const toolEntrySchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  kind: z.enum(TOOL_KINDS),
  package: z.object({ registry: z.enum(TOOL_REGISTRIES), name: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(60) }).nullable().default(null),
  mcp: z.object({ command: z.string().min(1).max(200), args: argv.default([]) }).nullable().default(null),
  plugin: z.string().trim().min(1).max(200).nullable().default(null),
  hooks: z.array(z.object({ event: z.enum(TOOL_HOOK_EVENTS), matcher: z.string().max(200).default(""), command: argv.min(1) })).max(10).default([]),
  agents: z
    .array(z.enum(TOOL_AGENTS))
    .min(1)
    .max(TOOL_AGENTS.length)
    .refine((list) => new Set(list).size === list.length, "agents must be unique"),
  check: argv.min(1).nullable().default(null),
  install: argv.min(1).nullable().default(null),
  prepare: z.object({ init: argv.min(1), sync: argv.min(1), marker: z.string().min(1).max(200) }).nullable().default(null),
  env: z
    .record(z.string().max(64), z.string().max(500))
    .default({})
    .refine((env) => Object.keys(env).length <= 20, "at most 20 variables"),
  secretEnv: z.array(z.string().max(64)).max(20).default([]),
  license: z.string().trim().max(60),
  homepage: z.string().trim().max(300).nullable().default(null),
  handler: z.enum(TOOL_HANDLERS).nullable().default(null),
  enabledByDefault: z.boolean().default(false),
});

/** What `{package}` becomes: brew and Claude plugins take no version on the command line, so their name alone. */
export function packageSpec(p: NonNullable<ToolEntry["package"]>): string {
  switch (p.registry) {
    case "npm":
      return `${p.name}@${p.version}`;
    case "pypi":
      return `${p.name}==${p.version}`;
    case "git":
      return `git+${p.name}@${p.version}`;
    default:
      return p.name;
  }
}

/** A command with `{package}` written out; `{worktree}` and `{repo}` are the machine's to fill in. */
export function expandPackage(args: readonly string[], p: ToolEntry["package"]): string[] {
  return p ? args.map((a) => a.split(PACKAGE_PLACEHOLDER).join(packageSpec(p))) : [...args];
}

/** Every command of an entry with the field it is in, the program first. */
function commands(e: ToolEntry): Array<[field: string, argv: readonly string[]]> {
  const out: Array<[string, readonly string[]]> = [];
  if (e.mcp) out.push(["mcp", [e.mcp.command, ...e.mcp.args]]);
  e.hooks.forEach((h, i) => out.push([`hooks.${i}`, h.command]));
  if (e.check) out.push(["check", e.check]);
  if (e.install) out.push(["install", e.install]);
  if (e.prepare) out.push(["prepare.init", e.prepare.init], ["prepare.sync", e.prepare.sync]);
  return out;
}

/** A version an argument asks for that is not one fixed release. */
const unpinned = (arg: string) => arg === "latest" || arg.includes("@latest") || arg.startsWith("^") || arg.startsWith("~");

/**
 * The package written out instead of `{package}`: it would not follow when the pinned version changes. The program
 * (argv[0]) may share the package's name, since many CLIs are called like their package (a binary, not a package spec).
 */
const namesPackage = (arg: string, name: string) => arg === name || arg.startsWith(`${name}@`) || arg.startsWith(`${name}==`) || arg.includes(`git+${name}`);

/**
 * The first thing wrong with an entry, as a message key with the field it is about (vars.field), or null. `builtin`:
 * whether it is (or replaces) a seed, which alone may have a handler.
 */
export function toolProblem(e: ToolEntry, builtin: boolean): ErrorText | null {
  const at = (field: string, key: string, vars: Record<string, string | number> = {}): ErrorText => ({ key, vars: { field, ...vars } });
  if (!TOOL_ID.test(e.id)) return at("id", "errors.toolId", { id: e.id });
  if (e.kind === "mcp" && !e.mcp) return at("mcp", "errors.toolKindField", { kind: e.kind });
  if (e.kind === "plugin" && !e.plugin) return at("plugin", "errors.toolKindField", { kind: e.kind });
  if (e.kind === "hook" && !e.hooks.length) return at("hooks", "errors.toolKindField", { kind: e.kind });
  if (e.kind === "cli" && !e.check) return at("check", "errors.toolKindField", { kind: e.kind });
  if (e.package && !TOOL_VERSION.test(e.package.version)) return at("package.version", "errors.toolVersionPin", { version: e.package.version });
  for (const [field, args] of commands(e)) {
    const loose = args.find(unpinned);
    if (loose !== undefined) return at(field, "errors.toolUnpinned", { arg: loose });
    const named = e.package ? args.slice(1).find((a) => namesPackage(a, e.package!.name)) : undefined;
    if (named !== undefined) return at(field, "errors.toolPackageName", { arg: named });
  }
  for (const name of [...Object.keys(e.env), ...e.secretEnv]) {
    if (!TOOL_ENV_NAME.test(name)) return at(name in e.env ? "env" : "secretEnv", "errors.toolEnvName", { name });
  }
  for (const [name, value] of Object.entries(e.env)) {
    const [hidden] = findHidden(value, 1);
    if (hidden) return at("env", "errors.toolHidden", { name, code: hidden.code });
    const secret = findSecret(value);
    if (secret) return at("env", "errors.toolSecret", { name, kind: secret });
  }
  // Machines run these commands and agents read the rest: nothing a reviewer cannot see, and no credential anywhere.
  for (const [field, text] of textFields(e)) {
    const [hidden] = findHidden(text, 1);
    if (hidden) return at(field, "errors.toolHidden", { name: field, code: hidden.code });
    const secret = findSecret(text);
    if (secret) return at(field, "errors.toolSecret", { name: field, kind: secret });
  }
  if (!e.license.trim()) return at("license", "errors.toolLicense");
  if (e.homepage !== null && !/^https:\/\/[^\s/]+\.[^\s]+$/.test(e.homepage)) return at("homepage", "errors.toolHomepage");
  if (e.handler !== null && !builtin) return at("handler", "errors.toolHandler");
  return null;
}

function textFields(e: ToolEntry): Array<[field: string, text: string]> {
  const out: Array<[string, string]> = [
    ["name", e.name],
    ["description", e.description],
    ["license", e.license],
  ];
  if (e.package) out.push(["package.name", e.package.name], ["package.version", e.package.version]);
  if (e.plugin) out.push(["plugin", e.plugin]);
  if (e.homepage) out.push(["homepage", e.homepage]);
  if (e.prepare) out.push(["prepare.marker", e.prepare.marker]);
  e.hooks.forEach((h, i) => out.push([`hooks.${i}`, h.matcher]));
  for (const [field, args] of commands(e)) out.push([field, args.join(" ")]);
  return out;
}

/** Whether a project gets the tool: its own choice, else the tool's default. */
export const toolEffective = (enabled: boolean | null, enabledByDefault: boolean): boolean => enabled ?? enabledByDefault;
