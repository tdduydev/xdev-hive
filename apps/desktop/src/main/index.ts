import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, shell, Tray, type IpcMainInvokeEvent } from "electron";
import {
  agentProfileSchema,
  HiveError,
  HubBackend,
  requestDeviceToken,
  isMethod,
  PROJECT_NAME,
  toErrorPayload,
  transferHive,
  usageStop,
  type Actor,
  type AgentProfile,
  type AgentRun,
  type DesktopProject,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type GitLabCheck,
  type HiveBackend,
  type MachineCommand,
  type Me,
  type ProfileCheck,
  type ReportedProfile,
  type SetupReport,
  type StartRunRequest,
  type TransferReport,
  type TransferSide,
} from "@xdev-hive/core";
import {
  configPath,
  configSchema,
  gitlabSettingsSchema,
  loadConfig,
  localDbPath,
  pinMachine,
  resolveBackend,
  runnerSettingsSchema,
  saveConfig,
  SqliteHive,
  type HiveConfig,
} from "@xdev-hive/core/node";
import { GitLabClient } from "./gitlab/client.ts";
import { setMainLocale, tr } from "./i18n.ts";
import { MergeRequester, type MrHost } from "./gitlab/mr.ts";
import { MrWatcher, type MrChange } from "./gitlab/watch.ts";
import { CiFixer } from "./gitlab/ci-fix.ts";
import { installAgents, installShim } from "./installer.ts";
import { expandEnv, expandHome, resolveBin } from "./runner/command.ts";
import { LoginMonitor, loginParts } from "./runner/login.ts";
import { Runner, type HubUpdate, type RunnerEvent } from "./runner/runner.ts";
import { agentPath } from "./runner/shell-path.ts";
import { landingPage, signInThroughBrowser } from "./hub-browser.ts";
import { Setup } from "./setup.ts";
import { checkCitations } from "./citations.ts";
import { syncProject } from "./sync.ts";
import { openInTerminal } from "./terminal.ts";

app.setName("xDev Hive");
const smokeShot = process.env.HIVE_SMOKE_SCREENSHOT;
// A screenshot run gets its own profile dir: the single-instance lock (and localStorage) live there,
// so it neither quits because the real app is open nor touches the real app's state.
if (smokeShot) app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "hive-smoke-ui-")));
const devUrl = process.env.ELECTRON_RENDERER_URL;

let config: HiveConfig;
let backend: HiveBackend;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner;
let logins: LoginMonitor;
/** The first sign-in check after start; the profile list waits for it (briefly) so it opens with the answer. */
let firstLoginCheck: Promise<void> = Promise.resolve();
let mergeRequester: MergeRequester;
let mrWatcher: MrWatcher;
let setup: Setup;
/** Last setup check, sent to the hub with every heartbeat. */
let setupCache: { checkedAt: string; report: SetupReport } | null = null;
/** What the hub sent on the last heartbeat (hub mode only). */
let hubState: HubUpdate | null = null;
const notifiedCommands = new Set<number>();
// Electron's network stack: honours system proxy settings and the macOS keychain's certificates.
const gitlabFetch = (url: string, init: RequestInit) => net.fetch(url, init);
let quitting = false;

const actor = (): Actor => {
  const source = { via: "desktop" as const, machine: config.machine };
  return config.mode === "hub" ? { name: "desktop", role: "admin", source } : { name: os.userInfo().username, role: "admin", source };
};

function reload(): void {
  config = loadConfig();
  setMainLocale(config.locale);
  try {
    pinMachine(config);
  } catch (err) {
    console.warn("[xdev-hive] could not pin the machine name in config.json:", toErrorPayload(err).message);
  }
  backend = resolveBackend(config);
}

const resource = (...p: string[]) =>
  app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), ...p);
const mcpEntry = () => (app.isPackaged ? resource("mcp", "hive-mcp.mjs") : resource("out", "mcp", "hive-mcp.mjs"));
const trayIcon = () => (app.isPackaged ? resource("icons", "trayTemplate.png") : resource("resources", "trayTemplate.png"));
/** Window icon on Windows/Linux and the Dock icon in dev; packaged macOS builds use build/icon.icns. */
const appIcon = () => (app.isPackaged ? resource("icons", "icon.png") : resource("resources", "icon.png"));

function settings(): DesktopSettings {
  return {
    mode: config.mode,
    machine: config.machine,
    hubUrl: config.hub.url,
    hasHubToken: config.hub.token.length > 0,
    projects: config.projects,
    memoryRequiresApproval: config.memoryRequiresApproval,
    autoCommit: config.sync.autoCommit,
    configPath: configPath(),
    dbPath: localDbPath(config),
    runner: config.runner,
    gitlab: { url: config.gitlab.url, hasToken: config.gitlab.token.length > 0, mr: config.gitlab.mr },
  };
}

function project(name: unknown): DesktopProject {
  const p = config.projects.find((x) => x.name === name);
  if (!p) throw new HiveError("not_found", `Dự án ${String(name)} chưa được thêm.`, { key: "errors.projectNotAdded", vars: { project: String(name) } });
  return p;
}

function persist(next: HiveConfig): DesktopSettings {
  saveConfig(next);
  reload();
  return settings();
}

async function updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings> {
  const next: HiveConfig = structuredClone(config);
  if (patch.mode === "local" || patch.mode === "hub") next.mode = patch.mode;
  if (typeof patch.hubUrl === "string") next.hub.url = patch.hubUrl.trim().replace(/\/+$/, "");
  if (typeof patch.hubToken === "string" && patch.hubToken.trim()) next.hub.token = patch.hubToken.trim();
  if (typeof patch.memoryRequiresApproval === "boolean") next.memoryRequiresApproval = patch.memoryRequiresApproval;
  if (typeof patch.autoCommit === "boolean") next.sync.autoCommit = patch.autoCommit;
  if (patch.runner) {
    const r = patch.runner;
    next.runner = runnerSettingsSchema.parse({
      ...next.runner,
      ...r,
      worktreeRoot: typeof r.worktreeRoot === "string" && r.worktreeRoot.trim() ? expandHome(r.worktreeRoot.trim()) : r.worktreeRoot === undefined ? next.runner.worktreeRoot : null,
    });
  }
  if (patch.gitlab) {
    const g = patch.gitlab;
    next.gitlab = gitlabSettingsSchema.parse({
      url: typeof g.url === "string" ? g.url.trim().replace(/\/+$/, "") : next.gitlab.url,
      token: typeof g.token === "string" && g.token.trim() ? g.token.trim() : next.gitlab.token,
      mr: { ...next.gitlab.mr, ...g.mr },
    });
    if (next.gitlab.url && !/^https?:\/\//.test(next.gitlab.url)) throw new HiveError("bad_request", "GitLab URL phải bắt đầu bằng http(s)://", { key: "errors.gitlabUrl" });
  }
  if (next.mode === "hub") {
    if (!/^https?:\/\//.test(next.hub.url) || !next.hub.token) {
      throw new HiveError("bad_request", "Chế độ hub cần URL (http/https) và token.", { key: "errors.hubNeedsUrlToken" });
    }
    try {
      await new HubBackend(next.hub.url, next.hub.token).me("desktop");
    } catch (err) {
      const reason = toErrorPayload(err).message;
      throw new HiveError("bad_request", `Không kết nối được hub: ${reason}`, { key: "errors.hubUnreachable", vars: { reason } });
    }
  }
  return persist(next);
}

async function hubSignIn(input: { hubUrl?: unknown; username?: unknown; password?: unknown }): Promise<DesktopSettings> {
  const hubUrl = String(input?.hubUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(hubUrl)) throw new HiveError("bad_request", "URL hub phải bắt đầu bằng http(s)://", { key: "errors.hubUrl" });
  const username = String(input?.username ?? "").trim();
  const password = String(input?.password ?? "");
  if (!username || !password) throw new HiveError("bad_request", "Nhập tên đăng nhập và mật khẩu.", { key: "errors.credentialsRequired" });
  let token: string;
  try {
    ({ token } = await requestDeviceToken(hubUrl, { username, password, machine: config.machine }));
  } catch (err) {
    const { code, message, key, vars } = toErrorPayload(err);
    // The hub's own reason (wrong password, temporary password…) when it sent one.
    throw new HiveError(code === "unauthorized" || code === "forbidden" ? code : "bad_request", `Hub từ chối đăng nhập: ${message}`, key ? { key, vars } : { key: "errors.hubRefused", vars: { reason: message } });
  }
  return updateSettings({ mode: "hub", hubUrl, hubToken: token });
}

let browserSignIn: AbortController | null = null;

/** Signs in through the hub's page in the browser (SSO accounts have no password for the form above). */
async function hubSignInBrowser(input: { hubUrl?: unknown }): Promise<DesktopSettings> {
  const hubUrl = String(input?.hubUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(hubUrl)) throw new HiveError("bad_request", "URL hub phải bắt đầu bằng http(s)://", { key: "errors.hubUrl" });
  browserSignIn?.abort();
  const controller = new AbortController();
  browserSignIn = controller;
  try {
    const { token } = await signInThroughBrowser({
      hubUrl,
      machine: config.machine,
      open: (url) => shell.openExternal(url),
      page: (outcome) =>
        landingPage("xDev Hive", tr(outcome === "done" ? "desktop.browserSignInDone" : "desktop.browserSignInDenied")),
      signal: controller.signal,
    });
    return await updateSettings({ mode: "hub", hubUrl, hubToken: token });
  } finally {
    if (browserSignIn === controller) browserSignIn = null;
  }
}

function addProject(p: DesktopProject): DesktopSettings {
  const name = String(p?.name ?? "");
  const repo = path.resolve(String(p?.repo ?? ""));
  if (!PROJECT_NAME.test(name)) throw new HiveError("bad_request", "Project key: chữ thường, số, . _ -", { key: "errors.badProjectKey" });
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new HiveError("bad_request", `Không thấy thư mục ${repo}`, { key: "errors.noFolder", vars: { path: repo } });
  if (config.projects.some((x) => x.name === name)) throw new HiveError("conflict", `Đã có dự án ${name}.`, { key: "errors.projectExists", vars: { project: name } });
  return persist({ ...config, projects: [...config.projects, { name, repo }] });
}

// ── agent profiles & runs ────────────────────────────────────────────────────

const agentEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: agentPath() });

function saveProfile(input: AgentProfile, previousId?: string) {
  const profile = agentProfileSchema.parse(input);
  const replacing = previousId ?? profile.id;
  if (previousId && previousId !== profile.id && runner.store.running(previousId)) {
    throw new HiveError("conflict", `Profile ${previousId} đang chạy, không đổi id được.`, { key: "errors.profileRunningRename", vars: { id: previousId } });
  }
  if (profile.id !== replacing && config.agents.some((a) => a.id === profile.id)) {
    throw new HiveError("conflict", `Đã có profile ${profile.id}.`, { key: "errors.profileExists", vars: { id: profile.id } });
  }
  const exists = config.agents.some((a) => a.id === replacing);
  const agents = exists ? config.agents.map((a) => (a.id === replacing ? profile : a)) : [...config.agents, profile];
  persist({ ...config, agents, agentTokens: moveToken(config.agentTokens, replacing, profile.id) });
  void logins.refresh([profile.id]).catch(() => undefined);
  void runner.tick();
  return runner.profileStatuses();
}

function removeProfile(id: string) {
  if (runner.store.running(id)) throw new HiveError("conflict", `Profile ${id} đang chạy.`, { key: "errors.profileRunning", vars: { id } });
  persist({ ...config, agents: config.agents.filter((a) => a.id !== id), agentTokens: moveToken(config.agentTokens, id, null) });
  return runner.profileStatuses();
}

/** A profile's token follows it when it is renamed, and goes with it when it is removed. */
function moveToken(tokens: Record<string, string>, from: string, to: string | null): Record<string, string> {
  const { [from]: token, ...rest } = tokens;
  return token && to ? { ...rest, [to]: token } : rest;
}

function setProfileToken(id: string, token: string) {
  if (!config.agents.some((a) => a.id === id)) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  const value = String(token ?? "").trim();
  if (value.length > 4000 || /\s/.test(value)) throw new HiveError("bad_request", "Token không hợp lệ.", { key: "errors.badProfileToken" });
  const { [id]: _old, ...rest } = config.agentTokens;
  persist({ ...config, agentTokens: value ? { ...rest, [id]: value } : rest });
  return runner.profileStatuses();
}

/** A terminal running `claude setup-token` with the profile's login folder: the person copies the token into the app. */
function openSetupToken(id: string): { opened: boolean } {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  if (profile.kind !== "claude") throw new HiveError("bad_request", "Chỉ Claude Code có token dài hạn.", { key: "errors.setupTokenClaudeOnly" });
  const pathEnv = agentEnv().PATH ?? "";
  const bin = resolveBin(expandHome(profile.bin), pathEnv);
  if (!bin) throw new HiveError("not_found", tr("desktop.cliNotFound", { bin: profile.bin }), { key: "desktop.cliNotFound", vars: { bin: profile.bin } });
  const env = loginParts(profile)?.env ?? {};
  const file = openInTerminal(
    { title: `xDev Hive: ${tr("desktop.setupTokenTitle", { profile: profile.id })}`, bin, args: ["setup-token"], env, done: tr("desktop.setupTokenDone") },
    { dir: path.join(path.dirname(configPath()), "login", profile.id), which: (b) => resolveBin(b, pathEnv) },
  );
  if (!file) throw new HiveError("not_found", tr("desktop.noTerminal"), { key: "desktop.noTerminal" });
  return { opened: true };
}

/** One project at a time; a project whose check fails (no repo, no access) does not stop the others. */
async function checkAllCitations(): Promise<void> {
  for (const project of config.projects) {
    await checkCitations(backend, actor(), project).catch(() => undefined);
  }
}

/** A terminal with the profile's sign-in command; the app checks again when its window gets focus. */
function openLogin(id: string): { opened: boolean } {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  const parts = loginParts(profile);
  if (!parts) throw new HiveError("bad_request", `${profile.kind} không có lệnh đăng nhập.`, { key: "errors.noLoginCommand", vars: { kind: profile.kind } });
  const pathEnv = agentEnv().PATH ?? "";
  const bin = resolveBin(expandHome(profile.bin), pathEnv);
  if (!bin) throw new HiveError("not_found", tr("desktop.cliNotFound", { bin: profile.bin }), { key: "desktop.cliNotFound", vars: { bin: profile.bin } });
  const file = openInTerminal(
    { title: `xDev Hive: ${tr("desktop.loginTitle", { profile: profile.id })}`, bin, ...parts, done: tr("desktop.loginDone") },
    { dir: path.join(path.dirname(configPath()), "login", profile.id), which: (b) => resolveBin(b, pathEnv) },
  );
  if (!file) throw new HiveError("not_found", tr("desktop.noTerminal"), { key: "desktop.noTerminal" });
  return { opened: true };
}

async function recheckLogins() {
  const ids = logins.signedOut();
  if (ids.length) {
    await logins.refresh(ids);
    void runner.tick();
  }
  return runner.profileStatuses();
}

/** `--version`, then the sign-in check (which the runner and the hub see too). */
async function checkProfile(id: string): Promise<ProfileCheck> {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  const env = agentEnv();
  const bin = resolveBin(expandHome(profile.bin), env.PATH ?? "");
  if (!bin) return { ok: false, path: null, output: `${tr("desktop.cliNotFound", { bin: profile.bin })}\n${env.PATH}` };
  const version = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    execFile(bin, ["--version"], { env: { ...env, ...expandEnv(profile.env) }, timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? err.message : "") });
    });
  });
  await logins.refresh([id]);
  const login = logins.get(id);
  const signIn =
    login?.loggedIn === true
      ? login.method
        ? tr("desktop.loginYesVia", { method: login.method })
        : tr("desktop.loginYes")
      : login?.loggedIn === false
        ? tr("desktop.loginNo", { cmd: login.loginCommand ?? profile.bin })
        : tr("desktop.loginUnknown");
  void runner.tick();
  return { ok: version.ok && login?.loggedIn !== false, path: bin, output: `${version.output}\n${signIn}` };
}

function updateProject(name: string, patch: { gitlabProject?: string | null; targetBranch?: string | null }) {
  const current = project(name);
  const clean = (v: string | null | undefined, keep: string | undefined) =>
    v === undefined ? keep : v === null || !v.trim() ? undefined : v.trim();
  const next = { ...current, gitlabProject: clean(patch?.gitlabProject, current.gitlabProject), targetBranch: clean(patch?.targetBranch, current.targetBranch) };
  return persist({ ...config, projects: config.projects.map((p) => (p.name === name ? next : p)) });
}

async function checkGitLab(): Promise<GitLabCheck> {
  try {
    const user = await new GitLabClient(config.gitlab.url, config.gitlab.token, gitlabFetch).user();
    return { ok: true, user: user.username, message: tr("desktop.gitlabSignedIn", { name: user.name, username: user.username }) };
  } catch (err) {
    return { ok: false, user: null, message: toErrorPayload(err).message };
  }
}

async function createMergeRequest(runId: string): Promise<AgentRun> {
  const run = runner.store.get(runId);
  if (!run) throw new HiveError("not_found", `Không có run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
  if (run.status !== "succeeded") throw new HiveError("bad_request", "Chỉ tạo MR từ run đã xong.", { key: "errors.mrNeedsSucceeded" });
  try {
    return runner.store.update(run.id, await mergeRequester.open(run, { manual: true }));
  } catch (err) {
    runner.store.update(run.id, { mrState: "failed", mrNote: toErrorPayload(err).message });
    throw err;
  }
}

// ── shared data between this machine and the hub ────────────────────────────

/** push: local database → hub (a differing doc becomes a proposal) · pull: hub → local database (a new version). */
async function transferHub(direction: unknown): Promise<TransferReport> {
  if (direction !== "push" && direction !== "pull") throw new HiveError("bad_request", "direction: push | pull");
  if (!config.hub.url || !config.hub.token) throw new HiveError("bad_request", "Chưa có URL và token hub: điền ở Nguồn dữ liệu rồi bấm Lưu.", { key: "errors.transferNotReady" });
  const hub = backend instanceof HubBackend ? backend : new HubBackend(config.hub.url, config.hub.token);
  try {
    await hub.me("hive-transfer");
  } catch (err) {
    const reason = toErrorPayload(err).message;
    throw new HiveError("bad_request", `Không kết nối được hub: ${reason}`, { key: "errors.hubUnreachable", vars: { reason } });
  }
  const local = backend instanceof SqliteHive ? backend : new SqliteHive(localDbPath(config), { memoryRequiresApproval: config.memoryRequiresApproval });
  try {
    const localSide: TransferSide = { backend: local, actor: { name: `hive-transfer@${os.userInfo().username}`, role: "admin" }, label: tr("desktop.thisMachineLabel", { machine: config.machine }) };
    // The hub decides the role from the token; the name is only the label on what gets written.
    const hubSide: TransferSide = { backend: hub, actor: { name: "hive-transfer", role: "admin" }, label: "hub" };
    return direction === "push" ? await transferHive(localSide, hubSide) : await transferHive(hubSide, localSide, { newVersions: true });
  } finally {
    if (local !== backend) local.close();
  }
}

// ── setup status for the hub, and install requests from an admin ─────────────

/** Re-checks this machine's setup; the next heartbeat carries it to the hub. */
async function refreshSetup(): Promise<SetupReport> {
  const report = await setup.status();
  setupCache = { checkedAt: new Date().toISOString(), report };
  return report;
}

/** Profiles without command line or env: the hub only needs to know what exists and whether it runs. */
const reportedProfiles = (): ReportedProfile[] =>
  runner.profileStatuses().map((p) => ({
    id: p.id,
    label: p.label,
    kind: p.kind,
    enabled: p.enabled,
    account: p.account ?? null,
    installed: p.cliPath !== null,
    loggedIn: p.login?.loggedIn ?? null,
    sessionPercent: p.usage?.session?.percent ?? null,
    weekPercent: p.usage?.week?.percent ?? null,
    weekResets: p.usage?.week?.resets ?? null,
    overLimit: usageStop(p, p.usage) !== null,
    cooldownUntil: p.cooldownUntil,
    runs: p.stats.runs,
    rateLimited: p.stats.rateLimited,
  }));

function onHub(update: HubUpdate): void {
  hubState = update;
  for (const cmd of update.commands) {
    if (notifiedCommands.has(cmd.id) || !Notification.isSupported()) continue;
    notifiedCommands.add(cmd.id);
    const n = new Notification({
      title: tr("desktop.installRequestTitle"),
      body: tr("desktop.installRequestBody", { who: cmd.requestedBy, label: cmd.label }),
    });
    n.on("click", () => {
      showWindow();
      win?.webContents.executeJavaScript('location.hash = "#/setup"').catch(() => undefined);
    });
    n.show();
  }
}

/** Nothing an admin asks for runs until this machine's user approves it here. */
async function answerCommand(id: unknown, approve: unknown): Promise<MachineCommand> {
  const cmd = hubState?.commands.find((c) => c.id === id);
  if (!cmd || !hubState) throw new HiveError("not_found", `Không có yêu cầu #${String(id)} đang chờ trên máy này.`, { key: "errors.noPendingRequest", vars: { id: String(id) } });
  hubState = { ...hubState, commands: hubState.commands.filter((c) => c.id !== cmd.id) };
  if (approve !== true) return runner.reportCommand(cmd.id, "rejected");
  await runner.reportCommand(cmd.id, "running");
  try {
    const result = await setup.install(cmd.itemId);
    await refreshSetup().catch(() => undefined);
    const status = result.item.state === "installed" ? "done" : "failed";
    return await runner.reportCommand(cmd.id, status, `${result.item.state}: ${result.item.detail}\n\n${result.output}`);
  } catch (err) {
    return runner.reportCommand(cmd.id, "failed", toErrorPayload(err).message);
  }
}

function knownPath(p: string): boolean {
  return config.projects.some((x) => x.repo === p) || runner.store.list({ limit: 500 }).some((r) => r.worktree === p);
}

function onRunnerEvent(event: RunnerEvent): void {
  if (!Notification.isSupported()) return;
  const r = event.run;
  const title = `${r.taskId} · ${r.profileId ?? ""}`;
  const mr = r.mrUrl
    ? ` ${tr(r.mrState === "updated" ? "desktop.mrUpdated" : "desktop.mrCreated", { iid: r.mrIid ?? "", draft: r.mrDraft ? " (draft)" : "" })}`
    : r.mrState === "failed"
      ? ` ${tr("desktop.mrFailed", { note: r.mrNote ?? "" })}`
      : "";
  const body =
    event.type === "rotated"
      ? tr("desktop.runRotated", { profile: r.profileId ?? "", attempt: event.next.attempt })
      : event.type === "follow-up"
        ? tr("desktop.runFollowUp")
        : r.status === "succeeded"
          ? r.role === "review"
            ? tr("desktop.reviewDone")
            : tr("desktop.runDone", { count: r.commits })
          : `${tr(`runStatus.${r.status}`)}: ${r.error ?? ""}`;
  const n = new Notification({ title, body: body + mr });
  n.on("click", () => {
    showWindow();
    win?.webContents.executeJavaScript('location.hash = "#/board"').catch(() => undefined);
  });
  n.show();
}

/** Tells about MRs that were merged or closed, and pipelines that failed. */
function onMrChanges(changes: MrChange[]): void {
  if (!Notification.isSupported()) return;
  for (const c of changes) {
    const iid = c.run.mrIid ?? "";
    const body =
      c.status.to === "merged" && c.status.from !== "merged"
        ? c.taskError
          ? tr("desktop.mrMergedTaskFailed", { iid, reason: c.taskError })
          : tr(c.taskDone ? "desktop.mrMerged" : "desktop.mrMergedOnly", { iid })
        : c.status.to === "closed" && c.status.from !== "closed"
          ? tr("desktop.mrClosed", { iid })
          : c.fix?.kind === "queued"
            ? tr("desktop.ciFixQueued", { iid, run: c.fix.run.id, n: c.fix.n, max: c.fix.max })
            : c.fix?.kind === "limit"
              ? tr("desktop.ciFixLimit", { iid, max: c.fix.max })
              : c.fix?.kind === "error"
                ? tr("desktop.ciFixFailed", { iid, reason: c.fix.reason })
                : c.pipeline.to === "failed"
                  ? tr("desktop.pipelineFailed", { iid })
                  : null;
    if (!body) continue;
    const n = new Notification({ title: `${c.run.taskId} · MR !${iid}`, body });
    n.on("click", () => {
      showWindow();
      win?.webContents.executeJavaScript('location.hash = "#/board"').catch(() => undefined);
    });
    n.show();
  }
}

async function me(): Promise<Me> {
  if (backend instanceof HubBackend) return backend.me("desktop");
  return { ...actor(), mode: "local" };
}

function isTrusted(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? "";
  return devUrl ? url.startsWith(devUrl) : url.startsWith("file://");
}

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrusted(event)) return { ok: false, error: { code: "forbidden", message: "Untrusted sender" } };
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: toErrorPayload(err) };
    }
  });
}

function registerIpc(): void {
  handle("hive:call", (method: unknown, input: unknown) => {
    if (!isMethod(method)) throw new HiveError("bad_request", `Unknown method ${String(method)}`);
    return backend.call(method, input as never, actor());
  });
  handle("hive:me", me);
  handle("desktop:settings", settings);
  handle("desktop:updateSettings", updateSettings);
  handle("desktop:hubSignIn", hubSignIn);
  handle("desktop:hubSignInBrowser", hubSignInBrowser);
  handle("desktop:hubSignInCancel", () => browserSignIn?.abort());
  handle("desktop:setLocale", setLocale);
  handle("desktop:addProject", addProject);
  handle("desktop:removeProject", (name: string) =>
    persist({ ...config, projects: config.projects.filter((p) => p.name !== name) }),
  );
  handle("desktop:pickFolder", async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  handle("desktop:syncProject", (name: string) => syncProject(backend, actor(), project(name), { autoCommit: config.sync.autoCommit }));
  handle("desktop:installAgents", (name: string) => installAgents(project(name).repo, name));
  handle("desktop:installShim", () => installShim({ electronPath: process.execPath, entry: mcpEntry() }, agentPath()));
  handle("desktop:setupStatus", refreshSetup);
  handle("desktop:installSetup", async (id: unknown) => {
    const result = await setup.install(String(id));
    await refreshSetup().catch(() => undefined);
    return result;
  });
  handle("desktop:hubRequests", () => ({
    policy: config.mode === "hub" ? (hubState?.policy ?? null) : null,
    commands: config.mode === "hub" ? (hubState?.commands ?? []) : [],
  }));
  handle("desktop:answerCommand", answerCommand);
  handle("desktop:transferHub", transferHub);
  handle("desktop:showInFolder", async (p: string) => {
    if (!knownPath(p)) throw new HiveError("forbidden", "Chỉ mở được thư mục dự án hoặc worktree của run.", { key: "errors.openOnlyKnown" });
    await shell.openPath(p);
  });

  handle("desktop:profiles", async () => {
    await Promise.race([firstLoginCheck, new Promise((r) => setTimeout(r, 5_000))]);
    return runner.profileStatuses();
  });
  handle("desktop:saveProfile", saveProfile);
  handle("desktop:removeProfile", removeProfile);
  handle("desktop:resetCooldown", async (id: string) => (await runner.resetCooldown(id), runner.profileStatuses()));
  handle("desktop:checkProfile", checkProfile);
  handle("desktop:openLogin", openLogin);
  handle("desktop:recheckLogins", recheckLogins);
  handle("desktop:setProfileToken", setProfileToken);
  handle("desktop:openSetupToken", openSetupToken);
  handle("desktop:startRun", (req: StartRunRequest) => runner.enqueue(req));
  handle("desktop:runs", (filter?: { project?: string; limit?: number }) => runner.list(filter));
  handle("desktop:runLog", (id: string) => runner.log(id));
  handle("desktop:runDiff", (id: string) => runner.diff(id));
  handle("desktop:cancelRun", (id: string): AgentRun => runner.cancel(id));
  handle("desktop:removeWorktree", (id: string) => runner.removeWorktree(id));
  handle("desktop:updateProject", updateProject);
  handle("desktop:checkGitLab", checkGitLab);
  handle("desktop:createMergeRequest", createMergeRequest);
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: "xDev Hive",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 14 },
    ...(process.platform === "darwin" ? {} : { icon: appIcon() }),
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
  });
  win.on("close", (e) => {
    if (!quitting && process.platform === "darwin" && !smokeShot) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.once("ready-to-show", () => {
    if (!smokeShot) win?.show();
  });

  const hash = process.env.HIVE_SMOKE_HASH;
  if (devUrl) void win.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void win.loadFile(path.join(import.meta.dirname, "../renderer/index.html"), hash ? { hash } : undefined);

  if (smokeShot) {
    const capture = () => {
      const delay = Number(process.env.HIVE_SMOKE_DELAY_MS ?? 1500);
      setTimeout(async () => {
        const image = await win!.webContents.capturePage();
        writeFileSync(smokeShot, image.toPNG());
        console.log(`[xdev-hive] smoke screenshot ${smokeShot}`);
        app.exit(0);
      }, delay);
    };
    // HIVE_SMOKE_LOCALE=en: the interface language lives in the renderer's localStorage, so set it and reload first.
    const locale = process.env.HIVE_SMOKE_LOCALE;
    win.webContents.once("did-finish-load", () => {
      if (!locale) return capture();
      void win!.webContents.executeJavaScript(`localStorage.setItem("xdev-hive.locale", ${JSON.stringify(locale)})`).then(() => {
        win!.webContents.once("did-finish-load", capture);
        win!.webContents.reload();
      });
    });
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  win!.show();
  win!.focus();
}

let lastPending = 0;
async function refreshTray(): Promise<void> {
  if (!tray) return;
  try {
    const pending = (await backend.call("proposals.list", { status: "pending" }, actor())).length;
    tray.setTitle(pending ? ` ${pending}` : "");
    tray.setToolTip(pending ? `xDev Hive: ${tr("desktop.pendingProposals", { count: pending })}` : "xDev Hive");
    if (pending > lastPending && Notification.isSupported()) {
      const n = new Notification({ title: "xDev Hive", body: tr("desktop.pendingProposalsBody", { count: pending }) });
      n.on("click", () => {
        showWindow();
        win?.webContents.executeJavaScript('location.hash = "#/proposals"').catch(() => undefined);
      });
      n.show();
    }
    lastPending = pending;
  } catch {
    tray.setToolTip(`xDev Hive: ${tr("desktop.sourceUnreachable")}`);
  }
}

/** Built again when the interface language changes. */
function buildTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: tr("desktop.trayOpen"), click: showWindow },
      { label: tr("desktop.trayProposals"), click: () => (showWindow(), win?.webContents.executeJavaScript('location.hash = "#/proposals"')) },
      { type: "separator" },
      { label: tr("desktop.trayQuit"), role: "quit" },
    ]),
  );
}

/** The renderer tells the language it shows; the tray and notifications follow it (kept in config.json). */
function setLocale(locale: unknown): void {
  if (!setMainLocale(locale)) return;
  config = { ...config, locale };
  saveConfig(config);
  buildTrayMenu();
  void refreshTray();
  // Machine setup items carry their labels: check again so they come back in the new language.
  void refreshSetup().catch(() => undefined);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIcon());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("xDev Hive");
  buildTrayMenu();
  void refreshTray();
  setInterval(() => void refreshTray(), 20_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  let stopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (stopped || !runner) return;
    // Stop agents and let the runner commit their work and update Hive before exiting.
    e.preventDefault();
    stopped = true;
    void runner.stop().finally(() => app.quit());
  });
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  void app.whenReady().then(() => {
    try {
      reload();
    } catch (err) {
      dialog.showErrorBox("xDev Hive", tr("desktop.badConfig", { path: configPath(), reason: toErrorPayload(err).message }));
      config = configSchema.parse({});
      backend = resolveBackend(config);
    }
    const mrHost: MrHost = {
      gitlab: () => config.gitlab,
      projects: () => config.projects,
      backend: () => backend,
      mode: () => config.mode,
      store: () => runner.store,
      fetch: gitlabFetch,
      user: os.userInfo().username,
    };
    mergeRequester = new MergeRequester(mrHost);
    mrWatcher = new MrWatcher(mrHost, new CiFixer({ ...mrHost, enqueue: (req, extra) => runner.enqueue(req, extra) }));
    logins = new LoginMonitor(() => config.agents, agentEnv);
    runner = new Runner(
      {
        backend: () => backend,
        profiles: () => config.agents,
        settings: () => config.runner,
        projects: () => config.projects,
        mode: () => config.mode,
        machine: () => config.machine,
        env: agentEnv,
        report: () => ({ setup: setupCache ?? undefined, profiles: reportedProfiles() }),
        login: (id) => logins.get(id),
        usage: (id) => logins.usage(id),
        hub: () => (config.mode === "hub" && config.hub.url && config.hub.token ? { url: config.hub.url, token: config.hub.token } : null),
        token: (id) => config.agentTokens[id],
        gitlab: () => config.gitlab.url || null,
      },
      {
        dataDir: path.dirname(configPath()),
        version: app.getVersion(),
        onEvent: onRunnerEvent,
        afterFinish: (run) => mergeRequester.afterFinish(run),
        onHub,
      },
    );
    setup = new Setup({
      pathEnv: (refresh) => agentPath(refresh),
      env: agentEnv,
      projects: () => config.projects,
      shim: { electronPath: process.execPath, entry: mcpEntry() },
    });
    runner.start();
    // Sign-ins change outside the app (a terminal login, an expired session): check at start, then every 10 minutes.
    const checkLogins = () => logins.refresh().then(() => runner.tick(), () => undefined);
    firstLoginCheck = checkLogins();
    setInterval(() => void checkLogins(), 10 * 60_000).unref();
    // The hub's admin view shows each machine's setup: check at start, then every 10 minutes.
    void refreshSetup().catch(() => undefined);
    setInterval(() => void refreshSetup().catch(() => undefined), 10 * 60_000).unref();
    // Memory that cites files: compare them with each project's branch shortly after start, then every 30 minutes.
    const citations = () => void checkAllCitations().catch(() => undefined);
    setTimeout(citations, 60_000).unref();
    setInterval(citations, 30 * 60_000).unref();
    // Open MRs (state and pipeline on GitLab): shortly after start, then every 2 minutes.
    const watchMrs = () => void mrWatcher.check().then(onMrChanges, () => undefined);
    setTimeout(watchMrs, smokeShot ? 0 : 30_000).unref();
    setInterval(watchMrs, 2 * 60_000).unref();
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon());
    registerIpc();
    createWindow();
    if (!smokeShot) createTray();
  });
}

