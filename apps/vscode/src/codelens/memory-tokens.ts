import { basename, resolve } from "node:path";

export const INSTRUCTION_FILES = new Set(["CLAUDE.md", "AGENTS.md", "MEMORY.md"]);
const CACHE_MS = 60_000;

export type TokenEstimate = { tokens: number; rough: boolean };

export interface MemoryTokensDeps {
  /** `hive-worker memory scan --json`; undefined khi không có worker hoặc workspace chưa tin cậy. */
  scan(): Promise<{ files?: { path: string; tokens: number }[] } | undefined>;
  now?(): number;
}

/** Token nạp mỗi phiên theo `memstore` của worker; không có worker thì ước tính thô bằng ký tự / 4. */
export class MemoryTokens {
  private readonly deps: MemoryTokensDeps;
  private cache: { at: number; tokens: Map<string, number> } | undefined;
  private pending: Promise<Map<string, number>> | undefined;

  constructor(deps: MemoryTokensDeps) {
    this.deps = deps;
  }

  async estimate(fsPath: string, text: string): Promise<TokenEstimate> {
    const known = (await this.inventory()).get(resolve(fsPath));
    return known === undefined ? { tokens: Math.ceil(text.length / 4), rough: true } : { tokens: known, rough: false };
  }

  private inventory(): Promise<Map<string, number>> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cache && now - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.tokens);
    // Nhiều lần hover liên tiếp dùng chung một lần quét.
    this.pending ??= this.deps
      .scan()
      .catch(() => undefined)
      .then((view) => {
        const tokens = new Map<string, number>();
        for (const file of view?.files ?? []) {
          if (typeof file.path === "string" && Number.isFinite(file.tokens))
            tokens.set(resolve(file.path), file.tokens);
        }
        this.cache = { at: now, tokens };
        return tokens;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}

export const isInstructionFile = (fsPath: string): boolean => INSTRUCTION_FILES.has(basename(fsPath));
