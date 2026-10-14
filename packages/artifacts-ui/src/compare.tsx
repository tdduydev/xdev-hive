import { useQuery } from "@tanstack/react-query";
import { type DiffBlock, type DiffLine, diffBlocks, lineDiff } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { cn } from "cn";
import { useMemo, useState } from "react";
import { useArtifactsEnv } from "./env.tsx";
import { useEditText } from "./text-edit.ts";

export type CompareMode = "diff" | "side";

const SIGN = { same: " ", added: "+", removed: "−" } as const;
const TONE = {
  same: "",
  added: "bg-success-soft text-success",
  removed: "bg-destructive-soft text-destructive",
} as const;

const LINE = "flex min-w-0 gap-2 px-2 font-mono text-xs leading-5";

function Gap({ count }: { count: number }) {
  const t = useEditText();
  return <div className="bg-muted px-2 py-0.5 text-center text-xs text-muted-foreground">{t.gap(count)}</div>;
}

function Unified({ blocks }: { blocks: DiffBlock[] }) {
  return (
    <div className="overflow-x-auto rounded-md border">
      {blocks.map((block, i) =>
        block.kind === "gap" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: danh sách tính một lần từ hai bản, không đổi chỗ.
          <Gap key={i} count={block.count} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
          <div key={i}>
            {block.lines.map((line, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: như trên.
              <div key={j} className={cn(LINE, TONE[line.kind])}>
                <span aria-hidden className="w-4 shrink-0 text-center select-none">
                  {SIGN[line.kind]}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

interface Row {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Ghép dãy dòng xoá với dãy dòng thêm liền kề thành các hàng hai cột; dòng không đổi nằm cả hai bên. */
function sideRows(lines: readonly DiffLine[]): Row[] {
  const rows: Row[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    const n = Math.max(removed.length, added.length);
    for (let i = 0; i < n; i++) rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "removed") removed.push(line);
    else if (line.kind === "added") added.push(line);
    else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

function Cell({ line }: { line: DiffLine | null }) {
  if (!line) return <div className="bg-muted/40" />;
  return (
    <div className={cn(LINE, "min-h-5", TONE[line.kind])}>
      <span aria-hidden className="w-4 shrink-0 text-center select-none">
        {SIGN[line.kind]}
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words">{line.text}</span>
    </div>
  );
}

function SideBySide({ lines, leftLabel, rightLabel }: { lines: DiffLine[]; leftLabel: string; rightLabel: string }) {
  const rows = useMemo(() => sideRows(lines), [lines]);
  return (
    <div className="grid grid-cols-2 overflow-x-auto rounded-md border">
      <div className="border-b bg-muted px-2 py-1 text-xs font-semibold">{leftLabel}</div>
      <div className="border-b border-l bg-muted px-2 py-1 text-xs font-semibold">{rightLabel}</div>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: hàng tính một lần từ hai bản, không đổi chỗ.
        <div key={i} className="col-span-2 grid grid-cols-2">
          <Cell line={row.left} />
          <div className="border-l">
            <Cell line={row.right} />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface DiffViewProps {
  before: string;
  after: string;
  beforeLabel: string;
  afterLabel: string;
  mode: CompareMode;
}

/** Diff dòng giữa hai nội dung; dùng chung cho so sánh phiên bản và gộp khi xung đột lúc sửa. */
export function DiffView({ before, after, beforeLabel, afterLabel, mode }: DiffViewProps) {
  const t = useEditText();
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const blocks = useMemo(() => diffBlocks(lines), [lines]);
  if (!lines.some((line) => line.kind !== "same")) return <p className="text-sm text-muted-foreground">{t.noChange}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {mode === "diff" ? (
        <>
          <h4 className="text-sm font-semibold">
            {beforeLabel} → {afterLabel}
          </h4>
          <Unified blocks={blocks} />
          <p className="text-xs text-muted-foreground">{t.legend}</p>
        </>
      ) : (
        <SideBySide lines={lines} leftLabel={beforeLabel} rightLabel={afterLabel} />
      )}
    </div>
  );
}

export function CompareModeSwitch({ mode, onChange }: { mode: CompareMode; onChange: (mode: CompareMode) => void }) {
  const t = useEditText();
  return (
    <nav aria-label={t.compareMode} className="flex gap-2">
      <Button variant="outline" size="sm" aria-pressed={mode === "diff"} onClick={() => onChange("diff")}>
        {t.compareDiff}
      </Button>
      <Button variant="outline" size="sm" aria-pressed={mode === "side"} onClick={() => onChange("side")}>
        {t.compareSide}
      </Button>
    </nav>
  );
}

export interface VersionCompareProps {
  artifactId: string;
  left: number;
  right: number;
}

/** So sánh hai phiên bản đã lưu: diff dòng, xem gộp hoặc cạnh nhau (ArtifactVersions.dc.html). */
export function VersionCompare({ artifactId, left, right }: VersionCompareProps) {
  const env = useArtifactsEnv();
  const t = useEditText();
  const [mode, setMode] = useState<CompareMode>("diff");
  const enabled = !env.offline && left !== right;
  const before = useQuery({
    ...env.api.artifacts.get.queryOptions({ input: { id: artifactId, version: left } }),
    enabled,
  });
  const after = useQuery({
    ...env.api.artifacts.get.queryOptions({ input: { id: artifactId, version: right } }),
    enabled,
  });

  if (left === right)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {t.compareSame}
      </p>
    );
  if (env.offline)
    return (
      <p role="status" className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
        {t.offline}
      </p>
    );
  const failed = before.error ?? after.error;
  if (failed)
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 rounded-md bg-destructive-soft p-3 text-sm text-destructive"
      >
        <p>{env.errorMessage(failed)}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void before.refetch();
            void after.refetch();
          }}
        >
          {t.retry}
        </Button>
      </div>
    );
  if (!before.data || !after.data)
    return (
      <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
        …
      </p>
    );
  const a = before.data.version.content;
  const b = after.data.version.content;
  if (a === null || b === null)
    return (
      <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
        {t.tombstoned}
      </p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <CompareModeSwitch mode={mode} onChange={setMode} />
      <DiffView before={a} after={b} beforeLabel={`v${left}`} afterLabel={`v${right}`} mode={mode} />
    </div>
  );
}
