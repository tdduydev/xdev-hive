import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { ChevronRightIcon, LockIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useMemo, useState } from "react";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { PERMISSION_LABEL, SYSTEM_ROLE_TEXT, usePermissions } from "@/lib/permissions.ts";
import { isOrgAdmin } from "@/lib/roles.ts";
import { cn } from "@/lib/utils.ts";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  crumb: string;
  title: string;
  lead: string;
  newRole: string;
  roles: string;
  groups: Record<"org" | "team" | "custom", string>;
  systemRole: string;
  perms: string;
  meta: (people: number, perms: number) => string;
  search: string;
  expandAll: string;
  collapseAll: string;
  onlyGranted: string;
  systemNote: string;
  danger: string;
  applies: string;
  discard: string;
  save: string;
  saved: string;
  duplicate: string;
  edit: string;
  remove: string;
  removeTitle: string;
  removeBody: (name: string) => string;
  cancel: string;
  expand: string;
  collapse: string;
  noCustom: string;
  name: string;
  description: string;
  scope: string;
  scopes: Record<"org" | "team", string>;
  scopeHint: string;
  copyFrom: string;
  copyNone: string;
  create: string;
  editTitle: string;
  dangerTitle: string;
  dangerBody: string;
  grant: string;
  assigned: string;
  noAssigned: string;
  addMember: string;
  addTeam: string;
  pickMember: string;
  pickTeam: string;
  assign: string;
  unassign: (name: string) => string;
  teamLabel: string;
  noMatch: string;
  readOnly: string;
}> = {
  vi: {
    crumb: "Người và quyền",
    title: "Vai trò và quyền",
    lead: "Mỗi vai trò là một tập quyền. Bật một nhánh là bật mọi quyền con của nhánh đó.",
    newRole: "Vai trò mới",
    roles: "Vai trò",
    groups: { org: "Tổ chức", team: "Đội", custom: "Tự tạo" },
    systemRole: "Vai trò hệ thống",
    perms: "quyền",
    meta: (people, perms) => `${people} người · ${perms} quyền`,
    search: "Tìm quyền…",
    expandAll: "Mở hết",
    collapseAll: "Thu gọn",
    onlyGranted: "Chỉ hiện quyền đang bật",
    systemNote: "Vai trò hệ thống không sửa được. Nhân bản thành vai trò mới nếu cần tập quyền khác.",
    danger: "nhạy cảm",
    applies: "Áp dụng ngay cho mọi người có vai trò này.",
    discard: "Bỏ thay đổi",
    save: "Lưu vai trò",
    saved: "Đã lưu vai trò.",
    duplicate: "Nhân bản",
    edit: "Sửa tên",
    remove: "Xoá vai trò",
    removeTitle: "Xoá vai trò?",
    removeBody: (name) => `Vai trò "${name}" sẽ bị xoá. Vai trò còn gán cho người hoặc đội thì hub từ chối.`,
    cancel: "Huỷ",
    expand: "Mở ",
    collapse: "Thu gọn ",
    noCustom: "Chưa có vai trò tự tạo.",
    name: "Tên vai trò",
    description: "Mô tả",
    scope: "Phạm vi",
    scopes: { org: "Tổ chức", team: "Đội" },
    scopeHint: "Vai trò tổ chức gán được cho người hoặc đội; vai trò đội chỉ gán cho đội và có hiệu lực trong đội đó.",
    copyFrom: "Bắt đầu từ",
    copyNone: "Trống",
    create: "Tạo vai trò",
    editTitle: "Sửa vai trò",
    dangerTitle: "Bật quyền nhạy cảm?",
    dangerBody: "Các quyền sau cho phép thao tác ảnh hưởng cả tổ chức. Chỉ bật khi thật cần:",
    grant: "Bật quyền",
    assigned: "Đang gán cho",
    noAssigned: "Chưa gán cho ai.",
    addMember: "Thêm người",
    addTeam: "Thêm đội",
    pickMember: "Chọn thành viên…",
    pickTeam: "Chọn đội…",
    assign: "Gán",
    unassign: (name) => `Gỡ vai trò khỏi ${name}`,
    teamLabel: "Đội",
    noMatch: "Không có quyền nào khớp.",
    readOnly: "Bạn chỉ xem được vai trò; cần quyền tạo và sửa vai trò để thay đổi.",
  },
  en: {
    crumb: "People & access",
    title: "Roles & permissions",
    lead: "A role is a set of permissions. Checking a branch grants every permission under it.",
    newRole: "New role",
    roles: "Roles",
    groups: { org: "Organization", team: "Team", custom: "Custom" },
    systemRole: "System role",
    perms: "permissions",
    meta: (people, perms) => `${people} people · ${perms} perms`,
    search: "Search permissions…",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    onlyGranted: "Only granted",
    systemNote: "System roles cannot be edited. Duplicate one into a new role for a different set.",
    danger: "sensitive",
    applies: "Applies immediately to everyone with this role.",
    discard: "Discard",
    save: "Save role",
    saved: "Role saved.",
    duplicate: "Duplicate",
    edit: "Rename",
    remove: "Delete role",
    removeTitle: "Delete role?",
    removeBody: (name) => `"${name}" will be deleted. The hub refuses while it is still assigned to people or teams.`,
    cancel: "Cancel",
    expand: "Expand ",
    collapse: "Collapse ",
    noCustom: "No custom roles yet.",
    name: "Role name",
    description: "Description",
    scope: "Scope",
    scopes: { org: "Organization", team: "Team" },
    scopeHint: "Organization roles go to people or teams; team roles only go to teams and apply inside that team.",
    copyFrom: "Start from",
    copyNone: "Empty",
    create: "Create role",
    editTitle: "Edit role",
    dangerTitle: "Grant sensitive permissions?",
    dangerBody: "These permissions affect the whole organization. Grant them only when needed:",
    grant: "Grant",
    assigned: "Assigned to",
    noAssigned: "Not assigned to anyone.",
    addMember: "Add person",
    addTeam: "Add team",
    pickMember: "Pick a member…",
    pickTeam: "Pick a team…",
    assign: "Assign",
    unassign: (name) => `Remove the role from ${name}`,
    teamLabel: "Team",
    noMatch: "No permission matches.",
    readOnly: "You can view roles; creating and editing them needs the roles permission.",
  },
};

const SYSTEM_IDS: SystemRoleId[] = ["owner", "admin", "member", "team-admin", "team-member", "team-viewer"];
const DANGER = new Set(DANGEROUS_PERMISSIONS);

type SystemView = { id: SystemRoleId; scope: "org" | "team"; permissions: string[]; memberCount: number };
type Selected = { kind: "system"; role: SystemView } | { kind: "custom"; role: CustomRole };

function leafKeys(node: PermissionNode): string[] {
  return node.children ? node.children.flatMap(leafKeys) : [node.key];
}

const branchKeys = (nodes: readonly PermissionNode[]): string[] =>
  nodes.flatMap((n) => (n.children ? [n.key, ...branchKeys(n.children)] : []));

/** Vai trò và quyền (Roles.dc.html): vai trò hệ thống chỉ xem, vai trò tự tạo sửa cây quyền và gán cho người, đội. */
export function RolesPage() {
  const { org, api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const can = usePermissions();
  const canWrite = isOrgAdmin(org.role) || can("roles.write");
  const list = useQuery(api.roles.list.queryOptions());
  const [selectedId, setSelectedId] = useState<string>("owner");
  const [creating, setCreating] = useState<{ copyOf?: SystemRoleId } | null>(null);
  // Lưu xong thì danh sách tải lại và ô chi tiết dựng lại theo bản mới, nên lời báo "đã lưu" phải giữ ở đây.
  const [savedId, setSavedId] = useState<string | null>(null);

  const selected: Selected | null = useMemo(() => {
    if (!list.data) return null;
    const sys = list.data.system.find((r) => r.id === selectedId);
    if (sys) return { kind: "system", role: sys };
    const custom = list.data.custom.find((r) => r.id === selectedId);
    if (custom) return { kind: "custom", role: custom };
    const first = list.data.system[0];
    return first ? { kind: "system", role: first } : null;
  }, [list.data, selectedId]);

  return (
    <>
      <PageHeader crumb={t.crumb} title={t.title}>
        {canWrite && (
          <Button onClick={() => setCreating({})}>
            <PlusIcon aria-hidden="true" />
            {t.newRole}
          </Button>
        )}
      </PageHeader>
      <PageBody>
        <p className="-mt-2 text-muted-foreground">{t.lead}</p>
        {!canWrite && <Alert>{t.readOnly}</Alert>}
        {list.isPending && <LoadingState />}
        {list.isError && <LoadFailure error={list.error} retry={() => list.refetch()} />}
        {list.data && selected && (
          <div className="flex flex-wrap items-start gap-4">
            <nav
              aria-label={t.roles}
              className="flex w-full flex-col gap-0.5 rounded-xl border bg-card p-2 md:max-w-[290px] md:flex-[1_1_260px]"
            >
              {(["org", "team", "custom"] as const).map((group) => {
                const roles =
                  group === "custom"
                    ? list.data.custom.map((r) => ({
                        id: r.id,
                        name: r.name,
                        people: r.assignments.length,
                        perms: r.permissions.length,
                        system: false,
                      }))
                    : list.data.system
                        .filter((r) => r.scope === group)
                        .map((r) => ({
                          id: r.id,
                          name: SYSTEM_ROLE_TEXT[r.id].name[lang],
                          people: r.memberCount,
                          perms: r.permissions.length,
                          system: true,
                        }));
                return (
                  <div key={group}>
                    <div className="px-2 pt-2 pb-1 font-mono text-2xs tracking-caps text-muted-foreground uppercase">
                      {t.groups[group]}
                    </div>
                    {group === "custom" && roles.length === 0 && (
                      <p className="px-2 py-1.5 text-xs text-muted-foreground">{t.noCustom}</p>
                    )}
                    {roles.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        aria-pressed={selected.role.id === r.id}
                        onClick={() => {
                          setSelectedId(r.id);
                          setSavedId(null);
                        }}
                        className="flex w-full cursor-pointer flex-col rounded-md px-2.5 py-2 text-left hover:bg-muted aria-pressed:bg-accent aria-pressed:text-accent-foreground"
                      >
                        <span className="flex items-center gap-1.5 font-medium">
                          {r.name}
                          {r.system && <LockIcon aria-label={t.systemRole} className="size-3 text-muted-foreground" />}
                        </span>
                        <span className="text-xs text-muted-foreground">{t.meta(r.people, r.perms)}</span>
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
            <RoleDetail
              key={`${selected.role.id}|${selected.kind === "custom" ? selected.role.updatedAt : ""}`}
              selected={selected}
              canWrite={canWrite}
              justSaved={savedId === selected.role.id}
              onSaved={() => setSavedId(selected.role.id)}
              onDuplicate={(copyOf) => setCreating({ copyOf })}
              onDeleted={() => setSelectedId("owner")}
            />
          </div>
        )}
        {creating && (
          <RoleDialog
            copyOf={creating.copyOf}
            onClose={() => setCreating(null)}
            onSaved={(id) => {
              setCreating(null);
              setSelectedId(id);
            }}
          />
        )}
      </PageBody>
    </>
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
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: api.roles.key() });
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
          <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-name`}>
            {t.name}
            <Input id={`${ids}-name`} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-desc`}>
            {t.description}
            <Textarea
              id={`${ids}-desc`}
              maxLength={500}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {!role && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-scope`}>
                {t.scope}
                <NativeSelect
                  id={`${ids}-scope`}
                  value={scope}
                  onChange={(e) => setScope(e.target.value as "org" | "team")}
                >
                  <option value="org">{t.scopes.org}</option>
                  <option value="team">{t.scopes.team}</option>
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor={`${ids}-from`}>
                {t.copyFrom}
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
              </label>
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

function RoleDetail({
  selected,
  canWrite,
  justSaved,
  onSaved,
  onDuplicate,
  onDeleted,
}: {
  selected: Selected;
  canWrite: boolean;
  justSaved: boolean;
  onSaved: () => void;
  onDuplicate: (copyOf: SystemRoleId) => void;
  onDeleted: () => void;
}) {
  const { api } = useOrg();
  const t = useT(text);
  const lang = useLang();
  const queryClient = useQueryClient();
  const system = selected.kind === "system";
  const locked = system || !canWrite;
  const original = selected.role.permissions;
  const [draft, setDraft] = useState<Set<string>>(() => new Set(original));
  const [open, setOpen] = useState<Set<string>>(() => new Set(branchKeys(PERMISSION_TREE)));
  const [q, setQ] = useState("");
  const [onlyGranted, setOnlyGranted] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState<string[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const dirty = draft.size !== original.length || original.some((k) => !draft.has(k));

  const name = system ? SYSTEM_ROLE_TEXT[selected.role.id].name[lang] : selected.role.name;
  const desc = system ? SYSTEM_ROLE_TEXT[selected.role.id].desc[lang] : selected.role.description;

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: api.roles.key() });
  const save = useMutation({
    mutationFn: () =>
      api.roles.update.call({
        roleId: selected.role.id,
        permissions: PERMISSIONS.filter((k) => draft.has(k)),
      }),
    onSuccess: () => {
      onSaved();
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.roles.remove.call({ roleId: selected.role.id }),
    onSuccess: () => {
      invalidate();
      onDeleted();
    },
  });

  function setLeaves(keys: string[], on: boolean) {
    if (on) {
      const dangerous = keys.filter((k) => DANGER.has(k) && !draft.has(k));
      if (dangerous.length) {
        setConfirmDanger(keys);
        return;
      }
    }
    apply(keys, on);
  }
  function apply(keys: string[], on: boolean) {
    setDraft((d) => {
      const next = new Set(d);
      for (const k of keys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }

  const label = (key: string) => PERMISSION_LABEL[key]?.[lang] ?? key;
  const query = q.trim().toLowerCase();
  const matches = (n: PermissionNode): boolean =>
    (!query ||
      label(n.key).toLowerCase().includes(query) ||
      n.key.includes(query) ||
      (n.children?.some(matches) ?? false)) &&
    (!onlyGranted || leafKeys(n).some((k) => draft.has(k)));

  type Row = { node: PermissionNode; level: number };
  const rows: Row[] = [];
  const walk = (nodes: readonly PermissionNode[], level: number) => {
    for (const n of nodes) {
      if (!matches(n)) continue;
      rows.push({ node: n, level });
      if (n.children && (query || open.has(n.key))) walk(n.children, level + 1);
    }
  };
  walk(PERMISSION_TREE, 1);

  const granted = draft.size;
  const total = PERMISSIONS.length;

  return (
    <section className="w-full min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground md:flex-[999_1_600px]">
      <div className="flex flex-wrap items-center gap-3 border-b px-4.5 py-4">
        <div className="flex min-w-60 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[17px] font-semibold">{name}</h2>
            <Pill>{text[lang].groups[system ? selected.role.scope : "custom"]}</Pill>
            {!system && <Pill>{t.scopes[selected.role.scope]}</Pill>}
            {system && (
              <Pill>
                <LockIcon aria-hidden="true" className="size-3" />
                {t.systemRole}
              </Pill>
            )}
          </div>
          {desc && <span className="text-[13px] text-muted-foreground">{desc}</span>}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
            <span>
              <strong className="font-mono text-sm text-foreground">{granted}</strong> / {total} {t.perms}
            </span>
            <span className="h-1 w-30 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span className="block h-full bg-primary" style={{ width: `${(granted / total) * 100}%` }} />
            </span>
          </span>
          {canWrite && system && (
            <Button variant="outline" size="sm" onClick={() => onDuplicate(selected.role.id)}>
              {t.duplicate}
            </Button>
          )}
          {canWrite && !system && (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t.edit}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRemoving(true)}>
                {t.remove}
              </Button>
            </>
          )}
        </div>
      </div>

      {selected.kind === "custom" && <Assignments role={selected.role} canWrite={canWrite} onChanged={invalidate} />}

      <div className="flex flex-wrap items-center gap-2 border-b px-4.5 py-2.5">
        <Input
          aria-label={t.search}
          placeholder={t.search}
          className="w-full sm:w-65"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(new Set(branchKeys(PERMISSION_TREE)))}>
          {t.expandAll}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(new Set())}>
          {t.collapseAll}
        </Button>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            checked={onlyGranted}
            onChange={(e) => setOnlyGranted(e.target.checked)}
            className="accent-primary"
          />
          {t.onlyGranted}
        </label>
      </div>

      {system && (
        <p className="mx-4.5 mt-3 rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">{t.systemNote}</p>
      )}

      <ul aria-label={t.perms} className="m-0 list-none px-3 pt-2.5 pb-4">
        {rows.length === 0 && <li className="px-2 py-3 text-[13px] text-muted-foreground">{t.noMatch}</li>}
        {rows.map(({ node, level }) => {
          const keys = leafKeys(node);
          const on = keys.filter((k) => draft.has(k)).length;
          const state = on === 0 ? "false" : on === keys.length ? "true" : "mixed";
          const isOpen = !!query || open.has(node.key);
          return (
            <li
              key={node.key}
              className="flex items-center gap-2 rounded-md py-1 pr-2 hover:bg-muted/50"
              style={{ paddingLeft: `${(level - 1) * 22 + 4}px` }}
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
                  className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-muted"
                >
                  <ChevronRightIcon
                    aria-hidden="true"
                    className={cn("size-3.5 transition-transform", isOpen && "rotate-90")}
                  />
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <input
                type="checkbox"
                aria-label={label(node.key)}
                checked={state === "true"}
                // Nhánh bật một phần: trình duyệt đọc là "mixed" như ô ba trạng thái của thiết kế.
                ref={(el) => {
                  if (el) el.indeterminate = state === "mixed";
                }}
                disabled={locked}
                onChange={() => setLeaves(keys, state !== "true")}
                className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className={cn(node.children ? "font-medium" : "", level === 1 && "font-semibold")}>
                  {label(node.key)}
                </span>
                {node.danger && <Pill tone="bad">{t.danger}</Pill>}
                {node.children && (
                  <span className="font-mono text-[11.5px] text-muted-foreground">
                    {on}/{keys.length}
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

      {!locked && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-2 border-t bg-card px-4.5 py-3">
          <span className="flex-1 text-[13px] text-muted-foreground">{justSaved && !dirty ? t.saved : t.applies}</span>
          {save.isError && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
          <Button variant="outline" disabled={!dirty} onClick={() => setDraft(new Set(original))}>
            {t.discard}
          </Button>
          <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {t.save}
          </Button>
        </div>
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

      {editing && selected.kind === "custom" && (
        <RoleDialog role={selected.role} onClose={() => setEditing(false)} onSaved={() => setEditing(false)} />
      )}

      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.removeTitle}</DialogTitle>
            <DialogDescription>{t.removeBody(name)}</DialogDescription>
          </DialogHeader>
          {remove.isError && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" onClick={() => setRemoving(false)}>
              {t.cancel}
            </Button>
            <Button variant="destructive-solid" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t.remove}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Assignments({ role, canWrite, onChanged }: { role: CustomRole; canWrite: boolean; onChanged: () => void }) {
  const { api } = useOrg();
  const t = useT(text);
  const ids = useId();
  const members = useQuery({ ...api.orgMembers.list.queryOptions(), enabled: canWrite });
  const teams = useQuery({ ...api.teams.list.queryOptions(), enabled: canWrite });
  const [memberId, setMemberId] = useState("");
  const [teamId, setTeamId] = useState("");
  const assign = useMutation({
    mutationFn: (input: { kind: "member"; userId: string } | { kind: "team"; teamId: string }) =>
      api.roles.assign.call({ roleId: role.id, ...input }),
    onSuccess: () => {
      setMemberId("");
      setTeamId("");
      onChanged();
    },
  });
  const unassign = useMutation({
    mutationFn: (input: { kind: "member"; userId: string } | { kind: "team"; teamId: string }) =>
      api.roles.unassign.call({ roleId: role.id, ...input }),
    onSuccess: onChanged,
  });
  const assignedMembers = new Set(role.assignments.flatMap((a) => (a.kind === "member" ? [a.userId] : [])));
  const assignedTeams = new Set(role.assignments.flatMap((a) => (a.kind === "team" ? [a.teamId] : [])));
  return (
    <section aria-label={t.assigned} className="flex flex-col gap-2 border-b px-4.5 py-3">
      <span className="text-xs font-medium text-muted-foreground">{t.assigned}</span>
      {role.assignments.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t.noAssigned}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {role.assignments.map((a) => (
            <li key={a.kind === "member" ? a.userId : a.teamId}>
              <Pill tone={a.kind === "team" ? "sel" : "neutral"}>
                {a.kind === "team" ? `${t.teamLabel}: ${a.name}` : a.name}
                {canWrite && (
                  <button
                    type="button"
                    aria-label={t.unassign(a.name)}
                    className="-mr-1 inline-flex cursor-pointer rounded-full p-0.5 hover:bg-background/60"
                    onClick={() =>
                      unassign.mutate(
                        a.kind === "member" ? { kind: "member", userId: a.userId } : { kind: "team", teamId: a.teamId },
                      )
                    }
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                )}
              </Pill>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <div className="flex flex-wrap items-end gap-2">
          {role.scope === "org" && (
            <form
              className="flex items-end gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (memberId) assign.mutate({ kind: "member", userId: memberId });
              }}
            >
              <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={`${ids}-m`}>
                {t.addMember}
                <NativeSelect id={`${ids}-m`} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                  <option value="">{t.pickMember}</option>
                  {members.data
                    ?.filter((m) => m.status === "active" && !assignedMembers.has(m.userId))
                    .map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name} · {m.email}
                      </option>
                    ))}
                </NativeSelect>
              </label>
              <Button type="submit" variant="secondary" size="sm" disabled={!memberId || assign.isPending}>
                {t.assign}
              </Button>
            </form>
          )}
          <form
            className="flex items-end gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (teamId) assign.mutate({ kind: "team", teamId });
            }}
          >
            <label className="flex flex-col gap-1 text-xs font-medium" htmlFor={`${ids}-t`}>
              {t.addTeam}
              <NativeSelect id={`${ids}-t`} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">{t.pickTeam}</option>
                {teams.data
                  ?.filter((team) => !assignedTeams.has(team.id))
                  .map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
            <Button type="submit" variant="secondary" size="sm" disabled={!teamId || assign.isPending}>
              {t.assign}
            </Button>
          </form>
        </div>
      )}
      {(assign.isError || unassign.isError) && (
        <Alert variant="destructive">{apiErrorMessage(assign.error ?? unassign.error)}</Alert>
      )}
    </section>
  );
}
