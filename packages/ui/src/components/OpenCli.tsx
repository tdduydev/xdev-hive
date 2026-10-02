import { useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { AgentProfileStatus } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ErrorNote, Notice } from "#ui/components/common.tsx";
import { useAction, useHive } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

/** A profile the person can work in now: its CLI is here and it is not known to be signed out. Off profiles too: off only keeps runs away. */
export const canOpenCli = (p: AgentProfileStatus) => p.cliPath !== null && p.login?.loggedIn !== false;

/**
 * Opens a profile's CLI in a project's repo on this machine (roadmap 32a). A select shows only where there is a choice:
 * on a profile's card the projects, on a project's row the profiles.
 */
export function OpenCli({ profiles, projects }: { profiles: AgentProfileStatus[]; projects: string[] }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  // The one the runner would pick first comes first: on, then by priority.
  const usable = profiles.filter(canOpenCli).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.priority - b.priority);
  const [profileId, setProfileId] = useState("");
  const [project, setProject] = useState("");
  const [opened, setOpened] = useState<{ profile: string; project: string } | null>(null);
  if (!usable.length || !projects.length || !client.desktop) return null;
  const profile = usable.find((p) => p.id === profileId) ?? usable[0]!;
  const target = projects.includes(project) ? project : projects[0]!;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {usable.length > 1 ? (
          <NativeSelect size="sm" value={profile.id} onChange={(e) => setProfileId(e.target.value)} aria-label={t("openCli.profile")}>
            {usable.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.label} ({p.id})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {projects.length > 1 ? (
          <NativeSelect size="sm" value={target} onChange={(e) => setProject(e.target.value)} aria-label={t("openCli.project")}>
            {projects.map((name) => (
              <NativeSelectOption key={name} value={name}>
                {name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={action.busy}
          data-open-cli={`${profile.id}:${target}`}
          onClick={() =>
            void action.run(async () => {
              await client.desktop!.openCli(profile.id, target);
              setOpened({ profile: profile.id, project: target });
            })
          }
        >
          <SquareTerminal />
          {t("openCli.open", { cli: profile.kind === "custom" ? profile.label : t(`agentKind.${profile.kind}`) })}
        </Button>
      </div>
      {opened ? <Notice tone="info">{t("openCli.opened", opened)}</Notice> : null}
      <ErrorNote error={action.error} />
    </div>
  );
}
