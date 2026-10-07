import type { ChatMessage } from "@xdev-hive/core";

/** Mobile Enter belongs to the keyboard; explicit modifiers still send on either surface. */
export function chatSubmitKey(key: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; composing: boolean }, mobile: boolean): boolean {
  return key.key === "Enter" && !key.shiftKey && !key.composing && (!mobile || key.ctrlKey || key.metaKey);
}

export function loadedMatches(messages: Pick<ChatMessage, "id" | "text">[], query: string): number[] {
  const needle = query.trim().normalize("NFC").toLocaleLowerCase("vi");
  return needle ? messages.filter((m) => m.text.normalize("NFC").toLocaleLowerCase("vi").includes(needle)).map((m) => m.id) : [];
}

/** React renders these strings as text, including markup supplied by the person searching. */
export function matchExcerpt(text: string, query: string): { before: string; match: string; after: string } {
  const source = text.normalize("NFC");
  const needle = query.trim().normalize("NFC");
  const at = source.toLocaleLowerCase("vi").indexOf(needle.toLocaleLowerCase("vi"));
  if (!needle || at < 0) return { before: source.slice(0, 160), match: "", after: "" };
  return { before: (at > 60 ? "…" : "") + source.slice(Math.max(0, at - 60), at), match: source.slice(at, at + needle.length), after: source.slice(at + needle.length, at + needle.length + 100) + (source.length > at + needle.length + 100 ? "…" : "") };
}

export function turnSeconds(createdAt: string, end: string | number): number {
  const seconds = Math.floor(((typeof end === "number" ? end : Date.parse(end)) - Date.parse(createdAt)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

type UsageMessage = { role: string; tokens?: { inputTokens: number; cacheReadTokens: number; outputTokens: number } | null; costUsd: number | null };
export function chatUsage(messages: UsageMessage[]) {
  const turns = messages.filter((m) => m.role === "assistant");
  return {
    tokens: turns.reduce((sum, m) => sum + (m.tokens ? m.tokens.inputTokens + m.tokens.cacheReadTokens + m.tokens.outputTokens : 0), 0),
    missing: turns.filter((m) => m.tokens == null).length,
    measured: turns.filter((m) => m.tokens != null).length,
    cost: turns.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
    missingCost: turns.filter((m) => m.costUsd === null).length,
  };
}
