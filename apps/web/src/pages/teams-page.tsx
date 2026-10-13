import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { OrgMember, System, TeamMember, TeamRole, TeamWithCounts } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { Icon } from "@/components/icons.tsx";
import { InviteForm } from "@/components/invite-form.tsx";
import { checkNameSlug, type NameSlugErrors, NameSlugFields } from "@/components/name-slug-fields.tsx";
import { Who } from "@/components/person.tsx";
import { Card } from "@/components/ui/card.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { canInvite } from "@/lib/invites.ts";
import { canManageTeam, isOrgAdmin, TEAM_ROLES } from "@/lib/roles.ts";
import { nextTeamColor, teamInitials } from "@/lib/teams.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  admin: string;
  teamsSystems: string;
  createFirstHint: string;
  noTeamsHint: string;
  teams: string;
  noDescriptionYet: string;
  systemName: string;
  systemNamePlaceholder: string;
  systemSlugHint: string;
  descriptionPlaceholder: string;
  adding: string;
  add: string;
  searchPeople: string;
  role: string;
  person: string;
  teamRole: string;
  systems: string;
  runs30d: string;
  joined: string;
  actions: string;
  cancel: string;
  close: string;
  teamName: string;
  teamNamePlaceholder: string;
  teamSlugHint: string;
  creating: string;
  createTeam: string;
  loading: string;
  noTeamsYet: string;
  system: string;
  addASystem: string;
  noSystemsInThisTeamYet: string;
  description: string;
  noAccessHint: string;
  noTeamMembersYet: string;
  noDataYet: string;
  teamMembers: string;
  addPerson: string;
  invitePeopleToTheOrganization: string;
  you: string;
  changeRole: string;
  removeFromTeam: string;
  noCandidatesHint: string;
  teamAdmin: string;
  notChosen: string;
  teamMeta: (systems: number, people: number) => string;
  systemsTitle: (name: string) => string;
  addSystemTitle: (name: string) => string;
  addPersonTitle: (name: string) => string;
  teamRoleLabel: (name: string) => string;
  removeLabel: (name: string) => string;
  inviteByEmail: string;
  chooseMember: string;
  newPeople: string;
  teamRoles: Record<"admin" | "member" | "viewer", string>;
}> = {
  vi: {
    admin: "Quản trị",
    teamsSystems: "Đội và hệ thống",
    createFirstHint: "Tạo đội đầu tiên để thêm hệ thống và người vào đội.",
    noTeamsHint: "Quản trị tổ chức chưa tạo đội nào.",
    teams: "Danh sách đội",
    noDescriptionYet: "Chưa có mô tả",
    systemName: "Tên hệ thống",
    systemNamePlaceholder: "Ví dụ: Cổng thanh toán",
    systemSlugHint: "Dùng trong đường dẫn và trong lệnh của agent.",
    descriptionPlaceholder: "Hệ thống này làm gì, gồm những service nào",
    adding: "Đang thêm…",
    add: "Thêm",
    searchPeople: "Tìm người…",
    role: "Vai trò",
    person: "Người",
    teamRole: "Vai trò trong đội",
    systems: "Hệ thống phụ trách",
    runs30d: "Run 30 ngày",
    joined: "Vào đội",
    actions: "Thao tác",
    cancel: "Huỷ",
    close: "Đóng",
    teamName: "Tên đội",
    teamNamePlaceholder: "Ví dụ: Thanh toán",
    teamSlugHint: "Dùng trong đường dẫn và tên hệ thống.",
    creating: "Đang tạo…",
    createTeam: "Tạo đội",
    loading: "Đang tải…",
    noTeamsYet: "Chưa có đội nào",
    system: "Hệ thống",
    addASystem: "Thêm hệ thống",
    noSystemsInThisTeamYet: "Đội chưa có hệ thống nào.",
    description: "Mô tả",
    noAccessHint: "Bạn không ở trong đội này nên chưa xem được thành viên.",
    noTeamMembersYet: "Đội chưa có ai.",
    noDataYet: "Chưa có dữ liệu",
    teamMembers: "Thành viên của đội",
    addPerson: "Thêm người",
    invitePeopleToTheOrganization: "Mời người vào tổ chức",
    you: "(bạn)",
    changeRole: "Đổi vai trò",
    removeFromTeam: "Gỡ khỏi đội",
    noCandidatesHint: "Mọi người đang hoạt động trong tổ chức đều đã ở trong đội này.",
    teamAdmin: "Quản trị đội",
    notChosen: "Chưa chọn",
    teamMeta: (systems, people) => `${systems} hệ thống · ${people} người`,
    systemsTitle: (name) => `Hệ thống của đội ${name}`,
    addSystemTitle: (name) => `Thêm hệ thống vào đội ${name}`,
    addPersonTitle: (name) => `Thêm người vào đội ${name}`,
    teamRoleLabel: (name) => `Vai trò của ${name} trong đội`,
    removeLabel: (name) => `Gỡ ${name} khỏi đội`,
    inviteByEmail: "mời bằng email",
    chooseMember: "Chọn trong những người đã vào tổ chức.",
    newPeople: "Người chưa vào tổ chức thì",
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem" },
  },
  en: {
    admin: "Admin",
    teamsSystems: "Teams & systems",
    createFirstHint: "Create your first team to add systems and people.",
    noTeamsHint: "The organization admin has not created any teams.",
    teams: "Teams",
    noDescriptionYet: "No description yet",
    systemName: "System name",
    systemNamePlaceholder: "e.g. Payment gateway",
    systemSlugHint: "Used in URLs and agent commands.",
    descriptionPlaceholder: "What the system does and which services it includes",
    adding: "Adding…",
    add: "Add",
    searchPeople: "Search people…",
    role: "Role",
    person: "Person",
    teamRole: "Team role",
    systems: "Systems",
    runs30d: "Runs, 30d",
    joined: "Joined",
    actions: "Actions",
    cancel: "Cancel",
    close: "Close",
    teamName: "Team name",
    teamNamePlaceholder: "e.g. Payments",
    teamSlugHint: "Used in URLs and system names.",
    creating: "Creating…",
    createTeam: "Create team",
    loading: "Loading…",
    noTeamsYet: "No teams yet",
    system: "System",
    addASystem: "Add a system",
    noSystemsInThisTeamYet: "No systems in this team yet.",
    description: "Description",
    noAccessHint: "You cannot view members because you are not in this team.",
    noTeamMembersYet: "No team members yet.",
    noDataYet: "No data yet",
    teamMembers: "Team members",
    addPerson: "Add person",
    invitePeopleToTheOrganization: "Invite people to the organization",
    you: "(you)",
    changeRole: "Change role",
    removeFromTeam: "Remove from team",
    noCandidatesHint: "All active organization members are already in this team.",
    teamAdmin: "Team admin",
    notChosen: "Not chosen",
    teamMeta: (systems, people) => `${systems} systems · ${people} people`,
    systemsTitle: (name) => `Systems of ${name}`,
    addSystemTitle: (name) => `Add a system to ${name}`,
    addPersonTitle: (name) => `Add person to ${name}`,
    teamRoleLabel: (name) => `Team role of ${name}`,
    removeLabel: (name) => `Remove ${name} from team`,
    inviteByEmail: "invite by email",
    chooseMember: "Choose an existing organization member.",
    newPeople: "For new people,",
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer" },
  },
};

/** Quyền của người đang xem với đội đang chọn; chỉ để ẩn nút, hub vẫn kiểm lại. */
type Access = "loading" | "none" | "view" | "manage";

function Loading() {
  const t = useT(text);
  return (
    <p aria-busy="true" className="text-muted-foreground">
      {t.loading}
    </p>
  );
}

/** Làm mới mọi dữ liệu có thể đổi sau khi thêm, sửa đội: số hệ thống, số người, đội của từng thành viên. */
function useRefreshTeams() {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [api.teams.key(), api.teamMembers.key(), api.systems.key(), api.orgMembers.key()].map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
}

/** Màn 3 của mockup: danh sách đội bên trái, hệ thống và thành viên của đội đang chọn bên phải. */
export function TeamsPage() {
  const t = useT(text);
  const me = useMe();
  const { org, api } = useOrg();
  const { doi } = useSearch({ from: "/session/app/in-org/admin/teams" });
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const orgAdmin = isOrgAdmin(org.role);
  const selected = teams.data?.find((t) => t.id === doi) ?? teams.data?.[0];

  let access: Access = "loading";
  if (orgAdmin) access = "manage";
  else if (members.data && selected) {
    const myRole = members.data.find((m) => m.userId === me.id)?.teams.find((t) => t.teamId === selected.id)?.role;
    access = canManageTeam(org.role, myRole) ? "manage" : myRole ? "view" : "none";
  } else if (members.isError) access = "none";

  return (
    <>
      <PageHeader crumb={t.admin} title={t.teamsSystems}>
        {orgAdmin && <CreateTeamDialog teamCount={teams.data?.length ?? 0} members={members.data ?? []} />}
      </PageHeader>
      <PageBody>
        {teams.isPending ? (
          <Loading />
        ) : teams.isError ? (
          <Alert variant="destructive">{apiErrorMessage(teams.error)}</Alert>
        ) : !selected ? (
          <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
            <span className="mb-1 grid size-10 place-items-center rounded-lg bg-accent text-accent-foreground">
              <Icon name="users" className="size-5" />
            </span>
            <h2 className="text-base font-semibold text-foreground">{t.noTeamsYet}</h2>
            <p className="max-w-md text-muted-foreground">{orgAdmin ? t.createFirstHint : t.noTeamsHint}</p>
          </Card>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-[240px_minmax(0,1fr)]">
            <TeamList teams={teams.data} selectedId={selected.id} />
            <div className="grid min-w-0 gap-4">
              <SystemsCard key={`s-${selected.id}`} team={selected} canManage={access === "manage"} />
              <TeamMembersCard key={`m-${selected.id}`} team={selected} access={access} orgMembers={members.data} />
            </div>
          </div>
        )}
      </PageBody>
    </>
  );
}

function TeamBadge({ team }: { team: Pick<TeamWithCounts, "id" | "name" | "color"> }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-7.5 shrink-0 place-items-center rounded-md bg-accent text-xs font-semibold text-accent-foreground"
    >
      {teamInitials(team.name)}
    </span>
  );
}

function TeamList({ teams, selectedId }: { teams: TeamWithCounts[]; selectedId: string }) {
  const t = useT(text);
  return (
    <Card className="p-1.5">
      <nav aria-label={t.teams} className="grid gap-0.5">
        {teams.map((team) => {
          const on = team.id === selectedId;
          return (
            <Link
              key={team.id}
              to="/admin/teams"
              search={{ doi: team.id }}
              aria-current={on ? "page" : undefined}
              className={cx("flex items-center gap-2.5 rounded-md p-2.5", on ? "bg-accent" : "hover:bg-muted")}
            >
              <TeamBadge team={team} />
              <span className="min-w-0">
                <b className="block truncate text-sm font-medium text-foreground">{team.name}</b>
                <small className="block text-xs text-muted-foreground">
                  {t.teamMeta(team.systemCount, team.memberCount)}
                </small>
              </span>
            </Link>
          );
        })}
      </nav>
    </Card>
  );
}

function SystemsCard({ team, canManage }: { team: TeamWithCounts; canManage: boolean }) {
  const t = useT(text);
  const { api } = useOrg();
  const systems = useQuery(api.systems.list.queryOptions({ input: { teamId: team.id } }));
  const [adding, setAdding] = useState(false);
  return (
    <Card className="grid min-w-0 gap-3 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">{t.systemsTitle(team.name)}</h2>
        {canManage && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {t.system}
          </Button>
        )}
      </div>
      {systems.isPending ? (
        <Loading />
      ) : systems.isError ? (
        <Alert variant="destructive">{apiErrorMessage(systems.error)}</Alert>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {systems.data.map((system) => (
            <SystemCard key={system.id} system={system} teamSlug={team.slug} />
          ))}
          {canManage ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="grid min-h-23 cursor-pointer place-items-center rounded-lg border border-dashed border-input text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="flex items-center gap-1.5">
                <Icon name="plus" />
                {t.addASystem}
              </span>
            </button>
          ) : (
            systems.data.length === 0 && <p className="text-muted-foreground">{t.noSystemsInThisTeamYet}</p>
          )}
        </div>
      )}
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <AddSystemForm team={team} onDone={() => setAdding(false)} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SystemCard({ system, teamSlug }: { system: System; teamSlug: string }) {
  const t = useT(text);
  return (
    <div className="grid content-start gap-1.5 rounded-lg border border-border bg-card p-3">
      <b className="font-semibold text-foreground">{system.name}</b>
      <small className="line-clamp-2 text-xs text-muted-foreground">{system.description || t.noDescriptionYet}</small>
      <span>
        <Pill tone="sel">
          {teamSlug}/{system.slug}
        </Pill>
      </span>
    </div>
  );
}

/** Nội dung dialog nằm trong popup để mỗi lần mở lại là form mới, không còn chữ và lỗi của lần trước. */
function AddSystemForm({ team, onDone }: { team: TeamWithCounts; onDone: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const descriptionId = useId();
  const [errors, setErrors] = useState<NameSlugErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (input: { teamId: string; name: string; slug: string; description?: string }) =>
      api.systems.create.call(input),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    const description = String(form.get("description") ?? "").trim();
    create.mutate({
      teamId: team.id,
      name: String(form.get("name")).trim(),
      slug: String(form.get("slug")),
      ...(description ? { description } : {}),
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{t.addSystemTitle(team.name)}</DialogTitle>
      <NameSlugFields
        nameLabel={t.systemName}
        namePlaceholder={t.systemNamePlaceholder}
        slugPrefix={`${team.slug}/`}
        slugPlaceholder="cong"
        slugHint={t.systemSlugHint}
        errors={errors}
        disabled={create.isPending}
        autoFocus
      />
      <div className="grid gap-1.5">
        <label htmlFor={descriptionId} className="text-sm font-medium text-foreground">
          {t.description}
        </label>
        <Textarea
          id={descriptionId}
          name="description"
          maxLength={2000}
          placeholder={t.descriptionPlaceholder}
          disabled={create.isPending}
        />
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={create.isPending}>
          {create.isPending ? t.adding : t.add}
        </Button>
      </DialogActions>
    </form>
  );
}

function TeamMembersCard({
  team,
  access,
  orgMembers,
}: {
  team: TeamWithCounts;
  access: Access;
  /** undefined khi danh sách thành viên tổ chức chưa tải xong. */
  orgMembers: OrgMember[] | undefined;
}) {
  const t = useT(text);
  const { org, api } = useOrg();
  const canView = access === "view" || access === "manage";
  const manage = access === "manage";
  const members = useQuery(api.teamMembers.list.queryOptions({ input: { teamId: team.id }, enabled: canView }));
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const [bulk, setBulk] = useState<{ mode: "role" | "remove"; members: TeamMember[] } | null>(null);
  let body: ReactNode;
  if (access === "loading" || (canView && members.isPending)) body = <Loading />;
  else if (access === "none") body = <p className="text-muted-foreground">{t.noAccessHint}</p>;
  else if (members.isError) body = <Alert variant="destructive">{apiErrorMessage(members.error)}</Alert>;
  else if (!members.data?.length) body = <p className="text-muted-foreground">{t.noTeamMembersYet}</p>;
  else
    body = (
      <DataTable
        rows={members.data.map((m) => ({ ...m, id: m.userId }))}
        rowLabel={(m) => m.name}
        placeholder={t.searchPeople}
        selectable={manage}
        bulk={[
          { key: "role", label: t.changeRole, onClick: (members) => setBulk({ mode: "role", members }) },
          { key: "remove", label: t.removeFromTeam, onClick: (members) => setBulk({ mode: "remove", members }) },
        ]}
        facets={[
          {
            key: "role",
            label: t.role,
            value: (m) => m.role,
            options: TEAM_ROLES.map((role) => ({ value: role, label: t.teamRoles[role] })),
          },
        ]}
        columns={[
          {
            key: "person",
            label: t.person,
            value: (m) => `${m.name} ${m.email}`,
            sortable: true,
            hideable: false,
            cell: (m) => <TeamMemberCell team={team} member={m} manage={manage} part="person" report={setFailure} />,
          },
          {
            key: "role",
            label: t.teamRole,
            value: (m) => t.teamRoles[m.role],
            cell: (m) => <TeamMemberCell team={team} member={m} manage={manage} part="role" report={setFailure} />,
          },
          {
            key: "systems",
            label: t.systems,
            value: () => null,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          {
            key: "runs",
            label: t.runs30d,
            value: () => null,
            sortable: true,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          {
            key: "joined",
            label: t.joined,
            value: () => null,
            sortable: true,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          ...(manage
            ? [
                {
                  key: "actions",
                  label: t.actions,
                  value: () => null,
                  hideable: false,
                  cell: (m: TeamMember) => (
                    <TeamMemberCell team={team} member={m} manage={manage} part="actions" report={setFailure} />
                  ),
                },
              ]
            : []),
        ]}
      />
    );

  return (
    <Card className="grid min-w-0 gap-3 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">{t.teamMembers}</h2>
        {manage && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            {t.addPerson}
          </Button>
        )}
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      {body}
      <Dialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
      >
        <DialogContent>
          {bulk && <TeamBulkDialog team={team} members={bulk.members} mode={bulk.mode} onDone={() => setBulk(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <AddTeamMemberForm
            team={team}
            orgMembers={orgMembers}
            onDone={() => setAdding(false)}
            // Quản trị đội không phải quản trị tổ chức thì không mời được người mới (hub chặn).
            onInvite={
              canInvite(org.role)
                ? () => {
                    setAdding(false);
                    setInviting(true);
                  }
                : undefined
            }
          />
        </DialogContent>
      </Dialog>
      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent>
          <InviteForm
            title={<DialogTitle>{t.invitePeopleToTheOrganization}</DialogTitle>}
            defaultTeamId={team.id}
            cancelLabel={t.cancel}
            doneLabel={t.close}
            onClose={() => setInviting(false)}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TeamMemberCell({
  team,
  member,
  manage,
  report,
  part,
}: {
  team: TeamWithCounts;
  member: TeamMember;
  manage: boolean;
  part: "person" | "role" | "actions";
  report: (message: string | null) => void;
}) {
  const t = useT(text);
  const me = useMe();
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const handlers = {
    onMutate: () => report(null),
    onSuccess: refresh,
    onError: (e: unknown) => report(apiErrorMessage(e)),
  };
  const mutationKey = ["team-member", team.id, member.userId];
  const mutating = useIsMutating({ mutationKey }) > 0;
  const setRole = useMutation({
    mutationKey,
    mutationFn: (role: TeamRole) => api.teamMembers.setRole.call({ teamId: team.id, userId: member.userId, role }),
    ...handlers,
  });
  const remove = useMutation({
    mutationKey,
    mutationFn: () => api.teamMembers.remove.call({ teamId: team.id, userId: member.userId }),
    ...handlers,
  });
  const busy = mutating || setRole.isPending || remove.isPending;
  // Hiện ngay vai trò vừa chọn trong lúc chờ hub; lỗi thì quay về vai trò cũ.
  const role = setRole.isPending ? setRole.variables : member.role;
  const self = member.userId === me.id;
  if (part === "person")
    return <Who person={member} extra={self && <small className="text-xs text-muted-foreground">{t.you}</small>} />;
  if (part === "role")
    return (
      <>
        {manage ? (
          <NativeSelect
            size="sm"
            className="w-35"
            aria-label={t.teamRoleLabel(member.name)}
            value={role}
            disabled={busy}
            onChange={(e) => {
              const next = TEAM_ROLES.find((r) => r === e.currentTarget.value);
              if (next) setRole.mutate(next);
            }}
          >
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {t.teamRoles[r]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          t.teamRoles[member.role]
        )}
      </>
    );
  if (part === "actions")
    return (
      <Button
        variant="ghost"
        size="sm"
        aria-label={t.removeLabel(member.name)}
        disabled={busy}
        onClick={() => remove.mutate()}
      >
        {t.removeFromTeam}
      </Button>
    );
  return null;
}

function AddTeamMemberForm({
  team,
  orgMembers,
  onDone,
  onInvite,
}: {
  team: TeamWithCounts;
  orgMembers: OrgMember[] | undefined;
  onDone: () => void;
  /** Mở hộp thoại mời người mới vào tổ chức, thêm sẵn vào đội này. Không có khi người xem không được mời. */
  onInvite?: (() => void) | undefined;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const personId = useId();
  const roleId = useId();
  const [failure, setFailure] = useState<string | null>(null);
  // Hub chỉ cho thêm người đang hoạt động trong tổ chức.
  const candidates = (orgMembers ?? []).filter(
    (m) => m.status === "active" && !m.teams.some((t) => t.teamId === team.id),
  );
  const add = useMutation({
    mutationFn: (input: { userId: string; role: TeamRole }) => api.teamMembers.add.call({ teamId: team.id, ...input }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: (error) => setFailure(apiErrorMessage(error)),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const userId = String(form.get("userId") ?? "");
    const role = TEAM_ROLES.find((r) => r === form.get("role"));
    setFailure(null);
    if (!userId || !role) return;
    add.mutate({ userId, role });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{t.addPersonTitle(team.name)}</DialogTitle>
      <DialogDescription>
        {t.chooseMember}
        {onInvite && (
          <>
            {" "}
            {t.newPeople}{" "}
            <Button variant="link" onClick={onInvite}>
              {t.inviteByEmail}
            </Button>
          </>
        )}
      </DialogDescription>
      {!orgMembers ? (
        <p aria-busy="true" className="text-muted-foreground">
          {t.loading}
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground">{t.noCandidatesHint}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 app:grid-cols-[minmax(0,1fr)_160px]">
          <div className="grid gap-1.5">
            <label htmlFor={personId} className="text-sm font-medium text-foreground">
              {t.person}
            </label>
            <NativeSelect id={personId} name="userId" disabled={add.isPending}>
              {candidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name} · {m.email}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={roleId} className="text-sm font-medium text-foreground">
              {t.teamRole}
            </label>
            <NativeSelect id={roleId} name="role" defaultValue="member" disabled={add.isPending}>
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t.teamRoles[r]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={add.isPending || candidates.length === 0}>
          {add.isPending ? t.adding : t.add}
        </Button>
      </DialogActions>
    </form>
  );
}

function CreateTeamDialog({ teamCount, members }: { teamCount: number; members: OrgMember[] }) {
  const t = useT(text);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        {t.createTeam}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <CreateTeamForm teamCount={teamCount} members={members} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateTeamForm({
  teamCount,
  members,
  onDone,
}: {
  teamCount: number;
  members: OrgMember[];
  onDone: () => void;
}) {
  const t = useT(text);
  const me = useMe();
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const navigate = useNavigate();
  const adminId = useId();
  const [errors, setErrors] = useState<NameSlugErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const active = members.filter((m) => m.status === "active");
  const create = useMutation({
    mutationFn: (input: { name: string; slug: string; adminUserId?: string }) =>
      api.teams.create.call({ ...input, color: nextTeamColor(teamCount) }),
    onSuccess: async (team) => {
      await refresh();
      onDone();
      await navigate({ to: "/admin/teams", search: { doi: team.id } });
    },
    onError: (error) => {
      const { field, message } = formError(error);
      if (field === "name" || field === "slug") setErrors({ [field]: message });
      else setFailure(message);
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const local = checkNameSlug(form);
    setErrors(local);
    setFailure(null);
    if (local.name || local.slug) return;
    const adminUserId = String(form.get("adminUserId") ?? "");
    create.mutate({
      name: String(form.get("name")).trim(),
      slug: String(form.get("slug")),
      ...(adminUserId ? { adminUserId } : {}),
    });
  }

  return (
    <form noValidate onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{t.createTeam}</DialogTitle>
      <NameSlugFields
        nameLabel={t.teamName}
        namePlaceholder={t.teamNamePlaceholder}
        slugPlaceholder="thanh-toan"
        slugHint={t.teamSlugHint}
        errors={errors}
        disabled={create.isPending}
        autoFocus
      />
      <div className="grid gap-1.5">
        <label htmlFor={adminId} className="text-sm font-medium text-foreground">
          {t.teamAdmin}
        </label>
        <NativeSelect id={adminId} name="adminUserId" defaultValue={me.id} disabled={create.isPending}>
          {/* Danh sách thành viên có thể chưa tải xong; luôn có chính mình để chọn. */}
          {!active.some((m) => m.userId === me.id) && (
            <option value={me.id}>
              {me.name} · {me.email}
            </option>
          )}
          {active.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name} · {m.email}
            </option>
          ))}
          <option value="">{t.notChosen}</option>
        </NativeSelect>
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" variant="default" disabled={create.isPending}>
          {create.isPending ? t.creating : t.createTeam}
        </Button>
      </DialogActions>
    </form>
  );
}

function TeamBulkDialog({
  team,
  members,
  mode,
  onDone,
}: {
  team: TeamWithCounts;
  members: TeamMember[];
  mode: "role" | "remove";
  onDone: () => void;
}) {
  const text: Dict<{
    roleTitle: string;
    removeTitle: string;
    count: (n: number, team: string) => string;
    role: string;
    roles: Record<TeamRole, string>;
    cancel: string;
    apply: string;
    busy: string;
  }> = {
    vi: {
      roleTitle: "Đổi vai trò",
      removeTitle: "Gỡ khỏi đội",
      count: (n, team) => `Áp dụng cho ${n} người đã chọn trong đội ${team}.`,
      role: "Vai trò trong đội",
      roles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem" },
      cancel: "Huỷ",
      apply: "Xác nhận",
      busy: "Đang cập nhật…",
    },
    en: {
      roleTitle: "Change role",
      removeTitle: "Remove from team",
      count: (n, team) => `Apply to ${n} selected people in ${team}.`,
      role: "Team role",
      roles: { admin: "Team admin", member: "Member", viewer: "Viewer" },
      cancel: "Cancel",
      apply: "Confirm",
      busy: "Updating…",
    },
  };
  const t = useT(text);
  const roleId = useId();
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const [remaining, setRemaining] = useState(members);
  const [failure, setFailure] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: async (role: TeamRole) => {
      const results = await Promise.allSettled(
        remaining.map((m) =>
          mode === "role"
            ? api.teamMembers.setRole.call({ teamId: team.id, userId: m.userId, role })
            : api.teamMembers.remove.call({ teamId: team.id, userId: m.userId }),
        ),
      );
      const failed = remaining.filter((_, i) => results[i]?.status === "rejected");
      setRemaining(failed);
      const error = results.find((result) => result.status === "rejected");
      setFailure(error?.status === "rejected" ? apiErrorMessage(error.reason) : null);
      await refresh();
      if (!failed.length) onDone();
    },
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const role = TEAM_ROLES.find((r) => r === data.get("role")) ?? "member";
    setFailure(null);
    update.mutate(role);
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{mode === "role" ? t.roleTitle : t.removeTitle}</DialogTitle>
      <DialogDescription>{t.count(remaining.length, team.name)}</DialogDescription>
      <ul className="max-h-40 overflow-y-auto text-muted-foreground">
        {remaining.map((m) => (
          <li key={m.userId}>
            {m.name} · {m.email}
          </li>
        ))}
      </ul>
      {mode === "role" && (
        <div className="grid gap-1.5">
          <label htmlFor={roleId}>{t.role}</label>
          <NativeSelect id={roleId} name="role" defaultValue="member" disabled={update.isPending}>
            {TEAM_ROLES.map((role) => (
              <option key={role} value={role}>
                {t.roles[role]}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" disabled={update.isPending} onClick={onDone}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? t.busy : t.apply}
        </Button>
      </DialogActions>
    </form>
  );
}
