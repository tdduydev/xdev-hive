/** Signals already reported by the machine; a free-form question is only recognized when the agent explicitly asks. */
export function waitingReason(run: { status: string; summary?: string | null; error?: string | null; mr?: { pipeline: string | null } | null }): "question" | "ci" | "quota" | null {
  if (run.mr?.pipeline === "failed") return "ci";
  if (run.status === "rate_limited" || /\b(quota|rate limit|usage limit)\b|hết (hạn mức|quota)/i.test(run.error ?? "")) return "quota";
  if (/\b(need your input|please (confirm|clarify|choose)|awaiting (input|response))\b|cần (bạn|người dùng) (xác nhận|trả lời|chọn)|chờ (bạn|người dùng) (trả lời|xác nhận)/i.test(run.summary ?? "")) return "question";
  return null;
}
