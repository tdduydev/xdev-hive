import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  PROJECT_NAME,
  TRANSFER_RESULTS,
  suggestProjectKey,
  type DesktopProject,
  type DesktopSettings,
  type FileAction,
  type GitLabCheck,
  type GitLabImportCandidate,
  type GitLabImportResult,
  type MrSettings,
  type RepoCandidate,
  type RepoImportResult,
  type RepoScan,
  type SyncReport,
  type TransferReport,
  type TransferResult,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@xdev-hive/ui/components/ui/collapsible";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader, StatusDot } from "#ui/components/common.tsx";
import { OpenCli } from "#ui/components/OpenCli.tsx";
import { formatTime, useAction, useHive, usePoll, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";
import { hostOf } from "#ui/shell/connection.tsx";

const ACTION_TONE: Record<FileAction["action"], string> = {
  created: "ok",
  updated: "info",
  unchanged: "neutral",
  skipped: "warn",
  removed: "neutral",
};

/** Inline code (paths, keys) inside explanatory text. */
const CODE = "rounded bg-muted px-1 py-0.5 font-mono text-xs break-all";
/** Label/field grid; collapses to one column on narrow screens. */
const FORM_GRID = "grid items-center gap-3 sm:grid-cols-[180px_1fr]";
const LINK = "font-medium text-primary underline underline-offset-2";

export function ProjectsPage() {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const settings = useQuery(() => desktop.settings(), [desktop]);

  return (
    <Page>
      <PageHeader
        title={t("nav.projects")}
        subtitle={t("projects.subtitle")}
      />
      <ErrorNote error={settings.error} />
      {settings.data ? (
        <>
          <ConnectionCard settings={settings.data} onSaved={settings.reload} />
          <AdvancedCard settings={settings.data} onSaved={settings.reload} />
          <GitLabCard settings={settings.data} onSaved={settings.reload} />
          <GitHubCard settings={settings.data} onSaved={settings.reload} />
        </>
      ) : null}
    </Page>
  );
}

/** A card whose body folds away: closed, its heading still says what state it is in. */
function FoldCard({ name, title, badge, children }: { name: string; title: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <Collapsible className="flex flex-col gap-3">
        <CardHeader>
          <CollapsibleTrigger
            data-fold={name}
            className="group flex w-full items-center gap-2 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
            {/* The card's title, as a span: a button may hold text, not the div CardTitle renders. */}
            <span className="min-w-0 flex-1 type-heading-sm text-fg-strong">{title}</span>
            {badge}
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-4">{children}</CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** Whether a forge (GitLab, GitHub) has a URL and a token, so the closed card still says what is left to do. */
function SetUpBadge({ on }: { on: boolean }) {
  const t = useT();
  return <Badge tone={on ? "ok" : "warn"}>{on ? t("projects.configured") : t("projects.notConfigured")}</Badge>;
}

/** The same fold inside a card, for the ways to sign in that most people do not need. */
function Disclosure({ name, label, children }: { name: string; label: string; children: ReactNode }) {
  return (
    <Collapsible className="flex flex-col gap-3">
      <CollapsibleTrigger
        data-fold={name}
        className="group flex w-fit items-center gap-1 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
        {label}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/** Is the hub answering? What the last heartbeat found (roadmap 22h); Thử lại sends one now. */
function HubLink() {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const tick = usePoll(5000);
  const status = useQuery(() => desktop.hubStatus(), [desktop, tick]);
  const retry = useAction();
  const link = status.data ?? null;
  const ok = link?.ok ?? null;
  const unreachable = link?.code === "unavailable";
  const tone = ok === null ? "neutral" : ok ? "ok" : unreachable ? "warn" : "danger";
  const label = ok === null ? t("projects.linkUnknown") : ok ? t("projects.linkOk") : unreachable ? t("projects.linkOffline") : t("projects.linkRefused");

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-hub-status={ok === null ? "unknown" : ok ? "ok" : "down"}>
      <StatusDot tone={tone} />
      <span className="text-sm">{label}</span>
      {link?.checkedAt ? <span className="text-xs text-muted-foreground">{t("projects.linkCheckedAt", { time: formatTime(link.checkedAt) })}</span> : null}
      {ok === false && link?.lastOkAt ? <span className="text-xs text-muted-foreground">· {t("projects.linkLastOk", { time: formatTime(link.lastOkAt) })}</span> : null}
      {ok === true ? null : (
        <Button
          size="sm"
          variant="ghost"
          disabled={retry.busy}
          onClick={() =>
            void retry.run(async () => {
              await desktop.hubRetry();
              status.reload();
            })
          }
        >
          {retry.busy ? t("shell.retrying") : t("shell.retry")}
        </Button>
      )}
      {ok === false && link?.error ? <p className="w-full text-xs break-words text-muted-foreground">{link.error}</p> : null}
    </div>
  );
}

/**
 * Connected: one line (hub, account, machine) with the link's state, and nothing to fill in. The sign-in form is
 * only for a machine that is not connected, or for someone who asked to change the connection.
 */
export function ConnectionCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client, me, bump } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  // Ngắt kết nối only puts the machine back in local mode (the token stays in config.json), so the mode decides
  // whether this machine is connected, not hasHubToken.
  const connected = settings.mode === "hub" && settings.hasHubToken;
  const [changing, setChanging] = useState(false);
  const action = useAction();
  const hub = hostOf(settings.hubUrl);

  if (!connected || changing) {
    return (
      <SignInCard
        settings={settings}
        changing={changing}
        onDone={() => {
          setChanging(false);
          onSaved();
          bump();
        }}
        onCancel={() => setChanging(false)}
      />
    );
  }
  return (
    <Card data-hub-link="connected">
      <CardHeader>
        <CardTitle>{t("projects.connection")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm break-words">
          {rich(t("projects.connectedTo"), {
            hub: <b className="text-foreground">{hub}</b>,
            account: <b className="text-foreground">{me.user ? `@${me.user.username}` : me.name}</b>,
            machine: <b className="text-foreground">{settings.machine}</b>,
          })}
        </p>
        <HubLink />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" data-hub-change onClick={() => setChanging(true)}>
            {t("projects.change")}
          </Button>
          <Button
            variant="ghost"
            disabled={action.busy}
            onClick={() => {
              if (!window.confirm(t("projects.confirmDisconnect", { hub }))) return;
              void action.run(async () => {
                await desktop.updateSettings({ mode: "local" });
                onSaved();
                bump();
              });
            }}
          >
            {t("projects.disconnect")}
          </Button>
        </div>
        <ErrorNote error={action.error} />
      </CardContent>
    </Card>
  );
}

export function SignInCard({
  settings,
  changing,
  onDone,
  onCancel,
  guide = false,
}: {
  guide?: boolean;
  settings: DesktopSettings;
  changing: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { client } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [hubUrl, setHubUrl] = useState(settings.hubUrl);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hubToken, setHubToken] = useState("");
  const browser = useAction();
  const signIn = useAction();
  const paste = useAction();
  const alone = useAction();
  const url = hubUrl.trim();
  const busy = browser.busy || signIn.busy || paste.busy || alone.busy;

  return (
    <Card data-hub-link={changing ? "changing" : "none"}>
      <CardHeader>
        <CardTitle>{t("projects.connection")}</CardTitle>
        <CardDescription className="break-words">
          {guide ? t("start.connectHint") : settings.mode === "local" && !changing
            ? rich(t("projects.localHint"), { path: <code className={CODE}>{settings.dbPath}</code> })
            : t("projects.connectHint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!guide ? <div className={FORM_GRID}>
          <Label htmlFor="hub-url">{t("projects.hubUrl")}</Label>
          <Input id="hub-url" className="font-mono" placeholder="https://hive.example.com" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
        </div> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-connect-browser
            disabled={!url || busy}
            onClick={() =>
              void browser.run(async () => {
                await desktop.hubSignInBrowser({ hubUrl: url });
                onDone();
              })
            }
          >
            {t("projects.signInBrowser")}
          </Button>
          {browser.busy ? (
            <>
              <span className="text-sm text-muted-foreground">{t("projects.signInBrowserWaiting")}</span>
              <Button size="sm" variant="ghost" onClick={() => void desktop.hubSignInCancel()}>
                {t("common.cancel")}
              </Button>
            </>
          ) : null}
          {/* While the browser sign-in waits it has its own Huỷ; two buttons of that name side by side say nothing. */}
          {changing && !browser.busy ? (
            <Button variant="ghost" onClick={onCancel}>
              {t("common.cancel")}
            </Button>
          ) : null}
        </div>
        <p className="text-xs break-words text-muted-foreground">{t("projects.signInBrowserHint")}</p>
        <ErrorNote error={browser.error} />
        <Disclosure name="other-sign-in" label={t(guide ? "projects.advanced" : "projects.otherWays")}>
          {guide ? <div className={FORM_GRID}>
            <Label htmlFor="hub-url">{t("projects.hubUrl")}</Label>
            <Input id="hub-url" className="font-mono" placeholder="https://hive.example.com" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
          </div> : null}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn.run(async () => {
                await desktop.hubSignIn({ hubUrl: url, username: username.trim(), password });
                setPassword("");
                onDone();
              });
            }}
          >
            <span className="text-sm font-medium">{t("projects.withPassword")}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="min-w-36 flex-1"
                placeholder={t("login.username")}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-label={t("projects.hubUsername")}
              />
              <Input
                className="min-w-36 flex-1"
                type="password"
                placeholder={t("login.password")}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-label={t("projects.hubPassword")}
              />
              <Button type="submit" variant="outline" disabled={!url || !username.trim() || !password || busy}>
                {signIn.busy ? t("login.submitting") : t("projects.signInConnect")}
              </Button>
            </div>
            <p className="text-xs break-words text-muted-foreground">
              {rich(t("projects.signInHint"), { machine: <code className={CODE}>{settings.machine}</code> })}
            </p>
            <ErrorNote error={signIn.error} />
          </form>
          <form
            className="flex flex-col gap-2 border-t border-dashed pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              void paste.run(async () => {
                await desktop.updateSettings({ mode: "hub", hubUrl: url, hubToken: hubToken.trim() });
                setHubToken("");
                onDone();
              });
            }}
          >
            <span className="text-sm font-medium">{t("projects.withToken")}</span>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="hub-token"
                className="min-w-48 flex-1 font-mono"
                type="password"
                autoComplete="off"
                placeholder="hive_…"
                value={hubToken}
                onChange={(e) => setHubToken(e.target.value)}
                aria-label={t("projects.hubToken")}
              />
              <Button type="submit" variant="outline" disabled={!url || !hubToken.trim() || busy}>
                {t("projects.connectWithToken")}
              </Button>
            </div>
            <ErrorNote error={paste.error} />
          </form>
        </Disclosure>
        {(guide || settings.mode === "hub") && !changing ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="ghost"
              className="w-fit"
              disabled={busy}
              onClick={() =>
                void alone.run(async () => {
                  await desktop.updateSettings({ mode: "local" });
                  onDone();
                })
              }
            >
              {t("projects.useAlone")}
            </Button>
            <ErrorNote error={alone.error} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Rarely touched: this machine's name and config file, the two switches, and the one-off copy to or from the hub. */
function AdvancedCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const t = useT();
  return (
    <FoldCard name="advanced" title={t("projects.advanced")}>
      <MachineSettings settings={settings} onSaved={onSaved} />
      <TransferSection settings={settings} />
    </FoldCard>
  );
}

function MachineSettings({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [approval, setApproval] = useState(settings.memoryRequiresApproval);
  const [autoCommit, setAutoCommit] = useState(settings.autoCommit);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [approval, autoCommit]);

  return (
    <div className="flex flex-col gap-4">
      <div className={FORM_GRID}>
        <span className="text-sm leading-none font-medium">{t("projects.machineName")}</span>
        <p className="text-sm break-words text-muted-foreground">
          {rich(t("projects.machineHint"), {
            machine: <code className={CODE}>{settings.machine}</code>,
            lease: <code className={CODE}>&lt;{t("projects.profile")}&gt;.{settings.machine}</code>,
            field: <code className={CODE}>machine</code>,
            file: <code className={CODE}>{settings.configPath}</code>,
          })}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={approval} onCheckedChange={(v) => setApproval(v === true)} disabled={settings.mode === "hub"} />
        {t("projects.approval")} {settings.mode === "hub" ? t("projects.approvalHub") : ""}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={autoCommit} onCheckedChange={(v) => setAutoCommit(v === true)} />
        {t("projects.autoCommit")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await client.desktop!.updateSettings({ memoryRequiresApproval: approval, autoCommit });
              setSaved(true);
              onSaved();
            })
          }
        >
          {t("projects.saveSettings")}
        </Button>
      </div>
      <ErrorNote error={action.error} />
      {saved ? <Notice tone="ok">{t("projects.savedNotice")}</Notice> : null}
    </div>
  );
}

const RESULT_TONE: Record<TransferResult, string> = { added: "ok", updated: "info", proposed: "warn", unchanged: "neutral", skipped: "neutral", failed: "danger" };
const KIND = { doc: "nav.docs", memory: "nav.memory", task: "nav.tasks" } as const;

/** A one-off copy between this machine's database and the hub; inside Nâng cao, since most machines never need it. */
function TransferSection({ settings }: { settings: DesktopSettings }) {
  const { client, bump } = useHive();
  const t = useT();
  const action = useAction();
  const [report, setReport] = useState<TransferReport | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ready = Boolean(settings.hubUrl && settings.hasHubToken);
  const run = (direction: "push" | "pull", question: string) => {
    if (!window.confirm(question)) return;
    void action.run(async () => {
      setReport(await client.desktop!.transferHub(direction));
      setShowAll(false);
      bump();
    });
  };
  const rows = report ? report.items.filter((i) => showAll || i.result !== "unchanged") : [];

  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t("projects.transfer")}</span>
        <p className="text-sm break-words text-muted-foreground">
          {rich(t("projects.transferHint"), {
            hub: <b>{t("projects.modeHub")}</b>,
            once: <b>{t("projects.once")}</b>,
            path: <code className={CODE}>{settings.dbPath}</code>,
          })}
        </p>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{rich(t("projects.pushRule"), { push: <b>{t("projects.pushShort")}</b> })}</li>
        <li>{rich(t("projects.pullRule"), { pull: <b>{t("projects.pullShort")}</b> })}</li>
        <li>{t("projects.notTransferred")}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-transfer="push"
          disabled={!ready || action.busy}
          onClick={() => run("push", t("projects.confirmPush", { hub: settings.hubUrl }))}
        >
          {t("projects.push")}
        </Button>
        <Button
          variant="outline"
          disabled={!ready || action.busy}
          onClick={() => run("pull", t("projects.confirmPull", { hub: settings.hubUrl }))}
        >
          {t("projects.pull")}
        </Button>
        {action.busy ? <span className="text-sm text-muted-foreground">{t("projects.transferring")}</span> : null}
      </div>
      {!ready ? <p className="text-sm text-muted-foreground">{t("projects.transferNotReady")}</p> : null}
      <ErrorNote error={action.error} />
      {report ? (
        <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium break-all">
              {report.from} → {report.to}
            </span>
            {TRANSFER_RESULTS.filter((r) => report.counts[r] > 0).map((r) => (
              <Badge key={r} tone={RESULT_TONE[r]}>
                {report.counts[r]} {t(`transferResult.${r}`)}
              </Badge>
            ))}
            <div className="ml-auto flex flex-wrap items-center gap-1">
              {report.counts.unchanged > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
                  {showAll ? t("projects.hideUnchanged") : t("projects.showUnchanged")}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
                {t("common.close")}
              </Button>
            </div>
          </div>
          {rows.length ? (
            <ul className="flex flex-col gap-1">
              {rows.map((i) => (
                <li key={`${i.kind}:${i.key}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={RESULT_TONE[i.result]}>{t(`transferResult.${i.result}`)}</Badge>
                  <span className="text-xs">{t(KIND[i.kind])}</span>
                  <span className="min-w-0 font-mono text-xs break-all">{i.key}</span>
                  {i.note ? <span className="min-w-0 text-xs break-words text-muted-foreground">· {i.note}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t("projects.nothingNew")}</p>
          )}
          {report.counts.proposed > 0 ? (
            <p className="text-xs text-muted-foreground">
              {rich(t(report.to === "hub" ? "projects.proposedOnHub" : "projects.proposedHere"), {
                link: (
                  <a href="#/proposals" className={LINK}>
                    {t("nav.proposals")}
                  </a>
                ),
              })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function GitLabCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const g = settings.gitlab;
  const [url, setUrl] = useState(g.url);
  const [token, setToken] = useState("");
  const [mr, setMr] = useState<MrSettings>(g.mr);
  const [labels, setLabels] = useState(g.mr.labels.join(", "));
  const [check, setCheck] = useState<GitLabCheck | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const set = <K extends keyof MrSettings>(k: K, v: MrSettings[K]) => {
    setSaved(false);
    setMr({ ...mr, [k]: v });
  };

  const save = () =>
    action.run(async () => {
      await client.desktop!.updateSettings({
        gitlab: { url, token, mr: { ...mr, labels: labels.split(",").map((l) => l.trim()).filter(Boolean) } },
      });
      setToken("");
      setSaved(true);
      onSaved();
    });

  return (
    <FoldCard name="gitlab" title="GitLab merge request" badge={<SetUpBadge on={Boolean(g.url && g.hasToken)} />}>
        <CardDescription className="break-words">
          {rich(t("projects.gitlabHint"), {
            branch: <code className={CODE}>ai/&lt;task&gt;</code>,
            merge: <code className={CODE}>/merge</code>,
          })}
        </CardDescription>
        <div className={FORM_GRID}>
          <Label htmlFor="gl-url">{t("projects.gitlabUrl")}</Label>
          <Input id="gl-url" className="font-mono" placeholder="https://gitlab.example.com" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
          <Label htmlFor="gl-token">Access token</Label>
          <Input
            id="gl-token"
            className="font-mono"
            type="password"
            autoComplete="off"
            placeholder={g.hasToken ? t("projects.savedKeep") : "glpat-… (scope api, write_repository)"}
            value={token}
            onChange={(e) => (setSaved(false), setToken(e.target.value))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.enabled} onCheckedChange={(v) => set("enabled", v === true)} />
          {t("projects.autoMr")}
        </label>
        <div className={FORM_GRID}>
          <Label htmlFor="gl-when">{t("projects.mrWhen")}</Label>
          <NativeSelect id="gl-when" value={mr.when} onChange={(e) => set("when", e.target.value as MrSettings["when"])}>
            <NativeSelectOption value="after_review">{t("projects.mrAfterReview")}</NativeSelectOption>
            <NativeSelectOption value="after_success">{t("projects.mrAfterSuccess")}</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor="gl-changes">{t("projects.mrChanges")}</Label>
          <NativeSelect
            id="gl-changes"
            value={mr.onChangesRequested}
            onChange={(e) => set("onChangesRequested", e.target.value as MrSettings["onChangesRequested"])}
          >
            <NativeSelectOption value="draft">{t("projects.mrDraft")}</NativeSelectOption>
            <NativeSelectOption value="skip">{t("projects.mrSkip")}</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor="gl-labels">Label</Label>
          <Input id="gl-labels" value={labels} onChange={(e) => (setSaved(false), setLabels(e.target.value))} />
          <Label htmlFor="gl-remote">Remote</Label>
          <Input id="gl-remote" className="font-mono" value={mr.remote} onChange={(e) => set("remote", e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.removeSourceBranch} onCheckedChange={(v) => set("removeSourceBranch", v === true)} />
          {t("projects.removeBranch")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.doneOnMerge} onCheckedChange={(v) => set("doneOnMerge", v === true)} />
          {t("projects.doneOnMerge")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.cleanupOnMerge} onCheckedChange={(v) => set("cleanupOnMerge", v === true)} />
          {t("projects.cleanupOnMerge")}
        </label>
        <div className={FORM_GRID}>
          <Label htmlFor="gl-closed">{t("projects.mrOnClosed")}</Label>
          <NativeSelect id="gl-closed" value={mr.onClosed} onChange={(e) => set("onClosed", e.target.value as MrSettings["onClosed"])}>
            <NativeSelectOption value="blocked">{t("projects.mrOnClosedBlocked")}</NativeSelectOption>
            <NativeSelectOption value="todo">{t("projects.mrOnClosedTodo")}</NativeSelectOption>
            <NativeSelectOption value="keep">{t("projects.mrOnClosedKeep")}</NativeSelectOption>
          </NativeSelect>
          <Label htmlFor="gl-poll">{t("projects.mrPollMinutes")}</Label>
          <Input
            id="gl-poll"
            className="sm:max-w-40"
            type="number"
            min={1}
            max={60}
            value={mr.pollMinutes}
            // Kept within 1–60 here: the schema rejects anything else and the whole save would fail.
            onChange={(e) => e.target.value !== "" && set("pollMinutes", Math.min(60, Math.max(1, Math.round(Number(e.target.value)) || 1)))}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={mr.fixCi} onCheckedChange={(v) => set("fixCi", v === true)} />
          {t("projects.fixCi")}
        </label>
        {mr.fixCi ? (
          <div className={FORM_GRID}>
            <Label htmlFor="gl-fixes">{t("projects.maxCiFixes")}</Label>
            <NativeSelect id="gl-fixes" value={String(mr.maxCiFixes)} onChange={(e) => set("maxCiFixes", Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <NativeSelectOption key={n} value={String(n)}>
                  {n}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void save()} disabled={action.busy}>
            {t("projects.save")}
          </Button>
          <Button
            variant="outline"
            disabled={action.busy || (!g.hasToken && !token)}
            onClick={() => void action.run(async () => setCheck(await client.desktop!.checkGitLab()))}
          >
            {t("projects.checkConnection")}
          </Button>
          {saved ? <span className="text-sm text-success">{t("agents.saved")}</span> : null}
        </div>
        {check ? (
          <Notice tone={check.ok ? "ok" : "error"} className="whitespace-pre-wrap">
            {check.message}
          </Notice>
        ) : null}
        <ErrorNote error={action.error} />
    </FoldCard>
  );
}

function GitHubCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const g = settings.github;
  const [url, setUrl] = useState(g.url);
  const [token, setToken] = useState("");
  const [check, setCheck] = useState<GitLabCheck | null>(null);
  const [saved, setSaved] = useState(false);
  const action = useAction();

  return (
    <FoldCard name="github" title="GitHub pull request" badge={<SetUpBadge on={g.hasToken} />}>
        <CardDescription className="break-words">{t("projects.githubHint")}</CardDescription>
        <div className={FORM_GRID}>
          <Label htmlFor="gh-url">{t("projects.githubUrl")}</Label>
          <Input id="gh-url" className="font-mono" placeholder="https://github.com" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
          <Label htmlFor="gh-token">Access token</Label>
          <Input
            id="gh-token"
            className="font-mono"
            type="password"
            autoComplete="off"
            placeholder={g.hasToken ? t("projects.savedKeep") : "github_pat_… (fine-grained)"}
            value={token}
            onChange={(e) => (setSaved(false), setToken(e.target.value))}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() =>
              void action.run(async () => {
                await client.desktop!.updateSettings({ github: { url, token } });
                setToken("");
                setSaved(true);
                onSaved();
              })
            }
            disabled={action.busy}
          >
            {t("projects.save")}
          </Button>
          <Button
            variant="outline"
            disabled={action.busy || (!g.hasToken && !token)}
            onClick={() => void action.run(async () => setCheck(await client.desktop!.checkGitHub()))}
          >
            {t("projects.checkConnection")}
          </Button>
          {saved ? <span className="text-sm text-success">{t("agents.saved")}</span> : null}
        </div>
        {check ? (
          <Notice tone={check.ok ? "ok" : "error"} className="whitespace-pre-wrap">
            {check.message}
          </Notice>
        ) : null}
        <ErrorNote error={action.error} />
    </FoldCard>
  );
}

function ProjectGitLab({ project, onSaved }: { project: DesktopProject; onSaved: () => void }) {
  const { client } = useHive();
  const t = useT();
  const [gitlabProject, setGitlabProject] = useState(project.gitlabProject ?? "");
  const [githubRepo, setGithubRepo] = useState(project.githubRepo ?? "");
  const [targetBranch, setTargetBranch] = useState(project.targetBranch ?? "");
  const action = useAction();
  return (
    <form
      className="flex flex-wrap items-center gap-2 border-t border-dashed pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.desktop!.updateProject(project.name, {
            gitlabProject: gitlabProject || null,
            githubRepo: githubRepo || null,
            targetBranch: targetBranch || null,
          });
          onSaved();
        });
      }}
    >
      <Input
        className="min-w-48 flex-[2] font-mono"
        placeholder={t("projects.gitlabProjectPlaceholder")}
        value={gitlabProject}
        onChange={(e) => setGitlabProject(e.target.value)}
        aria-label={t("projects.gitlabProjectOf", { project: project.name })}
      />
      <Input
        className="min-w-48 flex-[2] font-mono"
        placeholder={t("projects.githubRepoPlaceholder")}
        value={githubRepo}
        onChange={(e) => setGithubRepo(e.target.value)}
        aria-label={t("projects.githubRepoOf", { project: project.name })}
      />
      <Input
        className="min-w-40 flex-1 font-mono sm:max-w-52"
        placeholder={t("projects.targetPlaceholder")}
        value={targetBranch}
        onChange={(e) => setTargetBranch(e.target.value)}
        aria-label={t("projects.targetOf", { project: project.name })}
      />
      <Button size="sm" variant="outline" type="submit" disabled={action.busy}>
        {t("projects.save")}
      </Button>
      <ErrorNote error={action.error} />
    </form>
  );
}

/**
 * Reference repos of a project (roadmap 38h): other projects of the same system whose checkout is on this machine.
 * A run reads them and never writes in them, so a task on one service can read the old service's code. Only the
 * same system is offered: a repo of another product is never the context of this one.
 */
function ProjectReferences({ project, projects, onSaved }: { project: DesktopProject; projects: DesktopProject[]; onSaved: () => void }) {
  const { client, systems } = useHive();
  const t = useT();
  const action = useAction();
  const [picked, setPicked] = useState<string[]>(project.references ?? []);
  const sameSystem = new Set(systems.filter((s) => s.projects.includes(project.name)).flatMap((s) => s.projects));
  // A name saved before (a project since removed, or one out of the system now) stays on the list to be unticked.
  const names = [...new Set([...projects.map((p) => p.name).filter((n) => n !== project.name && sameSystem.has(n)), ...picked])].sort();
  const toggle = (name: string, on: boolean) => setPicked((list) => (on ? [...new Set([...list, name])] : list.filter((n) => n !== name)));

  return (
    <form
      className="flex flex-col gap-2 border-t border-dashed pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void action.run(async () => {
          await client.desktop!.updateProject(project.name, { references: picked });
          onSaved();
        });
      }}
    >
      <div className="text-sm font-medium">{t("projects.references")}</div>
      <p className="text-xs text-muted-foreground">{t("projects.referencesHint")}</p>
      {names.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {names.map((name) => {
            const local = projects.find((p) => p.name === name);
            return (
              <div key={name} className="flex items-center gap-2">
                <Checkbox id={`ref-${project.name}-${name}`} checked={picked.includes(name)} onCheckedChange={(v) => toggle(name, v === true)} />
                <Label htmlFor={`ref-${project.name}-${name}`} className="font-normal">
                  <span className="font-mono text-xs">{name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{local ? local.repo : t("projects.referencesGone")}</span>
                </Label>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("projects.referencesNone")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" type="submit" disabled={action.busy}>
          {t("projects.save")}
        </Button>
        <ErrorNote error={action.error} />
      </div>
    </form>
  );
}

export function ProjectsCard({ settings, onChanged }: { settings: DesktopSettings; onChanged: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const action = useAction();
  const [result, setResult] = useState<{ project: string; title: string; files: FileAction[]; extra?: string; ownAgents?: boolean } | null>(null);
  const [proposed, setProposed] = useState<number | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState<string | null>(null);
  // A folder that is no repository but holds some (roadmap 38d): what to offer instead of refusing it.
  const [found, setFound] = useState<RepoScan | null>(null);
  const [refsOpen, setRefsOpen] = useState<string | null>(null);
  const nameValid = PROJECT_NAME.test(name);
  const profiles = useQuery(() => desktop.profiles(), [desktop]);
  // Roadmap 47: repos the hub archived or deleted. The folder stays and works here, but nothing of it reaches the hub.
  const requests = useQuery(() => desktop.hubRequests(), [desktop]);
  const archived = new Set(requests.data?.archivedProjects ?? []);

  /** What a folder holds, as soon as it is picked or added: the suggestion comes before the error does. */
  const look = async (folder: string) => {
    const scan = await desktop.scanRepos(folder);
    setFound(!scan.isGit && scan.repos.length ? scan : null);
    return scan;
  };

  const showSync = (r: SyncReport) => {
    setProposed(null);
    setResult({
      project: r.project,
      title: t("projects.sync"),
      files: r.files,
      ownAgents: r.ownAgents,
      extra: [
        r.imported.length ? t("projects.imported", { keys: r.imported.join(", ") }) : "",
        r.commit ? t("projects.commit", { sha: r.commit }) : "",
        // In MR mode the docs are on their own branch, so the link matters more than the commit (roadmap 38c).
        r.mr ? t(r.mr.state === "created" ? "projects.syncMrCreated" : "projects.syncMrUpdated", { branch: r.mr.branch, url: r.mr.url }) : "",
        r.mirror?.commit
          ? t("projects.mirrored", { changed: r.mirror.changed.length, unchanged: r.mirror.unchanged, commit: r.mirror.commit })
          : "",
        r.mirror?.missing.length ? t("projects.mirrorMissing", { files: r.mirror.missing.join(", ") }) : "",
        r.mirror?.skipped.length ? t("projects.mirrorSkipped", { count: r.mirror.skipped.length, reason: r.mirror.skipped[0]!.reason }) : "",
        r.note ?? "",
      ]
        .filter(Boolean)
        .join(" · "),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("projects.local")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {settings.projects.length === 0 ? <Empty>{t("projects.noneLocal")}</Empty> : null}
        {settings.projects.length ? (
          <div className="flex flex-col gap-2">
            {settings.projects.map((p) => (
              <div key={p.name} className="flex flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-48">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm break-all">{p.name}</span>
                      {archived.has(p.name) ? (
                        <Badge tone="warn" data-project-archived={p.name}>
                          {t("projects.archivedOnHub")}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="font-mono text-xs break-all text-muted-foreground">{p.repo}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      data-sync-project={p.name}
                      onClick={() =>
                        void action.run(async () => {
                          showSync(await desktop.syncProject(p.name));
                          bump();
                        })
                      }
                    >
                      {t("projects.sync")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGitlabOpen(gitlabOpen === p.name ? null : p.name)} aria-expanded={gitlabOpen === p.name}>
                      {t("projects.forgeOf")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRefsOpen(refsOpen === p.name ? null : p.name)} aria-expanded={refsOpen === p.name}>
                      {t("projects.references")}
                      {p.references?.length ? <Badge tone="info">{p.references.length}</Badge> : null}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void desktop.showInFolder(p.repo)}>
                      {t("projects.open")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(t("projects.confirmRemove", { project: p.name }))) {
                          void action.run(async () => {
                            await desktop.removeProject(p.name);
                            onChanged();
                          });
                        }
                      }}
                    >
                      {t("projects.remove")}
                    </Button>
                  </div>
                </div>
                <OpenCli profiles={profiles.data ?? []} projects={[p.name]} />
                {gitlabOpen === p.name ? (
                  <ProjectGitLab
                    project={p}
                    onSaved={() => {
                      setGitlabOpen(null);
                      onChanged();
                    }}
                  />
                ) : null}
                {refsOpen === p.name ? (
                  <ProjectReferences
                    project={p}
                    projects={settings.projects}
                    onSaved={() => {
                      setRefsOpen(null);
                      onChanged();
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              // Repositories inside: offer them. Neither a repository nor holding any: addProject says so.
              if ((await look(repo)).repos.length) return;
              await desktop.addProject({ name, repo });
              setName("");
              setRepo("");
              onChanged();
            });
          }}
        >
          <Input
            className="min-w-32 flex-1 font-mono sm:max-w-44"
            placeholder="project key"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            aria-label="Project key"
            aria-invalid={name.length > 0 && !nameValid}
          />
          <Input
            className="min-w-48 flex-[3] font-mono"
            placeholder={t("projects.repoPlaceholder")}
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            aria-label={t("projects.repo")}
          />
          <Button
            type="button"
            variant="outline"
            data-pick-folder
            onClick={() =>
              void action.run(async () => {
                const folder = await desktop.pickFolder();
                if (folder) {
                  setRepo(folder);
                  if (!name) setName(suggestProjectKey(folder.split(/[\\/]/).filter(Boolean).pop() ?? "", settings.projects.map((p) => p.name)));
                  await look(folder);
                }
              })
            }
          >
            {t("projects.pickFolder")}
          </Button>
          <Button type="submit" data-add-project disabled={!nameValid || !repo || action.busy}>
            {t("projects.add")}
          </Button>
        </form>
        <ErrorNote error={action.error} />
        {found ? (
          <SubRepos
            key={found.root}
            scan={found}
            onAdded={async () => {
              setName("");
              setRepo("");
              onChanged();
              // Looking again marks what was just added, so a second click cannot try the same repositories.
              await look(found.root);
            }}
            onClose={() => setFound(null)}
          />
        ) : null}
        {result ? (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3" data-project-result={result.project}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{result.title}</span>
              <span className="min-w-0 font-mono text-xs break-all">{result.project}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setResult(null)}>
                {t("common.close")}
              </Button>
            </div>
            <ul className="flex flex-col gap-1">
              {result.files.map((f) => (
                <li key={f.file} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={ACTION_TONE[f.action]}>{t(`fileAction.${f.action}`)}</Badge>
                  <span className="min-w-0 font-mono text-xs break-all">{f.file}</span>
                  {f.note ? <span className="min-w-0 text-xs break-words text-muted-foreground">· {f.note}</span> : null}
                </li>
              ))}
            </ul>
            {result.extra ? <p className="text-xs break-words text-muted-foreground">{result.extra}</p> : null}
            {result.ownAgents ? (
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={action.busy || proposed !== null}
                  data-propose-agents={result.project}
                  onClick={() =>
                    void action.run(async () => {
                      setProposed((await desktop.proposeAgents(result.project)).id);
                    })
                  }
                >
                  {t("projects.proposeAgents")}
                </Button>
                <span className="min-w-0 flex-1 text-xs break-words text-muted-foreground">
                  {proposed === null ? t("projects.proposeAgentsHint") : t("projects.proposedAgents", { id: proposed })}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A folder that is no repository but holds some (roadmap 38d, the eight repos of one customer's system): each one
 * below it as a project of its own, with the key and the target branch it would get, then all of them in one system
 * named after the folder. Repositories the app already has are listed but not offered again.
 */
function SubRepos({ scan, onAdded, onClose }: { scan: RepoScan; onAdded: () => Promise<void>; onClose: () => void }) {
  const { client, bump, systems } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(scan.repos.filter((r) => r.state === "new").map((r) => [r.dir, true])));
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [toSystem, setToSystem] = useState(true);
  const [systemName, setSystemName] = useState<string | null>(null);
  const [results, setResults] = useState<RepoImportResult[] | null>(null);
  const adding = useAction();
  const keyOf = (r: RepoCandidate) => keys[r.dir] ?? r.key;
  const chosen = scan.repos.filter((r) => r.state === "new" && picked[r.dir]);
  const bad = chosen.filter((r) => !PROJECT_NAME.test(keyOf(r)));
  const dupes = new Set(chosen.map(keyOf).filter((k, i, all) => all.indexOf(k) !== i));
  const system = systemName ?? scan.system;

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-sub-repos>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("projects.subReposTitle", { count: scan.repos.length })}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
      <p className="m-0 text-xs break-words text-muted-foreground">{t("projects.subReposHint", { path: scan.root })}</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="w-8 p-2" />
              <th className="p-2 text-left font-medium">{t("projects.importRepo")}</th>
              <th className="p-2 text-left font-medium">Project key</th>
              <th className="p-2 text-left font-medium">{t("projects.subReposBranch")}</th>
            </tr>
          </thead>
          <tbody>
            {scan.repos.map((r) => {
              const added = r.state === "added";
              const key = keyOf(r);
              return (
                <tr key={r.dir} className="border-t align-top" data-sub-repo={r.rel}>
                  <td className="p-2">
                    <Checkbox
                      checked={!added && Boolean(picked[r.dir])}
                      disabled={added}
                      aria-label={r.rel}
                      onCheckedChange={(v) => setPicked((p) => ({ ...p, [r.dir]: v === true }))}
                    />
                  </td>
                  <td className="p-2">
                    <div className="font-mono text-xs break-all">{r.rel}</div>
                    {added ? (
                      <Badge tone="neutral" className="mt-1">
                        {t("projects.import_added")}
                      </Badge>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {added ? (
                      <span className="font-mono text-xs">{r.key}</span>
                    ) : (
                      <Input
                        className="h-8 w-40 font-mono text-xs md:text-xs"
                        value={key}
                        aria-label={`Project key ${r.rel}`}
                        aria-invalid={!PROJECT_NAME.test(key) || dupes.has(key)}
                        onChange={(e) => setKeys((k) => ({ ...k, [r.dir]: e.target.value.toLowerCase() }))}
                      />
                    )}
                  </td>
                  <td className="p-2 font-mono text-xs break-all text-muted-foreground">{r.targetBranch ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-add-sub-repos
          disabled={!chosen.length || bad.length > 0 || dupes.size > 0 || adding.busy}
          onClick={() =>
            void adding.run(async () => {
              const out = await desktop.addProjects(chosen.map((r) => ({ name: keyOf(r), repo: r.dir, targetBranch: r.targetBranch ?? undefined })));
              setResults(out.results);
              const joined = [...out.results.filter((r) => r.ok).map((r) => r.key), ...scan.repos.filter((r) => r.state === "added").map((r) => r.key)];
              if (toSystem && joined.length && PROJECT_NAME.test(system)) {
                const before = systems.find((s) => s.name === system)?.projects ?? [];
                await client.call("systems.save", { name: system, projects: [...new Set([...before, ...joined])] });
              }
              bump();
              await onAdded();
            })
          }
        >
          {adding.busy ? t("projects.subReposAdding") : t("projects.subReposAdd", { count: chosen.length })}
        </Button>
        <div className="flex items-center gap-2">
          <Checkbox id="sub-repos-to-system" checked={toSystem} onCheckedChange={(v) => setToSystem(v === true)} />
          <Label htmlFor="sub-repos-to-system" className="font-normal">
            {t("projects.importToSystem")}
          </Label>
          <Input
            className="h-8 w-36 font-mono text-xs md:text-xs"
            aria-label={t("systems.name")}
            value={system}
            disabled={!toSystem}
            aria-invalid={toSystem && !PROJECT_NAME.test(system)}
            onChange={(e) => setSystemName(e.target.value.toLowerCase())}
          />
        </div>
        {bad.length || dupes.size ? <span className="text-xs text-destructive">{t("projects.importBadKeys")}</span> : null}
      </div>
      <ErrorNote error={adding.error} />
      {results ? (
        <ul className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-sm">
          {results.map((r) => (
            <li key={r.dir} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Badge tone={r.ok ? "ok" : "danger"}>{r.ok ? t("projects.subReposAdded") : t("projects.importFailed")}</Badge>
              <span className="font-mono text-xs">{r.key}</span>
              <span className="font-mono text-xs break-all text-muted-foreground">{r.dir}</span>
              {r.error ? <span className="min-w-0 text-xs break-words text-destructive">{r.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The folder a path is in, for / and \\ alike. */
const parentDir = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || p;

const IMPORT_TONE: Record<GitLabImportCandidate["state"], string> = { added: "neutral", folder: "info", conflict: "danger", new: "ok" };

/**
 * A whole GitLab group at once (roadmap 19a): the repositories of the group and its subgroups, each with the project
 * key and folder it would get; the chosen ones are cloned (or their folder used) and added, with their GitLab path.
 */
export function GitLabImportCard({ settings, onChanged }: { settings: DesktopSettings; onChanged: () => void }) {
  const { client, bump, systems } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  // Where the projects so far are: their group and the folder they sit in, most likely where the rest go too.
  const first = settings.projects.find((p) => p.gitlabProject?.includes("/"));
  const [group, setGroup] = useState(first ? first.gitlabProject!.split("/").slice(0, -1).join("/") : "");
  const [baseDir, setBaseDir] = useState(first ? parentDir(first.repo) : "~/Work");
  const [protocol, setProtocol] = useState<"ssh" | "https">("ssh");
  // The group's projects as one system (roadmap 19b), named after the group unless changed.
  const [toSystem, setToSystem] = useState(true);
  const [systemName, setSystemName] = useState<string | null>(null);
  const [listed, setListed] = useState<{ group: string; candidates: GitLabImportCandidate[] } | null>(null);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [results, setResults] = useState<GitLabImportResult[] | null>(null);
  const listing = useAction();
  const importing = useAction();
  const chosen = (listed?.candidates ?? []).filter((c) => c.state !== "added" && c.state !== "conflict" && picked[c.repo.pathWithNamespace]);
  const keyOf = (c: GitLabImportCandidate) => keys[c.repo.pathWithNamespace] ?? c.key;
  const bad = chosen.filter((c) => !PROJECT_NAME.test(keyOf(c)));
  const dupes = new Set(chosen.map(keyOf).filter((k, i, all) => all.indexOf(k) !== i));
  const system = systemName ?? suggestProjectKey(listed?.group ?? group, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("projects.importTitle")}</CardTitle>
        <CardDescription>{t("projects.importHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="grid gap-3 sm:grid-cols-[1fr_2fr_auto_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void listing.run(async () => {
              const candidates = await desktop.gitlabGroup({ group, baseDir });
              setListed({ group, candidates });
              setPicked(Object.fromEntries(candidates.filter((c) => c.state !== "added" && c.state !== "conflict").map((c) => [c.repo.pathWithNamespace, true])));
              setKeys({});
              setResults(null);
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-group">{t("projects.importGroup")}</Label>
            <Input id="import-group" className="font-mono" placeholder="company/team" value={group} onChange={(e) => setGroup(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-base">{t("projects.importBase")}</Label>
            <div className="flex gap-1">
              <Input id="import-base" className="min-w-0 font-mono" value={baseDir} onChange={(e) => setBaseDir(e.target.value)} />
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void listing.run(async () => {
                    const folder = await desktop.pickFolder();
                    if (folder) setBaseDir(folder);
                  })
                }
              >
                {t("projects.pickFolder")}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="import-protocol">{t("projects.importProtocol")}</Label>
            <NativeSelect id="import-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value as "ssh" | "https")}>
              <NativeSelectOption value="ssh">SSH</NativeSelectOption>
              <NativeSelectOption value="https">HTTPS</NativeSelectOption>
            </NativeSelect>
          </div>
          <Button id="import-list" type="submit" disabled={!group.trim() || !baseDir.trim() || listing.busy}>
            {t("projects.importList")}
          </Button>
        </form>
        <ErrorNote error={listing.error} />
        {listed && !listed.candidates.length ? <Empty>{t("projects.importNone", { group: listed.group })}</Empty> : null}
        {listed?.candidates.length ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 p-2" />
                  <th className="p-2 text-left font-medium">{t("projects.importRepo")}</th>
                  <th className="p-2 text-left font-medium">Project key</th>
                  <th className="p-2 text-left font-medium">{t("projects.importFolder")}</th>
                </tr>
              </thead>
              <tbody>
                {listed.candidates.map((c) => {
                  const id = c.repo.pathWithNamespace;
                  const key = keyOf(c);
                  const locked = c.state === "added" || c.state === "conflict";
                  return (
                    <tr key={id} className="border-t align-top">
                      <td className="p-2">
                        <Checkbox
                          checked={!locked && Boolean(picked[id])}
                          disabled={locked}
                          aria-label={id}
                          onCheckedChange={(v) => setPicked((p) => ({ ...p, [id]: v === true }))}
                        />
                      </td>
                      <td className="p-2">
                        <div className="font-mono text-xs break-all">{id}</div>
                        <Badge tone={IMPORT_TONE[c.state]} className="mt-1">
                          {t(`projects.import_${c.state}`)}
                        </Badge>
                      </td>
                      <td className="p-2">
                        {locked ? (
                          <span className="font-mono text-xs">{c.key}</span>
                        ) : (
                          <Input
                            className="h-8 w-40 font-mono text-xs md:text-xs"
                            value={key}
                            aria-label={`Project key ${id}`}
                            aria-invalid={!PROJECT_NAME.test(key) || dupes.has(key)}
                            onChange={(e) => setKeys((k) => ({ ...k, [id]: e.target.value.toLowerCase() }))}
                          />
                        )}
                      </td>
                      <td className="p-2 font-mono text-xs break-all text-muted-foreground">{c.dir}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        {listed?.candidates.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!chosen.length || bad.length > 0 || dupes.size > 0 || importing.busy}
              onClick={() =>
                void importing.run(async () => {
                  const out = await desktop.importGitlab({
                    group: listed.group,
                    protocol,
                    items: chosen.map((c) => ({ key: keyOf(c), pathWithNamespace: c.repo.pathWithNamespace, dir: c.dir })),
                  });
                  setResults(out.results);
                  const joined = [
                    ...out.results.filter((r) => r.ok).map((r) => r.key),
                    ...listed.candidates.filter((c) => c.state === "added").map((c) => c.key),
                  ];
                  if (toSystem && joined.length && PROJECT_NAME.test(system)) {
                    const before = systems.find((s) => s.name === system)?.projects ?? [];
                    await client.call("systems.save", { name: system, projects: [...new Set([...before, ...joined])] });
                  }
                  bump();
                  onChanged();
                  // What was added is listed as added now.
                  setListed({ group: listed.group, candidates: await desktop.gitlabGroup({ group: listed.group, baseDir }) });
                })
              }
            >
              {importing.busy ? t("projects.importRunning") : t("projects.importRun", { count: chosen.length })}
            </Button>
            <div className="flex items-center gap-2">
              <Checkbox id="import-to-system" checked={toSystem} onCheckedChange={(v) => setToSystem(v === true)} />
              <Label htmlFor="import-to-system" className="font-normal">
                {t("projects.importToSystem")}
              </Label>
              <Input
                className="h-8 w-36 font-mono text-xs md:text-xs"
                aria-label={t("systems.name")}
                value={system}
                disabled={!toSystem}
                aria-invalid={toSystem && !PROJECT_NAME.test(system)}
                onChange={(e) => setSystemName(e.target.value.toLowerCase())}
              />
            </div>
            {bad.length || dupes.size ? <span className="text-xs text-destructive">{t("projects.importBadKeys")}</span> : null}
          </div>
        ) : null}
        <ErrorNote error={importing.error} />
        {results ? (
          <ul className="flex flex-col gap-1 rounded-lg bg-muted/50 p-3 text-sm">
            {results.map((r) => (
              <li key={r.pathWithNamespace} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge tone={r.ok ? "ok" : "danger"}>{r.ok ? (r.cloned ? t("projects.importCloned") : t("projects.importUsed")) : t("projects.importFailed")}</Badge>
                <span className="font-mono text-xs">{r.key}</span>
                <span className="font-mono text-xs break-all text-muted-foreground">{r.pathWithNamespace}</span>
                {r.error ? <span className="min-w-0 text-xs break-words text-destructive">{r.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
