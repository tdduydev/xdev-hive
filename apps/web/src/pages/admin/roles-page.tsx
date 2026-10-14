import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import {
  type CustomRole,
  DANGEROUS_PERMISSIONS,
  PERMISSION_TREE,
  PERMISSIONS,
  type PermissionNode,
  type SystemRoleId,
} from "@xdev-hive/contracts";
import { Alert } from "@xdev-hive/ui/alert";
import { Button } from "@xdev-hive/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@xdev-hive/ui/dialog";
import { Input } from "@xdev-hive/ui/input";
import { NativeSelect } from "@xdev-hive/ui/native-select";
import { Pill } from "@xdev-hive/ui/pill";
import { Textarea } from "@xdev-hive/ui/textarea";
import { ChevronRightIcon, EllipsisIcon, LockIcon, PlusIcon, SearchXIcon, UsersIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useMemo, useState } from "react";
import { DataTable } from "@/components/data-table/data-table.tsx";
import { DangerZone } from "@/components/page/danger-zone.tsx";
import { FilterBar, FilterSearch } from "@/components/page/filter-bar.tsx";
import { SegmentedControl } from "@/components/page/segmented-control.tsx";
import { type SectionSave, SettingsNav, SettingsSection } from "@/components/page/settings.tsx";
import { UnsavedChangesGuard } from "@/components/page/unsaved-guard.tsx";
import { Who } from "@/components/person.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { EmptyState, LoadFailure, SectionsSkeleton, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { cx } from "@/lib/cx.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { PERMISSION_LABEL, SYSTEM_ROLE_TEXT, usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import type { RoleTab } from "@/lib/route-search.ts";
import { useOrg } from "@/shell/org-context.ts";
import { DetailHeader, PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  lead: string;
  newRole: string;
  loading: string;
  roleCol: string;
  scopeCol: string;
  kindCol: string;
  assignedCol: string;
  permsCol: string;
  actions: string;
  kinds: Record<"system" | "custom", string>;
  search: string;
  moreFor: (name: string) => string;
  more: string;
  systemRole: string;
  perms: string;
  permsOf: (on: number, total: number) => string;
  peopleCount: (n: number) => string;
  assignedCount: (n: number) => string;
  permSearch: string;
  expandAll: string;
  collapseAll: string;
  onlyGranted: string;
  permFilter: string;
  groupsNav: string;
  systemNote: string;
  danger: string;
  groupOn: (on: number, total: number) => string;
  wholeGroup: (name: string) => string;
  savedRole: string;
  duplicate: string;
  edit: string;
  remove: string;
  removeTitle: (name: string) => string;
  removeBody: string;
  dangerHint: string;
  cancel: string;
  expand: string;
  collapse: string;
  name: string;
  description: string;
  scope: string;
  scopes: Record<"org" | "team", string>;
  scopeHint: string;
  copyFrom: string;
  copyNone: string;
  create: string;
  save: string;
  editTitle: string;
  dangerTitle: string;
  dangerBody: string;
  grant: string;
  tabsLabel: string;
  permsTab: string;
  peopleTab: string;
  assignTitle: (name: string) => string;
  assignTo: string;
  person: string;
  team: string;
  pickMember: string;
  pickTeam: string;
  assignRole: string;
  assign: string;
  unassign: string;
  unassignFor: (name: string) => string;
  unassignTitle: (role: string, who: string) => string;
  unassignBody: string;
  noAssigned: string;
  noAssignedHint: string;
  noAssignedReadOnly: string;
  whoCol: string;
  typeCol: string;
  teamCol: string;
  searchPeople: string;
  systemPeopleHint: string;
  noSystemPeople: string;
  noSystemPeopleHint: string;
  noMatch: string;
  noMatchHint: string;
  clearSearch: string;
  readOnly: string;
  notFound: string;
  backToList: string;
}> = {
  vi: {
    title: "Vai trò và quyền",
    lead: "Mỗi vai trò là một tập quyền. Bấm một vai trò để xem, sửa quyền và người đang có vai trò đó.",
    newRole: "Vai trò mới",
    loading: "Đang tải vai trò…",
    roleCol: "Vai trò",
    scopeCol: "Phạm vi",
    kindCol: "Loại",
    assignedCol: "Đang gán",
    permsCol: "Quyền",
    actions: "Thao tác",
    kinds: { system: "Hệ thống", custom: "Tự tạo" },
    search: "Tìm tên vai trò…",
    moreFor: (name) => `Thao tác khác cho ${name}`,
    more: "Thao tác khác",
    systemRole: "Vai trò hệ thống",
    perms: "Quyền",
    permsOf: (on, total) => `${on} / ${total} quyền`,
    peopleCount: (n) => `${n} người`,
    assignedCount: (n) => `Gán cho ${n} người hoặc đội`,
    permSearch: "Tìm quyền…",
    expandAll: "Mở hết",
    collapseAll: "Thu gọn",
    onlyGranted: "Chỉ hiện quyền đang bật",
    permFilter: "Lọc quyền",
    groupsNav: "Các nhóm quyền",
    systemNote: "Vai trò hệ thống không sửa được. Nhân bản thành vai trò mới nếu cần tập quyền khác.",
    danger: "nhạy cảm",
    groupOn: (on, total) => `Đang bật ${on} / ${total} quyền. Bật một nhánh là bật mọi quyền con của nhánh đó.`,
    wholeGroup: (name) => `Cả nhóm ${name}`,
    savedRole: "Đã lưu. Áp dụng ngay cho mọi người có vai trò này.",
    duplicate: "Nhân bản",
    edit: "Sửa tên",
    remove: "Xoá vai trò",
    removeTitle: (name) => `Xoá vai trò ${name}?`,
    removeBody: "Vai trò bị xoá hẳn. Vai trò còn gán cho người hoặc đội thì hub từ chối: gỡ hết ở tab Người trước.",
    dangerHint: "Xoá vai trò không hoàn tác được. Chỉ xoá được khi không còn gán cho ai.",
    cancel: "Huỷ",
    expand: "Mở ",
    collapse: "Thu gọn ",
    name: "Tên vai trò",
    description: "Mô tả",
    scope: "Phạm vi",
    scopes: { org: "Tổ chức", team: "Đội" },
    scopeHint: "Vai trò tổ chức gán được cho người hoặc đội; vai trò đội chỉ gán cho đội và có hiệu lực trong đội đó.",
    copyFrom: "Bắt đầu từ",
    copyNone: "Trống",
    create: "Tạo vai trò",
    save: "Lưu",
    editTitle: "Sửa vai trò",
    dangerTitle: "Bật quyền nhạy cảm?",
    dangerBody: "Các quyền sau cho phép thao tác ảnh hưởng cả tổ chức. Chỉ bật khi thật cần:",
    grant: "Bật quyền",
    tabsLabel: "Phần của vai trò",
    permsTab: "Quyền",
    peopleTab: "Người có vai trò này",
    assignTitle: (name) => `Gán vai trò ${name}`,
    assignTo: "Gán cho",
    person: "Người",
    team: "Đội",
    pickMember: "Chọn thành viên…",
    pickTeam: "Chọn đội…",
    assignRole: "Gán vai trò",
    assign: "Gán",
    unassign: "Gỡ",
    unassignFor: (name) => `Gỡ vai trò khỏi ${name}`,
    unassignTitle: (role, who) => `Gỡ vai trò ${role} khỏi ${who}?`,
    unassignBody: "Quyền của vai trò này mất hiệu lực ngay với người hoặc đội đó.",
    noAssigned: "Chưa gán cho ai",
    noAssignedHint: "Gán vai trò cho người hoặc đội để họ có các quyền ở tab Quyền.",
    noAssignedReadOnly: "Vai trò này chưa gán cho người hay đội nào.",
    whoCol: "Người hoặc đội",
    typeCol: "Loại",
    teamCol: "Đội",
    searchPeople: "Tìm tên, email…",
    systemPeopleHint: "Vai trò hệ thống đổi ở trang Thành viên hoặc trang của đội.",
    noSystemPeople: "Chưa có ai",
    noSystemPeopleHint: "Chưa thành viên nào có vai trò này.",
    noMatch: "Không có quyền nào khớp",
    noMatchHint: "Thử từ khoá khác, hoặc bỏ lọc “Chỉ hiện quyền đang bật”.",
    clearSearch: "Xoá bộ lọc",
    readOnly: "Bạn chỉ xem được vai trò; cần quyền tạo và sửa vai trò để thay đổi.",
    notFound: "Không tìm thấy vai trò này. Vai trò có thể đã bị xoá.",
    backToList: "Về danh sách vai trò",
  },
  en: {
    title: "Roles & permissions",
    lead: "A role is a set of permissions. Open a role to see and edit its permissions and who has it.",
    newRole: "New role",
    loading: "Loading roles…",
    roleCol: "Role",
    scopeCol: "Scope",
    kindCol: "Type",
    assignedCol: "Assigned",
    permsCol: "Permissions",
    actions: "Actions",
    kinds: { system: "System", custom: "Custom" },
    search: "Search role names…",
    moreFor: (name) => `More actions for ${name}`,
    more: "More actions",
    systemRole: "System role",
    perms: "Permissions",
    permsOf: (on, total) => `${on} / ${total} permissions`,
    peopleCount: (n) => `${n} ${n === 1 ? "person" : "people"}`,
    assignedCount: (n) => `Assigned to ${n} ${n === 1 ? "person or team" : "people or teams"}`,
    permSearch: "Search permissions…",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    onlyGranted: "Only granted",
    permFilter: "Filter permissions",
    groupsNav: "Permission groups",
    systemNote: "System roles cannot be edited. Duplicate one into a new role for a different set.",
    danger: "sensitive",
    groupOn: (on, total) => `${on} of ${total} granted. Checking a branch grants every permission under it.`,
    wholeGroup: (name) => `All of ${name}`,
    savedRole: "Saved. Applies immediately to everyone with this role.",
    duplicate: "Duplicate",
    edit: "Rename",
    remove: "Delete role",
    removeTitle: (name) => `Delete the ${name} role?`,
    removeBody:
      "The role is deleted for good. The hub refuses while it is still assigned: remove everyone on the People tab first.",
    dangerHint: "Deleting a role cannot be undone. Only roles nobody has can be deleted.",
    cancel: "Cancel",
    expand: "Expand ",
    collapse: "Collapse ",
    name: "Role name",
    description: "Description",
    scope: "Scope",
    scopes: { org: "Organization", team: "Team" },
    scopeHint: "Organization roles go to people or teams; team roles only go to teams and apply inside that team.",
    copyFrom: "Start from",
    copyNone: "Empty",
    create: "Create role",
    save: "Save",
    editTitle: "Edit role",
    dangerTitle: "Grant sensitive permissions?",
    dangerBody: "These permissions affect the whole organization. Grant them only when needed:",
    grant: "Grant",
    tabsLabel: "Role sections",
    permsTab: "Permissions",
    peopleTab: "People with this role",
    assignTitle: (name) => `Assign the ${name} role`,
    assignTo: "Assign to",
    person: "Person",
    team: "Team",
    pickMember: "Pick a member…",
    pickTeam: "Pick a team…",
    assignRole: "Assign role",
    assign: "Assign",
    unassign: "Remove",
    unassignFor: (name) => `Remove the role from ${name}`,
    unassignTitle: (role, who) => `Remove the ${role} role from ${who}?`,
    unassignBody: "The role's permissions stop applying to that person or team at once.",
    noAssigned: "Not assigned yet",
    noAssignedHint: "Assign the role to people or teams to give them the permissions on the Permissions tab.",
    noAssignedReadOnly: "Nobody has this role yet.",
    whoCol: "Person or team",
    typeCol: "Type",
    teamCol: "Team",
    searchPeople: "Search name, email…",
    systemPeopleHint: "System roles are changed on the Members page or the team's page.",
    noSystemPeople: "Nobody yet",
    noSystemPeopleHint: "No member has this role yet.",
    noMatch: "No permission matches",
    noMatchHint: "Try another keyword, or clear “Only granted”.",
    clearSearch: "Clear filters",
    readOnly: "You can view roles; creating and editing them needs the roles permission.",
    notFound: "This role was not found. It may have been deleted.",
    backToList: "Back to roles",
  },
};

const SYSTEM_IDS: SystemRoleId[] = ["owner", "admin", "member", "team-admin", "team-member", "team-viewer"];
const DANGER = new Set(DANGEROUS_PERMISSIONS);
/** Vai trò đội hệ thống ứng với vai trò trong đội của thành viên (orgMembers trả `teams[].role`). */
const TEAM_ROLE_OF: Partial<Record<SystemRoleId, string>> = {
  "team-admin": "admin",
  "team-member": "member",
  "team-viewer": "viewer",
};

type SystemView = { id: SystemRoleId; scope: "org" | "team"; permissions: string[]; memberCount: number };
type Selected = { kind: "system"; role: SystemView } | { kind: "custom"; role: CustomRole };
type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  scope: "org" | "team";
  system: boolean;
  assigned: number;
  perms: number;
  selected: Selected;
};

function leafKeys(node: PermissionNode): string[] {
  return node.children ? node.children.flatMap(leafKeys) : [node.key];
}

const branchKeys = (nodes: readonly PermissionNode[]): string[] =>
  nodes.flatMap((n) => (n.children ? [n.key, ...branchKeys(n.children)] : []));

/** Mỗi nhóm gốc của cây quyền là một mục lưu riêng; quyền lá thuộc đúng một nhóm. */
const GROUP_LEAVES = new Map(PERMISSION_TREE.map((g) => [g.key, leafKeys(g)]));
const GROUP_OF = new Map(PERMISSION_TREE.flatMap((g) => leafKeys(g).map((k) => [k, g.key] as const)));

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k) => b.includes(k));

function useRoleName() {
  const lang = useLang();
  return (selected: Selected) =>
    selected.kind === "system" ? SYSTEM_ROLE_TEXT[selected.role.id].name[lang] : selected.role.name;
}

function useCanWrite() {
  const { org } = useOrg();
  const can = usePermissions();
  return isOrgAdmin(org.role) || can("roles.write");
}

type RoleDialogState =
  | { kind: "create"; copyOf?: SystemRoleId }
  | { kind: "edit"; role: CustomRole }
  | { kind: "remove"; role: CustomRole }
  | null;

/**
 * /admin/roles: danh sách vai trò (admin-layout.md § Decisions 2). Bấm dòng mở trang của vai trò; nút ⋯ nhân bản,
 * sửa tên hay xoá ngay từ danh sách, có hỏi lại trước khi xoá.
 */
export function RolesPage() {
  const t = useT(text);
  const { api } = useOrg();
  const lang = useLang();
  const navigate = useNavigate();
  const canWrite = useCanWrite();
  const list = useQuery(api.roles.list.queryOptions());
  const [dialog, setDialog] = useState<RoleDialogState>(null);
  const open = (id: string) => navigate({ to: "/admin/roles/$roleId", params: { roleId: id } });
  const total = PERMISSIONS.length;

  let body: ReactNode;
  if (list.isPending) body = <TableSkeleton label={t.loading} columns={5} rows={8} />;
  else if (list.isError) body = <LoadFailure error={list.error} retry={() => list.refetch()} />;
  else {
    const rows: RoleRow[] = [
      ...list.data.system.map((role) => ({
        id: role.id,
        name: SYSTEM_ROLE_TEXT[role.id].name[lang],
        description: SYSTEM_ROLE_TEXT[role.id].desc[lang],
        scope: role.scope,
        system: true,
        assigned: role.memberCount,
        perms: role.permissions.length,
        selected: { kind: "system" as const, role },
      })),
      ...list.data.custom.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        scope: role.scope,
        system: false,
        assigned: role.assignments.length,
        perms: role.permissions.length,
        selected: { kind: "custom" as const, role },
      })),
    ];
    body = (
      <DataTable
        rows={rows}
        rowLabel={(row) => row.name}
        placeholder={t.search}
        onRowClick={(row) => void open(row.id)}
        pageSize={20}
        minWidth={640}
        facets={[
          {
            key: "kind",
            label: t.kindCol,
            value: (row) => (row.system ? "system" : "custom"),
            options: [
              { value: "system", label: t.kinds.system },
              { value: "custom", label: t.kinds.custom },
            ],
          },
          {
            key: "scope",
            label: t.scopeCol,
            value: (row) => row.scope,
            options: [
              { value: "org", label: t.scopes.org },
              { value: "team", label: t.scopes.team },
            ],
          },
        ]}
        columns={[
          {
            key: "name",
            label: t.roleCol,
            value: (row) => `${row.name} ${row.description ?? ""}`,
            sortable: true,
            hideable: false,
            pin: "start",
            cell: (row) => (
              <span className="grid min-w-0 max-w-96">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Link
                    to="/admin/roles/$roleId"
                    params={{ roleId: row.id }}
                    className="truncate font-medium text-foreground hover:underline"
                  >
                    {row.name}
                  </Link>
                  {row.system && (
                    <LockIcon aria-label={t.systemRole} className="size-3 shrink-0 text-muted-foreground" />
                  )}
                </span>
                {row.description && (
                  <span className="truncate text-xs text-muted-foreground" title={row.description}>
                    {row.description}
                  </span>
                )}
              </span>
            ),
          },
          {
            key: "kind",
            label: t.kindCol,
            value: (row) => (row.system ? t.kinds.system : t.kinds.custom),
            sortable: true,
            cell: (row) => (
              <Pill tone={row.system ? "neutral" : "sel"}>{row.system ? t.kinds.system : t.kinds.custom}</Pill>
            ),
          },
          {
            key: "scope",
            label: t.scopeCol,
            value: (row) => t.scopes[row.scope],
            sortable: true,
          },
          { key: "assigned", label: t.assignedCol, value: (row) => row.assigned, sortable: true, align: "end" },
          {
            key: "perms",
            label: t.permsCol,
            value: (row) => row.perms,
            sortable: true,
            align: "end",
            cell: (row) => (
              <span className="text-foreground">
                {row.perms} <span className="text-muted-foreground">/ {total}</span>
              </span>
            ),
          },
          ...(canWrite
            ? [
                {
                  key: "actions",
                  label: t.actions,
                  value: () => null,
                  hideable: false,
                  align: "end" as const,
                  cell: (row: RoleRow) => (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="icon-sm" aria-label={t.moreFor(row.name)} />}
                      >
                        <EllipsisIcon aria-hidden="true" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="min-w-40">
                        {row.selected.kind === "system" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              row.selected.kind === "system" &&
                              setDialog({ kind: "create", copyOf: row.selected.role.id })
                            }
                          >
                            {t.duplicate}
                          </DropdownMenuItem>
                        ) : (
                          <>
                            <DropdownMenuItem
                              onClick={() =>
                                row.selected.kind === "custom" && setDialog({ kind: "edit", role: row.selected.role })
                              }
                            >
                              {t.edit}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                row.selected.kind === "custom" && setDialog({ kind: "remove", role: row.selected.role })
                              }
                            >
                              {t.remove}
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ),
                },
              ]
            : []),
        ]}
      />
    );
  }

  return (
    <>
      <PageHeader title={t.title} description={t.lead}>
        {canWrite && (
          <Button onClick={() => setDialog({ kind: "create" })}>
            <PlusIcon aria-hidden="true" />
            {t.newRole}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        {!canWrite && <ReadOnlyNote>{t.readOnly}</ReadOnlyNote>}
        {body}
      </PageBody>
      <RoleDialogs dialog={dialog} onClose={() => setDialog(null)} onCreated={(id) => void open(id)} />
    </>
  );
}

function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-sm text-foreground">
      {children}
    </p>
  );
}

function RoleDialogs({
  dialog,
  onClose,
  onCreated,
  onRemoved,
}: {
  dialog: RoleDialogState;
  onClose: () => void;
  onCreated?: (id: string) => void;
  onRemoved?: () => void;
}) {
  if (!dialog) return null;
  if (dialog.kind === "remove") return <RemoveRoleDialog role={dialog.role} onClose={onClose} onRemoved={onRemoved} />;
  return (
    <RoleDialog
      copyOf={dialog.kind === "create" ? dialog.copyOf : undefined}
      {...(dialog.kind === "edit" ? { role: dialog.role } : {})}
      onClose={onClose}
      onSaved={(id) => {
        onClose();
        if (dialog.kind === "create") onCreated?.(id);
      }}
    />
  );
}

function RemoveRoleDialog({
  role,
  onClose,
  onRemoved,
}: {
  role: CustomRole;
  onClose: () => void;
  onRemoved?: (() => void) | undefined;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.roles.remove.call({ roleId: role.id }),
    onSuccess: async () => {
      onClose();
      onRemoved?.();
      await queryClient.invalidateQueries({ queryKey: api.roles.key() });
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.removeTitle(role.name)}</DialogTitle>
          <DialogDescription>{t.removeBody}</DialogDescription>
        </DialogHeader>
        {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
        <DialogActions>
          <Button variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {t.remove}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  copyOf,
  role,
  onClose,
  onSaved,
}: {
  copyOf?: SystemRoleId | undefined;
  role?: CustomRole;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const ids = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? (copyOf ? `${SYSTEM_ROLE_TEXT[copyOf].name[lang]} (2)` : ""));
  const [description, setDescription] = useState(role?.description ?? "");
  const [scope, setScope] = useState<"org" | "team">(role?.scope ?? (copyOf?.startsWith("team-") ? "team" : "org"));
  const [from, setFrom] = useState<SystemRoleId | "">(copyOf ?? "");
  const save = useMutation({
    mutationFn: () =>
      role
        ? api.roles.update.call({ roleId: role.id, name, description })
        : api.roles.create.call({
            name,
            description,
            scope,
            permissions: [],
            ...(from ? { copyOf: from } : {}),
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: api.roles.key() });
      onSaved(saved.id);
    },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{role ? t.editTitle : t.newRole}</DialogTitle>
            {!role && <DialogDescription>{t.scopeHint}</DialogDescription>}
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${ids}-name`}>{t.name}</FieldLabel>
            <Input id={`${ids}-name`} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-desc`}>{t.description}</FieldLabel>
            <Textarea
              id={`${ids}-desc`}
              maxLength={500}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          {!role && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${ids}-scope`}>{t.scope}</FieldLabel>
                <NativeSelect
                  id={`${ids}-scope`}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "org" | "team")}
                >
                  <option value="org">{t.scopes.org}</option>
                  <option value="team">{t.scopes.team}</option>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${ids}-from`}>{t.copyFrom}</FieldLabel>
                <NativeSelect
                  id={`${ids}-from`}
                  value={from}
                  onChange={(e) => setFrom(e.target.value as SystemRoleId | "")}
                >
                  <option value="">{t.copyNone}</option>
                  {SYSTEM_IDS.map((id) => (
                    <option key={id} value={id}>
                      {SYSTEM_ROLE_TEXT[id].name[lang]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
          )}
          {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {role ? t.save : t.create}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * /admin/roles/$roleId: trang của một vai trò (admin-layout.md § Decisions 3). Tab Quyền (mặc định, mỗi nhóm quyền
 * lưu riêng, vùng nguy hiểm ở cuối) và tab Người (`?tab=nguoi`).
 */
export function RoleDetailPage() {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const lang = useLang();
  const roleName = useRoleName();
  const canWrite = useCanWrite();
  const { roleId } = useParams({ from: "/session/app/in-org/admin/roles/$roleId" });
  const { tab = "quyen" } = useSearch({ from: "/session/app/in-org/admin/roles/$roleId" });
  const list = useQuery(api.roles.list.queryOptions());
  const [dialog, setDialog] = useState<RoleDialogState>(null);

  const system = list.data?.system.find((r) => r.id === roleId);
  const custom = list.data?.custom.find((r) => r.id === roleId);
  const selected: Selected | null = system
    ? { kind: "system", role: system }
    : custom
      ? { kind: "custom", role: custom }
      : null;

  if (!selected)
    return (
      <>
        <PageHeader title={t.title} width="wide" />
        <PageBody width="wide">
          {list.isPending ? (
            <SectionsSkeleton label={t.loading} />
          ) : list.isError ? (
            <LoadFailure error={list.error} retry={() => list.refetch()} />
          ) : (
            <>
              <Alert variant="destructive">{t.notFound}</Alert>
              <Link to="/admin/roles" className="w-fit text-primary hover:text-primary/90">
                {t.backToList}
              </Link>
            </>
          )}
        </PageBody>
      </>
    );

  const name = roleName(selected);
  const isSystem = selected.kind === "system";
  const desc = isSystem ? SYSTEM_ROLE_TEXT[selected.role.id].desc : null;
  const description = desc ? desc[lang] : selected.kind === "custom" ? selected.role.description : null;
  const assigned = isSystem ? selected.role.memberCount : selected.role.assignments.length;
  return (
    <>
      <DetailHeader
        back={{ to: "/admin/roles", label: t.title }}
        title={name}
        status={
          isSystem ? (
            <Pill>
              <LockIcon aria-hidden="true" className="size-3" />
              {t.systemRole}
            </Pill>
          ) : (
            <Pill tone="sel">{t.kinds.custom}</Pill>
          )
        }
        meta={
          <>
            <span>
              {t.scope}: {t.scopes[selected.role.scope]}
            </span>
            <span>{isSystem ? t.peopleCount(assigned) : t.assignedCount(assigned)}</span>
            <span>{t.permsOf(selected.role.permissions.length, PERMISSIONS.length)}</span>
            {description && <span className="basis-full text-sm">{description}</span>}
          </>
        }
      >
        {canWrite && selected.kind === "system" && (
          <Button onClick={() => setDialog({ kind: "create", copyOf: selected.role.id })}>{t.duplicate}</Button>
        )}
        {canWrite && selected.kind === "custom" && (
          <Button variant="outline" onClick={() => setDialog({ kind: "edit", role: selected.role })}>
            {t.edit}
          </Button>
        )}
      </DetailHeader>
      <Tabs.Root
        value={tab}
        onValueChange={(value: RoleTab | "quyen") =>
          navigate({
            to: "/admin/roles/$roleId",
            params: { roleId },
            search: value === "quyen" ? {} : { tab: value },
            replace: true,
          })
        }
      >
        <PageTabList label={t.tabsLabel}>
          <PageTab value="quyen">{t.permsTab}</PageTab>
          <PageTab value="nguoi" count={assigned}>
            {t.peopleTab}
          </PageTab>
        </PageTabList>
        <PageBody width="wide">
          <Tabs.Panel value="quyen" className="grid min-w-0 gap-4">
            <PermissionsTab
              key={selected.role.id}
              selected={selected}
              canWrite={canWrite}
              onRemove={
                selected.kind === "custom" ? () => setDialog({ kind: "remove", role: selected.role }) : undefined
              }
            />
          </Tabs.Panel>
          <Tabs.Panel value="nguoi" className="grid min-w-0 gap-4">
            {selected.kind === "custom" ? (
              <AssignmentsTab role={selected.role} canWrite={canWrite} />
            ) : (
              <SystemPeopleTab role={selected.role} />
            )}
          </Tabs.Panel>
        </PageBody>
      </Tabs.Root>
      <RoleDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        onCreated={(id) => void navigate({ to: "/admin/roles/$roleId", params: { roleId: id } })}
        onRemoved={() => void navigate({ to: "/admin/roles" })}
      />
    </>
  );
}

function PermissionsTab({
  selected,
  canWrite,
  onRemove,
}: {
  selected: Selected;
  canWrite: boolean;
  onRemove: (() => void) | undefined;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const queryClient = useQueryClient();
  const system = selected.kind === "system";
  const locked = system || !canWrite;
  const original = selected.role.permissions;
  // Chỉ nhóm đã sửa có bản nháp; nhóm khác luôn theo hub, nên lưu một nhóm xong thì nhóm khác vẫn đúng bản mới nhất.
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [results, setResults] = useState<Record<string, { done?: true; failure?: string }>>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set(branchKeys(PERMISSION_TREE)));
  const [q, setQ] = useState("");
  const [onlyGranted, setOnlyGranted] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState<string[] | null>(null);

  const savedIn = (group: string) => (GROUP_LEAVES.get(group) ?? []).filter((k) => original.includes(k));
  const grantedIn = (group: string) => edits[group] ?? savedIn(group);
  const draft = new Set(PERMISSION_TREE.flatMap((g) => grantedIn(g.key)));
  const isDirty = (group: string) => edits[group] !== undefined && !sameSet(edits[group], savedIn(group));
  const anyDirty = PERMISSION_TREE.some((g) => isDirty(g.key));

  const save = useMutation({
    mutationFn: ({ group }: { group: string }) => {
      const mine = new Set(grantedIn(group));
      return api.roles.update.call({
        roleId: selected.role.id,
        permissions: PERMISSIONS.filter((k) => (GROUP_OF.get(k) === group ? mine.has(k) : original.includes(k))),
      });
    },
    onSuccess: async (role, { group }) => {
      // Ghi bản hub trả vào cache trước khi bỏ nháp, để nhóm vừa lưu không nháy về giá trị cũ trong lúc tải lại.
      queryClient.setQueryData(api.roles.list.queryKey(), (old) =>
        old ? { ...old, custom: old.custom.map((r) => (r.id === role.id ? role : r)) } : old,
      );
      setEdits(({ [group]: _, ...rest }) => rest);
      setResults((r) => ({ ...r, [group]: { done: true } }));
      await queryClient.invalidateQueries({ queryKey: api.roles.key() });
    },
    onError: (error, { group }) => setResults((r) => ({ ...r, [group]: { failure: apiErrorMessage(error) } })),
  });

  function setLeaves(keys: string[], on: boolean) {
    if (on && keys.some((k) => DANGER.has(k) && !draft.has(k))) {
      setConfirmDanger(keys);
      return;
    }
    apply(keys, on);
  }
  function apply(keys: string[], on: boolean) {
    const byGroup = new Map<string, string[]>();
    for (const k of keys) {
      const g = GROUP_OF.get(k);
      if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), k]);
    }
    setResults((r) => {
      const next = { ...r };
      for (const g of byGroup.keys()) delete next[g];
      return next;
    });
    setEdits((e) => {
      const next = { ...e };
      for (const [g, changed] of byGroup) {
        const set = new Set(e[g] ?? savedIn(g));
        for (const k of changed) {
          if (on) set.add(k);
          else set.delete(k);
        }
        next[g] = [...set];
      }
      return next;
    });
  }

  const sectionSave = (group: string): SectionSave | undefined =>
    locked
      ? undefined
      : {
          dirty: isDirty(group),
          saving: save.isPending && save.variables?.group === group,
          disabled: save.isPending,
          saved: results[group]?.done === true,
          error: results[group]?.failure,
          savedLabel: t.savedRole,
          onSave: () => save.mutate({ group }),
          onDiscard: () => {
            setEdits(({ [group]: _, ...rest }) => rest);
            setResults(({ [group]: _, ...rest }) => rest);
          },
        };

  const label = (key: string) => PERMISSION_LABEL[key]?.[lang] ?? key;
  const query = q.trim().toLowerCase();
  const matches = (n: PermissionNode): boolean =>
    (!query ||
      label(n.key).toLowerCase().includes(query) ||
      n.key.includes(query) ||
      (n.children?.some(matches) ?? false)) &&
    (!onlyGranted || leafKeys(n).some((k) => draft.has(k)));

  type Row = { node: PermissionNode; level: number };
  const rowsOf = (group: PermissionNode) => {
    const rows: Row[] = [];
    const walk = (nodes: readonly PermissionNode[], level: number) => {
      for (const n of nodes) {
        if (!matches(n)) continue;
        rows.push({ node: n, level });
        if (n.children && (query || open.has(n.key))) walk(n.children, level + 1);
      }
    };
    walk(group.children ?? [], 1);
    return rows;
  };
  const groups = PERMISSION_TREE.map((g) => ({ group: g, rows: rowsOf(g) })).filter((g) => g.rows.length > 0);

  // Thanh mục dò lại vị trí mỗi khi danh sách đổi, nên chỉ dựng mảng mới khi tập nhóm đang hiện đổi.
  const visibleKeys = groups.map(({ group }) => group.key).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleKeys đại diện cho groups.
  const navItems = useMemo(
    () =>
      visibleKeys
        .split(",")
        .filter(Boolean)
        .map((key) => ({ id: `nhom-${key}`, label: PERMISSION_LABEL[key]?.[lang] ?? key })),
    [visibleKeys, lang],
  );

  const toggleState = (keys: string[]) => {
    const on = keys.filter((k) => draft.has(k)).length;
    return { on, state: on === 0 ? "false" : on === keys.length ? "true" : "mixed" };
  };

  return (
    <>
      <UnsavedChangesGuard when={anyDirty} />
      {system ? <ReadOnlyNote>{t.systemNote}</ReadOnlyNote> : !canWrite && <ReadOnlyNote>{t.readOnly}</ReadOnlyNote>}
      <FilterBar
        label={t.permFilter}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpen(new Set(branchKeys(PERMISSION_TREE)))}>
              {t.expandAll}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setOpen(new Set())}>
              {t.collapseAll}
            </Button>
          </>
        }
      >
        <FilterSearch value={q} onChange={setQ} placeholder={t.permSearch} />
        <label className="flex h-8 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyGranted}
            onChange={(e) => setOnlyGranted(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t.onlyGranted}
        </label>
      </FilterBar>

      {groups.length > 1 && <SettingsNav label={t.groupsNav} items={navItems} />}

      {groups.length === 0 && (
        <EmptyState
          compact
          icon={SearchXIcon}
          title={t.noMatch}
          description={t.noMatchHint}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQ("");
                setOnlyGranted(false);
              }}
            >
              {t.clearSearch}
            </Button>
          }
        />
      )}

      {groups.map(({ group, rows }) => {
        const keys = GROUP_LEAVES.get(group.key) ?? [];
        const { on, state } = toggleState(keys);
        return (
          <SettingsSection
            key={group.key}
            id={`nhom-${group.key}`}
            title={label(group.key)}
            description={t.groupOn(on, keys.length)}
            save={sectionSave(group.key)}
            actions={
              <TriCheckbox
                label={t.wholeGroup(label(group.key))}
                visibleLabel
                state={state}
                disabled={locked}
                onChange={() => setLeaves(keys, state !== "true")}
              />
            }
          >
            <ul aria-label={label(group.key)} className="m-0 grid list-none gap-0.5 p-0">
              {rows.map(({ node, level }) => {
                const leaves = leafKeys(node);
                const branch = toggleState(leaves);
                const isOpen = !!query || open.has(node.key);
                return (
                  <li
                    key={node.key}
                    className="flex min-h-8 items-center gap-2 rounded-md py-1 pr-1 hover:bg-muted/50"
                    style={{ paddingLeft: `${(level - 1) * 24}px` }}
                  >
                    {node.children ? (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-label={(isOpen ? t.collapse : t.expand) + label(node.key)}
                        onClick={() =>
                          setOpen((o) => {
                            const next = new Set(o);
                            if (next.has(node.key)) next.delete(node.key);
                            else next.add(node.key);
                            return next;
                          })
                        }
                        className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        <ChevronRightIcon
                          aria-hidden="true"
                          className={cx("size-3.5 transition-transform", isOpen && "rotate-90")}
                        />
                      </button>
                    ) : (
                      <span className="w-6 shrink-0" />
                    )}
                    <TriCheckbox
                      label={label(node.key)}
                      state={branch.state}
                      disabled={locked}
                      onChange={() => setLeaves(leaves, branch.state !== "true")}
                    />
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={cx(node.children && "font-medium")}>{label(node.key)}</span>
                      {node.danger && <Pill tone="bad">{t.danger}</Pill>}
                      {node.children && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {branch.on}/{leaves.length}
                        </span>
                      )}
                    </span>
                    {!node.children && (
                      <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{node.key}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </SettingsSection>
        );
      })}

      {onRemove && canWrite && (
        <DangerZone description={t.dangerHint}>
          <Button variant="destructive" onClick={onRemove}>
            {t.remove}
          </Button>
        </DangerZone>
      )}

      <Dialog open={!!confirmDanger} onOpenChange={(o) => !o && setConfirmDanger(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.dangerTitle}</DialogTitle>
            <DialogDescription>{t.dangerBody}</DialogDescription>
          </DialogHeader>
          <ul className="list-disc pl-5 text-sm">
            {confirmDanger
              ?.filter((k) => DANGER.has(k) && !draft.has(k))
              .map((k) => (
                <li key={k}>
                  {label(k)} <span className="font-mono text-xs text-muted-foreground">{k}</span>
                </li>
              ))}
          </ul>
          <DialogActions>
            <Button variant="outline" onClick={() => setConfirmDanger(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() => {
                if (confirmDanger) apply(confirmDanger, true);
                setConfirmDanger(null);
              }}
            >
              {t.grant}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Ô ba trạng thái: nhánh bật một phần thì trình duyệt đọc là "mixed" như ô của thiết kế. */
function TriCheckbox({
  label,
  visibleLabel = false,
  state,
  disabled,
  onChange,
}: {
  label: string;
  /** Hiện chữ cạnh ô (ô của cả nhóm); ô trong cây đã có chữ của dòng nên chỉ cần `aria-label`. */
  visibleLabel?: boolean;
  state: string;
  disabled: boolean;
  onChange: () => void;
}) {
  const id = useId();
  const input = (
    <input
      id={id}
      type="checkbox"
      aria-label={visibleLabel ? undefined : label}
      checked={state === "true"}
      ref={(el) => {
        if (el) el.indeterminate = state === "mixed";
      }}
      disabled={disabled}
      onChange={onChange}
      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-60"
    />
  );
  if (!visibleLabel) return input;
  return (
    <label
      htmlFor={id}
      className={cx(
        "flex items-center gap-2 text-sm text-muted-foreground",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
    >
      {input}
      {label}
    </label>
  );
}

type Assignment = CustomRole["assignments"][number];
type AssignmentRow = Assignment & { id: string };

function AssignmentsTab({ role, canWrite }: { role: CustomRole; canWrite: boolean }) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const [assigning, setAssigning] = useState(false);
  const [removing, setRemoving] = useState<Assignment | null>(null);
  const unassign = useMutation({
    mutationFn: (a: Assignment) =>
      api.roles.unassign.call({
        roleId: role.id,
        ...(a.kind === "member"
          ? { kind: "member" as const, userId: a.userId }
          : { kind: "team" as const, teamId: a.teamId }),
      }),
    onSuccess: async () => {
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: api.roles.key() });
    },
  });
  const rows: AssignmentRow[] = role.assignments.map((a) => ({
    ...a,
    id: a.kind === "member" ? `m:${a.userId}` : `t:${a.teamId}`,
  }));
  const assignButton = canWrite && (
    <Button size="sm" onClick={() => setAssigning(true)}>
      <PlusIcon aria-hidden="true" />
      {t.assignRole}
    </Button>
  );

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title={t.noAssigned}
          description={canWrite ? t.noAssignedHint : t.noAssignedReadOnly}
          action={assignButton}
        />
      ) : (
        <DataTable
          rows={rows}
          rowLabel={(row) => row.name}
          placeholder={t.searchPeople}
          minWidth={480}
          toolbar={assignButton}
          columns={[
            {
              key: "who",
              label: t.whoCol,
              value: (row) => `${row.name} ${row.kind === "member" ? row.email : ""}`,
              sortable: true,
              hideable: false,
              pin: "start",
              cell: (row) =>
                row.kind === "member" ? (
                  <Who person={{ name: row.name, email: row.email, image: null }} />
                ) : (
                  <span className="font-medium text-foreground">{row.name}</span>
                ),
            },
            {
              key: "type",
              label: t.typeCol,
              value: (row) => (row.kind === "member" ? t.person : t.team),
              sortable: true,
              cell: (row) => (
                <Pill tone={row.kind === "team" ? "sel" : "neutral"}>{row.kind === "member" ? t.person : t.team}</Pill>
              ),
            },
            ...(canWrite
              ? [
                  {
                    key: "actions",
                    label: t.unassign,
                    value: () => null,
                    hideable: false,
                    align: "end" as const,
                    cell: (row: AssignmentRow) => (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t.unassignFor(row.name)}
                        onClick={() => setRemoving(row)}
                      >
                        {t.unassign}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {assigning && <AssignDialog role={role} onClose={() => setAssigning(false)} />}
      <Dialog
        open={removing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setRemoving(null);
            unassign.reset();
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{removing && t.unassignTitle(role.name, removing.name)}</DialogTitle>
            <DialogDescription>{t.unassignBody}</DialogDescription>
          </DialogHeader>
          {unassign.isError && <Alert variant="destructive">{apiErrorMessage(unassign.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive-solid"
              disabled={unassign.isPending}
              onClick={() => removing && unassign.mutate(removing)}
            >
              {t.unassign}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AssignDialog({ role, onClose }: { role: CustomRole; onClose: () => void }) {
  const t = useT(text);
  const { api } = useOrg();
  const ids = useId();
  const queryClient = useQueryClient();
  // Vai trò phạm vi đội chỉ gán được cho đội.
  const [kind, setKind] = useState<"member" | "team">(role.scope === "org" ? "member" : "team");
  const [target, setTarget] = useState("");
  const members = useQuery({ ...api.orgMembers.list.queryOptions(), enabled: kind === "member" });
  const teams = useQuery({ ...api.teams.list.queryOptions(), enabled: kind === "team" });
  const assignedMembers = new Set(role.assignments.flatMap((a) => (a.kind === "member" ? [a.userId] : [])));
  const assignedTeams = new Set(role.assignments.flatMap((a) => (a.kind === "team" ? [a.teamId] : [])));
  const assign = useMutation({
    mutationFn: () =>
      api.roles.assign.call(
        kind === "member"
          ? { roleId: role.id, kind: "member", userId: target }
          : { roleId: role.id, kind: "team", teamId: target },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.roles.key() });
      onClose();
    },
  });
  const options = kind === "member" ? members : teams;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (target) assign.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t.assignTitle(role.name)}</DialogTitle>
            <DialogDescription>{t.scopeHint}</DialogDescription>
          </DialogHeader>
          {role.scope === "org" && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium text-foreground">{t.assignTo}</span>
              <SegmentedControl
                label={t.assignTo}
                value={kind}
                onChange={(v) => {
                  setKind(v);
                  setTarget("");
                }}
                options={[
                  { value: "member", label: t.person },
                  { value: "team", label: t.team },
                ]}
              />
            </div>
          )}
          <Field>
            <FieldLabel htmlFor={`${ids}-target`}>{kind === "member" ? t.person : t.team}</FieldLabel>
            <NativeSelect id={`${ids}-target`} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">{kind === "member" ? t.pickMember : t.pickTeam}</option>
              {kind === "member"
                ? members.data
                    ?.filter((m) => m.status === "active" && !assignedMembers.has(m.userId))
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} · {m.email}
                      </option>
                    ))
                : teams.data
                    ?.filter((team) => !assignedTeams.has(team.id))
                    .map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
            </NativeSelect>
          </Field>
          {options.isError && <LoadFailure error={options.error} retry={() => options.refetch()} />}
          {assign.isError && <Alert variant="destructive">{apiErrorMessage(assign.error)}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={!target || assign.isPending}>
              {t.assign}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type SystemPersonRow = { id: string; userId: string; name: string; email: string; image: string | null; team?: string };

/** Người có vai trò hệ thống: lấy từ danh sách thành viên (vai trò tổ chức, hoặc vai trò trong từng đội). */
function SystemPeopleTab({ role }: { role: SystemView }) {
  const t = useT(text);
  const { api } = useOrg();
  const navigate = useNavigate();
  const members = useQuery(api.orgMembers.list.queryOptions());
  const teamRole = TEAM_ROLE_OF[role.id];

  let body: ReactNode;
  if (members.isPending) body = <TableSkeleton label={t.loading} columns={2} rows={4} />;
  else if (members.isError) body = <LoadFailure error={members.error} retry={() => members.refetch()} />;
  else {
    const active = members.data.filter((m) => m.status === "active");
    const rows: SystemPersonRow[] = teamRole
      ? active.flatMap((m) =>
          m.teams
            .filter((x) => x.role === teamRole)
            .map((x) => ({
              id: `${m.userId}:${x.teamId}`,
              userId: m.userId,
              name: m.name,
              email: m.email,
              image: m.image,
              team: x.name,
            })),
        )
      : active
          .filter((m) => m.role === role.id)
          .map((m) => ({ id: m.userId, userId: m.userId, name: m.name, email: m.email, image: m.image }));
    body =
      rows.length === 0 ? (
        <EmptyState icon={UsersIcon} title={t.noSystemPeople} description={t.noSystemPeopleHint} />
      ) : (
        <DataTable
          rows={rows}
          rowLabel={(row) => (row.team ? `${row.name} · ${row.team}` : row.name)}
          placeholder={t.searchPeople}
          minWidth={teamRole ? 480 : 320}
          onRowClick={(row) => void navigate({ to: "/admin/members/$userId", params: { userId: row.userId } })}
          columns={[
            {
              key: "who",
              label: t.person,
              value: (row) => `${row.name} ${row.email}`,
              sortable: true,
              hideable: false,
              pin: "start",
              cell: (row) => <Who person={row} />,
            },
            ...(teamRole
              ? [{ key: "team", label: t.teamCol, value: (row: SystemPersonRow) => row.team ?? "", sortable: true }]
              : []),
          ]}
        />
      );
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">{t.systemPeopleHint}</p>
      {body}
    </>
  );
}
