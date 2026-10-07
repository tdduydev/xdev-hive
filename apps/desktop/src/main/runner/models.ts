import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "@xdev-hive/core";
import { expandEnv, expandHome, resolveBin } from "#desktop/main/runner/command.ts";

const valid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._:[\]-]{1,100}$/.test(v);
const unique = (values: unknown[]) => [...new Set(values.filter(valid))].slice(0, 200);
export const CLAUDE_MODELS = ["default", "best", "fable", "opus", "sonnet", "haiku", "opusplan", "opus[1m]", "sonnet[1m]"];

export function codexModels(text: string): string[] | null {
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data.models)) return null;
    return unique(data.models.filter((m: any) => m && m.visibility === "list").map((m: any) => m.slug));
  } catch { return null; }
}

export function agyModels(text: string): string[] | null {
  try {
    const data = JSON.parse(text);
    const rows = Array.isArray(data) ? data : data.models;
    if (!Array.isArray(rows)) return null;
    return unique(rows.filter((m: any) => typeof m === "string" || (m && m.supported !== false && m.available !== false && m.visibility !== "hidden"))
      .map((m: any) => typeof m === "string" ? m : m.slug ?? m.id ?? m.name));
  } catch {
    // Accept only model-like identifiers, never headings or a command's help/error text.
    const rows = text.split("\n").map((line) => /^\s*(?:[*•-]\s+)?((?:gemini|claude|gpt)-[\w.-]+)(?:\s|$)/i.exec(line)?.[1]);
    const models = unique(rows);
    return models.length ? models : null;
  }
}

/** Versions of the same family retain the tier; never silently jump from Sol to Astra, or Pro to Flash. */
export function nearestModel(wanted: string, supported: string[]): string | null {
  const family = (m: string) => {
    const claude = /^(?:claude-)?(sonnet|opus|haiku)(?:-[\d.-]+)?$/.exec(m);
    return claude?.[1] ?? m.toLowerCase().replace(/\d+(?:\.\d+)*/g, "#");
  };
  const numbers = (m: string) => (m.match(/\d+/g) ?? []).map(Number);
  const version = numbers(wanted);
  const distance = (m: string) => {
    const other = numbers(m);
    return Array.from({ length: Math.max(other.length, version.length) }, (_, i) => Math.abs((other[i] ?? 0) - (version[i] ?? 0)) / 100 ** i).reduce((a, b) => a + b, 0);
  };
  return supported.includes(wanted) ? wanted : supported.filter((m) => family(m) === family(wanted)).sort((a, b) => distance(a) - distance(b) || b.localeCompare(a, undefined, { numeric: true }))[0] ?? null;
}

export function unsupportedModel(text: string): boolean {
  return /\bunknown model\b|\bmodel\b[^\r\n]{0,180}\b(?:not supported|unsupported|not found|does not exist)\b|\bunsupported model\b/i.test(text);
}

/** Cache only agy's subprocess probe. Codex's account-specific cache is cheap and may change after any run. */
export class ProfileModels {
  #agy = new Map<string, { at: number; models: string[] | null; pending?: Promise<void> }>();
  #key(profile: AgentProfile, base: NodeJS.ProcessEnv): string {
    return JSON.stringify([profile.bin, profile.env, base.PATH, base.HOME]);
  }
  snapshot(profile: AgentProfile, base: NodeJS.ProcessEnv): string[] | null {
    if (profile.container) return null;
    if (profile.kind === "claude") return [...CLAUDE_MODELS];
    // Auto is the only model choice documented for Copilot Free/Student; paid models require an explicit profile pin.
    if (profile.kind === "copilot") return ["auto"];
    if (profile.kind === "codex") {
      const env = { ...base, ...expandEnv(profile.env) };
      try { return codexModels(readFileSync(path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "models_cache.json"), "utf8")); }
      catch { return null; }
    }
    return profile.kind === "antigravity" ? this.#agy.get(this.#key(profile, base))?.models ?? null : null;
  }
  async refresh(profile: AgentProfile, base: NodeJS.ProcessEnv): Promise<void> {
    if (profile.kind !== "antigravity" || profile.container) return;
    const key = this.#key(profile, base);
    const previous = this.#agy.get(key);
    if (previous?.pending) return previous.pending;
    if (previous && Date.now() - previous.at < 60_000) return;
    const env = { ...base, ...expandEnv(profile.env) };
    const bin = resolveBin(expandHome(profile.bin), env.PATH ?? "");
    const entry = { at: Date.now(), models: null as string[] | null, pending: undefined as Promise<void> | undefined };
    this.#agy.set(key, entry);
    if (!bin) return;
    entry.pending = new Promise<void>((resolve) => {
      execFile(bin, ["models"], { env, timeout: 3000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
        entry.models = err ? null : agyModels(stdout);
        entry.pending = undefined;
        resolve();
      });
    });
    return entry.pending;
  }
}
