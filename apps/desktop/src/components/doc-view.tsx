import type { ReactNode } from "react";
import { citations } from "@/lib/agent.ts";
import { type DiffLine, lineDiff } from "@/lib/diff.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Xem tài liệu Markdown trong màn Tài liệu (AppDocs.dc.html, khối `.doc`). Bộ đọc nhỏ cho đúng các khối tài liệu dự án
 * hay dùng (tiêu đề, đoạn, danh sách, code, bảng, trích); dựng phần tử React chứ không chèn HTML, nên nội dung do agent
 * viết không chạy được gì trong cửa sổ app.
 */
export type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "hr" };

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      const close = fence[1] as string;
      for (i++; i < lines.length && !(lines[i] as string).trim().startsWith(close); i++) body.push(lines[i] as string);
      out.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      out.push({ kind: "h", level: (heading[1] as string).length, text: (heading[2] as string).trim() });
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush();
      out.push({ kind: "hr" });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const re = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items = [((bullet ?? numbered) as RegExpExecArray)[1] as string];
      while (i + 1 < lines.length && re.test(lines[i + 1] as string)) {
        items.push((re.exec(lines[++i] as string) as RegExpExecArray)[1] as string);
      }
      out.push({ kind, items });
      continue;
    }
    if (line.trim().startsWith("|")) {
      flush();
      const rows = [cells(line)];
      while (i + 1 < lines.length && (lines[i + 1] as string).trim().startsWith("|"))
        rows.push(cells(lines[++i] as string));
      out.push({ kind: "table", rows: rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c))) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      out.push({ kind: "quote", text: quote[1] as string });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

/** `code`, **đậm**, [chữ](link) (chỉ hiện chữ: link trong cửa sổ app sẽ thay cả app). */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined)
      out.push(
        <code key={n++} className="rounded bg-muted px-1 py-px font-mono text-sm">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined) out.push(<strong key={n++}>{m[2]}</strong>);
    else
      out.push(
        <span key={n++} className="underline underline-offset-2">
          {m[3]}
        </span>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Đoạn ghi "dự kiến"/"planned": phần chưa có code, tô vàng như khối "Chưa có trong code" của thiết kế. */
export const isPlanned = (text: string) => /dự kiến|\bplanned\b/i.test(text);

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "h": {
      const cls =
        block.level === 1
          ? "mb-2 font-heading text-2xl font-semibold tracking-[-0.03em]"
          : block.level === 2
            ? "mt-5.5 mb-1.5 text-[17px] font-semibold"
            : "mt-4 mb-1 text-[15px] font-semibold";
      const H = block.level === 1 ? "h1" : block.level === 2 ? "h2" : "h3";
      return <H className={cls}>{inline(block.text)}</H>;
    }
    case "p":
      return isPlanned(block.text) ? (
        <p className="mb-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">{inline(block.text)}</p>
      ) : (
        <p className="mb-2.5">{inline(block.text)}</p>
      );
    case "ul":
    case "ol": {
      const List = block.kind;
      return (
        <List className={cn("mb-2.5 pl-6", block.kind === "ul" ? "list-disc" : "list-decimal")}>
          {block.items.map((it, i) => (
            // Danh sách tĩnh dựng từ văn bản: thứ tự là danh tính của mục.
            // biome-ignore lint/suspicious/noArrayIndexKey: mục không có id riêng
            <li key={i} className={cn(isPlanned(it) && "text-warning")}>
              {inline(it)}
            </li>
          ))}
        </List>
      );
    }
    case "code":
      return (
        <pre className="mb-2.5 overflow-x-auto rounded-lg bg-muted px-3 py-2 font-mono text-sm leading-normal">
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote className="mb-2.5 border-l-3 pl-3 text-muted-foreground">{inline(block.text)}</blockquote>;
    case "table":
      return (
        <div className="mb-2.5 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {block.rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: hàng của bảng tĩnh
                <tr key={r} className="border-b">
                  {row.map((c, k) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: ô của bảng tĩnh
                    <td key={k} className={cn("px-2 py-1 align-top", r === 0 && "font-semibold")}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr className="my-4" />;
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <>
      {parseBlocks(text).map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: khối dựng lại từ văn bản mỗi lần vẽ
        <BlockView key={i} block={b} />
      ))}
    </>
  );
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
