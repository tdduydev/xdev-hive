import { MODEL_TIERS, ROUTED_KINDS, type ModelRouterSettings } from "@xdev-hive/core";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

export function ModelsPanel({ settings, project }: { settings: ModelRouterSettings; project: string }) {
  const { client } = useHive();
  const t = useT();
  const poll = usePoll(30_000);
  const machines = useQuery(() => client.call("machines.list", {}), [client, poll]);
  const shown = (machines.data ?? []).filter((m) => m.projects.includes(project));
  const profiles = shown.flatMap((m) => m.profiles.map((p) => ({ machine: m, profile: p })));
  const usable = profiles.filter(({ machine: m, profile: p }) => m.online && m.acceptsRuns && p.enabled && p.installed && p.loggedIn !== false);
  return <section className="min-w-0 space-y-4 [overflow-wrap:anywhere]" aria-label={t("models.title")} data-supported-models>
    <h2 className="text-lg font-semibold">{t("models.title")}</h2>
    <p className="text-sm text-muted-foreground">{t("models.description")}</p>
    <ErrorNote error={machines.error} />
    <div className="grid min-w-0 gap-4 md:grid-cols-2">
      {MODEL_TIERS.map((tier) => <Card key={tier}>
        <CardHeader><CardTitle>{tier}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {ROUTED_KINDS.map((kind) => {
            const choice = settings.tiers[tier][kind];
            const supported = choice && usable.some(({ profile: p }) => p.kind === kind && p.supportedModels?.includes(choice.model));
            return <div key={kind} className="min-w-0 space-y-1 text-sm">
              <p className="break-words"><strong>{kind}</strong> · {choice ? `${choice.model} · ${choice.effort ?? t("models.default")}` : t("models.nearestTier")}</p>
              {choice && machines.data && !supported ? <Notice tone="warn"><p>{t("models.unavailable", { model: choice.model })}</p></Notice> : null}
            </div>;
          })}
        </CardContent>
      </Card>)}
    </div>
    <section className="space-y-3" aria-label={t("models.profiles")}>
      <h3 className="text-lg font-semibold">{t("models.profiles")}</h3>
      {machines.data && !profiles.length ? <Empty>{t("models.noProfiles")}</Empty> : null}
      {profiles.map(({ machine: m, profile: p }) => <Card key={`${m.id}/${p.id}`} data-supported-profile={p.id}>
        <CardHeader><CardTitle className="break-words">{m.machine} · {p.label} · {p.kind}</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">{m.online ? t("models.online") : t("models.offline")} · {p.enabled && p.installed && p.loggedIn !== false && m.acceptsRuns ? t("models.enabled") : t("models.disabled")}</p>
          <p className="break-words font-mono">{p.supportedModels == null ? t("models.unknown") : p.supportedModels.length ? p.supportedModels.join(", ") : t("models.empty")}</p>
        </CardContent>
      </Card>)}
    </section>
  </section>;
}
