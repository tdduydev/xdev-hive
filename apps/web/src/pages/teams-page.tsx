import { Tabs } from "@base-ui/react/tabs";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type { OrgMember, System, TeamMember, TeamRole, TeamWithCounts } from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { EllipsisIcon, NetworkIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { Icon } from "@/components/icons.tsx";
import { InviteForm } from "@/components/invite-form.tsx";
import { checkNameSlug, type NameSlugErrors, NameSlugFields } from "@/components/name-slug-fields.tsx";
import { PageSection } from "@/components/page/page-section.tsx";
import { FormRow, SettingsSection } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Who } from "@/components/person.tsx";
import { DescriptionList } from "@/components/ui/description-list.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { FieldError } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage, formError } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { canInvite } from "@/lib/invites.ts";
import { canManageTeam, isOrgAdmin, TEAM_ROLES } from "@/lib/roles.ts";
import type { TeamTab } from "@/lib/route-search.ts";
import { nextTeamColor, teamInitials } from "@/lib/teams.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text: Dict<{
  teamsSystems: string;
  listDescription: string;
  searchTeams: string;
  team: string;
  systemsCol: string;
  peopleCol: string;
  created: string;
  moreFor: (name: string) => string;
  createFirstHint: string;
  noTeamsHint: string;
  notFound: string;
  backToList: string;
  tabsLabel: string;
  overview: string;
  membersTab: string;
  systemsTab: string;
  youManage: string;
  youAre: (role: string) => string;
  systemsCount: (n: number) => string;
  peopleCount: (n: number) => string;
  createdOn: (day: string) => string;
  more: string;
  summary: string;
  slug: string;
  admins: string;
  noAdmins: string;
  adminsHidden: string;
  noDescriptionYet: string;
  projects: string;
  projectsHint: string;
  noProjects: string;
  infoTitle: string;
  infoHint: string;
  infoSaved: string;
  systemsHint: string;
  membersHint: string;
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
  addASystem: string;
  noSystemsInThisTeamYet: string;
  description: string;
  noAccessHint: string;
  noTeamMembersYet: string;
  noDataYet: string;
  addPerson: string;
  invitePeopleToTheOrganization: string;
  you: string;
  changeRole: string;
  removeFromTeam: string;
  noCandidatesHint: string;
  teamAdmin: string;
  notChosen: string;
  addSystemTitle: (name: string) => string;
  addPersonTitle: (name: string) => string;
  teamRoleLabel: (name: string) => string;
  removeLabel: (name: string) => string;
  inviteByEmail: string;
  chooseMember: string;
  newPeople: string;
  teamRoles: Record<TeamRole, string>;
}> = {
  vi: {
    teamsSystems: "Đội và hệ thống",
    listDescription: "Đội gom người và hệ thống; quyền trên dự án đi theo vai trò của từng người trong đội.",
    searchTeams: "Tìm tên đội, mã đội…",
    team: "Đội",
    systemsCol: "Hệ thống",
    peopleCol: "Người",
    created: "Tạo ngày",
    moreFor: (name) => `Thao tác nhanh cho đội ${name}`,
    createFirstHint: "Tạo đội đầu tiên để thêm hệ thống và người vào đội.",
    noTeamsHint: "Quản trị tổ chức chưa tạo đội nào.",
    notFound: "Không tìm thấy đội này. Đội có thể đã bị xoá, hoặc thuộc tổ chức khác.",
    backToList: "Về danh sách đội",
    tabsLabel: "Các phần của đội",
    overview: "Tổng quan",
    membersTab: "Thành viên",
    systemsTab: "Hệ thống",
    youManage: "Bạn quản trị đội",
    youAre: (role) => `Bạn: ${role}`,
    systemsCount: (n) => `${n} hệ thống`,
    peopleCount: (n) => `${n} người`,
    createdOn: (day) => `Tạo ${day}`,
    more: "Thao tác khác",
    summary: "Tóm tắt",
    slug: "Mã đội",
    admins: "Quản trị đội",
    noAdmins: "Chưa có",
    adminsHidden: "Chỉ người trong đội xem được",
    noDescriptionYet: "Chưa có mô tả",
    projects: "Dự án của đội",
    projectsHint: "Thành viên đội giao task và duyệt kết quả trên các dự án này.",
    noProjects: "Đội chưa có dự án nào.",
    infoTitle: "Thông tin đội",
    infoHint: "Tên hiện ở danh sách đội, bảng việc và lời mời. Mã đội không đổi được vì nằm trong tên hệ thống.",
    infoSaved: "Đã lưu tên đội.",
    systemsHint: "Phần sản phẩm đội phụ trách; agent đọc tên và mô tả để hiểu bối cảnh khi làm task.",
    membersHint: "Vai trò trong đội quyết định ai giao task, duyệt kết quả và sửa cấu hình dự án.",
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
    addASystem: "Thêm hệ thống",
    noSystemsInThisTeamYet: "Đội chưa có hệ thống nào.",
    description: "Mô tả",
    noAccessHint: "Bạn không ở trong đội này nên chưa xem được thành viên.",
    noTeamMembersYet: "Đội chưa có ai.",
    noDataYet: "Chưa có dữ liệu",
    addPerson: "Thêm người",
    invitePeopleToTheOrganization: "Mời người vào tổ chức",
    you: "(bạn)",
    changeRole: "Đổi vai trò",
    removeFromTeam: "Gỡ khỏi đội",
    noCandidatesHint: "Mọi người đang hoạt động trong tổ chức đều đã ở trong đội này.",
    teamAdmin: "Quản trị đội",
    notChosen: "Chưa chọn",
    addSystemTitle: (name) => `Thêm hệ thống vào đội ${name}`,
    addPersonTitle: (name) => `Thêm người vào đội ${name}`,
    teamRoleLabel: (name) => `Vai trò của ${name} trong đội`,
    removeLabel: (name) => `Gỡ ${name} khỏi đội`,
    inviteByEmail: "mời bằng email",
    chooseMember: "Chọn trong những người đã vào tổ chức.",
    newPeople: "Người chưa vào tổ chức thì",
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem", ba: "BA/PO" },
  },
  en: {
    teamsSystems: "Teams & systems",
    listDescription: "Teams group people and systems; project permissions follow each person's role in the team.",
    searchTeams: "Search team name, slug…",
    team: "Team",
    systemsCol: "Systems",
    peopleCol: "People",
    created: "Created",
    moreFor: (name) => `Quick actions for ${name}`,
    createFirstHint: "Create your first team to add systems and people.",
    noTeamsHint: "The organization admin has not created any teams.",
    notFound: "This team was not found. It may have been deleted or belong to another organization.",
    backToList: "Back to teams",
    tabsLabel: "Team sections",
    overview: "Overview",
    membersTab: "Members",
    systemsTab: "Systems",
    youManage: "You manage this team",
    youAre: (role) => `You: ${role}`,
    systemsCount: (n) => `${n} systems`,
    peopleCount: (n) => `${n} people`,
    createdOn: (day) => `Created ${day}`,
    more: "More actions",
    summary: "Summary",
    slug: "Team slug",
    admins: "Team admins",
    noAdmins: "None yet",
    adminsHidden: "Visible to team members only",
    noDescriptionYet: "No description yet",
    projects: "Team projects",
    projectsHint: "Team members assign tasks and review results on these projects.",
    noProjects: "This team has no projects yet.",
    infoTitle: "Team details",
    infoHint: "The name shows in the team list, boards and invitations. The slug cannot change: system names use it.",
    infoSaved: "Team name saved.",
    systemsHint: "Parts of the product this team owns; agents read the name and description for context.",
    membersHint: "Team roles decide who assigns tasks, reviews results and edits project settings.",
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
    addASystem: "Add a system",
    noSystemsInThisTeamYet: "No systems in this team yet.",
    description: "Description",
    noAccessHint: "You cannot view members because you are not in this team.",
    noTeamMembersYet: "No team members yet.",
    noDataYet: "No data yet",
    addPerson: "Add person",
    invitePeopleToTheOrganization: "Invite people to the organization",
    you: "(you)",
    changeRole: "Change role",
    removeFromTeam: "Remove from team",
    noCandidatesHint: "All active organization members are already in this team.",
    teamAdmin: "Team admin",
    notChosen: "Not chosen",
    addSystemTitle: (name) => `Add a system to ${name}`,
    addPersonTitle: (name) => `Add person to ${name}`,
    teamRoleLabel: (name) => `Team role of ${name}`,
    removeLabel: (name) => `Remove ${name} from team`,
    inviteByEmail: "invite by email",
    chooseMember: "Choose an existing organization member.",
    newPeople: "For new people,",
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer", ba: "BA/PO" },
  },
};

/** Quyền của người đang xem với một đội; chỉ để ẩn nút, hub vẫn kiểm lại. */
type Access = "loading" | "none" | "view" | "manage";

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

/** Vai trò của tôi trong từng đội, và hàm suy ra quyền với một đội theo vai trò đó. */
function useTeamAccess(orgMembers: OrgMember[] | undefined, failed: boolean) {
  const me = useMe();
  const { org } = useOrg();
  const mine = orgMembers?.find((m) => m.userId === me.id)?.teams;
  const roleIn = (teamId: string) => mine?.find((t) => t.teamId === teamId)?.role;
  const access = (teamId: string): Access => {
    if (isOrgAdmin(org.role)) return "manage";
    if (!orgMembers) return failed ? "none" : "loading";
    const role = roleIn(teamId);
    return canManageTeam(org.role, role) ? "manage" : role ? "view" : "none";
  };
  return { access, roleIn };
}

/** Dialog thêm người, thêm hệ thống, mời người của một đội; mở được từ đầu trang, tab hay menu ⋯ của dòng. */
type TeamDialog = { kind: "person" | "system" | "invite"; team: TeamWithCounts } | null;

function TeamDialogs({
  dialog,
  onChange,
  orgMembers,
}: {
  dialog: TeamDialog;
  onChange: (dialog: TeamDialog) => void;
  orgMembers: OrgMember[] | undefined;
}) {
  const t = useT(text);
  const { org } = useOrg();
  const close = () => onChange(null);
  const team = dialog?.team;
  return (
    <>
      <Dialog open={dialog?.kind === "person"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {team && dialog?.kind === "person" && (
            <AddTeamMemberForm
              team={team}
              orgMembers={orgMembers}
              onDone={close}
              // Quản trị đội không phải quản trị tổ chức thì không mời được người mới (hub chặn).
              onInvite={canInvite(org.role) ? () => onChange({ kind: "invite", team }) : undefined}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === "system"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {team && dialog?.kind === "system" && <AddSystemForm team={team} onDone={close} />}
        </DialogContent>
      </Dialog>
      <Dialog open={dialog?.kind === "invite"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          {team && dialog?.kind === "invite" && (
            <InviteForm
              title={<DialogTitle>{t.invitePeopleToTheOrganization}</DialogTitle>}
              defaultTeamId={team.id}
              cancelLabel={t.cancel}
              doneLabel={t.close}
              onClose={close}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TeamBadge({ team, size = "sm" }: { team: Pick<TeamWithCounts, "id" | "name" | "color">; size?: "sm" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={
        size === "lg"
          ? "grid size-10 shrink-0 place-items-center rounded-lg bg-accent text-sm font-semibold text-accent-foreground"
          : "grid size-7.5 shrink-0 place-items-center rounded-md bg-accent text-xs font-semibold text-accent-foreground"
      }
    >
      {teamInitials(team.name)}
    </span>
  );
}

/**
 * /admin/teams: danh sách đội (admin-layout.md § Decisions 2). Bấm dòng, Enter hay nút › mở trang của đội; nút ⋯ thêm
 * người hay hệ thống ngay từ danh sách cho đội mình quản trị.
 */
export function TeamsPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const orgAdmin = isOrgAdmin(org.role);
  const { access } = useTeamAccess(members.data, members.isError);
  const [dialog, setDialog] = useState<TeamDialog>(null);
  const open = (team: TeamWithCounts, tab?: TeamTab) =>
    navigate({ to: "/admin/teams/$teamId", params: { teamId: team.id }, search: tab ? { tab } : {} });

  let body: ReactNode;
  if (teams.isPending) body = <TableSkeleton label={t.loading} columns={4} />;
  else if (teams.isError) body = <LoadFailure error={teams.error} retry={teams.refetch} />;
  else if (teams.data.length === 0)
    body = (
      <EmptyState
        icon={NetworkIcon}
        title={t.noTeamsYet}
        description={orgAdmin ? t.createFirstHint : t.noTeamsHint}
        action={orgAdmin && <CreateTeamDialog teamCount={0} members={members.data ?? []} />}
      />
    );
  else
    body = (
      <DataTable
        rows={teams.data}
        rowLabel={(team) => team.name}
        placeholder={t.searchTeams}
        onRowClick={(team) => void open(team)}
        minWidth={560}
        columns={[
          {
            key: "team",
            label: t.team,
            value: (team) => `${team.name} ${team.slug}`,
            sortable: true,
            hideable: false,
            pin: "start",
            cell: (team) => (
              <span className="flex min-w-0 items-center gap-2.5">
                <TeamBadge team={team} />
                <span className="grid min-w-0">
                  <Link
                    to="/admin/teams/$teamId"
                    params={{ teamId: team.id }}
                    className="truncate font-medium text-foreground hover:underline"
                  >
                    {team.name}
                  </Link>
                  <span className="truncate font-mono text-xs text-muted-foreground">{team.slug}</span>
                </span>
              </span>
            ),
          },
          {
            key: "systems",
            label: t.systemsCol,
            value: (team) => team.systemCount,
            sortable: true,
            align: "end",
          },
          { key: "people", label: t.peopleCol, value: (team) => team.memberCount, sortable: true, align: "end" },
          {
            key: "created",
            label: t.created,
            value: (team) => team.createdAt,
            sortable: true,
            cell: (team) => formatDay(team.createdAt),
          },
          {
            key: "actions",
            label: t.actions,
            value: () => null,
            hideable: false,
            align: "end",
            cell: (team) =>
              access(team.id) === "manage" && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={t.moreFor(team.name)} />}
                  >
                    <EllipsisIcon aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-44">
                    <DropdownMenuItem onClick={() => setDialog({ kind: "person", team })}>
                      {t.addPerson}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setDialog({ kind: "system", team })}>
                      {t.addASystem}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ),
          },
        ]}
      />
    );

  return (
    <>
      <PageHeader title={t.teamsSystems} description={t.listDescription}>
        {orgAdmin && <CreateTeamDialog teamCount={teams.data?.length ?? 0} members={members.data ?? []} />}
      </PageHeader>
      <PageBody>{body}</PageBody>
      <TeamDialogs dialog={dialog} onChange={setDialog} orgMembers={members.data} />
    </>
  );
}

/**
 * /admin/teams/$teamId: trang của một đội (admin-layout.md § Decisions 3). Đầu trang tóm tắt, ba tab có URL
 * (`?tab=thanh-vien`, `?tab=he-thong`; Tổng quan không có tham số).
 */
export function TeamDetailPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const { teamId } = useParams({ from: "/session/app/in-org/admin/teams/$teamId" });
  const { tab = "tong-quan" } = useSearch({ from: "/session/app/in-org/admin/teams/$teamId" });
  const teams = useQuery(api.teams.list.queryOptions());
  const members = useQuery(api.orgMembers.list.queryOptions());
  const { access: accessOf, roleIn } = useTeamAccess(members.data, members.isError);
  const [dialog, setDialog] = useState<TeamDialog>(null);
  const team = teams.data?.find((x) => x.id === teamId);

  if (teams.isPending || teams.isError || !team)
    return (
      <>
        <PageHeader title={t.teamsSystems} width="wide" />
        <PageBody width="wide">
          {teams.isPending ? (
            <SectionsSkeleton label={t.loading} />
          ) : teams.isError ? (
            <LoadFailure error={teams.error} retry={teams.refetch} />
          ) : (
            <>
              <Alert variant="destructive">{t.notFound}</Alert>
              <Link to="/admin/teams" className="w-fit text-primary hover:text-primary/90">
                {t.backToList}
              </Link>
            </>
          )}
        </PageBody>
      </>
    );

  const access = accessOf(team.id);
  const manage = access === "manage";
  const myRole = roleIn(team.id);
  return (
    <>
      <DetailHeader
        back={{ to: "/admin/teams", label: t.teamsSystems }}
        title={team.name}
        leading={<TeamBadge team={team} size="lg" />}
        status={manage ? <Pill tone="sel">{t.youManage}</Pill> : myRole && <Pill>{t.youAre(t.teamRoles[myRole])}</Pill>}
        meta={
          <>
            <span className="font-mono">{team.slug}</span>
            <span>{t.systemsCount(team.systemCount)}</span>
            <span>{t.peopleCount(team.memberCount)}</span>
            <span>{t.createdOn(formatDay(team.createdAt))}</span>
          </>
        }
      >
        {manage && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={t.more} title={t.more} />}>
                <EllipsisIcon aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onClick={() => setDialog({ kind: "system", team })}>{t.addASystem}</DropdownMenuItem>
                {canInvite(org.role) && (
                  <DropdownMenuItem onClick={() => setDialog({ kind: "invite", team })}>
                    {t.invitePeopleToTheOrganization}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="default" onClick={() => setDialog({ kind: "person", team })}>
              <Icon name="plus" />
              {t.addPerson}
            </Button>
          </>
        )}
      </DetailHeader>
      <Tabs.Root
        value={tab}
        onValueChange={(value: TeamTab | "tong-quan") =>
          navigate({
            to: "/admin/teams/$teamId",
            params: { teamId },
            search: value === "tong-quan" ? {} : { tab: value },
            replace: true,
          })
        }
      >
        <PageTabList label={t.tabsLabel}>
          <PageTab value="tong-quan">{t.overview}</PageTab>
          <PageTab value="thanh-vien" count={team.memberCount}>
            {t.membersTab}
          </PageTab>
          <PageTab value="he-thong" count={team.systemCount}>
            {t.systemsTab}
          </PageTab>
        </PageTabList>
        <PageBody width="wide">
          <Tabs.Panel value="tong-quan" className="grid min-w-0 gap-6">
            <TeamOverview key={team.id} team={team} access={access} />
          </Tabs.Panel>
          <Tabs.Panel value="thanh-vien" className="grid min-w-0">
            <TeamMembersTab
              team={team}
              access={access}
              onAdd={manage ? () => setDialog({ kind: "person", team }) : undefined}
            />
          </Tabs.Panel>
          <Tabs.Panel value="he-thong" className="grid min-w-0">
            <SystemsTab team={team} onAdd={manage ? () => setDialog({ kind: "system", team }) : undefined} />
          </Tabs.Panel>
        </PageBody>
      </Tabs.Root>
      <TeamDialogs dialog={dialog} onChange={setDialog} orgMembers={members.data} />
    </>
  );
}

function TeamOverview({ team, access }: { team: TeamWithCounts; access: Access }) {
  const t = useT(text);
  const { api } = useOrg();
  const canView = access === "view" || access === "manage";
  const teamMembers = useQuery(api.teamMembers.list.queryOptions({ input: { teamId: team.id }, enabled: canView }));
  const projects = useQuery(api.projects.list.queryOptions({ input: {} }));
  const admins = teamMembers.data?.filter((m) => m.role === "admin").map((m) => m.name);
  const mine = projects.data?.filter((p) => p.teamId === team.id);
  return (
    <>
      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <PageSection title={t.summary}>
          <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <DescriptionList
              items={[
                { term: t.slug, detail: team.slug, mono: true },
                { term: t.systemsCol, detail: team.systemCount },
                { term: t.peopleCol, detail: team.memberCount },
                {
                  term: t.admins,
                  detail: !canView
                    ? t.adminsHidden
                    : admins === undefined
                      ? "…"
                      : admins.length > 0
                        ? admins.join(", ")
                        : t.noAdmins,
                },
                { term: t.created, detail: formatDay(team.createdAt) },
              ]}
            />
          </div>
        </PageSection>
        <PageSection title={t.projects} description={t.projectsHint}>
          {projects.isPending ? (
            <TableSkeleton rows={2} columns={2} label={t.loading} />
          ) : projects.isError ? (
            <LoadFailure error={projects.error} retry={projects.refetch} />
          ) : !mine?.length ? (
            <p className="text-sm text-muted-foreground">{t.noProjects}</p>
          ) : (
            <ul className="divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
              {mine.map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <Link
                    to="/projects/$key"
                    params={{ key: p.key }}
                    className="min-w-0 truncate font-medium text-foreground hover:underline"
                  >
                    {p.name}
                  </Link>
                  <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{p.key}</span>
                </li>
              ))}
            </ul>
          )}
        </PageSection>
      </div>
      {access === "manage" && <TeamInfoForm team={team} />}
    </>
  );
}

/** Mục "Thông tin đội": mẫu lưu từng mục (admin-layout.md § Decisions 4) trên trang chi tiết. */
function TeamInfoForm({ team }: { team: TeamWithCounts }) {
  const t = useT(text);
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const nameId = useId();
  const [name, setName] = useState(team.name);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const update = useMutation({
    mutationFn: (next: string) => api.teams.update.call({ teamId: team.id, name: next }),
    onSuccess: async (saved) => {
      setName(saved.name);
      setDone(true);
      await refresh();
    },
    onError: (e) => {
      const { field, message } = formError(e);
      if (field === "name") setError(message);
      else setFailure(message);
    },
  });
  const dirty = name.trim() !== team.name;
  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SettingsSection
        title={t.infoTitle}
        description={t.infoHint}
        save={{
          dirty,
          saving: update.isPending,
          saved: done,
          error: failure,
          savedLabel: t.infoSaved,
          onSave: () => {
            setError(null);
            setFailure(null);
            if (!name.trim()) {
              setError(t.teamNamePlaceholder);
              return;
            }
            update.mutate(name.trim());
          },
          onDiscard: () => {
            setName(team.name);
            setError(null);
            setFailure(null);
          },
        }}
      >
        <FormRow label={t.teamName} htmlFor={nameId}>
          <Input
            id={nameId}
            value={name}
            onValueChange={(v) => {
              setDone(false);
              setName(v);
            }}
            maxLength={80}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            disabled={update.isPending}
          />
          {error && <FieldError>{error}</FieldError>}
        </FormRow>
      </SettingsSection>
    </>
  );
}

function SystemsTab({ team, onAdd }: { team: TeamWithCounts; onAdd: (() => void) | undefined }) {
  const t = useT(text);
  const { api } = useOrg();
  const systems = useQuery(api.systems.list.queryOptions({ input: { teamId: team.id } }));
  let body: ReactNode;
  if (systems.isPending) body = <TableSkeleton rows={2} columns={2} label={t.loading} />;
  else if (systems.isError) body = <LoadFailure error={systems.error} retry={systems.refetch} />;
  else if (systems.data.length === 0)
    body = (
      <EmptyState
        compact
        title={t.noSystemsInThisTeamYet}
        description={t.systemsHint}
        action={
          onAdd && (
            <Button variant="outline" onClick={onAdd}>
              <Icon name="plus" />
              {t.addASystem}
            </Button>
          )
        }
      />
    );
  else
    body = (
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {systems.data.map((system) => (
          <SystemCard key={system.id} system={system} teamSlug={team.slug} />
        ))}
      </div>
    );
  return (
    <PageSection
      title={t.systemsTab}
      description={t.systemsHint}
      actions={
        onAdd &&
        (systems.data?.length ?? 0) > 0 && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            <Icon name="plus" />
            {t.addASystem}
          </Button>
        )
      }
    >
      {body}
    </PageSection>
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

function TeamMembersTab({
  team,
  access,
  onAdd,
}: {
  team: TeamWithCounts;
  access: Access;
  onAdd: (() => void) | undefined;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const canView = access === "view" || access === "manage";
  const manage = access === "manage";
  const members = useQuery(api.teamMembers.list.queryOptions({ input: { teamId: team.id }, enabled: canView }));
  const [failure, setFailure] = useState<string | null>(null);

  const [bulk, setBulk] = useState<{ mode: "role" | "remove"; members: TeamMember[] } | null>(null);
  let body: ReactNode;
  if (access === "loading" || (canView && members.isPending)) body = <TableSkeleton label={t.loading} columns={4} />;
  else if (access === "none") body = <p className="text-muted-foreground">{t.noAccessHint}</p>;
  else if (members.isError) body = <LoadFailure error={members.error} retry={members.refetch} />;
  else if (!members.data?.length)
    body = (
      <EmptyState
        compact
        title={t.noTeamMembersYet}
        description={t.membersHint}
        action={
          onAdd && (
            <Button variant="outline" onClick={onAdd}>
              {t.addPerson}
            </Button>
          )
        }
      />
    );
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
            pin: "start",
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
            hidden: true,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          {
            key: "runs",
            label: t.runs30d,
            value: () => null,
            hidden: true,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          {
            key: "joined",
            label: t.joined,
            value: () => null,
            hidden: true,
            cell: () => <span className="text-muted-foreground">{t.noDataYet}</span>,
          },
          ...(manage
            ? [
                {
                  key: "actions",
                  label: t.actions,
                  value: () => null,
                  hideable: false,
                  align: "end" as const,
                  pin: "end" as const,
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
    <PageSection
      title={t.membersTab}
      description={t.membersHint}
      actions={
        onAdd &&
        (members.data?.length ?? 0) > 0 && (
          <Button variant="outline" size="sm" onClick={onAdd}>
            {t.addPerson}
          </Button>
        )
      }
    >
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
    </PageSection>
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
      await navigate({ to: "/admin/teams/$teamId", params: { teamId: team.id } });
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
      roles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem", ba: "BA/PO" },
      cancel: "Huỷ",
      apply: "Xác nhận",
      busy: "Đang cập nhật…",
    },
    en: {
      roleTitle: "Change role",
      removeTitle: "Remove from team",
      count: (n, team) => `Apply to ${n} selected people in ${team}.`,
      role: "Team role",
      roles: { admin: "Team admin", member: "Member", viewer: "Viewer", ba: "BA/PO" },
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
