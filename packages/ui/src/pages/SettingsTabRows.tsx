// Cài đặt service rows for Tool, Context agent, Leader, Thành viên and Hệ thống (R-72l): design lines 1135–1172, a hint +
// solid action above and one row per setting. The pages that hold the full editors stay behind "Sửa"; here only what a
// row can change in one control (a select, a switch) is changed in place, through the same API calls and permissions.
import { useMemo, useState, type ReactNode } from "react";
import { CHAT_ACTION_ALWAYS_CONFIRM, CHAT_ACTION_KINDS, HUB_SCOPE, may, permissionsOn, PROJECT_ROLES, ROLE_PERMISSIONS, grantRole, skillDocKey, type ChatActionKind, type ProjectRole } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Toggle } from "@xdev-hive/ui/components/ui/primitives";
import { ErrorNote } from "#ui/components/common.tsx";
import { grantLabel } from "#ui/components/GrantEditor.tsx";
import { errorMessage, useAction, useCan, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { LEADER_SKILL } from "#ui/lib/skills.ts";
import { canEditChatSettings, contextProjects } from "#ui/lib/permission-controls.ts";
import { outsideSystems, scopeProject } from "#ui/lib/scope.ts";
import { useToast } from "#ui/shell/toast.tsx";
import { SettingsActionBar, SettingsRow, ValuePill } from "./SettingsRows.tsx";

type Tab = "tools" | "context" | "leader" | "members" | "systems";

/** The hint line and the solid button that opens the editor; the rows sit below it in one glass card. */
export function TabFrame({ tab, onEdit, children }: { tab: Tab; onEdit: () => void; children: ReactNode }) {
  const t = useT();
  return (
    <>
      <div className="cx-actionbar"><span>{t(`settingsTidy.summary.${tab}`)}</span><Button variant="solid" size="sm" className="max-md:min-h-11" data-settings-edit onClick={onEdit}>{t("settingsTidy.edit")}</Button></div>
      {children}
    </>
  );
}

function ProjectPick({ projects, value, onPick, label }: { projects: string[]; value: string; onPick: (p: string) => void; label: string }) {
  const t = useT();
  if (projects.length < 2) return null;
  return <SettingsRow label={label} hint={t("settingsRows.projectHint")}><select className="cx-select" aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>{projects.map((p) => <option key={p} value={p}>{p === HUB_SCOPE ? t("chat.hubScope") : p}</option>)}</select></SettingsRow>;
}

type ToolState = "default" | "on" | "off";

/** One row per catalog tool: its state for the picked project is the control; without projectSettings it is a pill. */
export function ToolRows() {
  const { client, scope } = useHive();
  const t = useT();
  const can = useCan();
  const known = useProjects();
  const action = useAction();
  const projects = useMemo(() => known.filter((p) => can(p, "projectSettings")).sort(), [known, can]);
  const [picked, setPicked] = useState("");
  const [tick, setTick] = useState(0);
  const project = projects.includes(picked) ? picked : projects.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : (projects[0] ?? null);
  const list = useQuery(() => client.call("tools.list", project ? { project } : {}), [client, project, tick]);
  const set = (id: string, enabled: boolean | null, required: boolean) => void action.run(async () => {
    await client.call("tools.setProject", { id, project: project!, enabled, required });
    setTick((n) => n + 1);
  });
  return <>
    <div className="cx-card" data-settings-rows="tools">
      <ProjectPick projects={projects} value={project ?? ""} onPick={setPicked} label={t("tools.project")} />
      {(list.data ?? []).map((tool) => {
        const mine = project ? tool.projects.find((p) => p.project === project) : undefined;
        const state: ToolState = mine?.enabled == null ? "default" : mine.enabled ? "on" : "off";
        return <SettingsRow key={tool.id} label={tool.name} hint={tool.description || `${t(`tools.kind.${tool.kind}`)} · v${tool.version}`}>
          {project ? <select className="cx-select" data-tool-row={tool.id} aria-label={`${tool.name} · ${project}`} disabled={action.busy} value={state} onChange={(e) => set(tool.id, e.target.value === "default" ? null : e.target.value === "on", mine?.required ?? false)}>
            <option value="default">{t("tools.stateDefault", { state: tool.enabledByDefault ? t("tools.on") : t("tools.off") })}</option>
            <option value="on">{t("tools.stateOn")}</option>
            <option value="off">{t("tools.stateOff")}</option>
          </select> : <ValuePill>{tool.enabledByDefault ? t("tools.defaultOn") : t("tools.defaultOff")}</ValuePill>}
        </SettingsRow>;
      })}
      {list.data && !list.data.length ? <div className="cx-row"><span><small>{t("tools.none")}</small></span></div> : null}
    </div>
    <ErrorNote error={list.error ?? action.error} />
  </>;
}

/** Context agent: AGENTS.md size and what goes into it, per project; the full preview and sync stay in the editor. */
export function ContextRows() {
  const { client, me, projects, scope } = useHive();
  const t = useT();
  const editable = contextProjects(me, projects);
  const [picked, setPicked] = useState("");
  const project = editable.includes(picked) ? picked : editable.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : (editable[0] ?? null);
  const ctx = useQuery(async () => (project ? client.call("docs.context", { project }) : null), [client, project]);
  const c = ctx.data;
  return <>
    {!editable.length ? <p className="text-sm text-fg-secondary">{t("context.noProjects")}</p> : null}
    {c ? <div className="cx-card" data-settings-rows="context">
      <ProjectPick projects={editable} value={project ?? ""} onPick={setPicked} label={t("context.project")} />
      <SettingsRow label="AGENTS.md" hint={c.lines > c.limit ? t("context.over") : t("context.under")}><ValuePill>{t("context.lines", { lines: c.lines, limit: c.limit })}</ValuePill></SettingsRow>
      {c.blocks.map((b) => <SettingsRow key={b.kind} label={t(`context.block.${b.kind}`)} hint={b.items.length ? b.items.slice(0, 3).map((i) => i.key ?? i.title).join(", ") : t("context.none")}><ValuePill>{b.items.length}</ValuePill></SettingsRow>)}
      <SettingsRow label={t("context.paths")} hint={t("context.syncHint")}><ValuePill>{c.paths.length}</ValuePill></SettingsRow>
      <SettingsRow label={t("context.files")} hint={t("context.memory", { project: c.memory.project, shared: c.memory.shared, stale: c.memory.stale, pending: c.memory.pending })}><ValuePill>{c.files.length}</ValuePill></SettingsRow>
    </div> : <ErrorNote error={ctx.error} />}
  </>;
}

/** Leader: guide source, commands count, and one switch per chat action the leader may run without asking. */
export function LeaderRows({ projects }: { projects: string[] }) {
  const { client, me, scope } = useHive();
  const t = useT();
  const action = useAction();
  const options = projects.filter((p) => p !== HUB_SCOPE);
  const [picked, setPicked] = useState("");
  const [tick, setTick] = useState(0);
  const project = options.includes(picked) ? picked : options.includes(scopeProject(scope) ?? "") ? scopeProject(scope)! : (options[0] ?? "");
  const defaults = useQuery(async () => (project ? client.call("chat.defaults", { project }) : null), [client, project, tick]);
  const guide = useQuery(async () => (project ? client.call("docs.get", { key: skillDocKey(LEADER_SKILL, project) }) : null), [client, project]);
  const editable = !!project && canEditChatSettings(me, project);
  if (!project) return <p className="text-sm text-fg-secondary">{t("agentPolicy.noProjects")}</p>;
  const kinds = defaults.data?.autoKinds ?? [];
  const toggle = (k: ChatActionKind, on: boolean) => void action.run(async () => {
    await client.call("chat.setAutonomy", { project, kinds: on ? [...kinds.filter((x) => x !== k), k] : kinds.filter((x) => x !== k) });
    setTick((n) => n + 1);
  });
  return <>
    <div className="cx-card" data-settings-rows="leader">
      <ProjectPick projects={options} value={project} onPick={setPicked} label={t("chat.project")} />
      <SettingsRow label={t("chat.guideTitle")} hint={t("chat.guideHint")}><ValuePill>{guide.data ? t("settingsRows.guideOwn") : t("settingsRows.guideTeam")}</ValuePill></SettingsRow>
      <SettingsRow label={t("chat.commandsTitle")} hint={t("settingsRows.commandsHint")}><ValuePill>{defaults.data?.commands.length ?? 0}</ValuePill></SettingsRow>
      {CHAT_ACTION_KINDS.map((k) => {
        const never = CHAT_ACTION_ALWAYS_CONFIRM.includes(k);
        const label = t(`chat.autoKind.${k.replace(".", "_") as "task_create"}`);
        return <SettingsRow key={k} label={label} hint={never ? t("chat.autoAlways") : t("settingsRows.autoKindHint")}>
          <Toggle aria-label={label} checked={!never && kinds.includes(k)} disabled={never || !editable || action.busy || !defaults.data} onChange={(e) => toggle(k, e.target.checked)} />
        </SettingsRow>;
      })}
    </div>
    <ErrorNote error={defaults.error ?? action.error} />
  </>;
}

/** Thành viên: one row per account with a role select that offers only roles within the actor's own permissions. */
export function MemberRows() {
  const { client, me } = useHive();
  const t = useT();
  const toast = useToast();
  const known = useProjects();
  const spaces = useMemo(() => [...(may(me, null, "membersManage") ? [""] : []), ...known.filter((p) => may(me, p, "membersManage"))], [me, known]);
  const [picked, setPicked] = useState<string | null>(null);
  const space = picked !== null && spaces.includes(picked) ? picked : (spaces[0] ?? null);
  const project = space === "" ? null : space;
  const [tick, setTick] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const members = useQuery(async () => (client.members && space !== null ? client.members.list(project) : []), [client, space, tick]);
  // The project's agent row (spec 79b): read here, changed in the editor behind "Sửa".
  const agents = useQuery(async () => (project !== null ? client.call("agentRights.get", { project }) : null), [client, project]);
  const mine = me.access ? (permissionsOn(me, project) ?? new Set()) : undefined;
  const allowed = (r: ProjectRole) => !mine || ROLE_PERMISSIONS[r].every((p) => mine.has(p));
  const set = (id: string, grant: ProjectRole | null) => {
    setSaving(id);
    void client.members!.set(project, id, grant).then(
      (u) => { toast(grant === null ? t("members.removed", { user: u.username, project: project ?? t("members.shared") }) : t("members.saved", { user: u.username, role: grantLabel(t, u.grant) })); setTick((n) => n + 1); },
      (err: unknown) => toast(errorMessage(err), { tone: "error" }),
    ).finally(() => setSaving(null));
  };
  if (!spaces.length) return <p className="text-sm text-fg-secondary">{t("members.noSpaces")}</p>;
  const rows = (members.data ?? []).filter((m) => m.admin || m.grant !== null);
  return <>
    <div className="cx-card" data-settings-rows="members">
      <ProjectPick projects={spaces} value={space ?? ""} onPick={setPicked} label={t("members.space")} />
      {agents.data ? <SettingsRow label={t("members.agent")} hint={t("members.agentTitle")}><ValuePill>{agents.data.isDefault ? t("members.agentDefault") : t("members.agentCustom", { count: agents.data.permissions.length })}</ValuePill></SettingsRow> : null}
      {rows.map((m) => {
        const role = grantRole(m.grant);
        const locked = me.user?.id === m.id || saving === m.id;
        return <SettingsRow key={m.id} label={m.displayName} hint={`@${m.username}${me.user?.id === m.id ? ` · ${t("members.you")}` : ""}`}>
          {m.admin ? <ValuePill>{t("members.admin")}</ValuePill> : role === "custom" ? <ValuePill>{grantLabel(t, m.grant)}</ValuePill> :
            <select className="cx-select" data-member-row={m.username} aria-label={t("users.levelOn", { project: `${m.username} · ${project ?? t("members.shared")}` })} disabled={locked} value={role ?? ""} onChange={(e) => set(m.id, (e.target.value || null) as ProjectRole | null)}>
              <option value="">{project === null ? t("members.sharedDefault") : t("projectRole.none")}</option>
              {PROJECT_ROLES.map((r) => <option key={r} value={r} disabled={!allowed(r)}>{t(`projectRole.${r}`)}</option>)}
            </select>}
        </SettingsRow>;
      })}
      {members.data && !rows.length ? <div className="cx-row"><span><small>{t("members.none")}</small></span></div> : null}
    </div>
    <ErrorNote error={members.error} />
  </>;
}

/** Hệ thống: each system with its projects, then the projects not in any. Creating and editing stay in the editor. */
export function SystemRows() {
  const { systems, projects } = useHive();
  const t = useT();
  const outside = outsideSystems(projects, systems);
  return <div className="cx-card" data-settings-rows="systems">
    {systems.map((s) => <SettingsRow key={s.name} label={s.name} hint={s.projects.join(", ") || t("settingsRows.noProjects")}><ValuePill>{t("settingsRows.projectCount", { count: s.projects.length })}</ValuePill></SettingsRow>)}
    {outside.length ? <SettingsRow label={t("settingsRows.outside")} hint={outside.join(", ")}><ValuePill>{t("settingsRows.projectCount", { count: outside.length })}</ValuePill></SettingsRow> : null}
    {!systems.length && !outside.length ? <div className="cx-row"><span><small>{t("systems.none")}</small></span></div> : null}
  </div>;
}
