// A review run's verdict, read from its report: the MR a machine opens and the web's Runs page both use it.
// Browser-safe.

export const VERDICTS = ["approve", "changes", "unknown", "none"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Reads the verdict the review prompt asks for ("verdict (approve / changes needed)"). */
export function parseVerdict(summary: string | null | undefined): Verdict {
  if (!summary?.trim()) return "unknown";
  const line = /verdict\s*[:：\-–—]?\s*\**\s*([^\n]{0,60})/i.exec(summary)?.[1] ?? "";
  if (/^(changes?\s+(needed|requested|required)|request(ed)?\s+changes|reject|not\s+approved)/i.test(line)) return "changes";
  if (/^(approve[ds]?|lgtm|ship\s*it|ok\b)/i.test(line)) return "approve";
  if (/(?<!\bno\s)\bchanges?\s+(needed|requested|required)\b|\brequest(ed)?\s+changes\b/i.test(summary)) return "changes";
  if (/\b(approved?|lgtm)\b/i.test(summary)) return "approve";
  return "unknown";
}
