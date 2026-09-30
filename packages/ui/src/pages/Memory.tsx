import { useState } from "react";
import { cn } from "cn";
import { MEMORY_KINDS, stripHidden, type Memory, type MemoryKind } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote, OwnerBadge, Page, PageHeader, STATUS_TONE } from "../components/common.tsx";
import { HiddenChars } from "../components/HiddenChars.tsx";
import type { HiveClient } from "../client.ts";
import { formatTime, sourceText, useAction, useCan, useHive, useQuery } from "../hooks.ts";
import { useT, type MessageKey } from "../i18n/index.tsx";
import { scopeId, scopeKey, scopeProject, type Scope } from "../lib/scope.ts";

/** Value of the "Chung" option in the owner select (project keys are never empty). */
const SHARED_OPTION = "";

/**
 * memory.list / memory.search input for the scope: all → everything, shared → team-wide only, project → its entries + shared,
 * system → its projects' entries + shared.
 * People see stale entries too (agents' searches skip them), so they can keep or remove them.
 */
function loadMemory(client: HiveClient, scope: Scope, query: string, filter: { pendingOnly: boolean; staleOnly: boolean }) {
  const status = filter.pendingOnly ? ("pending" as const) : undefined;
  const stale = filter.staleOnly || undefined;
  const search = query && !filter.pendingOnly && !filter.staleOnly;
  if (scope.kind === "project") {
    return search
      ? client.call("memory.search", { project: scope.project, query, limit: 50, includeStale: true })
      : client.call("memory.list", { project: scope.project, includeShared: true, status, stale });
  }
  if (scope.kind === "system") {
    return search
      ? client.call("memory.search", { projects: scope.projects, query, limit: 50, includeStale: true })
      : client.call("memory.list", { projects: scope.projects, includeShared: true, status, stale });
  }
  if (scope.kind === "shared") {
    return search ? client.call("memory.search", { query, limit: 50, includeStale: true }) : client.call("memory.list", { project: null, status, stale });
  }
  return search
    ? client.call("memory.search", { anyProject: true, query, limit: 50, includeStale: true })
    : client.call("memory.list", { status, stale });
}

export function MemoryPage() {
  const { client, scope, projects } = useHive();
  const t = useT();
  const allow = useCan();
  const scoped = scopeProject(scope);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [staleOnly, setStaleOnly] = useState(false);

  const list = useQuery(
    () => loadMemory(client, scope, submitted, { pendingOnly, staleOnly }),
    [client, scopeKey(scope), submitted, pendingOnly, staleOnly],
  );
  // A hub from before this has no such method: the line just does not show.
  const search = useQuery(() => client.call("memory.searchInfo", {}), [client, list.data]);

  // In a project, its own entries come first, then the team-wide ones it also sees.
  const rows = list.data ?? [];
  const groups: Array<{ owner: string | null; title: MessageKey | null; items: Memory[] }> =
    scope.kind === "project"
      ? [
          { owner: scope.project, title: "memory.ownGroup", items: rows.filter((m) => m.project !== null) },
          { owner: null, title: "memory.sharedGroup", items: rows.filter((m) => m.project === null) },
        ]
      : [{ owner: null, title: null, items: rows }];

  // New entries default to the scope: its project, Chung for the shared scope, the first project of a system or of all.
  const pool = scope.kind === "system" ? scope.projects : projects;
  const defaultOwner = scope.kind === "project" ? scope.project : scope.kind === "shared" ? null : (pool[0] ?? null);

  return (
    <Page>
      <PageHeader
        title={t("memory.title")}
        subtitle={t("memory.subtitle")}
      />
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex min-w-64 flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <Input
            className="flex-1"
            placeholder={t("memory.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("memory.searchLabel")}
          />
          <Button variant="outline" type="submit">
            {t("memory.search")}
          </Button>
        </form>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={pendingOnly} onCheckedChange={(v) => setPendingOnly(v === true)} />
          {t("memory.pendingOnly")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={staleOnly} onCheckedChange={(v) => setStaleOnly(v === true)} />
          {t("memory.staleOnly")}
        </label>
      </div>
      {search.data?.mode === "hybrid" ? (
        <p className={cn("-mt-3 text-xs", search.data.lastError ? "text-warning" : "text-muted-foreground")}>
          {search.data.lastError
            ? t("memory.searchEmbedError", { error: search.data.lastError })
            : t("memory.searchHybrid", { model: search.data.model ?? "", indexed: search.data.indexed, total: search.data.total })}
        </p>
      ) : null}
      {allow(null, "contribute") || projects.some((p) => allow(p, "contribute")) ? (
        <AddMemory key={scopeId(scope)} defaultOwner={defaultOwner} projects={pool} onAdded={list.reload} />
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{t("memory.none")}</Empty> : null}
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.title ?? "all"} className="flex flex-col gap-3" aria-label={g.title ? t(g.title) : undefined}>
            {g.title ? (
              <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-muted-foreground">
                <OwnerBadge owner={g.owner} />
                <span>{t(g.title)}</span>
                <Badge tone="neutral">{g.items.length}</Badge>
              </h2>
            ) : null}
            {g.items.map((m) => (
              <MemoryRow key={m.id} memory={m} onChanged={list.reload} />
            ))}
          </section>
        ))}
    </Page>
  );
}

function MemoryRow({ memory: m, onChanged }: { memory: Memory; onChanged: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const action = useAction();
  return (
    <article>
      <Card className="py-4">
        <CardContent className="flex flex-col gap-2 px-4">
          <div className="flex flex-wrap items-center gap-2">
            <OwnerBadge owner={m.project} />
            <Badge tone="accent">{t(`memoryKind.${m.kind}`)}</Badge>
            {m.status === "pending" ? <Badge tone={STATUS_TONE.pending}>{t("memory.pending")}</Badge> : null}
            {m.stale ? (
              <span title={t("memory.staleHint")}>
                <Badge tone="warn">{t("memory.stale")}</Badge>
              </span>
            ) : null}
            {m.review ? (
              <span title={t("memory.reviewHint")}>
                <Badge tone="danger">{t("memory.review")}</Badge>
              </span>
            ) : null}
            {m.supersededBy !== null ? (
              <span title={t("memory.replacedHint")}>
                <Badge tone="neutral">{t("memory.replaced")}</Badge>
              </span>
            ) : null}
            {m.conflictsWith.length ? (
              <span title={t("memory.conflictHint")}>
                <Badge tone="danger">{t("memory.conflict")}</Badge>
              </span>
            ) : null}
            {m.taskId ? <span className="font-mono text-xs text-muted-foreground">{m.taskId}</span> : null}
            <span className="min-w-0 flex-1 text-xs text-muted-foreground">
              #{m.id} · {m.author} · {formatTime(m.createdAt)}
              {sourceText(m.source, m.taskId)}
              {" · "}
              {m.useCount ? t("memory.used", { count: m.useCount, time: formatTime(m.lastUsedAt) }) : t("memory.neverUsed")}
            </span>
            {allow(m.project, "manage") ? (
              <>
                {m.status === "pending" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => action.run(async () => (await client.call("memory.approve", { id: m.id }), onChanged()))}
                  >
                    {t("memory.approve")}
                  </Button>
                ) : null}
                {m.stale || m.review ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() => action.run(async () => (await client.call("memory.keep", { id: m.id }), onChanged()))}
                  >
                    {m.review ? t("memory.stillTrue") : t("memory.keep")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  disabled={action.busy}
                  onClick={() => {
                    if (window.confirm(t("memory.confirmRemove"))) {
                      void action.run(async () => (await client.call("memory.remove", { id: m.id }), onChanged()));
                    }
                  }}
                >
                  {t("memory.remove")}
                </Button>
              </>
            ) : null}
          </div>
          <p className={cn("text-sm break-words whitespace-pre-wrap", m.supersededBy !== null && "text-muted-foreground line-through")}>{m.content}</p>
          {m.supersedes !== null || m.supersededBy !== null ? (
            <p className="text-xs text-muted-foreground">
              {[m.supersedes !== null ? t("memory.replaces", { id: m.supersedes }) : null, m.supersededBy !== null ? t("memory.replacedBy", { id: m.supersededBy }) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {m.conflictsWith.map((other) => (
            <div key={other} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-destructive">{t("memory.conflictWith", { id: other })}</span>
              {allow(m.project, "manage") ? (
                <>
                  {(
                    [
                      ["this", t("memory.keepThis")],
                      ["other", t("memory.keepOther", { id: other })],
                      ["both", t("memory.keepBoth")],
                    ] as const
                  ).map(([keep, label]) => (
                    <Button
                      key={keep}
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() => action.run(async () => (await client.call("memory.resolve", { id: m.id, other, keep }), onChanged()))}
                    >
                      {label}
                    </Button>
                  ))}
                </>
              ) : null}
            </div>
          ))}
          {m.files.length ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("memory.files")}:</span>
              {m.files.map((f) => (
                <code
                  key={f.path}
                  className={cn(
                    "rounded bg-muted px-1 py-0.5 font-mono break-all",
                    m.review?.changed.includes(f.path) && "text-warning",
                    m.review?.missing.includes(f.path) && "text-destructive line-through",
                  )}
                >
                  {f.path}
                </code>
              ))}
            </div>
          ) : null}
          {m.review ? (
            <p className="text-xs text-muted-foreground">
              {[
                m.review.changed.length ? t("memory.filesChanged", { files: m.review.changed.join(", ") }) : null,
                m.review.missing.length ? t("memory.filesMissing", { files: m.review.missing.join(", ") }) : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              {` · ${formatTime(m.review.at)}`}
            </p>
          ) : null}
          <ErrorNote error={action.error} />
        </CardContent>
      </Card>
    </article>
  );
}

function AddMemory({ defaultOwner, projects, onAdded }: { defaultOwner: string | null; projects: string[]; onAdded: () => void }) {
  const { client } = useHive();
  const t = useT();
  const allow = useCan();
  const sharedOk = allow(null, "contribute");
  // undefined: not picked yet, so it follows the scope's default (the project list may still be loading).
  const [picked, setPicked] = useState<string | null>();
  const writable = projects.filter((p) => allow(p, "contribute"));
  const fallback = defaultOwner !== null && !allow(defaultOwner, "contribute") ? (sharedOk ? null : (writable[0] ?? null)) : defaultOwner;
  const owner = picked === undefined ? fallback : picked;
  const options = owner !== null && !writable.includes(owner) ? [owner, ...writable] : writable;
  const [kind, setKind] = useState<MemoryKind>("decision");
  const [content, setContent] = useState("");
  const action = useAction();
  return (
    <Card className="py-4">
      <CardContent className="flex flex-col gap-2 px-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const text = content.trim();
              await client.call("memory.write", owner === null ? { shared: true, kind, content: text } : { project: owner, kind, content: text });
              setContent("");
              onAdded();
            });
          }}
        >
          <div className="flex max-w-full min-w-0 items-center gap-2">
            <Label htmlFor="memory-owner" className="shrink-0">
              {t("memory.owner")}
            </Label>
            <NativeSelect
              id="memory-owner"
              value={owner ?? SHARED_OPTION}
              onChange={(e) => setPicked(e.target.value === SHARED_OPTION ? null : e.target.value)}
            >
              {sharedOk ? <NativeSelectOption value={SHARED_OPTION}>{t("memory.sharedOption")}</NativeSelectOption> : null}
              {options.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)} aria-label={t("memory.kind")}>
            {MEMORY_KINDS.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`memoryKind.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            className="min-w-48 flex-1"
            placeholder={owner === null ? t("memory.addShared") : t("memory.addFor", { project: owner })}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            aria-label={t("memory.content")}
          />
          <Button variant="outline" type="submit" disabled={!content.trim() || action.busy}>
            {t("memory.add")}
          </Button>
        </form>
        <HiddenChars fields={[{ label: t("memory.content"), text: content }]} onStrip={() => setContent(stripHidden(content))} />
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}
