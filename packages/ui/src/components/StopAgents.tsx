// Stop-all (roadmap 27d): the button that stops every agent of a project or of the whole hub, and the notice the
// Board shows while they are paused. The hub does the work and checks who may (agents.stop, agents.resume).
import { Ban, Play } from "lucide-react";
import { PAUSED_HUB, type AgentsPaused } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useToast } from "#ui/shell/toast.tsx";

/** The pause that holds a project's agents (the hub's first), or, for project null, the hub's own. */
export function pauseOf(paused: AgentsPaused | undefined, project: string | null): { scope: string; name: string; at: string } | null {
  if (!paused) return null;
  const scope = paused.hub ? PAUSED_HUB : project !== null && paused.projects.includes(project) ? project : null;
  if (scope === null) return null;
  return { scope, name: paused.by[scope]?.name ?? "?", at: paused.by[scope]?.at ?? "" };
}

/**
 * Dừng mọi agent, or Cho agent chạy lại while this scope is paused. The confirmation counts what the hub will cancel,
 * from the lists the caller sees; the toast tells what it did.
 */
export function StopAgentsButton({ project }: { project: string | null }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const paused = useQuery(() => client.call("agents.paused", {}), [client]);
  // This scope's own pause: a project paused with the hub stays paused when the hub is let go, and the other way round.
  const on = paused.data ? (project === null ? paused.data.hub : paused.data.projects.includes(project)) : false;
  const where = project ?? t("stopAll.hub");

  const stop = () =>
    void action.run(async () => {
      const scope = project ? { project } : {};
      const [requests, runs] = await Promise.all([client.call("runs.requests", { ...scope, limit: 200 }), client.call("runs.list", { ...scope, limit: 200 })]);
      const counts = { requests: requests.filter((r) => r.status === "pending").length, runs: runs.filter((r) => r.status === "running").length };
      if (!window.confirm(t("stopAll.confirm", { project: where, ...counts }))) return;
      const done = await client.call("agents.stop", { project });
      toast(t("stopAll.stopped", { project: where, requests: done.requests, runs: done.runs, chats: done.chats }));
      paused.reload();
    });
  const resume = () =>
    void action.run(async () => {
      if (!window.confirm(t("stopAll.confirmResume", { project: where }))) return;
      await client.call("agents.resume", { project });
      toast(t("stopAll.resumed", { project: where }));
      paused.reload();
    });

  // A hub older than stop-all answers with an error: no button then.
  if (paused.error) return null;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {on ? (
        // The title says which scope: the Web Admin shows a project's button next to the hub's.
        <Button size="sm" variant="outline" title={where} disabled={action.busy || paused.loading} onClick={resume}>
          <Play />
          {t("stopAll.resume")}
        </Button>
      ) : (
        <Button size="sm" variant="danger-outline" title={where} disabled={action.busy || paused.loading} onClick={stop}>
          <Ban />
          {t("stopAll.stop")}
        </Button>
      )}
      <ErrorNote error={action.error} />
    </span>
  );
}

/** The notice while the project's agents are paused (Board, the project's page); checked about as often as a heartbeat. */
export function PausedNotice({ project }: { project: string }) {
  const { client } = useHive();
  const t = useT();
  const poll = usePoll(30_000);
  const paused = useQuery(() => client.call("agents.paused", {}), [client, poll]);
  const pause = pauseOf(paused.data, project);
  if (!pause) return null;
  return (
    <Notice tone="warn">
      {t("stopAll.banner", { project: pause.scope === PAUSED_HUB ? t("stopAll.hub") : project, by: pause.name, time: formatTime(pause.at) })}
    </Notice>
  );
}
