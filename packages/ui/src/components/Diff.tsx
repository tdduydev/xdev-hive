import { diffLines } from "diff";
import { useMemo } from "react";
import { cn } from "cn";
import { useT } from "../i18n/index.tsx";
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

/** Line diff with unchanged runs collapsed to a few lines of context. */
export function Diff({ before, after }: { before: string; after: string }) {
  const t = useT();
  const lines = useMemo(() => {
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
