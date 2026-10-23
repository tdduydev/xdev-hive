import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@xdev-hive/ui/dialog";
import { useEffect, useState } from "react";
import { type DiffLine, diffHunks, lineDiff } from "@/lib/diff.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { errorText, invoke } from "@/lib/tauri.ts";
import { cn } from "@/lib/utils.ts";

/** Một đề xuất nén của worker (`hive-worker memory compress --json`). Chưa ghi gì xuống máy. */
export interface CompressProposal {
  path: string;
  before: string;
  content: string;
  tokensBefore: number;
  tokensAfter: number;
  /** Số dòng (từ 1) của `content` không có trong file nguồn nào. */
  newLines: number[];
}

export interface Compression {
  files: CompressProposal[];
  tokensUsed: number;
  warnings: string[];
}

interface Line extends DiffLine {
  /** Dòng thêm mà AI không lấy từ file nguồn nào: soi kỹ trước khi áp dụng. */
  unsourced: boolean;
}

const text: Dict<{
  title: string;
  lead: string;
  suggest: string;
  working: string;
  again: string;
  apply: (n: number) => string;
  applying: string;
  close: string;
  nothing: string;
  used: (tokens: number) => string;
  saved: (before: number, after: number) => string;
  unsourced: string;
  legend: string;
  applied: (n: number, entry: string) => string;
}> = {
  vi: {
    title: "Gợi ý nén memory",
    lead: "Claude đọc các file memory của gói này và đề xuất bản gọn hơn. Chưa file nào bị đổi: bạn xem từng thay đổi rồi mới áp dụng, và mỗi lần áp dụng đều có bản sao lưu để khôi phục.",
    suggest: "Gợi ý nén",
    working: "Claude đang đọc và viết đề xuất… (tính vào gói của bạn)",
    again: "Gợi ý lại",
    apply: (n) => `Áp dụng ${n} file`,
    applying: "Đang áp dụng…",
    close: "Đóng",
    nothing: "Claude không thấy gì cần nén trong các file này.",
    used: (tokens) => `Lượt gợi ý dùng ${tokens.toLocaleString("vi-VN")} token.`,
    saved: (before, after) => `${before} → ${after} token mỗi phiên`,
    unsourced: "mới",
    legend: "Dòng viền cam là chữ mới mà Claude thêm, không có trong file cũ. Đọc kỹ trước khi áp dụng.",
    applied: (n, entry) => `Đã áp dụng ${n} file. Mã khôi phục: ${entry}`,
  },
  en: {
    title: "Suggest memory compression",
    lead: "Claude reads this profile's memory files and proposes shorter versions. Nothing is changed yet: review each change before applying, and every apply keeps a backup you can restore.",
    suggest: "Suggest compression",
    working: "Claude is reading and drafting… (counts against your plan)",
    again: "Suggest again",
    apply: (n) => `Apply ${n} file${n === 1 ? "" : "s"}`,
    applying: "Applying…",
    close: "Close",
    nothing: "Claude found nothing to compress in these files.",
    used: (tokens) => `This suggestion used ${tokens.toLocaleString("en-US")} tokens.`,
    saved: (before, after) => `${before} → ${after} tokens per session`,
    unsourced: "new",
    legend:
      "Lines with an orange border are new text Claude added that is not in the old file. Read them closely before applying.",
    applied: (n, entry) => `Applied ${n} file${n === 1 ? "" : "s"}. Restore id: ${entry}`,
  },
};

const compress = (profile: string, project: string, files: string[]) =>
  invoke<Compression>("memory_compress", { profile, project, files });

const applyEdit = (path: string, content: string) =>
  invoke<{ entry: string }>("memory_apply", { operation: { action: "edit", path, content } });

/** Gắn cờ "mới" vào dòng thêm theo số dòng của bản mới; số dòng đếm trên toàn bộ diff, trước khi cắt bớt đoạn giống. */
function annotate(p: Pick<CompressProposal, "before" | "content" | "newLines">): (Line | null)[] {
  const fresh = new Set(p.newLines);
  let n = 0;
  const lines = lineDiff(p.before, p.content).map((l): Line => {
    if (l.kind !== "del") n++;
    return { ...l, unsourced: l.kind === "add" && fresh.has(n) };
  });
  return diffHunks(lines) as (Line | null)[];
}

/** Diff trước/sau của một đề xuất AI, dòng thêm không có nguồn được viền cam. Dùng chung cho nén và gộp. */
export function ProposalDiff({ proposal }: { proposal: Pick<CompressProposal, "before" | "content" | "newLines"> }) {
  const t = useT(text);
  return (
    <div className="max-h-64 overflow-auto rounded-md border font-mono text-xs leading-5">
      {annotate(proposal).map((line, i) =>
        line === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: diff chỉ đọc, thứ tự cố định
          <div key={i} className="px-2.5 text-muted-foreground">
            …
          </div>
        ) : (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: diff chỉ đọc, thứ tự cố định
            key={i}
            className={cn(
              "px-2.5 whitespace-pre-wrap",
              line.kind === "add" && "bg-success-soft text-success",
              line.kind === "del" && "bg-destructive-soft text-destructive",
              line.unsourced && "border-l-2 border-warning",
            )}
            data-unsourced={line.unsourced || undefined}
          >
            {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : ""}
            {line.text}
            {line.unsourced && <span className="ml-2 text-warning">({t.unsourced})</span>}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Hộp "Gợi ý nén" của màn Memory (specs/015 US5): chạy AI một lần khi người dùng bấm, hiện diff từng file, và chỉ ghi
 * khi bấm "Áp dụng" (qua `memory edit` của worker, có sao lưu).
 */
export function MemoryCompressDialog({
  open,
  onOpenChange,
  profile,
  project,
  files = [],
  onApplied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: string;
  project: string;
  /** Rỗng là nén mọi file của dự án trong gói này. */
  files?: string[];
  onApplied?: () => void;
}) {
  const t = useT(text);
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "applying">("idle");
  const [result, setResult] = useState<Compression | null>(null);
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

  const suggest = async () => {
    setPhase("working");
    setError(null);
    setNotice(null);
    try {
      const next = await compress(profile, project, files);
      setResult(next);
      setPicked(new Set(next.files.map((f) => f.path)));
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
    // Ghi tuần tự và dừng ở lỗi đầu tiên: file đã ghi có mã khôi phục riêng, file chưa ghi vẫn còn nguyên.
    try {
      for (const f of result.files.filter((x) => picked.has(x.path))) {
        entry = (await applyEdit(f.path, f.content)).entry;
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

  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
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
        {result && result.files.length === 0 && <p className="text-sm text-muted-foreground">{t.nothing}</p>}

        {result?.files.map((f) => (
          <section key={f.path} className="flex flex-col gap-1.5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={picked.has(f.path)}
                disabled={busy}
                onChange={() => toggle(f.path)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <span className="text-xs text-muted-foreground">{t.saved(f.tokensBefore, f.tokensAfter)}</span>
              </span>
            </label>
            <ProposalDiff proposal={f} />
          </section>
        ))}
        {result?.files.some((f) => f.newLines.length > 0) && (
          <p className="text-xs text-muted-foreground">{t.legend}</p>
        )}
        {result && <p className="text-xs text-muted-foreground">{t.used(result.tokensUsed)}</p>}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={phase === "applying"}>
            {t.close}
          </Button>
          <Button variant="outline" onClick={suggest} disabled={busy}>
            {result || error ? t.again : t.suggest}
          </Button>
          {result && result.files.length > 0 && (
            <Button onClick={apply} disabled={busy || picked.size === 0}>
              {phase === "applying" ? t.applying : t.apply(picked.size)}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
