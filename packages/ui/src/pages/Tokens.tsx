import { useState } from "react";
import { Copy } from "lucide-react";
import { ROLES, type Role } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE, StatusDot } from "../components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "../hooks.ts";

const ROLE_HINT: Record<Role, string> = {
  viewer: "Chỉ xem",
  agent: "Agent: đọc, đề xuất, ghi memory, nhận task",
  admin: "Admin: sửa và duyệt tài liệu, quản lý token",
};

export function TokensPage() {
  const { client } = useHive();
  const tokens = client.tokens!;
  const list = useQuery(() => tokens.list(), [tokens]);
  // Machines report as runner.<machine>@<token name>: group them under their token.
  const machines = useQuery(() => client.call("admin.machines", {}), [client]);
  const byToken = new Map<string, Array<{ machine: string; online: boolean }>>();
  for (const m of machines.data ?? []) {
    const name = m.id.slice(m.id.lastIndexOf("@") + 1);
    byToken.set(name, [...(byToken.get(name) ?? []), { machine: m.machine, online: m.online }]);
  }
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("agent");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const action = useAction();

  return (
    <Page>
      <PageHeader
        title="Token truy cập"
        subtitle="Mỗi người hoặc mỗi máy một token. Agent dùng token vai trò agent. Token chỉ hiện một lần lúc tạo."
      />
      <Card className="py-4">
        <CardContent className="px-4">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const res = await tokens.create(name.trim(), role);
                setCreated({ name: res.info.name, token: res.token });
                setName("");
                list.reload();
              });
            }}
          >
            <Input
              className="min-w-48 flex-1"
              placeholder="Tên, ví dụ duy-macbook hoặc ci-gitlab"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Tên token"
            />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Vai trò">
              {ROLES.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {ROLE_HINT[r]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="submit" disabled={!name.trim() || action.busy}>
              Tạo token
            </Button>
          </form>
        </CardContent>
      </Card>
      <ErrorNote error={action.error} />
      {created ? (
        <Notice tone="ok" title={`Token ${created.name}: sao chép ngay, sẽ không hiện lại`}>
          <div className="flex w-full flex-wrap items-center gap-2 pt-1">
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{created.token}</code>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(created.token)}>
              <Copy />
              Sao chép
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              Đóng
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Dán vào app desktop (Dự án &amp; cài đặt → Hub) hoặc dùng trực tiếp cho MCP qua HTTP: <code className="font-mono">POST /mcp</code>, header{" "}
            <code className="font-mono">Authorization: Bearer …</code>
          </p>
        </Notice>
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>Chưa có token.</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tên</TableHead>
                <TableHead>Vai trò</TableHead>
                <TableHead>Máy</TableHead>
                <TableHead>Tạo lúc</TableHead>
                <TableHead>Dùng gần nhất</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell>
                    <Badge tone={STATUS_TONE[t.role]}>{t.role}</Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {(byToken.get(t.name) ?? []).map((m) => (
                        <span key={m.machine} className="flex items-center gap-2 font-mono text-xs">
                          <StatusDot tone={m.online ? "ok" : "neutral"} />
                          {m.machine}
                        </span>
                      ))}
                      {byToken.get(t.name)?.length ? null : <span className="text-muted-foreground">—</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(t.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(t.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(`Thu hồi token "${t.name}"? Máy/agent đang dùng sẽ mất quyền truy cập ngay.`)) {
                          void action.run(async () => {
                            await tokens.revoke(t.id);
                            list.reload();
                          });
                        }
                      }}
                    >
                      Thu hồi
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </Page>
  );
}
