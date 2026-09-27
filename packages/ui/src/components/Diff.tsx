import { diffLines } from "diff";
import { useMemo } from "react";

interface Line {
  kind: "add" | "del" | "same" | "gap";
  text: string;
}

const CONTEXT = 3;

/** Line diff with unchanged runs collapsed to a few lines of context. */
export function Diff({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => {
    const raw: Line[] = [];
    for (const part of diffLines(before, after)) {
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
        out.push(...run.slice(0, head), { kind: "gap", text: `… ${run.length - head - tail} dòng không đổi` }, ...run.slice(run.length - tail));
      } else {
        out.push(...run);
      }
      i = j;
    }
    return out;
  }, [before, after]);

  const changed = lines.some((l) => l.kind === "add" || l.kind === "del");
  if (!changed) return <div className="empty">Không có khác biệt.</div>;

  return (
    <pre className="diff" aria-label="Khác biệt">
      {lines.map((l, i) => (
        <div key={i} className={`diff-${l.kind}`}>
          <span className="diff-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          {l.text || " "}
        </div>
      ))}
    </pre>
  );
}
