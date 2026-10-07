// The tool catalog (roadmap 28a): MCP servers, Claude Code plugins, hooks and CLIs that runs may use, with the pinned
// version machines set up. Browser-safe: the Tool page runs the same checks as the hub, to show an error under its field
// before anything is sent.
import { z } from "zod";
import { HiveError, type ErrorText } from "./errors.ts";
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
/**
 * A run's own folder, which the machine fills in: only in hook or MCP env values, so browser profiles, output
 * and hook history are per run. An install or check has no run.
 */
export const RUN_DIR_PLACEHOLDER = "{runDir}";

/** Frozen migration 65a seed: upgrades need a new migration or tools.save, so profiles stay isolated per run. */
export const BROWSER_TOOL: ToolEntry = {
  id: "browser",
  name: "Playwright MCP",
  description: "Duyệt và kiểm thử web bằng trình duyệt headless; profile và ảnh riêng cho từng run.",
  kind: "mcp",
  package: { registry: "npm", name: "@playwright/mcp", version: "0.0.83" },
  mcp: { command: "npx", args: ["-y", "{package}", "--headless"] },
  plugin: null,
  hooks: [],
  agents: ["claude", "codex"],
  check: null,
  install: null,
  prepare: null,
  env: {
    PLAYWRIGHT_MCP_CONFIG: "{runDir}/browser.json",
    PLAYWRIGHT_MCP_USER_DATA_DIR: "{runDir}/browser-profile",
    PLAYWRIGHT_MCP_OUTPUT_DIR: "{runDir}/.xdev-hive/artifacts/browser",
  },
  secretEnv: [],
  license: "Apache-2.0",
  homepage: "https://github.com/microsoft/playwright-mcp",
  handler: "browser",
  enabledByDefault: false,
};

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
export function toolCommands(e: ToolEntry): Array<[field: string, argv: readonly string[]]> {
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
  for (const [field, args] of toolCommands(e)) {
    if (args.some((a) => a.includes(RUN_DIR_PLACEHOLDER))) return at(field, "errors.toolRunDir", { placeholder: RUN_DIR_PLACEHOLDER });
    const loose = args.find(unpinned);
    if (loose !== undefined) return at(field, "errors.toolUnpinned", { arg: loose });
    const named = e.package ? args.slice(1).find((a) => namesPackage(a, e.package!.name)) : undefined;
    if (named !== undefined) return at(field, "errors.toolPackageName", { arg: named });
  }
  for (const name of [...Object.keys(e.env), ...e.secretEnv]) {
    if (!TOOL_ENV_NAME.test(name)) return at(name in e.env ? "env" : "secretEnv", "errors.toolEnvName", { name });
  }
  for (const [name, value] of Object.entries(e.env)) {
    if (value.includes(RUN_DIR_PLACEHOLDER) && e.kind !== "hook" && e.kind !== "mcp") return at("env", "errors.toolRunDir", { placeholder: RUN_DIR_PLACEHOLDER });
    const [hidden] = findHidden(value, 1);
    if (hidden) return at("env", "errors.toolHidden", { name, code: hidden.code });
    const secret = findSecret(value);
    if (secret) return at("env", "errors.toolSecret", { name, kind: secret });
  }
  // Machines run these commands and agents read the rest: nothing a reviewer cannot see, and no credential anywhere.
  for (const [field, text] of textFields(e)) {
    // Words a person reads may name it; anything the machine uses may not.
    if (field !== "name" && field !== "description" && text.includes(RUN_DIR_PLACEHOLDER)) return at(field, "errors.toolRunDir", { placeholder: RUN_DIR_PLACEHOLDER });
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
  for (const [field, args] of toolCommands(e)) out.push([field, args.join(" ")]);
  return out;
}

/** Whether a project gets the tool: its own choice, else the tool's default. */
export const toolEffective = (enabled: boolean | null, enabledByDefault: boolean): boolean => enabled ?? enabledByDefault;

/**
 * The setup items a machine reports for a tool in a project (roadmap 28e). A seed keeps the items the app checked
 * before the catalog; any other entry is the machine's own tool:<id> (28b-2).
 */
export function toolSetupItems(tool: Pick<ToolEntry, "id" | "handler">, project: string): string[] {
  switch (tool.handler) {
    case "codegraph":
      return [`${project}:codegraph-mcp`, `${project}:codegraph-index`];
    case "superpowers":
      return [`${project}:superpowers`];
    case "speckit":
      return ["cli:specify", `${project}:speckit`];
    default:
      return [`tool:${tool.id}`];
  }
}

// ── on the machine (roadmap 28b) ──────────────────────────────────────────────

/** Where a command runs: a run's worktree, the project's main checkout. Left out where there is none (an install). */
export interface ToolContext {
  worktree?: string;
  repo?: string;
  runDir?: string;
}

const PLACEHOLDERS = /\{(package|worktree|repo)\}/g;

/**
 * A catalog command as the machine runs it. One pass, so a path that happens to hold `{repo}` is never filled in
 * again. Here and not on the hub, so the Tool page and the machine's Setup card show the very command that runs.
 */
export function toolArgv(argv: readonly string[], entry: Pick<ToolEntry, "id" | "package">, ctx: ToolContext = {}): string[] {
  return argv.map((arg) =>
    arg.replace(PLACEHOLDERS, (whole, name: "package" | "worktree" | "repo") => {
      const value = name === "package" ? (entry.package ? packageSpec(entry.package) : undefined) : ctx[name];
      if (value === undefined) {
        throw new HiveError("bad_request", `Tool ${entry.id}: nothing to put for ${whole} here.`, { key: "errors.toolPlaceholder", vars: { id: entry.id, placeholder: whole } });
      }
      return value;
    }),
  );
}

/**
 * The variables an entry's commands get. `runDir`: the run's own folder for `{runDir}` (hooks and MCP servers); without
 * one (a check, an install) the variables that need it are left out rather than pointing at a folder named "{runDir}".
 */
export function toolEnv(e: Pick<ToolEntry, "env">, runDir: string | null = null): Record<string, string> {
  return Object.fromEntries(
    Object.entries(e.env).flatMap(([k, v]) =>
      !v.includes(RUN_DIR_PLACEHOLDER) ? [[k, v]] : runDir === null ? [] : [[k, v.split(RUN_DIR_PLACEHOLDER).join(runDir)]],
    ),
  );
}

/** The first release number a `check` printed (`rtk 0.50.0`, `v1.2.3-rc.1`), without its "v"; null when there is none. */
export function versionIn(output: string): string | null {
  return /(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?![\w.])/.exec(output)?.[1] ?? null;
}

/**
 * Whether a check's output is the pinned version (roadmap 28d). For a hook, which rewrites what the agent runs: brew
 * installs whatever homebrew has, so the version the hub approved is checked rather than trusted.
 */
export function versionMatches(output: string, pinned: string): boolean {
  const found = versionIn(output);
  return found !== null && found === pinned.replace(/^v/, "");
}

/** What decides what a machine runs for an entry: name, description, agents or projects changing do not ask again. */
export type ToolCommands = Pick<ToolEntry, "package" | "mcp" | "plugin" | "hooks" | "check" | "install" | "prepare" | "env" | "secretEnv">;

/**
 * The version of an entry's commands a machine's user allowed (toolTrust in config.json). Arrays rather than objects,
 * so the key order JSON happens to keep does not matter. Hooks count too: 28d runs them on the machine.
 */
export function toolHash(e: ToolCommands): string {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return sha256Hex(
    JSON.stringify([
      e.package && [e.package.registry, e.package.name, e.package.version],
      e.mcp && [e.mcp.command, e.mcp.args],
      e.plugin,
      e.hooks.map((h) => [h.event, h.matcher, h.command]),
      e.check,
      e.install,
      e.prepare && [e.prepare.init, e.prepare.sync, e.prepare.marker],
      Object.entries(e.env).sort(([a], [b]) => byName(a, b)),
      [...e.secretEnv].sort(byName),
    ]),
  );
}

// SHA-256 of a string (UTF-8) as hex, here because core also runs in the browser, where crypto.subtle is async only.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** UTF-8 bytes without TextEncoder, which core's TypeScript libs (es2023, no DOM) do not declare. */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function sha256Hex(text: string): string {
  const bytes = utf8(text);
  const total = Math.ceil((bytes.length + 9) / 64) * 64;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 0x100000000));
  view.setUint32(total - 4, bits >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      w[i] = w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
    }
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d = h[3]!;
    let e = h[4]!;
    let f = h[5]!;
    let g = h[6]!;
    let k = h[7]!;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + k;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
