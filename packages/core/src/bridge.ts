import type { WorktreeReport, WorktreeTarget, WorktreeCommand } from "#core/worktrees.ts";
import type { DiffReview } from "#core/diff-review.ts";
// Contracts between the shared UI and its hosts (web hub, desktop main process). Types only.
import type { Access, Grant } from "./access.ts";
import type { ProfileAutonomy } from "./agent-policy.ts";
import type { ModelSelection } from "./model-router.ts";
import type { AgentKind, AgentProfile, AgentRole, PlanUsage, PreferKind, RunnerSettings, RunStatus } from "./agents.ts";
import type { GitLabImportCandidate, GitLabImportResult, MrSettings, MrState, MrStatus, PipelineStatus } from "./gitlab.ts";
import type { TransferReport } from "./transfer.ts";
import type { ChatFile, Machine, MachineCommand, Proposal, Role, RunMessage, RunCompression, SetupItem, SetupReport, TeamPolicy, TokenWindows, ToolHandler, ToolKind, WebhookEvent, WebhookKind } from "./types.ts";

/**
 * A hub tool as the machine's Setup card shows it (roadmap 28b): what it will run here, for the user to allow.
 * trust: app: the app's own commands for it, nothing to allow · trusted: allowed as it is · new: never allowed ·
 * changed: allowed before, the commands changed since (a new version).
 */
export interface MachineToolView {
  id: string;
  name: string;
  kind: ToolKind;
  license: string;
  homepage: string | null;
  /** Each command with `{package}` written out; `{worktree}` and `{repo}` stay, being per run. */
  commands: Array<{ field: string; argv: string[] }>;
  env: Record<string, string>;
  /** Names only: their values come from this machine (a profile's env, or its own). */
  secretEnv: string[];
  hash: string;
  trust: "app" | "trusted" | "new" | "changed";
  /** This machine's projects that have it on. */
  projects: string[];
  /** For the setup items it stands for (toolSetupItems): a seed keeps the app's own items. */
  handler: ToolHandler | null;
  /** Those of this machine's projects that require it: its setup items count as required (roadmap 28b-2). */
  required: string[];
}

export interface Me {
  name: string;
  role: Role;
  mode: "local" | "hub";
  /** Hub account behind the session or token (absent for tokens of no account, and in local mode). */
  user?: { id: string; username: string; displayName: string; admin: boolean; mustChangePassword: boolean };
  /** Per-project grants of a restricted account (see access.ts); absent = unrestricted. */
  access?: Access;
  /** The hub signs people in through an OpenID Connect provider too (session of an account only). */
  sso?: { name: string; linked: boolean };
}

export interface TokenInfo {
  id: string;
  name: string;
  role: Role;
  /** Account the token belongs to; null for tokens of no account (they keep the role-only rules). */
  ownerId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A chat webhook as hub admins see it: the URL is a secret, so only a hint of it comes back. */
export interface WebhookInfo {
  id: number;
  name: string;
  kind: WebhookKind;
  /** e.g. "https://hooks.slack.com/…/x9Qa" */
  urlHint: string;
  events: WebhookEvent[];
  /** Only these projects' events; empty: every project and the shared data. */
  projects: string[];
  /** Language of the messages. */
  locale: string;
  enabled: boolean;
  createdAt: string;
  lastSentAt: string | null;
  /** The last send's error; null after a success. */
  lastError: string | null;
}

export interface WebhookInput {
  id?: number;
  name: string;
  kind: WebhookKind;
  /** Required for a new webhook; omit on an update to keep the stored one. */
  url?: string;
  events: WebhookEvent[];
  projects: string[];
  locale: string;
  enabled: boolean;
}

/** A person's hub account, as admins manage it. */
export interface HubUser {
  id: string;
  username: string;
  displayName: string;
  admin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Project → role or permissions (roadmap 25); admins see every project whatever this says. */
  grants: Record<string, Grant>;
  /** The shared data (Chung); null: view, and propose / write memory where the account may in some project. */
  shared: Grant | null;
  /** Signs in through the hub's OpenID Connect provider (linked, or created by it). */
  sso: boolean;
}

export interface FileAction {
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "removed";
  note?: string;
}

/** The merge request (pull request on GitHub) a sync in MR mode opened or updated (roadmap 38c). */
export interface SyncMr {
  url: string;
  iid: number;
  /** The branch the docs went to; the user's checkout keeps its own branch and its unfinished work. */
  branch: string;
  state: "created" | "updated";
}

export interface SyncReport {
  project: string;
  files: FileAction[];
  /** Doc keys created in Hive from files that already existed in the repo. */
  imported: string[];
  /** Short hash of the commit made by the sync, if any; in MR mode it is on the docs branch, not the checkout. */
  commit: string | null;
  /** The merge request the docs went into (roadmap 38c); absent when the sync committed into the checkout. */
  mr?: SyncMr;
  /** The repo keeps an AGENTS.md of its own (roadmap 38f), so it can be proposed into Hive instead of overwritten. */
  ownAgents: boolean;
  note?: string;
  /** The repo's docs mirrored into Hive (roadmap 26), when the project has a .xdev-hive/docs.json. */
  mirror?: MirrorReport;
}

export interface MirrorReport {
  /** The commit mirrored (short), null when the project mirrors nothing. */
  commit: string | null;
  /** Pages saved as a new version. */
  changed: string[];
  unchanged: number;
  /** Files the config names that the branch does not have. */
  missing: string[];
  /** Pages this machine's account may not write, with why. */
  skipped: Array<{ key: string; reason: string }>;
}

export interface ShimReport {
  path: string;
  /** Whether the shim's folder is on PATH of the desktop process (GUI apps may see a shorter PATH than your shell). */
  onPath: boolean;
}

export interface DesktopProject {
  /** Local commands only: never included in heartbeat or hub settings. prepare bumps version/roadmap. */
  autoRelease?: { appRollout: boolean; prepare: string[]; release: string[]; deploy?: string[]; checkLogs?: string[]; timeoutMinutes: number };
  name: string;
  repo: string;
  gitlabProject?: string;
  /** owner/repo on GitHub; set, or read from a GitHub remote, the project gets pull requests instead of GitLab MRs. */
  githubRepo?: string;
  targetBranch?: string;
  /** Projects of this machine whose checkout a run of this one reads, read-only (roadmap 38h). */
  references?: string[];
}

/** A repository found inside a folder that is not one itself (roadmap 38d), as the app offers to add it. */
export interface RepoCandidate {
  dir: string;
  /** Its path under the folder that was scanned, which is what the person recognises it by. */
  rel: string;
  key: string;
  /** What `origin/HEAD` says; null when the repository has no remote (nothing cloned it). */
  targetBranch: string | null;
  /** added: a project of this app has that folder already (not offered again) · new: would be added. */
  state: "added" | "new";
}

/** What a folder holds: itself a repository, or repositories below it. */
export interface RepoScan {
  root: string;
  isGit: boolean;
  /** Empty when the folder is a repository itself, or when nothing was found under it. */
  repos: RepoCandidate[];
  /** The system the repositories would go into: the folder's name, made to fit a system name. */
  system: string;
}

export interface RepoImportResult {
  key: string;
  dir: string;
  ok: boolean;
  error: string | null;
}

export interface DesktopSettings {
  mode: "local" | "hub";
  /** Name of this machine in hub leases (config.json `machine`). */
  machine: string;
  hubUrl: string;
  hasHubToken: boolean;
  projects: DesktopProject[];
  memoryRequiresApproval: boolean;
  autoCommit: boolean;
  configPath: string;
  dbPath: string;
  runner: RunnerSettings;
  gitlab: { url: string; hasToken: boolean; mr: MrSettings };
  /** Pull requests on GitHub; they follow the MR options in `gitlab.mr`. */
  github: { url: string; hasToken: boolean };
  /** Parts of config.json the app could not read at the last load (left out or defaulted); empty when it read all of it. */
  configIssues: ConfigIssue[];
}

/** A part of config.json that did not parse (BUG-config-silent). */
export interface ConfigIssue {
  /** Top-level key: `agents`, `projects`, `runner`…; `file` when the file itself could not be read. */
  section: string;
  /** The profile id or project name (`#2` when it has none); null for a key that is not a list. */
  id: string | null;
  /** Path inside the entry or key, e.g. `account`; empty for the whole of it. */
  field: string;
  message: string;
  /** skipped: the entry is left out; default: the key's default is used instead. */
  action: "skipped" | "default";
}

export interface DesktopSettingsPatch {
  mode?: "local" | "hub";
  hubUrl?: string;
  /** Empty string keeps the saved token. */
  hubToken?: string;
  memoryRequiresApproval?: boolean;
  autoCommit?: boolean;
  runner?: Partial<RunnerSettings>;
  /** Empty token keeps the saved one. */
  gitlab?: { url?: string; token?: string; mr?: Partial<MrSettings> };
  /** Empty token keeps the saved one. */
  github?: { url?: string; token?: string };
}

export interface GitLabCheck {
  ok: boolean;
  user: string | null;
  message: string;
}

export interface SetupInstallResult {
  /** The item as re-checked after installing. */
  item: SetupItem;
  /** Tail of the installer output (npm, codegraph…) or the files written. */
  output: string;
}

/** Whether a profile's CLI is signed in, from the CLI's own status command run with the profile's env. */
export interface LoginStatus {
  /** null: the CLI has no status command (Gemini, custom), is missing, or gave an answer we could not read. */
  loggedIn: boolean | null;
  /** How it is signed in, as the CLI puts it (e.g. "claude.ai", "ChatGPT"). */
  method: string | null;
  /** The account's email when the CLI says (Claude Code), to tell several accounts of one vendor apart. */
  account?: string | null;
  /** What to run in a terminal to sign in, with the profile's login dir (never its other env). */
  loginCommand: string | null;
  checkedAt: string;
}

/** How a profile signs in (roadmap 24b): always the CLI's own sign-in, with one of its options. */
export interface LoginHow {
  /** Claude Code: through the company's SSO (`--sso`). */
  sso?: boolean;
  /** Claude Code: an Anthropic Console account, billed by API use (`--console`), instead of a Claude plan. */
  console?: boolean;
  /** Claude Code: the email the sign-in page starts with (`--email`). */
  email?: string;
  /** Codex: a code to enter in a browser, on this machine or another (`--device-auth`). */
  device?: boolean;
}

/** One more subscription on this machine: a profile with a sign-in folder of its own, signed in right away. */
export interface NewAccount {
  kind: "claude" | "codex" | "antigravity" | "gemini" | "vibe" | "opencode" | "kilo" | "copilot";
  label?: string;
  how?: LoginHow;
}

export interface AgentProfileStatus extends AgentProfile {
  /** null/absent: discovery unavailable, not evidence of support. */
  supportedModels?: string[] | null;
  running: number;
  /** Set while the subscription is resting after a rate limit (or a missing CLI). */
  cooldownUntil: string | null;
  cooldownReason: string | null;
  /** Hub actor of the machine that reported the rest, when it came from the hub (shared account). */
  cooldownFrom: string | null;
  /** Where the profile's CLI resolves on the login-shell PATH; null = not installed. */
  cliPath: string | null;
  /** Last sign-in check; null before the first one. */
  login: LoginStatus | null;
  /** Plan usage from the CLI (Claude Code, signed in with a subscription); null when unknown. */
  usage: PlanUsage | null;
  /** A long-lived token is saved for container runs (the token itself stays in the main process). */
  hasToken: boolean;
  lastUsedAt: string | null;
  /**
   * costUsd: sum of the runs' API-price estimates (Claude Code runs only). since: when the person last reset the
   * counter (roadmap 52); every count is from then on, null: from the first run.
   */
  stats: { runs: number; succeeded: number; failed: number; rateLimited: number; costUsd: number; since: string | null };
  /** Its runs' tokens and cache over 24 hours, 7 and 30 days, from this machine's runs.db (roadmap 46). */
  tokens: TokenWindows;
  /** Its own flags' autonomy and what runs get under the agent policy the machine last heard from the hub. */
  autonomy: ProfileAutonomy;
}

export interface AgentRun {
  timeoutMinutes?: number | null;
  /** Resume hint saved after a timeout, including the last activity and committed branch tip. */
  continuation?: string | null;
  plan?: import("#core/plan-approval.ts").RunPlan | null;
  diffReview?: DiffReview | null;
  diffSummaryFor?: string | null;
  diffPatch?: string | null;
  id: string;
  project: string;
  taskId: string;
  taskTitle: string;
  role: AgentRole;
  status: RunStatus;
  /** Profile that ran (or is running) this attempt. */
  profileId: string | null;
  /** Pinned by the admin; null = rotate automatically. */
  preferredProfile: string | null;
  /** A kind to wait for while one of its profiles could take the run; null = any (roadmap 24c). */
  preferKind: PreferKind | null;
  /** Kinds to avoid, e.g. the implementer's kind for a cross-review. */
  avoidKinds: AgentKind[];
  excludedProfiles: string[];
  attempt: number;
  maxAttempts: number;
  parentRunId: string | null;
  redispatch?: import("#core/types.ts").RunRedispatch & { crossMachine?: boolean } | null;
  worktree: string | null;
  branch: string | null;
  baseSha: string | null;
  instructions: string;
  reviewAfter: boolean;
  exitCode: number | null;
  summary: string | null;
  error: string | null;
  commits: number;
  headSha: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Merge request opened/updated for this run's branch. */
  mrUrl: string | null;
  mrIid: number | null;
  mrState: MrState | null;
  mrDraft: boolean;
  mrNote: string | null;
  /** What the app last saw of the MR on GitLab (it checks open ones every few minutes). */
  mrStatus: MrStatus | null;
  pipelineStatus: PipelineStatus | null;
  pipelineUrl: string | null;
  mrCheckedAt: string | null;
  ciFix: CiFix | null;
  /** One of several candidates for the task, or the judge that compares them (see BestOf). */
  bestOf: BestOf | null;
  /**
   * Who asked for it on the web (a hub run request), kept by the runs that follow from it; null: started on this
   * machine, which the hub counts as its token's account. For spending caps per person (roadmap 27b).
   */
  requestedBy: string | null;
  /**
   * The run has ended and the app is still on what comes after it (the Hive note, the MR, a follow-up run).
   * Set by the runner's list only, so the interface keeps refreshing until those land on the run.
   */
  finishing?: boolean;
  /** A running agent's current step (Claude Code's own summary, its last tool call, or the last line it printed); list only. */
  activity?: string;
  /** From the CLI's JSON result (Claude Code): estimated at API prices, which a subscription does not bill. */
  costUsd: number | null;
  /**
   * Input tokens read fresh, without what was written to or read from the prompt cache (roadmap 28c). Runs from before
   * 28c have the three added up here and null below.
   */
  inputTokens: number | null;
  cacheWriteTokens: number | null;
  cacheReadTokens: number | null;
  outputTokens: number | null;
  skills?: string[];
  /** What RTK left out of its Bash output (roadmap 28d); null or left out: no RTK, or no numbers. */
  compression?: RunCompression | null;
  /** The hub's model choice it was asked with (roadmap 54c); null or left out: none (older hub, or routing off). */
  selection?: ModelSelection | null;
  /**
   * What it ran on (roadmap 54a), read from the args once the policy fitted the profile: the profile's kind, and the
   * model and effort the args set (null: the CLI's default). Left out or null before it started.
   */
  agentKind?: AgentKind | null;
  model?: string | null;
  effort?: string | null;
}

/** A run queued because the pipeline of a merge request failed. */
export interface CiFix {
  mrUrl: string;
  mrIid: number | null;
  pipelineId: number;
  pipelineUrl: string | null;
  /** This is fix n of max for the MR. */
  n: number;
  max: number;
  /** Failed jobs (at most 3), each with the cleaned end of its log. */
  jobs: Array<{ name: string; stage: string; url: string; log: string }>;
}

/**
 * Best-of-n: 2–4 agents implement the same task, each on its own branch (ai/<task>+c<n>), then a judge
 * on another vendor compares the branches and keeps one, which moves to ai/<task> and goes on as usual.
 */
export interface BestOf {
  /** Shared by the candidates and their judge. */
  group: string;
  /** 1..of for a candidate; 0 for the judge. */
  n: number;
  of: number;
  /** Commit the candidates start from. */
  from: string;
  /** Once decided: the candidate kept (0 = none finished), and why. */
  pick: number | null;
  reason: string | null;
}

export interface StartRunRequest {
  timeoutMinutes?: number | null;
  project: string;
  taskId: string;
  role?: AgentRole;
  /** Pin a profile; omit to rotate. */
  profileId?: string | null;
  /** Unpinned: wait for a profile of this kind while one could take the run, then any (roadmap 24c). */
  preferKind?: PreferKind | null;
  instructions?: string;
  /** After success, queue a review on a different agent kind. */
  reviewAfter?: boolean;
  /** Implement 2–4 times on different subscriptions and keep the best (judged by another vendor); default 1. */
  candidates?: number;
  /** The hub's model choice (roadmap 54c), from its run request; a run started on the machine itself has none. */
  selection?: ModelSelection | null;
}

export interface ProfileCheck {
  ok: boolean;
  path: string | null;
  output: string;
}

/** The app's own update (roadmap 22i): what the hub offered and how far it got. */
export interface AppUpdateStatus {
  state: "idle" | "downloading" | "ready" | "installing" | "failed";
  version: string | null;
  percent: number | null;
  error: string | null;
  installWhen: "ask" | "quit" | "idle" | null;
  notes: string | null;
  supported: boolean;
  /** deb: installed through the system installer, with admin rights, instead of a restart. */
  updateKind?: "deb";
  idleState?: "waiting" | "retry" | null;
  idleDeadline?: number | null;
}

/** Whether this machine's last heartbeat reached the hub (hub mode); ok null before the first one or in local mode. */
export interface HubConnection {
  mode: "local" | "hub";
  url: string;
  ok: boolean | null;
  checkedAt: string | null;
  lastOkAt: string | null;
  /** The last failure: "unavailable" when the hub could not be reached at all. */
  code: string | null;
  error: string | null;
}

export interface DesktopBridge {
  /** The app's own version and the OS it runs on (sidebar footer, status bar, macOS window chrome). */
  appInfo(): Promise<{ version: string; platform: string }>;
  /** The hub connection as the last heartbeat found it; hubRetry sends a heartbeat now. */
  hubStatus(): Promise<HubConnection>;
  hubRetry(): Promise<HubConnection>;
  /** The update the hub offered this machine; installUpdate restarts into it. */
  updateStatus(): Promise<AppUpdateStatus>;
  installUpdate(): Promise<void>;
  settings(): Promise<DesktopSettings>;
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
  /** The interface language, for what the main process shows itself (tray, notifications, dialogs). */
  setLocale(locale: string): Promise<void>;
  /** A crash the interface caught (or an error nobody handled), for the app's log; older apps have none. */
  logError?(text: string): Promise<void>;
  /** Hub mode with a hub account: the hub issues this machine a token that belongs to the account. */
  hubSignIn(input: { hubUrl: string; username: string; password: string }): Promise<DesktopSettings>;
  /** The same through the browser (SSO or password on the hub's page); waits until allowed, denied or cancelled. */
  hubSignInBrowser(input: { hubUrl: string }): Promise<DesktopSettings>;
  hubSignInCancel(): Promise<void>;
  addProject(project: DesktopProject): Promise<DesktopSettings>;
  /** Whether a folder is a repository, and the repositories under it when it is not (roadmap 38d). */
  scanRepos(dir: string): Promise<RepoScan>;
  /** Adds several repositories at once (what scanRepos found); one failing does not stop the rest. */
  addProjects(items: DesktopProject[]): Promise<{ results: RepoImportResult[]; settings: DesktopSettings }>;
  /** The repositories of a GitLab group (and its subgroups) with the key and folder each would get (roadmap 19a). */
  gitlabGroup(input: { group: string; baseDir: string }): Promise<GitLabImportCandidate[]>;
  /** Clones the chosen ones (ssh or https) and adds them as projects; one failing does not stop the rest. */
  importGitlab(input: { items: Array<{ key: string; pathWithNamespace: string; dir: string }>; protocol: "ssh" | "https"; group: string }): Promise<{
    results: GitLabImportResult[];
    settings: DesktopSettings;
  }>;
  removeProject(name: string): Promise<DesktopSettings>;
  pickFolder(): Promise<string | null>;
  syncProject(name: string): Promise<SyncReport>;
  /** The repo's own AGENTS.md as a proposal on its Hive page (roadmap 38f), for a Context agent to review. */
  proposeAgents(name: string): Promise<Proposal>;
  installAgents(name: string): Promise<FileAction[]>;
  installShim(): Promise<ShimReport>;
  showInFolder(path: string): Promise<void>;

  profiles(): Promise<AgentProfileStatus[]>;
  saveProfile(profile: AgentProfile, previousId?: string): Promise<AgentProfileStatus[]>;
  removeProfile(id: string): Promise<AgentProfileStatus[]>;
  resetCooldown(id: string): Promise<AgentProfileStatus[]>;
  /** Reads the sign-in and plan usage again (roadmap 52): the given profiles, or every enabled one. One read at a time. */
  refreshUsage(ids?: string[]): Promise<AgentProfileStatus[]>;
  /** Counts the profile's runs from now on; its run history stays (roadmap 52). */
  resetStats(id: string): Promise<AgentProfileStatus[]>;
  checkProfile(id: string): Promise<ProfileCheck>;
  /** Opens a terminal running the profile's sign-in command (Claude Code, Codex). */
  openLogin(id: string, how?: LoginHow): Promise<{ opened: boolean }>;
  /** Adds a profile for another account (its own sign-in folder; the first of a kind uses the CLI's usual one) and opens its sign-in. */
  addAccount(account: NewAccount): Promise<{ id: string; profiles: AgentProfileStatus[] }>;
  /** Checks the signed-out profiles again (after the user signed in elsewhere). */
  recheckLogins(): Promise<AgentProfileStatus[]>;
  /** Saves (or with "" removes) the profile's long-lived token for container runs. */
  setProfileToken(id: string, token: string): Promise<AgentProfileStatus[]>;
  /** Opens a terminal running `claude setup-token` with the profile's login folder. */
  openSetupToken(id: string): Promise<{ opened: boolean }>;
  /** Opens a terminal running the profile's CLI in a project's repo, for the person to work in (roadmap 32a). */
  /** bypass: the CLI's own switch to skip its permission prompts (CLI_BYPASS_ARGS); refused for a kind without one. */
  openCli(id: string, project: string, opts?: { bypass?: boolean }): Promise<{ opened: boolean }>;

  startRun(request: StartRunRequest): Promise<AgentRun>;
  runs(filter?: { project?: string; projects?: string[]; limit?: number }): Promise<AgentRun[]>;
  runLog(id: string): Promise<string>;
  runMessages(id: string): Promise<RunMessage[]>;
  runDiff(id: string): Promise<string>;
  cancelRun(id: string): Promise<AgentRun>;
  steerRun(id: string, text: string): Promise<void>;
  removeWorktree(id: string): Promise<AgentRun>;
  worktrees(): Promise<WorktreeReport>;
  manageWorktrees(targets: WorktreeTarget[], force: boolean): Promise<WorktreeCommand["results"]>;
  /** Keeps this candidate when the judge could not choose (best-of-n). */
  pickCandidate(id: string): Promise<AgentRun>;

  updateProject(
    name: string,
    patch: { autoRelease?: DesktopProject["autoRelease"] | null; gitlabProject?: string | null; githubRepo?: string | null; targetBranch?: string | null; references?: string[] | null },
  ): Promise<DesktopSettings>;
  checkGitLab(): Promise<GitLabCheck>;
  /** Who the GitHub token belongs to (same shape as the GitLab check). */
  checkGitHub(): Promise<GitLabCheck>;
  /** Push the task branch and open/update its MR (or GitHub PR) now (ignores the automatic rules). */
  createMergeRequest(runId: string): Promise<AgentRun>;

  /** What is installed on this machine and in each project repo. */
  setupStatus(): Promise<SetupReport>;
  /** Installs one SetupItem (by id) and re-checks it. */
  installSetup(id: string): Promise<SetupInstallResult>;
  /** push: this machine's local database → hub · pull: hub → local database. Needs the hub URL and token. */
  transferHub(direction: "push" | "pull"): Promise<TransferReport>;

  /**
   * From the last heartbeat: the team policy (null in local mode), install requests waiting for this machine, the
   * hub's tools its projects use, with whether this machine's user allowed them (roadmap 28b; none in local mode),
   * and the repos of this machine the hub archived or deleted (roadmap 47), which it takes nothing for any more.
   */
  hubRequests(): Promise<{ policy: TeamPolicy | null; commands: MachineCommand[]; tools: MachineToolView[]; archivedProjects: string[] }>;
  /** Allows a hub tool's commands as shown (their hash), or with null takes the permission back. Returns the new list. */
  toolTrust(id: string, hash: string | null): Promise<MachineToolView[]>;
  /** Runs (approve) or declines an admin's install request, and reports the result to the hub. */
  answerCommand(id: number, approve: boolean): Promise<MachineCommand>;

  /**
   * The leader chat in the app (roadmap 48). chatMachine: in local mode the machine this database's chats run on
   * (this one, with its profiles and projects); null on a hub, whose machines.list has it. chatUpload keeps a file for
   * the project's chat, on the hub (with the machine's token) or in the local database; the page shows it from
   * chatFileUrl(id). Optional: an app older than 48 has neither.
   */
  chatMachine?(): Promise<Machine | null>;
  chatUpload?(project: string, name: string, bytes: Uint8Array): Promise<ChatFile>;
}
