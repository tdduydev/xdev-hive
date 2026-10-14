import { useQuery } from "@tanstack/react-query";
import { SDLC_PHASE_KINDS, type SdlcItemSummary, type SdlcPhaseKind } from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { cn } from "cn";
import { ChevronDown, ChevronRight, Columns3, List } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { ItemCard, ItemList } from "./item-list.tsx";
import { EmptyState } from "./parts.tsx";

export type BoardView = "board" | "list";

export interface ItemBoardProps {
  /** Lọc dự án lúc mở (đi từ trang dự án). */
  initialProjectId?: string | undefined;
  initialView?: BoardView | undefined;
}

const personKey = (item: SdlcItemSummary) => item.owner.userId;

/**
 * Bảng hạng mục (AppSdlcBoard.dc.html): bảy cột theo loại giai đoạn chuẩn, lọc dự án khớp cả dự án tham gia (hub lọc),
 * lọc chế độ (hub lọc) và người (lọc tại chỗ vì hub không có tham số này).
 */
export function ItemBoard({ initialProjectId, initialView = "board" }: ItemBoardProps) {
  const { api, can, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const ids = useId();
  const [view, setView] = useState<BoardView>(initialView);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [modeRef, setModeRef] = useState("");
  const [person, setPerson] = useState("");
  const [collapsed, setCollapsed] = useState<Partial<Record<SdlcPhaseKind, boolean>>>({});

  const board = useQuery(
    api.sdlc.board.queryOptions({
      input: { ...(projectId ? { projectId } : {}), ...(modeRef ? { modeRef } : {}) },
    }),
  );
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const modes = useQuery(api.sdlc.modes.list.queryOptions({ input: {} }));

  const sdlcProjects = (projects.data ?? []).filter((p) => p.settings.sdlc?.enabled);
  const columns = board.data?.columns ?? [];
  const all = columns.flatMap((c) => c.items);
  // Danh sách người lấy từ hạng mục đã tải, không gọi thêm: bộ lọc này chỉ thu hẹp những gì đang thấy.
  const people = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of all) seen.set(personKey(item), item.owner.name);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const byPerson = (item: SdlcItemSummary) => !person || personKey(item) === person;
  const shown = columns.map((c) => ({ ...c, items: c.items.filter(byPerson) }));
  const shownItems = shown.flatMap((c) => c.items);
  const anyFilter = !!(projectId || modeRef || person);
  const clear = () => {
    setProjectId("");
    setModeRef("");
    setPerson("");
  };
  const readOnly = !can.write();

  const header = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {t.board.title}
          {readOnly && <Pill>{t.readOnly}</Pill>}
        </h1>
        <p className="max-w-prose text-sm text-muted-foreground">{t.board.lead}</p>
      </div>
      <div className="flex items-center gap-2">
        <fieldset className="inline-flex rounded-lg bg-muted p-0.5">
          <legend className="sr-only">{t.board.view}</legend>
          {(
            [
              ["board", t.board.viewBoard, Columns3],
              ["list", t.board.viewList, List],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              onClick={() => setView(key)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm",
                view === key ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
              )}
            >
              <Icon aria-hidden="true" className="size-4" />
              {label}
            </button>
          ))}
        </fieldset>
        {!readOnly &&
          link({
            to: { kind: "new" },
            className:
              "inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80",
            children: t.board.create,
          })}
      </div>
    </header>
  );

  let body: React.ReactNode;
  if (board.isPending) {
    body = (
      <p role="status" className="text-sm text-muted-foreground">
        {t.board.loading}
      </p>
    );
  } else if (board.isError) {
    body = (
      <Alert variant="destructive">
        <AlertTitle>{t.board.errTitle}</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {errorMessage(board.error)}
          <Button variant="outline" size="sm" onClick={() => void board.refetch()}>
            {t.retry}
          </Button>
        </AlertDescription>
      </Alert>
    );
  } else if (!all.length && !anyFilter && projects.isSuccess && !sdlcProjects.length) {
    body = (
      <EmptyState title={t.board.offTitle} text={t.board.offText}>
        <Pill>{t.board.offBadge}</Pill>
      </EmptyState>
    );
  } else if (!all.length && !anyFilter) {
    body = (
      <EmptyState title={t.board.noneTitle} text={t.board.noneText}>
        {!readOnly &&
          link({
            to: { kind: "new" },
            className:
              "inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground",
            children: t.board.noneAction,
          })}
      </EmptyState>
    );
  } else if (!shownItems.length) {
    body = (
      <EmptyState title={t.board.noMatchTitle} text={t.board.noMatchText}>
        <Button variant="outline" size="sm" onClick={clear}>
          {t.board.clear}
        </Button>
      </EmptyState>
    );
  } else if (view === "list") {
    body = <ItemList items={shownItems} match={projectId || undefined} />;
  } else {
    body = (
      // Cột cố định 232 px như thiết kế; cuộn ngang trong vùng riêng để thanh lọc không trôi theo.
      <section aria-label={t.board.boardAria} className="flex gap-3 max-sm:flex-col sm:overflow-x-auto sm:pb-2">
        {SDLC_PHASE_KINDS.map((kind) => {
          const items = shown.find((c) => c.kind === kind)?.items ?? [];
          // Ở 360 px cột rỗng gập sẵn để danh sách dọc không dài vô ích; ở màn rộng mọi cột luôn mở.
          const closed = collapsed[kind] ?? items.length === 0;
          const headingId = `${ids}-${kind}`;
          return (
            <section
              key={kind}
              aria-labelledby={headingId}
              className="flex shrink-0 flex-col gap-2 rounded-xl bg-muted p-2 sm:w-58"
            >
              <h2 id={headingId} className="flex items-center justify-between gap-2 px-1 text-sm font-semibold">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 sm:pointer-events-none"
                  aria-expanded={!closed}
                  onClick={() => setCollapsed({ ...collapsed, [kind]: !closed })}
                >
                  <span className="sm:hidden" aria-hidden="true">
                    {closed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                  </span>
                  {t.phaseKind[kind]}
                </button>
                <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
              </h2>
              <div className={cn("flex flex-col gap-2", closed && "max-sm:hidden")}>
                {items.length ? (
                  items.map((item) => <ItemCard key={item.id} item={item} match={projectId || undefined} />)
                ) : (
                  <p className="px-1 py-3 text-center text-xs text-muted-foreground">{t.board.colEmpty}</p>
                )}
              </div>
            </section>
          );
        })}
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {readOnly && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t.readOnlyNote}</p>}
      <form
        aria-label={t.board.filters}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex w-48 flex-col gap-1 max-sm:w-full">
          <Label htmlFor={`${ids}-project`}>{t.board.fProject}</Label>
          <NativeSelect id={`${ids}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <NativeSelectOption value="">{t.board.allProjects}</NativeSelectOption>
            {sdlcProjects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.key}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="flex w-48 flex-col gap-1 max-sm:w-full">
          <Label htmlFor={`${ids}-mode`}>{t.board.fMode}</Label>
          <NativeSelect id={`${ids}-mode`} value={modeRef} onChange={(e) => setModeRef(e.target.value)}>
            <NativeSelectOption value="">{t.board.allModes}</NativeSelectOption>
            {(modes.data ?? [])
              .filter((m) => m.enabled)
              .map((m) => (
                <NativeSelectOption key={m.ref} value={m.ref}>
                  {m.definition.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </div>
        <div className="flex w-48 flex-col gap-1 max-sm:w-full">
          <Label htmlFor={`${ids}-person`}>{t.board.fPerson}</Label>
          <NativeSelect id={`${ids}-person`} value={person} onChange={(e) => setPerson(e.target.value)}>
            <NativeSelectOption value="">{t.board.allPeople}</NativeSelectOption>
            {people.map(([userId, name]) => (
              <NativeSelectOption key={userId} value={userId}>
                {name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        {anyFilter && (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            {t.board.clear}
          </Button>
        )}
        {board.isSuccess && (
          <span role="status" className="ml-auto text-sm text-muted-foreground">
            {t.board.count(shownItems.length)}
          </span>
        )}
      </form>
      {projectId && <p className="text-xs text-muted-foreground">{t.board.projHint}</p>}
      {body}
    </div>
  );
}
