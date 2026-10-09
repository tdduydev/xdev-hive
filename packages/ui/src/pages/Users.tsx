import { useMemo, useState, type CSSProperties } from "react";
import { ChevronRight, Copy, MoreHorizontal, Plus, UserPlus } from "lucide-react";
import { PROJECT_NAME, type Grant, type HubUser } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Empty, ErrorNote, Notice } from "#ui/components/common.tsx";
import { GrantEditor, grantLabel, RoleLegend } from "#ui/components/GrantEditor.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";
import {
  allSelected,
  avatarHue,
  bulkTargets,
  filterCounts,
  filterUsers,
  initials,
  paginate,
  sortUsers,
  USER_FILTERS,
  userStatus,
  type SortDir,
  type UserFilter,
  type UserSort,
} from "#ui/lib/users-table.ts";



/** A temporary password to hand over once: after a new account or a reset. */
function Handover({ shown, onClose }: { shown: { username: string; password: string; reset: boolean }; onClose: () => void }) {
  const t = useT();
  return (
    <Notice tone="ok" title={t(shown.reset ? "users.handoverReset" : "users.handoverNew", { username: shown.username })}>
      <div className="flex w-full flex-wrap items-center gap-2 pt-1">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-sm break-all text-foreground">{shown.password}</code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(shown.password)}>
          <Copy />
          {t("common.copy")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("users.handoverHint")}
      </p>
    </Notice>
  );
}

const GRANT_CHIPS = 3;

export function UsersPage({ inviteOpen, onInviteClose }: { inviteOpen: boolean; onInviteClose: () => void }) {
  const { client, me, projects } = useHive();
  const t = useT();
  const users = client.users!;
  const list = useQuery(() => users.list(), [users]);
  const action = useAction();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [admin, setAdmin] = useState(false);
  const [shown, setShown] = useState<{ username: string; password: string; reset: boolean } | null>(null);
  const [editing, setEditing] = useState<HubUser | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UserFilter>("all");
  const [sort, setSort] = useState<{ by: UserSort; dir: SortDir }>({ by: "name", dir: "asc" });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selfId = me.user?.id;

  const all = list.data ?? [];
  const counts = useMemo(() => filterCounts(all), [all]);
  const sorted = useMemo(() => sortUsers(filterUsers(all, query, filter), sort.by, sort.dir), [all, query, filter, sort]);
  const paged = paginate(sorted, page);
  // A selection outlives paging and filtering, but not an account that is gone from the hub.
  const picked = all.filter((u) => selected.has(u.id));
  const targets = bulkTargets(all, selected, selfId);

  const update = (u: HubUser, patch: { admin?: boolean; disabled?: boolean }, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    void action.run(async () => {
      await users.update(u.id, patch);
      list.reload();
    });
  };
  // One update per person, as the hub has no bulk call; the signed-in admin is skipped so it cannot lock itself out half-way.
  const bulk = (patch: { admin?: boolean; disabled?: boolean }, confirm?: string) => {
    const todo = targets.filter((u) => ("admin" in patch ? u.admin !== patch.admin : u.disabled !== patch.disabled));
    if (!todo.length || (confirm && !window.confirm(confirm.replace("{n}", String(todo.length))))) return;
    void action.run(async () => {
      await Promise.all(todo.map((u) => users.update(u.id, patch)));
      setSelected(new Set());
      list.reload();
    });
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const everyone = allSelected(paged.rows, selected);
  const toggleAll = () =>
    setSelected((s) => {
      const next = new Set(s);
      for (const u of paged.rows) everyone ? next.delete(u.id) : next.add(u.id);
      return next;
    });
  const sortBy = (by: UserSort) => {
    setSort((s) => (s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: "asc" }));
    setPage(1);
  };
  const cols: { id: UserSort; label: string }[] = [
    { id: "name", label: t("adminUsers.colName") },
    { id: "role", label: t("adminUsers.colRole") },
    { id: "access", label: t("adminUsers.colAccess") },
    { id: "sso", label: t("adminUsers.colSso") },
    { id: "last", label: t("adminUsers.colLast") },
    { id: "status", label: t("adminUsers.colStatus") },
  ];

  return (
    <div className="flex min-w-0 flex-col" data-users-page>
      <ErrorNote error={action.error} />
      {shown ? (
        <div className="mb-3">
          <Handover shown={shown} onClose={() => setShown(null)} />
        </div>
      ) : null}
      <ErrorNote error={list.error} />
      <div className="cu-toolbar">
        <div className="cu-search">
          <Input
            controlSize="sm"
            type="search"
            data-users-search
            placeholder={t("adminUsers.search")}
            aria-label={t("adminUsers.search")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="contents" role="group" aria-label={t("adminUsers.filters")}>
          {USER_FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="cosmic-tag"
              data-tone="neutral"
              data-active={filter === f}
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setPage(1);
              }}
            >
              {t(`adminUsers.filter.${f}`)} · {counts[f]}
            </button>
          ))}
        </div>
      </div>
      {picked.length ? (
        <div className="cu-sel" data-users-selection>
          <span>{t("adminUsers.selected", { n: picked.length })}</span>
          {picked.some((u) => u.id === selfId) ? <small className="text-xs text-fg-muted">{t("adminUsers.selfSkipped")}</small> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="glass" size="sm" disabled={!targets.length || action.busy}>
                {t("adminUsers.bulkRole")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => bulk({ admin: true }, t("adminUsers.confirmBulkGrant", { n: "{n}" }))}>{t("adminUsers.bulkGrantAdmin")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => bulk({ admin: false }, t("adminUsers.confirmBulkRevoke", { n: "{n}" }))}>{t("adminUsers.bulkRevokeAdmin")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {targets.length && targets.every((u) => u.disabled) ? (
            <Button variant="glass" size="sm" disabled={action.busy} onClick={() => bulk({ disabled: false })}>
              {t("adminUsers.bulkEnable")}
            </Button>
          ) : (
            <Button variant="glass" size="sm" disabled={!targets.length || action.busy} onClick={() => bulk({ disabled: true }, t("adminUsers.confirmBulkDisable", { n: "{n}" }))}>
              {t("adminUsers.bulkDisable")}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {t("adminUsers.clearSel")}
          </Button>
        </div>
      ) : null}
      <div className="cu-panel" data-users-table>
        <div className="cu-table">
          <div className="cu-grid cu-head">
            <button type="button" className="cu-check" role="checkbox" aria-checked={everyone} aria-label={t("adminUsers.selectAll")} onClick={toggleAll}>
              <span>{everyone ? "✓" : ""}</span>
            </button>
            {cols.map((c) => (
              <button
                key={c.id}
                type="button"
                aria-label={t("adminUsers.sortBy", { col: c.label })}
                aria-sort={sort.by === c.id ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                onClick={() => sortBy(c.id)}
              >
                {c.label}
                <span aria-hidden className="text-[10px]">{sort.by === c.id ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
              </button>
            ))}
            <span />
          </div>
          {paged.rows.map((u) => {
            const self = selfId === u.id;
            const grants = Object.entries(u.grants);
            const on = selected.has(u.id);
            const status = userStatus(u);
            return (
              <div key={u.id} className="cu-grid cu-row" data-user-row={u.username} data-selected={on} data-disabled={u.disabled}>
                <button type="button" className="cu-check" role="checkbox" aria-checked={on} aria-label={t("adminUsers.selectRow", { username: u.username })} onClick={() => toggle(u.id)}>
                  <span>{on ? "✓" : ""}</span>
                </button>
                <button type="button" className="cu-person" disabled={u.admin} onClick={() => setEditing(u)}>
                  <span className="cu-avatar" style={{ "--hue": avatarHue(u.username) } as CSSProperties}>{initials(u.displayName)}</span>
                  <span>
                    <strong>
                      {u.displayName}
                      {self ? <span className="font-normal text-fg-muted"> {t("users.you")}</span> : null}
                    </strong>
                    <small className="font-mono">@{u.username}</small>
                  </span>
                </button>
                <span className="cu-role" data-admin={u.admin}>{u.admin ? t("adminUsers.roleAdmin") : t("adminUsers.roleMember")}</span>
                <span className="cu-chips">
                  {u.admin ? (
                    <span className="cu-chip">{t("users.adminAll")}</span>
                  ) : grants.length ? (
                    <>
                      {grants.slice(0, GRANT_CHIPS).map(([p, g]) => (
                        <span key={p} className="cu-chip">
                          <b>{p}</b>
                          {grantLabel(t, g)}
                        </span>
                      ))}
                      {grants.length > GRANT_CHIPS ? <span className="cu-more">{t("adminUsers.more", { n: grants.length - GRANT_CHIPS })}</span> : null}
                    </>
                  ) : (
                    <span className="cu-more">{t("users.sharedOnly")}</span>
                  )}
                </span>
                <span className="cu-cell">{u.sso ? t("adminUsers.ssoYes") : t("adminUsers.ssoNo")}</span>
                <span className="cu-cell">{u.lastLoginAt ? formatTime(u.lastLoginAt) : t("adminUsers.never")}</span>
                <span className="cu-status" data-status={status}>{t(status === "active" ? "users.active" : status === "mustChange" ? "users.mustChange" : "users.disabled")}</span>
                <span className="flex items-center justify-end">
                  {u.admin ? null : (
                    <button type="button" className="cu-open" data-user-open aria-label={t("adminUsers.edit", { username: u.username })} onClick={() => setEditing(u)}>
                      <ChevronRight className="size-4" />
                    </button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="cu-open" aria-label={t("users.actionsFor", { username: u.username })}>
                        <MoreHorizontal className="size-4" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={self}
                        onSelect={() =>
                          update(u, { admin: !u.admin }, u.admin ? t("users.confirmRevokeAdmin", { username: u.username }) : t("users.confirmGrantAdmin", { username: u.username }))
                        }
                      >
                        {u.admin ? t("users.revokeAdmin") : t("users.grantAdmin")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          if (!window.confirm(t("users.confirmReset", { username: u.username }))) return;
                          void action.run(async () => {
                            const password = await users.resetPassword(u.id);
                            setShown({ username: u.username, password, reset: true });
                            list.reload();
                          });
                        }}
                      >
                        {t("users.resetPassword")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={self}
                        variant={u.disabled ? "default" : "destructive"}
                        onSelect={() => update(u, { disabled: !u.disabled }, u.disabled ? undefined : t("users.confirmDisable", { username: u.username }))}
                      >
                        {u.disabled ? t("users.enable") : t("users.disable")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              </div>
            );
          })}
          {list.data && !paged.rows.length ? <div className="cu-empty">{all.length ? t("adminUsers.empty") : t("users.none")}</div> : null}
          <div className="cu-foot">
            <span>{t("adminUsers.range", { from: paged.from, to: paged.to, total: paged.total })}</span>
            <Button variant="ghost" size="sm" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>
              {t("adminUsers.prev")}
            </Button>
            <span>{t("adminUsers.page", { page: paged.page, pages: paged.pages })}</span>
            <Button variant="ghost" size="sm" disabled={paged.page >= paged.pages} onClick={() => setPage(paged.page + 1)}>
              {t("adminUsers.next")}
            </Button>
          </div>
        </div>
      </div>
      <Dialog open={inviteOpen} onOpenChange={(open) => !open && onInviteClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("adminUsers.createTitle")}</DialogTitle>
            <DialogDescription>{t("adminUsers.createHint")}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const res = await users.create({ username: username.trim(), displayName: displayName.trim() || undefined, admin });
                setShown({ username: res.user.username, password: res.password, reset: false });
                setUsername("");
                setDisplayName("");
                setAdmin(false);
                list.reload();
                onInviteClose();
                if (!res.user.admin) setEditing(res.user);
              });
            }}
          >
            <Input
              className="font-mono"
              placeholder={t("users.usernamePlaceholder")}
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              aria-label={t("login.username")}
            />
            <Input placeholder={t("users.displayNamePlaceholder")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label={t("users.displayName")} />
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <Checkbox checked={admin} onCheckedChange={(v) => setAdmin(v === true)} />
              Admin
            </label>
            <ErrorNote error={action.error} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onInviteClose}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" variant="solid" disabled={!username.trim() || action.busy}>
                <UserPlus />
                {t("users.create")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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

export function GrantsDialog({ user, projects, onClose, onSaved }: { user: HubUser; projects: string[]; onClose: () => void; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [grants, setGrants] = useState<Record<string, Grant>>(user.grants);
  const [shared, setShared] = useState<Grant | null>(user.shared);
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const action = useAction();
  const rows = useMemo(() => [...new Set([...projects, ...Object.keys(user.grants), ...extra])].sort(), [projects, user.grants, extra]);

  const set = (project: string, grant: Grant | null) =>
    setGrants((g) => {
      const next = { ...g };
      if (grant === null) delete next[project];
      else next[project] = grant;
      return next;
    });

  const add = () => {
    const name = adding.trim().toLowerCase();
    if (!PROJECT_NAME.test(name)) {
      setAddError(t("users.badProject"));
      return;
    }
    setAddError(null);
    setExtra((x) => [...x, name]);
    set(name, "viewer");
    setAdding("");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t("users.grantsOf", { name: user.displayName })} <span className="font-mono text-sm font-normal text-muted-foreground">@{user.username}</span>
          </DialogTitle>
          <DialogDescription>
            {t("users.grantsHint")}
          </DialogDescription>
        </DialogHeader>
        <RoleLegend />
        <div className="flex max-h-[50vh] flex-col divide-y overflow-y-auto rounded-md border">
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium">{t("members.shared")}</span>
              <span className="text-[11px] text-muted-foreground">{t("members.sharedDefaultHint")}</span>
            </span>
            <div>
              <GrantEditor value={shared} onChange={setShared} noneLabel={t("members.sharedDefault")} label={t("users.levelOn", { project: t("members.shared") })} />
            </div>
          </div>
          {rows.length === 0 ? <Empty>{t("users.noProjects")}</Empty> : null}
          {rows.map((p) => (
            <div key={p} className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
              <span className="min-w-0 pt-1 font-mono text-sm break-all sm:w-40 sm:shrink-0">{p}</span>
              <div className="min-w-0 flex-1">
                <GrantEditor value={grants[p] ?? null} onChange={(g) => set(p, g)} label={t("users.levelOn", { project: p })} />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-40 flex-1 font-mono text-xs md:text-xs"
            placeholder={t("users.addProjectPlaceholder")}
            autoCapitalize="none"
            spellCheck={false}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            aria-label={t("users.addProject")}
          />
          <Button size="sm" variant="outline" onClick={add} disabled={!adding.trim()}>
            <Plus />
            {t("users.addProject")}
          </Button>
        </div>
        <ErrorNote error={addError ?? action.error} />
        <p className="text-xs text-muted-foreground">
          {t("users.sharedRule")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await client.users!.setGrants(user.id, grants, shared);
                onSaved();
              })
            }
          >
            {action.busy ? t("password.saving") : t("users.saveGrants")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
