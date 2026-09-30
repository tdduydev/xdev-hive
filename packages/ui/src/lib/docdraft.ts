// Docs: unsaved drafts kept on the device (they survive a reload or a closed window) and the Markdown toolbar's edit.

export interface DocDraft {
  title: string;
  content: string;
  includeInAgents: boolean;
  /** Globs as typed: comma- or line-separated. */
  paths: string;
  note: string;
  /** The version the draft started from: a newer saved version means someone else changed the doc meanwhile. */
  baseVersion: number;
  savedAt: string;
  /** Saved (or proposed) while the hub could not be reached: sent when it answers again. */
  queued?: { mode: "save" | "propose"; at: string };
  /** A page not saved yet: where it goes in the tree (roadmap 22j). */
  parent?: string | null;
}

const KEY = "hive-doc-drafts";

export function readDrafts(): Record<string, DocDraft> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, DocDraft>) : {};
  } catch {
    return {};
  }
}

/** Tells open views (the Docs page, the outbox) that the drafts changed. */
export const DRAFTS_EVENT = "hive-doc-drafts";

export function writeDrafts(drafts: Record<string, DocDraft>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts));
  } catch {
    // Storage blocked or full: the draft lasts for this session only.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DRAFTS_EVENT));
}

/** A call that failed because the hub could not be reached at all (desktop: HiveError "unavailable"; web: fetch). */
export function isUnreachable(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "unavailable" || err instanceof TypeError;
}

/**
 * The toolbar's edit: wraps the selection in `pre`/`post` ("**" … "**"), or with `line` puts `pre` at the start of
 * the selection's line ("## ", "- "). Returns the new text and where the selection goes.
 */
export function insertMd(
  text: string,
  start: number,
  end: number,
  pre: string,
  post = "",
  line = false,
): { text: string; start: number; end: number } {
  if (line) {
    const at = text.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const next = text.slice(0, at) + pre + text.slice(at);
    return { text: next, start: start + pre.length, end: end + pre.length };
  }
  const next = text.slice(0, start) + pre + text.slice(start, end) + post + text.slice(end);
  return { text: next, start: start + pre.length, end: end + pre.length };
}

/** Globs as typed, deduplicated. */
export const parsePaths = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
