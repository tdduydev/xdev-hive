import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Plus } from "lucide-react";
import {
  AGENT_TEMPLATES,
  POLICY_CLIS,
  POLICY_REPO_PARTS,
  SELF_APPROVALS,
  missingRequired,
  requiredItemIds,
  type SelfApproval,
  type CommandStatus,
  type MachineCommand,
  type MachineDetail,
  type SetupItem,
  type SetupState,
  type TeamPolicy,
  type ToolView,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@xdev-hive/ui/components/ui/collapsible";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@xdev-hive/ui/components/ui/table";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote } from "#ui/components/common.tsx";
import { ProfileStates } from "#ui/components/ProfileStates.tsx";
import { formatTime, useAction, useHive, useProjects, useQuery } from "#ui/hooks.ts";
import { rich, useT, type MessageKey } from "#ui/i18n/index.tsx";
import { hasNewer } from "#ui/lib/setup.ts";
import { AgentPolicyCard } from "#ui/pages/admin/AgentPolicy.tsx";
import { SdlcGatesCard } from "#ui/pages/admin/SdlcGates.tsx";


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
export const ACTION_LABEL: Record<string, MessageKey> = {
  "docs.save": "auditAction.docsSave",
  "proposals.approve": "auditAction.proposalsApprove",
  "proposals.reject": "auditAction.proposalsReject",
  "memory.approve": "auditAction.memoryApprove",
  "memory.remove": "auditAction.memoryRemove",
  "tasks.create": "auditAction.tasksCreate",
  "tasks.setDeps": "auditAction.tasksSetDeps",
  "machines.remove": "auditAction.machinesRemove",
  "machines.setProfile": "auditAction.machinesSetProfile",
  "runs.merge": "auditAction.runsMerge",
  "chat.setAutonomy": "auditAction.chatSetAutonomy",
  "specs.importTasks": "auditAction.specsImportTasks",
  "cooldowns.clear": "auditAction.cooldownsClear",
  "policy.set": "auditAction.policySet",
  "agentPolicy.set": "auditAction.agentPolicySet",
  "sdlc.setCeiling": "auditAction.sdlcCeiling",
  "sdlc.setProject": "auditAction.sdlcProject",
  "budgets.set": "auditAction.budgetsSet",
  "tools.save": "auditAction.toolsSave",
  "tools.remove": "auditAction.toolsRemove",
  "tools.setProject": "auditAction.toolsSetProject",
  "systems.save": "auditAction.systemsSave",
  "systems.remove": "auditAction.systemsRemove",
  "admin.commandCreate": "auditAction.commandCreate",
  "admin.commandCancel": "auditAction.commandCancel",
  "machines.commandResult": "auditAction.commandResult",
  "docs.syncRequest": "auditAction.syncRequest",
  "agents.stop": "auditAction.agentsStop",
  "agents.resume": "auditAction.agentsResume",
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
  // What agents write (roadmap 27c).
  "tasks.claim": "auditAction.tasksClaim",
  "tasks.update": "auditAction.tasksUpdate",
  "proposals.create": "auditAction.proposalsCreate",
  "memory.write": "auditAction.memoryWrite",
  "memory.resolve": "auditAction.memoryResolve",
  "memory.keep": "auditAction.memoryKeep",
  "chat.send": "auditAction.chatSend",
  "chat.propose": "auditAction.chatPropose",
  "chat.decide": "auditAction.chatDecide",
  "chat.decideAll": "auditAction.chatDecideAll",
};

/** Small uppercase heading for a group inside a card. */
const GROUP_TITLE = "text-xs font-semibold tracking-wide text-muted-foreground uppercase";

const NO_TOOLS: ToolView[] = [];

/**
 * The tool catalog, for the tools a project requires (roadmap 28b-2): those count as missing items like the policy's.
 * A hub older than the catalog has no tools.list: the policy alone, as before.
 */
export function useHubTools(): ToolView[] {
  const { client } = useHive();
  return useQuery(() => client.call("tools.list", {}).catch((): ToolView[] => []), [client]).data ?? NO_TOOLS;
}

export function MachineCard({
  machine: m,
  policy,
  tools = NO_TOOLS,
  onChanged,
}: {
  machine: MachineDetail;
  policy: TeamPolicy | null;
  tools?: ToolView[];
  onChanged: () => void;
}) {
  const t = useT();
  const projects = m.setup?.projects.map((p) => p.project) ?? [];
  const required = policy ? requiredItemIds(policy, projects, tools) : new Set<string>();
  const missing = policy && m.setup ? missingRequired(policy, m.setup, tools) : [];
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
                {hasNewer(i) ? <Badge tone="warn">{t("setup.newVersion", { version: i.latest! })}</Badge> : null}
                {pending ? (
                  <Badge tone={COMMAND_TONE[pending.status]} className="ml-auto">
                    {t(`commandStatus.${pending.status}`)}
                  </Badge>
                ) : i.action && (i.state !== "installed" || hasNewer(i)) ? (
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
                    {i.state === "installed" ? t("admin.requestUpgrade") : t("admin.requestInstall")}
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

export function PolicyTab() {
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
          <CardTitle>{t("admin.selfApproval")}</CardTitle>
          <CardDescription>{t("admin.selfApprovalHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <NativeSelect
            value={draft.selfApproval}
            onChange={(e) => change({ selfApproval: e.target.value as SelfApproval })}
            aria-label={t("admin.selfApproval")}
          >
            {SELF_APPROVALS.map((v) => (
              <NativeSelectOption key={v} value={v}>
                {t(`admin.selfApprovalOption.${v}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
                selfApproval: draft.selfApproval,
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

      {/* Saved row by row, apart from the button above: a project's manager may change their row without the rest. */}
      <AgentPolicyCard />
      <SdlcGatesCard />
    </>
  );
}
