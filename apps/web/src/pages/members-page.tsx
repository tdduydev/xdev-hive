import { Tabs } from "@base-ui/react/tabs";
import { type UseQueryResult, useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Invitation, InvitationStatus, OrgMember, OrgRole } from "@xdev-hive/contracts";
import { Button } from "@xdev-hive/ui/button";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "@xdev-hive/ui/dialog";
import { type FormEvent, useId, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { Icon } from "@/components/icons.tsx";
import { InviteForm } from "@/components/invite-form.tsx";
import { Who } from "@/components/person.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Card } from "@/components/ui/card.tsx";
import { NativeSelect } from "@/components/ui/native-select.tsx";
import { Pill, type PillProps } from "@/components/ui/pill.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { canInvite, canRevoke } from "@/lib/invites.ts";
import { canSetOrgRole, canSetStatus, isOrgAdmin, ORG_ROLES } from "@/lib/roles.ts";
import { useMe } from "@/shell/me-context.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const memberText: Dict<{
  active: string;
  invitations: string;
  pendingApproval: string;
  peopleAccess: string;
  members: string;
  memberGroups: string;
  searchNameOrEmail: string;
  role: string;
  team: string;
  noTeam: string;
  status: string;
  locked: string;
  activeStatus: string;
  person: string;
  organizationRole: string;
  joined: string;
  changeRole: string;
  addToTeam: string;
  inTeam: string;
  teamAdmin: string;
  signsInWith: string;
  lastActive: string;
  actions: string;
  noMembersYet: string;
  cancel: string;
  close: string;
  searchEmail: string;
  sent: string;
  expires: string;
  firstSignIn: string;
  noOneIsWaitingForApproval: string;
  unlock: string;
  lock: string;
  loading: string;
  invitePeople: string;
  signIn: string;
  neverSignedIn: string;
  noLinkedSignIn: string;
  password: string;
  invitePeopleToTheOrganization: string;
  noInvitationsYet: string;
  invitationHint: string;
  deletedTeam: string;
  revoke: string;
  pendingHint: string;
  approve: string;
  deny: string;
  teamAdminBadge: string;
  you: string;
  revokeLabel: (email: string) => string;
  approveLabel: (name: string) => string;
  denyLabel: (name: string) => string;
  roleLabel: (name: string) => string;
  lockLabel: (name: string, blocked: boolean) => string;
  acceptedOn: (day: string) => string;
  orgRoles: Record<"owner" | "admin" | "member", string>;
  teamRoles: Record<"admin" | "member" | "viewer", string>;
  invitationStatus: Record<"pending" | "accepted" | "expired", string>;
}> = {
  vi: {
    active: "Đang hoạt động",
    invitations: "Lời mời",
    pendingApproval: "Chờ duyệt",
    peopleAccess: "Người và quyền",
    members: "Thành viên",
    memberGroups: "Nhóm thành viên",
    searchNameOrEmail: "Tìm tên, email…",
    role: "Vai trò",
    team: "Đội",
    noTeam: "Chưa thuộc đội",
    status: "Trạng thái",
    locked: "Đã khoá",
    activeStatus: "Hoạt động",
    person: "Người",
    organizationRole: "Vai trò tổ chức",
    joined: "Tham gia",
    changeRole: "Đổi vai trò",
    addToTeam: "Thêm vào đội",
    inTeam: "Trong đội",
    teamAdmin: "Quản trị đội",
    signsInWith: "Đăng nhập bằng",
    lastActive: "Hoạt động gần nhất",
    actions: "Thao tác",
    noMembersYet: "Chưa có thành viên nào.",
    cancel: "Huỷ",
    close: "Đóng",
    searchEmail: "Tìm email…",
    sent: "Gửi",
    expires: "Hạn",
    firstSignIn: "Đăng nhập lần đầu",
    noOneIsWaitingForApproval: "Không có ai đang chờ duyệt.",
    unlock: "Mở khoá",
    lock: "Khoá",
    loading: "Đang tải…",
    invitePeople: "Mời người",
    signIn: "Đăng nhập",
    neverSignedIn: "Chưa đăng nhập",
    noLinkedSignIn: "Chưa liên kết",
    password: "Mật khẩu",
    invitePeopleToTheOrganization: "Mời người vào tổ chức",
    noInvitationsYet: "Chưa có lời mời nào",
    invitationHint: "Mời đồng nghiệp bằng email. Mỗi người nhận một link dùng một lần, hết hạn sau 7 ngày.",
    deletedTeam: "Đội đã xoá",
    revoke: "Thu hồi",
    pendingHint: "Người đăng nhập SSO lần đầu vào hàng này khi tổ chức chọn “Vào hàng chờ duyệt”.",
    approve: "Duyệt",
    deny: "Từ chối",
    teamAdminBadge: "quản trị đội",
    you: "(bạn)",
    revokeLabel: (email) => `Thu hồi lời mời cho ${email}`,
    approveLabel: (name) => `Duyệt ${name}`,
    denyLabel: (name) => `Từ chối ${name}`,
    roleLabel: (name) => `Vai trò tổ chức của ${name}`,
    lockLabel: (name, blocked) => `${blocked ? "Mở khoá" : "Khoá"} ${name}`,
    acceptedOn: (day) => `Nhận ${day}`,
    orgRoles: { owner: "Chủ sở hữu", admin: "Quản trị", member: "Thành viên" },
    teamRoles: { admin: "Quản trị đội", member: "Thành viên", viewer: "Chỉ xem" },
    invitationStatus: { pending: "Chờ nhận", accepted: "Đã nhận", expired: "Hết hạn" },
  },
  en: {
    active: "Active",
    invitations: "Invitations",
    pendingApproval: "Pending approval",
    peopleAccess: "People & access",
    members: "Members",
    memberGroups: "Member groups",
    searchNameOrEmail: "Search name or email…",
    role: "Role",
    team: "Team",
    noTeam: "No team",
    status: "Status",
    locked: "Locked",
    activeStatus: "Active",
    person: "Person",
    organizationRole: "Organization role",
    joined: "Joined",
    changeRole: "Change role",
    addToTeam: "Add to team",
    inTeam: "In team",
    teamAdmin: "Team admin",
    signsInWith: "Signs in with",
    lastActive: "Last active",
    actions: "Actions",
    noMembersYet: "No members yet.",
    cancel: "Cancel",
    close: "Close",
    searchEmail: "Search email…",
    sent: "Sent",
    expires: "Expires",
    firstSignIn: "First sign-in",
    noOneIsWaitingForApproval: "No one is waiting for approval.",
    unlock: "Unlock",
    lock: "Lock",
    loading: "Loading…",
    invitePeople: "Invite people",
    signIn: "Sign-in",
    neverSignedIn: "Never signed in",
    noLinkedSignIn: "Not linked",
    password: "Password",
    invitePeopleToTheOrganization: "Invite people to the organization",
    noInvitationsYet: "No invitations yet",
    invitationHint: "Invite colleagues by email. Each person gets a single-use link that expires in 7 days.",
    deletedTeam: "Deleted team",
    revoke: "Revoke",
    pendingHint: "First-time SSO sign-ins land here when the organization chooses “Queue for approval”.",
    approve: "Approve",
    deny: "Deny",
    teamAdminBadge: "team admin",
    you: "(you)",
    revokeLabel: (email) => `Revoke invitation for ${email}`,
    approveLabel: (name) => `Approve ${name}`,
    denyLabel: (name) => `Deny ${name}`,
    roleLabel: (name) => `Organization role of ${name}`,
    lockLabel: (name, blocked) => `${blocked ? "Unlock" : "Lock"} ${name}`,
    acceptedOn: (day) => `Accepted ${day}`,
    orgRoles: { owner: "Owner", admin: "Admin", member: "Member" },
    teamRoles: { admin: "Team admin", member: "Member", viewer: "Viewer" },
    invitationStatus: { pending: "Pending", accepted: "Accepted", expired: "Expired" },
  },
};

export type MembersTab = "dang-hoat-dong" | "loi-moi" | "cho-duyet";

export interface MembersSearch {
  /** Tab đang mở; không có là tab Đang hoạt động. */
  xem?: "loi-moi" | "cho-duyet";
}

export function validateMembersSearch(search: Record<string, unknown>): MembersSearch {
  return search.xem === "loi-moi" || search.xem === "cho-duyet" ? { xem: search.xem } : {};
}

const tab =
  "flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground data-active:border-primary data-active:text-foreground data-disabled:cursor-not-allowed data-disabled:opacity-60";

function Loading() {
  const t = useT(memberText);
  return (
    <p aria-busy="true" className="text-muted-foreground">
      {t.loading}
    </p>
  );
}

/**
 * Màn 4 của mockup. Người bị khoá vẫn nằm trong danh sách chính, có nhãn "Đã khoá", để mở khoá ngay tại chỗ. Tab Lời
 * mời và Chờ duyệt chỉ hiện với quản trị: hub chỉ cho quản trị xem lời mời và duyệt người.
 */
export function MembersPage() {
  const me = useMe();
  const t = useT(memberText);
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const { xem } = useSearch({ from: "/session/app/in-org/admin/members" });
  const admin = isOrgAdmin(org.role);
  const members = useQuery(api.orgMembers.list.queryOptions());
  const invitations = useQuery(api.invitations.list.queryOptions({ enabled: admin }));
  const [inviting, setInviting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const listed = members.data?.filter((m) => m.status !== "pending") ?? [];
  const pending = members.data?.filter((m) => m.status === "pending") ?? [];
  const activeCount = listed.filter((m) => m.status === "active").length;
  const openInvites = invitations.data?.filter((i) => i.status === "pending").length;
  const [bulk, setBulk] = useState<{ mode: MemberBulkMode; members: OrgMember[] } | null>(null);
  const current: MembersTab = admin && xem ? xem : "dang-hoat-dong";

  return (
    <>
      <PageHeader crumb={t.peopleAccess} title={t.members}>
        {canInvite(org.role) && (
          <Button variant="default" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            {t.invitePeople}
          </Button>
        )}
      </PageHeader>
      <Tabs.Root
        value={current}
        onValueChange={(value: MembersTab) =>
          navigate({
            to: "/admin/members",
            search: value === "dang-hoat-dong" ? {} : { xem: value },
            replace: true,
          })
        }
      >
        <Tabs.List aria-label={t.memberGroups} className="flex flex-wrap gap-0.5 border-b border-border px-3 sm:px-6">
          <Tabs.Tab value="dang-hoat-dong" className={tab}>
            {t.active}
            {members.data ? ` · ${activeCount}` : ""}
          </Tabs.Tab>
          {admin && (
            <>
              <Tabs.Tab value="loi-moi" className={tab}>
                {t.invitations}
                {openInvites !== undefined ? ` · ${openInvites}` : ""}
              </Tabs.Tab>
              <Tabs.Tab value="cho-duyet" className={tab}>
                {t.pendingApproval}
                {members.data ? ` · ${pending.length}` : ""}
              </Tabs.Tab>
            </>
          )}
        </Tabs.List>
        <Tabs.Panel value="dang-hoat-dong">
          <PageBody>
            {failure && <Alert variant="destructive">{failure}</Alert>}
            {members.isPending ? (
              <Loading />
            ) : members.isError ? (
              <Alert variant="destructive">{apiErrorMessage(members.error)}</Alert>
            ) : (
              <DataTable
                rows={listed.map((m) => ({ ...m, id: m.userId }))}
                rowLabel={(m) => m.name}
                placeholder={t.searchNameOrEmail}
                selectable={admin}
                bulk={[
                  {
                    key: "role",
                    label: t.changeRole,
                    onClick: (members) => setBulk({ mode: "role", members }),
                    disabled: (members) => members.some((m) => !canSetOrgRole(org.role, m.userId === me.id)),
                  },
                  {
                    key: "team",
                    label: t.addToTeam,
                    onClick: (members) => setBulk({ mode: "team", members }),
                    disabled: (members) => members.some((m) => m.status !== "active"),
                  },
                  {
                    key: "lock",
                    label: t.lock,
                    onClick: (members) => setBulk({ mode: "lock", members }),
                    disabled: (members) =>
                      members.some((m) => m.status !== "active" || !canSetStatus(org.role, m.role, m.userId === me.id)),
                  },
                ]}
                facets={[
                  {
                    key: "login",
                    label: t.signIn,
                    value: (m) => (m.providers ?? []).map(signInMethod),
                    options: Array.from(new Set(listed.flatMap((m) => (m.providers ?? []).map(signInMethod))))
                      .sort()
                      .map((provider) => ({ value: provider, label: providerLabel(provider, t.password) })),
                  },
                  {
                    key: "role",
                    label: t.role,
                    value: (m) => m.role,
                    options: ORG_ROLES.map((role) => ({ value: role, label: t.orgRoles[role] })),
                  },
                  {
                    key: "teams",
                    label: t.team,
                    value: (m) => (m.teams.length ? m.teams.map((team) => team.teamId) : ["none"]),
                    options: [
                      { value: "none", label: t.noTeam },
                      ...Array.from(
                        new Map(
                          listed.flatMap((m) =>
                            m.teams.map((team) => [team.teamId, { value: team.teamId, label: team.name }] as const),
                          ),
                        ).values(),
                      ),
                    ],
                  },
                  {
                    key: "status",
                    label: t.status,
                    value: (m) => m.status,
                    options: [
                      { value: "active", label: t.activeStatus },
                      { value: "blocked", label: t.locked },
                    ],
                  },
                ]}
                columns={[
                  {
                    key: "person",
                    label: t.person,
                    value: (m) => `${m.name} ${m.email}`,
                    sortable: true,
                    hideable: false,
                    cell: (m) => <MemberCell member={m} part="person" report={setFailure} />,
                  },
                  {
                    key: "role",
                    label: t.organizationRole,
                    value: (m) => t.orgRoles[m.role],
                    cell: (m) => <MemberCell member={m} part="role" report={setFailure} />,
                  },
                  {
                    key: "teams",
                    label: t.team,
                    value: (m) => m.teams.map((team) => team.name).join(" "),
                    cell: (m) => <MemberTeams teams={m.teams} />,
                  },
                  {
                    key: "teamAdmin",
                    label: t.inTeam,
                    hidden: true,
                    value: (m) => (m.teams.some((team) => team.role === "admin") ? t.teamAdmin : "—"),
                  },
                  {
                    key: "status",
                    label: t.status,
                    value: (m) => (m.status === "blocked" ? t.locked : t.activeStatus),
                    cell: (m) => (
                      <Pill tone={m.status === "blocked" ? "bad" : "ok"}>
                        {m.status === "blocked" ? t.locked : t.activeStatus}
                      </Pill>
                    ),
                  },
                  {
                    key: "login",
                    label: t.signsInWith,
                    value: (m) =>
                      (m.providers ?? [])
                        .map((provider) => providerLabel(signInMethod(provider), t.password))
                        .join(" "),
                    cell: (m) => <MemberSignIns member={m} />,
                  },
                  {
                    key: "seen",
                    label: t.lastActive,
                    value: (m) => m.lastSeenAt,
                    sortable: true,
                    cell: (m) => <MemberActivity member={m} />,
                  },
                  {
                    key: "joined",
                    label: t.joined,
                    value: (m) => m.joinedAt,
                    sortable: true,
                    cell: (m) => formatDay(m.joinedAt),
                  },
                  {
                    key: "actions",
                    label: t.actions,
                    value: () => null,
                    hideable: false,
                    cell: (m) => <MemberCell member={m} part="actions" report={setFailure} />,
                  },
                ]}
                emptyContent={t.noMembersYet}
              />
            )}
          </PageBody>
        </Tabs.Panel>
        {admin && (
          <>
            <Tabs.Panel value="loi-moi">
              <PageBody>
                <InvitationsTab invitations={invitations} onInvite={() => setInviting(true)} />
              </PageBody>
            </Tabs.Panel>
            <Tabs.Panel value="cho-duyet">
              <PageBody>
                <PendingTab members={members} pending={pending} />
              </PageBody>
            </Tabs.Panel>
          </>
        )}
      </Tabs.Root>
      <Dialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
      >
        <DialogContent>
          {bulk && <MemberBulkDialog members={bulk.members} mode={bulk.mode} onDone={() => setBulk(null)} />}
        </DialogContent>
      </Dialog>
      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent>
          <InviteForm
            title={<DialogTitle>{t.invitePeopleToTheOrganization}</DialogTitle>}
            cancelLabel={t.cancel}
            doneLabel={t.close}
            onClose={() => setInviting(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function InvitationsTab({
  invitations,
  onInvite,
}: {
  invitations: UseQueryResult<Invitation[]>;
  onInvite: () => void;
}) {
  const t = useT(memberText);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<Invitation[] | null>(null);
  if (invitations.isPending) return <Loading />;
  if (invitations.isError) return <Alert variant="destructive">{apiErrorMessage(invitations.error)}</Alert>;
  if (invitations.data.length === 0)
    return (
      <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-foreground">{t.noInvitationsYet}</h2>
        <p className="max-w-md text-muted-foreground">{t.invitationHint}</p>
        <Button variant="default" className="mt-2" onClick={onInvite}>
          <Icon name="plus" />
          {t.invitePeople}
        </Button>
      </Card>
    );
  return (
    <>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DataTable
        rows={invitations.data}
        rowLabel={(inv) => inv.email}
        placeholder={t.searchEmail}
        bulk={[
          {
            key: "revoke",
            label: t.revoke,
            onClick: setSelected,
            disabled: (rows) => rows.some((inv) => !canRevoke(inv.status)),
          },
        ]}
        facets={[
          {
            key: "status",
            label: t.status,
            value: (inv) => inv.status,
            options: (["pending", "accepted", "expired"] as const).map((status) => ({
              value: status,
              label: t.invitationStatus[status],
            })),
          },
          {
            key: "role",
            label: t.role,
            value: (inv) => inv.orgRole,
            options: ORG_ROLES.map((role) => ({ value: role, label: t.orgRoles[role] })),
          },
          {
            key: "team",
            label: t.team,
            value: (inv) => inv.teamId ?? "none",
            options: [
              { value: "none", label: t.noTeam },
              ...Array.from(
                new Map(
                  invitations.data
                    .filter((inv) => inv.teamId)
                    .map(
                      (inv) =>
                        [
                          inv.teamId ?? "none",
                          { value: inv.teamId ?? "none", label: inv.teamName ?? t.deletedTeam },
                        ] as const,
                    ),
                ).values(),
              ),
            ],
          },
        ]}
        columns={[
          { key: "email", label: "Email", value: (inv) => inv.email, sortable: true, hideable: false },
          { key: "role", label: t.organizationRole, value: (inv) => t.orgRoles[inv.orgRole] },
          {
            key: "team",
            label: t.team,
            value: (inv) => inv.teamName,
            cell: (inv) => <InvitationCell invitation={inv} part="team" report={setFailure} />,
          },
          {
            key: "status",
            label: t.status,
            value: (inv) => t.invitationStatus[inv.status],
            cell: (inv) => <InvitationCell invitation={inv} part="status" report={setFailure} />,
          },
          {
            key: "sent",
            label: t.sent,
            value: (inv) => inv.createdAt,
            sortable: true,
            cell: (inv) => formatDay(inv.createdAt),
          },
          {
            key: "expires",
            label: t.expires,
            value: (inv) => inv.expiresAt,
            sortable: true,
            cell: (inv) => <InvitationCell invitation={inv} part="expires" report={setFailure} />,
          },
          {
            key: "actions",
            label: t.actions,
            value: () => null,
            hideable: false,
            cell: (inv) => <InvitationCell invitation={inv} part="actions" report={setFailure} />,
          },
        ]}
      />
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <DialogContent>
          {selected && <InvitationBulkDialog invitations={selected} onDone={() => setSelected(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

const STATUS_TONE: Record<InvitationStatus, NonNullable<PillProps["tone"]>> = {
  pending: "warn",
  accepted: "ok",
  expired: "neutral",
};

function InvitationCell({
  invitation: inv,
  report,
  part,
}: {
  invitation: Invitation;
  report: (m: string | null) => void;
  part: string;
}) {
  const t = useT(memberText);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.invitations.revoke.call({ invitationId: inv.id }),
    onMutate: () => report(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.invitations.key() }),
    onError: (e: unknown) => report(apiErrorMessage(e)),
  });
  if (part === "team")
    return (
      <>
        {inv.teamId ? (
          <span className="inline-flex items-center gap-1">
            {inv.teamName ?? <span className="text-muted-foreground">{t.deletedTeam}</span>}
            {inv.teamRole && <Pill>{t.teamRoles[inv.teamRole].toLowerCase()}</Pill>}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </>
    );
  if (part === "status") return <Pill tone={STATUS_TONE[inv.status]}>{t.invitationStatus[inv.status]}</Pill>;
  if (part === "expires")
    return (
      <>
        {inv.status === "accepted" && inv.acceptedAt
          ? t.acceptedOn(formatDay(inv.acceptedAt))
          : formatDay(inv.expiresAt)}
      </>
    );
  if (part === "actions")
    return (
      <>
        {canRevoke(inv.status) && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t.revokeLabel(inv.email)}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {t.revoke}
          </Button>
        )}
      </>
    );
  return null;
}

function PendingTab({ members, pending }: { members: UseQueryResult<OrgMember[]>; pending: OrgMember[] }) {
  const t = useT(memberText);
  const [failure, setFailure] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ mode: MemberBulkMode; members: OrgMember[] } | null>(null);
  if (members.isPending) return <Loading />;
  if (members.isError) return <Alert variant="destructive">{apiErrorMessage(members.error)}</Alert>;
  return (
    <>
      <p className="text-muted-foreground">{t.pendingHint}</p>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DataTable
        rows={pending.map((m) => ({ ...m, id: m.userId }))}
        rowLabel={(m) => m.name}
        placeholder={t.searchNameOrEmail}
        bulk={[
          { key: "approve", label: t.approve, onClick: (members) => setBulk({ mode: "approve", members }) },
          { key: "deny", label: t.deny, onClick: (members) => setBulk({ mode: "deny", members }) },
        ]}
        columns={[
          {
            key: "person",
            label: t.person,
            value: (m) => `${m.name} ${m.email}`,
            sortable: true,
            hideable: false,
            cell: (m) => <PendingCell member={m} part="person" report={setFailure} />,
          },
          {
            key: "joined",
            label: t.firstSignIn,
            value: (m) => m.joinedAt,
            sortable: true,
            cell: (m) => formatDay(m.joinedAt),
          },
          {
            key: "actions",
            label: t.actions,
            value: () => null,
            hideable: false,
            cell: (m) => <PendingCell member={m} part="actions" report={setFailure} />,
          },
        ]}
        emptyContent={t.noOneIsWaitingForApproval}
      />
      <Dialog
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
      >
        <DialogContent>
          {bulk && <MemberBulkDialog members={bulk.members} mode={bulk.mode} onDone={() => setBulk(null)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function PendingCell({
  member,
  report,
  part,
}: {
  member: OrgMember;
  report: (message: string | null) => void;
  part: string;
}) {
  const t = useT(memberText);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      decision === "approve"
        ? api.orgMembers.approve.call({ userId: member.userId })
        : api.orgMembers.deny.call({ userId: member.userId }),
    onMutate: () => report(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.orgMembers.key() }),
    onError: (e: unknown) => report(apiErrorMessage(e)),
  });
  if (part === "person") return <Who person={member} extra={<Pill tone="warn">{t.pendingApproval}</Pill>} />;
  if (part === "actions")
    return (
      <span className="inline-flex gap-1.5">
        <Button
          variant="outline"
          size="sm"
          aria-label={t.approveLabel(member.name)}
          disabled={decide.isPending}
          onClick={() => decide.mutate("approve")}
        >
          {t.approve}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t.denyLabel(member.name)}
          disabled={decide.isPending}
          onClick={() => decide.mutate("deny")}
        >
          {t.deny}
        </Button>
      </span>
    );
  return null;
}

function signInMethod(provider: string): string {
  return provider.startsWith("org-") ? "sso" : provider;
}

function providerLabel(provider: string, password: string): string {
  const labels: Record<string, string> = {
    credential: password,
    google: "Google",
    microsoft: "Microsoft",
    github: "GitHub",
    gitlab: "GitLab",
    sso: "SSO",
  };
  return labels[provider] ?? provider;
}

function MemberSignIns({ member }: { member: OrgMember }) {
  const t = useT(memberText);
  const methods = Array.from(new Set((member.providers ?? []).map(signInMethod)));
  return methods.length ? (
    <span className="flex flex-wrap gap-1">
      {methods.map((method) => (
        <Pill key={method}>{providerLabel(method, t.password)}</Pill>
      ))}
    </span>
  ) : (
    <span className="text-muted-foreground">{t.noLinkedSignIn}</span>
  );
}

function MemberActivity({ member }: { member: OrgMember }) {
  const t = useT(memberText);
  const lang = useLang();
  if (!member.lastSeenAt) return <span className="text-muted-foreground">{t.neverSignedIn}</span>;
  const date = new Date(member.lastSeenAt);
  const seconds = Math.min(0, Math.round((date.getTime() - Date.now()) / 1000));
  const [unit, divisor]: [Intl.RelativeTimeFormatUnit, number] =
    seconds > -60
      ? ["second", 1]
      : seconds > -3600
        ? ["minute", 60]
        : seconds > -86400
          ? ["hour", 3600]
          : ["day", 86400];
  const relative = new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(Math.round(seconds / divisor), unit);
  return (
    <time dateTime={member.lastSeenAt} title={date.toLocaleString(lang)} className="text-muted-foreground">
      {relative}
    </time>
  );
}

function MemberTeams({ teams }: { teams: OrgMember["teams"] }) {
  const t = useT(memberText);
  if (teams.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {teams.map((team, i) => (
        <span key={team.teamId} className="inline-flex items-center gap-1">
          {team.name}
          {team.role === "admin" && <Pill>{t.teamAdminBadge}</Pill>}
          {i < teams.length - 1 && ","}
        </span>
      ))}
    </span>
  );
}

function MemberCell({
  member,
  report,
  part,
}: {
  member: OrgMember;
  report: (message: string | null) => void;
  part: string;
}) {
  const t = useT(memberText);
  const me = useMe();
  const { org, api } = useOrg();
  const queryClient = useQueryClient();
  const handlers = {
    onMutate: () => report(null),
    // Đội và trang chủ không đổi theo vai trò tổ chức, nên chỉ cần tải lại danh sách thành viên.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.orgMembers.key() }),
    onError: (e: unknown) => report(apiErrorMessage(e)),
  };
  const mutationKey = ["org-member", org.id, member.userId];
  const mutating = useIsMutating({ mutationKey }) > 0;
  const setRole = useMutation({
    mutationKey,
    mutationFn: (role: OrgRole) => api.orgMembers.setRole.call({ userId: member.userId, role }),
    ...handlers,
  });
  const setStatus = useMutation({
    mutationKey,
    mutationFn: (status: "active" | "blocked") => api.orgMembers.setStatus.call({ userId: member.userId, status }),
    ...handlers,
  });
  const self = member.userId === me.id;
  const blocked = member.status === "blocked";
  const busy = mutating || setRole.isPending || setStatus.isPending;
  // Hiện ngay vai trò vừa chọn trong lúc chờ hub; lỗi thì quay về vai trò cũ.
  const role = setRole.isPending ? setRole.variables : member.role;

  if (part === "person")
    return (
      <Who
        person={member}
        extra={
          <>
            {self && <small className="text-xs text-muted-foreground">{t.you}</small>}
            {blocked && <Pill tone="bad">{t.locked}</Pill>}
          </>
        }
      />
    );
  if (part === "role")
    return (
      <>
        {canSetOrgRole(org.role, self) ? (
          <NativeSelect
            size="sm"
            className="w-32.5"
            aria-label={t.roleLabel(member.name)}
            value={role}
            disabled={busy}
            onChange={(e) => {
              const next = ORG_ROLES.find((r) => r === e.currentTarget.value);
              if (next) setRole.mutate(next);
            }}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {t.orgRoles[r]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Pill tone={member.role === "owner" ? "sel" : "neutral"}>{t.orgRoles[member.role]}</Pill>
        )}
      </>
    );
  if (part === "actions")
    return (
      <>
        {canSetStatus(org.role, member.role, self) && (
          <Button
            variant={blocked ? "outline" : "ghost"}
            size="sm"
            aria-label={t.lockLabel(member.name, blocked)}
            disabled={busy}
            onClick={() => setStatus.mutate(blocked ? "active" : "blocked")}
          >
            {blocked ? t.unlock : t.lock}
          </Button>
        )}
      </>
    );
  return null;
}

type MemberBulkMode = "role" | "team" | "lock" | "approve" | "deny";

function MemberBulkDialog({
  members,
  mode,
  onDone,
}: {
  members: OrgMember[];
  mode: MemberBulkMode;
  onDone: () => void;
}) {
  const text: Dict<{
    title: Record<MemberBulkMode, string>;
    count: (n: number) => string;
    team: string;
    role: string;
    apply: string;
    busy: string;
    cancel: string;
    empty: string;
  }> = {
    vi: {
      title: { role: "Đổi vai trò", team: "Thêm vào đội", lock: "Khoá", approve: "Duyệt", deny: "Từ chối" },
      count: (n) => `Áp dụng cho ${n} người đã chọn.`,
      team: "Đội",
      role: "Vai trò",
      apply: "Xác nhận",
      busy: "Đang cập nhật…",
      cancel: "Huỷ",
      empty: "Chưa có đội nào. Tạo đội trước khi thêm người.",
    },
    en: {
      title: { role: "Change role", team: "Add to team", lock: "Lock", approve: "Approve", deny: "Deny" },
      count: (n) => `Apply to ${n} selected people.`,
      team: "Team",
      role: "Role",
      apply: "Confirm",
      busy: "Updating…",
      cancel: "Cancel",
      empty: "No teams yet. Create a team before adding people.",
    },
  };
  const t = useT(text);
  const labels = useT(memberText);
  const roleId = useId();
  const teamId = useId();
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const teams = useQuery(api.teams.list.queryOptions({ enabled: mode === "team" }));
  const [remaining, setRemaining] = useState(members);
  const [failure, setFailure] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: async ({ role, teamId }: { role: OrgRole; teamId: string }) => {
      const results = await Promise.allSettled(
        remaining.map((m) => {
          if (mode === "role") return api.orgMembers.setRole.call({ userId: m.userId, role });
          if (mode === "lock") return api.orgMembers.setStatus.call({ userId: m.userId, status: "blocked" });
          if (mode === "approve") return api.orgMembers.approve.call({ userId: m.userId });
          if (mode === "deny") return api.orgMembers.deny.call({ userId: m.userId });
          return api.teamMembers.add.call({ teamId, userId: m.userId, role: "member" });
        }),
      );
      // Only failed people remain selected for retry after a partial success.
      const failed = remaining.filter((_, i) => results[i]?.status === "rejected");
      setRemaining(failed);
      const error = results.find((result) => result.status === "rejected");
      setFailure(error?.status === "rejected" ? apiErrorMessage(error.reason) : null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: api.orgMembers.key() }),
        queryClient.invalidateQueries({ queryKey: api.teamMembers.key() }),
        queryClient.invalidateQueries({ queryKey: api.teams.key() }),
      ]);
      if (!failed.length) onDone();
    },
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const role = ORG_ROLES.find((r) => r === data.get("role")) ?? "member";
    const teamId = String(data.get("teamId") ?? "");
    if (mode === "team" && !teamId) return;
    setFailure(null);
    update.mutate({ role, teamId });
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-3.5">
      <DialogTitle>{t.title[mode]}</DialogTitle>
      <DialogDescription>{t.count(remaining.length)}</DialogDescription>
      <ul className="max-h-40 overflow-y-auto text-sm text-muted-foreground">
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
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {labels.orgRoles[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
      )}
      {mode === "team" &&
        (teams.isPending ? (
          <Loading />
        ) : teams.isError ? (
          <Alert variant="destructive">{apiErrorMessage(teams.error)}</Alert>
        ) : !teams.data.length ? (
          <p>{t.empty}</p>
        ) : (
          <div className="grid gap-1.5">
            <label htmlFor={teamId}>{t.team}</label>
            <NativeSelect id={teamId} name="teamId" disabled={update.isPending}>
              {teams.data.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ))}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone} disabled={update.isPending}>
          {t.cancel}
        </Button>
        <Button type="submit" disabled={update.isPending || (mode === "team" && !teams.data?.length)}>
          {update.isPending ? t.busy : t.apply}
        </Button>
      </DialogActions>
    </form>
  );
}

function InvitationBulkDialog({ invitations, onDone }: { invitations: Invitation[]; onDone: () => void }) {
  const text: Dict<{ title: string; count: (n: number) => string; apply: string; busy: string; cancel: string }> = {
    vi: {
      title: "Thu hồi lời mời",
      count: (n) => `Thu hồi ${n} lời mời đã chọn? Link đã gửi sẽ không còn dùng được.`,
      apply: "Thu hồi",
      busy: "Đang thu hồi…",
      cancel: "Huỷ",
    },
    en: {
      title: "Revoke invitations",
      count: (n) => `Revoke ${n} selected invitations? The links will no longer work.`,
      apply: "Revoke",
      busy: "Revoking…",
      cancel: "Cancel",
    },
  };
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [remaining, setRemaining] = useState(invitations);
  const [failure, setFailure] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        remaining.map((inv) => api.invitations.revoke.call({ invitationId: inv.id })),
      );
      const failed = remaining.filter((_, i) => results[i]?.status === "rejected");
      setRemaining(failed);
      const error = results.find((result) => result.status === "rejected");
      setFailure(error?.status === "rejected" ? apiErrorMessage(error.reason) : null);
      await queryClient.invalidateQueries({ queryKey: api.invitations.key() });
      if (!failed.length) onDone();
    },
  });
  return (
    <>
      <DialogTitle>{t.title}</DialogTitle>
      <DialogDescription>{t.count(remaining.length)}</DialogDescription>
      <ul className="max-h-40 overflow-y-auto text-muted-foreground">
        {remaining.map((inv) => (
          <li key={inv.id}>{inv.email}</li>
        ))}
      </ul>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" disabled={revoke.isPending} onClick={onDone}>
          {t.cancel}
        </Button>
        <Button disabled={revoke.isPending} onClick={() => revoke.mutate()}>
          {revoke.isPending ? t.busy : t.apply}
        </Button>
      </DialogActions>
    </>
  );
}
