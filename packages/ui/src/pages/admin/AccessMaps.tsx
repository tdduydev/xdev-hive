// Quản trị › Vai trò & quyền and Sơ đồ tổ chức (R-72l): two read-only views over data the hub already serves
// (ROLE_PERMISSIONS in core, the accounts' grants, the systems), so neither needs an endpoint of its own.
import { useMemo, useState, type CSSProperties } from "react";
import { effectivePolicy, PROJECT_ROLES, type Autonomy, type ChatDefaults, type HubRole, type HubUser, type Machine } from "@xdev-hive/core";
import { cosmicAssets } from "#ui/assets/cosmic.ts";
import { Toggle } from "@xdev-hive/ui/components/ui/primitives";
import { ErrorNote } from "#ui/components/common.tsx";
import { PERMISSION_GROUPS } from "#ui/components/GrantEditor.tsx";
import { useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import { avatarHue, hubRoleCounts, initials, orgLegend, orgTree, permissionMatrix, roleCounts, serviceAgents, type OrgRole } from "#ui/lib/users-table.ts";
import { GrantsDialog } from "#ui/pages/Users.tsx";

const hue = (name: string) => ({ "--hue": avatarHue(name) }) as CSSProperties;

export function RolesTab() {
  const { client } = useHive();
  const t = useT();
  const list = useQuery(() => client.users!.list(), [client]);
  const [role, setRole] = useState<string | null>(null);
  const matrix = useMemo(() => permissionMatrix(PERMISSION_GROUPS), []);
  const counts = roleCounts();
  const all = list.data ?? [];
  const byRole = hubRoleCounts(all);
  const hubRoles = [
    { id: "owner", dot: "var(--accent-amber, var(--accent-violet))" },
    { id: "admin", dot: "var(--accent-violet)" },
    { id: "member", dot: "var(--accent-blue)" },
    { id: "viewer", dot: "var(--accent-green)" },
  ].map((r) => ({ ...r, count: byRole[r.id as HubRole], label: t(`adminUsers.hubRole.${r.id as HubRole}`), hint: t(`adminUsers.roles.${r.id as HubRole}Hint`) }));
  return (
    <div data-roles-page>
      <ErrorNote error={list.error} />
      <div className="cu-cards">
        {hubRoles.map((r) => (
          <div key={r.id} className="cu-card" data-hub-role={r.id}>
            <span>
              <span className="cu-dot" style={{ "--dot": r.dot } as CSSProperties} />
              <span>{r.label}</span>
              <small>{list.data ? r.count : "—"}</small>
            </span>
            <small>{r.hint}</small>
          </div>
        ))}
      </div>
      <div className="cu-panel">
        <div className="cu-matrix">
          <div className="cu-mgrid cu-mhead">
            <span>{t("adminUsers.roles.matrix")}</span>
            {PROJECT_ROLES.map((r) => (
              <button key={r} type="button" aria-pressed={role === r} onClick={() => setRole(role === r ? null : r)}>
                <strong>{t(`projectRole.${r}`)}</strong>
                <small>{t("adminUsers.roles.count", { n: counts[r] })}</small>
              </button>
            ))}
          </div>
          {matrix.map((g) => (
            <div key={g.id}>
              <div className="cu-mgroup">{t(`permissionGroup.${g.id}`)}</div>
              {g.rows.map((row) => (
                <div key={row.permission} className="cu-mgrid cu-mrow">
                  <span>
                    <strong>{t(`permission.${row.permission}`)}</strong>
                    <code>{row.permission}</code>
                  </span>
                  {row.cells.map((on, i) => (
                    <span key={PROJECT_ROLES[i]} className="cu-mcell" data-on={on} data-hl={role === PROJECT_ROLES[i]} aria-label={on ? t("adminUsers.roles.granted") : t("adminUsers.roles.denied")}>
                      {on ? "✓" : "–"}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="cu-note">{t("adminUsers.roles.footnote")}</p>
    </div>
  );
}

function Faces({ people, onOpen }: { people: HubUser[]; onOpen: (u: HubUser) => void }) {
  const t = useT();
  return (
    <span className="cu-faces">
      {people.map((u) => (
        <button key={u.id} type="button" className="cu-avatar" data-size="sm" style={hue(u.username)} title={u.displayName} aria-label={t("adminUsers.org.openPerson", { name: u.displayName })} onClick={() => onOpen(u)}>
          {initials(u.displayName)}
        </button>
      ))}
    </span>
  );
}

/** Connector geometry: the horizontal bar of a child runs from the first child's centre to the last's, so the ends are cut in half. */
const bar = (i: number, n: number) => ({ left: i === 0 ? "50%" : 0, right: i === n - 1 ? "50%" : 0 });

function ServiceAgents({ name, machines, defaults, autonomy }: { name: string; machines: Machine[]; defaults: ChatDefaults | null; autonomy: Autonomy | null }) {
  const t = useT();
  const { leader, agents } = serviceAgents(name, machines, defaults);
  const planet = (kind: string) => (kind === "claude" ? cosmicAssets.planetViolet : kind === "codex" ? cosmicAssets.planetGreen : cosmicAssets.planetBlue);
  return (
    <div className="cu-agents" data-service-agents={name}>
      <span>
        <b>{t("adminUsers.org.agents")}</b>
        <span className="cu-planets">
          {agents.slice(0, 5).map((a) => (
            <i key={a.key} title={`${a.machine} · ${a.label}`} data-online={a.online} style={{ backgroundImage: `url(${planet(a.kind)})` }} />
          ))}
        </span>
      </span>
      <small>
        {t("adminUsers.org.leader")} · {leader ? `${leader.machine} · ${leader.label}` : t("adminUsers.org.noLeader")} · {agents.length ? t("adminUsers.org.agentCount", { n: agents.length }) : t("adminUsers.org.noAgent")}
        {autonomy ? ` · ${t(`agentPolicy.autonomy.${autonomy}`)}` : ""}
      </small>
    </div>
  );
}

export function OrgTab() {
  const { client, projects, systems } = useHive();
  const t = useT();
  const list = useQuery(() => client.users!.list(), [client]);
  const [role, setRole] = useState<OrgRole | null>(null);
  const [agents, setAgents] = useState(true);
  const [editing, setEditing] = useState<HubUser | null>(null);
  const all = list.data ?? [];
  const machines = useQuery(() => client.call("machines.list", {}).catch(() => []), [client]);
  const policy = useQuery(() => client.call("agentPolicy.get", {}).catch(() => null), [client]);
  // One call per service: a project's leader is its chat defaults, and the hub has no list of them.
  const defaults = useQuery(
    async () => Object.fromEntries(await Promise.all(projects.map(async (p) => [p, await client.call("chat.defaults", { project: p }).catch((): ChatDefaults | null => null)] as const))),
    [client, projects.join("\n")],
  );
  const tree = useMemo(() => orgTree(all, systems, projects, t("adminUsers.org.ungrouped")), [all, systems, projects, t]);
  const legend = orgLegend(tree);
  const admins = all.filter((u) => u.admin && !u.disabled);
  const services = tree.reduce((n, s) => n + s.services.length, 0);
  const roles: OrgRole[] = [...PROJECT_ROLES, "custom"];
  const roleName = (r: OrgRole) => t(`projectRole.${r}`);
  const open = (u: HubUser) => !u.admin && setEditing(u);
  return (
    <div data-org-page>
      <ErrorNote error={list.error} />
      <div className="cu-orgbar">
        <span>{t("adminUsers.org.highlight")}</span>
        {roles.map((r) => (
          <button key={r} type="button" className="cosmic-tag" data-tone="neutral" data-active={role === r} aria-pressed={role === r} onClick={() => setRole(role === r ? null : r)}>
            {roleName(r)}
          </button>
        ))}
        <i />
        <span>{t("adminUsers.org.agents")}</span>
        <Toggle aria-label={t("adminUsers.org.agents")} data-org-agents checked={agents} onChange={(e) => setAgents(e.target.checked)} />
      </div>
      <div className="cu-canvas">
        <div className="cu-tree">
          <div className="cu-hub">
            <span>
              <strong>{window.location.host || "hub"}</strong>
              <small>{t("adminUsers.org.hubMeta", { users: all.length, systems: systems.length, services })}</small>
            </span>
            <span className="cu-hubadmins">
              <span>{t("adminUsers.org.admins")}</span>
              <span className="cu-faces">
                {admins.map((u) => (
                  <span key={u.id} className="cu-avatar" data-size="sm" style={hue(u.username)} title={u.displayName}>{initials(u.displayName)}</span>
                ))}
              </span>
            </span>
          </div>
          {tree.length ? <span className="cu-vline" /> : <p className="cu-orgnone">{t("adminUsers.org.noData")}</p>}
          <div className="cu-level">
            {tree.map((sys, si) => (
              <div key={sys.name} className="cu-branch" data-system={sys.name}>
                <span className="cu-h" style={bar(si, tree.length)} />
                <span className="cu-v" />
                <div className="cu-system">
                  <span className="cu-dot" />
                  <strong>{sys.name}</strong>
                  <small>{t("adminUsers.org.services", { n: sys.services.length })}</small>
                </div>
                <span className="cu-vline" />
                <div className="cu-level">
                  {sys.services.map((sv, vi) => (
                    <div key={sv.name} className="cu-branch" data-leaf="true">
                      <span className="cu-h" style={bar(vi, sys.services.length)} />
                      <span className="cu-v" />
                      <div className="cu-service" data-service={sv.name}>
                        <header>
                          <strong>{sv.name}</strong>
                          <small>{t("adminUsers.org.people", { n: sv.count })}</small>
                        </header>
                        <div className="cu-roles">
                          {sv.roles.length ? (
                            sv.roles.map((r) => (
                              <div key={r.role} className="cu-orgrole" data-dim={role !== null && role !== r.role}>
                                <button type="button" onClick={() => setRole(role === r.role ? null : r.role)}>
                                  <span className="cu-dot" data-role={r.role} />
                                  {roleName(r.role)}
                                </button>
                                <Faces people={r.people.slice(0, 4)} onOpen={open} />
                                {r.people.length > 4 ? <span className="cu-more">{t("adminUsers.more", { n: r.people.length - 4 })}</span> : null}
                              </div>
                            ))
                          ) : (
                            <span className="cu-orgnone">{t("adminUsers.org.noRole")}</span>
                          )}
                        </div>
                        {agents ? <ServiceAgents name={sv.name} machines={machines.data ?? []} defaults={defaults.data?.[sv.name] ?? null} autonomy={policy.data ? effectivePolicy(policy.data.hub, policy.data.projects[sv.name] ?? {}).autonomy : null} /> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="cu-legend">
        {roles.map((r) => (
          <span key={r}>
            <span className="cu-dot" data-role={r} />
            {roleName(r)} · {legend[r]}
          </span>
        ))}
        <i />
        <span>{t("adminUsers.org.hint")}</span>
      </div>
      {editing ? (
        <GrantsDialog
          user={editing}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}
