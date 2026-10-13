import { Markdown as MarkdownView } from "@xdev-hive/ui/markdown";
import { citations } from "@/lib/agent.ts";
import { type DiffLine, lineDiff } from "@/lib/diff.ts";

/**
 * Xem tài liệu Markdown trong màn Tài liệu (AppDocs.dc.html, khối `.doc`) bằng bộ đọc chung của packages/ui: dựng phần
 * tử React chứ không chèn HTML, nên nội dung do agent viết không chạy được gì trong cửa sổ app.
 */

/** Đoạn ghi "dự kiến"/"planned": phần chưa có code, tô vàng như khối "Chưa có trong code" của thiết kế. */
export const isPlanned = (text: string) => /dự kiến|\bplanned\b/i.test(text);

export function Markdown({ text }: { text: string }) {
  // Link chỉ hiện chữ: bấm link trong cửa sổ app sẽ thay cả app.
  return <MarkdownView content={text} links="text" isPlanned={isPlanned} />;
}

export interface Segment {
  kind: DiffLine["kind"];
  text: string;
  /** Vị trí dòng đầu của đoạn trong bản so: khoá ổn định khi vẽ. */
  at: number;
}

/** Gộp các dòng liền nhau cùng loại (giữ, thêm, bỏ) thành đoạn để vẽ thành khối. */
export function segments(base: string, proposal: string): Segment[] {
  const out: Segment[] = [];
  lineDiff(base, proposal).forEach((line, at) => {
    const last = out.at(-1);
    if (last?.kind === line.kind) last.text += `\n${line.text}`;
    else out.push({ kind: line.kind, text: line.text, at });
  });
  // Dòng trống thêm hay bớt một mình chỉ là khoảng cách giữa đoạn: coi như giữ nguyên.
  return out.map((s) => (s.kind !== "same" && !s.text.trim() ? { ...s, kind: "same" } : s));
}

/** Đề xuất của agent so với bản nháp: phần thêm tô xanh kèm chỗ trong code được dẫn, phần bỏ gạch đỏ. */
export function SuggestionView({
  base,
  proposal,
  labels,
}: {
  base: string;
  proposal: string;
  labels: { added: string; removed: string };
}) {
  return (
    <>
      {segments(base, proposal).map((s) =>
        s.kind === "same" ? (
          <Markdown key={s.at} text={s.text} />
        ) : s.kind === "add" ? (
          <div
            key={s.at}
            data-testid="ins"
            className="mb-2.5 rounded-r-md border-l-3 border-success bg-success-soft px-2.5 py-1.5"
          >
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="inline-flex h-5 items-center rounded-full bg-card px-1.75 text-xs font-medium text-success">
                {labels.added}
              </span>
              {citations(s.text).map((c) => (
                <span
                  key={c}
                  className="inline-flex h-5 items-center rounded-[5px] bg-secondary px-1.5 font-mono text-xs text-secondary-foreground"
                >
                  {c}
                </span>
              ))}
            </div>
            <Markdown text={s.text} />
          </div>
        ) : (
          <div
            key={s.at}
            data-testid="del"
            className="mb-2.5 flex items-start gap-2 rounded-r-md border-l-3 border-destructive bg-destructive-soft px-2.5 py-1"
          >
            <span className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full bg-card px-1.75 text-xs font-medium text-destructive">
              {labels.removed}
            </span>
            <div className="min-w-0 text-sm whitespace-pre-wrap text-muted-foreground line-through">{s.text}</div>
          </div>
        ),
      )}
    </>
  );
}
