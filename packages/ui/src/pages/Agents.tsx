import { useEffect, useState } from "react";
import { cn } from "cn";
import {
  AGENT_KINDS,
  AGENT_ROLES,
  AGENT_TEMPLATES,
  agentProfileSchema,
  AUTONOMY,
  AUTONOMY_ARGS,
  autonomySource,
  usageStop,
  type AgentKind,
  type AgentProfile,
  type AgentProfileStatus,
  type AgentRole,
  type Autonomy,
  type LoginHow,
  type NewAccount,
  type ProfileCheck,
  type RunnerSettings,
  type SetupItem,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Switch } from "@xdev-hive/ui/components/ui/switch";
import { Textarea } from "@xdev-hive/ui/components/ui/textarea";
import { Badge, Empty, ErrorNote, Notice, StatusDot } from "#ui/components/common.tsx";
import { OpenCli } from "#ui/components/OpenCli.tsx";
import { Chip, type ChipKind } from "#ui/components/panes.tsx";
import { useToast } from "#ui/shell/toast.tsx";
import { errorMessage, formatTime, formatUsd, useAction, useHive, useQuery } from "#ui/hooks.ts";
import { activeIntl, rich, useT } from "#ui/i18n/index.tsx";
import { hasNewer } from "#ui/lib/setup.ts";

/** Env var that points each CLI at a separate login, so two subscriptions of one vendor can rotate. */
const ACCOUNT_ENV_HINT: Partial<Record<AgentKind, string>> = {
  claude: "CLAUDE_CONFIG_DIR=~/.claude-2",
  codex: "CODEX_HOME=~/.codex-2",
};

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
  // Profiles whose sign-in was opened from here: checked every few seconds until signed in (at most 5 minutes).
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const refresh = () => setTick((t) => t + 1);
  const waitFor = (id: string) => setWaiting((w) => ({ ...w, [id]: Date.now() }));
  useEffect(() => {
    const ids = Object.keys(waiting);
    if (!ids.length) return;
    const timer = setInterval(() => {
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
    }, 4000);
    return () => clearInterval(timer);
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

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-6 pt-5 pb-8">
      <h1 className="sr-only">{t("nav.agents")}</h1>
      {settings.data ? <IntakeCard runner={settings.data.runner} hub={settings.data.mode === "hub"} onSaved={settings.reload} /> : null}
      <QuotaTable profiles={profiles.data ?? []} />
      <p className="m-0 text-xs/[18px] text-fg-muted">{t("agents.thresholdsNote")}</p>
      <h2 className="m-0 mt-2 text-[13px]/[18px] font-semibold text-fg-strong">{t("agents.manage")}</h2>
      <p className="m-0 -mt-2 max-w-3xl text-xs/[18px] text-fg-muted">{t("agents.subtitle")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("agents.addAccount")}</span>
        {(["claude", "codex"] as const).map((k) => (
          <Button key={k} size="sm" data-add-account={k} onClick={() => setAdding(k)}>
            + {t(`agents.accountKind.${k}`)}
          </Button>
        ))}
      </div>
      {adding ? (
        <AccountForm
          kind={adding}
          onCancel={() => setAdding(null)}
          onAdded={(id) => {
            setAdding(null);
            waitFor(id);
            refresh();
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("agents.add")}</span>
        {AGENT_KINDS.map((k) => (
          <Button key={k} size="sm" variant="outline" onClick={() => newProfile(k)}>
            + {t(`agentKind.${k}`)}
          </Button>
        ))}
      </div>
      {templates.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("agents.templates")}</span>
          {templates.map((tpl) => {
            const exists = (profiles.data ?? []).some((p) => p.id === tpl.id);
            return (
              <Button
                key={tpl.id}
                size="sm"
                variant="outline"
                disabled={exists}
                title={exists ? t("agents.templateExists") : t("agents.templateHint")}
                onClick={() => setEditing({ profile: { ...tpl, env: {} } })}
              >
                + {tpl.label}
              </Button>
            );
          })}
        </div>
      ) : null}
      {editing ? (
        <ProfileForm
          key={editing.previousId ?? editing.profile.id}
          initial={editing.profile}
          previousId={editing.previousId}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      ) : null}
      <ErrorNote error={profiles.error} />
      {profiles.data?.length === 0 ? <Empty>{t("agents.none")}</Empty> : null}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {profiles.data?.map((p) => (
          <ProfileCard
            key={p.id}
            profile={p}
            waiting={p.id in waiting}
            projects={settings.data?.projects.map((x) => x.name) ?? []}
            cli={cliOf(p)}
            onEdit={() => setEditing({ profile: p, previousId: p.id })}
            onChanged={refresh}
            onLoginOpened={() => waitFor(p.id)}
          />
        ))}
      </div>
      {settings.data ? <RunnerCard runner={settings.data.runner} /> : null}
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
  const ways = kind === "claude" ? (["plan", "sso", "console"] as const) : (["browser", "device"] as const);
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
          <Input id="acc-label" value={label} placeholder={t("agents.accountLabelHint")} onChange={(e) => setLabel(e.target.value)} />
          <Label htmlFor="acc-way">{t("agents.loginWay")}</Label>
          <NativeSelect id="acc-way" value={way} onChange={(e) => setWay(e.target.value)} wrapperClassName="w-full">
            {ways.map((w) => (
              <NativeSelectOption key={w} value={w}>
                {t(`agents.way.${w}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {kind === "claude" ? (
            <>
              <Label htmlFor="acc-email">{t("agents.loginEmail")}</Label>
              <Input id="acc-email" type="email" value={email} placeholder="ten@congty.vn" onChange={(e) => setEmail(e.target.value)} />
            </>
          ) : null}
          <span className={HINT}>{t(`agents.wayHint.${way}` as never)}</span>
          <div className="flex gap-2 sm:col-start-2">
            <Button type="submit" size="sm" disabled={action.busy}>
              {t("agents.addAndSignIn")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
        <ErrorNote error={action.error} />
        <p className="m-0 text-xs/[18px] text-fg-muted">{t("agents.accountNote")}</p>
      </CardContent>
    </Card>
  );
}

function ProfileCard({
  profile: p,
  waiting,
  projects,
  cli,
  onEdit,
  onChanged,
  onLoginOpened,
}: {
  profile: AgentProfileStatus;
  waiting: boolean;
  /** This machine's projects, where its CLI can be opened. */
  projects: string[];
  /** The CLI's setup check, when the profile runs the one on PATH: its version and an upgrade (roadmap 33). */
  cli: SetupItem | null;
  onEdit: () => void;
  onChanged: () => void;
  onLoginOpened: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const action = useAction();
  const [check, setCheck] = useState<ProfileCheck | null>(null);
  const [loginOpened, setLoginOpened] = useState(false);
  const [token, setToken] = useState("");
  const resting = p.cooldownUntil !== null;
  const { cooldownUntil: _c, cooldownReason: _r, cooldownFrom: _f, cliPath: _p, running: _n, lastUsedAt: _l, stats: _s, ...plain } = p;
  const noCli = p.enabled && p.cliPath === null;
  const signedOut = p.enabled && !noCli && p.login?.loggedIn === false;
  const stop = p.enabled && !noCli && !signedOut ? usageStop(p, p.usage) : null;
  const pct = (limit: { percent: number } | null | undefined) => (limit ? `${limit.percent}%` : "?");
  const usageHigh = [p.usage?.session, p.usage?.week].some((l) => l && l.percent >= 80);

  return (
    <Card className={cn("min-w-0 gap-3 py-4", p.enabled ? "" : "opacity-65")}>
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-center gap-2">
          <StatusDot tone={!p.enabled ? "neutral" : noCli || signedOut ? "danger" : resting || stop ? "warn" : p.running ? "info" : "ok"} />
          <b className="min-w-0 flex-1 truncate font-semibold">{p.label}</b>
          {p.readOnly ? <Badge tone="neutral">{t("agents.readOnlyBadge")}</Badge> : null}
          {p.container ? (
            <span title={p.container.image}>
              <Badge tone="info">{p.container.network === "open" ? t("agents.containerBadge") : t("agents.containerLimitedBadge")}</Badge>
            </span>
          ) : null}
          <Badge tone="accent">{t(`agentKind.${p.kind}`)}</Badge>
        </div>
        <div className="font-mono text-xs wrap-anywhere text-muted-foreground">
          {p.id} · {t("agents.priorityN", { n: p.priority })} · {t("agents.parallelN", { n: p.maxConcurrent })}
          {p.account ? ` · ${t("agents.accountN", { account: p.account })}` : ""}
        </div>
        <div className="text-sm">
          {!p.enabled ? (
            <span className="text-muted-foreground">{t("agents.off")}</span>
          ) : noCli ? (
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
          ) : stop ? (
            <span className="text-warning">
              {t(stop === "session" ? "agents.overLimitSession" : "agents.overLimitWeek", {
                percent: (stop === "session" ? p.usage?.session : p.usage?.week)?.percent ?? "?",
                stop: stop === "session" ? p.stopAtSession : p.stopAtWeek,
                resets: (stop === "session" ? p.usage?.session : p.usage?.week)?.resets ?? "?",
              })}
            </span>
          ) : signedOut ? (
            <span className="text-destructive">{rich(t("agents.signedOut"), { cmd: <code className={CODE}>{p.login?.loginCommand ?? p.bin}</code> })}</span>
          ) : resting ? (
            <span className="text-warning">
              {t("agents.restingUntil", { time: formatTime(p.cooldownUntil) })}
              {p.cooldownFrom ? ` · ${t("agents.reportedBy", { who: p.cooldownFrom })}` : ""}
              {p.cooldownReason ? ` · ${p.cooldownReason}` : ""}
            </span>
          ) : p.running ? (
            <span className="text-info">{t("agents.runningN", { count: p.running })}</span>
          ) : (
            <span className="text-success">{t("agents.ready")}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>{t("agents.statRuns", { count: p.stats.runs })}</span>
          <span>· {t("agents.statDone", { count: p.stats.succeeded })}</span>
          <span>· {t("agents.statQuota", { count: p.stats.rateLimited })}</span>
          <span>· {t("agents.statFailed", { count: p.stats.failed })}</span>
          {p.stats.costUsd > 0 ? <span>· {t("agents.statCost", { cost: formatUsd(p.stats.costUsd) })}</span> : null}
          {p.lastUsedAt ? <span>· {t("agents.lastUsed", { time: formatTime(p.lastUsedAt) })}</span> : null}
          {p.login?.loggedIn ? (
            <span>
              · {p.login.method ? t("agents.signedIn", { method: p.login.method }) : t("agents.signedInPlain")}
              {p.login.account ? ` · ${p.login.account}` : ""}
            </span>
          ) : null}
          {p.usage ? (
            <span className={usageHigh ? "text-warning" : undefined} title={p.usage.week?.resets ?? undefined}>
              · {t("agents.usage", { session: pct(p.usage.session), week: pct(p.usage.week) })}
            </span>
          ) : null}
        </div>
        {cli?.version ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-cli-version={cli.id}>
            <span className="font-mono">{t("agents.cliVersion", { cli: cli.label, version: cli.version })}</span>
            {hasNewer(cli) ? <Badge tone="warn">{t("setup.newVersion", { version: cli.latest! })}</Badge> : null}
            {hasNewer(cli) && cli.action ? (
              <Button
                size="sm"
                variant="outline"
                disabled={action.busy}
                data-cli-upgrade={cli.id}
                onClick={() => void action.run(async () => (await desktop.installSetup(cli.id), onChanged()))}
              >
                {action.busy ? t("setup.installing") : cli.action}
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {p.roles.map((r) => (
            <Badge key={r}>{t(`agentRole.${r}`)}</Badge>
          ))}
        </div>
        <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs whitespace-nowrap">
          {Object.entries(p.env)
            .map(([k, v]) => `${k}=${v} `)
            .join("")}
          {p.bin} {p.args.join(" ")}
        </code>
        <AutonomyNote profile={p} />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={action.busy}
            onClick={() => void action.run(async () => (await desktop.saveProfile({ ...plain, enabled: !p.enabled }, p.id), onChanged()))}
          >
            {p.enabled ? t("agents.disable") : t("agents.enable")}
          </Button>
          {signedOut && p.login?.loginCommand ? (
            <Button size="sm" disabled={action.busy} onClick={() => void action.run(async () => (await desktop.openLogin(p.id), setLoginOpened(true), onLoginOpened()))}>
              {t("agents.login")}
            </Button>
          ) : null}
          {signedOut && p.login?.loginCommand && p.kind === "claude" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              onClick={() => void action.run(async () => (await desktop.openLogin(p.id, { sso: true }), setLoginOpened(true), onLoginOpened()))}
            >
              {t("agents.loginSso")}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={action.busy} onClick={() => void action.run(async () => setCheck(await desktop.checkProfile(p.id)))}>
            {t("agents.checkCli")}
          </Button>
          {resting ? (
            <Button
              size="sm"
              variant="outline"
              disabled={action.busy}
              onClick={() => void action.run(async () => (await desktop.resetCooldown(p.id), onChanged()))}
            >
              {t("machines.clear")}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t("agents.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={action.busy}
            onClick={() => {
              if (window.confirm(t("agents.confirmRemove", { id: p.id }))) void action.run(async () => (await desktop.removeProfile(p.id), onChanged()));
            }}
          >
            {t("agents.remove")}
          </Button>
        </div>
        <OpenCli profiles={[p]} projects={projects} />
        {(loginOpened || waiting) && signedOut ? <Notice tone="info">{t(waiting ? "agents.loginWaiting" : "agents.loginOpened")}</Notice> : null}
        {p.kind === "claude" && p.container ? (
          <form
            className="flex flex-col gap-2 rounded-md border p-3"
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
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
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
  onDone,
  onCancel,
}: {
  initial: AgentProfile;
  previousId?: string;
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
            <NativeSelect id="pf-kind" value={p.kind} onChange={(e) => set("kind", e.target.value as AgentKind)}>
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
            <Label htmlFor="pf-env" className="leading-snug sm:self-start sm:pt-2.5">
              {t("agents.env")}
            </Label>
            <Textarea
              id="pf-env"
              className="font-mono"
              placeholder={ACCOUNT_ENV_HINT[p.kind] ?? "KEY=value"}
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
            />
            <span className={HINT}>
              {ACCOUNT_ENV_HINT[p.kind]
                ? rich(t("agents.envHintExample"), { example: <code className={CODE}>{ACCOUNT_ENV_HINT[p.kind]}</code> })
                : t("agents.envHint")}
            </span>
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
              {AGENT_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={p.roles.includes(r)}
                    onCheckedChange={(v) => set("roles", v === true ? [...p.roles, r] : p.roles.filter((x: AgentRole) => x !== r))}
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
            <span className={HINT}>{t("agents.stopHint")}</span>
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
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={p.container !== null}
                onCheckedChange={(v) =>
                  set("container", v === true ? (p.container ?? { image: "xdev-hive-agent", network: "restricted", allow: [] }) : null)
                }
              />
              {t("agents.container")}
            </label>
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
            <Button type="submit" disabled={action.busy}>
              {t("agents.save")}
            </Button>
            <Button variant="ghost" type="button" onClick={onCancel}>
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
      <ErrorNote error={action.error} />
    </div>
  );
}

/** The state a subscription is in, as one chip. */
function stateChip(p: AgentProfileStatus): { key: "running" | "ready" | "off" | "noCli" | "signedOut" | "overLimit" | "resting" | "near"; kind: ChipKind } {
  if (!p.enabled) return { key: "off", kind: "neutral" };
  if (p.cliPath === null) return { key: "noCli", kind: "danger" };
  if (p.login?.loggedIn === false) return { key: "signedOut", kind: "danger" };
  if (p.running) return { key: "running", kind: "running" };
  if (usageStop(p, p.usage)) return { key: "overLimit", kind: "warning" };
  if (p.cooldownUntil) return { key: "resting", kind: "warning" };
  const top = Math.max(p.usage?.session?.percent ?? 0, p.usage?.week?.percent ?? 0);
  if (top >= 85) return { key: "near", kind: "warning" };
  return { key: "ready", kind: "success" };
}

function Meter({ percent, resets, stop }: { percent: number; resets: string | null; stop: number }) {
  const t = useT();
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <span className="flex flex-col gap-[5px]">
      <span className="flex text-[11px]/none text-fg-muted">
        <span className="font-mono text-xs/none font-semibold text-fg-strong">{pct}%</span>
        {/* Claude Code prints the reset as text ("Oct 3, 9am"), not a timestamp: shown as it came. */}
        {resets ? (
          <span className="ml-auto truncate pl-2" title={resets}>
            {t("agents.resets", { time: Number.isNaN(Date.parse(resets)) ? resets : formatTime(resets) })}
          </span>
        ) : null}
      </span>
      <span role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="relative h-1.5 rounded-[3px] bg-sunken">
        <span className={cn("absolute inset-y-0 left-0 rounded-[3px]", pct >= 85 ? "bg-warning-solid" : "bg-primary")} style={{ width: `${pct}%` }} />
        <span title={t("agents.stopMark", { percent: stop })} className="absolute -top-[3px] -bottom-[3px] w-0.5 bg-fg-muted" style={{ left: `${Math.min(100, stop)}%` }} />
      </span>
    </span>
  );
}

const QUOTA_COLS = "grid-cols-[minmax(150px,1.2fr)_150px_minmax(150px,1fr)_minmax(150px,1fr)_110px]";

/** Every subscription on this machine with its session and week use, the stop thresholds and its cost. */
function QuotaTable({ profiles }: { profiles: AgentProfileStatus[] }) {
  const t = useT();
  if (!profiles.length) return null;
  return (
    <div className="overflow-x-auto rounded-[10px] border border-line-default bg-surface">
      <div className="min-w-[760px]">
        <div className={cn("grid h-[34px] items-center gap-3.5 border-b border-line-subtle bg-subtle px-4 text-[11px]/none font-semibold text-fg-muted", QUOTA_COLS)}>
          <span>{t("agents.colProfile")}</span>
          <span>{t("agents.colState")}</span>
          <span>{t("agents.colSession")}</span>
          <span>{t("agents.colWeek")}</span>
          <span title={t("agents.costHint")}>{t("agents.colCost")}</span>
        </div>
        {profiles.map((p) => {
          const st = stateChip(p);
          const s = p.usage?.session;
          const w = p.usage?.week;
          return (
            <div key={p.id} className={cn("grid items-center gap-3.5 border-b border-line-subtle px-4 py-3 last:border-b-0", QUOTA_COLS)}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-mono text-[13px]/[18px] font-semibold text-fg-strong">{p.id}</span>
                <span className="truncate text-xs/4 text-fg-muted">
                  {t(`agentKind.${p.kind}`)} · {p.roles.map((r) => t(`agentRole.${r}`)).join(", ")}
                </span>
              </span>
              <span title={p.cooldownReason ?? undefined}>
                <Chip kind={st.kind} title={p.cooldownUntil ? formatTime(p.cooldownUntil) : undefined}>
                  {st.key === "resting" && p.cooldownUntil
                    ? `${t("agents.state.resting")} · ${new Date(p.cooldownUntil).toLocaleTimeString(activeIntl(), { hour: "2-digit", minute: "2-digit" })}`
                    : t(`agents.state.${st.key}`)}
                </Chip>
              </span>
              {s || w ? (
                <>
                  {s ? <Meter percent={s.percent} resets={s.resets} stop={p.stopAtSession} /> : <span className="text-xs text-fg-muted">—</span>}
                  {w ? <Meter percent={w.percent} resets={w.resets} stop={p.stopAtWeek} /> : <span className="text-xs text-fg-muted">—</span>}
                </>
              ) : (
                <span className="col-span-2 text-xs/[17px] text-fg-muted">{t("agents.noUsage")}</span>
              )}
              <span className="font-mono text-xs/none text-fg-secondary" title={t("agents.costHint")}>
                {p.stats.costUsd ? `~${formatUsd(p.stats.costUsd)}` : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
