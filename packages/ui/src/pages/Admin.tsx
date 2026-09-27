import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import { cn } from "cn";
import {
  AGENT_TEMPLATES,
  POLICY_CLIS,
  POLICY_REPO_PARTS,
  missingRequired,
  requiredItemIds,
  type AuditEntry,
  type CommandStatus,
  type MachineCommand,
  type MachineDetail,
  type PolicyRepoPart,
  type SetupItem,
  type SetupState,
  type TeamPolicy,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@xdev-hive/ui/components/ui/collapsible";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@xdev-hive/ui/components/ui/tabs";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Page, PageHeader, StatusDot } from "../components/common.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";

type Tab = "machines" | "policy" | "audit";
const TABS: Record<Tab, string> = { machines: "Máy", policy: "Chính sách", audit: "Nhật ký" };

const STATE: Record<SetupState, { label: string; tone: string }> = {
  installed: { label: "Đã cài", tone: "ok" },
  missing: { label: "Chưa cài", tone: "warn" },
  outdated: { label: "Cần cập nhật", tone: "info" },
  manual: { label: "Cần sửa tay", tone: "danger" },
};
const COMMAND: Record<CommandStatus, { label: string; tone: string }> = {
  pending: { label: "chờ máy đồng ý", tone: "warn" },
  running: { label: "đang cài", tone: "info" },
  done: { label: "xong", tone: "ok" },
  failed: { label: "lỗi", tone: "danger" },
  rejected: { label: "máy từ chối", tone: "neutral" },
  cancelled: { label: "đã huỷ", tone: "neutral" },
  expired: { label: "hết hạn", tone: "neutral" },
};
const CLI_LABEL: Record<(typeof POLICY_CLIS)[number], string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };
const PART_LABEL: Record<PolicyRepoPart, string> = {
  agents: "Cấu hình agent",
  "codegraph-mcp": "codegraph (MCP)",
  "codegraph-index": "Index codegraph",
  superpowers: "superpowers",
};
const ACTION_LABEL: Record<string, string> = {
  "docs.save": "Sửa tài liệu",
  "proposals.approve": "Duyệt đề xuất",
  "proposals.reject": "Từ chối đề xuất",
  "memory.approve": "Duyệt memory",
  "memory.remove": "Xoá memory",
  "tasks.create": "Tạo task",
  "machines.remove": "Xoá máy",
  "cooldowns.clear": "Hết nghỉ quota",
  "policy.set": "Sửa chính sách",
  "admin.commandCreate": "Yêu cầu cài",
  "admin.commandCancel": "Huỷ yêu cầu",
  "machines.commandResult": "Máy báo kết quả",
  "tokens.create": "Tạo token",
  "tokens.revoke": "Thu hồi token",
};

/** Small uppercase heading for a group inside a card. */
const GROUP_TITLE = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function AdminPage() {
  const [tab, setTab] = useState<Tab>("machines");
  return (
    <Page wide>
      <PageHeader title="Quản trị" subtitle="Tình trạng cài đặt của mọi máy trong team, chính sách chung và nhật ký thao tác admin." />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList>
          {(Object.keys(TABS) as Tab[]).map((id) => (
            <TabsTrigger key={id} value={id} className="px-3">
              {TABS[id]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="machines" className="flex flex-col gap-4">
          <FleetTab />
        </TabsContent>
        <TabsContent value="policy" className="flex flex-col gap-4">
          <PolicyTab />
        </TabsContent>
        <TabsContent value="audit" className="flex flex-col gap-4">
          <AuditTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

// ── machines ───────────────────────────────────────────────────────────────

function FleetTab() {
  const { client } = useHive();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const machines = useQuery(() => client.call("admin.machines", {}), [client, tick]);
  const policy = useQuery(() => client.call("policy.get", {}), [client]);
  const reload = () => setTick((n) => n + 1);
  const list = machines.data ?? [];
  const lacking = policy.data ? list.filter((m) => m.setup && missingRequired(policy.data!, m.setup).length > 0).length : 0;
  const waiting = list.reduce((n, m) => n + m.commands.filter((c) => c.status === "pending" || c.status === "running").length, 0);

  return (
    <>
      <ErrorNote error={machines.error ?? policy.error} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Máy" value={list.length} />
        <Stat label="Đang hoạt động" value={list.filter((m) => m.online).length} />
        <Stat label="Thiếu mục bắt buộc" value={lacking} tone={lacking ? "warn" : undefined} />
        <Stat label="Yêu cầu đang mở" value={waiting} />
      </div>
      {machines.data && list.length === 0 ? <Empty>Chưa có máy nào báo lên. App desktop ở chế độ hub gửi heartbeat mỗi 30 giây.</Empty> : null}
      {list.map((m) => (
        <MachineCard key={m.id} machine={m} policy={policy.data ?? null} onChanged={reload} />
      ))}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <Card className={cn("gap-1 py-4", tone === "warn" && "border-warning/35")}>
      <CardContent className="flex flex-col gap-1 px-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={cn("text-2xl font-semibold tabular-nums", tone === "warn" && "text-warning")}>{value}</div>
      </CardContent>
    </Card>
  );
}

function MachineCard({ machine: m, policy, onChanged }: { machine: MachineDetail; policy: TeamPolicy | null; onChanged: () => void }) {
  const projects = m.setup?.projects.map((p) => p.project) ?? [];
  const required = policy ? requiredItemIds(policy, projects) : new Set<string>();
  const missing = policy && m.setup ? missingRequired(policy, m.setup) : [];
  const open = new Map(m.commands.filter((c) => c.status === "pending" || c.status === "running").map((c) => [c.itemId, c]));

  return (
    <Card className="gap-4">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 font-mono text-sm break-all">{m.machine}</CardTitle>
          <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>{m.duplicate ? "Trùng tên máy" : m.online ? "Đang hoạt động" : "Mất kết nối"}</Badge>
          {missing.length ? <Badge tone="warn">thiếu {missing.length} mục bắt buộc</Badge> : policy && m.setup ? <Badge tone="ok">đủ theo chính sách</Badge> : null}
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {m.version ? `v${m.version} · ` : ""}heartbeat {formatTime(m.lastSeen)}
            {m.setupAt ? ` · kiểm tra cài đặt ${formatTime(m.setupAt)}` : ""}
          </span>
        </div>
        <CardDescription className="font-mono text-xs break-all">{m.id}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!m.setup ? (
          <p className="text-sm text-muted-foreground">Máy chưa gửi kết quả kiểm tra cài đặt (bản app cũ, hoặc vừa mở).</p>
        ) : (
          <div className="flex flex-col gap-4">
            <ItemTable title="Máy này" items={m.setup.machine} required={required} machineId={m.id} open={open} online={m.online} onChanged={onChanged} />
            {m.setup.projects.map((p) => (
              <ItemTable
                key={p.project}
                title={p.project}
                subtitle={p.repo}
                items={p.items}
                required={required}
                machineId={m.id}
                open={open}
                online={m.online}
                onChanged={onChanged}
              />
            ))}
          </div>
        )}
        {m.profiles.length ? (
          <div className="flex flex-col gap-2">
            <div className={GROUP_TITLE}>Gói sub</div>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {m.profiles.map((p) => (
                <span key={p.id} className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
                  <StatusDot tone={!p.enabled ? "neutral" : !p.installed ? "danger" : p.cooldownUntil ? "warn" : "ok"} />
                  <span className="font-mono text-xs break-all">{p.id}</span>
                  <span className="text-xs text-muted-foreground">
                    {!p.enabled ? "tắt" : !p.installed ? "chưa có CLI" : p.cooldownUntil ? `nghỉ đến ${formatTime(p.cooldownUntil)}` : "sẵn sàng"}
                    {p.account ? ` · ${p.account}` : ""} · {p.runs} lượt
                  </span>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {m.commands.length ? <CommandList commands={m.commands} onChanged={onChanged} /> : null}
      </CardContent>
    </Card>
  );
}

function ItemTable(props: {
  title: string;
  subtitle?: string;
  items: SetupItem[];
  required: Set<string>;
  machineId: string;
  open: Map<string, MachineCommand>;
  online: boolean;
  onChanged: () => void;
}) {
  const { client } = useHive();
  const action = useAction();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={GROUP_TITLE}>{props.title}</span>
        {props.subtitle ? <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{props.subtitle}</span> : null}
      </div>
      <div className="flex flex-col gap-2">
        {props.items.map((i) => {
          const pending = props.open.get(i.id);
          return (
            <div key={i.id} className="flex flex-col gap-1 rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATE[i.state].tone}>{STATE[i.state].label}</Badge>
                <span className="min-w-0 text-sm break-words">{i.label}</span>
                {props.required.has(i.id) ? <Badge tone="accent">bắt buộc</Badge> : null}
                {pending ? (
                  <Badge tone={COMMAND[pending.status].tone} className="ml-auto">
                    {COMMAND[pending.status].label}
                  </Badge>
                ) : i.action && i.state !== "installed" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={action.busy}
                    title={props.online ? "Máy sẽ hỏi người dùng trước khi cài" : "Máy đang mất kết nối: yêu cầu chờ tới khi máy mở lại (hết hạn sau 24 giờ)"}
                    onClick={() =>
                      void action.run(async () => {
                        await client.call("admin.commandCreate", { machineId: props.machineId, itemId: i.id });
                        props.onChanged();
                      })
                    }
                  >
                    Yêu cầu cài
                  </Button>
                ) : null}
              </div>
              <div className="text-xs wrap-anywhere text-muted-foreground">{i.detail}</div>
            </div>
          );
        })}
      </div>
      <ErrorNote error={action.error} />
    </div>
  );
}

function CommandList({ commands, onChanged }: { commands: MachineCommand[]; onChanged: () => void }) {
  const { client } = useHive();
  const action = useAction();
  return (
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger className="group flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        Yêu cầu cài đặt ({commands.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {commands.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={COMMAND[c.status].tone}>{COMMAND[c.status].label}</Badge>
                <span className="min-w-0 text-sm break-words">
                  #{c.id} {c.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {c.requestedBy} · {formatTime(c.requestedAt)}
                  {c.updatedAt !== c.requestedAt ? ` → ${formatTime(c.updatedAt)}` : ""}
                </span>
                {c.status === "pending" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await client.call("admin.commandCancel", { id: c.id });
                        onChanged();
                      })
                    }
                  >
                    Huỷ
                  </Button>
                ) : null}
              </div>
              {c.output ? <pre className="max-h-80 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs">{c.output}</pre> : null}
            </li>
          ))}
        </ul>
        <ErrorNote error={action.error} />
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── policy ─────────────────────────────────────────────────────────────────

function PolicyTab() {
  const { client } = useHive();
  const current = useQuery(() => client.call("policy.get", {}), [client]);
  const machines = useQuery(() => client.call("admin.machines", {}), [client]);
  const known = useProjects();
  const [draft, setDraft] = useState<TeamPolicy | null>(null);
  const [templates, setTemplates] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (current.data && !draft) {
      setDraft(current.data);
      setTemplates(JSON.stringify(current.data.profileTemplates, null, 2));
    }
  }, [current.data, draft]);

  const projects = useMemo(() => {
    const names = new Set<string>(known);
    for (const m of machines.data ?? []) for (const p of m.setup?.projects ?? []) names.add(p.project);
    for (const p of Object.keys(draft?.projects ?? {})) names.add(p);
    return [...names].sort();
  }, [known, machines.data, draft]);

  if (!draft) return <ErrorNote error={current.error} />;
  const change = (next: Partial<TeamPolicy>) => {
    setSaved(false);
    setDraft({ ...draft, ...next });
  };
  const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...new Set([...list, value])] : list.filter((x) => x !== value));
  const addTemplate = (kind: keyof typeof AGENT_TEMPLATES) => {
    let list: unknown[] = [];
    try {
      list = JSON.parse(templates || "[]") as unknown[];
    } catch {
      // keep the admin's text; the new template goes into a fresh list
    }
    const base = AGENT_TEMPLATES[kind];
    const { env: _env, ...template } = { ...base, id: `${base.id.replace(/-\d+$/, "")}-team`, account: undefined };
    setSaved(false);
    setTemplates(JSON.stringify([...list, template], null, 2));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Bắt buộc trên mọi máy</CardTitle>
          <CardDescription>Máy nào thiếu sẽ thấy nhãn "bắt buộc" ở trang Cài đặt máy, và tab Máy đánh dấu máy đó.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-x-6 gap-y-3">
            {POLICY_CLIS.map((cli) => (
              <label key={cli} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.requiredClis.includes(cli)}
                  onCheckedChange={(v) => change({ requiredClis: toggle(draft.requiredClis, cli, v === true) })}
                />
                {CLI_LABEL[cli]}
              </label>
            ))}
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={draft.requireShim} onCheckedChange={(v) => change({ requireShim: v === true })} />
              Lệnh hive-mcp
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Theo dự án</CardTitle>
          <CardDescription>Áp dụng cho máy nào đã thêm dự án đó vào app desktop.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {projects.length === 0 ? <Empty>Chưa thấy dự án nào (từ tài liệu, task hoặc máy báo lên).</Empty> : null}
          {projects.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableBody>
                  {projects.map((p) => (
                    <TableRow key={p}>
                      <TableCell className="font-mono text-xs">{p}</TableCell>
                      <TableCell className="whitespace-normal">
                        <div className="flex min-w-56 flex-wrap gap-x-4 gap-y-2">
                          {POLICY_REPO_PARTS.map((part) => (
                            <label key={part} className="flex items-center gap-2 text-sm">
                              <Checkbox
                                checked={(draft.projects[p] ?? []).includes(part)}
                                onCheckedChange={(v) => {
                                  const parts = toggle(draft.projects[p] ?? [], part, v === true);
                                  const next = { ...draft.projects, [p]: parts };
                                  if (!parts.length) delete next[p];
                                  change({ projects: next });
                                }}
                              />
                              {PART_LABEL[part]}
                            </label>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Profile mẫu cho team</CardTitle>
          <CardDescription>
            App desktop hiện các mẫu này ở trang Gói sub &amp; agent để thêm bằng một nút. Mẫu không được có{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">env</code>: thư mục đăng nhập và key là của từng máy.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Thêm mẫu:</span>
            {(Object.keys(AGENT_TEMPLATES) as Array<keyof typeof AGENT_TEMPLATES>).map((k) => (
              <Button key={k} size="sm" variant="outline" onClick={() => addTemplate(k)}>
                <Plus />
                {AGENT_TEMPLATES[k].label}
              </Button>
            ))}
          </div>
          <Textarea
            className="max-h-[32rem] min-h-64 font-mono text-xs md:text-xs"
            rows={12}
            value={templates}
            onChange={(e) => {
              setSaved(false);
              setTemplates(e.target.value);
            }}
            aria-label="Profile mẫu (JSON)"
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              let profileTemplates: TeamPolicy["profileTemplates"];
              try {
                profileTemplates = JSON.parse(templates || "[]") as TeamPolicy["profileTemplates"];
              } catch {
                throw new Error("Profile mẫu không phải JSON hợp lệ.");
              }
              const next = await client.call("policy.set", {
                requiredClis: draft.requiredClis,
                requireShim: draft.requireShim,
                projects: draft.projects,
                profileTemplates,
              });
              setDraft(next);
              setTemplates(JSON.stringify(next.profileTemplates, null, 2));
              setSaved(true);
            })
          }
        >
          Lưu chính sách
        </Button>
        {saved ? <span className="text-sm text-success">Đã lưu. Máy nhận ở heartbeat kế tiếp.</span> : null}
        {draft.updatedAt ? (
          <span className="text-sm text-muted-foreground">
            Sửa lần cuối {formatTime(draft.updatedAt)} bởi {draft.updatedBy}
          </span>
        ) : null}
      </div>
      <ErrorNote error={action.error} />
    </>
  );
}

// ── audit ──────────────────────────────────────────────────────────────────

function AuditTab() {
  const { client } = useHive();
  const [filter, setFilter] = useState("");
  const log = useQuery(() => client.call("admin.audit", { limit: 300, action: filter || undefined }), [client, filter]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Loại thao tác">
          <NativeSelectOption value="">Mọi thao tác</NativeSelectOption>
          {Object.entries(ACTION_LABEL).map(([k, v]) => (
            <NativeSelectOption key={k} value={k}>
              {v}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-sm text-muted-foreground">300 mục mới nhất. Chỉ ghi thao tác thay đổi dữ liệu, không ghi lượt đọc.</span>
      </div>
      <ErrorNote error={log.error} />
      {log.data?.length === 0 ? <Empty>Chưa có thao tác nào.</Empty> : null}
      {log.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Lúc</TableHead>
                <TableHead>Ai</TableHead>
                <TableHead>Thao tác</TableHead>
                <TableHead>Đối tượng</TableHead>
                <TableHead>Chi tiết</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.map((e: AuditEntry) => (
                <TableRow key={e.id}>
                  <TableCell className="align-top text-muted-foreground">{formatTime(e.at)}</TableCell>
                  <TableCell className="align-top font-mono text-xs">{e.actor}</TableCell>
                  <TableCell className="align-top">{ACTION_LABEL[e.action] ?? e.action}</TableCell>
                  <TableCell className="align-top font-mono text-xs">{e.target}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="max-w-80 min-w-48 text-xs whitespace-pre-wrap wrap-anywhere">{e.detail}</div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </>
  );
}
