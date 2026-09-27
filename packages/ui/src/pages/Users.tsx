import { useMemo, useState } from "react";
import { Copy, MoreHorizontal, Plus, UserPlus } from "lucide-react";
import { LEVEL_LABEL, LEVELS, PROJECT_NAME, type HubUser, type Level } from "@xdev-hive/core";
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
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const SEGMENT = "px-2.5 text-xs data-[state=on]:bg-brand-soft data-[state=on]:font-semibold data-[state=on]:text-brand-soft-foreground";
const NONE = "none";

const LEVEL_HINT: Record<Level, string> = {
  view: "đọc tài liệu, memory, task",
  contribute: "+ đề xuất sửa tài liệu, ghi memory, nhận và cập nhật task",
  manage: "+ sửa và duyệt tài liệu, duyệt memory, tạo task",
};
const LEVEL_TONE: Record<Level, string> = { view: "neutral", contribute: "info", manage: "accent" };

/** A temporary password to hand over once: after a new account or a reset. */
function Handover({ shown, onClose }: { shown: { username: string; password: string; reset: boolean }; onClose: () => void }) {
  return (
    <Notice tone="ok" title={`${shown.reset ? "Mật khẩu tạm mới" : "Tài khoản mới"} của ${shown.username}: sao chép ngay, sẽ không hiện lại`}>
      <div className="flex w-full flex-wrap items-center gap-2 pt-1">
        <code className="min-w-0 flex-1 rounded-md bg-muted px-2 py-1 font-mono text-sm break-all text-foreground">{shown.password}</code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(shown.password)}>
          <Copy />
          Sao chép
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Đóng
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Gửi riêng cho người đó (không dán vào kênh chung). Lần đăng nhập đầu hub bắt đổi mật khẩu; sau đó app desktop đăng nhập bằng tài khoản này để lấy token cho máy.
      </p>
    </Notice>
  );
}

export function UsersPage() {
  const { client, me, projects } = useHive();
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
        title="Người dùng & quyền"
        subtitle="Mỗi người một tài khoản. Admin thấy mọi dự án; người khác chỉ thấy dự án được cấp, kể cả qua agent và MCP trên máy của họ. Dữ liệu Chung (tài liệu org, memory chung) ai đăng nhập cũng xem được."
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
              placeholder="tên đăng nhập, vd: lan.nguyen"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              aria-label="Tên đăng nhập"
            />
            <Input className="min-w-40 flex-1" placeholder="Tên hiển thị (tuỳ chọn)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-label="Tên hiển thị" />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={admin} onCheckedChange={(v) => setAdmin(v === true)} />
              Admin
            </label>
            <Button type="submit" disabled={!username.trim() || action.busy}>
              <UserPlus />
              Tạo tài khoản
            </Button>
          </form>
        </CardContent>
      </Card>
      <ErrorNote error={action.error} />
      {shown ? <Handover shown={shown} onClose={() => setShown(null)} /> : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Chưa có tài khoản.</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tài khoản</TableHead>
                <TableHead>Được thấy</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead>Đăng nhập gần nhất</TableHead>
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
                          {self ? <span className="text-muted-foreground"> (bạn)</span> : null}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">@{u.username}</span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      {u.admin ? (
                        <Badge tone="accent">Admin · mọi dự án</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {grants.map(([p, l]) => (
                            <Badge key={p} tone={LEVEL_TONE[l]} className="font-mono text-[11px]">
                              {p} · {LEVEL_LABEL[l]}
                            </Badge>
                          ))}
                          {grants.length ? null : <span className="text-xs text-muted-foreground">Chỉ dữ liệu Chung</span>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.disabled ? (
                        <Badge tone="danger">Đã khoá</Badge>
                      ) : u.mustChangePassword ? (
                        <Badge tone="warn">Chờ đổi mật khẩu tạm</Badge>
                      ) : (
                        <Badge tone="ok">Hoạt động</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatTime(u.lastLoginAt)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {u.admin ? null : (
                        <Button size="sm" variant="outline" onClick={() => setEditing(u)}>
                          Phân quyền
                        </Button>
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="ml-1 size-8" aria-label={`Thao tác với ${u.username}`}>
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
                                  ? `Bỏ quyền admin của ${u.username}? Người đó chỉ còn thấy các dự án được cấp.`
                                  : `Cấp quyền admin cho ${u.username}? Admin thấy và quản trị mọi dự án, quản lý tài khoản.`,
                              )
                            }
                          >
                            {u.admin ? "Bỏ quyền admin" : "Cấp quyền admin"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              if (!window.confirm(`Đặt lại mật khẩu của ${u.username}? Mọi phiên đăng nhập của người đó bị đăng xuất; token của máy vẫn dùng được.`)) return;
                              void action.run(async () => {
                                const password = await users.resetPassword(u.id);
                                setShown({ username: u.username, password, reset: true });
                                list.reload();
                              });
                            }}
                          >
                            Đặt lại mật khẩu
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={self}
                            variant={u.disabled ? "default" : "destructive"}
                            onSelect={() =>
                              update(
                                u,
                                { disabled: !u.disabled },
                                u.disabled ? undefined : `Khoá ${u.username}? Người đó bị đăng xuất, mọi token của họ (máy, agent, CI) ngừng hoạt động ngay.`,
                              )
                            }
                          >
                            {u.disabled ? "Mở khoá" : "Khoá tài khoản"}
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
      setAddError("Tên dự án: chữ thường, số, . _ -");
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
            Quyền của {user.displayName} <span className="font-mono text-sm font-normal text-muted-foreground">@{user.username}</span>
          </DialogTitle>
          <DialogDescription>
            Dự án để “Không” thì người này không thấy gì của dự án đó: không trong danh sách, không qua agent, không qua MCP.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
          {LEVELS.map((l) => (
            <li key={l} className="rounded-md bg-muted px-2 py-1.5">
              <span className="font-semibold text-foreground">{LEVEL_LABEL[l]}</span>: {LEVEL_HINT[l]}
            </li>
          ))}
        </ul>
        <div className="flex max-h-[45vh] flex-col divide-y overflow-y-auto rounded-md border">
          {rows.length === 0 ? <Empty>Chưa có dự án nào trên hub. Thêm tên dự án bên dưới.</Empty> : null}
          {rows.map((p) => (
            <div key={p} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 font-mono text-sm break-all">{p}</span>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={grants[p] ?? NONE}
                onValueChange={(v) => v && set(p, v as Level | typeof NONE)}
                aria-label={`Quyền trên ${p}`}
              >
                <ToggleGroupItem value={NONE} className={SEGMENT}>
                  Không
                </ToggleGroupItem>
                {LEVELS.map((l) => (
                  <ToggleGroupItem key={l} value={l} className={SEGMENT}>
                    {LEVEL_LABEL[l]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="h-8 min-w-40 flex-1 font-mono text-xs md:text-xs"
            placeholder="Dự án chưa có dữ liệu, vd: billing"
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
            aria-label="Thêm dự án"
          />
          <Button size="sm" variant="outline" onClick={add} disabled={!adding.trim()}>
            <Plus />
            Thêm dự án
          </Button>
        </div>
        <ErrorNote error={addError ?? action.error} />
        <p className="text-xs text-muted-foreground">
          Người có quyền Đóng góp ở ít nhất một dự án cũng được đề xuất tài liệu Chung và ghi memory Chung (chờ admin duyệt). Token agent của người này tối đa ở mức Đóng góp.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Huỷ
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
            {action.busy ? "Đang lưu…" : "Lưu quyền"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
