// Thành viên (roadmap 25): who has which role in a project, or in the shared data, for whoever may manage its members.
// A lead gives roles to accounts that exist, up to their own permissions; making accounts stays a hub admin's.
import { useMemo, useState } from "react";
import { may, permissionsOn, type Grant } from "@xdev-hive/core";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Badge, Empty, ErrorNote, Page, PageHeader } from "#ui/components/common.tsx";
import { GrantEditor, grantLabel, RoleLegend } from "#ui/components/GrantEditor.tsx";
import { errorMessage, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import type { ProjectMember } from "#ui/client.ts";

/** The shared data, in the space picker. */
const SHARED = "";

export function MembersPage() {
  const { client, me } = useHive();
  const t = useT();
  const toast = useToast();
  const projects = useProjects();
  const spaces = useMemo(
    () => [...(may(me, null, "membersManage") ? [SHARED] : []), ...projects.filter((p) => may(me, p, "membersManage"))],
    [me, projects],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const space = picked !== null && spaces.includes(picked) ? picked : (spaces[0] ?? null);
  const project = space === SHARED ? null : space;
  const [filter, setFilter] = useState<"granted" | "all">("granted");
  const [tick, setTick] = useState(0);
  const members = useQuery(async () => (client.members && space !== null ? client.members.list(project) : []), [client, space, tick]);
  const [saving, setSaving] = useState<string | null>(null);
  // A lead gives at most what they have here; an admin anything.
  const mine = me.access ? (permissionsOn(me, project) ?? new Set()) : undefined;

  const rows = (members.data ?? []).filter((m) => filter === "all" || m.admin || m.grant !== null);
  const set = (m: ProjectMember, grant: Grant | null) => {
    setSaving(m.id);
    void client
      .members!.set(project, m.id, grant)
      .then(
        (u) => {
          toast(grant === null ? t("members.removed", { user: u.username, project: project ?? t("members.shared") }) : t("members.saved", { user: u.username, role: grantLabel(t, u.grant) }));
          setTick((n) => n + 1);
        },
        (err: unknown) => toast(errorMessage(err), { tone: "error" }),
      )
      .finally(() => setSaving(null));
  };

  return (
    <Page>
      <PageHeader title={t("members.title")} subtitle={t("members.hint")} />
      {spaces.length === 0 ? (
        <Empty>{t("members.noSpaces")}</Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("members.space")}</span>
              <NativeSelect size="sm" value={space ?? ""} onChange={(e) => setPicked(e.target.value)} aria-label={t("members.space")}>
                {spaces.map((s) => (
                  <NativeSelectOption key={s || "shared"} value={s}>
                    {s === SHARED ? t("members.shared") : s}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <ToggleGroup type="single" variant="outline" size="sm" value={filter} onValueChange={(v) => v && setFilter(v as "granted" | "all")} aria-label={t("members.title")}>
              <ToggleGroupItem value="granted" className="px-2.5 text-xs">
                {t("members.filterGranted")}
              </ToggleGroupItem>
              <ToggleGroupItem value="all" className="px-2.5 text-xs">
                {t("members.filterAll")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <RoleLegend />
          <ErrorNote error={members.error} />
          {members.data && rows.length === 0 ? <Empty>{t("members.none")}</Empty> : null}
          <div className="flex flex-col divide-y rounded-md border">
            {rows.map((m) => {
              const self = me.user?.id === m.id;
              return (
                <div key={m.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between">
                  <span className="flex min-w-0 flex-col pt-1">
                    <span className="text-sm font-medium">
                      {m.displayName}
                      {self ? <span className="text-muted-foreground"> · {t("members.you")}</span> : null}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">@{m.username}</span>
                  </span>
                  <div className="sm:w-[62%]">
                    {m.admin ? (
                      <Badge tone="accent">{t("members.admin")}</Badge>
                    ) : (
                      <GrantEditor
                        value={m.grant}
                        onChange={(g) => set(m, g)}
                        noneLabel={project === null ? t("members.sharedDefault") : undefined}
                        max={mine}
                        disabled={self || saving === m.id}
                        label={t("users.levelOn", { project: `${m.username} · ${project ?? t("members.shared")}` })}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Page>
  );
}
