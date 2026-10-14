import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type SdlcItemDetail,
  type SdlcModeView,
  type SdlcSize,
  type SdlcSuggestion,
  sdlcSize,
  sdlcSlug,
} from "@xdev-hive/contracts";
import { Alert, AlertDescription, AlertTitle } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Input } from "@xdev-hive/ui/input";
import { Label } from "@xdev-hive/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { cn } from "cn";
import { useEffect, useId, useState } from "react";
import { useSdlcEnv, useText } from "./env.tsx";
import { EmptyState } from "./parts.tsx";
import { ProjectPicker, type ProjectPickerValue } from "./project-picker.tsx";

const IDEA_MIN = 20;
const TITLE_MIN = 3;
/** Gợi ý chạy bằng luật tất định ở hub (< 3 giây); chờ người ngừng gõ để không gọi mỗi phím. */
const SUGGEST_DELAY_MS = 600;

function useDebounced<T>(value: T, ms: number): T {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
}

/** Chế độ dự án cho dùng (`settings.sdlc.modes`); rỗng là chỉ chế độ mặc định. */
export function allowedModes(settings: { defaultMode: string | null; modes: string[] } | undefined): string[] {
  if (!settings) return [];
  if (settings.modes.length) return settings.modes;
  return settings.defaultMode ? [settings.defaultMode] : [];
}

/** Thư mục repo của tài liệu đầu tiên; số hạng mục chỉ hub biết lúc tạo nên giữ `NNN`. */
function previewDir(mode: SdlcModeView | undefined, slug: string): string | null {
  const path = mode?.definition.phases.flatMap((p) => p.artifacts)[0]?.path;
  if (!path) return null;
  const filled = path
    .replaceAll("{NNN}", "NNN")
    .replaceAll("{slug}", slug)
    .replaceAll("{date}", new Date().toISOString().slice(0, 10));
  return filled.slice(0, filled.lastIndexOf("/") + 1);
}

export interface NewItemProps {
  /** Dự án chính chọn sẵn (đi từ trang dự án). */
  initialProjectId?: string | undefined;
  /** Gọi sau khi hub tạo xong; bỏ trống thì màn hiện thông báo "Đã tạo" và liên kết. */
  onCreated?: ((item: SdlcItemDetail) => void) | undefined;
}

/**
 * Tạo hạng mục (AppSdlcNewItem.dc.html): từ ý tưởng hoặc link issue, chọn dự án chính và dự án tham gia, nhận gợi ý cỡ
 * và chế độ (FR-007), xác nhận. Hub tạo trọn hoặc không tạo gì khi một dự án lỗi quyền, nên lỗi chỉ cần hiện lại.
 */
export function NewItem({ initialProjectId, onCreated }: NewItemProps) {
  const { api, can, link, errorMessage } = useSdlcEnv();
  const t = useText();
  const n = t.newItem;
  const ids = useId();
  const queryClient = useQueryClient();

  const [source, setSource] = useState<"idea" | "issue">("idea");
  const [title, setTitle] = useState("");
  const [idea, setIdea] = useState("");
  const [issueUrl, setIssueUrl] = useState("");
  const [picked, setPicked] = useState<ProjectPickerValue>({ primary: initialProjectId ?? "", participants: [] });
  const [size, setSize] = useState<SdlcSize | null>(null);
  const [modeRef, setModeRef] = useState<string | null>(null);
  const [created, setCreated] = useState<SdlcItemDetail | null>(null);

  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const teams = useQuery(api.teams.list.queryOptions());
  const writable = (projects.data ?? []).filter((p) => can.write(p.teamId));
  const primary = writable.find((p) => p.id === picked.primary);
  const modes = useQuery({
    ...api.sdlc.modes.list.queryOptions({ input: { teamId: primary?.teamId ?? "" } }),
    enabled: !!primary,
  });

  const issue = source === "issue" ? issueUrl.trim() : "";
  const suggestInput = useDebounced(
    { projectId: picked.primary, title: title.trim(), idea: idea.trim(), ...(issue ? { issueUrl: issue } : {}) },
    SUGGEST_DELAY_MS,
  );
  const canSuggest =
    !!suggestInput.projectId && suggestInput.title.length >= TITLE_MIN && suggestInput.idea.length >= IDEA_MIN;
  const suggestion = useQuery({
    ...api.sdlc.suggest.queryOptions({ input: suggestInput }),
    enabled: canSuggest,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const sug: SdlcSuggestion | undefined = canSuggest ? suggestion.data : undefined;

  const allowed = allowedModes(primary?.settings.sdlc);
  const modeList = (modes.data ?? []).filter((m) => m.enabled);
  const chosenSize = size ?? sug?.size ?? null;
  const chosenMode = modeRef ?? (sug && allowed.includes(sug.modeRef) ? sug.modeRef : (allowed[0] ?? null));
  const mode = modeList.find((m) => m.ref === chosenMode);
  const modeAllowed = !!chosenMode && allowed.includes(chosenMode);
  const slug = sdlcSlug(title);
  const dir = previewDir(mode, slug);

  const create = useMutation(
    api.sdlc.items.create.mutationOptions({
      onSuccess: (item) => {
        void queryClient.invalidateQueries({ queryKey: api.sdlc.key() });
        if (onCreated) onCreated(item);
        else setCreated(item);
      },
    }),
  );

  const readOnly = !can.write();
  const ready =
    !!primary &&
    title.trim().length >= TITLE_MIN &&
    idea.trim().length >= IDEA_MIN &&
    !!chosenSize &&
    modeAllowed &&
    (source === "idea" || !!issue);

  const submit = () => {
    if (!ready || !chosenSize || !chosenMode) return;
    create.mutate({
      projectId: picked.primary,
      participants: picked.participants,
      title: title.trim(),
      idea: idea.trim(),
      ...(issue ? { issueUrl: issue } : {}),
      modeRef: chosenMode,
      size: chosenSize,
      ...(sug ? { suggestion: sug } : {}),
    });
  };

  const reset = () => {
    setCreated(null);
    setTitle("");
    setIdea("");
    setIssueUrl("");
    setSize(null);
    setModeRef(null);
    setPicked({ primary: picked.primary, participants: [] });
    create.reset();
  };

  const heading = (
    <header className="flex flex-col gap-1">
      <nav aria-label={n.crumbAria} className="text-sm text-muted-foreground">
        {link({ to: { kind: "board" }, className: "hover:underline", children: t.board.title })} /
      </nav>
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        {n.title}
        {readOnly && <Pill>{t.readOnly}</Pill>}
      </h1>
      <p className="max-w-prose text-sm text-muted-foreground">{n.lead}</p>
    </header>
  );

  if (created) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        {heading}
        <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-live="polite">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {n.doneTitle} <Pill tone="ok">{`${created.project.key} · ${created.ref}`}</Pill>
          </h2>
          <p className="text-sm text-muted-foreground">{n.doneText}</p>
          {created.source.kind === "issue" && <p className="text-sm text-muted-foreground">{n.doneIssue}</p>}
          <div className="flex flex-wrap gap-2">
            {link({
              to: { kind: "item", projectKey: created.project.key, number: created.number },
              className:
                "inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground",
              children: n.openItem,
            })}
            {link({
              to: { kind: "board" },
              className: "inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium",
              children: n.backBoard,
            })}
            <Button variant="ghost" onClick={reset}>
              {n.another}
            </Button>
          </div>
        </section>
      </div>
    );
  }

  if (projects.isPending) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        {heading}
        <p role="status" className="text-sm text-muted-foreground">
          {n.loading}
        </p>
      </div>
    );
  }
  if (projects.isError) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        {heading}
        <Alert variant="destructive">
          <AlertTitle>{n.errTitle}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {errorMessage(projects.error)}
            <Button variant="outline" size="sm" onClick={() => void projects.refetch()}>
              {t.retry}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  if (!writable.some((p) => p.settings.sdlc?.enabled)) {
    return (
      <div className="flex max-w-2xl flex-col gap-4">
        {heading}
        {readOnly && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t.readOnlyNote}</p>}
        <EmptyState title={n.emptyTitle} text={n.emptyText} />
      </div>
    );
  }

  const teamName = (teamId: string) => teams.data?.find((team) => team.id === teamId)?.name;
  const section = "flex flex-col gap-3 rounded-xl border border-border bg-card p-4";

  return (
    <form
      className="flex max-w-3xl flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {heading}
      <fieldset disabled={readOnly || create.isPending} className="flex flex-col gap-4">
        <section className={section} aria-labelledby={`${ids}-src`}>
          <h2 id={`${ids}-src`} className="text-base font-semibold">
            {n.sourceTitle}
          </h2>
          <fieldset className="inline-flex self-start rounded-lg bg-muted p-0.5">
            <legend className="sr-only">{n.sourceTitle}</legend>
            {(
              [
                ["idea", n.ideaTab],
                ["issue", n.issueTab],
              ] as const
            ).map(([key, label]) => (
              <label
                key={key}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center rounded-md px-3 text-sm has-focus-visible:ring-2 has-focus-visible:ring-ring",
                  source === key ? "bg-card font-semibold shadow-sm" : "text-muted-foreground",
                )}
              >
                <input
                  type="radio"
                  name={`${ids}-source`}
                  className="sr-only"
                  checked={source === key}
                  onChange={() => setSource(key)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {source === "issue" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-issue`}>{n.issueLabel}</Label>
              <Input
                id={`${ids}-issue`}
                type="url"
                inputMode="url"
                placeholder="https://github.com/acme/payment-api/issues/231"
                value={issueUrl}
                onChange={(e) => setIssueUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{n.issueHint}</p>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-title`}>{n.titleLabel}</Label>
            <Input id={`${ids}-title`} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
            <p className="text-xs text-muted-foreground">{n.titleHint}</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${ids}-idea`}>{n.ideaLabel}</Label>
            <Textarea
              id={`${ids}-idea`}
              rows={6}
              value={idea}
              maxLength={20_000}
              onChange={(e) => setIdea(e.target.value)}
              aria-describedby={`${ids}-idea-hint`}
            />
            <p id={`${ids}-idea-hint`} className="text-xs text-muted-foreground">
              {n.ideaHint(IDEA_MIN)}
            </p>
          </div>
        </section>

        <section className={section} aria-labelledby={`${ids}-proj`}>
          <h2 id={`${ids}-proj`} className="flex flex-wrap items-baseline gap-2 text-base font-semibold">
            {n.projTitle} <span className="text-xs font-normal text-muted-foreground">{n.projMeta}</span>
          </h2>
          <ProjectPicker
            projects={writable}
            value={picked}
            onChange={(next) => {
              if (next.primary !== picked.primary) setModeRef(null);
              setPicked(next);
            }}
            teamName={teamName}
          />
        </section>

        <section className={section} aria-labelledby={`${ids}-sug`}>
          <h2 id={`${ids}-sug`} className="flex flex-wrap items-baseline gap-2 text-base font-semibold">
            {n.sugTitle} <span className="text-xs font-normal text-muted-foreground">{n.sugMeta}</span>
          </h2>
          <p role="status" className="text-sm text-muted-foreground">
            {!canSuggest
              ? n.sugIdle(IDEA_MIN)
              : suggestion.isFetching
                ? n.sugBusy
                : suggestion.isError
                  ? errorMessage(suggestion.error)
                  : sug
                    ? sug.reason
                    : ""}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-size`}>{n.sizeLabel}</Label>
              <NativeSelect
                id={`${ids}-size`}
                value={chosenSize ?? ""}
                onChange={(e) => setSize((e.target.value || null) as SdlcSize | null)}
              >
                <NativeSelectOption value="">—</NativeSelectOption>
                {sdlcSize.options.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {sug?.size === s ? `${s} (${n.suggested})` : s}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${ids}-mode`}>{n.modeLabel}</Label>
              <NativeSelect
                id={`${ids}-mode`}
                value={chosenMode ?? ""}
                disabled={!primary}
                aria-invalid={!!chosenMode && !modeAllowed}
                onChange={(e) => setModeRef(e.target.value || null)}
              >
                <NativeSelectOption value="">—</NativeSelectOption>
                {modeList.map((m) => {
                  const ok = allowed.includes(m.ref);
                  const tag = !ok ? ` (${n.notAllowed})` : sug?.modeRef === m.ref ? ` (${n.suggested})` : "";
                  return (
                    <NativeSelectOption key={m.ref} value={m.ref} disabled={!ok}>
                      {m.definition.name + tag}
                    </NativeSelectOption>
                  );
                })}
              </NativeSelect>
              {chosenMode && !modeAllowed && modes.isSuccess && <p className="text-xs text-destructive">{n.badMode}</p>}
              <p className="text-xs text-muted-foreground">{n.modeHint}</p>
            </div>
          </div>
        </section>

        <section className={section} aria-labelledby={`${ids}-pv`}>
          <h2 id={`${ids}-pv`} className="flex flex-wrap items-baseline gap-2 text-base font-semibold">
            {n.pvTitle} <span className="text-xs font-normal text-muted-foreground">{n.pvMeta}</span>
          </h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{n.pvSlug}</dt>
            <dd className="font-mono">{title.trim() ? slug : "—"}</dd>
            <dt className="text-muted-foreground">{n.pvDir}</dt>
            <dd className="font-mono break-all">{dir ?? "—"}</dd>
            <dt className="text-muted-foreground">{n.pvStage}</dt>
            <dd>{mode?.definition.phases[0]?.name ?? "—"}</dd>
            <dt className="text-muted-foreground">{n.pvProjects}</dt>
            <dd className="font-mono">
              {primary
                ? [primary.key, ...picked.participants.map((id) => writable.find((p) => p.id === id)?.key ?? id)].join(
                    ", ",
                  )
                : "—"}
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">{n.confAtomic}</p>
          {source === "issue" && <p className="text-xs text-muted-foreground">{n.confIssue}</p>}
        </section>
      </fieldset>

      {readOnly && <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t.readOnlyNote}</p>}
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>{n.sendError}</AlertTitle>
          <AlertDescription>{errorMessage(create.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={readOnly || !ready || create.isPending}>
          {create.isPending ? n.sending : n.submit}
        </Button>
        {link({
          to: { kind: "board" },
          className: "inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium hover:bg-muted",
          children: n.cancel,
        })}
      </div>
    </form>
  );
}
