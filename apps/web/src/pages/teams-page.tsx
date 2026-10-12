import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { OrgMember, System, TeamMember, TeamRole, TeamWithCounts } from "@xdev-hive/contracts";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { InviteForm } from "../components/invite-form.tsx";
import { checkNameSlug, type NameSlugErrors, NameSlugFields } from "../components/name-slug-fields.tsx";
import { Who } from "../components/person.tsx";
import { Alert } from "../components/ui/alert.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { Dialog, DialogActions, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { Pill } from "../components/ui/pill.tsx";
import { Table, Td, Th } from "../components/ui/table.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { apiErrorMessage, formError } from "../lib/api-errors.ts";
import { cx } from "../lib/cx.ts";
import { canInvite } from "../lib/invites.ts";
import { canManageTeam, isOrgAdmin, TEAM_ROLE_LABEL, TEAM_ROLES } from "../lib/roles.ts";
import { nextTeamColor, teamColor, teamInitials } from "../lib/teams.ts";
import { useMe } from "../shell/me-context.ts";
import { useOrg } from "../shell/org-context.ts";
import { PageBody, PageHeader } from "../shell/page-header.tsx";

export interface TeamsSearch {
  /** Đội đang xem; không có thì xem đội đầu tiên. */
  doi?: string;
}

export function validateTeamsSearch(search: Record<string, unknown>): TeamsSearch {
  return typeof search.doi === "string" ? { doi: search.doi } : {};
}

/** Quyền của người đang xem với đội đang chọn; chỉ để ẩn nút, hub vẫn kiểm lại. */
type Access = "loading" | "none" | "view" | "manage";

function Loading() {
  return (
    <p aria-busy="true" className="text-muted-foreground">
      Đang tải…
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
      <PageHeader crumb="Quản trị" title="Đội và hệ thống">
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
            <h2 className="text-base font-semibold text-foreground">Chưa có đội nào</h2>
            <p className="max-w-md text-muted-foreground">
              {orgAdmin ? "Tạo đội đầu tiên để thêm hệ thống và người vào đội." : "Quản trị tổ chức chưa tạo đội nào."}
            </p>
          </Card>
        ) : (
          <div className="grid items-start gap-4 app:grid-cols-[280px_minmax(0,1fr)]">
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
      className="grid size-7.5 shrink-0 place-items-center rounded-md text-xs font-semibold text-white"
      // Màu là dữ liệu của từng đội nên đặt bằng style, không có sẵn token.
      style={{ backgroundColor: teamColor(team) }}
    >
      {teamInitials(team.name)}
    </span>
  );
}

function TeamList({ teams, selectedId }: { teams: TeamWithCounts[]; selectedId: string }) {
  return (
    <Card className="p-1.5">
      <nav aria-label="Danh sách đội" className="grid gap-0.5">
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
                  {team.systemCount} hệ thống · {team.memberCount} người
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
  const { api } = useOrg();
  const systems = useQuery(api.systems.list.queryOptions({ input: { teamId: team.id } }));
  const [adding, setAdding] = useState(false);
  return (
    <Card className="grid gap-3 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">Hệ thống của đội {team.name}</h2>
        {canManage && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            Hệ thống
          </Button>
        )}
      </div>
      {systems.isPending ? (
        <Loading />
      ) : systems.isError ? (
        <Alert variant="destructive">{apiErrorMessage(systems.error)}</Alert>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
          {systems.data.map((system) => (
            <SystemCard key={system.id} system={system} teamSlug={team.slug} />
          ))}
          {canManage ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="grid min-h-23 cursor-pointer place-items-center rounded-lg border border-dashed border-input text-muted-foreground hover:bg-muted"
            >
              <span className="flex items-center gap-1.5">
                <Icon name="plus" />
                Thêm hệ thống
              </span>
            </button>
          ) : (
            systems.data.length === 0 && <p className="text-muted-foreground">Đội chưa có hệ thống nào.</p>
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
  return (
    <div className="grid content-start gap-1.5 rounded-lg border border-border bg-card p-3">
      <b className="font-semibold text-foreground">{system.name}</b>
      <small className="line-clamp-2 text-xs text-muted-foreground">{system.description || "Chưa có mô tả"}</small>
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
      <DialogTitle>Thêm hệ thống vào đội {team.name}</DialogTitle>
      <NameSlugFields
        nameLabel="Tên hệ thống"
        namePlaceholder="Ví dụ: Cổng thanh toán"
        slugPrefix={`${team.slug}/`}
        slugPlaceholder="cong"
        slugHint="Dùng trong đường dẫn và trong lệnh của agent."
        errors={errors}
        disabled={create.isPending}
        autoFocus
      />
      <div className="grid gap-1.5">
        <label htmlFor={descriptionId} className="text-sm font-medium text-foreground">
          Mô tả
        </label>
        <Textarea
          id={descriptionId}
          name="description"
          maxLength={2000}
          placeholder="Hệ thống này làm gì, gồm những service nào"
          disabled={create.isPending}
        />
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={create.isPending}>
          {create.isPending ? "Đang thêm…" : "Thêm"}
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
  const { org, api } = useOrg();
  const canView = access === "view" || access === "manage";
  const manage = access === "manage";
  const members = useQuery(api.teamMembers.list.queryOptions({ input: { teamId: team.id }, enabled: canView }));
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  let body: ReactNode;
  if (access === "loading" || (canView && members.isPending)) body = <Loading />;
  else if (access === "none")
    body = <p className="text-muted-foreground">Bạn không ở trong đội này nên chưa xem được thành viên.</p>;
  else if (members.isError) body = <Alert variant="destructive">{apiErrorMessage(members.error)}</Alert>;
  else if (!members.data?.length) body = <p className="text-muted-foreground">Đội chưa có ai.</p>;
  else
    body = (
      <Table>
        <thead>
          <tr>
            <Th>Người</Th>
            <Th>Vai trò trong đội</Th>
            {manage && (
              <Th>
                <span className="sr-only">Thao tác</span>
              </Th>
            )}
          </tr>
        </thead>
        <tbody>
          {members.data.map((member) => (
            <TeamMemberRow key={member.userId} team={team} member={member} manage={manage} report={setFailure} />
          ))}
        </tbody>
      </Table>
    );

  return (
    <Card className="grid gap-3 px-4.5 py-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-base font-semibold text-foreground">Thành viên của đội</h2>
        {manage && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setAdding(true)}>
            Thêm người
          </Button>
        )}
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      {body}
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
            title={<DialogTitle>Mời người vào tổ chức</DialogTitle>}
            defaultTeamId={team.id}
            cancelLabel="Huỷ"
            doneLabel="Đóng"
            onClose={() => setInviting(false)}
          />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function TeamMemberRow({
  team,
  member,
  manage,
  report,
}: {
  team: TeamWithCounts;
  member: TeamMember;
  manage: boolean;
  report: (message: string | null) => void;
}) {
  const me = useMe();
  const { api } = useOrg();
  const refresh = useRefreshTeams();
  const handlers = {
    onMutate: () => report(null),
    onSuccess: refresh,
    onError: (e: unknown) => report(apiErrorMessage(e)),
  };
  const setRole = useMutation({
    mutationFn: (role: TeamRole) => api.teamMembers.setRole.call({ teamId: team.id, userId: member.userId, role }),
    ...handlers,
  });
  const remove = useMutation({
    mutationFn: () => api.teamMembers.remove.call({ teamId: team.id, userId: member.userId }),
    ...handlers,
  });
  const busy = setRole.isPending || remove.isPending;
  // Hiện ngay vai trò vừa chọn trong lúc chờ hub; lỗi thì quay về vai trò cũ.
  const role = setRole.isPending ? setRole.variables : member.role;
  const self = member.userId === me.id;
  return (
    <tr>
      <Td>
        <Who person={member} extra={self && <small className="text-xs text-muted-foreground">(bạn)</small>} />
      </Td>
      <Td>
        {manage ? (
          <NativeSelect
            size="sm"
            className="w-35"
            aria-label={`Vai trò của ${member.name} trong đội`}
            value={role}
            disabled={busy}
            onChange={(e) => {
              const next = TEAM_ROLES.find((r) => r === e.currentTarget.value);
              if (next) setRole.mutate(next);
            }}
          >
            {TEAM_ROLES.map((r) => (
              <option key={r} value={r}>
                {TEAM_ROLE_LABEL[r]}
              </option>
            ))}
          </NativeSelect>
        ) : (
          TEAM_ROLE_LABEL[member.role]
        )}
      </Td>
      {manage && (
        <Td className="text-right">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Gỡ ${member.name} khỏi đội`}
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            Gỡ khỏi đội
          </Button>
        </Td>
      )}
    </tr>
  );
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
      <DialogTitle>Thêm người vào đội {team.name}</DialogTitle>
      <DialogDescription>
        Chọn trong những người đã vào tổ chức.
        {onInvite && (
          <>
            {" "}
            Người chưa vào tổ chức thì{" "}
            <button
              type="button"
              onClick={onInvite}
              className="cursor-pointer font-medium text-primary hover:underline"
            >
              mời bằng email
            </button>
            .
          </>
        )}
      </DialogDescription>
      {!orgMembers ? (
        <p aria-busy="true" className="text-muted-foreground">
          Đang tải…
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground">Mọi người đang hoạt động trong tổ chức đều đã ở trong đội này.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3.5 app:grid-cols-[minmax(0,1fr)_160px]">
          <div className="grid gap-1.5">
            <label htmlFor={personId} className="text-sm font-medium text-foreground">
              Người
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
              Vai trò trong đội
            </label>
            <NativeSelect id={roleId} name="role" defaultValue="member" disabled={add.isPending}>
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {TEAM_ROLE_LABEL[r]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      )}
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={add.isPending || candidates.length === 0}>
          {add.isPending ? "Đang thêm…" : "Thêm"}
        </Button>
      </DialogActions>
    </form>
  );
}

function CreateTeamDialog({ teamCount, members }: { teamCount: number; members: OrgMember[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="default" onClick={() => setOpen(true)}>
        <Icon name="plus" />
        Tạo đội
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
      <DialogTitle>Tạo đội</DialogTitle>
      <NameSlugFields
        nameLabel="Tên đội"
        namePlaceholder="Ví dụ: Thanh toán"
        slugPlaceholder="thanh-toan"
        slugHint="Dùng trong đường dẫn và tên hệ thống."
        errors={errors}
        disabled={create.isPending}
        autoFocus
      />
      <div className="grid gap-1.5">
        <label htmlFor={adminId} className="text-sm font-medium text-foreground">
          Quản trị đội
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
          <option value="">Chưa chọn</option>
        </NativeSelect>
      </div>
      {failure && <Alert variant="destructive">{failure}</Alert>}
      <DialogActions>
        <Button variant="outline" onClick={onDone}>
          Huỷ
        </Button>
        <Button type="submit" variant="default" disabled={create.isPending}>
          {create.isPending ? "Đang tạo…" : "Tạo đội"}
        </Button>
      </DialogActions>
    </form>
  );
}
