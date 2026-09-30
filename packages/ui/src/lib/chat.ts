// Small helpers of the Chat page: which machines can hold a thread, following a reply being written, and a
// leader's reply turned into text with links to the tasks and runs it names.
import type { ChatAction, ChatMessage, Machine, ReportedProfile } from "@xdev-hive/core";

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

/** A reply that can still change: being written, or with an action nobody decided yet (another manager may). */
const changing = (m: ChatMessage): boolean => isLiveReply(m) || m.actions.some((a) => a.status === "proposed");

/**
 * Where to read a thread from on the next poll (chat.get `after`): a reply that can still change does so in place, so
 * from just before the first one; otherwise only what came after the last message.
 */
export function pollAfter(messages: ChatMessage[]): number {
  const live = messages.find(changing);
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

/** The messages with one action replaced by its newer version (after deciding it). */
export function withAction(messages: ChatMessage[], action: ChatAction): ChatMessage[] {
  return messages.map((m) => (m.id === action.replyId ? { ...m, actions: m.actions.map((a) => (a.id === action.id ? action : a)) } : m));
}

/** A machine's name from its hub id: `runner.duy-mbp@duy-mbp` → duy-mbp. */
export const machineName = (id: string): string => id.replace(/^runner\./, "").split("@")[0]!;

/** The task a leader's action is about. */
export const actionTask = (a: Pick<ChatAction, "kind" | "input">): string => String(a.kind === "run.dispatch" ? a.input.taskId : a.input.id);

/** Badge tone of an action's status. */
export const ACTION_TONE: Record<string, string> = { proposed: "warn", done: "ok", failed: "danger", dismissed: "neutral" };

/** A file's size for people: 820 B, 12 KB, 1.4 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The tool calls in a reply's steps (the ▶ lines of the run log). */
export const stepCount = (steps: string): number => steps.split("\n").filter((l) => l.startsWith("▶")).length;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type IdPart = { kind: "text" | "task" | "run"; text: string };

/** Text with the ids of the project's tasks and run ids (R-1a2b3c) picked out, to become links. */
export function linkIds(text: string, taskIds: Iterable<string> = []): IdPart[] {
  // Longer ids first, so AUTH-12 is not read as AUTH-1 and a trailing 2.
  const ids = [...new Set(taskIds)].filter(Boolean).sort((a, b) => b.length - a.length).map(escape);
  // An id stands alone: not inside a longer word, and a sentence's full stop after it is not part of it.
  const alone = (p: string) => `(?<![\\w.-])(?:${p})(?![\\w-]|\\.\\w)`;
  const pattern = new RegExp([`(${alone("R-[0-9a-f]{6}")})`, ...(ids.length ? [`(${alone(ids.join("|"))})`] : [])].join("|"), "g");
  const parts: IdPart[] = [];
  let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    parts.push(m[1] !== undefined ? { kind: "run", text: m[1] } : { kind: "task", text: m[2]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

/** Where a task or run id links to: its panel on the Tasks or Runs page. */
export const idHref = (p: IdPart): string => (p.kind === "run" ? `#/runs?run=${encodeURIComponent(p.text)}` : `#/tasks?task=${encodeURIComponent(p.text)}`);

/** The few Markdown syntax tree fields this plugin reads and writes. */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Code, and text already inside a link, stay as they are. */
const KEEP = new Set(["link", "linkReference", "definition", "code", "inlineCode", "html"]);

function linkTree(node: MdNode, taskIds: string[]): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child): MdNode[] => {
    if (child.type === "text" && child.value) {
      return linkIds(child.value, taskIds).map((p) =>
        p.kind === "text" ? { type: "text", value: p.text } : { type: "link", url: idHref(p), children: [{ type: "text", value: p.text }] },
      );
    }
    if (!KEEP.has(child.type)) linkTree(child, taskIds);
    return [child];
  });
}

/** A remark plugin: the project's task ids and run ids in a reply become links to their page. */
export function remarkHiveLinks(options?: { taskIds?: string[] }) {
  const taskIds = options?.taskIds ?? [];
  return (tree: MdNode) => linkTree(tree, taskIds);
}

/**
 * How a leader's reply is read as Markdown (GitHub's flavour): raw HTML is never rendered, and an image would load
 * from wherever the text points, so it is left out. Attachments come with the message instead.
 */
export const REPLY_MARKDOWN = {
  skipHtml: true,
  disallowedElements: ["img"],
  unwrapDisallowed: true,
} as const;
