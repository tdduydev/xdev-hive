// Every repo of a system on this machine, with where it stands against its remote and a Pull that only fast-forwards
// (GROUP-repos-forge). The app decides what is safe to pull, again right before pulling; the page only shows it.
import { useState } from "react";
import { ExternalLink, GitBranch } from "lucide-react";
import { memberFolder, type HiveSystem, type RepoPullResult, type RepoStatusRow } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { Chip } from "#ui/components/panes.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT, type MessageKey } from "#ui/i18n/index.tsx";
import { accessTone, mergeRows, pullable, pullCounts, remoteState, shortPath } from "#ui/lib/repo-status.ts";

function RemoteState({ row }: { row: RepoStatusRow }) {
  const t = useT();
  const s = remoteState(row);
  if (s.key === "detached") return <Chip kind="warning">{t("repos.detached")}</Chip>;
  if (s.key === "noUpstream") return <Chip kind="neutral">{t("repos.noUpstream")}</Chip>;
  if (s.key === "upToDate") return <Chip kind="success">{t("repos.upToDate")}</Chip>;
  return (
    <>
      {s.ahead ? <Chip kind="info">{t("repos.ahead", { count: s.ahead })}</Chip> : null}
      {s.behind ? <Chip kind="warning">{t("repos.behind", { count: s.behind })}</Chip> : null}
    </>
  );
}

function Row({ row, system, result, busy, onPull }: { row: RepoStatusRow; system: HiveSystem; result: RepoPullResult | undefined; busy: boolean; onPull: () => void }) {
  const t = useT();
  const folder = memberFolder(system.source, row.project);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5" data-repo-row={row.project} data-repo-block={row.block ?? ""}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-sm">
          {folder.length ? <span className="text-muted-foreground">{folder.join(" › ")} › </span> : null}
          <span className="font-medium">{row.project}</span>
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={row.repo}>{shortPath(row.repo)}</span>
        <span className="ml-auto flex items-center gap-2">
          {!row.block && row.behind > 0 ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onPull} data-repo-pull={row.project}>{t("repos.pull")}</Button>
          ) : row.block && row.exists ? (
            <span className="text-xs text-muted-foreground" data-repo-reason={row.block}>
              {t(`repos.block.${row.block}` as MessageKey)}{row.busy ? ` (${t(`repos.busy.${row.busy}` as MessageKey)})` : ""}
            </span>
          ) : null}
        </span>
      </div>
      {row.exists ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1 font-mono" data-repo-branch>
            <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
            {row.branch ?? "HEAD"}
            {row.upstream ? <span className="text-muted-foreground">→ {row.upstream}</span> : null}
          </span>
          <RemoteState row={row} />
          {row.conflicts ? <Chip kind="danger">{t("repos.conflicts", { count: row.conflicts })}</Chip> : row.changes ? <Chip kind="warning">{t("repos.changed", { count: row.changes })}</Chip> : <Chip kind="neutral">{t("repos.clean")}</Chip>}
          <span title={row.accessDetail ?? undefined}><Chip kind={accessTone(row.access)}>{t(`repos.access.${row.access}` as MessageKey)}</Chip></span>
          <span className="text-muted-foreground">{row.fetchedAt ? t("repos.fetchedAt", { at: formatTime(row.fetchedAt) }) : t("repos.notFetched")}</span>
          {row.webUrl ? (
            <a className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2" href={row.webUrl} target="_blank" rel="noreferrer" data-repo-web>
              {t("repos.openWeb", { forge: row.forge === "github" ? "GitHub" : "GitLab" })}
              <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : (
            <span className="min-w-0 truncate font-mono text-muted-foreground" title={row.remote ?? undefined}>{row.remote ?? t("repos.noRemote")}</span>
          )}
        </div>
      ) : (
        <span className="text-xs text-destructive">{t("repos.block.missing")}</span>
      )}
      {result ? (
        <span className={result.outcome === "failed" ? "text-xs break-words text-destructive" : "text-xs text-muted-foreground"} data-repo-result={result.outcome}>
          {result.outcome === "skipped" && result.reason
            ? t("repos.result.skipped", { reason: t(`repos.block.${result.reason}` as MessageKey) })
            : result.outcome === "failed"
              ? t("repos.result.failed", { error: result.error ?? "" })
              : t(`repos.result.${result.outcome}` as MessageKey)}
        </span>
      ) : null}
    </li>
  );
}

/** projects: the system's repos on this machine, in the group's tree order. */
export function SystemRepos({ system, projects }: { system: HiveSystem; projects: string[] }) {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const key = projects.join(",");
  const status = useQuery(() => desktop.repoStatus!(projects), [desktop, key]);
  const [rows, setRows] = useState<RepoStatusRow[] | null>(null);
  const [results, setResults] = useState<RepoPullResult[] | null>(null);
  const action = useAction();
  const shown = rows ?? status.data ?? null;
  const pull = (names: string[]) =>
    void action.run(async () => {
      const done = await desktop.pullRepos!(names);
      setResults(done);
      setRows(mergeRows(shown ?? [], done));
    });
  const counts = results ? pullCounts(results) : null;
  const toPull = shown ? pullable(shown) : [];
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-system-repos={system.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("repos.title", { system: system.name })}</span>
        {toPull.length ? <Chip kind="warning">{t("repos.pullable", { count: toPull.length })}</Chip> : null}
        <span className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={action.busy || !projects.length} data-repos-fetch
            onClick={() => void action.run(async () => { setResults(null); setRows(await desktop.repoStatus!(projects, { fetch: true })); })}>
            {t("repos.fetchAll")}
          </Button>
          <Button size="sm" disabled={action.busy || !toPull.length} data-repos-pull-all onClick={() => pull(toPull.map((r) => r.project))}>
            {t("repos.pullAll")}
          </Button>
        </span>
      </div>
      <p className="m-0 text-xs break-words text-muted-foreground">{t("repos.hint")}</p>
      {counts ? <Notice tone={counts.failed ? "warn" : "ok"} data-repos-summary>{t("repos.summary", counts)}</Notice> : null}
      <ErrorNote error={action.error ?? status.error} />
      {!shown ? (
        <p className="m-0 text-xs text-muted-foreground">{t("repos.loading")}</p>
      ) : shown.length ? (
        <ul className="flex flex-col divide-y rounded-lg border" data-repo-rows>
          {shown.map((row) => (
            <Row key={row.project} row={row} system={system} busy={action.busy} result={results?.find((r) => r.project === row.project)} onPull={() => pull([row.project])} />
          ))}
        </ul>
      ) : (
        <p className="m-0 text-xs text-muted-foreground">{t("repos.empty")}</p>
      )}
    </div>
  );
}
