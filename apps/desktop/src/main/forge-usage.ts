// When this machine's GitLab and GitHub tokens last worked (GROUP-repos-forge), for the connection card. A file beside
// config.json, not config.json itself: every fetch would otherwise rewrite the person's settings. Never the token.
// No Electron imports.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ForgeUse } from "@xdev-hive/core";

export type ForgeKind = "gitlab" | "github";
export type ForgeUsage = Partial<Record<ForgeKind, ForgeUse>>;

export class ForgeUsageStore {
  #file: string;
  #now: () => Date;
  #data: ForgeUsage;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.#file = file;
    this.#now = now;
    this.#data = ForgeUsageStore.#read(file);
  }

  static #read(file: string): ForgeUsage {
    try {
      const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
      const out: ForgeUsage = {};
      for (const kind of ["gitlab", "github"] as const) {
        const v = raw[kind] as Partial<ForgeUse> | undefined;
        if (v && typeof v.at === "string") out[kind] = { at: v.at, user: typeof v.user === "string" ? v.user : null, by: typeof v.by === "string" ? v.by : "check" };
      }
      return out;
    } catch {
      // A broken file only loses the "last used" line; it must not stop the app.
      return {};
    }
  }

  get(kind: ForgeKind): ForgeUse | null {
    return this.#data[kind] ?? null;
  }

  /** user: who a check answered with; left out, the last known account stays. */
  record(kind: ForgeKind, by: string, user?: string | null): void {
    const prev = this.#data[kind];
    this.#data[kind] = { at: this.#now().toISOString(), user: user === undefined ? (prev?.user ?? null) : user, by };
    try {
      writeFileSync(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`);
    } catch {
      // Kept in memory for this session; the next record tries the file again.
    }
  }

  /** A token that changed belongs to someone else, maybe: what the old one did says nothing about it. */
  forget(kind: ForgeKind): void {
    if (!this.#data[kind]) return;
    delete this.#data[kind];
    try {
      writeFileSync(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`);
    } catch {
      /* As in record(). */
    }
  }
}
