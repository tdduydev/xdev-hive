import { useMemo, useState } from "react";
import { Copy, MoreHorizontal, Plus, UserPlus } from "lucide-react";
import { LEVELS, PROJECT_NAME, type HubUser, type Level } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { useT } from "#ui/i18n/index.tsx";

const SEGMENT = "px-2.5 text-xs";
const NONE = "none";

const LEVEL_TONE: Record<Level, string> = { view: "neutral", contribute: "info", manage: "accent" };

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

export function UsersPage() {
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

  const update = (u: HubUser, patch: { admin?: boolean; disabled?: boolean }, confirm?: string) => {
    if (confirm && !window.confirm(confirm)) return;
    void action.run(async () => {
      await users.update(u.id, patch);
      list.reload();
    });
  };

  return (
    <Page>
      <PageHeader
        title={t("nav.users")}
        subtitle={t("users.subtitle")}
      />
      <Card className="py-4">
        <CardContent className="px-4">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const res = await users.create({ username: username.trim(), displayName: displayName.trim() || undefined, admin });
                setShown({ username: res.user.username, password: res.password, reset: false });
                setUsername("");
                setDisplayName("");
                setAdmin(false);
                list.reload();
                if (!res.user.admin) setEditing(res.user);
              });
            }}
          >
            <Input
              className="min-w-40 flex-1 font-mono"
              placeholder={t("users.usernamePlaceholder")}
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              aria-label={t("login.username")}
            />
            <Input className="min-w-40 flex-1" placeholder={t("users.displayNamePlaceholder")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label={t("users.displayName")} />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={admin} onCheckedChange={(v) => setAdmin(v === true)} />
              Admin
            </label>
            <Button type="submit" disabled={!username.trim() || action.busy}>
              <UserPlus />
              {t("users.create")}
            </Button>
          </form>
        </CardContent>
      </Card>
      <ErrorNote error={action.error} />
      {shown ? <Handover shown={shown} onClose={() => setShown(null)} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{t("users.none")}</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("users.colAccount")}</TableHead>
                <TableHead>{t("users.colAccess")}</TableHead>
                <TableHead>{t("users.colStatus")}</TableHead>
                <TableHead>{t("users.colLastLogin")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((u) => {
                const self = me.user?.id === u.id;
                const grants = Object.entries(u.grants);
                return (
                  <TableRow key={u.id} className={u.disabled ? "opacity-60" : undefined}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {u.displayName}
                          {self ? <span className="text-muted-foreground"> {t("users.you")}</span> : null}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">@{u.username}</span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      {u.admin ? (
                        <Badge tone="accent">{t("users.adminAll")}</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {grants.map(([p, l]) => (
                            <Badge key={p} tone={LEVEL_TONE[l]} className="font-mono text-[11px]">
                              {p} · {t(`level.${l}`)}
                            </Badge>
                          ))}
                          {grants.length ? null : <span className="text-xs text-muted-foreground">{t("users.sharedOnly")}</span>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.disabled ? (
                        <Badge tone="danger">{t("users.disabled")}</Badge>
                      ) : u.mustChangePassword ? (
                        <Badge tone="warn">{t("users.mustChange")}</Badge>
                      ) : (
                        <Badge tone="ok">{t("users.active")}</Badge>
                      )}
                      {u.sso ? (
                        <Badge tone="info" className="ml-1">
                          {t("users.sso")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatTime(u.lastLoginAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {u.admin ? null : (
                        <Button size="sm" variant="outline" onClick={() => setEditing(u)}>
                          {t("users.grants")}
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="ml-1 size-8" aria-label={t("users.actionsFor", { username: u.username })}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={self}
                            onSelect={() =>
                              update(
                                u,
                                { admin: !u.admin },
                                u.admin
                                  ? t("users.confirmRevokeAdmin", { username: u.username })
                                  : t("users.confirmGrantAdmin", { username: u.username }),
                              )
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
                            onSelect={() =>
                              update(
                                u,
                                { disabled: !u.disabled },
                                u.disabled ? undefined : t("users.confirmDisable", { username: u.username }),
                              )
                            }
                          >
                            {u.disabled ? t("users.enable") : t("users.disable")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
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
    </Page>
  );
}

function GrantsDialog({ user, projects, onClose, onSaved }: { user: HubUser; projects: string[]; onClose: () => void; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [grants, setGrants] = useState<Record<string, Level>>(user.grants);
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const action = useAction();
  const rows = useMemo(() => [...new Set([...projects, ...Object.keys(user.grants), ...extra])].sort(), [projects, user.grants, extra]);

  const set = (project: string, level: Level | typeof NONE) =>
    setGrants((g) => {
      const next = { ...g };
      if (level === NONE) delete next[project];
      else next[project] = level;
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
    set(name, "view");
    setAdding("");
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("users.grantsOf", { name: user.displayName })} <span className="font-mono text-sm font-normal text-muted-foreground">@{user.username}</span>
          </DialogTitle>
          <DialogDescription>
            {t("users.grantsHint")}
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
          {LEVELS.map((l) => (
            <li key={l} className="rounded-md bg-muted px-2 py-1.5">
              <span className="font-semibold text-foreground">{t(`level.${l}`)}</span>: {t(`levelHint.${l}`)}
            </li>
          ))}
        </ul>
        <div className="flex max-h-[45vh] flex-col divide-y overflow-y-auto rounded-md border">
          {rows.length === 0 ? <Empty>{t("users.noProjects")}</Empty> : null}
          {rows.map((p) => (
            <div key={p} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 font-mono text-sm break-all">{p}</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={grants[p] ?? NONE}
                onValueChange={(v) => v && set(p, v as Level | typeof NONE)}
                aria-label={t("users.levelOn", { project: p })}
              >
                <ToggleGroupItem value={NONE} className={SEGMENT}>
                  {t("users.levelNone")}
                </ToggleGroupItem>
                {LEVELS.map((l) => (
                  <ToggleGroupItem key={l} value={l} className={SEGMENT}>
                    {t(`level.${l}`)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
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
                await client.users!.setGrants(user.id, grants);
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
