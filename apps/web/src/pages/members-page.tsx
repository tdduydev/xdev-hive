import { Tabs } from "@base-ui/react/tabs";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { Invitation, InvitationStatus, OrgMember, OrgRole } from "@xdev-hive/contracts";
import { useState } from "react";
import { Icon } from "../components/icons.tsx";
import { InviteForm } from "../components/invite-form.tsx";
import { Who } from "../components/person.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill, type PillProps } from "../components/ui/pill.tsx";
import { Select } from "../components/ui/select.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDay } from "../lib/format.ts";
import { canInvite, canRevoke, INVITATION_STATUS_LABEL } from "../lib/invites.ts";
import { matchesPerson } from "../lib/people.ts";
import { canSetOrgRole, canSetStatus, isOrgAdmin, ORG_ROLE_LABEL, ORG_ROLES, TEAM_ROLE_LABEL } from "../lib/roles.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

export type MembersTab = "dang-hoat-dong" | "loi-moi" | "cho-duyet";

export interface MembersSearch {
  /** Tab đang mở; không có là tab Đang hoạt động. */
  xem?: "loi-moi" | "cho-duyet";
}

export function validateMembersSearch(search: Record<string, unknown>): MembersSearch {
  return search.xem === "loi-moi" || search.xem === "cho-duyet" ? { xem: search.xem } : {};
}

const tab =
  "flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-label font-medium text-muted data-active:border-accent data-active:text-ink data-disabled:cursor-not-allowed data-disabled:opacity-60";

function Loading() {
  return (
    <p aria-busy="true" className="text-muted">
      Đang tải…
    </p>
  );
}

/**
 * Màn 4 của mockup. Người bị khoá vẫn nằm trong danh sách chính, có nhãn "Đã khoá", để mở khoá ngay tại chỗ. Tab Lời
 * mời và Chờ duyệt chỉ hiện với quản trị: hub chỉ cho quản trị xem lời mời và duyệt người.
 */
export function MembersPage() {
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const { xem } = useSearch({ from: "/session/app/in-org/quan-tri/thanh-vien" });
  const admin = isOrgAdmin(org.role);
  const members = useQuery(api.orgMembers.list.queryOptions());
  const invitations = useQuery(api.invitations.list.queryOptions({ enabled: admin }));
  const [query, setQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const listed = members.data?.filter((m) => m.status !== "pending") ?? [];
  const pending = members.data?.filter((m) => m.status === "pending") ?? [];
  const shown = listed.filter((m) => matchesPerson(m, query));
  const activeCount = listed.filter((m) => m.status === "active").length;
  const openInvites = invitations.data?.filter((i) => i.status === "pending").length;
  const current: MembersTab = admin && xem ? xem : "dang-hoat-dong";

  return (
    <>
      <PageHeader crumb="Quản trị" title="Thành viên">
        <Input
          type="search"
          value={query}
          onValueChange={setQuery}
          placeholder="Tìm theo tên, email"
          aria-label="Tìm thành viên"
          className="w-55"
        />
        {canInvite(org.role) && (
          <Button variant="primary" onClick={() => setInviting(true)}>
            <Icon name="plus" />
            Mời người
          </Button>
        )}
      </PageHeader>
      <Tabs.Root
        value={current}
        onValueChange={(value: MembersTab) =>
          navigate({
            to: "/quan-tri/thanh-vien",
            search: value === "dang-hoat-dong" ? {} : { xem: value },
            replace: true,
          })
        }
      >
        <Tabs.List aria-label="Nhóm thành viên" className="flex gap-0.5 border-b border-line bg-surface px-6">
          <Tabs.Tab value="dang-hoat-dong" className={tab}>
            Đang hoạt động{members.data ? ` · ${activeCount}` : ""}
          </Tabs.Tab>
          {admin && (
            <>
              <Tabs.Tab value="loi-moi" className={tab}>
                Lời mời{openInvites !== undefined ? ` · ${openInvites}` : ""}
              </Tabs.Tab>
              <Tabs.Tab value="cho-duyet" className={tab}>
                Chờ duyệt{members.data ? ` · ${pending.length}` : ""}
              </Tabs.Tab>
            </>
          )}
        </Tabs.List>
        <Tabs.Panel value="dang-hoat-dong">
          <PageBody>
            {failure && <Alert>{failure}</Alert>}
            {members.isPending ? (
              <Loading />
            ) : members.isError ? (
              <Alert>{apiErrorMessage(members.error)}</Alert>
            ) : (
              <Card>
                <Table>
                  <thead>
                    <tr>
                      <Th>Người</Th>
                      <Th>Vai trò tổ chức</Th>
                      <Th>Đội</Th>
                      <Th>Tham gia</Th>
                      <Th>
                        <span className="sr-only">Thao tác</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((member) => (
                      <MemberRow key={member.userId} member={member} report={setFailure} />
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <Td colSpan={5} className="text-muted">
                          {query.trim() ? `Không có ai khớp với "${query.trim()}".` : "Chưa có thành viên nào."}
                        </Td>
                      </tr>
                    )}
                  </tbody>
                </Table>
              </Card>
            )}
          </PageBody>
        </Tabs.Panel>
        {admin && (
          <>
            <Tabs.Panel value="loi-moi">
              <PageBody>
                <InvitationsTab invitations={invitations} query={query} onInvite={() => setInviting(true)} />
              </PageBody>
            </Tabs.Panel>
            <Tabs.Panel value="cho-duyet">
              <PageBody>
                <PendingTab members={members} pending={pending.filter((m) => matchesPerson(m, query))} />
              </PageBody>
            </Tabs.Panel>
          </>
        )}
      </Tabs.Root>
      <Dialog open={inviting} onOpenChange={setInviting}>
        <DialogContent>
          <InviteForm
            title={<DialogTitle>Mời người vào tổ chức</DialogTitle>}
            cancelLabel="Huỷ"
            doneLabel="Đóng"
            onClose={() => setInviting(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function InvitationsTab({
  invitations,
  query,
  onInvite,
}: {
  invitations: UseQueryResult<Invitation[]>;
  query: string;
  onInvite: () => void;
}) {
  const [failure, setFailure] = useState<string | null>(null);
  if (invitations.isPending) return <Loading />;
  if (invitations.isError) return <Alert>{apiErrorMessage(invitations.error)}</Alert>;
  const q = query.trim();
  const shown = invitations.data.filter((i) => matchesPerson({ name: "", email: i.email }, q));
  if (invitations.data.length === 0)
    return (
      <Card className="grid justify-items-center gap-2 px-6 py-10 text-center">
        <h2 className="text-lg font-semibold text-ink">Chưa có lời mời nào</h2>
        <p className="max-w-md text-muted">
          Mời đồng nghiệp bằng email. Mỗi người nhận một link dùng một lần, hết hạn sau 7 ngày.
        </p>
        <Button variant="primary" className="mt-2" onClick={onInvite}>
          <Icon name="plus" />
          Mời người
        </Button>
      </Card>
    );
  return (
    <>
      {failure && <Alert>{failure}</Alert>}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Email</Th>
              <Th>Vai trò tổ chức</Th>
              <Th>Đội</Th>
              <Th>Trạng thái</Th>
              <Th>Hạn</Th>
              <Th>
                <span className="sr-only">Thao tác</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((inv) => (
              <InvitationRow key={inv.id} invitation={inv} report={setFailure} />
            ))}
            {shown.length === 0 && (
              <tr>
                <Td colSpan={6} className="text-muted">
                  Không có lời mời nào khớp với "{q}".
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

const STATUS_TONE: Record<InvitationStatus, NonNullable<PillProps["tone"]>> = {
  pending: "warn",
  accepted: "ok",
  expired: "neutral",
};

function InvitationRow({ invitation: inv, report }: { invitation: Invitation; report: (m: string | null) => void }) {
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.invitations.revoke.call({ invitationId: inv.id }),
    onMutate: () => report(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.invitations.key() }),
    onError: (e: unknown) => report(apiErrorMessage(e)),
  });
  return (
    <tr>
      <Td className="font-medium text-ink">{inv.email}</Td>
      <Td>{ORG_ROLE_LABEL[inv.orgRole]}</Td>
      <Td>
        {inv.teamId ? (
          <span className="inline-flex items-center gap-1">
            {inv.teamName ?? <span className="text-muted">Đội đã xoá</span>}
            {inv.teamRole && <Pill>{TEAM_ROLE_LABEL[inv.teamRole].toLowerCase()}</Pill>}
          </span>
        ) : (
          <span className="text-muted">—</span>
        )}
      </Td>
      <Td>
        <Pill tone={STATUS_TONE[inv.status]}>{INVITATION_STATUS_LABEL[inv.status]}</Pill>
      </Td>
      <Td className="whitespace-nowrap">
        {inv.status === "accepted" && inv.acceptedAt ? `Nhận ${formatDay(inv.acceptedAt)}` : formatDay(inv.expiresAt)}
      </Td>
      <Td className="text-right">
        {canRevoke(inv.status) && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Thu hồi lời mời cho ${inv.email}`}
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            Thu hồi
          </Button>
        )}
      </Td>
    </tr>
  );
}

function PendingTab({ members, pending }: { members: UseQueryResult<OrgMember[]>; pending: OrgMember[] }) {
  const [failure, setFailure] = useState<string | null>(null);
  if (members.isPending) return <Loading />;
  if (members.isError) return <Alert>{apiErrorMessage(members.error)}</Alert>;
  return (
    <>
      <p className="text-muted">
        Người đăng nhập SSO lần đầu bằng email của tổ chức chờ ở đây khi tổ chức chọn "Vào hàng chờ duyệt". Duyệt thì họ
        thành thành viên, chưa thuộc đội nào. Từ chối thì họ bị khoá, lần đăng nhập sau không vào lại hàng chờ.
      </p>
      {failure && <Alert>{failure}</Alert>}
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Người</Th>
              <Th>Đăng nhập lần đầu</Th>
              <Th>
                <span className="sr-only">Thao tác</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {pending.map((member) => (
              <PendingRow key={member.userId} member={member} report={setFailure} />
            ))}
            {pending.length === 0 && (
              <tr>
                <Td colSpan={3} className="text-muted">
                  Không có ai đang chờ duyệt.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

function PendingRow({ member, report }: { member: OrgMember; report: (message: string | null) => void }) {
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
  return (
    <tr>
      <Td>
        <Who person={member} extra={<Pill tone="warn">Chờ duyệt</Pill>} />
      </Td>
      <Td className="whitespace-nowrap">{formatDay(member.joinedAt)}</Td>
      <Td className="text-right whitespace-nowrap">
        <span className="inline-flex gap-1.5">
          <Button
            size="sm"
            aria-label={`Duyệt ${member.name}`}
            disabled={decide.isPending}
            onClick={() => decide.mutate("approve")}
          >
            Duyệt
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Từ chối ${member.name}`}
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
          >
            Từ chối
          </Button>
        </span>
      </Td>
    </tr>
  );
}

function MemberTeams({ teams }: { teams: OrgMember["teams"] }) {
  if (teams.length === 0) return <span className="text-muted">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {teams.map((t, i) => (
        <span key={t.teamId} className="inline-flex items-center gap-1">
          {t.name}
          {t.role === "admin" && <Pill>quản trị đội</Pill>}
          {i < teams.length - 1 && ","}
        </span>
      ))}
    </span>
  );
}

function MemberRow({ member, report }: { member: OrgMember; report: (message: string | null) => void }) {
  const me = useMe();
  const { org, api } = useOrg();
  const queryClient = useQueryClient();
  const handlers = {
    onMutate: () => report(null),
    // Đội và trang chủ không đổi theo vai trò tổ chức, nên chỉ cần tải lại danh sách thành viên.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.orgMembers.key() }),
    onError: (e: unknown) => report(apiErrorMessage(e)),
  };
  const setRole = useMutation({
    mutationFn: (role: OrgRole) => api.orgMembers.setRole.call({ userId: member.userId, role }),
    ...handlers,
  });
  const setStatus = useMutation({
    mutationFn: (status: "active" | "blocked") => api.orgMembers.setStatus.call({ userId: member.userId, status }),
    ...handlers,
  });
  const self = member.userId === me.id;
  const blocked = member.status === "blocked";
  const busy = setRole.isPending || setStatus.isPending;
  // Hiện ngay vai trò vừa chọn trong lúc chờ hub; lỗi thì quay về vai trò cũ.
  const role = setRole.isPending ? setRole.variables : member.role;

  return (
    <tr>
      <Td>
        <Who
          person={member}
          extra={
            <>
              {self && <small className="text-xs text-muted">(bạn)</small>}
              {blocked && <Pill tone="bad">Đã khoá</Pill>}
            </>
          }
        />
      </Td>
      <Td>
        {canSetOrgRole(org.role, self) ? (
          <Select
            size="sm"
            className="w-32.5"
            aria-label={`Vai trò tổ chức của ${member.name}`}
            value={role}
            disabled={busy}
            onChange={(e) => {
              const next = ORG_ROLES.find((r) => r === e.currentTarget.value);
              if (next) setRole.mutate(next);
            }}
          >
            {ORG_ROLES.map((r) => (
              <option key={r} value={r}>
                {ORG_ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        ) : (
          <Pill tone={member.role === "owner" ? "sel" : "neutral"}>{ORG_ROLE_LABEL[member.role]}</Pill>
        )}
      </Td>
      <Td>
        <MemberTeams teams={member.teams} />
      </Td>
      <Td className="whitespace-nowrap">{formatDay(member.joinedAt)}</Td>
      <Td className="text-right">
        {canSetStatus(org.role, member.role, self) && (
          <Button
            variant={blocked ? "default" : "ghost"}
            size="sm"
            aria-label={`${blocked ? "Mở khoá" : "Khoá"} ${member.name}`}
            disabled={busy}
            onClick={() => setStatus.mutate(blocked ? "active" : "blocked")}
          >
            {blocked ? "Mở khoá" : "Khoá"}
          </Button>
        )}
      </Td>
    </tr>
  );
}
