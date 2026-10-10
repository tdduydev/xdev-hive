import { useMemo, useState, type CSSProperties } from "react";
import { ChevronRight, Copy, MoreHorizontal, Plus, RotateCcw, UserPlus } from "lucide-react";
import { HUB_ROLES, INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, PROJECT_NAME, TRASH_DAYS, type Grant, type HubInvite, type HubRole, type HubUser } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@xdev-hive/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  daysToPurge,
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

/** A sign-up link, shown once: the hub keeps only its hash. */
function InviteLink({ url, text, onClose }: { url: string; text: string; onClose: () => void }) {
  const t = useT();
  return (
    <Notice tone="ok" title={text}>
      <div className="flex w-full flex-wrap items-center gap-2 pt-1">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-sm break-all text-foreground" data-invite-url>{url}</code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(url)}>
          <Copy />
          {t("common.copy")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Notice>
  );
}

/** Where a link leads: the sign-up page of this hub (a hash route, so no server rewrite is needed). */
const inviteUrl = (token: string) => `${window.location.origin}/#/invite/${token}`;

const GRANT_CHIPS = 3;

function InviteRow({ invite, busy, roleName, onRevoke }: { invite: HubInvite; busy: boolean; roleName: (r: HubRole) => string; onRevoke: () => void }) {
  const t = useT();
  return (
    <div className="cu-invite" data-invite-row={invite.id} data-state={invite.state}>
      <span className="cu-status" data-status={invite.state === "pending" ? "active" : invite.state === "used" ? "invited" : "disabled"}>{t(`adminUsers.inviteState.${invite.state}`)}</span>
      <span className="min-w-0 flex-1 text-sm">
        {t("adminUsers.inviteMeta", { role: roleName(invite.role), by: invite.createdBy, at: formatTime(invite.expiresAt) })}
        {invite.username ? <small className="ml-2 font-mono text-fg-muted">{t("adminUsers.inviteFor", { username: invite.username })}</small> : null}
      </span>
      {invite.state === "pending" ? (
        <Button size="sm" variant="ghost" data-invite-revoke disabled={busy} onClick={onRevoke}>
          {t("adminUsers.inviteRevoke")}
        </Button>
      ) : null}
    </div>
  );
}

export function UsersPage({ inviteOpen, onInviteClose }: { inviteOpen: boolean; onInviteClose: () => void }) {
  const { client, me, projects } = useHive();
  const t = useT();
  const users = client.users!;
  const list = useQuery(() => users.list(), [users]);
  const invites = useQuery(() => users.invites.list(), [users]);
  const action = useAction();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [hubRole, setHubRole] = useState<HubRole>("member");
  const [tab, setTab] = useState<"link" | "account">("link");
  const [days, setDays] = useState(INVITE_DEFAULT_DAYS);
  const [link, setLink] = useState<{ url: string; text: string } | null>(null);
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

  const update = (u: HubUser, patch: { hubRole?: HubRole; disabled?: boolean }, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    void action.run(async () => {
      await users.update(u.id, patch);
      list.reload();
    });
  };
  // One call per person, as the hub has no bulk call; the signed-in admin is skipped so it cannot lock itself out half-way.
  const bulk = (patch: { hubRole?: HubRole; disabled?: boolean; trash?: boolean }, confirm?: string) => {
    const todo = targets.filter((u) => (patch.trash ? true : patch.hubRole ? u.hubRole !== patch.hubRole : u.disabled !== patch.disabled));
    if (!todo.length || (confirm && !window.confirm(confirm.replace("{n}", String(todo.length))))) return;
    void action.run(async () => {
      await Promise.all(todo.map((u) => (patch.trash ? users.trash(u.id) : users.update(u.id, patch))));
      setSelected(new Set());
      list.reload();
    });
  };
  const trashOne = (u: HubUser) => {
    if (!window.confirm(t("adminUsers.confirmTrash", { username: u.username, days: TRASH_DAYS }))) return;
    void action.run(async () => {
      await users.trash(u.id);
      list.reload();
    });
  };
  const roleName = (r: HubRole) => t(`adminUsers.hubRole.${r}`);
  const makeLink = (userId?: string, username?: string) =>
    void action.run(async () => {
      const made = await users.invites.create({ hubRole, days, ...(userId ? { userId } : {}) });
      setLink({ url: inviteUrl(made.token), text: username ? t("adminUsers.linkResentFor", { username }) : t("adminUsers.linkReady", { role: roleName(made.invite.role), at: formatTime(made.invite.expiresAt) }) });
      invites.reload();
      if (userId) onInviteClose();
    });
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
      {link && !inviteOpen ? (
        <div className="mb-3">
          <InviteLink url={link.url} text={link.text} onClose={() => setLink(null)} />
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
              {HUB_ROLES.map((r) => (
                <DropdownMenuItem key={r} data-bulk-role={r} onSelect={() => bulk({ hubRole: r }, t("adminUsers.confirmBulkRole", { n: "{n}", role: roleName(r) }))}>
                  {roleName(r)}
                </DropdownMenuItem>
              ))}
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
          <Button variant="glass" size="sm" disabled={!targets.length || action.busy} data-bulk-trash onClick={() => bulk({ trash: true }, t("adminUsers.confirmBulkTrash", { n: "{n}", days: TRASH_DAYS }))}>
            {t("adminUsers.bulkTrash")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            {t("adminUsers.clearSel")}
          </Button>
        </div>
      ) : null}
      {filter === "trash" ? <p className="cu-note" data-trash-hint>{t("adminUsers.trashHint", { days: TRASH_DAYS })}</p> : null}
      <div className="cu-panel" data-users-table>
        <div className="cu-table" data-trash-view={filter === "trash" ? "" : undefined}>
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
              <div key={u.id} className="cu-grid cu-row" data-user-row={u.username} data-selected={on} data-disabled={u.disabled} data-trash={!!u.deletedAt}>
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
                <span className="cu-role" data-admin={u.admin} data-hub-role-of={u.hubRole}>{roleName(u.hubRole)}</span>
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
                <span className="cu-cell">{u.deletedAt ? t("adminUsers.purgeIn", { days: daysToPurge(u) }) : u.lastLoginAt ? formatTime(u.lastLoginAt) : t("adminUsers.never")}</span>
                <span className="cu-status" data-status={status}>{t(status === "active" ? "users.active" : status === "mustChange" ? "users.mustChange" : status === "invited" ? "adminUsers.statusInvited" : status === "trash" ? "adminUsers.statusTrash" : "users.disabled")}</span>
                {u.deletedAt ? (
                  <span className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="glass" data-user-restore disabled={action.busy} onClick={() => void action.run(async () => { await users.restore(u.id); list.reload(); })}>
                      <RotateCcw />
                      {t("adminUsers.restore")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-user-purge
                      disabled={action.busy}
                      onClick={() => {
                        if (!window.confirm(t("adminUsers.confirmPurge", { username: u.username }))) return;
                        void action.run(async () => { await users.purge(u.id); list.reload(); });
                      }}
                    >
                      {t("adminUsers.purge")}
                    </Button>
                  </span>
                ) : (
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
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger disabled={self}>{t("adminUsers.changeRole")}</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          {HUB_ROLES.map((r) => (
                            <DropdownMenuItem key={r} disabled={r === u.hubRole} data-set-role={r} onSelect={() => update(u, { hubRole: r }, t("adminUsers.confirmRole", { username: u.username, role: roleName(r) }))}>
                              {roleName(r)}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
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
                      <DropdownMenuItem disabled={self} variant="destructive" data-user-trash onSelect={() => trashOne(u)}>
                        {t("adminUsers.trash")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
                )}
              </div>
            );
          })}
          {list.data && !paged.rows.length ? <div className="cu-empty">{filter === "trash" ? t("adminUsers.trashEmpty") : all.length ? t("adminUsers.empty") : t("users.none")}</div> : null}
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
      <section className="mt-4" data-invites-panel>
        <h3 className="mb-2 text-sm font-semibold">{t("adminUsers.invitesTitle")}</h3>
        <ErrorNote error={invites.error} />
        <div className="cu-panel">
          {(invites.data ?? []).length === 0 ? <div className="cu-empty">{t("adminUsers.invitesNone")}</div> : null}
          {(invites.data ?? []).map((i) => (
            <InviteRow key={i.id} invite={i} busy={action.busy} roleName={roleName} onRevoke={() => void action.run(async () => { await users.invites.revoke(i.id); invites.reload(); })} />
          ))}
        </div>
      </section>
      <Dialog open={inviteOpen} onOpenChange={(open) => !open && onInviteClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("adminUsers.inviteTitle")}</DialogTitle>
            <DialogDescription>{tab === "link" ? t("adminUsers.linkHint") : t("adminUsers.createHint")}</DialogDescription>
          </DialogHeader>
          <div className="cu-seg" role="tablist">
            {(["link", "account"] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} data-invite-tab={k} data-active={tab === k} onClick={() => setTab(k)}>
                {t(k === "link" ? "adminUsers.tabLink" : "adminUsers.tabAccount")}
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {t("adminUsers.linkRole")}
            <select className="cu-select" data-invite-role value={hubRole} onChange={(e) => setHubRole(e.target.value as HubRole)}>
              {HUB_ROLES.map((r) => (
                <option key={r} value={r}>{roleName(r)}</option>
              ))}
            </select>
          </label>
          {tab === "link" ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                {t("adminUsers.linkDays")}
                <Input type="number" min={1} max={INVITE_MAX_DAYS} data-invite-days value={days} onChange={(e) => setDays(Number(e.target.value) || INVITE_DEFAULT_DAYS)} />
              </label>
              {link ? <InviteLink url={link.url} text={link.text} onClose={() => setLink(null)} /> : null}
              <ErrorNote error={action.error} />
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={onInviteClose}>
                  {t("common.close")}
                </Button>
                <Button type="button" variant="solid" data-invite-create disabled={action.busy} onClick={() => makeLink()}>
                  {t("adminUsers.linkCreate")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => {
                  const res = await users.create({ username: username.trim(), displayName: displayName.trim() || undefined, hubRole });
                  setShown({ username: res.user.username, password: res.password, reset: false });
                  setUsername("");
                  setDisplayName("");
                  setHubRole("member");
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
          )}
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
  const [resent, setResent] = useState<string | null>(null);
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
        {user.invited ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-resend>
            <span className="flex-1">{t("adminUsers.resendHint")}</span>
            <Button
              size="sm"
              variant="glass"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const made = await client.users!.invites.create({ hubRole: user.hubRole, userId: user.id });
                  setResent(inviteUrl(made.token));
                })
              }
            >
              {t("adminUsers.resend")}
            </Button>
          </div>
        ) : null}
        {resent ? <InviteLink url={resent} text={t("adminUsers.linkResentFor", { username: user.username })} onClose={() => setResent(null)} /> : null}
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
