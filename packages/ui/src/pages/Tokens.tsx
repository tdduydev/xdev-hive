import { ResponsiveTable as Table, ResponsiveTableRow as TableRow } from "#ui/components/ResponsiveTable.tsx";
import { useState } from "react";
import { Copy } from "lucide-react";
import { TOKEN_ROLES, type Role } from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent } from "@xdev-hive/ui/components/ui/card";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { TableBody, TableCell, TableHead, TableHeader } from "@xdev-hive/ui/components/ui/table";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, STATUS_TONE, StatusDot } from "#ui/components/common.tsx";
import { formatTime, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";

export function TokensPage() {
  const { client, me } = useHive();
  const t = useT();
  const tokens = client.tokens!;
  const hubAdmin = me.role === "admin" && !me.access;
  // A person creates agent/viewer tokens for their own CI and scripts; machines get theirs at desktop sign-in. No token
  // is admin (spec 79a): a hub admin may add a member token, or a release token for release.mjs.
  const roles: Array<Role | "release"> = hubAdmin ? [...TOKEN_ROLES.filter((r) => r !== "admin"), "release"] : ["agent", "viewer"];
  const list = useQuery(() => tokens.list(), [tokens]);
  const owners = useQuery(async () => (hubAdmin && client.users ? await client.users.list() : []), [client, hubAdmin]);
  const ownerName = new Map((owners.data ?? []).map((u) => [u.id, u.username]));
  // Machines report as runner.<machine>@<token name>: group them under their token.
  const machines = useQuery(() => (hubAdmin ? client.call("admin.machines", {}) : client.call("machines.list", {})), [client, hubAdmin]);
  const byToken = new Map<string, Array<{ machine: string; online: boolean }>>();
  for (const m of machines.data ?? []) {
    const name = m.id.slice(m.id.lastIndexOf("@") + 1);
    byToken.set(name, [...(byToken.get(name) ?? []), { machine: m.machine, online: m.online }]);
  }
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role | "release">("agent");
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const action = useAction();

  return (
    <Page>
      <PageHeader
        title={t("tokens.title")}
        subtitle={hubAdmin ? t("tokens.subtitleAdmin") : t("tokens.subtitleMember")}
      />
      <Card className="py-4">
        <CardContent className="px-4">
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const res = role === "release" ? await tokens.create(name.trim(), "viewer", { releaseUpload: true }) : await tokens.create(name.trim(), role);
                setCreated({ name: res.info.name, token: res.token });
                setName("");
                list.reload();
              });
            }}
          >
            <Input
              className="min-w-48 flex-1"
              placeholder={t("tokens.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={t("tokens.name")}
            />
            <NativeSelect value={role} onChange={(e) => setRole(e.target.value as Role | "release")} aria-label={t("tokens.role")}>
              {roles.map((r) => (
                <NativeSelectOption key={r} value={r}>
                  {r === "release" ? t("tokens.releaseRole") : t(`tokenRole.${r}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button type="submit" disabled={!name.trim() || action.busy}>
              {t("tokens.create")}
            </Button>
          </form>
        </CardContent>
      </Card>
      <ErrorNote error={action.error} />
      {created ? (
        <Notice tone="ok" title={t("tokens.created", { name: created.name })}>
          <div className="flex w-full flex-wrap items-center gap-2 pt-1">
            <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">{created.token}</code>
            <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(created.token)}>
              <Copy />
              {t("common.copy")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
              {t("common.close")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {rich(t("tokens.mcpHint"), {
              endpoint: <code className="font-mono">POST /mcp</code>,
              header: <code className="font-mono">Authorization: Bearer …</code>,
            })}
          </p>
        </Notice>
      ) : null}
      <ErrorNote error={list.error} />
      {list.data?.length === 0 ? <Empty>{t("tokens.none")}</Empty> : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("tokens.name")}</TableHead>
                <TableHead>{t("tokens.role")}</TableHead>
                {hubAdmin ? <TableHead>{t("tokens.owner")}</TableHead> : null}
                <TableHead>{t("tokens.machines")}</TableHead>
                <TableHead>{t("tokens.createdAt")}</TableHead>
                <TableHead>{t("tokens.lastUsed")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((tok) => (
                <TableRow key={tok.id}>
                  <TableCell className="font-medium">{tok.name}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      {tok.releaseUpload ? (
                        <Badge tone="running">{t("tokens.releaseBadge")}</Badge>
                      ) : (
                        // An admin token acts as a member (spec 79a): the badge says what it can do, not what was stored.
                        <Badge tone={STATUS_TONE[tok.role === "admin" ? "member" : tok.role]}>{t(`role.${tok.role === "admin" ? "member" : tok.role}`)}</Badge>
                      )}
                    </div>
                  </TableCell>
                  {hubAdmin ? (
                    <TableCell className="font-mono text-xs">
                      {tok.ownerId ? (
                        `@${ownerName.get(tok.ownerId) ?? tok.ownerId}`
                      ) : (
                        <span className="flex flex-col items-start gap-1" data-token-ownerless>
                          <span className="text-muted-foreground">{t("tokens.noOwner")}</span>
                          <Badge tone="warn">{t("tokens.ownerlessBadge")}</Badge>
                          <span className="font-sans text-muted-foreground">{t("tokens.ownerlessHint")}</span>
                        </span>
                      )}
                    </TableCell>
                  ) : null}
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      {(byToken.get(tok.name) ?? []).map((m) => (
                        <span key={m.machine} className="flex items-center gap-2 font-mono text-xs">
                          <StatusDot tone={m.online ? "ok" : "neutral"} />
                          {m.machine}
                        </span>
                      ))}
                      {byToken.get(tok.name)?.length ? null : <span className="text-muted-foreground">—</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(tok.createdAt)}</TableCell>
                  <TableCell className="text-muted-foreground">{formatTime(tok.lastUsedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => {
                        if (window.confirm(t("tokens.confirmRevoke", { name: tok.name }))) {
                          void action.run(async () => {
                            await tokens.revoke(tok.id);
                            list.reload();
                          });
                        }
                      }}
                    >
                      {t("tokens.revoke")}
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
