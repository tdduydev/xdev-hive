// A review run's verdict, read from its report: the MR a machine opens and the web's Runs page both use it.
// Browser-safe.

export const VERDICTS = ["approve", "changes", "unknown", "none"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Reads a review verdict from its final verdict line or an unambiguous findings summary. */
export function parseVerdict(summary: string | null | undefined): Verdict {
  if (!summary?.trim()) return "unknown";
  // Prefer the explicit label, since findings may discuss both resolved and open issues.
  const verdictLine = summary.match(/^[ \t>#*_\-]*verdict(?:\*\*)?\s*[:：\-–—]?\s*(?:\*\*)?([^\n]{0,80})/im)?.[1]?.trim() ?? "";
  if (verdictLine) {
    if (/^(?:changes?|needs?\s+(?:changes|fixes)|changes?\s+(?:needed|requested|required)|request(?:ed)?\s+changes|reject(?:ed)?|not\s+approved|cần\s+(?:sửa|thay\s+đổi)|cần\s+chỉnh)/i.test(verdictLine)) return "changes";
    if (/^(?:approve[ds]?|approved\s+with\s+(?:no\s+)?(?:blocking\s+)?findings|lgtm|ship\s*it|ok\b|không\s+chặn|không\s+có\s+(?:vấn\s+đề|lỗi)\s+chặn)/i.test(verdictLine)) return "approve";
  }

  const text = summary.replace(/```[\s\S]*?```/g, " ");
  if (/(?<!\bno\s)\b(?:changes?\s+(?:needed|requested|required)|request(?:ed)?\s+changes|blocking\s+(?:finding|issue|problem)s?\s+(?:remain|exist)|must\s+be\s+fixed|cần\s+(?:sửa|thay\s+đổi|chỉnh)|phải\s+(?:sửa|chỉnh))\b|đang\s+bị\s+chặn/i.test(text)) return "changes";
  if (/\b(?:no\s+blocking\s+(?:findings?|issues?|problems?)|none\s+block(?:s)?\s+(?:the\s+)?review|nothing\s+blocks?\s+(?:the\s+)?review|no\s+blockers?|không\s+chặn|không\s+có\s+(?:vấn\s+đề|lỗi)\s+chặn)\b/i.test(text)) return "approve";
  if (/\b(?:approved?|lgtm)\b/i.test(text)) return "approve";
  return "unknown";
}
