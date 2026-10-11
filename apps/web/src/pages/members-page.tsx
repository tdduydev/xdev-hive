import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrgMember, OrgRole } from "@xdev-hive/contracts";
import { useState } from "react";
import { Icon } from "../components/icons.tsx";
import { Who } from "../components/person.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Input } from "../components/ui/input.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Select } from "../components/ui/select.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { apiErrorMessage } from "../lib/api-errors.ts";
import { formatDay } from "../lib/format.ts";
import { matchesPerson } from "../lib/people.ts";
import { canSetOrgRole, canSetStatus, ORG_ROLE_LABEL, ORG_ROLES } from "../lib/roles.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

const tab =
  "flex cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-label font-medium text-muted data-active:border-accent data-active:text-ink data-disabled:cursor-not-allowed data-disabled:opacity-60";

/**
 * Màn 4 của mockup. Tab "Lời mời" và "Chờ duyệt" chờ API lời mời, SSO (task M1c-invite-sso). Người bị khoá vẫn nằm
 * trong danh sách chính, có nhãn "Đã khoá", để mở khoá ngay tại chỗ.
 */
export function MembersPage() {
  const { api } = useOrg();
  const members = useQuery(api.orgMembers.list.queryOptions());
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const listed = members.data?.filter((m) => m.status !== "pending") ?? [];
  const shown = listed.filter((m) => matchesPerson(m, query));
  const activeCount = listed.filter((m) => m.status === "active").length;

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
        <Button variant="primary" disabled title="Sắp có">
          <Icon name="plus" />
          Mời người
          <Pill small>Sắp có</Pill>
        </Button>
      </PageHeader>
      <Tabs.Root defaultValue="active">
        <Tabs.List aria-label="Nhóm thành viên" className="flex gap-0.5 border-b border-line bg-surface px-6">
          <Tabs.Tab value="active" className={tab}>
            Đang hoạt động{members.data ? ` · ${activeCount}` : ""}
          </Tabs.Tab>
          <Tabs.Tab value="invites" disabled className={tab}>
            Lời mời <Pill small>Sắp có</Pill>
          </Tabs.Tab>
          <Tabs.Tab value="pending" disabled className={tab}>
            Chờ duyệt <Pill small>Sắp có</Pill>
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="active">
          <PageBody>
            {failure && <Alert>{failure}</Alert>}
            {members.isPending ? (
              <p aria-busy="true" className="text-muted">
                Đang tải…
              </p>
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
      </Tabs.Root>
    </>
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
