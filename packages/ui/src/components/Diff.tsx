import { diffLines } from "diff";
import { useMemo } from "react";
import { cn } from "cn";
import { useT } from "#ui/i18n/index.tsx";
import { Empty } from "./common.tsx";

interface Line {
  kind: "add" | "del" | "same" | "gap";
  text: string;
}

const CONTEXT = 3;

const LINE_CLASS: Record<Line["kind"], string> = {
  add: "bg-success/10",
  del: "bg-destructive/10",
  same: "text-muted-foreground",
  gap: "italic text-muted-foreground",
};

const SIGN_CLASS: Record<Line["kind"], string> = {
  add: "text-success",
  del: "text-destructive",
  same: "text-muted-foreground",
  gap: "text-muted-foreground",
};

function useDiffLines(before: string, after: string): Line[] {
  const t = useT();
  return useMemo(() => {
    const raw: Line[] = [];
    // The last line with or without a newline is the same line.
    const nl = (s: string) => (s && !s.endsWith("\n") ? `${s}\n` : s);
    for (const part of diffLines(nl(before), nl(after))) {
      const kind = part.added ? "add" : part.removed ? "del" : "same";
      const texts = part.value.replace(/\n$/, "").split("\n");
      for (const text of texts) raw.push({ kind, text });
    }
    const out: Line[] = [];
    for (let i = 0; i < raw.length; ) {
      if (raw[i]!.kind !== "same") {
        out.push(raw[i++]!);
        continue;
      }
      let j = i;
      while (j < raw.length && raw[j]!.kind === "same") j++;
      const run = raw.slice(i, j);
      const head = i === 0 ? 0 : CONTEXT;
      const tail = j === raw.length ? 0 : CONTEXT;
      if (run.length > head + tail + 1) {
        out.push(...run.slice(0, head), { kind: "gap", text: t("diff.gap", { count: run.length - head - tail }) }, ...run.slice(run.length - tail));
      } else {
        out.push(...run);
      }
      i = j;
    }
    return out;
  }, [before, after, t]);
}

/** Line diff with unchanged runs collapsed to a few lines of context. */
export function Diff({ before, after }: { before: string; after: string }) {
  const t = useT();
  const lines = useDiffLines(before, after);
  const changed = lines.some((l) => l.kind === "add" || l.kind === "del");
  if (!changed) return <Empty>{t("diff.none")}</Empty>;

  return (
    <pre
      className="m-0 max-h-[520px] min-w-0 overflow-x-auto overflow-y-auto rounded-md border bg-muted/30 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
      aria-label={t("diff.label")}
    >
      {lines.map((l, i) => (
        <div key={i} className={cn("pr-3 pl-1", LINE_CLASS[l.kind])}>
          <span className={cn("inline-block w-[18px] select-none", SIGN_CLASS[l.kind])}>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}

const PANEL_LINE: Record<Line["kind"], string> = {
  add: "bg-(--diff-add-bg) text-(--diff-add-fg)",
  del: "bg-(--diff-del-bg) text-(--diff-del-fg)",
  same: "text-(--diff-ctx-fg)",
  gap: "text-(--diff-ctx-fg) italic",
};

/** The design's diff block (Hôm nay): a file bar with +/- counts over mono lines, 24px mark column. */
export function DiffPanel({ before, after, file }: { before: string; after: string; file: string }) {
  const t = useT();
  const lines = useDiffLines(before, after);
  const add = lines.filter((l) => l.kind === "add").length;
  const del = lines.filter((l) => l.kind === "del").length;
  if (!add && !del) return <Empty>{t("diff.none")}</Empty>;
  return (
    <div className="min-w-0 overflow-hidden rounded-[16px] bg-(--surface-sunken) shadow-[var(--ring-glass)]" aria-label={t("diff.label")} role="group">
      <div className="flex h-9 items-center gap-2 px-3.5 font-mono text-[12px]/none font-medium text-fg-muted shadow-[inset_0_-1px_0_var(--today-rule)]">
        <span className="min-w-0 flex-1 truncate">{file}</span>
        <span className="text-(--accent-green)">+{add}</span>
        <span className="text-(--accent-red)">−{del}</span>
      </div>
      <div className="max-h-[520px] overflow-y-auto py-2 font-mono text-[12.5px]/[21px] font-medium">
        {lines.map((l, i) => (
          <div key={i} className={cn("grid grid-cols-[24px_minmax(0,1fr)] px-3.5", PANEL_LINE[l.kind])}>
            <span className="opacity-60">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}</span>
            <span className="[overflow-wrap:anywhere] whitespace-pre-wrap">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
