import type { AcceptanceEvidence, EvidenceArtifact } from "#core/evidence.ts";
import { featureChecks } from "#core/acceptance-criteria.ts";
import { historyRows } from "#core/history-store.ts";
import type { HistoryEntry } from "#core/history.ts";
import { researchSchema, type Research, type ResearchInput, type ResearchJob } from "#core/research.ts";
import type { WorktreeReport, WorktreeCommand, MachineWorktrees } from "#core/worktrees.ts";
import { AutoReleaseStore } from "#core/auto-release-store.ts";
import { GateStore } from "#core/gate-store.ts";
import { isTerminalHuman } from "#core/terminal.ts";
import { HIVE_GATE_COMMANDS, mergeQueueConfigSchema, type MergeQueueView, type MergeQueueItem, type MergeBatch, type MergeResult } from "#core/merge-queue.ts";
import { waitingReason } from "#core/inbox.ts";
import { DEFAULT_RUN_TIMEOUT, runTimeoutMinutes, type RunTimeoutSettings } from "#core/run-timeout.ts";
import { diffReviewSelection, validDiffReview, patchHunks } from "#core/diff-review.ts";
import { memoryCleanupBaseline, type MemoryCleanupRun, type MemoryCleanupProposal } from "#core/memory-cleanup.ts";
import { needsPlanApproval, type ImplementationPlan, type RunPlan } from "#core/plan-approval.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isContextDoc, may, sees, systemOf, systemOwner, withSystemGrants, type Permission } from "./access.ts";
import type { AgentKind, AgentRole, PreferKind } from "./agents.ts";
import { ARTIFACTS_PER_RUN, artifactName, checkArtifact, isArtifactText, type Artifact } from "./artifacts.ts";
import type { BlobStore } from "./blobs.ts";
import { HiveError, type ErrorText } from "./errors.ts";
import { agentsDocKey, CLI_ACTION_SLUG_PREFIX, decisionsDocKey, isCliActionProposalKey, parseDocKey, PROJECT_NAME, titleFromSlug, type ParsedDocKey } from "./keys.ts";
import { parseSkill, type SkillSummary } from "./skills.ts";
import { chatFileName, checkChatFile, isImage } from "./chatfiles.ts";
import { DOC_ASSET_MAX_BYTES, DOC_ASSETS_PER_DOC, DOC_TREE_DEPTH, docLinkRefs, linkSnippet, resolveDocLink } from "./doclinks.ts";
import { describeProjectContext, syncItemId } from "./sync.ts";
import { CHAT_ACTION_ALWAYS_CONFIRM, DEFAULT_LEADER_COMMANDS, HUB_SCOPE, PAUSED_HUB } from "./types.ts";
import { EMPTY_POLICY } from "./policy.ts";
import { budgetApplies, budgetId, budgetRatio, budgetVars, periodStart, type Budget, type BudgetBlock, type BudgetUsage } from "./budgets.ts";
import { agentPolicyView, EMPTY_AGENT_POLICY, OPEN_POLICY, policySummary, type AgentPolicy, type AgentPolicySettings, type AgentPolicyView } from "./agent-policy.ts";
import {
  DEFAULT_MAX_FIX_ROUNDS,
  MAX_AUTOMATION_GATES,
  effectiveGates,
  EMPTY_SDLC_POLICY,
  fixInstructions,
  fullCeiling,
  GATE_MODES,
  gateCheckInstructions,
  NEXT_STEP,
  sdlcPolicyView,
  SDLC_GATES,
  STEP_GATE,
  type FlowState,
  type FlowStep,
  type SdlcFlow,
  type SdlcFlowTask,
  type TaskStage,
  type GateMode,
  type GateModes,
  type GateStatus,
  type SdlcGate,
  type SdlcGateRecord,
  type SdlcPolicySettings,
  type SdlcPolicyView,
  DEFAULT_AGENT_KINDS,
} from "./sdlc.ts";
import {
  authorize,
  chatPlanSchema,
  type ChatPlan,
  parseInput,
  type HiveBackend,
  type Method,
  type MethodInput,
  type MethodOutput,
  type ParsedInput,
} from "./methods.ts";
import { fuseRanks, similarity, type Embedder } from "./embed.ts";
import { assertNoHidden, stripHidden } from "./hidden.ts";
import { assertNoSecret, findSecret, redactLines } from "./secrets.ts";
import { isAgentActor, MR_WATCHER, parseSource, principalOf, type WriteSource } from "./source.ts";
import { SEED_DOCS, SEED_VERSION } from "./seed.ts";
import { planSpecTasks, specStage, specStepInstructions, specTaskPrefix, specTasks, specTitle, type SpecFeature, type SpecFeatureDetail, type SpecFiles, type SpecStep } from "./speckit.ts";
import { MODEL_TIERS, DEFAULT_MODEL_CELLS, DEFAULT_MODEL_ROUTER, selectModel, type ModelProject, type ModelRouterSettings, type ModelSelection, type ModelTier } from "./model-router.ts";
import {
  isTrialTask,
  LEARN_DAYS,
  LEARNED_KINDS,
  learnedTasks,
  learningDue,
  learningStats,
  qualityStats,
  proposeTier,
  type LearningChange,
  type LearningRun,
  type ModelLearningCell,
  type ModelLearningView,
} from "./model-learning.ts";
import { parseVerdict, type Verdict } from "./verdict.ts";
import { parseParts, partInstructions, reduceInstructions, splitInstructions, type MapPhase } from "./mapreduce.ts";
import { ROLE_STEP_RUN, stepInstructions, type RoleStep } from "./roles.ts";
import { BROWSER_TOOL, toolEffective, toolProblem, toolSetupItems, toolHash } from "./tools.ts";
import { classifyTaskRule, DEFAULT_TASK_CLASS, parseTaskClass, TASK_SIZES, type TaskClass, type TaskKind, type TaskSize } from "./task-classify.ts";
import type {
  Actor,
  AgentsPaused,
  AgentsStop,
  AuditEntry,
  ChatAction,
  ChatActionKind,
  ChatActionStatus,
  ChatDefaults,
  ChatEffort,
  ChatFile,
  ChatMessage,
  ChatReplyStatus,
  ChatRequest,
  ChatSender,
  ChatThread,
  CommandKind,
  CommandStatus,
  CompressionCompare,
  ModelUse,
  CompressionSide,
  CostTotals,
  Doc,
  DocMirror,
  DocAsset,
  DocAssist,
  DocAssistJob,
  DocLinks,
  DocSummary,
  HiveEvent,
  DocVersion,
  Machine,
  MachineCommand,
  MachineTools,
  MachineDetail,
  MachineRun,
  ProfileChange,
  RunnerChange,
  MachineRunnerSettings,
  RunCompression,
  RunMr,
  MergeStatus,
  Memory,
  MemoryFile,
  MemoryReview,
  MemorySearchInfo,
  ProjectDeleted,
  ProjectState,
  ProjectSummary,
  ProjectSyncState,
  Proposal,
  QuotaCooldown,
  ReportedProfile,
  RunNotice,
  RunRecord,
  RunMessage,
  RunGroup,
  RunGroupItem,
  RunGroupItemStatus,
  RunGroupKind,
  RunGroupRun,
  RunRequest,
  RunRequestError,
  RunRequestStatus,
  MachineSetupMissing,
  SetupReport,
  Task,
  TaskAgent,
  TaskAgentQueueItem,
  TaskNote,
  TaskStatus,
  TeamPolicy,
  ToolEntry,
  ToolProjectSetting,
  ToolStatus,
  MachineToolState,
  MachineToolAccess,
  ToolApproval,
  ToolView,
  HiveSystem,
  RetiredProject,
} from "./types.ts";

/** Tests only: the index of the first migration whose SQL contains `fragment` (see SqliteHiveOptions.migrateTo). */
export function migrationIndex(fragment: string): number {
  const i = MIGRATIONS.findIndex((m) => m.includes(fragment));
  if (i < 0) throw new Error(`No migration contains ${fragment}`);
  return i;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE docs(
    key TEXT PRIMARY KEY, scope TEXT NOT NULL, project TEXT, title TEXT NOT NULL,
    content TEXT NOT NULL, version INTEGER NOT NULL, include_in_agents INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX docs_project ON docs(project);
  CREATE TABLE doc_versions(
    key TEXT NOT NULL, version INTEGER NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, PRIMARY KEY(key, version));
  CREATE TABLE proposals(
    id INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, base_version INTEGER NOT NULL, content TEXT NOT NULL,
    reason TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    reviewer TEXT, review_note TEXT, decided_at TEXT, created_at TEXT NOT NULL);
  CREATE INDEX proposals_status ON proposals(status);
  CREATE TABLE memory(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
    author TEXT NOT NULL, task_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX memory_project ON memory(project, status);
  CREATE VIRTUAL TABLE memory_fts USING fts5(
    content, content='memory', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
  END;
  CREATE TRIGGER memory_au AFTER UPDATE OF content ON memory BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO memory_fts(rowid, content) VALUES (new.id, new.content);
  END;
  CREATE TABLE tasks(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo',
    owner TEXT, lease_until TEXT, note TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX tasks_project ON tasks(project, status);
  `,
  `
  CREATE TABLE machines(
    id TEXT PRIMARY KEY, machine TEXT NOT NULL, instance TEXT NOT NULL, prev_instance TEXT,
    version TEXT NOT NULL DEFAULT '', runs TEXT NOT NULL DEFAULT '[]', last_seen TEXT NOT NULL, duplicate_at TEXT);
  CREATE TABLE quota_cooldowns(
    account TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL,
    reported_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  ALTER TABLE machines ADD COLUMN setup TEXT;
  ALTER TABLE machines ADD COLUMN setup_at TEXT;
  ALTER TABLE machines ADD COLUMN profiles TEXT NOT NULL DEFAULT '[]';
  CREATE TABLE machine_commands(
    id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL, item_id TEXT NOT NULL, label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, output TEXT);
  CREATE INDEX machine_commands_machine ON machine_commands(machine_id, status);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE audit(
    id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '');
  CREATE INDEX audit_at ON audit(at);
  `,
  `
  ALTER TABLE audit ADD COLUMN detail_key TEXT;
  ALTER TABLE audit ADD COLUMN detail_vars TEXT;
  `,
  `
  ALTER TABLE doc_versions ADD COLUMN source TEXT;
  ALTER TABLE proposals ADD COLUMN source TEXT;
  ALTER TABLE memory ADD COLUMN source TEXT;
  `,
  `
  CREATE TABLE run_costs(
    machine_id TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, task_id TEXT NOT NULL,
    profile_id TEXT NOT NULL, account TEXT, cost_usd REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    finished_at TEXT NOT NULL, PRIMARY KEY(machine_id, run_id));
  CREATE INDEX run_costs_at ON run_costs(finished_at);
  `,
  `
  ALTER TABLE memory ADD COLUMN last_used_at TEXT;
  ALTER TABLE memory ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE memory ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE memory ADD COLUMN review TEXT;
  `,
  `
  ALTER TABLE memory ADD COLUMN supersedes INTEGER;
  ALTER TABLE memory ADD COLUMN superseded_by INTEGER;
  ALTER TABLE memory ADD COLUMN conflicts TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE task_deps(task_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id, depends_on));
  CREATE INDEX task_deps_on ON task_deps(depends_on);
  `,
  `
  ALTER TABLE docs ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE memory_vectors(
    memory_id INTEGER PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE, model TEXT NOT NULL, vector BLOB NOT NULL);
  CREATE TRIGGER memory_vectors_au AFTER UPDATE OF content ON memory BEGIN
    DELETE FROM memory_vectors WHERE memory_id = new.id;
  END;
  `,
  `
  CREATE TABLE run_records(
    machine_id TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, task_id TEXT NOT NULL,
    task_title TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, profile_id TEXT, activity TEXT, summary TEXT,
    error TEXT, branch TEXT, commits INTEGER NOT NULL DEFAULT 0, mr_url TEXT, cost_usd REAL, log TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY(machine_id, run_id));
  CREATE INDEX run_records_project ON run_records(project, updated_at);
  CREATE INDEX run_records_at ON run_records(updated_at);
  `,
  `
  ALTER TABLE machines ADD COLUMN projects TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE machines ADD COLUMN accepts_runs INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE run_requests(
    id INTEGER PRIMARY KEY, machine_id TEXT NOT NULL, machine TEXT NOT NULL, project TEXT NOT NULL, task_id TEXT NOT NULL,
    task_title TEXT NOT NULL, role TEXT NOT NULL, profile_id TEXT, review_after INTEGER NOT NULL DEFAULT 0,
    candidates INTEGER NOT NULL DEFAULT 1, instructions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
    run_id TEXT, error TEXT, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX run_requests_machine ON run_requests(machine_id, status);
  CREATE INDEX run_requests_project ON run_requests(project, id);
  `,
  `
  CREATE TABLE chat_threads(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, machine_id TEXT NOT NULL, machine TEXT NOT NULL,
    profile_id TEXT, session_id TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX chat_threads_project ON chat_threads(project, updated_at);
  CREATE TABLE chat_messages(
    id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, role TEXT NOT NULL,
    author TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', status TEXT, activity TEXT, steps TEXT NOT NULL DEFAULT '', error TEXT,
    cost_usd REAL, sender TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
  CREATE INDEX chat_messages_thread ON chat_messages(thread_id, id);
  CREATE INDEX chat_messages_status ON chat_messages(status);
  `,
  `
  CREATE TABLE chat_actions(
    id INTEGER PRIMARY KEY, reply_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE, project TEXT NOT NULL, kind TEXT NOT NULL,
    input TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', result TEXT, error TEXT,
    decided_by TEXT, decided_at TEXT, created_at TEXT NOT NULL);
  CREATE INDEX chat_actions_thread ON chat_actions(thread_id, reply_id);
  `,
  `
  CREATE TABLE hive_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE run_records ADD COLUMN cancel_by TEXT;
  ALTER TABLE run_records ADD COLUMN cancel_at TEXT;
  `,
  `
  CREATE TABLE chat_files(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, thread_id INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE, name TEXT NOT NULL, type TEXT NOT NULL,
    size INTEGER NOT NULL, data BLOB NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX chat_files_thread ON chat_files(thread_id, message_id);
  `,
  `
  ALTER TABLE chat_threads ADD COLUMN model TEXT;
  ALTER TABLE chat_threads ADD COLUMN effort TEXT;
  CREATE TABLE chat_defaults(
    project TEXT PRIMARY KEY, machine_id TEXT, profile_id TEXT, model TEXT, effort TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  ALTER TABLE chat_defaults ADD COLUMN commands TEXT;
  `,
  // Systems (roadmap 19b): projects as a JSON array.
  `
  CREATE TABLE systems(name TEXT PRIMARY KEY, projects TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  // Pages under pages, and files on a page (roadmap 22j).
  `
  ALTER TABLE docs ADD COLUMN parent TEXT;
  ALTER TABLE docs ADD COLUMN folder INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX docs_parent ON docs(parent);
  CREATE TABLE doc_assets(
    id INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
    data BLOB NOT NULL, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(doc_key, name));
  `,
  // The writing assistant's asks (roadmap 22k): a machine that takes one writes it with Claude.
  `
  CREATE TABLE doc_assists(
    id INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, project TEXT, kind TEXT NOT NULL, prompt TEXT NOT NULL,
    sources TEXT NOT NULL, context TEXT NOT NULL, code TEXT NOT NULL, base TEXT NOT NULL, status TEXT NOT NULL,
    taken_by TEXT, machine TEXT, profile TEXT, reply TEXT NOT NULL DEFAULT '', markdown TEXT, error TEXT, cost_usd REAL,
    outcome TEXT, requested_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX doc_assists_doc ON doc_assists(doc_key, requested_by);
  CREATE INDEX doc_assists_status ON doc_assists(status);
  `,
  // What a run changed, as its machine last sent it (roadmap 22l): the web shows a run of another machine's diff.
  `
  ALTER TABLE run_records ADD COLUMN patch TEXT;
  `,
  // Doc files in a store beside the hub (roadmap 23c): the row keeps what the file is, the store its bytes by SHA-256.
  // stored: the store's name (data is then empty), null while the bytes are in this row.
  `
  ALTER TABLE doc_assets ADD COLUMN sha256 TEXT;
  ALTER TABLE doc_assets ADD COLUMN stored TEXT;
  CREATE INDEX doc_assets_sha ON doc_assets(sha256);
  `,
  // Pages mirrored from the repo (roadmap 26): {from, commit} as JSON, null for pages whose home is Hive.
  `
  ALTER TABLE docs ADD COLUMN mirror TEXT;
  `,
  // Sync requests ride the machine command channel (roadmap 22n): install rows keep kind 'install' and no project.
  `
  ALTER TABLE machine_commands ADD COLUMN kind TEXT NOT NULL DEFAULT 'install';
  ALTER TABLE machine_commands ADD COLUMN project TEXT;
  CREATE INDEX machine_commands_project ON machine_commands(project, machine_id);
  `,
  // Agents in the audit log, and no approving your own work (roadmap 27c). on_behalf: the account a token belongs to,
  // so an agent's proposal, memory or run counts as its person's. run_records.requested_by: whose the run was.
  `
  ALTER TABLE audit ADD COLUMN agent TEXT;
  ALTER TABLE audit ADD COLUMN on_behalf TEXT;
  ALTER TABLE audit ADD COLUMN run TEXT;
  CREATE INDEX audit_run ON audit(run);
  ALTER TABLE proposals ADD COLUMN on_behalf TEXT;
  ALTER TABLE memory ADD COLUMN on_behalf TEXT;
  ALTER TABLE run_requests ADD COLUMN on_behalf TEXT;
  ALTER TABLE run_records ADD COLUMN requested_by TEXT;
  `,
  // Spending caps per person (roadmap 27b): who asked for the run. Rows from before stay null and count for no one.
  `
  ALTER TABLE run_costs ADD COLUMN requested_by TEXT;
  CREATE INDEX run_costs_by ON run_costs(requested_by, finished_at);
  `,
  // Profiles changed from the web (roadmap 18d). owner: the account the machine's token belongs to, null for a token of
  // no account. One waiting change per profile; null columns leave that part as the machine has it.
  `
  ALTER TABLE machines ADD COLUMN owner TEXT;
  CREATE TABLE machine_profile_changes(
    machine_id TEXT NOT NULL, profile_id TEXT NOT NULL, enabled INTEGER, priority INTEGER,
    requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, PRIMARY KEY(machine_id, profile_id));
  `,
  // Merge from the web (roadmap 18c). mr: the MR as the machine's watcher last saw it (RunMr as JSON). merge_*: a merge
  // asked for on the web, which the run's machine does with its own token.
  `
  ALTER TABLE run_records ADD COLUMN mr TEXT;
  ALTER TABLE run_records ADD COLUMN merge_by TEXT;
  ALTER TABLE run_records ADD COLUMN merge_at TEXT;
  ALTER TABLE run_records ADD COLUMN merge_status TEXT;
  ALTER TABLE run_records ADD COLUMN merge_error TEXT;
  ALTER TABLE run_records ADD COLUMN merge_done_at TEXT;
  CREATE INDEX run_records_merge ON run_records(merge_status);
  `,
  // Spec Kit features as machines last read them (roadmap 20b). branch '' is the project's target branch; files is
  // SpecFiles as JSON. A machine replaces only its own rows, so machine is not in the key: the newest push wins.
  `
  CREATE TABLE spec_features(
    project TEXT NOT NULL, dir TEXT NOT NULL, branch TEXT NOT NULL, title TEXT NOT NULL, files TEXT NOT NULL,
    commit_sha TEXT NOT NULL, machine TEXT NOT NULL, pushed_at TEXT NOT NULL, PRIMARY KEY(project, dir, branch));
  CREATE INDEX spec_features_machine ON spec_features(project, machine);
  `,
  // Token counts apart (roadmap 28c): input fresh (input_tokens, for rows from now on), written to the cache, read from it.
  // A run with no price (Codex) is kept with cost 0 and priced 0.
  `
  ALTER TABLE run_costs ADD COLUMN cache_write_tokens INTEGER;
  ALTER TABLE run_costs ADD COLUMN cache_read_tokens INTEGER;
  ALTER TABLE run_costs ADD COLUMN priced INTEGER NOT NULL DEFAULT 1;
  `,
  // What a project's leader runs without a confirm (roadmap 29c): kinds as JSON, none when null. auto: it ran so.
  `
  ALTER TABLE chat_defaults ADD COLUMN auto_kinds TEXT;
  ALTER TABLE chat_actions ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `,
  // The tool catalog (roadmap 28a). entry: ToolEntry as JSON without its id. tool_projects.enabled null follows the
  // entry's enabledByDefault. Seeded with what machines ran on 2/10 (see toolSeedSql).
  `
  CREATE TABLE tools(
    id TEXT PRIMARY KEY, entry TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL,
    updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
  CREATE TABLE tool_projects(
    tool_id TEXT NOT NULL, project TEXT NOT NULL, enabled INTEGER, required INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(tool_id, project));
  CREATE INDEX tool_projects_project ON tool_projects(project);
  ${toolSeedSql()}
  `,
  // Run groups (roadmap 31): an item is held here and becomes a run request only when released, so run_requests keep
  // their meaning and a held item does not expire. machine_id null: any free machine, picked when released.
  `
  CREATE TABLE run_groups(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, max_parallel INTEGER,
    review_after INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '', parent_task TEXT, winner_task TEXT,
    created_by TEXT NOT NULL, on_behalf TEXT, created_at TEXT NOT NULL, closed_at TEXT);
  CREATE INDEX run_groups_open ON run_groups(closed_at);
  CREATE INDEX run_groups_project ON run_groups(project, id);
  CREATE TABLE run_group_items(
    id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, position INTEGER NOT NULL, task_id TEXT NOT NULL, role TEXT NOT NULL,
    machine_id TEXT, profile_id TEXT, instructions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, request_id INTEGER,
    error TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX run_group_items_group ON run_group_items(group_id, position);
  CREATE INDEX run_group_items_task ON run_group_items(task_id, status);
  `,
  // Lifecycle gates reached (roadmap 34): one row each time a flow comes to a gate, and how it was decided.
  `
  CREATE TABLE sdlc_gates(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, gate TEXT NOT NULL, mode TEXT NOT NULL,
    status TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '{}', decided_by TEXT, note TEXT, created_at TEXT NOT NULL, decided_at TEXT);
  CREATE INDEX sdlc_gates_project ON sdlc_gates(project, id);
  CREATE INDEX sdlc_gates_task ON sdlc_gates(task_id, gate);
  `,
  // Flows the hub drives through the gates (roadmap 34b): one per task. step: the Spec Kit step running, or next when
  // state is "next" ("import": the tasks.md into the board). request_id: the step's run request, or the gate check's.
  `
  CREATE TABLE sdlc_flows(
    task_id TEXT PRIMARY KEY, project TEXT NOT NULL, dir TEXT, step TEXT NOT NULL, state TEXT NOT NULL,
    machine_id TEXT NOT NULL, profile_id TEXT, request_id INTEGER, gate_id INTEGER, input TEXT NOT NULL DEFAULT '',
    note TEXT, reached_at TEXT, created_by TEXT NOT NULL, on_behalf TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX sdlc_flows_project ON sdlc_flows(project, updated_at);
  CREATE INDEX sdlc_flows_state ON sdlc_flows(state);
  `,
  // Tasks a flow gave to agents (roadmap 34c, 34d) and where each is on its way to main: stage, the gate it waits at,
  // the fix runs it had, and the run (machine_id, run_id) whose branch and MR it waits on.
  `
  CREATE TABLE sdlc_flow_tasks(
    task_id TEXT PRIMARY KEY, flow_task TEXT NOT NULL, project TEXT NOT NULL, stage TEXT NOT NULL, gate_id INTEGER,
    fix_rounds INTEGER NOT NULL DEFAULT 0, machine_id TEXT, run_id TEXT, request_id INTEGER, note TEXT,
    created_by TEXT NOT NULL, on_behalf TEXT, updated_at TEXT NOT NULL);
  CREATE INDEX sdlc_flow_tasks_flow ON sdlc_flow_tasks(flow_task);
  CREATE INDEX sdlc_flow_tasks_stage ON sdlc_flow_tasks(stage);
  `,
  // Map-reduce groups (roadmap 31c): their phase, the job's parts (JSON), the one machine of the parts and the merge
  // (their branches have to be in one repository), the split or merge run's request, and why the group stopped.
  `
  ALTER TABLE run_groups ADD COLUMN phase TEXT;
  ALTER TABLE run_groups ADD COLUMN parts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE run_groups ADD COLUMN machine_id TEXT;
  ALTER TABLE run_groups ADD COLUMN phase_request INTEGER;
  ALTER TABLE run_groups ADD COLUMN phase_error TEXT;
  `,
  // A kind a run prefers (roadmap 24c): it waits for a profile of that kind while one could take it, then any.
  `
  ALTER TABLE run_requests ADD COLUMN prefer_kind TEXT;
  ALTER TABLE run_group_items ADD COLUMN prefer_kind TEXT;
  `,
  // Run archive (roadmap 41b): a run's summary stays for good, only its log and patch go after RUN_LOG_DAYS.
  // log_pruned_at: when they went, so the page and run_get can say so instead of showing an empty log as the truth.
  // Records are never deleted now, so the clean-up at each runs.push looks only at the ones still to clean.
  `
  ALTER TABLE run_records ADD COLUMN log_pruned_at TEXT;
  CREATE INDEX run_records_unpruned ON run_records(updated_at) WHERE log_pruned_at IS NULL;
  `,
  // Archived and deleted projects (roadmap 47): no row means the project is in use. A "deleted" row is the headstone
  // left behind after its data went, so a machine that still reports the repo cannot bring the name back by itself.
  `
  CREATE TABLE project_states(project TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL);
  `,
  // The agent a task is for (roadmap 50), apart from owner, which says who took it. agent_order: its place in that
  // machine's queue, a REAL so a task dragged between two others takes the value in between and the rest keep theirs.
  // agent_request: the run the hub queued for this turn, so a task it already handed over is not handed over twice;
  // assigning the task again (the *Chạy lại* button) clears it and starts a new turn.
  // agent_hold: why the hub stopped sending it (a run of it failed); assigning it again clears that too.
  `
  ALTER TABLE tasks ADD COLUMN agent_machine TEXT;
  ALTER TABLE tasks ADD COLUMN agent_profile TEXT;
  ALTER TABLE tasks ADD COLUMN agent_order REAL;
  ALTER TABLE tasks ADD COLUMN agent_by TEXT;
  ALTER TABLE tasks ADD COLUMN agent_at TEXT;
  ALTER TABLE tasks ADD COLUMN agent_request INTEGER;
  ALTER TABLE tasks ADD COLUMN agent_hold TEXT;
  CREATE INDEX tasks_agent ON tasks(agent_machine, agent_order) WHERE agent_machine IS NOT NULL;
  `,
  // What RTK left out of a run's Bash output (roadmap 28d), RunCompression as JSON; null: no RTK, or no numbers.
  // The catalog gets RTK as an entry of its own, off by default and not built in: the Chi phí page compares runs with
  // and without it before anyone turns it on. OR IGNORE: a hub whose admin added an "rtk" already keeps theirs.
  `
  ALTER TABLE run_records ADD COLUMN compression TEXT;
  ${rtkSeedSql()}
  `,
  // What a run ran on (roadmap 54a), the data the model router learns from: the profile's kind, the model and effort
  // its final args set (null: the CLI's default), the router's tier (null until 54c), which attempt it was and the run
  // it follows, and a review's verdict as parsed once, so the learning does not read summaries again. Runs from
  // before stay null: their args are gone. The index: costs.summary reads 30 days of ended runs from a table whose
  // rows are no longer deleted (41b).
  `
  ALTER TABLE run_records ADD COLUMN kind TEXT;
  ALTER TABLE run_records ADD COLUMN model TEXT;
  ALTER TABLE run_records ADD COLUMN effort TEXT;
  ALTER TABLE run_records ADD COLUMN tier TEXT;
  ALTER TABLE run_records ADD COLUMN attempt INTEGER;
  ALTER TABLE run_records ADD COLUMN parent_run TEXT;
  ALTER TABLE run_records ADD COLUMN verdict TEXT;
  CREATE INDEX run_records_finished ON run_records(finished_at);
  `,
  // What a task is (roadmap 54b), and who said so: 'rule', 'ai' or a person's name. The classify run a task waits for,
  // the runs.dispatch calls waiting behind one, and the projects that turned the run off (no row: on).
  `
  ALTER TABLE tasks ADD COLUMN kind TEXT;
  ALTER TABLE tasks ADD COLUMN size TEXT;
  ALTER TABLE tasks ADD COLUMN risk TEXT;
  ALTER TABLE tasks ADD COLUMN classified_by TEXT;
  ALTER TABLE tasks ADD COLUMN classified_at TEXT;
  CREATE TABLE task_classify_config(project TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE task_classify_runs(task_id TEXT PRIMARY KEY, request_id INTEGER NOT NULL, requested_at TEXT NOT NULL);
  CREATE TABLE task_classify_dispatches(task_id TEXT PRIMARY KEY, project TEXT NOT NULL, request TEXT NOT NULL, requested_by TEXT NOT NULL, on_behalf TEXT);
  `,
  // Handover notes as they were written (roadmap 41a): tasks.note stays the latest, these keep the ones before it.
  // The notes already on the board become version 1, written by "hub": they were kept before versions existed, so
  // nobody is named for them, and the newest version is the task's note for every task, old ones included.
  `
  CREATE TABLE task_notes(
    task_id TEXT NOT NULL, version INTEGER NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL,
    author TEXT NOT NULL, on_behalf TEXT, source TEXT, created_at TEXT NOT NULL, PRIMARY KEY(task_id, version));
  INSERT INTO task_notes(task_id, version, note, status, author, created_at)
    SELECT id, 1, note, status, 'hub', updated_at FROM tasks WHERE note IS NOT NULL AND note != '';
  `,
  // Files an agent made during a run (roadmap 41c). Like doc_assets: the row says what the file is, the store keeps
  // its bytes by SHA-256 (stored = the store's name, data then empty), null while they are in this row. One name per
  // run, so a run sent twice replaces instead of doubling. Since DATA-cleanup-hub, pruneArtifacts drops old ones of done tasks.
  `
  CREATE TABLE artifacts(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, run_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, stored TEXT, data BLOB NOT NULL,
    profile_id TEXT, uploaded_by TEXT NOT NULL, on_behalf TEXT, source TEXT, created_at TEXT NOT NULL,
    UNIQUE(machine_id, run_id, name));
  CREATE INDEX artifacts_project ON artifacts(project, id);
  CREATE INDEX artifacts_task ON artifacts(project, task_id);
  CREATE INDEX artifacts_sha ON artifacts(sha256);
  `,
  // Migration 48 (49f): scheduled reviews hold snapshots; only a human decision changes memory.
  `
  CREATE TABLE memory_cleanup_settings(project TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, last_queued_at TEXT);
  CREATE TABLE memory_cleanup_runs(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
    taken_by TEXT, machine TEXT, snapshot TEXT NOT NULL DEFAULT '[]', profile TEXT, model TEXT NOT NULL DEFAULT 'haiku', cost_usd REAL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX memory_cleanup_active ON memory_cleanup_runs(project, status);
  CREATE TABLE memory_cleanup_proposals(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, run_id INTEGER NOT NULL, suggestion TEXT NOT NULL,
    entries TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reviewer TEXT, decided_at TEXT, created_at TEXT NOT NULL);
  `,
  // Removing and moving pages (roadmap 38g). removed_at: the page is out of every list, of AGENTS.md and of the next
  // sync, but its versions stay. removed_op numbers the removal (two in the same millisecond share a time but not a
  // number), so a restore puts back exactly what one removal took. doc_redirects: a key a page used to have, so links
  // from before a move still find it.
  `
  ALTER TABLE docs ADD COLUMN removed_at TEXT;
  ALTER TABLE docs ADD COLUMN removed_by TEXT;
  ALTER TABLE docs ADD COLUMN removed_note TEXT;
  ALTER TABLE docs ADD COLUMN removed_op INTEGER;
  CREATE INDEX docs_removed ON docs(removed_at);
  CREATE TABLE doc_redirects(
    from_key TEXT PRIMARY KEY, to_key TEXT NOT NULL, moved_by TEXT NOT NULL, moved_at TEXT NOT NULL);
  CREATE INDEX doc_redirects_to ON doc_redirects(to_key);
  `,
  // The model router's choice (54c), fixed when the request is made: the heartbeat resends the row as it is, and the
  // tier must not change between the hub's answer and the machine starting the run.
  `
  ALTER TABLE run_requests ADD COLUMN selection TEXT;
  `,
  // Projects already known at upgrade keep their chosen gates. Later projects start from maximum automation.
  `
  INSERT INTO hive_meta(key, value)
    SELECT 'sdlc_legacy_projects', json_group_array(project) FROM (
      SELECT project FROM tasks UNION SELECT project FROM docs UNION SELECT project FROM memory
      UNION SELECT project FROM run_records UNION SELECT project FROM chat_threads
      UNION SELECT project FROM project_states UNION SELECT project FROM artifacts
      UNION SELECT value AS project FROM machines, json_each(machines.projects)
      UNION SELECT value AS project FROM systems, json_each(systems.projects)
    ) WHERE project IS NOT NULL AND project != '' AND project NOT LIKE 'sys:%';
  `,
  // The router's learning (54d), per project; no row: learning on, no cell locked. locked: ["feature/m", …], cells the
  // nightly round leaves alone. The log keeps every change it or a person made to them, the cell's tier before and after.
  `
  CREATE TABLE model_learning(project TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, locked TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE model_learning_log(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, change TEXT NOT NULL, task_kind TEXT, task_size TEXT,
    from_tier TEXT, to_tier TEXT, tasks INTEGER, clean_rate REAL, changed_by TEXT NOT NULL, at TEXT NOT NULL);
  CREATE INDEX model_learning_log_project ON model_learning_log(project, id);
  `,
  `ALTER TABLE audit ADD COLUMN source TEXT;`,
  `
  CREATE TABLE run_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    text TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, delivered_at TEXT,
    FOREIGN KEY(machine_id, run_id) REFERENCES run_records(machine_id, run_id) ON DELETE CASCADE);
  CREATE INDEX run_messages_run ON run_messages(machine_id, run_id, id);
  CREATE INDEX run_messages_pending ON run_messages(machine_id, id) WHERE delivered_at IS NULL;
  `,
  // Implementation planning is a separate read-only run; revisions remain readable after approval.
  `
  ALTER TABLE run_requests ADD COLUMN plan TEXT;
  ALTER TABLE run_records ADD COLUMN plan TEXT;
  CREATE TABLE implementation_plans(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL, machine_id TEXT NOT NULL,
    request_id INTEGER NOT NULL, run_id TEXT, status TEXT NOT NULL DEFAULT 'planning', text TEXT, note TEXT,
    revision INTEGER NOT NULL DEFAULT 1, timeout_minutes INTEGER,
    created_at TEXT NOT NULL, ready_at TEXT, deadline TEXT, decided_at TEXT, decided_by TEXT);
  CREATE INDEX implementation_plans_task ON implementation_plans(project, task_id, id);
  CREATE INDEX implementation_plans_waiting ON implementation_plans(status, deadline);
  `,
  `ALTER TABLE run_records ADD COLUMN diff_review TEXT;`,
  `ALTER TABLE run_records ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';`,
  // Chains of roles (roadmap 31d): what each step does. Its run's role cannot tell: writing code, tests or docs are all
  // implement runs.
  `
  ALTER TABLE run_group_items ADD COLUMN step TEXT;
  `,
  // Approvals are commands pinned by hash, acknowledged independently of local trust so revocation stays local.
  `
  ALTER TABLE machines ADD COLUMN tool_states TEXT;
  CREATE TABLE machine_tool_approvals(
    id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    tool_id TEXT NOT NULL REFERENCES tools(id) ON DELETE CASCADE, hash TEXT NOT NULL,
    approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, applied_at TEXT,
    UNIQUE(machine_id, tool_id));
  `,
  `ALTER TABLE run_requests ADD COLUMN timeout_minutes INTEGER;`,
  // An update holds new work without revoking consent to cancel or steer the work already running.
  `ALTER TABLE machines ADD COLUMN update_draining INTEGER NOT NULL DEFAULT 0;`,
  // Keep retries traceable after their queue requests age out, including when they move machines.
  `
  ALTER TABLE run_requests ADD COLUMN redispatch TEXT;
  ALTER TABLE run_records ADD COLUMN parent_machine_id TEXT;
  ALTER TABLE run_records ADD COLUMN instructions TEXT;
  ALTER TABLE run_records ADD COLUMN base_sha TEXT;
  UPDATE run_records SET instructions = (SELECT q.instructions FROM run_requests q
    WHERE q.machine_id = run_records.machine_id AND q.run_id = run_records.run_id AND q.status = 'accepted'
    ORDER BY q.id DESC LIMIT 1);
  `,
  // Large boards must stop at the list limit without sorting their entire history. Request housekeeping also runs
  // on every list read, so index its time windows rather than visiting every retained request.
  `
  CREATE INDEX tasks_list_at ON tasks(updated_at DESC);
  CREATE INDEX run_records_created ON run_records(created_at DESC, run_id DESC);
  CREATE INDEX run_requests_pending_at ON run_requests(requested_at) WHERE status = 'pending';
  CREATE INDEX run_requests_retention_at ON run_requests(updated_at) WHERE status <> 'pending';
  `,
  // Existing tasks retain insertion order within the default priority.
  `ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 50;
   ALTER TABLE machines ADD COLUMN max_parallel INTEGER;
   ALTER TABLE tasks ADD COLUMN agent_auto INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN agent_retries INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN agent_retry_source TEXT;`,
  `ALTER TABLE machines ADD COLUMN gate_runner INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE merge_batches(id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, machine_id TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL);
   CREATE UNIQUE INDEX merge_batches_active ON merge_batches(project) WHERE status IN ('running','awaiting');
   CREATE TABLE merge_batch_items(batch_id INTEGER NOT NULL REFERENCES merge_batches(id), task_id TEXT NOT NULL, machine_id TEXT NOT NULL, run_id TEXT NOT NULL, UNIQUE(task_id,machine_id,run_id));
   CREATE TABLE merge_repairs(project TEXT NOT NULL, repair_task TEXT NOT NULL, task_id TEXT NOT NULL, machine_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(repair_task,task_id));`,
  `CREATE TABLE auto_releases(project TEXT NOT NULL, batch_id TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(project, batch_id));
   CREATE TABLE auto_release_pauses(project TEXT PRIMARY KEY);`,
  // Run credentials are separate from machine credentials; expiry and parent revocation are checked on every call.
  // Local databases also run this migration: a foreign key's parent must exist before project cleanup can delete rows.
  `
  CREATE TABLE IF NOT EXISTS hub_tokens(
    id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
    created_at TEXT NOT NULL, last_used_at TEXT, owner_id TEXT);
  CREATE TABLE run_credentials(
    hash TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES hub_tokens(id) ON DELETE CASCADE,
    machine TEXT NOT NULL, project TEXT NOT NULL, task TEXT NOT NULL, run TEXT NOT NULL,
    expires_at TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 0,
    UNIQUE(parent_id, machine, run));
  CREATE INDEX run_credentials_expiry ON run_credentials(expires_at);
  CREATE TABLE mcp_credentials(
    hash TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES hub_tokens(id) ON DELETE CASCADE,
    project TEXT, expires_at TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX mcp_credentials_expiry ON mcp_credentials(expires_at);
  `,
  // Inbox needs the newest run per task before it tests whether that run waits for a person.
  `CREATE INDEX run_records_task_latest ON run_records(project, task_id, created_at DESC, run_id DESC, machine_id DESC);`,
  `
  ALTER TABLE machines ADD COLUMN worktrees TEXT;
  CREATE TABLE machine_worktree_commands(
    id TEXT PRIMARY KEY, machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    command TEXT NOT NULL, completed_at TEXT, results TEXT NOT NULL DEFAULT '[]');
  CREATE INDEX machine_worktree_pending ON machine_worktree_commands(machine_id, completed_at);
  `,
  // Bind a session to the actual profile, and keep quota failures until the next user turn can switch providers.
  `
  ALTER TABLE chat_messages ADD COLUMN tokens TEXT;
  ALTER TABLE chat_messages ADD COLUMN switched_from TEXT;
  ALTER TABLE chat_messages ADD COLUMN rate_limited INTEGER NOT NULL DEFAULT 0;
  `,
  `CREATE TABLE research_runs(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, input TEXT NOT NULL, projects TEXT NOT NULL,
    request_id INTEGER NOT NULL, doc_key TEXT NOT NULL, artifact_id INTEGER, proposal_id INTEGER,
    sources TEXT NOT NULL DEFAULT '[]', recommendations TEXT NOT NULL DEFAULT '');
   CREATE INDEX research_project ON research_runs(project, id);`,
  // New providers get their own pinned catalog entry; existing team entries remain theirs.
  `INSERT OR IGNORE INTO tools(id, entry, builtin, version, updated_at, updated_by) VALUES (
    'kilo-cli', '${JSON.stringify({ id: "kilo-cli", name: "Kilo Code CLI", description: "CLI Kilo native headless JSON; free pool và điều khoản endpoint cần kiểm trước khi gửi dữ liệu.", kind: "cli", package: { registry: "npm", name: "@kilocode/cli", version: "7.8.3" }, agents: ["kilo"], check: ["kilo", "--version"], install: ["npm", "install", "-g", "{package}"], license: "MIT", homepage: "https://kilo.ai/docs/code-with-ai/platforms/cli", enabledByDefault: false, handler: null, mcp: null, plugin: null, hooks: [], prepare: null, env: {}, secretEnv: [] })}',
    0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'hive');`,
  browserSeedSql(),
  // Remote terminal (spec 69, 69a): metadata only, never terminal text. No foreign keys to accounts, projects or
  // machines, so deleting one leaves these rows as its audit headstone until retention purges them. A session's scope
  // never changes after create: the trigger refuses it even for code that forgets.
  `
  ALTER TABLE machines ADD COLUMN terminal_capability TEXT;
  CREATE TABLE terminal_sessions(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, machine_id TEXT NOT NULL, creator TEXT NOT NULL,
    browser_session TEXT NOT NULL, checkout_ref TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL, policy_version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL, last_reason TEXT, version INTEGER NOT NULL DEFAULT 0, writer_epoch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, closed_at TEXT, exit_code INTEGER,
    cleanup_uncertain INTEGER NOT NULL DEFAULT 0, audit_seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(creator, idempotency_key));
  CREATE INDEX terminal_sessions_machine ON terminal_sessions(machine_id, state);
  CREATE INDEX terminal_sessions_project ON terminal_sessions(project, created_at);
  CREATE TRIGGER terminal_sessions_scope BEFORE UPDATE OF id, project, machine_id, creator, checkout_ref, mode, reason, idempotency_key, created_at
    ON terminal_sessions BEGIN SELECT RAISE(ABORT, 'terminal session scope is immutable'); END;
  CREATE TABLE terminal_tickets(
    hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
    account TEXT NOT NULL, browser_session TEXT NOT NULL, epoch INTEGER NOT NULL,
    expires_at TEXT NOT NULL, used_at TEXT);
  CREATE INDEX terminal_tickets_expiry ON terminal_tickets(expires_at);
  CREATE TABLE terminal_stepups(
    hash TEXT PRIMARY KEY, account TEXT NOT NULL, browser_session TEXT NOT NULL, machine_id TEXT NOT NULL,
    project TEXT NOT NULL, operation TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE INDEX terminal_stepups_expiry ON terminal_stepups(expires_at);
  CREATE TABLE terminal_audit_chunks(
    session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
    first_event INTEGER NOT NULL, last_event INTEGER NOT NULL, bytes INTEGER NOT NULL,
    hash TEXT NOT NULL, prev_hash TEXT NOT NULL, storage_ref TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(session_id, seq));
  `,
  // Terminal step-up (69c): a proof for attach or recording is bound to its session too, and keeps how and when the
  // person proved themselves (auth freshness in the audit, spec §8).
  `
  ALTER TABLE terminal_stepups ADD COLUMN session_id TEXT;
  ALTER TABLE terminal_stepups ADD COLUMN method TEXT NOT NULL DEFAULT 'password';
  ALTER TABLE terminal_stepups ADD COLUMN authenticated_at TEXT;
  `,
  // Keep the binding after token revocation: deleting a token must not reopen the machine for a namesake.
  `ALTER TABLE machines ADD COLUMN token_id TEXT;`,
  // Append-only results keep who verified which criterion on which revision, including superseded attempts.
  `CREATE TABLE acceptance_evidence(
    id INTEGER PRIMARY KEY, project TEXT NOT NULL, task_id TEXT NOT NULL,
    spec_hash TEXT NOT NULL, commit_sha TEXT NOT NULL, spec_dir TEXT NOT NULL, spec_branch TEXT NOT NULL, criterion_id TEXT NOT NULL,
    criterion TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL,
    artifacts TEXT NOT NULL, recorded_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX acceptance_evidence_scope ON acceptance_evidence(project, task_id, spec_hash, commit_sha, id);
  CREATE TRIGGER acceptance_evidence_immutable BEFORE UPDATE ON acceptance_evidence
    BEGIN SELECT RAISE(ABORT, 'acceptance evidence is immutable'); END;`,
  `ALTER TABLE run_records ADD COLUMN head_sha TEXT;`,
  // Gate jobs (spec 69h1, 69h2): a job's scope never changes after create, as for a terminal session. A manifest is
  // written once per machine and hash: the approval screen shows what that hash ran, whatever the machine sends later.
  `
  ALTER TABLE machines ADD COLUMN gate_capability TEXT;
  CREATE TABLE gate_manifests(machine_id TEXT NOT NULL, hash TEXT NOT NULL, manifest TEXT NOT NULL, first_seen TEXT NOT NULL, PRIMARY KEY(machine_id, hash));
  CREATE TABLE gate_jobs(
    id TEXT PRIMARY KEY, project TEXT NOT NULL, machine_id TEXT NOT NULL, template_id TEXT NOT NULL, template_hash TEXT NOT NULL,
    timeout_minutes INTEGER NOT NULL, sha TEXT NOT NULL, ref TEXT NOT NULL, purpose TEXT NOT NULL, batch_id INTEGER,
    requested_by TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, version INTEGER NOT NULL DEFAULT 0,
    approval TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, claimed_at TEXT, lease_until TEXT, lease_hash TEXT, receipt TEXT,
    UNIQUE(project, template_hash, sha, idempotency_key));
  CREATE INDEX gate_jobs_machine ON gate_jobs(machine_id, state);
  CREATE INDEX gate_jobs_sha ON gate_jobs(project, sha);
  CREATE INDEX gate_jobs_batch ON gate_jobs(batch_id);
  CREATE TRIGGER gate_jobs_scope BEFORE UPDATE OF id, project, machine_id, template_id, template_hash, timeout_minutes, sha, ref, purpose, batch_id, requested_by, idempotency_key, created_at, expires_at
    ON gate_jobs BEGIN SELECT RAISE(ABORT, 'gate job scope is immutable'); END;
  `,
  `ALTER TABLE machines ADD COLUMN runner_settings TEXT;
   ALTER TABLE machines ADD COLUMN runner_change TEXT;
   ALTER TABLE machine_profile_changes ADD COLUMN stop_at_session INTEGER;
   ALTER TABLE machine_profile_changes ADD COLUMN stop_at_week INTEGER;`,
  `CREATE TABLE mr_ci_policy(project TEXT NOT NULL, mr_url TEXT NOT NULL, stopped_by TEXT NOT NULL, stopped_at TEXT NOT NULL, PRIMARY KEY(project, mr_url));`,
];

function browserSeedSql(): string {
  const { id, ...entry } = BROWSER_TOOL;
  const json = JSON.stringify(entry).replaceAll("'", "''");
  return `INSERT OR IGNORE INTO tools(id, entry, builtin, version, updated_at, updated_by) VALUES ('${id}', '${json}', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'hive');`;
}

/**
 * The seeds as the 28a migration wrote them, frozen: a migration must mean the same on every hub, whenever it runs.
 * Newer versions go through tools.save (after 28b, when machines read the catalog), never through this list.
 */
function toolSeedSql(): string {
  const seeds: ToolEntry[] = [
    {
      id: "codegraph",
      name: "Codegraph",
      description: "Đồ thị mã nguồn qua MCP: một lần gọi trả về symbol, đường gọi và phạm vi ảnh hưởng, thay cho grep và đọc nhiều file.",
      kind: "mcp",
      package: { registry: "npm", name: "@colbymchenry/codegraph", version: "1.6.0" },
      mcp: { command: "npx", args: ["-y", "{package}", "serve", "--mcp"] },
      plugin: null,
      hooks: [],
      agents: ["claude"],
      check: null,
      install: null,
      prepare: { init: ["npx", "-y", "{package}", "init", "{worktree}"], sync: ["npx", "-y", "{package}", "sync", "{worktree}"], marker: ".codegraph/codegraph.db" },
      env: { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
      secretEnv: [],
      license: "MIT",
      homepage: "https://github.com/colbymchenry/codegraph",
      handler: "codegraph",
      enabledByDefault: false,
    },
    {
      id: "superpowers",
      name: "Superpowers",
      description: "Plugin Claude Code gồm các skill lập kế hoạch, làm theo test và gỡ lỗi.",
      kind: "plugin",
      package: { registry: "claude-plugin", name: "superpowers@claude-plugins-official", version: "6.4.2" },
      mcp: null,
      plugin: "superpowers@claude-plugins-official",
      hooks: [],
      agents: ["claude"],
      check: null,
      install: null,
      prepare: null,
      env: {},
      secretEnv: [],
      license: "MIT",
      homepage: "https://github.com/obra/superpowers",
      handler: "superpowers",
      enabledByDefault: false,
    },
    {
      id: "speckit",
      name: "Spec Kit",
      description: "CLI Spec Kit của GitHub (specify): spec, plan và tasks cho từng tính năng, trong specs/ của repo.",
      kind: "cli",
      package: { registry: "git", name: "https://github.com/github/spec-kit.git", version: "v1.0.13" },
      mcp: null,
      plugin: null,
      hooks: [],
      agents: ["claude", "codex"],
      check: ["specify", "--version"],
      install: ["uv", "tool", "install", "specify-cli", "--from", "{package}"],
      prepare: null,
      env: {},
      secretEnv: [],
      license: "MIT",
      homepage: "https://github.com/github/spec-kit",
      handler: "speckit",
      enabledByDefault: false,
    },
  ];
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return seeds
    .map(({ id, ...entry }) => `INSERT INTO tools(id, entry, builtin, version, updated_at, updated_by) VALUES (${quote(id)}, ${quote(JSON.stringify(entry))}, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'hive');`)
    .join("\n  ");
}

/** RTK as the 28d migration wrote it, frozen like toolSeedSql: a newer version goes through tools.save. */
function rtkSeedSql(): string {
  const entry: Omit<ToolEntry, "id"> = {
    name: "RTK",
    description: "Nén output lệnh Bash của agent (git, test, build…) để đọc ít token hơn; chỉ cho run Claude.",
    kind: "hook",
    package: { registry: "brew", name: "rtk", version: "0.50.0" },
    mcp: null,
    plugin: null,
    hooks: [{ event: "PreToolUse", matcher: "Bash", command: ["rtk", "hook", "claude"] }],
    agents: ["claude"],
    check: ["rtk", "--version"],
    install: ["brew", "install", "{package}"],
    prepare: null,
    env: { RTK_TELEMETRY_DISABLED: "1", RTK_SUPPRESS_HOOK_WARNING: "1", RTK_DB_PATH: "{runDir}/rtk.db" },
    secretEnv: [],
    license: "Apache-2.0",
    homepage: "https://github.com/rtk-ai/rtk",
    handler: null,
    enabledByDefault: false,
  };
  const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return `INSERT OR IGNORE INTO tools(id, entry, builtin, version, updated_at, updated_by) VALUES ('rtk', ${quote(JSON.stringify(entry))}, 0, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'hive');`;
}

/** A leader's reply asks for at most this many actions. */
const CHAT_ACTIONS_PER_REPLY = 20;
/** More for the hub-wide leader (roadmap 37): one instruction there can touch every project at once. */
const CHAT_ACTIONS_PER_HUB_REPLY = 50;

/**
 * How long a task waits for its classify run (roadmap 54b) before it starts with the default class anyway: the run
 * itself takes seconds, so this only covers a machine that took the request and then went quiet.
 */
const CLASSIFY_WAIT_MINUTES = 10;

/**
 * What confirming each kind of chat action calls, as the person confirming (roadmap 29b): the method, the input it gets
 * from the stored one, and what the card keeps of its answer. One row per kind, so a new kind (28e, 29c) is one line.
 */
interface ChatCall {
  method: Method;
  input?: (stored: Record<string, unknown>) => Record<string, unknown>;
  result?: (output: unknown) => NonNullable<ChatAction["result"]>;
}
const CHAT_ACTION_CALLS: Record<Exclude<ChatActionKind, "plan.create" | "research.start">, ChatCall> = {
  // The card's `taskKind` is the task's `kind`: in the action, `kind` already names the action.
  "task.create": { method: "tasks.create", input: ({ taskKind, ...rest }) => ({ ...rest, kind: taskKind }), result: (o) => ({ taskId: (o as Task).id }) },
  "task.update": { method: "tasks.update", result: (o) => ({ taskId: (o as Task).id }) },
  "task.classify": { method: "tasks.classify", input: ({ id, taskKind, size, risk }) => ({ id, kind: taskKind, size, risk }), result: (o) => ({ taskId: (o as Task).id }) },
  // `machine` is only the name the card shows; tasks.assign takes the hub id.
  "task.assign": { method: "tasks.assign", input: ({ id, machineId, profileId }) => ({ id, machineId, profileId }), result: (o) => ({ taskId: (o as Task).id }) },
  "run.dispatch": { method: "runs.dispatch", result: (o) => ({ requestId: (o as RunRequest).id }) },
  "run.cancel": { method: "runs.cancel" },
  "run.merge": { method: "runs.merge" },
  "machine.profile": { method: "machines.setProfile" },
  // `before` is only what the card shows; agentPolicy.set takes no such field.
  "agent.policy": { method: "agentPolicy.set", input: ({ project, policy }) => ({ project, policy }) },
  "agents.stop": { method: "agents.stop" },
  "agents.resume": { method: "agents.resume" },
  "machine.install": { method: "admin.commandCreate", result: (o) => ({ commandId: (o as MachineCommand).id }) },
  // `name` and `before` are only what the card shows.
  "tool.enable": { method: "tools.setProject", input: ({ id, project, enabled, required }) => ({ id, project, enabled, required }) },
};

/**
 * Confirm all (chat.decideAll): tasks before what refers to them; agents resumed before runs are queued, and stopped
 * last, so a reply that also says "stop everything" does not block what was confirmed with it.
 */
const CHAT_DECIDE_ORDER: Record<ChatActionKind, number> = {
  "plan.create": 0,
  "research.start": 10,
  "task.create": 0,
  "task.update": 1,
  // Before task.assign: a task given to an agent with no kind yet gets a classify run first.
  "task.classify": 1,
  // After the task exists and has its status; the hub starts it by itself from there (roadmap 50).
  "task.assign": 2,
  "agent.policy": 3,
  // A tool turned on before a machine is asked to install it, and both before the runs that use it.
  "tool.enable": 4,
  "machine.profile": 5,
  "machine.install": 6,
  "agents.resume": 7,
  "run.cancel": 8,
  "run.merge": 9,
  "run.dispatch": 10,
  "agents.stop": 11,
};

/**
 * A run's log and patch (the heavy part) are dropped this long after its last update; the record itself — summary,
 * error, branch, MR, merge, cost, who asked — stays for good, so what an agent concluded is never lost (roadmap 41b).
 */
const RUN_LOG_DAYS = 30;
/** Screenshots and reports of a finished task are evidence for its review; a month later nobody opens them. */
const ARTIFACT_DAYS = 30;

/** A run's tokens beside its record (run_costs joined as c), as toRunRecord reads them. */
const RUN_TOKEN_COLUMNS = "c.input_tokens AS tok_input, c.cache_write_tokens AS tok_cache_write, c.cache_read_tokens AS tok_cache_read, c.output_tokens AS tok_output";
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** A pushed text as the team may see it: no hidden characters, no line that looks like a secret. */
const clean = (text: string | null) => (text === null ? null : redactLines(stripHidden(text)));

// Error vars are rendered beside the message; cleaning the message alone still exposes a credential in a var.
const cleanMachineError = (error: RunRequestError | null): RunRequestError | null => error === null ? null : {
  ...error,
  message: clean(error.message)!,
  ...(error.vars ? { vars: Object.fromEntries(Object.entries(error.vars).map(([key, value]) => [key, typeof value === "string" ? clean(value)! : value])) } : {}),
};

/** Stage and progress come from the files, so the list does not have to send them. */
function toSpecFeature(r: Row): SpecFeatureDetail {
  const files = JSON.parse(str(r.files)) as SpecFiles;
  const tasks = specTasks(files.tasks);
  return {
    project: str(r.project),
    dir: str(r.dir),
    branch: str(r.branch),
    title: str(r.title),
    stage: specStage(files),
    tasksDone: tasks.done,
    tasksTotal: tasks.total,
    commit: str(r.commit_sha),
    machine: str(r.machine),
    pushedAt: str(r.pushed_at),
    files,
  };
}

// Read the original request rather than recomputing a reason from settings that may have changed since dispatch.
const RUN_SELECTION_COLUMN = `COALESCE(
  (SELECT q.selection FROM run_requests q WHERE q.project = r.project AND q.machine_id = r.machine_id
    AND q.status = 'accepted' AND q.run_id = r.run_id ORDER BY q.id DESC LIMIT 1),
  (SELECT json_extract(q.selection, '$.review') FROM run_requests q WHERE r.role = 'review' AND q.project = r.project
    AND q.machine_id = r.machine_id AND q.status = 'accepted' AND q.run_id = r.parent_run ORDER BY q.id DESC LIMIT 1)
) AS router_selection`;

function toRunMessage(r: Row): RunMessage {
  return { id: num(r.id), machineId: str(r.machine_id), runId: str(r.run_id), text: str(r.text), by: str(r.by), at: str(r.at), deliveredAt: strOrNull(r.delivered_at) };
}

function toRunRecord(r: Row, withLog: boolean): RunRecord {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
    plan: r.plan == null ? null : JSON.parse(str(r.plan)) as RunPlan,
    machineId: str(r.machine_id),
    machine: str(r.machine),
    runId: str(r.run_id),
    project: str(r.project),
    taskId: str(r.task_id),
    taskTitle: str(r.task_title),
    role: str(r.role),
    status: str(r.status),
    profileId: s(r.profile_id),
    activity: s(r.activity),
    summary: s(r.summary),
    error: s(r.error),
    branch: s(r.branch),
    commits: num(r.commits),
    mrUrl: s(r.mr_url),
    costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
    createdAt: str(r.created_at),
    startedAt: s(r.started_at),
    finishedAt: s(r.finished_at),
    updatedAt: str(r.updated_at),
    cancelRequestedBy: s(r.cancel_by),
    cancelRequestedAt: s(r.cancel_at),
    mr: r.mr == null ? null : (JSON.parse(String(r.mr)) as RunMr),
    skills: JSON.parse(String(r.skills ?? "[]")),
    // From run_costs when the query joined it (runs.list / runs.get) and the machine reported the run.
    compression: r.compression == null ? null : (JSON.parse(String(r.compression)) as RunCompression),
    tokens:
      r.tok_output == null && r.tok_input == null
        ? null
        : { inputTokens: numOrNull(r.tok_input), cacheWriteTokens: numOrNull(r.tok_cache_write), cacheReadTokens: numOrNull(r.tok_cache_read), outputTokens: numOrNull(r.tok_output) },
    merge:
      r.merge_status == null
        ? null
        : {
            requestedBy: str(r.merge_by),
            requestedAt: str(r.merge_at),
            status: str(r.merge_status) as MergeStatus,
            error: r.merge_error == null ? null : (JSON.parse(String(r.merge_error)) as RunRequestError),
            finishedAt: s(r.merge_done_at),
          },
    logPrunedAt: s(r.log_pruned_at),
    kind: s(r.kind) as AgentKind | null,
    model: s(r.model),
    effort: s(r.effort),
    tier: s(r.tier),
    selection: r.router_selection == null ? null : (JSON.parse(str(r.router_selection)) as ModelSelection),
    attempt: numOrNull(r.attempt),
    parentRun: s(r.parent_run),
    parentMachineId: s(r.parent_machine_id) ?? (r.parent_run ? str(r.machine_id) : null),
    baseSha: s(r.base_sha),
    headSha: s(r.head_sha),
    ...(withLog ? { instructions: s(r.instructions) ?? s(r.request_instructions) } : {}),
    verdict: s(r.verdict) as Verdict | null,
    ...(withLog ? { log: str(r.log), patch: r.patch == null ? null : str(r.patch), diffReview: r.diff_review == null ? null : JSON.parse(str(r.diff_review)) } : {}),
  };
}

/** Entries embedded per request while indexing. */
const EMBED_BATCH = 16;
/** A search waits this long for the query's vector, then answers from words alone. */
const QUERY_EMBED_MS = 5000;
/** Vectors as stored: float32, little-endian like every platform the hub runs on. */
const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Run costs older than this are dropped; the summary only looks back 30 days. */
const COST_DAYS = 90;

/** A machine is online if it sent a heartbeat this recently (runners send one every 30 s). */
const ONLINE_MINUTES = 2;
/** Instances seen alternating within this window count as two apps under one machine name. */
const DUPLICATE_MINUTES = 5;
/** Machines silent for this long are dropped. */
const MACHINE_TTL_DAYS = 14;
/**
 * A profile change the machine has not reported within this time is dropped: machines apply one at the next heartbeat,
 * so that one went away for good, or lost the profile.
 */
const PROFILE_CHANGE_HOURS = 24;
/** A command nobody approved on the machine within this time is dropped. */
const COMMAND_TTL_HOURS = 24;
/** Commands kept per machine in the admin view. */
const COMMAND_HISTORY = 20;
/**
 * A sync request not taken or not finished within this time expires: machines hear it within 30 s and a sync takes
 * seconds, so the machine went away, or its app is older than sync requests and never takes it.
 */
const SYNC_TTL_MINUTES = 15;
/** A run request no machine took within this time expires: machines ask every 30 s, so that one is gone. */
const RUN_REQUEST_TTL_MINUTES = 15;
/** A run its machine took but has not pushed yet keeps its group's place this long (roadmap 31a). */
const GROUP_UNREPORTED_MINUTES = 10;
/** Runs of one assignment that may be cut short (rate limit, app closed) before the agent's turn counts as used. */
const MAX_INTERRUPTED_TURNS = 3;
/**
 * What the desktop app writes as the error of a run it found still running at start (runNote.appClosed). The push
 * carries no reason code, so the hub tells "the app closed" from a real failure by this text.
 */
const APP_CLOSED_ERRORS = ["The app closed while the run was going", "App đã đóng khi run đang chạy"];
/** What fails a group's item when it is released; anything else (offline, cap, pause, a run going) waits for later. */
const GROUP_FAILS = new Set(["errors.machineNotFound", "errors.machineNoRepo", "errors.dispatchAssignedElsewhere", "errors.taskDone", "errors.taskNotInProject", "errors.profileNotOnMachine", "errors.secret"]);
const groupFails = (key: string | undefined) => !!key && (GROUP_FAILS.has(key) || key.startsWith("errors.hidden."));
/** A merge no machine reported on within this time failed: machines hear one within 30 s, and a merge takes seconds. */
const MERGE_TTL_MINUTES = 15;
/** Answered run requests are kept this long. */
const RUN_REQUEST_DAYS = 30;
/** A chat reply no machine started within this time expires; one that stops reporting for as long has failed. */
const CHAT_WAIT_MINUTES = 15;
/** Threads nobody wrote in for this long are dropped with their messages. */
const CHAT_DAYS = 90;

/** Allowed status moves for a machine reporting on a command. */
const COMMAND_MOVES: Record<CommandStatus, CommandStatus[]> = {
  pending: ["running", "rejected", "done", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: [],
  rejected: [],
  cancelled: [],
  expired: [],
};

const clipDetail = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

/**
 * Admin actions written to the audit log: method → what it acted on. Reads are never logged.
 * `text` is the detail as a message key of the UI catalogue, so the log reads in each admin's language.
 */
const AUDITED: Partial<Record<Method, (input: any, output: any) => { target: string; detail?: string; text?: ErrorText }>> = {
  "evidence.record": (i, o: AcceptanceEvidence) => ({ target: `${i.project} ${i.taskId} #${o.id}`, detail: `${i.criterionId}: ${i.outcome} @ ${i.commitSha}`, text: { key: "audit.evidenceRecorded", vars: { criterion: i.criterionId, outcome: i.outcome, sha: i.commitSha } } }),
  "docs.save": (i, o) => ({ target: i.key, detail: `v${o.version}${i.note ? ` · ${i.note}` : ""}` }),
  "docs.move": (i, o) => ({ target: i.key, detail: i.to ? `→ ${i.to}${o.moved.length > 1 ? ` (+${o.moved.length - 1})` : ""}` : `→ ${i.parent ?? "/"}` }),
  "docs.remove": (i, o) => ({ target: i.key, detail: `− ${o.keys.length}${i.note ? ` · ${i.note}` : ""}` }),
  "docs.restore": (i, o) => ({ target: i.key, detail: `+ ${o.keys.length}` }),
  "docs.assetPut": (i, o) => ({ target: i.key, detail: `+ ${o.name}` }),
  "docs.assetRemove": (i, o) => (o.removed ? { target: i.key, detail: `− ${i.name}` } : { target: i.key, detail: `− ${i.name} (—)` }),
  "artifacts.remove": (i, o) =>
    o.removed
      ? { target: `${o.project} #${i.id}`, detail: `− ${o.name}`, text: { key: "audit.artifactRemoved", vars: { name: o.name } } }
      : { target: `#${i.id}`, detail: "− (—)" },
  "proposals.approve": (i, o) => ({ target: o.docKey, detail: `đề xuất #${i.id}`, text: { key: "audit.proposal", vars: { id: i.id } } }),
  "proposals.reject": (i, o) => {
    const text: ErrorText = i.note ? { key: "audit.proposalNote", vars: { id: i.id, note: i.note } } : { key: "audit.proposal", vars: { id: i.id } };
    return { target: o.docKey, detail: `đề xuất #${i.id}${i.note ? ` · ${i.note}` : ""}`, text };
  },
  "memory.setCleanup": (i) => ({ target: i.project, detail: `enabled=${i.enabled}` }),
  "memory.decideCleanup": (i, o) => ({ target: `${o.project} memory proposal #${i.id}`, detail: o.status }),
  "runs.stopCi": (i) => ({ target: i.project, detail: i.mrUrl }),
  "memory.share": (i) => ({ target: `memory #${i.id}`, detail: "shared" }),
  "memory.approve": (i, o) => ({ target: `${o.project ?? "org"} #${i.id}` }),
  "memory.remove": (i) => ({ target: `memory #${i.id}` }),
  "tasks.create": (i) => ({ target: i.id, detail: i.dependsOn?.length ? `${i.title} · ← ${i.dependsOn.join(", ")}` : i.title }),
  "tasks.requestChanges": (i) => ({ target: i.id, detail: i.note }),
  "tasks.update": (i, o: Task) => ({
    target: o.id,
    detail: `→ ${o.status}${i.note !== undefined ? " · cập nhật ghi chú" : ""}`,
    text: { key: i.note !== undefined ? "audit.taskStatusNote" : "audit.taskStatus", vars: { status: o.status } },
  }),
  "tasks.setDeps": (i) => ({ target: i.id, detail: i.dependsOn.length ? `← ${i.dependsOn.join(", ")}` : "—" }),
  "tasks.assign": (i, o: Task) => {
    const agent = o.agent ? `${o.agent.machine}${o.agent.profileId ? `/${o.agent.profileId}` : ""}` : "—";
    return { target: i.id, detail: `agent ${agent}`, text: { key: "audit.taskAssign", vars: { agent } } };
  },
  "tasks.unassign": (i) => ({ target: i.id, detail: "bỏ gán agent", text: { key: "audit.taskUnassign" } }),
  "machines.remove": (i) => ({ target: i.id }),
  "machines.manageWorktrees": (i, o: WorktreeCommand) => ({ target: i.machineId, detail: JSON.stringify({ targets: o.targets.map(t => `${t.project}/${t.path}`), force: o.force, cleanup: o.cleanup }) }),
  "machines.approveTool": (i, o: ToolApproval) => ({ target: `${i.machineId}/${o.toolId}`, detail: o.hash, text: { key: "audit.toolApproved", vars: { tool: o.toolId, hash: o.hash } } }),
  "machines.setRunner": (i) => ({ target: i.machineId, detail: JSON.stringify(i.settings) }),
  "machines.setProfile": (i, o: Machine) => {
    if (i.stopAtSession !== undefined || i.stopAtWeek !== undefined) return { target: `${o.machine}/${i.profileId}`, detail: JSON.stringify({ enabled: i.enabled, priority: i.priority, stopAtSession: i.stopAtSession, stopAtWeek: i.stopAtWeek }) };
    const key = i.enabled === undefined ? "audit.profilePriority" : i.priority === undefined ? (i.enabled ? "audit.profileOn" : "audit.profileOff") : i.enabled ? "audit.profileOnPriority" : "audit.profileOffPriority";
    const parts = [i.enabled === undefined ? "" : i.enabled ? "bật" : "tắt", i.priority === undefined ? "" : `ưu tiên ${i.priority}`].filter(Boolean).join(", ");
    return { target: `${o.machine}/${i.profileId}`, detail: parts, text: { key, vars: { profile: i.profileId, priority: i.priority ?? "" } } };
  },
  "cooldowns.clear": (i) => ({ target: i.account }),
  "systems.save": (i, o: HiveSystem) => ({ target: i.name, detail: o.projects.join(", "), text: { key: "audit.system", vars: { projects: o.projects.join(", ") } } }),
  "systems.remove": (i) => ({ target: i.name }),
  "projects.archive": (i) => ({ target: i.project, detail: "lưu trữ", text: { key: "audit.projectArchived" } }),
  "projects.restore": (i) => ({ target: i.project, detail: "khôi phục", text: { key: "audit.projectRestored" } }),
  "tasks.setClassifyConfig": (i: { project: string; enabled: boolean }) => ({
    target: i.project,
    detail: i.enabled ? "bật AI phân loại task" : "tắt AI phân loại task",
    text: { key: i.enabled ? "audit.classifyOn" : "audit.classifyOff" },
  }),
  // The row count is the only record of what a deletion took: nothing is left in the tables to look at afterwards.
  "projects.delete": (i, o: ProjectDeleted) => {
    const rows = Object.values(o.rows).reduce((n, v) => n + v, 0);
    return { target: i.project, detail: `xoá hẳn · ${rows} dòng · backup ${o.backup}`, text: { key: "audit.projectDeleted", vars: { rows, backup: o.backup } } };
  },
  "projects.retire": (i) => ({ target: i.project, detail: i.note ?? undefined }),
  "projects.resume": (i) => ({ target: i.project }),
  "policy.set": (_i, o: TeamPolicy) => ({
    target: "policy",
    detail: `CLI: ${o.requiredClis.join(", ") || "—"} · shim: ${o.requireShim ? "có" : "không"} · ${Object.keys(o.projects).length} dự án · ${o.profileTemplates.length} mẫu profile`,
    text: {
      key: o.requireShim ? "audit.policyShim" : "audit.policy",
      vars: { clis: o.requiredClis.join(", ") || "—", projects: Object.keys(o.projects).length, templates: o.profileTemplates.length },
    },
  }),
  "autoRelease.green": (i, o) => ({ target: `${i.project}/${i.batchId}`, detail: `${i.version} · ${o.state}` }),
  "autoRelease.result": (i) => ({ target: `${i.project}/${i.batchId}`, detail: `${i.step} · ${i.success ? "success" : "failed"}${i.warning ? " · warning" : ""}` }),
  "autoRelease.decide": (i) => ({ target: `${i.project}/${i.batchId}`, detail: i.pass ? "approved" : "rejected" }),
  "autoRelease.reconcile": (i) => ({ target: `${i.project}/${i.batchId}`, detail: "reconciled: failed" }),
  "autoRelease.resume": (i) => ({ target: i.project, detail: "release queue resumed" }),
  "sdlc.setCeiling": (i: { ceiling: Partial<GateModes> }) => {
    const summary = gateSummary(fullCeiling(i.ceiling));
    return { target: "hub", detail: `trần: ${summary}`, text: { key: "audit.sdlcCeiling", vars: { summary } } };
  },
  "sdlc.setProject": (i: { project: string; settings: { gates: Partial<GateModes> } | null }) => {
    if (!i.settings) return { target: i.project, detail: "mọi chốt về người duyệt", text: { key: "audit.sdlcProjectCleared" } };
    const summary = gateSummary(i.settings.gates);
    return { target: i.project, detail: summary, text: { key: "audit.sdlcProject", vars: { summary } } };
  },
  "agentPolicy.set": (i: { project: string | null; policy: Partial<AgentPolicy> | null }) => {
    const target = i.project ?? "hub";
    if (!i.policy) return { target, detail: "bỏ chính sách agent", text: { key: "audit.agentPolicyCleared" } };
    const summary = policySummary(i.policy);
    return { target, detail: summary, text: { key: "audit.agentPolicy", vars: { summary } } };
  },
  "modelRouter.set": (i: { project: string | null; setting?: { enabled: boolean; profile: string } }) =>
    i.project === null
      ? { target: "hub", detail: "bảng cấp và bảng loại × cỡ" }
      : { target: i.project, detail: i.setting!.enabled ? `chọn model: ${i.setting!.profile}` : "tắt chọn model" },
  "modelLearning.set": (i: { project: string; enabled?: boolean; lock?: { kind: string; size: string; locked: boolean }; apply?: { kind: string; size: string } }) => ({
    target: i.project,
    detail: [
      i.enabled === undefined ? null : i.enabled ? "bật tự học" : "tắt tự học",
      i.lock ? `${i.lock.locked ? "khoá" : "mở khoá"} ô ${i.lock.kind}/${i.lock.size}` : null,
      i.apply ? `áp dụng đề xuất ${i.apply.kind}/${i.apply.size}` : null,
    ]
      .filter(Boolean)
      .join(", "),
  }),
  "tools.save": (i: { baseVersion?: number }, o: ToolView) => {
    const pkg = o.package ? `${o.package.name}@${o.package.version}` : "—";
    return { target: o.id, detail: `v${o.version} · ${pkg}`, text: { key: i.baseVersion === undefined ? "audit.toolAdded" : "audit.toolSaved", vars: { pkg, version: o.version } } };
  },
  "tools.remove": (i, o: { removed: boolean }) => (o.removed ? { target: i.id } : { target: i.id, detail: "(—)" }),
  "tools.setProject": (i: { id: string; project: string; enabled: boolean | null; required: boolean }) => {
    const state = i.enabled === null ? "default" : i.enabled ? "on" : "off";
    const words = { default: "theo mặc định", on: "bật", off: "tắt" }[state];
    return {
      target: `${i.project}/${i.id}`,
      detail: `${words}${i.required ? ", bắt buộc" : ""}`,
      text: { key: i.required ? `audit.toolProject.${state}Required` : `audit.toolProject.${state}`, vars: { project: i.project, tool: i.id } },
    };
  },
  "budgets.set": (_i, o: BudgetUsage[]) => ({
    target: "budgets",
    detail: o.map((b) => b.id).join(", ") || "—",
    text: { key: "audit.budgets", vars: { count: o.length } },
  }),
  "admin.commandCreate": (i, o: MachineCommand) => ({
    target: i.machineId,
    detail: `yêu cầu ${o.label} (${i.itemId}, #${o.id})`,
    text: { key: "audit.commandCreate", vars: { label: o.label, item: i.itemId, id: o.id } },
  }),
  "admin.commandCancel": (i, o: MachineCommand) => ({
    target: o.machineId,
    detail: `huỷ #${i.id} ${o.itemId}`,
    text: { key: "audit.commandCancel", vars: { id: i.id, item: o.itemId } },
  }),
  "machines.commandResult": (i, o: MachineCommand) => ({ target: o.machineId, detail: `#${i.id} ${o.itemId} → ${i.status}` }),
  "docs.syncRequest": (i, o: MachineCommand[]) => ({
    target: i.project,
    detail: `yêu cầu đồng bộ trên ${o.length} máy`,
    text: { key: "audit.syncRequest", vars: { count: o.length } },
  }),
  "runs.setTimeoutSettings": () => ({ target: "hub", detail: "run timeout settings", text: { key: "audit.runTimeoutSettings" } }),
  "research.start": (_i, o: Research) => ({ target: String(o.id), detail: o.input.topic, text: { key: "audit.research", vars: { id: o.id } } }),
  "runs.dispatch": (_i, o: RunRequest) => ({
    target: `${o.project}/${o.taskId}`,
    detail: `run ${o.role} trên ${o.machine} (#${o.id})`,
    text: { key: "audit.runDispatch", vars: { role: o.role, machine: o.machine, id: o.id } },
  }),
  "runs.dispatchMany": (_i, o: RunGroup) => ({
    target: o.project,
    detail: `đợt chạy #${o.id}: ${o.items.length} task${o.maxParallel ? `, tối đa ${o.maxParallel} cùng lúc` : ""}`,
    text: { key: "audit.runGroup", vars: { id: o.id, count: o.items.length } },
  }),
  "runs.fanout": (_i, o: RunGroup) => ({
    target: `${o.project}/${o.parentTask}`,
    detail: `một prompt cho ${o.items.length} agent (đợt chạy #${o.id})`,
    text: { key: "audit.runFanout", vars: { id: o.id, count: o.items.length } },
  }),
  "runs.pickWinner": (_i, o: RunGroup) => ({
    target: `${o.project}/${o.winnerTask}`,
    detail: `giữ ${o.winnerTask} trong ${o.parentTask} (đợt chạy #${o.id})`,
    text: { key: "audit.runPick", vars: { task: o.winnerTask ?? "", parent: o.parentTask ?? "", id: o.id } },
  }),
  "runs.mapReduce": (_i, o: RunGroup) => ({
    target: `${o.project}/${o.parentTask}`,
    detail: `chia ${o.parentTask} thành ${o.items.length} phần (đợt chạy #${o.id})`,
    text: { key: "audit.runMapReduce", vars: { id: o.id, count: o.items.length, task: o.parentTask ?? "" } },
  }),
  "runs.roles": (_i, o: RunGroup) => ({
    target: `${o.project}/${o.parentTask}`,
    detail: `chuỗi ${o.items.length} vai trên ${o.parentTask} (đợt chạy #${o.id})`,
    text: { key: "audit.runRoles", vars: { id: o.id, count: o.items.length, task: o.parentTask ?? "" } },
  }),
  "runs.mapSplit": (_i, o: RunGroup) => ({
    target: `${o.project}/${o.parentTask}`,
    detail: `nhờ agent chia ${o.parentTask} (đợt chạy #${o.id})`,
    text: { key: "audit.runMapSplit", vars: { id: o.id, task: o.parentTask ?? "" } },
  }),
  "runs.resumeGroup": (_i, o: RunGroup) => ({
    target: o.project,
    detail: `chạy lại đợt chạy #${o.id}`,
    text: { key: "audit.runGroupResume", vars: { id: o.id } },
  }),
  "runs.cancelGroup": (_i, o: RunGroup) => ({
    target: o.project,
    detail: `huỷ đợt chạy #${o.id}`,
    text: { key: "audit.runGroupCancel", vars: { id: o.id } },
  }),
  "runs.prompt": (_i, o: { task: Task; request: RunRequest }) => ({
    target: `${o.request.project}/${o.task.id}`,
    detail: `prompt → run trên ${o.request.machine} (#${o.request.id})`,
    text: { key: "audit.runPrompt", vars: { machine: o.request.machine, id: o.request.id } },
  }),
  "chat.setAutonomy": (i, o: ChatDefaults) => ({
    target: i.project,
    detail: o.autoKinds.join(", ") || "—",
    text: { key: "audit.chatAutonomy", vars: { kinds: o.autoKinds.join(", ") || "—" } },
  }),
  "runs.merge": (_i, o: RunRecord) => ({
    target: `${o.project}/${o.taskId}`,
    detail: `merge ${o.mrUrl} trên ${o.machine}`,
    text: { key: "audit.runMerge", vars: { mr: o.mrUrl ?? "", machine: o.machine } },
  }),
  "runs.cancelRequest": (i, o: RunRequest) => ({
    target: `${o.project}/${o.taskId}`,
    detail: `huỷ yêu cầu run #${i.id}`,
    text: { key: "audit.runRequestCancel", vars: { id: i.id } },
  }),
  "agents.stop": (i, o: AgentsStop) => ({
    target: i.project ?? "hub",
    detail: `dừng mọi agent: huỷ ${o.requests} yêu cầu, dừng ${o.runs} run, huỷ ${o.chats} chat`,
    text: { key: "audit.agentsStop", vars: { requests: o.requests, runs: o.runs, chats: o.chats } },
  }),
  "agents.resume": (i) => ({ target: i.project ?? "hub", detail: "cho agent chạy lại", text: { key: "audit.agentsResume" } }),
};

/**
 * What an agent writes (roadmap 27c): logged when the actor is an agent (isAgentActor), with its label, the account it
 * acted for and its run, so the log tells what each agent did. Methods in AUDITED are logged for everyone instead.
 * Left out: what machines report about themselves (heartbeat, runs.push, chat.progress), which is not an agent's doing.
 */
const AGENT_AUDITED: Partial<Record<Method, (input: any, output: any) => { target: string; detail?: string; text?: ErrorText }>> = {
  "tasks.claim": (i, o: { claimed: boolean }) => ({ target: i.id, detail: o.claimed ? "nhận task" : "chưa nhận được: người khác đang giữ", text: { key: o.claimed ? "audit.taskClaimed" : "audit.taskNotClaimed" } }),
  "proposals.create": (_i, o: Proposal) => ({ target: o.docKey, detail: `đề xuất #${o.id}`, text: { key: "audit.proposal", vars: { id: o.id } } }),
  "memory.write": (_i, o: Memory) => ({ target: `${o.project ?? "org"} #${o.id}`, detail: `${o.kind} · ${o.content}`, text: { key: "audit.memoryWrite", vars: { kind: o.kind, content: clipDetail(o.content) } } }),
  "memory.resolve": (i) => ({ target: `memory #${i.id}`, detail: `#${i.other} · ${i.keep}` }),
  "memory.keep": (i) => ({ target: `memory #${i.id}` }),
  "chat.send": (_i, o: { thread: ChatThread }) => ({ target: `${o.thread.project} · chat #${o.thread.id}` }),
  "chat.propose": (_i, o: ChatAction) => ({ target: `${o.project} · chat #${o.threadId}`, detail: o.kind, text: { key: "audit.chatPropose", vars: { kind: o.kind, id: o.id } } }),
  "chat.decide": (_i, o: ChatAction) => ({ target: `${o.project} · chat #${o.threadId}`, detail: `${o.kind} → ${o.status}` }),
  "chat.decideAll": (i, o: ChatAction[]) => ({ target: `chat reply #${i.replyId}`, detail: `${o.length} · ${i.accept ? "nhận" : "bỏ"}` }),
};

/**
 * The writes an archived or deleted project refuses (roadmap 47), and where each one's project is: `project` for the
 * input's own field, `task` / `thread` / `doc` / `proposal` for the row it names. Spelled out method by method on
 * purpose — a write added later is refused only once someone says where its project is, instead of being caught (or
 * missed) by a rule that guesses from the input's field names.
 * Not here, and so still allowed: what machines report about work already going (runs.push, machines.heartbeat,
 * docs.assistFinish…), and clearing up (cancelling, removing memory, deleting a thread).
 */
const PROJECT_WRITES: Partial<Record<Method, "project" | "task" | "thread" | "doc" | "proposal">> = {
  "evidence.record": "project",
  "autoRelease.green": "project",
  "autoRelease.take": "project",
  "autoRelease.decide": "project",
  "autoRelease.rollout": "project",
  "autoRelease.resume": "project",

  "mergeQueue.configure": "project",
  "mergeQueue.take": "project",
  "docs.save": "doc",
  "docs.move": "doc",
  "docs.assetPut": "doc",
  "docs.assetRemove": "doc",
  "docs.assist": "doc",
  "docs.syncRequest": "project",
  "proposals.create": "doc",
  "proposals.approve": "proposal",
  "memory.write": "project",
  "memory.setCleanup": "project",
  "tasks.create": "project",
  "tasks.setDeps": "task",
  "tasks.claim": "task",
  "tasks.update": "task",
  "tasks.classify": "task",
  "tasks.setClassifyConfig": "project",
  "tasks.assign": "task",
  "tasks.unassign": "task",
  "specs.push": "project",
  "specs.importTasks": "project",
  "specs.runStep": "project",
  "runs.preparePlan": "project",
  "runs.dispatch": "project",
  "runs.prompt": "project",
  "runs.dispatchMany": "project",
  "runs.fanout": "project",
  "runs.mapReduce": "project",
  "research.start": "project",
  "chat.send": "project",
  "chat.setDefaults": "project",
  "chat.setCommands": "project",
  "chat.setAutonomy": "project",
  "chat.rename": "thread",
  "chat.configure": "thread",
  "sdlc.setProject": "project",
  "tools.setProject": "project",
  "agentPolicy.set": "project",
  "modelRouter.set": "project",
  "modelLearning.set": "project",
};

/** The event a successful call is worth telling people about, if any. */
function eventOf(method: Method, input: unknown, output: unknown, actor: Actor): HiveEvent | null {
  switch (method) {
    case "agentPolicy.set": {
      // The input says what changed; the output (filtered for the caller) only who saved it last, which is the caller.
      const i = input as { project: string | null; policy: Partial<AgentPolicy> | null };
      return { type: "agentPolicy.changed", project: i.project, by: (output as AgentPolicyView).updatedBy ?? "?", policy: i.policy };
    }
    case "agents.stop": {
      const stop = output as AgentsStop;
      return { type: "agents.stopped", project: stop.project, by: actor.name, stop };
    }
    case "agents.resume":
      return { type: "agents.resumed", project: (input as { project: string | null }).project, by: actor.name };
    case "tools.save":
      return { type: "tool.changed", project: null, by: actor.name, tool: (output as ToolView).id, removed: false };
    case "tools.remove":
      return (output as { removed: boolean }).removed ? { type: "tool.changed", project: null, by: actor.name, tool: (input as { id: string }).id, removed: true } : null;
    case "tools.setProject": {
      const i = input as { id: string; project: string };
      return { type: "tool.changed", project: i.project, by: actor.name, tool: i.id, removed: false };
    }
    case "proposals.create": {
      const proposal = output as Proposal;
      return { type: "proposal.created", project: parseDocKey(proposal.docKey).project, proposal };
    }
    case "memory.write": {
      const memory = output as Memory;
      return memory.status === "pending" ? { type: "memory.pending", project: memory.project, memory } : null;
    }
    case "admin.commandCreate":
      return { type: "command.requested", project: null, command: output as MachineCommand };
    case "machines.commandResult": {
      const command = output as MachineCommand;
      // Webhooks tell about installs; a sync request ends on every machine of the project, its page shows how.
      return command.kind === "install" && ["done", "failed", "rejected"].includes(command.status) ? { type: "command.finished", project: null, command } : null;
    }
    case "runs.report": {
      const run = output as RunNotice;
      return { type: run.kind === "failed" ? "run.failed" : run.kind === "ci_limit" ? "run.ciLimit" : "mr.created", project: run.project, run };
    }
    case "projects.archive":
      return { type: "project.archived", project: (input as { project: string }).project, by: actor.name, archived: true };
    case "projects.restore":
      return { type: "project.archived", project: (input as { project: string }).project, by: actor.name, archived: false };
    case "projects.delete": {
      const deleted = output as ProjectDeleted;
      return { type: "project.deleted", project: deleted.project, by: actor.name, deleted };
    }
    default:
      return null;
  }
}

type Row = Record<string, unknown>;
const str = (v: unknown) => v as string;
const strOrNull = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => Number(v);
/** Keeps a local path's last part only: a machine's home and folders are not for every reader of a project. */
const hidePaths = (text: string) => text.replace(/(?<![\w:/.~])(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/·]+[\\/])+([^\s\\/·]*)/g, "…/$1");
const sourceOf = (v: unknown): WriteSource | null => (v ? parseSource(JSON.parse(str(v))) : null);
const sourceJson = (s: WriteSource | null | undefined) => (s ? JSON.stringify(s) : null);
/**
 * Whom a machine's Board runs count for (roadmap 27b): the account of its token, else the token's name, which a hub
 * puts after the last "@" of the actor's name.
 */
const requesterOf = (actor: Actor) => actor.onBehalf ?? actor.name.slice(actor.name.lastIndexOf("@") + 1);

const toGate = (r: Row): SdlcGateRecord => ({
  id: num(r.id),
  project: str(r.project),
  taskId: str(r.task_id),
  gate: str(r.gate) as SdlcGate,
  mode: str(r.mode) as GateMode,
  status: str(r.status) as GateStatus,
  decidedBy: strOrNull(r.decided_by),
  note: strOrNull(r.note),
  createdAt: str(r.created_at),
  decidedAt: strOrNull(r.decided_at),
  ...(r.first_attempt == null ? {} : { firstAttempt: num(r.first_attempt) === 1 }),
});
/** "spec: ai, merge: auto": the gates left to agents; "—" when every one waits for a person. */
const gateSummary = (gates: Partial<GateModes>) =>
  SDLC_GATES.filter((g) => gates[g] && gates[g] !== "human").map((g) => `${g}: ${gates[g]}`).join(", ") || "—";

const toSummary = (r: Row): DocSummary => ({
  key: str(r.key),
  scope: str(r.scope) as DocSummary["scope"],
  project: strOrNull(r.project),
  title: str(r.title),
  version: num(r.version),
  includeInAgents: num(r.include_in_agents) === 1,
  paths: JSON.parse(str(r.paths ?? "[]")) as string[],
  parent: strOrNull(r.parent),
  folder: num(r.folder ?? 0) === 1,
  mirror: r.mirror ? (JSON.parse(str(r.mirror)) as DocMirror) : null,
  removedAt: strOrNull(r.removed_at),
  removedBy: strOrNull(r.removed_by),
  removedNote: strOrNull(r.removed_note),
  updatedBy: str(r.updated_by),
  updatedAt: str(r.updated_at),
});
const ASSET_FIELDS = "id, doc_key, name, type, size, uploaded_by, created_at";
const toAsset = (r: Row): DocAsset => ({
  id: num(r.id),
  docKey: str(r.doc_key),
  name: str(r.name),
  type: str(r.type),
  size: num(r.size),
  uploadedBy: str(r.uploaded_by),
  createdAt: str(r.created_at),
});
/** The tables whose rows point at bytes in the file store: both are read before a blob is dropped or backed up. */
const BLOB_TABLES = ["doc_assets", "artifacts"] as const;
/** Everything but the bytes: a list of artifacts never reads a blob. */
const ARTIFACT_FIELDS = "id, project, task_id, run_id, machine_id, name, type, size, sha256, profile_id, uploaded_by, source, created_at";
const toArtifact = (r: Row): Artifact => ({
  id: num(r.id),
  project: str(r.project),
  taskId: str(r.task_id),
  runId: str(r.run_id),
  machineId: str(r.machine_id),
  name: str(r.name),
  type: str(r.type),
  size: num(r.size),
  sha256: str(r.sha256),
  profileId: strOrNull(r.profile_id),
  uploadedBy: str(r.uploaded_by),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});
const toDoc = (r: Row): Doc => ({ ...toSummary(r), content: str(r.content) });
const toAssist = (r: Row): DocAssist => ({
  id: num(r.id),
  docKey: str(r.doc_key),
  project: strOrNull(r.project),
  kind: str(r.kind) as DocAssist["kind"],
  prompt: str(r.prompt),
  sources: JSON.parse(str(r.sources)) as string[],
  status: str(r.status) as DocAssist["status"],
  machine: strOrNull(r.machine),
  profile: strOrNull(r.profile),
  reply: str(r.reply),
  markdown: strOrNull(r.markdown),
  base: str(r.base),
  error: r.error == null ? null : (JSON.parse(str(r.error)) as DocAssist["error"]),
  costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
  outcome: strOrNull(r.outcome) as DocAssist["outcome"],
  requestedBy: str(r.requested_by),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
});
/** How long an ask waits for a machine, or a machine may go silent, before it is given up. */
const ASSIST_WAIT_MINUTES = 15;
/** Of the sources' text, at most this much goes to the assistant (per page, and in all). */
const ASSIST_DOC_CHARS = 20_000;
const ASSIST_CONTEXT_CHARS = 120_000;
const toVersion = (r: Row): DocVersion => ({
  key: str(r.key),
  version: num(r.version),
  content: str(r.content),
  author: str(r.author),
  note: str(r.note),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});
const toProposal = (r: Row): Proposal => ({
  id: num(r.id),
  docKey: str(r.doc_key),
  baseVersion: num(r.base_version),
  content: str(r.content),
  reason: str(r.reason),
  author: str(r.author),
  status: str(r.status) as Proposal["status"],
  reviewer: strOrNull(r.reviewer),
  reviewNote: strOrNull(r.review_note),
  decidedAt: strOrNull(r.decided_at),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});
/** Shared (team-wide) memory is stored with an empty project: no project key can be empty. */
const SHARED = "";
/** staleBefore: entries neither used nor written since then are stale; null turns staleness off. */
const toMemory = (r: Row, staleBefore: string | null): Memory => ({
  id: num(r.id),
  project: str(r.project) === SHARED ? null : str(r.project),
  kind: str(r.kind) as Memory["kind"],
  content: str(r.content),
  author: str(r.author),
  taskId: strOrNull(r.task_id),
  status: str(r.status) as Memory["status"],
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
  lastUsedAt: strOrNull(r.last_used_at),
  useCount: num(r.use_count ?? 0),
  stale: staleBefore !== null && (strOrNull(r.last_used_at) ?? str(r.created_at)) < staleBefore,
  files: JSON.parse(str(r.files ?? "[]")) as MemoryFile[],
  review: r.review ? (JSON.parse(str(r.review)) as MemoryReview) : null,
  supersedes: r.supersedes == null ? null : num(r.supersedes),
  supersededBy: r.superseded_by == null ? null : num(r.superseded_by),
  conflictsWith: JSON.parse(str(r.conflicts ?? "[]")) as number[],
});
const toTask = (
  r: Row,
  deps: Pick<Task, "dependsOn" | "waitingOn" | "depProjects"> = { dependsOn: [], waitingOn: [] },
  /** Machine names by hub id: the row keeps only the id, and a reader wants the name it knows the machine by. */
  machines: Map<string, string> = new Map(),
): Task => ({
  id: str(r.id),
  project: str(r.project),
  title: str(r.title),
  priority: num(r.priority ?? 50),
  kind: strOrNull(r.kind) as Task["kind"],
  size: strOrNull(r.size) as Task["size"],
  risk: strOrNull(r.risk) as Task["risk"],
  classifiedBy: strOrNull(r.classified_by),
  classifiedAt: strOrNull(r.classified_at),
  status: str(r.status) as Task["status"],
  owner: strOrNull(r.owner),
  leaseUntil: strOrNull(r.lease_until),
  note: strOrNull(r.note),
  updatedAt: str(r.updated_at),
  ...deps,
  agent: toTaskAgent(r, machines),
});

/** The assignment a task row carries (roadmap 50); null when agent_machine is empty, which is every task before 50. */
function toTaskAgent(r: Row, machines: Map<string, string>): TaskAgent | null {
  const machineId = strOrNull(r.agent_machine);
  if (machineId === null) return null;
  return {
    machineId,
    // A machine the hub has forgotten (removed, never seen) still shows the id, so the assignment is not a blank.
    machine: machines.get(machineId) ?? machineId,
    profileId: strOrNull(r.agent_profile),
    order: r.agent_order == null ? 0 : num(r.agent_order),
    by: strOrNull(r.agent_by) ?? "",
    at: strOrNull(r.agent_at) ?? "",
    hold: r.agent_hold ? (JSON.parse(str(r.agent_hold)) as RunRequestError) : null,
  };
}

const toTaskNote = (r: Row): TaskNote => ({
  taskId: str(r.task_id),
  version: num(r.version),
  note: str(r.note),
  status: str(r.status) as TaskStatus,
  author: str(r.author),
  onBehalf: strOrNull(r.on_behalf),
  source: sourceOf(r.source),
  createdAt: str(r.created_at),
});

/** What a task waits for, in words: `api/API-1, WEB-0, +1` (another service's with its project, hidden ones counted). */
const waitingLabelsFor = (t: Task): string =>
  [...t.waitingOn.map((d) => (t.depProjects?.[d] ? `${t.depProjects[d]}/${d}` : d)), ...(t.waitingHidden ? [`+${t.waitingHidden}`] : [])].join(", ");

/** A task as a reader sees it: what it waits for in a project they cannot see is a count, not ids (roadmap 19d). */
function hideDeps(t: Task, visible: (project: string) => boolean): Task {
  const hidden = Object.entries(t.depProjects ?? {}).filter(([, p]) => !visible(p)).map(([id]) => id);
  if (!hidden.length) return t;
  const keep = (id: string) => !hidden.includes(id);
  const depProjects = Object.fromEntries(Object.entries(t.depProjects!).filter(([id]) => keep(id)));
  return {
    ...t,
    dependsOn: t.dependsOn.filter(keep),
    waitingOn: t.waitingOn.filter(keep),
    ...(Object.keys(depProjects).length ? { depProjects } : { depProjects: undefined }),
    waitingHidden: t.waitingOn.length - t.waitingOn.filter(keep).length,
  };
}

const toCooldown = (r: Row): QuotaCooldown => ({
  account: str(r.account),
  until: str(r.until),
  reason: str(r.reason),
  reportedBy: str(r.reported_by),
  updatedAt: str(r.updated_at),
});
const toProfileChange = (r: Row): ProfileChange => ({
  machineId: str(r.machine_id),
  profileId: str(r.profile_id),
  enabled: r.enabled == null ? null : num(r.enabled) === 1,
  priority: r.priority == null ? null : num(r.priority),
  stopAtSession: r.stop_at_session == null ? null : num(r.stop_at_session),
  stopAtWeek: r.stop_at_week == null ? null : num(r.stop_at_week),
  requestedBy: str(r.requested_by),
  requestedAt: str(r.requested_at),
});

const toCommand = (r: Row): MachineCommand => ({
  id: num(r.id),
  machineId: str(r.machine_id),
  kind: (strOrNull(r.kind) ?? "install") as CommandKind,
  itemId: str(r.item_id),
  project: strOrNull(r.project),
  label: str(r.label),
  status: str(r.status) as CommandStatus,
  requestedBy: str(r.requested_by),
  requestedAt: str(r.requested_at),
  updatedAt: str(r.updated_at),
  output: strOrNull(r.output),
});
const toSystem = (r: Row): HiveSystem => ({
  name: str(r.name),
  projects: JSON.parse(str(r.projects)) as string[],
  updatedAt: str(r.updated_at),
  updatedBy: str(r.updated_by),
});

/** A project list filter as bound to `json_each`: null when there is none. */
const listParam = (projects: string[] | undefined) => (projects ? JSON.stringify(projects) : null);

const toRunRequest = (r: Row): RunRequest => ({
  timeoutMinutes: r.timeout_minutes == null ? null : num(r.timeout_minutes),
  redispatch: r.redispatch == null ? null : JSON.parse(str(r.redispatch)),
  plan: r.plan == null ? null : JSON.parse(str(r.plan)) as RunPlan,
  id: num(r.id),
  machineId: str(r.machine_id),
  machine: str(r.machine),
  project: str(r.project),
  taskId: str(r.task_id),
  taskTitle: str(r.task_title),
  role: str(r.role) as AgentRole,
  profileId: strOrNull(r.profile_id),
  preferKind: strOrNull(r.prefer_kind) as PreferKind | null,
  reviewAfter: num(r.review_after) === 1,
  candidates: num(r.candidates),
  instructions: str(r.instructions),
  status: str(r.status) as RunRequestStatus,
  runId: strOrNull(r.run_id),
  error: r.error == null ? null : (JSON.parse(str(r.error)) as RunRequestError),
  requestedBy: str(r.requested_by),
  requestedAt: str(r.requested_at),
  updatedAt: str(r.updated_at),
  selection: r.selection == null ? null : (JSON.parse(str(r.selection)) as ModelSelection),
});
const toChatThread = (r: Row): ChatThread => ({
  id: num(r.id),
  project: str(r.project),
  title: str(r.title),
  machineId: str(r.machine_id),
  machine: str(r.machine),
  profileId: strOrNull(r.profile_id),
  model: strOrNull(r.model),
  effort: strOrNull(r.effort) as ChatEffort | null,
  createdBy: str(r.created_by),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  busy: num(r.busy ?? 0) === 1,
});
const toChatMessage = (r: Row): ChatMessage => ({
  id: num(r.id),
  threadId: num(r.thread_id),
  role: str(r.role) as ChatMessage["role"],
  author: str(r.author),
  text: str(r.text),
  status: strOrNull(r.status) as ChatReplyStatus | null,
  activity: strOrNull(r.activity),
  steps: str(r.steps),
  error: r.error == null ? null : (JSON.parse(str(r.error)) as RunRequestError),
  costUsd: r.cost_usd == null ? null : num(r.cost_usd),
  tokens: r.tokens == null ? null : JSON.parse(str(r.tokens)),
  switchedFrom: strOrNull(r.switched_from),
  createdAt: str(r.created_at),
  updatedAt: str(r.updated_at),
  finishedAt: strOrNull(r.finished_at),
  actions: [],
  files: [],
});
const toChatFile = (r: Row): ChatFile => ({ id: num(r.id), name: str(r.name), type: str(r.type), size: num(r.size), createdAt: str(r.created_at) });
/** Everything about a file but its bytes. */
const FILE_FIELDS = "id, name, type, size, created_at, message_id";
const toChatAction = (r: Row): ChatAction => ({
  id: num(r.id),
  replyId: num(r.reply_id),
  threadId: num(r.thread_id),
  project: str(r.project),
  kind: str(r.kind) as ChatActionKind,
  input: JSON.parse(str(r.input)) as Record<string, unknown>,
  reason: str(r.reason),
  status: str(r.status) as ChatActionStatus,
  result: r.result == null ? null : (JSON.parse(str(r.result)) as ChatAction["result"]),
  error: r.error == null ? null : (JSON.parse(str(r.error)) as RunRequestError),
  decidedBy: strOrNull(r.decided_by),
  decidedAt: strOrNull(r.decided_at),
  createdAt: str(r.created_at),
  auto: num(r.auto ?? 0) === 1,
});
/** A thread row with whether a reply is waiting or being written. */
const THREAD_SELECT =
  "SELECT t.*, EXISTS(SELECT 1 FROM chat_messages m WHERE m.thread_id = t.id AND m.status IN ('pending', 'running')) AS busy FROM chat_threads t";
const toAudit = (r: Row): AuditEntry => ({
  id: num(r.id),
  at: str(r.at),
  actor: str(r.actor),
  action: str(r.action),
  target: str(r.target),
  detail: str(r.detail),
  ...(r.detail_key ? { detailKey: str(r.detail_key), detailVars: r.detail_vars ? (JSON.parse(str(r.detail_vars)) as AuditEntry["detailVars"]) : undefined } : {}),
  agent: strOrNull(r.agent),
  onBehalf: strOrNull(r.on_behalf),
  run: strOrNull(r.run),
  source: sourceOf(r.source),
});

/** FTS5 query from free text: every word becomes a quoted prefix term, OR-ed together. */
function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(" OR ");
}

export interface SqliteHiveOptions {
  /**
   * Tests only: stop the schema at this many migrations, to replay an upgrade from the schema a hub had before one.
   * Several items land in one batch, so "the last migration" is not a stable place to roll back to.
   */
  migrateTo?: number;
  /** When true, memory written by non-admins stays `pending` (hidden from search) until an admin approves it. */
  memoryRequiresApproval?: boolean;
  /** Memory no agent searched up (nor anyone wrote or kept) for this many days is stale. 0: never. Default 90. */
  memoryStaleDays?: number;
  /** A run's log and patch go this many days after its last update; the rest of the record stays. 0: keep them. Default 30. */
  runLogDays?: number;
  /** A done task's run artifacts go this many days after they were sent (pruneArtifacts). 0: keep them. Default 30. */
  artifactDays?: number;
  /** Called after a change people may want to hear about (the hub sends webhooks); errors are ignored. */
  onEvent?: (event: HiveEvent) => void;
  /** Embeddings for memory search (the hub: Ollama or an API). Without one, search matches words only. */
  embedder?: Embedder | null;
  /** Entries less similar than this to the query (cosine) do not count as found by meaning. */
  embedMinScore?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
  /**
   * The database of one machine (the desktop app without a hub): its own runner writes the writing assistant's asks.
   * On a hub only a machine that takes runs does.
   */
  local?: boolean;
  /** Where doc files keep their bytes (roadmap 23c: SeaweedFS on a hub). Without one: in the database. */
  blobs?: BlobStore | null;
  /**
   * A snapshot of the whole hub, as the Hub page's "Backup ngay" makes one (roadmap 47): projects.delete takes one
   * before it deletes anything, and gives up when it cannot. Without this, deleting a project is refused — a deletion
   * nobody can undo is not worth taking on trust.
   */
  backup?: (() => Promise<{ file: string }>) | null;
  /** HIVE_GATE_JOBS=1 (spec 69h1 §9). Off: no gate job is created, approved or taken; reading and stopping still work. */
  gateJobs?: boolean;
}

/** How a hub keeps doc files, for its Hub page. */
export interface DocFilesInfo {
  store: string | null;
  where: string | null;
  count: number;
  bytes: number;
  /** Files whose bytes are still in the database: moved to the store when there is one. */
  inDb: number;
  lastError: string | null;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

type Handlers = { [M in Method]: (input: ParsedInput<M>, actor: Actor) => MethodOutput[M] | Promise<MethodOutput[M]> };

/** Agent credentials must never inherit machine reporting or human decisions, including future RPCs. */
const AGENT_METHODS = new Set<Method>([
  "agentPolicy.get", "agents.paused", "artifacts.get", "artifacts.list", "budgets.list", "costs.summary",
  "docs.assetGet", "docs.assets", "docs.get", "docs.list", "gate.get", "gate.list", "machines.list", "machines.setupMissing",
  "memory.search", "memory.write", "policy.get", "projects.list", "proposals.create", "runs.get",
  "runs.ciPolicy", "runs.list", "runs.requests", "skills.list", "systems.list", "tasks.claim", "tasks.list",
  "tasks.next", "tasks.notes", "tasks.update", "tools.list", "tools.status",
]);

// Interactive MCP credentials may manage the owner's board. A run credential remains limited to its own task.
const CLI_LEADER_METHODS = new Set<Method>([
  "tasks.create", "tasks.setDeps", "tasks.assign", "runs.dispatch", "plans.create",
]);

// Legacy names can be forged before their first migrated heartbeat; they must not authorize machine reports or work.
const MACHINE_METHODS = new Set<Method>([
  "machines.heartbeat", "machines.commandResult", "runs.push", "runs.report", "runs.requestResult", "runs.preparePlan", "runs.mergeResult",
  "artifacts.put", "specs.push", "docs.assistTake", "docs.assistProgress", "docs.assistFinish",
  "memory.cleanupTake", "memory.cleanupRead", "memory.cleanupProgress", "memory.cleanupFinish",
  "chat.poll", "chat.progress", "chat.finish", "research.finish", "mergeQueue.take", "mergeQueue.progress", "mergeQueue.finish",
  "autoRelease.take", "autoRelease.progress", "autoRelease.result", "autoRelease.rollout",
]);

export class SqliteHive implements HiveBackend {
  readonly db: DatabaseSync;
  readonly #opts: Required<SqliteHiveOptions>;
  readonly #handlers: Handlers;
  readonly #machineIdentityReady: boolean;
  /** The desktop app's own machine in local mode (roadmap 48): it never heartbeats, so it is no row of `machines`. */
  #chatMachine: (() => Machine | null) | null = null;

  constructor(dbOrPath: DatabaseSync | string, opts: SqliteHiveOptions = {}) {
    if (typeof dbOrPath === "string" && dbOrPath !== ":memory:") {
      mkdirSync(path.dirname(dbOrPath), { recursive: true });
    }
    this.db = typeof dbOrPath === "string" ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.#opts = {
      memoryRequiresApproval: false,
      memoryStaleDays: 90,
      runLogDays: RUN_LOG_DAYS,
      artifactDays: ARTIFACT_DAYS,
      now: () => new Date(),
      onEvent: () => undefined,
      embedder: null,
      embedMinScore: 0.5,
      local: false,
      blobs: null,
      backup: null,
      gateJobs: false,
      migrateTo: Number.POSITIVE_INFINITY,
      ...opts,
    };
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    // Case folding SQLite's LIKE leaves out beyond ASCII (Đ and đ): searches compare hive_fold of both sides.
    this.db.function("hive_fold", { deterministic: true }, (v) => (typeof v === "string" ? v.normalize("NFC").toLocaleLowerCase("vi") : v));
    this.db.function("hive_waiting_reason", { deterministic: true }, (status, summary, error, pipeline) => waitingReason({
      status: str(status), summary: strOrNull(summary), error: strOrNull(error), mr: { pipeline: strOrNull(pipeline) },
    }));
    this.#migrate();
    if (this.#opts.migrateTo >= MIGRATIONS.length) {
      // A stopped process cannot tell whether an in-flight operation took effect; never retry it automatically.
      this.db.prepare("UPDATE proposals SET status = 'conflict', review_note = ? WHERE status = 'executing'")
        .run("Execution was interrupted; check the operation's effect before creating a new proposal.");
    }
    this.#machineIdentityReady = (this.db.prepare("PRAGMA table_info(machines)").all() as Row[]).some((r) => r.name === "token_id");
    this.#handlers = this.#buildHandlers();
  }

  async call<M extends Method>(method: M, input: MethodInput<M>, caller: Actor): Promise<MethodOutput[M]> {
    if (caller.runCredential || caller.mcpCredential) {
      if (!AGENT_METHODS.has(method) && !(caller.mcpCredential && !caller.runCredential && !caller.chatReply && CLI_LEADER_METHODS.has(method)))
        throw new HiveError("forbidden", "An agent credential cannot call this method.");
      if (caller.runCredential && (method === "tasks.claim" || method === "tasks.update") && (input as { id?: string }).id !== caller.runCredential.task)
        throw new HiveError("forbidden", "A run credential can work only on its task.");
    }
    authorize(method, caller);
    const machine = this.#machineIdentityReady ? this.db.prepare("SELECT token_id FROM machines WHERE id = ?").get(caller.name) as Row | undefined : undefined;
    if (machine?.token_id != null && !caller.runCredential && !caller.mcpCredential && !this.isMachineActor(caller.name, caller))
      throw new HiveError("forbidden", "This token is not paired with the machine.", { key: "errors.machineIdentityForbidden" });
    // A legacy machine gets its identity only at heartbeat, before it can take work or report results. Callers that are no
    // machine row (the desktop app's own `desktop@<token>` calls) keep working: no machine's records are reachable by name.
    if (machine && machine.token_id == null && MACHINE_METHODS.has(method) && method !== "machines.heartbeat" && caller.tokenId)
      throw new HiveError("forbidden", "Heartbeat with the paired machine token first.", { key: "errors.machineIdentityForbidden" });
    const actor = this.#withSystems(caller);
    const parsed = parseInput(method, input);
    const handler = this.#handlers[method] as (i: ParsedInput<M>, a: Actor) => MethodOutput[M] | Promise<MethodOutput[M]>;
    this.#check(method, parsed as ParsedInput<Method>, actor);
    this.#assertProjectOpen(method, parsed as ParsedInput<Method>);
    const output = this.#hideArchived(method, parsed as ParsedInput<Method>, this.#filter(method, await handler(parsed, actor), actor));
    this.#report(method, parsed, output, actor);
    return output;
  }

  /** The owner pinned with the machine's token, or null while no token is pinned (spec 69: a heartbeat never changes it). */
  machinePinnedOwner(machineId: string): string | null {
    if (!this.#machineIdentityReady) return null;
    const row = this.db.prepare("SELECT owner FROM machines WHERE id = ? AND token_id IS NOT NULL").get(machineId) as Row | undefined;
    return row ? strOrNull(row.owner) : null;
  }

  /** Use this for machine reporting (including terminal); scoped agent credentials are never machine credentials. */
  isMachineActor(machineId: string, actor: Actor): boolean {
    if (!this.#machineIdentityReady) return false;
    if (actor.name !== machineId || actor.role === "viewer" || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined) return false;
    const row = this.db.prepare("SELECT token_id, owner FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    if (!row) return false;
    if (row.token_id == null) return this.#opts.local && !actor.tokenId;
    return !!actor.tokenId && actor.tokenId === row.token_id && (actor.account ?? null) === strOrNull(row.owner);
  }

  /**
   * The desktop's password sign-in replaces its token with a new one of the same name and account: that is the owner
   * re-pairing in person, so the machines of the old token follow the new one instead of being locked out.
   */
  rebindMachineToken(fromTokenId: string, toTokenId: string, actor: Actor): number {
    if (!this.#machineIdentityReady) return 0;
    return this.#tx(() => {
      // Run credentials of the old token die with it: verify joins them to their parent hub_tokens row.
      const rows = this.db.prepare("SELECT id FROM machines WHERE token_id = ?").all(fromTokenId) as Row[];
      for (const row of rows) {
        this.db.prepare("UPDATE machines SET token_id = ? WHERE id = ?").run(toTokenId, str(row.id));
        this.audit(actor, "machines.repair", str(row.id), `${fromTokenId} → ${toTokenId} · sign-in`, { key: "audit.machineRepaired" });
      }
      return rows.length;
    });
  }

  #bindMachine(actor: Actor, machine: string): void {
    const row = this.db.prepare("SELECT token_id, owner FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    if (actor.tokenId) {
      const token = this.db.prepare("SELECT name FROM hub_tokens WHERE id = ?").get(actor.tokenId) as Row | undefined;
      if (!token || actor.name !== `runner.${machine}@${str(token.name)}`)
        throw new HiveError("forbidden", "This token is not paired with the machine.", { key: "errors.machineIdentityForbidden" });
    }
    if (row?.token_id != null) {
      if (!this.isMachineActor(actor.name, actor)) throw new HiveError("forbidden", "This token is not paired with the machine.", { key: "errors.machineIdentityForbidden" });
      return;
    }
    // Direct/local backends have no hub credential; the HTTP hub requires one before entering this handler.
    if (!actor.tokenId) return;
    const token = this.db.prepare("SELECT name, owner_id, role FROM hub_tokens WHERE id = ?").get(actor.tokenId) as Row | undefined;
    if (!token || token.role === "viewer" || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined ||
        actor.name !== `runner.${machine}@${str(token.name)}` || (row && strOrNull(row.owner) !== (actor.account ?? null)))
      throw new HiveError("forbidden", "This token is not paired with the machine.", { key: "errors.machineIdentityForbidden" });
    if (row) {
      // Old rows carry no token id: a namesake owned by somebody else is never a migration candidate.
      const candidates = this.db.prepare("SELECT id FROM hub_tokens WHERE name = ? AND owner_id IS ? AND role != 'viewer'").all(str(token.name), strOrNull(token.owner_id)) as Row[];
      if (candidates.length !== 1) throw new HiveError("forbidden", "Machine identity is ambiguous; its owner or admin must re-pair it.", { key: "errors.machineIdentityAmbiguous" });
      this.db.prepare("UPDATE machines SET token_id = ? WHERE id = ?").run(actor.tokenId, actor.name);
      this.audit(actor, "machines.bind", actor.name, "legacy heartbeat", { key: "audit.machineBound" });
    }
  }

  /** The audit line and event of a write, as `call` makes them: also for writes a chat plan makes inside one transaction. */
  #report<M extends Method>(method: M, parsed: ParsedInput<M>, output: MethodOutput[M], actor: Actor): void {
    const audited = AUDITED[method] ?? (isAgentActor(actor) ? AGENT_AUDITED[method] : undefined);
    if (audited) {
      const { target, detail, text } = audited(parsed, output);
      this.audit(actor, method, target, detail, text);
    }
    const event = eventOf(method, parsed, output, actor);
    if (event) {
      try {
        this.#opts.onEvent(actor.agent === "automation" ? { ...event, automation: true } : event);
      } catch {
        // a listener must never fail the call
      }
    }
  }

  // ── per-project access (access.ts) ─────────────────────────────────────────

  /** An account's grants with the ones it gets on each system from its services (roadmap 19c). */
  #withSystems(actor: Actor): Actor {
    if (!actor.access) return actor;
    const access = withSystemGrants(actor.access, this.#systemList());
    return access === actor.access ? actor : { ...actor, access };
  }

  /** Each project with the systems it is a service of and the machines that have its repo (ChatRequest.projects). */
  #projectsForHubChat(): Array<{ project: string; systems: string[]; machines: string[] }> {
    const systems = this.#systemList();
    const machines = (this.db.prepare("SELECT machine, projects FROM machines").all() as Row[]).map((r) => ({
      machine: str(r.machine),
      projects: JSON.parse(str(r.projects)) as string[],
    }));
    return this.#projectNames().map((project) => ({
      project,
      systems: systems.filter((s) => s.projects.includes(project)).map((s) => s.name),
      machines: machines.filter((m) => m.projects.includes(project)).map((m) => m.machine),
    }));
  }

  #systemList(): Array<{ name: string; projects: string[] }> {
    return (this.db.prepare("SELECT name, projects FROM systems").all() as Row[]).map((r) => ({ name: str(r.name), projects: JSON.parse(str(r.projects)) as string[] }));
  }

  /** Owners (sys:<name>) of the systems any of these projects is in: their docs and memory go to those projects' agents. */
  #systemOwnersOf(projects: ReadonlyArray<string | null | undefined>): string[] {
    const wanted = new Set(projects.filter((p): p is string => !!p));
    if (!wanted.size) return [];
    return this.#systemList()
      .filter((s) => s.projects.some((p) => wanted.has(p)))
      .map((s) => systemOwner(s.name));
  }

  /** A system's docs and memory need the system: a key or a name of one that is gone answers like a missing project. */
  #assertSystem(owner: string | null): void {
    const name = systemOf(owner);
    if (name !== null && !this.#system(name)) throw new HiveError("not_found", `No system ${name}.`, { key: "errors.systemNotFound", vars: { system: name } });
  }

  /** Owner project of a doc key: null for org/* (shared). */
  static #docOwner(key: string): string | null {
    return parseDocKey(key).project;
  }

  /**
   * Refuses a call on something the actor may not touch. Invisible projects answer not_found, so an
   * account cannot learn what exists in projects it was not given; visible but too low a level is forbidden.
   */
  #need(actor: Actor, owner: string | null, permission: Permission, what: string): void {
    if (may(actor, owner, permission)) return;
    if (!sees(actor, owner)) throw new HiveError("not_found", `${what} not found.`, { key: "errors.notFound" });
    const where = owner === null ? "the shared (team-wide) data" : `project ${owner}`;
    throw new HiveError("forbidden", `${what}: needs "${permission}" on ${where}.`, {
      key: owner === null ? `errors.needShared.${permission}` : `errors.need.${permission}`,
      vars: { project: owner ?? "" },
    });
  }

  /**
   * The hub-wide chat (roadmap 37) reaches every project and every machine, so nothing short of a hub admin may see or
   * touch it: no grant can add up to it, as with stopping every agent of the hub. A project manager is not one.
   */
  #needHubAdmin(actor: Actor, what: string): void {
    if (this.#isHubAdmin(actor)) return;
    throw new HiveError("forbidden", `${what}: only a hub admin.`, { key: "errors.hubAdminOnly" });
  }

  /** Whether the actor may see the hub-wide chat at all; lists use it to leave its threads out for everyone else. */
  #isHubAdmin(actor: Actor): boolean {
    return actor.role === "admin" && !actor.access;
  }

  /** The thread a reply belongs to, or a chat action: HUB_SCOPE for the hub-wide one. */
  #threadProjectOfReply(replyId: number): string | null {
    const row = this.db.prepare("SELECT t.project FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ?").get(replyId) as Row | undefined;
    return row ? str(row.project) : null;
  }

  /** A doc agents read takes contextEdit to change, any other docEdit (roadmap 25): as it is, or as the save makes it. */
  #docPermission(key: string, after?: { paths?: string[]; includeInAgents?: boolean }): Permission {
    return isContextDoc(key, this.#getDoc(key)) || isContextDoc(key, after) ? "contextEdit" : "docEdit";
  }

  #check(method: Method, input: ParsedInput<Method>, actor: Actor): void {
    const i = input as Record<string, any>;
    const owner = SqliteHive.#docOwner;
    switch (method) {
      case "evidence.tasks":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "evidence.record":
      case "evidence.context":
      case "evidence.list": {
        this.#need(actor, i.project, method === "evidence.record" ? "qaVerify" : "view", `Project ${i.project}`);
        const task = this.db.prepare("SELECT project FROM tasks WHERE id = ?").get(i.taskId) as Row | undefined;
        if (!task || task.project !== i.project) throw new HiveError("not_found", "Task not found.", { key: "errors.notFound" });
        return;
      }
      case "mergeQueue.get":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "mergeQueue.configure":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "mergeQueue.take":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "docs.get":
      case "docs.history":
      case "docs.links":
      case "docs.assets":
      case "docs.assetGet":
        return this.#need(actor, owner(i.key), "view", `Doc ${i.key}`);
      // A run's files belong to its project, like the run (roadmap 41c): sending one is work on the task.
      case "artifacts.put":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "artifacts.list":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "artifacts.get":
      case "artifacts.remove": {
        const row = this.db.prepare("SELECT project FROM artifacts WHERE id = ?").get(i.id) as Row | undefined;
        // Removing is the project manager's: nothing else ever deletes an artifact.
        if (row) this.#need(actor, str(row.project), method === "artifacts.get" ? "view" : "projectSettings", `Artifact #${i.id}`);
        const artifact = this.db.prepare("SELECT project, task_id, machine_id, run_id FROM artifacts WHERE id = ?").get(i.id) as Row | undefined;
        const research = artifact ? this.#researchForArtifact(str(artifact.project), str(artifact.task_id), str(artifact.machine_id), str(artifact.run_id)) : undefined;
        if (research && !this.#researchVisible(research, actor)) throw new HiveError("not_found", "Artifact not found.");
        return;
      }
      case "docs.save":
        return this.#need(actor, owner(i.key), this.#docPermission(i.key, { paths: i.paths, includeInAgents: i.includeInAgents }), `Doc ${i.key}`);
      case "docs.move": {
        // The key it gets counts too: moving a page onto project/<p>/agents makes it a page agents read.
        const level = i.to && this.#docPermission(i.to) === "contextEdit" ? "contextEdit" : this.#docPermission(i.key);
        this.#need(actor, owner(i.key), level, `Doc ${i.key}`);
        // Giving the page another space puts it in someone else's hands: the new space has to be the actor's too.
        if (i.to && i.to !== i.key) this.#need(actor, owner(i.to), level, `Doc ${i.to}`);
        return;
      }
      case "docs.remove":
      case "docs.restore":
        return this.#need(actor, owner(i.key), this.#docPermission(i.key), `Doc ${i.key}`);
      case "docs.removed":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "projects.retire":
      case "projects.resume":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin lets a project key rest.", { key: "errors.hubAdminOnly" });
        return;
      // Those who propose attach files to it; removing someone else's file takes docEdit (see the handler).
      case "docs.assetPut":
      case "docs.assetRemove":
      case "docs.assist":
        return this.#need(actor, owner(i.key), "docPropose", `Doc ${i.key}`);
      case "docs.assists":
        return this.#need(actor, owner(i.key), "view", `Doc ${i.key}`);
      case "docs.context":
      case "docs.syncStatus":
      case "machines.setupMissing":
      case "tools.status":
      case "modelLearning.get":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      // Whoever may change what agents read may have the machines write it now.
      case "docs.syncRequest":
        return this.#need(actor, i.project, "contextEdit", `Project ${i.project}`);
      case "proposals.create":
        if ("action" in i) {
          if (!actor.mcpCredential || actor.runCredential || actor.chatReply !== undefined)
            throw new HiveError("forbidden", "Only an interactive MCP credential can propose an operation.");
          if (i.action.project === null && ["agents.stop", "agents.resume", "agentPolicy.set"].includes(i.action.method))
            this.#needHubAdmin(actor, "Hub operation proposal");
          return this.#need(actor, i.action.project, "docPropose", "CLI operation proposal");
        }
        return this.#need(actor, owner(i.docKey), "docPropose", `Doc ${i.docKey}`);
      case "proposals.approve":
      case "proposals.reject": {
        const row = this.db.prepare("SELECT doc_key, COALESCE(on_behalf, author) AS owner FROM proposals WHERE id = ?").get(i.id) as Row | undefined;
        // A change to what agents read is the context's to approve; any other a doc reviewer's.
        const research = row ? this.db.prepare("SELECT * FROM research_runs WHERE doc_key = ?").get(str(row.doc_key)) as Row | undefined : undefined;
        if (research && !this.#researchVisible(research, actor)) throw new HiveError("not_found", "Proposal not found.");
        const operation = row && isCliActionProposalKey(str(row.doc_key));
        if (operation && method === "proposals.approve" &&
          (!actor.humanSession || actor.role === "agent" || isAgentActor(actor) || actor.mcpCredential || actor.runCredential || actor.chatReply !== undefined))
          throw new HiveError("forbidden", "Only a human session can approve an operation.");
        if (row) this.#need(actor, owner(str(row.doc_key)), this.#docPermission(str(row.doc_key)) === "contextEdit" ? "contextEdit" : "docApprove", `Proposal #${i.id}`);
        // Rejecting your own proposal is only taking it back.
        if (row && method === "proposals.approve" && !operation) this.#notSelf(actor, [str(row.owner)], `Proposal #${i.id}`);
        return;
      }
      case "memory.cleanupSettings":
      case "memory.cleanupRuns":
      case "memory.cleanupProposals":
      case "memory.search":
      case "skills.list":
      case "runs.list":
      case "inbox.source":
      case "sdlc.dispatch":
      case "runs.requests":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "research.start": {
        this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
        this.#researchProjects(i as ResearchInput, actor);
        return this.#need(actor, i.scope === "system" ? systemOwner(i.system) : i.project, "docPropose", "Research draft");
      }
      case "research.get":
      case "research.finish": {
        const research = this.#research(i.id);
        for (const p of research.projects) this.#need(actor, p, "view", `Research #${i.id}`);
        if (method === "research.get" && research.input.scope === "hub") this.#needHubAdmin(actor, `Research #${i.id}`);
        // Machines may finish only their own accepted request; they need not be hub admins.
        if (method === "research.finish" && research.machineId !== actor.name) throw new HiveError("forbidden", "Research belongs to another machine.");
        return;
      }
      case "runs.dispatch":
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.dispatchMany":
      case "runs.roles":
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.fanout":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.mapReduce":
      case "runs.mapSplit":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.resumeGroup": {
        const row = this.db.prepare("SELECT project, kind FROM run_groups WHERE id = ?").get(i.id) as Row | undefined;
        if (!row) return;
        // A job in parts made its tasks; a chain of roles runs one that was there, as runs.roles needs.
        if (str(row.kind) !== "roles") this.#need(actor, str(row.project), "taskManage", `Run group #${i.id}`);
        return this.#need(actor, str(row.project), "runDispatch", `Run group #${i.id}`);
      }
      case "runs.pickWinner": {
        const row = this.db.prepare("SELECT project FROM run_groups WHERE id = ?").get(i.groupId) as Row | undefined;
        if (!row) return;
        this.#need(actor, str(row.project), "taskManage", `Run group #${i.groupId}`);
        return this.#need(actor, str(row.project), "runDispatch", `Run group #${i.groupId}`);
      }
      case "runs.groups":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "runs.cancelGroup": {
        const row = this.db.prepare("SELECT project FROM run_groups WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Run group #${i.id}`);
        return;
      }
      // It makes a task as well as the request.
      case "runs.prompt":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      // Whoever may queue and stop a project's runs may stop them all; the whole hub is its admin's alone.
      case "agents.stop":
      case "agents.resume":
        if (i.project !== null) return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin stops every agent of the hub.", { key: "errors.hubAdminOnly" });
        return;
      case "chat.send":
        if (i.project === HUB_SCOPE) return this.#needHubAdmin(actor, "The hub-wide chat");
        return this.#need(actor, i.project, "chatUse", `Project ${i.project}`);
      case "chat.threads":
        // Without a project the handler leaves the hub-wide threads out; asking for them outright says who may.
        if (i.project === HUB_SCOPE) return this.#needHubAdmin(actor, "The hub-wide chat");
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "chat.get": {
        const row = this.db.prepare("SELECT project FROM chat_threads WHERE id = ?").get(i.threadId) as Row | undefined;
        if (!row) return;
        if (str(row.project) === HUB_SCOPE) return this.#needHubAdmin(actor, `Chat #${i.threadId}`);
        this.#need(actor, str(row.project), "view", `Chat #${i.threadId}`);
        return;
      }
      case "chat.propose": {
        // The reply's own token only: the leader has at most what the sender and the machine both have.
        const project = actor.chatReply ? this.#threadProjectOfReply(actor.chatReply) : null;
        // The hub-wide leader is never a hub admin itself (its token is cut to the machine's): the reply's token is what
        // lets it propose, and #proposeChat checks the project each proposal names. Confirming is still a hub admin's.
        if (project === null || project === HUB_SCOPE) return;
        // Only proposing: someone with chatApprove decides, and the token is this one reply's (its sender could chat).
        this.#need(actor, project, "view", `Chat reply #${actor.chatReply}`);
        return;
      }
      case "chat.decideAll": {
        const project = this.#threadProjectOfReply(i.replyId);
        if (project === null) return;
        if (project === HUB_SCOPE) return this.#needHubAdmin(actor, `Chat reply #${i.replyId}`);
        this.#need(actor, project, "chatApprove", `Chat reply #${i.replyId}`);
        return;
      }
      case "chat.decide": {
        const row = this.db
          .prepare("SELECT a.project, t.project AS thread_project FROM chat_actions a JOIN chat_threads t ON t.id = a.thread_id WHERE a.id = ?")
          .get(i.actionId) as Row | undefined;
        if (!row) return;
        // The action's own project is what it is aimed at; whether a person may confirm it follows the thread it was
        // proposed in, so a manager of one project cannot confirm what the hub-wide leader asked for.
        if (str(row.thread_project) === HUB_SCOPE) return this.#needHubAdmin(actor, `Chat action #${i.actionId}`);
        this.#need(actor, str(row.project), "chatApprove", `Chat action #${i.actionId}`);
        return;
      }
      case "chat.defaults":
        if (i.project === HUB_SCOPE) return this.#needHubAdmin(actor, "The hub-wide chat");
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "chat.pending":
        if (i.project === HUB_SCOPE) return this.#needHubAdmin(actor, "The hub-wide chat");
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "chat.setDefaults":
      case "chat.setCommands":
      case "chat.setAutonomy":
        if (i.project === HUB_SCOPE) return this.#needHubAdmin(actor, "The hub-wide chat");
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      // The ceiling binds every project: a hub admin (no per-project grants) only.
      case "sdlc.setCeiling":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin sets how far gates may go.", { key: "errors.hubAdminOnly" });
        return;
      case "runs.preparePlan":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "runs.plans":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "runs.decidePlan": {
        const row = this.db.prepare("SELECT project FROM implementation_plans WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Plan #${i.id}`);
        return;
      }
      case "gate.templates":
      case "gate.list":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "gate.get": {
        const row = this.db.prepare("SELECT project FROM gate_jobs WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "view", `Gate job ${i.id}`);
        return;
      }
      // A person at the web, never a bearer of any role (spec 69h1 §5): no run, MCP, chat leader or machine asks for code
      // to be run outside a sandbox, nor says yes to it.
      case "gate.create":
      case "gate.approve":
      case "gate.reconcile":
      case "gate.cancel": {
        if (!isTerminalHuman(actor)) throw new HiveError("forbidden", "Only a person signed in on the web decides gate jobs.");
        const row = method === "gate.create" ? null : this.db.prepare("SELECT project, machine_id, requested_by FROM gate_jobs WHERE id = ?").get(i.id) as Row | null | undefined;
        if (method !== "gate.create" && !row) return;
        const project = row ? str(row.project) : i.project;
        if (method === "gate.cancel" && row) {
          // Stopping is open to whoever asked for it and to the machine's owner, as well as the project's manager.
          const owner = this.db.prepare("SELECT owner FROM machines WHERE id = ?").get(str(row.machine_id)) as Row | undefined;
          if (str(row.requested_by) === actor.account || (owner?.owner && str(owner.owner) === actor.account)) return this.#need(actor, project, "view", `Gate job ${i.id}`);
        }
        return this.#need(actor, project, "projectSettings", `Project ${project}`);
      }
      // The machine the job names; which one that is comes from its credential (actor.name), checked by the store.
      case "gate.take":
      case "gate.progress":
      case "gate.artifact":
      case "gate.result": {
        if (actor.humanSession) throw new HiveError("forbidden", "Gate jobs are taken by a machine.");
        if (method === "gate.take") return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
        const row = this.db.prepare("SELECT project FROM gate_jobs WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "taskWork", `Project ${str(row.project)}`);
        return;
      }
      case "autoRelease.list":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "autoRelease.decide":
      case "autoRelease.reconcile":
      case "autoRelease.resume":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "autoRelease.green":
      case "autoRelease.take":
      case "autoRelease.result":
      case "autoRelease.progress":
      case "autoRelease.rollout": {
        this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
        const machine = method === "autoRelease.result" ? new AutoReleaseStore(this.db, () => this.#now()).get(i.project, i.batchId)?.machine : this.#sdlcPolicy().projects[i.project]?.releaseMachine;
        if (!machine || actor.name !== machine) throw new HiveError("forbidden", "Only the configured Gate machine may report or take a release.");
        return;
      }
      case "sdlc.setProject":
        if (i.settings?.autoDispatch) this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "sdlc.gates":
      case "sdlc.flows":
      case "sdlc.flowTasks":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      // A flow makes its task and queues its runs.
      case "specs.runStep":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "sdlc.decide": {
        const row = this.db.prepare("SELECT project, gate FROM sdlc_gates WHERE id = ?").get(i.gateId) as Row | undefined;
        if (!row) return;
        // Passing the tasks gate imports the feature's tasks into the board.
        if (str(row.gate) === "tasks" && i.decision === "pass") this.#need(actor, str(row.project), "taskManage", `Gate #${i.gateId}`);
        // A task's review and its merge are a code reviewer's, as merging from the web is (18c).
        if (str(row.gate) === "review" || str(row.gate) === "merge") return this.#need(actor, str(row.project), "codeReview", `Gate #${i.gateId}`);
        if (str(row.gate) === "test") return this.#need(actor, str(row.project), "qaVerify", `Gate #${i.gateId}`);
        return this.#need(actor, str(row.project), "runDispatch", `Gate #${i.gateId}`);
      }
      case "sdlc.retry": {
        const row = this.db.prepare("SELECT project FROM sdlc_flows WHERE task_id = ?").get(i.taskId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Flow ${i.taskId}`);
        return;
      }
      // The tier table names the models of every project's runs, like the hub's agent policy.
      case "modelRouter.set":
        if (i.project === null) {
          if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin sets the model tiers.", { key: "errors.hubAdminOnly" });
          return;
        }
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      // Its cells are the project's part of the router: the same right as setting them by hand.
      case "modelLearning.set":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "runs.setTimeoutSettings":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin sets run timeouts.", { key: "errors.hubAdminOnly" });
        return;
      case "agentPolicy.set":
        // The default binds every project, so only someone over all of them: a hub admin (no per-project grants).
        if (i.project === null) {
          if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin sets the hub's agent policy.", { key: "errors.hubAdminOnly" });
          return;
        }
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "tools.list":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      // An entry is what every project's runs may get, and its commands run on every machine: a hub admin's alone.
      case "tools.save":
      case "tools.remove":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin changes the tool catalog.", { key: "errors.hubAdminOnly" });
        return;
      case "tools.setProject":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      // Archiving hides a project from everyone and deleting takes it from the whole hub: no project manager's call.
      case "projects.archive":
      case "projects.restore":
      case "projects.delete":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin archives or deletes a project.", { key: "errors.hubAdminOnly" });
        return;
      // The whole list at once, and a cap on a person or the hub binds every project: someone over all of them.
      case "budgets.set":
        if (actor.access) throw new HiveError("forbidden", "Only a hub admin sets spending caps.", { key: "errors.hubAdminOnly" });
        return;
      case "chat.configure":
      case "chat.rename":
      case "chat.delete": {
        const row = this.db.prepare("SELECT project FROM chat_threads WHERE id = ?").get(i.threadId) as Row | undefined;
        if (!row) return;
        if (str(row.project) === HUB_SCOPE) return this.#needHubAdmin(actor, `Chat #${i.threadId}`);
        this.#need(actor, str(row.project), "chatUse", `Chat #${i.threadId}`);
        return;
      }
      case "chat.cancel": {
        const project = this.#threadProjectOfReply(i.replyId);
        if (project === null) return;
        if (project === HUB_SCOPE) return this.#needHubAdmin(actor, `Chat reply #${i.replyId}`);
        this.#need(actor, project, "chatUse", `Chat reply #${i.replyId}`);
        return;
      }
      case "runs.steer":
      case "runs.cancel": {
        const row = this.db.prepare("SELECT project FROM run_records WHERE machine_id = ? AND run_id = ?").get(i.machineId, i.runId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Run ${i.runId}`);
        return;
      }
      case "runs.ciPolicy":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "runs.stopCi":
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.merge": {
        const row = this.db.prepare("SELECT project, requested_by FROM run_records WHERE machine_id = ? AND run_id = ?").get(i.machineId, i.runId) as Row | undefined;
        if (!row) return;
        // Merging accepts the code, as moving its task to done does: a reviewer's call, and not on your own run.
        this.#need(actor, str(row.project), "codeReview", `Run ${i.runId}`);
        if (row.requested_by != null) this.#notSelf(actor, [str(row.requested_by)], `Run ${i.runId}`);
        return;
      }
      case "runs.cancelRequest": {
        const row = this.db.prepare("SELECT project FROM run_requests WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Run request #${i.id}`);
        return;
      }
      case "runs.push":
        for (const r of i.runs as Array<{ project: string }>) this.#need(actor, r.project, "taskWork", `Project ${r.project}`);
        return;
      case "cooldowns.set":
      case "cooldowns.clear": {
        if (this.#isHubAdmin(actor)) return;
        // Subscription accounts can be shared: every reporting machine owns its cooldown, as does its human owner.
        const machines = this.db.prepare(`SELECT id, owner, token_id FROM machines WHERE EXISTS (
          SELECT 1 FROM json_each(machines.profiles) p WHERE json_extract(p.value, '$.account') = ?
        )`).all(i.account) as Row[];
        const human = actor.role !== "agent" && !isAgentActor(actor) && actor.account !== undefined;
        if (machines.some((m) => (str(m.id) === actor.name && (actor.tokenId ? this.isMachineActor(str(m.id), actor) : m.token_id == null)) || (human && actor.account === strOrNull(m.owner)))) return;
        throw new HiveError("forbidden", "Only a reporting machine, its owner or a hub admin changes this subscription's cooldown.", { key: "errors.cooldownForbidden" });
      }
      case "specs.push":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "specs.list":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "specs.importTasks":
        // Planning only shows what would be made; making them is creating tasks.
        return this.#need(actor, i.project, i.dryRun ? "view" : "taskManage", `Project ${i.project}`);
      case "memory.setCleanup":
        if (actor.role === "agent" || isAgentActor(actor)) throw new HiveError("forbidden", "Only a person enables periodic memory cleanup.", { key: "cleanup.errors.human" });
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      case "memory.decideCleanup": {
        const row = this.db.prepare("SELECT project FROM memory_cleanup_proposals WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "memoryApprove", `Memory proposal #${i.id}`);
        if (actor.role === "agent" || isAgentActor(actor)) throw new HiveError("forbidden", "A person must decide memory cleanup proposals.", { key: "cleanup.errors.human" });
        return;
      }
      case "memory.write":
        if (i.system) return this.#need(actor, systemOwner(i.system), "memoryWrite", `System ${i.system}`);
        return this.#need(actor, i.shared ? null : i.project, "memoryWrite", i.shared ? "Shared memory" : `Project ${i.project}`);
      case "memory.checkFiles":
      case "runs.report":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "memory.share":
        // Publishing across the team needs both the source approval and the shared grant.
        this.#need(actor, null, "memoryApprove", "Shared memory");
      case "memory.approve":
      case "memory.resolve":
      case "memory.keep":
      case "memory.remove": {
        const row = this.db.prepare("SELECT project, COALESCE(on_behalf, author) AS owner FROM memory WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project) === SHARED ? null : str(row.project), "memoryApprove", `Memory #${i.id}`);
        if (row && (method === "memory.approve" || method === "memory.share")) this.#notSelf(actor, [str(row.owner)], `Memory #${i.id}`);
        return;
      }
      case "tasks.create":
        return this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
      case "systems.save":
      case "systems.remove": {
        // Every project it has and gets: a system never takes in, or drops, a project its editor does not manage.
        const before = this.#system(i.name)?.projects ?? [];
        for (const p of new Set([...before, ...((i.projects as string[] | undefined) ?? [])])) this.#need(actor, p, "projectSettings", `Project ${p}`);
        return;
      }
      case "tasks.setDeps": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "taskManage", `Task ${i.id}`);
        return;
      }
      case "tasks.classify": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "taskManage", `Task ${i.id}`);
        return;
      }
      // tasks.classifyConfig answers for the projects the caller sees, so it needs nothing more here.
      case "tasks.setClassifyConfig":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      // Giving a task to an agent is queueing its run, only without saying when: the same right as runs.dispatch.
      case "tasks.assign":
      case "tasks.unassign": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "runDispatch", `Task ${i.id}`);
        return;
      }
      // The notes are the task's: whoever may see the project reads them (roadmap 41a).
      case "tasks.notes": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "view", `Task ${i.id}`);
        return;
      }
      case "tasks.requestChanges": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "codeReview", `Task ${i.id}`);
        return;
      }
      case "tasks.claim":
      case "tasks.update": {
        const task = this.#getTask(i.id);
        if (!task) return;
        this.#need(actor, task.project, "taskWork", `Task ${i.id}`);
        // Done is a reviewer's call: an agent sends its work to review, a person with codeReview takes it from there.
        if (method === "tasks.update" && i.status === "done" && task.status !== "done") {
          this.#need(actor, task.project, "codeReview", `Task ${i.id}`);
          // The MR watcher moves a task to done when its MR merged: someone already approved it on GitLab or GitHub,
          // so the merge is the review and the rule below does not apply. (Its label is not proof; a person who fakes
          // it only skips a check meant to stop their own slip, the codeReview right above still holds.)
          if (actor.agent !== MR_WATCHER) this.#notSelf(actor, this.#taskRequesters(task), `Task ${i.id}`);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Who asked for the implement runs that did a task: by a request from the web, or started from a machine's Board. */
  #taskRequesters(task: Task): string[] {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(on_behalf, requested_by) AS who FROM run_requests WHERE project = ?1 AND task_id = ?2 AND role = 'implement' AND status = 'accepted'
         UNION SELECT requested_by FROM run_records WHERE project = ?1 AND task_id = ?2 AND role = 'implement' AND requested_by IS NOT NULL`,
      )
      .all(task.project, task.id) as Row[];
    return rows.map((r) => str(r.who));
  }

  /**
   * Nobody approves their own work (roadmap 27c); an agent on someone's token counts as that person. With the team
   * policy's selfApproval "admins", a hub admin may: on a hub of one person, that person's agents run on their token.
   */
  #notSelf(actor: Actor, owners: string[], what: string): void {
    if (!owners.includes(principalOf(actor))) return;
    if (this.#policy().selfApproval === "admins" && actor.role === "admin" && !actor.access) return;
    throw new HiveError("forbidden", `${what}: someone else has to approve your own work.`, { key: "errors.selfApprove" });
  }

  /** Lists only show what the actor can see (shared items are visible to every account). */
  #researchVisible(row: Row, actor: Actor): boolean {
    const input = JSON.parse(str(row.input)) as ResearchInput;
    return (input.scope !== "hub" || this.#isHubAdmin(actor)) && (JSON.parse(str(row.projects)) as string[]).every(p => sees(actor, p));
  }

  #researchForTask(project: string, taskId: string): Row | undefined {
    const match = /^research-(\d+)$/.exec(taskId);
    return match ? this.db.prepare("SELECT * FROM research_runs WHERE id = ? AND project = ?").get(Number(match[1]), project) as Row | undefined : undefined;
  }

  /** A run's file, or a gate job's (runId = its job id, no task): the same checks and the same store for both. */
  async #putArtifact({ project, taskId, runId, profileId, name: raw, data }: { project: string; taskId: string; runId: string; profileId: string | null; name: string; data: string }, actor: Actor): Promise<Artifact> {
    const name = artifactName(raw);
    if (!name) throw new HiveError("bad_request", `${raw} is not a file name.`, { key: "errors.artifactName", vars: { name: raw } });
    let bytes = new Uint8Array(Buffer.from(data, "base64"));
    const type = checkArtifact(name, bytes);
    if (isArtifactText(type)) {
      const text = new TextDecoder().decode(bytes);
      // Refused, not stripped: an artifact is read by people and by agents, like a doc (41c "Nguyên tắc chung").
      assertNoHidden(text, name);
      bytes = new TextEncoder().encode(redactLines(text));
    }
    // After redaction: the bytes the store gets are the bytes the row names, or artifacts.get would refuse them.
    const sha = sha256(bytes);
    const allowed = () => {
      const has = this.db.prepare("SELECT id, sha256, project, task_id FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?").get(actor.name, runId, name) as Row | undefined;
      if (has) {
        // A verifier's snapshot must keep pointing at the same bytes and scope after a rerun uploads files.
        if (has.sha256 !== sha || has.project !== project || has.task_id !== taskId) this.#checkEvidenceArtifact(num(has.id));
        return;
      }
      const count = num((this.db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE machine_id = ? AND run_id = ?").get(actor.name, runId) as Row).n);
      if (count >= ARTIFACTS_PER_RUN) {
        throw new HiveError("bad_request", `Run ${runId} already has ${ARTIFACTS_PER_RUN} files.`, { key: "errors.artifactsFull", vars: { run: runId, max: ARTIFACTS_PER_RUN } });
      }
    };
    const blobs = this.#opts.blobs;
    // Into the store first, the row after, as for a doc's file: a row never points at bytes the store lacks.
    if (blobs) {
      allowed();
      await this.#toStore(blobs, sha, bytes, type);
    }
    const { artifact, dropped } = this.#tx(() => {
      allowed();
      const before = this.db.prepare("SELECT sha256, stored FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?").get(actor.name, runId, name) as Row | undefined;
      this.db.prepare(
        `INSERT INTO artifacts(project, task_id, run_id, machine_id, name, type, size, sha256, stored, data, profile_id, uploaded_by, on_behalf, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(machine_id, run_id, name) DO UPDATE SET project = excluded.project, task_id = excluded.task_id,
           type = excluded.type, size = excluded.size, sha256 = excluded.sha256, stored = excluded.stored, data = excluded.data,
           profile_id = excluded.profile_id, uploaded_by = excluded.uploaded_by, on_behalf = excluded.on_behalf,
           source = excluded.source, created_at = excluded.created_at`,
      ).run(
        project, taskId, runId, actor.name, name, type, bytes.length, sha, blobs ? blobs.name : null, blobs ? new Uint8Array(0) : bytes,
        profileId, actor.name, actor.onBehalf ?? null, sourceJson(actor.source), this.#now(),
      );
      return {
        artifact: toArtifact(this.db.prepare(`SELECT ${ARTIFACT_FIELDS} FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?`).get(actor.name, runId, name) as Row),
        dropped: before?.stored && before.sha256 !== sha ? str(before.sha256) : null,
      };
    });
    if (dropped) await this.#dropBlob(dropped);
    return artifact;
  }

  #gates(actor: Actor): GateStore {
    return new GateStore(this.db, () => this.#opts.now(), (action, target, detail) => this.audit(actor, action, target, detail));
  }

  #gatesOn(): void {
    if (!this.#opts.gateJobs) throw new HiveError("forbidden", "Gate jobs are off on this hub (HIVE_GATE_JOBS).");
  }

  #researchForArtifact(project: string, taskId: string, machineId: string, runId: string): Row | undefined {
    const research = this.#researchForTask(project, taskId);
    if (!research) return undefined;
    const request = this.db.prepare("SELECT machine_id, run_id FROM run_requests WHERE id = ?").get(num(research.request_id)) as Row | undefined;
    return request && request.machine_id === machineId && request.run_id === runId ? research : undefined;
  }

  #filter<M extends Method>(method: M, output: MethodOutput[M], actor: Actor): MethodOutput[M] {
    const taskVisible = (r: { project: string; taskId: string; role?: AgentRole; machineId?: string; runId?: string }) => {
      const research = r.role === "research" ? this.#researchForTask(r.project, r.taskId) : r.role === undefined ? this.#researchForArtifact(r.project, r.taskId, r.machineId!, r.runId!) : undefined;
      return !research || this.#researchVisible(research, actor);
    };
    if (method === "artifacts.list" || method === "runs.list" || method === "runs.requests") output = (output as unknown as Array<{ project: string; taskId: string }>).filter(taskVisible) as MethodOutput[M];
    if (method === "machines.list") output = (output as Machine[]).map(m => ({ ...m, runs: m.runs.filter(taskVisible) })) as MethodOutput[M];
    if (method === "proposals.list") output = (output as Proposal[]).filter(p => {
      const row = this.db.prepare("SELECT * FROM research_runs WHERE doc_key = ?").get(p.docKey) as Row | undefined;
      return !row || this.#researchVisible(row, actor);
    }) as MethodOutput[M];
    if (!actor.access) return output;
    const visible = (owner: string | null) => sees(actor, owner);
    const out = output as unknown;
    switch (method as Method) {
      case "docs.list":
      case "docs.removed":
        return (out as DocSummary[]).filter((d) => visible(d.project)) as MethodOutput[M];
      case "projects.retired":
        return (out as RetiredProject[]).filter((r) => visible(r.project)) as MethodOutput[M];
      case "skills.list":
        return (out as SkillSummary[]).filter((s) => visible(s.project)) as MethodOutput[M];
      case "runs.list":
        return (out as RunRecord[]).filter((r) => visible(r.project)) as MethodOutput[M];
      case "specs.list":
        return (out as SpecFeature[]).filter((f) => visible(f.project)) as MethodOutput[M];
      case "runs.requests":
        return (out as RunRequest[]).filter((r) => visible(r.project)) as MethodOutput[M];
      case "runs.groups":
        return (out as RunGroup[]).filter((g) => visible(g.project)) as MethodOutput[M];
      case "chat.threads":
        return (out as ChatThread[]).filter((t) => visible(t.project)) as MethodOutput[M];
      case "chat.pending":
        return (out as ChatAction[]).filter((a) => visible(a.project)) as MethodOutput[M];
      case "proposals.list":
        return (out as Proposal[]).filter((p) => visible(SqliteHive.#docOwner(p.docKey))) as MethodOutput[M];
      case "memory.search":
      case "memory.list":
        return (out as Memory[]).filter((m) => visible(m.project)) as MethodOutput[M];
      case "memory.cleanupSettings":
      case "memory.cleanupRuns":
      case "memory.cleanupProposals":
        return (out as Array<{ project: string }>).filter((m) => visible(m.project)) as MethodOutput[M];
      case "tasks.list":
      case "tasks.next":
        return (out as Task[]).filter((t) => visible(t.project)).map((t) => hideDeps(t, visible)) as MethodOutput[M];
      // A machine is the team's but its queue is tasks: a reader sees only the projects they may view (no project input).
      case "tasks.agentQueue":
        return (out as TaskAgentQueueItem[]).filter((q) => visible(q.task.project)).map((q) => ({ ...q, task: hideDeps(q.task, visible) })) as MethodOutput[M];
      // Machines are the team's, but what they run and which repos they have shows the project: hide hidden projects.
      case "machines.list":
        return (out as Machine[]).map((m) => ({ ...m, runs: m.runs.filter((r) => visible(r.project)), projects: m.projects.filter((p) => visible(p)) })) as MethodOutput[M];
      case "projects.list":
        return (out as ProjectSummary[]).filter((p) => visible(p.project)) as MethodOutput[M];
      // Only the projects it may see; a system of none of them is not shown at all.
      case "systems.list":
        return (out as HiveSystem[])
          .map((s) => ({ ...s, projects: s.projects.filter((p) => visible(p)) }))
          .filter((s) => s.projects.length > 0) as MethodOutput[M];
      case "agents.paused":
      case "agents.resume":
        return this.#pausedFor(out as AgentsPaused, actor) as MethodOutput[M];
      case "agents.stop": {
        const stop = out as AgentsStop;
        return { ...stop, paused: this.#pausedFor(stop.paused, actor) } as MethodOutput[M];
      }
      case "policy.get": {
        const policy = out as TeamPolicy;
        return { ...policy, projects: Object.fromEntries(Object.entries(policy.projects).filter(([p]) => visible(p))) } as MethodOutput[M];
      }
      case "modelRouter.get":
      case "modelRouter.set": {
        const view = out as ModelRouterSettings;
        return { ...view, projects: Object.fromEntries(Object.entries(view.projects).filter(([p]) => visible(p))) } as MethodOutput[M];
      }
      case "agentPolicy.get":
      case "sdlc.get":
      case "sdlc.setCeiling":
      case "sdlc.setProject": {
        const view = out as SdlcPolicyView;
        return { ...view, projects: Object.fromEntries(Object.entries(view.projects).filter(([p]) => visible(p))) } as MethodOutput[M];
      }
      case "sdlc.gates":
        return (out as SdlcGateRecord[]).filter((g) => visible(g.project)) as MethodOutput[M];
      case "sdlc.flows":
        return (out as SdlcFlow[]).filter((f) => visible(f.project)) as MethodOutput[M];
      case "sdlc.flowTasks":
        return (out as SdlcFlowTask[]).filter((f) => visible(f.project)) as MethodOutput[M];
      case "agentPolicy.set": {
        const view = out as AgentPolicyView;
        const only = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([p]) => visible(p)));
        return { ...view, projects: only(view.projects), effective: only(view.effective) } as MethodOutput[M];
      }
      // What a project spent shows to who sees the project, a person's to that person; the hub's sums projects they may
      // not see, so only unrestricted readers get it.
      case "budgets.list":
      case "budgets.set":
        return (out as BudgetUsage[]).filter((b) =>
          b.scope.kind === "project" ? visible(b.scope.project) : b.scope.kind === "user" ? b.scope.user === (actor.onBehalf ?? actor.name) : false,
        ) as MethodOutput[M];
      default:
        return output;
    }
  }

  #embedError: string | null = null;
  #indexedAt: string | null = null;
  #indexing = false;

  /**
   * Embeds approved memory that has no vector for the current model yet, up to `max` entries.
   * Returns how many got one; the hub calls it until that is 0. An error stops the round and shows in memory.searchInfo.
   */
  async indexMemory(max = 64): Promise<number> {
    const embedder = this.#opts.embedder;
    if (!embedder || this.#indexing) return 0;
    this.#indexing = true;
    try {
      const rows = this.db
        .prepare(
          `SELECT m.id, m.content FROM memory m LEFT JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?
           WHERE m.status = 'approved' AND v.memory_id IS NULL ORDER BY m.id LIMIT ?`,
        )
        .all(embedder.model, max) as Row[];
      const still = this.db.prepare("SELECT 1 FROM memory WHERE id = ? AND status = 'approved' AND content = ?");
      const put = this.db.prepare("INSERT OR REPLACE INTO memory_vectors(memory_id, model, vector) VALUES (?, ?, ?)");
      let done = 0;
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH);
        let vectors: Float32Array[];
        try {
          vectors = await embedder.embed(batch.map((r) => str(r.content)));
          this.#embedError = null;
        } catch (err) {
          this.#embedError = (err as Error).message;
          break;
        }
        // An entry removed or edited while its vector was being made gets one next round.
        batch.forEach((r, j) => {
          if (still.get(num(r.id), str(r.content))) put.run(num(r.id), embedder.model, toBlob(vectors[j]!));
        });
        done += batch.length;
      }
      if (done) this.#indexedAt = this.#now();
      return done;
    } finally {
      this.#indexing = false;
    }
  }

  async #queryVector(query: string): Promise<Float32Array | null> {
    const embedder = this.#opts.embedder;
    if (!embedder || !query.trim()) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), QUERY_EMBED_MS);
      });
      const [v] = await Promise.race([embedder.embed([query]), late]);
      this.#embedError = null;
      return v ?? null;
    } catch (err) {
      this.#embedError = (err as Error).message;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Records an admin action (also used by the hub for token changes, which live outside the method table). */
  audit(actor: Actor, action: string, target: string, detail = "", text?: ErrorText): void {
    // The desktop window sends a label too ("desktop"): only an agent's goes in the agent column.
    const agent = isAgentActor(actor) ? (actor.agent ?? actor.name) : null;
    // Source-less writes also seed historical schemas in migration tests, before the source column exists.
    this.db
      .prepare(`INSERT INTO audit(at, actor, action, target, detail, detail_key, detail_vars, agent, on_behalf, run${actor.source ? ", source" : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${actor.source ? ", ?" : ""})`)
      .run(
        this.#now(),
        actor.name,
        action,
        target,
        clipDetail(detail),
        text?.key ?? null,
        text?.vars ? JSON.stringify(text.vars) : null,
        agent,
        actor.onBehalf ?? null,
        actor.run ?? actor.source?.run ?? null,
        ...(actor.source ? [JSON.stringify(actor.source)] : []),
      );
  }

  /** Called on hub start and every minute: persisted timestamps survive restarts and catch up once. */
  queueMemoryCleanup(): number {
    return this.#tx(() => {
      const db = this.db;
      const now = this.#now();
      // A lost worker ends visibly; a new weekly run can be queued after its lease expires.
      db.prepare("UPDATE memory_cleanup_runs SET status = 'failed', snapshot = '[]', error = 'expired', updated_at = ? WHERE status = 'running' AND updated_at < ?")
        .run(now, new Date(Date.parse(now) - 15 * 60_000).toISOString());
      let queued = 0;
      const rows = db.prepare("SELECT * FROM memory_cleanup_settings WHERE enabled = 1").all() as Row[];
      for (const row of rows) {
        const p = str(row.project);
        if (this.#projectState(p) !== null || this.#isPaused(p)) continue;
        if (row.last_queued_at && Date.parse(now) - Date.parse(str(row.last_queued_at)) < 7 * 86400_000) continue;
        if (db.prepare("SELECT 1 FROM memory_cleanup_runs WHERE project = ? AND status IN ('queued','running')").get(p)) continue;
        db.prepare("INSERT INTO memory_cleanup_runs(project, created_at, updated_at) VALUES (?, ?, ?)").run(p, now, now);
        db.prepare("UPDATE memory_cleanup_settings SET last_queued_at = ? WHERE project = ?").run(now, p);
        queued++;
      }
      return queued;
    });
  }

  #cleanupRun(row: Row): MemoryCleanupRun {
    return { id: num(row.id), project: str(row.project), status: str(row.status) as MemoryCleanupRun["status"], machine: strOrNull(row.machine), profile: strOrNull(row.profile), model: str(row.model), costUsd: numOrNull(row.cost_usd), createdAt: str(row.created_at), updatedAt: str(row.updated_at), error: strOrNull(row.error) as MemoryCleanupRun["error"] };
  }

  #cleanupProposal(id: number): MemoryCleanupProposal {
    const row = this.db.prepare("SELECT * FROM memory_cleanup_proposals WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No memory proposal #${id}.`);
    return { ...JSON.parse(str(row.suggestion)), id, project: str(row.project), runId: num(row.run_id), entries: JSON.parse(str(row.entries)), status: str(row.status), reviewer: strOrNull(row.reviewer), decidedAt: strOrNull(row.decided_at), createdAt: str(row.created_at) };
  }

  #cleanupJob(id: number, actor: Actor): Row {
    const row = this.db.prepare("SELECT * FROM memory_cleanup_runs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No memory cleanup run #${id}.`);
    this.#need(actor, str(row.project), "taskWork", `Memory cleanup #${id}`);
    if (row.taken_by !== actor.name) throw new HiveError("forbidden", "Only the machine that took this run can report it.");
    return row;
  }

  /** Creates the default org docs on an empty database. Safe to call on every start. */
  /**
   * The default docs: all of them in a new database; in one seeded before, only those a later seed version added
   * (once: a doc someone removed stays removed). `hub`: also those only a hub needs.
   */
  seed(author = "xdev-hive", opts: { hub?: boolean } = {}): void {
    const count = num((this.db.prepare("SELECT COUNT(*) AS n FROM docs").get() as Row).n);
    const stored = this.db.prepare("SELECT value FROM hive_meta WHERE key = 'seed_version'").get() as Row | undefined;
    // Databases seeded before the version was kept have had the first seed.
    const had = stored ? num(Number(stored.value)) : count > 0 ? 1 : 0;
    if (had >= SEED_VERSION) return;
    this.#tx(() => {
      for (const d of SEED_DOCS) {
        if ((d.since ?? 1) <= had || (d.hubOnly && !opts.hub)) continue;
        if (this.db.prepare("SELECT 1 FROM docs WHERE key = ?").get(d.key)) continue;
        this.#writeDoc(d.key, d.content, { title: d.title, includeInAgents: d.includeInAgents, note: "Seed" }, author);
      }
      this.db.prepare("INSERT INTO hive_meta(key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SEED_VERSION));
    });
  }

  /**
   * Keeps a file someone is about to send in a project's chat (roadmap 17g), for chat.send to attach: only a manager of
   * the project, who alone can send there. Images and PDF are checked by their bytes; text must be UTF-8 with no secret.
   */
  putChatFile(input: { project: string; name: string; bytes: Uint8Array }, actor: Actor): ChatFile {
    if (input.project === HUB_SCOPE) this.#needHubAdmin(actor, "The hub-wide chat");
    else this.#need(actor, input.project, "chatUse", `Project ${input.project}`);
    const name = chatFileName(input.name);
    const type = checkChatFile(name, input.bytes);
    if (!isImage(type) && type !== "application/pdf") assertNoSecret(new TextDecoder().decode(input.bytes), name);
    this.#expireChats();
    const id = num(
      this.db
        .prepare("INSERT INTO chat_files(project, name, type, size, data, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.project, name, type, input.bytes.length, input.bytes, actor.name, this.#now()).lastInsertRowid,
    );
    return toChatFile(this.db.prepare(`SELECT ${FILE_FIELDS} FROM chat_files WHERE id = ?`).get(id) as Row);
  }

  /** A file with its bytes, for whoever sees its project's chats; one not sent yet only for whoever uploaded it. */
  chatFile(id: number, actor: Actor): (ChatFile & { bytes: Uint8Array }) | null {
    const row = this.db.prepare("SELECT * FROM chat_files WHERE id = ?").get(id) as Row | undefined;
    if (!row || !sees(actor, str(row.project))) return null;
    if (str(row.project) === HUB_SCOPE && !this.#isHubAdmin(actor)) return null;
    if (row.message_id == null && str(row.uploaded_by) !== actor.name) return null;
    return { ...toChatFile(row), bytes: row.data as Uint8Array };
  }

  /**
   * The machine that writes this database's chat replies when it is one machine's own (roadmap 48): chat.send and
   * chat.poll take it as a machine that took runs. Left out of machines.list, so no Board or Spec form offers a hub
   * run to a machine that never asks for one. Only a local database (opts.local) takes one.
   */
  setChatMachine(machine: (() => Machine | null) | null): void {
    this.#chatMachine = this.#opts.local ? machine : null;
  }

  /** A machine as chat sees it: this database's own one, or one that heartbeats. */
  #machineFor(id: string): Machine | null {
    const own = this.#chatMachine?.();
    if (own && own.id === id) return own;
    const row = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#toMachine(row) : null;
  }

  close(): void {
    this.db.close();
  }

  #now(offsetMinutes = 0): string {
    return new Date(this.#opts.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  #migrate(): void {
    const current = num((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    const end = Math.min(this.#opts.migrateTo, MIGRATIONS.length);
    for (let v = current; v < end; v++) {
      this.#tx(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  #filesError: string | null = null;
  #moving = false;

  async #toStore(blobs: BlobStore, sha: string, bytes: Uint8Array, type: string): Promise<void> {
    try {
      await blobs.put(sha, bytes, type);
      this.#filesError = null;
    } catch (err) {
      this.#filesError = (err as Error).message;
      throw new HiveError("unavailable", `The file store (${blobs.name}) did not take the file: ${(err as Error).message}`, { key: "errors.fileStore", vars: { store: blobs.name } });
    }
  }

  async #fromStore(row: Row): Promise<Uint8Array> {
    const blobs = this.#opts.blobs;
    const store = str(row.stored);
    if (!blobs || blobs.name !== store) {
      throw new HiveError("unavailable", `${str(row.name)} is kept in ${store}, which this hub is not set up to reach.`, { key: "errors.fileStoreOff", vars: { store } });
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await blobs.get(str(row.sha256));
    } catch (err) {
      this.#filesError = (err as Error).message;
      throw new HiveError("unavailable", `The file store (${store}) did not answer: ${(err as Error).message}`, { key: "errors.fileStore", vars: { store } });
    }
    if (!bytes || sha256(bytes) !== str(row.sha256)) {
      throw new HiveError("not_found", `${str(row.name)} is missing from ${store}.`, { key: "errors.fileMissing", vars: { name: str(row.name), store } });
    }
    return bytes;
  }

  /**
   * The bytes of a file no row points at any more leave the store; a failure only leaves them there. Both tables are
   * asked: the same bytes are kept once, so a doc's file and a run's artifact can be the very same blob.
   */
  /**
   * Drops the artifacts of done tasks sent more than artifactDays ago, and their bytes once nothing points at them. An
   * open task keeps its evidence however old; so does a task that is gone, as there is nothing left to tell.
   */
  async pruneArtifacts(): Promise<{ removed: number; bytes: number }> {
    if (!(this.#opts.artifactDays > 0)) return { removed: 0, bytes: 0 };
    const rows = this.db
      .prepare(
        `SELECT a.id, a.size, a.sha256, a.stored FROM artifacts a JOIN tasks t ON t.project = a.project AND t.id = a.task_id
         WHERE t.status = 'done' AND a.created_at < ?
         AND NOT EXISTS (SELECT 1 FROM acceptance_evidence e, json_each(e.artifacts) ref
           WHERE json_extract(ref.value, '$.id') = a.id)`,
      )
      .all(this.#now(-this.#opts.artifactDays * 24 * 60)) as Row[];
    if (!rows.length) return { removed: 0, bytes: 0 };
    const del = this.db.prepare("DELETE FROM artifacts WHERE id = ?");
    this.#tx(() => { for (const r of rows) del.run(r.id as number); });
    for (const sha of new Set(rows.filter((r) => r.stored).map((r) => str(r.sha256)))) await this.#dropBlob(sha);
    return { removed: rows.length, bytes: rows.reduce((n, r) => n + Number(r.size), 0) };
  }

  /** Artifacts on the hub and how long a done task keeps them, for the Hub page. */
  artifactsInfo(): { count: number; bytes: number; days: number; runLogDays: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM artifacts").get() as Row;
    return { count: Number(r.n), bytes: Number(r.b), days: this.#opts.artifactDays, runLogDays: this.#opts.runLogDays };
  }

  /** Gives the pages freed by deletes back to the disk; the WAL is checkpointed first so the file can shrink. */
  vacuum(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }

  #checkEvidenceArtifact(id: number): void {
    if (this.db.prepare(`SELECT 1 FROM acceptance_evidence e, json_each(e.artifacts) ref
      WHERE json_extract(ref.value, '$.id') = ? LIMIT 1`).get(id)) {
      throw new HiveError("bad_request", "This file is retained as acceptance evidence.", { key: "errors.evidenceArtifactPinned" });
    }
  }

  async #dropBlob(sha: string): Promise<void> {
    const blobs = this.#opts.blobs;
    if (!blobs) return;
    for (const table of BLOB_TABLES) if (this.db.prepare(`SELECT 1 FROM ${table} WHERE sha256 = ? AND stored IS NOT NULL`).get(sha)) return;
    await blobs.remove(sha).catch((err: Error) => (this.#filesError = err.message));
  }

  /**
   * Moves up to `max` files whose bytes are still in the database into the store (a hub that just got one).
   * Returns how many moved; the hub calls it until that is 0. A file replaced meanwhile moves next round.
   */
  async moveFilesToStore(max = 20): Promise<number> {
    const blobs = this.#opts.blobs;
    if (!blobs || this.#moving) return 0;
    this.#moving = true;
    try {
      let moved = 0;
      for (const table of BLOB_TABLES) {
        if (moved >= max) break;
        const rows = this.db.prepare(`SELECT id, name, type, created_at, data FROM ${table} WHERE stored IS NULL ORDER BY id LIMIT ?`).all(max - moved) as Row[];
        for (const r of rows) {
          const bytes = r.data as Uint8Array;
          const sha = sha256(bytes);
          try {
            await blobs.put(sha, bytes, str(r.type));
            this.#filesError = null;
          } catch (err) {
            this.#filesError = (err as Error).message;
            return moved;
          }
          const done = this.db
            .prepare(`UPDATE ${table} SET stored = ?, sha256 = ?, data = ? WHERE id = ? AND stored IS NULL AND created_at = ?`)
            .run(blobs.name, sha, new Uint8Array(0), num(r.id), str(r.created_at));
          if (Number(done.changes) === 1) moved++;
        }
      }
      return moved;
    } finally {
      this.#moving = false;
    }
  }

  /** The SHA-256 of every file kept in the store, for a backup to copy. */
  storedFileIds(): string[] {
    const union = BLOB_TABLES.map((t) => `SELECT sha256 FROM ${t} WHERE stored IS NOT NULL AND sha256 IS NOT NULL`).join(" UNION ");
    return (this.db.prepare(`${union} ORDER BY sha256`).all() as Row[]).map((r) => str(r.sha256));
  }

  /** The bytes of a file in the store, by its SHA-256 (backups). */
  readStoredFile(sha: string): Promise<Uint8Array | null> {
    return this.#opts.blobs ? this.#opts.blobs.get(sha) : Promise.resolve(null);
  }

  filesInfo(): DocFilesInfo {
    const union = BLOB_TABLES.map((t) => `SELECT size, stored FROM ${t}`).join(" UNION ALL ");
    const r = this.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, COALESCE(SUM(stored IS NULL), 0) AS in_db FROM (${union})`).get() as Row;
    const blobs = this.#opts.blobs;
    return { store: blobs?.name ?? null, where: blobs?.where ?? null, count: num(r.n), bytes: num(r.bytes), inDb: num(r.in_db), lastError: this.#filesError };
  }

  #tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  #removeMemory(id: number): { removed: boolean } {
    const db = this.db;
          const removed = num(db.prepare("DELETE FROM memory WHERE id = ?").run(id).changes) === 1;
          if (removed) {
            db.prepare("UPDATE memory SET superseded_by = NULL WHERE superseded_by = ?").run(id);
            db.prepare("UPDATE memory SET supersedes = NULL WHERE supersedes = ?").run(id);
            const linked = db.prepare("SELECT id, conflicts FROM memory WHERE conflicts != '[]'").all() as Row[];
            for (const r of linked) {
              const ids = JSON.parse(str(r.conflicts)) as number[];
              if (ids.includes(id)) this.#setConflicts(num(r.id), ids.filter((x) => x !== id));
            }
          }
          return { removed };
  }

  /** Keep completion and its journal in the same transaction, including automatic group closures. */
  #journalTask(id: string): void {
    const task = this.#getTask(id)!;
    const now = this.#now();
    const systems = (this.db.prepare("SELECT name, projects FROM systems ORDER BY name").all() as Row[])
      .filter((r) => (JSON.parse(str(r.projects)) as string[]).includes(task.project));
    const prefixes = systems.length ? systems.map((r) => `system/${str(r.name)}`) : [`project/${task.project}`];
    const handover = this.db.prepare("SELECT note, source FROM task_notes WHERE task_id = ? ORDER BY version DESC LIMIT 1").get(id) as Row | undefined;
    const note = handover ? str(handover.note) : task.note ?? "";
    const section = (label: string): string => {
      const lines = note.split(/\r?\n/);
      const start = lines.findIndex((line) => new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?${label}`, "i").test(line));
      if (start < 0) return label === "ĐÃ LÀM" ? note.slice(0, 700) : "Không ghi trong bàn giao.";
      let end = start + 1;
      while (end < lines.length && !/^\s*(?:#{1,6}\s*)?(?:\*\*)?(ĐÃ LÀM|CHƯA LÀM|CÁCH KIỂM|RỦI RO)\b/i.test(lines[end]!)) end++;
      return lines.slice(start, end).join("\n").slice(0, 700);
    };
    const run = this.db.prepare("SELECT * FROM run_records WHERE project = ? AND task_id = ? ORDER BY created_at DESC, updated_at DESC, rowid DESC LIMIT 1").get(task.project, id) as Row | undefined;
    const artifacts = this.db.prepare("SELECT id, name, run_id FROM artifacts WHERE project = ? AND task_id = ? ORDER BY id").all(task.project, id) as Row[];
    const source: WriteSource = {
      ...(handover?.source ? JSON.parse(str(handover.source)) as WriteSource : { via: "api" as const }),
      ...(run ? { machine: str(run.machine), run: str(run.run_id) } : {}),
      task: id,
    };
    const text = (value: string) => value.replace(/[\\\[\]`*_<>]/g, "\\$&");
    const marker = `<!-- task-journal:${encodeURIComponent(id)} -->`;
    const endMarker = `<!-- /task-journal:${encodeURIComponent(id)} -->`;
    const lines = [marker, `## ${now.slice(0, 10)} · ${task.project} · ${id}: ${text(task.title)}`, "", "### Đã làm", section("ĐÃ LÀM"), "", "### Rủi ro", section("RỦI RO")];
    if (run) {
      lines.push("", `Run: [${str(run.run_id)}](#/runs?run=${encodeURIComponent(str(run.run_id))}) · máy ${str(run.machine_id)}`);
      if (run.mr_url) lines.push(`MR/PR: ${str(run.mr_url)}`);
    }
    for (const a of artifacts) lines.push(`Artifact #${num(a.id)}: [${text(str(a.name))}](#/tasks?task=${encodeURIComponent(id)}) · run ${str(a.run_id)}`);
    lines.push(endMarker);
    const cleanEntry = redactLines(lines.join("\n"));
    assertNoHidden(cleanEntry, "Task journal");
    for (const prefix of prefixes) {
      const folder = `${prefix}/nhat-ky`;
      if (!this.#getDoc(folder)) this.#writeDoc(folder, "# Nhật ký\n", { title: "Nhật ký", folder: true, includeInAgents: false, note: `Nhật ký: ${id}` }, "hub", source);
      // Reopened tasks retain their original month; exact markers avoid collisions between task ids.
      const existing = (this.db.prepare("SELECT * FROM docs WHERE project = ? AND key LIKE ? AND removed_at IS NULL").all(parseDocKey(`${prefix}/nhat-ky`).project!, `${prefix}/nhat-ky-%`) as Row[])
        .map(toDoc).find((doc) => doc.content.includes(marker));
      const key = existing?.key ?? `${prefix}/nhat-ky-${now.slice(0, 7)}`;
      const doc = existing ?? this.#getDoc(key);
      let content = doc?.content ?? `# Nhật ký ${now.slice(0, 7)}\n`;
      let entry = cleanEntry;
      if (existing) {
        const start = content.indexOf(marker), end = content.indexOf(endMarker, start);
        const previous = content.slice(start, end);
        const completions = previous.split("\n").filter((line) => line.startsWith("Hoàn tất lại: "));
        entry = entry.replace(endMarker, `${[...completions, `Hoàn tất lại: ${now.slice(0, 10)}`].join("\n")}\n${endMarker}`);
        content = content.slice(0, start) + content.slice(end + endMarker.length);
      }
      const heading = /^# [^\n]*\n/.exec(content)?.[0] ?? "";
      content = `${heading}\n${entry}\n\n${content.slice(heading.length).trim()}\n`;
      this.#writeDoc(key, content, { includeInAgents: false, parent: folder, note: `Nhật ký: ${id}` }, "hub", source);
      if (prefix.startsWith("system/")) {
        const overviewKey = `${prefix}/tong-quan`;
        const overview = this.#getDoc(overviewKey);
        const link = `[[${folder}|Nhật ký]]`;
        if (!overview?.content.includes(link)) this.#writeDoc(overviewKey, `${overview?.content ?? "# Tổng quan\n"}\n${link}\n`, { note: `Nhật ký: ${id}` }, "hub", source);
      }
    }
  }

  #getDoc(key: string): Doc | null {
    const row = this.db.prepare("SELECT * FROM docs WHERE key = ?").get(key) as Row | undefined;
    return row ? toDoc(row) : null;
  }

  #writeDoc(
    key: string,
    content: string,
    meta: { title?: string; includeInAgents?: boolean; paths?: string[]; note?: string; parent?: string | null; folder?: boolean; mirror?: DocMirror | null },
    author: string,
    source: WriteSource | null = null,
  ): Doc {
    const parsed = parseDocKey(key);
    this.#assertSystem(parsed.project);
    if (meta.parent) this.#checkParent(key, meta.parent);
    const paths = [...new Set(meta.paths ?? this.#getDoc(key)?.paths ?? [])];
    if (parsed.skill) {
      SqliteHive.#checkSkill(parsed, content);
      if (paths.length) throw new HiveError("bad_request", `${key} is a skill: skills are not limited to paths.`, { key: "errors.skillPaths", vars: { key } });
    }
    // AGENTS.md and docs/decisions.md are the repo-wide docs themselves.
    if (paths.length && parsed.project && (key === agentsDocKey(parsed.project) || key === decisionsDocKey(parsed.project))) {
      throw new HiveError("bad_request", `${key} is for the whole repo and cannot be limited to paths.`, { key: "errors.docPathsWholeRepo", vars: { key } });
    }
    assertNoSecret(content, "Document content");
    assertNoHidden(content, "Document content");
    if (meta.title) assertNoHidden(meta.title, "Title");
    if (meta.note) assertNoHidden(meta.note, "Note");
    const existing = this.#getDoc(key);
    // Writing over a removed page would bring it back by the side door, with no sign of the removal: restore it first.
    if (existing?.removedAt) {
      throw new HiveError("conflict", `${key} was removed on ${existing.removedAt}. Restore it before writing to it.`, {
        key: "errors.docRemoved",
        vars: { key, at: existing.removedAt },
      });
    }
    const version = (existing?.version ?? 0) + 1;
    const now = this.#now();
    const title = meta.title ?? existing?.title ?? titleFromSlug(parsed.slug);
    // A skill goes to .claude/skills, never into AGENTS.md.
    const include = !parsed.skill && (meta.includeInAgents ?? existing?.includeInAgents ?? parsed.scope === "org");
    const parent = meta.parent !== undefined ? meta.parent : (existing?.parent ?? null);
    const folder = !parsed.skill && (meta.folder ?? existing?.folder ?? false);
    const mirror = meta.mirror !== undefined ? meta.mirror : (existing?.mirror ?? null);
    this.db
      .prepare(
        `INSERT INTO docs(key, scope, project, title, content, version, include_in_agents, paths, parent, folder, mirror, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET title = excluded.title, content = excluded.content,
           version = excluded.version, include_in_agents = excluded.include_in_agents, paths = excluded.paths,
           parent = excluded.parent, folder = excluded.folder, mirror = excluded.mirror, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(key, parsed.scope, parsed.project, title, content, version, include ? 1 : 0, JSON.stringify(paths), parent, folder ? 1 : 0, mirror ? JSON.stringify(mirror) : null, author, now);
    this.db
      .prepare("INSERT INTO doc_versions(key, version, content, author, note, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(key, version, content, author, meta.note ?? "", sourceJson(source), now);
    return this.#getDoc(key)!;
  }

  /** A page goes under a page of its own space that is not a skill, not under itself or its own pages, and not too deep. */
  #checkParent(key: string, parent: string): void {
    const bad = (k: string, msg: string) => new HiveError("bad_request", msg, { key: `errors.${k}`, vars: { key, parent } });
    const p = parseDocKey(parent);
    const self = parseDocKey(key);
    if (parent === key) throw bad("docParentSelf", `${key} cannot go under itself.`);
    if (p.skill || self.skill) throw bad("docParentSkill", "Skills stay in the skills folder: they do not go under pages, and pages do not go under them.");
    if (p.project !== self.project) throw bad("docParentSpace", `${parent} is in another space than ${key}.`);
    let at: string | null = parent;
    for (let depth = 1; at; depth++) {
      if (at === key) throw bad("docParentCycle", `${parent} is under ${key}: a page cannot go under its own pages.`);
      if (depth >= DOC_TREE_DEPTH) throw bad("docParentDepth", `Pages nest at most ${DOC_TREE_DEPTH} deep.`);
      // A removed page holds nothing: putting a page under one reads as there being no such page (roadmap 38g).
      const row = this.db.prepare("SELECT parent FROM docs WHERE key = ? AND removed_at IS NULL").get(at) as Row | undefined;
      if (!row) {
        if (at === parent) throw bad("docParentMissing", `There is no page ${parent} to put ${key} under.`);
        break;
      }
      at = strOrNull(row.parent);
    }
  }

  /**
   * The pages under `key`, a level at a time, keeping only those `keep` accepts; a page it turns down stops that
   * branch, so one removal and the restore that undoes it walk the same tree.
   */
  #under(key: string, keep: (page: { key: string; removedAt: string | null; removedOp: number | null }) => boolean): string[] {
    const out: string[] = [];
    let edge = [key];
    for (let depth = 0; edge.length && depth < DOC_TREE_DEPTH; depth++) {
      const next: string[] = [];
      for (const parent of edge) {
        for (const r of this.db.prepare("SELECT key, removed_at, removed_op FROM docs WHERE parent = ?").all(parent) as Row[]) {
          const page = { key: str(r.key), removedAt: strOrNull(r.removed_at), removedOp: r.removed_op == null ? null : num(r.removed_op) };
          if (!keep(page)) continue;
          out.push(page.key);
          next.push(page.key);
        }
      }
      edge = next;
    }
    return out;
  }

  /** Where a key a page used to have leads now (roadmap 38g); chains are collapsed as pages move, so one hop is enough. */
  #redirects(): Map<string, string> {
    return new Map((this.db.prepare("SELECT from_key, to_key FROM doc_redirects").all() as Row[]).map((r) => [str(r.from_key), str(r.to_key)]));
  }

  /** The key of a page in `to`'s space keeping its own slug: what a page under a moved one becomes. */
  static #keyIn(key: string, space: ParsedDocKey): string {
    const { slug, skill } = parseDocKey(key);
    const tail = `${skill ? "skills/" : ""}${slug}`;
    return space.scope === "org" ? `org/${tail}` : space.scope === "system" ? `system/${systemOf(space.project)!}/${tail}` : `project/${space.project}/${tail}`;
  }

  /**
   * Gives each page a new key, in one transaction: its row, its versions, its files, its asks, the proposals waiting on
   * it and the pages under it follow, and the old key is kept pointing at the new one so links from before still work.
   */
  #rekey(pairs: Array<{ from: string; to: string }>, actor: Actor, now: string): void {
    const db = this.db;
    for (const { to } of pairs) {
      if (db.prepare("SELECT 1 FROM docs WHERE key = ?").get(to)) {
        throw new HiveError("conflict", `There is already a page ${to}.`, { key: "errors.docKeyTaken", vars: { key: to } });
      }
    }
    for (const { from, to } of pairs) {
      const parsed = parseDocKey(to);
      db.prepare("UPDATE docs SET key = ?, scope = ?, project = ? WHERE key = ?").run(to, parsed.scope, parsed.project, from);
      db.prepare("UPDATE docs SET parent = ? WHERE parent = ?").run(to, from);
      db.prepare("UPDATE doc_versions SET key = ? WHERE key = ?").run(to, from);
      db.prepare("UPDATE doc_assets SET doc_key = ? WHERE doc_key = ?").run(to, from);
      db.prepare("UPDATE doc_assists SET doc_key = ? WHERE doc_key = ?").run(to, from);
      db.prepare("UPDATE proposals SET doc_key = ? WHERE doc_key = ?").run(to, from);
      // A page living at the new key again leaves no redirect of its own behind.
      db.prepare("DELETE FROM doc_redirects WHERE from_key = ?").run(to);
      db.prepare(
        `INSERT INTO doc_redirects(from_key, to_key, moved_by, moved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(from_key) DO UPDATE SET to_key = excluded.to_key, moved_by = excluded.moved_by, moved_at = excluded.moved_at`,
      ).run(from, to, actor.name, now);
      // The page moved twice: the keys it had before point straight at where it is now.
      db.prepare("UPDATE doc_redirects SET to_key = ? WHERE to_key = ? AND from_key <> ?").run(to, from, from);
    }
  }

  /** Project keys put to rest (roadmap 38g), settings key `retiredProjects`. */
  #retired(): Record<string, { at: string; by: string; note: string | null }> {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'retiredProjects'").get() as Row | undefined;
    return row ? (JSON.parse(str(row.value)) as Record<string, { at: string; by: string; note: string | null }>) : {};
  }

  #saveRetired(value: Record<string, { at: string; by: string; note: string | null }>): void {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES ('retiredProjects', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(value));
  }

  /** A resting key with what is left on it: the lists only hide it once no machine, page or open task is on it. */
  #retiredView(project: string, entry: { at: string; by: string; note: string | null }): RetiredProject {
    const one = (sql: string) => num((this.db.prepare(sql).get(project) as Row).n);
    const left = {
      machines: this.#machinesWith(project).length,
      docs: one("SELECT COUNT(*) AS n FROM docs WHERE project = ? AND removed_at IS NULL"),
      openTasks: one("SELECT COUNT(*) AS n FROM tasks WHERE project = ? AND status != 'done'"),
    };
    return { project, ...entry, left, hidden: left.machines === 0 && left.docs === 0 && left.openTasks === 0 };
  }

  /** A skill's SKILL.md must name the folder it is loaded from: the key's last part. */
  static #checkSkill(parsed: ParsedDocKey, content: string): void {
    const meta = parseSkill(content);
    if (meta.name !== parsed.slug) {
      throw new HiveError("bad_request", `The skill says name: ${meta.name}, but its key ends in ${parsed.slug}. Use the same name.`, {
        key: "errors.skillNameMismatch",
        vars: { name: meta.name, slug: parsed.slug },
      });
    }
  }

  #getProposal(id: number): Proposal {
    const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Proposal #${id} not found.`, { key: "errors.proposalNotFound", vars: { id } });
    return toProposal(row);
  }

  #getMemory(id: number): Memory {
    const row = this.db.prepare("SELECT * FROM memory WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Memory #${id} not found.`, { key: "errors.memoryNotFound", vars: { id } });
    return toMemory(row, this.#staleBefore());
  }

  #setConflicts(id: number, ids: number[]): void {
    this.db.prepare("UPDATE memory SET conflicts = ? WHERE id = ?").run(JSON.stringify([...new Set(ids)].sort((x, y) => x - y)), id);
  }

  #staleBefore(): string | null {
    return this.#opts.memoryStaleDays > 0 ? this.#now(-this.#opts.memoryStaleDays * 24 * 60) : null;
  }

  #getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#tasks([row])[0]! : null;
  }

  /**
   * The hub's rules (roadmap 54b) on a task nobody classified by hand: they only fill what is still empty, so a
   * person's or the classifier's answer is never undone by a later note. `title only`: a note the hub wrote itself
   * ("Spec Kit · specs/…") would read as a keyword.
   */
  #applyTaskRule(id: string, opts: { role?: AgentRole; specStep?: string; titleOnly?: boolean } = {}): void {
    const task = this.#getTask(id);
    if (!task || (task.classifiedBy !== null && task.classifiedBy !== "rule")) return;
    const found = classifyTaskRule(task.title, opts.titleOnly ? null : task.note, opts.role, opts.specStep);
    if ((!found.kind || task.kind) && (!found.risk || task.risk)) return;
    this.db
      .prepare("UPDATE tasks SET kind = COALESCE(kind, ?), risk = COALESCE(risk, ?), classified_by = 'rule', classified_at = ? WHERE id = ?")
      .run(found.kind ?? null, found.risk ?? null, this.#now(), id);
  }

  #classifyEnabled(project: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM task_classify_config WHERE project = ?").get(project) as Row | undefined;
    return row ? num(row.enabled) === 1 : true;
  }

  /**
   * The classifier's answer, or the default (null: it failed). It fills what is empty: a size or risk a person gave
   * while it ran stays, and so does a high risk the rules found.
   */
  #finishClassify(taskId: string, result: TaskClass | null): void {
    const picked = result ?? DEFAULT_TASK_CLASS;
    this.db
      .prepare(
        `UPDATE tasks SET kind = ?, size = COALESCE(size, ?),
           risk = CASE WHEN risk = 'high' OR (risk IS NOT NULL AND classified_by <> 'rule') THEN risk ELSE ? END,
           classified_by = 'ai', classified_at = ? WHERE id = ? AND kind IS NULL`,
      )
      .run(picked.kind, picked.size, picked.risk, this.#now(), taskId);
    this.db.prepare("DELETE FROM task_classify_runs WHERE task_id = ?").run(taskId);
  }

  /**
   * Before a task with no kind starts its run, a short classify run on the same machine (roadmap 54b). True while that
   * run must end first: the caller leaves the task for a later release. Off for the project, no Claude/Codex profile
   * on the machine, or a classifier that never answered: the task goes on (with the default when one was tried).
   */
  #queueClassify(task: Task, machine: Machine, actor: Actor): boolean {
    if (this.#getTask(task.id)?.kind !== null || !this.#classifyEnabled(task.project)) return false;
    const prior = this.db.prepare("SELECT request_id, requested_at FROM task_classify_runs WHERE task_id = ?").get(task.id) as Row | undefined;
    if (prior) {
      const req = this.#runRequest(num(prior.request_id));
      if (["rejected", "cancelled", "expired"].includes(req.status) || str(prior.requested_at) < this.#now(-CLASSIFY_WAIT_MINUTES)) {
        this.#finishClassify(task.id, null);
        return false;
      }
      return true;
    }
    // Only a profile the machine says can classify (an app that knows the role, a Claude or Codex plan): otherwise the
    // task stays unclassified rather than waiting for a run nobody there would take.
    if (!machine.profiles.some((p) => p.enabled && p.classify === true)) return false;
    const req = this.#insertRequest(machine, task.project, task, { role: "classify", profileId: null, reviewAfter: false, candidates: 1, instructions: "" }, actor);
    this.db.prepare("INSERT INTO task_classify_runs(task_id, request_id, requested_at) VALUES (?, ?, ?)").run(task.id, req.id, this.#now());
    return true;
  }

  /**
   * A handover note as the board keeps it (roadmap 41a): hidden characters are refused and lines that look like a
   * secret are replaced, once, so `tasks.note` and the version kept beside it are the same text.
   */
  static #cleanNote(note: string): string {
    assertNoHidden(note, "Note");
    return redactLines(note);
  }

  /**
   * Keeps a note as its own version, so a later handover never erases this one. Called by every write of
   * `tasks.note` with the status the task has right after it. The same text as the note already on the task adds
   * nothing, so it is not kept twice (a caller that resends its note has not written a new handover).
   */
  #keepNote(taskId: string, note: string, status: TaskStatus, actor: Actor, at: string): void {
    const last = this.db.prepare("SELECT version, note FROM task_notes WHERE task_id = ? ORDER BY version DESC LIMIT 1").get(taskId) as Row | undefined;
    if (last && str(last.note) === note) return;
    this.db
      .prepare("INSERT INTO task_notes(task_id, version, note, status, author, on_behalf, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(taskId, (last ? num(last.version) : 0) + 1, note, status, actor.name, actor.onBehalf ?? null, sourceJson(actor.source), at);
  }

  /** Source pagination must not spend its limit on hidden or archived projects. */
  #sourceProjects(input: { project?: string; projects?: string[] }, actor: Actor): string[] {
    const hidden = this.#projectStates();
    const projects = input.project ? [input.project] : input.projects ?? (actor.access ? Object.keys(actor.access.projects)
      : (this.db.prepare("SELECT project FROM tasks UNION SELECT project FROM run_records").all() as Row[]).map((r) => str(r.project)));
    return projects.filter((p) =>
      (!input.project || input.project === p) && (!input.projects || input.projects.includes(p)) &&
      sees(actor, p) && (input.project === p || !hidden.has(p)));
  }

  /** Task rows with what they depend on, in one query. */
  #tasks(rows: Row[]): Task[] {
    if (!rows.length) return [];
    const deps = this.db
      .prepare(
        `SELECT d.task_id, d.depends_on, t.status, t.project FROM task_deps d LEFT JOIN tasks t ON t.id = d.depends_on
         WHERE d.task_id IN (SELECT value FROM json_each(?)) ORDER BY d.depends_on`,
      )
      .all(JSON.stringify(rows.map((r) => str(r.id)))) as Row[];
    const projectOf = new Map(rows.map((r) => [str(r.id), str(r.project)]));
    const by = new Map<string, Pick<Task, "dependsOn" | "waitingOn" | "depProjects">>();
    for (const d of deps) {
      const entry = by.get(str(d.task_id)) ?? { dependsOn: [], waitingOn: [] };
      entry.dependsOn.push(str(d.depends_on));
      if (strOrNull(d.status) !== "done") entry.waitingOn.push(str(d.depends_on));
      // Another service's task (roadmap 19d): the page says whose.
      const other = strOrNull(d.project);
      if (other !== null && other !== projectOf.get(str(d.task_id))) entry.depProjects = { ...entry.depProjects, [str(d.depends_on)]: other };
      by.set(str(d.task_id), entry);
    }
    const machines = this.#machineNames();
    return rows.map((r) => toTask(r, by.get(str(r.id)), machines));
  }

  /** Machine names by hub id; machines are few and the map is read once per task list. */
  #machineNames(): Map<string, string> {
    return new Map((this.db.prepare("SELECT id, machine FROM machines").all() as Row[]).map((r) => [str(r.id), str(r.machine)]));
  }

  /** Whether two projects are services of one system (roadmap 19c/19d). */
  #sameSystem(a: string, b: string): boolean {
    return a === b || this.#systemList().some((s) => s.projects.includes(a) && s.projects.includes(b));
  }

  /**
   * Dependencies must be other tasks of the same project, or of another service of a system it is in (roadmap 19d:
   * service B waits for A's API), that the actor sees, and must not lead back to the task.
   */
  #checkDeps(id: string, project: string, dependsOn: string[], actor: Actor): string[] {
    const deps = [...new Set(dependsOn)];
    for (const dep of deps) {
      if (dep === id) throw new HiveError("bad_request", `Task ${id} cannot depend on itself.`, { key: "errors.taskDepSelf", vars: { id } });
      const task = this.#getTask(dep);
      // One of a project the actor does not see is not there, as everywhere else.
      if (!task || !sees(actor, task.project)) throw new HiveError("not_found", `Task ${dep} not found.`, { key: "errors.taskNotFound", vars: { id: dep } });
      if (!this.#sameSystem(task.project, project)) {
        throw new HiveError("bad_request", `Task ${dep} belongs to project ${task.project}, which is neither ${project} nor a service of a system with it.`, {
          key: "errors.taskDepProject",
          vars: { id: dep, project: task.project, other: project },
        });
      }
    }
    // Walk what the new dependencies depend on: reaching the task again would make a cycle.
    const next = this.db.prepare("SELECT depends_on FROM task_deps WHERE task_id = ?");
    const seen = new Set<string>();
    const queue = [...deps];
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === id) throw new HiveError("bad_request", `Task ${id} would end up depending on itself.`, { key: "errors.taskDepCycle", vars: { id } });
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const r of next.all(cur) as Row[]) queue.push(str(r.depends_on));
    }
    return deps;
  }

  #setDeps(id: string, deps: string[]): void {
    this.db.prepare("DELETE FROM task_deps WHERE task_id = ?").run(id);
    const add = this.db.prepare("INSERT INTO task_deps(task_id, depends_on) VALUES (?, ?)");
    for (const dep of deps) add.run(id, dep);
  }

  /** Cooldowns still in force; expired ones are dropped on the way. */
  #cooldowns(): QuotaCooldown[] {
    const now = this.#now();
    this.db.prepare("DELETE FROM quota_cooldowns WHERE until <= ?").run(now);
    return (this.db.prepare("SELECT * FROM quota_cooldowns ORDER BY until").all() as Row[]).map(toCooldown);
  }

  #system(name: string): HiveSystem | null {
    const row = this.db.prepare("SELECT * FROM systems WHERE name = ?").get(name) as Row | undefined;
    return row ? toSystem(row) : null;
  }

  #policy(): TeamPolicy {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'policy'").get() as Row | undefined;
    return row ? { ...EMPTY_POLICY, ...(JSON.parse(str(row.value)) as TeamPolicy) } : EMPTY_POLICY;
  }

  /**
   * What a heartbeat carries: the default and the parts of the projects the machine last said it has (and its token may
   * see), so a machine never learns the rules of a project it does not work on.
   */
  #machineAgentPolicy(actor: Actor): { hub: AgentPolicy; projects: Record<string, Partial<AgentPolicy>> } {
    const { hub, projects } = this.#agentPolicy();
    const row = this.db.prepare("SELECT projects FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    const has = new Set(row ? (JSON.parse(str(row.projects)) as string[]) : []);
    return { hub, projects: Object.fromEntries(Object.entries(projects).filter(([p]) => has.has(p) && sees(actor, p))) };
  }

  /**
   * The catalog a heartbeat carries (roadmap 28b), like #machineAgentPolicy: only the projects the machine last said it
   * has and its token sees. An entry goes when one of them has a line for it, when it is on by default, or when the
   * app has its own code for it: a project with no line still gets codegraph and superpowers from the repo's own
   * setup (.mcp.json, .claude/settings.json), which the machine reads itself.
   */
  #machineTools(actor: Actor): MachineTools {
    const row = this.db.prepare("SELECT projects FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    const mine = (row ? (JSON.parse(str(row.projects)) as string[]) : []).filter((p) => sees(actor, p));
    const lines = mine.length
      ? (this.db.prepare(`SELECT * FROM tool_projects WHERE project IN (${mine.map(() => "?").join(", ")})`).all(...mine) as Row[])
      : [];
    const entries: ToolEntry[] = [];
    const projects: MachineTools["projects"] = Object.fromEntries(mine.map((p) => [p, []]));
    for (const r of this.db.prepare("SELECT id, entry FROM tools ORDER BY id").all() as Row[]) {
      const entry: ToolEntry = { id: str(r.id), ...(JSON.parse(str(r.entry)) as Omit<ToolEntry, "id">) };
      const own = lines.filter((l) => str(l.tool_id) === entry.id);
      if (!own.length && !entry.enabledByDefault && entry.handler === null) continue;
      entries.push(entry);
      for (const p of mine) {
        const l = own.find((x) => str(x.project) === p);
        const enabled = l && l.enabled != null ? num(l.enabled) === 1 : null;
        projects[p]!.push({ id: entry.id, enabled, effective: toolEffective(enabled, entry.enabledByDefault), required: l ? num(l.required) === 1 : false });
      }
    }
    return { entries, projects };
  }

  /**
   * A catalog entry with the settings of the projects the actor may view: a project's choices tell what it uses, which
   * is not for those who cannot see the project. With `only`, that project's line alone, there even with no row of its own.
   */
  #toolView(row: Row, actor: Actor, only?: string): ToolView {
    const entry = JSON.parse(str(row.entry)) as Omit<ToolEntry, "id">;
    const id = str(row.id);
    const rows = (
      only === undefined
        ? this.db.prepare("SELECT * FROM tool_projects WHERE tool_id = ? ORDER BY project").all(id)
        : this.db.prepare("SELECT * FROM tool_projects WHERE tool_id = ? AND project = ?").all(id, only)
    ) as Row[];
    const setting = (project: string, enabled: boolean | null, required: boolean): ToolProjectSetting => ({
      project,
      enabled,
      required,
      effective: toolEffective(enabled, entry.enabledByDefault),
    });
    const projects = rows
      .filter((r) => may(actor, str(r.project), "view"))
      .map((r) => setting(str(r.project), r.enabled == null ? null : num(r.enabled) === 1, num(r.required) === 1));
    if (only !== undefined && !projects.length) projects.push(setting(only, null, false));
    return { id, ...entry, builtin: num(row.builtin) === 1, version: num(row.version), updatedAt: str(row.updated_at), updatedBy: str(row.updated_by), projects };
  }

  /** Next to the team policy, in its own key: policy.set replaces the whole team policy and must not touch this. */
  #agentPolicy(): AgentPolicySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'agentPolicy'").get() as Row | undefined;
    if (!row) return EMPTY_AGENT_POLICY;
    const stored = JSON.parse(str(row.value)) as AgentPolicySettings;
    return { ...EMPTY_AGENT_POLICY, ...stored, hub: { ...OPEN_POLICY, ...stored.hub } };
  }

  #modelRouter(): ModelRouterSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'modelRouter'").get() as Row | undefined;
    if (!row) return DEFAULT_MODEL_ROUTER;
    const saved = JSON.parse(str(row.value)) as ModelRouterSettings;
    const tiers = Object.fromEntries(MODEL_TIERS.map((tier) => [tier, { ...DEFAULT_MODEL_ROUTER.tiers[tier], ...saved.tiers?.[tier] }])) as ModelRouterSettings["tiers"];
    return { tiers, cells: saved.cells ?? DEFAULT_MODEL_ROUTER.cells, projects: saved.projects ?? {} };
  }

  #saveModelRouter(next: ModelRouterSettings): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('modelRouter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  }

  /** The project's own cell, as a person would set it in its part of modelRouter: the hub's table stays as it is. */
  #setModelCell(project: string, kind: TaskKind, size: TaskSize, tier: ModelTier): void {
    const router = this.#modelRouter();
    const own: ModelProject = router.projects[project] ?? { enabled: true, profile: "balanced", cells: {} };
    const cells = { ...own.cells, [kind]: { ...own.cells[kind], [size]: tier } };
    this.#saveModelRouter({ ...router, projects: { ...router.projects, [project]: { ...own, cells } } });
  }

  #learningOn(project: string): boolean {
    const row = this.db.prepare("SELECT enabled FROM model_learning WHERE project = ?").get(project) as Row | undefined;
    return !row || num(row.enabled) === 1;
  }

  /** "kind/size" of the cells a person keeps by hand. */
  #lockedCells(project: string): Set<string> {
    const row = this.db.prepare("SELECT locked FROM model_learning WHERE project = ?").get(project) as Row | undefined;
    return new Set(row ? (JSON.parse(str(row.locked)) as string[]) : []);
  }

  #logLearning(project: string, change: LearningChange, by: string, cell?: { kind: TaskKind; size: TaskSize; from?: ModelTier; to?: ModelTier; tasks?: number; cleanRate?: number }): void {
    this.db
      .prepare(
        `INSERT INTO model_learning_log(project, change, task_kind, task_size, from_tier, to_tier, tasks, clean_rate, changed_by, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project, change, cell?.kind ?? null, cell?.size ?? null, cell?.from ?? null, cell?.to ?? null, cell?.tasks ?? null, cell?.cleanRate ?? null, by, this.#now());
  }

  /**
   * Every run of the project's tasks that are done, finished (their last run) in the last 30 days, classified and not
   * high risk: a high-risk task starts a tier up, so it says nothing of its cell. Classify runs are not a try of the task.
   */
  // Plans contribute to the task cost, but their tier and errors must not become implementation attempts.
  #learningRuns(project: string, quality = false): LearningRun[] {
    const since = new Date(this.#opts.now().getTime() - LEARN_DAYS * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT r.task_id, CASE WHEN json_extract(r.plan, '$.phase') = 'plan' THEN 'plan' ELSE r.role END AS role, r.status, r.verdict, r.tier, r.kind AS plan, r.created_at, json_extract(r.mr, '$.pipeline') AS pipeline,
           t.kind AS task_kind, t.size AS task_size, t.risk, t.status AS task_status, r.machine_id, r.profile_id, r.model, r.effort, r.started_at, r.finished_at, c.cost_usd, c.priced, c.input_tokens, c.cache_write_tokens, c.cache_read_tokens, c.output_tokens
         FROM run_records r
         JOIN tasks t ON t.id = r.task_id AND t.project = r.project
         LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id
         WHERE r.project = ?1 AND r.role != 'classify' ${quality ? '' : "AND t.status = 'done' AND t.kind IS NOT NULL AND t.size IS NOT NULL AND COALESCE(t.risk, 'normal') != 'high'"}
           AND (SELECT MAX(x.finished_at) FROM run_records x WHERE x.project = r.project AND x.task_id = r.task_id ${quality ? "AND x.role = 'implement' AND COALESCE(json_extract(x.plan, '$.phase'), '') != 'plan'" : ''}) >= ?2`,
      )
      .all(project, since) as Row[];
    return rows
      .filter((r) => quality || (LEARNED_KINDS as readonly string[]).includes(str(r.task_kind)))
      .map((r) => {
        const parts = [r.input_tokens, r.cache_write_tokens, r.cache_read_tokens, r.output_tokens].filter((v) => v != null).map(Number);
        return {
          taskId: str(r.task_id),
          risk: strOrNull(r.risk), taskStatus: str(r.task_status),
          machine: strOrNull(r.machine_id), profile: strOrNull(r.profile_id),
          model: strOrNull(r.model), effort: strOrNull(r.effort), pipeline: strOrNull(r.pipeline),
          startedAt: strOrNull(r.started_at), finishedAt: strOrNull(r.finished_at),
          taskKind: str(r.task_kind) as TaskKind,
          taskSize: str(r.task_size) as TaskSize,
          role: str(r.role),
          status: str(r.status),
          verdict: strOrNull(r.verdict),
          tier: strOrNull(r.tier),
          plan: strOrNull(r.plan),
          pipelineFailed: r.pipeline === "failed",
          createdAt: str(r.created_at),
          tokens: parts.length ? parts.reduce((a, b) => a + b, 0) : null,
          // A run with no price is kept at 0 (priced 0): it is unknown, not free.
          costUsd: r.cost_usd == null || num(r.priced) !== 1 ? null : Number(r.cost_usd),
        };
      });
  }

  #learningView(project: string): ModelLearningView {
    const router = this.#modelRouter();
    const own = router.projects[project];
    const profile = own?.profile ?? "balanced";
    const stats = learningStats(learnedTasks(this.#learningRuns(project)));
    const locked = this.#lockedCells(project);
    const cells: ModelLearningCell[] = LEARNED_KINDS.flatMap((kind) =>
      TASK_SIZES.map((size) => {
        const current = own?.cells[kind]?.[size] ?? router.cells[kind]?.[size] ?? DEFAULT_MODEL_CELLS[kind][size];
        return { kind, size, current, locked: locked.has(`${kind}/${size}`), proposal: proposeTier(stats, kind, size, current, profile) };
      }),
    );
    const at = this.db.prepare("SELECT value FROM hive_meta WHERE key = 'model_learning_at'").get() as Row | undefined;
    const log = (this.db.prepare("SELECT * FROM model_learning_log WHERE project = ? ORDER BY id DESC LIMIT 100").all(project) as Row[]).map((r) => ({
      id: num(r.id),
      change: str(r.change) as LearningChange,
      kind: strOrNull(r.task_kind) as TaskKind | null,
      size: strOrNull(r.task_size) as TaskSize | null,
      fromTier: strOrNull(r.from_tier) as ModelTier | null,
      toTier: strOrNull(r.to_tier) as ModelTier | null,
      tasks: numOrNull(r.tasks),
      cleanRate: numOrNull(r.clean_rate),
      by: str(r.changed_by),
      at: str(r.at),
    }));
    return { project, enabled: this.#learningOn(project), routing: own?.enabled !== false, learnedAt: at ? str(at.value) : null, stats, quality: qualityStats(this.#learningRuns(project, true)), cells, log };
  }

  /**
   * The nightly round (54d): every unlocked cell of a project that learns takes its proposal, and the log says so. The
   * hub calls this every minute; it does the work once a night (learningDue). force: now, whatever the time (tests).
   * Returns the cells it changed.
   */
  learnModels(force = false): number {
    return this.#tx(() => {
      const at = this.db.prepare("SELECT value FROM hive_meta WHERE key = 'model_learning_at'").get() as Row | undefined;
      if (!force && !learningDue(at ? str(at.value) : null, this.#opts.now())) return 0;
      this.db.prepare("INSERT INTO hive_meta(key, value) VALUES ('model_learning_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(this.#now());
      let changed = 0;
      for (const project of this.#projectNames()) {
        // Routing off: its runs carry no tier, and a cell set now would surprise whoever turns it back on.
        if (this.#modelRouter().projects[project]?.enabled === false || !this.#learningOn(project) || this.#projectState(project) !== null) continue;
        for (const cell of this.#learningView(project).cells) {
          if (cell.locked || !cell.proposal) continue;
          this.#setModelCell(project, cell.kind, cell.size, cell.proposal.tier);
          this.#logLearning(project, "auto", "hub", { kind: cell.kind, size: cell.size, from: cell.current, to: cell.proposal.tier, tasks: cell.proposal.tasks, cleanRate: cell.proposal.cleanRate });
          changed++;
        }
      }
      return changed;
    });
  }

  #sdlcPolicy(): SdlcPolicySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'sdlcPolicy'").get() as Row | undefined;
    const stored = row ? { ...EMPTY_SDLC_POLICY, ...(JSON.parse(str(row.value)) as Partial<SdlcPolicySettings>) } : EMPTY_SDLC_POLICY;
    const legacyRow = this.db.prepare("SELECT value FROM hive_meta WHERE key = 'sdlc_legacy_projects'").get() as Row | undefined;
    if (!legacyRow) return stored;
    const legacy = new Set(JSON.parse(str(legacyRow.value)) as string[]);
    const projects = { ...stored.projects };
    for (const project of this.#projectNames()) {
      if (!legacy.has(project) && !projects[project]) projects[project] = { gates: MAX_AUTOMATION_GATES };
    }
    return { ...stored, projects };
  }

  #saveSdlc(policy: SdlcPolicySettings, actor: Actor): void {
    const next: SdlcPolicySettings = { ...policy, updatedAt: this.#now(), updatedBy: actor.name };
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('sdlcPolicy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  }

  /** Every project with tasks shows, with what applies to it, even one that never changed a gate. */
  #sdlcView(): SdlcPolicyView {
    return sdlcPolicyView(this.#sdlcPolicy(), this.#projectNames());
  }

  #paused(): AgentsPaused {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'paused'").get() as Row | undefined;
    return row ? { hub: false, projects: [], by: {}, ...(JSON.parse(str(row.value)) as Partial<AgentsPaused>) } : { hub: false, projects: [], by: {} };
  }

  #savePaused(paused: AgentsPaused): void {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('paused', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(paused));
  }

  /** Only the projects the actor sees: a paused project's name must not tell an outsider it exists. */
  #pausedFor(paused: AgentsPaused, actor: Actor): AgentsPaused {
    const projects = paused.projects.filter((p) => sees(actor, p));
    const by = Object.fromEntries(Object.entries(paused.by).filter(([k]) => k === PAUSED_HUB || projects.includes(k)));
    return { hub: paused.hub, projects, by };
  }

  /** Refuses to start agents of a paused project or hub (runs.dispatch, chat.send). */
  #isPaused(project: string): boolean {
    const paused = this.#paused();
    return paused.hub || paused.projects.includes(project);
  }

  #assertNotPaused(project: string): void {
    const paused = this.#paused();
    const scope = paused.hub ? PAUSED_HUB : paused.projects.includes(project) ? project : null;
    if (scope === null) return;
    const mark = paused.by[scope];
    throw new HiveError("conflict", `Agents of ${scope === PAUSED_HUB ? "the hub" : project} are paused.`, {
      key: "errors.agentsPaused",
      vars: { project: scope === PAUSED_HUB ? "hub" : project, by: mark?.name ?? "?", at: mark?.at ?? "" },
    });
  }

  // ── archived and deleted projects (roadmap 47) ─────────────────────────────

  /** Project → its state; empty on a hub where nothing was ever archived, which is the usual case. */
  #projectStates(): Map<string, { state: ProjectState; at: string; by: string }> {
    return new Map(
      (this.db.prepare(`SELECT project, state, at, "by" FROM project_states`).all() as Row[]).map((r) => [
        str(r.project),
        { state: str(r.state) as ProjectState, at: str(r.at), by: str(r.by) },
      ]),
    );
  }

  #projectState(project: string): ProjectState | null {
    const row = this.db.prepare("SELECT state FROM project_states WHERE project = ?").get(project) as Row | undefined;
    return row ? (str(row.state) as ProjectState) : null;
  }

  #projectGone(project: string): HiveError {
    const state = this.#projectState(project);
    const key = state === "deleted" ? "errors.projectDeleted" : "errors.projectArchived";
    return new HiveError("conflict", `Project ${project} is ${state === "deleted" ? "deleted" : "archived"}.`, { key, vars: { project } });
  }

  /**
   * Refuses a write to an archived or deleted project. Reads stay open on purpose: a hub admin has to be able to look
   * through what is in the archive before restoring it or deciding to delete it.
   */
  #assertProjectOpen(method: Method, input: ParsedInput<Method>): void {
    if (["memory.cleanupRead", "memory.cleanupProgress", "memory.cleanupFinish", "memory.decideCleanup"].includes(method)) {
      const table = method === "memory.decideCleanup" ? "memory_cleanup_proposals" : "memory_cleanup_runs";
      const row = this.db.prepare(`SELECT project FROM ${table} WHERE id = ?`).get((input as { id: number }).id) as Row | undefined;
      if (row && this.#projectState(str(row.project)) !== null) throw this.#projectGone(str(row.project));
    }
    if (method === "research.finish") {
      const research = this.#research((input as { id: number }).id);
      for (const p of research.projects) if (this.#projectState(p)) throw this.#projectGone(p);
    }
    if (method === "runs.decidePlan") {
      const row = this.db.prepare("SELECT project FROM implementation_plans WHERE id = ?").get((input as { id: number }).id) as Row | undefined;
      if (row && this.#projectState(str(row.project))) throw this.#projectGone(str(row.project));
    }
    const where = PROJECT_WRITES[method];
    if (!where) return;
    const i = input as Record<string, any>;
    const rowProject = (sql: string, key: unknown): string | null =>
      key == null ? null : strOrNull((this.db.prepare(sql).get(key as string) as Row | undefined)?.project);
    const keys: Array<string | null> = [];
    if (where === "project") keys.push(typeof i.project === "string" ? i.project : null);
    else if (where === "task") keys.push(rowProject("SELECT project FROM tasks WHERE id = ?", i.id ?? i.taskId));
    else if (where === "thread") keys.push(rowProject("SELECT project FROM chat_threads WHERE id = ?", i.threadId));
    else if (where === "proposal") keys.push(rowProject("SELECT doc_key AS project FROM proposals WHERE id = ?", i.id));
    // A page moved is a write where it comes from and where it lands.
    else for (const k of [i.key ?? i.docKey, i.parent]) if (typeof k === "string") keys.push(k);
    for (const key of keys) {
      if (key === null) continue;
      const project = where === "doc" || where === "proposal" ? SqliteHive.#docOwner(key) : key;
      if (project !== null && this.#projectState(project) !== null) throw this.#projectGone(project);
    }
  }

  /**
   * Lists leave out archived and deleted projects, so they disappear from the scope picker, the boards, the runs and
   * the chat without every page having to know about them. Asking for that project by name still works, which is how
   * a hub admin looks at what the archive holds before restoring or deleting it.
   */
  #hideArchived<M extends Method>(method: M, input: ParsedInput<Method>, output: MethodOutput[M]): MethodOutput[M] {
    const hidden = new Set(this.#projectStates().keys());
    if (!hidden.size) return output;
    const asked = (input as Record<string, unknown>).project;
    // Asked for by name: the caller already knows it and wants what is in it.
    if (typeof asked === "string" && hidden.has(asked)) return output;
    const shown = (project: string | null | undefined) => !(project != null && hidden.has(project));
    const out = output as unknown;
    switch (method as Method) {
      case "docs.list":
      case "docs.removed":
        return (out as DocSummary[]).filter((d) => shown(d.project)) as MethodOutput[M];
      case "projects.retired":
        return (out as RetiredProject[]).filter((r) => shown(r.project)) as MethodOutput[M];
      case "skills.list":
        return (out as SkillSummary[]).filter((s) => shown(s.project)) as MethodOutput[M];
      case "memory.search":
      case "memory.list":
        return (out as Memory[]).filter((m) => shown(m.project)) as MethodOutput[M];
      case "memory.cleanupSettings":
      case "memory.cleanupRuns":
      case "memory.cleanupProposals":
        return (out as Array<{ project: string }>).filter((m) => shown(m.project)) as MethodOutput[M];
      case "tasks.list":
      case "tasks.next":
        return (out as Task[]).filter((t) => shown(t.project)) as MethodOutput[M];
      case "tasks.agentQueue":
        return (out as TaskAgentQueueItem[]).filter((q) => shown(q.task.project)) as MethodOutput[M];
      case "specs.list":
        return (out as SpecFeature[]).filter((f) => shown(f.project)) as MethodOutput[M];
      case "runs.plans":
        return (out as ImplementationPlan[]).filter((r) => shown(r.project)) as MethodOutput[M];
      case "runs.list":
        return (out as RunRecord[]).filter((r) => shown(r.project)) as MethodOutput[M];
      case "runs.requests":
        return (out as RunRequest[]).filter((r) => shown(r.project)) as MethodOutput[M];
      case "runs.groups":
        return (out as RunGroup[]).filter((g) => shown(g.project)) as MethodOutput[M];
      case "chat.threads":
        return (out as ChatThread[]).filter((t) => shown(t.project)) as MethodOutput[M];
      case "chat.pending":
        return (out as ChatAction[]).filter((a) => shown(a.project)) as MethodOutput[M];
      case "proposals.list":
        return (out as Proposal[]).filter((p) => shown(SqliteHive.#docOwner(p.docKey))) as MethodOutput[M];
      case "sdlc.gates":
        return (out as SdlcGateRecord[]).filter((g) => shown(g.project)) as MethodOutput[M];
      case "sdlc.flows":
        return (out as SdlcFlow[]).filter((f) => shown(f.project)) as MethodOutput[M];
      case "sdlc.flowTasks":
        return (out as SdlcFlowTask[]).filter((f) => shown(f.project)) as MethodOutput[M];
      // A machine stays in the list; only what it says about a hidden project goes.
      case "machines.list":
        return (out as Machine[]).map((m) => ({ ...m, runs: m.runs.filter((r) => shown(r.project)), projects: m.projects.filter(shown) })) as MethodOutput[M];
      // A system keeps its name even when every service of it was archived: its own docs and memory are still there.
      case "systems.list":
        return (out as HiveSystem[]).map((s) => ({ ...s, projects: s.projects.filter(shown) })) as MethodOutput[M];
      default:
        return output;
    }
  }

  #setProjectState(project: string, state: ProjectState, by: string): void {
    this.db
      .prepare(
        `INSERT INTO project_states(project, state, at, "by") VALUES (?, ?, ?, ?)
         ON CONFLICT(project) DO UPDATE SET state = excluded.state, at = excluded.at, "by" = excluded."by"`,
      )
      .run(project, state, this.#now(), by);
  }

  /** Every project name the hub knows: from its data, from what machines report, and from the states themselves. */
  #projectNames(): string[] {
    const names = new Set<string>();
    // A system's own docs and memory sit under sys:<name> (roadmap 19c), which is not a project.
    const add = (v: unknown) => {
      if (typeof v === "string" && PROJECT_NAME.test(v)) names.add(v);
    };
    for (const table of ["tasks", "docs", "memory", "run_records", "run_requests", "chat_threads", "chat_defaults", "tool_projects", "project_states", "artifacts"]) {
      for (const r of this.db.prepare(`SELECT DISTINCT project FROM ${table}`).all() as Row[]) add(r.project);
    }
    for (const table of ["machines", "systems"]) {
      for (const r of this.db.prepare(`SELECT projects FROM ${table}`).all() as Row[]) for (const p of JSON.parse(str(r.projects ?? "[]")) as string[]) add(p);
    }
    return [...names].sort();
  }

  #projectSummary(project: string, states = this.#projectStates()): ProjectSummary {
    const count = (sql: string) => num((this.db.prepare(sql).get(project) as Row).n);
    const state = states.get(project);
    return {
      project,
      state: state?.state ?? null,
      stateAt: state?.at ?? null,
      stateBy: state?.by ?? null,
      openTasks: count("SELECT COUNT(*) AS n FROM tasks WHERE project = ? AND status != 'done'"),
      tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE project = ?"),
      docs: count("SELECT COUNT(*) AS n FROM docs WHERE project = ?"),
      memory: count("SELECT COUNT(*) AS n FROM memory WHERE project = ?"),
      runs: count("SELECT COUNT(*) AS n FROM run_records WHERE project = ?"),
      machines: this.#machinesWith(project).map((m) => m.machine),
      systems: this.#systemList().filter((s) => s.projects.includes(project)).map((s) => s.name).sort(),
    };
  }

  #hasTable(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  /**
   * Tables with a `project` column, read from the schema instead of a list kept by hand: a table added by a later
   * migration (or by the hub's own stores, such as hub_grants) is cleared out too, without anyone remembering to.
   * project_states is left out — the headstone is the one row a deletion leaves behind.
   */
  #projectTables(): string[] {
    const names = (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Row[]).map((r) => str(r.name));
    return names
      .filter((t) => t !== "project_states")
      .filter((t) => (this.db.prepare(`PRAGMA table_info("${t}")`).all() as Row[]).some((c) => str(c.name) === "project"));
  }

  /**
   * Everything of a project, in one transaction: the rows that hang off a doc key or a task id, then every table with
   * a project column, then the JSON lists and settings that only name it. Returns the rows deleted per table and the
   * doc files to take out of the store afterwards (the store is not part of the transaction).
   */
  #deleteProject(project: string, by: string): { rows: Record<string, number>; files: string[] } {
    const db = this.db;
    const rows: Record<string, number> = {};
    const count = (table: string, n: number) => {
      if (n) rows[table] = (rows[table] ?? 0) + n;
    };
    const run = (table: string, sql: string, ...args: unknown[]) => count(table, Number(db.prepare(sql).run(...(args as never[])).changes));
    const holes = (ids: string[]) => ids.map(() => "?").join(", ");

    // Read before anything goes: these rows are found by a doc key or a task id, which the deletes below take away.
    const docKeys = (db.prepare("SELECT key FROM docs WHERE project = ?").all(project) as Row[]).map((r) => str(r.key));
    const taskIds = (db.prepare("SELECT id FROM tasks WHERE project = ?").all(project) as Row[]).map((r) => str(r.id));
    // Only the files a store holds: without one the bytes are in the row, and go with it.
    const files = docKeys.length
      ? (
          db
            .prepare(`SELECT DISTINCT sha256 FROM doc_assets WHERE stored IS NOT NULL AND sha256 IS NOT NULL AND doc_key IN (${holes(docKeys)})`)
            .all(...docKeys) as Row[]
        ).map((r) => str(r.sha256))
      : [];
    files.push(...(db.prepare("SELECT DISTINCT sha256 FROM artifacts WHERE project = ? AND stored IS NOT NULL").all(project) as Row[]).map((r) => str(r.sha256)));

    for (const [table, column] of [["doc_versions", "key"], ["proposals", "doc_key"], ["doc_assets", "doc_key"], ["doc_assists", "doc_key"]] as const) {
      if (docKeys.length) run(table, `DELETE FROM ${table} WHERE ${column} IN (${holes(docKeys)})`, ...docKeys);
    }
    // Both ways round: a task of another project may be waiting on one of these (roadmap 19d cross-service deps).
    if (taskIds.length) run("task_deps", `DELETE FROM task_deps WHERE task_id IN (${holes(taskIds)}) OR depends_on IN (${holes(taskIds)})`, ...taskIds, ...taskIds);
    if (taskIds.length) run("task_classify_runs", `DELETE FROM task_classify_runs WHERE task_id IN (${holes(taskIds)})`, ...taskIds);
    // Items hang off their group by id, with no project column of their own and no cascade to carry them.
    run("run_group_items", "DELETE FROM run_group_items WHERE group_id IN (SELECT id FROM run_groups WHERE project = ?)", project);
    run("merge_batch_items", "DELETE FROM merge_batch_items WHERE batch_id IN (SELECT id FROM merge_batches WHERE project = ?)", project);
    run("settings", "DELETE FROM settings WHERE key = ?", `mergeQueue:${project}`);

    for (const table of this.#projectTables()) run(table, `DELETE FROM "${table}" WHERE project = ?`, project);

    // JSON lists of project names: no column scan can look inside them.
    for (const [table, key] of [["machines", "id"], ["systems", "name"], ["hub_webhooks", "id"]] as const) {
      if (!this.#hasTable(table)) continue;
      for (const r of db.prepare(`SELECT ${key} AS k, projects FROM ${table}`).all() as Row[]) {
        const list = JSON.parse(str(r.projects ?? "[]")) as string[];
        if (!list.includes(project)) continue;
        // A system keeps its name even with nothing left in it: its own docs and memory are not the project's.
        db.prepare(`UPDATE ${table} SET projects = ? WHERE ${key} = ?`).run(JSON.stringify(list.filter((p) => p !== project)), r.k as string);
        count(`${table}.projects`, 1);
      }
    }

    const setting = (key: string, drop: (value: any) => boolean) => {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
      if (!row) return;
      const value = JSON.parse(str(row.value)) as unknown;
      if (!drop(value)) return;
      db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(JSON.stringify(value), key);
      count(`settings.${key}`, 1);
    };
    const fromRecord = (rec: Record<string, unknown> | undefined) => {
      if (!rec || !(project in rec)) return false;
      delete rec[project];
      return true;
    };
    setting("policy", (v) => fromRecord(v.projects));
    setting("agentPolicy", (v) => fromRecord(v.projects));
    setting("sdlcPolicy", (v) => fromRecord(v.projects));
    setting("paused", (v) => {
      const paused = Array.isArray(v.projects) && v.projects.includes(project);
      if (paused) v.projects = (v.projects as string[]).filter((p) => p !== project);
      return fromRecord(v.by) || paused;
    });
    setting("budgets", (v) => {
      if (!Array.isArray(v)) return false;
      const left = (v as Budget[]).filter((b) => !(b.scope.kind === "project" && b.scope.project === project));
      if (left.length === v.length) return false;
      v.length = 0;
      v.push(...left);
      return true;
    });

    // The headstone, last: the name does not come back to life because a machine still reports the repo.
    this.#setProjectState(project, "deleted", by);
    return { rows, files };
  }

  #budgets(): Budget[] {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'budgets'").get() as Row | undefined;
    return row ? (JSON.parse(str(row.value)) as Budget[]) : [];
  }

  /** Each cap with what run_costs holds for it since its day or month began; runs: those that ended, with a cost. */
  #budgetUsage(): BudgetUsage[] {
    const now = this.#opts.now();
    return this.#budgets().map((b) => {
      const since = periodStart(b.period, now).toISOString();
      const s = b.scope;
      const r = this.db
        .prepare(
          `SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS runs FROM run_costs
           WHERE finished_at >= ?1 AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR requested_by = ?3)`,
        )
        .get(since, s.kind === "project" ? s.project : null, s.kind === "user" ? s.user : null) as Row;
      const used = { usd: Number(r.usd), runs: num(r.runs) };
      return { ...b, id: budgetId(b), since, used, ratio: budgetRatio(b, used) };
    });
  }

  /** Full caps binding a run of this project asked for by this person, the fullest first. */
  #fullBudgets(project: string, user: string): BudgetUsage[] {
    return this.#budgetUsage()
      .filter((u) => u.ratio >= 1 && budgetApplies(u, project, user))
      .sort((a, b) => b.ratio - a.ratio);
  }

  /**
   * What a heartbeat carries: every full cap on the hub or on a person (a machine may run requests of anyone), and
   * those of the projects the machine has and its token sees, as for the agent policy.
   */
  #budgetBlocks(actor: Actor): BudgetBlock[] {
    const row = this.db.prepare("SELECT projects FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    const has = new Set(row ? (JSON.parse(str(row.projects)) as string[]) : []);
    const owner = requesterOf(actor);
    const out: BudgetBlock[] = [];
    for (const u of this.#budgetUsage()) {
      if (u.ratio < 1) continue;
      const text = { key: "errors.budgetExceeded", vars: budgetVars(u) };
      const s = u.scope;
      if (s.kind === "hub") out.push({ hub: true, ...text });
      else if (s.kind === "user") out.push({ user: s.user, self: s.user === owner, ...text });
      else if (has.has(s.project) && sees(actor, s.project)) out.push({ project: s.project, ...text });
    }
    return out;
  }

  /** Pending commands nobody approved in time become expired; so do sync requests no machine took or finished. */
  #expireCommands(): void {
    this.db
      .prepare("UPDATE machine_commands SET status = 'expired', updated_at = ?1 WHERE kind = 'install' AND status = 'pending' AND requested_at < ?2")
      .run(this.#now(), this.#now(-COMMAND_TTL_HOURS * 60));
    // A running one too: the app quit during the sync and will never report it.
    this.db
      .prepare("UPDATE machine_commands SET status = 'expired', updated_at = ?1 WHERE kind = 'sync' AND status IN ('pending', 'running') AND updated_at < ?2")
      .run(this.#now(), this.#now(-SYNC_TTL_MINUTES));
  }

  /** Run requests no machine took in time expire; answered ones are dropped after a month. */
  /**
   * What the machine's Board would check first, so a manager hears at once instead of after a heartbeat: for
   * runs.dispatch, and for runs.prompt (roadmap 32b) before the task it creates exists (`task` null).
   */
  #assertDispatchable(
    r: { machineId: string; project: string; task: Task | null; role: AgentRole; profileId: string | null; candidates: number; instructions: string },
    actor: Actor,
  ): Machine {
    const { machineId, project, task, role, profileId, candidates, instructions } = r;
    const db = this.db;
    this.#expireRequests();
    this.#assertNotPaused(project);
    const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
    const m = this.#toMachine(row);
    const name = { machine: m.machine };
    if (task?.agent && task.agent.machineId !== m.id) {
      throw new HiveError("conflict", `Task ${task.id} is assigned to ${task.agent.machine}. Unassign it before dispatching to another machine.`, {
        key: "errors.dispatchAssignedElsewhere", vars: { id: task.id, machine: task.agent.machine },
      });
    }
    if (!m.online) throw new HiveError("conflict", `${m.machine} is offline.`, { key: "errors.machineOffline", vars: name });
    if (!m.acceptsRuns) throw new HiveError("bad_request", `${m.machine} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: name });
    if (!m.projects.includes(project)) {
      throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { ...name, project } });
    }
    if (task) {
      const taskId = task.id;
      if (task.status === "done") throw new HiveError("bad_request", `Task ${taskId} is done.`, { key: "errors.taskDone", vars: { id: taskId } });
      if (task.waitingOn.length) {
        throw new HiveError("conflict", `Task ${taskId} waits for ${task.waitingOn.join(", ")}.`, {
          key: "errors.taskWaiting",
          vars: { id: taskId, tasks: task.waitingOn.join(", ") },
        });
      }
    }
    if (profileId && !m.profiles.some((p) => p.id === profileId && p.enabled)) {
      throw new HiveError("bad_request", `${m.machine} has no enabled profile ${profileId}.`, { key: "errors.profileNotOnMachine", vars: { ...name, id: profileId } });
    }
    const pinnedKind = profileId ? m.profiles.find(p => p.id === profileId)?.kind : null;
    const allowedKinds = this.#sdlcPolicy().projects[project]?.allowedAgentKinds;
    if (pinnedKind && allowedKinds && !allowedKinds.includes(pinnedKind)) {
      throw new HiveError("bad_request", `Agent kind ${pinnedKind} is not allowed for ${project}.`, { key: "errors.agentKindPolicy", vars: { kind: pinnedKind, project } });
    }
    if (candidates > 1 && role !== "implement") throw new HiveError("bad_request", "Only implement runs have candidates.", { key: "errors.candidatesImplementOnly" });
    if (candidates > 1 && profileId) throw new HiveError("bad_request", "Candidates rotate profiles; do not pin one.", { key: "errors.candidatesPinned" });
    if (task) {
      const taskId = task.id;
      if (db.prepare("SELECT 1 FROM implementation_plans WHERE task_id = ? AND status IN ('planning', 'waiting')").get(taskId)) throw new HiveError("conflict", "Task waits for plan approval.", { key: "errors.planPending" });
      // One request at a time per task, and none while a machine runs it.
      const open = db.prepare("SELECT id, machine FROM run_requests WHERE project = ? AND task_id = ? AND status = 'pending'").get(project, taskId) as Row | undefined;
      if (open) {
        throw new HiveError("conflict", `Run request #${num(open.id)} for ${taskId} still waits for ${str(open.machine)}.`, {
          key: "errors.runRequestOpen",
          vars: { id: taskId, request: num(open.id), machine: str(open.machine) },
        });
      }
      for (const other of (db.prepare("SELECT * FROM machines").all() as Row[]).map((x) => this.#toMachine(x))) {
        const busy = other.online ? other.runs.find((x) => x.project === project && x.taskId === taskId) : undefined;
        if (busy) {
          throw new HiveError("conflict", `Task ${taskId} has run ${busy.runId} on ${other.machine}.`, {
            key: "errors.taskRunning",
            vars: { id: taskId, run: busy.runId, machine: other.machine },
          });
        }
      }
    }
    this.#assertBudget(project, actor);
    // The machine hands them to an agent as its prompt.
    assertNoHidden(instructions, "Instructions");
    assertNoSecret(instructions, "Instructions");
    return m;
  }

  /** The run would count for whoever asks (run_requests.requested_by, which the machine reports with its cost). */
  #assertBudget(project: string, actor: Actor): void {
    const full = this.#fullBudgets(project, actor.name)[0];
    if (!full) return;
    const vars = budgetVars(full);
    throw new HiveError("conflict", `Spending cap ${full.id} is reached: ${vars.used} of ${vars.limit} since ${vars.from}.`, {
      key: "errors.budgetExceeded",
      vars,
    });
  }

  /** A task waiting or running in a group that is not over: the group starts it, nobody else. */
  #assertNotInGroup(taskId: string): void {
    const rows = this.db
      .prepare(
        `SELECT g.id FROM run_group_items i JOIN run_groups g ON g.id = i.group_id
         WHERE i.task_id = ? AND g.closed_at IS NULL AND i.status IN ('held', 'sent')`,
      )
      .all(taskId) as Row[];
    for (const row of rows) {
      // Its run over, a task is free again while the rest of its group goes on: a fix run, a review, by hand.
      // A chain of roles has the task in each of its steps (roadmap 31d): it holds it until its last step ran.
      if (this.#group(num(row.id)).items.some((i) => i.taskId === taskId && (i.status === "held" || i.active))) {
        throw new HiveError("conflict", `Task ${taskId} is in run group #${num(row.id)}.`, { key: "errors.taskInGroup", vars: { id: taskId, group: num(row.id) } });
      }
    }
  }

  /** What a sent item's run did, as its machine pushed it; null before the machine took it or pushed it. */
  #groupRun(req: RunRequest | null): RunGroupRun | null {
    if (!req?.runId) return null;
    const r = this.db
      .prepare("SELECT machine_id, run_id, machine, status, profile_id, started_at, finished_at, cost_usd FROM run_records WHERE machine_id = ? AND run_id = ?")
      .get(req.machineId, req.runId) as Row | undefined;
    if (!r) return null;
    return {
      machineId: str(r.machine_id),
      runId: str(r.run_id),
      machine: str(r.machine),
      status: req.plan?.phase === "plan" ? (req.status === "cancelled" ? "cancelled" : this.#planActive(req.plan.id) ? "running" : str(r.status)) : str(r.status),
      profileId: strOrNull(r.profile_id),
      startedAt: strOrNull(r.started_at),
      finishedAt: strOrNull(r.finished_at),
      costUsd: r.cost_usd == null ? null : num(r.cost_usd),
    };
  }

  /**
   * A sent item still takes a place of its group: its request waits for the machine, or its run has not ended. A run
   * the machine took but has not pushed yet counts for 10 minutes, then the place is given back.
   */
  #itemActive(status: RunGroupItemStatus, req: RunRequest | null, run: RunGroupRun | null): boolean {
    if (status !== "sent" || !req) return false;
    if (req.status === "pending") return true;
    if (req.status !== "accepted") return false;
    if (req.plan?.phase === "plan" && this.#planActive(req.plan.id)) return true;
    if (run) return run.status === "queued" || run.status === "running";
    return req.updatedAt > this.#now(-GROUP_UNREPORTED_MINUTES);
  }

  #group(id: number): RunGroup {
    const g = this.db.prepare("SELECT * FROM run_groups WHERE id = ?").get(id) as Row | undefined;
    if (!g) throw new HiveError("not_found", `Run group #${id} not found.`, { key: "errors.runGroupNotFound", vars: { id } });
    const rows = this.db.prepare("SELECT * FROM run_group_items WHERE group_id = ? ORDER BY position").all(id) as Row[];
    const items = rows.map((r): RunGroupItem => {
      const task = this.#getTask(str(r.task_id));
      const req = r.request_id == null ? null : ((this.db.prepare("SELECT * FROM run_requests WHERE id = ?").get(num(r.request_id)) as Row | undefined) ?? null);
      const request = req ? toRunRequest(req) : null;
      const run = this.#groupRun(request);
      const status = str(r.status) as RunGroupItemStatus;
      return {
        id: num(r.id),
        position: num(r.position),
        taskId: str(r.task_id),
        taskTitle: task?.title ?? null,
        taskStatus: task?.status ?? null,
        role: str(r.role) as AgentRole,
        step: strOrNull(r.step) as RoleStep | null,
        machineId: strOrNull(r.machine_id),
        profileId: strOrNull(r.profile_id),
        preferKind: strOrNull(r.prefer_kind) as PreferKind | null,
        instructions: str(r.instructions),
        status,
        request,
        run,
        active: this.#itemActive(status, request, run),
        error: r.error ? (JSON.parse(str(r.error)) as RunRequestError) : null,
        updatedAt: str(r.updated_at),
      };
    });
    return {
      id,
      project: str(g.project),
      kind: str(g.kind) as RunGroupKind,
      title: str(g.title),
      maxParallel: g.max_parallel == null ? null : num(g.max_parallel),
      reviewAfter: num(g.review_after) === 1,
      instructions: str(g.instructions),
      parentTask: strOrNull(g.parent_task),
      winnerTask: strOrNull(g.winner_task),
      createdBy: str(g.created_by),
      createdAt: str(g.created_at),
      closedAt: strOrNull(g.closed_at),
      items,
      ...this.#mapFields(g),
    };
  }

  /** A map-reduce group's own fields (roadmap 31c); empty for the other kinds. */
  #mapFields(g: Row): Pick<RunGroup, "phase" | "parts" | "machineId" | "phaseRequest" | "phaseRun" | "phaseError"> {
    const phase = strOrNull(g.phase) as MapPhase | null;
    const req = g.phase_request == null ? null : ((this.db.prepare("SELECT * FROM run_requests WHERE id = ?").get(num(g.phase_request)) as Row | undefined) ?? null);
    const phaseRequest = req ? toRunRequest(req) : null;
    let parts = JSON.parse(str(g.parts ?? "[]")) as string[];
    // A run can arrive before its handoff: keep reading the latest plan until the person confirms the parts.
    if (phase === "ready" && g.parent_task) parts = this.#splitParts(str(g.parent_task), str(g.instructions));
    return {
      phase,
      parts,
      machineId: strOrNull(g.machine_id),
      phaseRequest,
      phaseRun: this.#groupRun(phaseRequest),
      phaseError: g.phase_error ? (JSON.parse(str(g.phase_error)) as RunRequestError) : null,
    };
  }

  /** The original job can have bullets too; only the split run's new handoff proposes parts. */
  #splitParts(taskId: string, prompt: string): string[] {
    const note = this.#getTask(taskId)?.note;
    return note === prompt.slice(0, 2000) ? [] : parseParts(note);
  }

  /**
   * The machine with the most free places for a project's run now, for an item of a group that left the machine to
   * the hub (roadmap 31a). A place: one of maxConcurrent (1 when the app does not say) of a profile that could start a
   * run now (on, installed, not known signed out, under its stop threshold, not resting, the pinned one if any), less
   * the runs it has on those profiles and the requests sent to the machine it has not answered.
   */
  #freeMachine(project: string, profileId: string | null): string | null {
    const waiting = this.#waitingRequests();
    let best: { id: string; machine: string; free: number } | null = null;
    for (const m of (this.db.prepare("SELECT * FROM machines").all() as Row[]).map((r) => this.#toMachine(r))) {
      const free = this.#freePlaces(m, project, profileId, waiting);
      if (free > 0 && (!best || free > best.free || (free === best.free && m.machine < best.machine))) best = { id: m.id, machine: m.machine, free };
    }
    return best?.id ?? null;
  }

  /** Requests sent to each machine that it has not answered yet: every one of them is a place already spoken for. */
  #waitingRequests(): Map<string, number> {
    return new Map(
      (this.db.prepare("SELECT machine_id, COUNT(*) AS n FROM run_requests WHERE status = 'pending' GROUP BY machine_id").all() as Row[]).map((r) => [
        str(r.machine_id),
        num(r.n),
      ]),
    );
  }

  /** Free places of one machine for a project's run now, by the rule above; 0 when it could not take the run at all. */
  #freePlaces(m: Machine, project: string, profileId: string | null, waiting: Map<string, number>): number {
    if (!m.online || !m.acceptsRuns || m.duplicate || !m.projects.includes(project)) return 0;
    const now = this.#now();
    const usable = m.profiles.filter(
      (p) =>
        p.enabled &&
        p.installed &&
        p.loggedIn !== false &&
        !p.overLimit &&
        !(p.cooldownUntil && p.cooldownUntil > now) &&
        (profileId === null || p.id === profileId),
    );
    if (!usable.length) return 0;
    const ids = new Set(usable.map((p) => p.id));
    const places = usable.reduce((n, p) => n + (p.maxConcurrent ?? 1), 0);
    // A queued run with no profile yet may take any of them.
    const busy = m.runs.filter((r) => r.profileId === null || ids.has(r.profileId)).length;
    // A pinned request only reserves its own plan; an unpinned one may take any plan.
    const pending = profileId === null ? (waiting.get(m.id) ?? 0) : num((this.db.prepare(
      "SELECT COUNT(*) AS n FROM run_requests WHERE machine_id = ? AND status = 'pending' AND (profile_id IS NULL OR profile_id = ?)",
    ).get(m.id, profileId) as Row).n);
    return places - busy - pending;
  }

  /**
   * Sends what open groups may start now (roadmap 31a), in their order: an item waits while its group has maxParallel
   * items going, while its task waits for others, or while no machine is free for it. A check that may pass later
   * (machine offline, cap reached, project paused) keeps it waiting; one that will not (task done, machine without the
   * repo) fails it. A group with nothing left to release or going is over.
   */
  #releaseGroups(): void {
    const db = this.db;
    const groups = db.prepare("SELECT id FROM run_groups WHERE closed_at IS NULL ORDER BY id").all() as Row[];
    for (const { id } of groups) {
      const g = this.#group(num(id));
      let active = g.items.filter((i) => i.active).length;
      // Whoever made the group: its runs count for them (budgets, run_requests.requested_by).
      const onBehalf = this.#groupOnBehalf(g.id);
      const actor: Actor = { name: g.createdBy, role: "member", ...(onBehalf ? { onBehalf } : {}) };
      // A map-reduce group splits, waits for a person or merges outside its items (roadmap 31c).
      if (g.kind === "mapreduce" && g.phase !== "map") {
        this.#mapStep(g, actor);
        continue;
      }
      // A chain of roles goes one step at a time, and only on from a step that succeeded (roadmap 31d).
      if (g.kind === "roles") {
        this.#rolesStep(g, actor);
        continue;
      }
      for (const item of g.items) {
        if (item.status !== "held") continue;
        if (g.maxParallel !== null && active >= g.maxParallel) break;
        if (this.#releaseItem(g, item, actor) === "sent") active++;
      }
      const after = this.#group(g.id);
      if (after.kind === "mapreduce") this.#mapStep(after, actor);
      else if (!after.items.some((i) => i.status === "held" || i.active)) db.prepare("UPDATE run_groups SET closed_at = ? WHERE id = ?").run(this.#now(), g.id);
    }
  }

  /**
   * Sends one held item as a run request: "wait" when it cannot go yet (its task waits, no machine is free, a check
   * that may pass later), "failed" when it never will (the item is failed with the reason).
   */
  #releaseItem(g: RunGroup, item: RunGroupItem, actor: Actor): "sent" | "wait" | "failed" {
    const db = this.db;
    const now = this.#now();
    const task = this.#getTask(item.taskId);
    const fail = (error: RunRequestError) => {
      db.prepare("UPDATE run_group_items SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, item.id);
      return "failed" as const;
    };
    if (!task) return fail({ message: `Task ${item.taskId} not found.`, key: "errors.taskNotFound", vars: { id: item.taskId } });
    if (task.waitingOn.length) return "wait";
    // The group still decides when the task runs; a task with an agent (roadmap 50) only lends the item the machine
    // and plan to run it on, when the item names none of its own.
    const agent = item.machineId === null ? task.agent : null;
    const profileId = item.profileId ?? agent?.profileId ?? null;
    const machineId = item.machineId ?? agent?.machineId ?? this.#freeMachine(g.project, profileId);
    if (!machineId) return "wait";
    try {
      const instructions = [g.instructions, item.instructions].filter(Boolean).join("\n\n");
      // Its classify run (roadmap 54b) still going: the item waits. Asked before #assertDispatchable, which would
      // see that run as the task's and refuse.
      if (item.role === "implement" && db.prepare("SELECT 1 FROM task_classify_runs WHERE task_id = ?").get(task.id)) {
        if (this.#queueClassify(task, this.#machineByRef(machineId), actor)) return "wait";
      }
      const m = this.#assertDispatchable(
        { machineId, project: g.project, task, role: item.role, profileId, candidates: 1, instructions },
        actor,
      );
      if (item.role === "implement" && this.#queueClassify(task, m, actor)) return "wait";
      // A job reviews its merged result; a chain reviews in its own steps.
      const reviewAfter = (g.kind === "mapreduce" || g.kind === "roles") ? false : g.reviewAfter;
      const req = this.#insertRequest(m, g.project, task, { role: item.role, profileId, preferKind: item.preferKind, reviewAfter, candidates: 1, instructions }, actor);
      db.prepare("UPDATE run_group_items SET status = 'sent', machine_id = ?, request_id = ?, updated_at = ? WHERE id = ?").run(machineId, req.id, now, item.id);
      return "sent";
    } catch (err) {
      if (!(err instanceof HiveError)) throw err;
      if (!groupFails(err.key)) return "wait";
      return fail({ message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars as Record<string, string | number> } : {}) });
    }
  }

  /**
   * Moves a chain of roles on (roadmap 31d): its steps in order, the next one sent only once the run of the one before
   * it succeeded, all on the chain's machine so each finds the branch the others left. A step that failed, could not be
   * sent, or whose run its machine never reported stops the chain; the steps after it are cancelled.
   */
  #rolesStep(g: RunGroup, actor: Actor): void {
    const db = this.db;
    const now = this.#now();
    const stop = (item: RunGroupItem) => {
      db.prepare("UPDATE run_group_items SET status = 'cancelled', updated_at = ? WHERE group_id = ? AND status = 'held'").run(now, g.id);
      const error = { message: `Step ${item.position} (${item.step}) did not finish.`, key: "errors.rolesStepFailed", vars: { step: item.position, role: item.step ?? item.role } };
      db.prepare("UPDATE run_groups SET phase = 'stopped', phase_error = ?, closed_at = ? WHERE id = ?").run(JSON.stringify(error), now, g.id);
    };
    for (const item of g.items) {
      if (item.status === "held") {
        if (this.#releaseItem(g, item, actor) === "failed") stop(item);
        return;
      }
      if (item.active) return;
      if (item.run?.status !== "succeeded") return void stop(item);
    }
    db.prepare("UPDATE run_groups SET phase = 'done', closed_at = ? WHERE id = ?").run(now, g.id);
  }

  /**
   * Moves a map-reduce group on (roadmap 31c): the split run's list goes to a person to check; when every part ran, the
   * parts are done and a run on the job's task merges their branches, on their machine; the merge done, so is the group.
   * A part, the split or the merge that failed stops it until a person starts it again (runs.resumeGroup).
   */
  #mapStep(g: RunGroup, actor: Actor): void {
    const db = this.db;
    const now = this.#now();
    const stop = (error: RunRequestError) =>
      db.prepare("UPDATE run_groups SET phase = 'stopped', phase_error = ?, closed_at = ? WHERE id = ?").run(JSON.stringify(error), now, g.id);
    if (g.phase === "split" || g.phase === "reduce") {
      const req = g.phaseRequest;
      if (!req || req.status === "pending") return;
      if (req.status !== "accepted") return void stop({ message: `The machine did not take the run (${req.status}).`, key: "errors.mapRequestGone", vars: { status: req.status } });
      const run = g.phaseRun;
      if (!run) {
        if (req.updatedAt < this.#now(-GROUP_UNREPORTED_MINUTES)) stop({ message: "The machine took the run but never reported it.", key: "errors.mapRunGone" });
        return;
      }
      if (run.status === "queued" || run.status === "running") return;
      if (run.status !== "succeeded") return void stop({ message: `Run ${run.runId} ${run.status}.`, key: "errors.mapRunFailed", vars: { run: run.runId, status: run.status } });
      if (g.phase === "split") db.prepare("UPDATE run_groups SET phase = 'ready', parts = ? WHERE id = ?").run(JSON.stringify(this.#splitParts(g.parentTask!, g.instructions)), g.id);
      else db.prepare("UPDATE run_groups SET phase = 'done', closed_at = ? WHERE id = ?").run(now, g.id);
      return;
    }
    if (g.phase !== "map" || g.items.some((i) => i.status === "held" || i.active)) return;
    const unfinished = g.items.filter((i) => i.run?.status !== "succeeded").map((i) => i.taskId);
    if (unfinished.length) return void stop({ message: `Parts did not finish: ${unfinished.join(", ")}.`, key: "errors.mapPartsFailed", vars: { tasks: unfinished.join(", ") } });
    const parent = this.#getTask(g.parentTask!);
    if (!parent) return void stop({ message: `Task ${g.parentTask} not found.`, key: "errors.taskNotFound", vars: { id: g.parentTask! } });
    // Every part ran: their work goes on in the job's task, which stops waiting for them.
    const parts = g.items.map((i) => this.#getTask(i.taskId)).filter((t): t is Task => !!t);
    const close = db.prepare("UPDATE tasks SET status = 'done', owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status != 'done'");
    for (const t of parts) {
      close.run(now, t.id);
      if (t.status !== "done") this.#journalTask(t.id);
    }
    const task = this.#getTask(parent.id)!;
    const instructions = reduceInstructions(parent.id, parts.map((t) => ({ taskId: t.id, title: t.title, note: t.note })));
    // The job's own pin, as for any run of a pinned task.
    const reducePin = this.#pinnedProfile(task, g.machineId);
    try {
      const m = this.#assertDispatchable({ machineId: g.machineId!, project: g.project, task, role: "implement", profileId: reducePin, candidates: 1, instructions }, actor);
      const req = this.#insertRequest(m, g.project, task, { role: "implement", profileId: reducePin, reviewAfter: g.reviewAfter, candidates: 1, instructions }, actor);
      db.prepare("UPDATE run_groups SET phase = 'reduce', phase_request = ?, phase_error = NULL WHERE id = ?").run(req.id, g.id);
    } catch (err) {
      if (!(err instanceof HiveError)) throw err;
      // Offline, busy, paused, over budget: the next heartbeat tries again.
      if (groupFails(err.key)) stop({ message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars as Record<string, string | number> } : {}) });
    }
  }

  // ── agents with a queue of their own (roadmap 50) ──────────────────────────

  /**
   * Everything the hub may start by itself now, in this order: the items of the open run groups (roadmap 31a), then the
   * tasks each agent was given (roadmap 50). The groups first, so a task that is in one is started by its group alone.
   */
  #release(): void {
    this.#releaseClassifyDispatches();
    this.#releaseGroups();
    this.#releaseAssigned();
    this.#autoDispatch();
  }

  /** Count each live run once, including the gap between acceptance and the first push. */
  #projectOccupancy(project: string): number {
    const keys = new Set<string>();
    for (const row of this.db.prepare("SELECT * FROM machines").all() as Row[]) {
      const m = this.#toMachine(row);
      for (const r of m.runs) if (r.project === project) keys.add(`${m.id}/${r.runId}`);
    }
    const rows = this.db.prepare(`SELECT q.*, r.status AS run_status FROM run_requests q
      LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
      WHERE q.project = ? AND q.status IN ('pending', 'accepted')`).all(project) as Row[];
    for (const r of rows) {
      if (r.status === "pending" || r.run_status === "queued" || r.run_status === "running" ||
          (r.run_status == null && str(r.updated_at) > this.#now(-GROUP_UNREPORTED_MINUTES))) {
        keys.add(r.run_id == null ? `request/${r.id}` : `${r.machine_id}/${r.run_id}`);
      }
    }
    // A plan waiting for approval still reserves the task's project slot.
    const plans = this.db.prepare("SELECT machine_id, run_id, request_id FROM implementation_plans WHERE project = ? AND status IN ('planning', 'waiting')").all(project) as Row[];
    for (const r of plans) keys.add(r.run_id == null ? `request/${r.request_id}` : `${r.machine_id}/${r.run_id}`);
    return keys.size;
  }

  /** Retry selection must use the same routing and shared quota rules as the first assignment. */
  #autoProfileAllowed(task: Task, profile: ReportedProfile, machines: Machine[]): boolean {
    const own = this.#sdlcPolicy().projects[task.project];
    if (!(own?.allowedAgentKinds ?? DEFAULT_AGENT_KINDS).includes(profile.kind)) return false;
    if (needsPlanApproval(own?.planApproval, task.size) && (!profile.planApproval || !["claude", "codex"].includes(profile.kind))) return false;
    const selection = this.#selection(task.project, task, "implement");
    const model = selection?.models[profile.kind as keyof NonNullable<typeof selection>["models"]];
    // The runner resolves account-specific model versions within the chosen family (59c).
    if (selection && (!model || /fable/i.test(model.model))) return false;
    // Reports of one subscription share quota even when the retry moves to another machine.
    const account = profile.account?.trim();
    const latest = account ? machines.flatMap(machine => machine.profiles)
      .filter(other => other.kind === profile.kind && other.account?.trim() === account)
      .sort((a, b) => (b.usageCheckedAt ?? "").localeCompare(a.usageCheckedAt ?? ""))[0] : profile;
    return !latest?.overLimit;
  }

  /** Explicit opt-in: old automatic gates alone must never start a service's backlog. */
  #autoDispatch(): void {
    const policy = this.#sdlcPolicy();
    if (!Object.values(policy.projects).some((p) => p.autoDispatch)) return;
    const rows = this.db.prepare(`SELECT t.*,
      (SELECT COUNT(*) FROM task_deps d JOIN tasks o ON o.id = d.task_id
       WHERE d.depends_on = t.id AND o.status != 'done') AS unlocks
      FROM tasks t WHERE t.status = 'todo' AND t.agent_machine IS NULL
      ORDER BY t.priority, unlocks DESC, t.rowid`).all() as Row[];
    for (const task of this.#tasks(rows)) {
      const own = policy.projects[task.project];
      if (!own?.autoDispatch || !own.autoDispatchBy || this.#projectState(task.project) !== null) continue;
      if (own.maxParallel && this.#projectOccupancy(task.project) >= own.maxParallel) continue;
      const actor: Actor = { name: own.autoDispatchBy, role: "member" };
      const machines = (this.db.prepare("SELECT * FROM machines ORDER BY machine, id").all() as Row[]).map((r) => this.#toMachine(r));
      const waiting = this.#waitingRequests();
      const candidates = machines.flatMap((m) => {
        const free = (m.maxParallel ?? 1) - m.runs.length - (waiting.get(m.id) ?? 0) - this.#unreportedRequests(m);
        if (free <= 0) return [];
        return m.profiles.filter((p) => {
          return this.#freePlaces(m, task.project, p.id, waiting) - this.#unreportedRequests(m, p.id) > 0 && this.#autoProfileAllowed(task, p, machines);
        }).map((p) => ({ m, p, free }));
      }).sort((a, b) => (a.p.priority ?? 50) - (b.p.priority ?? 50) || b.free - a.free || a.m.id.localeCompare(b.m.id) || a.p.id.localeCompare(b.p.id));
      for (const { m, p } of candidates) {
        const preview: Task = { ...task, agent: { machineId: m.id, machine: m.machine, profileId: p.id, order: 0, by: actor.name, at: this.#now(), hold: null } };
        if (this.#agentWait(preview, m, 1)) continue;
        try {
          this.#assertDispatchable({ machineId: m.id, project: task.project, task, role: "implement", profileId: p.id, candidates: 1, instructions: "" }, actor);
          this.#assignTask({ id: task.id, machineId: m.id, profileId: p.id }, actor, true);
          this.audit(actor, "tasks.autoAssign", task.id, `${m.machine}/${p.id}`, { key: "audit.autoAssign", vars: { task: task.id, machine: m.machine, profile: p.id } });
          break;
        } catch (err) {
          if (!(err instanceof HiveError)) throw err;
          // A changed budget or unavailable runner is retried at the next heartbeat.
        }
      }
    }
  }

  /** The runs.dispatch calls that waited for their task's classify run (roadmap 54b), sent once it ended. */
  #releaseClassifyDispatches(): void {
    const drop = this.db.prepare("DELETE FROM task_classify_dispatches WHERE task_id = ?");
    for (const row of this.db.prepare("SELECT * FROM task_classify_dispatches").all() as Row[]) {
      const task = this.#getTask(str(row.task_id));
      if (!task || task.status === "done") {
        drop.run(str(row.task_id));
        continue;
      }
      const wanted = JSON.parse(str(row.request)) as ParsedInput<"runs.dispatch">;
      const actor: Actor = { name: str(row.requested_by), role: "member", ...(row.on_behalf ? { onBehalf: str(row.on_behalf) } : {}) };
      try {
        // Still no kind: the classify run is going, or it went quiet and #queueClassify gives the default now.
        // runs.dispatch may leave the machine to the hub (49e): pick it as runs.dispatch does.
        const { project, role, profileId, preferKind, reviewAfter, candidates, instructions, timeoutMinutes } = wanted;
        const machineId = wanted.machineId ?? task.agent?.machineId ?? this.#mapMachine(project, null, profileId).id;
        if (task.kind === null && this.#queueClassify(task, this.#machineByRef(machineId), actor)) continue;
        const fresh = this.#getTask(task.id)!;
        const machine = this.#assertDispatchable({ machineId, project, task: fresh, role, profileId, candidates, instructions }, actor);
        this.#dispatchDirect(machine, project, fresh, { role, profileId, preferKind, reviewAfter, candidates, instructions, timeoutMinutes, redispatch: this.#redispatch(wanted.redispatch, fresh) }, actor);
        drop.run(task.id);
      } catch (err) {
        if (!(err instanceof HiveError)) throw err;
        // Busy or offline right after the classify run: the next heartbeat tries again. One that will not pass is
        // dropped, as a group drops its item, rather than tried every thirty seconds.
        if (groupFails(err.key)) drop.run(task.id);
      }
    }
  }

  /**
   * The machines a call speaks for, or [] for a person: the runner's own token (its name is the machine's hub id), and
   * an agent run on a machine, which says so in its write source or profile.machine label. Bound rows require the
   * verified parent token, even when a source header or label supplies the machine name.
   */
  #callerMachines(actor: Actor): string[] {
    const owns = (r: Row) => r.token_id == null ? !actor.tokenId : actor.tokenId === r.token_id && (actor.account ?? null) === strOrNull(r.owner);
    const own = this.db.prepare("SELECT id, token_id, owner FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    if (own && owns(own)) return [str(own.id)];
    // Some CLI shims send only the profile.machine agent label, without x-hive-source.
    // Match the whole machine suffix; token/account names are not machine identities.
    const label = actor.agent ?? (actor.role === "agent" ? actor.name.split("@")[0] : undefined);
    const name = actor.source?.machine ?? (label?.includes(".") ? label.slice(label.lastIndexOf(".") + 1) : undefined);
    if (!name) return [];
    return (this.db.prepare("SELECT id, token_id, owner FROM machines WHERE machine = ?").all(name) as Row[]).filter(owns).map((r) => str(r.id));
  }

  /** A machine by hub id, or by the name people know it as (as a chat proposal names one). */
  #machineByRef(ref: string): Machine {
    const row = this.db.prepare("SELECT * FROM machines WHERE id = ? OR machine = ? ORDER BY last_seen DESC LIMIT 1").get(ref, ref) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No machine ${ref}.`, { key: "errors.machineNotFound", vars: { machine: ref } });
    return this.#toMachine(row);
  }

  /**
   * Gives each agent the next task of its own queue, as a group releases an item: the task has to be free (todo, held
   * by nobody, waiting for nothing, no run going, not in a group or a flow) and its machine has to have a place.
   * A check that may pass later (offline, busy, cap, pause) leaves the task waiting; one that will not (the machine
   * lost the repo, the plan is gone) writes a hold, so nobody watches the same refusal every thirty seconds.
   */
  #releaseAssigned(): void {
    const db = this.db;
    const rows = db
      .prepare("SELECT * FROM tasks WHERE agent_machine IS NOT NULL AND agent_hold IS NULL AND status = 'todo' ORDER BY agent_machine, agent_order, rowid")
      .all() as Row[];
    if (!rows.length) return;
    const waiting = this.#waitingRequests();
    const machines = new Map<string, Machine | null>();
    const machineOf = (id: string): Machine | null => {
      if (!machines.has(id)) {
        const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Row | undefined;
        machines.set(id, row ? this.#toMachine(row) : null);
      }
      return machines.get(id)!;
    };
    for (const originalTask of this.#tasks(rows)) {
      let task = originalTask;
      const retryRow = db.prepare("SELECT agent_retry_source FROM tasks WHERE id = ?").get(task.id) as Row;
      const source = retryRow.agent_retry_source ? JSON.parse(str(retryRow.agent_retry_source)) as NonNullable<ParsedInput<"runs.dispatch">["redispatch"]> : null;
      const fix = source && (source as { fix?: boolean }).fix ? (source as unknown as { instructions: string }) : null;
      if (source && !fix) {
        const own = this.#sdlcPolicy().projects[task.project];
        if (!own?.autoDispatch) continue;
        const prior = db.prepare("SELECT profile_id FROM run_records WHERE machine_id = ? AND run_id = ?").get(source.machineId, source.runId) as Row | undefined;
        const retryMachines = (db.prepare("SELECT * FROM machines ORDER BY machine, id").all() as Row[]).map(row => this.#toMachine(row));
        const choices = retryMachines.flatMap(machine => machine.profiles
          .filter(profile => profile.redispatch && this.#autoProfileAllowed(task, profile, retryMachines) && (machine.id !== source.machineId || profile.id !== prior?.profile_id) && this.#freePlaces(machine, task.project, profile.id, waiting) - this.#unreportedRequests(machine, profile.id) > 0)
          .map(profile => ({ machine, profile })))
          .sort((a, b) => (a.profile.priority ?? 50) - (b.profile.priority ?? 50));
        const choice = choices.find(({ machine, profile }) => {
          const preview = { ...task, agent: { ...task.agent!, machineId: machine.id, machine: machine.machine, profileId: profile.id } };
          return !this.#agentWait(preview, machine, 1);
        });
        if (!choice) continue;
        db.prepare("UPDATE tasks SET agent_machine = ?, agent_profile = ? WHERE id = ?").run(choice.machine.id, choice.profile.id, task.id);
        machines.set(choice.machine.id, choice.machine);
        task = this.#getTask(task.id)!;
      }
      const agent = task.agent!;
      const m = machineOf(agent.machineId);
      // Its classify run (roadmap 54b) still going: wait for it here, before #agentWait counts it as the task's run.
      if (m && db.prepare("SELECT 1 FROM task_classify_runs WHERE task_id = ?").get(task.id)) {
        if (this.#queueClassify(task, m, { name: agent.by, role: "member" })) continue;
      }
      // A machine the hub no longer has: no places to count, and #agentWait says so before it looks at them.
      const free = m ? this.#freePlaces(m, task.project, agent.profileId, waiting) - this.#unreportedRequests(m, agent.profileId) : 0;
      const why = this.#agentWait(task, m, free);
      if (why) {
        if (groupFails(why.key)) this.#holdAgent(task.id, why);
        continue;
      }
      // Whoever gave the agent the task: its runs count for them, in the budgets and in the log (as a group's do).
      const actor: Actor = { name: agent.by, role: "member" };
      try {
        const r = { machineId: agent.machineId, project: task.project, task, role: "implement" as AgentRole, profileId: agent.profileId, candidates: 1, instructions: "" };
        const machine = this.#assertDispatchable(r, actor);
        if (this.#queueClassify(task, machine, actor)) {
          waiting.set(agent.machineId, (waiting.get(agent.machineId) ?? 0) + 1);
          continue;
        }
        // The project's review gate decides the cross-review, as it does for the tasks a flow hands out (roadmap 34c).
        const reviewAfter = effectiveGates(this.#sdlcPolicy(), task.project).review !== "auto";
        const retry = fix ? null : source;
        const redispatch = retry ? this.#redispatch(retry, task) : null;
        const original = retry ? db.prepare("SELECT instructions FROM run_records WHERE machine_id = ? AND run_id = ?").get(retry.machineId, retry.runId) as Row | undefined : null;
        const req = this.#insertRequest(machine, task.project, task, { role: "implement", profileId: agent.profileId, reviewAfter, candidates: 1, instructions: fix ? fix.instructions : str(original?.instructions ?? ""), redispatch }, actor);
        // This turn's run: the task is not handed over again until a person assigns it afresh.
        db.prepare("UPDATE tasks SET agent_request = ?, agent_retry_source = NULL, agent_retries = agent_retries + ? WHERE id = ?").run(req.id, retry ? 1 : 0, task.id);
        if (retry && source) this.audit(actor, "tasks.autoAssign", task.id, `Retry ${source.runId}: ${machine.machine}/${agent.profileId}`, { key: "audit.autoAssign", vars: { task: task.id, machine: machine.machine, profile: agent.profileId ?? "" } });
        // The place it just took, so the next task of the same machine sees one fewer.
        waiting.set(agent.machineId, (waiting.get(agent.machineId) ?? 0) + 1);
      } catch (err) {
        if (!(err instanceof HiveError)) throw err;
        if (groupFails(err.key)) {
          this.#holdAgent(task.id, { message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars as Record<string, string | number> } : {}) });
        }
      }
    }
  }

  /**
   * Why the hub is not giving an assigned task to its agent right now, or null when it should go out. The release loop
   * and tasks.agentQueue ask the same question, so the queue a person reads says exactly what the hub is waiting for.
   */
  #agentWait(task: Task, m: Machine | null, free: number): RunRequestError | null {
    const agent = task.agent!;
    const id = task.id;
    if (agent.hold) return agent.hold;
    if (!m) return { message: `No machine ${agent.machineId}.`, key: "errors.machineNotFound", vars: { machine: agent.machineId } };
    if (task.status !== "todo") {
      return { message: `Task ${id} is ${task.status}.`, key: "errors.agentTaskBusy", vars: { id, status: task.status } };
    }
    const now = this.#now();
    if (task.owner !== null && task.leaseUntil !== null && task.leaseUntil > now) {
      return { message: `Task ${id} is held by ${task.owner}.`, key: "errors.taskHeld", vars: { id, owner: task.owner, until: task.leaseUntil } };
    }
    if (task.waitingOn.length) {
      const tasks = waitingLabelsFor(task);
      return { message: `Task ${id} waits for ${tasks}.`, key: "errors.taskWaiting", vars: { id, tasks } };
    }
    if (this.#projectState(task.project) !== null) {
      const state = this.#projectState(task.project);
      return { message: `Project ${task.project} is ${state}.`, key: state === "deleted" ? "errors.projectDeleted" : "errors.projectArchived", vars: { project: task.project } };
    }
    try {
      this.#assertNotPaused(task.project);
      // A group that is not over starts the task itself; the assignment then only says which machine and plan it uses.
      this.#assertNotInGroup(id);
    } catch (err) {
      if (!(err instanceof HiveError)) throw err;
      return { message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars as Record<string, string | number> } : {}) };
    }
    // So does a flow, by the same rule runs.dispatch goes by, and for as long as a flow's task is still on its way.
    const flow = this.#flowRow(id);
    const flowTask = this.#flowTaskRow(id);
    if ((flow && ["running", "check", "checking", "next"].includes(str(flow.state))) || (flowTask && !["done", "stopped"].includes(str(flowTask.stage)))) {
      return { message: `Task ${id} is in a flow that is going on.`, key: "errors.taskInFlow", vars: { id } };
    }
    // Any run of the task that is going, not only the one this turn queued: one started by hand on another machine
    // counts just as much, and #assertDispatchable would not see it until its machine pushes it.
    if (this.#taskRunOpen(task)) return { message: `Task ${id} has a run going.`, key: "errors.agentTaskBusy", vars: { id, status: "running" } };
    const turn = this.#agentTurn(task);
    if (turn === "going") return { message: `Task ${id} has a run going.`, key: "errors.agentTaskBusy", vars: { id, status: "running" } };
    // It already had its turn and nobody moved it on: a second one would only repeat the same run for ever.
    if (turn === "over") return { message: `The agent already ran task ${id} once.`, key: "errors.agentTurnOver", vars: { id } };
    const parallel = this.#sdlcPolicy().projects[task.project]?.maxParallel;
    if (parallel && this.#projectOccupancy(task.project) >= parallel) free = 0;
    if (m.maxParallel !== undefined && m.runs.length + (this.#waitingRequests().get(m.id) ?? 0) + this.#unreportedRequests(m) >= m.maxParallel) free = 0;
    if (free <= 0) return { message: `${m.machine} has no free place now.`, key: "errors.agentBusy", vars: { machine: m.machine } };
    return null;
  }

  /**
   * A run of the task some machine has taken and not finished, whoever asked for it: an accepted request whose run is
   * queued or running, or one it has not pushed a run for yet (for GROUP_UNREPORTED_MINUTES, as a group's item counts).
   * #assertDispatchable sees only pending requests and the runs a heartbeat listed, so without this a task already
   * running elsewhere — started by hand, by a flow, by an earlier assignment — would be handed out a second time.
   */
  #taskRunOpen(task: Task): boolean {
    if (this.db.prepare("SELECT 1 FROM implementation_plans WHERE task_id = ? AND status IN ('planning', 'waiting')").get(task.id)) return true;
    const rows = this.db
      .prepare(
        `SELECT q.updated_at, r.status AS run_status FROM run_requests q
         LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
         WHERE q.project = ? AND q.task_id = ? AND q.status = 'accepted'`,
      )
      .all(task.project, task.id) as Row[];
    const since = this.#now(-GROUP_UNREPORTED_MINUTES);
    return rows.some((r) => {
      const status = strOrNull(r.run_status);
      return status === null ? str(r.updated_at) > since : status === "queued" || status === "running";
    });
  }

  /**
   * What became of the run this turn queued (tasks.agent_request): "going" while the request waits or its run is on,
   * "over" once that run ended, whatever the agent then did with the task — a second run would only repeat it for ever.
   * null: no run this turn, or one the machine never took; a request it took but never pushed a run for counts as
   * going for GROUP_UNREPORTED_MINUTES, as a group's item does, and after that the run never happened.
   */
  #agentTurn(task: Task): "going" | "over" | null {
    const r = this.db
      .prepare(
        `SELECT q.status, q.updated_at, q.machine_id, q.run_id, r.status AS run_status, r.error AS run_error FROM run_requests q
         LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
         WHERE q.id = (SELECT agent_request FROM tasks WHERE id = ?)`,
      )
      .get(task.id) as Row | undefined;
    if (!r) return null;
    if (str(r.status) === "pending") return "going";
    if (str(r.status) !== "accepted") return null;
    // The runner takes a rate-limited run up again on another profile, as a new run whose parent_run is the last one:
    // the turn is that last attempt's, or a rate limit would free a turn whose next attempt went on and did the work.
    for (let n = 0; strOrNull(r.run_status) === "rate_limited" && n < 10; n++) {
      const next = this.db
        .prepare("SELECT run_id, status, error FROM run_records WHERE machine_id = ? AND parent_run = ? AND parent_machine_id IS NULL AND role = 'implement' ORDER BY created_at DESC LIMIT 1")
        .get(str(r.machine_id), str(r.run_id)) as Row | undefined;
      if (!next) break;
      Object.assign(r, { run_id: next.run_id, run_status: next.status, run_error: next.error });
    }
    const status = strOrNull(r.run_status);
    if (status === "queued" || status === "running") return "going";
    // A run cut short (rate limit, app closed) is not a turn the agent used; but a task that is cut short again and
    // again must still stop, or it would be handed out for ever.
    if (status !== null) return this.#runInterrupted(r) && this.#interruptedTurns(task) < MAX_INTERRUPTED_TURNS ? null : "over";
    return str(r.updated_at) > this.#now(-GROUP_UNREPORTED_MINUTES) ? "going" : null;
  }

  /** rate_limited, or a run the app marked failed because it closed under it (runNote.appClosed, in either language). */
  #runInterrupted(r: Row): boolean {
    const status = strOrNull(r.run_status);
    return status === "rate_limited" || (status === "failed" && APP_CLOSED_ERRORS.includes(strOrNull(r.run_error) ?? ""));
  }

  /** Runs of this assignment that were cut short. */
  #interruptedTurns(task: Task): number {
    return num((this.db.prepare(
      `SELECT COUNT(*) AS n FROM run_records WHERE project = ? AND task_id = ? AND role = 'implement' AND created_at >= ?
         AND (status = 'rate_limited' OR (status = 'failed' AND error IN (${APP_CLOSED_ERRORS.map(() => "?").join(", ")})))`,
    ).get(task.project, task.id, task.agent?.at ?? "", ...APP_CLOSED_ERRORS) as Row).n);
  }

  /**
   * A review of an assigned task asked for changes and the fix gate is not a person's: the task gets a new turn on the
   * machine that holds its branch (up to maxFixRounds), as a flow task's fix does. Without it the task sat in review
   * and #agentTurn refused it, since the agent had "already run it once".
   */
  #agentFixTurn(r: { runId: string; taskId: string; project: string; role: string; status: string; summary: string | null; verdict?: Verdict | null }, machineId: string): void {
    // The runner reads the full report; its pushed summary may end before the verdict line.
    if (r.role !== "review" || r.status !== "succeeded" || (r.verdict ?? parseVerdict(r.summary)) !== "changes") return;
    const row = this.db.prepare("SELECT t.*, q.run_id AS assigned_run, q.machine_id AS assigned_machine FROM tasks t LEFT JOIN run_requests q ON q.id = t.agent_request WHERE t.id = ? AND t.project = ?").get(r.taskId, r.project) as Row | undefined;
    if (!row || row.agent_machine == null || row.agent_hold != null || row.assigned_run == null || str(row.status) === "done") return;
    if (this.#flowRow(r.taskId) || this.#flowTaskRow(r.taskId)) return;
    if (effectiveGates(this.#sdlcPolicy(), r.project).fix === "human") return;
    const impl = this.db.prepare("SELECT status FROM run_records WHERE machine_id = ? AND run_id = ?").get(str(row.assigned_machine), str(row.assigned_run)) as Row | undefined;
    if (str(impl?.status ?? "") !== "succeeded") return;
    // Only a review of this turn's own run: a late report of an older review (an earlier round, another machine's run)
    // carries findings about code the agent has since changed, and would send it back to fix what is already fixed.
    const mine = this.db.prepare("SELECT parent_run, parent_machine_id FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, r.runId) as Row | undefined;
    if (!mine || mine.parent_run !== row.assigned_run || (mine.parent_machine_id ?? machineId) !== row.assigned_machine) return;
    const max = this.#sdlcPolicy().projects[r.project]?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
    // Each fix round is one more implement run after the first, so the rounds so far are those runs.
    const rounds = num((this.db.prepare("SELECT COUNT(*) AS n FROM run_records WHERE project = ? AND task_id = ? AND role = 'implement' AND status = 'succeeded' AND created_at >= ?").get(r.project, r.taskId, str(row.agent_at ?? "")) as Row).n) - 1;
    if (rounds >= max) return;
    const fix = { fix: true, instructions: fixInstructions({ runId: r.runId, profileId: null, summary: r.summary }, "") };
    this.db.prepare("UPDATE tasks SET status = 'todo', owner = NULL, lease_until = NULL, agent_machine = ?, agent_request = NULL, agent_retry_source = ?, updated_at = ? WHERE id = ?")
      .run(str(row.assigned_machine), JSON.stringify(fix), this.#now(), r.taskId);
  }

  /**
   * Places taken on a machine that #freeMachine's count of pending requests misses: one the machine has taken but whose
   * run it has not pushed yet. Without this an assignment goes out twice in the window between runs.requestResult and
   * the first push, when the task looks free to #assertDispatchable and the place looks free to #freePlaces.
   */
  #unreportedRequests(m: Machine, profileId: string | null = null): number {
    const have = new Set(m.runs.map((r) => r.runId));
    const rows = this.db
      .prepare(
        `SELECT q.run_id, q.profile_id, r.status AS run_status FROM run_requests q
         LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
         WHERE q.machine_id = ? AND q.status = 'accepted' AND q.updated_at > ?`,
      )
      .all(m.id, this.#now(-GROUP_UNREPORTED_MINUTES)) as Row[];
    return rows.filter((r) => {
      if (profileId !== null && r.profile_id != null && r.profile_id !== profileId) return false;
      const runId = strOrNull(r.run_id);
      // The heartbeat already counts it among the machine's runs.
      if (runId !== null && have.has(runId)) return false;
      const status = strOrNull(r.run_status);
      return status === null || status === "queued" || status === "running";
    }).length;
  }

  #holdAgent(taskId: string, why: RunRequestError): void {
    this.db.prepare("UPDATE tasks SET agent_hold = ?, updated_at = ? WHERE id = ? AND agent_machine IS NOT NULL").run(JSON.stringify(why), this.#now(), taskId);
  }

  /**
   * An automatic assignment may continue its recorded branch once on another plan. Holding manual failures and
   * blocking a second automatic failure prevents repeated dispatch of a broken task; cancellation always holds.
   */
  #agentRunEnded(r: { runId: string; taskId: string; project: string; role: string; status: string; error: string | null }, machineId?: string): void {
    if (r.role !== "implement" || r.status === "succeeded") return;
    const row = this.db.prepare("SELECT t.*, q.run_id AS assigned_run, q.machine_id AS assigned_machine FROM tasks t LEFT JOIN run_requests q ON q.id = t.agent_request WHERE t.id = ? AND t.project = ?").get(r.taskId, r.project) as Row | undefined;
    if (!row || row.agent_machine == null || row.agent_hold != null) return;
    // A delayed report from the first attempt must not stop or retry its replacement.
    if (machineId && (row.assigned_run !== r.runId || row.assigned_machine !== machineId)) return;
    const cut = r.status === "rate_limited" || (r.status === "failed" && APP_CLOSED_ERRORS.includes(r.error ?? ""));
    if (num(row.agent_auto) === 1 && this.#sdlcPolicy().projects[r.project]?.autoDispatch && ["failed", "rate_limited"].includes(r.status) && ["todo", "doing"].includes(str(row.status))) {
      if (num(row.agent_retries) === 0 && machineId) {
        const source = { machineId, runId: r.runId, continueBranch: true };
        try {
          this.#redispatch(source, this.#getTask(r.taskId)!);
          this.db.prepare("UPDATE tasks SET status = 'todo', owner = NULL, lease_until = NULL, agent_request = NULL, agent_retry_source = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(source), this.#now(), r.taskId);
          return;
        } catch (err) {
          if (!(err instanceof HiveError)) throw err;
          // Keep the existing hold when a runner cannot safely continue the task branch.
        }
      } else if (num(row.agent_retries) > 0 && !cut) {
        const note = `Automatic retry failed: ${r.runId}. ${r.error ?? r.status}`.slice(0, 2000);
        this.db.prepare("UPDATE tasks SET status = 'blocked', note = ?, owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(note, this.#now(), r.taskId);
        this.#keepNote(r.taskId, note, "blocked", { name: str(row.agent_by), role: "member" }, this.#now());
      }
    }
    // Cut short, not failed: the turn is free again (#agentTurn) and the task waits in its queue for the next place.
    // The run had claimed the task and #agentWait only hands out a todo one, so give it back: its lease may not run out
    // for a long while, or ever when the app that held it is gone.
    if (cut) {
      if (str(row.status) === "doing") this.db.prepare("UPDATE tasks SET status = 'todo', owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(this.#now(), r.taskId);
      return;
    }
    this.#holdAgent(
      r.taskId,
      r.status === "cancelled"
        ? { message: `Run ${r.runId} was cancelled.`, key: "errors.agentRunCancelled", vars: { run: r.runId } }
        : { message: r.error ?? `Run ${r.runId} ${r.status}.`, key: "errors.agentRunFailed", vars: { run: r.runId, error: clipDetail(r.error ?? r.status) } },
    );
  }

  /** Shared by manual assignment and the hub, inside their existing transaction. */
  #assignTask({ id, machineId, profileId, before }: ParsedInput<"tasks.assign">, actor: Actor, automatic = false): Task {
    const db = this.db;
    const task = this.#getTask(id);
    if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
    if (task.status === "done") throw new HiveError("bad_request", `Task ${id} is done.`, { key: "errors.taskDone", vars: { id } });
    const m = this.#machineByRef(machineId);
    const name = { machine: m.machine };
    // What the hub would need the moment it gives the task out: said now, not left to a hold nobody expected.
    if (!m.acceptsRuns) throw new HiveError("bad_request", `${m.machine} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: name });
    if (!m.projects.includes(task.project)) {
      throw new HiveError("bad_request", `${m.machine} has no repo for ${task.project}.`, { key: "errors.machineNoRepo", vars: { ...name, project: task.project } });
    }
    if (profileId && !m.profiles.some((p) => p.id === profileId && p.enabled)) {
      throw new HiveError("bad_request", `${m.machine} has no enabled profile ${profileId}.`, { key: "errors.profileNotOnMachine", vars: { ...name, id: profileId } });
    }
    const now = this.#now();
    db.prepare(
      `UPDATE tasks SET agent_machine = ?, agent_profile = ?, agent_order = ?, agent_by = ?, agent_at = ?,
         agent_request = NULL, agent_hold = NULL, updated_at = ? WHERE id = ?`,
    ).run(m.id, profileId, this.#agentOrder(task, m.id, before), principalOf(actor), now, now, id);
    db.prepare("UPDATE tasks SET agent_auto = ?, agent_retries = 0, agent_retry_source = NULL WHERE id = ?").run(automatic ? 1 : 0, id);
    // A fresh turn: it may start at once, whatever run the task had under the assignment before this one.
    this.#releaseAssigned();
    return this.#getTask(id)!;
  }

  /**
   * Where a task goes in its machine's queue. `before`: just in front of that task, halfway between it and the one
   * above — a drag moves one task and leaves every other order as it was. Left out: it keeps the place it has when it
   * is already that machine's (pressing *Chạy lại* must not send it to the back), else it goes last.
   */
  #agentOrder(task: Task, machineId: string, before: string | undefined): number {
    const db = this.db;
    if (before === undefined) {
      if (task.agent?.machineId === machineId) return task.agent.order;
      const top = db.prepare("SELECT MAX(agent_order) AS top FROM tasks WHERE agent_machine = ?").get(machineId) as Row;
      return top.top == null ? 1 : num(top.top) + 1;
    }
    const next = this.#getTask(before);
    if (!next || next.agent?.machineId !== machineId) {
      throw new HiveError("bad_request", `Task ${before} is not in that agent's queue.`, { key: "errors.agentBeforeOther", vars: { id: before } });
    }
    const above = db
      .prepare("SELECT MAX(agent_order) AS top FROM tasks WHERE agent_machine = ? AND id != ? AND agent_order < ?")
      .get(machineId, task.id, next.agent.order) as Row;
    return above.top == null ? next.agent.order - 1 : (num(above.top) + next.agent.order) / 2;
  }

  /** The machine a job runs on: the one asked for, which has the project's repo, or the one with the most free places now. */
  #mapMachine(project: string, machineId: string | null, profileId: string | null = null): Machine {
    const id = machineId ?? this.#freeMachine(project, profileId);
    if (!id) throw new HiveError("conflict", `No machine with ${project}'s repo is free now.`, { key: "errors.noFreeMachine", vars: { project } });
    const row = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `No machine ${id}.`, { key: "errors.machineNotFound", vars: { machine: id } });
    const m = this.#toMachine(row);
    if (!m.projects.includes(project)) throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { machine: m.machine, project } });
    return m;
  }

  #groupOnBehalf(id: number): string | null {
    return strOrNull((this.db.prepare("SELECT on_behalf FROM run_groups WHERE id = ?").get(id) as Row | undefined)?.on_behalf);
  }

  /** tasks.md of a feature into board tasks (roadmap 20c): from specs.importTasks, and when a flow's tasks gate passes. */
  #importSpecTasks(project: string, dir: string, branch: string, prefix: string | null, dryRun: boolean, actor: Actor) {
    const db = this.db;
    const row = db.prepare("SELECT * FROM spec_features WHERE project = ? AND dir = ? AND branch = ?").get(project, dir, branch) as Row | undefined;
    const tasksMd = row ? toSpecFeature(row).files.tasks : null;
    if (tasksMd === null) throw new HiveError("not_found", `${project} has no tasks.md for ${dir}.`, { key: "errors.specNoTasks", vars: { dir } });
    const plan = planSpecTasks(tasksMd, prefix ?? specTaskPrefix(dir));
    const todo = plan.tasks.filter((t) => !t.done);
    const exists = (id: string) => this.#getTask(id) !== null;
    const tasks = todo.map((t) => ({ ...t, exists: exists(t.id) }));
    // A task with that id in another project is not this feature's: refused rather than waited on.
    for (const t of tasks.filter((x) => x.exists)) {
      if (this.#getTask(t.id)!.project !== project) {
        throw new HiveError("conflict", `Task ${t.id} already exists in another project.`, { key: "errors.taskExists", vars: { id: t.id } });
      }
    }
    const created: string[] = [];
    if (!dryRun) {
      const note = (phase: string) => `Spec Kit · specs/${dir}/tasks.md${branch ? ` (${branch})` : ""} · ${phase}`;
      const fresh = tasks.filter((x) => !x.exists);
      // All first, then what they wait for: a line may name one further down ("depends on T020").
      for (const t of fresh) {
        const at = this.#now();
        db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(t.id, project, t.title, note(t.phase), at);
        this.#keepNote(t.id, note(t.phase), "todo", actor, at);
        // Work a spec planned, not a spec step: "Spec Kit" in the note would read as one.
        this.#applyTaskRule(t.id, { titleOnly: true });
        created.push(t.id);
      }
      for (const t of fresh) this.#setDeps(t.id, this.#checkDeps(t.id, project, t.dependsOn.filter((d) => exists(d)), actor));
      if (created.length) {
        this.audit(actor, "specs.importTasks", `${project}/${dir}`, `${created.length} task: ${created[0]} … ${created.at(-1)}`, {
          key: "audit.specImport",
          vars: { count: created.length, dir },
        });
      }
    }
    return { tasks, warnings: plan.warnings, created };
  }

  // ── flows through the gates (roadmap 34b) ─────────────────────────────────

  #flowRow(taskId: string): Row | null {
    return (this.db.prepare("SELECT * FROM sdlc_flows WHERE task_id = ?").get(taskId) as Row | undefined) ?? null;
  }

  #flow(taskId: string): SdlcFlow | null {
    const r = this.#flowRow(taskId);
    if (!r) return null;
    const machine = this.db.prepare("SELECT machine FROM machines WHERE id = ?").get(str(r.machine_id)) as Row | undefined;
    const gate = r.gate_id == null ? undefined : (this.db.prepare("SELECT * FROM sdlc_gates WHERE id = ?").get(num(r.gate_id)) as Row | undefined);
    return {
      taskId: str(r.task_id),
      project: str(r.project),
      dir: strOrNull(r.dir),
      step: str(r.step) as FlowStep,
      state: str(r.state) as FlowState,
      machineId: str(r.machine_id),
      machine: machine ? str(machine.machine) : str(r.machine_id),
      profileId: strOrNull(r.profile_id),
      gate: gate ? toGate(gate) : null,
      note: strOrNull(r.note),
      createdBy: str(r.created_by),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  /** Whoever started the flow: its runs are requested, and counted, as theirs. */
  #flowActor(r: Row): Actor {
    return { name: str(r.created_by), role: "member", ...(r.on_behalf ? { onBehalf: str(r.on_behalf) } : {}) };
  }

  #setFlow(taskId: string, fields: Partial<Record<"state" | "step" | "dir" | "request_id" | "gate_id" | "input" | "note" | "reached_at", string | number | null>>): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE sdlc_flows SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE task_id = ?`)
      .run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), this.#now(), taskId);
  }

  #addGate(flow: Row, gate: SdlcGate, mode: GateMode, status: GateStatus, subject: Record<string, unknown>, decided: { by: string; note?: string | null } | null): number {
    const now = this.#now();
    const res = this.db
      .prepare(
        `INSERT INTO sdlc_gates(project, task_id, gate, mode, status, subject, decided_by, note, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(str(flow.project), str(flow.task_id), gate, mode, status, JSON.stringify(subject), decided?.by ?? null, decided?.note ?? null, now, decided ? now : null);
    return num(res.lastInsertRowid);
  }

  /**
   * An enabled profile of another vendor than the one that did the step, for a gate's check: a review on the same
   * vendor would share its blind spots. null: the machine has none ready, it then picks as for any review.
   */
  #otherVendorProfile(machineId: string, did: string | null): string | null {
    const row = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    if (!row) return null;
    const profiles = this.#toMachine(row).profiles;
    const kind = profiles.find((p) => p.id === did)?.kind ?? null;
    const now = this.#now();
    const other = profiles
      .filter((p) => p.enabled && p.installed && p.loggedIn !== false && !p.overLimit && !(p.cooldownUntil && p.cooldownUntil > now) && p.kind !== kind)
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    return other[0]?.id ?? null;
  }

  /** A step's run ended on its machine: at its gate, the flow waits for a person, has it checked, or goes on. */
  #reachGate(flow: Row, run: { runId: string | null; profileId: string | null }): void {
    const taskId = str(flow.task_id);
    const step = str(flow.step) as Exclude<FlowStep, "dispatch">;
    const gate = STEP_GATE[step];
    const mode = effectiveGates(this.#sdlcPolicy(), str(flow.project))[gate];
    const subject = { step, dir: strOrNull(flow.dir), runId: run.runId, machineId: str(flow.machine_id) };
    if (mode === "auto") {
      this.#addGate(flow, gate, mode, "passed", subject, { by: "auto" });
      this.#passFlow(taskId);
      return;
    }
    if (mode === "ai") {
      // Queued by #releaseFlows: the machine may still list the step's run as going until its next heartbeat.
      const gateId = this.#addGate(flow, gate, mode, "checking", { ...subject, didProfile: run.profileId }, null);
      this.#setFlow(taskId, { state: "check", gate_id: gateId, reached_at: this.#now() });
      return;
    }
    const gateId = this.#addGate(flow, gate, mode, "waiting", subject, null);
    this.#setFlow(taskId, { state: "gate", gate_id: gateId, reached_at: this.#now() });
  }

  /**
   * The gate's check (mode "ai"): a review run on another vendor's profile, on the flow's machine and branch. A check
   * that cannot start for a reason that will not pass hands the gate to a person instead of stalling the flow.
   */
  #startCheck(flow: Row): void {
    const taskId = str(flow.task_id);
    const task = this.#getTask(taskId);
    const gateRow = flow.gate_id == null ? undefined : (this.db.prepare("SELECT * FROM sdlc_gates WHERE id = ?").get(num(flow.gate_id)) as Row | undefined);
    if (!task || !gateRow) {
      this.#setFlow(taskId, { state: "stopped", note: `Task ${taskId} or its gate is gone.` });
      return;
    }
    const subject = JSON.parse(str(gateRow.subject)) as { didProfile?: string | null };
    const profileId = this.#otherVendorProfile(str(flow.machine_id), subject.didProfile ?? null);
    const instructions = gateCheckInstructions(str(gateRow.gate) as SdlcGate, { dir: strOrNull(flow.dir) });
    const actor = this.#flowActor(flow);
    try {
      const m = this.#assertDispatchable({ machineId: str(flow.machine_id), project: str(flow.project), task, role: "review", profileId, candidates: 1, instructions }, actor);
      const req = this.#insertRequest(m, str(flow.project), task, { role: "review", profileId, reviewAfter: false, candidates: 1, instructions }, actor);
      this.#setFlow(taskId, { state: "checking", request_id: req.id });
    } catch (err) {
      if (!(err instanceof HiveError)) throw err;
      if (!groupFails(err.key)) return;
      this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', decided_by = 'auto', note = ?, decided_at = ? WHERE id = ?").run(`AI check could not start: ${err.message}`, this.#now(), num(flow.gate_id));
      this.#setFlow(taskId, { state: "gate" });
    }
  }

  /** The gate passed: the next step is queued as soon as it can be (#releaseFlows). */
  #passFlow(taskId: string): void {
    const flow = this.#flowRow(taskId)!;
    const step = str(flow.step) as Exclude<FlowStep, "dispatch">;
    this.#setFlow(taskId, { state: "next", step: NEXT_STEP[step], gate_id: null, input: "", reached_at: this.#now() });
  }

  /**
   * A run of the task ended on that machine (runs.push). Only the flow's own step or check counts: a run on another
   * machine, or of another role, is someone else's. rate_limited is not an end: the machine tries again on another
   * profile, under a new run.
   */
  #flowRunEnded(machineId: string, r: { runId: string; taskId: string; project: string; role: string; status: string; profileId: string | null; summary: string | null; error: string | null }): void {
    const flow = this.#flowRow(r.taskId);
    if (!flow || str(flow.project) !== r.project || str(flow.machine_id) !== machineId || r.status === "rate_limited") return;
    const req = flow.request_id == null ? null : (this.db.prepare("SELECT status FROM run_requests WHERE id = ?").get(num(flow.request_id)) as Row | undefined);
    if (!req || str(req.status) !== "accepted") return;
    const state = str(flow.state);
    if (state === "running" && r.role === "implement") {
      if (r.status === "succeeded") this.#reachGate(flow, r);
      else this.#setFlow(r.taskId, { state: "stopped", note: r.error ?? r.status });
      return;
    }
    if (state === "checking" && r.role === "review" && flow.gate_id != null) {
      const gateId = num(flow.gate_id);
      const now = this.#now();
      const report = r.summary ? r.summary.slice(0, 2000) : (r.error ?? r.status);
      if (r.status === "succeeded" && parseVerdict(r.summary) === "approve") {
        this.db.prepare("UPDATE sdlc_gates SET status = 'passed', decided_by = ?, note = ?, decided_at = ? WHERE id = ?").run(`run:${machineId}/${r.runId}`, report, now, gateId);
        this.#passFlow(r.taskId);
      } else {
        // Changes asked, a verdict it could not read, or a check that failed: a person decides, with the report.
        this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', decided_by = ?, note = ?, decided_at = ? WHERE id = ?").run(`run:${machineId}/${r.runId}`, report, now, gateId);
        this.#setFlow(r.taskId, { state: "gate" });
      }
    }
  }

  /** A flow's request that no machine will run (refused, expired, cancelled): the step stops, a check goes to a person. */
  #syncFlows(): void {
    const rows = this.db
      .prepare(
        `SELECT f.task_id, f.state, f.gate_id, r.status AS req_status, r.error AS req_error FROM sdlc_flows f JOIN run_requests r ON r.id = f.request_id
         WHERE f.state IN ('running', 'checking') AND r.status IN ('rejected', 'expired', 'cancelled')`,
      )
      .all() as Row[];
    for (const r of rows) {
      const why = r.req_error ? (JSON.parse(str(r.req_error)) as RunRequestError).message : str(r.req_status);
      if (str(r.state) === "running") this.#setFlow(str(r.task_id), { state: "stopped", note: why });
      else {
        if (r.gate_id != null) this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', note = ?, decided_at = ? WHERE id = ?").run(`AI check did not run: ${why}`, this.#now(), num(r.gate_id));
        this.#setFlow(str(r.task_id), { state: "gate" });
      }
    }
  }

  /**
   * Queues what flows may do next: the next Spec Kit step on the flow's machine, or the tasks.md import. A step waits
   * for the feature's folder (the machine pushes it after the specify run) and the import for a tasks.md pushed after
   * the tasks step; a machine offline or a cap reached keeps it waiting; a refusal that will not pass stops the flow.
   */
  #releaseFlows(): void {
    this.#syncFlows();
    this.#releaseTasks();
    const rows = this.db.prepare("SELECT * FROM sdlc_flows WHERE state IN ('next', 'check') ORDER BY updated_at").all() as Row[];
    for (const flow of rows) {
      const taskId = str(flow.task_id);
      const project = str(flow.project);
      if (str(flow.state) === "check") {
        this.#startCheck(flow);
        continue;
      }
      const branch = `ai/${taskId}`;
      let dir = strOrNull(flow.dir);
      if (!dir) {
        const dirs = this.db.prepare("SELECT dir FROM spec_features WHERE project = ? AND branch = ?").all(project, branch) as Row[];
        if (dirs.length !== 1) continue;
        dir = str(dirs[0]!.dir);
        this.#setFlow(taskId, { dir });
      }
      const step = str(flow.step) as FlowStep;
      const actor = this.#flowActor(flow);
      if (step === "import") {
        const f = this.db.prepare("SELECT * FROM spec_features WHERE project = ? AND dir = ? AND branch = ?").get(project, dir, branch) as Row | undefined;
        // The tasks.md the gate passed: pushed after the step's gate was reached, not an older one.
        if (!f || toSpecFeature(f).files.tasks === null || (flow.reached_at && str(f.pushed_at) < str(flow.reached_at))) continue;
        try {
          const out = this.#importSpecTasks(project, dir, branch, null, false, actor);
          const now = this.#now();
          const add = this.db.prepare(
            "INSERT OR IGNORE INTO sdlc_flow_tasks(task_id, flow_task, project, stage, created_by, on_behalf, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
          );
          for (const id of out.created) add.run(id, taskId, project, str(flow.created_by), strOrNull(flow.on_behalf), now);
          this.#setFlow(taskId, { note: `${out.created.length} task: ${out.created[0] ?? "—"} … ${out.created.at(-1) ?? "—"}` });
          // Whether they go to agents now is the dispatch gate's.
          this.#reachGate(this.#flowRow(taskId)!, { runId: null, profileId: null });
        } catch (err) {
          if (!(err instanceof HiveError)) throw err;
          this.#setFlow(taskId, { state: "stopped", note: err.message });
        }
        continue;
      }
      if (step === "dispatch") {
        this.#dispatchFlowTasks(this.#flowRow(taskId)!);
        continue;
      }
      // A Spec Kit step is a spec by rule: no classify run before it.
      this.#applyTaskRule(taskId, { specStep: step });
      const task = this.#getTask(taskId);
      if (!task) {
        this.#setFlow(taskId, { state: "stopped", note: `Task ${taskId} is gone.` });
        continue;
      }
      const specStep = step as SpecStep;
      const instructions = specStepInstructions(specStep, { dir, input: str(flow.input) });
      const profileId = strOrNull(flow.profile_id);
      try {
        const m = this.#assertDispatchable({ machineId: str(flow.machine_id), project, task, role: "implement", profileId, candidates: 1, instructions }, actor);
        const req = this.#insertRequest(m, project, task, { role: "implement", profileId, reviewAfter: false, candidates: 1, instructions }, actor);
        this.#setFlow(taskId, { state: "running", request_id: req.id, input: "", note: null });
      } catch (err) {
        if (!(err instanceof HiveError)) throw err;
        if (groupFails(err.key)) this.#setFlow(taskId, { state: "stopped", note: err.message });
      }
    }
  }

  // ── a flow's tasks on their way to main (roadmap 34c, 34d) ────────────────

  /** The dispatch gate passed: the flow's tasks become a run group, on free machines, at most maxParallel at a time. */
  #dispatchFlowTasks(flow: Row): void {
    const taskId = str(flow.task_id);
    const project = str(flow.project);
    const ids = (this.db.prepare("SELECT task_id FROM sdlc_flow_tasks WHERE flow_task = ? AND stage = 'queued' ORDER BY task_id").all(taskId) as Row[]).map((r) => str(r.task_id));
    const settings = this.#sdlcPolicy().projects[project];
    const review = effectiveGates(this.#sdlcPolicy(), project).review;
    const now = this.#now();
    if (ids.length) {
      const res = this.db
        .prepare(
          `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, parent_task, created_by, on_behalf, created_at)
           VALUES (?, 'batch', ?, ?, ?, '', ?, ?, ?, ?)`,
        )
        // A cross-review after each run unless the project's review gate leaves it out.
        .run(project, `${taskId} · ${strOrNull(flow.dir) ?? ""}`.slice(0, 120), settings?.maxParallel ?? null, review === "auto" ? 0 : 1, taskId, str(flow.created_by), strOrNull(flow.on_behalf), now);
      const groupId = num(res.lastInsertRowid);
      const item = this.db.prepare(
        "INSERT INTO run_group_items(group_id, position, task_id, role, machine_id, profile_id, status, updated_at) VALUES (?, ?, ?, 'implement', NULL, NULL, 'held', ?)",
      );
      ids.forEach((id, i) => item.run(groupId, i + 1, id, now));
      this.db.prepare(`UPDATE sdlc_flow_tasks SET stage = 'build', updated_at = ? WHERE flow_task = ? AND stage = 'queued'`).run(now, taskId);
      this.#setFlow(taskId, { state: "done", note: `${ids.length} task → run group #${groupId}` });
      this.#release();
    } else this.#setFlow(taskId, { state: "done" });
  }

  #flowTaskRow(taskId: string): Row | null {
    return (this.db.prepare("SELECT * FROM sdlc_flow_tasks WHERE task_id = ?").get(taskId) as Row | undefined) ?? null;
  }

  #toFlowTask(r: Row): SdlcFlowTask {
    const gate = r.gate_id == null ? undefined : (this.db.prepare("SELECT * FROM sdlc_gates WHERE id = ?").get(num(r.gate_id)) as Row | undefined);
    return {
      taskId: str(r.task_id),
      flowTask: str(r.flow_task),
      project: str(r.project),
      stage: str(r.stage) as TaskStage,
      gate: gate ? toGate(gate) : null,
      fixRounds: num(r.fix_rounds),
      machineId: strOrNull(r.machine_id),
      runId: strOrNull(r.run_id),
      note: strOrNull(r.note),
      updatedAt: str(r.updated_at),
    };
  }

  #setTask(taskId: string, fields: Partial<Record<"stage" | "gate_id" | "fix_rounds" | "machine_id" | "run_id" | "request_id" | "note", string | number | null>>): void {
    const keys = Object.keys(fields);
    this.db
      .prepare(`UPDATE sdlc_flow_tasks SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE task_id = ?`)
      .run(...keys.map((k) => fields[k as keyof typeof fields] ?? null), this.#now(), taskId);
  }

  /** A gate of a flow's task: written like a flow's, with the task as its subject. */
  #taskGate(ft: Row, gate: SdlcGate, mode: GateMode, status: GateStatus, subject: Record<string, unknown>, decided: { by: string; note?: string | null } | null): number {
    return this.#addGate({ project: ft.project, task_id: ft.task_id }, gate, mode, status, subject, decided);
  }

  /**
   * A run of a flow's task ended (runs.push). Its implement run: on to review (or straight to merge when the review gate
   * is "auto"). Its review: the review gate decides (34d). A gate's check: approve does what the gate was for.
   */
  #taskRunEnded(machineId: string, r: { runId: string; taskId: string; project: string; role: string; status: string; profileId: string | null; summary: string | null; error: string | null }): void {
    const ft = this.#flowTaskRow(r.taskId);
    if (!ft || str(ft.project) !== r.project) return;
    const stage = str(ft.stage);
    const modes = effectiveGates(this.#sdlcPolicy(), r.project);
    if (r.role === "implement" && (stage === "build" || stage === "fix")) {
      if (r.status !== "succeeded") {
        this.#setTask(r.taskId, { stage: "stopped", note: r.error ?? r.status });
        return;
      }
      // Its branch and MR are this run's from now on.
      this.#setTask(r.taskId, { machine_id: machineId, run_id: r.runId });
      if (modes.review === "auto") {
        this.#taskGate(ft, "review", "auto", "passed", { runId: r.runId }, { by: "auto" });
        this.#toTest(this.#flowTaskRow(r.taskId)!);
      } else this.#setTask(r.taskId, { stage: "review" });
      return;
    }
    if (r.role !== "review") return;
    const report = r.summary ? r.summary.slice(0, 2000) : (r.error ?? r.status);
    const by = `run:${machineId}/${r.runId}`;
    if (stage === "review") {
      const verdict = r.status === "succeeded" ? parseVerdict(r.summary) : "unknown";
      const review = { runId: r.runId, profileId: r.profileId, summary: r.summary };
      if (modes.review === "human") {
        const gateId = this.#taskGate(ft, "review", "human", "waiting", { review, verdict }, null);
        this.#setTask(r.taskId, { stage: "gate", gate_id: gateId, note: report });
      } else if (verdict === "approve") {
        this.#taskGate(ft, "review", "ai", "passed", { review }, { by, note: report });
        this.#toTest(this.#flowTaskRow(r.taskId)!);
      } else if (verdict === "changes") {
        this.#taskGate(ft, "review", "ai", "rejected", { review }, { by, note: report });
        this.#toFix(this.#flowTaskRow(r.taskId)!, review, "");
      } else {
        const gateId = this.#taskGate(ft, "review", "ai", "escalated", { review, verdict }, { by, note: report });
        this.#setTask(r.taskId, { stage: "gate", gate_id: gateId, note: report });
      }
      return;
    }
    if (stage === "checking" && ft.gate_id != null) {
      const gateId = num(ft.gate_id);
      const now = this.#now();
      if (r.status === "succeeded" && parseVerdict(r.summary) === "approve") {
        this.db.prepare("UPDATE sdlc_gates SET status = 'passed', decided_by = ?, note = ?, decided_at = ? WHERE id = ?").run(by, report, now, gateId);
        this.#gatePassed(this.#flowTaskRow(r.taskId)!, gateId, "");
      } else {
        this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', decided_by = ?, note = ?, decided_at = ? WHERE id = ?").run(by, report, now, gateId);
        this.#setTask(r.taskId, { stage: "gate" });
      }
    }
  }

  /**
   * A person's word at a task's gate. review: pass goes on to merge; changes queues a fix with their note. fix: pass
   * queues it; changes stops the task for them to take over. merge: pass merges; changes stops it unmerged. Passing a
   * review or a merge is not for whoever asked for the work (27c), as merging from the web is not.
   */
  #decideTask(ft: Row, gate: Row, decision: "pass" | "changes", note: string, actor: Actor): SdlcFlow {
    const gateId = num(gate.id);
    const kind = str(gate.gate) as SdlcGate;
    const status = str(gate.status);
    if (str(ft.stage) !== "gate" || (status !== "waiting" && status !== "escalated")) {
      throw new HiveError("conflict", `Gate #${gateId} is not waiting for a person.`, { key: "errors.gateNotWaiting", vars: { id: gateId } });
    }
    if (decision === "pass" && (kind === "review" || kind === "merge")) this.#notSelf(actor, [strOrNull(ft.on_behalf) ?? str(ft.created_by)], `Gate #${gateId}`);
    assertNoHidden(note, "Note");
    assertNoSecret(note, "Note");
    const now = this.#now();
    this.db
      .prepare("UPDATE sdlc_gates SET status = ?, decided_by = ?, note = COALESCE(NULLIF(?, ''), note), decided_at = ? WHERE id = ?")
      .run(decision === "pass" ? "passed" : "rejected", actor.name, note, now, gateId);
    const taskId = str(ft.task_id);
    const subject = JSON.parse(str(gate.subject)) as { review?: { runId: string; profileId: string | null; summary: string | null } };
    if (decision === "pass") this.#gatePassed(ft, gateId, note);
    else if (kind === "review") this.#setTask(taskId, { stage: "fixnext", gate_id: null, note: fixInstructions(subject.review ?? { runId: "?", profileId: null, summary: null }, note) });
    else this.#setTask(taskId, { stage: "stopped", gate_id: null, note: note || `${kind}: stopped by ${actor.name}` });
    this.#releaseFlows();
    return this.#flow(str(ft.flow_task))!;
  }

  /** The review asked for changes: the fix gate decides, within the project's rounds. */
  #toFix(ft: Row, review: { runId: string; profileId: string | null; summary: string | null }, note: string): void {
    const project = str(ft.project);
    const taskId = str(ft.task_id);
    const mode = effectiveGates(this.#sdlcPolicy(), project).fix;
    const max = this.#sdlcPolicy().projects[project]?.maxFixRounds ?? DEFAULT_MAX_FIX_ROUNDS;
    const subject = { review, note };
    if (num(ft.fix_rounds) >= max) {
      const gateId = this.#taskGate(ft, "fix", mode, "escalated", subject, { by: "auto", note: `${num(ft.fix_rounds)} fix rounds already (at most ${max})` });
      this.#setTask(taskId, { stage: "gate", gate_id: gateId });
      return;
    }
    if (mode === "auto") {
      this.#taskGate(ft, "fix", mode, "passed", subject, { by: "auto" });
      this.#setTask(taskId, { stage: "fixnext", gate_id: null, note: fixInstructions(review, note) });
      return;
    }
    const gateId = this.#taskGate(ft, "fix", mode, mode === "ai" ? "checking" : "waiting", subject, null);
    this.#setTask(taskId, { stage: mode === "ai" ? "check" : "gate", gate_id: gateId, note: review.summary ? review.summary.slice(0, 2000) : null });
  }

  /** A task's gate passed (a person, or its check): what the gate was for happens. */
  #gatePassed(ft: Row, gateId: number, note: string): void {
    const gate = this.db.prepare("SELECT gate, subject FROM sdlc_gates WHERE id = ?").get(gateId) as Row;
    const subject = JSON.parse(str(gate.subject)) as { review?: { runId: string; profileId: string | null; summary: string | null } };
    const taskId = str(ft.task_id);
    switch (str(gate.gate) as SdlcGate) {
      case "review":
        this.#toTest(ft);
        break;
      case "test":
        this.#setTask(taskId, { stage: "merge", gate_id: null, note: null });
        break;
      case "fix":
        this.#setTask(taskId, { stage: "fixnext", gate_id: null, note: fixInstructions(subject.review ?? { runId: "?", profileId: null, summary: null }, note) });
        break;
      case "merge":
        this.#startMerge(ft);
        break;
      default:
        break;
    }
  }

  /** QA is an independent gate between code review and the existing MR/merge checks. */
  #toTest(ft: Row): void {
    const mode = effectiveGates(this.#sdlcPolicy(), str(ft.project)).test;
    if (mode === "auto") {
      this.#taskGate(ft, "test", mode, "passed", { runId: str(ft.run_id) }, { by: "auto" });
      this.#setTask(str(ft.task_id), { stage: "merge", gate_id: null, note: null });
      return;
    }
    const gateId = this.#taskGate(ft, "test", mode, mode === "ai" ? "checking" : "waiting", { runId: str(ft.run_id) }, null);
    this.#setTask(str(ft.task_id), { stage: mode === "ai" ? "check" : "gate", gate_id: gateId });
  }

  /** The hub asks the machine of the task's run to merge its MR, as runs.merge does for a person (merge_by "sdlc"). */
  #startMerge(ft: Row): void {
    const taskId = str(ft.task_id);
    const now = this.#now();
    this.db
      .prepare("UPDATE run_records SET merge_by = 'sdlc', merge_at = ?, merge_status = 'pending', merge_error = NULL, merge_done_at = NULL WHERE machine_id = ? AND run_id = ?")
      .run(now, str(ft.machine_id), str(ft.run_id));
    this.#setTask(taskId, { stage: "merging", gate_id: null });
  }

  /** How long a task waits for its MR (or for its MR to leave draft, or for CI) before a person is asked. */
  static readonly #MR_WAIT_MINUTES = 15;

  /**
   * A task whose review passed waits for a green MR (34d): an open MR, not a draft, its pipeline "success". Then the
   * merge gate: merged by the hub, checked first, or a person's. No MR, a draft or no CI after a while: a person decides.
   */
  #checkMerge(ft: Row): void {
    const taskId = str(ft.task_id);
    const run = ft.machine_id == null ? undefined : (this.db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(str(ft.machine_id), str(ft.run_id)) as Row | undefined);
    const record = run ? toRunRecord(run, false) : null;
    const mr = record?.mr ?? null;
    const late = str(ft.updated_at) < this.#now(-SqliteHive.#MR_WAIT_MINUTES);
    const project = str(ft.project);
    const mode = effectiveGates(this.#sdlcPolicy(), project).merge;
    const ask = (why: string) => {
      const gateId = this.#taskGate(ft, "merge", mode, "escalated", { runId: str(ft.run_id) }, { by: "auto", note: why });
      this.#setTask(taskId, { stage: "gate", gate_id: gateId });
    };
    if (mr?.status === "merged") return this.#setTask(taskId, { stage: "done", note: null });
    if (mr?.status === "closed") return this.#setTask(taskId, { stage: "stopped", note: "MR closed" });
    if (!record?.mrUrl) return void (late && ask("No MR for this run: open one (MR settings of its machine), or merge by hand."));
    if (mr?.draft || mr?.pipeline !== "success") {
      // CI may still run, or fix itself (mr.fixCi); a person is asked only after a while.
      return void (late && ask(mr?.draft ? "The MR is still a draft." : mr?.pipeline ? `CI is ${mr.pipeline}.` : "The MR has no CI: merging it needs a person."));
    }
    if (mode === "auto") {
      this.#taskGate(ft, "merge", mode, "passed", { runId: str(ft.run_id), mr: record.mrUrl }, { by: "auto" });
      this.#startMerge(ft);
      return;
    }
    const gateId = this.#taskGate(ft, "merge", mode, mode === "ai" ? "checking" : "waiting", { runId: str(ft.run_id), mr: record.mrUrl }, null);
    this.#setTask(taskId, { stage: mode === "ai" ? "check" : "gate", gate_id: gateId });
  }

  /**
   * Moves flow tasks on: fixes and checks waiting to be queued (on the machine of the task's run, where its branch is),
   * MRs awaited green, merges and requests that ended.
   */
  #releaseTasks(): void {
    const rows = this.db.prepare("SELECT * FROM sdlc_flow_tasks WHERE stage IN ('fixnext', 'fix', 'check', 'checking', 'merge', 'merging') ORDER BY updated_at").all() as Row[];
    for (const ft of rows) {
      const taskId = str(ft.task_id);
      const stage = str(ft.stage);
      const project = str(ft.project);
      // A request of the task no machine will run: a fix stops, a check goes to a person.
      if ((stage === "fix" || stage === "checking") && ft.request_id != null) {
        const req = this.db.prepare("SELECT status, error FROM run_requests WHERE id = ?").get(num(ft.request_id)) as Row | undefined;
        if (req && ["rejected", "expired", "cancelled"].includes(str(req.status))) {
          const why = req.error ? (JSON.parse(str(req.error)) as RunRequestError).message : str(req.status);
          if (stage === "fix") this.#setTask(taskId, { stage: "stopped", note: why });
          else {
            if (ft.gate_id != null) this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', note = ?, decided_at = ? WHERE id = ?").run(`AI check did not run: ${why}`, this.#now(), num(ft.gate_id));
            this.#setTask(taskId, { stage: "gate" });
          }
        }
        continue;
      }
      if (stage === "merge") {
        this.#checkMerge(ft);
        continue;
      }
      if (stage === "merging") {
        const run = this.db.prepare("SELECT merge_status, merge_error FROM run_records WHERE machine_id = ? AND run_id = ?").get(str(ft.machine_id), str(ft.run_id)) as Row | undefined;
        if (run?.merge_status === "merged") this.#setTask(taskId, { stage: "done" });
        else if (run?.merge_status === "failed" || run?.merge_status === "expired") {
          const mode = effectiveGates(this.#sdlcPolicy(), project).merge;
          const gateId = this.#taskGate(ft, "merge", mode, "escalated", { runId: str(ft.run_id) }, { by: "auto", note: `Merge ${str(run.merge_status)}: ${strOrNull(run.merge_error) ?? ""}` });
          this.#setTask(taskId, { stage: "gate", gate_id: gateId });
        }
        continue;
      }
      if (stage !== "fixnext" && stage !== "check") continue;
      const task = this.#getTask(taskId);
      if (!task || ft.machine_id == null) {
        this.#setTask(taskId, { stage: "stopped", note: `Task ${taskId} or its run is gone.` });
        continue;
      }
      const actor: Actor = { name: str(ft.created_by), role: "member", ...(ft.on_behalf ? { onBehalf: str(ft.on_behalf) } : {}) };
      const review = effectiveGates(this.#sdlcPolicy(), project).review;
      let role: AgentRole = "implement";
      let instructions = str(ft.note ?? "");
      let profileId: string | null = null;
      if (stage === "check") {
        const gate = this.db.prepare("SELECT gate FROM sdlc_gates WHERE id = ?").get(num(ft.gate_id)) as Row;
        role = "review";
        instructions = gateCheckInstructions(str(gate.gate) as SdlcGate);
        const did = this.db.prepare("SELECT profile_id FROM run_records WHERE machine_id = ? AND run_id = ?").get(str(ft.machine_id), str(ft.run_id)) as Row | undefined;
        profileId = this.#otherVendorProfile(str(ft.machine_id), strOrNull(did?.profile_id));
      }
      try {
        const m = this.#assertDispatchable({ machineId: str(ft.machine_id), project, task, role, profileId, candidates: 1, instructions }, actor);
        const req = this.#insertRequest(m, project, task, { role, profileId, reviewAfter: role === "implement" && review !== "auto", candidates: 1, instructions }, actor);
        this.#setTask(taskId, stage === "check" ? { stage: "checking", request_id: req.id } : { stage: "fix", request_id: req.id, fix_rounds: num(ft.fix_rounds) + 1 });
      } catch (err) {
        if (!(err instanceof HiveError)) throw err;
        if (!groupFails(err.key)) continue;
        if (stage === "fixnext") this.#setTask(taskId, { stage: "stopped", note: err.message });
        else {
          this.db.prepare("UPDATE sdlc_gates SET status = 'escalated', decided_by = 'auto', note = ?, decided_at = ? WHERE id = ?").run(`AI check could not start: ${err.message}`, this.#now(), num(ft.gate_id));
          this.#setTask(taskId, { stage: "gate" });
        }
      }
    }
  }

  #redispatch(source: ParsedInput<"runs.dispatch">["redispatch"], task: Task): RunRequest["redispatch"] {
    if (!source) return null;
    const row = this.db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(source.machineId, source.runId) as Row | undefined;
    if (!row || row.project !== task.project || row.task_id !== task.id) throw new HiveError("not_found", `No run ${source.runId} for this task.`, { key: "errors.runNotFound", vars: { id: source.runId } });
    if (!["failed", "cancelled", "rate_limited"].includes(str(row.status))) throw new HiveError("conflict", "Run cannot be redispatched in this state.", { key: "errors.redispatchState" });
    const branch = strOrNull(row.branch);
    // Only task branches are resumable; refs from a machine must never become shell or git options.
    if (source.continueBranch && (!branch || !/^ai\/[A-Za-z0-9._+/-]+$/.test(branch) || branch.includes(".."))) throw new HiveError("bad_request", "No resumable task branch.", { key: "errors.redispatchBranch" });
    return { ...source, branch: source.continueBranch ? branch : null, baseSha: source.continueBranch ? strOrNull(row.base_sha) : null };
  }

  #assertRedispatchRunner(m: Machine, profileId: string | null): void {
    if (!m.profiles.some(p => p.enabled && p.installed && p.redispatch && (!profileId || p.id === profileId))) throw new HiveError("bad_request", "Update the runner before redispatching.", { key: "errors.redispatchRunnerRequired" });
  }

  #linkRedispatch(machineId: string, runId: string, retry: RunRequest["redispatch"]): void {
    if (retry) this.db.prepare("UPDATE run_records SET parent_run = ?, parent_machine_id = ? WHERE machine_id = ? AND run_id = ?").run(retry.runId, retry.machineId, machineId, runId);
  }

  // The plan a task is pinned to, unless the run is aimed at another machine, where that plan does not exist.
  #pinnedProfile(task: Task, machineId: string | null | undefined): string | null {
    const agent = task.agent;
    if (!agent?.profileId) return null;
    return !machineId || this.#machineByRef(machineId).id === agent.machineId ? agent.profileId : null;
  }

  /** A manually dispatched small task joins the existing review/fix/merge lifecycle without Spec Kit. */
  #dispatchDirect(m: Machine, project: string, task: Task, r: { timeoutMinutes?: number | null; role: AgentRole; profileId: string | null; preferKind?: PreferKind | null; reviewAfter: boolean; candidates: number; instructions: string; redispatch?: RunRequest["redispatch"] }, actor: Actor): RunRequest {
    const fast = r.role === "implement" && r.candidates === 1 && !this.#flowRow(task.id) && !this.#flowTaskRow(task.id)
      && this.#sdlcPolicy().projects[project]?.fastLaneKinds?.some((kind) => kind === task.kind);
    const request = this.#insertRequest(m, project, task, fast ? { ...r, reviewAfter: effectiveGates(this.#sdlcPolicy(), project).review !== "auto" } : r, actor);
    if (fast) {
      const now = this.#now();
      this.db.prepare(`INSERT INTO sdlc_flows(task_id, project, step, state, machine_id, profile_id, created_by, on_behalf, created_at, updated_at)
        VALUES (?, ?, 'dispatch', 'done', ?, ?, ?, ?, ?, ?)`)
        .run(task.id, project, m.id, r.profileId, actor.name, actor.onBehalf ?? null, now, now);
      this.db.prepare(`INSERT INTO sdlc_flow_tasks(task_id, flow_task, project, stage, request_id, created_by, on_behalf, updated_at)
        VALUES (?, ?, ?, 'build', ?, ?, ?, ?)`)
        .run(task.id, task.id, project, request.id, actor.name, actor.onBehalf ?? null, now);
      // The authorized dispatch itself is the person's approval, even under a human hub ceiling.
      this.#addGate({ project, task_id: task.id }, "dispatch", "human", "passed", { requestId: request.id, fastLane: true }, { by: actor.name });
    }
    return request;
  }

  #runTimeoutSettings(): RunTimeoutSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'runTimeout'").get() as Row | undefined;
    return row ? JSON.parse(str(row.value)) as RunTimeoutSettings : DEFAULT_RUN_TIMEOUT;
  }

  #requestTimeout(m: Machine, task: Task, profileId: string | null, requested?: number | null): number {
    const settings = this.#runTimeoutSettings();
    const profiles = m.profiles.filter((p) => p.enabled && p.installed && (!profileId || p.id === profileId));
    const ceiling = Math.min(settings.maxMinutes, profiles.length ? Math.max(...profiles.map((p) => p.timeoutMinutes ?? 60)) : 60);
    if (requested != null && requested > ceiling) {
      throw new HiveError("bad_request", `Run timeout exceeds ${ceiling} minutes.`, { key: "errors.runTimeoutCeiling", vars: { minutes: ceiling } });
    }
    return runTimeoutMinutes(settings, ceiling, task.kind, task.id, requested);
  }

  #insertRequest(
    m: Machine,
    project: string,
    task: Task,
    r: { timeoutMinutes?: number | null; role: AgentRole; profileId: string | null; preferKind?: PreferKind | null; reviewAfter: boolean; candidates: number; instructions: string; redispatch?: RunRequest["redispatch"] },
    actor: Actor,
  ): RunRequest {
    const now = this.#now();
    if (r.redispatch) this.#assertRedispatchRunner(m, r.profileId);
    const planning = r.role === "implement" && needsPlanApproval(this.#sdlcPolicy().projects[project]?.planApproval, task.size);
    if (planning && !m.profiles.some((p) => p.enabled && p.installed && p.planApproval && (!r.profileId || p.id === r.profileId) && ["claude", "codex", "gemini"].includes(p.kind))) {
      throw new HiveError("bad_request", "This machine needs an updated Claude, Codex or Gemini runner for plan approval.", { key: "errors.planRunnerRequired" });
    }
    const timeoutMinutes = this.#requestTimeout(m, task, r.profileId, r.timeoutMinutes);
    const selection = this.#selection(project, task, r.role);
    const res = this.db
      .prepare(
        `INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role, profile_id, prefer_kind, review_after, candidates,
           instructions, requested_by, on_behalf, requested_at, updated_at, selection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // A pinned profile is the run's whatever its kind, so the preference would mean nothing.
      .run(m.id, m.machine, project, task.id, task.title, r.role, r.profileId, r.profileId ? null : (r.preferKind ?? null), r.reviewAfter ? 1 : 0, r.candidates, r.instructions, actor.name, actor.onBehalf ?? null, now, now, selection ? JSON.stringify(selection) : null);
    const requestId = num(res.lastInsertRowid);
    this.db.prepare("UPDATE run_requests SET timeout_minutes = ? WHERE id = ?").run(timeoutMinutes, requestId);
    if (r.redispatch) this.db.prepare("UPDATE run_requests SET redispatch = ? WHERE id = ?").run(JSON.stringify(r.redispatch), requestId);
    if (planning) {
      const row = this.db.prepare(`INSERT INTO implementation_plans(project, task_id, machine_id, request_id, timeout_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(project, task.id, m.id, requestId, this.#sdlcPolicy().projects[project]?.planApproval?.timeoutMinutes ?? null, now);
      const plan: RunPlan = { id: num(row.lastInsertRowid), phase: "plan", text: null, note: null };
      this.db.prepare("UPDATE run_requests SET plan = ? WHERE id = ?").run(JSON.stringify(plan), requestId);
    }
    return this.#runRequest(requestId);
  }

  #toPlan(r: Row): ImplementationPlan {
    return { id: num(r.id), project: str(r.project), taskId: str(r.task_id), taskTitle: this.#getTask(str(r.task_id))?.title ?? str(r.task_id), machineId: str(r.machine_id), requestId: num(r.request_id), runId: strOrNull(r.run_id),
      status: str(r.status) as ImplementationPlan["status"], text: strOrNull(r.text), note: strOrNull(r.note), revision: num(r.revision), createdAt: str(r.created_at), readyAt: strOrNull(r.ready_at), deadline: strOrNull(r.deadline), decidedAt: strOrNull(r.decided_at), decidedBy: strOrNull(r.decided_by) };
  }

  #planActive(id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM implementation_plans WHERE id = ? AND status IN ('planning', 'waiting')").get(id);
  }

  #decidePlan(row: Row, decision: "approve" | "changes" | "cancel", note: string, by: string): void {
    const old = this.#runRequest(num(row.request_id));
    const task = this.#getTask(old.taskId);
    if (!task || task.status === "done") throw new HiveError("conflict", "Task is already done.", { key: "errors.taskDone", vars: { id: old.taskId } });
    const now = this.#now();
    if (decision === "cancel") {
      this.db.prepare("UPDATE implementation_plans SET status = 'cancelled', decided_at = ?, decided_by = ?, note = ? WHERE id = ?").run(now, by, note, num(row.id));
      this.db.prepare("UPDATE run_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, old.id);
      this.#agentRunEnded({ runId: old.runId ?? `plan-${row.id}`, taskId: old.taskId, project: old.project, role: old.role, status: "cancelled", error: null });
      return;
    }
    // Copy the authorized request, including its budget owner and model choice. Do not dispatch through the policy
    // again: that would require a second plan and lose the group's/flow's original place.
    const result = this.db.prepare(`INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role, profile_id, prefer_kind, review_after, candidates,
      instructions, requested_by, on_behalf, requested_at, updated_at, selection, timeout_minutes, redispatch)
      SELECT machine_id, machine, project, task_id, task_title, role, profile_id, prefer_kind, review_after, candidates,
      instructions, requested_by, on_behalf, ?, ?, selection, timeout_minutes, redispatch FROM run_requests WHERE id = ?`).run(now, now, old.id);
    const requestId = num(result.lastInsertRowid);
    let planId = num(row.id);
    if (decision === "changes") {
      const next = this.db.prepare(`INSERT INTO implementation_plans(project, task_id, machine_id, request_id, revision, note, timeout_minutes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(old.project, old.taskId, old.machineId, requestId, num(row.revision) + 1, note, row.timeout_minutes as number | null, now);
      planId = num(next.lastInsertRowid);
    }
    this.db.prepare("UPDATE implementation_plans SET status = ?, decided_at = ?, decided_by = ?, note = ? WHERE id = ?")
      .run(decision === "approve" ? "approved" : "changes", now, by, note, num(row.id));
    const plan: RunPlan = { id: planId, phase: decision === "approve" ? "implement" : "plan", text: strOrNull(row.text), note };
    this.db.prepare("UPDATE run_requests SET plan = ? WHERE id = ?").run(JSON.stringify(plan), requestId);
    for (const [table, column] of [["sdlc_flows", "request_id"], ["sdlc_flow_tasks", "request_id"], ["run_group_items", "request_id"], ["run_groups", "phase_request"], ["tasks", "agent_request"]]) {
      this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(requestId, old.id);
    }
  }

  #approveTimedPlans(): void {
    this.db.prepare(`UPDATE implementation_plans SET status = 'cancelled' WHERE status IN ('planning', 'waiting') AND (
      request_id IN (SELECT request_id FROM run_group_items WHERE status = 'cancelled') OR
      task_id IN (SELECT id FROM tasks WHERE status = 'done') OR task_id NOT IN (SELECT id FROM tasks))`).run();
    const rows = this.db.prepare("SELECT * FROM implementation_plans WHERE status = 'waiting' AND deadline IS NOT NULL AND deadline <= ?").all(this.#now()) as Row[];
    for (const row of rows) {
      // A pause or archive also pauses automatic approval; the normal runner still enforces budgets and policy.
      if (this.#projectState(str(row.project)) || !this.#getTask(str(row.task_id)) || this.#getTask(str(row.task_id))?.status === "done") continue;
      try { this.#assertNotPaused(str(row.project)); } catch { continue; }
      this.#decidePlan(row, "approve", "", "auto");
    }
  }

  /** Task ids are the hub's, not a project's: prompts count up across every project, past any P-<n> someone made by hand. */
  #nextPromptTaskId(): string {
    const ids = this.db.prepare("SELECT id FROM tasks WHERE id GLOB 'P-[0-9]*'").all() as Row[];
    const top = Math.max(0, ...ids.map((r) => /^P-(\d+)$/.exec(str(r.id))?.[1]).filter(Boolean).map(Number));
    return `P-${top + 1}`;
  }

  #expireRequests(): void {
    this.db
      .prepare("UPDATE run_requests SET status = 'expired', updated_at = ?1 WHERE status = 'pending' AND requested_at < ?2")
      .run(this.#now(), this.#now(-RUN_REQUEST_TTL_MINUTES));
    this.db.prepare("UPDATE implementation_plans SET status = 'cancelled' WHERE status = 'planning' AND request_id IN (SELECT id FROM run_requests WHERE status IN ('cancelled', 'expired', 'rejected'))").run();
    this.db.prepare("DELETE FROM run_requests WHERE status <> 'pending' AND updated_at < ? AND id NOT IN (SELECT request_id FROM research_runs) AND id NOT IN (SELECT request_id FROM implementation_plans WHERE status IN ('planning', 'waiting'))").run(this.#now(-RUN_REQUEST_DAYS * 24 * 60));
  }

  /** Chat replies nobody started in time expire; one gone silent has failed; old threads are dropped. */
  /** Asks no machine took in time, or whose machine went silent, are given up; a month on they are gone. */
  #expireAssists(): void {
    const now = this.#now();
    const since = this.#now(-ASSIST_WAIT_MINUTES);
    const expired = JSON.stringify({ message: "No machine took the ask in time.", key: "errors.assistNotTaken" });
    const silent = JSON.stringify({ message: "The machine stopped reporting.", key: "errors.assistSilent" });
    this.db.prepare("UPDATE doc_assists SET status = 'expired', error = ?, updated_at = ? WHERE status = 'pending' AND created_at < ?").run(expired, now, since);
    this.db.prepare("UPDATE doc_assists SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running' AND updated_at < ?").run(silent, now, since);
    this.db.prepare("DELETE FROM doc_assists WHERE created_at < ?").run(this.#now(-30 * 24 * 60));
  }

  /** An ask as its machine sees it; only the machine that took it. */
  #assistFor(id: number, actor: Actor): Row {
    const row = this.db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(id) as Row | undefined;
    if (!row || str(row.taken_by ?? "") !== actor.name) throw new HiveError("not_found", `No ask #${id} for this machine.`, { key: "errors.notFound" });
    return row;
  }

  #expireChats(): void {
    const now = this.#now();
    const since = this.#now(-CHAT_WAIT_MINUTES);
    const expired: RunRequestError = { message: "No machine took the message in time.", key: "errors.chatNotTaken" };
    const silent: RunRequestError = { message: "The machine stopped reporting.", key: "errors.chatSilent" };
    this.db
      .prepare("UPDATE chat_messages SET status = 'expired', error = ?, updated_at = ?, finished_at = ? WHERE status = 'pending' AND created_at < ?")
      .run(JSON.stringify(expired), now, now, since);
    this.db
      .prepare("UPDATE chat_messages SET status = 'failed', error = ?, updated_at = ?, finished_at = ? WHERE status = 'running' AND updated_at < ?")
      .run(JSON.stringify(silent), now, now, since);
    this.db.prepare("DELETE FROM chat_threads WHERE updated_at < ?").run(this.#now(-CHAT_DAYS * 24 * 60));
    // Uploaded and never sent.
    this.db.prepare("DELETE FROM chat_files WHERE message_id IS NULL AND created_at < ?").run(this.#now(-24 * 60));
  }

  /** What the project set for its new chats; all null when it set nothing. */
  #chatDefaults(project: string): ChatDefaults {
    const r = this.db.prepare("SELECT * FROM chat_defaults WHERE project = ?").get(project) as Row | undefined;
    return {
      project,
      machineId: r ? strOrNull(r.machine_id) : null,
      profileId: r ? strOrNull(r.profile_id) : null,
      model: r ? strOrNull(r.model) : null,
      effort: r ? (strOrNull(r.effort) as ChatEffort | null) : null,
      commands: r?.commands == null ? [...DEFAULT_LEADER_COMMANDS] : (JSON.parse(str(r.commands)) as string[]),
      autoKinds: r?.auto_kinds == null ? [] : (JSON.parse(str(r.auto_kinds)) as ChatActionKind[]).filter((k) => !CHAT_ACTION_ALWAYS_CONFIRM.includes(k)),
      updatedBy: r ? strOrNull(r.updated_by) : null,
      updatedAt: r ? strOrNull(r.updated_at) : null,
    };
  }

  /** A leader's proposal checked and kept (chat.propose); #autoRun may run it at once. */
  #proposeChat(action: ParsedInput<"chat.propose">["action"], reason: string, actor: Actor): ChatAction {
    const db = this.db;
    return this.#tx(() => {
          if (!actor.chatReply) {
            throw new HiveError("forbidden", "Only a chat leader proposes actions, with the token of the reply it writes.", { key: "errors.chatProposeOnly" });
          }
          const reply = db
            .prepare("SELECT m.status, m.thread_id, t.project, t.machine_id FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ? AND m.role = 'assistant'")
            .get(actor.chatReply) as Row | undefined;
          const replyId = actor.chatReply;
          if (!reply) throw new HiveError("not_found", `Chat reply #${replyId} not found.`, { key: "errors.chatReplyNotFound", vars: { id: replyId } });
          if (str(reply.status) !== "pending" && str(reply.status) !== "running") {
            throw new HiveError("conflict", `Chat reply #${replyId} has ended.`, { key: "errors.chatReplyEnded", vars: { id: replyId } });
          }
          const project = str(reply.project);
          const hub = project === HUB_SCOPE;
          const max = hub ? CHAT_ACTIONS_PER_HUB_REPLY : CHAT_ACTIONS_PER_REPLY;
          const count = num((db.prepare("SELECT COUNT(*) AS n FROM chat_actions WHERE reply_id = ?").get(replyId) as Row).n);
          if (count >= max) {
            throw new HiveError("bad_request", `A reply proposes at most ${max} actions.`, { key: "errors.chatTooManyActions", vars: { max } });
          }
          // A person reads it before confirming, and an agent may read it as its prompt.
          const texts: Array<[string, string | undefined]> = [["Reason", reason]];
          if (action.kind === "task.create") texts.push(["Title", action.title]);
          if (action.kind === "task.update") texts.push(["Note", action.note]);
          if (action.kind === "run.dispatch") texts.push(["Instructions", action.instructions]);
          for (const [what, text] of texts) {
            if (!text) continue;
            assertNoHidden(text, what);
            assertNoSecret(text, what);
          }
          const task = (id: string) => db.prepare("SELECT project FROM tasks WHERE id = ?").get(id) as Row | undefined;
          // A plan (roadmap 60d) proposes its tasks too: each one already has its project when the plan is stored. One
          // set aside or failed makes nothing, so the leader may propose it again in the same reply.
          const plannedRow = (id: string) =>
            db
              .prepare(
                `SELECT json_extract(input, '$.project') AS project FROM chat_actions WHERE reply_id = ? AND kind = 'task.create' AND json_extract(input, '$.id') = ?
                 UNION ALL
                 SELECT json_extract(j.value, '$.project') FROM chat_actions a, json_each(a.input, '$.tasks') j
                 WHERE a.reply_id = ? AND a.kind = 'plan.create' AND a.status IN ('proposed', 'done') AND json_extract(j.value, '$.id') = ?`,
              )
              .get(replyId, id, replyId, id) as Row | undefined;
          const planned = (id: string) => plannedRow(id) !== undefined;
          // The project a task is in, or will be in once this reply's proposal to create it is confirmed.
          const projectOf = (id: string): string | null => strOrNull(task(id)?.project) ?? strOrNull(plannedRow(id)?.project);
          // A task of the project aimed at, or of another service of a system it is in that the sender sees (roadmap
          // 19d), or one this reply also proposes to create (confirming all makes it first). The hub-wide leader names
          // the project itself, so there it is that one exactly.
          const known = (id: string, scope: string) => {
            const p = projectOf(id);
            return p !== null && (p === scope || (!hub && this.#sameSystem(p, scope) && sees(actor, p)));
          };
          const missing = (id: string, scope: string) =>
            new HiveError("not_found", `Task ${id} not found in ${scope}.`, { key: "errors.chatTaskNotFound", vars: { id, project: scope } });
          /**
           * The project this proposal is aimed at. A project's own thread works on its own project, as it always has.
           * The hub-wide thread (roadmap 37) reaches every project, so there the leader has to name one, and it has to
           * be a project the hub really has and the leader's token sees.
           */
          const named = action.project;
          const aimed = (): string => {
            if (!hub) return project;
            if (!named) {
              throw new HiveError("bad_request", `${action.kind} in the hub-wide chat says which project it is for.`, {
                key: "errors.chatProjectRequired",
                vars: { kind: action.kind },
              });
            }
            if (!this.#projectNames().includes(named) || !sees(actor, named)) {
              throw new HiveError("not_found", `No project ${named} on the hub.`, { key: "errors.chatProjectUnknown", vars: { project: named } });
            }
            return named;
          };
          // Kinds that need no project: left out in the hub-wide chat they mean the whole hub (null), as agents.stop does.
          const aimedOrHub = (): string | null => (hub && !named ? null : aimed());
          // A machine by hub id or name, as run.dispatch names one.
          const machineRow = (wanted: string): Row => {
            const m = db.prepare("SELECT * FROM machines WHERE id = ? OR machine = ? ORDER BY last_seen DESC LIMIT 1").get(wanted, wanted) as Row | undefined;
            if (!m) throw new HiveError("not_found", `No machine ${wanted}.`, { key: "errors.machineNotFound", vars: { machine: wanted } });
            return m;
          };
          // Only a run of the project aimed at: the leader never reaches past the project it named.
          const runRow = (machineId: string, runId: string, scope: string): Row => {
            const r = db.prepare("SELECT status, mr_url FROM run_records WHERE machine_id = ? AND run_id = ? AND project = ?").get(machineId, runId, scope) as Row | undefined;
            if (!r) throw new HiveError("not_found", `Run ${runId} not found in ${scope}.`, { key: "errors.chatRunNotFound", vars: { id: runId, project: scope } });
            return r;
          };
          let input: Record<string, unknown>;
          /**
           * What chat_actions.project keeps: the project the proposal is aimed at, so Today, the filters and the log
           * stay per project. A project's thread files everything under itself, as before 37. HUB_SCOPE is for what
           * belongs to no project: a machine's plan or setup item, a stop of every agent, the hub's own policy.
           */
          let scope = project;
          switch (action.kind) {
            case "research.start": {
              const target = aimed();
              const m = machineRow(action.machine ?? str(reply.machine_id));
              const request = researchSchema.parse({ ...action, project: target, machineId: str(m.id) });
              this.#researchProjects(request, actor);
              for (const value of [request.topic, ...request.questions]) { assertNoHidden(value, "Research"); assertNoSecret(value, "Research"); }
              input = request;
              scope = target;
              break;
            }
            case "plan.create": {
              const target = aimed();
              const plan = { ...action, project: target, tasks: action.tasks.map((t) => ({ ...t, project: t.project ?? target })) };
              this.#validateChatPlan(plan, actor, hub ? null : project);
              const taken = plan.tasks.find((t) => planned(t.id));
              if (taken) throw new HiveError("conflict", `Task ${taken.id} already exists.`, { key: "errors.taskExists", vars: { id: taken.id } });
              input = plan;
              scope = target;
              break;
            }
            case "task.create": {
              if (task(action.id) || planned(action.id)) throw new HiveError("conflict", `Task ${action.id} already exists.`, { key: "errors.taskExists", vars: { id: action.id } });
              // A leader of one service plans a feature across its system: a task for another service of it (roadmap 19d).
              const target = hub ? aimed() : (action.project ?? project);
              if (!hub && target !== project && (!this.#sameSystem(target, project) || !sees(actor, target))) {
                throw new HiveError("bad_request", `${target} is not a service of a system with ${project}.`, { key: "errors.chatProjectOutside", vars: { project: target, home: project } });
              }
              input = {
                id: action.id,
                project: target,
                title: action.title,
                dependsOn: action.dependsOn,
                ...(action.taskKind ? { taskKind: action.taskKind } : {}),
                ...(action.size ? { size: action.size } : {}),
                ...(action.risk ? { risk: action.risk } : {}),
              };
              if (hub) scope = target;
              break;
            }
            case "task.update": {
              const target = aimed();
              if (!known(action.id, target)) throw missing(action.id, target);
              input = { id: action.id, status: action.status, ...(action.note === undefined ? {} : { note: action.note }) };
              if (hub) scope = target;
              break;
            }
            case "task.classify": {
              const target = aimed();
              if (!known(action.id, target)) throw missing(action.id, target);
              if (hub) scope = target;
              if (action.taskKind === undefined && action.size === undefined && action.risk === undefined) {
                throw new HiveError("bad_request", "A classification needs a kind, size or risk.", { key: "errors.classifyEmpty" });
              }
              input = {
                id: action.id,
                ...(action.taskKind ? { taskKind: action.taskKind } : {}),
                ...(action.size ? { size: action.size } : {}),
                ...(action.risk ? { risk: action.risk } : {}),
              };
              break;
            }
            case "task.assign": {
              const target = aimed();
              if (!known(action.taskId, target)) throw missing(action.taskId, target);
              if (hub) scope = target;
              const m = this.#toMachine(machineRow(action.machine));
              if (action.profileId !== null && !m.profiles.some((p) => p.id === action.profileId)) {
                throw new HiveError("not_found", `${m.machine} has not reported a profile ${action.profileId}.`, {
                  key: "errors.chatProfileNotFound",
                  vars: { machine: m.machine, profile: action.profileId },
                });
              }
              // `machine` is only what the card shows: tasks.assign takes the hub id.
              input = { id: action.taskId, machineId: m.id, profileId: action.profileId, machine: m.machine };
              break;
            }
            case "run.dispatch": {
              const target = aimed();
              if (!known(action.taskId, target)) throw missing(action.taskId, target);
              // The chat's own machine unless the leader names another.
              const m = machineRow(action.machine ?? str(reply.machine_id));
              input = {
                machineId: str(m.id),
                // The task's own project: another service of the system for a task proposed there (roadmap 19d).
                project: projectOf(action.taskId)!,
                taskId: action.taskId,
                role: action.role,
                profileId: action.profileId,
                reviewAfter: action.reviewAfter,
                candidates: action.candidates,
                instructions: action.instructions,
              };
              if (hub) scope = target;
              break;
            }
            case "run.cancel": {
              const target = aimed();
              const machineId = str(machineRow(action.machine).id);
              const status = str(runRow(machineId, action.runId, target).status);
              if (status !== "queued" && status !== "running") {
                throw new HiveError("conflict", `Run ${action.runId} has ended (${status}).`, { key: "errors.chatRunEnded", vars: { id: action.runId } });
              }
              input = { machineId, runId: action.runId };
              if (hub) scope = target;
              break;
            }
            case "run.merge": {
              const target = aimed();
              const machineId = str(machineRow(action.machine).id);
              if (runRow(machineId, action.runId, target).mr_url == null) {
                throw new HiveError("bad_request", `Run ${action.runId} has no merge request.`, { key: "errors.chatRunNoMr", vars: { id: action.runId } });
              }
              input = { machineId, runId: action.runId };
              if (hub) scope = target;
              break;
            }
            case "machine.profile": {
              if (action.enabled === undefined && action.priority === undefined) {
                throw new HiveError("bad_request", "Say enabled or priority.", { key: "errors.chatProfileNothing" });
              }
              const m = this.#toMachine(machineRow(action.machine));
              if (!m.profiles.some((p) => p.id === action.profileId)) {
                throw new HiveError("not_found", `${m.machine} has not reported a profile ${action.profileId}.`, {
                  key: "errors.chatProfileNotFound",
                  vars: { machine: m.machine, profile: action.profileId },
                });
              }
              input = {
                machineId: m.id,
                profileId: action.profileId,
                ...(action.enabled === undefined ? {} : { enabled: action.enabled }),
                ...(action.priority === undefined ? {} : { priority: action.priority }),
              };
              // A plan belongs to the machine, not to any project.
              if (hub) scope = HUB_SCOPE;
              break;
            }
            case "agent.policy": {
              // What it is now, so the card shows before and after; the policy may change again before it is confirmed.
              const target = aimedOrHub();
              const policy = this.#agentPolicy();
              input = { project: target, policy: action.policy, before: target === null ? policy.hub : (policy.projects[target] ?? null) };
              if (hub) scope = target ?? HUB_SCOPE;
              break;
            }
            case "agents.stop":
            case "agents.resume": {
              const target = aimedOrHub();
              input = { project: target };
              if (hub) scope = target ?? HUB_SCOPE;
              break;
            }
            case "machine.install": {
              // The machine's own items (cli:<kind>, shim) belong to no project; a project's item is only that project's
              // to ask for, so the hub-wide leader has to name the one it belongs to.
              const colon = action.itemId.indexOf(":");
              const owner = action.itemId === "shim" || action.itemId.startsWith("cli:") || action.itemId.startsWith("tool:") ? null : action.itemId.slice(0, colon);
              const target = owner === null ? null : aimed();
              if (owner !== null && owner !== (target ?? project)) {
                throw new HiveError("forbidden", `${action.itemId} belongs to another project.`, {
                  key: "errors.chatInstallOtherProject",
                  vars: { item: action.itemId, project: target ?? project },
                });
              }
              input = { machineId: str(machineRow(action.machine).id), itemId: action.itemId };
              if (hub) scope = target ?? HUB_SCOPE;
              break;
            }
            case "tool.enable": {
              const target = aimed();
              const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(action.id) as Row | undefined;
              if (!row) throw new HiveError("not_found", `No tool ${action.id}.`, { key: "errors.toolNotFound", vars: { id: action.id } });
              // The project's setting now: the card shows before and after, and a proposal that leaves required out
              // should not drop a requirement the project set.
              const view = this.#toolView(row, actor, target);
              const now = view.projects.find((p) => p.project === target)!;
              input = {
                id: view.id,
                project: target,
                enabled: action.enabled,
                required: action.required ?? now.required,
                name: view.name,
                before: { enabled: now.enabled, required: now.required, effective: now.effective },
              };
              if (hub) scope = target;
              break;
            }
          }
          const id = num(
            db
              .prepare("INSERT INTO chat_actions(reply_id, thread_id, project, kind, input, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run(replyId, num(reply.thread_id), scope, action.kind, JSON.stringify(input), reason, this.#now()).lastInsertRowid,
          );
          return this.#chatAction(id);
    });
  }

  #createTask(input: ParsedInput<"tasks.create">, actor: Actor): Task {
    const db = this.db;
    if (this.#getTask(input.id)) throw new HiveError("conflict", `Task ${input.id} already exists.`, { key: "errors.taskExists", vars: { id: input.id } });
    const deps = this.#checkDeps(input.id, input.project, input.dependsOn, actor);
    // Save the initial brief with creation: a task manager need not have taskWork to describe new work.
    if (input.note) assertNoHidden(input.note, "Note");
    db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      input.id,
      input.project,
      input.title,
      input.note === undefined ? null : clean(input.note),
      this.#now(),
    );
    // Whoever creates it may say what it is (a leader's task.create): theirs, and the rules leave it alone.
    if (input.kind || input.size || input.risk) {
      db.prepare("UPDATE tasks SET kind = ?, size = ?, risk = ?, classified_by = ?, classified_at = ? WHERE id = ?").run(
        input.kind ?? null,
        input.size ?? null,
        input.risk ?? null,
        actor.name,
        this.#now(),
        input.id,
      );
    }
    if (input.priority !== undefined) db.prepare("UPDATE tasks SET priority = ? WHERE id = ?").run(input.priority, input.id);
    this.#applyTaskRule(input.id);
    this.#setDeps(input.id, deps);
    return this.#getTask(input.id)!;
  }

  /** Validate all scopes and the dependency graph before a plan can become a card or write anything. */
  #validateChatPlan(plan: ChatPlan, actor: Actor, home: string | null): void {
    const fail = (message: string): never => { throw new HiveError("bad_request", message); };
    const projects = new Set(this.#projectNames());
    const doc = parseDocKey(plan.spec.key);
    const targets = new Set(plan.tasks.map((t) => t.project ?? plan.project!));
    targets.add(plan.project!);
    for (const target of targets) {
      if (!projects.has(target) || !sees(actor, target)) fail(`Unknown service: ${target}`);
      if (home && target !== home && !this.#sameSystem(target, home)) {
        throw new HiveError("bad_request", `${target} is not a service of a system with ${home}.`, { key: "errors.chatProjectOutside", vars: { project: target, home } });
      }
    }
    if (doc.scope === "project") {
      if (targets.size !== 1 || doc.project !== plan.project) fail("A service spec must belong to the plan's service; use a system spec for multiple services.");
    } else if (doc.scope === "system") {
      const system = this.#systemList().find((s) => systemOwner(s.name) === doc.project);
      if (!system || [...targets].some((p) => !system.projects.includes(p))) fail("The spec's system must contain every service in the plan.");
    } else fail("A plan spec belongs to a service or a system.");
    if (doc.skill || isContextDoc(plan.spec.key)) fail("A plan must create a spec, not agent instructions.");
    // Checked again when it runs: someone may have written that page or made one of the tasks in the meantime.
    if (this.#getDoc(plan.spec.key)) throw new HiveError("conflict", `${plan.spec.key} already exists.`, { key: "errors.chatPlanSpecExists", vars: { key: plan.spec.key } });
    const ids = new Set(plan.tasks.map((t) => t.id));
    if (ids.size !== plan.tasks.length) fail("Duplicate task ids in plan.");
    const batchOf = new Map<string, number>();
    plan.batches.forEach((batch, index) => {
      for (const id of batch.taskIds) {
        if (!ids.has(id) || batchOf.has(id)) fail("Each planned task must appear in exactly one batch.");
        batchOf.set(id, index);
      }
    });
    if (batchOf.size !== ids.size) fail("Every planned task needs a batch.");
    for (const task of plan.tasks) {
      if (this.#getTask(task.id)) throw new HiveError("conflict", `Task ${task.id} already exists.`, { key: "errors.taskExists", vars: { id: task.id } });
      for (const dep of task.dependsOn) {
        if (dep === task.id) fail("A task cannot depend on itself.");
        if (ids.has(dep)) {
          if (batchOf.get(dep)! > batchOf.get(task.id)!) fail("A dependency cannot be in a later batch.");
        } else {
          const existing = this.#getTask(dep);
          const target = task.project ?? plan.project!;
          if (!existing || !sees(actor, existing.project) || (existing.project !== target && !this.#sameSystem(existing.project, target))) fail(`Unknown dependency: ${dep}`);
        }
      }
    }
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) fail("Cyclic plan dependencies.");
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of plan.tasks.find((t) => t.id === id)!.dependsOn) if (ids.has(dep)) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    for (const text of [plan.spec.title, plan.spec.content, ...plan.tasks.flatMap((t) => [t.title, t.acceptance]), ...plan.batches.map((b) => b.title)]) {
      assertNoHidden(text, "Plan"); assertNoSecret(text, "Plan");
    }
  }

  #createChatPlan(plan: ChatPlan, caller: Actor, autoDispatch = true, cli = false): NonNullable<ChatAction["result"]> {
    const actor = this.#withSystems(caller);
    const { spec, doc, tasks, made, automation } = this.#tx(() => {
      this.#validateChatPlan(plan, actor, null);
      const spec = parseInput("docs.save", { ...plan.spec, includeInAgents: false, baseVersion: 0 });
      const tasks = plan.tasks.map(({ taskKind, acceptance, ...task }) => parseInput("tasks.create", {
        ...task, project: task.project ?? plan.project!, kind: taskKind,
        note: `${acceptance}\n\nSpec: [[${plan.spec.key}]]`,
      }));
      // A CLI plan can create a validated new spec with docPropose; changing an existing doc still needs docs.save rights.
      if (cli) {
        const owner = parseDocKey(spec.key).project;
        this.#need(actor, owner, "docPropose", `Plan ${spec.key}`);
      } else {
        authorize("docs.save", actor); this.#check("docs.save", spec, actor);
      }
      this.#assertProjectOpen("docs.save", spec);
      for (const task of tasks) {
        authorize("tasks.create", actor); this.#check("tasks.create", task, actor); this.#assertProjectOpen("tasks.create", task);
      }
      const automation = autoDispatch ? [...new Set(tasks.map(t => t.project))].map(project => {
        const current = this.#sdlcPolicy().projects[project];
        const input = parseInput("sdlc.setProject", { project, settings: { ...current, gates: current?.gates ?? {}, autoDispatch: true } });
        authorize("sdlc.setProject", actor); this.#check("sdlc.setProject", input, actor); this.#assertProjectOpen("sdlc.setProject", input);
        return input;
      }) : [];
      const doc = this.#writeDoc(spec.key, spec.content, spec, actor.name, actor.source);
      const made: Task[] = [];
      // Dependencies first, whatever order the leader listed them in: #checkDeps wants each one to exist.
      const pending = [...tasks];
      while (pending.length) {
        const index = pending.findIndex((t) => t.dependsOn.every((dep) => !pending.some((other) => other.id === dep)));
        const [task] = pending.splice(index, 1);
        made.push(this.#createTask(task!, actor));
      }
      // The reviewed plan and its opt-in commit together; missing dispatch rights leave neither behind.
      for (const input of automation) this.#handlers["sdlc.setProject"](input, actor);
      return { spec, doc, tasks, made, automation };
    });
    // After the commit, as `call` does: nobody hears of a write that was rolled back.
    this.#report("docs.save", spec, doc, actor);
    tasks.forEach((task) => this.#report("tasks.create", task, made.find((t) => t.id === task.id)!, actor));
    automation.forEach(input => this.#report("sdlc.setProject", input, this.#sdlcView(), actor));
    return { specKey: spec.key, taskIds: tasks.map((t) => t.id) };
  }

  /**
   * Runs a proposal as `actor`'s own call, or sets it aside: a person confirming it (chat.decide), or the leader running
   * it as the person who sent the message (auto, roadmap 29c).
   */
  async #decideChat(actionId: number, accept: boolean, actor: Actor, auto: boolean, autoDispatch = true): Promise<ChatAction> {
    const db = this.db;
        const action = this.#chatAction(actionId);
        const decided = () => new HiveError("conflict", `Chat action #${actionId} was already decided.`, { key: "errors.chatActionDecided", vars: { id: actionId } });
        if (action.status !== "proposed") throw decided();
        // Taken first, so a second click or another manager does not run it twice.
        const taken = db
          .prepare("UPDATE chat_actions SET status = ?, decided_by = ?, decided_at = ?, auto = ? WHERE id = ? AND status = 'proposed'")
          .run(accept ? "done" : "dismissed", auto ? (actor.onBehalf ?? actor.name) : actor.name, this.#now(), auto ? 1 : 0, actionId);
        if (Number(taken.changes) === 0) throw decided();
        if (!accept) return this.#chatAction(actionId);
        try {
          // this.call, not the handler: the method's own role, rights (#check), audit and events, as on the web.
          if (action.kind === "research.start") {
            const research = await this.call("research.start", action.input as MethodInput<"research.start">, actor);
            db.prepare("UPDATE chat_actions SET result = ? WHERE id = ?").run(JSON.stringify({ researchId: research.id, requestId: research.requestId }), actionId);
            return this.#chatAction(actionId);
          } else if (action.kind === "plan.create") {
            const result = this.#createChatPlan(chatPlanSchema.parse(action.input), actor, autoDispatch);
            db.prepare("UPDATE chat_actions SET result = ? WHERE id = ?").run(JSON.stringify(result), actionId);
            return this.#chatAction(actionId);
          }
          const call = CHAT_ACTION_CALLS[action.kind];
          const output = await this.call(call.method, (call.input ? call.input(action.input) : action.input) as MethodInput<Method>, actor);
          if (call.result) db.prepare("UPDATE chat_actions SET result = ? WHERE id = ?").run(JSON.stringify(call.result(output)), actionId);
        } catch (err) {
          // Run alone, it stops at the sender's rights: then it waits for a person who has them, rather than failing.
          if (auto && err instanceof HiveError && err.code === "forbidden") {
            db.prepare("UPDATE chat_actions SET status = 'proposed', decided_by = NULL, decided_at = NULL, auto = 0 WHERE id = ?").run(actionId);
            return this.#chatAction(actionId);
          }
          const why: RunRequestError =
            err instanceof HiveError && err.key ? { message: err.message, key: err.key, ...(err.vars ? { vars: err.vars } : {}) } : { message: String((err as Error).message ?? err) };
          db.prepare("UPDATE chat_actions SET status = 'failed', error = ? WHERE id = ?").run(JSON.stringify(why), actionId);
        }
        return this.#chatAction(actionId);
  }

  /**
   * Roadmap 29c: a kind the project lets its leader run alone runs at once, as the person who sent the message, with no
   * more than their rights, and only when they could confirm it themselves (chatApprove). Anything else waits for a person.
   */
  async #autoRun(action: ChatAction, leader: Actor): Promise<ChatAction> {
    // What a leader may run alone is the chat's own setting, not the target project's: the hub-wide leader (roadmap 37)
    // follows chat_defaults["*"], which only a hub admin sets, whichever project the proposal is aimed at.
    const thread = this.#threadProjectOfReply(action.replyId);
    const settings = thread === HUB_SCOPE ? HUB_SCOPE : action.project;
    if (CHAT_ACTION_ALWAYS_CONFIRM.includes(action.kind) || !this.#chatDefaults(settings).autoKinds.includes(action.kind)) return action;
    // A run or a move of a task this reply proposes to create waits until someone confirms the task.
    const taskId =
      action.kind === "run.dispatch" ? action.input.taskId : action.kind === "task.update" || action.kind === "task.classify" || action.kind === "task.assign" ? action.input.id : null;
    if (typeof taskId === "string" && !this.#getTask(taskId)) return action;
    const row = this.db.prepare("SELECT sender FROM chat_messages WHERE id = ?").get(action.replyId) as Row | undefined;
    if (row?.sender == null) return action;
    const sender = JSON.parse(str(row.sender)) as ChatSender;
    const person: Actor = {
      name: sender.name,
      role: sender.role,
      ...(sender.access ? { access: sender.access } : {}),
      ...(sender.account ? { account: sender.account } : {}),
      // The audit log (27c) names the leader and whom it acted for.
      agent: leader.agent ?? leader.name,
      onBehalf: sender.name,
      source: leader.source ?? { via: "mcp" },
    };
    if (!may(this.#withSystems(person), action.project, "chatApprove")) return action;
    // Auto-dispatch starts a service's whole backlog: only a person's click on the plan opts in, never the leader alone.
    return this.#decideChat(action.id, true, person, true, false);
  }

  #chatThread(id: number): ChatThread {
    const row = this.db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Chat #${id} not found.`, { key: "errors.chatNotFound", vars: { id } });
    return toChatThread(row);
  }

  #chatMessage(id: number): ChatMessage {
    const message = toChatMessage(this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as Row);
    return {
      ...message,
      actions: (this.db.prepare("SELECT * FROM chat_actions WHERE reply_id = ? ORDER BY id").all(id) as Row[]).map(toChatAction),
      files: (this.db.prepare(`SELECT ${FILE_FIELDS} FROM chat_files WHERE message_id = ? ORDER BY id`).all(id) as Row[]).map(toChatFile),
    };
  }

  /** A thread's messages after `after`, each reply with the actions its leader asked for. */
  #chatMessages(threadId: number, after: number): ChatMessage[] {
    const actions = new Map<number, ChatAction[]>();
    for (const r of this.db.prepare("SELECT * FROM chat_actions WHERE thread_id = ? AND reply_id > ? ORDER BY id").all(threadId, after) as Row[]) {
      const a = toChatAction(r);
      actions.set(a.replyId, [...(actions.get(a.replyId) ?? []), a]);
    }
    const files = new Map<number, ChatFile[]>();
    for (const r of this.db.prepare(`SELECT ${FILE_FIELDS} FROM chat_files WHERE thread_id = ? AND message_id > ? ORDER BY id`).all(threadId, after) as Row[]) {
      files.set(num(r.message_id), [...(files.get(num(r.message_id)) ?? []), toChatFile(r)]);
    }
    return (this.db.prepare("SELECT * FROM chat_messages WHERE thread_id = ? AND id > ? ORDER BY id").all(threadId, after) as Row[]).map((r) => {
      const m = toChatMessage(r);
      return { ...m, actions: actions.get(m.id) ?? [], files: files.get(m.id) ?? [] };
    });
  }

  #chatAction(id: number): ChatAction {
    const row = this.db.prepare("SELECT * FROM chat_actions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Chat action #${id} not found.`, { key: "errors.chatActionNotFound", vars: { id } });
    return toChatAction(row);
  }

  /** A fresh provider session needs the conversation, while prior proposals remain in Hive. */
  #chatHistory(threadId: number, before: number): string {
    const rows = this.db.prepare(
      "SELECT role, text FROM (SELECT id, role, text FROM chat_messages WHERE thread_id = ? AND id < ? AND text <> '' ORDER BY id DESC LIMIT 20) ORDER BY id",
    ).all(threadId, before) as Row[];
    return rows.map((m) => `${str(m.role)}: ${str(m.text)}`).join("\n\n").slice(-24_000);
  }

  /** The replies a machine should write: pending ones of its threads, with the message and the session to resume. */
  #chatRequests(machineId: string): ChatRequest[] {
    return (
      this.db
        .prepare(
          `SELECT m.id, m.thread_id, m.sender, m.created_at, t.project, t.profile_id, t.session_id, t.model, t.effort,
             (SELECT u.text FROM chat_messages u WHERE u.thread_id = m.thread_id AND u.role = 'user' AND u.id < m.id ORDER BY u.id DESC LIMIT 1) AS text,
             (SELECT u.author FROM chat_messages u WHERE u.thread_id = m.thread_id AND u.role = 'user' AND u.id < m.id ORDER BY u.id DESC LIMIT 1) AS requested_by,
             (SELECT u.id FROM chat_messages u WHERE u.thread_id = m.thread_id AND u.role = 'user' AND u.id < m.id ORDER BY u.id DESC LIMIT 1) AS message_id
           FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id
           WHERE t.machine_id = ? AND m.status = 'pending' ORDER BY m.id`,
        )
        .all(machineId) as Row[]
    ).map(
      (r): ChatRequest => ({
        replyId: num(r.id),
        threadId: num(r.thread_id),
        project: str(r.project),
        profileId: strOrNull(r.profile_id),
        sessionId: strOrNull(r.session_id),
        model: strOrNull(r.model),
        effort: strOrNull(r.effort) as ChatEffort | null,
        text: str(r.text ?? ""),
        history: this.#chatHistory(num(r.thread_id), num(r.message_id)),
        requestedBy: str(r.requested_by ?? ""),
        createdAt: str(r.created_at),
        ...(r.sender == null ? {} : { sender: JSON.parse(str(r.sender)) as ChatSender }),
        files: (this.db.prepare(`SELECT ${FILE_FIELDS} FROM chat_files WHERE message_id = ? ORDER BY id`).all(num(r.message_id ?? 0)) as Row[]).map(toChatFile),
        commands: this.#chatDefaults(str(r.project)).commands,
        // The systems the project is a service of (roadmap 19d): the leader plans across them.
        systems: this.#systemList().filter((s) => s.projects.includes(str(r.project))),
        // The hub-wide leader works across projects (roadmap 37): it gets the whole list, with who has each repo.
        ...(str(r.project) === HUB_SCOPE ? { projects: this.#projectsForHubChat() } : {}),
      }),
    );
  }

  /** A reply as the machine writing it may touch it: only the machine its thread is on. */
  #replyFor(replyId: number, actor: Actor): Row {
    const row = this.db
      .prepare("SELECT m.*, t.machine_id FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ? AND m.role = 'assistant'")
      .get(replyId) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Chat reply #${replyId} not found.`, { key: "errors.chatReplyNotFound", vars: { id: replyId } });
    if (str(row.machine_id) !== actor.name) throw new HiveError("forbidden", `Chat reply #${replyId} is for ${str(row.machine_id)}, not ${actor.name}.`);
    return row;
  }

  #researchProjects(input: ResearchInput, actor: Actor): string[] {
    if (input.scope === "hub") { if (!actor.chatReply || this.#threadProjectOfReply(actor.chatReply) !== HUB_SCOPE) this.#needHubAdmin(actor, "Hub research"); return this.#projectNames().filter(p => !this.#projectState(p)); }
    if (input.scope === "service") return [input.project];
    const system = this.#systemList().find(s => s.name === input.system && s.projects.includes(input.project));
    if (!system) throw new HiveError("bad_request", "Research system must contain the service.");
    for (const p of system.projects) this.#need(actor, p, "view", `Project ${p}`);
    return system.projects;
  }

  #research(id: number): Research {
    const row = this.db.prepare("SELECT * FROM research_runs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Research #${id} not found.`);
    const q = this.db.prepare("SELECT * FROM run_requests WHERE id = ?").get(num(row.request_id)) as Row | undefined;
    const run = q?.run_id ? this.db.prepare("SELECT status, error FROM run_records WHERE machine_id = ? AND run_id = ?").get(str(q.machine_id), str(q.run_id)) as Row | undefined : undefined;
    const status: Research["status"] = row.proposal_id != null ? "done" : !q || ["expired", "rejected"].includes(str(q.status)) ? "failed" : q.status === "cancelled" || run?.status === "cancelled" ? "cancelled" : run && !["queued", "running"].includes(str(run.status)) ? "failed" : run?.status === "running" ? "running" : q.status === "accepted" ? "queued" : "pending";
    return { id, input: JSON.parse(str(row.input)), projects: JSON.parse(str(row.projects)), requestId: num(row.request_id), machineId: q ? str(q.machine_id) : JSON.parse(str(row.input)).machineId,
      runId: q ? strOrNull(q.run_id) : null, status, artifactId: row.artifact_id == null ? null : num(row.artifact_id), proposalId: row.proposal_id == null ? null : num(row.proposal_id),
      docKey: str(row.doc_key), sources: JSON.parse(str(row.sources)), recommendations: str(row.recommendations), error: strOrNull(run?.error) ?? (q?.error ? (JSON.parse(str(q.error)) as RunRequestError).message : null) };
  }

  #runRequest(id: number): RunRequest {
    const row = this.db.prepare("SELECT * FROM run_requests WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Run request #${id} not found.`, { key: "errors.runRequestNotFound", vars: { id } });
    return this.#withAllowedKinds(toRunRequest(row));
  }

  /**
   * Only a service that chose its kinds restricts the machine's pick: an unset policy sends none, so a machine's own
   * profiles (custom ones too) keep taking its hub runs as before the setting existed.
   */
  #withAllowedKinds(request: RunRequest): RunRequest {
    const own = this.#sdlcPolicy().projects[request.project]?.allowedAgentKinds;
    return own ? { ...request, allowedAgentKinds: own as AgentKind[] } : request;
  }

  /**
   * The router's choice for a new request (54c). Failures are what spec 54 counts: an implement run that failed (out of
   * quota is rate_limited, so not counted), a review asking for changes, an implement run whose MR's CI went red. A fix
   * round follows one of those, so it is not counted again. A failed review says nothing of the implementer's model.
   */
  #selection(project: string, task: Task, role: AgentRole): ModelSelection | null {
    const failures = num(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM run_records WHERE project = ? AND task_id = ?
               AND COALESCE(json_extract(plan, '$.phase'), '') != 'plan'
               AND (verdict = 'changes' OR (role = 'implement' AND (status = 'failed' OR json_extract(mr, '$.pipeline') = 'failed')))`,
          )
          .get(project, task.id) as Row
      ).n,
    );
    const router = this.#modelRouter();
    // Only a classified task tries the tier below: the learning counts tasks by their kind and size (54d). The review
    // row also routes every review run, so it is not one the learning moves.
    const trial =
      task.kind !== null && task.size !== null && task.risk !== "high" && (LEARNED_KINDS as readonly string[]).includes(task.kind) && isTrialTask(project, task.id) &&
      this.#learningOn(project) && !this.#lockedCells(project).has(`${task.kind}/${task.size}`);
    const selection = selectModel(router, project, { kind: task.kind, size: task.size, risk: task.risk, role, failures, trial });
    if (!selection) return selection;
    if (role !== "implement") return { ...selection, diffReview: diffReviewSelection(router) };
    return { ...selection, diffReview: diffReviewSelection(router), review: selectModel(router, project, { kind: task.kind, size: task.size, risk: task.risk, role: "review" }) };
  }

  #command(id: number): MachineCommand {
    const row = this.db.prepare("SELECT * FROM machine_commands WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Command #${id} not found.`, { key: "errors.commandNotFound", vars: { id } });
    return toCommand(row);
  }

  /** A merge the machine never reported on: gone offline, stopped taking runs from the hub, or an app older than 18c. */
  #expireMerges(): void {
    const error: RunRequestError = { message: "The machine did not merge in time.", key: "errors.mergeExpired" };
    this.db
      .prepare("UPDATE run_records SET merge_status = 'failed', merge_error = ?, merge_done_at = ? WHERE merge_status = 'pending' AND merge_at < ?")
      .run(JSON.stringify(error), this.#now(), this.#now(-MERGE_TTL_MINUTES));
  }

  #mergeQueue(project: string, landing?: Pick<MergeQueueItem, "taskId" | "branch" | "runId" | "machineId">): MergeQueueView {
    const setting = this.db.prepare('SELECT value FROM settings WHERE key=?').get(`mergeQueue:${project}`) as Row | undefined;
    const config = mergeQueueConfigSchema.parse(setting ? JSON.parse(str(setting.value)) : project === "xdev-hive" ? { commands: HIVE_GATE_COMMANDS } : {});
    const batches = (this.db.prepare('SELECT body FROM merge_batches WHERE project=? ORDER BY id DESC LIMIT 50').all(project) as Row[]).map(r => JSON.parse(str(r.body)) as MergeBatch);
    const waiting = (this.db.prepare(`SELECT t.id, r.branch, r.run_id, r.machine_id, COALESCE(r.finished_at,t.updated_at) AS ready_at
      FROM tasks t JOIN run_records r ON r.task_id=t.id AND r.project=t.project
      WHERE t.project=? AND t.status='review' AND r.status='succeeded' AND r.branch IS NOT NULL AND r.branch!=''
      AND r.rowid=(SELECT r2.rowid FROM run_records r2 WHERE r2.task_id=t.id AND r2.project=t.project ORDER BY r2.created_at DESC,r2.rowid DESC LIMIT 1)
      -- The latest run itself must be an approving review: an older approval does not cover work pushed after it.
      AND r.role='review' AND r.verdict='approve'
      AND NOT EXISTS (SELECT 1 FROM merge_batch_items i WHERE i.task_id=t.id AND i.machine_id=r.machine_id AND i.run_id=r.run_id)
      ORDER BY ready_at,t.id`).all(project) as Row[]).map(r => ({taskId: str(r.id), branch: str(r.branch), runId: str(r.run_id), machineId: str(r.machine_id), readyAt: str(r.ready_at)}));
    // The visible batch history is capped; resolve close evidence against the indexed item regardless of age.
    const landed = landing ? (() => {
      const row = this.db.prepare(`SELECT b.body FROM merge_batch_items i JOIN merge_batches b ON b.id=i.batch_id
        WHERE b.project=? AND i.task_id=? AND i.machine_id=? AND i.run_id=?`).get(project, landing.taskId, landing.machineId, landing.runId) as Row | undefined;
      if (!row) return false;
      const batch = JSON.parse(str(row.body)) as MergeBatch;
      return batch.status === "landed" && batch.items.some(item => item.taskId === landing.taskId && item.branch === landing.branch && item.runId === landing.runId && item.machineId === landing.machineId)
        && !!batch.result?.outcomes.some(outcome => outcome.taskId === landing.taskId && outcome.status === "included");
    })() : undefined;
    return { config, waiting, batches, ...(landing ? { landed } : {}) };
  }

  /** Repair branches carry the excluded work; landing one also closes its unchanged source tasks. */
  #landMergeRepairs(repairTask: string, project: string, note: string, actor: Actor, now: string): void {
    const pending = [repairTask];
    const seen = new Set<string>();
    while (pending.length) {
      const repair = pending.shift()!;
      if (seen.has(repair)) continue;
      seen.add(repair);
      const sources = this.db.prepare("SELECT * FROM merge_repairs WHERE project=? AND repair_task=?").all(project, repair) as Row[];
      for (const source of sources) {
        const taskId = str(source.task_id);
        const task = this.#getTask(taskId);
        if (task?.status !== "blocked" || !task.note?.includes(repair)) continue;
        const latest = this.db.prepare("SELECT machine_id,run_id FROM run_records WHERE project=? AND task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(project, taskId) as Row | undefined;
        if (latest?.machine_id !== source.machine_id || latest?.run_id !== source.run_id) continue;
        this.db.prepare("UPDATE tasks SET status='done',note=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(note, now, taskId);
        this.#keepNote(taskId, note, "done", actor, now);
        this.#journalTask(taskId);
        pending.push(taskId);
      }
    }
  }

  #saveMergeBatch(batch: MergeBatch): void {
    this.db.prepare('UPDATE merge_batches SET status=?,body=? WHERE id=?').run(batch.status, JSON.stringify(batch), batch.id);
  }

  #ownedMergeBatch(id: number, instance: string, actor: Actor): MergeBatch {
    const row = this.db.prepare('SELECT body FROM merge_batches WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new HiveError('not_found', 'No merge batch.');
    const batch = JSON.parse(str(row.body)) as MergeBatch;
    this.#need(actor, batch.project, 'taskWork', 'Merge batch');
    if (batch.machineId !== actor.name || batch.instance !== instance) throw new HiveError('forbidden', 'Only the gate instance holding this batch may report it.');
    return batch;
  }

  #toMachine(r: Row): Machine {
    const dup = strOrNull(r.duplicate_at);
    return {
      id: str(r.id),
      machine: str(r.machine),
      version: str(r.version),
      lastSeen: str(r.last_seen),
      online: str(r.last_seen) > this.#now(-ONLINE_MINUTES),
      duplicate: dup !== null && dup > this.#now(-DUPLICATE_MINUTES),
      runs: JSON.parse(str(r.runs)) as MachineRun[],
      profiles: JSON.parse(str(r.profiles ?? "[]")) as ReportedProfile[],
      projects: JSON.parse(str(r.projects ?? "[]")) as string[],
      acceptsRuns: num(r.accepts_runs ?? 0) === 1,
      gateRunner: num(r.gate_runner ?? 0) === 1,
      maxParallel: r.max_parallel == null ? undefined : num(r.max_parallel),
      runnerSettings: r.runner_settings == null ? undefined : JSON.parse(str(r.runner_settings)) as MachineRunnerSettings,
      runnerChange: r.runner_change == null ? null : JSON.parse(str(r.runner_change)) as RunnerChange,
      owner: strOrNull(r.owner),
      profileChanges: this.#profileChanges(str(r.id)),
    };
  }

  #mayApproveTool(actor: Actor, owner: string | null): boolean {
    return actor.role !== "agent" && !isAgentActor(actor) &&
      ((actor.role === "admin" && !actor.access) || (!!actor.account && actor.account === owner));
  }

  #toolApproval(r: Row): ToolApproval & { appliedAt: string | null } {
    return { id: str(r.id), toolId: str(r.tool_id), hash: str(r.hash), approvedBy: str(r.approved_by), approvedAt: str(r.approved_at), appliedAt: strOrNull(r.applied_at) };
  }

  #machineToolAccess(machineId: string, actor: Actor): MachineToolAccess {
    const r = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    if (!r) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
    const states = JSON.parse(str(r.tool_states ?? "[]")) as MachineToolState[];
    const approvals = (this.db.prepare("SELECT * FROM machine_tool_approvals WHERE machine_id = ?").all(machineId) as Row[]).map((a) => this.#toolApproval(a));
    const tools = states.flatMap((state) => {
      const row = this.db.prepare("SELECT * FROM tools WHERE id = ?").get(state.id) as Row | undefined;
      if (!row) return [];
      const entry = { id: state.id, ...JSON.parse(str(row.entry)) } as ToolEntry;
      const hash = toolHash(entry);
      return [{ ...state, hash, trust: state.hash === hash ? state.trust : "changed" as const, entry, approval: approvals.find((a) => a.toolId === state.id && a.hash === hash) ?? null }];
    });
    return { supported: r.tool_states != null, canApprove: this.#mayApproveTool(actor, strOrNull(r.owner)), tools };
  }

  #worktreeCommands(machineId: string, pending = false): WorktreeCommand[] {
    const rows = pending ? this.db.prepare("SELECT * FROM machine_worktree_commands WHERE machine_id = ? AND completed_at IS NULL AND json_extract(command, '$.requestedAt') > ? ORDER BY rowid LIMIT 100").all(machineId, this.#now(-24 * 60))
      : this.db.prepare("SELECT * FROM machine_worktree_commands WHERE machine_id = ? ORDER BY rowid DESC LIMIT 100").all(machineId);
    return (rows as Row[])
      .map(r => ({ ...JSON.parse(str(r.command)), completedAt: strOrNull(r.completed_at), results: JSON.parse(str(r.results)) }));
  }

  #machineWorktrees(machineId: string, actor: Actor): MachineWorktrees {
    const r = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    if (!r) throw new HiveError("not_found", "Machine not found.", { key: "errors.machineNotFound", vars: { machine: machineId } });
    if (!this.#mayApproveTool(actor, strOrNull(r.owner))) throw new HiveError("forbidden", "Only the human machine owner or hub admin manages worktrees.", { key: "errors.worktreeForbidden" });
    const stored = r.worktrees == null ? null : JSON.parse(str(r.worktrees)) as WorktreeReport;
    const report = stored ? { ...stored, entries: stored.entries.filter(e => sees(actor, e.project)), logs: stored.logs.filter(e => sees(actor, e.project)), errors: stored.errors.filter(e => sees(actor, e.split(":")[0]!)) } : null;
    if (report) report.totalBytes = report.entries.reduce((n, e) => n + (e.bytes ?? 0), 0);
    const commands = this.#worktreeCommands(machineId).map(c => ({ ...c, targets: c.targets.filter(t => sees(actor, t.project)), results: c.results.filter(r => !r.path || c.targets.some(t => t.path === r.path && sees(actor, t.project))) }));
    return { supported: report !== null, canManage: true, report, commands };
  }

  #profileChanges(machineId: string): ProfileChange[] {
    return (this.db.prepare("SELECT * FROM machine_profile_changes WHERE machine_id = ? ORDER BY profile_id").all(machineId) as Row[]).map(toProfileChange);
  }

  /** Machines that reported a repo for the project at their last heartbeat, the most recently seen first. */
  #machinesWith(project: string): Machine[] {
    return (this.db.prepare("SELECT * FROM machines ORDER BY last_seen DESC").all() as Row[])
      .map((r) => this.#toMachine(r))
      .filter((m) => m.projects.includes(project));
  }

  #buildHandlers(): Handlers {
    const db = this.db;
    return {
      "docs.list": ({ project, scope }) => {
        // A project's list has its systems' docs too (roadmap 19c): what its agents and its sync read.
        const rows = db
          .prepare(
            `SELECT key, scope, project, title, version, include_in_agents, paths, parent, folder, updated_by, updated_at FROM docs
             WHERE removed_at IS NULL AND (?1 IS NULL OR scope = ?1) AND (?2 IS NULL OR scope = 'org' OR project = ?2 OR project IN (SELECT value FROM json_each(?3)))
             ORDER BY scope, project, key`,
          )
          .all(scope ?? null, project ?? null, JSON.stringify(this.#systemOwnersOf([project]))) as Row[];
        return rows.map(toSummary);
      },

      // A key a page used to have leads to where it is now (roadmap 38g), but only for someone who may see it there.
      "docs.get": ({ key }, actor) => {
        const doc = this.#getDoc(key);
        if (doc) return doc;
        const moved = this.#redirects().get(key);
        const at = moved ? this.#getDoc(moved) : null;
        return at && sees(actor, at.project) ? at : null;
      },

      "skills.list": ({ project }, actor) => {
        const now = Date.parse(this.#now());
        const day = 86400000;
        const monday = new Date(now);
        monday.setUTCHours(0, 0, 0, 0);
        monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
        const hidden = this.#projectStates();
        const records = (db.prepare("SELECT project, skills, COALESCE(started_at, created_at) AS at FROM run_records WHERE skills != '[]' AND (? IS NULL OR project = ?)").all(project ?? null, project ?? null) as Row[])
          .filter((r) => sees(actor, str(r.project)) && (project === r.project || !hidden.has(str(r.project))));
        const rows = db
          .prepare(
            `SELECT key, scope, project, content, version, updated_by, updated_at FROM docs
             WHERE key LIKE '%/skills/%' AND removed_at IS NULL AND (?1 IS NULL OR scope = 'org' OR project = ?1)
             ORDER BY scope, project, key`,
          )
          .all(project ?? null) as Row[];
        const all = rows.map((r): SkillSummary => {
          const parsed = parseDocKey(str(r.key));
          let description = "";
          try {
            description = parseSkill(str(r.content)).description;
          } catch {
            // saved before it was checked: listed without a description
          }
          return {
            key: str(r.key),
            name: parsed.slug,
            description,
            scope: parsed.scope,
            project: parsed.project,
            version: num(r.version),
            updatedBy: str(r.updated_by),
            updatedAt: str(r.updated_at),
          };
        });
        const overrides = new Set(all.filter((s) => s.project).map((s) => `${s.project}/${s.name}`));
        const loads = records.map((r) => ({ project: str(r.project), at: str(r.at), skills: new Set(JSON.parse(str(r.skills)) as string[]) }));
        for (const skill of all) {
          const weeks = Array.from({ length: 8 }, (_, i) => ({ start: new Date(monday.getTime() - (7 - i) * 7 * day).toISOString(), runs: 0 }));
          let runs30d = 0;
          let lastUsedAt: string | null = null;
          for (const r of loads) {
            if (skill.project ? r.project !== skill.project : overrides.has(`${r.project}/${skill.name}`)) continue;
            if (!r.skills.has(skill.name)) continue;
            const time = Date.parse(r.at);
            if (!Number.isFinite(time) || time > now) continue;
            const at = new Date(time).toISOString();
            if (!lastUsedAt || at > lastUsedAt) lastUsedAt = at;
            if (time >= now - 30 * day) runs30d++;
            const week = weeks.find((w) => time >= Date.parse(w.start) && time < Date.parse(w.start) + 7 * day);
            if (week) week.runs++;
          }
          skill.usage = { runs30d, lastUsedAt, weeks };
        }
        if (!project) return all;
        // The project's own skill replaces the team's of the same name.
        const own = new Set(all.filter((s) => s.project === project).map((s) => s.name));
        return all.filter((s) => s.project === project || !own.has(s.name)).sort((a, b) => a.name.localeCompare(b.name));
      },

      "docs.history": ({ key }) =>
        (db.prepare("SELECT * FROM doc_versions WHERE key = ? ORDER BY version DESC").all(key) as Row[]).map(toVersion),

      "docs.save": (input, actor) =>
        this.#tx(() => {
          const current = this.#getDoc(input.key)?.version ?? 0;
          if (input.baseVersion !== undefined && input.baseVersion !== current) {
            throw new HiveError(
              "conflict",
              `${input.key} is at v${current} but you edited v${input.baseVersion}. Reload and re-apply your changes.`,
              { key: "errors.docConflict", vars: { key: input.key, current, base: input.baseVersion } },
            );
          }
          return this.#writeDoc(input.key, input.content, input, actor.name, actor.source);
        }),

      "docs.move": ({ key, parent, to }, actor) =>
        this.#tx(() => {
          const doc = this.#getDoc(key);
          if (!doc || doc.removedAt) throw new HiveError("not_found", `Doc ${key} not found.`, { key: "errors.notFound" });
          // A tree operation must be authorized in full before any page is changed.
          for (const k of [key, ...this.#under(key, () => true)]) {
            this.#need(actor, SqliteHive.#docOwner(k), this.#docPermission(k), `Doc ${k}`);
          }
          const moved: Array<{ from: string; to: string }> = [];
          if (to && to !== key) {
            const space = parseDocKey(to);
            this.#assertSystem(space.project);
            // A mirrored page is written from its repo: moved here, the next mirror would only make it again at the old key.
            if (doc.mirror) {
              throw new HiveError("bad_request", `${key} is mirrored from ${doc.mirror.from}: move it in the repo it comes from.`, {
                key: "errors.docMirrorMove",
                vars: { key, from: doc.mirror.from },
              });
            }
            // A page does not become a skill (or stop being one) by being given another key: skills are checked on save.
            if (parseDocKey(key).skill !== space.skill) {
              throw new HiveError("bad_request", "Skills stay in the skills folder: a page does not become one by moving.", { key: "errors.docMoveSkill", vars: { key, to } });
            }
            // The tree goes as one: a page may only sit under a page of its own space, so what is under it moves too.
            // Removed pages under it come along as well, keeping their removal, so restoring one later still lands right.
            const under = this.#under(key, () => true).map((k) => ({ from: k, to: SqliteHive.#keyIn(k, space) }));
            // A rename inside one space leaves the pages under it where they are: their own key does not change.
            moved.push({ from: key, to }, ...under.filter((p) => p.from !== p.to));
            for (const { from, to: target } of moved) {
              const level = this.#docPermission(from) === "contextEdit" || this.#docPermission(target, this.#getDoc(from)!) === "contextEdit" ? "contextEdit" : "docEdit";
              this.#need(actor, SqliteHive.#docOwner(from), level, `Doc ${from}`);
              this.#need(actor, SqliteHive.#docOwner(target), level, `Doc ${target}`);
            }
            this.#rekey(moved, actor, this.#now());
            // Out of the space it left: a page keeps no parent there.
            if (space.project !== doc.project && parent === undefined) db.prepare("UPDATE docs SET parent = NULL WHERE key = ?").run(to);
          }
          const at = to ?? key;
          if (parent !== undefined) {
            if (parent) this.#checkParent(at, parent);
            db.prepare("UPDATE docs SET parent = ? WHERE key = ?").run(parent, at);
          }
          const { content: _content, ...summary } = this.#getDoc(at)!;
          return { ...summary, moved };
        }),

      "docs.remove": ({ key, note }, actor) =>
        this.#tx(() => {
          const doc = this.#getDoc(key);
          if (!doc || doc.removedAt) throw new HiveError("not_found", `Doc ${key} not found.`, { key: "errors.notFound" });
          const keys = [key, ...this.#under(key, (p) => !p.removedAt)];
          for (const k of keys) this.#need(actor, SqliteHive.#docOwner(k), this.#docPermission(k), `Doc ${k}`);
          // A mirrored page is written from its repo: removing it here would only have the next mirror write it again.
          for (const k of keys) {
            const mirror = this.#getDoc(k)?.mirror;
            if (mirror) {
              throw new HiveError("bad_request", `${k} is mirrored from ${mirror.from}: remove it in the repo it comes from.`, {
                key: "errors.docMirrorRemove",
                vars: { key: k, from: mirror.from },
              });
            }
          }
          // One number for the whole removal, so a restore can put back exactly what this call took.
          const now = this.#now();
          const op = num((db.prepare("SELECT COALESCE(MAX(removed_op), 0) + 1 AS n FROM docs").get() as Row).n);
          const mark = db.prepare("UPDATE docs SET removed_at = ?, removed_by = ?, removed_note = ?, removed_op = ? WHERE key = ?");
          for (const k of keys) mark.run(now, actor.name, note ?? null, op, k);
          return { keys };
        }),

      "docs.restore": ({ key }, actor) =>
        this.#tx(() => {
          const doc = this.#getDoc(key);
          if (!doc) throw new HiveError("not_found", `Doc ${key} not found.`, { key: "errors.notFound" });
          if (!doc.removedAt) throw new HiveError("conflict", `${key} is not removed.`, { key: "errors.docNotRemoved", vars: { key } });
          // Its system may have been removed while the page was gone: it would come back where no one can see it.
          this.#assertSystem(doc.project);
          // Under a page that is still removed it would be out of reach: that one comes back first.
          if (doc.parent && this.#getDoc(doc.parent)?.removedAt) {
            throw new HiveError("conflict", `${doc.parent} is removed too: restore it first.`, { key: "errors.docParentRemoved", vars: { key, parent: doc.parent } });
          }
          const op = num((db.prepare("SELECT removed_op AS n FROM docs WHERE key = ?").get(key) as Row).n);
          const keys = [key, ...this.#under(key, (p) => p.removedOp === op)];
          for (const k of keys) this.#need(actor, SqliteHive.#docOwner(k), this.#docPermission(k), `Doc ${k}`);
          const back = db.prepare("UPDATE docs SET removed_at = NULL, removed_by = NULL, removed_note = NULL, removed_op = NULL WHERE key = ?");
          for (const k of keys) back.run(k);
          return { keys };
        }),

      "docs.removed": ({ project }) =>
        (
          db
            .prepare(
              `SELECT key, scope, project, title, version, include_in_agents, paths, parent, folder, mirror,
                      removed_at, removed_by, removed_note, updated_by, updated_at FROM docs
               WHERE removed_at IS NOT NULL AND (?1 IS NULL OR project = ?1)
               ORDER BY removed_at DESC, key`,
            )
            .all(project ?? null) as Row[]
        ).map(toSummary),

      "docs.links": ({ key }, actor) => {
        const rows = db.prepare("SELECT key, title, content FROM docs WHERE removed_at IS NULL").all() as Row[];
        const titles = new Map(rows.map((r) => [str(r.key), str(r.title)]));
        // A key a page used to have counts as a link that works: it leads to where the page is now (roadmap 38g).
        const where = this.#redirects();
        const at = (k: string) => (titles.has(k) ? k : (where.get(k) ?? k));
        const exists = (k: string) => titles.has(at(k));
        const seen = (k: string) => sees(actor, SqliteHive.#docOwner(k));
        const doc = rows.find((r) => str(r.key) === key);
        const out: DocLinks["out"] = [];
        for (const ref of docLinkRefs(doc ? str(doc.content) : "")) {
          const hit = resolveDocLink(ref.target, key, exists);
          if (!hit) continue;
          const target = hit.exists ? at(hit.key) : hit.key;
          if ((hit.exists && !seen(target)) || out.some((o) => o.key === target)) continue;
          out.push({ target: ref.target, key: target, title: hit.exists ? titles.get(target)! : null, exists: hit.exists });
        }
        const back: DocLinks["back"] = [];
        for (const r of rows) {
          const from = str(r.key);
          if (from === key || !seen(from)) continue;
          const text = str(r.content);
          if (!text.includes("[[")) continue;
          if (docLinkRefs(text).some((ref) => at(resolveDocLink(ref.target, from, exists)?.key ?? "") === key)) {
            back.push({ key: from, title: str(r.title), snippet: linkSnippet(text, from, key, exists, (k) => titles.get(k), at) });
          }
        }
        // Memory that names the page by its key (current entries only).
        const memory = (
          db
            .prepare("SELECT id, project, content FROM memory WHERE instr(content, ?) > 0 AND superseded_by IS NULL ORDER BY id DESC LIMIT 20")
            .all(key) as Row[]
        )
          .map((r) => ({ id: num(r.id), project: str(r.project) === SHARED ? null : str(r.project), content: str(r.content) }))
          .filter((m) => sees(actor, m.project))
          .slice(0, 8);
        return { out, back: back.sort((a, b) => a.title.localeCompare(b.title)), memory };
      },

      "docs.assist": (input, actor) => {
        const owner = SqliteHive.#docOwner(input.key);
        assertNoHidden(input.prompt, "Prompt");
        assertNoSecret(input.prompt, "Prompt");
        assertNoSecret(input.content, "Page");
        const parts: string[] = [];
        const sources = ["page"];
        let room = ASSIST_CONTEXT_CHARS;
        const add = (text: string) => {
          const cut = text.slice(0, room);
          room -= cut.length;
          if (cut) parts.push(cut);
        };
        for (const k of [...new Set(input.docs)].filter((k) => k !== input.key)) {
          const o = SqliteHive.#docOwner(k);
          // Only what the person sees, of the page's own space or the team's.
          if ((o !== null && o !== owner) || !sees(actor, o)) continue;
          const d = this.#getDoc(k);
          if (!d) continue;
          sources.push(`doc:${k}`);
          add(`### Tài liệu: ${d.title} (${k})\n${d.content.slice(0, ASSIST_DOC_CHARS)}\n`);
        }
        for (const mid of [...new Set(input.memory)]) {
          const r = db.prepare("SELECT id, project, kind, content FROM memory WHERE id = ?").get(mid) as Row | undefined;
          if (!r) continue;
          const p = str(r.project) === SHARED ? null : str(r.project);
          if ((p !== null && p !== owner) || !sees(actor, p)) continue;
          sources.push(`memory:${mid}`);
          add(`### Memory #${mid} (${str(r.kind)})\n${str(r.content)}\n`);
        }
        const code = [...new Set(input.code.map((c) => c.trim()).filter((c) => c && !c.startsWith("/") && !c.split("/").includes("..")))];
        // Files are read on the machine, from the project's repo: a team page has none.
        if (owner) for (const c of code) sources.push(`code:${c}`);
        const now = this.#now();
        const id = num(
          db
            .prepare(
              `INSERT INTO doc_assists(doc_key, project, kind, prompt, sources, context, code, base, status, requested_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
            )
            .run(input.key, owner, input.kind, input.prompt, JSON.stringify(sources), parts.join("\n"), JSON.stringify(owner ? code : []), input.content, actor.name, now, now).lastInsertRowid,
        );
        return toAssist(db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(id) as Row);
      },

      "docs.assists": ({ key }, actor) => {
        this.#expireAssists();
        const rows = db.prepare("SELECT * FROM doc_assists WHERE doc_key = ? AND requested_by = ? ORDER BY id DESC LIMIT 30").all(key, actor.name) as Row[];
        return rows.reverse().map(toAssist);
      },

      "docs.assistCancel": ({ id: aid }, actor) => {
        const row = db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(aid) as Row | undefined;
        if (!row) throw new HiveError("not_found", `No ask #${aid}.`, { key: "errors.notFound" });
        if (str(row.requested_by) !== actor.name) this.#need(actor, SqliteHive.#docOwner(str(row.doc_key)), "docEdit", `Ask #${aid}`);
        db.prepare("UPDATE doc_assists SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'running')").run(this.#now(), aid);
        return toAssist(db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(aid) as Row);
      },

      "docs.assistSettle": ({ id: aid, outcome }, actor) => {
        const row = db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(aid) as Row | undefined;
        if (!row || str(row.requested_by) !== actor.name) throw new HiveError("not_found", `No ask #${aid}.`, { key: "errors.notFound" });
        db.prepare("UPDATE doc_assists SET outcome = ? WHERE id = ?").run(outcome, aid);
        return toAssist(db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(aid) as Row);
      },

      "docs.assistTake": ({ projects, machine }, actor) =>
        this.#tx(() => {
          this.#expireAssists();
          const m = db.prepare("SELECT machine, accepts_runs FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
          if (!this.#opts.local && !(m && num(m.accepts_runs) === 1)) return null;
          const have = new Set(projects);
          const rows = db.prepare("SELECT * FROM doc_assists WHERE status = 'pending' ORDER BY id LIMIT 50").all() as Row[];
          const row = rows.find((r) => {
            const p = strOrNull(r.project);
            return (p === null || have.has(p)) && sees(actor, p);
          });
          if (!row) return null;
          const label = machine?.trim() || (m ? str(m.machine) : actor.name);
          db.prepare("UPDATE doc_assists SET status = 'running', taken_by = ?, machine = ?, updated_at = ? WHERE id = ?").run(actor.name, label, this.#now(), row.id as number);
          const taken = db.prepare("SELECT * FROM doc_assists WHERE id = ?").get(row.id as number) as Row;
          const key = str(taken.doc_key);
          return {
            ...toAssist(taken),
            title: this.#getDoc(key)?.title ?? titleFromSlug(parseDocKey(key).slug),
            context: str(taken.context),
            code: JSON.parse(str(taken.code)) as string[],
          } satisfies DocAssistJob;
        }),

      "docs.assistProgress": ({ id: aid }, actor) => {
        const row = this.#assistFor(aid, actor);
        if (str(row.status) === "running") db.prepare("UPDATE doc_assists SET updated_at = ? WHERE id = ?").run(this.#now(), aid);
        return { cancelled: str(row.status) === "cancelled" };
      },

      "docs.assistFinish": ({ id: aid, status, reply, markdown, profile, costUsd, error }, actor) => {
        const row = this.#assistFor(aid, actor);
        if (str(row.status) !== "running") return { ok: false };
        db.prepare("UPDATE doc_assists SET status = ?, reply = ?, markdown = ?, profile = ?, cost_usd = ?, error = ?, updated_at = ? WHERE id = ?").run(
          status,
          clean(reply),
          clean(markdown),
          profile,
          costUsd,
          error ? JSON.stringify(cleanMachineError(error)) : null,
          this.#now(),
          aid,
        );
        return { ok: true };
      },

      "docs.context": ({ project }, actor) => {
        // As docs.list gives a project's sync: its own, the team's and its systems' (roadmap 19c).
        const docs = (
          db.prepare("SELECT * FROM docs WHERE removed_at IS NULL AND (project IS NULL OR project = ? OR project IN (SELECT value FROM json_each(?)))").all(project, JSON.stringify(this.#systemOwnersOf([project]))) as Row[]
        ).map(toDoc).filter((d) => sees(actor, d.project));
        const staleBefore = this.#staleBefore();
        const count = (p: string, status: string, stale?: boolean) =>
          (db.prepare("SELECT created_at, last_used_at FROM memory WHERE project = ? AND status = ? AND superseded_by IS NULL").all(p, status) as Row[]).filter(
            (r) => stale === undefined || (staleBefore !== null && (strOrNull(r.last_used_at) ?? str(r.created_at)) < staleBefore) === stale,
          ).length;
        return {
          ...describeProjectContext(project, docs),
          memory: {
            project: count(project, "approved", false),
            shared: sees(actor, null) ? count(SHARED, "approved", false) : 0,
            stale: count(project, "approved", true) + (sees(actor, null) ? count(SHARED, "approved", true) : 0),
            pending: count(project, "pending") + (sees(actor, null) ? count(SHARED, "pending") : 0),
          },
        };
      },

      // Offline machines get none: they would sync whenever they come back, long after the person who asked looked.
      "docs.syncRequest": ({ project }, actor) =>
        this.#tx(() => {
          this.#expireCommands();
          const itemId = syncItemId(project);
          const now = this.#now();
          const out: MachineCommand[] = [];
          for (const m of this.#machinesWith(project)) {
            if (!m.online) continue;
            const open = db
              .prepare("SELECT id FROM machine_commands WHERE machine_id = ? AND item_id = ? AND status IN ('pending', 'running')")
              .get(m.id, itemId) as Row | undefined;
            if (open) {
              out.push(this.#command(num(open.id)));
              continue;
            }
            const res = db
              .prepare(
                "INSERT INTO machine_commands(machine_id, kind, item_id, project, label, requested_by, requested_at, updated_at) VALUES (?, 'sync', ?, ?, ?, ?, ?, ?)",
              )
              .run(m.id, itemId, project, `sync ${project}`, actor.name, now, now);
            out.push(this.#command(num(res.lastInsertRowid)));
          }
          return out;
        }),

      "docs.syncStatus": ({ project }) => {
        this.#expireCommands();
        return this.#machinesWith(project).map((m): ProjectSyncState => {
          const row = db
            .prepare("SELECT * FROM machine_commands WHERE machine_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1")
            .get(m.id, syncItemId(project)) as Row | undefined;
          return { machineId: m.id, machine: m.machine, online: m.online, version: m.version, last: row ? toCommand(row) : null };
        });
      },

      "docs.assets": ({ key }) => (db.prepare(`SELECT ${ASSET_FIELDS} FROM doc_assets WHERE doc_key = ? ORDER BY name`).all(key) as Row[]).map(toAsset),

      "docs.assetGet": async ({ key, name }) => {
        const row = db.prepare("SELECT * FROM doc_assets WHERE doc_key = ? AND name = ?").get(key, name) as Row | undefined;
        if (!row) return null;
        const bytes = row.stored === null || row.stored === undefined ? (row.data as Uint8Array) : await this.#fromStore(row);
        return { asset: toAsset(row), data: Buffer.from(bytes).toString("base64") };
      },

      "docs.assetPut": async ({ key, name: raw, data }, actor) => {
        parseDocKey(key);
        const name = chatFileName(raw);
        const bytes = new Uint8Array(Buffer.from(data, "base64"));
        if (bytes.length > DOC_ASSET_MAX_BYTES) {
          throw new HiveError("bad_request", `${name} is over ${DOC_ASSET_MAX_BYTES / 1024 / 1024} MB.`, { key: "errors.chatFileTooBig", vars: { name, mb: DOC_ASSET_MAX_BYTES / 1024 / 1024 } });
        }
        const type = checkChatFile(name, bytes);
        if (!isImage(type) && type !== "application/pdf") assertNoSecret(new TextDecoder().decode(bytes), name);
        const allowed = () => {
          const has = db.prepare("SELECT uploaded_by FROM doc_assets WHERE doc_key = ? AND name = ?").get(key, name) as Row | undefined;
          // Replacing someone else's file is removing it: manage only.
          if (has && str(has.uploaded_by) !== actor.name) this.#need(actor, SqliteHive.#docOwner(key), "docEdit", `File ${name}`);
          const count = num((db.prepare("SELECT COUNT(*) AS n FROM doc_assets WHERE doc_key = ?").get(key) as Row).n);
          if (!has && count >= DOC_ASSETS_PER_DOC) {
            throw new HiveError("bad_request", `${key} already has ${DOC_ASSETS_PER_DOC} files.`, { key: "errors.docAssetsFull", vars: { key, max: DOC_ASSETS_PER_DOC } });
          }
        };
        const blobs = this.#opts.blobs;
        const sha = sha256(bytes);
        // Into the store first (checked before, so no one uploads what they may not keep), the row after: a row never
        // points at bytes the store does not have. Checked again in the transaction, as the doc may have changed.
        if (blobs) {
          allowed();
          await this.#toStore(blobs, sha, bytes, type);
        }
        const { asset, dropped } = this.#tx(() => {
          allowed();
          const before = db.prepare("SELECT sha256, stored FROM doc_assets WHERE doc_key = ? AND name = ?").get(key, name) as Row | undefined;
          db.prepare(
            `INSERT INTO doc_assets(doc_key, name, type, size, data, uploaded_by, created_at, sha256, stored) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(doc_key, name) DO UPDATE SET type = excluded.type, size = excluded.size, data = excluded.data,
               uploaded_by = excluded.uploaded_by, created_at = excluded.created_at, sha256 = excluded.sha256, stored = excluded.stored`,
          ).run(key, name, type, bytes.length, blobs ? new Uint8Array(0) : bytes, actor.name, this.#now(), sha, blobs ? blobs.name : null);
          return {
            asset: toAsset(db.prepare(`SELECT ${ASSET_FIELDS} FROM doc_assets WHERE doc_key = ? AND name = ?`).get(key, name) as Row),
            dropped: before?.stored && before.sha256 !== sha ? str(before.sha256) : null,
          };
        });
        if (dropped) await this.#dropBlob(dropped);
        return asset;
      },

      "docs.assetRemove": async ({ key, name }, actor) => {
        const row = db.prepare("SELECT uploaded_by, sha256, stored FROM doc_assets WHERE doc_key = ? AND name = ?").get(key, name) as Row | undefined;
        if (!row) return { removed: false };
        if (str(row.uploaded_by) !== actor.name) this.#need(actor, SqliteHive.#docOwner(key), "docEdit", `File ${name}`);
        db.prepare("DELETE FROM doc_assets WHERE doc_key = ? AND name = ?").run(key, name);
        if (row.stored) await this.#dropBlob(str(row.sha256));
        return { removed: true };
      },

      // A run's files (roadmap 41c), from the machine that ran it. Secrets and hidden characters are the hub's own
      // check of what it keeps, as for a run's log and patch: the machine already looked, this is the second look.
      "artifacts.put": (i, actor) => this.#putArtifact(i, actor),

      "evidence.tasks": ({ project, specDir, specBranch }, actor) => {
        const root = /^ai\/(.+)$/.exec(specBranch)?.[1] ?? null;
        const prefix = `${specTaskPrefix(specDir)}-`;
        // Filter before returning rows: older feature tasks must survive the general board's 500-row cap.
        const rows = db.prepare(`SELECT t.* FROM tasks t WHERE t.project = ?1 AND (
          t.id = ?2 OR substr(t.id, 1, length(?3)) = ?3 OR
          EXISTS (SELECT 1 FROM sdlc_flows f WHERE f.project = ?1 AND f.task_id = t.id AND f.dir = ?4) OR
          EXISTS (SELECT 1 FROM sdlc_flow_tasks ft JOIN sdlc_flows f ON f.task_id = ft.flow_task
            WHERE ft.task_id = t.id AND f.project = ?1 AND (f.dir = ?4 OR f.task_id = ?2)))
          ORDER BY t.updated_at DESC, t.id DESC`).all(project, root, prefix, specDir) as Row[];
        return this.#tasks(rows).map(task => hideDeps(task, p => sees(actor, p)));
      },
      "evidence.context": ({ project, taskId, specDir, specBranch }) => {
        const row = db.prepare("SELECT files, commit_sha FROM spec_features WHERE project = ? AND dir = ? AND branch = ?").get(project, specDir, specBranch) as Row | undefined;
        const spec = row ? (JSON.parse(str(row.files)) as SpecFiles).spec : null;
        if (!row || spec === null || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(str(row.commit_sha))) return null;
        return { project, taskId, specDir, specBranch, specHash: sha256(new TextEncoder().encode(spec)), commitSha: str(row.commit_sha), specText: spec };
      },
      "evidence.record": (input, actor) => {
        assertNoSecret(input.criterionId, "Acceptance criterion identifier");
        const source = db.prepare("SELECT files, commit_sha FROM spec_features WHERE project = ? AND dir = ? AND branch = ?").get(input.project, input.specDir, input.specBranch) as Row | undefined;
        const spec = source ? (JSON.parse(str(source.files)) as SpecFiles).spec : null;
        if (!source || spec === null || source.commit_sha !== input.commitSha || sha256(new TextEncoder().encode(spec)) !== input.specHash) {
          throw new HiveError("conflict", "The published specification or code revision has changed. Reload before verifying.", { key: "errors.evidenceRevisionChanged" });
        }
        if (!featureChecks(spec).some(criterion => criterion.id === input.criterionId && criterion.text === input.criterion)) {
          throw new HiveError("bad_request", "This criterion is not in the published specification.", { key: "errors.evidenceCriterionMissing" });
        }
        assertNoSecret(input.note, "Acceptance note");
        assertNoSecret(input.criterion, "Acceptance criterion");
        const artifacts: EvidenceArtifact[] = input.artifactIds.map(id => {
          const row = db.prepare("SELECT id, project, task_id, name, sha256, run_id, machine_id FROM artifacts WHERE id = ?").get(id) as Row | undefined;
          if (!row || row.project !== input.project || row.task_id !== input.taskId) throw new HiveError("not_found", "Artifact not found in this task.", { key: "errors.notFound" });
          return { id, name: str(row.name), sha256: str(row.sha256), runId: str(row.run_id), machineId: str(row.machine_id) };
        });
        const createdAt = this.#now();
        const result = db.prepare(`INSERT INTO acceptance_evidence(project, task_id, spec_hash, commit_sha, spec_dir, spec_branch, criterion_id, criterion, outcome, note, artifacts, recorded_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.project, input.taskId, input.specHash, input.commitSha, input.specDir, input.specBranch, input.criterionId, input.criterion, input.outcome, input.note, JSON.stringify(artifacts), actor.name, createdAt);
        return { ...input, id: Number(result.lastInsertRowid), recordedBy: actor.name, createdAt, artifacts };
      },
      "evidence.list": ({ project, taskId, specHash, commitSha, specDir, specBranch, limit, offset }) => {
        const rows = db.prepare(`SELECT * FROM acceptance_evidence WHERE project = ? AND task_id = ?
          AND (? IS NULL OR spec_hash = ?) AND (? IS NULL OR commit_sha = ?)
          AND (? IS NULL OR spec_dir = ?) AND (? IS NULL OR spec_branch = ?)
          ORDER BY id DESC LIMIT ? OFFSET ?`)
          .all(project, taskId, specHash ?? null, specHash ?? null, commitSha ?? null, commitSha ?? null, specDir ?? null, specDir ?? null, specBranch ?? null, specBranch ?? null, limit, offset) as Row[];
        return rows.map(row => {
          const artifacts = JSON.parse(str(row.artifacts)) as EvidenceArtifact[];
          return { id: num(row.id), project, taskId, specHash: str(row.spec_hash), commitSha: str(row.commit_sha), specDir: str(row.spec_dir), specBranch: str(row.spec_branch), criterionId: str(row.criterion_id), criterion: str(row.criterion), outcome: str(row.outcome) as AcceptanceEvidence["outcome"], note: str(row.note), artifacts, artifactIds: artifacts.map(a => a.id), recordedBy: str(row.recorded_by), createdAt: str(row.created_at) };
        });
      },
      "artifacts.list": ({ project, projects, taskId, runId, machineId, limit, offset, name, kind }, actor) => {
        // Filter grants and archives before LIMIT/OFFSET: hidden files must never consume a visible page.
        const archived = this.#projectStates();
        const allowed = (db.prepare("SELECT DISTINCT project FROM artifacts").all() as Row[])
          .map((r) => str(r.project))
          .filter((p) => may(actor, p, "view") && (p === project || !archived.has(p)));
        return (db.prepare(
          `SELECT ${ARTIFACT_FIELDS} FROM artifacts WHERE project IN (SELECT value FROM json_each(?1))
           AND (?2 IS NULL OR project = ?2) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3)))
           AND (?4 IS NULL OR task_id = ?4) AND (?5 IS NULL OR run_id = ?5) AND (?6 IS NULL OR machine_id = ?6)
           AND (?7 IS NULL OR instr(hive_fold(name), hive_fold(?7)) > 0)
           AND (?8 IS NULL OR
             (?8 = 'markdown' AND type = 'text/markdown') OR
             (?8 = 'log' AND lower(name) LIKE '%.log') OR
             (?8 = 'json' AND type = 'application/json') OR
             (?8 = 'image' AND type LIKE 'image/%') OR
             (?8 = 'text' AND type = 'text/plain' AND lower(name) NOT LIKE '%.log') OR
             (?8 = 'pdf' AND type = 'application/pdf'))
           ORDER BY created_at DESC, id DESC LIMIT ?9 OFFSET ?10`
        ).all(JSON.stringify(allowed), project ?? null, listParam(projects), taskId ?? null, runId ?? null,
          machineId ?? null, name?.trim() || null, kind ?? null, limit, offset) as Row[]).map(toArtifact);
      },

      "artifacts.get": async ({ id, maxBytes, metadataOnly }) => {
        const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
        if (!row) return null;
        if (metadataOnly) return { artifact: toArtifact(row), data: "" };
        const bytes = row.stored === null || row.stored === undefined ? (row.data as Uint8Array) : await this.#fromStore(row);
        const truncated = maxBytes !== undefined && isArtifactText(str(row.type)) && bytes.length > maxBytes;
        let end = truncated ? maxBytes! : bytes.length;
        // Never end a preview midway through a UTF-8 character.
        if (truncated) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
        return { artifact: toArtifact(row), data: Buffer.from(bytes.subarray(0, end)).toString("base64"), ...(maxBytes === undefined ? {} : { truncated }) };
      },

      "artifacts.remove": async ({ id }) => {
        const row = db.prepare("SELECT project, name, sha256, stored FROM artifacts WHERE id = ?").get(id) as Row | undefined;
        if (!row) return { removed: false, project: null, name: null };
        this.#checkEvidenceArtifact(id);
        db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
        if (row.stored) await this.#dropBlob(str(row.sha256));
        return { removed: true, project: str(row.project), name: str(row.name) };
      },

      "proposals.list": ({ status, docKey }) =>
        (
          db
            .prepare(
              `SELECT * FROM proposals WHERE (?1 IS NULL OR status = ?1) AND (?2 IS NULL OR doc_key = ?2)
               ORDER BY id DESC LIMIT 200`,
            )
            .all(status ?? null, docKey ?? null) as Row[]
        ).map(toProposal),

      "proposals.create": (input, actor) => {
        if ("action" in input) {
          const { method, project, input: raw } = input.action;
          if (project && !this.#projectNames().includes(project)) throw new HiveError("not_found", `Project ${project} not found.`);
          const parsed = parseInput(method, raw as never);
          if ("project" in parsed && parsed.project !== project)
            throw new HiveError("bad_request", "The operation and proposal must name the same project.");
          if (method === "runs.merge" || method === "runs.cancel") {
            const runInput = parsed as ParsedInput<"runs.merge">;
            const run = db.prepare("SELECT project FROM run_records WHERE machine_id = ? AND run_id = ?")
              .get(runInput.machineId, runInput.runId) as Row | undefined;
            if (!run || str(run.project) !== project) throw new HiveError("not_found", "Run not found in the proposal's project.");
          }
          if (method === "admin.commandCreate") {
            const item = (parsed as ParsedInput<"admin.commandCreate">).itemId;
            const itemProject = item === "shim" || item.startsWith("cli:") || item.startsWith("tool:") ? null : item.slice(0, item.indexOf(":"));
            if (itemProject && itemProject !== project) throw new HiveError("forbidden", `${item} belongs to another project.`);
          }
          const content = JSON.stringify({ method, project, input: parsed }, null, 2);
          assertNoSecret(content, "Proposed operation");
          assertNoHidden(content, "Proposed operation");
          assertNoSecret(input.reason, "Reason");
          const docKey = `${project ? `project/${project}` : "org"}/${CLI_ACTION_SLUG_PREFIX}${randomUUID().replace(/-/g, "")}`;
          const res = db.prepare(
            `INSERT INTO proposals(doc_key, base_version, content, reason, author, source, on_behalf, created_at)
             VALUES (?, 0, ?, ?, ?, ?, ?, ?)`,
          ).run(docKey, content, input.reason, actor.name, sourceJson(actor.source), actor.onBehalf ?? null, this.#now());
          return this.#getProposal(num(res.lastInsertRowid));
        }
        const parsed = parseDocKey(input.docKey);
        if (parsed.slug.startsWith(CLI_ACTION_SLUG_PREFIX)) throw new HiveError("bad_request", "Reserved proposal key.");
        if (parsed.skill) SqliteHive.#checkSkill(parsed, input.content);
        assertNoSecret(input.content, "Proposed content");
        assertNoSecret(input.reason, "Reason");
        assertNoHidden(input.content, "Proposed content");
        assertNoHidden(input.reason, "Reason");
        const doc = this.#getDoc(input.docKey);
        const current = doc?.version ?? 0;
        if (input.baseVersion !== current) {
          throw new HiveError(
            "conflict",
            `${input.docKey} is at v${current}, you based your change on v${input.baseVersion}. Call doc_get again and re-propose.`,
            { key: "errors.proposalStale", vars: { key: input.docKey, current, base: input.baseVersion } },
          );
        }
        if (doc && doc.content === input.content) {
          throw new HiveError("bad_request", "Proposed content is identical to the current version.", { key: "errors.proposalSame" });
        }
        const res = db
          .prepare(
            `INSERT INTO proposals(doc_key, base_version, content, reason, author, source, on_behalf, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(input.docKey, input.baseVersion, input.content, input.reason, actor.name, sourceJson(actor.source), actor.onBehalf ?? null, this.#now());
        return this.#getProposal(num(res.lastInsertRowid));
      },

      "proposals.approve": async ({ id }, actor) => {
        const pending = this.#getProposal(id);
        if (isCliActionProposalKey(pending.docKey)) {
          const action = JSON.parse(pending.content) as { method: Method; input: Record<string, unknown> };
          this.#tx(() => {
            if (this.#getProposal(id).status !== "pending") throw new HiveError("bad_request", `Proposal #${id} is already decided.`);
            db.prepare("UPDATE proposals SET status = 'executing', reviewer = ?, decided_at = ? WHERE id = ?").run(actor.name, this.#now(), id);
          });
          try {
            await this.call(action.method, action.input as never, actor);
            db.prepare("UPDATE proposals SET status = 'approved' WHERE id = ? AND status = 'executing'").run(id);
          } catch (error) {
            db.prepare("UPDATE proposals SET status = 'conflict', review_note = ? WHERE id = ?").run(String((error as Error).message ?? error).slice(0, 500), id);
          }
          return this.#getProposal(id);
        }
        return this.#tx(() => {
          const p = this.#getProposal(id);
          if (p.status !== "pending") throw new HiveError("bad_request", `Proposal #${id} is already ${p.status}.`, { key: "errors.proposalDecided", vars: { id } });
          const current = this.#getDoc(p.docKey)?.version ?? 0;
          const decide = (status: Proposal["status"], note: string | null) =>
            db
              .prepare("UPDATE proposals SET status = ?, reviewer = ?, review_note = ?, decided_at = ? WHERE id = ?")
              .run(status, actor.name, note, this.#now(), id);
          if (current !== p.baseVersion) {
            decide("conflict", `Doc moved from v${p.baseVersion} to v${current} before approval.`);
          } else {
            // The version keeps where the proposed text came from; the audit log has who approved it.
            this.#writeDoc(p.docKey, p.content, { note: `#${id}: ${p.reason}` }, `${p.author} (approved by ${actor.name})`, p.source);
            decide("approved", null);
          }
          return this.#getProposal(id);
        });
      },

      "proposals.reject": ({ id, note }, actor) => {
        const p = this.#getProposal(id);
        if (p.status !== "pending") throw new HiveError("bad_request", `Proposal #${id} is already ${p.status}.`, { key: "errors.proposalDecided", vars: { id } });
        db.prepare("UPDATE proposals SET status = 'rejected', reviewer = ?, review_note = ?, decided_at = ? WHERE id = ?").run(
          actor.name,
          note ?? null,
          this.#now(),
          id,
        );
        return this.#getProposal(id);
      },

      "memory.search": async ({ project, projects, query, limit, includeShared, anyProject, includeStale }, actor) => {
        // Before any read: the handler waits here, and what it reads must be current when it answers.
        const vector = await this.#queryVector(query);
        const match = ftsQuery(query);
        // ?2 = the project (or shared when none), ?3 = also shared entries, ?5 = every project, ?6 = the stale cutoff ('' keeps all),
        // ?8 = a system's projects (JSON; '[]' when none).
        // Replaced entries drop out once their replacement is approved, so a chain shows only its newest entry.
        const scope = `(?5 = 1 OR m.project = ?2 OR m.project IN (SELECT value FROM json_each(?8)) OR (?3 = 1 AND m.project = ''))
          AND COALESCE(m.last_used_at, m.created_at) >= ?6
          AND NOT EXISTS (SELECT 1 FROM memory s WHERE s.id = m.superseded_by AND s.status = 'approved')`;
        // A system's projects and no one project: shared entries only with includeShared.
        const own = project ?? (projects ? null : SHARED);
        // The memory of the systems these projects are in (roadmap 19c) counts as theirs.
        const listed = JSON.stringify([...(projects ?? []), ...this.#systemOwnersOf([project, ...(projects ?? [])])]);
        const shared = includeShared ? 1 : 0;
        const staleBefore = this.#staleBefore();
        const cutoff = includeStale || staleBefore === null ? "" : staleBefore;
        // With a query vector each side brings more candidates, then rank fusion keeps the best of both.
        const pool = vector ? limit * 2 : limit;
        const words = (
          match
            ? db
                .prepare(
                  `SELECT m.* FROM memory_fts f JOIN memory m ON m.id = f.rowid
                   WHERE memory_fts MATCH ?1 AND ${scope} AND m.status = 'approved'
                   ORDER BY bm25(memory_fts) LIMIT ?4`,
                )
                .all(match, own, shared, pool, anyProject ? 1 : 0, cutoff, null, listed)
            : vector
              ? []
              : db
                  .prepare(`SELECT m.* FROM memory m WHERE ${scope} AND m.status = 'approved' ORDER BY m.id DESC LIMIT ?4`)
                  .all(null, own, shared, limit, anyProject ? 1 : 0, cutoff, null, listed)
        ) as Row[];
        let rows = words;
        if (vector) {
          const candidates = db
            .prepare(
              `SELECT m.*, v.vector FROM memory m JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ?7
               WHERE ${scope} AND m.status = 'approved'`,
            )
            .all(null, own, shared, null, anyProject ? 1 : 0, cutoff, this.#opts.embedder!.model, listed) as Row[];
          const meaning = candidates
            .map((r) => ({ r, score: similarity(vector, fromBlob(r.vector as Uint8Array)) }))
            .filter((c) => c.score >= this.#opts.embedMinScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, pool)
            .map((c) => c.r);
          const byId = new Map([...words, ...meaning].map((r) => [num(r.id), r]));
          rows = fuseRanks([words.map((r) => num(r.id)), meaning.map((r) => num(r.id))])
            .slice(0, limit)
            .map((id) => byId.get(id)!);
        }
        // What an agent was given counts as used; people browsing the page do not.
        if (actor.role === "agent" && rows.length) {
          const now = this.#now();
          const touch = db.prepare("UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?");
          for (const r of rows) {
            touch.run(now, num(r.id));
            r.last_used_at = now;
            r.use_count = num(r.use_count ?? 0) + 1;
          }
        }
        return rows.map((r) => toMemory(r, staleBefore));
      },

      "memory.cleanupSettings": ({ project }) => (db.prepare("SELECT * FROM memory_cleanup_settings WHERE (? IS NULL OR project = ?)").all(project ?? null, project ?? null) as Row[])
        .map((r) => ({ project: str(r.project), enabled: num(r.enabled) === 1, lastQueuedAt: strOrNull(r.last_queued_at) })),
      "memory.setCleanup": ({ project, enabled }) => {
        db.prepare("INSERT INTO memory_cleanup_settings(project, enabled) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET enabled = excluded.enabled").run(project, enabled ? 1 : 0);
        if (!enabled) db.prepare("UPDATE memory_cleanup_runs SET status = 'failed', snapshot = '[]', error = 'disabled', updated_at = ? WHERE project = ? AND status IN ('queued','running')").run(this.#now(), project);
        const row = db.prepare("SELECT * FROM memory_cleanup_settings WHERE project = ?").get(project) as Row;
        return { project, enabled, lastQueuedAt: strOrNull(row.last_queued_at) };
      },
      "memory.cleanupRuns": ({ project }) => (db.prepare("SELECT * FROM memory_cleanup_runs WHERE (? IS NULL OR project = ?) ORDER BY id DESC LIMIT 100").all(project ?? null, project ?? null) as Row[]).map((r) => this.#cleanupRun(r)),
      "memory.cleanupTake": ({ projects }, actor) => this.#tx(() => {
        const machine = db.prepare("SELECT machine, accepts_runs, projects FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
        if (!machine || num(machine.accepts_runs) !== 1) return null;
        const reported = JSON.parse(str(machine.projects)) as string[];
        const rows = db.prepare("SELECT * FROM memory_cleanup_runs WHERE status = 'queued' ORDER BY id").all() as Row[];
        const row = rows.find((r) => projects.includes(str(r.project)) && reported.includes(str(r.project)) && may(actor, str(r.project), "taskWork") && this.#projectState(str(r.project)) === null && !this.#isPaused(str(r.project)));
        if (!row) return null;
        const entries = (db.prepare("SELECT * FROM memory WHERE project = ? AND status = 'approved' AND superseded_by IS NULL ORDER BY id").all(str(row.project)) as Row[]).map((r) => toMemory(r, this.#staleBefore()));
        db.prepare("UPDATE memory_cleanup_runs SET status = 'running', taken_by = ?, machine = ?, snapshot = ?, updated_at = ? WHERE id = ?").run(actor.name, str(machine.machine), JSON.stringify(entries), this.#now(), num(row.id));
        return this.#cleanupRun(db.prepare("SELECT * FROM memory_cleanup_runs WHERE id = ?").get(num(row.id)) as Row);
      }),
      "memory.cleanupRead": ({ id, offset }, actor) => {
        const row = this.#cleanupJob(id, actor);
        if (row.status !== "running") throw new HiveError("conflict", "This cleanup run is no longer running.");
        const entries = JSON.parse(str(row.snapshot)) as Memory[];
        return { entries: entries.slice(offset, offset + 10), next: offset + 10 < entries.length ? offset + 10 : null };
      },
      "memory.cleanupProgress": ({ id }, actor) => {
        const row = this.#cleanupJob(id, actor);
        if (row.status !== "running") return { ok: false };
        if (this.#isPaused(str(row.project))) return { ok: false };
        db.prepare("UPDATE memory_cleanup_runs SET updated_at = ? WHERE id = ?").run(this.#now(), id);
        return { ok: true };
      },
      "memory.cleanupFinish": ({ id, suggestions, error, profile, model, costUsd }, actor) => this.#tx(() => {
        const row = this.#cleanupJob(id, actor);
        if (row.status !== "running") return { ok: false };
        if (this.#isPaused(str(row.project))) throw new HiveError("conflict", "Agents are paused.");
        const entries = JSON.parse(str(row.snapshot)) as Memory[];
        const used = new Set<number>();
        if (!error) for (const suggestion of suggestions) {
          const sources = suggestion.ids.map((mid) => entries.find((m) => m.id === mid));
          if (sources.some((m) => !m) || suggestion.ids.some((mid) => used.has(mid))) throw new HiveError("bad_request", "Suggestion ids must be unique entries from this run's project snapshot.");
          suggestion.ids.forEach((mid) => used.add(mid));
          assertNoHidden(suggestion.reason, "Reason"); assertNoSecret(suggestion.reason, "Reason");
          if (suggestion.content) { assertNoHidden(suggestion.content, "Content"); assertNoSecret(suggestion.content, "Content"); }
          // An undecided proposal already covers these facts: do not fill the inbox with weekly duplicates.
          const pending = db.prepare("SELECT suggestion FROM memory_cleanup_proposals WHERE project = ? AND status = 'pending'").all(str(row.project)) as Row[];
          if (pending.some((p) => (JSON.parse(str(p.suggestion)).ids as number[]).some((mid) => suggestion.ids.includes(mid)))) continue;
          db.prepare("INSERT INTO memory_cleanup_proposals(project, run_id, suggestion, entries, created_at) VALUES (?, ?, ?, ?, ?)").run(str(row.project), id, JSON.stringify(suggestion), JSON.stringify(sources), this.#now());
        }
        db.prepare("UPDATE memory_cleanup_runs SET status = ?, snapshot = '[]', error = ?, profile = ?, model = ?, cost_usd = ?, updated_at = ? WHERE id = ?").run(error ? "failed" : "done", error ?? null, profile, model, costUsd, this.#now(), id);
        return { ok: true };
      }),
      "memory.cleanupProposals": ({ project }) => (db.prepare("SELECT id FROM memory_cleanup_proposals WHERE (? IS NULL OR project = ?) ORDER BY id DESC LIMIT 500").all(project ?? null, project ?? null) as Row[]).map((r) => this.#cleanupProposal(num(r.id))),
      "memory.decideCleanup": ({ id, accept }, actor) => this.#tx(() => {
        const p = this.#cleanupProposal(id);
        if (p.status !== "pending") throw new HiveError("conflict", "This proposal has already been decided.");
        let status: MemoryCleanupProposal["status"] = accept ? "approved" : "rejected";
        if (accept) {
          const fresh = p.entries.every((m) => {
            const row = db.prepare("SELECT * FROM memory WHERE id = ?").get(m.id) as Row | undefined;
            return !!row && memoryCleanupBaseline(toMemory(row, this.#staleBefore())) === memoryCleanupBaseline(m);
          });
          if (!fresh) status = "conflict";
          else {
            let replacement: number | null = null;
            if (p.kind === "merge") {
              const first = p.entries[0]!;
              const files = [...new Map(p.entries.flatMap((m) => m.files).map((f) => [f.path, f])).values()];
              const r = db.prepare("INSERT INTO memory(project, kind, content, author, status, files, created_at) VALUES (?, ?, ?, ?, 'approved', ?, ?)").run(p.project, first.kind, p.content!, actor.name, JSON.stringify(files), this.#now());
              replacement = Number(r.lastInsertRowid);
              const conflicts = [...new Set(p.entries.flatMap((m) => m.conflictsWith))].filter((mid) => !p.ids.includes(mid));
              this.#setConflicts(replacement, conflicts);
              for (const m of p.entries) this.#setConflicts(m.id, []);
              for (const mid of conflicts) {
                const other = this.#getMemory(mid);
                this.#setConflicts(mid, [...new Set([...other.conflictsWith.filter((source) => !p.ids.includes(source)), replacement])]);
              }
            }
            for (const m of p.entries) {
              if (replacement !== null) db.prepare("UPDATE memory SET superseded_by = ? WHERE id = ?").run(replacement, m.id);
              else this.#removeMemory(m.id);
            }
          }
        }
        db.prepare("UPDATE memory_cleanup_proposals SET status = ?, reviewer = ?, decided_at = ? WHERE id = ?").run(status, actor.name, this.#now(), id);
        return this.#cleanupProposal(id);
      }),

      "memory.searchInfo": (_input, actor) => {
        const model = this.#opts.embedder?.model ?? null;
        const count = (sql: string, ...args: string[]) => (db.prepare(sql).all(...args) as Row[])
          .filter((r) => sees(actor, str(r.project) === SHARED ? null : str(r.project)))
          .reduce((sum, r) => sum + num(r.n), 0);
        return {
          mode: model ? "hybrid" : "keyword",
          model,
          indexed: model
            ? count("SELECT m.project, COUNT(*) AS n FROM memory m JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ? WHERE m.status = 'approved' GROUP BY m.project", model)
            : 0,
          total: count("SELECT project, COUNT(*) AS n FROM memory WHERE status = 'approved' GROUP BY project"),
          lastError: this.#embedError,
          lastIndexedAt: this.#indexedAt,
        } satisfies MemorySearchInfo;
      },

      "memory.list": ({ project, projects, system, includeShared, status, stale, limit }) => {
        const staleBefore = this.#staleBefore();
        // ?5: only entries older than this cutoff ('' matches nothing, so staleness off lists none).
        const onlyStale = stale ? (staleBefore ?? "") : null;
        return (
          db
            .prepare(
              `SELECT * FROM memory
               WHERE ((?1 IS NULL AND ?6 IS NULL) OR project = ?1 OR project IN (SELECT value FROM json_each(?6)) OR (?2 = 1 AND project = ''))
                 AND (?3 IS NULL OR status = ?3)
                 AND (?5 IS NULL OR COALESCE(last_used_at, created_at) < ?5)
               ORDER BY id DESC LIMIT ?4`,
            )
            .all(
              system ? systemOwner(system) : project === undefined ? null : (project ?? SHARED),
              includeShared ? 1 : 0,
              status ?? null,
              limit,
              onlyStale,
              // A system's projects (its scope on the web) bring the system's own memory along.
              projects ? JSON.stringify([...projects, ...this.#systemOwnersOf(projects)]) : null,
            ) as Row[]
        ).map((r) => toMemory(r, staleBefore));
      },

      "memory.write": (input, actor) =>
        this.#tx(() => {
          assertNoSecret(input.content, "Memory content");
          assertNoHidden(input.content, "Memory content");
          const owner = input.shared ? null : input.system ? systemOwner(input.system) : input.project!;
          const stored = owner ?? SHARED;
          this.#assertSystem(owner);
          if (input.supersedes !== undefined && input.supersedes === input.contradicts) {
            throw new HiveError("bad_request", "An entry cannot both replace and contradict the same entry.", { key: "errors.memoryLinkBoth" });
          }
          const target = (id: number | undefined) => {
            if (id === undefined) return null;
            const t = this.#getMemory(id);
            if ((t.project ?? SHARED) !== stored) {
              throw new HiveError("bad_request", `Memory #${id} belongs to ${t.project ?? "the shared memory"}: link entries of the same owner only.`, {
                key: "errors.memoryLinkOwner",
                vars: { id },
              });
            }
            return t;
          };
          const old = target(input.supersedes);
          if (old?.supersededBy != null) {
            throw new HiveError("conflict", `Memory #${old.id} is already replaced by #${old.supersededBy}; replace that one instead.`, {
              key: "errors.memorySuperseded",
              vars: { id: old.id, by: old.supersededBy },
            });
          }
          const other = target(input.contradicts);
          // Written by someone who may approve it: approved at once.
          const status = this.#opts.memoryRequiresApproval && !may(actor, owner, "memoryApprove") ? "pending" : "approved";
          const res = db
            .prepare(
              "INSERT INTO memory(project, kind, content, author, task_id, status, source, files, on_behalf, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              stored,
              input.kind,
              input.content,
              actor.name,
              input.taskId ?? actor.source?.task ?? null,
              status,
              sourceJson(actor.source),
              JSON.stringify([...new Set(input.files)].map((path): MemoryFile => ({ path, sha: null }))),
              actor.onBehalf ?? null,
              this.#now(),
            );
          const created = num(res.lastInsertRowid);
          if (old) {
            db.prepare("UPDATE memory SET supersedes = ? WHERE id = ?").run(old.id, created);
            db.prepare("UPDATE memory SET superseded_by = ? WHERE id = ?").run(created, old.id);
          }
          if (other) {
            this.#setConflicts(created, [other.id]);
            this.#setConflicts(other.id, [...other.conflictsWith, created]);
          }
          return this.#getMemory(created);
        }),

      "memory.resolve": ({ id, other, keep }) =>
        this.#tx(() => {
          const a = this.#getMemory(id);
          const b = this.#getMemory(other);
          if (!a.conflictsWith.includes(other)) {
            throw new HiveError("bad_request", `Memory #${id} is not marked as contradicting #${other}.`, { key: "errors.memoryNoConflict", vars: { id, other } });
          }
          this.#setConflicts(a.id, a.conflictsWith.filter((x) => x !== b.id));
          this.#setConflicts(b.id, b.conflictsWith.filter((x) => x !== a.id));
          const [winner, loser] = keep === "this" ? [a, b] : keep === "other" ? [b, a] : [null, null];
          if (winner && loser) {
            db.prepare("UPDATE memory SET superseded_by = ? WHERE id = ?").run(winner.id, loser.id);
            db.prepare("UPDATE memory SET supersedes = COALESCE(supersedes, ?) WHERE id = ?").run(loser.id, winner.id);
          }
          return this.#getMemory(id);
        }),

      "memory.share": ({ id }) => {
        const m = this.#getMemory(id);
        if (m.supersedes !== null || m.supersededBy !== null || m.conflictsWith.length) throw new HiveError("bad_request", "Resolve memory links before changing scope.", { key: "inbox.memory.linked" });
        db.prepare("UPDATE memory SET project = ?, status = 'approved' WHERE id = ?").run(SHARED, id);
        return this.#getMemory(id);
      },

      "memory.approve": ({ id }) => {
        this.#getMemory(id);
        db.prepare("UPDATE memory SET status = 'approved' WHERE id = ?").run(id);
        return this.#getMemory(id);
      },

      "memory.keep": ({ id }) => {
        const m = this.#getMemory(id);
        const files = m.review ? m.files.map((f) => ({ path: f.path, sha: f.path in m.review!.current ? m.review!.current[f.path]! : f.sha })) : m.files;
        db.prepare("UPDATE memory SET last_used_at = ?, files = ?, review = NULL WHERE id = ?").run(this.#now(), JSON.stringify(files), id);
        return this.#getMemory(id);
      },

      // First sight of a cited file sets its baseline; later a different object id or a missing file flags the entry.
      // A file not on the branch yet (written in a task branch) waits for its baseline instead of being flagged.
      "memory.checkFiles": ({ project, files }) =>
        this.#tx(() => {
          const now = new Map(files.map((f) => [f.path, f.sha]));
          const rows = db.prepare("SELECT id, files, review FROM memory WHERE project = ? AND files != '[]'").all(project) as Row[];
          const save = db.prepare("UPDATE memory SET files = ?, review = ? WHERE id = ?");
          let flagged = 0;
          let baselined = 0;
          for (const r of rows) {
            const cited = JSON.parse(str(r.files)) as MemoryFile[];
            const before = r.review ? (JSON.parse(str(r.review)) as MemoryReview) : null;
            const changed = new Set(before?.changed);
            const missing = new Set(before?.missing);
            const current = { ...before?.current };
            let dirty = false;
            const next = cited.map((f) => {
              if (!now.has(f.path)) return f;
              const sha = now.get(f.path)!;
              if (f.sha === null) {
                if (sha === null) return f;
                baselined += 1;
                dirty = true;
                return { ...f, sha };
              }
              if (sha === f.sha) {
                // Back to the baseline: nothing to review for this file any more.
                if (changed.delete(f.path) || missing.delete(f.path)) dirty = true;
                delete current[f.path];
                return f;
              }
              if (current[f.path] !== sha || !(sha === null ? missing : changed).has(f.path)) dirty = true;
              current[f.path] = sha;
              (sha === null ? missing : changed).add(f.path);
              (sha === null ? changed : missing).delete(f.path);
              return f;
            });
            if (!dirty) continue;
            const review: MemoryReview | null =
              changed.size || missing.size ? { at: before && (before.changed.length || before.missing.length) ? before.at : this.#now(), changed: [...changed], missing: [...missing], current } : null;
            if (review && !before) flagged += 1;
            save.run(JSON.stringify(next), review ? JSON.stringify(review) : null, num(r.id));
          }
          return { flagged, baselined };
        }),

      // A removed replacement brings the entry it replaced back; conflicts with it are dropped.
      "memory.remove": ({ id }) => this.#tx(() => this.#removeMemory(id)),

      "inbox.source": (input, actor) => {
        const projects = this.#sourceProjects(input, actor);
        if (input.source === "tasks") {
          const review = JSON.stringify(projects.filter((p) => may(actor, p, "codeReview")));
          const dispatch = JSON.stringify(projects.filter((p) => may(actor, p, "runDispatch")));
          const settings = JSON.stringify(projects.filter((p) => may(actor, p, "projectSettings")));
          const where = `project IN (SELECT value FROM json_each(?1)) AND (
            (status = 'review' AND project IN (SELECT value FROM json_each(?2))) OR
            (status <> 'done' AND agent_machine IS NOT NULL AND agent_hold IS NOT NULL AND
              (project IN (SELECT value FROM json_each(?3)) OR agent_by = ?4)) OR
            (status <> 'done' AND id GLOB 'OPS-release-*' AND project IN (SELECT value FROM json_each(?5))))`;
          const args = [JSON.stringify(projects), review, dispatch, principalOf(actor), settings];
          const total = num((db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${where}`).get(...args) as Row).n);
          const rows = db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ?6 OFFSET ?7`).all(...args, input.limit, input.offset) as Row[];
          return { total, tasks: this.#tasks(rows).map((t) => hideDeps(t, (p) => sees(actor, p))), runs: [] };
        }
        const allowed = JSON.stringify(projects.filter((p) => may(actor, p, "runDispatch")));
        // Rank before testing signals: a newer answered run supersedes an older question, even across machines.
        const latest = `WITH ranked AS (
          SELECT machine_id, run_id, created_at,
            ROW_NUMBER() OVER (PARTITION BY project, task_id ORDER BY created_at DESC, run_id DESC, machine_id DESC) AS rank
          FROM run_records WHERE project IN (SELECT value FROM json_each(?1))
        ), waiting AS (SELECT r.machine_id, r.run_id, r.created_at FROM ranked n
          JOIN run_records r ON r.machine_id = n.machine_id AND r.run_id = n.run_id WHERE n.rank = 1
          AND COALESCE(json_extract(r.plan, '$.phase'), '') <> 'plan'
          AND hive_waiting_reason(r.status, r.summary, r.error, json_extract(r.mr, '$.pipeline')) IS NOT NULL)`;
        const rows = db.prepare(`${latest} SELECT r.*, ${RUN_TOKEN_COLUMNS}, w.source_total
          FROM (SELECT *, COUNT(*) OVER () AS source_total FROM waiting ORDER BY created_at DESC, run_id DESC, machine_id DESC LIMIT ?2 OFFSET ?3) w
          JOIN run_records r ON r.machine_id = w.machine_id AND r.run_id = w.run_id
          LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id
          ORDER BY r.created_at DESC, r.run_id DESC, r.machine_id DESC`).all(allowed, input.limit, input.offset) as Row[];
        const total = rows.length ? num(rows[0]!.source_total) : num((db.prepare(`${latest} SELECT COUNT(*) AS n FROM waiting`).get(allowed) as Row).n);
        return { total, tasks: [], runs: rows.map((r) => toRunRecord(r, false)) };
      },

      "sdlc.dispatch": (input, actor) => {
        this.#tx(() => this.#releaseFlows());
        const projects = this.#sourceProjects(input, actor);
        const settings = this.#sdlcPolicy();
        const fast = JSON.stringify(projects.flatMap((p) => (settings.projects[p]?.fastLaneKinds ?? []).map((kind) => ({ project: p, kind }))));
        const where = `t.project IN (SELECT value FROM json_each(?1)) AND (
          EXISTS (SELECT 1 FROM sdlc_flow_tasks ft LEFT JOIN sdlc_gates g ON g.id = ft.gate_id
            WHERE ft.task_id = t.id AND (ft.stage = 'queued' OR (ft.stage IN ('gate', 'check', 'checking') AND g.gate = 'dispatch'))) OR
          EXISTS (SELECT 1 FROM sdlc_flows f WHERE f.task_id = t.id AND f.step = 'import' AND f.state <> 'done') OR
          (t.status = 'todo' AND EXISTS (SELECT 1 FROM json_each(?2) k WHERE json_extract(k.value, '$.project') = t.project AND json_extract(k.value, '$.kind') = t.kind)
            AND NOT EXISTS (SELECT 1 FROM sdlc_flows f WHERE f.task_id = t.id)
            AND NOT EXISTS (SELECT 1 FROM sdlc_flow_tasks ft WHERE ft.task_id = t.id)))`;
        const args = [JSON.stringify(projects), fast];
        const total = num((db.prepare(`SELECT COUNT(*) AS n FROM tasks t WHERE ${where}`).get(...args) as Row).n);
        const rows = db.prepare(`SELECT t.* FROM tasks t WHERE ${where} ORDER BY t.updated_at DESC, t.id DESC LIMIT ?3 OFFSET ?4`).all(...args, input.limit, input.offset) as Row[];
        return { total, tasks: this.#tasks(rows).map((t) => hideDeps(t, (p) => sees(actor, p))) };
      },

      "tasks.list": ({ project, projects, status }) =>
        this.#tasks(
          db
            .prepare(
              `SELECT * FROM tasks WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3)))
               ORDER BY updated_at DESC LIMIT 500`,
            )
            .all(project ?? null, status ?? null, listParam(projects)) as Row[],
        ),

      "tasks.create": (input, actor) => this.#tx(() => this.#createTask(input, actor)),

      "plans.create": (input, actor) => {
        if (!actor.mcpCredential || actor.runCredential || actor.chatReply !== undefined)
          throw new HiveError("forbidden", "Only an interactive MCP credential can create a plan.");
        return this.#createChatPlan(input, actor, false, true) as { specKey: string; taskIds: string[] };
      },

      "tasks.setDeps": ({ id, dependsOn }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(id);
          if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
          // What it waits for in projects this person cannot see stays: they could neither see it nor mean to drop it.
          const hidden = (db.prepare("SELECT d.depends_on, t.project FROM task_deps d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ?").all(id) as Row[])
            .filter((r) => !sees(actor, str(r.project)))
            .map((r) => str(r.depends_on));
          this.#setDeps(id, [...this.#checkDeps(id, task.project, dependsOn, actor), ...hidden]);
          db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(this.#now(), id);
          return this.#getTask(id)!;
        }),

      "tasks.next": ({ project, projects, limit }, actor) => {
        // A machine asking gets its own tasks first and never another agent's (roadmap 50); anyone else sees the board
        // as before, assignments and all — a person picking work is not bound by them.
        const mine = this.#callerMachines(actor);
        return this.#tasks(
          db
            .prepare(
              `SELECT t.*, (SELECT COUNT(*) FROM task_deps d JOIN tasks o ON o.id = d.task_id WHERE d.depends_on = t.id AND o.status != 'done') AS unlocks,
                 (t.agent_machine IS NOT NULL AND t.agent_machine IN (SELECT value FROM json_each(?5))) AS assigned_to_me
               FROM tasks t
               WHERE t.status = 'todo' AND (?1 IS NULL OR t.project = ?1)
                 AND (?4 IS NULL OR t.project IN (SELECT value FROM json_each(?4)))
                 AND (t.owner IS NULL OR t.lease_until IS NULL OR t.lease_until < ?2)
                 AND (?6 = 0 OR t.agent_machine IS NULL OR t.agent_machine IN (SELECT value FROM json_each(?5)))
                 AND NOT EXISTS (SELECT 1 FROM task_deps d JOIN tasks p ON p.id = d.depends_on WHERE d.task_id = t.id AND p.status != 'done')
               ORDER BY assigned_to_me DESC, CASE WHEN assigned_to_me THEN t.agent_order END, t.priority, unlocks DESC, t.rowid
               LIMIT ?3`,
            )
            .all(project ?? null, this.#now(), limit, listParam(projects), JSON.stringify(mine), mine.length ? 1 : 0) as Row[],
        );
      },

      "tasks.claim": ({ id, leaseMinutes }, actor) => {
        const task = this.#getTask(id);
        if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
        // Given to one agent (roadmap 50): nobody else takes it from under it. A hub admin still can, to unblock it.
        if (task.agent && actor.role !== "admin" && !this.#callerMachines(actor).includes(task.agent.machineId)) {
          throw new HiveError("conflict", `Task ${id} is assigned to ${task.agent.machine}.`, {
            key: "errors.taskAssignedElsewhere",
            vars: { id, machine: task.agent.machine },
          });
        }
        // Whoever holds it already may renew; nobody starts it while what it depends on is open.
        if (task.waitingOn.length && task.owner !== actor.name) {
          // Named as the actor may see them: another service's task it cannot see is only counted (roadmap 19d).
          const shown = waitingLabelsFor(hideDeps(task, (p) => sees(actor, p)));
          throw new HiveError("conflict", `Task ${id} waits on ${shown}, which are not done yet.`, {
            key: "errors.taskWaiting",
            vars: { id, tasks: shown },
          });
        }
        const now = this.#now();
        const res = db
          .prepare(
            `UPDATE tasks SET owner = ?1, status = 'doing', lease_until = ?2, updated_at = ?3
             WHERE id = ?4 AND status != 'done'
               AND (owner IS NULL OR owner = ?1 OR lease_until IS NULL OR lease_until < ?3)`,
          )
          .run(actor.name, this.#now(leaseMinutes), now, id);
        return { claimed: num(res.changes) === 1, task: this.#getTask(id) };
      },

      "tasks.requestChanges": ({ id, note }, actor) => this.#tx(() => {
        const task = this.#getTask(id);
        if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
        if (task.status !== "review") throw new HiveError("conflict", "Task is no longer awaiting review.", { key: "inbox.review.noLongerReview" });
        const now = this.#now();
        const kept = SqliteHive.#cleanNote(note);
        db.prepare("UPDATE tasks SET status = 'todo', owner = NULL, lease_until = NULL, note = ?, updated_at = ? WHERE id = ?").run(kept, now, id);
        this.#keepNote(id, kept, "todo", actor, now);
        return this.#getTask(id)!;
      }),

      "tasks.update": ({ id, status, note, priority }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(id);
          if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
          const now = this.#now();
          const heldByOther =
            task.owner !== null && task.owner !== actor.name && task.leaseUntil !== null && task.leaseUntil > now;
          if (heldByOther && actor.role !== "admin") {
            throw new HiveError("forbidden", `Task ${id} is held by ${task.owner} until ${task.leaseUntil}.`, {
              key: "errors.taskHeld",
              vars: { id, owner: task.owner ?? "", until: task.leaseUntil ?? "" },
            });
          }
          const doing = status === "doing";
          // A status change with no note leaves the note (and its history) alone: the audit log already has the move.
          const kept = note === undefined ? null : SqliteHive.#cleanNote(note);
          db.prepare(
            "UPDATE tasks SET status = ?, owner = ?, lease_until = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
          ).run(
            status,
            doing ? actor.name : null,
            doing ? (task.owner === actor.name ? task.leaseUntil : this.#now(120)) : null,
            kept,
            now,
            id,
          );
          if (priority !== undefined) db.prepare("UPDATE tasks SET priority = ? WHERE id = ?").run(priority, id);
          if (note !== undefined) this.#applyTaskRule(id);
          // An empty note clears the task's note as it always did, but is no handover to keep.
          if (kept !== null && kept.trim()) this.#keepNote(id, kept, status, actor, now);
          if (status === "done" && task.status !== "done") this.#journalTask(id);
          return this.#getTask(id)!;
        }),
      "tasks.classify": ({ id, kind, size, risk }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(id);
          if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
          const now = this.#now();
          db.prepare("UPDATE tasks SET kind = ?, size = ?, risk = ?, classified_by = ?, classified_at = ?, updated_at = ? WHERE id = ?").run(
            kind ?? task.kind,
            size ?? task.size,
            risk ?? task.risk,
            actor.name,
            now,
            now,
            id,
          );
          return this.#getTask(id)!;
        }),
      // Only the projects that differ from the default (on), as a list the settings card reads in one call.
      "tasks.classifyConfig": (_input, actor) =>
        (db.prepare("SELECT project, enabled FROM task_classify_config ORDER BY project").all() as Row[])
          .filter((r) => sees(actor, str(r.project)))
          .map((r) => ({ project: str(r.project), enabled: num(r.enabled) === 1 })),
      "tasks.setClassifyConfig": ({ project, enabled }) =>
        this.#tx(() => {
          db.prepare("INSERT INTO task_classify_config(project, enabled) VALUES (?, ?) ON CONFLICT(project) DO UPDATE SET enabled = excluded.enabled").run(
            project,
            enabled ? 1 : 0,
          );
          return { project, enabled };
        }),

      "tasks.assign": ({ id, machineId, profileId, before }, actor) =>
        this.#tx(() => {
          return this.#assignTask({ id, machineId, profileId, before }, actor);
        }),

      "tasks.unassign": ({ id }) =>
        this.#tx(() => {
          const task = this.#getTask(id);
          if (!task) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
          // A run already going keeps going: taking the task off the queue is not cancelling its work.
          db.prepare(
            `UPDATE tasks SET agent_machine = NULL, agent_profile = NULL, agent_order = NULL, agent_by = NULL, agent_at = NULL,
               agent_request = NULL, agent_hold = NULL, updated_at = ? WHERE id = ?`,
          ).run(this.#now(), id);
          return this.#getTask(id)!;
        }),

      "tasks.agentQueue": ({ machineId, profileId }) => {
        const m = this.#machineByRef(machineId);
        const rows = db
          .prepare("SELECT * FROM tasks WHERE agent_machine = ? AND (?2 IS NULL OR agent_profile = ?2) ORDER BY agent_order, rowid")
          .all(m.id, profileId) as Row[];
        const waiting = this.#waitingRequests();
        // The same count the release loop works from, so the queue says "busy" exactly when the hub would hold a task.
        const places = new Map<string, number>();
        const freeFor = (project: string, plan: string | null): number => {
          const key = `${project}\u0000${plan ?? ""}`;
          if (!places.has(key)) places.set(key, this.#freePlaces(m, project, plan, waiting) - this.#unreportedRequests(m, plan));
          return places.get(key)!;
        };
        return this.#tasks(rows).map((task): TaskAgentQueueItem => ({ task, waiting: this.#agentWait(task, m, freeFor(task.project, task.agent!.profileId)) }));
      },

      // Newest first: the one at the top is what tasks.list shows as the task's note.
      "tasks.notes": ({ id, limit }) => {
        if (!this.#getTask(id)) throw new HiveError("not_found", `Task ${id} not found.`, { key: "errors.taskNotFound", vars: { id } });
        return (db.prepare("SELECT * FROM task_notes WHERE task_id = ? ORDER BY version DESC LIMIT ?").all(id, limit) as Row[]).map(toTaskNote);
      },

      // Keyed by the hub actor (`runner.<machine>@<token>`): the same key as the leases that machine takes.
      "mergeQueue.get": ({ project, landing }) => this.#mergeQueue(project, landing),
      "mergeQueue.configure": ({ project, config }, actor) => this.#tx(() => {
        const active = this.#mergeQueue(project).batches.find(b => b.status === 'running' || b.status === 'awaiting');
        if (active && config.machineId !== active.machineId) throw new HiveError('conflict', 'Finish the active batch before choosing another gate machine.');
        if (config.enabled && (!config.machineId || !config.commands.length)) throw new HiveError('bad_request', 'Choose a gate machine and at least one gate command.');
        if (config.machineId) {
          const machine = this.#machineByRef(config.machineId);
          if (!machine.projects.includes(project)) throw new HiveError('bad_request', 'The gate machine needs this service.');
        }
        assertNoSecret(config.commands.join('\n'), 'Gate commands');
        db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`mergeQueue:${project}`, JSON.stringify(config));
        this.audit(actor, 'mergeQueue.configure', project, 'Merge queue configuration updated');
        return this.#mergeQueue(project);
      }),
      "mergeQueue.take": ({ project, instance }, actor) => this.#tx(() => {
        const view = this.#mergeQueue(project);
        const machine = this.#machineFor(actor.name);
        const row = db.prepare('SELECT instance, update_draining FROM machines WHERE id=?').get(actor.name) as Row | undefined;
        if (!machine?.gateRunner || !machine.online || machine.duplicate || num(row?.update_draining ?? 0) === 1 || !machine.projects.includes(project) || row?.instance !== instance || view.config.machineId !== actor.name) return null;
        if (!view.config.enabled || this.#isPaused(project)) return null;
        if (new AutoReleaseStore(db, () => this.#now()).view(project).paused) return null;
        const active = view.batches.find(b => b.status === 'running' || b.status === 'awaiting');
        // Never transfer a live batch after a timeout: the old process may still be publishing it.
        if (active) return active.machineId === actor.name ? active : null;
        if (!view.waiting.length || (view.waiting.length < view.config.maxBranches && view.waiting[0]!.readyAt > this.#now(-view.config.waitMinutes))) return null;
        // A gate machine handles only one service at a time, even if two heartbeats overlap.
        if (db.prepare("SELECT 1 FROM merge_batches WHERE machine_id=? AND status='running'").get(actor.name)) return null;
        const items = view.waiting.slice(0, view.config.maxBranches);
        const batch: MergeBatch = { id: 0, project, machineId: actor.name, instance, config: view.config, items, status: 'running', step: 'prepare', log: '', result: null, createdAt: this.#now() };
        batch.id = Number(db.prepare("INSERT INTO merge_batches(project,machine_id,status,body) VALUES (?,?,'running',?)").run(project, actor.name, JSON.stringify(batch)).lastInsertRowid);
        this.#saveMergeBatch(batch);
        const put = db.prepare('INSERT INTO merge_batch_items(batch_id,task_id,machine_id,run_id) VALUES (?,?,?,?)');
        for (const item of items) put.run(batch.id, item.taskId, item.machineId, item.runId);
        this.audit(actor, 'mergeQueue.take', project, `Batch ${batch.id}: ${items.map(i => i.taskId).join(', ')}`);
        return batch;
      }),
      "mergeQueue.progress": ({ id, instance, step, log }, actor) => this.#tx(() => {
        const batch = this.#ownedMergeBatch(id, instance, actor);
        if (batch.status !== 'running') return batch;
        if (this.#isPaused(batch.project) || this.#projectState(batch.project) || this.#machineFor(actor.name)?.duplicate || !this.#machineFor(actor.name)?.gateRunner || !this.#mergeQueue(batch.project).config.enabled || this.#mergeQueue(batch.project).config.machineId !== actor.name) throw new HiveError('conflict', 'Merge queue is paused.');
        if (new AutoReleaseStore(db, () => this.#now()).view(batch.project).paused) throw new HiveError('conflict', 'Release queue is paused.');
        batch.step = stripHidden(step); batch.log = redactLines(stripHidden(log));
        this.#saveMergeBatch(batch);
        return batch;
      }),
      "mergeQueue.finish": ({ id, instance, result }, actor) => this.#tx(() => {
        const batch = this.#ownedMergeBatch(id, instance, actor);
        if (batch.status === 'landed' || batch.status === 'failed') return batch;
        if (result.outcomes.length !== batch.items.length || new Set(result.outcomes.map(o => o.taskId)).size !== batch.items.length || result.outcomes.some(o => !batch.items.some(i => i.taskId === o.taskId))) throw new HiveError('bad_request', 'A result must account for every branch exactly once.');
        if (result.status !== 'failed' && (!result.sha || !result.outcomes.some(o => o.status === 'included') || result.outcomes.some(o => o.status === 'included' && !o.sha))) throw new HiveError('bad_request', 'A green batch needs commit evidence.');
        if (result.status === 'awaiting' && (batch.config.mode !== 'mr' || !result.url)) throw new HiveError('bad_request', 'An MR batch needs its URL.');
        if (batch.status === 'awaiting' && (result.sha !== batch.result?.sha || result.version !== batch.result?.version || JSON.stringify(result.outcomes) !== JSON.stringify(batch.result?.outcomes))) throw new HiveError('conflict', 'The MR must land the checked batch.');
        const clean: MergeResult = { ...result, step: redactLines(stripHidden(result.step)), log: redactLines(stripHidden(result.log)), outcomes: result.outcomes.map(o => ({ ...o, reason: redactLines(stripHidden(o.reason)) })) };
        batch.status = clean.status; batch.step = clean.step; batch.log = clean.log; batch.result = clean;
        this.#saveMergeBatch(batch);
        if (this.#projectState(batch.project)) return batch;
        const now = this.#now();
        const repair = (wanted: string, title: string, note: string) => {
          const base = wanted.length <= 80 ? wanted : `${wanted.slice(0, 67)}-${createHash("sha256").update(wanted).digest("hex").slice(0, 12)}`;
          let taskId = base;
          const existing = this.#getTask(taskId);
          if (existing) taskId = `${base}-${id}`;
          if (!this.#getTask(taskId)) {
            db.prepare("INSERT INTO tasks(id,project,title,status,note,updated_at,kind,risk) VALUES (?,?,?,'todo',?,?,'merge','high')").run(taskId, batch.project, title.slice(0,300), `Artifacts: project ${batch.project}, run MERGE-${id}.\n${note}`.slice(0,2000), now);
            this.#keepNote(taskId, `Artifacts: project ${batch.project}, run MERGE-${id}.\n${note}`.slice(0,2000), 'todo', actor, now);
          }
          return taskId;
        };
        let integration: string | null = null;
        if (clean.status === 'failed' && clean.outcomes.some(o => o.status === 'included')) integration = repair(`INT-${id}`, `Cổng kiểm lô ${id}: ${clean.step}`, `Lô ${id}, service ${batch.project}, nhánh đích ${batch.config.target}.\nGhép và sửa các nhánh: ${batch.items.filter(i => clean.outcomes.some(o => o.taskId === i.taskId && o.status === 'included')).map(i => i.branch).join(', ')}.\nBước lỗi: ${clean.step}\n${clean.log}`);
        for (const outcome of clean.outcomes) {
          const item = batch.items.find(i => i.taskId === outcome.taskId)!;
          const task = this.#getTask(item.taskId);
          // A newer run or an administrator's change must not be completed by an old batch.
          const newer = db.prepare('SELECT machine_id,run_id FROM run_records WHERE task_id=? AND project=? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(item.taskId, batch.project) as Row | undefined;
          if (!task || task.status !== 'review' || newer?.run_id !== item.runId || newer?.machine_id !== item.machineId) continue;
          let note: string | null = null;
          let status: TaskStatus = 'blocked';
          if (outcome.status === 'conflict') {
            const land = repair(`LAND-${item.taskId}`, `Ghép ${item.taskId} (lô ${id})`, `Nhánh ${item.branch}, đích ${batch.config.target}, lô ${id}.\n${outcome.reason}`);
            db.prepare('INSERT OR IGNORE INTO merge_repairs(project,repair_task,task_id,machine_id,run_id) VALUES (?,?,?,?,?)').run(batch.project, land, item.taskId, item.machineId, item.runId);
            note = `Lô ${id}: ${land}\n${outcome.reason}`;
          } else if (clean.status === 'failed') {
            db.prepare('INSERT OR IGNORE INTO merge_repairs(project,repair_task,task_id,machine_id,run_id) VALUES (?,?,?,?,?)').run(batch.project, integration!, item.taskId, item.machineId, item.runId);
            note = `Cổng kiểm đỏ ở ${clean.step}: ${integration}\n${clean.log}`;
          }
          else if (clean.status === 'landed') { status = 'done'; note = `Đã vào ${batch.config.target} ở ${clean.sha}`; }
          if (note !== null) {
            note = note.slice(0,2000);
            db.prepare('UPDATE tasks SET status=?,note=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=?').run(status, note, now, item.taskId);
            this.#keepNote(item.taskId, note, status, actor, now);
            if (status === 'done') {
              this.#journalTask(item.taskId);
              this.#landMergeRepairs(item.taskId, batch.project, note, actor, now);
            }
          }
        }
        const releaseMachine = this.#sdlcPolicy().projects[batch.project]?.releaseMachine;
        if (clean.status === 'landed' && releaseMachine && clean.version) {
          const taskIds = clean.outcomes.filter(o => o.status === 'included' && this.#getTask(o.taskId)?.status === 'done').map(o => o.taskId);
          if (taskIds.length) new AutoReleaseStore(db, () => this.#now()).green({
            project: batch.project, batchId: `merge-${id}`, sha: clean.sha!, version: clean.version, targetBranch: batch.config.target,
            taskIds, checks: batch.config.commands.map((name, index) => ({ name: `${index + 1}: ${name}`.slice(0, 100), passed: true as const })), landed: true,
          }, releaseMachine, effectiveGates(this.#sdlcPolicy(), batch.project).release);
        }
        this.audit(actor, 'mergeQueue.finish', batch.project, `Batch ${id}: ${clean.status} (${clean.step})`);
        return batch;
      }),

      "machines.heartbeat": ({ machine, instance, version, runs, setup, profiles, projects, acceptsRuns, maxParallel, runnerSettings, updateDraining, gateRunner, costs, deliveredMessages, toolStates, appliedToolApprovals, worktrees, worktreeResults, terminal, gate }, actor) =>
        this.#tx(() => {
          this.#bindMachine(actor, machine);
          // Drop out-of-scope reports without taking the whole machine offline; grants can change between beats.
          runs = runs.filter((r) => may(actor, r.project, "taskWork"));
          costs = costs.filter((c) => may(actor, c.project, "taskWork"));
          if (worktrees) {
            // Same scope as the projects list: a revoked project leaves no paths or branches on the hub, while a
            // member turned viewer still sees the worktrees left on the machine and may clean them up.
            const entries = worktrees.entries.filter((e) => sees(actor, e.project));
            worktrees = { ...worktrees, entries, totalBytes: entries.reduce((n, e) => n + (e.bytes ?? 0), 0),
              logs: worktrees.logs.filter((l) => sees(actor, l.project)), errors: worktrees.errors.filter((e) => sees(actor, e.split(":")[0]!)) };
          }
          const ack = db.prepare("UPDATE run_messages SET delivered_at = COALESCE(delivered_at, ?) WHERE machine_id = ? AND id = ?");
          for (const id of deliveredMessages) ack.run(this.#now(), actor.name, id);
          const now = this.#now();
          const row = db.prepare("SELECT instance, prev_instance, last_seen, duplicate_at, projects FROM machines WHERE id = ?").get(actor.name) as
            | Row
            | undefined;
          let prev = strOrNull(row?.prev_instance);
          let duplicateAt = strOrNull(row?.duplicate_at);
          if (row && str(row.instance) !== instance) {
            // A restart switches instance once; two live apps keep alternating (A, B, A…).
            if (prev === instance && str(row.last_seen) > this.#now(-DUPLICATE_MINUTES)) duplicateAt = now;
            prev = str(row.instance);
          }
          db.prepare(
            `INSERT INTO machines(id, machine, instance, prev_instance, version, runs, last_seen, duplicate_at, token_id, owner)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, instance = excluded.instance,
               prev_instance = excluded.prev_instance, version = excluded.version, runs = excluded.runs,
               last_seen = excluded.last_seen, duplicate_at = excluded.duplicate_at`,
          ).run(actor.name, machine, instance, prev, version, JSON.stringify(runs), now, duplicateAt, actor.tokenId ?? null, actor.account ?? null);
          if (setup) db.prepare("UPDATE machines SET setup = ?, setup_at = ? WHERE id = ?").run(JSON.stringify(setup.report), setup.checkedAt, actor.name);
          if (profiles) db.prepare("UPDATE machines SET profiles = ? WHERE id = ?").run(JSON.stringify(profiles), actor.name);
          if (worktrees) db.prepare("UPDATE machines SET worktrees = ? WHERE id = ?").run(JSON.stringify(worktrees), actor.name);
          for (const result of worktreeResults) db.prepare("UPDATE machine_worktree_commands SET completed_at = ?, results = ? WHERE id = ? AND machine_id = ? AND completed_at IS NULL")
            .run(now, JSON.stringify(result.results), result.id, actor.name);
          db.prepare("DELETE FROM machine_worktree_commands WHERE completed_at < ?").run(this.#now(-30 * 24 * 60));
          if (toolStates) db.prepare("UPDATE machines SET tool_states = ? WHERE id = ?").run(JSON.stringify(toolStates), actor.name);
          // Written every beat: a machine that turned the terminal off, or went back to an app without it, is off now.
          db.prepare("UPDATE machines SET terminal_capability = ? WHERE id = ?").run(terminal ? JSON.stringify(terminal) : null, actor.name);
          // Likewise every beat; only projects this machine's token works on, so no one sees templates of another.
          const gateReply = this.#gates(actor).heartbeat(actor.name, gate, (p) => may(actor, p, "taskWork"));
          for (const id of appliedToolApprovals) db.prepare("UPDATE machine_tool_approvals SET applied_at = COALESCE(applied_at, ?) WHERE id = ? AND machine_id = ?").run(now, id, actor.name);
          // An archived or deleted project is not stored as a repo this machine has (roadmap 47): a machine that still
          // has the folder must not put the name back into the lists, nor bring a deleted one back from its headstone.
          const hidden = new Set(this.#projectStates().keys());
          const reportedProjects = projects ?? (row ? JSON.parse(str(row.projects)) as string[] : []);
          const allowedProjects = reportedProjects.filter((p) => sees(actor, p));
          const archivedProjects = allowedProjects.filter((p) => hidden.has(p));
          db.prepare("UPDATE machines SET projects = ? WHERE id = ?").run(JSON.stringify(allowedProjects.filter((p) => !hidden.has(p))), actor.name);
          db.prepare("UPDATE machines SET gate_runner = ? WHERE id = ?").run(gateRunner ? 1 : 0, actor.name);
          // A downgraded app must lose the capability too; a previous report cannot promise it still applies patches.
          db.prepare("UPDATE machines SET runner_settings = ? WHERE id = ?").run(runnerSettings ? JSON.stringify(runnerSettings) : null, actor.name);
          if (runnerSettings) db.prepare("UPDATE machines SET max_parallel = ? WHERE id = ?").run(runnerSettings.maxParallel, actor.name);
          const pendingRunner = this.#toMachine(db.prepare("SELECT * FROM machines WHERE id = ?").get(actor.name) as Row).runnerChange;
          if (pendingRunner && (pendingRunner.requestedAt < this.#now(-PROFILE_CHANGE_HOURS * 60) ||
              (runnerSettings && Object.entries(pendingRunner.settings).every(([key, value]) => runnerSettings[key as keyof MachineRunnerSettings] === value)))) {
            db.prepare("UPDATE machines SET runner_change = NULL WHERE id = ?").run(actor.name);
          }
          if (!runnerSettings && maxParallel !== undefined) db.prepare("UPDATE machines SET max_parallel = ? WHERE id = ?").run(maxParallel, actor.name);
          if (acceptsRuns !== undefined) db.prepare("UPDATE machines SET accepts_runs = ? WHERE id = ?").run(acceptsRuns ? 1 : 0, actor.name);
          // Missing on older clients and cleared on the first heartbeat after a restart.
          db.prepare("UPDATE machines SET update_draining = ? WHERE id = ?").run(updateDraining ? 1 : 0, actor.name);
          if (!actor.tokenId) db.prepare("UPDATE machines SET owner = ? WHERE id = ? AND token_id IS NULL").run(actor.account ?? null, actor.name);
          db.prepare("DELETE FROM machine_profile_changes WHERE requested_at < ?").run(this.#now(-PROFILE_CHANGE_HOURS * 60));
          if (profiles) {
            const drop = db.prepare("DELETE FROM machine_profile_changes WHERE machine_id = ? AND profile_id = ?");
            for (const c of this.#profileChanges(actor.name)) {
              const p = profiles.find((x) => x.id === c.profileId);
              // Gone from the machine, or reported as asked: nothing is left to send.
              if (!p || ((c.enabled === null || p.enabled === c.enabled) && (c.priority === null || p.priority === c.priority) && (c.stopAtSession == null || p.stopAtSession === c.stopAtSession) && (c.stopAtWeek == null || p.stopAtWeek === c.stopAtWeek))) drop.run(actor.name, c.profileId);
            }
          }
          // A machine resends until the hub answers, so a run is kept as first reported.
          const cost = db.prepare(
            `INSERT OR IGNORE INTO run_costs(machine_id, run_id, machine, project, task_id, profile_id, account, cost_usd, input_tokens, output_tokens, finished_at, requested_by,
               cache_write_tokens, cache_read_tokens, priced)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          );
          const owner = requesterOf(actor);
          for (const c of costs) {
            cost.run(
              actor.name, c.runId, machine, c.project, c.taskId, c.profileId, c.account, c.costUsd ?? 0, c.inputTokens, c.outputTokens, c.finishedAt,
              c.requestedBy ?? owner, c.cacheWriteTokens, c.cacheReadTokens, c.costUsd === null ? 0 : 1,
            );
          }
          db.prepare("DELETE FROM run_costs WHERE finished_at < ?").run(this.#now(-COST_DAYS * 24 * 60));
          // Forgetting an offline hub machine would let a namesake inherit its id and old records, even after migration.
          db.prepare("DELETE FROM machines WHERE token_id IS NULL AND last_seen < ? AND NOT EXISTS (SELECT 1 FROM hub_tokens)").run(this.#now(-MACHINE_TTL_DAYS * 24 * 60));
          this.#expireCommands();
          const pending = (
            db.prepare("SELECT * FROM machine_commands WHERE machine_id = ? AND status = 'pending' ORDER BY id").all(actor.name) as Row[]
          ).map(toCommand);
          const commands = pending.filter((c) => c.kind === "install");
          // Sent until the machine reports it running, whether or not it takes runs: a sync only writes Hive's own files.
          const syncCommands = pending.filter((c) => c.kind === "sync");
          this.#expireRequests();
          const accepts = num((db.prepare("SELECT accepts_runs FROM machines WHERE id = ?").get(actor.name) as Row).accepts_runs) === 1;
          // The user turned it off after a manager queued something: say so on the web instead of letting it expire.
          this.#expireChats();
          if (!accepts && !updateDraining) {
            const error: RunRequestError = { message: `${machine} does not take runs from the hub.`, key: "errors.machineNoHubRuns", vars: { machine } };
            db.prepare("UPDATE run_requests SET status = 'rejected', error = ?, updated_at = ? WHERE machine_id = ? AND status = 'pending'").run(
              JSON.stringify(error),
              now,
              actor.name,
            );
            db.prepare(
              `UPDATE chat_messages SET status = 'failed', error = ?, updated_at = ?, finished_at = ?
               WHERE status = 'pending' AND thread_id IN (SELECT id FROM chat_threads WHERE machine_id = ?)`,
            ).run(JSON.stringify(error), now, now, actor.name);
          }
          // With this beat's runs in, so a run that ended leaves its place to the next of its group, sent in this answer.
          this.#approveTimedPlans();
          this.#release();
          this.#releaseFlows();
          // Held back rather than rejected for an archived project: restoring it lets the work go on, and anything
          // still waiting when the fifteen minutes are up expires on its own.
          const runRequests = accepts
            ? (db.prepare("SELECT * FROM run_requests WHERE machine_id = ? AND status = 'pending' ORDER BY id").all(actor.name) as Row[])
                .map((r) => this.#withAllowedKinds(toRunRequest(r)))
                .filter((r) => !hidden.has(r.project))
            : [];
          // Sent again at every heartbeat until the machine reports progress on it.
          const chatRequests = accepts ? this.#chatRequests(actor.name).filter((r) => !hidden.has(r.project)) : [];
          this.#expireMerges();
          // Sent again at every heartbeat until the machine reports how it went.
          const mergeRuns = accepts
            ? (
                db
                  .prepare("SELECT run_id, mr_url, merge_by FROM run_records WHERE machine_id = ? AND merge_status = 'pending' AND mr_url IS NOT NULL ORDER BY merge_at")
                  .all(actor.name) as Row[]
              ).map((r) => ({ runId: str(r.run_id), mrUrl: str(r.mr_url), requestedBy: str(r.merge_by) }))
            : [];
          // Until the machine pushes the run as ended.
          const cancelRuns = accepts || updateDraining
            ? (
                db
                  .prepare("SELECT run_id, cancel_by FROM run_records WHERE machine_id = ? AND cancel_by IS NOT NULL AND status IN ('queued', 'running') ORDER BY cancel_at")
                  .all(actor.name) as Row[]
              ).map((r) => ({ runId: str(r.run_id), requestedBy: str(r.cancel_by) }))
            : [];
          const tools = this.#machineTools(actor);
          return {
            ...(gateReply ? { gate: gateReply } : {}),
            supportsUpdateDrain: true,
            duplicate: duplicateAt !== null && duplicateAt > this.#now(-DUPLICATE_MINUTES),
            cooldowns: this.#cooldowns(),
            policy: this.#policy(),
            agentPolicy: this.#machineAgentPolicy(actor),
            tools,
            worktreeCommands: this.#worktreeCommands(actor.name, true),
            toolApprovals: (db.prepare("SELECT a.* FROM machine_tool_approvals a JOIN tools t ON t.id = a.tool_id WHERE a.machine_id = ? AND a.applied_at IS NULL").all(actor.name) as Row[])
              .map((a) => { const { appliedAt: _appliedAt, ...approval } = this.#toolApproval(a); return approval; })
              .filter((a) => tools.entries.some((e) => e.id === a.toolId && toolHash(e) === a.hash)),
            commands,
            syncCommands,
            runRequests,
            chatRequests,
            cancelRuns,
            runMessages: accepts || updateDraining ? (db.prepare(`SELECT m.*, r.project FROM run_messages m JOIN run_records r
              ON r.machine_id = m.machine_id AND r.run_id = m.run_id
              WHERE m.machine_id = ? AND m.delivered_at IS NULL AND r.status = 'running'
              ORDER BY m.id`).all(actor.name) as Row[])
              .filter((r) => sees(actor, str(r.project)) && !hidden.has(str(r.project)))
              .slice(0, 100)
              .map(toRunMessage) : [],
            paused: this.#pausedFor(this.#paused(), actor),
            // After this beat's costs went in, so a run that just filled a cap holds the next one at once.
            budgetBlocked: this.#budgetBlocks(actor),
            profileChanges: this.#profileChanges(actor.name),
            runnerChange: this.#toMachine(db.prepare("SELECT * FROM machines WHERE id = ?").get(actor.name) as Row).runnerChange,
            mergeRuns,
            archivedProjects,
          };
        }),

      // Keyed by the hub actor, like the heartbeat: two machines may number their runs alike.
      "runs.push": ({ machine, runs }, actor) =>
        this.#tx(() => {
          const now = this.#now();
          const put = db.prepare(
            `INSERT INTO run_records(machine_id, run_id, machine, project, task_id, task_title, role, status, profile_id, activity,
               summary, error, branch, commits, mr_url, cost_usd, log, created_at, started_at, finished_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(machine_id, run_id) DO UPDATE SET machine = excluded.machine, project = excluded.project,
               task_id = excluded.task_id, task_title = excluded.task_title, role = excluded.role, status = excluded.status,
               profile_id = excluded.profile_id, activity = excluded.activity, summary = excluded.summary, error = excluded.error,
               branch = excluded.branch, commits = excluded.commits, mr_url = excluded.mr_url, cost_usd = excluded.cost_usd,
               log = excluded.log, started_at = excluded.started_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at,
               log_pruned_at = NULL`,
          );
          // Sent only when it changed: left out, the one the hub has stays.
          const patchPut = db.prepare("UPDATE run_records SET patch = ? WHERE machine_id = ? AND run_id = ?");
          const mrPut = db.prepare("UPDATE run_records SET mr = ? WHERE machine_id = ? AND run_id = ?");
          const compressionPut = db.prepare("UPDATE run_records SET compression = ? WHERE machine_id = ? AND run_id = ?");
          // One statement per set of fields sent: the column names come from the fixed list below, never from the push.
          const ranOnPut = new Map<string, ReturnType<typeof db.prepare>>();
          const ownerPut = db.prepare(
            `UPDATE run_records SET requested_by = COALESCE(
               (SELECT COALESCE(on_behalf, requested_by) FROM run_requests WHERE machine_id = ?1 AND run_id = ?2 AND status = 'accepted'), ?3)
             WHERE machine_id = ?1 AND run_id = ?2 AND requested_by IS NULL`,
          );
          const prior = db.prepare("SELECT status FROM run_records WHERE machine_id = ? AND run_id = ?");
          const ended: typeof runs = [];
          for (const r of runs) {
            const before = (prior.get(actor.name, r.runId) as Row | undefined)?.status;
            if ((["succeeded", "failed", "cancelled"].includes(r.status) || (r.status === "rate_limited" && db.prepare("SELECT 1 FROM run_requests WHERE machine_id = ? AND run_id = ? AND json_extract(plan, '$.phase') = 'plan'").get(actor.name, r.runId))) && (before === undefined || ["queued", "running"].includes(str(before)))) ended.push(r);
            // The machine already hid secret-looking lines; this is the hub's own check of what it keeps.
            put.run(
              actor.name, r.runId, machine, r.project, r.taskId, stripHidden(r.taskTitle), r.role, r.status, r.profileId,
              clean(r.activity), clean(r.summary), clean(r.error), r.branch, r.commits, r.mrUrl, r.costUsd, clean(r.log) ?? "",
              r.createdAt, r.startedAt, r.finishedAt, now,
            );
            if (r.patch !== undefined) {
              const patch = redactLines(stripHidden(r.patch));
              db.prepare("UPDATE run_records SET diff_review = NULL WHERE machine_id = ? AND run_id = ? AND patch IS NOT ?").run(actor.name, r.runId, patch);
              patchPut.run(patch, actor.name, r.runId);
            }
            if (r.diffReview !== undefined) {
              const stored = db.prepare("SELECT patch FROM run_records WHERE machine_id = ? AND run_id = ?").get(actor.name, r.runId) as Row;
              const review = r.diffReview && validDiffReview(r.diffReview, patchHunks(str(stored.patch)));
              db.prepare("UPDATE run_records SET diff_review = ? WHERE machine_id = ? AND run_id = ?").run(review ? JSON.stringify({
                groups: review.groups.map(g => ({ ...g, title: clean(g.title) ?? "", explanation: clean(g.explanation) ?? "" })),
                risks: review.risks.map(risk => ({ ...risk, explanation: clean(risk.explanation) ?? "" })),
              }) : null, actor.name, r.runId);
            }
            if (r.mr !== undefined) {
              const mr = r.mr && { ...r.mr, pipelineUrl: r.mr.pipelineUrl && /^https?:\/\//.test(r.mr.pipelineUrl) ? r.mr.pipelineUrl : null };
              mrPut.run(mr ? JSON.stringify(mr) : null, actor.name, r.runId);
            }
            if (r.skills !== undefined) db.prepare("UPDATE run_records SET skills = ? WHERE machine_id = ? AND run_id = ?").run(JSON.stringify([...new Set(r.skills)]), actor.name, r.runId);
            if (r.compression !== undefined) compressionPut.run(r.compression ? JSON.stringify(r.compression) : null, actor.name, r.runId);
            // An older app sends no verdict: a review's is read here from the summary, which it clipped, so a verdict
            // past its end reads as unknown. The app reads the whole report.
            const verdict = r.verdict !== undefined ? r.verdict : r.role === "review" && r.status === "succeeded" ? parseVerdict(clean(r.summary)) : undefined;
            const ranOn: Array<[string, unknown]> = [
              ["kind", r.kind],
              ["model", r.model],
              ["effort", r.effort],
              ["tier", r.tier],
              ["attempt", r.attempt],
              ["parent_run", db.prepare("SELECT parent_machine_id FROM run_records WHERE machine_id = ? AND run_id = ?").get(actor.name, r.runId)?.parent_machine_id ? undefined : r.parentRun],
              ["instructions", r.instructions === undefined ? undefined : clean(r.instructions)],
              ["base_sha", r.baseSha],
              ["head_sha", r.headSha],
              ["verdict", verdict],
            ];
            const sent = ranOn.filter(([, v]) => v !== undefined);
            if (sent.length) {
              const sql = `UPDATE run_records SET ${sent.map(([c]) => `${c} = ?`).join(", ")} WHERE machine_id = ? AND run_id = ?`;
              const stmt = ranOnPut.get(sql) ?? ranOnPut.set(sql, db.prepare(sql)).get(sql)!;
              stmt.run(...sent.map(([, v]) => v as string | number | null), actor.name, r.runId);
            }
            const req = db.prepare("SELECT plan, redispatch, instructions FROM run_requests WHERE machine_id = ? AND run_id = ? AND status = 'accepted'").get(actor.name, r.runId) as Row | undefined;
            if (req) db.prepare("UPDATE run_records SET instructions = COALESCE(instructions, ?) WHERE machine_id = ? AND run_id = ?").run(str(req.instructions), actor.name, r.runId);
            if (req?.redispatch) this.#linkRedispatch(actor.name, r.runId, JSON.parse(str(req.redispatch)));
            if (req?.plan) {
              db.prepare("UPDATE run_records SET plan = ? WHERE machine_id = ? AND run_id = ?").run(str(req.plan), actor.name, r.runId);
              const plan = JSON.parse(str(req.plan)) as RunPlan;
              if (plan.phase === "plan") {
                const saved = db.prepare("SELECT status FROM implementation_plans WHERE id = ?").get(plan.id) as Row | undefined;
                // A terminal plan is immutable even when a machine replays its original succeeded/empty result.
                if (saved?.status === "failed" || saved?.status === "cancelled") db.prepare("UPDATE run_records SET status = ? WHERE machine_id = ? AND run_id = ?").run(str(saved.status), actor.name, r.runId);
              }
            }
            // Whose run it is, set once: whoever asked for it from the web, else the person whose token the machine has
            // (a run started from its Board). A machine takes a request (runs.requestResult) before it pushes the run.
            ownerPut.run(actor.name, r.runId, principalOf(actor));
          }
          // The heavy part of an old run goes, the record stays (roadmap 41b): what the agent concluded, its MR and what
          // it cost outlive the log. log_pruned_at IS NULL: a run cleaned once is not touched again.
          if (this.#opts.runLogDays > 0) {
            db.prepare("UPDATE run_records SET log = '', patch = NULL, diff_review = NULL, log_pruned_at = ? WHERE updated_at < ? AND log_pruned_at IS NULL").run(
              now,
              this.#now(-this.#opts.runLogDays * 24 * 60),
            );
          }
          // Flows (roadmap 34b) move on the step or check that just ended, then queue what comes next.
          for (const r of ended) {
            const run = { ...r, summary: clean(r.summary) ?? null, error: clean(r.error) ?? null };
            // A classify run (roadmap 54b) is not the task's work: it only fills the task's kind, then the release below
            // queues the task's own run.
            if (run.role === "classify") {
              const row = db
                .prepare("SELECT c.task_id FROM task_classify_runs c JOIN run_requests q ON q.id = c.request_id WHERE q.machine_id = ? AND q.run_id = ?")
                .get(actor.name, run.runId) as Row | undefined;
              if (row) {
                let result: TaskClass | null = null;
                try {
                  result = run.status === "succeeded" && run.summary ? parseTaskClass(JSON.parse(run.summary)) : null;
                } catch {
                  // Not JSON: the default below, as for a failed run.
                }
                this.#finishClassify(str(row.task_id), result);
              }
              continue;
            }
            const planRequest = db.prepare("SELECT * FROM run_requests WHERE machine_id = ? AND run_id = ? AND plan IS NOT NULL").get(actor.name, run.runId) as Row | undefined;
            const plan = planRequest?.plan ? JSON.parse(str(planRequest.plan)) as RunPlan : null;
            if (plan?.phase === "plan") {
              const text = clean(run.planText ?? null)?.trim() ?? "";
              const pending = db.prepare("SELECT * FROM implementation_plans WHERE id = ? AND status = 'planning'").get(plan.id) as Row | undefined;
              if (pending) {
                const ok = run.status === "succeeded" && text.length > 0;
                db.prepare("UPDATE implementation_plans SET status = ?, text = ?, run_id = ?, ready_at = ?, deadline = ? WHERE id = ?")
                  .run(ok ? "waiting" : run.status === "cancelled" ? "cancelled" : "failed", ok ? text : null, run.runId, now, ok && pending.timeout_minutes != null ? this.#now(num(pending.timeout_minutes)) : null, plan.id);
                const snapshot = JSON.stringify({ ...plan, text: ok ? text : null });
                db.prepare("UPDATE run_records SET plan = ? WHERE machine_id = ? AND run_id = ?").run(snapshot, actor.name, run.runId);
                db.prepare("UPDATE run_requests SET plan = ? WHERE id = ?").run(snapshot, num(planRequest!.id));
                if (!ok) {
                  const failed = { ...run, status: run.status === "cancelled" ? "cancelled" : "failed", error: run.error ?? "Plan phase failed or returned no plan." };
                  db.prepare("UPDATE run_records SET status = ?, error = ? WHERE machine_id = ? AND run_id = ?").run(failed.status, failed.error, actor.name, run.runId);
                  this.#flowRunEnded(actor.name, failed);
                  this.#taskRunEnded(actor.name, failed);
                  this.#agentRunEnded(failed, actor.name);
                }
              }
              continue;
            }
            this.#flowRunEnded(actor.name, run);
            this.#taskRunEnded(actor.name, run);
            // A run that failed stops its agent at that task (roadmap 50) before the release below looks at the queue.
            this.#agentRunEnded(run, actor.name);
            this.#agentFixTurn(run, actor.name);
          }
          // An MR that turned green, or merged, moves a flow task on as well.
          this.#releaseFlows();
          // A run that ended moves its group, and its agent's queue, on now rather than at the next heartbeat.
          if (ended.length) this.#release();
          return { stored: runs.length };
        }),

      // A machine's whole view of the project each time: what it no longer sends it no longer has (merged, removed).
      "specs.push": ({ project, features }, actor) =>
        this.#tx(() => {
          const now = this.#now();
          const put = db.prepare(
            `INSERT INTO spec_features(project, dir, branch, title, files, commit_sha, machine, pushed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, dir, branch) DO UPDATE SET title = excluded.title, files = excluded.files,
               commit_sha = excluded.commit_sha, machine = excluded.machine, pushed_at = excluded.pushed_at`,
          );
          const kept = new Set<string>();
          for (const f of features) {
            // The repo's text as the team may see it, like a run's patch: no hidden characters, no secret-looking line.
            const files: SpecFiles = { spec: clean(f.files.spec), plan: clean(f.files.plan), tasks: clean(f.files.tasks) };
            put.run(project, f.dir, f.branch, stripHidden(specTitle(files.spec, f.dir)).slice(0, 300), JSON.stringify(files), f.commit, actor.name, now);
            kept.add(JSON.stringify([f.dir, f.branch]));
          }
          const mine = db.prepare("SELECT dir, branch FROM spec_features WHERE project = ? AND machine = ?").all(project, actor.name) as Row[];
          const drop = db.prepare("DELETE FROM spec_features WHERE project = ? AND dir = ? AND branch = ?");
          let removed = 0;
          for (const r of mine) {
            if (kept.has(JSON.stringify([str(r.dir), str(r.branch)]))) continue;
            drop.run(project, str(r.dir), str(r.branch));
            removed++;
          }
          // A flow waiting for the folder its specify step made, or for its tasks.md, may go on now.
          this.#releaseFlows();
          return { stored: features.length, removed };
        }),

      "specs.list": ({ project, projects }) =>
        (
          db
            .prepare(
              `SELECT * FROM spec_features WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR project IN (SELECT value FROM json_each(?2)))
               ORDER BY branch <> '', dir, branch, project`,
            )
            .all(project ?? null, listParam(projects)) as Row[]
        ).map((r) => {
          const feature: SpecFeature & { files?: SpecFiles } = toSpecFeature(r);
          delete feature.files;
          return feature;
        }),

      "specs.importTasks": ({ project, dir, branch, prefix, dryRun }, actor) => this.#tx(() => this.#importSpecTasks(project, dir, branch, prefix ?? null, dryRun, actor)),

      "specs.get": ({ project, dir, branch }, actor) => {
        // A project the caller does not see answers like a missing feature.
        if (!sees(actor, project)) return null;
        const row = db.prepare("SELECT * FROM spec_features WHERE project = ? AND dir = ? AND branch = ?").get(project, dir, branch) as Row | undefined;
        return row ? toSpecFeature(row) : null;
      },

      "runs.list": ({ project, projects, limit, taskId, activeOnly }) =>
        (
          db
            .prepare(
              `SELECT r.*, ${RUN_TOKEN_COLUMNS}, ${RUN_SELECTION_COLUMN} FROM run_records r LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id
               WHERE (?1 IS NULL OR r.project = ?1) AND (?3 IS NULL OR r.project IN (SELECT value FROM json_each(?3))) AND (?4 IS NULL OR r.task_id = ?4) AND (?5 = 0 OR r.status IN ('queued', 'running')) ORDER BY r.created_at DESC, r.rowid DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, listParam(projects), taskId ?? null, activeOnly ? 1 : 0) as Row[]
        ).map((r) => toRunRecord(r, false)),

      "runs.get": ({ machineId, runId }, actor) => {
        const row = db
          .prepare(`SELECT r.*, ${RUN_TOKEN_COLUMNS}, ${RUN_SELECTION_COLUMN}, (SELECT q.instructions FROM run_requests q WHERE q.machine_id = r.machine_id AND q.run_id = r.run_id AND q.status = 'accepted' ORDER BY q.id DESC LIMIT 1) AS request_instructions FROM run_records r LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id WHERE r.machine_id = ? AND r.run_id = ?`)
          .get(machineId, runId) as Row | undefined;
        // The research summary can include evidence from more than its anchor service.
        const research = row?.role === "research" ? this.#researchForTask(str(row.project), str(row.task_id)) : undefined;
        if (research && !this.#researchVisible(research, actor)) return null;
        // A run of a project the caller does not see answers like a missing one.
        return row && sees(actor, str(row.project)) ? {
          ...toRunRecord(row, true),
          messages: (db.prepare("SELECT * FROM run_messages WHERE machine_id = ? AND run_id = ? ORDER BY id").all(machineId, runId) as Row[]).map(toRunMessage),
        } : null;
      },

      "runs.steer": ({ machineId, runId, text }, actor) => this.#tx(() => {
        const row = db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row | undefined;
        if (!row) throw new HiveError("not_found", `No run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
        if (this.#projectState(str(row.project)) !== null) throw this.#projectGone(str(row.project));
        if (str(row.status) !== "running") throw new HiveError("conflict", `Run ${runId} is not running.`, { key: "errors.runNotRunning", vars: { id: runId } });
        const machine = db.prepare("SELECT accepts_runs, update_draining FROM machines WHERE id = ?").get(machineId) as Row | undefined;
        if (!machine || (num(machine.accepts_runs) !== 1 && num(machine.update_draining) !== 1)) throw new HiveError("bad_request", "Machine does not accept hub runs.", { key: "errors.machineNoHubRuns", vars: { machine: str(row.machine) } });
        assertNoHidden(text, "text");
        assertNoSecret(text, "text");
        const result = db.prepare("INSERT INTO run_messages(run_id, machine_id, text, by, at) VALUES (?, ?, ?, ?, ?)").run(runId, machineId, text, actor.name, this.#now());
        return toRunMessage(db.prepare("SELECT * FROM run_messages WHERE id = ?").get(result.lastInsertRowid) as Row);
      }),

      // Only a machine that takes runs from the hub obeys it: its user let project managers drive it from the web.
      "runs.cancel": ({ machineId, runId }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
          const status = str(row.status);
          if (status !== "queued" && status !== "running") {
            throw new HiveError("conflict", `Run ${runId} has ended (${status}).`, { key: "errors.runEnded", vars: { id: runId } });
          }
          const machine = db.prepare("SELECT accepts_runs, update_draining FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!machine || (num(machine.accepts_runs) !== 1 && num(machine.update_draining) !== 1)) {
            throw new HiveError("bad_request", `${str(row.machine)} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: { machine: str(row.machine) } });
          }
          // Asked once: a second click keeps who asked first.
          db.prepare("UPDATE run_records SET cancel_by = ?, cancel_at = ? WHERE machine_id = ? AND run_id = ? AND cancel_by IS NULL").run(actor.name, this.#now(), machineId, runId);
          return toRunRecord(db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row, false);
        }),

      "runs.ciPolicy": ({ project, mrUrl }) => ({ fixCi: !db.prepare("SELECT 1 FROM mr_ci_policy WHERE project = ? AND mr_url = ?").get(project, mrUrl) }),
      "runs.stopCi": ({ project, mrUrl }, actor) => {
        db.prepare("INSERT OR IGNORE INTO mr_ci_policy(project, mr_url, stopped_by, stopped_at) VALUES (?, ?, ?, ?)").run(project, mrUrl, actor.name, this.#now());
        return { fixCi: false };
      },

      // The run's machine merges with its own token: the hub keeps no forge secret.
      "runs.merge": ({ machineId, runId }, actor) =>
        this.#tx(() => {
          this.#expireMerges();
          const row = db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
          const run = toRunRecord(row, false);
          if (!run.mrUrl) throw new HiveError("bad_request", `Run ${runId} has no merge request.`, { key: "errors.runNoMr", vars: { id: runId } });
          const mr = run.mr;
          if (mr?.status === "merged" || mr?.status === "closed") {
            throw new HiveError("conflict", `${run.mrUrl} is ${mr.status}.`, { key: "errors.mrNotOpen", vars: { status: mr.status } });
          }
          // Draft: the review asked for changes, or the MR went up before its review; mark it ready on GitLab/GitHub first.
          if (mr?.draft) throw new HiveError("bad_request", `${run.mrUrl} is a draft.`, { key: "errors.mrDraft" });
          if (mr?.pipeline === "failed") throw new HiveError("bad_request", `The pipeline of ${run.mrUrl} failed.`, { key: "errors.mrPipelineFailed" });
          const machine = db.prepare("SELECT accepts_runs, machine FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!machine || num(machine.accepts_runs) !== 1) {
            throw new HiveError("bad_request", `${run.machine} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: { machine: run.machine } });
          }
          // Other runs of the task point at the same MR: one merge at a time.
          const open = db.prepare("SELECT run_id FROM run_records WHERE mr_url = ? AND merge_status = 'pending'").get(run.mrUrl) as Row | undefined;
          if (open) throw new HiveError("conflict", `A merge of ${run.mrUrl} is already waiting.`, { key: "errors.mergePending" });
          db.prepare("UPDATE run_records SET merge_by = ?, merge_at = ?, merge_status = 'pending', merge_error = NULL, merge_done_at = NULL WHERE machine_id = ? AND run_id = ?").run(
            actor.account ?? actor.name,
            this.#now(),
            machineId,
            runId,
          );
          return toRunRecord(db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row, false);
        }),

      "runs.mergeResult": ({ runId, ok, error }, actor) =>
        this.#tx(() => {
          // Keyed by the heartbeat's actor: a machine reports on its own runs only.
          const row = db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(actor.name, runId) as Row | undefined;
          if (!row || row.merge_status == null) throw new HiveError("not_found", `No merge asked for run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
          const now = this.#now();
          const merged = { ...(row.mr == null ? { iid: null, draft: false, pipeline: null, pipelineUrl: null } : (JSON.parse(String(row.mr)) as RunMr)), status: "merged", checkedAt: now };
          db.prepare("UPDATE run_records SET merge_status = ?, merge_error = ?, merge_done_at = ?, mr = CASE WHEN ? THEN ? ELSE mr END WHERE machine_id = ? AND run_id = ?").run(
            ok ? "merged" : "failed",
            ok ? null : JSON.stringify(cleanMachineError(error ?? { message: "merge failed" })),
            now,
            ok ? 1 : 0,
            JSON.stringify(merged),
            actor.name,
            runId,
          );
          return toRunRecord(db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(actor.name, runId) as Row, false);
        }),

      "runs.timeoutSettings": () => this.#runTimeoutSettings(),
      "runs.setTimeoutSettings": (settings) => {
        db.prepare("INSERT INTO settings(key, value) VALUES ('runTimeout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(settings));
        return this.#runTimeoutSettings();
      },
      "runs.dispatch": ({ machineId, project, taskId, role, profileId: requestedProfile, preferKind, reviewAfter, candidates, instructions, timeoutMinutes, redispatch: source }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(taskId);
          if (!task || task.project !== project) {
            throw new HiveError("not_found", `No task ${taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { id: taskId, project } });
          }
          // A pinned task stays on its plan when the caller names none: a run quietly landing on another plan is the bug
          // this guards. Only a plain implement run: a review wants another vendor, a redispatch another runner, candidates rotate.
          const profileId = requestedProfile ?? (role === "implement" && candidates === 1 && !source ? this.#pinnedProfile(task, machineId) : null);
          const redispatch = this.#redispatch(source, task);
          if (redispatch && candidates !== 1) throw new HiveError("bad_request", "Redispatch requires one run.", { key: "errors.redispatchOne" });
          // Its flow queues its steps itself, and would take this run for one of them.
          const flow = this.#flowRow(taskId);
          if (flow && ["running", "check", "checking", "next"].includes(str(flow.state))) {
            throw new HiveError("conflict", `Task ${taskId} is in a flow that is going on.`, { key: "errors.taskInFlow", vars: { id: taskId } });
          }
          // Pick at dispatch time, when the hub knows which plans and machines still have room.
          const m = this.#assertDispatchable({ machineId: machineId ?? task.agent?.machineId ?? this.#mapMachine(project, null, profileId).id, project, task, role, profileId, candidates, instructions }, actor);
          this.#requestTimeout(m, task, profileId, timeoutMinutes);
          if (redispatch) this.#assertRedispatchRunner(m, profileId);
          // Its group would run it again once this run ended.
          this.#assertNotInGroup(taskId);
          // A task only ever reviewed is a review (roadmap 54b rules); it only fills an empty kind.
          if (role === "review") this.#applyTaskRule(taskId, { role });
          // No kind yet: the classify run goes first and this run waits in task_classify_dispatches until it ends
          // (#releaseClassifyDispatches). The answer is the classify request, so the caller sees something queued.
          if (role === "implement" && this.#queueClassify(task, m, actor)) {
            db.prepare(
              `INSERT INTO task_classify_dispatches(task_id, project, request, requested_by, on_behalf) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(task_id) DO UPDATE SET request = excluded.request, requested_by = excluded.requested_by, on_behalf = excluded.on_behalf`,
            ).run(
              taskId,
              project,
              JSON.stringify({ machineId, project, taskId, role, profileId, preferKind, reviewAfter, candidates, instructions, timeoutMinutes, redispatch: source }),
              actor.name,
              actor.onBehalf ?? null,
            );
            const pending = db.prepare("SELECT request_id FROM task_classify_runs WHERE task_id = ?").get(taskId) as Row;
            return this.#runRequest(num(pending.request_id));
          }
          return this.#dispatchDirect(m, project, task, { role, profileId, preferKind, reviewAfter, candidates, instructions, timeoutMinutes, redispatch }, actor);
        }),

      "runs.dispatchMany": ({ project, title, items, maxParallel, reviewAfter, instructions }, actor) =>
        this.#tx(() => {
          this.#assertNotPaused(project);
          // What does not change while an item waits is checked now, so a mistake is heard at once and nothing is made.
          assertNoHidden(title, "Title");
          assertNoHidden(instructions, "Instructions");
          assertNoSecret(instructions, "Instructions");
          this.#assertBudget(project, actor);
          const seen = new Set<string>();
          for (const item of items) {
            const vars = { id: item.taskId };
            if (seen.has(item.taskId)) throw new HiveError("bad_request", `Task ${item.taskId} is twice in the group.`, { key: "errors.taskTwiceInGroup", vars });
            seen.add(item.taskId);
            const task = this.#getTask(item.taskId);
            if (!task || task.project !== project) {
              throw new HiveError("not_found", `No task ${item.taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { ...vars, project } });
            }
            if (task.status === "done") throw new HiveError("bad_request", `Task ${item.taskId} is done.`, { key: "errors.taskDone", vars });
            this.#assertNotInGroup(item.taskId);
            if (!item.machineId) continue;
            const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(item.machineId) as Row | undefined;
            if (!row) throw new HiveError("not_found", `No machine ${item.machineId}.`, { key: "errors.machineNotFound", vars: { machine: item.machineId } });
            const m = this.#toMachine(row);
            if (!m.projects.includes(project)) {
              throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { machine: m.machine, project } });
            }
            if (item.profileId && !m.profiles.some((p) => p.id === item.profileId)) {
              throw new HiveError("bad_request", `${m.machine} has no profile ${item.profileId}.`, { key: "errors.profileNotOnMachine", vars: { machine: m.machine, id: item.profileId } });
            }
          }
          const now = this.#now();
          const res = db
            .prepare(
              `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, created_by, on_behalf, created_at)
               VALUES (?, 'batch', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(project, title.trim(), maxParallel, reviewAfter ? 1 : 0, instructions, actor.name, actor.onBehalf ?? null, now);
          const groupId = num(res.lastInsertRowid);
          const put = db.prepare(
            "INSERT INTO run_group_items(group_id, position, task_id, role, machine_id, profile_id, prefer_kind, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)",
          );
          items.forEach((item, i) => put.run(groupId, i + 1, item.taskId, item.role, item.machineId, item.profileId, item.profileId ? null : item.preferKind, now));
          this.#release();
          return this.#group(groupId);
        }),

      "runs.fanout": ({ project, title, prompt, targets, reviewAfter }, actor) =>
        this.#tx(() => {
          this.#assertNotPaused(project);
          const heading = (title?.trim() || prompt.trim().split(/\r?\n/, 1)[0]!.trim()).slice(0, 120);
          for (const [text, what] of [[heading, "Title"], [prompt, "Instructions"]] as const) {
            assertNoHidden(text, what);
            assertNoSecret(text, what);
          }
          this.#assertBudget(project, actor);
          const names = new Map<string, string>();
          for (const t of targets) {
            if (!t.machineId) continue;
            const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(t.machineId) as Row | undefined;
            if (!row) throw new HiveError("not_found", `No machine ${t.machineId}.`, { key: "errors.machineNotFound", vars: { machine: t.machineId } });
            const m = this.#toMachine(row);
            if (!m.projects.includes(project)) {
              throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { machine: m.machine, project } });
            }
            if (t.profileId && !m.profiles.some((p) => p.id === t.profileId)) {
              throw new HiveError("bad_request", `${m.machine} has no profile ${t.profileId}.`, { key: "errors.profileNotOnMachine", vars: { machine: m.machine, id: t.profileId } });
            }
            names.set(t.machineId, m.machine);
          }
          const parent = this.#nextPromptTaskId();
          const children = targets.map((_, i) => `${parent}-${String.fromCharCode(97 + i)}`);
          for (const child of children) {
            if (this.#getTask(child)) throw new HiveError("conflict", `Task ${child} already exists.`, { key: "errors.taskExists", vars: { id: child } });
          }
          const now = this.#now();
          const note = prompt.slice(0, 2000);
          const put = db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)");
          put.run(parent, project, heading, note, now);
          this.#keepNote(parent, note, "todo", actor, now);
          // Where each one runs, in its title: "any" machine or profile is the hub's or the machine's pick.
          targets.forEach((t, i) => {
            const where = `${t.machineId ? names.get(t.machineId) : "*"}/${t.profileId ?? "*"}`;
            put.run(children[i]!, project, `${heading.slice(0, 100)} · ${where}`.slice(0, 300), note, now);
            this.#keepNote(children[i]!, note, "todo", actor, now);
          });
          for (const id of [parent, ...children]) this.#applyTaskRule(id);
          // Nobody runs the prompt's own task: it waits for its agents until one is picked.
          this.#setDeps(parent, children);
          const res = db
            .prepare(
              `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, parent_task, created_by, on_behalf, created_at)
               VALUES (?, 'fanout', ?, NULL, ?, ?, ?, ?, ?, ?)`,
            )
            // The agents read the prompt as their task's note; the instructions carry it only when the note had to cut it.
            .run(project, heading, reviewAfter ? 1 : 0, prompt.length > 2000 ? prompt : "", parent, actor.name, actor.onBehalf ?? null, now);
          const groupId = num(res.lastInsertRowid);
          const item = db.prepare(
            "INSERT INTO run_group_items(group_id, position, task_id, role, machine_id, profile_id, status, updated_at) VALUES (?, ?, ?, 'implement', ?, ?, 'held', ?)",
          );
          targets.forEach((t, i) => item.run(groupId, i + 1, children[i]!, t.machineId, t.profileId, now));
          this.#release();
          return this.#group(groupId);
        }),

      "runs.pickWinner": ({ groupId, taskId }, actor) =>
        this.#tx(() => {
          const g = this.#group(groupId);
          if (g.kind !== "fanout" || !g.parentTask) throw new HiveError("bad_request", `Run group #${groupId} is not one prompt for several agents.`, { key: "errors.notFanout", vars: { id: groupId } });
          if (g.winnerTask) throw new HiveError("conflict", `${g.winnerTask} was already kept in ${g.parentTask}.`, { key: "errors.winnerPicked", vars: { task: g.winnerTask, parent: g.parentTask } });
          if (!g.items.some((i) => i.taskId === taskId)) throw new HiveError("bad_request", `${taskId} is not in run group #${groupId}.`, { key: "errors.notInGroup", vars: { task: taskId, id: groupId } });
          // A run still going would hand its task back to review when it ends, after it was closed here.
          if (g.items.some((i) => i.status === "held" || i.active)) {
            throw new HiveError("conflict", `Run group #${groupId} still has agents working.`, { key: "errors.fanoutRunning", vars: { id: groupId } });
          }
          const now = this.#now();
          const close = db.prepare("UPDATE tasks SET status = 'done', owner = NULL, lease_until = NULL, note = ?, updated_at = ? WHERE id = ?");
          // The line that closes a candidate goes over its agent's handover, so that handover is kept as a version first.
          const closeNote = (id: string, text: string) => {
            const wasDone = this.#getTask(id)?.status === "done";
            close.run(text, now, id);
            this.#keepNote(id, text, "done", actor, now);
            if (!wasDone) this.#journalTask(id);
          };
          for (const i of g.items) {
            if (i.taskId !== taskId) closeNote(i.taskId, `Không chọn trong ${g.parentTask} (chọn ${taskId}).`);
          }
          closeNote(g.parentTask, `Chọn ${taskId}.`);
          db.prepare("UPDATE run_groups SET winner_task = ?, closed_at = COALESCE(closed_at, ?) WHERE id = ?").run(taskId, now, groupId);
          return this.#group(groupId);
        }),

      "runs.mapSplit": ({ project, title, prompt, machineId, profileId }, actor) =>
        this.#tx(() => {
          this.#assertNotPaused(project);
          const heading = (title?.trim() || prompt.trim().split(/\r?\n/, 1)[0]!.trim()).slice(0, 120);
          for (const [text, what] of [[heading, "Title"], [prompt, "Instructions"]] as const) {
            assertNoHidden(text, what);
            assertNoSecret(text, what);
          }
          this.#assertBudget(project, actor);
          const machine = this.#mapMachine(project, machineId, profileId);
          const parent = this.#nextPromptTaskId();
          const now = this.#now();
          db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(parent, project, heading, prompt.slice(0, 2000), now);
          this.#applyTaskRule(parent);
          this.#keepNote(parent, prompt.slice(0, 2000), "todo", actor, now);
          const task = this.#getTask(parent)!;
          // The job is the task's note; past the note's 2000 characters the instructions carry all of it.
          const instructions = [splitInstructions(), prompt.length > 2000 ? `The job, in full:\n${prompt}` : ""].filter(Boolean).join("\n\n");
          const m = this.#assertDispatchable({ machineId: machine.id, project, task, role: "plan", profileId, candidates: 1, instructions }, actor);
          const req = this.#insertRequest(m, project, task, { role: "plan", profileId, reviewAfter: false, candidates: 1, instructions }, actor);
          const res = db
            .prepare(
              `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, parent_task, created_by, on_behalf, created_at, phase, machine_id, phase_request)
               VALUES (?, 'mapreduce', ?, NULL, 1, ?, ?, ?, ?, ?, 'split', ?, ?)`,
            )
            // The job stays in the group: the split run writes its list over the task's note.
            .run(project, heading, prompt, parent, actor.name, actor.onBehalf ?? null, now, m.id, req.id);
          return this.#group(num(res.lastInsertRowid));
        }),

      "runs.mapReduce": ({ project, groupId, title, prompt, parts, machineId, profiles, maxParallel, reviewAfter }, actor) =>
        this.#tx(() => {
          this.#assertNotPaused(project);
          const split = groupId === undefined ? null : this.#group(groupId);
          if (split && (split.kind !== "mapreduce" || split.phase !== "ready" || split.project !== project || !split.parentTask || split.closedAt)) {
            throw new HiveError("conflict", `Run group #${groupId} has no parts waiting to run.`, { key: "errors.mapNotReady", vars: { id: groupId! } });
          }
          const job = split ? split.instructions : prompt.trim();
          if (!job) throw new HiveError("bad_request", "Write the job first.", { key: "errors.mapNoJob" });
          const heading = split ? split.title : (title?.trim() || job.split(/\r?\n/, 1)[0]!.trim()).slice(0, 120);
          for (const [text, what] of [[heading, "Title"], [job, "Instructions"], ...parts.map((p) => [p, "Part"] as const)] as const) {
            assertNoHidden(text, what);
            assertNoSecret(text, what);
          }
          this.#assertBudget(project, actor);
          const m = split ? this.#mapMachine(project, split.machineId) : this.#mapMachine(project, machineId);
          for (const id of profiles) {
            if (!m.profiles.some((p) => p.id === id)) throw new HiveError("bad_request", `${m.machine} has no profile ${id}.`, { key: "errors.profileNotOnMachine", vars: { machine: m.machine, id } });
          }
          const parent = split?.parentTask ?? this.#nextPromptTaskId();
          const children = parts.map((_, i) => `${parent}-${i + 1}`);
          for (const child of children) {
            if (this.#getTask(child)) throw new HiveError("conflict", `Task ${child} already exists.`, { key: "errors.taskExists", vars: { id: child } });
          }
          const now = this.#now();
          const put = db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)");
          // The split run handed the job's task in for review: it waits for its parts now.
          if (split) db.prepare("UPDATE tasks SET status = 'todo', owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(now, parent);
          else {
            put.run(parent, project, heading, job.slice(0, 2000), now);
            this.#keepNote(parent, job.slice(0, 2000), "todo", actor, now);
          }
          // Each part's note says what it is part of; the job itself reaches its run as instructions.
          parts.forEach((part, i) => {
            const note = `Phần ${i + 1}/${parts.length} của ${parent}: ${heading}\n\n${part}`.slice(0, 2000);
            put.run(children[i]!, project, part.split(/\r?\n/, 1)[0]!.slice(0, 300), note, now);
            this.#keepNote(children[i]!, note, "todo", actor, now);
          });
          for (const id of split ? children : [parent, ...children]) this.#applyTaskRule(id);
          // Nobody runs the job's task while its parts run: the merge run does, after them.
          this.#setDeps(parent, children);
          let id = split?.id;
          if (split) {
            db.prepare("UPDATE run_groups SET phase = 'map', parts = ?, max_parallel = ?, review_after = ?, phase_request = NULL, phase_error = NULL WHERE id = ?").run(
              JSON.stringify(parts),
              maxParallel,
              reviewAfter ? 1 : 0,
              split.id,
            );
          } else {
            const res = db
              .prepare(
                `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, parent_task, created_by, on_behalf, created_at, phase, parts, machine_id)
                 VALUES (?, 'mapreduce', ?, ?, ?, ?, ?, ?, ?, ?, 'map', ?, ?)`,
              )
              .run(project, heading, maxParallel, reviewAfter ? 1 : 0, job, parent, actor.name, actor.onBehalf ?? null, now, JSON.stringify(parts), m.id);
            id = num(res.lastInsertRowid);
          }
          const item = db.prepare(
            "INSERT INTO run_group_items(group_id, position, task_id, role, machine_id, profile_id, instructions, status, updated_at) VALUES (?, ?, ?, 'implement', ?, ?, ?, 'held', ?)",
          );
          children.forEach((child, i) => item.run(id!, i + 1, child, m.id, profiles.length ? profiles[i % profiles.length]! : null, partInstructions(parent, i + 1, parts.length), now));
          this.#release();
          return this.#group(id!);
        }),

      "runs.roles": ({ project, taskId, title, machineId, steps }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(taskId);
          if (!task || task.project !== project) {
            throw new HiveError("not_found", `No task ${taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { id: taskId, project } });
          }
          const flow = this.#flowRow(taskId);
          if (flow && ["running", "check", "checking", "next"].includes(str(flow.state))) {
            throw new HiveError("conflict", `Task ${taskId} is in a flow that is going on.`, { key: "errors.taskInFlow", vars: { id: taskId } });
          }
          const heading = (title.trim() || task.title).slice(0, 120);
          assertNoHidden(heading, "Title");
          for (const s of steps) {
            assertNoHidden(s.instructions, "Instructions");
            assertNoSecret(s.instructions, "Instructions");
          }
          // Every step on one machine: each finds the branch ai/<task> the steps before it left in its repository.
          const m = this.#mapMachine(project, machineId);
          for (const s of steps) {
            if (s.profileId && !m.profiles.some((p) => p.id === s.profileId)) {
              throw new HiveError("bad_request", `${m.machine} has no profile ${s.profileId}.`, { key: "errors.profileNotOnMachine", vars: { machine: m.machine, id: s.profileId } });
            }
          }
          // The first step goes now: checked as runs.dispatch checks it (online, takes runs, no run of the task going, cap).
          const first = steps[0]!;
          this.#assertDispatchable({ machineId: m.id, project, task, role: ROLE_STEP_RUN[first.step], profileId: first.profileId, candidates: 1, instructions: first.instructions }, actor);
          this.#assertNotInGroup(taskId);
          const now = this.#now();
          const res = db
            .prepare(
              `INSERT INTO run_groups(project, kind, title, max_parallel, review_after, instructions, parent_task, created_by, on_behalf, created_at, machine_id)
               VALUES (?, 'roles', ?, 1, 0, '', ?, ?, ?, ?, ?)`,
            )
            .run(project, heading, taskId, actor.name, actor.onBehalf ?? null, now, m.id);
          const groupId = num(res.lastInsertRowid);
          const item = db.prepare(
            "INSERT INTO run_group_items(group_id, position, task_id, role, step, machine_id, profile_id, instructions, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?)",
          );
          steps.forEach((s, i) => {
            const instructions = [stepInstructions(taskId, i + 1, steps), s.instructions.trim()].filter(Boolean).join("\n\n");
            item.run(groupId, i + 1, taskId, ROLE_STEP_RUN[s.step], s.step, m.id, s.profileId, instructions, now);
          });
          this.#releaseGroups();
          return this.#group(groupId);
        }),

      "runs.resumeGroup": ({ id }, actor) =>
        this.#tx(() => {
          const g = this.#group(id);
          if (g.kind === "roles") {
            if (g.phase !== "stopped") throw new HiveError("conflict", `Run group #${id} has not stopped.`, { key: "errors.mapNotStopped", vars: { id } });
            // A step cancelled while its run went on would run twice: once it ends, the chain can go on from after it.
            if (g.items.some((i) => i.active)) throw new HiveError("conflict", `Run group #${id} still has a run going.`, { key: "errors.rolesRunning", vars: { id } });
            this.#assertNotPaused(g.project);
            // From the step that did not finish: the ones before it succeeded, and their work is on the branch.
            const from = g.items.findIndex((i) => i.run?.status !== "succeeded");
            const again = db.prepare("UPDATE run_group_items SET status = 'held', request_id = NULL, error = NULL, updated_at = ? WHERE id = ?");
            const now = this.#now();
            // A cancelled last run may have succeeded since: there is no step left to repeat.
            if (from >= 0) for (const i of g.items.slice(from)) again.run(now, i.id);
            db.prepare("UPDATE run_groups SET phase = NULL, phase_error = NULL, closed_at = NULL WHERE id = ?").run(id);
            this.#releaseGroups();
            return this.#group(id);
          }
          if (g.kind !== "mapreduce") throw new HiveError("bad_request", `Run group #${id} is not a job in parts.`, { key: "errors.notMapReduce", vars: { id } });
          if (g.phase !== "stopped") throw new HiveError("conflict", `Run group #${id} has not stopped.`, { key: "errors.mapNotStopped", vars: { id } });
          this.#assertNotPaused(g.project);
          const now = this.#now();
          // A run can finish after cancellation; its successful split or merge must not be repeated either.
          if (g.phaseRun?.status === "succeeded") {
            db.prepare("UPDATE run_groups SET phase = ?, phase_error = NULL, closed_at = ? WHERE id = ?").run(g.items.length ? "done" : "ready", g.items.length ? now : null, id);
            return this.#group(id);
          }
          // Cancellation cannot stop an accepted run: keep its request and reopen the phase it is still doing.
          if (this.#itemActive("sent", g.phaseRequest, g.phaseRun)) {
            db.prepare("UPDATE run_groups SET phase = ?, phase_error = NULL, closed_at = NULL WHERE id = ?").run(g.items.length ? "reduce" : "split", id);
            return this.#group(id);
          }
          if (!g.items.length) {
            // The split stopped: ask its machine again.
            const task = this.#getTask(g.parentTask!);
            if (!task) throw new HiveError("not_found", `Task ${g.parentTask} not found.`, { key: "errors.taskNotFound", vars: { id: g.parentTask! } });
            const instructions = [splitInstructions(), `The job, in full:\n${g.instructions}`].filter(Boolean).join("\n\n");
            const m = this.#assertDispatchable({ machineId: g.machineId!, project: g.project, task, role: "plan", profileId: null, candidates: 1, instructions }, actor);
            const req = this.#insertRequest(m, g.project, task, { role: "plan", profileId: null, reviewAfter: false, candidates: 1, instructions }, actor);
            db.prepare("UPDATE run_groups SET phase = 'split', phase_request = ?, phase_error = NULL, closed_at = NULL WHERE id = ?").run(req.id, id);
            return this.#group(id);
          }
          // The parts that did not finish run again; with all of them in, the merge does.
          const again = db.prepare("UPDATE run_group_items SET status = 'held', request_id = NULL, error = NULL, updated_at = ? WHERE id = ?");
          for (const i of g.items) if (!i.active && i.run?.status !== "succeeded") again.run(now, i.id);
          db.prepare("UPDATE run_groups SET phase = 'map', phase_request = NULL, phase_error = NULL, closed_at = NULL WHERE id = ?").run(id);
          this.#release();
          return this.#group(id);
        }),

      "runs.groups": ({ project, projects, limit }) => {
        this.#tx(() => this.#release());
        const ids = db
          .prepare(`SELECT id FROM run_groups WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) ORDER BY id DESC LIMIT ?2`)
          .all(project ?? null, limit, listParam(projects)) as Row[];
        return ids.map((r) => this.#group(num(r.id)));
      },

      "runs.cancelGroup": ({ id }, actor) =>
        this.#tx(() => {
          const g = this.#group(id);
          if (g.closedAt) throw new HiveError("conflict", `Run group #${id} is over.`, { key: "errors.runGroupClosed", vars: { id } });
          const now = this.#now();
          db.prepare("UPDATE run_group_items SET status = 'cancelled', updated_at = ? WHERE group_id = ? AND status = 'held'").run(now, id);
          db.prepare(
            "UPDATE run_requests SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND id IN (SELECT request_id FROM run_group_items WHERE group_id = ?)",
          ).run(now, id);
          // A job's split or merge request too; the group stops where it was (runs.resumeGroup goes on from there).
          db.prepare("UPDATE run_requests SET status = 'cancelled', updated_at = ? WHERE status = 'pending' AND id = (SELECT phase_request FROM run_groups WHERE id = ?)").run(now, id);
          db.prepare(`UPDATE implementation_plans SET status = 'cancelled', decided_at = ?, decided_by = ?
            WHERE status IN ('planning', 'waiting') AND request_id IN (
              SELECT request_id FROM run_group_items WHERE group_id = ? UNION SELECT phase_request FROM run_groups WHERE id = ?)`)
            .run(now, actor.name, id, id);
          db.prepare(
            // A chain of roles stops too, so that Chạy lại goes on from the step it had reached (roadmap 31d).
            `UPDATE run_groups SET closed_at = ?,
               phase = CASE WHEN phase = 'done' OR (phase IS NULL AND kind != 'roles') THEN phase ELSE 'stopped' END,
               phase_error = CASE WHEN phase = 'done' OR (phase IS NULL AND kind != 'roles') THEN phase_error ELSE ? END WHERE id = ?`,
          ).run(now, JSON.stringify({ message: "Cancelled.", key: "errors.mapCancelled" }), id);
          return this.#group(id);
        }),

      // A free prompt from the web (roadmap 32b): its own new task and the request to run it, or neither.
      "runs.prompt": ({ project, title, prompt, machineId, profileId, preferKind, reviewAfter }, actor) =>
        this.#tx(() => {
          const m = this.#assertDispatchable({ machineId, project, task: null, role: "implement", profileId, candidates: 1, instructions: prompt }, actor);
          const heading = (title?.trim() || prompt.trim().split(/\r?\n/, 1)[0]!.trim()).slice(0, 120);
          // The title is the agent's to read too (and every reader's of the project).
          assertNoHidden(heading, "Title");
          assertNoSecret(heading, "Title");
          const id = this.#nextPromptTaskId();
          const at = this.#now();
          db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, project, heading, prompt.slice(0, 2000), at);
          this.#keepNote(id, prompt.slice(0, 2000), "todo", actor, at);
          // Rules only: a prompt is someone waiting at the screen, and a classify run first would only make them wait.
          this.#applyTaskRule(id);
          const task = this.#getTask(id)!;
          // The runner hands the agent the task's note as well as the instructions: the prompt goes once, as the note,
          // and in full as the instructions only when the note had to cut it.
          const instructions = prompt.length > 2000 ? prompt : "";
          const request = this.#insertRequest(m, project, task, { role: "implement", profileId, preferKind, reviewAfter, candidates: 1, instructions }, actor);
          return { task, request };
        }),

      "runs.requests": ({ project, projects, limit, taskId, pendingOnly }) => {
        this.#expireRequests();
        return (
          db
            .prepare(`SELECT * FROM run_requests WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) AND (?4 IS NULL OR task_id = ?4) AND (?5 = 0 OR status = 'pending') ORDER BY id DESC LIMIT ?2`)
            .all(project ?? null, limit, listParam(projects), taskId ?? null, pendingOnly ? 1 : 0) as Row[]
        ).map((r) => this.#withAllowedKinds(toRunRequest(r)));
      },

      "runs.preparePlan": ({ project, taskId, profileId, preferKind, reviewAfter, candidates, instructions }, actor) => this.#tx(() => {
        const task = this.#getTask(taskId);
        if (!task || task.project !== project) throw new HiveError("not_found", "Task not found.");
        if (!needsPlanApproval(this.#sdlcPolicy().projects[project]?.planApproval, task.size)) throw new HiveError("conflict", "This task does not require plan approval.");
        const m = this.#assertDispatchable({ machineId: actor.name, project, task, role: "implement", profileId, candidates, instructions }, actor);
        this.#assertNotInGroup(taskId);
        const flow = this.#flowRow(taskId);
        if (flow && ["running", "check", "checking", "next"].includes(str(flow.state))) throw new HiveError("conflict", "Task has an active flow.", { key: "errors.taskInFlow", vars: { id: taskId } });
        return this.#dispatchDirect(m, project, task, { role: "implement", profileId, preferKind, reviewAfter, candidates, instructions }, actor);
      }),
      "runs.plans": ({ project, projects, taskId, status, limit }, actor) =>
        (db.prepare(`SELECT * FROM implementation_plans WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR task_id = ?2)
          AND (?3 IS NULL OR status = ?3) AND (?4 IS NULL OR project IN (SELECT value FROM json_each(?4))) ORDER BY id DESC LIMIT ?5`)
          .all(project ?? null, taskId ?? null, status ?? null, listParam(projects), limit) as Row[]).filter((r) => sees(actor, str(r.project))).map((r) => this.#toPlan(r)),
      "runs.decidePlan": ({ id, revision, decision, note }, actor) => this.#tx(() => {
        const row = db.prepare("SELECT * FROM implementation_plans WHERE id = ?").get(id) as Row | undefined;
        if (!row) throw new HiveError("not_found", "Plan not found.");
        if (str(row.status) !== "waiting" || num(row.revision) !== revision) throw new HiveError("conflict", "This plan has already changed.", { key: "errors.planChanged" });
        if (decision === "changes" && !note.trim()) throw new HiveError("bad_request", "Please describe the plan changes.", { key: "errors.planNoteRequired" });
        this.#decidePlan(row, decision, clean(note) ?? "", actor.name);
        return this.#toPlan(db.prepare("SELECT * FROM implementation_plans WHERE id = ?").get(id) as Row);
      }),

      "runs.cancelRequest": ({ id }) =>
        this.#tx(() => {
          this.#expireRequests();
          const req = this.#runRequest(id);
          if (req.status !== "pending") throw new HiveError("conflict", `Run request #${id} is ${req.status}.`, { key: "errors.runRequestNotPending", vars: { id } });
          db.prepare("UPDATE run_requests SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.#now(), id);
          return this.#runRequest(id);
        }),

      "runs.requestResult": ({ id, status, runId, error }, actor) =>
        this.#tx(() => {
          const req = this.#runRequest(id);
          if (req.machineId !== actor.name) throw new HiveError("forbidden", `Run request #${id} is for ${req.machineId}, not ${actor.name}.`);
          if (req.status !== "pending") throw new HiveError("conflict", `Run request #${id} is ${req.status}.`, { key: "errors.runRequestNotPending", vars: { id } });
          // The reason shows on the web: no hidden characters, no line that looks like a secret.
          const why = cleanMachineError(error);
          db.prepare("UPDATE run_requests SET status = ?, run_id = ?, error = ?, updated_at = ? WHERE id = ?").run(
            status,
            status === "accepted" ? runId : null,
            why ? JSON.stringify(why) : null,
            this.#now(),
            id,
          );
          if (status === "accepted" && runId) {
            this.#linkRedispatch(actor.name, runId, req.redispatch);
            db.prepare("UPDATE run_records SET instructions = COALESCE(instructions, ?) WHERE machine_id = ? AND run_id = ?").run(req.instructions, actor.name, runId);
          }
          if (status === "rejected" && req.plan?.phase === "plan") db.prepare("UPDATE implementation_plans SET status = 'failed' WHERE id = ? AND status = 'planning'").run(req.plan.id);
          // A refusal frees its group's place at once, and stops a flow's step.
          this.#release();
          this.#releaseFlows();
          return this.#runRequest(id);
        }),

      // Research consumes runner capacity without creating a coding task or asking for a review run.
      "research.start": (input, actor) => this.#tx(() => {
        for (const value of [input.topic, ...input.questions]) { assertNoHidden(value, "Research"); assertNoSecret(value, "Research"); }
        const projects = this.#researchProjects(input, actor);
        this.#assertNotPaused(input.project);
        const machine = this.#assertDispatchable({ machineId: input.machineId, project: input.project, task: null, role: "research", profileId: input.profileId, candidates: 1, instructions: "" }, actor);
        if (!machine.profiles.some(p => p.enabled && p.installed && p.research && (!input.profileId || p.id === input.profileId))) throw new HiveError("bad_request", "Machine needs a research-capable runner.");
        const id = num(this.db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM research_runs").get()!.id);
        const task = { id: `research-${id}`, project: input.project, title: input.topic, kind: "spec", size: "m", risk: "normal" } as Task;
        const job: ResearchJob = { ...input, id, projects };
        const request = this.#insertRequest(machine, input.project, task, { role: "research", profileId: input.profileId, reviewAfter: false, candidates: 1, instructions: JSON.stringify(job) }, actor);
        const docKey = `${input.scope === "system" ? `system/${input.system}` : `project/${input.project}`}/research/research-${id}`;
        this.db.prepare("INSERT INTO research_runs(id, project, input, projects, request_id, doc_key) VALUES (?, ?, ?, ?, ?, ?)").run(id, input.project, JSON.stringify(input), JSON.stringify(projects), request.id, docKey);
        return this.#research(id);
      }),
      "research.get": ({ id }) => { this.#expireRequests(); return this.#research(id); },
      "research.finish": async ({ id, artifactId, sources, recommendations }, actor) => {
        const research = this.#research(id);
        if (research.proposalId) return research;
        const req = this.#runRequest(research.requestId);
        if (req.status !== "accepted" || !req.runId) throw new HiveError("conflict", "Research request was not accepted.");
        const file = await this.#handlers["artifacts.get"]({ id: artifactId }, actor);
        if (!file || file.artifact.machineId !== actor.name || file.artifact.runId !== req.runId || file.artifact.project !== research.input.project || file.artifact.taskId !== `research-${id}` || file.artifact.name !== "report.md") throw new HiveError("bad_request", "Expected this research run's report.md.");
        const content = Buffer.from(file.data, "base64").toString("utf8");
        if (!content.trim() || content.length > 200_000) throw new HiveError("bad_request", "Invalid research report.");
        for (const value of [...sources, recommendations]) { assertNoHidden(value, "Research result"); assertNoSecret(value, "Research result"); }
        const proposed = parseInput("proposals.create", { docKey: research.docKey, baseVersion: 0, content, reason: research.input.topic });
        // The confirmed request delegates this single draft, and keeps the requester for the no-self-approval rule.
        const writer: Actor = { ...actor, agent: file.artifact.profileId ?? "research", run: req.runId, onBehalf: req.requestedBy,
          source: { via: "api", machine: req.machine, run: req.runId, task: req.taskId } };
        const made = this.#tx(() => {
          const current = this.#research(id);
          if (current.proposalId) return null;
          const proposal = this.#handlers["proposals.create"](proposed, writer) as Proposal;
          this.db.prepare("UPDATE research_runs SET artifact_id = ?, proposal_id = ?, sources = ?, recommendations = ? WHERE id = ?").run(artifactId, proposal.id, JSON.stringify(sources), recommendations, id);
          return proposal;
        });
        if (made) this.#report("proposals.create", proposed, made, writer);
        return this.#research(id);
      },
      "chat.send": ({ project, threadId, machineId, profileId, model, effort, title, text, files }, actor) =>
        this.#tx(() => {
          this.#expireChats();
          this.#assertNotPaused(project);
          const thread = threadId === undefined ? null : (db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(threadId) as Row | undefined);
          if (thread === undefined || (thread && str(thread.project) !== project)) {
            throw new HiveError("not_found", `Chat #${threadId} not found in ${project}.`, { key: "errors.chatNotFound", vars: { id: threadId ?? 0 } });
          }
          if (thread && num(thread.busy) === 1) {
            throw new HiveError("conflict", `Chat #${threadId} still waits for its reply.`, { key: "errors.chatBusy", vars: { id: threadId! } });
          }
          // A new thread takes what the project set for its chats, where the person picked nothing.
          const defaults = thread ? null : this.#chatDefaults(project);
          const target = thread ? str(thread.machine_id) : (machineId ?? defaults?.machineId ?? undefined);
          if (!target) throw new HiveError("bad_request", "Pick the machine that runs the chat.", { key: "errors.chatMachine" });
          const m = this.#machineFor(target);
          if (!m) throw new HiveError("not_found", `No machine ${target}.`, { key: "errors.machineNotFound", vars: { machine: target } });
          const name = { machine: m.machine };
          if (!m.online) throw new HiveError("conflict", `${m.machine} is offline.`, { key: "errors.machineOffline", vars: name });
          if (!m.acceptsRuns) throw new HiveError("bad_request", `${m.machine} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: name });
          // The hub-wide leader reads the board, not one repo (roadmap 37): its machine needs no project checked out.
          if (project !== HUB_SCOPE && !m.projects.includes(project)) {
            throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { ...name, project } });
          }
          const pinned = thread ? strOrNull(thread.profile_id) : profileId === undefined ? (defaults?.profileId ?? null) : profileId;
          const now = this.#now();
          const profiles = m.profiles.filter((p) => ["claude", "codex"].includes(p.kind) && p.enabled && p.loggedIn !== false);
          const ready = profiles.filter((p) => !p.overLimit && !(p.cooldownUntil && p.cooldownUntil > now)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
          const previous = m.profiles.find((p) => p.id === pinned);
          const quotaFailed = thread && num((db.prepare("SELECT rate_limited FROM chat_messages WHERE thread_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(num(thread.id)) as Row | undefined)?.rate_limited ?? 0) === 1;
          const fallback = !!thread && previous?.kind === "claude" && (quotaFailed || previous.overLimit || !!(previous.cooldownUntil && previous.cooldownUntil > now));
          const chosen = fallback ? ready.find((p) => p.kind === "codex") : pinned ? ready.find((p) => p.id === pinned) ?? (!thread && profileId === undefined ? ready[0] : undefined) : ready[0];
          if (!chosen) {
            throw new HiveError("bad_request", `${m.machine} has no available Claude or Codex profile${pinned ? ` ${pinned}` : ""}.`, {
              key: "errors.chatNoProfile", vars: { ...name, id: pinned ?? "Claude / Codex" },
            });
          }
          const switched = !!thread && ((!!pinned && chosen.id !== pinned) || (!pinned && thread.session_id != null));
          const defaultKindChanged = !thread && previous && previous.kind !== chosen.kind;
          if (thread) {
            db.prepare("UPDATE chat_threads SET profile_id = ?, session_id = CASE WHEN ? THEN NULL ELSE session_id END, model = CASE WHEN ? THEN NULL ELSE model END, effort = CASE WHEN ? THEN NULL ELSE effort END WHERE id = ?").run(chosen.id, switched ? 1 : 0, switched ? 1 : 0, switched ? 1 : 0, num(thread.id));
          }
          // The agent reads it as its prompt.
          assertNoHidden(text, "Message");
          assertNoSecret(text, "Message");
          if (title) assertNoHidden(title, "Title");
          const id = thread
            ? num(thread.id)
            : num(
                db
                  .prepare(
                    "INSERT INTO chat_threads(project, title, machine_id, machine, profile_id, model, effort, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                  )
                  .run(
                    project,
                    (title?.trim() || text.trim().split("\n")[0]!).slice(0, 120),
                    target,
                    m.machine,
                    chosen.id,
                    model === undefined ? (defaultKindChanged ? null : defaults?.model ?? null) : model,
                    effort === undefined ? (defaultKindChanged ? null : defaults?.effort ?? null) : effort,
                    actor.name,
                    now,
                    now,
                  ).lastInsertRowid,
              );
          const put = db.prepare(
            "INSERT INTO chat_messages(thread_id, role, author, text, status, sender, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          );
          const message = num(put.run(id, "user", actor.name, text, null, null, now, now).lastInsertRowid);
          // Only the sender's own uploads for this project, not sent with another message.
          for (const fileId of files) {
            const f = db.prepare("SELECT project, uploaded_by, message_id FROM chat_files WHERE id = ?").get(fileId) as Row | undefined;
            if (!f || str(f.uploaded_by) !== actor.name || str(f.project) !== project || f.message_id != null) {
              throw new HiveError("not_found", `No file #${fileId} to send.`, { key: "errors.chatFileNotFound", vars: { id: fileId } });
            }
            db.prepare("UPDATE chat_files SET thread_id = ?, message_id = ? WHERE id = ?").run(id, message, fileId);
          }
          const sender: ChatSender = { name: actor.name, role: actor.role, ...(actor.access ? { access: actor.access } : {}), ...(actor.account ? { account: actor.account } : {}) };
          const reply = num(put.run(id, "assistant", `${chosen.id}@${m.machine}`, "", "pending", JSON.stringify(sender), now, now).lastInsertRowid);
          if (switched) db.prepare("UPDATE chat_messages SET switched_from = ? WHERE id = ?").run(pinned, reply);
          db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(now, id);
          return { thread: this.#chatThread(id), message: this.#chatMessage(message), reply: this.#chatMessage(reply) };
        }),

      "chat.pending": ({ project, projects, limit }, actor) =>
        (
          db
            .prepare(
              `SELECT * FROM chat_actions WHERE status = 'proposed' AND (?1 IS NULL OR project = ?1)
                 AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3)))
                 AND (?4 = 1 OR thread_id IN (SELECT id FROM chat_threads WHERE project <> '*'))
               ORDER BY id DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, listParam(projects), this.#isHubAdmin(actor) ? 1 : 0) as Row[]
        ).map(toChatAction),
      "chat.threads": ({ project, projects, query, limit }, actor) => {
        this.#expireChats();
        const words = query?.trim();
        // Found in the title or in any message; % and _ are the person's own characters, not wildcards.
        const like = words ? `%${words.normalize("NFC").toLocaleLowerCase("vi").replace(/[\\%_]/g, "\\$&")}%` : null;
        // The hub-wide thread (roadmap 37) is left out here rather than in #filter, which only trims actors with grants:
        // an unrestricted token that is not a hub admin's must not see it either.
        return (
          db
            .prepare(
              `${THREAD_SELECT} WHERE (?1 IS NULL OR t.project = ?1) AND (?4 IS NULL OR t.project IN (SELECT value FROM json_each(?4)))
                 AND (?5 = 1 OR t.project <> '${HUB_SCOPE}')
                 AND (?3 IS NULL OR hive_fold(t.title) LIKE ?3 ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM chat_messages q WHERE q.thread_id = t.id AND hive_fold(q.text) LIKE ?3 ESCAPE '\\'))
               ORDER BY t.updated_at DESC, t.id DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, like, listParam(projects), this.#isHubAdmin(actor) ? 1 : 0) as Row[]
        ).map(toChatThread);
      },

      "chat.defaults": ({ project }) => this.#chatDefaults(project),

      // Only the list: the machine, plan, model and effort a manager set stay as they are.
      "chat.setCommands": ({ project, commands }, actor) =>
        this.#tx(() => {
          const list = [...new Set(commands.map((c) => c.trim()))];
          db.prepare(
            `INSERT INTO chat_defaults(project, commands, updated_by, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(project) DO UPDATE SET commands = excluded.commands, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          ).run(project, JSON.stringify(list), actor.name, this.#now());
          return this.#chatDefaults(project);
        }),

      "chat.setAutonomy": ({ project, kinds }, actor) =>
        this.#tx(() => {
          const asked = [...new Set(kinds)];
          // Loosening the leader's own limits is a person's call, every time (29b kept them apart for this).
          const never = asked.filter((k) => CHAT_ACTION_ALWAYS_CONFIRM.includes(k));
          if (never.length) throw new HiveError("bad_request", `${never.join(", ")} always wait for a confirm.`, { key: "errors.chatAutoNever", vars: { kinds: never.join(", ") } });
          db.prepare(
            `INSERT INTO chat_defaults(project, auto_kinds, updated_by, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(project) DO UPDATE SET auto_kinds = excluded.auto_kinds, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          ).run(project, JSON.stringify(asked), actor.name, this.#now());
          return this.#chatDefaults(project);
        }),

      "chat.setDefaults": ({ project, machineId, profileId, model, effort }, actor) =>
        this.#tx(() => {
          if (machineId && !this.#machineFor(machineId)) {
            throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
          }
          db.prepare(
            `INSERT INTO chat_defaults(project, machine_id, profile_id, model, effort, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project) DO UPDATE SET machine_id = excluded.machine_id, profile_id = excluded.profile_id, model = excluded.model,
               effort = excluded.effort, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          ).run(project, machineId, profileId, model, effort, actor.name, this.#now());
          return this.#chatDefaults(project);
        }),

      // The next replies of the thread use them; the one being written goes on as it started.
      "chat.configure": ({ threadId, model, effort }) =>
        this.#tx(() => {
          this.#chatThread(threadId);
          db.prepare("UPDATE chat_threads SET model = ?, effort = ? WHERE id = ?").run(model, effort, threadId);
          return this.#chatThread(threadId);
        }),

      "chat.rename": ({ threadId, title }) =>
        this.#tx(() => {
          this.#chatThread(threadId);
          assertNoHidden(title, "Title");
          db.prepare("UPDATE chat_threads SET title = ? WHERE id = ?").run(title.trim().slice(0, 120), threadId);
          return this.#chatThread(threadId);
        }),

      // A reply being written would lose its place: stop it first.
      "chat.delete": ({ threadId }) =>
        this.#tx(() => {
          if (this.#chatThread(threadId).busy) {
            throw new HiveError("conflict", `Chat #${threadId} still waits for its reply.`, { key: "errors.chatBusy", vars: { id: threadId } });
          }
          db.prepare("DELETE FROM chat_threads WHERE id = ?").run(threadId);
          return { deleted: threadId };
        }),

      "chat.get": ({ threadId, after }) => {
        this.#expireChats();
        const row = db.prepare(`${THREAD_SELECT} WHERE t.id = ?`).get(threadId) as Row | undefined;
        if (!row) return null;
        const messages = this.#chatMessages(threadId, after);
        return { thread: toChatThread(row), messages };
      },

      // Only for a machine that heartbeats and takes runs from the hub; cheap enough to ask every few seconds.
      "chat.poll": (_input, actor) => {
        this.#expireChats();
        return this.#machineFor(actor.name)?.acceptsRuns ? this.#chatRequests(actor.name) : [];
      },

      // Only the leader writing a reply, through that reply's token; nothing runs until a project manager confirms it.
      "chat.propose": async ({ action, reason }, actor) => this.#autoRun(this.#proposeChat(action, reason, actor), actor),

      "chat.decide": async ({ actionId, accept, autoDispatch }, actor) => this.#decideChat(actionId, accept, actor, false, autoDispatch),


      // Confirmed, the action is the manager's own call, checked and recorded like any other; set aside, nothing runs.

      // In CHAT_DECIDE_ORDER, each kind in the order proposed: a run may be for a task the reply also creates. The first
      // that fails stops the rest, which wait for a person to look.
      "chat.decideAll": async ({ replyId, accept, autoDispatch }, actor) => {
        if (!db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND role = 'assistant'").get(replyId)) {
          throw new HiveError("not_found", `Chat reply #${replyId} not found.`, { key: "errors.chatReplyNotFound", vars: { id: replyId } });
        }
        const all = () => (db.prepare("SELECT * FROM chat_actions WHERE reply_id = ? ORDER BY id").all(replyId) as Row[]).map(toChatAction);
        const waiting = all()
          .filter((a) => a.status === "proposed")
          .sort((a, b) => CHAT_DECIDE_ORDER[a.kind] - CHAT_DECIDE_ORDER[b.kind] || a.id - b.id);
        for (const a of waiting) {
          try {
            const done = await this.#handlers["chat.decide"]({ actionId: a.id, accept, autoDispatch: autoDispatch?.[String(a.id)] }, actor);
            if (done.status === "failed") break;
          } catch (err) {
            // Another manager decided it meanwhile: theirs stands.
            if (err instanceof HiveError && err.key === "errors.chatActionDecided") continue;
            throw err;
          }
        }
        return all();
      },

      "chat.cancel": ({ replyId }) =>
        this.#tx(() => {
          this.#expireChats();
          const row = db.prepare("SELECT status FROM chat_messages WHERE id = ? AND role = 'assistant'").get(replyId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `Chat reply #${replyId} not found.`, { key: "errors.chatReplyNotFound", vars: { id: replyId } });
          if (str(row.status) !== "pending" && str(row.status) !== "running") {
            throw new HiveError("conflict", `Chat reply #${replyId} has ended.`, { key: "errors.chatReplyEnded", vars: { id: replyId } });
          }
          const now = this.#now();
          db.prepare("UPDATE chat_messages SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ?").run(now, now, replyId);
          return this.#chatMessage(replyId);
        }),

      // Shown on the web as it comes: no hidden characters, no line that looks like a secret.
      "chat.progress": ({ replyId, text, steps, activity }, actor) =>
        this.#tx(() => {
          const row = this.#replyFor(replyId, actor);
          const status = str(row.status);
          if (status === "cancelled") return { cancelled: true };
          if (status !== "pending" && status !== "running") {
            throw new HiveError("conflict", `Chat reply #${replyId} has ended.`, { key: "errors.chatReplyEnded", vars: { id: replyId } });
          }
          db.prepare("UPDATE chat_messages SET status = 'running', text = ?, steps = ?, activity = ?, updated_at = ? WHERE id = ?").run(
            clean(text)!,
            clean(steps)!,
            clean(activity),
            this.#now(),
            replyId,
          );
          return { cancelled: false };
        }),

      // A cancelled reply keeps what the machine wrote until it stopped, and stays cancelled.
      "chat.finish": ({ replyId, status, text, steps, sessionId, costUsd, profileId, tokens, rateLimited, error }, actor) =>
        this.#tx(() => {
          const row = this.#replyFor(replyId, actor);
          const was = str(row.status);
          if (was !== "pending" && was !== "running" && was !== "cancelled") {
            throw new HiveError("conflict", `Chat reply #${replyId} has ended.`, { key: "errors.chatReplyEnded", vars: { id: replyId } });
          }
          const now = this.#now();
          const why = cleanMachineError(error);
          db.prepare(
            "UPDATE chat_messages SET status = ?, text = ?, steps = ?, activity = NULL, error = ?, cost_usd = ?, updated_at = ?, finished_at = ? WHERE id = ?",
          ).run(was === "cancelled" ? "cancelled" : status, clean(text)!, clean(steps)!, why ? JSON.stringify(why) : null, costUsd, now, now, replyId);
          const thread = num(row.thread_id);
          db.prepare("UPDATE chat_messages SET tokens = ?, rate_limited = ? WHERE id = ?").run(tokens ? JSON.stringify(tokens) : null, rateLimited ? 1 : 0, replyId);
          const latest = num((db.prepare("SELECT MAX(id) AS id FROM chat_messages WHERE thread_id = ? AND role = 'assistant'").get(thread) as Row).id);
          // A cancelled process may finish after the user sent another turn. It must not replace that turn's session.
          if (latest !== replyId) {
            if (profileId) db.prepare("UPDATE chat_messages SET author = ? WHERE id = ?").run(`${profileId}@${this.#chatThread(thread).machine}`, replyId);
            return this.#chatMessage(replyId);
          }
          if (profileId) {
            const current = this.#chatThread(thread);
            const previous = current.profileId;
            db.prepare("UPDATE chat_messages SET author = ?, switched_from = COALESCE(switched_from, ?) WHERE id = ?").run(`${profileId}@${current.machine}`, previous && previous !== profileId ? previous : null, replyId);
            db.prepare("UPDATE chat_threads SET profile_id = ?, session_id = CASE WHEN profile_id IS NOT ? THEN NULL ELSE session_id END, model = CASE WHEN profile_id IS NOT ? THEN NULL ELSE model END, effort = CASE WHEN profile_id IS NOT ? THEN NULL ELSE effort END WHERE id = ?").run(profileId, profileId, profileId, profileId, thread);
          }
          if (sessionId) db.prepare("UPDATE chat_threads SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, now, thread);
          else db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(now, thread);
          return this.#chatMessage(replyId);
        }),

      // Nothing is stored: the notice only feeds the hub's webhooks. The error goes to a chat channel, so it is cleaned first.
      "runs.report": (input, actor) => {
        const line = input.error === null ? null : stripHidden(input.error).trim().split("\n").at(-1)!.slice(0, 300);
        const error = line && findSecret(line) ? "(hidden: it looked like a secret)" : line;
        return { ...input, error, machine: actor.name };
      },

      "costs.summary": (_input, actor) => {
        const since = (days: number) => this.#now(-days * 24 * 60);
        const rows = db
          .prepare(
            `SELECT project, machine, profile_id, account,
               SUM(CASE WHEN finished_at >= ?1 THEN cost_usd ELSE 0 END) AS usd1,
               SUM(CASE WHEN finished_at >= ?2 THEN cost_usd ELSE 0 END) AS usd7,
               SUM(cost_usd) AS usd30, COUNT(*) AS runs30,
               SUM(CASE WHEN cache_read_tokens IS NOT NULL THEN input_tokens END) AS tin,
               SUM(cache_write_tokens) AS twrite, SUM(cache_read_tokens) AS tread, SUM(output_tokens) AS tout
             FROM run_costs WHERE finished_at >= ?3 GROUP BY project, machine, profile_id, account`,
          )
          .all(since(1), since(7), since(30)) as Row[];
        const visible = rows.filter((r) => sees(actor, str(r.project)));
        const zero = (): CostTotals => ({
          usd1: 0,
          usd7: 0,
          usd30: 0,
          runs30: 0,
          tokens30: { inputTokens: null, cacheWriteTokens: null, cacheReadTokens: null, outputTokens: null },
        });
        // null until some run reported it: an older machine's runs say nothing about the cache.
        const sum = (a: number | null, b: unknown) => (b == null ? a : (a ?? 0) + Number(b));
        const add = (t: CostTotals, r: Row) => {
          t.usd1 += Number(r.usd1);
          t.usd7 += Number(r.usd7);
          t.usd30 += Number(r.usd30);
          t.runs30 += Number(r.runs30);
          t.tokens30 = {
            inputTokens: sum(t.tokens30.inputTokens, r.tin),
            cacheWriteTokens: sum(t.tokens30.cacheWriteTokens, r.twrite),
            cacheReadTokens: sum(t.tokens30.cacheReadTokens, r.tread),
            outputTokens: sum(t.tokens30.outputTokens, r.tout),
          };
          return t;
        };
        const group = <K extends string>(key: (r: Row) => K) => {
          const out = new Map<K, CostTotals>();
          for (const r of visible) out.set(key(r), add(out.get(key(r)) ?? zero(), r));
          return [...out].sort((a, b) => b[1].usd30 - a[1].usd30);
        };
        const sep = "\u0000";
        // Priced runs only (Claude Code's: RTK is for Claude alone), so a Codex run never sits in the "without" column.
        const sides = db
          .prepare(
            `SELECT r.project, r.role, r.compression IS NOT NULL AS rtk, COUNT(*) AS runs,
               SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
               AVG(c.input_tokens + COALESCE(c.cache_write_tokens, 0) + COALESCE(c.cache_read_tokens, 0)) AS input_avg,
               AVG(c.output_tokens) AS output_avg, AVG(c.cost_usd) AS cost_avg,
               SUM(c.cache_read_tokens) AS tread,
               SUM(CASE WHEN c.cache_read_tokens IS NOT NULL THEN c.input_tokens + COALESCE(c.cache_write_tokens, 0) + c.cache_read_tokens END) AS tall
             FROM run_costs c JOIN run_records r ON r.machine_id = c.machine_id AND r.run_id = c.run_id
             WHERE c.finished_at >= ?1 AND c.priced = 1
             GROUP BY r.project, r.role, r.compression IS NOT NULL`,
          )
          .all(since(30)) as Row[];
        const noSide = (): CompressionSide => ({ runs: 0, failed: 0, inputAvg: null, outputAvg: null, cacheShare: null, costAvg: null });
        const compare = new Map<string, CompressionCompare>();
        for (const r of sides) {
          if (!sees(actor, str(r.project))) continue;
          const key = [str(r.project), str(r.role)].join(sep);
          const row = compare.get(key) ?? { project: str(r.project), role: str(r.role), rtk: noSide(), plain: noSide() };
          row[num(r.rtk) === 1 ? "rtk" : "plain"] = {
            runs: num(r.runs),
            failed: num(r.failed),
            inputAvg: numOrNull(r.input_avg),
            outputAvg: numOrNull(r.output_avg),
            cacheShare: r.tall == null || Number(r.tall) === 0 ? null : Number(r.tread) / Number(r.tall),
            costAvg: numOrNull(r.cost_avg),
          };
          compare.set(key, row);
        }
        // Every ended run, priced or not (Codex reports tokens without a price): the run is what the router learns from.
        const models = (
          db
            .prepare(
              `SELECT r.project, r.role, r.kind, r.model, r.effort, COUNT(*) AS runs,
                 SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END) AS failed,
                 SUM(CASE WHEN r.attempt > 1 THEN 1 ELSE 0 END) AS retries,
                 SUM(CASE WHEN r.verdict = 'approve' THEN 1 ELSE 0 END) AS approved,
                 SUM(CASE WHEN r.verdict = 'changes' THEN 1 ELSE 0 END) AS changes,
                 AVG(c.cost_usd) AS cost_avg, AVG(c.output_tokens) AS output_avg
               FROM run_records r LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id
               WHERE r.finished_at >= ?1 AND r.status IN ('succeeded', 'failed')
               GROUP BY r.project, r.role, r.kind, r.model, r.effort`,
            )
            .all(since(30)) as Row[]
        )
          .filter((r) => sees(actor, str(r.project)))
          .map(
            (r): ModelUse => ({
              project: str(r.project),
              role: str(r.role),
              kind: strOrNull(r.kind) as AgentKind | null,
              model: strOrNull(r.model),
              effort: strOrNull(r.effort),
              runs: num(r.runs),
              failed: num(r.failed),
              retries: num(r.retries),
              approved: num(r.approved),
              changes: num(r.changes),
              costAvg: numOrNull(r.cost_avg),
              outputAvg: numOrNull(r.output_avg),
            }),
          )
          .sort(
            (a, b) =>
              a.project.localeCompare(b.project) ||
              a.role.localeCompare(b.role) ||
              b.runs - a.runs ||
              `${a.kind ?? ""}\u0000${a.model ?? ""}\u0000${a.effort ?? ""}`.localeCompare(`${b.kind ?? ""}\u0000${b.model ?? ""}\u0000${b.effort ?? ""}`),
          );
        return {
          models,
          compression: [...compare.values()]
            .filter((c) => c.rtk.runs > 0)
            .sort((a, b) => a.project.localeCompare(b.project) || a.role.localeCompare(b.role)),
          total: visible.reduce(add, zero()),
          projects: group((r) => str(r.project)).map(([project, t]) => ({ project, ...t })),
          profiles: group((r) => [str(r.machine), str(r.profile_id), strOrNull(r.account) ?? ""].join(sep)).map(([k, t]) => {
            const [machine, profileId, account] = k.split(sep) as [string, string, string];
            return { machine, profileId, account: account || null, ...t };
          }),
        };
      },

      "budgets.list": () => this.#budgetUsage(),

      "budgets.set": ({ budgets }) => {
        const ids = budgets.map(budgetId);
        const twice = ids.find((id, i) => ids.indexOf(id) !== i);
        if (twice) throw new HiveError("bad_request", `Two spending caps for ${twice}.`, { key: "errors.budgetDuplicate", vars: { id: twice } });
        // Only the fields of a cap: what zod left out stays out of the stored value.
        const list: Budget[] = budgets.map((b) => ({
          scope: b.scope,
          period: b.period,
          limit: { ...(b.limit.usd !== undefined ? { usd: b.limit.usd } : {}), ...(b.limit.runs !== undefined ? { runs: b.limit.runs } : {}) },
        }));
        db.prepare("INSERT INTO settings(key, value) VALUES ('budgets', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(list));
        return this.#budgetUsage();
      },

      "machines.list": () =>
        (db.prepare("SELECT * FROM machines ORDER BY last_seen DESC").all() as Row[]).map((r) => this.#toMachine(r)),

      // The project's readers see why its runs wait, not how to fix the machine: no install action, no repo, no local paths.
      "machines.setupMissing": ({ project }) => {
        const rows = new Map((db.prepare("SELECT id, setup FROM machines").all() as Row[]).map((r) => [str(r.id), r.setup]));
        const out: MachineSetupMissing[] = [];
        for (const m of this.#machinesWith(project)) {
          const setup = rows.get(m.id);
          if (setup == null) continue;
          const report = JSON.parse(str(setup)) as SetupReport;
          const items = [...report.machine, ...report.projects.filter((p) => p.project === project).flatMap((p) => p.items)]
            .filter((item) => item.state !== "installed")
            .map(({ id, label, state, detail }) => ({ id, label, state, detail: hidePaths(detail) }));
          if (items.length) out.push({ machineId: m.id, machine: m.machine, items });
        }
        return out;
      },

      "machines.worktrees": ({ machineId }, actor) => this.#machineWorktrees(machineId, actor),
      "machines.manageWorktrees": ({ machineId, targets, force, cleanup }, actor) => this.#tx(() => {
        const access = this.#machineWorktrees(machineId, actor);
        if (!access.report) throw new HiveError("bad_request", "Update the app to manage worktrees.", { key: "errors.machineAppTooOld", vars: { machine: machineId } });
        const machine = this.#machineByRef(machineId);
        for (const target of targets ?? []) {
          const entry = access.report.entries.find(e => e.project === target.project && e.path === target.path);
          if (!entry || entry.fingerprint !== target.fingerprint) throw new HiveError("conflict", "Worktree changed; refresh first.", { key: "errors.worktreeChanged" });
          if (entry.active || machine.runs.some(r => r.project === entry.project && r.taskId === entry.taskId) ||
            db.prepare("SELECT 1 FROM run_records WHERE project = ? AND task_id = ? AND status IN ('queued', 'running') LIMIT 1").get(entry.project, entry.taskId) ||
            db.prepare("SELECT 1 FROM run_requests WHERE project = ? AND task_id = ? AND status = 'pending' LIMIT 1").get(entry.project, entry.taskId)) {
            throw new HiveError("conflict", "Task has a run.", { key: "errors.worktreeActive" });
          }
          if ((entry.dirty || entry.merged !== true) && !force) throw new HiveError("conflict", "Confirm uncommitted or unmerged work first.", { key: "errors.worktreeConfirm" });
        }
        const command: WorktreeCommand = { id: randomUUID(), targets: targets ?? [], force, cleanup: cleanup ?? null, requestedBy: actor.account ?? actor.name, requestedAt: this.#now(), completedAt: null, results: [] };
        db.prepare("INSERT INTO machine_worktree_commands(id, machine_id, command) VALUES (?, ?, ?)").run(command.id, machineId, JSON.stringify(command));
        return command;
      }),

      "machines.tools": ({ machineId }, actor) => this.#machineToolAccess(machineId, actor),
      "machines.repair": ({ machineId, tokenId }, actor) => this.#tx(() => {
        const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
        if (!row) throw new HiveError("not_found", "Machine not found.", { key: "errors.machineNotFound", vars: { machine: machineId } });
        if (!this.#mayApproveTool(actor, strOrNull(row.owner)) || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined)
          throw new HiveError("forbidden", "Only the machine owner or a hub admin may re-pair it.", { key: "errors.machineRepairForbidden" });
        const token = db.prepare("SELECT * FROM hub_tokens WHERE id = ?").get(tokenId) as Row | undefined;
        const owner = token?.owner_id == null ? null : db.prepare("SELECT username, disabled FROM hub_users WHERE id = ?").get(str(token.owner_id)) as Row | undefined;
        if (!token || token.role === "viewer" || (token.owner_id != null && (!owner || num(owner.disabled) === 1)) ||
            machineId !== `runner.${str(row.machine)}@${str(token.name)}` ||
            (!this.#isHubAdmin(actor) && strOrNull(owner?.username) !== strOrNull(row.owner)))
          throw new HiveError("bad_request", "Choose an active machine token with the same name and owner.", { key: "errors.machineRepairToken" });
        // Rotation invalidates agents already issued for this machine, even if someone later pairs the old token again.
        if (row.token_id != null) db.prepare("DELETE FROM run_credentials WHERE parent_id = ? AND machine = ?").run(str(row.token_id), str(row.machine));
        db.prepare("UPDATE machines SET token_id = ?, owner = ?, last_seen = ?, prev_instance = NULL, duplicate_at = NULL WHERE id = ?")
          .run(tokenId, strOrNull(owner?.username), "1970-01-01T00:00:00.000Z", machineId);
        this.audit(actor, "machines.repair", machineId, `${strOrNull(row.token_id) ?? "legacy"} → ${tokenId}`, { key: "audit.machineRepaired" });
        return this.#toMachine(db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row);
      }),
      "machines.approveTool": ({ machineId, toolId, hash }, actor) => this.#tx(() => {
        const access = this.#machineToolAccess(machineId, actor);
        if (!access.canApprove) throw new HiveError("forbidden", "Only a person owning the machine or a hub admin approves tools.", { key: "errors.machineToolForbidden" });
        if (!access.supported) throw new HiveError("bad_request", "Update this machine to approve tools from the web.", { key: "errors.machineAppTooOld", vars: { machine: machineId } });
        const tool = access.tools.find((t) => t.id === toolId);
        if (!tool) throw new HiveError("not_found", `No tool ${toolId} on machine.`, { key: "errors.toolNotFound", vars: { id: toolId } });
        if (tool.hash !== hash) throw new HiveError("conflict", "The tool commands changed. Read them again.", { key: "errors.machineToolChanged" });
        const problem = toolProblem(tool.entry, !!tool.entry.handler);
        if (problem) throw new HiveError("bad_request", "Invalid tool commands.", problem);
        if (tool.approval && !tool.approval.appliedAt) {
          const { appliedAt: _appliedAt, ...approval } = tool.approval;
          return approval;
        }
        const approval: ToolApproval = { id: randomUUID(), toolId, hash, approvedBy: actor.account ?? actor.name, approvedAt: this.#now() };
        db.prepare(`INSERT INTO machine_tool_approvals(id, machine_id, tool_id, hash, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(machine_id, tool_id) DO UPDATE SET id = excluded.id, hash = excluded.hash, approved_by = excluded.approved_by, approved_at = excluded.approved_at, applied_at = NULL`)
          .run(approval.id, machineId, toolId, hash, approval.approvedBy, approval.approvedAt);
        return approval;
      }),

      "machines.remove": ({ id }) => ({ removed: num(db.prepare("DELETE FROM machines WHERE id = ?").run(id).changes) === 1 }),

      // A subscription is a person's own account: only its machine's owner and hub admins change it (asked 2/10).
      "machines.setRunner": ({ machineId, settings }, actor) => this.#tx(() => {
        const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
        if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
        const m = this.#toMachine(row);
        if (!this.#mayApproveTool(actor, m.owner)) throw new HiveError("forbidden", "Only a hub admin or machine owner changes runner settings.", { key: "errors.machineProfileForbidden", vars: { machine: m.machine } });
        if (!m.runnerSettings) throw new HiveError("bad_request", "App too old for runner settings.", { key: "errors.machineAppTooOld", vars: { machine: m.machine } });
        const next = { ...m.runnerChange?.settings, ...settings };
        for (const key of Object.keys(next) as (keyof MachineRunnerSettings)[]) if (next[key] === m.runnerSettings[key]) delete next[key];
        const change: RunnerChange | null = Object.keys(next).length ? { settings: next, requestedBy: actor.account ?? actor.name, requestedAt: this.#now() } : null;
        db.prepare("UPDATE machines SET runner_change = ? WHERE id = ?").run(change ? JSON.stringify(change) : null, machineId);
        return this.#toMachine(db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row);
      }),
      "machines.setProfile": ({ machineId, profileId, enabled, priority, stopAtSession, stopAtWeek }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
          const m = this.#toMachine(row);
          const hubAdmin = actor.role === "admin" && !actor.access;
          // Not an agent on the owner's token: a run should not turn subscriptions on for itself.
          const owner = !isAgentActor(actor) && actor.account !== undefined && actor.account === m.owner;
          if (actor.role === "agent" || isAgentActor(actor) || (!hubAdmin && !owner)) {
            throw new HiveError("forbidden", `Only a hub admin or the owner of ${m.machine} changes its profiles.`, { key: "errors.machineProfileForbidden", vars: { machine: m.machine } });
          }
          const p = m.profiles.find((x) => x.id === profileId);
          if (!p) throw new HiveError("not_found", `${m.machine} has no profile ${profileId}.`, { key: "errors.machineProfileNotFound", vars: { machine: m.machine, profile: profileId } });
          // An app that does not report priorities does not take changes either: one would wait a day for nothing.
          if (p.priority === undefined) throw new HiveError("bad_request", `${m.machine} runs an app too old for profile changes.`, { key: "errors.machineAppTooOld", vars: { machine: m.machine } });
          if ((stopAtSession !== undefined && p.stopAtSession === undefined) || (stopAtWeek !== undefined && p.stopAtWeek === undefined)) throw new HiveError("bad_request", "App too old for profile thresholds.", { key: "errors.machineAppTooOld", vars: { machine: m.machine } });
          const old = m.profileChanges.find((c) => c.profileId === profileId);
          let on = enabled ?? old?.enabled ?? null;
          let rank = priority ?? old?.priority ?? null;
          // What the machine already has needs no change: switching back cancels the waiting one.
          if (on === p.enabled) on = null;
          if (rank === p.priority) rank = null;
          let session = stopAtSession ?? old?.stopAtSession ?? null;
          let week = stopAtWeek ?? old?.stopAtWeek ?? null;
          if (session === p.stopAtSession) session = null;
          if (week === p.stopAtWeek) week = null;
          if (on === null && rank === null && session === null && week === null) db.prepare("DELETE FROM machine_profile_changes WHERE machine_id = ? AND profile_id = ?").run(machineId, profileId);
          else {
            db.prepare(
              `INSERT INTO machine_profile_changes(machine_id, profile_id, enabled, priority, requested_by, requested_at, stop_at_session, stop_at_week) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(machine_id, profile_id) DO UPDATE SET enabled = excluded.enabled, priority = excluded.priority, stop_at_session = excluded.stop_at_session, stop_at_week = excluded.stop_at_week,
                 requested_by = excluded.requested_by, requested_at = excluded.requested_at`,
            ).run(machineId, profileId, on === null ? null : on ? 1 : 0, rank, actor.account ?? actor.name, this.#now(), session, week);
          }
          return this.#toMachine(db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row);
        }),

      "cooldowns.list": () => this.#cooldowns(),

      // Last report wins: the newest rate-limit message has the best reset time.
      "cooldowns.set": ({ account, until, reason }, actor) => {
        assertNoSecret(reason, "Cooldown reason");
        const iso = new Date(until).toISOString();
        const now = this.#now();
        if (iso <= now) {
          db.prepare("DELETE FROM quota_cooldowns WHERE account = ?").run(account);
          return null;
        }
        db.prepare(
          `INSERT INTO quota_cooldowns(account, until, reason, reported_by, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET until = excluded.until, reason = excluded.reason,
             reported_by = excluded.reported_by, updated_at = excluded.updated_at`,
        ).run(account, iso, reason, actor.name, now);
        return toCooldown(db.prepare("SELECT * FROM quota_cooldowns WHERE account = ?").get(account) as Row);
      },

      "cooldowns.clear": ({ account }) => ({
        cleared: num(db.prepare("DELETE FROM quota_cooldowns WHERE account = ?").run(account).changes) === 1,
      }),

      "machines.commandResult": ({ id, status, output }, actor) =>
        this.#tx(() => {
          const cmd = this.#command(id);
          if (cmd.machineId !== actor.name) throw new HiveError("forbidden", `Command #${id} is for ${cmd.machineId}, not ${actor.name}.`);
          if (!COMMAND_MOVES[cmd.status].includes(status)) throw new HiveError("conflict", `Command #${id} is ${cmd.status}, cannot become ${status}.`);
          db.prepare("UPDATE machine_commands SET status = ?, output = COALESCE(?, output), updated_at = ? WHERE id = ?").run(
            status,
            clean(output ?? null),
            this.#now(),
            id,
          );
          return this.#command(id);
        }),

      "policy.get": () => this.#policy(),

      "policy.set": (input, actor) => {
        const policy: TeamPolicy = { ...input, selfApproval: input.selfApproval ?? this.#policy().selfApproval, updatedAt: this.#now(), updatedBy: actor.name };
        assertNoSecret(JSON.stringify(policy), "Policy");
        db.prepare("INSERT INTO settings(key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          JSON.stringify(policy),
        );
        return this.#policy();
      },

      "gate.templates": ({ project }, actor) => this.#gates(actor).templates(project, may(actor, project, "projectSettings")),
      "gate.list": ({ project, state, sha, limit }, actor) => this.#tx(() => this.#gates(actor).list(project, { state, sha, limit })),
      "gate.get": ({ id }, actor) => this.#tx(() => this.#gates(actor).require(id)),
      "gate.create": (i, actor) => this.#tx(() => {
        this.#gatesOn();
        return this.#gates(actor).create({ ...i, requestedBy: actor.account! });
      }),
      "gate.approve": ({ id, version, pass, reason }, actor) => this.#tx(() => {
        if (pass) this.#gatesOn();
        assertNoSecret(reason, "reason");
        return this.#gates(actor).approve(id, version, pass, actor.account!, reason);
      }),
      "gate.cancel": ({ id, reason }, actor) => this.#tx(() => { assertNoSecret(reason, "reason"); return this.#gates(actor).cancel(id, reason); }),
      "gate.reconcile": ({ id, outcome, note }, actor) => this.#tx(() => { assertNoSecret(note, "note"); return this.#gates(actor).reconcile(id, outcome, note); }),
      "gate.take": ({ project }, actor) => this.#tx(() => {
        if (!this.#opts.gateJobs) return null;
        // Same holds as a merge batch: a machine draining for an update or running twice takes nothing new.
        const m = db.prepare("SELECT update_draining, duplicate_at FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
        if (!m || num(m.update_draining) === 1 || (strOrNull(m.duplicate_at) ?? "") > this.#now(-DUPLICATE_MINUTES)) return null;
        return this.#gates(actor).take(project, actor.name);
      }),
      "gate.progress": ({ id, leaseToken }, actor) => this.#tx(() => this.#gates(actor).progress(id, actor.name, leaseToken)),
      "gate.artifact": async ({ id, leaseToken, name, data }, actor) => {
        const job = this.#tx(() => this.#gates(actor).assertUploading(id, actor.name, leaseToken));
        const a = await this.#putArtifact({ project: job.project, taskId: "", runId: job.id, profileId: null, name, data }, actor);
        return { name: a.name, sha256: a.sha256, bytes: a.size };
      },
      "gate.result": ({ id, leaseToken, receipt }, actor) => this.#tx(() => {
        // Diagnostics only, and filtered once more: the machine's filter is the first look, as for a run's log.
        const clean = { ...receipt, logTail: redactLines(receipt.logTail), result: receipt.result && { ...receipt.result, summary: receipt.result.summary === undefined ? undefined : redactLines(receipt.result.summary) } };
        const uploaded = db.prepare("SELECT sha256 FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?");
        return this.#gates(actor).result(id, actor.name, leaseToken, clean, (n) => strOrNull((uploaded.get(actor.name, id, n) as Row | undefined)?.sha256));
      }),
      "autoRelease.green": (batch, actor) => this.#tx(() => {
        this.#assertNotPaused(batch.project);
        assertNoSecret(JSON.stringify(batch), "Green batch"); assertNoHidden(JSON.stringify(batch), "Green batch");
        return new AutoReleaseStore(db, () => this.#now()).green(batch, actor.name, effectiveGates(this.#sdlcPolicy(), batch.project).release);
      }),
      "autoRelease.list": ({ project }) => new AutoReleaseStore(db, () => this.#now()).view(project),
      "autoRelease.take": ({ project }, actor) => this.#tx(() => { this.#assertNotPaused(project); const machine = db.prepare("SELECT update_draining FROM machines WHERE id = ?").get(actor.name) as Row | undefined; if (num(machine?.update_draining ?? 0) === 1) return null; return new AutoReleaseStore(db, () => this.#now()).take(project, actor.name, effectiveGates(this.#sdlcPolicy(), project).release); }),
      "autoRelease.result": ({ project, batchId, success, step, warning }, actor) => this.#tx(() => new AutoReleaseStore(db, () => this.#now()).result(project, batchId, actor.name, success, step, warning)),
      "autoRelease.progress": ({ project, batchId, step }, actor) => this.#tx(() => {
        this.#assertNotPaused(project);
        const store = new AutoReleaseStore(db, () => this.#now());
        const r = store.require(project, batchId);
        if (r.machine !== actor.name || r.state !== "running") throw new HiveError("conflict", "Release is no longer running on this machine.");
        const gate = db.prepare("SELECT decided_by FROM sdlc_gates WHERE id = ?").get(r.gateId) as Row;
        if (effectiveGates(this.#sdlcPolicy(), project).release !== "auto" && gate.decided_by === "auto") throw new HiveError("forbidden", "Release ceiling changed; a person must reconcile it.");
        const order = ["prepare", "release", "deploy", "rollout", "checkLogs"];
        if ((!r.step && step !== "prepare") || (r.step && order.indexOf(step) <= order.indexOf(r.step))) throw new HiveError("conflict", "Release steps must advance once in order.");
        r.step = step; return store.save(r);
      }),
      "autoRelease.rollout": ({ project, batchId }, actor) => {
        this.#assertNotPaused(project);
        const r = new AutoReleaseStore(db, () => this.#now()).require(project, batchId);
        if (r.machine !== actor.name || r.state !== "running" || r.step !== "rollout") throw new HiveError("forbidden", "Rollout requires the rollout step of a running release on its Gate machine.");
        return r;
      },
      "autoRelease.decide": ({ project, batchId, pass }, actor) => this.#tx(() => new AutoReleaseStore(db, () => this.#now()).decide(project, batchId, pass, actor.name)),
      "autoRelease.reconcile": ({ project, batchId }) => this.#tx(() => {
        const store = new AutoReleaseStore(db, () => this.#now());
        const r = store.require(project, batchId);
        return store.save({ ...store.result(project, batchId, r.machine, false, r.step ?? "prepare", false), reconciled: true });
      }),
      "autoRelease.resume": ({ project }) => this.#tx(() => new AutoReleaseStore(db, () => this.#now()).resume(project)),
      "sdlc.get": () => this.#sdlcView(),

      "sdlc.setCeiling": ({ ceiling }, actor) => {
        // "auto" is the ceiling a gate has when left out: kept out, so the stored settings say only what was narrowed.
        const narrowed = Object.fromEntries(Object.entries(ceiling).filter(([, m]) => m !== "auto")) as Partial<GateModes>;
        this.#saveSdlc({ ...this.#sdlcPolicy(), ceiling: narrowed }, actor);
        return this.#sdlcView();
      },

      "sdlc.setProject": ({ project, settings }, actor) => {
        const current = this.#sdlcPolicy();
        const ceiling = fullCeiling(current.ceiling);
        const projects = { ...current.projects };
        // An explicit reset means human gates, including for a project whose creation default was automatic.
        if (!settings) projects[project] = { gates: {} };
        else {
          for (const g of SDLC_GATES) {
            const m = settings.gates[g];
            if (m && GATE_MODES.indexOf(m) > GATE_MODES.indexOf(ceiling[g]) && m !== current.projects[project]?.gates[g]) {
              throw new HiveError("forbidden", `The hub lets gate ${g} go up to ${ceiling[g]}, not ${m}.`, { key: "errors.gateOverCeiling", vars: { gate: g, mode: m, ceiling: ceiling[g] } });
            }
          }
          // "human" is a gate's default: kept out, so a later ceiling change reads only the gates the project opened.
          const gates = Object.fromEntries(Object.entries(settings.gates).filter(([, m]) => m !== "human")) as Partial<GateModes>;
          projects[project] = {
            gates,
            releaseMachine: settings.releaseMachine === null ? undefined : settings.releaseMachine ?? current.projects[project]?.releaseMachine,
            autoDispatch: settings.autoDispatch ?? current.projects[project]?.autoDispatch ?? false,
            autoDispatchBy: settings.autoDispatch === true ? principalOf(actor) : current.projects[project]?.autoDispatchBy,
            allowedAgentKinds: settings.allowedAgentKinds ?? current.projects[project]?.allowedAgentKinds,
            planApproval: settings.planApproval ?? current.projects[project]?.planApproval,
            ...(settings.maxFixRounds !== undefined ? { maxFixRounds: settings.maxFixRounds } : {}),
            ...((settings.maxParallel === undefined ? current.projects[project]?.maxParallel : settings.maxParallel) ? { maxParallel: settings.maxParallel ?? current.projects[project]!.maxParallel } : {}),
            ...((settings.fastLaneKinds ?? current.projects[project]?.fastLaneKinds) ? { fastLaneKinds: [...new Set(settings.fastLaneKinds ?? current.projects[project]!.fastLaneKinds)] } : {}),
          };
        }
        this.#saveSdlc({ ...current, projects }, actor);
        return this.#sdlcView();
      },

      "sdlc.gates": ({ project, projects, taskId, status, limit, beforeId, since }) =>
        (
          db
            .prepare(
              `SELECT *, CASE WHEN ?7 IS NULL THEN NULL ELSE NOT EXISTS (
                 SELECT 1 FROM sdlc_gates earlier WHERE earlier.project = sdlc_gates.project
                   AND earlier.task_id = sdlc_gates.task_id AND earlier.gate = sdlc_gates.gate AND earlier.id < sdlc_gates.id
               ) END AS first_attempt FROM sdlc_gates WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2)
                 AND (?4 IS NULL OR project IN (SELECT value FROM json_each(?4))) AND (?5 IS NULL OR task_id = ?5)
               AND (?6 IS NULL OR id < ?6) AND (?7 IS NULL OR created_at >= ?7)
               ORDER BY CASE WHEN ?7 IS NULL THEN CASE status WHEN 'waiting' THEN 0 WHEN 'escalated' THEN 0 ELSE 1 END ELSE 1 END, id DESC LIMIT ?3`,
            )
            .all(project ?? null, status ?? null, limit, listParam(projects), taskId ?? null, beforeId ?? null, since ?? null) as Row[]
        ).map(toGate),

      "specs.runStep": ({ project, step, taskId, title, dir, input, machineId, profileId }, actor) =>
        this.#tx(() => {
          const open = this.#flowRow(taskId);
          if (open && ["running", "check", "checking"].includes(str(open.state))) {
            throw new HiveError("conflict", `Task ${taskId} has a step going.`, { key: "errors.flowBusy", vars: { id: taskId } });
          }
          let task = this.#getTask(taskId);
          if (!task) {
            if (!title) throw new HiveError("not_found", `No task ${taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { id: taskId, project } });
            assertNoHidden(title, "Title");
            assertNoSecret(title, "Title");
            db.prepare("INSERT INTO tasks(id, project, title, updated_at) VALUES (?, ?, ?, ?)").run(taskId, project, title.trim(), this.#now());
            task = this.#getTask(taskId)!;
          } else if (task.project !== project) {
            throw new HiveError("not_found", `No task ${taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { id: taskId, project } });
          }
          // A Spec Kit step is a spec by rule: no classify run before it.
          this.#applyTaskRule(taskId, { specStep: step });
          task = this.#getTask(taskId)!;
          const instructions = specStepInstructions(step, { ...(dir ? { dir } : {}), input });
          const m = this.#assertDispatchable({ machineId, project, task, role: "implement", profileId, candidates: 1, instructions }, actor);
          this.#assertNotInGroup(taskId);
          const request = this.#insertRequest(m, project, task, { role: "implement", profileId, reviewAfter: false, candidates: 1, instructions }, actor);
          const now = this.#now();
          // Run again by hand from the Spec page: the gate it waited at is over.
          if (open?.gate_id != null) {
            db.prepare("UPDATE sdlc_gates SET status = 'rejected', decided_by = ?, note = COALESCE(note, ?), decided_at = ? WHERE id = ? AND status IN ('waiting', 'escalated')").run(
              actor.name,
              `${step} run again`,
              now,
              num(open.gate_id),
            );
          }
          db.prepare(
            `INSERT INTO sdlc_flows(task_id, project, dir, step, state, machine_id, profile_id, request_id, created_by, on_behalf, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET dir = COALESCE(excluded.dir, dir), step = excluded.step, state = 'running',
               machine_id = excluded.machine_id, profile_id = excluded.profile_id, request_id = excluded.request_id, gate_id = NULL,
               input = '', note = NULL, updated_at = excluded.updated_at`,
          ).run(taskId, project, dir ?? null, step, m.id, profileId, request.id, actor.name, actor.onBehalf ?? null, now, now);
          return { task, request, flow: this.#flow(taskId)! };
        }),

      "sdlc.decide": ({ gateId, decision, note }, actor) =>
        this.#tx(() => {
          const gate = db.prepare("SELECT * FROM sdlc_gates WHERE id = ?").get(gateId) as Row | undefined;
          if (!gate) throw new HiveError("not_found", `Gate #${gateId} not found.`, { key: "errors.gateNotFound", vars: { id: gateId } });
          const ft = this.#flowTaskRow(str(gate.task_id));
          if (ft && ft.gate_id != null && num(ft.gate_id) === gateId) return this.#decideTask(ft, gate, decision, note, actor);
          const flow = this.#flowRow(str(gate.task_id));
          const status = str(gate.status);
          if ((status !== "waiting" && status !== "escalated") || !flow || num(flow.gate_id) !== gateId) {
            throw new HiveError("conflict", `Gate #${gateId} is not waiting for a person.`, { key: "errors.gateNotWaiting", vars: { id: gateId } });
          }
          assertNoHidden(note, "Note");
          assertNoSecret(note, "Note");
          const now = this.#now();
          db.prepare("UPDATE sdlc_gates SET status = ?, decided_by = ?, note = COALESCE(NULLIF(?, ''), note), decided_at = ? WHERE id = ?").run(
            decision === "pass" ? "passed" : "rejected",
            actor.name,
            note,
            now,
            gateId,
          );
          const taskId = str(flow.task_id);
          if (decision === "pass") this.#passFlow(taskId);
          // The step again, with what the person asked for as its input (AI-DLC: a rejected stage reopens).
          else db.prepare("UPDATE sdlc_flows SET state = 'next', gate_id = NULL, input = ?, updated_at = ? WHERE task_id = ?").run(note, now, taskId);
          this.#releaseFlows();
          return this.#flow(taskId)!;
        }),

      "sdlc.retry": ({ taskId }) =>
        this.#tx(() => {
          const flow = this.#flowRow(taskId);
          if (!flow) throw new HiveError("not_found", `No flow for ${taskId}.`, { key: "errors.flowNotFound", vars: { id: taskId } });
          if (str(flow.state) !== "stopped") throw new HiveError("conflict", `The flow of ${taskId} has not stopped.`, { key: "errors.flowNotStopped", vars: { id: taskId } });
          db.prepare("UPDATE sdlc_flows SET state = 'next', note = NULL, updated_at = ? WHERE task_id = ?").run(this.#now(), taskId);
          this.#releaseFlows();
          return this.#flow(taskId)!;
        }),

      "sdlc.flowTasks": ({ project, projects, flowTask, taskId }) => {
        this.#tx(() => this.#releaseFlows());
        return (
          db
            .prepare(
              `SELECT * FROM sdlc_flow_tasks WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR project IN (SELECT value FROM json_each(?2)))
                 AND (?3 IS NULL OR flow_task = ?3) AND (?4 IS NULL OR task_id = ?4) ORDER BY task_id`,
            )
            .all(project ?? null, listParam(projects), flowTask ?? null, taskId ?? null) as Row[]
        ).map((r) => this.#toFlowTask(r));
      },

      "sdlc.flows": ({ project, projects, limit, offset }) => {
        this.#tx(() => this.#releaseFlows());
        return (
          db
            .prepare(`SELECT task_id FROM sdlc_flows WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) ORDER BY updated_at DESC, task_id DESC LIMIT ?2 OFFSET ?4`)
            .all(project ?? null, limit, listParam(projects), offset) as Row[]
        ).map((r) => this.#flow(str(r.task_id))!);
      },

      "modelRouter.get": () => this.#modelRouter(),
      "modelRouter.set": (input) => {
        const prev = this.#modelRouter();
        const next = input.project === null
          ? { ...prev, tiers: input.tiers, cells: input.cells }
          : { ...prev, projects: { ...prev.projects, [input.project]: input.setting } };
        db.prepare("INSERT INTO settings(key, value) VALUES ('modelRouter', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
        return next;
      },
      "modelLearning.get": ({ project }) => this.#learningView(project),
      "modelLearning.set": ({ project, enabled, lock, apply }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT enabled, locked FROM model_learning WHERE project = ?").get(project) as Row | undefined;
          const wasOn = !row || num(row.enabled) === 1;
          const locked = new Set(row ? (JSON.parse(str(row.locked)) as string[]) : []);
          const on = enabled ?? wasOn;
          if (on !== wasOn) this.#logLearning(project, on ? "on" : "off", actor.name);
          if (lock) {
            const key = `${lock.kind}/${lock.size}`;
            if (lock.locked !== locked.has(key)) {
              if (lock.locked) locked.add(key);
              else locked.delete(key);
              this.#logLearning(project, lock.locked ? "lock" : "unlock", actor.name, { kind: lock.kind, size: lock.size });
            }
          }
          db.prepare("INSERT INTO model_learning(project, enabled, locked) VALUES (?, ?, ?) ON CONFLICT(project) DO UPDATE SET enabled = excluded.enabled, locked = excluded.locked")
            .run(project, on ? 1 : 0, JSON.stringify([...locked].sort()));
          // A person applies what the table shows now, locked cell or not: the lock only keeps the nightly round off it.
          if (apply) {
            const cell = this.#learningView(project).cells.find((c) => c.kind === apply.kind && c.size === apply.size)!;
            if (!cell.proposal) throw new HiveError("conflict", `No proposal for ${apply.kind}/${apply.size}.`, { key: "errors.noModelProposal", vars: { cell: `${apply.kind}/${apply.size}` } });
            this.#setModelCell(project, cell.kind, cell.size, cell.proposal.tier);
            this.#logLearning(project, "apply", actor.name, { kind: cell.kind, size: cell.size, from: cell.current, to: cell.proposal.tier, tasks: cell.proposal.tasks, cleanRate: cell.proposal.cleanRate });
          }
          return this.#learningView(project);
        }),
      "agentPolicy.get": () => agentPolicyView(this.#agentPolicy()),

      "agentPolicy.set": (input, actor) => {
        const current = this.#agentPolicy();
        const projects = { ...current.projects };
        let hub = current.hub;
        if (input.project === null) {
          // A field left out is open (the schema's defaults); null puts the hub back to open.
          hub = input.policy ?? OPEN_POLICY;
        } else if (input.policy && Object.keys(input.policy).length) {
          projects[input.project] = input.policy;
        } else {
          delete projects[input.project];
        }
        const next: AgentPolicySettings = { hub, projects, updatedAt: this.#now(), updatedBy: actor.name };
        assertNoSecret(JSON.stringify(next), "Agent policy");
        db.prepare("INSERT INTO settings(key, value) VALUES ('agentPolicy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
          JSON.stringify(next),
        );
        return agentPolicyView(this.#agentPolicy());
      },

      "tools.list": ({ project }, actor) => (db.prepare("SELECT * FROM tools ORDER BY builtin DESC, id").all() as Row[]).map((r) => this.#toolView(r, actor, project)),

      "tools.save": ({ entry, baseVersion }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(entry.id) as Row | undefined;
          if (baseVersion === undefined && row) throw new HiveError("conflict", `There is a tool ${entry.id} already.`, { key: "errors.toolExists", vars: { id: entry.id } });
          if (baseVersion !== undefined && !row) throw new HiveError("not_found", `No tool ${entry.id}.`, { key: "errors.toolNotFound", vars: { id: entry.id } });
          if (row && num(row.version) !== baseVersion) {
            throw new HiveError("conflict", `Tool ${entry.id} changed since it was read (now v${num(row.version)}).`, { key: "errors.toolVersion", vars: { id: entry.id, version: num(row.version) } });
          }
          const builtin = !!row && num(row.builtin) === 1;
          if (builtin) {
            // The app's own code sets a seed up by its handler and kind: those stay what the seed says.
            const seed = JSON.parse(str(row.entry)) as Omit<ToolEntry, "id">;
            if (entry.kind !== seed.kind || entry.handler !== seed.handler) {
              throw new HiveError("bad_request", `Tool ${entry.id} is built in: its kind and handler stay.`, { key: "errors.toolBuiltinFixed", vars: { field: entry.kind !== seed.kind ? "kind" : "handler" } });
            }
          }
          const problem = toolProblem(entry, builtin);
          if (problem) throw new HiveError("bad_request", `Tool ${entry.id}: ${problem.key} (${problem.vars?.field ?? ""}).`, problem);
          // Even reverting to earlier commands needs a fresh decision; an old pending approval cannot revive.
          db.prepare("DELETE FROM machine_tool_approvals WHERE tool_id = ? AND hash != ?").run(entry.id, toolHash(entry));
          const { id, ...rest } = entry;
          const now = this.#now();
          db.prepare(
            `INSERT INTO tools(id, entry, builtin, version, updated_at, updated_by) VALUES (?1, ?2, 0, 1, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET entry = excluded.entry, version = tools.version + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
          ).run(id, JSON.stringify(rest), now, actor.name);
          return this.#toolView(db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as Row, actor);
        }),

      "tools.remove": ({ id }) =>
        this.#tx(() => {
          const row = db.prepare("SELECT builtin FROM tools WHERE id = ?").get(id) as Row | undefined;
          if (!row) return { removed: false };
          if (num(row.builtin) === 1) throw new HiveError("bad_request", `Tool ${id} is built in: turn it off instead.`, { key: "errors.toolBuiltin", vars: { id } });
          db.prepare("DELETE FROM tool_projects WHERE tool_id = ?").run(id);
          db.prepare("DELETE FROM tools WHERE id = ?").run(id);
          return { removed: true };
        }),

      "tools.status": ({ project }, actor) => {
        const setups = new Map((db.prepare("SELECT id, setup FROM machines").all() as Row[]).map((r) => [str(r.id), r.setup]));
        const machines = this.#machinesWith(project).flatMap((m) => {
          const setup = setups.get(m.id);
          if (setup == null) return [];
          const report = JSON.parse(str(setup)) as SetupReport;
          return [{ m, items: [...report.machine, ...report.projects.filter((p) => p.project === project).flatMap((p) => p.items)] }];
        });
        return (db.prepare("SELECT * FROM tools ORDER BY builtin DESC, id").all() as Row[]).map((r): ToolStatus => {
          const view = this.#toolView(r, actor, project);
          const setting = view.projects.find((p) => p.project === project)!;
          const ids = toolSetupItems(view, project);
          return {
            id: view.id,
            name: view.name,
            effective: setting.effective,
            required: setting.required,
            items: ids,
            // As setupMissing: for the project's readers, so no install action or local paths.
            machines: machines.map(({ m, items }) => ({
              machineId: m.id,
              machine: m.machine,
              items: items.filter((item) => ids.includes(item.id)).map(({ id, label, state, detail }) => ({ id, label, state, detail: hidePaths(detail) })),
            })),
          };
        });
      },

      "tools.setProject": ({ id, project, enabled, required }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(id) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No tool ${id}.`, { key: "errors.toolNotFound", vars: { id } });
          // Nothing of its own: no row, so the project follows the tool's default again.
          if (enabled === null && !required) db.prepare("DELETE FROM tool_projects WHERE tool_id = ? AND project = ?").run(id, project);
          else {
            db.prepare(
              `INSERT INTO tool_projects(tool_id, project, enabled, required) VALUES (?, ?, ?, ?)
               ON CONFLICT(tool_id, project) DO UPDATE SET enabled = excluded.enabled, required = excluded.required`,
            ).run(id, project, enabled === null ? null : enabled ? 1 : 0, required ? 1 : 0);
          }
          return this.#toolView(row, actor, project);
        }),

      // Machines that take runs from the hub hear cancelRuns, as after runs.cancel; every machine hears `paused` too.
      "agents.stop": ({ project }, actor) =>
        this.#tx(() => {
          this.#expireRequests();
          this.#expireChats();
          const now = this.#now();
          const requests = num(
            db.prepare("UPDATE run_requests SET status = 'cancelled', updated_at = ?2 WHERE status = 'pending' AND (?1 IS NULL OR project = ?1)").run(project, now).changes,
          );
          // Running ones only: a queued run stays in its machine's queue, saying why, until the pause is lifted.
          const runs = num(
            (db.prepare("SELECT COUNT(*) AS n FROM run_records WHERE status = 'running' AND (?1 IS NULL OR project = ?1)").get(project) as Row).n,
          );
          // Like runs.cancel: one asked already keeps who asked first.
          db.prepare(
            "UPDATE run_records SET cancel_by = ?2, cancel_at = ?3 WHERE status = 'running' AND cancel_by IS NULL AND (?1 IS NULL OR project = ?1)",
          ).run(project, actor.name, now);
          // A leader is an agent too; the machine hears it at its next chat.progress, as after chat.cancel.
          const chats = num(
            db
              .prepare(
                `UPDATE chat_messages SET status = 'cancelled', updated_at = ?2, finished_at = ?2
                 WHERE role = 'assistant' AND status IN ('pending', 'running') AND thread_id IN (SELECT id FROM chat_threads WHERE ?1 IS NULL OR project = ?1)`,
              )
              .run(project, now).changes,
          );
          const paused = this.#paused();
          if (project === null) paused.hub = true;
          else if (!paused.projects.includes(project)) paused.projects = [...paused.projects, project].sort();
          paused.by = { ...paused.by, [project ?? PAUSED_HUB]: { name: actor.name, at: now } };
          this.#savePaused(paused);
          return { project, paused, requests, runs, chats };
        }),

      "agents.resume": ({ project }) => {
        const paused = this.#paused();
        if (project === null) paused.hub = false;
        else paused.projects = paused.projects.filter((p) => p !== project);
        paused.by = { ...paused.by };
        delete paused.by[project ?? PAUSED_HUB];
        this.#savePaused(paused);
        return paused;
      },

      "agents.paused": () => this.#paused(),

      "systems.list": () => (db.prepare("SELECT * FROM systems ORDER BY name").all() as Row[]).map(toSystem),

      "systems.save": ({ name, projects }, actor) => {
        db.prepare(
          `INSERT INTO systems(name, projects, updated_by, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET projects = excluded.projects, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ).run(name, JSON.stringify([...new Set(projects)].sort()), actor.name, this.#now());
        return this.#system(name)!;
      },

      "systems.remove": ({ name }) => {
        // Its docs and memory would be left with no one able to see them: moved or deleted first.
        const owner = systemOwner(name);
        const docs = num((db.prepare("SELECT COUNT(*) AS n FROM docs WHERE project = ? AND removed_at IS NULL").get(owner) as Row).n);
        const memory = num((db.prepare("SELECT COUNT(*) AS n FROM memory WHERE project = ?").get(owner) as Row).n);
        if (docs || memory) throw new HiveError("conflict", `System ${name} still has ${docs} docs and ${memory} memory entries.`, { key: "errors.systemHasData", vars: { system: name, docs, memory } });
        return { removed: Number(db.prepare("DELETE FROM systems WHERE name = ?").run(name).changes) > 0 };
      },

      "projects.list": () => {
        const states = this.#projectStates();
        return this.#projectNames().map((p) => this.#projectSummary(p, states));
      },

      "projects.archive": ({ project }, actor) =>
        this.#tx(() => {
          // A deleted project has nothing left to archive; restoring the name is the only way out of the headstone.
          if (this.#projectState(project) === "deleted") throw this.#projectGone(project);
          this.#setProjectState(project, "archived", actor.name);
          return this.#projectSummary(project);
        }),

      "projects.restore": ({ project }) =>
        this.#tx(() => {
          db.prepare("DELETE FROM project_states WHERE project = ?").run(project);
          return this.#projectSummary(project);
        }),

      "projects.delete": async ({ project, confirm }, actor) => {
        // Archiving first is the pause that makes this deliberate: nothing is deleted straight off a list.
        if (this.#projectState(project) !== "archived") {
          throw new HiveError("conflict", `Project ${project} has to be archived before it can be deleted.`, { key: "errors.projectNotArchived", vars: { project } });
        }
        if (confirm !== project) throw new HiveError("bad_request", `Confirm with the project's name: ${project}.`, { key: "errors.projectConfirm", vars: { project } });
        const backup = this.#opts.backup;
        if (!backup) throw new HiveError("conflict", "Backups are off: set HIVE_BACKUP_DIR.", { key: "errors.backupOff" });
        // Nothing goes until the whole hub is in a snapshot: it is the only way back from here. A backup that fails
        // throws out of the call, before a single row is touched.
        const snapshot = await backup();
        const { rows, files } = this.#tx(() => this.#deleteProject(project, actor.name));
        // Outside the transaction: the file store is not part of it. A file left behind costs disk, a missing one costs
        // a page, so a failure here is only counted — the rows are already gone either way.
        let removed = 0;
        let failed = 0;
        for (const sha of new Set(files)) {
          // Files are named after their bytes, so another page may well be pointing at the very same file (#dropBlob).
          if (BLOB_TABLES.some((table) => db.prepare(`SELECT 1 FROM ${table} WHERE sha256 = ? AND stored IS NOT NULL`).get(sha))) continue;
          try {
            await this.#opts.blobs?.remove(sha);
            removed++;
          } catch {
            failed++;
          }
        }
        return { project, backup: path.basename(snapshot.file), rows, files: { removed, failed } };
      },

      "projects.retired": () =>
        Object.entries(this.#retired())
          .map(([project, entry]) => this.#retiredView(project, entry))
          .sort((a, b) => b.at.localeCompare(a.at)),

      "projects.retire": ({ project, note }, actor) =>
        this.#tx(() => {
          const all = this.#retired();
          // Resting again would only move the date: the first one is the one that counts.
          const entry = all[project] ?? { at: this.#now(), by: actor.name, note: note ?? null };
          this.#saveRetired({ ...all, [project]: entry });
          return this.#retiredView(project, entry);
        }),

      "projects.resume": ({ project }) =>
        this.#tx(() => {
          const all = this.#retired();
          if (!(project in all)) return { removed: false };
          delete all[project];
          this.#saveRetired(all);
          return { removed: true };
        }),
      "admin.machines": () => {
        this.#expireCommands();
        return (db.prepare("SELECT * FROM machines ORDER BY last_seen DESC").all() as Row[]).map(
          (r): MachineDetail => ({
            ...this.#toMachine(r),
            setup: r.setup == null ? null : (JSON.parse(str(r.setup)) as SetupReport),
            setupAt: strOrNull(r.setup_at),
            // Installs only: sync requests show on the Context agent page, per project.
            commands: (
              db
                .prepare("SELECT * FROM machine_commands WHERE machine_id = ? AND kind = 'install' ORDER BY id DESC LIMIT ?")
                .all(str(r.id), COMMAND_HISTORY) as Row[]
            ).map(toCommand),
          }),
        );
      },

      // Only an install the machine itself reported as possible: the hub never sends a free-form command.
      "admin.commandCreate": ({ machineId, itemId }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT setup FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
          const report = row.setup == null ? null : (JSON.parse(str(row.setup)) as SetupReport);
          const item = report ? [...report.machine, ...report.projects.flatMap((p) => p.items)].find((i) => i.id === itemId) : undefined;
          if (!item) throw new HiveError("bad_request", `${machineId} has not reported ${itemId}.`, { key: "errors.itemNotReported", vars: { machine: machineId, item: itemId } });
          if (!item.action) throw new HiveError("bad_request", `${itemId} is ${item.state} on ${machineId}: nothing the app can install.`, {
              key: "errors.nothingToInstall",
              vars: { machine: machineId, item: itemId },
            });
          const open = db
            .prepare("SELECT id FROM machine_commands WHERE machine_id = ? AND item_id = ? AND status IN ('pending', 'running')")
            .get(machineId, itemId) as Row | undefined;
          if (open) throw new HiveError("conflict", `Command #${num(open.id)} for ${itemId} is still open.`, { key: "errors.commandOpen", vars: { id: num(open.id), item: itemId } });
          const now = this.#now();
          const res = db
            .prepare("INSERT INTO machine_commands(machine_id, item_id, label, requested_by, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(machineId, itemId, `${item.action}: ${item.label}`, actor.name, now, now);
          return this.#command(num(res.lastInsertRowid));
        }),

      "admin.commandCancel": ({ id }) =>
        this.#tx(() => {
          const cmd = this.#command(id);
          if (cmd.status !== "pending") throw new HiveError("conflict", `Command #${id} is ${cmd.status}; only pending commands can be cancelled.`, { key: "errors.commandNotPending", vars: { id } });
          db.prepare("UPDATE machine_commands SET status = 'cancelled', updated_at = ? WHERE id = ?").run(this.#now(), id);
          return this.#command(id);
        }),

      // agent: `claude-1` also finds `claude-1.<machine>`. user: a person's own rows, and those of agents on their token.
      "history.list": (input, actor) => {
        const hidden = new Set(this.#projectStates().keys());
        // Permission and research visibility must be applied before counting pages.
        const visible = (entry: HistoryEntry) => {
          if (entry.kind === "audit") return this.#isHubAdmin(actor) && !input.project && !input.projects && !input.taskId;
          if (entry.project === HUB_SCOPE) return this.#isHubAdmin(actor);
          if (!sees(actor, entry.project) || (hidden.has(entry.project!) && input.project !== entry.project)) return false;
          if (entry.kind === "run") {
            const research = this.#researchForTask(entry.project!, entry.taskId!);
            if (research && !this.#researchVisible(research, actor)) return false;
          }
          return true;
        };
        return historyRows(db, input, visible);
      },
      "admin.audit": ({ limit, action, agent, user, run }) =>
        (
          db
            .prepare(
              `SELECT * FROM audit WHERE (?1 IS NULL OR action = ?1)
                 AND (?3 IS NULL OR agent = ?3 OR substr(agent, 1, length(?3) + 1) = ?3 || '.')
                 AND (?4 IS NULL OR on_behalf = ?4 OR (on_behalf IS NULL AND actor = ?4))
                 AND (?5 IS NULL OR run = ?5)
               ORDER BY id DESC LIMIT ?2`,
            )
            .all(action ?? null, limit, agent ?? null, user ?? null, run ?? null) as Row[]
        ).map(toAudit),
    };
  }
}
