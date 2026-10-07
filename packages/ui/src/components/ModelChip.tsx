import { ROUTED_KINDS, selectModel, type AgentRun, type RunRecord, type RunRequest, type Task } from "@xdev-hive/core";
import { useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { choiceText } from "#ui/components/ModelRouting.tsx";

/** Actual args stay visible even if a package fixed a different model than the router requested. */
export function ModelRunChip({ run, focusable = true }: { run: AgentRun | RunRecord; focusable?: boolean }) {
  const t = useT();
  const kind = "runId" in run ? run.kind : run.agentKind;
  const tier = "runId" in run ? run.tier ?? run.selection?.tier : run.selection?.tier;
  const selection = run.selection;
  if (!kind && !run.model && !run.effort && !tier) return null;
  const cell = selection?.reason.split(",")[0];
  const reason = selection ? t("modelRouting.reason", { reason: selection.reason }) : t("runs.modelNote");
  return <span className="inline-flex max-w-full rounded-md border border-border bg-muted px-2 py-1 text-xs text-fg-muted" tabIndex={focusable ? 0 : undefined} title={reason} aria-label={`${choiceText(run.model ?? t("runs.modelDefault"), run.effort ?? null, t)} · ${reason}`} data-run-model={run.model ?? ""}>{choiceText(run.model ?? t("runs.modelDefault"), run.effort ?? null, t)}{tier ? ` · ${t("runs.modelTier", { tier })}${cell ? ` (${cell})` : ""}` : ""}</span>;
}

export function TaskModelChips({ task, requests }: { task: Task; requests: RunRequest[] }) {
  const { client } = useHive(); const t = useT();
  const router = useQuery(() => client.call("modelRouter.get", {}), [client, task.project]);
  const latest = [...requests].sort((a, b) => b.id - a.id).find((r) => r.selection);
  const selection = latest?.selection ?? (router.data ? selectModel(router.data, task.project, { kind: task.kind, size: task.size, risk: task.risk, role: "implement" }) : null);
  if (!selection) return null;
  const reason = latest ? t("modelRouting.reason", { reason: selection.reason }) : t("modelRouting.preview", { reason: selection.reason });
  return <section className="space-y-2" data-task-model><h3 className="text-sm font-medium">{t("modelRouting.title")}</h3><p className="text-xs text-muted-foreground">{reason}</p><div className="flex flex-wrap gap-2">{ROUTED_KINDS.map((kind) => { const choice = selection.models[kind]; return choice ? <span key={kind} tabIndex={0} title={reason} className="max-w-full rounded-md border border-border px-2 py-1 text-xs wrap-anywhere">{kind}: {choiceText(choice.model, choice.effort, t)} · {t("runs.modelTier", { tier: selection.tier })} ({selection.reason.split(",")[0]})</span> : null; })}</div></section>;
}
