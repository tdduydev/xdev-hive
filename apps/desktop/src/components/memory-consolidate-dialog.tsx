import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { useEffect, useState } from "react";
import { ProposalDiff } from "@/components/memory-compress-dialog.tsx";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText, invoke } from "@/lib/tauri.ts";

/** Một nhóm file nên gộp (`hive-worker memory consolidate --json`). Chưa ghi gì xuống máy. */
export interface MergeProposal {
  sources: string[];
  /** Luôn là một trong `sources`, để giữ tên file và dòng chỉ mục đã có. */
  target: string;
  reason: string;
  /** Nội dung các nguồn nối lại theo thứ tự `sources`. */
  before: string;
  content: string;
  tokensBefore: number;
  tokensAfter: number;
  newLines: number[];
}

export interface Consolidation {
  merges: MergeProposal[];
  tokensUsed: number;
  warnings: string[];
}

const text: Dict<{
  title: string;
  lead: string;
  evaluate: string;
  working: string;
  again: string;
  apply: (n: number) => string;
  applying: string;
  close: string;
  nothing: string;
  used: (tokens: number) => string;
  saved: (before: number, after: number) => string;
  into: string;
  legend: string;
  applied: (n: number, entry: string) => string;
}> = {
  vi: {
    title: "Đánh giá và gộp memory",
    lead: "Claude đọc các file memory của gói này, tìm nhóm file nói cùng chuyện và viết bản gộp. Chưa file nào bị đổi: bạn xem diff từng nhóm rồi mới áp dụng. File nguồn khác file đích vào thùng rác, chỉ mục và link được sửa theo, và có thể khôi phục.",
    evaluate: "Đánh giá",
    working: "Claude đang đọc và đánh giá… (tính vào gói của bạn)",
    again: "Đánh giá lại",
    apply: (n) => `Gộp ${n} nhóm`,
    applying: "Đang gộp…",
    close: "Đóng",
    nothing: "Claude không thấy nhóm file nào nên gộp.",
    used: (tokens) => `Lượt đánh giá dùng ${tokens.toLocaleString("vi-VN")} token.`,
    saved: (before, after) => `${before} → ${after} token mỗi phiên`,
    into: "gộp vào",
    legend: "Dòng viền cam là chữ mới mà Claude thêm, không có trong file cũ. Đọc kỹ trước khi áp dụng.",
    applied: (n, entry) => `Đã gộp ${n} nhóm. Mã khôi phục: ${entry}`,
  },
  en: {
    title: "Review and merge memory",
    lead: "Claude reads this profile's memory files, finds groups that cover the same topic and drafts a merged file. Nothing is changed yet: review each group's diff before applying. Source files other than the target go to the trash, the index and links are updated, and it can be restored.",
    evaluate: "Review",
    working: "Claude is reading and reviewing… (counts against your plan)",
    again: "Review again",
    apply: (n) => `Merge ${n} group${n === 1 ? "" : "s"}`,
    applying: "Merging…",
    close: "Close",
    nothing: "Claude found no files worth merging.",
    used: (tokens) => `This review used ${tokens.toLocaleString("en-US")} tokens.`,
    saved: (before, after) => `${before} → ${after} tokens per session`,
    into: "into",
    legend:
      "Lines with an orange border are new text Claude added that is not in the old files. Read them closely before applying.",
    applied: (n, entry) => `Merged ${n} group${n === 1 ? "" : "s"}. Restore id: ${entry}`,
  },
};

const consolidate = (profile: string, project: string) =>
  invoke<Consolidation>("memory_consolidate", { profile, project });

const applyMerge = (m: MergeProposal) =>
  invoke<{ entry: string }>("memory_apply", {
    operation: { action: "merge", sources: m.sources, target: m.target, content: m.content },
  });

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Hộp "Đánh giá và gộp" của màn Memory: một lượt AI tìm nhóm file chồng lấn trong cùng thư mục memory của một gói,
 * hiện diff từng nhóm, và chỉ ghi khi bấm gộp (qua `memory merge` của worker, có sao lưu).
 */
export function MemoryConsolidateDialog({
  open,
  onOpenChange,
  profile,
  project,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: string;
  project: string;
  onApplied?: () => void;
}) {
  const t = useT(text);
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "applying">("idle");
  const [result, setResult] = useState<Consolidation | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Mở lại hộp thì bắt đầu sạch: đề xuất cũ có thể đã lỗi thời so với file trên đĩa.
  useEffect(() => {
    if (open) return;
    setPhase("idle");
    setResult(null);
    setPicked(new Set());
    setError(null);
    setNotice(null);
  }, [open]);

  const evaluate = async () => {
    setPhase("working");
    setError(null);
    setNotice(null);
    try {
      const next = await consolidate(profile, project);
      setResult(next);
      setPicked(new Set(next.merges.map((m) => m.target)));
    } catch (e) {
      setResult(null);
      setError(errorText(e));
    }
    setPhase("done");
  };

  const apply = async () => {
    if (!result) return;
    setPhase("applying");
    setError(null);
    let applied = 0;
    let entry = "";
    // Ghi tuần tự và dừng ở lỗi đầu tiên: nhóm đã gộp có mã khôi phục riêng, nhóm chưa gộp vẫn còn nguyên.
    try {
      for (const m of result.merges.filter((x) => picked.has(x.target))) {
        entry = (await applyMerge(m)).entry;
        applied++;
      }
      setNotice(t.applied(applied, entry));
      setResult(null);
      onApplied?.();
    } catch (e) {
      setError(errorText(e));
      if (applied > 0) onApplied?.();
    }
    setPhase("done");
  };

  const toggle = (target: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(target)) next.add(target);
      return next;
    });

  const busy = phase === "working" || phase === "applying";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3.5 overflow-y-auto p-5 sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="text-[17px] font-semibold">{t.title}</DialogTitle>
          <DialogDescription className="text-sm">{t.lead}</DialogDescription>
        </DialogHeader>

        {error && <Alert variant="destructive">{error}</Alert>}
        {notice && <Alert>{notice}</Alert>}
        {phase === "working" && <p className="text-sm text-muted-foreground">{t.working}</p>}
        {result?.warnings.map((w) => (
          <p key={w} className="text-xs text-muted-foreground">
            {w}
          </p>
        ))}
        {result && result.merges.length === 0 && <p className="text-sm text-muted-foreground">{t.nothing}</p>}

        {result?.merges.map((m) => (
          <section key={m.target} className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(m.target)}
                disabled={busy}
                onChange={() => toggle(m.target)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-xs" title={m.sources.join("\n")}>
                  {m.sources.map(baseName).join(" + ")} {t.into} {baseName(m.target)}
                </span>
                {m.reason && <span className="text-xs">{m.reason}</span>}
                <span className="text-xs text-muted-foreground">{t.saved(m.tokensBefore, m.tokensAfter)}</span>
              </span>
            </label>
            <ProposalDiff proposal={m} />
          </section>
        ))}
        {result?.merges.some((m) => m.newLines.length > 0) && (
          <p className="text-xs text-muted-foreground">{t.legend}</p>
        )}
        {result && <p className="text-xs text-muted-foreground">{t.used(result.tokensUsed)}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={phase === "applying"}>
            {t.close}
          </Button>
          <Button variant="outline" onClick={evaluate} disabled={busy}>
            {result || error ? t.again : t.evaluate}
          </Button>
          {result && result.merges.length > 0 && (
            <Button onClick={apply} disabled={busy || picked.size === 0}>
              {phase === "applying" ? t.applying : t.apply(picked.size)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
