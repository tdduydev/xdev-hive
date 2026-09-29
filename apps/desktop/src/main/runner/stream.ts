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
  /** The agent's last message, for a run that ends without a result. */
  lastText: string | null = null;
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
    if (event.type === "result") this.result = line;
    const content = (event.message as Json | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      const said = (content as Json[]).filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim()).at(-1);
      if (said) this.lastText = String(said.text).trim();
    }
    const text = describeEvent(event, this.#cwd, this.state);
    return text ? `${text}\n` : "";
  }
}
