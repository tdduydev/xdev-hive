import type { SdlcItemSummary } from "@xdev-hive/contracts";
import { Pill } from "@xdev-hive/ui/pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/table";
import { cn } from "cn";
import { useSdlcEnv, useText } from "./env.tsx";
import { formatUsd, waitingOf } from "./format.ts";

const itemLink = (item: SdlcItemSummary) => ({
  kind: "item" as const,
  projectKey: item.project.key,
  number: item.number,
});

/** Chip dự án: dự án chính tô nổi; dự án khớp bộ lọc có ✓ vì lọc khớp cả dự án chỉ tham gia. */
export function ProjectChips({ item, match }: { item: SdlcItemSummary; match?: string | undefined }) {
  const t = useText();
  return (
    <ul aria-label={t.board.projectsAria} className="flex flex-wrap gap-1">
      {item.projects.map((p) => {
        const home = p.role === "home";
        const hit = match === p.id;
        return (
          <li
            key={p.id}
            title={home ? `${p.key} · ${t.primary}` : p.key}
            className={cn(
              "inline-flex h-5.5 items-center rounded-full border px-2 font-mono text-xs",
              home ? "border-transparent bg-accent font-semibold text-accent-foreground" : "border-border bg-card",
              hit && "ring-2 ring-ring",
            )}
          >
            {hit && "✓ "}
            {p.key}
            {home && <span className="sr-only"> · {t.primary}</span>}
          </li>
        );
      })}
    </ul>
  );
}

const toneClass = {
  neutral: "bg-muted text-muted-foreground",
  ok: "bg-success-soft text-success",
  warn: "bg-warning-soft text-warning",
  bad: "bg-destructive-soft text-destructive",
  sel: "bg-accent text-accent-foreground",
};

/** Thẻ hạng mục của bảng và dạng danh sách ở 360 px. */
export function ItemCard({ item, match }: { item: SdlcItemSummary; match?: string | undefined }) {
  const { link, lang } = useSdlcEnv();
  const t = useText();
  const waiting = waitingOf(item, t.board);
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm shadow-xs">
      <header className="flex flex-col gap-0.5">
        {link({
          to: itemLink(item),
          className: "font-medium hover:underline",
          children: (
            <>
              <span className="font-mono text-muted-foreground">{item.ref}</span> · {item.title}
            </>
          ),
        })}
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {item.modeName}
          <span aria-hidden="true">·</span>
          <span>
            {t.size} <span className="font-mono">{item.size}</span>
          </span>
        </span>
      </header>
      <ProjectChips item={item} match={match} />
      {waiting && (
        <p className={cn("rounded-md px-2 py-1 text-xs font-medium", toneClass[waiting.tone])}>{waiting.text}</p>
      )}
      <dl className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {item.phase && (
          <div>
            <dt className="sr-only">{t.board.stage}</dt>
            <dd>{t.board.phaseOf(item.phase.name, item.phase.index + 1, item.phase.total)}</dd>
          </div>
        )}
        <div>
          <dt className="sr-only">{t.board.coverage}</dt>
          <dd>{t.board.coverageValue(item.coverage?.planned ?? null)}</dd>
        </div>
        <div>
          <dt className="sr-only">{t.board.cost}</dt>
          <dd>{formatUsd(item.costUsd, lang)}</dd>
        </div>
      </dl>
      {item.openQuestions > 0 && (
        <Pill tone="warn" small className="self-start">
          {t.board.openQuestions(item.openQuestions)}
        </Pill>
      )}
    </article>
  );
}

export interface ItemListProps {
  items: SdlcItemSummary[];
  /** Id dự án đang lọc: chip khớp có ✓. */
  match?: string | undefined;
}

/** Dạng danh sách của bảng hạng mục; ở 360 px đổi sang thẻ. */
export function ItemList({ items, match }: ItemListProps) {
  const { lang, link } = useSdlcEnv();
  const t = useText();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.board.item}</TableHead>
              <TableHead>{t.board.stage}</TableHead>
              <TableHead>{t.board.mode}</TableHead>
              <TableHead>{t.size}</TableHead>
              <TableHead>{t.board.projects}</TableHead>
              <TableHead>{t.board.waiting}</TableHead>
              <TableHead className="text-right">{t.board.coverage}</TableHead>
              <TableHead className="text-right">{t.board.cost}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const waiting = waitingOf(item, t.board);
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col">
                      {link({
                        to: itemLink(item),
                        className: "truncate font-medium hover:underline",
                        children: `${item.ref} · ${item.title}`,
                      })}
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.ref}-{item.slug}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {item.phase ? (
                      <Pill>{t.phaseKind[item.phase.kind]}</Pill>
                    ) : (
                      <Pill tone={item.status === "done" ? "ok" : "neutral"}>{t.itemStatus[item.status]}</Pill>
                    )}
                  </TableCell>
                  <TableCell>{item.modeName}</TableCell>
                  <TableCell className="font-mono">{item.size}</TableCell>
                  <TableCell>
                    <ProjectChips item={item} match={match} />
                  </TableCell>
                  <TableCell>{waiting ? <Pill tone={waiting.tone}>{waiting.text}</Pill> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.coverage ? `${item.coverage.planned}%` : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsd(item.costUsd, lang)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col gap-2 sm:hidden">
        {items.map((item) => (
          <li key={item.id}>
            <ItemCard item={item} match={match} />
          </li>
        ))}
      </ul>
    </div>
  );
}
