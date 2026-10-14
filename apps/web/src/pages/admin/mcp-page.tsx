import { Tabs } from "@base-ui/react/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { McpAdminTool, McpUserToken } from "@xdev-hive/contracts";
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
import { Copy, KeyRound } from "lucide-react";
import { useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { Field, FieldLabel } from "@/components/ui/field.tsx";
import { LoadFailure, TableSkeleton } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { formatDay } from "@/lib/format.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { usePermissions } from "@/lib/permissions.ts";
import type { McpTab as McpSearchTab } from "@/lib/route-search.ts";
import { McpServersTab } from "@/pages/admin/mcp-servers-tab.tsx";
import { useOrg } from "@/shell/org-context.ts";
import { PageBody, PageHeader, PageTab, PageTabList } from "@/shell/page-header.tsx";

const text: Dict<{
  title: string;
  lead: string;
  endpoint: string;
  tabs: string;
  tools: string;
  servers: string;
  tokens: string;
  searchTools: string;
  searchTokens: string;
  copyEndpoint: string;
  newToken: string;
  creating: string;
  saving: string;
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
  turnOn: string;
  turnOff: string;
  turnOnTitle: (name: string) => string;
  turnOffTitle: (name: string) => string;
  turnOnHint: string;
  turnOffHint: string;
  turnOnConfirm: string;
  turnOffConfirm: string;
  cancel: string;
  close: string;
  copy: string;
  copied: string;
  once: string;
  days: string;
  loading: string;
  noTokensTitle: string;
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
  descriptions: Record<string, string>;
}> = {
  vi: {
    title: "MCP và công cụ",
    lead: "Tool agent gọi được qua cổng MCP của hub, MCP server ngoài được phép dùng, và token của người dùng.",
    endpoint: "Cổng MCP:",
    tabs: "Nhóm MCP",
    tools: "Tool của hub",
    servers: "MCP server ngoài",
    tokens: "Token MCP",
    searchTools: "Tìm tool…",
    searchTokens: "Tìm token, người, client…",
    copyEndpoint: "Chép địa chỉ",
    newToken: "Tạo token",
    creating: "Đang tạo…",
    saving: "Đang lưu…",
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
    turnOn: "Bật",
    turnOff: "Tắt",
    turnOnTitle: (n) => `Bật tool ${n}?`,
    turnOffTitle: (n) => `Tắt tool ${n}?`,
    turnOnHint: "Run và người dùng có quyền gọi lại được tool này qua cổng MCP của hub.",
    turnOffHint: "Cổng MCP của hub từ chối mọi lượt gọi tool này, của run lẫn người dùng, cho tới khi bật lại.",
    turnOnConfirm: "Bật tool",
    turnOffConfirm: "Tắt tool",
    cancel: "Huỷ",
    close: "Đóng",
    copy: "Chép token",
    copied: "Đã chép",
    once: "Token chỉ hiện một lần. Hãy chép và lưu ở nơi an toàn; bạn không thể xem lại token sau khi đóng hộp thoại.",
    days: "ngày",
    loading: "Đang tải dữ liệu MCP…",
    noTokensTitle: "Chưa có token MCP",
    noTokens: "Tạo token để kết nối client của bạn (Claude Code, Cursor, VS Code…).",
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
    copyError: "Không chép được. Hãy chọn và chép thủ công.",
    descriptions: {},
  },
  en: {
    title: "MCP and tools",
    lead: "Tools agents call through the hub MCP gateway, allowed external MCP servers, and user tokens.",
    endpoint: "MCP gateway:",
    tabs: "MCP areas",
    tools: "Hub tools",
    servers: "External MCP servers",
    tokens: "MCP tokens",
    searchTools: "Search tools…",
    searchTokens: "Search token, owner, client…",
    copyEndpoint: "Copy endpoint",
    newToken: "New token",
    creating: "Creating…",
    saving: "Saving…",
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
    turnOn: "Turn on",
    turnOff: "Turn off",
    turnOnTitle: (n) => `Turn on tool ${n}?`,
    turnOffTitle: (n) => `Turn off tool ${n}?`,
    turnOnHint: "Runs and users with access can call this tool through the hub MCP gateway again.",
    turnOffHint:
      "The hub MCP gateway rejects every call to this tool, from runs and users, until it is turned back on.",
    turnOnConfirm: "Turn on tool",
    turnOffConfirm: "Turn off tool",
    cancel: "Cancel",
    close: "Close",
    copy: "Copy token",
    copied: "Copied",
    once: "This token is shown only once. Copy and store it safely; you cannot view it again after closing this dialog.",
    days: "days",
    loading: "Loading MCP data…",
    noTokensTitle: "No MCP tokens yet",
    noTokens: "Create a token to connect your client (Claude Code, Cursor, VS Code…).",
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
    copyError: "Could not copy. Select and copy it manually.",
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

type McpTab = "tools" | NonNullable<McpSearchTab>;

function McpOrgPage() {
  const t = useT(text);
  const { org, api } = useOrg();
  const navigate = useNavigate();
  const search = useSearch({ from: "/session/app/in-org/admin/mcp" });
  const canManage = org.role === "owner" || org.role === "admin";
  // Quy tắc server ngoài: quản trị tổ chức hoặc vai trò tự tạo có mcp.servers (hub kiểm lại).
  const canManageServers = usePermissions()("mcp.servers");
  const queryClient = useQueryClient();
  const tools = useQuery(api.mcpAdmin.listTools.queryOptions({ refetchInterval: 30_000 }));
  const tokens = useQuery(api.mcpAdmin.listTokens.queryOptions({ refetchInterval: 30_000 }));
  const servers = useQuery({ ...api.mcpAdmin.listServers.queryOptions(), enabled: canManageServers });
  const tab: McpTab = search.tab && (search.tab !== "server" || canManageServers) ? search.tab : "tools";
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [clientId, setClientId] = useState("cursor");
  const [days, setDays] = useState(30);
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<{ token: McpUserToken; action: "revoke" | "extend" } | null>(null);
  const [toggling, setToggling] = useState<McpAdminTool | null>(null);
  const [extensionDays, setExtensionDays] = useState(90);
  const refreshTokens = () => queryClient.invalidateQueries({ queryKey: api.mcpAdmin.listTokens.key() });
  const toggle = useMutation({
    mutationFn: (input: { toolName: string; enabled: boolean }) => api.mcpAdmin.setTool.call(input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: api.mcpAdmin.listTools.key() });
      setToggling(null);
    },
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
      pin: "start",
      cell: (r) => (
        <div className="max-w-64 min-w-0">
          <span className="font-mono font-medium">{r.name}</span>
          <p className="truncate text-xs text-muted-foreground">{t.descriptions[r.name] ?? r.description}</p>
        </div>
      ),
    },
    { key: "group", label: t.group, value: (r) => t.groups[r.group] },
    // Ẩn mặc định (vẫn lọc được bằng facet) để bảng vừa cột nội dung khoảng 790 px ở màn 1100.
    {
      key: "caller",
      label: t.caller,
      value: (r) => t.callers[r.caller],
      hidden: true,
      className: "text-muted-foreground",
    },
    { key: "calls", label: t.calls, value: (r) => r.calls, sortable: true, align: "end" },
    { key: "errors", label: t.errors, value: (r) => r.errors, sortable: true, align: "end" },
    {
      key: "state",
      label: t.state,
      value: (r) => (r.enabled ? t.on : t.off),
      cell: (r) => (
        <Pill tone={r.enabled ? "ok" : "neutral"} dot>
          {r.enabled ? t.on : t.off}
        </Pill>
      ),
    },
    ...(canManage
      ? [
          {
            key: "actions",
            label: t.actions,
            value: () => "",
            hideable: false,
            align: "end",
            pin: "end",
            cell: (r) => (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${r.enabled ? t.turnOff : t.turnOn} ${r.name}`}
                onClick={() => {
                  toggle.reset();
                  setToggling(r);
                }}
              >
                {r.enabled ? t.turnOff : t.turnOn}
              </Button>
            ),
          } satisfies Column<McpAdminTool>,
        ]
      : []),
  ];
  const tokenColumns: Column<McpUserToken>[] = [
    {
      key: "name",
      label: "Token",
      value: (r) => `${r.clientId} ${r.prefix}`,
      sortable: true,
      hideable: false,
      pin: "start",
      cell: (r) => (
        <div className="min-w-0">
          <span className="font-medium">{r.clientId}</span>
          <p className="font-mono text-xs text-muted-foreground">{r.prefix}…</p>
        </div>
      ),
    },
    {
      key: "owner",
      label: t.owner,
      value: (r) => `${r.ownerName ?? r.userId} ${r.userId}`,
      cell: (r) => <span className="block max-w-48 truncate">{r.ownerName ?? r.userId}</span>,
    },
    {
      key: "lifetime",
      label: t.lifetime,
      align: "end",
      className: "whitespace-nowrap",
      value: (r) =>
        `${Math.ceil((new Date(r.expiresAt).getTime() - new Date(r.createdAt).getTime()) / 86_400_000)} ${t.days}`,
    },
    {
      key: "expires",
      label: t.expires,
      value: (r) => r.expiresAt,
      sortable: true,
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Pill tone={status(r) === t.expiring ? "warn" : status(r) === t.valid ? "ok" : "neutral"}>{status(r)}</Pill>
          <span className="text-xs text-muted-foreground tabular-nums">{formatDay(r.expiresAt)}</span>
        </span>
      ),
    },
    {
      key: "last",
      label: t.last,
      value: (r) => r.lastUsedAt,
      sortable: true,
      cell: (r) => (r.lastUsedAt ? <span className="tabular-nums">{formatDay(r.lastUsedAt)}</span> : t.never),
    },
    {
      key: "actions",
      label: t.actions,
      value: () => "",
      hideable: false,
      align: "end",
      pin: "end",
      cell: (r) => (
        <span className="inline-flex gap-1">
          {canManage && (
            <Button
              variant="ghost"
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
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!!r.revokedAt}
            onClick={() => {
              manage.reset();
              setSelected({ token: r, action: "revoke" });
            }}
          >
            {t.revoke}
          </Button>
        </span>
      ),
    },
  ];
  const endpoint = `${window.location.origin}/mcp`;
  const newToken = (
    <Button
      size="sm"
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
  );
  return (
    <>
      <PageHeader
        title={t.title}
        description={t.lead}
        meta={
          <span className="flex min-w-0 max-w-full items-center gap-1.5">
            <span>{t.endpoint}</span>
            <code className="min-w-0 rounded bg-muted px-1.5 py-0.5 font-mono break-all text-foreground">
              {endpoint}
            </code>
            <Button variant="ghost" size="icon-xs" aria-label={t.copyEndpoint} onClick={() => void copy(endpoint)}>
              <Copy aria-hidden="true" />
            </Button>
          </span>
        }
      />
      <Tabs.Root
        value={tab}
        onValueChange={(value: McpTab) => {
          setNotice("");
          void navigate({ to: "/admin/mcp", search: value === "tools" ? {} : { tab: value }, replace: true });
        }}
      >
        <PageTabList label={t.tabs}>
          <PageTab value="tools" count={tools.data?.tools.length}>
            {t.tools}
          </PageTab>
          {canManageServers && (
            <PageTab value="server" count={servers.data?.rules.length}>
              {t.servers}
            </PageTab>
          )}
          <PageTab value="token" count={tokens.data?.tokens.length}>
            {t.tokens}
          </PageTab>
        </PageTabList>
        <PageBody>
          {!canManage && (
            <p role="note" className="rounded-lg border border-border bg-muted px-3.5 py-2.5 text-xs text-foreground">
              {t.memberHint}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          <Tabs.Panel value="tools" className="min-w-0">
            {tools.isPending ? (
              <TableSkeleton label={t.loading} columns={6} />
            ) : tools.error ? (
              <LoadFailure error={tools.error} retry={tools.refetch} />
            ) : (
              <DataTable
                columns={toolColumns}
                rows={tools.data.tools}
                caption={t.tools}
                placeholder={t.searchTools}
                minWidth={760}
                rowLabel={(r) => r.name}
                emptyContent={t.noTools}
                facets={[
                  { key: "group", label: t.group, value: (r) => t.groups[r.group] },
                  { key: "state", label: t.state, value: (r) => (r.enabled ? t.on : t.off) },
                  { key: "caller", label: t.caller, value: (r) => t.callers[r.caller] },
                ]}
              />
            )}
          </Tabs.Panel>
          {canManageServers && (
            <Tabs.Panel value="server" className="min-w-0">
              <McpServersTab />
            </Tabs.Panel>
          )}
          <Tabs.Panel value="token" className="min-w-0">
            {tokens.isPending ? (
              <TableSkeleton label={t.loading} columns={6} />
            ) : tokens.error ? (
              <LoadFailure error={tokens.error} retry={tokens.refetch} />
            ) : (
              <DataTable
                columns={tokenColumns}
                rows={tokens.data.tokens}
                caption={t.tokens}
                placeholder={t.searchTokens}
                minWidth={780}
                rowLabel={(r) => `${r.clientId} ${r.prefix}`}
                toolbar={newToken}
                emptyContent={
                  <span className="grid justify-items-center gap-1">
                    <span className="font-medium text-foreground">{t.noTokensTitle}</span>
                    <span>{t.noTokens}</span>
                  </span>
                }
                facets={[
                  { key: "expiry", label: t.expires, value: status },
                  { key: "client", label: "Client", value: (r) => r.clientId },
                ]}
              />
            )}
          </Tabs.Panel>
        </PageBody>
      </Tabs.Root>
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
              <Field>
                <FieldLabel htmlFor="mcp-client">Client</FieldLabel>
                <NativeSelect
                  id="mcp-client"
                  value={clientId}
                  onChange={(event) => setClientId(event.currentTarget.value)}
                >
                  {["claude-code", "cursor", "vscode", "codex", "hermes"].map((client) => (
                    <option key={client} value={client}>
                      {client}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="mcp-lifetime">{t.lifetime}</FieldLabel>
                <NativeSelect
                  id="mcp-lifetime"
                  value={days}
                  onChange={(event) => setDays(Number(event.currentTarget.value))}
                >
                  {[7, 30, 90].map((n) => (
                    <option key={n} value={n}>
                      {n} {t.days}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {create.error && <Alert variant="destructive">{apiErrorMessage(create.error)}</Alert>}
              <DialogActions>
                <Button variant="outline" disabled={create.isPending} onClick={() => setCreating(false)}>
                  {t.cancel}
                </Button>
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? t.creating : t.newToken}
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
            <Field>
              <FieldLabel htmlFor="mcp-extension-lifetime">{t.lifetime}</FieldLabel>
              <NativeSelect
                id="mcp-extension-lifetime"
                value={extensionDays}
                onChange={(event) => setExtensionDays(Number(event.currentTarget.value))}
              >
                {[30, 90].map((n) => (
                  <option key={n} value={n}>
                    {n} {t.days}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          {manage.error && <Alert variant="destructive">{apiErrorMessage(manage.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={manage.isPending} onClick={() => setSelected(null)}>
              {t.cancel}
            </Button>
            <Button
              variant={selected?.action === "revoke" ? "destructive-solid" : "default"}
              disabled={manage.isPending}
              onClick={() => {
                if (selected) manage.mutate({ id: selected.token.id, action: selected.action });
              }}
            >
              {manage.isPending ? t.saving : selected?.action === "extend" ? t.extend : t.revoke}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!toggling}
        onOpenChange={(open) => {
          if (!open && !toggle.isPending) setToggling(null);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {toggling?.enabled ? t.turnOffTitle(toggling.name) : t.turnOnTitle(toggling?.name ?? "")}
            </DialogTitle>
            <DialogDescription>{toggling?.enabled ? t.turnOffHint : t.turnOnHint}</DialogDescription>
          </DialogHeader>
          {toggle.error && <Alert variant="destructive">{apiErrorMessage(toggle.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={toggle.isPending} onClick={() => setToggling(null)}>
              {t.cancel}
            </Button>
            <Button
              variant={toggling?.enabled ? "destructive-solid" : "default"}
              disabled={toggle.isPending}
              onClick={() => {
                if (toggling) toggle.mutate({ toolName: toggling.name, enabled: !toggling.enabled });
              }}
            >
              {toggle.isPending ? t.saving : toggling?.enabled ? t.turnOffConfirm : t.turnOnConfirm}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
