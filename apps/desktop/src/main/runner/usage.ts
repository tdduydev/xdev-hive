// What an agent CLI says about a finished run. Claude Code with `--output-format json` prints one
// result object: the final message, an API-price cost estimate and token counts.

export interface RunUsage {
  /** The agent's final message; replaces the raw stdout as the run's summary. */
  text: string | null;
  /** Estimated at API prices; a subscription does not bill it. */
  costUsd: number | null;
  /** Input tokens including cache reads and writes. */
  inputTokens: number | null;
  outputTokens: number | null;
}

const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** The last `{"type":"result",…}` line on stdout, or null when there is none. */
export function parseClaudeResult(stdout: string): RunUsage | null {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (json.type !== "result") continue;
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(count);
    return {
      text: typeof json.result === "string" ? json.result : null,
      costUsd: count(json.total_cost_usd),
      inputTokens: parts.every((p) => p === null) ? null : parts.reduce<number>((n, p) => n + (p ?? 0), 0),
      outputTokens: count(usage.output_tokens),
    };
  }
  return null;
}

/** The `--output-format` a claude command line asks for, or null when it names none. */
export function outputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--output-format") return args[i + 1] ?? null;
    if (a.startsWith("--output-format=")) return a.slice("--output-format=".length);
  }
  return null;
}
