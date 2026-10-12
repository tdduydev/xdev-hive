import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type McpServerLaunch, type McpServerRule, type McpServerRuleInput, mcpServerKey } from "@xdev-hive/contracts";
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
import { Pencil, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { type Column, DataTable } from "@/components/data-table/data-table.tsx";
import { LoadFailure, LoadingState } from "@/components/ui/query-state.tsx";
import { apiErrorMessage } from "@/lib/api-errors.ts";
import { type Dict, useT } from "@/lib/i18n.ts";
import { useOrg } from "@/shell/org-context.ts";

type MatchType = McpServerRule["matchType"];
type Effect = McpServerRule["rule"];
const MATCH_TYPES: readonly MatchType[] = ["name", "url", "command", "wildcard"];

const text: Dict<{
  lead: string;
  search: string;
  server: string;
  match: string;
  rule: string;
  scope: string;
  matchBy: string;
  actions: string;
  allow: string;
  deny: string;
  org: string;
  ruleOnly: string;
  edit: string;
  remove: string;
  changeRule: string;
  empty: string;
  noAccess: string;
  addServer: string;
  editServer: string;
  formHint: string;
  name: string;
  cliName: (key: string) => string;
  pattern: string;
  patternHint: Record<MatchType, string>;
  patternFromLaunch: string;
  matchTypes: Record<MatchType, string>;
  launch: string;
  launchNone: string;
  launchStdio: string;
  launchHttp: string;
  command: string;
  args: string;
  argsHint: string;
  url: string;
  secretsHint: string;
  wildcardAllowWarning: string;
  cancel: string;
  save: string;
  saving: string;
  deleteTitle: (n: number) => string;
  deleteHint: string;
  previewTitle: string;
  previewLead: string;
  previewScope: string;
  previewEmpty: string;
  sent: string;
  blocked: string;
  decidedBy: (name: string) => string;
  noRule: string;
}> = {
  vi: {
    lead: "Hub ghi vào managed settings của CLI trên máy chạy run. Mục chặn thắng mục cho phép.",
    search: "Tìm server…",
    server: "Server",
    match: "Khớp theo",
    rule: "Quy tắc",
    scope: "Phạm vi",
    matchBy: "Khớp theo",
    actions: "Thao tác",
    allow: "Cho phép",
    deny: "Chặn",
    org: "Tổ chức",
    ruleOnly: "Chỉ là quy tắc, không phát xuống máy",
    edit: "Sửa",
    remove: "Xoá",
    changeRule: "Đổi quy tắc",
    empty: "Chưa có quy tắc nào. Run chỉ dùng cổng MCP của hub cho tới khi bạn thêm server được phép.",
    noAccess: "Chỉ chủ sở hữu, quản trị hoặc người có quyền quản lý MCP server được xem và sửa quy tắc server ngoài.",
    addServer: "Thêm server",
    editServer: "Sửa quy tắc server",
    formHint:
      "Quy tắc cụ thể (tên, URL, lệnh) quyết định trước; quy tắc * chỉ áp cho server không khớp quy tắc cụ thể nào. Quy tắc của dự án cộng thêm, không mở lại server tổ chức đã chặn.",
    name: "Tên server",
    cliName: (key) => `Tên trong cấu hình CLI: ${key}`,
    pattern: "Mẫu khớp",
    patternHint: {
      name: "Tên server, dùng * để khớp nhiều tên (vd. git*).",
      url: "URL của server HTTP, có thể dùng * (vd. https://*.acme.vn/*).",
      command: "Các từ phải xuất hiện theo thứ tự trong lệnh (vd. npx @modelcontextprotocol/server-filesystem).",
      wildcard: "Khớp mọi server.",
    },
    patternFromLaunch: "Bỏ trống để lấy theo chính server bên dưới.",
    matchTypes: { name: "Tên", url: "URL", command: "Lệnh", wildcard: "Mọi server (*)" },
    launch: "Phát xuống máy chạy run",
    launchNone: "Không, chỉ là quy tắc",
    launchStdio: "Chạy lệnh (stdio)",
    launchHttp: "Server HTTP",
    command: "Lệnh",
    args: "Tham số",
    argsHint: "Mỗi dòng một tham số.",
    url: "URL",
    secretsHint:
      "Không đặt khoá bí mật trong lệnh, tham số hay URL: hub gửi nguyên văn tới máy chạy run. Worker không chuyển token của hub cho server ngoài.",
    wildcardAllowWarning: "Cho phép * mở mọi server không bị chặn rõ. Hãy chắc chắn đó là điều bạn muốn.",
    cancel: "Huỷ",
    save: "Lưu",
    saving: "Đang lưu…",
    deleteTitle: (n) => (n === 1 ? "Xoá quy tắc?" : `Xoá ${n} quy tắc?`),
    deleteHint: "Run được giao sau khi xoá sẽ không còn nhận hoặc bị chặn theo quy tắc này.",
    previewTitle: "Server run sẽ nhận",
    previewLead: "Chỉ run code nhận server ngoài; run review, kế hoạch và leader chỉ có cổng MCP của hub.",
    previewScope: "Xem cho",
    previewEmpty: "Không có server ngoài nào được khai báo cho phạm vi này.",
    sent: "Được phát",
    blocked: "Bị chặn",
    decidedBy: (name) => `theo quy tắc "${name}"`,
    noRule: "không quy tắc nào cho phép",
  },
  en: {
    lead: "Written to the CLI managed settings on run machines. Deny wins over allow.",
    search: "Search servers…",
    server: "Server",
    match: "Match",
    rule: "Rule",
    scope: "Scope",
    matchBy: "Match by",
    actions: "Actions",
    allow: "Allow",
    deny: "Deny",
    org: "Organization",
    ruleOnly: "Rule only, not sent to machines",
    edit: "Edit",
    remove: "Delete",
    changeRule: "Change rule",
    empty: "No rules yet. Runs only use the hub MCP gateway until you add an allowed server.",
    noAccess:
      "Only owners, administrators or people allowed to manage MCP servers can view and edit external server rules.",
    addServer: "Add server",
    editServer: "Edit server rule",
    formHint:
      "Specific rules (name, URL, command) decide first; a * rule only applies to servers no specific rule matches. Project rules add to organization rules and never reopen a server the organization denies.",
    name: "Server name",
    cliName: (key) => `Name in the CLI configuration: ${key}`,
    pattern: "Pattern",
    patternHint: {
      name: "Server name; use * to match several names (e.g. git*).",
      url: "HTTP server URL; * is allowed (e.g. https://*.acme.vn/*).",
      command: "Words must appear in this order in the command (e.g. npx @modelcontextprotocol/server-filesystem).",
      wildcard: "Matches every server.",
    },
    patternFromLaunch: "Leave empty to use the server below.",
    matchTypes: { name: "Name", url: "URL", command: "Command", wildcard: "Every server (*)" },
    launch: "Send to run machines",
    launchNone: "No, rule only",
    launchStdio: "Run a command (stdio)",
    launchHttp: "HTTP server",
    command: "Command",
    args: "Arguments",
    argsHint: "One argument per line.",
    url: "URL",
    secretsHint:
      "Do not put secrets in the command, arguments or URL: the hub sends them verbatim to run machines. The worker never passes hub tokens to external servers.",
    wildcardAllowWarning: "Allowing * opens every server that is not explicitly denied. Make sure that is intended.",
    cancel: "Cancel",
    save: "Save",
    saving: "Saving…",
    deleteTitle: (n) => (n === 1 ? "Delete rule?" : `Delete ${n} rules?`),
    deleteHint: "Runs dispatched after deleting no longer get or are blocked by this rule.",
    previewTitle: "Servers runs will get",
    previewLead: "Only code runs get external servers; review, plan and leader runs only have the hub MCP gateway.",
    previewScope: "Preview for",
    previewEmpty: "No external server is declared for this scope.",
    sent: "Sent",
    blocked: "Blocked",
    decidedBy: (name) => `by rule "${name}"`,
    noRule: "no rule allows it",
  },
};

const matchLabel = (r: Pick<McpServerRule, "matchType" | "pattern">) =>
  r.matchType === "wildcard" ? "*" : `${r.matchType}: ${r.pattern}`;
const launchLabel = (launch: McpServerLaunch) =>
  launch.transport === "http" ? launch.url : [launch.command, ...launch.args].join(" ");
const inputOf = (r: McpServerRule, rule: Effect = r.rule): McpServerRuleInput => ({
  name: r.name,
  rule,
  matchType: r.matchType,
  pattern: r.pattern,
  projectId: r.projectId,
  launch: r.launch,
});

/** Tab "MCP server ngoài" (MCP-05/06) của /admin/mcp theo docs/design-system/screens/McpTools.dc.html. */
export function McpServersTab({
  canManage,
  editing,
  onEdit,
}: {
  canManage: boolean;
  /** `"new"` là đang thêm; quy tắc là đang sửa. Trang giữ state vì nút "Thêm server" nằm ở đầu trang. */
  editing: McpServerRule | "new" | null;
  onEdit: (value: McpServerRule | "new" | null) => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const queryClient = useQueryClient();
  const rules = useQuery({ ...api.mcpAdmin.listServers.queryOptions(), enabled: canManage });
  const projects = useQuery({ ...api.projects.list.queryOptions({ input: {} }), enabled: canManage });
  const [removing, setRemoving] = useState<McpServerRule[] | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: api.mcpAdmin.key() });
  const flip = useMutation({
    mutationFn: async (rows: McpServerRule[]) => {
      for (const r of rows)
        await api.mcpAdmin.updateServer.call({ id: r.id, ...inputOf(r, r.rule === "allow" ? "deny" : "allow") });
    },
    onSettled: () => void refresh(),
  });
  const remove = useMutation({
    mutationFn: async (rows: McpServerRule[]) => {
      for (const r of rows) await api.mcpAdmin.deleteServer.call({ id: r.id });
    },
    onSuccess: () => setRemoving(null),
    onSettled: () => void refresh(),
  });
  if (!canManage) return <p className="mt-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground">{t.noAccess}</p>;
  const scopeLabel = (r: McpServerRule) => (r.projectId ? (r.projectKey ?? r.projectId.slice(0, 8)) : t.org);
  const columns: Column<McpServerRule>[] = [
    {
      key: "name",
      label: t.server,
      value: (r) => `${r.name} ${r.key} ${r.launch ? launchLabel(r.launch) : ""}`,
      sortable: true,
      hideable: false,
      cell: (r) => (
        <div className="max-w-72 min-w-0">
          <span className="font-medium">{r.name}</span>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {r.launch ? `${r.key} · ${launchLabel(r.launch)}` : t.ruleOnly}
          </p>
        </div>
      ),
    },
    {
      key: "match",
      label: t.match,
      value: matchLabel,
      cell: (r) => <span className="break-all font-mono text-xs">{matchLabel(r)}</span>,
    },
    {
      key: "rule",
      label: t.rule,
      value: (r) => (r.rule === "allow" ? t.allow : t.deny),
      cell: (r) => <Pill tone={r.rule === "allow" ? "ok" : "bad"}>{r.rule === "allow" ? t.allow : t.deny}</Pill>,
    },
    {
      key: "scope",
      label: t.scope,
      value: scopeLabel,
      cell: (r) => <span className="font-mono text-xs">{scopeLabel(r)}</span>,
    },
    {
      key: "actions",
      label: t.actions,
      value: () => "",
      hideable: false,
      cell: (r) => (
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={`${t.edit} ${r.name}`} onClick={() => onEdit(r)}>
            <Pencil aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={`${t.remove} ${r.name}`} onClick={() => setRemoving([r])}>
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];
  return (
    <div className="space-y-4 pt-2">
      <p className="text-sm text-muted-foreground">{t.lead}</p>
      {flip.error && <Alert variant="destructive">{apiErrorMessage(flip.error)}</Alert>}
      {rules.isPending ? (
        <LoadingState />
      ) : rules.error ? (
        <LoadFailure error={rules.error} retry={() => rules.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rules.data.rules}
          caption={t.server}
          placeholder={t.search}
          emptyContent={t.empty}
          rowLabel={(r) => r.name}
          bulk={[
            { key: "rule", label: t.changeRule, onClick: (rows) => flip.mutate(rows), disabled: () => flip.isPending },
            { key: "delete", label: t.remove, onClick: (rows) => setRemoving(rows) },
          ]}
          facets={[
            { key: "rule", label: t.rule, value: (r) => (r.rule === "allow" ? t.allow : t.deny) },
            { key: "scope", label: t.scope, value: scopeLabel },
            { key: "kind", label: t.matchBy, value: (r) => t.matchTypes[r.matchType] },
          ]}
        />
      )}
      <EffectivePreview projects={projects.data ?? []} />
      {editing && (
        <ServerRuleDialog
          rule={editing === "new" ? null : editing}
          projects={projects.data ?? []}
          onClose={() => onEdit(null)}
          onSaved={() => {
            onEdit(null);
            void refresh();
          }}
        />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) {
            setRemoving(null);
            remove.reset();
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t.deleteTitle(removing?.length ?? 1)}</DialogTitle>
            <DialogDescription>{t.deleteHint}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm">
            {removing?.map((r) => (
              <li key={r.id} className="break-all">
                <span className="font-medium">{r.name}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">{matchLabel(r)}</span>
              </li>
            ))}
          </ul>
          {remove.error && <Alert variant="destructive">{apiErrorMessage(remove.error)}</Alert>}
          <DialogActions>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(null)}>
              {t.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing)}
            >
              {remove.isPending ? t.saving : t.remove}
            </Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Nhãn đứng riêng (không bọc ô nhập), để tên truy cập của ô chọn không lẫn chữ của các lựa chọn. */
function Labeled({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}

function EffectivePreview({ projects }: { projects: { id: string; key: string; name: string }[] }) {
  const t = useT(text);
  const { api } = useOrg();
  const id = useId();
  const [projectId, setProjectId] = useState("");
  const preview = useQuery(
    api.mcpAdmin.previewServers.queryOptions({ input: projectId ? { projectId } : {}, refetchInterval: 30_000 }),
  );
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-title`} className="font-heading text-base font-semibold">
            {t.previewTitle}
          </h2>
          <p className="text-xs text-muted-foreground">{t.previewLead}</p>
        </div>
        <Labeled id={`${id}-scope`} label={t.previewScope}>
          <NativeSelect id={`${id}-scope`} value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
            <option value="">{t.org}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key}
              </option>
            ))}
          </NativeSelect>
        </Labeled>
      </div>
      {preview.isPending ? (
        <LoadingState />
      ) : preview.error ? (
        <LoadFailure error={preview.error} retry={() => preview.refetch()} />
      ) : preview.data.servers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.previewEmpty}</p>
      ) : (
        <ul className="divide-y divide-border">
          {preview.data.servers.map((s) => (
            <li key={s.ruleId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <span className="font-mono text-sm font-medium">{s.key}</span>
                <p className="break-all font-mono text-xs text-muted-foreground">{launchLabel(s.launch)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {s.decidedBy ? t.decidedBy(s.decidedBy.name) : t.noRule}
                </span>
                <Pill tone={s.allowed ? "ok" : "bad"} dot>
                  {s.allowed ? t.sent : t.blocked}
                </Pill>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ServerRuleDialog({
  rule,
  projects,
  onClose,
  onSaved,
}: {
  rule: McpServerRule | null;
  projects: { id: string; key: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT(text);
  const { api } = useOrg();
  const ids = useId();
  const [name, setName] = useState(rule?.name ?? "");
  const [effect, setEffect] = useState<Effect>(rule?.rule ?? "allow");
  const [matchType, setMatchType] = useState<MatchType>(rule?.matchType ?? "name");
  const [pattern, setPattern] = useState(rule?.matchType === "wildcard" ? "" : (rule?.pattern ?? ""));
  const [projectId, setProjectId] = useState(rule?.projectId ?? "");
  const [transport, setTransport] = useState<"" | McpServerLaunch["transport"]>(rule?.launch?.transport ?? "");
  const [command, setCommand] = useState(rule?.launch?.transport === "stdio" ? rule.launch.command : "");
  const [args, setArgs] = useState(rule?.launch?.transport === "stdio" ? rule.launch.args.join("\n") : "");
  const [url, setUrl] = useState(rule?.launch?.transport === "http" ? rule.launch.url : "");
  const save = useMutation({
    mutationFn: () => {
      const launch: McpServerLaunch | null =
        transport === "stdio"
          ? {
              transport,
              command,
              args: args
                .split("\n")
                .map((a) => a.trim())
                .filter(Boolean),
            }
          : transport === "http"
            ? { transport, url: url.trim() }
            : null;
      const input: McpServerRuleInput = {
        name,
        rule: effect,
        matchType,
        pattern: matchType === "wildcard" ? "*" : pattern,
        projectId: projectId || null,
        launch,
      };
      return rule ? api.mcpAdmin.updateServer.call({ id: rule.id, ...input }) : api.mcpAdmin.createServer.call(input);
    },
    onSuccess: onSaved,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? t.editServer : t.addServer}</DialogTitle>
            <DialogDescription>{t.formHint}</DialogDescription>
          </DialogHeader>
          <Labeled id={`${ids}-name`} label={t.name}>
            <Input
              id={`${ids}-name`}
              required
              maxLength={80}
              value={name}
              aria-describedby={transport ? `${ids}-key` : undefined}
              onChange={(e) => setName(e.target.value)}
            />
            {transport && name.trim() && (
              <span id={`${ids}-key`} className="font-mono text-xs text-muted-foreground">
                {t.cliName(mcpServerKey(name))}
              </span>
            )}
          </Labeled>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled id={`${ids}-rule`} label={t.rule}>
              <NativeSelect id={`${ids}-rule`} value={effect} onChange={(e) => setEffect(e.target.value as Effect)}>
                <option value="allow">{t.allow}</option>
                <option value="deny">{t.deny}</option>
              </NativeSelect>
            </Labeled>
            <Labeled id={`${ids}-scope`} label={t.scope}>
              <NativeSelect id={`${ids}-scope`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t.org}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key}
                  </option>
                ))}
              </NativeSelect>
            </Labeled>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            <Labeled id={`${ids}-match`} label={t.matchBy}>
              <NativeSelect
                id={`${ids}-match`}
                value={matchType}
                onChange={(e) => setMatchType(e.target.value as MatchType)}
              >
                {MATCH_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {t.matchTypes[m]}
                  </option>
                ))}
              </NativeSelect>
            </Labeled>
            {matchType !== "wildcard" && (
              <Labeled id={`${ids}-pattern`} label={t.pattern}>
                <Input
                  id={`${ids}-pattern`}
                  className="font-mono"
                  maxLength={500}
                  required={!transport}
                  aria-describedby={`${ids}-pattern-hint`}
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                />
              </Labeled>
            )}
          </div>
          <p id={`${ids}-pattern-hint`} className="-mt-2 text-xs text-muted-foreground">
            {t.patternHint[matchType]} {transport && matchType !== "wildcard" ? t.patternFromLaunch : ""}
          </p>
          {matchType === "wildcard" && effect === "allow" && (
            <p role="status" className="rounded-lg bg-warning-soft px-3.5 py-2.5 text-xs text-warning">
              {t.wildcardAllowWarning}
            </p>
          )}
          <Labeled id={`${ids}-launch`} label={t.launch}>
            <NativeSelect
              id={`${ids}-launch`}
              value={transport}
              onChange={(e) => setTransport(e.target.value as "" | McpServerLaunch["transport"])}
            >
              <option value="">{t.launchNone}</option>
              <option value="stdio">{t.launchStdio}</option>
              <option value="http">{t.launchHttp}</option>
            </NativeSelect>
          </Labeled>
          {transport === "stdio" && (
            <>
              <Labeled id={`${ids}-command`} label={t.command}>
                <Input
                  id={`${ids}-command`}
                  className="font-mono"
                  required
                  maxLength={500}
                  value={command}
                  placeholder="npx"
                  onChange={(e) => setCommand(e.target.value)}
                />
              </Labeled>
              <Labeled id={`${ids}-args`} label={t.args}>
                <Textarea
                  id={`${ids}-args`}
                  className="font-mono"
                  rows={3}
                  value={args}
                  aria-describedby={`${ids}-args-hint`}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  onChange={(e) => setArgs(e.target.value)}
                />
                <span id={`${ids}-args-hint`} className="text-xs text-muted-foreground">
                  {t.argsHint}
                </span>
              </Labeled>
            </>
          )}
          {transport === "http" && (
            <Labeled id={`${ids}-url`} label={t.url}>
              <Input
                id={`${ids}-url`}
                className="font-mono"
                type="url"
                required
                maxLength={2000}
                value={url}
                placeholder="https://mcp.example.com/mcp"
                onChange={(e) => setUrl(e.target.value)}
              />
            </Labeled>
          )}
          {transport && <p className="text-xs text-muted-foreground">{t.secretsHint}</p>}
          {save.error && <Alert variant="destructive">{apiErrorMessage(save.error)}</Alert>}
          <DialogActions>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || !name.trim()}>
              {save.isPending ? t.saving : t.save}
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
