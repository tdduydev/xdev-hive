// Contracts between the shared UI and its hosts (web hub, desktop main process). Types only.
import type { Access, Level } from "./access.ts";
import type { AgentKind, AgentProfile, AgentRole, PlanUsage, RunnerSettings, RunStatus } from "./agents.ts";
import type { MrSettings, MrState, MrStatus, PipelineStatus } from "./gitlab.ts";
import type { TransferReport } from "./transfer.ts";
import type { MachineCommand, Role, SetupItem, SetupReport, TeamPolicy, WebhookEvent, WebhookKind } from "./types.ts";

export interface Me {
  name: string;
  role: Role;
  mode: "local" | "hub";
  /** Hub account behind the session or token (absent for tokens of no account, and in local mode). */
  user?: { id: string; username: string; displayName: string; admin: boolean; mustChangePassword: boolean };
  /** Per-project grants of a restricted account (see access.ts); absent = unrestricted. */
  access?: Access;
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
  /** Project → level; admins see every project whatever this says. */
  grants: Record<string, Level>;
}

export interface FileAction {
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "removed";
  note?: string;
}

export interface SyncReport {
  project: string;
  files: FileAction[];
  /** Doc keys created in Hive from files that already existed in the repo. */
  imported: string[];
  /** Short hash of the commit made by the sync, if any. */
  commit: string | null;
  note?: string;
}

export interface ShimReport {
  path: string;
  /** Whether the shim's folder is on PATH of the desktop process (GUI apps may see a shorter PATH than your shell). */
  onPath: boolean;
}

export interface DesktopProject {
  name: string;
  repo: string;
  gitlabProject?: string;
  targetBranch?: string;
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
  /** What to run in a terminal to sign in, with the profile's login dir (never its other env). */
  loginCommand: string | null;
  checkedAt: string;
}

export interface AgentProfileStatus extends AgentProfile {
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
  lastUsedAt: string | null;
  /** costUsd: sum of the runs' API-price estimates (Claude Code runs only). */
  stats: { runs: number; succeeded: number; failed: number; rateLimited: number; costUsd: number };
}

export interface AgentRun {
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
  /** Kinds to avoid, e.g. the implementer's kind for a cross-review. */
  avoidKinds: AgentKind[];
  excludedProfiles: string[];
  attempt: number;
  maxAttempts: number;
  parentRunId: string | null;
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
  /** From the CLI's JSON result (Claude Code): estimated at API prices, which a subscription does not bill. */
  costUsd: number | null;
  /** Input tokens including cache reads and writes. */
  inputTokens: number | null;
  outputTokens: number | null;
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

export interface StartRunRequest {
  project: string;
  taskId: string;
  role?: AgentRole;
  /** Pin a profile; omit to rotate. */
  profileId?: string | null;
  instructions?: string;
  /** After success, queue a review on a different agent kind. */
  reviewAfter?: boolean;
}

export interface ProfileCheck {
  ok: boolean;
  path: string | null;
  output: string;
}

export interface DesktopBridge {
  settings(): Promise<DesktopSettings>;
  updateSettings(patch: DesktopSettingsPatch): Promise<DesktopSettings>;
  /** The interface language, for what the main process shows itself (tray, notifications, dialogs). */
  setLocale(locale: string): Promise<void>;
  /** Hub mode with a hub account: the hub issues this machine a token that belongs to the account. */
  hubSignIn(input: { hubUrl: string; username: string; password: string }): Promise<DesktopSettings>;
  addProject(project: DesktopProject): Promise<DesktopSettings>;
  removeProject(name: string): Promise<DesktopSettings>;
  pickFolder(): Promise<string | null>;
  syncProject(name: string): Promise<SyncReport>;
  installAgents(name: string): Promise<FileAction[]>;
  installShim(): Promise<ShimReport>;
  showInFolder(path: string): Promise<void>;

  profiles(): Promise<AgentProfileStatus[]>;
  saveProfile(profile: AgentProfile, previousId?: string): Promise<AgentProfileStatus[]>;
  removeProfile(id: string): Promise<AgentProfileStatus[]>;
  resetCooldown(id: string): Promise<AgentProfileStatus[]>;
  checkProfile(id: string): Promise<ProfileCheck>;
  /** Opens a terminal running the profile's sign-in command (Claude Code, Codex). */
  openLogin(id: string): Promise<{ opened: boolean }>;
  /** Checks the signed-out profiles again (after the user signed in elsewhere). */
  recheckLogins(): Promise<AgentProfileStatus[]>;

  startRun(request: StartRunRequest): Promise<AgentRun>;
  runs(filter?: { project?: string; limit?: number }): Promise<AgentRun[]>;
  runLog(id: string): Promise<string>;
  runDiff(id: string): Promise<string>;
  cancelRun(id: string): Promise<AgentRun>;
  removeWorktree(id: string): Promise<AgentRun>;

  updateProject(name: string, patch: { gitlabProject?: string | null; targetBranch?: string | null }): Promise<DesktopSettings>;
  checkGitLab(): Promise<GitLabCheck>;
  /** Push the task branch and open/update its MR now (ignores the automatic rules). */
  createMergeRequest(runId: string): Promise<AgentRun>;

  /** What is installed on this machine and in each project repo. */
  setupStatus(): Promise<SetupReport>;
  /** Installs one SetupItem (by id) and re-checks it. */
  installSetup(id: string): Promise<SetupInstallResult>;
  /** push: this machine's local database → hub · pull: hub → local database. Needs the hub URL and token. */
  transferHub(direction: "push" | "pull"): Promise<TransferReport>;

  /** From the last heartbeat: the team policy (null in local mode) and install requests waiting for this machine. */
  hubRequests(): Promise<{ policy: TeamPolicy | null; commands: MachineCommand[] }>;
  /** Runs (approve) or declines an admin's install request, and reports the result to the hub. */
  answerCommand(id: number, approve: boolean): Promise<MachineCommand>;
}
