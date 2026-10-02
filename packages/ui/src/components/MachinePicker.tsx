import type { Machine } from "@xdev-hive/core";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { useT } from "#ui/i18n/index.tsx";

/** A machine the hub can hand a run of the project to now (what runs.dispatch and runs.prompt check first). */
export const takesRunsOf = (m: Machine, project: string) => m.online && m.acceptsRuns && m.projects.includes(project);

/** Which machine runs it: the Tasks page's Gửi cho máy, and Prompt cho agent (roadmap 32b). */
export function MachineSelect({ id, machines, value, onChange }: { id: string; machines: Machine[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("tasks.dispatchMachine")}</Label>
      <NativeSelect id={id} size="sm" className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        {machines.map((m) => (
          <NativeSelectOption key={m.id} value={m.id}>
            {m.machine}
            {m.runs.length ? ` · ${t("board.running", { count: m.runs.filter((r) => r.status === "running").length })}` : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

/** One of the machine's profiles that are on, or "" to let it rotate them; each says why it may not start now. */
export function ProfileSelect({ id, machine, value, onChange }: { id: string; machine: Machine | null; value: string; onChange: (id: string) => void }) {
  const t = useT();
  const now = new Date().toISOString();
  const profiles = machine?.profiles.filter((p) => p.enabled) ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("board.profile")}</Label>
      <NativeSelect id={id} size="sm" className="w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        <NativeSelectOption value="">{t("board.rotate")}</NativeSelectOption>
        {profiles.map((p) => (
          <NativeSelectOption key={p.id} value={p.id}>
            {p.label}
            {p.loggedIn === false
              ? ` (${t("board.profileSignedOut")})`
              : p.overLimit
                ? ` (${t("board.profileOverLimit")})`
                : p.cooldownUntil && p.cooldownUntil > now
                  ? ` (${t("board.resting")})`
                  : ""}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
