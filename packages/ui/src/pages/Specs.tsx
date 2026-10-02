// Spec (roadmap 20b): the Spec Kit features of the projects in scope, as machines read them from specs/<NNN-name>/ on
// the target branch and on the branches being worked on, and pushed to the hub. A list on the left (stage, progress,
// branch); the feature's spec.md, plan.md and tasks.md on the right. #/specs?project=&dir=&branch= opens one.
import { useEffect, useState } from "react";
import { SPEC_FILES, type SpecFeature, type SpecFile, type SpecStage } from "@xdev-hive/core";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { DocMarkdown } from "#ui/components/DocMarkdown.tsx";
import { ErrorNote } from "#ui/components/common.tsx";
import { Chip, DetailBody, DetailHeader, ListItem, ListPane, type ChipKind } from "#ui/components/panes.tsx";
import { formatTime, useHashParam, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { inScope, projectScope, scopeFilter, scopeKey } from "#ui/lib/scope.ts";
import { fold } from "#ui/lib/text.ts";

const STAGE_CHIP: Record<SpecStage, ChipKind> = { specify: "neutral", plan: "info", tasks: "info", implement: "running", done: "success" };

const idOf = (f: Pick<SpecFeature, "project" | "dir" | "branch">) => JSON.stringify([f.project, f.dir, f.branch]);

/** The link to one feature, in the frame it is shown in (the Web Admin has its own). */
function specHref(f: Pick<SpecFeature, "project" | "dir" | "branch">): string {
  const admin = window.location.hash.startsWith("#/admin/");
  const q = new URLSearchParams({ project: f.project, dir: f.dir, branch: f.branch });
  return `#/${admin ? "admin/" : ""}specs?${q}`;
}

export function SpecsPage() {
  const { client, scope, setScope } = useHive();
  const t = useT();
  // Features are a project's: the team-wide scope has none.
  const list = useQuery(async () => (scope.kind === "shared" ? [] : client.call("specs.list", scopeFilter(scope))), [client, scopeKey(scope)]);
  const [linkProject, clearLink] = useHashParam("project");
  const [linkDir] = useHashParam("dir");
  const [linkBranch] = useHashParam("branch");
  const linked = linkProject && linkDir ? idOf({ project: linkProject, dir: linkDir, branch: linkBranch ?? "" }) : null;
  const [selected, setSelected] = useState<string | null>(linked);
  useEffect(() => {
    if (linked) setSelected(linked);
  }, [linked]);
  // A link to another project's feature moves the scope there, as a doc link does.
  useEffect(() => {
    if (linkProject && !inScope(scope, linkProject)) setScope(projectScope(linkProject));
  }, [linkProject, scope, setScope]);

  const [q, setQ] = useState("");
  const needle = fold(q.trim());
  const features = list.data ?? [];
  const shown = features.filter((f) => !needle || fold(`${f.dir} ${f.title} ${f.branch} ${f.project}`).includes(needle));
  const current = features.find((f) => idOf(f) === selected) ?? null;
  const manyProjects = scope.kind !== "project";
  useEffect(() => {
    if (list.data && !current && !linkProject) setSelected(list.data[0] ? idOf(list.data[0]) : null);
  }, [list.data, current, linkProject]);

  const pick = (f: SpecFeature) => {
    setSelected(idOf(f));
    // Shareable: the address bar names the feature, without a hashchange that would reload the page.
    window.history.replaceState(null, "", specHref(f));
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-surface">
      <ListPane label={t("nav.specs")} head={<Input className="h-7 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("specs.search")} aria-label={t("specs.search")} />}>
        <ErrorNote error={list.error} />
        {shown.map((f) => (
          <ListItem
            key={idOf(f)}
            selected={idOf(f) === selected}
            onClick={() => pick(f)}
            title={f.title}
            chip={
              <Chip kind={STAGE_CHIP[f.stage]} small>
                {t(`specs.stage.${f.stage}`)}
              </Chip>
            }
            sub={
              <span className="flex flex-col gap-1">
                <span className="font-mono">
                  {manyProjects ? `${f.project} · ` : ""}
                  {f.dir} · {f.branch || t("specs.targetBranch")}
                </span>
                {f.tasksTotal ? <Progress done={f.tasksDone} total={f.tasksTotal} /> : null}
              </span>
            }
            meta={`${f.machine} · ${formatTime(f.pushedAt)} · ${f.commit}`}
          />
        ))}
        {list.data && !features.length ? <p className="m-0 px-3 py-8 text-center text-xs/5 text-fg-muted">{t("specs.empty")}</p> : null}
        {features.length && !shown.length ? <p className="m-0 px-3 py-8 text-center text-xs text-fg-muted">{t("specs.noMatch")}</p> : null}
      </ListPane>
      <div className="flex min-w-0 flex-1 flex-col">
        {current ? (
          <SpecReader key={idOf(current)} feature={current} manyProjects={manyProjects} />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-[13px] text-fg-muted">
            {list.data && selected && linkProject ? (
              <span>
                {t("specs.notFound")}{" "}
                <button type="button" className="cursor-pointer text-fg-link underline" 
                  onClick={() => {
                    clearLink();
                    setSelected(null);
                  }}
                >
                  {t("specs.showAll")}
                </button>
              </span>
            ) : list.data && features.length ? (
              t("specs.pick")
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const t = useT();
  return (
    <span className="flex items-center gap-2" title={t("specs.progress", { done, total })}>
      <span className="h-1 w-24 overflow-hidden rounded-full bg-neutral-soft">
        <span className="block h-full rounded-full bg-success-solid" style={{ width: `${Math.round((done / total) * 100)}%` }} />
      </span>
      <span className="text-[11px]/none tabular-nums text-fg-muted">
        {done}/{total}
      </span>
    </span>
  );
}

function SpecReader({ feature, manyProjects }: { feature: SpecFeature; manyProjects: boolean }) {
  const { client } = useHive();
  const t = useT();
  const detail = useQuery(() => client.call("specs.get", { project: feature.project, dir: feature.dir, branch: feature.branch }), [client, idOf(feature), feature.pushedAt]);
  const files = detail.data?.files;
  const [tab, setTab] = useState<SpecFile>("spec");
  // The furthest file there is, once it has loaded: what the feature is at now.
  useEffect(() => {
    if (files) setTab([...SPEC_FILES].reverse().find((f) => files[f] !== null) ?? "spec");
  }, [files]);
  const text = files?.[tab] ?? null;
  return (
    <>
      <DetailHeader
        chips={
          <>
            <Chip kind={STAGE_CHIP[feature.stage]}>{t(`specs.stage.${feature.stage}`)}</Chip>
            <Chip kind={feature.branch ? "warning" : "neutral"}>{feature.branch || t("specs.targetBranch")}</Chip>
          </>
        }
        scope={`${manyProjects ? `${feature.project} · ` : ""}specs/${feature.dir}`}
        when={`${feature.machine} · ${formatTime(feature.pushedAt)} · ${feature.commit}`}
        title={feature.title}
      />
      <div className="flex shrink-0 items-center gap-3 border-b border-line-subtle px-6 py-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as SpecFile)}>
          <TabsList>
            {SPEC_FILES.map((f) => (
              <TabsTrigger key={f} value={f} className="px-3" disabled={!files || files[f] === null}>
                {t(`specs.file.${f}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {feature.tasksTotal ? <Progress done={feature.tasksDone} total={feature.tasksTotal} /> : null}
      </div>
      <DetailBody>
        <ErrorNote error={detail.error} />
        {detail.data === null ? <p className="m-0 text-[13px] text-fg-muted">{t("specs.notFound")}</p> : null}
        {text !== null ? <DocMarkdown text={text} /> : files ? <p className="m-0 text-[13px] text-fg-muted">{t("specs.noFile", { file: `${tab}.md` })}</p> : null}
      </DetailBody>
    </>
  );
}
