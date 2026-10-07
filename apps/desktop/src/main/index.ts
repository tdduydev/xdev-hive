import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, protocol, shell, Tray, type IpcMainInvokeEvent } from "electron";
import {
  AGENT_TEMPLATES,
  agentProfileSchema,
  CHAT_FILE_SCHEME,
  chatFileName,
  isImage,
  type ChatFile,
  type ChatRequest,
  type ConfigIssue,
  type Machine,
  HiveError,
  HubBackend,
  requestDeviceToken,
  isMethod,
  PROJECT_NAME,
  suggestProjectKey,
  toErrorPayload,
  TOOL_ID,
  transferHive,
  usageStop,
  type Actor,
  type AgentProfile,
  type AgentRun,
  type DesktopProject,
  type DesktopSettings,
  type DesktopSettingsPatch,
  type GitLabCheck,
  type GitLabImportCandidate,
  type GitLabImportResult,
  type HiveBackend,
  type LoginHow,
  type NewAccount,
  type MachineCommand,
  type MachineTools,
  type MachineToolView,
  type ProfileChange,
  type RunMergeOrder,
  type Me,
  type ProfileCheck,
  type ReportedProfile,
  type RepoImportResult,
  type RepoScan,
  type SetupReport,
  type StartRunRequest,
  type SyncReport,
  type TransferReport,
  type TransferSide,
} from "@xdev-hive/core";
import { antigravityHome } from "#desktop/main/runner/antigravity.ts";
import { canClassify } from "#desktop/main/runner/classify.ts";
import {
  configPath,
  configSchema,
  githubSettingsSchema,
  gitlabSettingsSchema,
  localDbPath,
  pinMachine,
  resolveBackend,
  runnerSettingsSchema,
  saveConfig,
  SqliteHive,
  type HiveConfig,
} from "@xdev-hive/core/node";
import { GitHubClient } from "./github/client.ts";
import { GitLabClient } from "./gitlab/client.ts";
import { gitClone, importRepos, planImport } from "./gitlab/import.ts";
import { findGitRepos, isGitRepo, isRepoRoot, remoteUrl } from "./git.ts";
import { addRepos, planLocalImport } from "./local-import.ts";
import { appendCrashLog, crashLogPath, ReloadGuard, rendererGoneText, type RendererMemorySample } from "./crashlog.ts";
import { readDesktopConfig } from "./config-read.ts";
import { MainLog, mainLogDir, QuitReasons, relaunchAfterQuitInstall, takeStartHidden } from "./applog.ts";
import { mainLocale, setMainLocale, tr } from "./i18n.ts";
import { MergeRequester, mrLabel, type MrHost } from "./gitlab/mr.ts";
import { branchFor } from "#desktop/main/runner/worktree.ts";
import { cleanupNote, mrPollDelay, MrWatcher, type MrChange } from "./gitlab/watch.ts";
import { CiFixer } from "./gitlab/ci-fix.ts";
import { installAgents, installCodexConfig, installShim, repoFeatures, shimTarget } from "./installer.ts";
import { windowsUserPath } from "./winpath.ts";
import { toolViews } from "./runner/tools.ts";
import { expandEnv, expandHome, resolveBin } from "./runner/command.ts";
import { LOGIN_DIR_ENV, LoginMonitor, loginParts, readLoginHow, usageRefresher } from "./runner/login.ts";
import { platformKey, Updater, type UpdateStatus } from "./updater.ts";
import { Runner, type HubUpdate, type RunnerEvent } from "./runner/runner.ts";
import { agentPath } from "./runner/shell-path.ts";
import { landingPage, signInThroughBrowser } from "./hub-browser.ts";
import { Setup } from "./setup.ts";
import { checkCitations } from "./citations.ts";
import { proposeAgents, syncProject, type SyncOptions } from "./sync.ts";
import { mirrorDocs, mirrors } from "./mirror.ts";
import { pushSpecs } from "./specs.ts";
import { cliCommand } from "./cli-open.ts";
import { openInTerminal } from "./terminal.ts";
import { AlertWatch, fetchAlerts, noticeText, type AlertNotice } from "./alert-notify.ts";
import { applyProfileChanges } from "./profile-changes.ts";
import { mergeMr } from "./gitlab/merge.ts";
import { chatFileId, chatNotice, hubChatUpload, servedName } from "./chat.ts";

app.setName("xDev Hive");
// Chat files (roadmap 48): the page shows them from hive-file://chat/<id>, which only the main process can answer.
protocol.registerSchemesAsPrivileged([{ scheme: CHAT_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const smokeShot = process.env.HIVE_SMOKE_SCREENSHOT;
// A screenshot run gets its own profile dir: the single-instance lock (and localStorage) live there,
// so it neither quits because the real app is open nor touches the real app's state.
if (smokeShot) app.setPath("userData", mkdtempSync(path.join(os.tmpdir(), "hive-smoke-ui-")));
// HIVE_SMOKE_SIZE=1100x800: the window the screenshot is taken in, so a page can be shot at the widths it has to
// work at (roadmap 39g, the Board at 1100 and 1440). Screenshot runs only: never resizes a real window.
const smokeSize = smokeShot ? /^(\d+)x(\d+)$/.exec(process.env.HIVE_SMOKE_SIZE ?? "") : null;
const devUrl = process.env.ELECTRON_RENDERER_URL;

let config: HiveConfig;
/** What the last read of config.json left out or defaulted: shown on Agents and Today, written to main.log. */
let configIssues: ConfigIssue[] = [];
let backend: HiveBackend;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let runner: Runner;
let logins: LoginMonitor;
/** The first sign-in check after start; the profile list waits for it (briefly) so it opens with the answer. */
let firstLoginCheck: Promise<void> = Promise.resolve();
/** The commit each project's docs were last mirrored from (roadmap 26): the same main is not read twice. */
const mirrored = new Map<string, string>();
/** The hash of the Spec Kit features each project last pushed (roadmap 20b): the same ones are not sent again. */
const specsPushed = new Map<string, string>();
let mergeRequester: MergeRequester;
let mrHostRef: MrHost;
const mrHost = () => mrHostRef;
let mrWatcher: MrWatcher;
let setup: Setup;
/** Last setup check, sent to the hub with every heartbeat. */
let setupCache: { checkedAt: string; report: SetupReport } | null = null;
/** What the hub sent on the last heartbeat (hub mode only). */
let hubState: HubUpdate | null = null;
const notifiedCommands = new Set<number>();
let alertWatch: AlertWatch;
/** The hub and token the alerts were last read with: another one starts the watch over. */
let alertHub = "";
// Electron's network stack: honours system proxy settings and the macOS keychain's certificates.
const gitlabFetch = (url: string, init: RequestInit) => net.fetch(url, init);
let quitting = false;
// Started by the computer at sign-in ("Mở cùng máy" on Windows), or again by the updater after an install at quit
// (takeStartHidden, read once this instance holds the lock): the window waits in the tray until asked for.
let startHidden = process.argv.includes("--hidden");
let lastWindowHash = "";
// OOM every ~315 seconds evades a five-minute rolling limit. Keep a budget across windows for this app session.
const rendererReloads = new ReloadGuard(3, 5 * 60_000, 3);
// A screenshot run logs into its own temp profile: its starts and quits are not the real app's.
const mainLog = new MainLog(path.join(smokeShot ? app.getPath("userData") : mainLogDir(process.platform, process.env, os.homedir()), "main.log"));
const quitReasons = new QuitReasons();
/** The tray's or the menu's Quit: the person wants the app closed, so an install at quit does not start it again. */
function quitByUser(via: string): void {
  quitReasons.mark("user", via);
  app.quit();
}
let trayHintShown = false;

const actor = (): Actor => {
  const source = { via: "desktop" as const, machine: config.machine };
  return config.mode === "hub" ? { name: "desktop", role: "admin", source } : { name: os.userInfo().username, role: "admin", source };
};

function reload(): void {
  const read = readDesktopConfig(configPath(), (line) => mainLog.write(line), configIssues);
  configIssues = read.issues;
  if (!read.config) throw new Error(read.issues[0]?.message ?? "config.json cannot be read");
  config = read.config;
  setMainLocale(config.locale);
  try {
    pinMachine(config);
  } catch (err) {
    mainLog.write(`config: could not pin the machine name: ${toErrorPayload(err).message}`);
  }
  backend = resolveBackend(config);
  // This machine's own chat (local mode, roadmap 48): the database takes it as the machine its threads run on.
  if (backend instanceof SqliteHive) backend.setChatMachine(() => runner?.localChatMachine() ?? null);
}

const resource = (...p: string[]) =>
  app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(app.getAppPath(), ...p);
const mcpEntry = () => (app.isPackaged ? resource("mcp", "hive-mcp.mjs") : resource("out", "mcp", "hive-mcp.mjs"));
/** Agent configs name the shim by its full path: a GUI-started agent has no shell PATH to look it up on. */
const shimPath = () => shimTarget({ electronPath: process.execPath, entry: mcpEntry() });
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
    github: { url: config.github.url, hasToken: config.github.token.length > 0 },
    configIssues,
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
  // A changed MR check period counts from the last check, not from the next tick of the old period.
  scheduleMrWatch();
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
  if (patch.github) {
    const g = patch.github;
    next.github = githubSettingsSchema.parse({
      url: typeof g.url === "string" && g.url.trim() ? g.url.trim().replace(/\/+$/, "") : next.github.url,
      token: typeof g.token === "string" && g.token.trim() ? g.token.trim() : next.github.token,
    });
    if (!/^https?:\/\//.test(next.github.url)) throw new HiveError("bad_request", "GitHub URL phải bắt đầu bằng http(s)://", { key: "errors.githubUrl" });
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

/** The machine's GitLab, for the import: its URL and token must be set on this page first. */
function importClient(): GitLabClient {
  if (!config.gitlab.url || !config.gitlab.token) throw new HiveError("bad_request", "Set the GitLab URL and token first.", { key: "errors.gitlabNoToken" });
  return new GitLabClient(config.gitlab.url, config.gitlab.token, gitlabFetch);
}

async function gitlabGroup(input: { group: string; baseDir: string }): Promise<GitLabImportCandidate[]> {
  const group = String(input?.group ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(group)) throw new HiveError("bad_request", "A group path like company/team.", { key: "errors.gitlabGroup" });
  const baseDir = path.resolve(expandHome(String(input?.baseDir ?? "")));
  const repos = await importClient().groupProjects(group);
  const depth = Math.max(3, ...repos.map((repo) => repo.pathWithNamespace.split("/").length - group.split("/").length));
  const local = findGitRepos(baseDir, depth).map((dir) => ({ dir, remote: remoteUrl(dir) }));
  return planImport(repos, baseDir, config.projects, group, local);
}

async function importGitlab(input: {
  items: Array<{ key: string; pathWithNamespace: string; dir: string }>;
  protocol: "ssh" | "https";
  group: string;
}): Promise<{ results: GitLabImportResult[]; settings: DesktopSettings }> {
  const client = importClient();
  // The clone URLs come from GitLab again, not from the page.
  const repos = new Map((await client.groupProjects(String(input.group))).map((r) => [r.pathWithNamespace, r]));
  const items = (input.items ?? []).flatMap((i) => {
    const repo = repos.get(i.pathWithNamespace);
    return repo ? [{ key: i.key, pathWithNamespace: i.pathWithNamespace, dir: path.resolve(expandHome(i.dir)), url: input.protocol === "https" ? repo.httpUrl : repo.sshUrl, sshUrl: repo.sshUrl, httpUrl: repo.httpUrl, targetBranch: repo.defaultBranch }] : [];
  });
  const results = await importRepos(items, {
    check: (key) => {
      if (!PROJECT_NAME.test(key)) throw new HiveError("bad_request", "Project key: chữ thường, số, . _ -", { key: "errors.badProjectKey" });
      if (config.projects.some((x) => x.name === key)) throw new HiveError("conflict", `Đã có dự án ${key}.`, { key: "errors.projectExists", vars: { project: key } });
    },
    clone: gitClone(client, config.gitlab.token),
    remote: (dir) => isRepoRoot(dir) ? remoteUrl(dir) : null,
    add: (p) => {
      addProject({ name: p.name, repo: p.repo, targetBranch: p.targetBranch });
      updateProject(p.name, { gitlabProject: p.gitlabProject ?? null });
    },
  });
  return { results, settings: settings() };
}

function addProject(p: DesktopProject): DesktopSettings {
  const name = String(p?.name ?? "");
  const repo = path.resolve(expandHome(String(p?.repo ?? "")));
  const targetBranch = String(p?.targetBranch ?? "").trim() || undefined;
  if (!PROJECT_NAME.test(name)) throw new HiveError("bad_request", "Project key: chữ thường, số, . _ -", { key: "errors.badProjectKey" });
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new HiveError("bad_request", `Không thấy thư mục ${repo}`, { key: "errors.noFolder", vars: { path: repo } });
  // A folder that is no repository (roadmap 38d) is refused here, not later: a run on it fails at the worktree, the
  // sync writes without committing, and the Spec page stays empty.
  if (!isGitRepo(repo)) throw new HiveError("bad_request", `${repo} không phải git repo`, { key: "errors.notGitRepo", vars: { path: repo } });
  if (config.projects.some((x) => x.name === name)) throw new HiveError("conflict", `Đã có dự án ${name}.`, { key: "errors.projectExists", vars: { project: name } });
  return persist({ ...config, projects: [...config.projects, { name, repo, targetBranch }] });
}

/** What the folder someone picked holds (roadmap 38d): itself a repository, or the repositories under it. */
function scanRepos(dir: unknown): RepoScan {
  const root = path.resolve(expandHome(String(dir ?? "")));
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new HiveError("bad_request", `Không thấy thư mục ${root}`, { key: "errors.noFolder", vars: { path: root } });
  const isGit = isGitRepo(root);
  return {
    root,
    isGit,
    repos: isGit ? [] : planLocalImport(root, findGitRepos(root), config.projects),
    system: suggestProjectKey(path.basename(root), []),
  };
}

function addProjects(items: DesktopProject[]): { results: RepoImportResult[]; settings: DesktopSettings } {
  const results = addRepos(
    (items ?? []).map((i) => ({ name: String(i?.name ?? ""), repo: String(i?.repo ?? ""), targetBranch: i?.targetBranch })),
    { add: (p) => void addProject(p) },
  );
  return { results, settings: settings() };
}

// ── agent profiles & runs ────────────────────────────────────────────────────

const agentEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: agentPath() });

function saveProfile(input: AgentProfile, previousId?: string) {
  const profile = agentProfileSchema.parse(input);
  if (profile.kind === "antigravity" && process.platform === "linux" && !profile.env.HOME &&
      !config.agents.some((a) => a.id === (previousId ?? profile.id) && a.kind === "antigravity") && config.agents.some((a) => a.kind === "antigravity")) {
    const home = antigravityHome(profile.id, process.platform, os.homedir(), true)!;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    profile.env.HOME = home;
  }
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

/** The Setup card's hub tools (roadmap 28b): none in local mode, nor before the first heartbeat. */
function hubTools(): MachineToolView[] {
  return toolViews(hubCatalog(), config.projects.map((p) => ({ name: p.name, features: repoFeatures(p.repo) })), config.toolTrust);
}

/**
 * Screenshots only: a catalog as a heartbeat carries it (HIVE_SMOKE_TOOLS, a JSON file), so the Setup shot shows the
 * hub's tools and their tool:<id> items without a hub.
 */
const smokeTools = smokeShot && process.env.HIVE_SMOKE_TOOLS ? (JSON.parse(readFileSync(process.env.HIVE_SMOKE_TOOLS, "utf8")) as MachineTools) : null;

/** The catalog of the runner's last heartbeat: none in local mode, before the first heartbeat, or from a hub before 28b. */
function hubCatalog(): MachineTools | null {
  if (smokeTools) return smokeTools;
  return config.mode === "hub" ? (hubState?.tools ?? null) : null;
}

/** The machine's user allows a hub tool's commands as the card showed them (their hash), or takes it back (null). */
function setToolTrust(id: unknown, hash: unknown): MachineToolView[] {
  const name = String(id ?? "");
  if (!TOOL_ID.test(name) || (hash !== null && !(typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)))) {
    throw new HiveError("bad_request", `Không cho phép được tool ${name}.`, { key: "errors.toolTrustBad", vars: { id: name } });
  }
  const { [name]: _old, ...rest } = config.toolTrust;
  persist({ ...config, toolTrust: hash ? { ...rest, [name]: hash } : rest });
  // A run waiting on nothing else may start with it now; one already going keeps what it started with.
  void runner.tick();
  // Its tool:<id> item can be checked now (or no longer): the hub hears it with the next heartbeat.
  void refreshSetup().catch(() => undefined);
  return hubTools();
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

/**
 * A terminal with the profile's CLI in a project's repo, for the person at this machine to work in (roadmap 32a). Hive's
 * MCP server goes in under the profile's id. Not a run: no agent policy, no spending cap, nothing in the run store.
 */
function openCli(id: string, name: string): { opened: boolean } {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  const p = project(name);
  if (!existsSync(p.repo)) throw new HiveError("not_found", `Không thấy thư mục repo: ${p.repo}`, { key: "errors.noFolder", vars: { path: p.repo } });
  // Unknown (not checked yet, a CLI with no status command) still opens: the CLI says so itself.
  if (logins.get(id)?.loggedIn === false) throw new HiveError("conflict", tr("desktop.cliSignedOut", { profile: id }), { key: "desktop.cliSignedOut", vars: { profile: id } });
  const pathEnv = agentEnv().PATH ?? "";
  const bin = resolveBin(expandHome(profile.bin), pathEnv);
  if (!bin) throw new HiveError("not_found", tr("desktop.cliNotFound", { bin: profile.bin }), { key: "desktop.cliNotFound", vars: { bin: profile.bin } });
  const dir = path.join(path.dirname(configPath()), "cli", profile.id);
  const mcpFile = path.join(dir, "mcp.json");
  const { command, mcpConfig } = cliCommand(profile, {
    project: p.name,
    repo: p.repo,
    bin,
    // cmd.exe inherits the app's env, and a Windows PATH may hold characters a cmd script cannot quote.
    path: process.platform === "win32" ? null : pathEnv,
    shim: shimPath(),
    mcpFile,
    title: `xDev Hive: ${tr("desktop.cliTitle", { profile: profile.id, project: p.name })}`,
    done: tr("desktop.cliDone"),
  });
  if (mcpConfig) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(mcpFile, mcpConfig, { mode: 0o600 });
  }
  const file = openInTerminal(command, { dir, which: (b) => resolveBin(b, pathEnv), ...(smokeShot ? { run: () => undefined } : {}) });
  if (!file) throw new HiveError("not_found", tr("desktop.noTerminal"), { key: "desktop.noTerminal" });
  return { opened: true };
}

/** One project at a time; a project whose check fails (no repo, no access) does not stop the others. */
async function checkAllCitations(): Promise<void> {
  for (const project of config.projects) {
    await checkCitations(backend, actor(), project).catch(() => undefined);
  }
}

/**
 * How a project's docs get into its repo: as a merge request when the repo is on a forge this app can open one on
 * (roadmap 38c), so the checkout the user works in keeps its branch and its unfinished files; by a commit into the
 * checkout otherwise, as before. Auto-commit off means the app writes no git history at all, so no MR either.
 */
function syncMr(p: DesktopProject): SyncOptions["mr"] {
  if (!config.sync.autoCommit || !mergeRequester.canOpenContext(p)) return undefined;
  const worktreeRoot = config.runner.worktreeRoot ?? path.join(path.dirname(configPath()), "worktrees");
  return { worktreeRoot, open: (target, branch) => mergeRequester.openContext(target, branch) };
}

/** Đồng bộ of the Projects page, and what a sync request from the hub runs (roadmap 22n), the same way for both. */
async function syncAndMirror(name: string): Promise<SyncReport> {
  const report = await syncProject(backend, actor(), project(name), { autoCommit: config.sync.autoCommit, mr: syncMr(project(name)) });
  // The other way too (roadmap 26): the repo's docs into Hive, when the repo says which.
  if (!mirrors(project(name).repo)) return report;
  const mirror = await mirrorDocs(backend, actor(), project(name));
  if (mirror.commit) mirrored.set(name, mirror.commit);
  return { ...report, mirror };
}

/**
 * One project's Spec Kit features to the hub after a run (hub mode only), even unchanged: the push itself tells a flow
 * that what it waits for is as the run left it.
 */
async function pushSpecsOf(name: string): Promise<void> {
  const p = config.mode === "hub" ? config.projects.find((x) => x.name === name) : undefined;
  if (!p) return;
  const hash = await pushSpecs(backend, actor(), p, undefined).catch(() => null);
  if (hash) specsPushed.set(p.name, hash);
}

/** The repo's docs into Hive for every project that mirrors some (one at a time; one that fails leaves the others). */
async function mirrorAll(): Promise<void> {
  // Spec Kit features of every project (roadmap 20b), not only those that mirror docs.
  for (const p of smokeShot ? [] : config.projects) {
    const hash = await pushSpecs(backend, actor(), p, specsPushed.get(p.name)).catch((err: Error) => {
      console.error(`[xdev-hive] specs ${p.name}: ${err.message}`);
      return null;
    });
    if (hash) specsPushed.set(p.name, hash);
  }
  for (const p of config.projects) {
    if (!mirrors(p.repo)) continue;
    const r = await mirrorDocs(backend, actor(), p, { since: mirrored.get(p.name) }).catch((err: Error) => {
      console.error(`[xdev-hive] mirror ${p.name}: ${err.message}`);
      return null;
    });
    if (r?.commit) mirrored.set(p.name, r.commit);
    if (r?.changed.length) console.log(`[xdev-hive] mirror ${p.name} @ ${r.commit}: ${r.changed.length} pages`);
  }
}

/** A terminal with the profile's sign-in command; the app checks again when its window gets focus. */
function openLogin(id: string, how?: LoginHow): { opened: boolean } {
  const profile = config.agents.find((a) => a.id === id);
  if (!profile) throw new HiveError("not_found", `Không có profile ${id}.`, { key: "errors.profileNotFound", vars: { id } });
  const parts = loginParts(profile, readLoginHow(how));
  if (!parts) throw new HiveError("bad_request", `${profile.kind} không có lệnh đăng nhập.`, { key: "errors.noLoginCommand", vars: { kind: profile.kind } });
  if (profile.kind === "codex") {
    const home = profile.env.CODEX_HOME ? expandHome(profile.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
    installCodexConfig(path.join(home, "config.toml"), shimPath());
  }
  const pathEnv = agentEnv().PATH ?? "";
  const bin = resolveBin(expandHome(profile.bin), pathEnv);
  if (!bin) throw new HiveError("not_found", tr("desktop.cliNotFound", { bin: profile.bin }), { key: "desktop.cliNotFound", vars: { bin: profile.bin } });
  const file = openInTerminal(
    { title: `xDev Hive: ${tr("desktop.loginTitle", { profile: profile.id })}`, bin, ...parts, done: tr("desktop.loginDone") },
    // A smoke run writes the script but opens no window on the machine running it.
    { dir: path.join(path.dirname(configPath()), "login", profile.id), which: (b) => resolveBin(b, pathEnv), ...(smokeShot ? { run: () => undefined } : {}) },
  );
  if (!file) throw new HiveError("not_found", tr("desktop.noTerminal"), { key: "desktop.noTerminal" });
  return { opened: true };
}

/**
 * One more subscription (roadmap 24b): a profile from the kind's template with the next free id. The first profile of
 * a kind on the CLI's usual sign-in folder keeps it; every other one gets ~/.xdev-hive/accounts/<id>, which a Codex
 * account needs Hive's MCP block in too. Then its sign-in, in a terminal like the Đăng nhập button.
 */
function addAccount(input: NewAccount): { id: string; opened: boolean; profiles: ReturnType<typeof runner.profileStatuses> } {
  const kind = input?.kind;
  if (kind !== "claude" && kind !== "codex" && kind !== "antigravity") throw new HiveError("bad_request", `No accounts for ${String(kind)}.`, { key: "errors.noLoginCommand", vars: { kind: String(kind) } });
  const template = AGENT_TEMPLATES[kind];
  const pathEnv = agentEnv().PATH ?? "";
  if (!resolveBin(expandHome(template.bin), pathEnv)) throw new HiveError("not_found", tr("desktop.cliNotFound", { bin: template.bin }), { key: "desktop.cliNotFound", vars: { bin: template.bin } });
  const dirEnv = LOGIN_DIR_ENV[kind]!;
  const taken = new Set(config.agents.map((a) => a.id));
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  const id = `${kind}-${n}`;
  const usualTaken = config.agents.some((a) => a.kind === kind && !a.env[dirEnv]);
  const env: Record<string, string> = {};
  if (usualTaken && (kind !== "antigravity" || process.platform === "linux")) {
    const dir = kind === "antigravity" ? path.join(os.homedir(), ".xdev-hive", "antigravity", id) : path.join(path.dirname(configPath()), "accounts", id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (kind === "codex") installCodexConfig(path.join(dir, "config.toml"), shimPath());
    env[dirEnv] = dir.startsWith(os.homedir() + path.sep) ? `~${dir.slice(os.homedir().length)}` : dir;
  }
  // Named by how many of the kind there are with it ("Claude 2" next to the one already there), not by its id.
  const nth = config.agents.filter((a) => a.kind === kind).length + 1;
  const label = String(input.label ?? "").trim().slice(0, 80) || `${kind === "claude" ? "Claude" : kind === "antigravity" ? "Antigravity (Google)" : "ChatGPT (Codex)"} ${nth}`;
  const profile = { ...template, id, label, env };
  // Before it is saved, in the same turn: the run the save starts must not take an account nobody signed in yet.
  logins.expectSignedOut(profile);
  saveProfile(profile);
  const { opened } = openLogin(id, input.how);
  return { id, opened, profiles: runner.profileStatuses() };
}

async function recheckLogins() {
  const ids = logins.signedOut();
  if (ids.length) {
    await logins.refresh(ids);
    void runner.tick();
  }
  return runner.profileStatuses();
}

/** Đọc lại quota on the Agent page (roadmap 52), for one profile or every enabled one. */
const refreshUsage = usageRefresher(
  (ids) => logins.refresh(ids),
  () => runner.tick(),
  () => runner.profileStatuses(),
);

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

/**
 * The reference repos of a project (roadmap 38h): other projects of this machine, so the runner can read their
 * checkout. A project cannot reference itself, and a name nobody added here would only be skipped at run time.
 */
function references(name: string, patch: string[] | null | undefined, keep: string[] | undefined): string[] | undefined {
  if (patch === undefined) return keep;
  const list = [...new Set((patch ?? []).map((n) => String(n).trim()).filter(Boolean))];
  for (const ref of list) {
    if (ref === name) throw new HiveError("bad_request", `Dự án ${name} không tham chiếu chính nó được.`, { key: "errors.referenceSelf", vars: { project: name } });
    // Only a name being added has to exist: one saved earlier whose project went is kept until the user unticks it,
    // so saving the rest of the form never fails on it.
    if (!keep?.includes(ref) && !config.projects.some((p) => p.name === ref)) {
      throw new HiveError("not_found", `Dự án ${ref} chưa được thêm.`, { key: "errors.projectNotAdded", vars: { project: ref } });
    }
  }
  return list.length ? list : undefined;
}

function updateProject(name: string, patch: { gitlabProject?: string | null; githubRepo?: string | null; targetBranch?: string | null; references?: string[] | null }) {
  const current = project(name);
  const clean = (v: string | null | undefined, keep: string | undefined) =>
    v === undefined ? keep : v === null || !v.trim() ? undefined : v.trim();
  const githubRepo = clean(patch?.githubRepo, current.githubRepo);
  if (githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(githubRepo)) {
    throw new HiveError("bad_request", "GitHub repo có dạng owner/repo.", { key: "errors.githubRepoFormat" });
  }
  const next = {
    ...current,
    gitlabProject: clean(patch?.gitlabProject, current.gitlabProject),
    githubRepo,
    targetBranch: clean(patch?.targetBranch, current.targetBranch),
    references: references(name, patch?.references, current.references),
  };
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

async function checkGitHub(): Promise<GitLabCheck> {
  try {
    const user = await new GitHubClient(config.github.url, config.github.token, gitlabFetch).user();
    return { ok: true, user: user.login, message: tr("desktop.githubSignedIn", { name: user.name ?? user.login, username: user.login }) };
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
  const report = smokeShot && process.env.HIVE_SMOKE_SETUP_REPORT
    ? JSON.parse(readFileSync(process.env.HIVE_SMOKE_SETUP_REPORT, "utf8")) as SetupReport
    : await setup.status();
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
    sessionResetsAt: p.usage?.session?.resetsAt ?? null,
    weekResetsAt: p.usage?.week?.resetsAt ?? null,
    running: p.running,
    sessionResets: p.usage?.session?.resets ?? null,
    weekResets: p.usage?.week?.resets ?? null,
    usageCheckedAt: p.usage?.checkedAt ?? null,
    resetsLeft: p.usage?.resetsLeft ?? null,
    fullSessionsLeft: p.usage?.fullSessionsLeft ?? null,
    weekPerSession: p.usage?.weekPerSession ?? null,
    credits: p.usage?.credits ?? null,
    planType: p.usage?.planType ?? null,
    spendControlReached: p.usage?.spendControlReached ?? null,
    overLimit: usageStop(p, p.usage) !== null,
    cooldownUntil: p.cooldownUntil,
    runs: p.stats.runs,
    rateLimited: p.stats.rateLimited,
    statsSince: p.stats.since,
    priority: p.priority,
    // The hub counts free places with it when it picks a machine for a run group (roadmap 31a).
    maxConcurrent: p.maxConcurrent,
    // Only then does the hub put a classify run before a task with no kind on this machine (roadmap 54b).
    classify: canClassify(p),
    timeoutMinutes: p.timeoutMinutes,
    redispatch: true,
    planApproval: ["claude", "codex"].includes(p.kind) && p.roles.includes("implement"),
    supportedModels: p.supportedModels ?? null,
  }));

let updater: Updater;
let notifiedUpdate: string | null = null;

/** A download finished: say so once per version (the top bar also shows it). */
function onUpdateChange(status: UpdateStatus): void {
  if (status.state !== "ready" || !status.version || notifiedUpdate === status.version || !Notification.isSupported()) return;
  notifiedUpdate = status.version;
  const n = new Notification({ title: tr("desktop.updateReadyTitle", { version: status.version }), body: tr("desktop.updateReadyBody") });
  n.on("click", showWindow);
  n.show();
}

/** Restarts into the downloaded build: the runner stops its agents first (before-quit), then the helper swaps the app. */
async function installAndRestart(): Promise<void> {
  await updater.install({ relaunch: true });
  quitReasons.mark("update", "restart into the new build");
  app.quit();
}

function onHub(update: HubUpdate): void {
  const catalogBefore = JSON.stringify(hubState?.tools ?? null);
  hubState = update;
  // The catalog decides the machine's tool:<id> items and Spec Kit's version: check again when it changed, so admins
  // see a tool turned on or bumped without waiting for the 10-minute check.
  if (JSON.stringify(update.tools ?? null) !== catalogBefore || update.toolApprovals?.length) void refreshSetup().catch(() => undefined);
  if (update.toolApprovals?.length) void runner.tick();
  if (!smokeShot) void watchAlerts();
  if (update.profileChanges?.length) takeProfileChanges(update.profileChanges);
  if (update.mergeRuns?.length) void takeMerges(update.mergeRuns);
  updater.offer(update.update);
  // "Once no run is going": nothing queued or running, the window may even be closed.
  if (updater.installsOn("idle") && !runner.store.active().length) void installAndRestart();
  for (const cmd of update.commands) {
    if (notifiedCommands.has(cmd.id) || !Notification.isSupported()) continue;
    notifiedCommands.add(cmd.id);
    const n = new Notification({
      title: tr("desktop.installRequestTitle"),
      body: tr("desktop.installRequestBody", { who: cmd.requestedBy, label: cmd.label }),
    });
    n.on("click", () => {
      showPage("/setup");
    });
    n.show();
  }
}

/**
 * Someone else turned a subscription of this machine on or off, or moved its priority, on the web (roadmap 18d): saved
 * like a change on the Agents page, and said, since it is this machine's user's account.
 */
function takeProfileChanges(changes: ProfileChange[]): void {
  const { agents, applied } = applyProfileChanges(config.agents, changes);
  if (!applied.length) return;
  persist({ ...config, agents });
  // A profile back on may take what waits in the queue now rather than at the next tick.
  void runner.tick();
  if (!Notification.isSupported()) return;
  for (const { change, profile } of applied) {
    const what = change.enabled === null ? "desktop.profileChangedPriority" : profile.enabled ? "desktop.profileChangedOn" : "desktop.profileChangedOff";
    const n = new Notification({ title: tr("desktop.profileChangedTitle"), body: tr(what, { who: change.requestedBy, profile: profile.id, priority: profile.priority }) });
    n.on("click", () => {
      showPage("/agents");
    });
    n.show();
  }
}

/** Merges in progress here: the hub sends a merge at every heartbeat until the machine reports on it. */
const merging = new Set<string>();

/**
 * Someone with Code review merged a run's MR from the web (roadmap 18c): done here with this machine's GitLab or GitHub
 * token. Only an MR of one of this machine's own runs. The watcher then sees it merged and moves the task, as for any merge.
 */
async function takeMerges(orders: RunMergeOrder[]): Promise<void> {
  let merged = false;
  for (const o of orders) {
    if (merging.has(o.runId)) continue;
    merging.add(o.runId);
    try {
      const run = runner.store.get(o.runId);
      let error: { message: string; key?: string; vars?: Record<string, string | number> } | null = null;
      if (!run || run.mrUrl !== o.mrUrl) error = { message: `Run ${o.runId} has no MR ${o.mrUrl} on this machine.`, key: "errors.mrNotOnForge", vars: { url: o.mrUrl } };
      else {
        try {
          await mergeMr(mrHost(), o.mrUrl);
          merged = true;
        } catch (err) {
          const e = toErrorPayload(err);
          error = { message: e.message.slice(0, 2000), ...(e.key ? { key: e.key, vars: e.vars as Record<string, string | number> } : {}) };
        }
      }
      await backend.call("runs.mergeResult", { runId: o.runId, ok: error === null, error }, actor());
      if (Notification.isSupported() && run) {
        const n = new Notification({
          title: `${run.taskId} · ${mrLabel(run)}`,
          body: error ? tr("desktop.mergeFailed", { who: o.requestedBy, reason: error.message }) : tr("desktop.mergedFromHub", { who: o.requestedBy }),
        });
        n.on("click", showWindow);
        n.show();
      }
    } catch (err) {
      // The hub did not hear the result: the next heartbeat sends the merge again, and the forge says it is merged.
      console.error(`[xdev-hive] merge ${o.runId}: ${toErrorPayload(err).message}`);
    } finally {
      merging.delete(o.runId);
    }
  }
  // The watcher moves the task to done, cleans up and tells, as for a merge made on GitLab or GitHub.
  if (merged) void mrWatcher.check().then(onMrChanges, () => undefined);
}

/** A hub admin's app tells about alerts the hub opened (roadmap 22m-2); the watch asks once a minute at most. */
async function watchAlerts(): Promise<void> {
  const hub = `${config.hub.url}\n${config.hub.token}`;
  if (hub !== alertHub) {
    alertHub = hub;
    alertWatch.reset();
  }
  await alertWatch.tick();
}

function showAlert(notice: AlertNotice): void {
  if (!Notification.isSupported()) return;
  const n = new Notification(noticeText(tr, notice, (iso) => new Date(iso).toLocaleString(mainLocale())));
  // Alerts live in the hub's Web Admin, which this app does not have.
  n.on("click", () => void shell.openExternal(`${config.hub.url}/#/admin/alerts`));
  n.show();
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

// ── the leader chat in the app (roadmap 48) ─────────────────────────────────

const hubAccess = () => (config.mode === "hub" && config.hub.url && config.hub.token ? { url: config.hub.url, token: config.hub.token } : null);

/** Local mode: the machine this database's chats run on. On a hub, machines.list has it. */
function chatMachine(): Machine | null {
  return runner.localChatMachine();
}

/** A file for the project's chat: on the hub as the app's calls name it, or in the local database. */
async function chatUpload(project: unknown, name: unknown, bytes: unknown): Promise<ChatFile> {
  if (!(bytes instanceof Uint8Array)) throw new HiveError("bad_request", "No file.", { key: "errors.chatFileEmpty", vars: { name: String(name ?? "") } });
  const hub = hubAccess();
  if (hub) return hubChatUpload(hub, actor().name, String(project ?? ""), String(name ?? "file"), bytes, gitlabFetch);
  if (!(backend instanceof SqliteHive)) throw new HiveError("bad_request", "No database for the chat's files.");
  return backend.putChatFile({ project: String(project ?? ""), name: String(name ?? "file"), bytes }, actor());
}

/** A chat file's bytes and name, read as the app's user: with the machine's token, or from the local database. */
async function readChatFile(id: number): Promise<{ name: string; type: string; bytes: Uint8Array } | null> {
  const hub = hubAccess();
  if (hub) {
    const res = await gitlabFetch(`${hub.url}/api/chat/files/${id}`, { headers: { authorization: `Bearer ${hub.token}`, "x-hive-agent": actor().name } });
    if (!res.ok) return null;
    return { name: servedName(res.headers.get("content-disposition")) ?? `file-${id}`, type: res.headers.get("content-type") ?? "application/octet-stream", bytes: new Uint8Array(await res.arrayBuffer()) };
  }
  const file = backend instanceof SqliteHive ? backend.chatFile(id, actor()) : null;
  return file ? { name: file.name, type: file.type, bytes: file.bytes } : null;
}

/** hive-file://chat/<id> for the page: images and PDF as they are, anything else as plain text, never a page. */
function serveChatFiles(): void {
  protocol.handle(CHAT_FILE_SCHEME, async (request) => {
    const id = chatFileId(request.url);
    const file = id === null ? null : await readChatFile(id).catch(() => null);
    if (!file) return new Response("Not found", { status: 404 });
    const type = isImage(file.type) || file.type === "application/pdf" ? file.type : "text/plain; charset=utf-8";
    return new Response(new Uint8Array(file.bytes).buffer, { headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600" } });
  });
}

/** A chat file the person clicked: saved in a folder of the app and opened with what the system opens it with. */
async function openChatFile(url: string): Promise<void> {
  const id = chatFileId(url);
  const file = id === null ? null : await readChatFile(id).catch(() => null);
  if (!file || id === null) return;
  const dir = path.join(app.getPath("temp"), "xdev-hive-chat", String(id));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, chatFileName(file.name));
  writeFileSync(target, file.bytes, { mode: 0o600 });
  await shell.openPath(target);
}

/** A reply this machine wrote ended while the window was away: told, and a click opens its thread. */
async function onChatEnded(req: ChatRequest, status: "done" | "failed"): Promise<void> {
  if (!Notification.isSupported()) return;
  const shown = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused();
  const who = shown ? null : await me().then((m) => m.name, () => null);
  const notice = chatNotice(req, status, { me: who, windowShown: shown });
  if (!notice) return;
  const n = new Notification(notice);
  n.on("click", () => {
    showPage(`/chat?thread=${req.threadId}`);
  });
  n.show();
}

function knownPath(p: string): boolean {
  return config.projects.some((x) => x.repo === p) || runner.store.list({ limit: 500 }).some((r) => r.worktree === p);
}

function onRunnerEvent(event: RunnerEvent): void {
  if (!Notification.isSupported()) return;
  const r = event.run;
  if (event.type === "dispatched") {
    const n = new Notification({ title: tr("desktop.hubRunTitle"), body: tr("desktop.hubRunBody", { who: event.by, task: r.taskId, role: tr(`agentRole.${r.role}`) }) });
    n.on("click", () => {
      showPage("/tasks");
    });
    n.show();
    return;
  }
  const title = `${r.taskId} · ${r.profileId ?? ""}`;
  const pr = /\/pull\/\d+$/.test(r.mrUrl ?? "");
  const mr = r.mrUrl
    ? ` ${tr(r.mrState === "updated" ? (pr ? "desktop.prUpdated" : "desktop.mrUpdated") : pr ? "desktop.prCreated" : "desktop.mrCreated", { iid: r.mrIid ?? "", draft: r.mrDraft ? " (draft)" : "" })}`
    : r.mrState === "failed"
      ? ` ${tr("desktop.mrFailed", { note: r.mrNote ?? "" })}`
      : "";
  const body =
    event.type === "rotated"
      ? tr("desktop.runRotated", { profile: r.profileId ?? "", attempt: event.next.attempt })
      : event.type === "follow-up"
        ? tr("desktop.runFollowUp")
        : event.type === "judging"
          ? tr("desktop.judging")
          : event.type === "picked"
            ? tr(event.next ? "desktop.pickedReview" : "desktop.picked", { n: r.bestOf?.n ?? "?" })
            : event.type === "undecided"
              ? tr("desktop.undecided")
              : r.status === "succeeded"
                ? r.role === "review"
                  ? tr("desktop.reviewDone")
                  : tr("desktop.runDone", { count: r.commits })
                : `${tr(`runStatus.${r.status}`)}: ${r.error ?? ""}`;
  const n = new Notification({ title, body: body + mr });
  n.on("click", () => {
    showPage("/tasks");
  });
  n.show();
}

let mrWatchTimer: NodeJS.Timeout | null = null;
let lastMrCheckAt: number | null = null;

/**
 * (Re)arms the MR check from the period in the settings. One timeout re-armed after each check rather than a
 * setInterval, so a period saved on the Projects page applies without restarting the app.
 */
function scheduleMrWatch(): void {
  if (!mrWatcher) return;
  if (mrWatchTimer) clearTimeout(mrWatchTimer);
  const delay = mrPollDelay(lastMrCheckAt, config.gitlab.mr.pollMinutes, Date.now(), smokeShot ? 0 : 30_000);
  mrWatchTimer = setTimeout(() => {
    mrWatchTimer = null;
    lastMrCheckAt = Date.now();
    void mrWatcher
      .check()
      .then(onMrChanges, () => undefined)
      .finally(scheduleMrWatch);
  }, delay);
  mrWatchTimer.unref();
}

/** Tells about MRs that were merged or closed, and pipelines that failed. */
function onMrChanges(changes: MrChange[]): void {
  // The hub raises an alert for a pipeline that still fails once the fix runs are used up (roadmap 22m).
  if (config.mode === "hub") {
    for (const c of changes.filter((x) => x.fix?.kind === "limit")) {
      const r = c.run;
      void backend
        .call("runs.report", { kind: "ci_limit", project: r.project, taskId: r.taskId, taskTitle: r.taskTitle, runId: r.id, profileId: r.profileId, role: r.role, mrUrl: r.mrUrl, mrIid: r.mrIid }, actor())
        .catch(() => undefined);
    }
  }
  if (!Notification.isSupported()) return;
  for (const c of changes) {
    const mr = mrLabel(c.run);
    const body =
      c.status.to === "merged" && c.status.from !== "merged"
        ? c.taskError
          ? tr("desktop.mrMergedTaskFailed", { mr, reason: c.taskError })
          : c.taskNeedsReview
            ? tr("desktop.mrMergedNeedsReview", { mr })
            : tr(c.taskDone ? "desktop.mrMerged" : "desktop.mrMergedOnly", { mr })
        : c.status.to === "closed" && c.status.from !== "closed"
          ? c.taskError
            ? tr("desktop.mrClosedTaskFailed", { mr, reason: c.taskError })
            : c.taskStatus
              ? tr("desktop.mrClosedTask", { mr, status: tr(`taskStatus.${c.taskStatus}`) })
              : tr("desktop.mrClosed", { mr })
          : c.fix?.kind === "queued"
            ? tr("desktop.ciFixQueued", { mr, run: c.fix.run.id, n: c.fix.n, max: c.fix.max })
            : c.fix?.kind === "limit"
              ? tr("desktop.ciFixLimit", { mr, max: c.fix.max })
              : c.fix?.kind === "error"
                ? tr("desktop.ciFixFailed", { mr, reason: c.fix.reason })
                : c.pipeline.to === "failed"
                  ? tr("desktop.pipelineFailed", { mr })
                  : null;
    if (!body) continue;
    // Said with the merge, so a worktree the app kept (and why) is not a surprise later.
    const cleanup = c.cleanup ? cleanupNote(c.cleanup, branchFor(c.run.taskId)) : null;
    const n = new Notification({ title: `${c.run.taskId} · ${mr}`, body: cleanup ? `${body} ${cleanup}.` : body });
    n.on("click", () => {
      showPage("/tasks");
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
  handle("desktop:appInfo", () => ({ version: app.getVersion(), platform: process.platform }));
  handle("desktop:hubStatus", () => ({ mode: config.mode, url: config.hub.url, ...runner.hubState() }));
  handle("desktop:updateStatus", () => updater.status());
  handle("desktop:installUpdate", () => installAndRestart());
  handle("desktop:hubRetry", async () => {
    await runner.beat();
    return { mode: config.mode, url: config.hub.url, ...runner.hubState() };
  });
  handle("desktop:settings", settings);
  handle("desktop:updateSettings", updateSettings);
  handle("desktop:hubSignIn", hubSignIn);
  handle("desktop:hubSignInBrowser", hubSignInBrowser);
  handle("desktop:hubSignInCancel", () => browserSignIn?.abort());
  handle("desktop:setLocale", setLocale);
  handle("desktop:logError", (text: unknown) => appendCrashLog(crashLogPath(path.dirname(configPath())), `renderer: ${String(text)}`));
  handle("desktop:addProject", addProject);
  handle("desktop:scanRepos", scanRepos);
  handle("desktop:addProjects", addProjects);
  handle("desktop:gitlabGroup", gitlabGroup);
  handle("desktop:importGitlab", importGitlab);
  handle("desktop:removeProject", (name: string) =>
    persist({
      ...config,
      // A project that goes also goes from the others' reference repos (roadmap 38h), so no run looks for it.
      projects: config.projects
        .filter((p) => p.name !== name)
        .map((p) => (p.references?.includes(name) ? { ...p, references: p.references.filter((r) => r !== name) } : p))
        .map((p) => (p.references?.length === 0 ? { ...p, references: undefined } : p)),
    }),
  );
  handle("desktop:pickFolder", async () => {
    // Screenshots only: no one can answer a file dialog, so the folder the shot wants comes from the environment.
    if (smokeShot && process.env.HIVE_SMOKE_PICK_FOLDER) return process.env.HIVE_SMOKE_PICK_FOLDER;
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  handle("desktop:syncProject", syncAndMirror);
  handle("desktop:proposeAgents", (name: string) => proposeAgents(backend, actor(), project(name)));
  handle("desktop:installAgents", (name: string) => installAgents(project(name).repo, name, { shim: shimPath() }));
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
    tools: hubTools(),
    // Roadmap 47: repos this machine has that the hub no longer keeps, so Dự án & công cụ says so.
    archivedProjects: config.mode === "hub" ? (hubState?.archivedProjects ?? []) : [],
  }));
  handle("desktop:toolTrust", setToolTrust);
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
  handle("desktop:refreshUsage", (ids?: string[]) => refreshUsage(Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : undefined));
  handle("desktop:resetStats", (id: string) => (runner.resetStats(id), runner.profileStatuses()));
  handle("desktop:checkProfile", checkProfile);
  handle("desktop:openLogin", openLogin);
  handle("desktop:addAccount", addAccount);
  handle("desktop:recheckLogins", recheckLogins);
  handle("desktop:setProfileToken", setProfileToken);
  handle("desktop:openSetupToken", openSetupToken);
  handle("desktop:openCli", openCli);
  handle("desktop:startRun", (req: StartRunRequest) => runner.enqueue(req));
  handle("desktop:runs", (filter?: { project?: string; limit?: number }) => runner.list(filter));
  handle("desktop:runMessages", (id: string) => runner.messages(id));
  handle("desktop:runLog", (id: string) => runner.log(id));
  handle("desktop:runDiff", (id: string) => runner.diff(id));
  handle("desktop:steerRun", (id: string, text: string) => runner.steer(id, text));
  handle("desktop:cancelRun", (id: string): AgentRun => runner.cancel(id));
  handle("desktop:removeWorktree", (id: string) => runner.removeWorktree(id));
  handle("desktop:pickCandidate", (id: string) => runner.pick(id));
  handle("desktop:updateProject", updateProject);
  handle("desktop:checkGitLab", checkGitLab);
  handle("desktop:checkGitHub", checkGitHub);
  handle("desktop:createMergeRequest", createMergeRequest);
  handle("desktop:chatMachine", chatMachine);
  handle("desktop:chatUpload", chatUpload);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: smokeSize ? Number(smokeSize[1]) : 1240,
    height: smokeSize ? Number(smokeSize[2]) : 820,
    // The asked-for size is what the page gets, frame and title bar apart: the shot proves that width.
    ...(smokeSize ? { useContentSize: true } : {}),
    minWidth: smokeSize ? Math.min(820, Number(smokeSize[1])) : 820,
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
  win = window;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    // A chat file (an image opened full size): the system's viewer, not a window of the app.
    else if (chatFileId(url) !== null) void openChatFile(url).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (e, url) => {
    if (!(devUrl && url.startsWith(devUrl))) e.preventDefault();
    if (chatFileId(url) !== null) void openChatFile(url).catch(() => undefined);
  });
  // Closing the window keeps the app (and the runner taking work) going: in the menu bar on macOS, in the tray on
  // Windows and Linux. Quitting is the tray's Thoát (or Cmd+Q).
  window.on("close", (e) => {
    if (quitting || smokeShot) return;
    e.preventDefault();
    // No person can see this page while the app is in the tray; dispose its polling UI and keep only the runner.
    const currentUrl = window.webContents.getURL();
    if (currentUrl) lastWindowHash = new URL(currentUrl).hash.slice(1);
    window.destroy();
    if (process.platform !== "darwin" && !trayHintShown) {
      trayHintShown = true;
      showNotice(tr("desktop.trayHintTitle"), tr("desktop.trayHint"));
    }
  });
  window.on("closed", () => { if (win === window) win = null; });
  window.once("ready-to-show", () => {
    if (!smokeShot && !startHidden) window.show();
  });
  // A renderer that died (out of memory, a GPU crash) or a page that failed to load leaves the window blank: say so in
  // the log and load it again.
  const crashLog = crashLogPath(path.dirname(configPath()));
  let lastMemory: RendererMemorySample | null = null;
  const sampleMemory = () => {
    if (window.isDestroyed()) return;
    const pid = window.webContents.getOSProcessId();
    const metric = app.getAppMetrics().find((m) => m.pid === pid);
    if (metric) lastMemory = { at: Date.now(), pid, workingSetKB: metric.memory.workingSetSize, peakWorkingSetKB: metric.memory.peakWorkingSetSize, privateBytesKB: metric.memory.privateBytes };
  };
  window.webContents.on("did-finish-load", sampleMemory);
  const memoryTimer = setInterval(sampleMemory, 30_000);
  memoryTimer.unref();
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    // Navigation failures and a process crash may arrive together. A queued retry belongs only to this window.
    if (reloadTimer !== undefined) return "already-scheduled";
    if (quitting || window.isDestroyed()) return "closed";
    if (!rendererReloads.allow()) return "limit-reached";
    reloadTimer = setTimeout(() => {
      reloadTimer = undefined;
      if (!quitting && !window.isDestroyed()) window.webContents.reload();
    }, 2000);
    return "reload-scheduled";
  };
  window.on("closed", () => {
    clearInterval(memoryTimer);
    if (reloadTimer !== undefined) clearTimeout(reloadTimer);
  });
  window.webContents.on("render-process-gone", (_e, details) => {
    const recovery = details.reason === "clean-exit" ? "clean-exit" : scheduleReload();
    const text = rendererGoneText(details, lastMemory, process.memoryUsage().rss, recovery);
    appendCrashLog(crashLog, text);
    mainLog.write(text);
  });
  window.webContents.on("unresponsive", () => {
    appendCrashLog(crashLog, "unresponsive");
    mainLog.write("window unresponsive");
  });
  // Windows signs out or shuts down (powerMonitor's "shutdown" is macOS and Linux only).
  window.on("session-end", () => {
    mainLog.write("system: session-end");
    quitReasons.mark("shutdown", "session-end");
  });
  window.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    // -3 is a load another navigation replaced, not a failure.
    if (!isMainFrame || code === -3) return;
    const text = `did-fail-load: ${code} ${description} ${url}; recovery=${scheduleReload()}`;
    appendCrashLog(crashLog, text);
    mainLog.write(text);
  });

  const hash = process.env.HIVE_SMOKE_HASH ?? lastWindowHash;
  if (devUrl) void window.loadURL(hash ? `${devUrl}#${hash}` : devUrl);
  else void window.loadFile(path.join(import.meta.dirname, "../renderer/index.html"), hash ? { hash } : undefined);

  if (smokeShot) {
    const capture = () => {
      const delay = Number(process.env.HIVE_SMOKE_DELAY_MS ?? 1500);
      setTimeout(async () => {
        // HIVE_SMOKE_CLICK / HIVE_SMOKE_SCROLL: CSS selectors to click (several: joined by " && "), then to scroll to.
        const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const click = process.env.HIVE_SMOKE_CLICK;
        const scroll = process.env.HIVE_SMOKE_SCROLL;
        for (const sel of click ? click.split(" && ") : []) {
          // A page that loads more after its first paint (the CLI versions on Agent) may show the target late.
          for (let i = 0; i < 40; i++) {
            if (await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) break;
            await pause(200);
          }
          // A radix menu (the … of an Agent row) opens on pointerdown, so a click alone would leave it shut.
          await window.webContents
            .executeJavaScript(
              `(() => {
                 const el = document.querySelector(${JSON.stringify(sel)});
                 if (!el) return;
                 if (el.closest('[data-slot="dropdown-menu-trigger"]')) el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
                 else el.click();
               })()`,
            )
            .then(() => pause(700));
        }
        if (scroll) {
          await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(scroll)})?.scrollIntoView({ block: "start" })`).then(() => pause(300));
        }
        // HIVE_SMOKE_EXPECT: selectors (joined by " && ") that must be on the page within 8 s, or the shot fails:
        // a check of what rendered, not only a picture of it.
        const expect = process.env.HIVE_SMOKE_EXPECT;
        let missing: string | null = null;
        for (const sel of expect ? expect.split(" && ") : []) {
          let found = false;
          for (let i = 0; i < 40 && !found; i++) {
            found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
            if (!found) await pause(200);
          }
          if (!found) {
            missing = sel;
            break;
          }
        }
        // HIVE_SMOKE_ABSENT: selectors (joined by " && ") that must not be on the page, such as a menu entry left out.
        const absent = process.env.HIVE_SMOKE_ABSENT;
        let present: string | null = null;
        for (const sel of absent ? absent.split(" && ") : []) {
          if (await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)) {
            present = sel;
            break;
          }
        }
        // HIVE_SMOKE_ASSERT: JS expressions (joined by " && ") that must each be true in the page, for what no
        // selector can say — a menu that fits without scrolling, for one.
        const asserts = process.env.HIVE_SMOKE_ASSERT;
        let untrue: string | null = null;
        for (const expr of asserts ? asserts.split(" && ") : []) {
          let ok = false;
          for (let i = 0; i < 40 && !ok; i++) {
            ok = await window.webContents.executeJavaScript(`Boolean(${expr})`).catch(() => false);
            if (!ok) await pause(200);
          }
          if (!ok) {
            untrue = expr;
            break;
          }
        }
        const image = await window.webContents.capturePage();
        writeFileSync(smokeShot, image.toPNG());
        console.log(`[xdev-hive] smoke screenshot ${smokeShot}`);
        if (missing) console.error(`[xdev-hive] smoke expected ${missing} on the page`);
        if (present) console.error(`[xdev-hive] smoke did not expect ${present} on the page`);
        if (untrue) console.error(`[xdev-hive] smoke expected ${untrue} to be true on the page`);
        app.exit(missing || present || untrue ? 3 : 0);
      }, delay);
    };
    // HIVE_SMOKE_LOCALE=en / HIVE_SMOKE_THEME=dark / HIVE_SMOKE_VIEW / HIVE_SMOKE_SIDEBAR: the language, the theme,
    // the Task view and the sidebar live in the renderer's localStorage, so set them and reload first. The last two
    // are what the reader picked last, which would otherwise decide a shot (roadmap 39f).
    const stored = Object.entries({
      "xdev-hive.locale": process.env.HIVE_SMOKE_LOCALE,
      "hive-theme": process.env.HIVE_SMOKE_THEME,
      "hive-tasks-view": process.env.HIVE_SMOKE_VIEW,
      "hive-sidebar": process.env.HIVE_SMOKE_SIDEBAR,
    }).filter((e): e is [string, string] => Boolean(e[1]));
    window.webContents.once("did-finish-load", () => {
      if (!stored.length) return capture();
      const js = stored.map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("");
      void window.webContents.executeJavaScript(js).then(() => {
        window.webContents.once("did-finish-load", capture);
        window.webContents.reload();
      });
    });
  }
}

function showWindow(): void {
  startHidden = false;
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens the window on a page ("/tasks"): one made now loads straight there, as the closed one has no renderer left. */
function showPage(hash: string): void {
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${hash}`)}`).catch(() => undefined);
  } else {
    lastWindowHash = hash;
  }
  showWindow();
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
        showPage("/proposals");
      });
      n.show();
    }
    lastPending = pending;
  } catch {
    tray.setToolTip(`xDev Hive: ${tr("desktop.sourceUnreachable")}`);
  }
}

/** Built again when the interface language changes. */
/** Windows: the tray's balloon; elsewhere a notification (the menu bar app on macOS needs none). */
function showNotice(title: string, content: string): void {
  if (process.platform === "win32" && tray) tray.displayBalloon({ title, content, iconType: "info" });
  else if (Notification.isSupported()) new Notification({ title, body: content }).show();
}

/** Starting with the computer: macOS and Windows (Linux desktops each have their own autostart). */
const canStartAtLogin = process.platform === "darwin" || process.platform === "win32";

function buildTrayMenu(): void {
  const atLogin = canStartAtLogin && app.isPackaged ? app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin : null;
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: tr("desktop.trayOpen"), click: showWindow },
      { label: tr("desktop.trayProposals"), click: () => showPage("/proposals") },
      { type: "separator" },
      ...(atLogin === null
        ? []
        : [
            {
              label: tr("desktop.trayStartAtLogin"),
              type: "checkbox" as const,
              checked: atLogin,
              click: (item: Electron.MenuItem) => {
                // In the tray on Windows; macOS opens it like any login item.
                app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
                buildTrayMenu();
              },
            },
            { type: "separator" as const },
          ]),
      { label: tr("desktop.trayQuit"), click: () => quitByUser("tray") },
    ]),
  );
}

/**
 * macOS: Electron's default menu, but with a Quit (Cmd+Q) of our own, so a quit the person asked for is told apart
 * from one the system or a signal started. Windows and Linux keep their default menu (quitting is the tray's).
 */
function buildAppMenu(): void {
  if (process.platform !== "darwin") return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { label: tr("desktop.trayQuit"), accelerator: "Command+Q", click: () => quitByUser("menu") },
        ],
      },
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

/** The renderer tells the language it shows; the tray and notifications follow it (kept in config.json). */
function setLocale(locale: unknown): void {
  if (!setMainLocale(locale)) return;
  config = { ...config, locale };
  saveConfig(config);
  buildTrayMenu();
  buildAppMenu();
  void refreshTray();
  // Machine setup items carry their labels: check again so they come back in the new language.
  void refreshSetup().catch(() => undefined);
}

function createTray(): void {
  // macOS: a template image the menu bar tints. Windows and Linux show it as it is, and a black X is lost on a dark
  // taskbar: the app's own icon there.
  const icon = process.platform === "darwin" ? nativeImage.createFromPath(trayIcon()) : nativeImage.createFromPath(appIcon()).resize({ width: 32, height: 32, quality: "best" });
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("xDev Hive");
  // Windows and Linux: a click opens the window (the menu is on the right button); macOS opens the menu.
  if (process.platform !== "darwin") tray.on("click", showWindow);
  buildTrayMenu();
  void refreshTray();
  setInterval(() => void refreshTray(), 20_000).unref();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const afterUpdate = !smokeShot && takeStartHidden(path.join(path.dirname(configPath()), "updates"));
  if (afterUpdate) startHidden = true;
  mainLog.write(`start ${app.getVersion()} pid ${process.pid} ${process.platform}/${process.arch}${startHidden ? " hidden" : ""}${afterUpdate ? " (started again by the updater)" : ""}`);
  app.on("second-instance", showWindow);
  let stopped = false;
  app.on("before-quit", (e) => {
    quitting = true;
    if (stopped) return;
    if (!runner) return mainLog.write(`${quitReasons.describe()} before the app was ready`);
    // Stop agents and let the runner commit their work and update Hive before exiting.
    e.preventDefault();
    stopped = true;
    const reason = quitReasons.reason;
    // Read before the runner stops, which ends the runs it would be asked about.
    const active = runner.store.active().length;
    const takesWork = config.runner.acceptHubRuns || active > 0;
    mainLog.write(`${quitReasons.describe()}; runs ${active}, acceptHubRuns ${config.runner.acceptHubRuns}`);
    void runner
      .stop()
      .then(() => {
        mainLog.write("runner stopped");
        // The rollout says "install when the app quits": the helper swaps the build once this process is gone, and
        // starts it again (hidden) only when relaunchAfterQuitInstall says so: a machine taking work that the person
        // did not quit on purpose. "now"/"restart"/"idle" installs go through installAndRestart, unchanged.
        if (!updater.installsOn("quit")) return;
        const relaunch = relaunchAfterQuitInstall(reason, takesWork);
        return updater.install({ relaunch, hidden: relaunch }).catch(() => undefined);
      })
      .catch((err) => mainLog.write(`runner stop failed: ${toErrorPayload(err).message}`))
      .finally(() => app.quit());
  });
  app.on("will-quit", () => mainLog.write("will-quit"));
  app.on("quit", (_e, code) => mainLog.write(`exit ${code}`));
  // The GPU process, a utility process or a helper dying: the window may go blank, the app may follow.
  app.on("child-process-gone", (_e, d) => mainLog.write(`child-process-gone: ${d.type}${d.name ? ` ${d.name}` : ""} ${d.reason} (exit ${d.exitCode})`));
  // Electron quits on these itself; listening keeps that (app.quit, so the runner still stops its agents first) and
  // says which one it was. once: a second Ctrl+C or kill falls back to the default and ends a quit that hangs.
  if (process.platform !== "win32" && !smokeShot) {
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(sig, () => {
        mainLog.write(`signal ${sig}`);
        quitReasons.mark("signal", sig);
        app.quit();
      });
    }
  }
  app.on("activate", showWindow);
  // Electron otherwise quits on Windows and Linux when the last window is destroyed; the tray owns app lifetime.
  app.on("window-all-closed", () => {});
  void app.whenReady().then(() => {
    // The heartbeat stops while the computer sleeps: say when, so a gap on the hub can be matched with it.
    powerMonitor.on("suspend", () => mainLog.write("system: suspend"));
    powerMonitor.on("resume", () => mainLog.write("system: resume"));
    powerMonitor.on("shutdown", () => {
      mainLog.write("system: shutdown");
      quitReasons.mark("shutdown", "powerMonitor");
    });
    try {
      reload();
    } catch (err) {
      // Not showErrorBox: it blocks the main process until someone clicks it, and a runner started hidden at sign-in
      // then sends no heartbeat at all (BUG-config-silent). The message box waits on its own; the app goes on.
      const reason = toErrorPayload(err).message;
      mainLog.write(`config: cannot use ${configPath()}: ${reason}; running in local mode`);
      if (!configIssues.some((i) => i.section === "file")) configIssues = [...configIssues, { section: "file", id: null, field: "", message: reason, action: "default" }];
      // A file that read but whose hub cannot be used (hub mode without a token) keeps its profiles and projects.
      config = { ...(config ?? configSchema.parse({})), mode: "local" };
      backend = resolveBackend(config);
      if (!smokeShot) void dialog.showMessageBox({ type: "error", title: "xDev Hive", message: tr("desktop.badConfig", { path: configPath(), reason }) });
    }
    mrHostRef = {
      gitlab: () => config.gitlab,
      github: () => config.github,
      projects: () => config.projects,
      backend: () => backend,
      mode: () => config.mode,
      store: () => runner.store,
      fetch: gitlabFetch,
      user: os.userInfo().username,
    };
    mergeRequester = new MergeRequester(mrHostRef);
    mrWatcher = new MrWatcher(mrHostRef, new CiFixer({ ...mrHostRef, enqueue: (req, extra) => runner.enqueue(req, extra) }));
    logins = new LoginMonitor(() => config.agents, agentEnv, undefined, undefined, (id, usage) => {
      if (usage.session && usage.week) runner.store.recordUsage(id, { at: usage.checkedAt, session: usage.session.percent, week: usage.week.percent, sessionResetsAt: usage.session.resetsAt ?? null }, new Date());
    });
    alertWatch = new AlertWatch({
      me: () => me(),
      list: () => fetchAlerts({ url: config.hub.url, token: config.hub.token }, gitlabFetch),
      notify: showAlert,
    });
    updater = new Updater({
      version: app.getVersion(),
      dataDir: path.dirname(configPath()),
      hub: () => (config.mode === "hub" && config.hub.url && config.hub.token ? { url: config.hub.url, token: config.hub.token } : null),
      // Never for a dev build or a smoke run: they would replace the app they run from.
      packaged: app.isPackaged && !smokeShot,
      platform: process.platform,
      execPath: process.execPath,
      appImage: process.env.APPIMAGE,
      onChange: onUpdateChange,
      log: (line) => mainLog.write(line),
    });
    runner = new Runner(
      {
        backend: () => backend,
        profiles: () => config.agents,
        settings: () => config.runner,
        projects: () => config.projects,
        mode: () => config.mode,
        machine: () => config.machine,
        env: agentEnv,
        // platform, arch and update are read by the hub itself (app updates, roadmap 22i); core ignores them.
        report: () => ({ setup: setupCache ?? undefined, profiles: reportedProfiles(), platform: platformKey(process.platform), arch: process.arch, update: updater.report() }),
        login: (id) => logins.get(id),
        usage: (id) => logins.usage(id),
        hub: () => (config.mode === "hub" && config.hub.url && config.hub.token ? { url: config.hub.url, token: config.hub.token } : null),
        token: (id) => config.agentTokens[id],
        gitlab: () => config.gitlab.url || null,
        toolTrust: () => config.toolTrust,
        applyToolTrust: (toolTrust) => {
          persist({ ...config, toolTrust });
        },
      },
      {
        dataDir: path.dirname(configPath()),
        version: app.getVersion(),
        onEvent: (event) => {
          // A run that ended (on its own, rotated or before its follow-up) left Codex's newest limits in its session file.
          if (event.type !== "dispatched" && event.run.profileId) logins.rereadUsage(event.run.profileId);
          onRunnerEvent(event);
        },
        afterFinish: (run) => mergeRequester.afterFinish(run),
        // What a Spec Kit step just wrote, to the hub once it knows the run ended: a flow there waits for it (roadmap 34b).
        afterReport: (run) => pushSpecsOf(run.project),
        onHub,
        sync: (p) => syncAndMirror(p.name),
        onChat: (req, status) => void onChatEnded(req, status).catch(() => undefined),
        // The chat's own machine reads a message's files as the runner: the database hands it only sent ones.
        chatFile: (id) => (backend instanceof SqliteHive ? (backend.chatFile(id, { name: "runner", role: "agent" })?.bytes ?? null) : null),
      },
    );
    setup = new Setup({
      ...(smokeShot ? { latest: async () => null } : {}),
      pathEnv: (refresh) => agentPath(refresh),
      env: agentEnv,
      projects: () => config.projects,
      shim: { electronPath: process.execPath, entry: mcpEntry() },
      registry: process.platform === "win32" ? windowsUserPath() : undefined,
      cliBusy: (kind) => runner.runningOfKind(kind),
      holdCli: (kind, held) => runner.holdKind(kind, held),
      tools: hubCatalog,
      toolTrust: () => config.toolTrust,
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
    // Docs the repo keeps (roadmap 26): its main fetched and mirrored into Hive shortly after start, then every 10 minutes.
    const mirror = () => void mirrorAll().catch(() => undefined);
    if (!smokeShot) setTimeout(mirror, 90_000).unref();
    setInterval(mirror, 10 * 60_000).unref();
    // Open MRs and PRs (state and pipeline on GitLab, checks on GitHub): shortly after start, then every pollMinutes.
    scheduleMrWatch();
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(appIcon());
    registerIpc();
    serveChatFiles();
    if (!startHidden || smokeShot) createWindow();
    buildAppMenu();
    if (!smokeShot) createTray();
  });
}
