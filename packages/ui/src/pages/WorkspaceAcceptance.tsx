import { ArrowRight } from "lucide-react";
import { Badge, ErrorNote, Page, PageHeader } from "#ui/components/common.tsx";
import { ReleaseQueue } from "#ui/components/ReleaseQueue.tsx";
import { PipelinePage } from "#ui/pages/Pipeline.tsx";
import { useHashParam, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { scopeProject } from "#ui/lib/scope.ts";
import { useInbox } from "#ui/shell/inbox.tsx";

export function WorkspaceAcceptance() {
  const { scope, bump } = useHive();
  const t = useT();
  const inbox = useInbox();
  const [tab] = useHashParam("workspaceTab");
  const project = scopeProject(scope);
  const items = inbox.items.filter(item => item.kind === "review" || item.kind === "gate" || item.kind === "releaseFailure");
  // Existing links to a pipeline step/project retain the configuration view.
  const [linkedProject] = useHashParam("project");
  const process = tab === "process" || !!linkedProject;
  return <div className="workspace-acceptance"><nav className="workspace-section-tabs" aria-label={t("workspace.acceptance")}><a href="#/pipeline" aria-current={!process ? "page" : undefined}>{t("workspace.results")}</a><a href="#/pipeline?workspaceTab=process" aria-current={process ? "page" : undefined}>{t("workspace.process")}</a></nav>{process ? <PipelinePage /> : <Page wide><PageHeader title={t("workspace.acceptance")} subtitle={t("workspace.acceptanceIntro")} /><ErrorNote error={inbox.error} /><div className="workspace-columns"><section className="workspace-panel"><header><h2>{t("workspace.results")}</h2><Badge tone="warn">{items.length}</Badge></header>{items.map(item => <article className="workspace-item" key={item.key}><Badge tone={item.tone}>{t(`inbox.tag.${item.kind}`)}</Badge><h3>{item.kind === "gate" ? item.gate.taskId : `${item.task.id} · ${item.task.title}`}</h3><p className="text-sm text-fg-muted">{item.kind === "gate" ? t(`sdlc.gateHint.${item.gate.gate}`) : t("workspace.evidenceIntro")}</p><a className="workspace-text-link" href={`#/today?section=inbox&item=${encodeURIComponent(item.key)}`}>{t("workspace.inspect")}<ArrowRight className="size-4" aria-hidden="true" /></a></article>)}{!items.length ? <p className="workspace-empty">{inbox.loading ? t("common.loading") : t("workspace.noResults")}</p> : null}</section><section className="workspace-panel"><header><h2>{t("workspace.releases")}</h2></header>{project ? <ReleaseQueue project={project} onChanged={bump} /> : <p className="workspace-empty">{t("workspace.pickReleaseProject")}</p>}</section></div></Page>}</div>;
}
