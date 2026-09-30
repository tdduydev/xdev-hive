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
import { Badge, Empty, ErrorNote, Page, PageHeader } from "../components/common.tsx";
import { ProfileStates } from "../components/ProfileStates.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "../hooks.ts";
import { hasKey, rich, useT, type MessageKey } from "../i18n/index.tsx";
import { WebhooksTab } from "./Webhooks.tsx";

type Tab = "machines" | "policy" | "audit" | "webhooks";
const TABS: Record<Tab, MessageKey> = { machines: "admin.tabMachines", policy: "admin.tabPolicy", audit: "admin.tabAudit", webhooks: "admin.tabWebhooks" };

const STATE_TONE: Record<SetupState, string> = { installed: "ok", missing: "warn", outdated: "info", manual: "danger" };
const COMMAND_TONE: Record<CommandStatus, string> = {
  pending: "warn",
  running: "info",
  done: "ok",
  failed: "danger",
  rejected: "neutral",
  cancelled: "neutral",
  expired: "neutral",
};
const CLI_LABEL: Record<(typeof POLICY_CLIS)[number], string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };
/** Audit actions by the name the hub records (keys of the catalogue cannot contain dots). */
const ACTION_LABEL: Record<string, MessageKey> = {
  "docs.save": "auditAction.docsSave",
  "proposals.approve": "auditAction.proposalsApprove",
  "proposals.reject": "auditAction.proposalsReject",
  "memory.approve": "auditAction.memoryApprove",
  "memory.remove": "auditAction.memoryRemove",
  "tasks.create": "auditAction.tasksCreate",
  "tasks.setDeps": "auditAction.tasksSetDeps",
  "machines.remove": "auditAction.machinesRemove",
  "cooldowns.clear": "auditAction.cooldownsClear",
  "policy.set": "auditAction.policySet",
  "systems.save": "auditAction.systemsSave",
  "systems.remove": "auditAction.systemsRemove",
  "admin.commandCreate": "auditAction.commandCreate",
  "admin.commandCancel": "auditAction.commandCancel",
  "machines.commandResult": "auditAction.commandResult",
  "tokens.create": "auditAction.tokensCreate",
  "tokens.revoke": "auditAction.tokensRevoke",
  "auth.login": "auditAction.authLogin",
  "users.create": "auditAction.usersCreate",
  "users.update": "auditAction.usersUpdate",
  "users.setGrants": "auditAction.usersSetGrants",
  "users.resetPassword": "auditAction.usersResetPassword",
  "users.password": "auditAction.usersPassword",
  "import.forge": "auditAction.importForge",
  "webhooks.save": "auditAction.webhooksSave",
  "webhooks.remove": "auditAction.webhooksRemove",
  "users.ssoLink": "auditAction.usersSsoLink",
};

/** Small uppercase heading for a group inside a card. */
const GROUP_TITLE = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

export function AdminPage() {
  const t = useT();
  const { client } = useHive();
  const [tab, setTab] = useState<Tab>("machines");
  // Webhooks live on the hub only (the desktop app has no hub admin).
  const tabs = (Object.keys(TABS) as Tab[]).filter((id) => id !== "webhooks" || client.webhooks);
  return (
    <Page wide>
      <PageHeader title={t("nav.admin")} subtitle={t("admin.subtitle")} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
        <TabsList>
          {tabs.map((id) => (
            <TabsTrigger key={id} value={id} className="px-3">
              {t(TABS[id])}
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
        {client.webhooks ? (
          <TabsContent value="webhooks" className="flex flex-col gap-4">
            <WebhooksTab />
          </TabsContent>
        ) : null}
      </Tabs>
    </Page>
  );
}

// ── machines ───────────────────────────────────────────────────────────────

function FleetTab() {
  const { client } = useHive();
  const t = useT();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(timer);
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
        <Stat label={t("admin.statMachines")} value={list.length} />
        <Stat label={t("machineState.online")} value={list.filter((m) => m.online).length} />
        <Stat label={t("admin.statLacking")} value={lacking} tone={lacking ? "warn" : undefined} />
        <Stat label={t("admin.statOpen")} value={waiting} />
      </div>
      {machines.data && list.length === 0 ? <Empty>{t("admin.noMachines")}</Empty> : null}
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
  const t = useT();
  const projects = m.setup?.projects.map((p) => p.project) ?? [];
  const required = policy ? requiredItemIds(policy, projects) : new Set<string>();
  const missing = policy && m.setup ? missingRequired(policy, m.setup) : [];
  const open = new Map(m.commands.filter((c) => c.status === "pending" || c.status === "running").map((c) => [c.itemId, c]));

  return (
    <Card className="gap-4">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="min-w-0 font-mono text-sm break-all">{m.machine}</CardTitle>
          <Badge tone={m.duplicate ? "danger" : m.online ? "ok" : "neutral"}>{m.duplicate ? t("machineState.duplicate") : m.online ? t("machineState.online") : t("machineState.offline")}</Badge>
          {missing.length ? (
            <Badge tone="warn">{t("admin.missingRequired", { count: missing.length })}</Badge>
          ) : policy && m.setup ? (
            <Badge tone="ok">{t("admin.meetsPolicy")}</Badge>
          ) : null}
          <span className="text-xs text-muted-foreground sm:ml-auto">
            {m.version ? `v${m.version} · ` : ""}
            {t("overview.heartbeat", { time: formatTime(m.lastSeen) })}
            {m.setupAt ? ` · ${t("admin.setupChecked", { time: formatTime(m.setupAt) })}` : ""}
          </span>
        </div>
        <CardDescription className="font-mono text-xs break-all">{m.id}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!m.setup ? (
          <p className="text-sm text-muted-foreground">{t("admin.noSetup")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            <ItemTable title={t("setup.thisMachine")} items={m.setup.machine} required={required} machineId={m.id} open={open} online={m.online} onChanged={onChanged} />
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
            <div className={GROUP_TITLE}>{t("board.profiles")}</div>
            <ProfileStates profiles={m.profiles} details />
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
  const t = useT();
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
                <Badge tone={STATE_TONE[i.state]}>{t(`setupState.${i.state}`)}</Badge>
                <span className="min-w-0 text-sm break-words">{i.label}</span>
                {props.required.has(i.id) ? <Badge tone="accent">{t("setup.required")}</Badge> : null}
                {pending ? (
                  <Badge tone={COMMAND_TONE[pending.status]} className="ml-auto">
                    {t(`commandStatus.${pending.status}`)}
                  </Badge>
                ) : i.action && i.state !== "installed" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={action.busy}
                    title={props.online ? t("admin.requestHintOnline") : t("admin.requestHintOffline")}
                    onClick={() =>
                      void action.run(async () => {
                        await client.call("admin.commandCreate", { machineId: props.machineId, itemId: i.id });
                        props.onChanged();
                      })
                    }
                  >
                    {t("admin.requestInstall")}
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
  const t = useT();
  const action = useAction();
  return (
    <Collapsible className="flex flex-col gap-2">
      <CollapsibleTrigger className="group flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        {t("admin.requests", { count: commands.length })}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2">
        <ul className="flex flex-col gap-2">
          {commands.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={COMMAND_TONE[c.status]}>{t(`commandStatus.${c.status}`)}</Badge>
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
                    {t("admin.cancelRequest")}
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
  const t = useT();
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
          <CardTitle>{t("admin.everyMachine")}</CardTitle>
          <CardDescription>{t("admin.everyMachineHint")}</CardDescription>
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
              {t("admin.shim")}
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("admin.perProject")}</CardTitle>
          <CardDescription>{t("admin.perProjectHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {projects.length === 0 ? <Empty>{t("admin.noProjects")}</Empty> : null}
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
                              {t(`setupPart.${part}`)}
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
          <CardTitle>{t("admin.templates")}</CardTitle>
          <CardDescription>
            {rich(t("admin.templatesHint"), { env: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">env</code> })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t("admin.addTemplate")}</span>
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
            aria-label={t("admin.templatesJson")}
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
                throw new Error(t("admin.badTemplates"));
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
          {t("admin.savePolicy")}
        </Button>
        {saved ? <span className="text-sm text-success">{t("admin.policySaved")}</span> : null}
        {draft.updatedAt ? (
          <span className="text-sm text-muted-foreground">
            {t("admin.policyUpdated", { time: formatTime(draft.updatedAt), who: draft.updatedBy ?? "" })}
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
  const t = useT();
  const [filter, setFilter] = useState("");
  const log = useQuery(() => client.call("admin.audit", { limit: 300, action: filter || undefined }), [client, filter]);
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t("admin.auditFilter")}>
          <NativeSelectOption value="">{t("admin.auditAll")}</NativeSelectOption>
          {Object.entries(ACTION_LABEL).map(([k, v]) => (
            <NativeSelectOption key={k} value={k}>
              {t(v)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="text-sm text-muted-foreground">{t("admin.auditHint", { count: 300 })}</span>
      </div>
      <ErrorNote error={log.error} />
      {log.data?.length === 0 ? <Empty>{t("admin.auditNone")}</Empty> : null}
      {log.data?.length ? (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.colAt")}</TableHead>
                <TableHead>{t("admin.colWho")}</TableHead>
                <TableHead>{t("admin.colAction")}</TableHead>
                <TableHead>{t("admin.colTarget")}</TableHead>
                <TableHead>{t("admin.colDetail")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.map((e: AuditEntry) => (
                <TableRow key={e.id}>
                  <TableCell className="align-top text-muted-foreground">{formatTime(e.at)}</TableCell>
                  <TableCell className="align-top font-mono text-xs">{e.actor}</TableCell>
                  <TableCell className="align-top">{ACTION_LABEL[e.action] ? t(ACTION_LABEL[e.action]!) : e.action}</TableCell>
                  <TableCell className="align-top font-mono text-xs">{e.target}</TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="max-w-80 min-w-48 text-xs whitespace-pre-wrap wrap-anywhere">
                      {e.detailKey && hasKey(e.detailKey) ? t(e.detailKey as MessageKey, e.detailVars) : e.detail}
                    </div>
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
