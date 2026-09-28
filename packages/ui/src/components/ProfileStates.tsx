// A machine's subscription profiles as it reported them: off, no CLI, not signed in, resting, ready.
import type { ReportedProfile } from "@xdev-hive/core";
import { formatTime } from "../hooks.ts";
import { useT } from "../i18n/index.tsx";
import { StatusDot } from "./common.tsx";

export function ProfileStates({ profiles, details = false }: { profiles: ReportedProfile[]; details?: boolean }) {
  const t = useT();
  const now = new Date().toISOString();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {profiles.map((p) => {
        const resting = p.cooldownUntil !== null && p.cooldownUntil > now;
        const [tone, state] = !p.enabled
          ? ["neutral", t("board.profileOff")]
          : !p.installed
            ? ["danger", t("admin.noCli")]
            : p.loggedIn === false
              ? ["danger", t("board.profileSignedOut")]
              : resting
                ? ["warn", t("board.profileResting", { time: formatTime(p.cooldownUntil) })]
                : ["ok", t("board.profileReady")];
        return (
          <span key={p.id} className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
            <StatusDot tone={tone} />
            <span className="font-mono text-xs break-all">{p.id}</span>
            <span className="text-xs text-muted-foreground">
              {state}
              {details && p.account ? ` · ${p.account}` : ""}
              {details ? ` · ${t("agents.statRuns", { count: p.runs })}` : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
}
