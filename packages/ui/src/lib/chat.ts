// Small helpers of the Chat page: which machines can hold a thread, following a reply being written, and a
// leader's reply turned into text with links to the tasks and runs it names.
import type { ChatMessage, Machine, ReportedProfile } from "@xdev-hive/core";

/** A Claude profile that can write a reply now: the hub asks the same (chat.send). */
export const chatProfile = (p: ReportedProfile): boolean => p.kind === "claude" && p.enabled && p.loggedIn !== false;

/** Machines a new thread of `project` can run on: online, taking runs from the hub, with its repo and a Claude plan. */
export function chatMachines(machines: Machine[], project: string): Machine[] {
  return machines.filter((m) => m.online && m.acceptsRuns && m.projects.includes(project) && m.profiles.some(chatProfile));
}

/** A reply that is still waiting for its machine or being written. */
export const isLiveReply = (m: Pick<ChatMessage, "status">): boolean => m.status === "pending" || m.status === "running";

/** Badge tone of a reply's status. */
export const REPLY_TONE: Record<string, string> = { pending: "neutral", running: "info", done: "ok", failed: "danger", cancelled: "neutral", expired: "warn" };

/**
 * Where to read a thread from on the next poll (chat.get `after`): a reply being written changes in place, so from
 * just before the first one still live; otherwise only what came after the last message.
 */
export function pollAfter(messages: ChatMessage[]): number {
  const live = messages.find(isLiveReply);
  if (live) return live.id - 1;
  return messages.length ? messages[messages.length - 1]!.id : 0;
}

/** The messages known so far with those a poll returned: newer versions replace older ones, in id order. */
export function mergeMessages(known: ChatMessage[], fresh: ChatMessage[]): ChatMessage[] {
  if (!fresh.length) return known;
  const byId = new Map(known.map((m) => [m.id, m]));
  for (const m of fresh) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** The tool calls in a reply's steps (the ▶ lines of the run log). */
export const stepCount = (steps: string): number => steps.split("\n").filter((l) => l.startsWith("▶")).length;

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "em"; text: string }
  | { kind: "task"; text: string }
  | { kind: "run"; text: string }
  | { kind: "url"; text: string };

export type Block = { kind: "code"; text: string } | { kind: "text"; parts: Inline[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A leader's reply for display: ``` blocks stay as code, and in the text between them `code`, **bold**, *emphasis*,
 * web links, run ids (R-1a2b3c) and the ids of the project's tasks are picked out. Everything else is shown as written.
 */
export function replyBlocks(text: string, taskIds: Iterable<string> = []): Block[] {
  const blocks: Block[] = [];
  const fence = /^```[^\n]*\n([\s\S]*?)(?:^```[ \t]*$|(?![\s\S]))/gm;
  let at = 0;
  for (const m of text.matchAll(fence)) {
    if (m.index > at) pushText(blocks, text.slice(at, m.index), taskIds);
    blocks.push({ kind: "code", text: m[1]!.replace(/\n$/, "") });
    at = m.index + m[0].length;
  }
  if (at < text.length) pushText(blocks, text.slice(at), taskIds);
  return blocks;
}

function pushText(blocks: Block[], text: string, taskIds: Iterable<string>) {
  const trimmed = text.replace(/^\n+|\n+$/g, "");
  if (trimmed) blocks.push({ kind: "text", parts: inline(trimmed, taskIds) });
}

/** Text with its code spans, emphasis, links and ids picked out (see replyBlocks). */
export function inline(text: string, taskIds: Iterable<string> = []): Inline[] {
  // Longer ids first, so AUTH-12 is not read as AUTH-1 and a trailing 2.
  const ids = [...new Set(taskIds)].filter(Boolean).sort((a, b) => b.length - a.length).map(escape);
  // An id stands alone: not inside a longer word, and a sentence's full stop after it is not part of it.
  const alone = (p: string) => `(?<![\\w.-])(?:${p})(?![\\w-]|\\.\\w)`;
  const pattern = new RegExp(
    [
      "`([^`\\n]+)`",
      "\\*\\*([^*\\n]+)\\*\\*",
      // *like this*, not the stars of 2 * 3 * 4.
      "(?<![\\w*])\\*(?=\\S)([^*\\n]+?)(?<=\\S)\\*(?![\\w*])",
      "(https?://[^\\s<>()\"'`]+[^\\s<>()\"'`.,;:!?])",
      `(${alone("R-[0-9a-f]{6}")})`,
      ...(ids.length ? [`(${alone(ids.join("|"))})`] : []),
    ].join("|"),
    "g",
  );
  const parts: Inline[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    const [, code, bold, em, url, run, task] = m;
    if (code !== undefined) parts.push({ kind: "code", text: code });
    else if (bold !== undefined) parts.push({ kind: "bold", text: bold });
    else if (em !== undefined) parts.push({ kind: "em", text: em });
    else if (url !== undefined) parts.push({ kind: "url", text: url });
    else if (run !== undefined) parts.push({ kind: "run", text: run });
    else parts.push({ kind: "task", text: task! });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}
