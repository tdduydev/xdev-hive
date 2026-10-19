import type { DocConflictDetail } from "@xdev-hive/contracts";
import { joinBlocks, splitBlocks } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { useId, useMemo, useState } from "react";
import { type Dict, type Lang, useOptionalDocEditorEnv } from "./env.tsx";

/*
 * Màn xung đột ba bản (FR-020, FR-041): gốc chung, hub, repo. Chỉ hiển thị và thu quyết định; trang chủ gọi
 * `docConflicts.resolve` nên web và desktop dùng chung mà không cần `DocEditorProvider`.
 */

/** Một đoạn của tài liệu, ba cột cùng hàng để người xem thấy chỗ khác nhau mà không phải dò. */
export type ConflictRow = {
  /** `same`: không bên nào đổi; `hub`/`repo`: một bên đổi (hợp được); `both`: hai bên đổi giống nhau; `conflict`: hai bên đổi khác nhau. */
  kind: "same" | "hub" | "repo" | "both" | "conflict";
  base: string[];
  hub: string[];
  repo: string[];
};

function lcsTable(a: string[], b: string[]): Uint32Array[] {
  const t = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = t[i] as Uint32Array;
    const next = t[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j--)
      row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
  }
  return t;
}

/** Cặp chỉ số khối khớp nhau của `base` và `other` theo LCS, giống cách `mergeBlocks` chia đoạn. */
function matchBlocks(base: string[], other: string[]): Map<number, number> {
  const t = lcsTable(base, other);
  const out = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < base.length && j < other.length) {
    if (base[i] === other[j]) out.set(i++, j++);
    else if ((t[i + 1]?.[j] ?? 0) >= (t[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return out;
}

const sameBlocks = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);

/**
 * Chia ba bản thành các hàng theo đúng quy tắc của `mergeBlocks` (`contracts/doc-text.ts`), để số hàng xung đột ở đây
 * khớp `merge.conflicts` hub trả về. Tách riêng vì `mergeBlocks` chỉ trả chữ đã hợp và số xung đột, không nói khối nào.
 */
export function conflictRows(base: string, hub: string, repo: string): ConflictRow[] {
  const o = splitBlocks(base);
  const a = splitBlocks(hub);
  const b = splitBlocks(repo);
  const ma = matchBlocks(o, a);
  const mb = matchBlocks(o, b);
  const rows: ConflictRow[] = [];
  const push = (oc: string[], ac: string[], bc: string[]) => {
    // Hai bên cùng chỉ sửa tại chỗ (không thêm, bớt khối): xét từng khối, để sửa hai khối liền nhau không thành xung đột.
    if (oc.length > 1 && ac.length === oc.length && bc.length === oc.length) {
      for (let k = 0; k < oc.length; k++) push([oc[k] as string], [ac[k] as string], [bc[k] as string]);
      return;
    }
    if (!oc.length && !ac.length && !bc.length) return;
    let kind: ConflictRow["kind"];
    if (sameBlocks(ac, oc) && sameBlocks(bc, oc)) kind = "same";
    else if (sameBlocks(ac, oc)) kind = "repo";
    else if (sameBlocks(bc, oc)) kind = "hub";
    else if (sameBlocks(ac, bc)) kind = "both";
    else kind = "conflict";
    rows.push({ kind, base: oc, hub: ac, repo: bc });
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (let i = 0; i < o.length; i++) {
    const ja = ma.get(i);
    const jb = mb.get(i);
    if (ja === undefined || jb === undefined) continue;
    push(o.slice(io, i), a.slice(ia, ja), b.slice(ib, jb));
    rows.push({ kind: "same", base: [o[i] as string], hub: [a[ja] as string], repo: [b[jb] as string] });
    io = i + 1;
    ia = ja + 1;
    ib = jb + 1;
  }
  push(o.slice(io), a.slice(ia), b.slice(ib));
  return rows;
}

export const CONFLICT_MARK = { hub: "<<<<<<< hub", split: "=======", repo: ">>>>>>> repo" } as const;

/**
 * Bản hợp để sửa tay: chỗ không xung đột đã hợp sẵn, chỗ xung đột giữ cả hai bên giữa các dòng đánh dấu như git, để
 * người sửa thấy đủ hai bản thay vì chỉ bản hub như `mergeBlocks`.
 */
export function markedMerge(rows: readonly ConflictRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.kind === "conflict")
      out.push(CONFLICT_MARK.hub, ...r.hub, CONFLICT_MARK.split, ...r.repo, CONFLICT_MARK.repo);
    else out.push(...(r.kind === "repo" ? r.repo : r.hub));
  }
  return joinBlocks(out);
}

/** Còn dòng đánh dấu của `markedMerge` thì chưa giải quyết xong, lưu vào repo sẽ đẩy cả dấu theo. */
export const hasConflictMarks = (content: string) =>
  content.split(/\r?\n/).some((l) => l === CONFLICT_MARK.hub || l === CONFLICT_MARK.repo);

const text: Dict<{
  title: string;
  base: string;
  hub: string;
  repo: string;
  baseMeta: (v: number) => string;
  hubMeta: (v: number) => string;
  repoMeta: (sha: string) => string;
  summary: (n: number) => string;
  none: string;
  empty: string;
  tag: Record<Exclude<ConflictRow["kind"], "same">, string>;
  unchanged: (n: number) => string;
  show: string;
  hide: string;
  keepHub: string;
  keepRepo: string;
  edit: string;
  manual: string;
  manualHint: string;
  marksLeft: string;
  save: string;
  cancel: string;
  resolved: string;
  columns: string;
}> = {
  vi: {
    title: "Ba bản của tài liệu",
    base: "Bản gốc chung",
    hub: "Bản hub",
    repo: "Bản repo",
    baseMeta: (v) => `Phiên bản ${v}`,
    hubMeta: (v) => `Phiên bản ${v}`,
    repoMeta: (sha) => `Commit ${sha}`,
    summary: (n) => `Hub và repo cùng sửa ${n} chỗ khác nhau. Giữ một bản hoặc sửa tay.`,
    none: "Hai bản không còn chỗ nào đụng nhau, nhưng tài liệu vẫn chờ bạn chọn cách giải quyết.",
    empty: "(không có)",
    tag: { hub: "Đổi ở hub", repo: "Đổi ở repo", both: "Hai bên giống nhau", conflict: "Xung đột" },
    unchanged: (n) => `${n} khối không đổi`,
    show: "Hiện",
    hide: "Ẩn",
    keepHub: "Giữ bản hub",
    keepRepo: "Giữ bản repo",
    edit: "Sửa tay",
    manual: "Bản hợp có đánh dấu",
    manualHint: "Giữ phần đúng và xoá các dòng <<<<<<< hub, =======, >>>>>>> repo trước khi lưu.",
    marksLeft: "Còn dòng đánh dấu xung đột trong văn bản.",
    save: "Lưu bản đã sửa",
    cancel: "Huỷ",
    resolved: "Xung đột này đã được giải quyết.",
    columns: "Các bản của tài liệu",
  },
  en: {
    title: "Three versions of the document",
    base: "Common base",
    hub: "Hub version",
    repo: "Repository version",
    baseMeta: (v) => `Version ${v}`,
    hubMeta: (v) => `Version ${v}`,
    repoMeta: (sha) => `Commit ${sha}`,
    summary: (n) =>
      `The hub and the repository changed ${n} place${n === 1 ? "" : "s"} differently. Keep one or edit by hand.`,
    none: "The two versions no longer overlap, but the document still waits for you to choose how to resolve it.",
    empty: "(none)",
    tag: { hub: "Changed on hub", repo: "Changed in repository", both: "Same on both", conflict: "Conflict" },
    unchanged: (n) => `${n} unchanged block${n === 1 ? "" : "s"}`,
    show: "Show",
    hide: "Hide",
    keepHub: "Keep hub version",
    keepRepo: "Keep repository version",
    edit: "Edit by hand",
    manual: "Merged text with markers",
    manualHint: "Keep the right parts and delete the <<<<<<< hub, =======, >>>>>>> repo lines before saving.",
    marksLeft: "Conflict marker lines are still in the text.",
    save: "Save edited version",
    cancel: "Cancel",
    resolved: "This conflict has been resolved.",
    columns: "Document versions",
  },
};

export type ConflictResolution = { choice: "hub" } | { choice: "repo" } | { choice: "manual"; content: string };

type Col = "base" | "hub" | "repo";
const COLS: Col[] = ["base", "hub", "repo"];

const CELL_TONE: Record<ConflictRow["kind"], Record<Col, string>> = {
  same: { base: "", hub: "", repo: "" },
  hub: { base: "", hub: "bg-warning-soft", repo: "" },
  repo: { base: "", hub: "", repo: "bg-warning-soft" },
  both: { base: "", hub: "bg-muted", repo: "bg-muted" },
  conflict: { base: "bg-muted", hub: "bg-destructive-soft", repo: "bg-destructive-soft" },
};

type Item = { kind: "row"; id: number; row: ConflictRow } | { kind: "run"; id: number; rows: ConflictRow[] };

/** Các hàng không đổi liền nhau gộp thành một dòng thu gọn, để tài liệu dài vẫn thấy ngay chỗ khác nhau. */
function collapseRuns(rows: readonly ConflictRow[]): Item[] {
  const items: Item[] = [];
  for (const [id, row] of rows.entries()) {
    const last = items.at(-1);
    if (row.kind !== "same") items.push({ kind: "row", id, row });
    else if (last?.kind === "run") last.rows.push(row);
    else items.push({ kind: "run", id, rows: [row] });
  }
  return items;
}

function Cell({ row, col, active, lang }: { row: ConflictRow; col: Col; active: Col; lang: Lang }) {
  const blocks = row[col];
  return (
    <div
      data-col={col}
      data-kind={row.kind}
      className={cn(
        "min-w-0 border-b border-border px-3 py-2 md:block",
        col === active ? "block" : "max-md:hidden",
        CELL_TONE[row.kind][col],
      )}
    >
      {row.kind !== "same" && col !== "base" && (
        <div className="mb-1 text-2xs font-medium text-muted-foreground">{text[lang].tag[row.kind]}</div>
      )}
      {blocks.length ? (
        <pre className="font-mono text-xs/5 break-words whitespace-pre-wrap">{blocks.join("\n\n")}</pre>
      ) : (
        <span className="text-xs italic text-muted-foreground">{text[lang].empty}</span>
      )}
    </div>
  );
}

/**
 * Màn giải quyết xung đột tài liệu với repo (FR-020, FR-041): ba cột (gốc chung, hub, repo) trên màn rộng, ba tab trên
 * màn hẹp, tô khối hai bên cùng sửa khác nhau. Chọn "Giữ bản hub", "Giữ bản repo" hoặc "Sửa tay" trên bản hợp có
 * đánh dấu; việc gọi hub do trang chủ làm qua `onResolve`. Ngôn ngữ lấy từ `lang`, không có thì từ `DocEditorProvider`.
 */
export function ConflictView({
  conflict,
  onResolve,
  busy = false,
  error,
  lang,
  className,
}: {
  conflict: Pick<
    DocConflictDetail,
    "baseContent" | "hubContent" | "repoContent" | "baseVersion" | "hubVersion" | "repoCommit" | "state"
  >;
  onResolve: (resolution: ConflictResolution) => void;
  busy?: boolean;
  error?: string | undefined;
  lang?: Lang | undefined;
  className?: string | undefined;
}) {
  const envLang = useOptionalDocEditorEnv()?.lang;
  const l = lang ?? envLang ?? "vi";
  const t = text[l];
  const id = useId();
  const [tab, setTab] = useState<Col>("hub");
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const [manual, setManual] = useState<string | null>(null);
  const rows = useMemo(
    () => conflictRows(conflict.baseContent, conflict.hubContent, conflict.repoContent),
    [conflict.baseContent, conflict.hubContent, conflict.repoContent],
  );
  const items = useMemo(() => collapseRuns(rows), [rows]);
  const conflicts = rows.filter((r) => r.kind === "conflict").length;
  const resolved = conflict.state === "resolved";
  const meta: Record<Col, string> = {
    base: t.baseMeta(conflict.baseVersion),
    hub: t.hubMeta(conflict.hubVersion),
    repo: t.repoMeta((conflict.repoCommit ?? "").slice(0, 7)),
  };
  const toggle = (runId: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(runId)) next.add(runId);
      return next;
    });

  return (
    <section aria-label={t.title} className={cn("flex min-w-0 flex-col gap-3", className)}>
      {conflicts > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="bad" dot>
            {t.summary(conflicts)}
          </Pill>
        </div>
      )}
      {!conflicts && !resolved && <p className="text-sm text-muted-foreground">{t.none}</p>}
      {error && (
        <Alert variant="destructive" aria-live="polite">
          {error}
        </Alert>
      )}
      {resolved && <Alert>{t.resolved}</Alert>}

      <div className="min-w-0 rounded-lg border border-border">
        <div
          role="tablist"
          aria-label={t.columns}
          className="grid grid-cols-3 border-b border-border md:cursor-default"
        >
          {COLS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              id={`${id}-${c}`}
              aria-selected={tab === c}
              onClick={() => setTab(c)}
              className={cn(
                "min-w-0 border-b-2 px-3 py-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:cursor-default md:border-transparent",
                tab === c ? "border-primary" : "border-transparent",
              )}
            >
              <div className="truncate text-sm font-medium">{t[c]}</div>
              <div className="truncate font-mono text-2xs text-muted-foreground">{meta[c]}</div>
            </button>
          ))}
        </div>
        {items.map((item) =>
          item.kind === "row" ? (
            <div key={`r${item.id}`} className="grid md:grid-cols-3">
              {COLS.map((c) => (
                <Cell key={c} row={item.row} col={c} active={tab} lang={l} />
              ))}
            </div>
          ) : (
            <div key={`u${item.id}`} className="border-b border-border">
              <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                <span>{t.unchanged(item.rows.length)}</span>
                <Button variant="ghost" size="xs" aria-expanded={open.has(item.id)} onClick={() => toggle(item.id)}>
                  {open.has(item.id) ? t.hide : t.show}
                </Button>
              </div>
              {open.has(item.id) &&
                item.rows.map((row, k) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: hàng không đổi, thứ tự cố định theo tài liệu.
                  <div key={k} className="grid md:grid-cols-3">
                    {COLS.map((c) => (
                      <Cell key={c} row={row} col={c} active={tab} lang={l} />
                    ))}
                  </div>
                ))}
            </div>
          ),
        )}
      </div>

      {!resolved &&
        (manual === null ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => onResolve({ choice: "hub" })}>
              {t.keepHub}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => onResolve({ choice: "repo" })}>
              {t.keepRepo}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setManual(markedMerge(rows))}>
              {t.edit}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor={`${id}-manual`} className="text-sm font-medium">
              {t.manual}
            </label>
            <p id={`${id}-hint`} className="text-xs text-muted-foreground">
              {t.manualHint}
            </p>
            <Textarea
              id={`${id}-manual`}
              aria-describedby={`${id}-hint`}
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              spellCheck={false}
              className="min-h-64 font-mono text-xs/5"
            />
            {hasConflictMarks(manual) && (
              <p role="status" className="text-xs text-destructive">
                {t.marksLeft}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || hasConflictMarks(manual)}
                onClick={() => onResolve({ choice: "manual", content: manual })}
              >
                {t.save}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setManual(null)}>
                {t.cancel}
              </Button>
            </div>
          </div>
        ))}
    </section>
  );
}
