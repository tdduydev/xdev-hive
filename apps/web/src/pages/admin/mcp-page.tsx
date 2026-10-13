import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { McpAdminTool, McpServerRule, McpUserToken } from "@xdev-hive/contracts";
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
import { Copy, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { type Dict, useLang, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import { McpServersTab } from "@/pages/admin/mcp-servers-tab.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  crumb: string;
  lead: string;
  tools: string;
  servers: string;
  tokens: string;
  searchTools: string;
  searchTokens: string;
  copyEndpoint: string;
  newToken: string;
  addServer: string;
  group: string;
  caller: string;
  calls: string;
  errors: string;
  state: string;
  on: string;
  off: string;
  groups: Record<McpAdminTool["group"], string>;
  callers: Record<McpAdminTool["caller"], string>;
  owner: string;
  lifetime: string;
  expires: string;
  last: string;
  actions: string;
  revoke: string;
  extend: string;
  cancel: string;
  close: string;
  copy: string;
  copied: string;
  once: string;
  days: string;
  loading: string;
  noTokens: string;
  noTools: string;
  memberHint: string;
  expired: string;
  expiring: string;
  valid: string;
  revoked: string;
  never: string;
  revokeTitle: string;
  revokeHint: string;
  extendTitle: string;
  extendHint: string;
  copyError: string;
  failed: string;
  retry: string;
  descriptions: Record<string, string>;
}> = {
  vi: {
    title: "MCP và công cụ",
    crumb: "Quản trị agent",
    lead: "Tool agent gọi được qua cổng MCP của hub, MCP server ngoài được phép dùng, và token của người dùng.",
    tools: "Tool của hub",
    servers: "MCP server ngoài",
    tokens: "Token MCP",
    searchTools: "Tìm tool…",
    searchTokens: "Tìm token, người, client…",
    copyEndpoint: "Chép địa chỉ",
    newToken: "Tạo token",
    addServer: "Thêm server",
    group: "Nhóm",
    caller: "Ai gọi được",
    calls: "Lượt gọi 7 ngày",
    errors: "Lỗi",
    state: "Trạng thái",
    on: "Bật",
    off: "Tắt",
    groups: { knowledge: "Kiến thức", tasks: "Việc", runs: "Run", tenancy: "Tổ chức", leader: "Leader" },
    callers: { runs: "Token của run", users: "Người dùng", both: "Run và người dùng" },
    owner: "Chủ",
    lifetime: "Thời hạn",
    expires: "Hết hạn",
    last: "Dùng lần cuối",
    actions: "Thao tác",
    revoke: "Thu hồi",
    extend: "Gia hạn",
    cancel: "Huỷ",
    close: "Đóng",
    copy: "Chép token",
    copied: "Đã chép",
    once: "Token chỉ hiện một lần. Hãy chép và lưu ở nơi an toàn; bạn không thể xem lại token sau khi đóng hộp thoại.",
    days: "ngày",
    loading: "Đang tải…",
    noTokens: "Chưa có token MCP. Tạo token để kết nối client của bạn.",
    noTools: "Chưa có tool MCP.",
    memberHint:
      "Bạn quản lý token của mình. Chỉ chủ sở hữu và quản trị được bật/tắt tool, xem và gia hạn token của mọi người.",
    expired: "Đã hết hạn",
    expiring: "Sắp hết hạn",
    valid: "Còn hạn",
    revoked: "Đã thu hồi",
    never: "Chưa dùng",
    revokeTitle: "Thu hồi token?",
    revokeHint: "Client dùng token này sẽ bị từ chối ở lần gọi kế tiếp.",
    extendTitle: "Gia hạn token",
    extendHint: "Hạn mới tính từ hôm nay, tối đa 90 ngày. Token đã thu hồi không thể gia hạn.",
    copyError: "Không chép được. Hãy chọn và chép token thủ công.",
    failed: "Không tải được dữ liệu MCP.",
    retry: "Thử lại",
    descriptions: {},
  },
  en: {
    title: "MCP and tools",
    crumb: "Agent administration",
    lead: "Tools agents call through the hub MCP gateway, allowed external MCP servers, and user tokens.",
    tools: "Hub tools",
    servers: "External MCP servers",
    tokens: "MCP tokens",
    searchTools: "Search tools…",
    searchTokens: "Search token, owner, client…",
    copyEndpoint: "Copy endpoint",
    newToken: "New token",
    addServer: "Add server",
    group: "Group",
    caller: "Who can call",
    calls: "Calls, 7d",
    errors: "Errors",
    state: "State",
    on: "On",
    off: "Off",
    groups: { knowledge: "Knowledge", tasks: "Tasks", runs: "Runs", tenancy: "Organization", leader: "Leader" },
    callers: { runs: "Run token", users: "Users", both: "Runs and users" },
    owner: "Owner",
    lifetime: "Lifetime",
    expires: "Expires",
    last: "Last used",
    actions: "Actions",
    revoke: "Revoke",
    extend: "Extend",
    cancel: "Cancel",
    close: "Close",
    copy: "Copy token",
    copied: "Copied",
    once: "This token is shown only once. Copy and store it safely; you cannot view it again after closing this dialog.",
    days: "days",
    loading: "Loading…",
    noTokens: "No MCP tokens yet. Create a token to connect your client.",
    noTools: "No MCP tools yet.",
    memberHint:
      "You manage your own tokens. Only owners and administrators can toggle tools, view and extend everyone's tokens.",
    expired: "Expired",
    expiring: "Expiring soon",
    valid: "Valid",
    revoked: "Revoked",
    never: "Never used",
    revokeTitle: "Revoke token?",
    revokeHint: "Clients using this token will be rejected on their next request.",
    extendTitle: "Extend token",
    extendHint: "The new expiry is measured from today, up to 90 days. Revoked tokens cannot be extended.",
    copyError: "Could not copy. Select and copy the token manually.",
    failed: "Could not load MCP data.",
    retry: "Retry",
    descriptions: {
      doc_list: "List docs in scope",
      doc_get: "Read a doc",
      doc_propose: "Propose a doc edit",
      skill_list: "List skills",
      skill_get: "Read a SKILL.md",
      skill_propose: "Propose a skill edit",
      mcp_server_list: "Allowed external MCP servers",
      memory_search: "Search memory",
      memory_write: "Write a memory (pending)",
      task_get: "Read the current task",
      task_update: "Update progress",
      plan_submit: "Submit a plan",
      review_submit: "Submit a cross-review",
      hive_whoami: "Current user, organization and role",
      orgs_list: "List your organizations",
      teams_list: "List teams",
      systems_list: "List systems",
      leader_reply: "Reply to a leader thread",
      leader_propose: "Propose a leader action",
    },
  },
};

export function McpPage() {
  const { org } = useOrg();
  return <McpOrgPage key={org.id} />;
}

function McpOrgPage() {
  const t = useT(text);
  const lang = useLang();
  const { org, api } = useOrg();
  const canManage = org.role === "owner" || org.role === "admin";
  // Quy tắc server ngoài: quản trị tổ chức hoặc vai trò tự tạo có mcp.servers (hub kiểm lại).
  const canManageServers = usePermissions()("mcp.servers");
  const queryClient = useQueryClient();
  const tools = useQuery(api.mcpAdmin.listTools.queryOptions({ refetchInterval: 30_000 }));
  const tokens = useQuery(api.mcpAdmin.listTokens.queryOptions({ refetchInterval: 30_000 }));
  const servers = useQuery({ ...api.mcpAdmin.listServers.queryOptions(), enabled: canManageServers });
  const [tab, setTab] = useState("tools");
  const [editingServer, setEditingServer] = useState<McpServerRule | "new" | null>(null);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [clientId, setClientId] = useState("cursor");
  const [days, setDays] = useState(30);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<{ token: McpUserToken; action: "revoke" | "extend" } | null>(null);
  const [extensionDays, setExtensionDays] = useState(90);
  const refreshTokens = () => queryClient.invalidateQueries({ queryKey: api.mcpAdmin.listTokens.key() });
  const toggle = useMutation({
    mutationFn: (input: { toolName: string; enabled: boolean }) => api.mcpAdmin.setTool.call(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: api.mcpAdmin.listTools.key() }),
  });
  const create = useMutation({
    gcTime: 0,
    mutationFn: () => api.mcpAdmin.createToken.call({ clientId, lifetimeDays: days }),
    onSuccess: (result) => {
      setSecret(result.token);
      create.reset();
      void refreshTokens();
    },
  });
  const manage = useMutation({
    mutationFn: async (input: { id: string; action: "revoke" | "extend" }) => {
      if (input.action === "revoke") await api.mcpAdmin.revokeToken.call({ id: input.id });
      else await api.mcpAdmin.extendToken.call({ id: input.id, lifetimeDays: extensionDays });
    },
    onSuccess: () => {
      setSelected(null);
      void refreshTokens();
    },
  });
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(t.copied);
    } catch {
      setNotice(t.copyError);
    }
  };
  const date = (value: string) =>
    new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en", { dateStyle: "medium" }).format(new Date(value));
  const status = (token: McpUserToken) =>
    token.revokedAt
      ? t.revoked
      : new Date(token.expiresAt).getTime() <= Date.now()
        ? t.expired
        : new Date(token.expiresAt).getTime() - Date.now() < 7 * 86_400_000
          ? t.expiring
          : t.valid;
  const toolColumns: Column<McpAdminTool>[] = [
    {
      key: "name",
      label: "Tool",
      value: (r) => `${r.name} ${t.descriptions[r.name] ?? r.description}`,
      sortable: true,
      hideable: false,
      cell: (r) => (
        <div className="max-w-64">
          <span className="font-mono font-medium">{r.name}</span>
          <p className="text-xs text-muted-foreground">{t.descriptions[r.name] ?? r.description}</p>
        </div>
      ),
    },
    { key: "group", label: t.group, value: (r) => t.groups[r.group] },
    { key: "caller", label: t.caller, value: (r) => t.callers[r.caller], className: "text-muted-foreground" },
    { key: "calls", label: t.calls, value: (r) => r.calls, sortable: true, className: "font-mono text-right" },
    { key: "errors", label: t.errors, value: (r) => r.errors, sortable: true, className: "font-mono text-right" },
    {
      key: "state",
      label: t.state,
      value: (r) => (r.enabled ? t.on : t.off),
      cell: (r) => (
        <div className="flex items-center gap-3">
          <Pill tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? t.on : t.off}</Pill>
          <Switch
            aria-label={`${t.state} ${r.name}`}
            checked={r.enabled}
            disabled={!canManage || toggle.isPending}
            onCheckedChange={(enabled) => toggle.mutate({ toolName: r.name, enabled })}
          />
        </div>
      ),
    },
  ];
  const tokenColumns: Column<McpUserToken>[] = [
    {
      key: "name",
      label: "Token",
      value: (r) => `${r.clientId} ${r.prefix}`,
      sortable: true,
      hideable: false,
      cell: (r) => (
        <div>
          <span className="font-medium">{r.clientId}</span>
          <p className="font-mono text-xs text-muted-foreground">{r.prefix}…</p>
        </div>
      ),
    },
    {
      key: "owner",
      label: t.owner,
      value: (r) => `${r.ownerName ?? r.userId} ${r.userId}`,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Avatar size="sm">
            <AvatarFallback>
              {(r.ownerName ?? r.userId)
                .split(/\s+/)
                .slice(-2)
                .map((part) => part[0])
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div>
            <span>{r.ownerName ?? r.userId}</span>
            <p className="text-xs text-muted-foreground">{r.clientId}</p>
          </div>
        </div>
      ),
    },
    {
      key: "lifetime",
      label: t.lifetime,
      value: (r) =>
        `${Math.ceil((new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime()) / 86_400_000)} ${t.days}`,
    },
    {
      key: "expires",
      label: t.expires,
      value: (r) => r.expiresAt,
      sortable: true,
      cell: (r) => (
        <div className="space-y-1">
          <Pill tone={status(r) === t.expiring ? "warn" : status(r) === t.valid ? "ok" : "neutral"}>{status(r)}</Pill>
          <p className="text-xs text-muted-foreground">{date(r.expiresAt)}</p>
        </div>
      ),
    },
    {
      key: "last",
      label: t.last,
      value: (r) => r.lastUsedAt,
      sortable: true,
      cell: (r) => (r.lastUsedAt ? date(r.lastUsedAt) : t.never),
    },
    {
      key: "actions",
      label: t.actions,
      value: () => "",
      hideable: false,
      cell: (r) => (
        <div className="flex gap-2">
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              disabled={!!r.revokedAt}
              onClick={() => {
                manage.reset();
                setSelected({ token: r, action: "extend" });
              }}
            >
              {t.extend}
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            disabled={!!r.revokedAt}
            onClick={() => {
              manage.reset();
              setSelected({ token: r, action: "revoke" });
            }}
          >
            {t.revoke}
          </Button>
        </div>
      ),
    },
  ];
  const endpoint = `${window.location.origin}/mcp`;
  return (
    <>
      <PageHeader crumb={t.crumb} title={t.title}>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          <code className="max-w-full break-all rounded-lg border border-border bg-card px-3 py-1.5 text-xs">
            {endpoint}
          </code>
          {tab === "tokens" ? (
            <Button
              onClick={() => {
                setSecret(null);
                setNotice("");
                create.reset();
                setCreating(true);
              }}
            >
              <KeyRound aria-hidden="true" />
              {t.newToken}
            </Button>
          ) : tab === "servers" && canManageServers ? (
            <Button onClick={() => setEditingServer("new")}>
              <Plus aria-hidden="true" />
              {t.addServer}
            </Button>
          ) : (
            <Button onClick={() => void copy(endpoint)}>
              <Copy aria-hidden="true" />
              {t.copyEndpoint}
            </Button>
          )}
        </div>
      </PageHeader>
      <PageBody>
        <p className="-mt-2 text-sm text-muted-foreground">{t.lead}</p>
        {!canManage && <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t.memberHint}</p>}
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {toggle.error && (
          <p role="alert" className="text-destructive">
            {toggle.error.message}
          </p>
        )}
        <Tabs
          value={tab}
          onValueChange={(value) => {
            setTab(String(value));
            setNotice("");
          }}
        >
          <TabsList variant="line" className="h-auto w-full flex-wrap justify-start gap-4 border-b border-border p-0">
            <TabsTrigger className="min-h-10 flex-none px-1 whitespace-normal after:!bottom-[-1px]" value="tools">
              {t.tools}
              <Pill small>{tools.data?.tools.length ?? "—"}</Pill>
            </TabsTrigger>
            <TabsTrigger className="min-h-10 flex-none px-1 whitespace-normal after:!bottom-[-1px]" value="servers">
              {t.servers}
              {canManageServers && <Pill small>{servers.data?.rules.length ?? "—"}</Pill>}
            </TabsTrigger>
            <TabsTrigger className="min-h-10 flex-none px-1 whitespace-normal after:!bottom-[-1px]" value="tokens">
              {t.tokens}
              <Pill small>{tokens.data?.tokens.length ?? "—"}</Pill>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tools">
            {tools.isPending ? (
              <p role="status">{t.loading}</p>
            ) : tools.error ? (
              <div role="alert">
                <p>{t.failed}</p>
                <Button variant="outline" onClick={() => void tools.refetch()}>
                  {t.retry}
                </Button>
              </div>
            ) : (
              <DataTable
                columns={toolColumns}
                rows={tools.data.tools}
                selectable={false}
                caption={t.tools}
                placeholder={t.searchTools}
                emptyContent={t.noTools}
                facets={[
                  { key: "group", label: t.group, value: (r) => t.groups[r.group] },
                  { key: "state", label: t.state, value: (r) => (r.enabled ? t.on : t.off) },
                  { key: "caller", label: t.caller, value: (r) => t.callers[r.caller] },
                ]}
              />
            )}
          </TabsContent>
          <TabsContent value="servers">
            <McpServersTab canManage={canManageServers} editing={editingServer} onEdit={setEditingServer} />
          </TabsContent>
          <TabsContent value="tokens">
            {tokens.isPending ? (
              <p role="status">{t.loading}</p>
            ) : tokens.error ? (
              <div role="alert">
                <p>{t.failed}</p>
                <Button variant="outline" onClick={() => void tokens.refetch()}>
                  {t.retry}
                </Button>
              </div>
            ) : (
              <DataTable
                columns={tokenColumns}
                rows={tokens.data.tokens}
                selectable={false}
                caption={t.tokens}
                placeholder={t.searchTokens}
                emptyContent={t.noTokens}
                facets={[
                  { key: "expiry", label: t.expires, value: status },
                  { key: "client", label: "Client", value: (r) => r.clientId },
                ]}
              />
            )}
          </TabsContent>
        </Tabs>
        <Dialog
          open={creating}
          onOpenChange={(open) => {
            if (create.isPending) return;
            setCreating(open);
            if (!open) {
              setSecret(null);
              create.reset();
              setNotice("");
            }
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{t.newToken}</DialogTitle>
              <DialogDescription>{t.once}</DialogDescription>
            </DialogHeader>
            {secret ? (
              <>
                <Input
                  aria-label="Token"
                  className="font-mono text-xs"
                  readOnly
                  value={secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button onClick={() => void copy(secret)}>
                  <Copy aria-hidden="true" />
                  {t.copy}
                </Button>
                {notice && <p role="status">{notice}</p>}
                <DialogActions>
                  <Button
                    onClick={() => {
                      setSecret(null);
                      setCreating(false);
                      setNotice("");
                    }}
                  >
                    {t.close}
                  </Button>
                </DialogActions>
              </>
            ) : (
              <form
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  create.mutate();
                }}
              >
                <label htmlFor="mcp-client" className="grid gap-1.5">
                  Client
                  <NativeSelect
                    id="mcp-client"
                    aria-label="Client"
                    value={clientId}
                    onChange={(event) => setClientId(event.currentTarget.value)}
                  >
                    {["claude-code", "cursor", "vscode", "codex", "hermes"].map((client) => (
                      <option key={client} value={client}>
                        {client}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label htmlFor="mcp-lifetime" className="grid gap-1.5">
                  {t.lifetime}
                  <NativeSelect
                    id="mcp-lifetime"
                    aria-label={t.lifetime}
                    value={days}
                    onChange={(event) => setDays(Number(event.currentTarget.value))}
                  >
                    {[7, 30, 90].map((n) => (
                      <option key={n} value={n}>
                        {n} {t.days}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                {create.error && (
                  <p role="alert" className="text-destructive">
                    {create.error.message}
                  </p>
                )}
                <DialogActions>
                  <Button variant="outline" disabled={create.isPending} onClick={() => setCreating(false)}>
                    {t.cancel}
                  </Button>
                  <Button type="submit" disabled={create.isPending}>
                    {create.isPending ? t.loading : t.newToken}
                  </Button>
                </DialogActions>
              </form>
            )}
          </DialogContent>
        </Dialog>
        <Dialog
          open={!!selected}
          onOpenChange={(open) => {
            if (!open && !manage.isPending) setSelected(null);
          }}
        >
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{selected?.action === "extend" ? t.extendTitle : t.revokeTitle}</DialogTitle>
              <DialogDescription>{selected?.action === "extend" ? t.extendHint : t.revokeHint}</DialogDescription>
            </DialogHeader>
            <p className="break-all font-mono text-xs">
              {selected?.token.clientId} · {selected?.token.prefix}…
            </p>
            {selected?.action === "extend" && (
              <label htmlFor="mcp-extension-lifetime" className="grid gap-1.5">
                {t.lifetime}
                <NativeSelect
                  id="mcp-extension-lifetime"
                  aria-label={t.lifetime}
                  value={extensionDays}
                  onChange={(event) => setExtensionDays(Number(event.currentTarget.value))}
                >
                  {[30, 90].map((n) => (
                    <option key={n} value={n}>
                      {n} {t.days}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {manage.error && (
              <p role="alert" className="text-destructive">
                {manage.error.message}
              </p>
            )}
            <DialogActions>
              <Button variant="outline" disabled={manage.isPending} onClick={() => setSelected(null)}>
                {t.cancel}
              </Button>
              <Button
                variant={selected?.action === "revoke" ? "destructive" : "default"}
                disabled={manage.isPending}
                onClick={() => {
                  if (selected) manage.mutate({ id: selected.token.id, action: selected.action });
                }}
              >
                {manage.isPending ? t.loading : selected?.action === "extend" ? t.extend : t.revoke}
              </Button>
            </DialogActions>
          </DialogContent>
        </Dialog>
      </PageBody>
    </>
  );
}
