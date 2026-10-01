import { useEffect, useState } from "react";
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
  type SyncReport,
  type TransferReport,
  type TransferResult,
} from "@xdev-hive/core";
import { Button } from "@xdev-hive/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@xdev-hive/ui/components/ui/card";
import { Checkbox } from "@xdev-hive/ui/components/ui/checkbox";
import { Input } from "@xdev-hive/ui/components/ui/input";
import { Label } from "@xdev-hive/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@xdev-hive/ui/components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "@xdev-hive/ui/components/ui/toggle-group";
import { Badge, Empty, ErrorNote, Notice, Page, PageHeader } from "#ui/components/common.tsx";
import { useAction, useHive, useQuery } from "#ui/hooks.ts";
import { rich, useT } from "#ui/i18n/index.tsx";

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
          <ModeCard settings={settings.data} onSaved={settings.reload} />
          <TransferCard settings={settings.data} />
          <GitLabCard settings={settings.data} onSaved={settings.reload} />
          <GitHubCard settings={settings.data} onSaved={settings.reload} />
          <ProjectsCard settings={settings.data} onChanged={settings.reload} />
          {settings.data.gitlab.url && settings.data.gitlab.hasToken ? <GitLabImportCard settings={settings.data} onChanged={settings.reload} /> : null}
        </>
      ) : null}
    </Page>
  );
}

function ModeCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
  const { client, me, bump } = useHive();
  const t = useT();
  const [mode, setMode] = useState(settings.mode);
  const [hubUrl, setHubUrl] = useState(settings.hubUrl);
  const [hubToken, setHubToken] = useState("");
  // People sign in with their hub account (the hub issues this machine a token); a pasted token still works.
  const [auth, setAuth] = useState<"account" | "token">("account");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const signIn = useAction();
  const browserSignIn = useAction();
  const [signedIn, setSignedIn] = useState<string | null>(null);
  const [approval, setApproval] = useState(settings.memoryRequiresApproval);
  const [autoCommit, setAutoCommit] = useState(settings.autoCommit);
  const action = useAction();
  const [saved, setSaved] = useState(false);

  useEffect(() => setSaved(false), [mode, hubUrl, hubToken, approval, autoCommit]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("projects.source")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          className="max-w-full"
          value={mode}
          onValueChange={(v) => {
            if (v) setMode(v as DesktopSettings["mode"]);
          }}
          aria-label={t("projects.mode")}
        >
          <ToggleGroupItem
            value="local"
            className="h-auto min-h-9 shrink py-1.5 whitespace-normal"
          >
            {t("projects.modeLocal")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="hub"
            className="h-auto min-h-9 shrink py-1.5 whitespace-normal"
          >
            {t("projects.modeHub")}
          </ToggleGroupItem>
        </ToggleGroup>
        {mode === "local" ? (
          <p className="text-sm break-words text-muted-foreground">
            {rich(t("projects.localHint"), { path: <code className={CODE}>{settings.dbPath}</code> })}
          </p>
        ) : (
          <div className={FORM_GRID}>
            <Label htmlFor="hub-url">{t("projects.hubUrl")}</Label>
            <Input id="hub-url" className="font-mono" placeholder="https://hive.xdev.asia" value={hubUrl} onChange={(e) => setHubUrl(e.target.value)} />
            <span className="text-sm leading-none font-medium">{t("projects.signIn")}</span>
            <div className="flex min-w-0 flex-col gap-3">
              {settings.mode === "hub" && settings.hasHubToken ? (
                <p className="text-sm text-muted-foreground">
                  {me.user ? (
                    rich(t("projects.usingAccount"), { account: <b className="text-foreground">@{me.user.username}</b> })
                  ) : (
                    t("projects.usingToken", { name: me.name })
                  )}
                </p>
              ) : null}
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                className="w-fit"
                value={auth}
                onValueChange={(v) => v && setAuth(v as "account" | "token")}
                aria-label={t("projects.signInMethod")}
              >
                <ToggleGroupItem value="account" className="px-3">
                  {t("projects.account")}
                </ToggleGroupItem>
                <ToggleGroupItem value="token" className="px-3">
                  {t("projects.pasteToken")}
                </ToggleGroupItem>
              </ToggleGroup>
              {auth === "account" ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void signIn.run(async () => {
                      await client.desktop!.hubSignIn({ hubUrl, username: username.trim(), password });
                      setSignedIn(username.trim().toLowerCase());
                      setPassword("");
                      setMode("hub");
                      onSaved();
                      bump();
                    });
                  }}
                >
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
                  <Button type="submit" variant="outline" disabled={!hubUrl.trim() || !username.trim() || !password || signIn.busy}>
                    {signIn.busy ? t("login.submitting") : t("projects.signInConnect")}
                  </Button>
                  <p className="w-full text-xs text-muted-foreground">
                    {rich(t("projects.signInHint"), { machine: <code className={CODE}>{settings.machine}</code> })}
                  </p>
                  <ErrorNote error={signIn.error} />
                  {signedIn && !signIn.error ? <Notice tone="ok">{t("projects.connected", { account: signedIn })}</Notice> : null}
                  <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!hubUrl.trim() || browserSignIn.busy || signIn.busy}
                      onClick={() =>
                        void browserSignIn.run(async () => {
                          await client.desktop!.hubSignInBrowser({ hubUrl });
                          setSignedIn(null);
                          setMode("hub");
                          onSaved();
                          bump();
                        })
                      }
                    >
                      {t("projects.signInBrowser")}
                    </Button>
                    {browserSignIn.busy ? (
                      <>
                        <span className="text-sm text-muted-foreground">{t("projects.signInBrowserWaiting")}</span>
                        <Button type="button" size="sm" variant="ghost" onClick={() => void client.desktop!.hubSignInCancel()}>
                          {t("common.cancel")}
                        </Button>
                      </>
                    ) : null}
                    <p className="w-full text-xs text-muted-foreground">{t("projects.signInBrowserHint")}</p>
                    <ErrorNote error={browserSignIn.error} />
                  </div>
                </form>
              ) : (
                <Input
                  id="hub-token"
                  className="font-mono"
                  type="password"
                  autoComplete="off"
                  placeholder={settings.hasHubToken ? t("projects.savedKeep") : "hive_…"}
                  value={hubToken}
                  onChange={(e) => setHubToken(e.target.value)}
                  aria-label={t("projects.hubToken")}
                />
              )}
            </div>
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
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={approval} onCheckedChange={(v) => setApproval(v === true)} disabled={mode === "hub"} />
          {t("projects.approval")} {mode === "hub" ? t("projects.approvalHub") : ""}
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
                await client.desktop!.updateSettings({ mode, hubUrl, hubToken, memoryRequiresApproval: approval, autoCommit });
                setHubToken("");
                setSaved(true);
                onSaved();
              })
            }
          >
            {t("projects.saveSettings")}
          </Button>
          <span className="min-w-0 font-mono text-xs break-all text-muted-foreground">{settings.configPath}</span>
        </div>
        <ErrorNote error={action.error} />
        {saved ? <Notice tone="ok">{t("projects.savedNotice")}</Notice> : null}
      </CardContent>
    </Card>
  );
}

const RESULT_TONE: Record<TransferResult, string> = { added: "ok", updated: "info", proposed: "warn", unchanged: "neutral", skipped: "neutral", failed: "danger" };
const KIND = { doc: "nav.docs", memory: "nav.memory", task: "nav.tasks" } as const;

function TransferCard({ settings }: { settings: DesktopSettings }) {
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
    <Card>
      <CardHeader>
        <CardTitle>{t("projects.transfer")}</CardTitle>
        <CardDescription className="break-words">
          {rich(t("projects.transferHint"), {
            hub: <b>{t("projects.modeHub")}</b>,
            once: <b>{t("projects.once")}</b>,
            path: <code className={CODE}>{settings.dbPath}</code>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{rich(t("projects.pushRule"), { push: <b>{t("projects.pushShort")}</b> })}</li>
          <li>{rich(t("projects.pullRule"), { pull: <b>{t("projects.pullShort")}</b> })}</li>
          <li>{t("projects.notTransferred")}</li>
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
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
      </CardContent>
    </Card>
  );
}

function GitLabCard({ settings, onSaved }: { settings: DesktopSettings; onSaved: () => void }) {
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
    <Card>
      <CardHeader>
        <CardTitle>GitLab merge request</CardTitle>
        <CardDescription className="break-words">
          {rich(t("projects.gitlabHint"), {
            branch: <code className={CODE}>ai/&lt;task&gt;</code>,
            merge: <code className={CODE}>/merge</code>,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className={FORM_GRID}>
          <Label htmlFor="gl-url">{t("projects.gitlabUrl")}</Label>
          <Input id="gl-url" className="font-mono" placeholder="https://gitlab.fis.vn" value={url} onChange={(e) => (setSaved(false), setUrl(e.target.value))} />
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
      </CardContent>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>GitHub pull request</CardTitle>
        <CardDescription className="break-words">{t("projects.githubHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
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

function ProjectsCard({ settings, onChanged }: { settings: DesktopSettings; onChanged: () => void }) {
  const { client, bump } = useHive();
  const t = useT();
  const desktop = client.desktop!;
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const action = useAction();
  const [result, setResult] = useState<{ project: string; title: string; files: FileAction[]; extra?: string } | null>(null);
  const [gitlabOpen, setGitlabOpen] = useState<string | null>(null);
  const nameValid = PROJECT_NAME.test(name);

  const showSync = (r: SyncReport) =>
    setResult({
      project: r.project,
      title: t("projects.sync"),
      files: r.files,
      extra: [
        r.imported.length ? t("projects.imported", { keys: r.imported.join(", ") }) : "",
        r.commit ? t("projects.commit", { sha: r.commit }) : "",
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
                    <div className="font-mono text-sm break-all">{p.name}</div>
                    <div className="font-mono text-xs break-all text-muted-foreground">{p.repo}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          showSync(await desktop.syncProject(p.name));
                          bump();
                        })
                      }
                    >
                      {t("projects.sync")}
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <a href="#/setup">{t("overview.settings")}</a>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setGitlabOpen(gitlabOpen === p.name ? null : p.name)} aria-expanded={gitlabOpen === p.name}>
                      {t("projects.forgeOf")}
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
                {gitlabOpen === p.name ? (
                  <ProjectGitLab
                    project={p}
                    onSaved={() => {
                      setGitlabOpen(null);
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
            onClick={() =>
              void action.run(async () => {
                const folder = await desktop.pickFolder();
                if (folder) {
                  setRepo(folder);
                  if (!name) setName((folder.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "-"));
                }
              })
            }
          >
            {t("projects.pickFolder")}
          </Button>
          <Button type="submit" disabled={!nameValid || !repo || action.busy}>
            {t("projects.add")}
          </Button>
        </form>
        <ErrorNote error={action.error} />
        {result ? (
          <div className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
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
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The folder a path is in, for / and \\ alike. */
const parentDir = (p: string) => p.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "") || p;

const IMPORT_TONE: Record<GitLabImportCandidate["state"], string> = { added: "neutral", folder: "info", new: "ok" };

/**
 * A whole GitLab group at once (roadmap 19a): the repositories of the group and its subgroups, each with the project
 * key and folder it would get; the chosen ones are cloned (or their folder used) and added, with their GitLab path.
 */
function GitLabImportCard({ settings, onChanged }: { settings: DesktopSettings; onChanged: () => void }) {
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
  const chosen = (listed?.candidates ?? []).filter((c) => c.state !== "added" && picked[c.repo.pathWithNamespace]);
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
              setPicked(Object.fromEntries(candidates.filter((c) => c.state !== "added").map((c) => [c.repo.pathWithNamespace, true])));
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
                  const added = c.state === "added";
                  return (
                    <tr key={id} className="border-t align-top">
                      <td className="p-2">
                        <Checkbox
                          checked={!added && Boolean(picked[id])}
                          disabled={added}
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
                        {added ? (
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
