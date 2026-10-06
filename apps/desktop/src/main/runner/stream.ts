// Claude Code's `--output-format stream-json --verbose`: one JSON event per line while it works (its tool
// calls and their results, its messages, then the result with cost and tokens). This turns the events
// into a log a person can follow while the run goes on, and keeps a short line of what it is doing now.
import path from "node:path";

type Json = Record<string, unknown>;

export interface StreamState {
  /** What the agent does now: its own summary of the step, else its last tool call. */
  activity: string | null;
}

const clipLine = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** A file path inside the working copy as a repo path. */
function rel(file: unknown, cwd: string): string {
  if (typeof file !== "string") return "?";
  const r = path.relative(cwd, file);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : file;
}

/** "Bash: mvn -B verify", "Edit src/Main.java", "memory_search: jwt refresh". */
/**
 * Puts the time each line was written before it (ISO, to the second, UTC, then a tab), so the log viewer shows when
 * every step happened (roadmap 22l). Blank lines stay bare; a line that arrives in pieces is stamped once.
 */
export function lineStamper(now: () => Date = () => new Date()): (text: string) => string {
  let atStart = true;
  return (text) => {
    if (!text) return text;
    let out = "";
    for (const part of text.split(/(?<=\n)/)) {
      if (atStart && part !== "\n") out += `${now().toISOString().slice(0, 19)}Z\t`;
      out += part;
      atStart = part.endsWith("\n");
    }
    return out;
  };
}

export function toolLine(name: string, input: Json, cwd: string): string {
  const short = name.replace(/^mcp__.+?__/, "");
  switch (name) {
    case "Bash":
      return `Bash: ${clipLine(String(input.command ?? ""), 200)}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
    case "NotebookEdit":
      return `${name} ${rel(input.file_path ?? input.notebook_path, cwd)}`;
    case "Grep":
    case "Glob":
      return `${name}: ${clipLine(String(input.pattern ?? ""), 120)}${input.path ? ` in ${rel(input.path, cwd)}` : ""}`;
    case "WebFetch":
    case "WebSearch":
      return `${name}: ${clipLine(String(input.url ?? input.query ?? ""), 160)}`;
    case "TodoWrite":
      return "TodoWrite";
    default: {
      // MCP tools (xdev-hive: memory_search, task_update…) and anything newer: the name and its input.
      const args = clipLine(JSON.stringify(input ?? {}), 160);
      return `${short}${args === "{}" ? "" : ` ${args}`}`;
    }
  }
}

/** The text of a tool result: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && (b as Json).type === "text" ? String((b as Json).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * One event as log text (null: nothing worth a line), updating `state.activity`. The result event is left
 * to the runner, which writes it with the cost once the run ends.
 */
export function describeEvent(e: Json, cwd: string, state: StreamState): string | null {
  const content = (e.message as Json | undefined)?.content;
  switch (e.type) {
    case "system":
      if (e.subtype === "init") {
        const version = e.claude_code_version ? ` · Claude Code ${String(e.claude_code_version)}` : "";
        return `# session ${String(e.session_id ?? "?")} · model ${String(e.model ?? "?")}${version}`;
      }
      if (e.subtype === "task_summary" && typeof e.detail === "string") state.activity = clipLine(e.detail, 160);
      return null;
    case "assistant": {
      if (!Array.isArray(content)) return null;
      const out: string[] = [];
      for (const b of content as Json[]) {
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(b.text.trim());
        if (b.type === "tool_use") {
          const line = toolLine(String(b.name ?? "?"), (b.input ?? {}) as Json, cwd);
          state.activity = line;
          out.push(`▶ ${line}`);
        }
      }
      return out.length ? out.join("\n") : null;
    }
    case "user": {
      if (!Array.isArray(content)) return null;
      const out: string[] = [];
      for (const b of content as Json[]) {
        if (b.type !== "tool_result") continue;
        const text = resultText(b.content).trim();
        const lines = text ? text.split("\n") : [];
        const first = lines.length ? clipLine(lines[0]!, 160) : "(no output)";
        const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : "";
        out.push(`  ${b.is_error ? "✗" : "✓"} ${first}${more}`);
      }
      return out.length ? out.join("\n") : null;
    }
    default:
      return null;
  }
}

/** Feeds stdout chunks in; gives back the log text for the complete lines so far. */
export class ClaudeStream {
  readonly state: StreamState = { activity: null };
  /** The result event's line (cost, tokens, final message), once it came. */
  result: string | null = null;
  results = 0;
  /** The agent's last message, for a run that ends without a result. */
  lastText: string | null = null;
  /** Claude Code's session, from its init event or its result: what `--resume` takes next time. */
  sessionId: string | null = null;
  #rest = "";
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  push(chunk: string): string {
    const text = this.#rest + chunk;
    const lines = text.split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((l) => this.#line(l)).join("");
  }

  /** What is left when the process exits (a last line without a newline). */
  end(): string {
    const rest = this.#rest;
    this.#rest = "";
    return rest ? this.#line(rest) : "";
  }

  #line(raw: string): string {
    const line = raw.trim();
    if (!line) return "";
    let event: Json;
    try {
      event = JSON.parse(line) as Json;
    } catch {
      // Not an event (a CLI warning…): as it came.
      return `${raw}\n`;
    }
    if (event.type === "result") { this.result = line; this.results++; }
    if ((event.type === "result" || (event.type === "system" && event.subtype === "init")) && typeof event.session_id === "string") {
      this.sessionId = event.session_id;
    }
    const content = (event.message as Json | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      const said = (content as Json[]).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim()).at(-1);
      if (said) this.lastText = String(said.text).trim();
    }
    const text = describeEvent(event, this.#cwd, this.state);
    return text ? `${text}\n` : "";
  }
}

/**
 * Codex's `exec --json` (roadmap 28c): one JSON event per line (thread, turns, items: its messages, commands, file
 * changes, MCP calls, then the turn's token usage). Turned into the same kind of log as Claude Code's, with the agent's
 * last message kept for the run's summary. [Unverified] for Codex versions other than the 0.1xx one the names come from:
 * a line that is not a known event is written as it came.
 */
export class CodexStream {
  readonly state: StreamState = { activity: null };
  /** The agent's last message: the run's summary. */
  lastText: string | null = null;
  threadId: string | null = null;
  /** Every turn's usage added up as the events pass, so a long run's early turns count even once the log is cut. */
  readonly tokens = { turns: 0, input: 0, cached: 0, output: 0 };
  #rest = "";
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  push(chunk: string): string {
    const text = this.#rest + chunk;
    const lines = text.split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((l) => this.#line(l)).join("");
  }

  end(): string {
    const rest = this.#rest;
    this.#rest = "";
    return rest ? this.#line(rest) : "";
  }

  #line(raw: string): string {
    const line = raw.trim();
    if (!line) return "";
    let e: Json;
    try {
      e = JSON.parse(line) as Json;
    } catch {
      return `${raw}\n`;
    }
    const text = this.#describe(e);
    return text ? `${text}\n` : "";
  }

  #describe(e: Json): string | null {
    const item = (e.item ?? {}) as Json;
    switch (e.type) {
      case "thread.started":
        if (typeof e.thread_id === "string") this.threadId = e.thread_id;
        return `# thread ${String(e.thread_id ?? "?")} · Codex`;
      case "turn.completed": {
        const u = (e.usage ?? {}) as Json;
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
        this.tokens.turns++;
        this.tokens.input += n(u.input_tokens);
        this.tokens.cached += n(u.cached_input_tokens);
        this.tokens.output += n(u.output_tokens);
        return `# tokens in ${String(u.input_tokens ?? "?")} (cached ${String(u.cached_input_tokens ?? "?")}) out ${String(u.output_tokens ?? "?")}`;
      }
      case "turn.failed":
        return `✗ ${clipLine(String((e.error as Json | undefined)?.message ?? "turn failed"), 300)}`;
      case "error":
        return `✗ ${clipLine(String(e.message ?? "error"), 300)}`;
      case "item.started":
        if (item.type === "command_execution") {
          const cmd = `Bash: ${clipLine(String(item.command ?? ""), 200)}`;
          this.state.activity = cmd;
          return `▶ ${cmd}`;
        }
        if (item.type === "mcp_tool_call") {
          const call = `${String(item.tool ?? "?")}${item.server ? ` (${String(item.server)})` : ""}`;
          this.state.activity = call;
          return `▶ ${call}`;
        }
        return null;
      case "item.completed":
        switch (item.type) {
          case "agent_message": {
            const said = String(item.text ?? "").trim();
            if (!said) return null;
            this.lastText = said;
            return said;
          }
          case "command_execution": {
            const out = String(item.aggregated_output ?? "").trim().split("\n");
            const code = item.exit_code;
            return `  ${code === 0 ? "✓" : "✗"} ${out[0] ? clipLine(out[0], 160) : `exit ${String(code ?? "?")}`}${out.length > 1 ? ` (+${out.length - 1} lines)` : ""}`;
          }
          case "file_change": {
            const changes = Array.isArray(item.changes) ? (item.changes as Json[]) : [];
            const lines = changes.map((c) => `▶ ${c.kind === "add" ? "Write" : "Edit"} ${rel(c.path, this.#cwd)}`);
            if (lines.length) this.state.activity = lines.at(-1)!.slice(2);
            return lines.length ? lines.join("\n") : null;
          }
          case "web_search":
            return `▶ WebSearch: ${clipLine(String(item.query ?? ""), 160)}`;
          default:
            return null;
        }
      default:
        return null;
    }
  }
}

/** agy's schema is unverified: preserve every line, extracting only recognisable messages and results. */
export class AntigravityStream {
  readonly state: StreamState = { activity: null };
  lastText: string | null = null;
  #rest = "";
  push(chunk: string): string {
    const lines = (this.#rest + chunk).split("\n");
    this.#rest = lines.pop() ?? "";
    return lines.map((line) => this.#line(line)).join("");
  }
  end(): string {
    const line = this.#rest;
    this.#rest = "";
    return line ? this.#line(line) : "";
  }
  #line(line: string): string {
    try {
      const e = JSON.parse(line) as Json;
      const message = e.message as Json | undefined;
      const content = message?.content;
      const text = typeof e.result === "string" ? e.result : typeof e.text === "string" ? e.text : resultText(content);
      if (text && /result|assistant|message|final/.test(String(e.type))) this.lastText = text;
      this.state.activity = clipLine(text || String(e.type ?? line), 160);
    } catch { this.state.activity = clipLine(line, 160); }
    return `${line}\n`;
  }
}
