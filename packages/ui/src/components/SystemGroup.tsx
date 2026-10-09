// A system's forge group on this machine (GROUP-init-sync): set it up (clone what is missing in the group's tree under
// one root, reuse clones already there, register each repo), link a hand-made system to its group, and sync it. Desktop
// only, since it clones with this machine's forge token and adds projects to this app.
import { useEffect, useState } from "react";
import { FolderGit2, RefreshCw } from "lucide-react";
import { memberFolder, type GitLabImportResult, type HiveSystem, type SystemInitItem, type SystemLinkPlan, type SystemPlan, type SystemSyncReport } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

const STATE_TONE: Record<SystemInitItem["state"], string> = { added: "neutral", folder: "info", new: "ok", conflict: "danger", gone: "warn", unknown: "warn" };

/** Members this machine lacks and could clone: what the "set up" button counts. */
export const missingHere = (system: HiveSystem, local: Set<string>) =>
  (system.source?.members ?? []).filter((m) => m.state === "active" && system.projects.includes(m.project) && !local.has(m.project)).length;

/** Whether the app has the group commands (an app older than GROUP-init-sync has none). */
export const canSetUpGroups = (desktop: unknown): boolean => typeof (desktop as { systemPlan?: unknown } | undefined)?.systemPlan === "function";

export function SystemGroupPanel({ system, root: initialRoot, onChanged }: { system: HiveSystem; root?: string; onChanged?: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [root, setRoot] = useState(initialRoot ?? "");
  const [plan, setPlan] = useState<SystemPlan | null>(null);
  const [protocol, setProtocol] = useState<"ssh" | "https">("https");
  const [results, setResults] = useState<GitLabImportResult[] | null>(null);
  const [synced, setSynced] = useState<SystemSyncReport | null>(null);
  const planning = useAction();
  const running = useAction();
  const syncing = useAction();
  const here = useQuery(async () => (await desktop.systemsOnMachine?.())?.[system.name] ?? null, [desktop, system.name, results, synced]);

  const load = (at?: string) =>
    void planning.run(async () => {
      const next = await desktop.systemPlan!({ system: system.name, ...(at?.trim() ? { root: at.trim() } : {}) });
      setPlan(next);
      setRoot(next.root);
      setProtocol(next.protocol);
    });
  // The plan for the root this machine would use, as soon as the panel opens: the person sees what will happen first.
  useEffect(() => { if (system.source) load(initialRoot); }, [system.name, Boolean(system.source)]);

  if (!system.source) return <LinkGroup system={system} onSaved={onChanged} />;
  const source = system.source;
  const todo = (plan?.items ?? []).filter((i) => i.state === "new" || i.state === "folder");
  const lastSync = synced ?? here.data?.lastSync ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-system-group={system.name}>
      <div className="flex flex-wrap items-center gap-2">
        <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("systemGroup.initTitle", { system: system.name })}</span>
        <Badge tone="neutral" className="font-mono">{t("systemGroup.source", { forge: source.forge === "github" ? "GitHub" : "GitLab", group: source.groupPath })}</Badge>
        <span className="text-xs text-muted-foreground">{source.syncedAt ? t("systemGroup.syncedAt", { time: formatTime(source.syncedAt) }) : t("systemGroup.neverSynced")}</span>
      </div>
      <p className="m-0 text-xs break-words text-muted-foreground">{t("systemGroup.initHint")}</p>
      {plan && !plan.forgeReady ? <Notice tone="warn">{t("systemGroup.noForgeToken", { forge: source.forge === "github" ? "GitHub" : "GitLab", host: hostName(source.url) })}</Notice> : null}
      <form
        className="grid gap-3 sm:grid-cols-[2fr_auto_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          load(root);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`group-root-${system.name}`}>{t("systemGroup.root")}</Label>
          <div className="flex gap-1">
            <Input id={`group-root-${system.name}`} className="min-w-0 font-mono" value={root} data-group-root onChange={(e) => setRoot(e.target.value)} />
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void planning.run(async () => {
                  const folder = await desktop.pickFolder();
                  if (folder) {
                    setRoot(folder);
                    load(folder);
                  }
                })
              }
            >
              {t("projects.pickFolder")}
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`group-protocol-${system.name}`}>{t("systemGroup.protocol")}</Label>
          <NativeSelect id={`group-protocol-${system.name}`} value={protocol} onChange={(e) => setProtocol(e.target.value as "ssh" | "https")}>
            <NativeSelectOption value="https">HTTPS</NativeSelectOption>
            <NativeSelectOption value="ssh">SSH</NativeSelectOption>
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" disabled={!root.trim() || planning.busy} data-group-plan>
          {t("systemGroup.plan")}
        </Button>
      </form>
      <ErrorNote error={planning.error} />
      {plan?.items.length ? (
        <ul className="flex flex-col divide-y rounded-lg border" data-group-items>
          {plan.items.map((i) => {
            const folder = memberFolder(source, i.project);
            return (
              <li key={i.project} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2" data-group-item={i.project} data-group-state={i.state}>
                <span className="font-mono text-sm">
                  {folder.length ? <span className="text-muted-foreground">{folder.join(" › ")} › </span> : null}
                  {i.project}
                </span>
                <Badge tone={STATE_TONE[i.state]}>{t(`systemGroup.state.${i.state}`)}</Badge>
                {i.owner ? <span className="text-xs text-muted-foreground">{t("systemGroup.conflictOwner", { project: i.owner })}</span> : null}
                {i.dir ? <span className="min-w-0 flex-1 basis-60 truncate text-right font-mono text-xs text-muted-foreground" title={i.dir}>{i.dir}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-group-init={system.name}
          disabled={!plan || !todo.length || running.busy || planning.busy}
          onClick={() =>
            void running.run(async () => {
              const out = await desktop.systemInit!({ system: system.name, root: plan!.root, protocol });
              setResults(out.results);
              bump();
              onChanged?.();
              load(plan!.root);
            })
          }
        >
          {running.busy ? t("systemGroup.running") : t("systemGroup.run", { count: todo.length })}
        </Button>
        <Button
          variant="outline"
          data-group-sync={system.name}
          disabled={syncing.busy || running.busy}
          onClick={() =>
            void syncing.run(async () => {
              setSynced(await desktop.systemSync!(system.name));
              bump();
              onChanged?.();
              if (plan) load(plan.root);
            })
          }
        >
          <RefreshCw className={syncing.busy ? "animate-spin" : undefined} />
          {syncing.busy ? t("systemGroup.syncing") : t("systemGroup.sync")}
        </Button>
        {here.data ? (
          <>
            <span className="text-xs text-muted-foreground" data-group-root-here>{t("systemGroup.initedAt", { root: here.data.root })}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (!window.confirm(t("systemGroup.forgetConfirm", { system: system.name }))) return;
                void syncing.run(async () => {
                  await desktop.systemForget!(system.name);
                  here.reload();
                });
              }}
            >
              {t("systemGroup.forget")}
            </Button>
          </>
        ) : null}
      </div>
      <ErrorNote error={running.error ?? syncing.error} />
      {lastSync ? (
        <p className="m-0 text-xs break-words text-muted-foreground" data-group-sync-result>
          {lastSync.error
            ? t("systemGroup.syncError", { error: lastSync.error })
            : t("systemGroup.syncResult", { added: lastSync.added.length, gone: lastSync.gone.length, cloned: lastSync.cloned.length })}
        </p>
      ) : null}
      {results ? <ImportResults results={results} /> : null}
    </div>
  );
}

function ImportResults({ results }: { results: GitLabImportResult[] }) {
  const t = useT();
  return (
    <ul className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-sm" data-group-results>
      {results.map((r) => (
        <li key={r.key} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={r.ok ? "ok" : "danger"}>{r.ok ? (r.cloned ? t("projects.importCloned") : t("projects.importUsed")) : t("projects.importFailed")}</Badge>
          <span className="font-mono text-xs">{r.key}</span>
          <span className="font-mono text-xs break-all text-muted-foreground">{r.pathWithNamespace}</span>
          {r.error ? <span className="min-w-0 text-xs break-words text-destructive">{r.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A system without a source: matched to a group with this machine's token, shown, then saved by the person. */
function LinkGroup({ system, onSaved }: { system: HiveSystem; onSaved?: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [forge, setForge] = useState<"gitlab" | "github">("gitlab");
  const [group, setGroup] = useState(system.name);
  const [plan, setPlan] = useState<SystemLinkPlan | null>(null);
  const action = useAction();
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-system-link={system.name}>
      <div className="flex flex-wrap items-center gap-2">
        <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("systemGroup.linkTitle", { system: system.name })}</span>
        <Badge tone="warn">{t("systemGroup.noSource")}</Badge>
      </div>
      <p className="m-0 text-xs break-words text-muted-foreground">{t("systemGroup.linkHint")}</p>
      <form
        className="grid gap-3 sm:grid-cols-[auto_2fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => setPlan(await desktop.systemLink!({ system: system.name, forge, group: group.trim() })));
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`link-forge-${system.name}`}>{t("systemGroup.forge")}</Label>
          <NativeSelect id={`link-forge-${system.name}`} value={forge} onChange={(e) => setForge(e.target.value as "gitlab" | "github")}>
            <NativeSelectOption value="gitlab">GitLab</NativeSelectOption>
            <NativeSelectOption value="github">GitHub</NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={`link-group-${system.name}`}>{t("systemGroup.group")}</Label>
          <Input id={`link-group-${system.name}`} className="font-mono" value={group} onChange={(e) => setGroup(e.target.value)} />
        </div>
        <Button type="submit" variant="outline" disabled={!group.trim() || action.busy} data-link-preview>
          {t("systemGroup.linkPreview")}
        </Button>
      </form>
      {plan ? (
        <div className="flex flex-col gap-1 text-xs" data-link-plan>
          <span>{t("systemGroup.linkMatched", { count: plan.matched.length })}</span>
          {plan.added.length ? <span>{t("systemGroup.linkAdded", { count: plan.added.length, keys: plan.added.join(", ") })}</span> : null}
          {plan.unmatched.length ? <span className="text-muted-foreground">{t("systemGroup.linkUnmatched", { keys: plan.unmatched.join(", ") })}</span> : null}
          <div>
            <Button
              size="sm"
              className="mt-2"
              data-link-save
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await client.call("systems.save", { name: system.name, projects: plan.projects, source: plan.source });
                  setPlan(null);
                  bump();
                  onSaved?.();
                })
              }
            >
              {t("systemGroup.linkSave")}
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorNote error={action.error} />
    </div>
  );
}

function hostName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
