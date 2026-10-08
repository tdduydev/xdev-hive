import { WorktreeManager } from "#ui/components/Worktrees.tsx";
import { visibleInterval } from "#ui/lib/visible-interval.ts";
import { ResponsiveGridRow, ResponsiveTableFrame } from "#ui/components/ResponsiveTable.tsx";
import { AttentionList, type AttentionItem } from "#ui/components/AttentionList.tsx";
import { SummaryStrip, type SummaryItem } from "#ui/components/SummaryStrip.tsx";
import { ConfigIssues } from "#ui/components/ConfigIssues.tsx";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { ChevronRight, CircleHelp, MoreHorizontal, Plus, RefreshCw } from "lucide-react";
import {
  AGENT_KINDS,
  WORK_ROLES,
  AGENT_TEMPLATES,
  agentProfileSchema,
  AUTONOMY,
  AUTONOMY_ARGS,
  addTokenWindows,
  autonomySource,
  cacheReadShare,
  TOKEN_WINDOWS,
  usageStop,
  CLI_BYPASS_ARGS,
  flagValue,
  type AgentKind,
  type AgentProfile,
  type AgentProfileStatus,
  type WorkRole,
  type Autonomy,
  type LoginHow,
  type NewAccount,
  type ProfileCheck,
  type RunnerSettings,
  type SetupItem,
  type TokenTotals,
  type TokenWindow,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@xdev-hive/ui/components/ui/dropdown-menu";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@xdev-hive/ui/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@xdev-hive/ui/components/ui/sheet";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Badge, Empty, ErrorNote, Notice, PageHeader } from "#ui/components/common.tsx";
import { canOpenCli } from "#ui/components/OpenCli.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { errorMessage, formatCount, formatDay, formatTime, formatUsd, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { activeIntl, rich, useT } from "#ui/i18n/index.tsx";
import { machineQuota, profileRows, profileState, quotaView, rowFix, usageAsOf, type ProfileState, type QuotaLimit } from "#ui/lib/agents.ts";
import { hasNewer } from "#ui/lib/setup.ts";

/** Env var that points each CLI at a separate login, so two subscriptions of one vendor can rotate. */
const ACCOUNT_ENV_HINT: Partial<Record<AgentKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR=~/.claude-2",
  codex: "CODEX_HOME=~/.codex-2",
  gemini: "GEMINI_CLI_HOME=~/.xdev-hive/accounts/gemini-2",
  vibe: "VIBE_HOME=~/.vibe-2",
  opencode: "XDG_CONFIG_HOME=~/.xdev-hive/accounts/opencode-2/config\nXDG_DATA_HOME=~/.xdev-hive/accounts/opencode-2/data\nXDG_CACHE_HOME=~/.xdev-hive/accounts/opencode-2/cache\nXDG_STATE_HOME=~/.xdev-hive/accounts/opencode-2/state",
  kilo: "XDG_CONFIG_HOME=~/.xdev-hive/accounts/kilo-2/config\nXDG_DATA_HOME=~/.xdev-hive/accounts/kilo-2/data\nXDG_CACHE_HOME=~/.xdev-hive/accounts/kilo-2/cache\nXDG_STATE_HOME=~/.xdev-hive/accounts/kilo-2/state",
};

const AGY_CONTROL = "min-h-11 text-base md:min-h-0 md:text-[13px]";
const AGY_BUTTON = "min-h-11 md:min-h-0";

const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs wrap-anywhere";
const HINT = "text-xs text-muted-foreground sm:col-start-2";

export function AgentsPage() {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [tick, setTick] = useState(0);
  const profiles = useQuery(() => desktop.profiles(), [desktop, tick]);
  const settings = useQuery(() => desktop.settings(), [desktop]);
  // Each CLI's version and the newest out (roadmap 33), for the profiles that run the CLI on PATH.
  const setup = useQuery(() => desktop.setupStatus(), [desktop, tick]);
  const cliOf = (p: AgentProfile): SetupItem | null =>
    p.kind !== "custom" && p.bin === AGENT_TEMPLATES[p.kind].bin ? (setup.data?.machine.find((i) => i.id === `cli:${p.kind}`) ?? null) : null;
  const requests = useQuery(() => desktop.hubRequests(), [desktop]);
  const templates = requests.data?.policy?.profileTemplates ?? [];
  const [editing, setEditing] = useState<{ profile: AgentProfile; previousId?: string } | null>(null);
  const [adding, setAdding] = useState<NewAccount["kind"] | null>(null);
  const toast = useToast();
  // Rows opened for their Chi tiết, and whether the off subscriptions are unfolded (roadmap 39c).
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [showOff, setShowOff] = useState(false);
  // Profiles whose sign-in was opened from here: checked every few seconds until signed in (at most 5 minutes).
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const refresh = () => setTick((t) => t + 1);
  const now = useMinute();
  // The read going on (roadmap 52): one profile's id, "all", or none. The main process runs one read at a time anyway.
  const [reading, setReading] = useState<string | null>(null);
  const readUsage = (id?: string) => {
    if (reading) return;
    setReading(id ?? "all");
    void desktop
      .refreshUsage(id ? [id] : undefined)
      .then(refresh, (err: unknown) => toast(errorMessage(err)))
      .finally(() => setReading(null));
  };
  // The newest check of the enabled profiles: the 10-minute one or a read from here.
  const checkedAt = (profiles.data ?? [])
    .filter((p) => p.enabled)
    .map((p) => p.login?.checkedAt ?? "")
    .sort()
    .at(-1);
  const waitFor = (id: string) => setWaiting((w) => ({ ...w, [id]: Date.now() }));
  useEffect(() => {
    const ids = Object.keys(waiting);
    if (!ids.length) return;
    return visibleInterval(4000, () => {
      void desktop.recheckLogins().then(
        (list) => {
          refresh();
          setWaiting((w) => {
            const next = { ...w };
            for (const id of Object.keys(next)) {
              const p = list.find((x) => x.id === id);
              if (p?.login?.loggedIn) {
                toast(t("agents.signedInToast", { id, account: p.login.account ?? p.login.method ?? "" }));
                delete next[id];
              } else if (!p || Date.now() - next[id]! > 5 * 60_000) delete next[id];
            }
            return next;
          });
        },
        () => undefined,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, Object.keys(waiting).join(",")]);

  // Back from a terminal sign-in: check the signed-out profiles again.
  const anySignedOut = (profiles.data ?? []).some((p) => p.login?.loggedIn === false);
  useEffect(() => {
    if (!anySignedOut) return;
    const onFocus = () => void desktop.recheckLogins().then(refresh, () => undefined);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [desktop, anySignedOut]);

  const newProfile = (kind: AgentKind) => {
    const base = kind === "custom" ? { ...AGENT_TEMPLATES.claude, kind, label: t("agents.customLabel"), bin: "", args: ["{prompt}"] } : AGENT_TEMPLATES[kind];
    const taken = new Set((profiles.data ?? []).map((p) => p.id));
    let n = 1;
    while (taken.has(`${kind}-${n}`)) n++;
    setEditing({ profile: { ...base, id: `${kind}-${n}`, label: kind === "custom" ? base.label : t("agents.newLabel", { kind: t(`agentKind.${kind}`), n }), env: {} } });
  };
  // Thêm gói and Sửa share one sheet, so the forms no longer sit 16 buttons down the page.
  const [addOpen, setAddOpen] = useState(false);
  const sheetOpen = addOpen || adding !== null || editing !== null;
  const closeSheet = () => {
    setAddOpen(false);
    setAdding(null);
    setEditing(null);
  };
  const edit = (profile: AgentProfile, previousId?: string) => {
    setAddOpen(false);
    setEditing({ profile, previousId });
  };
  const list = profiles.data ?? [];
  const quotaNow = machineQuota(list, now);
  const enabledCount = list.filter((p) => p.enabled).length;
  const attention: AttentionItem[] = list.flatMap((p): AttentionItem[] => {
    const state = profileState(p);
    const text = state === "signedOut" ? t("agents.attentionSignedOut", { label: p.label }) : state === "noCli" ? t("agents.attentionNoCli", { label: p.label }) : state === "overLimit" ? t("agents.attentionOver", { label: p.label }) : null;
    if (!text) return [];
    const danger = state !== "overLimit";
    return [{ id: p.id, level: danger ? "danger" : "warning", levelLabel: t(danger ? "agents.attentionLevelDanger" : "agents.attentionLevelWarning"), text }];
  });
  const summary: SummaryItem[] = [
    { id: "ready", label: t("agents.summaryReady"), value: quotaNow.count, sub: t("agents.summaryReadySub", { total: enabledCount }), href: "#/agents", tone: enabledCount > 0 && quotaNow.count === 0 ? "warning" : undefined },
    { id: "running", label: t("agents.summaryRunning"), value: list.reduce((n, p) => n + p.running, 0), sub: t("agents.summaryRunningSub"), href: "#/agents" },
    { id: "slots", label: t("agents.summarySlots"), value: quotaNow.slots, sub: t("agents.summarySlotsSub", { reset: quotaNow.reset ? `${quotaNow.label} · ${clock(quotaNow.reset, now)}` : t("agents.quota.unknown") }), href: "#/agents" },
  ];

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-6 pt-5 pb-8 max-md:px-4">
      <PageHeader
        title={t("nav.agents")}
        actions={
          <Button size="sm" data-add-profile onClick={() => setAddOpen(true)}>
            <Plus />
            {t("agents.addProfile")}
          </Button>
        }
      />
      <ConfigIssues issues={settings.data?.configIssues} configPath={settings.data?.configPath} />
      <AttentionList items={attention} label={t("agents.attentionLabel")} />
      <SummaryStrip items={summary} label={t("agents.summaryLabel")} />
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        {checkedAt ? (
          <span data-usage-checked className="text-xs/4 text-fg-muted">
            {t("agents.quota.updatedAt", { time: clock(checkedAt, now) })}
          </span>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          data-read-usage-all
          title={t("agents.quota.readAllHint")}
          aria-busy={reading === "all"}
          disabled={reading !== null || !list.some((p) => p.enabled)}
          onClick={() => readUsage()}
        >
          <RefreshCw className={cn(reading === "all" && "motion-safe:animate-spin")} aria-hidden />
          {reading === "all" ? t("agents.quota.readingAll") : t("agents.quota.readAll")}
        </Button>
      </div>
      <ProfileTable
        profiles={list}
        projects={settings.data?.projects.map((x) => x.name) ?? []}
        waiting={waiting}
        cliOf={cliOf}
        open={openRows}
        onToggle={(id) => setOpenRows((o) => ({ ...o, [id]: !o[id] }))}
        showOff={showOff}
        onShowOff={() => setShowOff((v) => !v)}
        onEdit={(p) => edit(p, p.id)}
        onChanged={refresh}
        onLoginOpened={waitFor}
        now={now}
        reading={reading}
        onRead={readUsage}
      />
      <ErrorNote error={profiles.error} />
      {profiles.data?.length === 0 ? <Empty>{t("agents.none")}</Empty> : null}
      {list.length ? (
        <details data-token-details className="group rounded-[10px] border border-line-default bg-surface">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 px-4 text-[13px]/[18px] font-semibold text-fg-strong outline-none focus-visible:focus-ring md:min-h-10 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
            {t("agents.tokensTitle")}
          </summary>
          <div className="px-4 pb-3">
            <TokenStats profiles={list} />
          </div>
        </details>
      ) : null}
      <details data-machine-settings className="group rounded-[10px] border border-line-default bg-surface">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 px-4 text-[13px]/[18px] font-semibold text-fg-strong outline-none focus-visible:focus-ring md:min-h-10 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
          {t("agents.machineSettings")}
          <span className="text-xs/4 font-normal text-fg-muted">{t("agents.machineSettingsHint")}</span>
        </summary>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {settings.data ? <IntakeCard runner={settings.data.runner} hub={settings.data.mode === "hub"} onSaved={settings.reload} /> : null}
          <div><WorktreeManager /></div>
          {settings.data ? <RunnerCard runner={settings.data.runner} /> : null}
        </div>
      </details>
      <Sheet open={sheetOpen} onOpenChange={(open) => !open && closeSheet()}>
        <SheetContent data-add-sheet className="w-full max-md:!w-full overflow-y-auto sm:max-w-xl max-md:[&_button]:min-h-(--control-h-touch)">
          <SheetHeader>
            <SheetTitle>{t("agents.addProfile")}</SheetTitle>
            <SheetDescription>{t("agents.addSheetHint")}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-4 p-4">
            {editing ? (
              <ProfileForm
                key={editing.previousId ?? editing.profile.id}
                initial={editing.profile}
                previousId={editing.previousId}
                supportedModels={list.find((row) => row.id === editing.profile.id)?.supportedModels ?? null}
                onDone={() => {
                  closeSheet();
                  refresh();
                }}
                onCancel={closeSheet}
              />
            ) : adding ? (
              <AccountForm
                kind={adding}
                onCancel={() => setAdding(null)}
                onAdded={(id) => {
                  const kind = adding;
                  closeSheet();
                  if (kind !== "copilot") waitFor(id);
                  refresh();
                }}
              />
            ) : (
              <>
                <section className="flex flex-col gap-2">
                  <h3 className="m-0 text-[13px]/[18px] font-semibold text-fg-strong">{t("agents.groupAccounts")}</h3>
                  <p className="m-0 text-xs/[18px] text-fg-muted">{t("agents.addAccount")}</p>
                  <div className="flex flex-wrap gap-2">
                    {(["claude", "codex", "antigravity", "gemini", "vibe", "opencode", "kilo", "copilot"] as const).map((k) => (
                      <Button key={k} size="sm" variant="outline" className={AGY_BUTTON} data-add-account={k} disabled={k === "copilot" && list.some((p) => p.kind === "copilot")} onClick={() => setAdding(k)}>
                        {t(`agents.accountKind.${k}`)}
                      </Button>
                    ))}
                  </div>
                </section>
                <section className="flex flex-col gap-2">
                  <h3 className="m-0 text-[13px]/[18px] font-semibold text-fg-strong">{t("agents.groupKinds")}</h3>
                  <p className="m-0 text-xs/[18px] text-fg-muted">{t("agents.add")}</p>
                  <div className="flex flex-wrap gap-2">
                    {AGENT_KINDS.map((k) => (
                      <Button key={k} size="sm" variant="outline" className={AGY_BUTTON} data-add-kind={k} onClick={() => { setAddOpen(false); newProfile(k); }}>
                        {t(`agentKind.${k}`)}
                      </Button>
                    ))}
                  </div>
                </section>
                {templates.length ? (
                  <section className="flex flex-col gap-2">
                    <h3 className="m-0 text-[13px]/[18px] font-semibold text-fg-strong">{t("agents.templates")}</h3>
                    <div className="flex flex-wrap gap-2">
                      {templates.map((tpl) => {
                        const exists = list.some((p) => p.id === tpl.id);
                        return (
                          <Button
                            key={tpl.id}
                            size="sm"
                            variant="outline"
                            className={AGY_BUTTON}
                            disabled={exists}
                            title={exists ? t("agents.templateExists") : t("agents.templateHint")}
                            onClick={() => { setAddOpen(false); setEditing({ profile: { ...tpl, env: {} } }); }}
                          >
                            {tpl.label}
                          </Button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/**
 * The profile's own autonomy, the agent policy's ceiling and what a run gets: the lower of the two. The policy never
 * widens a profile's flags, which a user took it to do (report of 2/10), so the card says how to widen them instead.
 */
function AutonomyNote({ profile: p }: { profile: AgentProfileStatus }) {
  const t = useT();
  const a = p.autonomy;
  const level = (l: Autonomy) => t(`agentPolicy.autonomy.${l}`);
  // effective null: a custom CLI, which keeps its own flags at full and is skipped below it.
  const shown = (effective: Autonomy | null, policy: Autonomy) =>
    effective ? level(effective) : policy === "full" ? t("agents.autonomy.asCli") : t("agents.autonomy.skipped");
  const effective = a.hub ? shown(a.hub.effective, a.hub.policy) : a.own ? level(a.own) : t("agents.autonomy.asCli");
  // The profile, not the policy, holds runs down: only its own args can raise that.
  const limiting = a.own !== null && AUTONOMY.indexOf(a.own) < AUTONOMY.indexOf(a.hub?.policy ?? "full");
  const ceilings = a.hub ? [a.hub.policy, ...a.projects.map((x) => x.policy)] : [];
  const code = (s: string) => <code className={CODE}>{s}</code>;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-autonomy={p.id}>
      <span>
        <span className="font-medium text-fg-strong">{t("agents.autonomy.title")}</span>
        {" · "}
        {a.own === null ? t("agents.autonomy.ownCustom") : rich(t("agents.autonomy.own"), { own: <OwnLevel level={a.own} flag={a.flag} /> })}
        {" · "}
        {a.hub ? t("agents.autonomy.policy", { level: level(a.hub.policy) }) : t("agents.autonomy.noPolicy")}
        {" → "}
        <span className="font-medium text-fg-strong">{t("agents.autonomy.effective", { level: effective })}</span>
      </span>
      {a.projects.map((x) => (
        <span key={x.project}>{t("agents.autonomy.project", { project: x.project, policy: level(x.policy), effective: shown(x.effective, x.policy) })}</span>
      ))}
      {limiting && p.kind !== "custom" ? (
        <span>
          {p.kind === "claude" && a.flag?.includes("acceptEdits") ? `${t("agents.autonomy.claudeEdit")} ` : null}
          {p.kind === "claude"
            ? rich(t("agents.autonomy.widenClaude"), { allowed: code('--allowedTools "Bash(git:*)"'), full: code(AUTONOMY_ARGS.claude.full.join(" ")) })
            : rich(t("agents.autonomy.widen"), { full: code(AUTONOMY_ARGS[p.kind].full.join(" ")) })}
        </span>
      ) : null}
      {a.own === null && ceilings.some((l) => l !== "full") ? <span>{t("agents.autonomy.customSkipped")}</span> : null}
    </div>
  );
}

/** What the args being typed give, read as the runner reads them. */
function ArgsAutonomy({ kind, args }: { kind: Exclude<AgentKind, "custom">; args: string[] }) {
  const t = useT();
  const { level, flag } = autonomySource(kind, args);
  return (
    <span className={HINT} data-args-autonomy={level}>
      {rich(t("agents.autonomy.form"), { own: <OwnLevel level={level} flag={flag} /> })}
    </span>
  );
}

/** A level with the flag it comes from: "Sửa file (--permission-mode acceptEdits)". */
function OwnLevel({ level, flag }: { level: Autonomy; flag: string | null }) {
  const t = useT();
  const name = t(`agentPolicy.autonomy.${level}`);
  return <>{flag ? rich(t("agents.autonomy.withFlag"), { level: name, flag: <code className={CODE}>{flag}</code> }) : t("agents.autonomy.noFlag", { level: name })}</>;
}

/** One more subscription (roadmap 24b): the CLI's own sign-in, in a terminal, with a sign-in folder of its own. */
function AccountForm({ kind, onAdded, onCancel }: { kind: NewAccount["kind"]; onAdded: (id: string) => void; onCancel: () => void }) {
  const { client } = useHive();
  const t = useT();
  const action = useAction();
  const [label, setLabel] = useState("");
  const [way, setWay] = useState(kind === "claude" ? "plan" : "browser");
  const [email, setEmail] = useState("");
  const ways = kind === "opencode" ? (["provider"] as const) : (kind === "antigravity" || kind === "gemini" || kind === "vibe" || kind === "kilo") ? (["browser"] as const) : kind === "claude" ? (["plan", "sso", "console"] as const) : (["browser", "device"] as const);
  const how: LoginHow = { sso: way === "sso", console: way === "console", device: way === "device", ...(kind === "claude" && email.trim() ? { email: email.trim() } : {}) };
  return (
    <Card className="gap-3 py-4">
      <CardContent className="flex flex-col gap-3 px-4">
        <b className="text-sm font-semibold">{t(`agents.accountKind.${kind}`)}</b>
        <form
          className="grid grid-cols-1 items-center gap-x-3 gap-y-2 sm:grid-cols-[160px_minmax(0,1fr)]"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => onAdded((await client.desktop!.addAccount({ kind, label: label.trim() || undefined, how })).id));
          }}
        >
          <Label htmlFor="acc-label">{t("agents.accountLabel")}</Label>
          <Input id="acc-label" className={(kind === "antigravity" || kind === "gemini") ? AGY_CONTROL : undefined} value={label} placeholder={t(kind === "kilo" ? "agents.kiloLabelHint" : kind === "antigravity" ? "agents.agyLabelHint" : kind === "gemini" ? "agents.geminiLabelHint" : "agents.accountLabelHint")} onChange={(e) => setLabel(e.target.value)} />
          <Label htmlFor="acc-way">{t("agents.loginWay")}</Label>
          <NativeSelect id="acc-way" className={(kind === "antigravity" || kind === "gemini") ? AGY_CONTROL : undefined} value={way} onChange={(e) => setWay(e.target.value)} wrapperClassName="w-full">
            {ways.map((w) => (
              <NativeSelectOption key={w} value={w}>
                {kind === "kilo" ? t("agents.kiloWay") : kind === "vibe" ? t("agents.vibeWay") : kind === "antigravity" ? t("agents.agyWay") : t(`agents.way.${w}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {kind === "claude" ? (
            <>
              <Label htmlFor="acc-email">{t("agents.loginEmail")}</Label>
              <Input id="acc-email" type="email" value={email} placeholder="ten@congty.vn" onChange={(e) => setEmail(e.target.value)} />
            </>
          ) : null}
          <span className={HINT}>{kind === "kilo" ? t("agents.kiloLogin") : kind === "opencode" ? t("agents.opencodeLogin") : kind === "antigravity" ? t("agents.agyLogin") : kind === "vibe" ? t("agents.vibeLogin") : kind === "gemini" ? t("agents.geminiLogin") : kind === "copilot" ? t(way === "device" ? "agents.copilotDevice" : "agents.copilotBrowser") : t(`agents.wayHint.${way}` as never)}</span>
          <div className="flex gap-2 sm:col-start-2">
            <Button type="submit" size="sm" className={(kind === "antigravity" || kind === "gemini") ? AGY_BUTTON : undefined} disabled={action.busy}>
              {t("agents.addAndSignIn")}
            </Button>
            <Button type="button" size="sm" className={(kind === "antigravity" || kind === "gemini") ? AGY_BUTTON : undefined} variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
        {kind === "vibe" ? <VibeNotice /> : null}
        <ErrorNote error={action.error} />
        <p className="m-0 text-xs/[18px] text-fg-muted">{kind === "kilo" ? t("agents.kiloAccounts") : kind === "opencode" ? t("agents.opencodeAccounts") : kind === "antigravity" ? t("agents.agyAccounts") : kind === "gemini" ? t("agents.geminiAccounts") : kind === "copilot" ? t("agents.copilotAccounts") : t("agents.accountNote")}</p>
      </CardContent>
    </Card>
  );
}

// A card, not a 900px table: the cells wrap onto a second line when the window is narrow, so nothing scrolls sideways.
const CARD = "flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 max-md:flex-col max-md:items-stretch";

const STATE_TONE: Record<ProfileState, ChipKind> = {
  off: "neutral",
  noCli: "danger",
  signedOut: "danger",
  running: "running",
  overLimit: "warning",
  resting: "warning",
  near: "warning",
  ready: "success",
};

/**
 * Every subscription on this machine, one row each: its CLI and version, the one state it is in, the session and week
 * bars, and in the row the buttons that fix what it reports (roadmap 39c). Off subscriptions fold away.
 */
function ProfileTable({
  profiles,
  projects,
  waiting,
  cliOf,
  open,
  onToggle,
  showOff,
  onShowOff,
  onEdit,
  onChanged,
  onLoginOpened,
  now,
  reading,
  onRead,
}: {
  profiles: AgentProfileStatus[];
  /** This machine's projects, where a subscription's CLI can be opened. */
  projects: string[];
  /** Profiles whose sign-in was opened from here, by id. */
  waiting: Record<string, number>;
  /** The CLI's setup check, when the profile runs the one on PATH: its version and an upgrade (roadmap 33). */
  cliOf: (p: AgentProfileStatus) => SetupItem | null;
  open: Record<string, boolean>;
  onToggle: (id: string) => void;
  showOff: boolean;
  onShowOff: () => void;
  onEdit: (p: AgentProfileStatus) => void;
  onChanged: () => void;
  onLoginOpened: (id: string) => void;
  /** The page's clock, moved each minute, for the countdowns. */
  now: number;
  /** The profile whose quota is being read, "all", or null. */
  reading: string | null;
  onRead: (id: string) => void;
}) {
  const t = useT();
  const { on, off } = profileRows(profiles);
  if (!profiles.length) return null;
  const row = (p: AgentProfileStatus) => (
    <ProfileRow
      key={p.id}
      profile={p}
      projects={projects}
      waiting={p.id in waiting}
      cli={cliOf(p)}
      open={Boolean(open[p.id])}
      onToggle={() => onToggle(p.id)}
      onEdit={() => onEdit(p)}
      onChanged={onChanged}
      onLoginOpened={() => { if (p.kind !== "copilot") onLoginOpened(p.id); }}
      now={now}
      reading={reading === p.id || (reading === "all" && p.enabled)}
      readBusy={reading !== null}
      onRead={() => onRead(p.id)}
    />
  );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 text-[11px]/none font-semibold text-fg-muted">
        {t("agents.colSession")} · {t("agents.colWeek")}
        <Thresholds />
      </div>
      <ResponsiveTableFrame className="flex flex-col gap-2">
        {on.map(row)}
        {off.length ? (
          <button
            type="button"
            data-off-group
            aria-expanded={showOff}
            onClick={onShowOff}
            className="flex min-h-9 w-full cursor-pointer items-center gap-1 rounded-[10px] border border-line-default px-4 text-left text-xs/none font-medium text-fg-secondary outline-none hover:bg-hover focus-visible:focus-ring max-md:min-h-11"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", showOff && "rotate-90")} />
            {t("agents.offGroup", { count: off.length })}
          </button>
        ) : null}
        {showOff ? off.map(row) : null}
      </ResponsiveTableFrame>
    </div>
  );
}

const TOKEN_COLS = "grid-cols-[minmax(170px,1.4fr)_repeat(4,minmax(84px,1fr))_96px_64px]";

/** 1,2 Tr, 34 N: token counts run into the millions; the exact number is in the cell's title. */
const compact = (n: number) => new Intl.NumberFormat(activeIntl(), { notation: "compact", maximumFractionDigits: 1 }).format(n);

/**
 * Each subscription's tokens over 24 hours, 7 or 30 days, and the machine's line (roadmap 46): fresh input, written to
 * and read from the prompt cache, output, and the share of input read from the cache. From this machine's runs.db, in
 * local mode and on a hub alike; a row opens Lượt chạy on that subscription's runs.
 */
function TokenStats({ profiles }: { profiles: AgentProfileStatus[] }) {
  const t = useT();
  const [win, setWin] = useState<TokenWindow>("d7");
  const total = addTokenWindows(profiles.map((p) => p.tokens))[win];
  const cells = (k: TokenTotals) => {
    const share = cacheReadShare(k);
    // A window of old runs only has no split: dashes, not zeros that read as "nothing from the cache".
    const split = k.cacheReadTokens !== null;
    const num = (v: number, shown = split) => (
      <span className="text-right tabular-nums" title={shown ? formatCount(v) : undefined}>
        {shown ? compact(v) : "—"}
      </span>
    );
    return (
      <>
        {num(k.inputTokens)}
        {num(k.cacheWriteTokens)}
        {num(k.cacheReadTokens ?? 0)}
        {num(k.outputTokens, k.runs > 0)}
        <span className="text-right font-medium tabular-nums text-fg-strong">{share === null ? "—" : `${Math.round(share * 100)}%`}</span>
        <span className="text-right tabular-nums text-fg-muted">{formatCount(k.runs)}</span>
      </>
    );
  };
  const ROW = cn("grid min-h-10 items-center py-2 gap-3 border-b border-line-subtle px-4 text-xs/none last:border-b-0", TOKEN_COLS);
  return (
    <section data-token-stats className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="m-0 max-w-3xl text-xs/[18px] text-fg-muted">{t("agents.tokensHint")}</p>
        </div>
        <ToggleGroup type="single" variant="outline" size="sm" value={win} onValueChange={(v) => v && setWin(v as TokenWindow)} aria-label={t("agents.tokensWindow")}>
          {TOKEN_WINDOWS.map((w) => (
            <ToggleGroupItem key={w} value={w} data-token-window={w} className="px-2.5 text-xs">
              {t(`agents.tokenWindow.${w}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="overflow-x-auto rounded-[10px] border border-line-default bg-surface">
        <div className="min-w-[760px]">
          <div className={cn("grid h-[34px] items-center gap-3 border-b border-line-subtle bg-subtle px-4 text-[11px]/none font-semibold text-fg-muted", TOKEN_COLS)}>
            <span>{t("agents.colProfile")}</span>
            <span className="text-right">{t("agents.colInput")}</span>
            <span className="text-right">{t("agents.colCacheWrite")}</span>
            <span className="text-right">{t("agents.colCacheRead")}</span>
            <span className="text-right">{t("agents.colOutput")}</span>
            <span className="text-right" title={t("agents.colShareHint")}>
              {t("agents.colShare")}
            </span>
            <span className="text-right">{t("agents.colRuns")}</span>
          </div>
          {profiles.map((p) => (
            <a
              key={p.id}
              href={`#/runs?profile=${encodeURIComponent(p.id)}`}
              data-token-row={p.id}
              title={t("agents.tokensOpenRuns", { id: p.id })}
              className={cn(ROW, "text-fg-secondary no-underline outline-none hover:bg-hover focus-visible:focus-ring")}
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-medium text-fg-strong">{p.label}</span>
                <span className="truncate font-mono text-[11px]/none text-fg-muted">{p.id}</span>
              </span>
              {cells(p.tokens[win])}
            </a>
          ))}
          <div data-token-total className={cn(ROW, "bg-subtle font-semibold text-fg-strong")}>
            <span>{t("agents.tokensMachine")}</span>
            {cells(total)}
          </div>
        </div>
      </div>
      {total.oldRuns ? <p className="m-0 text-xs/[18px] text-fg-muted">{t("agents.tokensOldRuns", { count: total.oldRuns })}</p> : null}
    </section>
  );
}

/** What the mark on the bars means: out of the table until someone asks (roadmap 39c). */
function Thresholds() {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-thresholds
          aria-label={t("agents.thresholdsTitle")}
          className="flex cursor-pointer items-center text-fg-muted outline-none hover:text-fg-strong focus-visible:focus-ring"
        >
          <CircleHelp className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <PopoverTitle className="mb-1 text-[13px]/[18px]">{t("agents.thresholdsTitle")}</PopoverTitle>
        <p className="m-0 text-xs/[18px] text-fg-secondary">{t("agents.thresholdsNote")}</p>
      </PopoverContent>
    </Popover>
  );
}

function ProfileRow({
  profile: p,
  projects,
  waiting,
  cli,
  open,
  onToggle,
  onEdit,
  onChanged,
  onLoginOpened,
  now,
  reading,
  readBusy,
  onRead,
}: {
  profile: AgentProfileStatus;
  projects: string[];
  waiting: boolean;
  cli: SetupItem | null;
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onLoginOpened: () => void;
  now: number;
  /** This profile's quota is being read. */
  reading: boolean;
  /** A read is going on, this profile's or another's. */
  readBusy: boolean;
  onRead: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const desktop = client.desktop!;
  const action = useAction();
  const [check, setCheck] = useState<ProfileCheck | null>(null);
  const [loginOpened, setLoginOpened] = useState(false);
  const [openedCli, setOpenedCli] = useState<{ profile: string; project: string; bypass: boolean } | null>(null);
  const [token, setToken] = useState("");
  const [resuming, setResuming] = useState(false);
  const state = profileState(p);
  const fix = rowFix(p);
  const quota = quotaView(p, now);
  // What the machine works out itself stays out: saveProfile takes the profile as the config holds it.
  const { cooldownUntil: _c, cooldownReason: _r, cooldownFrom: _f, cliPath: _p, running: _n, lastUsedAt: _l, stats: _s, ...plain } = p;
  const stop = state === "overLimit" ? usageStop(p, p.usage) : null;
  const cliName = p.kind === "custom" ? p.label : t(`agentKind.${p.kind}`);
  const upgrade = cli && hasNewer(cli) && cli.action ? cli : null;

  return (
    <div data-profile={p.id} data-state={state} className={cn("rounded-[10px] border border-line-default bg-surface max-md:border-0 max-md:bg-transparent", p.enabled ? "" : "opacity-70")}>
      <ResponsiveGridRow labels={[t("agents.colProfile"), t("agents.colState"), t("agents.colSession"), t("agents.colWeek"), t("agents.colCost"), null]} className={CARD}>
        <span className="flex min-w-0 items-center gap-1 md:min-w-52 md:flex-[1.4]">
          <button
            type="button"
            data-profile-toggle={p.id}
            aria-expanded={open}
            aria-label={t("agents.rowDetails", { label: p.label })}
            onClick={onToggle}
            className="-ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs text-fg-muted outline-none hover:text-fg-strong focus-visible:focus-ring"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1 text-[13px]/[18px] font-semibold text-fg-strong">
              <span className="truncate">{p.label}</span>
              {p.usage?.planType ? <span className="shrink-0 text-xs/4 font-normal text-fg-muted">· {p.usage.planType}</span> : null}
            </span>
            <span className="truncate text-xs/4 text-fg-muted" data-cli-version={cli?.id}>
              {cli?.version ? t("agents.cliVersion", { cli: cliName, version: cli.version }) : cliName} · <span className="font-mono">{p.id}</span>
            </span>
          </span>
        </span>
        <span title={p.cooldownReason ?? undefined}>
          {/* Until when is on the quota line under the row, next to Bỏ nghỉ. */}
          <Chip kind={STATE_TONE[state]} title={p.cooldownUntil ? formatTime(p.cooldownUntil) : undefined}>
            {t(`agents.state.${state}`)}
          </Chip>
        </span>
        {(["session", "week"] as const).map((which) => {
          const limit = quota[which];
          return limit.known ? (
            <Meter
              key={which}
              which={which}
              limit={limit}
              now={now}
              // Once per row: both numbers come from the same check.
              asOf={which === "session" || !quota.session.known ? usageAsOf(p.usage?.checkedAt, now) : null}
            />
          ) : (
            <span key={which} data-usage-unknown={which} className="flex flex-col gap-[5px] text-[11px]/none text-fg-muted md:min-w-32 md:flex-1">
              <span className="text-xs/none font-medium text-fg-secondary">{t("agents.quota.unknown")}</span>
              <span className="truncate">{t(`agents.quota.why.${limit.why}`)}</span>
            </span>
          );
        })}
        <span className="font-mono text-xs/none text-fg-secondary" title={t("agents.costHint")}>
          {p.stats.costUsd ? `~${formatUsd(p.stats.costUsd)}` : "—"}
        </span>
        <span className="flex items-center justify-end gap-1.5 md:ml-auto">
          {/* One button for what the row reports; the states exclude each other, so there is never a second. Bỏ nghỉ is
              not one of them: a rest can go with any state, so it has its place on the quota line. */}
          {fix === "installCli" ? (
            <Button asChild size="sm" variant="outline">
              <a href="#/setup">{t("agents.installCli")}</a>
            </Button>
          ) : fix === "login" ? (
            <Button
              size="sm"
              data-login={p.id}
              disabled={action.busy}
              onClick={() => void action.run(async () => (await desktop.openLogin(p.id), setLoginOpened(true), onLoginOpened()))}
            >
              {t("agents.login")}
            </Button>
          ) : null}
          {p.kind === "copilot" && p.cliPath !== null && fix !== "login" ? (
            <Button size="sm" variant="outline" data-login={p.id} disabled={action.busy} onClick={() => void action.run(async () => (await desktop.openLogin(p.id), setLoginOpened(true), onLoginOpened()))}>
              {t("agents.login")}
            </Button>
          ) : null}
          {upgrade ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              data-cli-upgrade={upgrade.id}
              title={t("setup.newVersion", { version: upgrade.latest! })}
              onClick={() => void action.run(async () => (await desktop.installSetup(upgrade.id), onChanged()))}
            >
              {action.busy ? t("setup.installing") : upgrade.action}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            data-profile-enable={p.id}
            disabled={action.busy}
            onClick={() => void action.run(async () => (await desktop.saveProfile({ ...plain, enabled: !p.enabled }, p.id), onChanged()))}
          >
            {p.enabled ? t("agents.disable") : t("agents.enable")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8" data-row-menu={p.id} aria-label={t("agents.rowActions", { label: p.label })}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem data-edit-profile={p.id} onSelect={onEdit}>{t("agents.edit")}</DropdownMenuItem>
              {canOpenCli(p)
                ? projects.flatMap((name) =>
                    // A separate item, not a setting: each terminal opened without prompts is chosen on its own.
                    [false, ...(CLI_BYPASS_ARGS[p.kind] ? [true] : [])].map((bypass) => (
                      <DropdownMenuItem
                        key={`${name}:${bypass}`}
                        data-open-cli={`${p.id}:${name}${bypass ? ":bypass" : ""}`}
                        onSelect={() => void action.run(async () => (await desktop.openCli(p.id, name, { bypass }), setOpenedCli({ profile: p.id, project: name, bypass })))}
                      >
                        {projects.length > 1 ? t(bypass ? "agents.cliOpenInBypass" : "agents.cliOpenIn", { project: name }) : t(bypass ? "agents.cliOpenBypass" : "agents.cliOpen")}
                      </DropdownMenuItem>
                    )),
                  )
                : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => {
                  if (window.confirm(t("agents.confirmRemove", { id: p.id }))) void action.run(async () => (await desktop.removeProfile(p.id), onChanged()));
                }}
              >
                {t("agents.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </ResponsiveGridRow>
      {p.kind === "gemini" ? <GeminiInfo /> : null}
      {p.kind === "vibe" ? <div className="px-4 pb-3"><VibeNotice /></div> : null}
      {p.kind === "opencode" ? <div className="px-4 pb-3"><OpenCodeNotice /></div> : null}
      {p.kind === "kilo" ? <div className="px-4 pb-3"><KiloInfo /></div> : null}
      {p.kind === "antigravity" ? (
        <div data-agy-pools className="flex flex-wrap gap-x-3 gap-y-1 px-4 pb-2 text-xs text-fg-muted">
          <span>{t("agents.agyPoolSelected", { pool: /claude|gpt/i.test(flagValue(p.args, ["--model"]) ?? "") ? "Claude/GPT" : "Gemini" })}</span>
          {p.usage?.others.map((limit) => <span key={limit.label}>{limit.label}: {limit.percent}%</span>)}
        </div>
      ) : null}
      {/* Always shown, off rows too (roadmap 52): the counts and the rest are what a person checks the page for. */}
      <div data-quota={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-3 text-xs/4 text-fg-muted">
        <QuotaOutlookLine p={p} now={now} />
        {quota.rest || quota.canResume ? (
          <span data-resting={quota.rest ? p.id : undefined} className="flex items-center gap-2" title={quota.rest?.reason ?? undefined}>
            {quota.rest ? <Chip kind="warning">{t("agents.quota.restingUntil", { time: clock(quota.rest.until, now) })}</Chip> : null}
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              data-resume={p.id}
              aria-label={t("agents.quota.resumeLabel", { label: p.label })}
              title={t("agents.quota.resumeHint")}
              disabled={action.busy || readBusy}
              onClick={() => {
                if (window.confirm(t("agents.quota.confirmResume", { id: p.id })))
                  void action.run(async () => {
                    setResuming(true);
                    try {
                      await desktop.resumeProfile(p.id);
                      toast(t("agents.quota.resumed", { id: p.id }));
                      onChanged();
                    } finally {
                      setResuming(false);
                    }
                  });
              }}
            >
              {resuming ? t("agents.quota.resuming") : t("agents.quota.resume")}
            </Button>
          </span>
        ) : null}
        {quota.resumed ? (
          <span data-resumed={p.id} className="text-fg-secondary" title={formatTime(quota.resumed.at)}>
            {t("agents.quota.resumedBy", { who: quota.resumed.by, time: clock(quota.resumed.until, now) })}
          </span>
        ) : null}
        <span data-stat-line={p.id}>
          <span className={quota.counts.hitLimit ? "font-medium text-warning" : undefined}>{t("agents.quota.hitLimit", { count: quota.counts.hitLimit })}</span>
          {" · "}
          {t("agents.quota.runs", { count: quota.counts.runs })} · {t("agents.quota.done", { count: quota.counts.done })} ·{" "}
          {t("agents.quota.failed", { count: quota.counts.failed })}
          {" · "}
          <span data-stats-since={quota.counts.since ?? ""}>
            {quota.counts.since ? t("agents.quota.since", { date: formatDay(quota.counts.since) }) : t("agents.quota.sinceStart")}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            data-read-usage={p.id}
            aria-label={t(reading ? "agents.quota.reading" : "agents.quota.read", { label: p.label })}
            title={t("agents.quota.read", { label: p.label })}
            aria-busy={reading}
            disabled={readBusy || !quota.canRead}
            onClick={onRead}
          >
            <RefreshCw className={cn(reading && "motion-safe:animate-spin")} aria-hidden />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            data-reset-stats={p.id}
            aria-label={t("agents.quota.resetStatsLabel", { label: p.label })}
            disabled={action.busy}
            onClick={() => {
              if (window.confirm(t("agents.quota.confirmResetStats", { id: p.id })))
                void action.run(async () => (await desktop.resetStats(p.id), toast(t("agents.quota.statsReset", { id: p.id })), onChanged()));
            }}
          >
            {t("agents.quota.resetStats")}
          </Button>
        </span>
      </div>
      {open ? (
        <div className="flex flex-col gap-3 border-t border-line-subtle bg-subtle px-4 py-3 text-sm">
          {state === "noCli" ? (
            <span className="text-destructive">
              {rich(t("agents.noCli"), {
                bin: <code className={CODE}>{p.bin}</code>,
                link: (
                  <a href="#/setup" className="underline underline-offset-2">
                    {t("nav.setup")}
                  </a>
                ),
              })}
            </span>
          ) : state === "signedOut" ? (
            <span className="text-destructive">{rich(t("agents.signedOut"), { cmd: <code className={CODE}>{p.login?.loginCommand ?? p.bin}</code> })}</span>
          ) : stop ? (
            <span className="text-warning">
              {t(stop === "session" ? "agents.overLimitSession" : "agents.overLimitWeek", {
                percent: (stop === "session" ? p.usage?.session : p.usage?.week)?.percent ?? "?",
                stop: stop === "session" ? p.stopAtSession : p.stopAtWeek,
                resets: (stop === "session" ? p.usage?.session : p.usage?.week)?.resets ?? "?",
              })}
            </span>
          ) : state === "resting" ? (
            <span className="text-warning">
              {t("agents.restingUntil", { time: formatTime(p.cooldownUntil) })}
              {p.cooldownFrom ? ` · ${t("agents.reportedBy", { who: p.cooldownFrom })}` : ""}
              {p.cooldownReason ? ` · ${p.cooldownReason}` : ""}
            </span>
          ) : state === "running" ? (
            <span className="text-info">{t("agents.runningN", { count: p.running })}</span>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {p.roles.map((r) => (
              <Badge key={r}>{t(`agentRole.${r}`)}</Badge>
            ))}
            {p.readOnly ? <Badge tone="neutral">{t("agents.readOnlyBadge")}</Badge> : null}
            {p.container ? (
              <span title={p.container.image}>
                <Badge tone="info">{p.container.network === "open" ? t("agents.containerBadge") : t("agents.containerLimitedBadge")}</Badge>
              </span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              {t("agents.priorityN", { n: p.priority })} · {t("agents.parallelN", { n: p.maxConcurrent })}
              {p.account ? ` · ${t("agents.accountN", { account: p.account })}` : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            {/* The counts are on the quota line under the row. */}
            {p.stats.costUsd > 0 ? <span>{t("agents.statCost", { cost: formatUsd(p.stats.costUsd) })}</span> : null}
            {p.lastUsedAt ? <span>{t("agents.lastUsed", { time: formatTime(p.lastUsedAt) })}</span> : null}
            {p.kind === "kilo" && p.login?.loggedIn ? <span>{t("agents.kiloCredential")}</span> : p.login?.loggedIn ? (
              <span>
                {p.login.method ? t("agents.signedIn", { method: p.login.method }) : t("agents.signedInPlain")}
                {p.login.account ? ` · ${p.login.account}` : ""}
              </span>
            ) : null}
          </div>
          <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-nowrap">
            {Object.entries(p.env)
              .map(([k, v]) => `${k}=${v} `)
              .join("")}
            {p.bin} {p.args.join(" ")}
          </code>
          <AutonomyNote profile={p} />
          {p.kind === "copilot" ? (
            <Notice tone="warn"><div className="space-y-2 text-xs">
              <p>{t("agents.copilotLimits")} <a className="underline underline-offset-2" href="https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing" target="_blank" rel="noreferrer">{t("agents.copilotSource")}</a></p>
              <p>{t("agents.copilotAccounts")} <a className="underline underline-offset-2" href="https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli" target="_blank" rel="noreferrer">{t("agents.copilotSource")}</a></p>
              <p>{t("agents.copilotPermissions")} <a className="underline underline-offset-2" href="https://docs.github.com/en/copilot/how-tos/cloud-and-local-sandboxes/configuring-local-sandbox-settings" target="_blank" rel="noreferrer">{t("agents.copilotSource")}</a></p>
            </div></Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => setCheck(await desktop.checkProfile(p.id)))}>
              {t("agents.checkCli")}
            </Button>
            {p.kind === "kilo" && p.cliPath && p.login?.loginCommand ? <Button size="sm" className={AGY_BUTTON} variant="outline" disabled={action.busy} onClick={() => void action.run(async () => (await desktop.openLogin(p.id), setLoginOpened(true), onLoginOpened()))}>{t("agents.login")}</Button> : null}
            {state === "signedOut" && p.login?.loginCommand && p.kind === "claude" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                onClick={() => void action.run(async () => (await desktop.openLogin(p.id, { sso: true }), setLoginOpened(true), onLoginOpened()))}
              >
                {t("agents.loginSso")}
              </Button>
            ) : null}
          </div>
          {p.kind === "claude" && p.container ? (
            <form
              className="flex flex-col gap-2 rounded-md border border-line-default p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void action.run(async () => (await desktop.setProfileToken(p.id, token), setToken(""), onChanged()));
              }}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{t("agents.token")}</span>
                <Badge tone={p.hasToken ? "ok" : "warn"}>{p.hasToken ? t("agents.tokenSaved") : t("agents.tokenMissing")}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="min-w-48 flex-1 font-mono text-xs md:text-xs"
                  type="password"
                  autoComplete="off"
                  data-token={p.id}
                  placeholder={t("agents.tokenPlaceholder")}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  aria-label={t("agents.token")}
                />
                <Button size="sm" type="submit" variant="outline" disabled={action.busy || !token.trim()}>
                  {t("agents.tokenSave")}
                </Button>
                {p.hasToken ? (
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={action.busy}
                    onClick={() => void action.run(async () => (await desktop.setProfileToken(p.id, ""), onChanged()))}
                  >
                    {t("agents.tokenRemove")}
                  </Button>
                ) : null}
                <Button size="sm" type="button" variant="ghost" disabled={action.busy} onClick={() => void action.run(() => desktop.openSetupToken(p.id))}>
                  {t("agents.tokenCreate")}
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">{t("agents.tokenHint")}</span>
            </form>
          ) : null}
          {check ? (
            <Notice tone={check.ok ? "ok" : "error"}>
              {check.path ? <div className="max-w-full font-mono text-xs break-all">{check.path}</div> : null}
              <div className="max-w-full font-mono text-xs whitespace-pre-wrap wrap-anywhere">{check.output || (check.ok ? "OK" : t("runStatus.failed"))}</div>
            </Notice>
          ) : null}
        </div>
      ) : null}
      {/* Answers to what the row's own buttons did: shown whether or not Chi tiết is open. */}
      {((loginOpened || waiting) && state === "signedOut") || (loginOpened && p.kind === "copilot") || openedCli || action.error ? (
        <div className="flex flex-col gap-2 px-4 pb-3">
          {(loginOpened || waiting) && state === "signedOut" ? <Notice tone="info">{t(waiting ? "agents.loginWaiting" : "agents.loginOpened")}</Notice> : null}
          {loginOpened && p.kind === "copilot" ? <Notice tone="info">{t("agents.copilotLoginUnknown")}</Notice> : null}
          {openedCli ? <Notice tone={openedCli.bypass ? "warn" : "info"}>{t(openedCli.bypass ? "openCli.openedBypass" : "openCli.opened", { profile: openedCli.profile, project: openedCli.project })}</Notice> : null}
          <ErrorNote error={action.error} />
        </div>
      ) : null}
    </div>
  );
}

const envToText = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const textToEnv = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf("=");
        return i === -1 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );

function ProfileForm({
  initial,
  previousId,
  supportedModels,
  onDone,
  onCancel,
}: {
  initial: AgentProfile;
  previousId?: string;
  supportedModels: string[] | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const [p, setP] = useState(initial);
  const [argsText, setArgsText] = useState(initial.args.join("\n"));
  const [envText, setEnvText] = useState(envToText(initial.env));
  const [allowText, setAllowText] = useState((initial.container?.allow ?? []).join("\n"));
  const [error, setError] = useState<string | null>(null);
  const action = useAction();
  const set = <K extends keyof AgentProfile>(key: K, value: AgentProfile[K]) => setP({ ...p, [key]: value });
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== "" ? Number(v) : fallback);

  const submit = () => {
    const allow = allowText.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean);
    const candidate = {
      ...p,
      args: argsText.split("\n").filter((a) => a.length > 0),
      env: textToEnv(envText),
      container: p.container ? { ...p.container, allow } : null,
    };
    const parsed = agentProfileSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
      return;
    }
    setError(null);
    void action.run(async () => {
      await client.desktop!.saveProfile(parsed.data, previousId);
      onDone();
    });
  };

  return (
    <form
      className={p.kind === "gemini" ? "[&_input:not([type=checkbox])]:min-h-11 [&_input:not([type=checkbox])]:text-base [&_select]:min-h-11 [&_select]:text-base [&_textarea]:text-base md:[&_input:not([type=checkbox])]:min-h-0 md:[&_input:not([type=checkbox])]:text-[13px] md:[&_select]:min-h-0 md:[&_select]:text-[13px] md:[&_textarea]:text-[13px]" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{previousId ? t("agents.editTitle", { id: previousId }) : t("agents.newTitle")}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
            <Label htmlFor="pf-id">Id</Label>
            <Input id="pf-id" className="font-mono" value={p.id} onChange={(e) => set("id", e.target.value)} />
            <Label htmlFor="pf-label">{t("agents.name")}</Label>
            <Input id="pf-label" value={p.label} onChange={(e) => set("label", e.target.value)} />
            <Label htmlFor="pf-kind">{t("agents.kind")}</Label>
            <NativeSelect id="pf-kind" value={p.kind} onChange={(e) => { const kind = e.target.value as AgentKind; setP({ ...p, kind, container: kind === "copilot" ? null : p.container }); }}>
              {AGENT_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`agentKind.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Label htmlFor="pf-bin">{t("agents.bin")}</Label>
            <Input id="pf-bin" className="font-mono" placeholder={t("agents.binPlaceholder")} value={p.bin} onChange={(e) => set("bin", e.target.value)} />
            <Label htmlFor="pf-args" className="leading-snug sm:self-start sm:pt-2.5">
              {t("agents.args")}
            </Label>
            <Textarea id="pf-args" className="font-mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} />
            {p.kind !== "custom" ? <ArgsAutonomy kind={p.kind} args={argsText.split("\n").filter((a) => a.length > 0)} /> : null}
            <span className={HINT}>
              {rich(t("agents.argsHint"), {
                prompt: <code className={CODE}>{"{prompt}"}</code>,
                others: (
                  <>
                    <code className={CODE}>{"{worktree}"}</code>, <code className={CODE}>{"{task}"}</code>, <code className={CODE}>{"{project}"}</code>,{" "}
                    <code className={CODE}>{"{branch}"}</code>
                  </>
                ),
                help: <code className={CODE}>--help</code>,
              })}
            </span>
            {p.kind === "gemini" ? <div className="sm:col-span-2"><GeminiInfo login /></div> : null}
            {p.kind === "opencode" ? <>
              <Label htmlFor="pf-opencode-model">{t("agents.opencodeModel")}</Label>
              <Input id="pf-opencode-model" className="font-mono" list="pf-opencode-models" aria-describedby="pf-opencode-model-hint" value={p.opencode?.model ?? ""} onChange={(e) => set("opencode", { ...p.opencode, model: e.target.value || undefined })} placeholder="provider/model" />
              <datalist id="pf-opencode-models">{supportedModels?.map((model) => <option key={model} value={model} />)}</datalist>
              <span id="pf-opencode-model-hint" className={HINT}>{t("agents.opencodeModelHint")}</span>
              <Label htmlFor="pf-opencode-small">{t("agents.opencodeSmallModel")}</Label>
              <Input id="pf-opencode-small" className="font-mono" list="pf-opencode-models" aria-describedby="pf-opencode-small-hint" value={p.opencode?.smallModel ?? ""} onChange={(e) => set("opencode", { ...p.opencode, smallModel: e.target.value || undefined })} />
              <span id="pf-opencode-small-hint" className={HINT}>{t("agents.opencodeSmallHint")}</span>
              <OpenCodeNotice />
            </> : null}
            {p.kind === "kilo" ? <div className="sm:col-start-2"><KiloInfo /></div> : null}
            {p.kind === "antigravity" ? <>
              <Label htmlFor="pf-agy-project">{t("agents.agyProject")}</Label>
              <Input id="pf-agy-project" className={AGY_CONTROL} aria-describedby="pf-agy-project-hint" value={textToEnv(envText).GOOGLE_CLOUD_QUOTA_PROJECT ?? ""} onChange={(e) => {
                const env = textToEnv(envText);
                if (e.target.value) { env.GOOGLE_CLOUD_QUOTA_PROJECT = e.target.value; env.AGY_ADC_AUTH = "true"; }
                else { delete env.GOOGLE_CLOUD_QUOTA_PROJECT; delete env.AGY_ADC_AUTH; }
                setEnvText(envToText(env));
              }} />
              <span id="pf-agy-project-hint" className={HINT}>{t("agents.agyProjectHint")}</span>
              <span className={HINT}>{t("agents.agyAccounts")}</span>
            </> : null}
            {p.kind === "copilot" ? <span className={HINT}>{t("agents.copilotAccounts")} {t("agents.copilotPermissions")}</span> : null}
            <Label htmlFor="pf-env" className="leading-snug sm:self-start sm:pt-2.5">
              {t("agents.env")}
            </Label>
            <Textarea
              id="pf-env"
              className={p.kind === "gemini" ? "font-mono text-base md:text-[13px]" : "font-mono"}
              placeholder={ACCOUNT_ENV_HINT[p.kind] ?? "KEY=value"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
            <span className={HINT}>
              {p.kind === "antigravity" ? t("agents.agyAccounts") : ACCOUNT_ENV_HINT[p.kind]
                ? rich(t("agents.envHintExample"), { example: <code className={CODE}>{ACCOUNT_ENV_HINT[p.kind]}</code> })
                : t("agents.envHint")}
            </span>
            {p.kind === "vibe" ? <div className={HINT}><VibeNotice /></div> : null}
            <Label htmlFor="pf-account" className="leading-snug">
              {t("agents.account")}
            </Label>
            <Input
              id="pf-account"
              className="font-mono"
              placeholder="claude-max-duy"
              value={p.account ?? ""}
              onChange={(e) => set("account", e.target.value.trim() || undefined)}
            />
            <span className={HINT}>{t("agents.accountHint")}</span>
            <Label>{t("agents.roles")}</Label>
            <div className="flex flex-wrap items-center gap-4">
              {WORK_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={p.roles.includes(r)}
                    onCheckedChange={(v) => set("roles", v === true ? [...p.roles, r] : p.roles.filter((x: WorkRole) => x !== r))}
                  />
                  {t(`agentRole.${r}`)}
                </label>
              ))}
            </div>
            <Label htmlFor="pf-priority">{t("agents.priority")}</Label>
            <Input
              id="pf-priority"
              className="sm:max-w-40"
              type="number"
              min={0}
              max={100}
              value={p.priority}
              onChange={(e) => set("priority", num(e.target.value, p.priority))}
            />
            <Label htmlFor="pf-conc">{t("agents.maxConcurrent")}</Label>
            <Input
              id="pf-conc"
              className="sm:max-w-40"
              type="number"
              min={1}
              max={8}
              value={p.maxConcurrent}
              onChange={(e) => set("maxConcurrent", num(e.target.value, p.maxConcurrent))}
            />
            <Label htmlFor="pf-cool">{t("agents.cooldown")}</Label>
            <Input
              id="pf-cool"
              className="sm:max-w-40"
              type="number"
              min={1}
              value={p.cooldownMinutes}
              onChange={(e) => set("cooldownMinutes", num(e.target.value, p.cooldownMinutes))}
            />
            <Label htmlFor="pf-timeout">{t("agents.timeout")}</Label>
            <Input
              id="pf-timeout"
              className="sm:max-w-40"
              type="number"
              min={1}
              value={p.timeoutMinutes}
              onChange={(e) => set("timeoutMinutes", num(e.target.value, p.timeoutMinutes))}
            />
            <Label htmlFor="pf-stop-session">{t("agents.stopAtSession")}</Label>
            <Input
              id="pf-stop-session"
              className="sm:max-w-40"
              type="number"
              min={1}
              max={100}
              value={p.stopAtSession}
              onChange={(e) => set("stopAtSession", num(e.target.value, p.stopAtSession))}
            />
            <Label htmlFor="pf-stop-week">{t("agents.stopAtWeek")}</Label>
            <Input
              id="pf-stop-week"
              className="sm:max-w-40"
              type="number"
              min={1}
              max={100}
              value={p.stopAtWeek}
              onChange={(e) => set("stopAtWeek", num(e.target.value, p.stopAtWeek))}
            />
            <span className={HINT}>{t(p.kind === "antigravity" ? "agents.agyStopHint" : "agents.stopHint")}</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={p.enabled} onCheckedChange={(v) => set("enabled", v === true)} />
            {t("agents.enabled")}
          </label>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={p.readOnly} onCheckedChange={(v) => set("readOnly", v === true)} />
              {t("agents.readOnly")}
            </label>
            <span className={HINT}>{t("agents.readOnlyHint")}</span>
          </div>
          {p.kind === "codex" ? (
            <div className="flex flex-col gap-1">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <Checkbox checked={p.codexLocalhost} onCheckedChange={(v) => set("codexLocalhost", v === true)} />
                {t("agents.codexLocalhost")}
              </label>
              <span className={HINT}>{t("agents.codexLocalhostHint")}</span>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={p.container !== null}
                disabled={p.kind === "copilot"}
                onCheckedChange={(v) =>
                  set("container", v === true ? (p.container ?? { image: "xdev-hive-agent", network: "restricted", allow: [] }) : null)
                }
              />
              {t("agents.container")}
            </label>
            {p.kind === "copilot" ? <span className={HINT}>{t("agents.copilotContainer")}</span> : null}
            {p.container ? (
              <div className="flex flex-col gap-2 pl-6">
                <Input
                  className="max-w-80 font-mono text-xs md:text-xs"
                  value={p.container.image}
                  onChange={(e) => set("container", { ...p.container!, image: e.target.value.trim() })}
                  aria-label={t("agents.containerImage")}
                  placeholder="xdev-hive-agent"
                />
                <NativeSelect
                  className="max-w-80"
                  value={p.container.network}
                  onChange={(e) => set("container", { ...p.container!, network: e.target.value as "restricted" | "open" })}
                  aria-label={t("agents.network")}
                >
                  <NativeSelectOption value="restricted">{t("agents.networkRestricted")}</NativeSelectOption>
                  <NativeSelectOption value="open">{t("agents.networkOpen")}</NativeSelectOption>
                </NativeSelect>
                {p.container.network === "restricted" ? (
                  <>
                    <Textarea
                      className="max-w-80 font-mono text-xs md:text-xs"
                      rows={3}
                      value={allowText}
                      onChange={(e) => setAllowText(e.target.value)}
                      placeholder={"registry.example.com\n.corp.example.com\nhost:8443"}
                      aria-label={t("agents.networkAllow")}
                    />
                    <span className={HINT}>{t("agents.networkHint")}</span>
                  </>
                ) : null}
              </div>
            ) : null}
            <span className={HINT}>{t("agents.containerHint")}</span>
          </div>
          <ErrorNote error={error} />
          <ErrorNote error={action.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" className={(p.kind === "antigravity" || p.kind === "gemini") ? AGY_BUTTON : undefined} disabled={action.busy}>
              {t("agents.save")}
            </Button>
            <Button variant="ghost" type="button" className={(p.kind === "antigravity" || p.kind === "gemini") ? AGY_BUTTON : undefined} onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/** The runner's less frequent settings: attempts per task and where worktrees go. */
function RunnerCard({ runner }: { runner: RunnerSettings }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const [maxAttempts, setMaxAttempts] = useState(String(runner.maxAttempts));
  const [root, setRoot] = useState(runner.worktreeRoot ?? "");
  const action = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="m-0">{t("agents.advanced")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Label htmlFor="rn-att" className="leading-snug">
            {t("agents.runnerAttempts")}
          </Label>
          <Input id="rn-att" className="w-20" type="number" min={1} max={6} value={maxAttempts} onChange={(e) => setMaxAttempts(e.target.value)} />
        </div>
        <div className="grid items-center gap-3 sm:grid-cols-[180px_1fr]">
          <Label htmlFor="rn-root">{t("agents.runnerRoot")}</Label>
          <Input id="rn-root" className="font-mono" placeholder={t("agents.runnerRootPlaceholder")} value={root} onChange={(e) => setRoot(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                try {
                  await client.desktop!.updateSettings({ runner: { maxAttempts: Number(maxAttempts), worktreeRoot: root.trim() || null } });
                  toast(t("agents.savedToast"));
                } catch (err) {
                  throw new Error(errorMessage(err));
                }
              })
            }
          >
            {t("agents.runnerSave")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

/** "Nhận việc trên máy này": take runs from the hub (hub mode), and how many agents at once. Saved right away. */
function IntakeCard({ runner, hub, onSaved }: { runner: RunnerSettings; hub: boolean; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const toast = useToast();
  const action = useAction();
  const save = (patch: Partial<RunnerSettings>) =>
    void action.run(async () => {
      await client.desktop!.updateSettings({ runner: patch });
      toast(t("agents.savedToast"));
      onSaved();
    });
  const options = [...new Set([1, 2, 3, 4, runner.maxParallel])].sort((a, b) => a - b);
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line-default bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-4">
        <span className="flex min-w-[240px] flex-1 flex-col gap-0.5">
          <span className="text-sm/5 font-semibold text-fg-strong">{t("agents.recvTitle")}</span>
          <span className="text-xs/4 text-fg-muted">{hub ? (runner.acceptHubRuns ? t("agents.recvHubOn") : t("agents.recvHubOff")) : t("agents.recvLocal")}</span>
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs/none text-fg-muted">{t("agents.maxAtOnce")}</span>
          <div role="radiogroup" aria-label={t("agents.maxAtOnce")} className="flex gap-0.5 rounded-[7px] bg-sunken p-0.5">
            {options.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={runner.maxParallel === n}
                disabled={action.busy}
                onClick={() => runner.maxParallel !== n && save({ maxParallel: n })}
                className={cn(
                  "h-6 w-7 cursor-pointer rounded-[5px] font-mono text-xs/none font-semibold text-fg-strong outline-none focus-visible:focus-ring",
                  runner.maxParallel === n ? "bg-surface shadow-e1" : "hover:bg-hover",
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        {hub ? <Switch checked={runner.acceptHubRuns} disabled={action.busy} onCheckedChange={(v) => save({ acceptHubRuns: v })} aria-label={t("agents.runnerHubRuns")} /> : null}
      </div>
      {hub ? <label className="flex min-h-11 items-center gap-3 text-sm">
        <Switch className="relative before:absolute before:-inset-3 md:before:hidden" checked={runner.gateRunner ?? false} disabled={action.busy} onCheckedChange={v => save({ gateRunner: v })} aria-label={t("mergeQueue.role")} />
        <span>{t("mergeQueue.role")}<span className="block text-xs text-muted-foreground">{t("mergeQueue.roleHint")}</span></span>
      </label> : null}
      <label htmlFor="auto-update-idle" className="flex min-h-11 cursor-pointer items-center gap-4 border-t border-line-subtle pt-2">
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm/5 font-semibold text-fg-strong">{t("agents.autoUpdateIdle")}</span>
          <span id="auto-update-idle-hint" className="text-xs/4 text-fg-muted">{t("agents.autoUpdateIdleHint")}</span>
        </span>
        <Switch
          id="auto-update-idle"
          checked={runner.autoUpdateIdle ?? runner.acceptHubRuns}
          disabled={action.busy}
          onCheckedChange={(v) => save({ autoUpdateIdle: v })}
          aria-label={t("agents.autoUpdateIdle")}
          aria-describedby="auto-update-idle-hint"
          className="relative before:absolute before:-inset-3 md:before:hidden"
        />
      </label>
      <ErrorNote error={action.error} />
    </div>
  );
}

/** The time, moved on each minute: the countdowns change no faster, and the page renders no more often than that. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    return visibleInterval(60_000, () => setNow(Date.now()));
  }, []);
  return now;
}

/** "14:05" today, "Th 5 09:00" within the week (a week's reset is never further), the date beyond that. */
function clock(iso: string, now: number): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  const inWeek = Math.abs(at.getTime() - now) < 6 * 86_400_000;
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : inWeek
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" };
  return at.toLocaleString(activeIntl(), opts);
}

const TONE = { ok: "bg-primary", near: "bg-warning-solid", over: "bg-danger-solid" } as const;

function Meter({ which, limit, now, asOf }: { which: "session" | "week"; limit: Extract<QuotaLimit, { known: true }>; now: number; asOf: string | null }) {
  const t = useT();
  const { percent: pct, stop, resets, resetsAt, left } = limit;
  return (
    <span className="flex min-w-0 flex-col gap-[5px] md:min-w-32 md:flex-1" data-meter={which}>
      <span className="flex text-[11px]/none text-fg-muted">
        <span className="font-mono text-xs/none font-semibold text-fg-strong">{pct}%</span>
        {/* Re-rendered each minute: aria-live off so a screen reader does not read it out every time. */}
        {left ? (
          <span data-reset-left className="ml-auto truncate pl-2 font-medium text-fg-secondary" aria-live="off">
            {left.days
              ? t(left.hours ? "agents.quota.left.daysHours" : "agents.quota.left.days", left)
              : left.hours
                ? t("agents.quota.left.hours", left)
                : t("agents.quota.left.minutes", left)}
          </span>
        ) : null}
      </span>
      <span
        role="meter"
        aria-label={t(which === "session" ? "agents.colSession" : "agents.colWeek")}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-1.5 rounded-[3px] bg-sunken"
      >
        <span className={cn("absolute inset-y-0 left-0 rounded-[3px]", TONE[limit.tone])} style={{ width: `${pct}%` }} />
        <span title={t("agents.stopMark", { percent: stop })} className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-fg-muted" style={{ left: `${Math.min(100, stop)}%` }} />
      </span>
      {/* The reset in this machine's time; the CLI's own text ("Oct 8 at 5:59pm (Asia/Saigon)") when it could not be read. */}
      {resetsAt || resets ? (
        <span data-reset-at className="truncate text-[11px]/none text-fg-muted" title={resets ?? undefined}>
          {resetsAt
            ? left
              ? t("agents.quota.resetAt", { time: clock(resetsAt, now) })
              : t("agents.quota.resetPast")
            : t("agents.quota.resetAt", { time: resets! })}
        </span>
      ) : null}
      {/* Codex reports its share only when it runs: old numbers say how old they are. */}
      {asOf ? (
        <span data-usage-as-of className="truncate text-[11px]/none text-fg-muted">
          {t("agents.usageAsOf", { time: formatTime(asOf) })}
        </span>
      ) : null}
    </span>
  );
}


function QuotaOutlookLine({ p, now }: { p: AgentProfileStatus; now: number }) {
  const t = useT();
  const u = p.usage;
  const resets = u?.resetsLeft ?? null;
  const full = u?.fullSessionsLeft ?? null;
  return <div data-quota-outlook={p.id} data-resets-left={resets ?? undefined} data-full-sessions-left={full ?? undefined} className="w-full text-xs/5 wrap-anywhere" title={t("agents.quota.outlookHint")}>
    <span>{resets === null ? t("agents.quota.outlookUnknown") : t("agents.quota.outlookResets", { count: resets, time: u?.week?.resetsAt ? clock(u.week.resetsAt, now) : "?" })}</span>
    {" · "}<span>{full === null ? t("agents.quota.outlookInsufficient") : t("agents.quota.outlookSessions", { count: Math.round(Math.min(resets ?? full, full) * 10) / 10 })}</span>
    {" · "}<span>{u?.credits ? u.credits.unlimited ? t("agents.quota.outlookUnlimited") : t("agents.quota.outlookCredits", { balance: u.credits.balance ?? "?" }) : t("agents.quota.outlookNoCredits")}</span>
    {full !== null && resets !== null && full < resets ? <span className="block">{t("agents.quota.outlookCeiling")}</span> : null}
    <details className="mt-1"><summary className="min-h-11 cursor-pointer content-center md:min-h-0">{t("agents.quota.outlookHow")}</summary><p>{t("agents.quota.outlookHint")}</p></details>
    {u?.spendControlReached ? <span className="block text-warning">{t("agents.quota.outlookSpend")}</span> : null}
  </div>;
}

function GeminiInfo({ login = false }: { login?: boolean }) {
  const t = useT();
  return <div data-gemini-info className="space-y-2 px-4 pb-3 text-xs/5 text-fg-muted wrap-anywhere">
    {login ? <><p>{t("agents.geminiLogin")}</p><p>{t("agents.geminiAccounts")}</p></> : null}
    <p>{t("agents.geminiStatus")}</p><p>{t("agents.geminiFree")}</p><p>{t("agents.geminiModels")}</p>
    <div className="flex flex-wrap gap-x-4 gap-y-2">{([
      ["geminiAuthSource", "get-started/authentication"], ["geminiQuotaSource", "resources/quota-and-pricing"],
      ["geminiTermsSource", "resources/tos-privacy"], ["geminiModelSource", "cli/model"],
    ] as const).map(([key, slug]) => <a key={key} className="inline-flex min-h-11 items-center underline underline-offset-2 focus-visible:outline-2 md:min-h-0" href={`https://geminicli.com/docs/${slug}/`} target="_blank" rel="noreferrer">{t(`agents.${key}`)}</a>)}</div>
  </div>;
}

function VibeNotice() {
  const t = useT();
  return <div data-vibe-notice className="space-y-2 text-xs/5 text-fg-muted">
    <p>{t("agents.vibeNotice")}</p>
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://mistral.ai/pricing/" target="_blank" rel="noreferrer">{t("agents.vibeSources")}</a>
      <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://docs.mistral.ai/vibe/code/cli/api-keys-profiles" target="_blank" rel="noreferrer">{t("agents.vibeSetupSource")}</a>
      <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://legal.mistral.ai/terms" target="_blank" rel="noreferrer">{t("agents.vibeTermsSource")}</a>
    </div>
  </div>;
}

function OpenCodeNotice() {
  const t = useT();
  return <div className={`${HINT} space-y-1`} data-opencode-notice>
    <p className="m-0">{t("agents.opencodeQuota")}</p>
    <p className="m-0">{t("agents.opencodeFree")} <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://opencode.ai/docs/zen/" target="_blank" rel="noreferrer">OpenCode Zen</a></p>
    <p className="m-0">{t("agents.opencodePolicy")} <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://opencode.ai/docs/permissions/" target="_blank" rel="noreferrer">{t("agents.opencodePermissions")}</a></p>
    <p className="m-0">{t("agents.opencodeAccounts")} <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://opencode.ai/docs/providers/" target="_blank" rel="noreferrer">{t("agents.opencodeProviders")}</a></p>
  </div>;
}

function KiloInfo() {
  const t = useT();
  return <div data-kilo-info className="min-w-0 space-y-2 text-xs/[18px] text-fg-muted wrap-anywhere">
    <p>{t("agents.kiloQuota")}</p>
    <details>
      <summary className="min-h-11 cursor-pointer md:min-h-0">Kilo Code CLI</summary>
      <div className="space-y-2 pt-2">
        <p>{t("agents.kiloFree")}</p><p>{t("agents.kiloData")}</p>
        <p>{t("agents.kiloPermissions")}</p><p>{t("agents.kiloAccounts")}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-2">
          <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://kilo.ai/docs/getting-started/using-kilo-for-free" target="_blank" rel="noreferrer">{t("agents.kiloFreeLink")}</a>
          <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://kilo.ai/docs/gateway/authentication" target="_blank" rel="noreferrer">{t("agents.kiloAuthLink")}</a>
          <a className="inline-flex min-h-11 items-center underline md:min-h-0" href="https://kilo.ai/terms" target="_blank" rel="noreferrer">{t("agents.kiloTermsLink")}</a>
        </div>
      </div>
    </details>
  </div>;
}
