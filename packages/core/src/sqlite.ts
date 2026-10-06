import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { isContextDoc, may, sees, systemOf, systemOwner, withSystemGrants, type Permission } from "./access.ts";
import type { AgentKind, AgentRole, PreferKind } from "./agents.ts";
import { ARTIFACTS_PER_RUN, artifactName, checkArtifact, isArtifactText, type Artifact } from "./artifacts.ts";
import type { BlobStore } from "./blobs.ts";
import { HiveError, type ErrorText } from "./errors.ts";
import { agentsDocKey, decisionsDocKey, parseDocKey, titleFromSlug, type ParsedDocKey } from "./keys.ts";
import { parseSkill, type SkillSummary } from "./skills.ts";
import { chatFileName, checkChatFile, isImage } from "./chatfiles.ts";
import { DOC_ASSET_MAX_BYTES, DOC_ASSETS_PER_DOC, DOC_TREE_DEPTH, docLinkRefs, linkSnippet, resolveDocLink } from "./doclinks.ts";
import { describeProjectContext, syncItemId } from "./sync.ts";
import { CHAT_ACTION_ALWAYS_CONFIRM, DEFAULT_LEADER_COMMANDS, PAUSED_HUB } from "./types.ts";
import { EMPTY_POLICY } from "./policy.ts";
import { budgetApplies, budgetId, budgetRatio, budgetVars, periodStart, type Budget, type BudgetBlock, type BudgetUsage } from "./budgets.ts";
import { agentPolicyView, EMPTY_AGENT_POLICY, OPEN_POLICY, policySummary, type AgentPolicy, type AgentPolicySettings, type AgentPolicyView } from "./agent-policy.ts";
import {
  DEFAULT_MAX_FIX_ROUNDS,
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
} from "./sdlc.ts";
import {
  authorize,
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
import { parseVerdict, type Verdict } from "./verdict.ts";
import { parseParts, partInstructions, reduceInstructions, splitInstructions, type MapPhase } from "./mapreduce.ts";
import { toolEffective, toolProblem, toolSetupItems } from "./tools.ts";
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
  TeamPolicy,
  ToolEntry,
  ToolProjectSetting,
  ToolStatus,
  ToolView,
  HiveSystem,
} from "./types.ts";

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
  // Files an agent made during a run (roadmap 41c). Like doc_assets: the row says what the file is, the store keeps
  // its bytes by SHA-256 (stored = the store's name, data then empty), null while they are in this row. One name per
  // run, so a run sent twice replaces instead of doubling. Nothing deletes a row on its own.
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
];

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

/**
 * What confirming each kind of chat action calls, as the person confirming (roadmap 29b): the method, the input it gets
 * from the stored one, and what the card keeps of its answer. One row per kind, so a new kind (28e, 29c) is one line.
 */
interface ChatCall {
  method: Method;
  input?: (stored: Record<string, unknown>) => Record<string, unknown>;
  result?: (output: unknown) => NonNullable<ChatAction["result"]>;
}
const CHAT_ACTION_CALLS: Record<ChatActionKind, ChatCall> = {
  "task.create": { method: "tasks.create", result: (o) => ({ taskId: (o as Task).id }) },
  "task.update": { method: "tasks.update", result: (o) => ({ taskId: (o as Task).id }) },
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
  "task.create": 0,
  "task.update": 1,
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

/** A run's tokens beside its record (run_costs joined as c), as toRunRecord reads them. */
const RUN_TOKEN_COLUMNS = "c.input_tokens AS tok_input, c.cache_write_tokens AS tok_cache_write, c.cache_read_tokens AS tok_cache_read, c.output_tokens AS tok_output";
const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/** A pushed text as the team may see it: no hidden characters, no line that looks like a secret. */
const clean = (text: string | null) => (text === null ? null : redactLines(stripHidden(text)));

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

function toRunRecord(r: Row, withLog: boolean): RunRecord {
  const s = (v: unknown) => (v == null ? null : String(v));
  return {
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
    attempt: numOrNull(r.attempt),
    parentRun: s(r.parent_run),
    verdict: s(r.verdict) as Verdict | null,
    ...(withLog ? { log: str(r.log), patch: r.patch == null ? null : str(r.patch) } : {}),
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
/** What fails a group's item when it is released; anything else (offline, cap, pause, a run going) waits for later. */
const GROUP_FAILS = new Set(["errors.machineNotFound", "errors.machineNoRepo", "errors.taskDone", "errors.taskNotInProject", "errors.profileNotOnMachine", "errors.secret"]);
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
  "docs.save": (i, o) => ({ target: i.key, detail: `v${o.version}${i.note ? ` · ${i.note}` : ""}` }),
  "docs.move": (i) => ({ target: i.key, detail: `→ ${i.parent ?? "/"}` }),
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
  "memory.approve": (i, o) => ({ target: `${o.project ?? "org"} #${i.id}` }),
  "memory.remove": (i) => ({ target: `memory #${i.id}` }),
  "tasks.create": (i) => ({ target: i.id, detail: i.dependsOn?.length ? `${i.title} · ← ${i.dependsOn.join(", ")}` : i.title }),
  "tasks.setDeps": (i) => ({ target: i.id, detail: i.dependsOn.length ? `← ${i.dependsOn.join(", ")}` : "—" }),
  "tasks.assign": (i, o: Task) => {
    const agent = o.agent ? `${o.agent.machine}${o.agent.profileId ? `/${o.agent.profileId}` : ""}` : "—";
    return { target: i.id, detail: `agent ${agent}`, text: { key: "audit.taskAssign", vars: { agent } } };
  },
  "tasks.unassign": (i) => ({ target: i.id, detail: "bỏ gán agent", text: { key: "audit.taskUnassign" } }),
  "machines.remove": (i) => ({ target: i.id }),
  "machines.setProfile": (i, o: Machine) => {
    const key = i.enabled === undefined ? "audit.profilePriority" : i.priority === undefined ? (i.enabled ? "audit.profileOn" : "audit.profileOff") : i.enabled ? "audit.profileOnPriority" : "audit.profileOffPriority";
    const parts = [i.enabled === undefined ? "" : i.enabled ? "bật" : "tắt", i.priority === undefined ? "" : `ưu tiên ${i.priority}`].filter(Boolean).join(", ");
    return { target: `${o.machine}/${i.profileId}`, detail: parts, text: { key, vars: { profile: i.profileId, priority: i.priority ?? "" } } };
  },
  "cooldowns.clear": (i) => ({ target: i.account }),
  "systems.save": (i, o: HiveSystem) => ({ target: i.name, detail: o.projects.join(", "), text: { key: "audit.system", vars: { projects: o.projects.join(", ") } } }),
  "systems.remove": (i) => ({ target: i.name }),
  "projects.archive": (i) => ({ target: i.project, detail: "lưu trữ", text: { key: "audit.projectArchived" } }),
  "projects.restore": (i) => ({ target: i.project, detail: "khôi phục", text: { key: "audit.projectRestored" } }),
  // The row count is the only record of what a deletion took: nothing is left in the tables to look at afterwards.
  "projects.delete": (i, o: ProjectDeleted) => {
    const rows = Object.values(o.rows).reduce((n, v) => n + v, 0);
    return { target: i.project, detail: `xoá hẳn · ${rows} dòng · backup ${o.backup}`, text: { key: "audit.projectDeleted", vars: { rows, backup: o.backup } } };
  },
  "policy.set": (_i, o: TeamPolicy) => ({
    target: "policy",
    detail: `CLI: ${o.requiredClis.join(", ") || "—"} · shim: ${o.requireShim ? "có" : "không"} · ${Object.keys(o.projects).length} dự án · ${o.profileTemplates.length} mẫu profile`,
    text: {
      key: o.requireShim ? "audit.policyShim" : "audit.policy",
      vars: { clis: o.requiredClis.join(", ") || "—", projects: Object.keys(o.projects).length, templates: o.profileTemplates.length },
    },
  }),
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
  "tasks.update": (i, o: Task) => ({ target: o.id, detail: `→ ${o.status}`, text: { key: "audit.taskStatus", vars: { status: o.status } } }),
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
  "docs.save": "doc",
  "docs.move": "doc",
  "docs.assetPut": "doc",
  "docs.assetRemove": "doc",
  "docs.assist": "doc",
  "docs.syncRequest": "project",
  "proposals.create": "doc",
  "proposals.approve": "proposal",
  "memory.write": "project",
  "tasks.create": "project",
  "tasks.setDeps": "task",
  "tasks.claim": "task",
  "tasks.update": "task",
  "tasks.assign": "task",
  "tasks.unassign": "task",
  "specs.push": "project",
  "specs.importTasks": "project",
  "specs.runStep": "project",
  "runs.dispatch": "project",
  "runs.prompt": "project",
  "runs.dispatchMany": "project",
  "runs.fanout": "project",
  "runs.mapReduce": "project",
  "chat.send": "project",
  "chat.setDefaults": "project",
  "chat.setCommands": "project",
  "chat.setAutonomy": "project",
  "chat.rename": "thread",
  "chat.configure": "thread",
  "sdlc.setProject": "project",
  "tools.setProject": "project",
  "agentPolicy.set": "project",
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
});

/** FTS5 query from free text: every word becomes a quoted prefix term, OR-ed together. */
function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_]+/gu);
  if (!words?.length) return null;
  return words.map((w) => `"${w}"*`).join(" OR ");
}

export interface SqliteHiveOptions {
  /** When true, memory written by non-admins stays `pending` (hidden from search) until an admin approves it. */
  memoryRequiresApproval?: boolean;
  /** Memory no agent searched up (nor anyone wrote or kept) for this many days is stale. 0: never. Default 90. */
  memoryStaleDays?: number;
  /** A run's log and patch go this many days after its last update; the rest of the record stays. 0: keep them. Default 30. */
  runLogDays?: number;
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

export class SqliteHive implements HiveBackend {
  readonly db: DatabaseSync;
  readonly #opts: Required<SqliteHiveOptions>;
  readonly #handlers: Handlers;
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
      now: () => new Date(),
      onEvent: () => undefined,
      embedder: null,
      embedMinScore: 0.5,
      local: false,
      blobs: null,
      backup: null,
      ...opts,
    };
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    // Case folding SQLite's LIKE leaves out beyond ASCII (Đ and đ): searches compare hive_fold of both sides.
    this.db.function("hive_fold", { deterministic: true }, (v) => (typeof v === "string" ? v.normalize("NFC").toLocaleLowerCase("vi") : v));
    this.#migrate();
    this.#handlers = this.#buildHandlers();
  }

  async call<M extends Method>(method: M, input: MethodInput<M>, caller: Actor): Promise<MethodOutput[M]> {
    authorize(method, caller);
    const actor = this.#withSystems(caller);
    const parsed = parseInput(method, input);
    const handler = this.#handlers[method] as (i: ParsedInput<M>, a: Actor) => MethodOutput[M] | Promise<MethodOutput[M]>;
    this.#check(method, parsed as ParsedInput<Method>, actor);
    this.#assertProjectOpen(method, parsed as ParsedInput<Method>);
    const output = this.#hideArchived(method, parsed as ParsedInput<Method>, this.#filter(method, await handler(parsed, actor), actor));
    const audited = AUDITED[method] ?? (isAgentActor(actor) ? AGENT_AUDITED[method] : undefined);
    if (audited) {
      const { target, detail, text } = audited(parsed, output);
      this.audit(actor, method, target, detail, text);
    }
    const event = eventOf(method, parsed, output, actor);
    if (event) {
      try {
        this.#opts.onEvent(event);
      } catch {
        // a listener must never fail the call
      }
    }
    return output;
  }

  // ── per-project access (access.ts) ─────────────────────────────────────────

  /** An account's grants with the ones it gets on each system from its services (roadmap 19c). */
  #withSystems(actor: Actor): Actor {
    if (!actor.access) return actor;
    const access = withSystemGrants(actor.access, this.#systemList());
    return access === actor.access ? actor : { ...actor, access };
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

  /** A doc agents read takes contextEdit to change, any other docEdit (roadmap 25): as it is, or as the save makes it. */
  #docPermission(key: string, after?: { paths?: string[]; includeInAgents?: boolean }): Permission {
    return isContextDoc(key, this.#getDoc(key)) || isContextDoc(key, after) ? "contextEdit" : "docEdit";
  }

  #check(method: Method, input: ParsedInput<Method>, actor: Actor): void {
    const i = input as Record<string, any>;
    const owner = SqliteHive.#docOwner;
    switch (method) {
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
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "artifacts.get":
      case "artifacts.remove": {
        const row = this.db.prepare("SELECT project FROM artifacts WHERE id = ?").get(i.id) as Row | undefined;
        // Removing is the project manager's: nothing else ever deletes an artifact.
        if (row) this.#need(actor, str(row.project), method === "artifacts.get" ? "view" : "projectSettings", `Artifact #${i.id}`);
        return;
      }
      case "docs.save":
        return this.#need(actor, owner(i.key), this.#docPermission(i.key, { paths: i.paths, includeInAgents: i.includeInAgents }), `Doc ${i.key}`);
      case "docs.move":
        return this.#need(actor, owner(i.key), this.#docPermission(i.key), `Doc ${i.key}`);
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
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      // Whoever may change what agents read may have the machines write it now.
      case "docs.syncRequest":
        return this.#need(actor, i.project, "contextEdit", `Project ${i.project}`);
      case "proposals.create":
        return this.#need(actor, owner(i.docKey), "docPropose", `Doc ${i.docKey}`);
      case "proposals.approve":
      case "proposals.reject": {
        const row = this.db.prepare("SELECT doc_key, COALESCE(on_behalf, author) AS owner FROM proposals WHERE id = ?").get(i.id) as Row | undefined;
        // A change to what agents read is the context's to approve; any other a doc reviewer's.
        if (row) this.#need(actor, owner(str(row.doc_key)), this.#docPermission(str(row.doc_key)) === "contextEdit" ? "contextEdit" : "docApprove", `Proposal #${i.id}`);
        // Rejecting your own proposal is only taking it back.
        if (row && method === "proposals.approve") this.#notSelf(actor, [str(row.owner)], `Proposal #${i.id}`);
        return;
      }
      case "memory.search":
      case "skills.list":
      case "runs.list":
      case "runs.requests":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "runs.dispatch":
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.dispatchMany":
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.fanout":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.mapReduce":
      case "runs.mapSplit":
        this.#need(actor, i.project, "taskManage", `Project ${i.project}`);
        return this.#need(actor, i.project, "runDispatch", `Project ${i.project}`);
      case "runs.resumeGroup": {
        const row = this.db.prepare("SELECT project FROM run_groups WHERE id = ?").get(i.id) as Row | undefined;
        if (!row) return;
        this.#need(actor, str(row.project), "taskManage", `Run group #${i.id}`);
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
        return this.#need(actor, i.project, "chatUse", `Project ${i.project}`);
      case "chat.threads":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "chat.get": {
        const row = this.db.prepare("SELECT project FROM chat_threads WHERE id = ?").get(i.threadId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "view", `Chat #${i.threadId}`);
        return;
      }
      case "chat.propose": {
        // The reply's own token only: the leader has at most what the sender and the machine both have.
        const row = actor.chatReply
          ? (this.db.prepare("SELECT t.project FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ?").get(actor.chatReply) as Row | undefined)
          : undefined;
        // Only proposing: someone with chatApprove decides, and the token is this one reply's (its sender could chat).
        if (row) this.#need(actor, str(row.project), "view", `Chat reply #${actor.chatReply}`);
        return;
      }
      case "chat.decideAll": {
        const row = this.db
          .prepare("SELECT t.project FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ?")
          .get(i.replyId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "chatApprove", `Chat reply #${i.replyId}`);
        return;
      }
      case "chat.decide": {
        const row = this.db.prepare("SELECT project FROM chat_actions WHERE id = ?").get(i.actionId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "chatApprove", `Chat action #${i.actionId}`);
        return;
      }
      case "chat.defaults":
        return this.#need(actor, i.project, "view", `Project ${i.project}`);
      case "chat.pending":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "chat.setDefaults":
      case "chat.setCommands":
      case "chat.setAutonomy":
        return this.#need(actor, i.project, "projectSettings", `Project ${i.project}`);
      // The ceiling binds every project: a hub admin (no per-project grants) only.
      case "sdlc.setCeiling":
        if (actor.role !== "admin" || actor.access) throw new HiveError("forbidden", "Only a hub admin sets how far gates may go.", { key: "errors.hubAdminOnly" });
        return;
      case "sdlc.setProject":
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
        return this.#need(actor, str(row.project), "runDispatch", `Gate #${i.gateId}`);
      }
      case "sdlc.retry": {
        const row = this.db.prepare("SELECT project FROM sdlc_flows WHERE task_id = ?").get(i.taskId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Flow ${i.taskId}`);
        return;
      }
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
        if (row) this.#need(actor, str(row.project), "chatUse", `Chat #${i.threadId}`);
        return;
      }
      case "chat.cancel": {
        const row = this.db
          .prepare("SELECT t.project FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = ?")
          .get(i.replyId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "chatUse", `Chat reply #${i.replyId}`);
        return;
      }
      case "runs.cancel": {
        const row = this.db.prepare("SELECT project FROM run_records WHERE machine_id = ? AND run_id = ?").get(i.machineId, i.runId) as Row | undefined;
        if (row) this.#need(actor, str(row.project), "runDispatch", `Run ${i.runId}`);
        return;
      }
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
      case "specs.push":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "specs.list":
        if (i.project) this.#need(actor, i.project, "view", `Project ${i.project}`);
        return;
      case "specs.importTasks":
        // Planning only shows what would be made; making them is creating tasks.
        return this.#need(actor, i.project, i.dryRun ? "view" : "taskManage", `Project ${i.project}`);
      case "memory.write":
        if (i.system) return this.#need(actor, systemOwner(i.system), "memoryWrite", `System ${i.system}`);
        return this.#need(actor, i.shared ? null : i.project, "memoryWrite", i.shared ? "Shared memory" : `Project ${i.project}`);
      case "memory.checkFiles":
      case "runs.report":
        return this.#need(actor, i.project, "taskWork", `Project ${i.project}`);
      case "memory.approve":
      case "memory.resolve":
      case "memory.keep":
      case "memory.remove": {
        const row = this.db.prepare("SELECT project, COALESCE(on_behalf, author) AS owner FROM memory WHERE id = ?").get(i.id) as Row | undefined;
        if (row) this.#need(actor, str(row.project) === SHARED ? null : str(row.project), "memoryApprove", `Memory #${i.id}`);
        if (row && method === "memory.approve") this.#notSelf(actor, [str(row.owner)], `Memory #${i.id}`);
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
      // Giving a task to an agent is queueing its run, only without saying when: the same right as runs.dispatch.
      case "tasks.assign":
      case "tasks.unassign": {
        const task = this.#getTask(i.id);
        if (task) this.#need(actor, task.project, "runDispatch", `Task ${i.id}`);
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
  #filter<M extends Method>(method: M, output: MethodOutput[M], actor: Actor): MethodOutput[M] {
    if (!actor.access) return output;
    const visible = (owner: string | null) => sees(actor, owner);
    const out = output as unknown;
    switch (method as Method) {
      case "docs.list":
        return (out as DocSummary[]).filter((d) => visible(d.project)) as MethodOutput[M];
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
    this.db
      .prepare("INSERT INTO audit(at, actor, action, target, detail, detail_key, detail_vars, agent, on_behalf, run) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
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
      );
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
    this.#need(actor, input.project, "chatUse", `Project ${input.project}`);
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
    for (let v = current; v < MIGRATIONS.length; v++) {
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
      const row = this.db.prepare("SELECT parent FROM docs WHERE key = ?").get(at) as Row | undefined;
      if (!row) {
        if (at === parent) throw bad("docParentMissing", `There is no page ${parent} to put ${key} under.`);
        break;
      }
      at = strOrNull(row.parent);
    }
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
    return rows.map((r) => toTask(r, by.get(str(r.id)), this.#machineNames()));
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

  #sdlcPolicy(): SdlcPolicySettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'sdlcPolicy'").get() as Row | undefined;
    return row ? { ...EMPTY_SDLC_POLICY, ...(JSON.parse(str(row.value)) as Partial<SdlcPolicySettings>) } : EMPTY_SDLC_POLICY;
  }

  #saveSdlc(policy: SdlcPolicySettings, actor: Actor): void {
    const next: SdlcPolicySettings = { ...policy, updatedAt: this.#now(), updatedBy: actor.name };
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('sdlcPolicy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  }

  /** Every project with tasks shows, with what applies to it, even one that never changed a gate. */
  #sdlcView(): SdlcPolicyView {
    const projects = (this.db.prepare("SELECT DISTINCT project FROM tasks").all() as Row[]).map((r) => str(r.project));
    return sdlcPolicyView(this.#sdlcPolicy(), projects);
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
        return (out as DocSummary[]).filter((d) => shown(d.project)) as MethodOutput[M];
      case "skills.list":
        return (out as SkillSummary[]).filter((s) => shown(s.project)) as MethodOutput[M];
      case "memory.search":
      case "memory.list":
        return (out as Memory[]).filter((m) => shown(m.project)) as MethodOutput[M];
      case "tasks.list":
      case "tasks.next":
        return (out as Task[]).filter((t) => shown(t.project)) as MethodOutput[M];
      case "tasks.agentQueue":
        return (out as TaskAgentQueueItem[]).filter((q) => shown(q.task.project)) as MethodOutput[M];
      case "specs.list":
        return (out as SpecFeature[]).filter((f) => shown(f.project)) as MethodOutput[M];
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
      if (typeof v === "string" && v && systemOf(v) === null) names.add(v);
    };
    for (const table of ["tasks", "docs", "memory", "run_records", "chat_threads", "project_states", "artifacts"]) {
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
    // Items hang off their group by id, with no project column of their own and no cascade to carry them.
    run("run_group_items", "DELETE FROM run_group_items WHERE group_id IN (SELECT id FROM run_groups WHERE project = ?)", project);

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
    if (candidates > 1 && role !== "implement") throw new HiveError("bad_request", "Only implement runs have candidates.", { key: "errors.candidatesImplementOnly" });
    if (candidates > 1 && profileId) throw new HiveError("bad_request", "Candidates rotate profiles; do not pin one.", { key: "errors.candidatesPinned" });
    if (task) {
      const taskId = task.id;
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
      const item = this.#group(num(row.id)).items.find((i) => i.taskId === taskId);
      if (item && (item.status === "held" || item.active)) {
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
      status: str(r.status),
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
    // The split run's list lands in the task's note when its machine reports the task, which may come after its run.
    if (phase === "ready" && !parts.length && g.parent_task) parts = parseParts(this.#getTask(str(g.parent_task))?.note);
    return {
      phase,
      parts,
      machineId: strOrNull(g.machine_id),
      phaseRequest,
      phaseRun: this.#groupRun(phaseRequest),
      phaseError: g.phase_error ? (JSON.parse(str(g.phase_error)) as RunRequestError) : null,
    };
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
    return places - busy - (waiting.get(m.id) ?? 0);
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
      for (const item of g.items) {
        if (item.status !== "held") continue;
        if (g.maxParallel !== null && active >= g.maxParallel) break;
        const now = this.#now();
        const task = this.#getTask(item.taskId);
        const fail = (error: RunRequestError) =>
          db.prepare("UPDATE run_group_items SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(error), now, item.id);
        if (!task) {
          fail({ message: `Task ${item.taskId} not found.`, key: "errors.taskNotFound", vars: { id: item.taskId } });
          continue;
        }
        if (task.waitingOn.length) continue;
        // The group still decides when the task runs; a task with an agent (roadmap 50) only lends the item the machine
        // and plan to run it on, when the item names none of its own.
        const agent = item.machineId === null ? task.agent : null;
        const profileId = item.profileId ?? agent?.profileId ?? null;
        const machineId = item.machineId ?? agent?.machineId ?? this.#freeMachine(g.project, profileId);
        if (!machineId) continue;
        try {
          const instructions = [g.instructions, item.instructions].filter(Boolean).join("\n\n");
          const m = this.#assertDispatchable(
            { machineId, project: g.project, task, role: item.role, profileId, candidates: 1, instructions },
            actor,
          );
          // A job's parts get no review of their own: the merged result does (roadmap 31c).
          const reviewAfter = g.kind === "mapreduce" ? false : g.reviewAfter;
          const req = this.#insertRequest(m, g.project, task, { role: item.role, profileId, preferKind: item.preferKind, reviewAfter, candidates: 1, instructions }, actor);
          db.prepare("UPDATE run_group_items SET status = 'sent', machine_id = ?, request_id = ?, updated_at = ? WHERE id = ?").run(machineId, req.id, now, item.id);
          active++;
        } catch (err) {
          if (!(err instanceof HiveError)) throw err;
          if (!groupFails(err.key)) continue;
          fail({ message: err.message, ...(err.key ? { key: err.key } : {}), ...(err.vars ? { vars: err.vars as Record<string, string | number> } : {}) });
        }
      }
      const after = this.#group(g.id);
      if (after.kind === "mapreduce") this.#mapStep(after, actor);
      else if (!after.items.some((i) => i.status === "held" || i.active)) db.prepare("UPDATE run_groups SET closed_at = ? WHERE id = ?").run(this.#now(), g.id);
    }
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
      if (g.phase === "split") db.prepare("UPDATE run_groups SET phase = 'ready', parts = ? WHERE id = ?").run(JSON.stringify(parseParts(this.#getTask(g.parentTask!)?.note)), g.id);
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
    for (const t of parts) close.run(now, t.id);
    const task = this.#getTask(parent.id)!;
    const instructions = reduceInstructions(parent.id, parts.map((t) => ({ taskId: t.id, title: t.title, note: t.note })));
    try {
      const m = this.#assertDispatchable({ machineId: g.machineId!, project: g.project, task, role: "implement", profileId: null, candidates: 1, instructions }, actor);
      const req = this.#insertRequest(m, g.project, task, { role: "implement", profileId: null, reviewAfter: g.reviewAfter, candidates: 1, instructions }, actor);
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
    this.#releaseGroups();
    this.#releaseAssigned();
  }

  /**
   * The machines a call speaks for, or [] for a person: the runner's own token (its name is the machine's hub id), and
   * an agent run on a machine, which says so in its write source. A hub may hold two rows for one machine name (two
   * accounts' tokens), and the agent's token tells them apart no better than its user does — so all of them count.
   */
  #callerMachines(actor: Actor): string[] {
    const own = this.db.prepare("SELECT id FROM machines WHERE id = ?").get(actor.name) as Row | undefined;
    if (own) return [str(own.id)];
    const name = actor.source?.machine;
    if (!name) return [];
    return (this.db.prepare("SELECT id FROM machines WHERE machine = ?").all(name) as Row[]).map((r) => str(r.id));
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
    for (const task of this.#tasks(rows)) {
      const agent = task.agent!;
      const m = machineOf(agent.machineId);
      // A machine the hub no longer has: no places to count, and #agentWait says so before it looks at them.
      const free = m ? this.#freePlaces(m, task.project, agent.profileId, waiting) - this.#unreportedRequests(m) : 0;
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
        // The project's review gate decides the cross-review, as it does for the tasks a flow hands out (roadmap 34c).
        const reviewAfter = effectiveGates(this.#sdlcPolicy(), task.project).review !== "auto";
        const req = this.#insertRequest(machine, task.project, task, { role: "implement", profileId: agent.profileId, reviewAfter, candidates: 1, instructions: "" }, actor);
        // This turn's run: the task is not handed over again until a person assigns it afresh.
        db.prepare("UPDATE tasks SET agent_request = ? WHERE id = ?").run(req.id, task.id);
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
        `SELECT q.status, q.updated_at, r.status AS run_status FROM run_requests q
         LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
         WHERE q.id = (SELECT agent_request FROM tasks WHERE id = ?)`,
      )
      .get(task.id) as Row | undefined;
    if (!r) return null;
    if (str(r.status) === "pending") return "going";
    if (str(r.status) !== "accepted") return null;
    const status = strOrNull(r.run_status);
    if (status === "queued" || status === "running") return "going";
    if (status !== null) return "over";
    return str(r.updated_at) > this.#now(-GROUP_UNREPORTED_MINUTES) ? "going" : null;
  }

  /**
   * Places taken on a machine that #freeMachine's count of pending requests misses: one the machine has taken but whose
   * run it has not pushed yet. Without this an assignment goes out twice in the window between runs.requestResult and
   * the first push, when the task looks free to #assertDispatchable and the place looks free to #freePlaces.
   */
  #unreportedRequests(m: Machine): number {
    const have = new Set(m.runs.map((r) => r.runId));
    const rows = this.db
      .prepare(
        `SELECT q.run_id, r.status AS run_status FROM run_requests q
         LEFT JOIN run_records r ON r.machine_id = q.machine_id AND r.run_id = q.run_id
         WHERE q.machine_id = ? AND q.status = 'accepted' AND q.updated_at > ?`,
      )
      .all(m.id, this.#now(-GROUP_UNREPORTED_MINUTES)) as Row[];
    return rows.filter((r) => {
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
   * A run of an assigned task ended (runs.push). Failed or cancelled: the agent stops here and the task says why, so it
   * does not take a broken task again and again; a person presses *Chạy lại* (assigns it again) or gives it to another.
   */
  #agentRunEnded(r: { runId: string; taskId: string; project: string; role: string; status: string; error: string | null }): void {
    if (r.role !== "implement" || r.status === "succeeded") return;
    const row = this.db.prepare("SELECT agent_machine, agent_hold FROM tasks WHERE id = ? AND project = ?").get(r.taskId, r.project) as Row | undefined;
    if (!row || row.agent_machine == null || row.agent_hold != null) return;
    this.#holdAgent(
      r.taskId,
      r.status === "cancelled"
        ? { message: `Run ${r.runId} was cancelled.`, key: "errors.agentRunCancelled", vars: { run: r.runId } }
        : { message: r.error ?? `Run ${r.runId} ${r.status}.`, key: "errors.agentRunFailed", vars: { run: r.runId, error: clipDetail(r.error ?? r.status) } },
    );
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
        db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(t.id, project, t.title, note(t.phase), this.#now());
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
        this.#setTask(r.taskId, { stage: "merge", gate_id: null });
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
        this.#setTask(r.taskId, { stage: "merge", gate_id: null, note: null });
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

  #insertRequest(
    m: Machine,
    project: string,
    task: Task,
    r: { role: AgentRole; profileId: string | null; preferKind?: PreferKind | null; reviewAfter: boolean; candidates: number; instructions: string },
    actor: Actor,
  ): RunRequest {
    const now = this.#now();
    const res = this.db
      .prepare(
        `INSERT INTO run_requests(machine_id, machine, project, task_id, task_title, role, profile_id, prefer_kind, review_after, candidates,
           instructions, requested_by, on_behalf, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      // A pinned profile is the run's whatever its kind, so the preference would mean nothing.
      .run(m.id, m.machine, project, task.id, task.title, r.role, r.profileId, r.profileId ? null : (r.preferKind ?? null), r.reviewAfter ? 1 : 0, r.candidates, r.instructions, actor.name, actor.onBehalf ?? null, now, now);
    return this.#runRequest(num(res.lastInsertRowid));
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
    this.db.prepare("DELETE FROM run_requests WHERE status <> 'pending' AND updated_at < ?").run(this.#now(-RUN_REQUEST_DAYS * 24 * 60));
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
          const count = num((db.prepare("SELECT COUNT(*) AS n FROM chat_actions WHERE reply_id = ?").get(replyId) as Row).n);
          if (count >= CHAT_ACTIONS_PER_REPLY) {
            throw new HiveError("bad_request", `A reply proposes at most ${CHAT_ACTIONS_PER_REPLY} actions.`, { key: "errors.chatTooManyActions", vars: { max: CHAT_ACTIONS_PER_REPLY } });
          }
          const project = str(reply.project);
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
          const plannedRow = (id: string) =>
            db.prepare("SELECT json_extract(input, '$.project') AS project FROM chat_actions WHERE reply_id = ? AND kind = 'task.create' AND json_extract(input, '$.id') = ?").get(replyId, id) as
              | Row
              | undefined;
          const planned = (id: string) => plannedRow(id) !== undefined;
          // The project a task is in, or will be in once this reply's proposal to create it is confirmed.
          const projectOf = (id: string): string | null => strOrNull(task(id)?.project) ?? strOrNull(plannedRow(id)?.project);
          // A task of the project, or of another service of a system it is in that the sender sees (roadmap 19d), or one
          // this reply also proposes to create (confirming all makes it first).
          const known = (id: string) => {
            const p = projectOf(id);
            return p !== null && (p === project || (this.#sameSystem(p, project) && sees(actor, p)));
          };
          const missing = (id: string) =>
            new HiveError("not_found", `Task ${id} not found in ${project}.`, { key: "errors.chatTaskNotFound", vars: { id, project } });
          // A machine by hub id or name, as run.dispatch names one.
          const machineRow = (wanted: string): Row => {
            const m = db.prepare("SELECT * FROM machines WHERE id = ? OR machine = ? ORDER BY last_seen DESC LIMIT 1").get(wanted, wanted) as Row | undefined;
            if (!m) throw new HiveError("not_found", `No machine ${wanted}.`, { key: "errors.machineNotFound", vars: { machine: wanted } });
            return m;
          };
          // Only a run of this chat's project: the leader acts for this project alone.
          const runRow = (machineId: string, runId: string): Row => {
            const r = db.prepare("SELECT status, mr_url FROM run_records WHERE machine_id = ? AND run_id = ? AND project = ?").get(machineId, runId, project) as Row | undefined;
            if (!r) throw new HiveError("not_found", `Run ${runId} not found in ${project}.`, { key: "errors.chatRunNotFound", vars: { id: runId, project } });
            return r;
          };
          let input: Record<string, unknown>;
          switch (action.kind) {
            case "task.create": {
              if (task(action.id) || planned(action.id)) throw new HiveError("conflict", `Task ${action.id} already exists.`, { key: "errors.taskExists", vars: { id: action.id } });
              // A leader of one service plans a feature across its system: a task for another service of it (roadmap 19d).
              const target = action.project ?? project;
              if (target !== project && (!this.#sameSystem(target, project) || !sees(actor, target))) {
                throw new HiveError("bad_request", `${target} is not a service of a system with ${project}.`, { key: "errors.chatProjectOutside", vars: { project: target, home: project } });
              }
              input = { id: action.id, project: target, title: action.title, dependsOn: action.dependsOn };
              break;
            }
            case "task.update":
              if (!known(action.id)) throw missing(action.id);
              input = { id: action.id, status: action.status, ...(action.note === undefined ? {} : { note: action.note }) };
              break;
            case "task.assign": {
              if (!known(action.taskId)) throw missing(action.taskId);
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
              if (!known(action.taskId)) throw missing(action.taskId);
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
              break;
            }
            case "run.cancel": {
              const machineId = str(machineRow(action.machine).id);
              const status = str(runRow(machineId, action.runId).status);
              if (status !== "queued" && status !== "running") {
                throw new HiveError("conflict", `Run ${action.runId} has ended (${status}).`, { key: "errors.chatRunEnded", vars: { id: action.runId } });
              }
              input = { machineId, runId: action.runId };
              break;
            }
            case "run.merge": {
              const machineId = str(machineRow(action.machine).id);
              if (runRow(machineId, action.runId).mr_url == null) {
                throw new HiveError("bad_request", `Run ${action.runId} has no merge request.`, { key: "errors.chatRunNoMr", vars: { id: action.runId } });
              }
              input = { machineId, runId: action.runId };
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
              break;
            }
            case "agent.policy":
              // What it is now, so the card shows before and after; the policy may change again before it is confirmed.
              input = { project, policy: action.policy, before: this.#agentPolicy().projects[project] ?? null };
              break;
            case "agents.stop":
            case "agents.resume":
              input = { project };
              break;
            case "machine.install": {
              // The machine's own items, or this project's: another project's install is not this chat's to ask for.
              const colon = action.itemId.indexOf(":");
              const owner = action.itemId === "shim" || action.itemId.startsWith("cli:") ? null : action.itemId.slice(0, colon);
              if (owner !== null && owner !== project) {
                throw new HiveError("forbidden", `${action.itemId} belongs to another project.`, { key: "errors.chatInstallOtherProject", vars: { item: action.itemId, project } });
              }
              input = { machineId: str(machineRow(action.machine).id), itemId: action.itemId };
              break;
            }
            case "tool.enable": {
              const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(action.id) as Row | undefined;
              if (!row) throw new HiveError("not_found", `No tool ${action.id}.`, { key: "errors.toolNotFound", vars: { id: action.id } });
              // The project's setting now: the card shows before and after, and a proposal that leaves required out
              // should not drop a requirement the project set.
              const view = this.#toolView(row, actor, project);
              const now = view.projects.find((p) => p.project === project)!;
              input = {
                id: view.id,
                project,
                enabled: action.enabled,
                required: action.required ?? now.required,
                name: view.name,
                before: { enabled: now.enabled, required: now.required, effective: now.effective },
              };
              break;
            }
          }
          const id = num(
            db
              .prepare("INSERT INTO chat_actions(reply_id, thread_id, project, kind, input, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
              .run(replyId, num(reply.thread_id), project, action.kind, JSON.stringify(input), reason, this.#now()).lastInsertRowid,
          );
          return this.#chatAction(id);
    });
  }

  /**
   * Runs a proposal as `actor`'s own call, or sets it aside: a person confirming it (chat.decide), or the leader running
   * it as the person who sent the message (auto, roadmap 29c).
   */
  async #decideChat(actionId: number, accept: boolean, actor: Actor, auto: boolean): Promise<ChatAction> {
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
    if (CHAT_ACTION_ALWAYS_CONFIRM.includes(action.kind) || !this.#chatDefaults(action.project).autoKinds.includes(action.kind)) return action;
    // A run or a move of a task this reply proposes to create waits until someone confirms the task.
    const taskId =
      action.kind === "run.dispatch" ? action.input.taskId : action.kind === "task.update" || action.kind === "task.assign" ? action.input.id : null;
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
    return this.#decideChat(action.id, true, person, true);
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
        requestedBy: str(r.requested_by ?? ""),
        createdAt: str(r.created_at),
        ...(r.sender == null ? {} : { sender: JSON.parse(str(r.sender)) as ChatSender }),
        files: (this.db.prepare(`SELECT ${FILE_FIELDS} FROM chat_files WHERE message_id = ? ORDER BY id`).all(num(r.message_id ?? 0)) as Row[]).map(toChatFile),
        commands: this.#chatDefaults(str(r.project)).commands,
        // The systems the project is a service of (roadmap 19d): the leader plans across them.
        systems: this.#systemList().filter((s) => s.projects.includes(str(r.project))),
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

  #runRequest(id: number): RunRequest {
    const row = this.db.prepare("SELECT * FROM run_requests WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new HiveError("not_found", `Run request #${id} not found.`, { key: "errors.runRequestNotFound", vars: { id } });
    return toRunRequest(row);
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
      owner: strOrNull(r.owner),
      profileChanges: this.#profileChanges(str(r.id)),
    };
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
             WHERE (?1 IS NULL OR scope = ?1) AND (?2 IS NULL OR scope = 'org' OR project = ?2 OR project IN (SELECT value FROM json_each(?3)))
             ORDER BY scope, project, key`,
          )
          .all(scope ?? null, project ?? null, JSON.stringify(this.#systemOwnersOf([project]))) as Row[];
        return rows.map(toSummary);
      },

      "docs.get": ({ key }) => this.#getDoc(key),

      "skills.list": ({ project }) => {
        const rows = db
          .prepare(
            `SELECT key, scope, project, content, version, updated_by, updated_at FROM docs
             WHERE key LIKE '%/skills/%' AND (?1 IS NULL OR scope = 'org' OR project = ?1)
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

      "docs.move": ({ key, parent }) =>
        this.#tx(() => {
          if (!this.#getDoc(key)) throw new HiveError("not_found", `Doc ${key} not found.`, { key: "errors.notFound" });
          if (parent) this.#checkParent(key, parent);
          db.prepare("UPDATE docs SET parent = ? WHERE key = ?").run(parent, key);
          const { content: _content, ...summary } = this.#getDoc(key)!;
          return summary;
        }),

      "docs.links": ({ key }, actor) => {
        const rows = db.prepare("SELECT key, title, content FROM docs").all() as Row[];
        const titles = new Map(rows.map((r) => [str(r.key), str(r.title)]));
        const exists = (k: string) => titles.has(k);
        const seen = (k: string) => sees(actor, SqliteHive.#docOwner(k));
        const doc = rows.find((r) => str(r.key) === key);
        const out: DocLinks["out"] = [];
        for (const ref of docLinkRefs(doc ? str(doc.content) : "")) {
          const hit = resolveDocLink(ref.target, key, exists);
          if (!hit || (hit.exists && !seen(hit.key)) || out.some((o) => o.key === hit.key)) continue;
          out.push({ target: ref.target, key: hit.key, title: hit.exists ? titles.get(hit.key)! : null, exists: hit.exists });
        }
        const back: DocLinks["back"] = [];
        for (const r of rows) {
          const from = str(r.key);
          if (from === key || !seen(from)) continue;
          const text = str(r.content);
          if (!text.includes("[[")) continue;
          if (docLinkRefs(text).some((ref) => resolveDocLink(ref.target, from, exists)?.key === key)) {
            back.push({ key: from, title: str(r.title), snippet: linkSnippet(text, from, key, exists, (k) => titles.get(k)) });
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
          reply,
          markdown,
          profile,
          costUsd,
          error ? JSON.stringify(error) : null,
          this.#now(),
          aid,
        );
        return { ok: true };
      },

      "docs.context": ({ project }) => {
        // As docs.list gives a project's sync: its own, the team's and its systems' (roadmap 19c).
        const docs = (
          db.prepare("SELECT * FROM docs WHERE project IS NULL OR project = ? OR project IN (SELECT value FROM json_each(?))").all(project, JSON.stringify(this.#systemOwnersOf([project]))) as Row[]
        ).map(toDoc);
        const staleBefore = this.#staleBefore();
        const count = (p: string, status: string, stale?: boolean) =>
          (db.prepare("SELECT created_at, last_used_at FROM memory WHERE project = ? AND status = ? AND superseded_by IS NULL").all(p, status) as Row[]).filter(
            (r) => stale === undefined || (staleBefore !== null && (strOrNull(r.last_used_at) ?? str(r.created_at)) < staleBefore) === stale,
          ).length;
        return {
          ...describeProjectContext(project, docs),
          memory: {
            project: count(project, "approved", false),
            shared: count(SHARED, "approved", false),
            stale: count(project, "approved", true) + count(SHARED, "approved", true),
            pending: count(project, "pending") + count(SHARED, "pending"),
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
      "artifacts.put": async ({ project, taskId, runId, profileId, name: raw, data }, actor) => {
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
          const has = db.prepare("SELECT id FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?").get(actor.name, runId, name);
          if (has) return;
          const count = num((db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE machine_id = ? AND run_id = ?").get(actor.name, runId) as Row).n);
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
          const before = db.prepare("SELECT sha256, stored FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?").get(actor.name, runId, name) as Row | undefined;
          db.prepare(
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
            artifact: toArtifact(db.prepare(`SELECT ${ARTIFACT_FIELDS} FROM artifacts WHERE machine_id = ? AND run_id = ? AND name = ?`).get(actor.name, runId, name) as Row),
            dropped: before?.stored && before.sha256 !== sha ? str(before.sha256) : null,
          };
        });
        if (dropped) await this.#dropBlob(dropped);
        return artifact;
      },

      "artifacts.list": ({ project, taskId, runId, machineId, limit }) =>
        (
          db
            .prepare(
              `SELECT ${ARTIFACT_FIELDS} FROM artifacts WHERE project = ?1 AND (?2 IS NULL OR task_id = ?2) AND (?3 IS NULL OR run_id = ?3)
               AND (?4 IS NULL OR machine_id = ?4) ORDER BY id DESC LIMIT ?5`,
            )
            .all(project, taskId ?? null, runId ?? null, machineId ?? null, limit) as Row[]
        ).map(toArtifact),

      "artifacts.get": async ({ id }) => {
        const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
        if (!row) return null;
        const bytes = row.stored === null || row.stored === undefined ? (row.data as Uint8Array) : await this.#fromStore(row);
        return { artifact: toArtifact(row), data: Buffer.from(bytes).toString("base64") };
      },

      "artifacts.remove": async ({ id }) => {
        const row = db.prepare("SELECT project, name, sha256, stored FROM artifacts WHERE id = ?").get(id) as Row | undefined;
        if (!row) return { removed: false, project: null, name: null };
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
        const parsed = parseDocKey(input.docKey);
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

      "proposals.approve": ({ id }, actor) =>
        this.#tx(() => {
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
        }),

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

      "memory.searchInfo": () => {
        const model = this.#opts.embedder?.model ?? null;
        const count = (sql: string, ...args: string[]) => num((db.prepare(sql).get(...args) as Row).n);
        return {
          mode: model ? "hybrid" : "keyword",
          model,
          indexed: model
            ? count("SELECT COUNT(*) AS n FROM memory m JOIN memory_vectors v ON v.memory_id = m.id AND v.model = ? WHERE m.status = 'approved'", model)
            : 0,
          total: count("SELECT COUNT(*) AS n FROM memory WHERE status = 'approved'"),
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
      "memory.remove": ({ id }) =>
        this.#tx(() => {
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
        }),

      "tasks.list": ({ project, projects, status }) =>
        this.#tasks(
          db
            .prepare(
              `SELECT * FROM tasks WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3)))
               ORDER BY updated_at DESC LIMIT 500`,
            )
            .all(project ?? null, status ?? null, listParam(projects)) as Row[],
        ),

      "tasks.create": (input, actor) =>
        this.#tx(() => {
          if (this.#getTask(input.id)) throw new HiveError("conflict", `Task ${input.id} already exists.`, { key: "errors.taskExists", vars: { id: input.id } });
          const deps = this.#checkDeps(input.id, input.project, input.dependsOn, actor);
          db.prepare("INSERT INTO tasks(id, project, title, updated_at) VALUES (?, ?, ?, ?)").run(
            input.id,
            input.project,
            input.title,
            this.#now(),
          );
          this.#setDeps(input.id, deps);
          return this.#getTask(input.id)!;
        }),

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
               ORDER BY assigned_to_me DESC, CASE WHEN assigned_to_me THEN t.agent_order END, unlocks DESC, t.rowid
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

      "tasks.update": ({ id, status, note }, actor) =>
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
          db.prepare(
            "UPDATE tasks SET status = ?, owner = ?, lease_until = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?",
          ).run(
            status,
            doing ? actor.name : null,
            doing ? (task.owner === actor.name ? task.leaseUntil : this.#now(120)) : null,
            note ?? null,
            now,
            id,
          );
          return this.#getTask(id)!;
        }),

      "tasks.assign": ({ id, machineId, profileId, before }, actor) =>
        this.#tx(() => {
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
          // A fresh turn: it may start at once, whatever run the task had under the assignment before this one.
          this.#releaseAssigned();
          return this.#getTask(id)!;
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
        const taken = this.#unreportedRequests(m);
        // The same count the release loop works from, so the queue says "busy" exactly when the hub would hold a task.
        const places = new Map<string, number>();
        const freeFor = (project: string, plan: string | null): number => {
          const key = `${project}\u0000${plan ?? ""}`;
          if (!places.has(key)) places.set(key, this.#freePlaces(m, project, plan, waiting) - taken);
          return places.get(key)!;
        };
        return this.#tasks(rows).map((task): TaskAgentQueueItem => ({ task, waiting: this.#agentWait(task, m, freeFor(task.project, task.agent!.profileId)) }));
      },

      // Keyed by the hub actor (`runner.<machine>@<token>`): the same key as the leases that machine takes.
      "machines.heartbeat": ({ machine, instance, version, runs, setup, profiles, projects, acceptsRuns, costs }, actor) =>
        this.#tx(() => {
          const now = this.#now();
          const row = db.prepare("SELECT instance, prev_instance, last_seen, duplicate_at FROM machines WHERE id = ?").get(actor.name) as
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
            `INSERT INTO machines(id, machine, instance, prev_instance, version, runs, last_seen, duplicate_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET machine = excluded.machine, instance = excluded.instance,
               prev_instance = excluded.prev_instance, version = excluded.version, runs = excluded.runs,
               last_seen = excluded.last_seen, duplicate_at = excluded.duplicate_at`,
          ).run(actor.name, machine, instance, prev, version, JSON.stringify(runs), now, duplicateAt);
          if (setup) db.prepare("UPDATE machines SET setup = ?, setup_at = ? WHERE id = ?").run(JSON.stringify(setup.report), setup.checkedAt, actor.name);
          if (profiles) db.prepare("UPDATE machines SET profiles = ? WHERE id = ?").run(JSON.stringify(profiles), actor.name);
          // An archived or deleted project is not stored as a repo this machine has (roadmap 47): a machine that still
          // has the folder must not put the name back into the lists, nor bring a deleted one back from its headstone.
          const hidden = new Set(this.#projectStates().keys());
          const archivedProjects = (projects ?? []).filter((p) => hidden.has(p));
          if (projects) db.prepare("UPDATE machines SET projects = ? WHERE id = ?").run(JSON.stringify(projects.filter((p) => !hidden.has(p))), actor.name);
          if (acceptsRuns !== undefined) db.prepare("UPDATE machines SET accepts_runs = ? WHERE id = ?").run(acceptsRuns ? 1 : 0, actor.name);
          db.prepare("UPDATE machines SET owner = ? WHERE id = ?").run(actor.account ?? null, actor.name);
          db.prepare("DELETE FROM machine_profile_changes WHERE requested_at < ?").run(this.#now(-PROFILE_CHANGE_HOURS * 60));
          if (profiles) {
            const drop = db.prepare("DELETE FROM machine_profile_changes WHERE machine_id = ? AND profile_id = ?");
            for (const c of this.#profileChanges(actor.name)) {
              const p = profiles.find((x) => x.id === c.profileId);
              // Gone from the machine, or reported as asked: nothing is left to send.
              if (!p || ((c.enabled === null || p.enabled === c.enabled) && (c.priority === null || p.priority === c.priority))) drop.run(actor.name, c.profileId);
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
          db.prepare("DELETE FROM machines WHERE last_seen < ?").run(this.#now(-MACHINE_TTL_DAYS * 24 * 60));
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
          if (!accepts) {
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
          this.#release();
          this.#releaseFlows();
          // Held back rather than rejected for an archived project: restoring it lets the work go on, and anything
          // still waiting when the fifteen minutes are up expires on its own.
          const runRequests = accepts
            ? (db.prepare("SELECT * FROM run_requests WHERE machine_id = ? AND status = 'pending' ORDER BY id").all(actor.name) as Row[])
                .map(toRunRequest)
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
          const cancelRuns = accepts
            ? (
                db
                  .prepare("SELECT run_id, cancel_by FROM run_records WHERE machine_id = ? AND cancel_by IS NOT NULL AND status IN ('queued', 'running') ORDER BY cancel_at")
                  .all(actor.name) as Row[]
              ).map((r) => ({ runId: str(r.run_id), requestedBy: str(r.cancel_by) }))
            : [];
          return {
            duplicate: duplicateAt !== null && duplicateAt > this.#now(-DUPLICATE_MINUTES),
            cooldowns: this.#cooldowns(),
            policy: this.#policy(),
            agentPolicy: this.#machineAgentPolicy(actor),
            tools: this.#machineTools(actor),
            commands,
            syncCommands,
            runRequests,
            chatRequests,
            cancelRuns,
            paused: this.#pausedFor(this.#paused(), actor),
            // After this beat's costs went in, so a run that just filled a cap holds the next one at once.
            budgetBlocked: this.#budgetBlocks(actor),
            profileChanges: this.#profileChanges(actor.name),
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
            if (["succeeded", "failed", "cancelled"].includes(r.status) && (before === undefined || ["queued", "running"].includes(str(before)))) ended.push(r);
            // The machine already hid secret-looking lines; this is the hub's own check of what it keeps.
            put.run(
              actor.name, r.runId, machine, r.project, r.taskId, stripHidden(r.taskTitle), r.role, r.status, r.profileId,
              clean(r.activity), clean(r.summary), clean(r.error), r.branch, r.commits, r.mrUrl, r.costUsd, clean(r.log) ?? "",
              r.createdAt, r.startedAt, r.finishedAt, now,
            );
            if (r.patch !== undefined) patchPut.run(redactLines(stripHidden(r.patch)), actor.name, r.runId);
            if (r.mr !== undefined) {
              const mr = r.mr && { ...r.mr, pipelineUrl: r.mr.pipelineUrl && /^https?:\/\//.test(r.mr.pipelineUrl) ? r.mr.pipelineUrl : null };
              mrPut.run(mr ? JSON.stringify(mr) : null, actor.name, r.runId);
            }
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
              ["parent_run", r.parentRun],
              ["verdict", verdict],
            ];
            const sent = ranOn.filter(([, v]) => v !== undefined);
            if (sent.length) {
              const sql = `UPDATE run_records SET ${sent.map(([c]) => `${c} = ?`).join(", ")} WHERE machine_id = ? AND run_id = ?`;
              const stmt = ranOnPut.get(sql) ?? ranOnPut.set(sql, db.prepare(sql)).get(sql)!;
              stmt.run(...sent.map(([, v]) => v as string | number | null), actor.name, r.runId);
            }
            // Whose run it is, set once: whoever asked for it from the web, else the person whose token the machine has
            // (a run started from its Board). A machine takes a request (runs.requestResult) before it pushes the run.
            ownerPut.run(actor.name, r.runId, principalOf(actor));
          }
          // The heavy part of an old run goes, the record stays (roadmap 41b): what the agent concluded, its MR and what
          // it cost outlive the log. log_pruned_at IS NULL: a run cleaned once is not touched again.
          if (this.#opts.runLogDays > 0) {
            db.prepare("UPDATE run_records SET log = '', patch = NULL, log_pruned_at = ? WHERE updated_at < ? AND log_pruned_at IS NULL").run(
              now,
              this.#now(-this.#opts.runLogDays * 24 * 60),
            );
          }
          // Flows (roadmap 34b) move on the step or check that just ended, then queue what comes next.
          for (const r of ended) {
            const run = { ...r, summary: clean(r.summary) ?? null, error: clean(r.error) ?? null };
            this.#flowRunEnded(actor.name, run);
            this.#taskRunEnded(actor.name, run);
            // A run that failed stops its agent at that task (roadmap 50) before the release below looks at the queue.
            this.#agentRunEnded(run);
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

      "runs.list": ({ project, projects, limit }) =>
        (
          db
            .prepare(
              `SELECT r.*, ${RUN_TOKEN_COLUMNS} FROM run_records r LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id
               WHERE (?1 IS NULL OR r.project = ?1) AND (?3 IS NULL OR r.project IN (SELECT value FROM json_each(?3))) ORDER BY r.created_at DESC, r.run_id DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, listParam(projects)) as Row[]
        ).map((r) => toRunRecord(r, false)),

      "runs.get": ({ machineId, runId }, actor) => {
        const row = db
          .prepare(`SELECT r.*, ${RUN_TOKEN_COLUMNS} FROM run_records r LEFT JOIN run_costs c ON c.machine_id = r.machine_id AND c.run_id = r.run_id WHERE r.machine_id = ? AND r.run_id = ?`)
          .get(machineId, runId) as Row | undefined;
        // A run of a project the caller does not see answers like a missing one.
        return row && sees(actor, str(row.project)) ? toRunRecord(row, true) : null;
      },

      // Only a machine that takes runs from the hub obeys it: its user let project managers drive it from the web.
      "runs.cancel": ({ machineId, runId }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No run ${runId}.`, { key: "errors.runNotFound", vars: { id: runId } });
          const status = str(row.status);
          if (status !== "queued" && status !== "running") {
            throw new HiveError("conflict", `Run ${runId} has ended (${status}).`, { key: "errors.runEnded", vars: { id: runId } });
          }
          const machine = db.prepare("SELECT accepts_runs FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!machine || num(machine.accepts_runs) !== 1) {
            throw new HiveError("bad_request", `${str(row.machine)} does not take runs from the hub.`, { key: "errors.machineNoHubRuns", vars: { machine: str(row.machine) } });
          }
          // Asked once: a second click keeps who asked first.
          db.prepare("UPDATE run_records SET cancel_by = ?, cancel_at = ? WHERE machine_id = ? AND run_id = ? AND cancel_by IS NULL").run(actor.name, this.#now(), machineId, runId);
          return toRunRecord(db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(machineId, runId) as Row, false);
        }),

      // The run's machine merges with its own token (asked 2/10): the hub keeps no GitLab or GitHub secret.
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
            ok ? null : JSON.stringify(error ?? { message: "merge failed" }),
            now,
            ok ? 1 : 0,
            JSON.stringify(merged),
            actor.name,
            runId,
          );
          return toRunRecord(db.prepare("SELECT * FROM run_records WHERE machine_id = ? AND run_id = ?").get(actor.name, runId) as Row, false);
        }),

      "runs.dispatch": ({ machineId, project, taskId, role, profileId, preferKind, reviewAfter, candidates, instructions }, actor) =>
        this.#tx(() => {
          const task = this.#getTask(taskId);
          if (!task || task.project !== project) {
            throw new HiveError("not_found", `No task ${taskId} in ${project}.`, { key: "errors.taskNotInProject", vars: { id: taskId, project } });
          }
          // Its flow queues its steps itself, and would take this run for one of them.
          const flow = this.#flowRow(taskId);
          if (flow && ["running", "check", "checking", "next"].includes(str(flow.state))) {
            throw new HiveError("conflict", `Task ${taskId} is in a flow that is going on.`, { key: "errors.taskInFlow", vars: { id: taskId } });
          }
          const m = this.#assertDispatchable({ machineId, project, task, role, profileId, candidates, instructions }, actor);
          // Its group would run it again once this run ended.
          this.#assertNotInGroup(taskId);
          return this.#insertRequest(m, project, task, { role, profileId, preferKind, reviewAfter, candidates, instructions }, actor);
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
          // Where each one runs, in its title: "any" machine or profile is the hub's or the machine's pick.
          targets.forEach((t, i) => {
            const where = `${t.machineId ? names.get(t.machineId) : "*"}/${t.profileId ?? "*"}`;
            put.run(children[i]!, project, `${heading.slice(0, 100)} · ${where}`.slice(0, 300), note, now);
          });
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

      "runs.pickWinner": ({ groupId, taskId }) =>
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
          for (const i of g.items) {
            if (i.taskId !== taskId) close.run(`Không chọn trong ${g.parentTask} (chọn ${taskId}).`, now, i.taskId);
          }
          close.run(`Chọn ${taskId}.`, now, g.parentTask);
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
          else put.run(parent, project, heading, job.slice(0, 2000), now);
          // Each part's note says what it is part of; the job itself reaches its run as instructions.
          parts.forEach((part, i) => put.run(children[i]!, project, part.split(/\r?\n/, 1)[0]!.slice(0, 300), `Phần ${i + 1}/${parts.length} của ${parent}: ${heading}\n\n${part}`.slice(0, 2000), now));
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

      "runs.resumeGroup": ({ id }, actor) =>
        this.#tx(() => {
          const g = this.#group(id);
          if (g.kind !== "mapreduce") throw new HiveError("bad_request", `Run group #${id} is not a job in parts.`, { key: "errors.notMapReduce", vars: { id } });
          if (g.phase !== "stopped") throw new HiveError("conflict", `Run group #${id} has not stopped.`, { key: "errors.mapNotStopped", vars: { id } });
          this.#assertNotPaused(g.project);
          const now = this.#now();
          if (!g.items.length) {
            // The split stopped: ask its machine again.
            const task = this.#getTask(g.parentTask!);
            if (!task) throw new HiveError("not_found", `Task ${g.parentTask} not found.`, { key: "errors.taskNotFound", vars: { id: g.parentTask! } });
            const instructions = [splitInstructions(), g.instructions.length > 2000 ? `The job, in full:\n${g.instructions}` : ""].filter(Boolean).join("\n\n");
            const m = this.#assertDispatchable({ machineId: g.machineId!, project: g.project, task, role: "plan", profileId: null, candidates: 1, instructions }, actor);
            const req = this.#insertRequest(m, g.project, task, { role: "plan", profileId: null, reviewAfter: false, candidates: 1, instructions }, actor);
            db.prepare("UPDATE run_groups SET phase = 'split', phase_request = ?, phase_error = NULL, closed_at = NULL WHERE id = ?").run(req.id, id);
            return this.#group(id);
          }
          // The parts that did not finish run again; with all of them in, the merge does.
          const again = db.prepare("UPDATE run_group_items SET status = 'held', request_id = NULL, error = NULL, updated_at = ? WHERE id = ?");
          for (const i of g.items) if (i.run?.status !== "succeeded") again.run(now, i.id);
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

      "runs.cancelGroup": ({ id }) =>
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
          db.prepare(
            "UPDATE run_groups SET closed_at = ?, phase = CASE WHEN phase IS NULL OR phase = 'done' THEN phase ELSE 'stopped' END, phase_error = CASE WHEN phase IS NULL OR phase = 'done' THEN phase_error ELSE ? END WHERE id = ?",
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
          db.prepare("INSERT INTO tasks(id, project, title, note, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, project, heading, prompt.slice(0, 2000), this.#now());
          const task = this.#getTask(id)!;
          // The runner hands the agent the task's note as well as the instructions: the prompt goes once, as the note,
          // and in full as the instructions only when the note had to cut it.
          const instructions = prompt.length > 2000 ? prompt : "";
          const request = this.#insertRequest(m, project, task, { role: "implement", profileId, preferKind, reviewAfter, candidates: 1, instructions }, actor);
          return { task, request };
        }),

      "runs.requests": ({ project, projects, limit }) => {
        this.#expireRequests();
        return (
          db
            .prepare(`SELECT * FROM run_requests WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) ORDER BY id DESC LIMIT ?2`)
            .all(project ?? null, limit, listParam(projects)) as Row[]
        ).map(toRunRequest);
      },

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
          const why = error ? { ...error, message: clean(error.message)! } : null;
          db.prepare("UPDATE run_requests SET status = ?, run_id = ?, error = ?, updated_at = ? WHERE id = ?").run(
            status,
            status === "accepted" ? runId : null,
            why ? JSON.stringify(why) : null,
            this.#now(),
            id,
          );
          // A refusal frees its group's place at once, and stops a flow's step.
          this.#release();
          this.#releaseFlows();
          return this.#runRequest(id);
        }),

      // The machine is checked the way runs.dispatch checks it, and must have a Claude profile that can write the reply.
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
          if (!m.projects.includes(project)) {
            throw new HiveError("bad_request", `${m.machine} has no repo for ${project}.`, { key: "errors.machineNoRepo", vars: { ...name, project } });
          }
          const pinned = thread ? strOrNull(thread.profile_id) : profileId === undefined ? (defaults?.profileId ?? null) : profileId;
          const claude = m.profiles.filter((p) => p.kind === "claude" && p.enabled && p.loggedIn !== false && (!pinned || p.id === pinned));
          if (!claude.length) {
            throw new HiveError("bad_request", `${m.machine} has no enabled, signed-in Claude profile${pinned ? ` ${pinned}` : ""}.`, {
              key: "errors.chatNoClaude",
              vars: { ...name, id: pinned ?? "claude" },
            });
          }
          // The agent reads it as its prompt.
          assertNoHidden(text, "Message");
          assertNoSecret(text, "Message");
          if (title) assertNoHidden(title, "Title");
          const now = this.#now();
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
                    pinned,
                    model === undefined ? (defaults?.model ?? null) : model,
                    effort === undefined ? (defaults?.effort ?? null) : effort,
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
          const reply = num(put.run(id, "assistant", `${pinned ?? "claude"}@${m.machine}`, "", "pending", JSON.stringify(sender), now, now).lastInsertRowid);
          db.prepare("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(now, id);
          return { thread: this.#chatThread(id), message: this.#chatMessage(message), reply: this.#chatMessage(reply) };
        }),

      "chat.pending": ({ project, projects, limit }) =>
        (
          db
            .prepare(
              `SELECT * FROM chat_actions WHERE status = 'proposed' AND (?1 IS NULL OR project = ?1)
                 AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3)))
               ORDER BY id DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, listParam(projects)) as Row[]
        ).map(toChatAction),
      "chat.threads": ({ project, projects, query, limit }) => {
        this.#expireChats();
        const words = query?.trim();
        // Found in the title or in any message; % and _ are the person's own characters, not wildcards.
        const like = words ? `%${words.normalize("NFC").toLocaleLowerCase("vi").replace(/[\\%_]/g, "\\$&")}%` : null;
        return (
          db
            .prepare(
              `${THREAD_SELECT} WHERE (?1 IS NULL OR t.project = ?1) AND (?4 IS NULL OR t.project IN (SELECT value FROM json_each(?4)))
                 AND (?3 IS NULL OR hive_fold(t.title) LIKE ?3 ESCAPE '\\'
                   OR EXISTS (SELECT 1 FROM chat_messages q WHERE q.thread_id = t.id AND hive_fold(q.text) LIKE ?3 ESCAPE '\\'))
               ORDER BY t.updated_at DESC, t.id DESC LIMIT ?2`,
            )
            .all(project ?? null, limit, like, listParam(projects)) as Row[]
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

      "chat.decide": async ({ actionId, accept }, actor) => this.#decideChat(actionId, accept, actor, false),


      // Confirmed, the action is the manager's own call, checked and recorded like any other; set aside, nothing runs.

      // In CHAT_DECIDE_ORDER, each kind in the order proposed: a run may be for a task the reply also creates. The first
      // that fails stops the rest, which wait for a person to look.
      "chat.decideAll": async ({ replyId, accept }, actor) => {
        if (!db.prepare("SELECT 1 FROM chat_messages WHERE id = ? AND role = 'assistant'").get(replyId)) {
          throw new HiveError("not_found", `Chat reply #${replyId} not found.`, { key: "errors.chatReplyNotFound", vars: { id: replyId } });
        }
        const all = () => (db.prepare("SELECT * FROM chat_actions WHERE reply_id = ? ORDER BY id").all(replyId) as Row[]).map(toChatAction);
        const waiting = all()
          .filter((a) => a.status === "proposed")
          .sort((a, b) => CHAT_DECIDE_ORDER[a.kind] - CHAT_DECIDE_ORDER[b.kind] || a.id - b.id);
        for (const a of waiting) {
          try {
            const done = await this.#handlers["chat.decide"]({ actionId: a.id, accept }, actor);
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
      "chat.finish": ({ replyId, status, text, steps, sessionId, costUsd, error }, actor) =>
        this.#tx(() => {
          const row = this.#replyFor(replyId, actor);
          const was = str(row.status);
          if (was !== "pending" && was !== "running" && was !== "cancelled") {
            throw new HiveError("conflict", `Chat reply #${replyId} has ended.`, { key: "errors.chatReplyEnded", vars: { id: replyId } });
          }
          const now = this.#now();
          const why = error ? { ...error, message: clean(error.message)! } : null;
          db.prepare(
            "UPDATE chat_messages SET status = ?, text = ?, steps = ?, activity = NULL, error = ?, cost_usd = ?, updated_at = ?, finished_at = ? WHERE id = ?",
          ).run(was === "cancelled" ? "cancelled" : status, clean(text)!, clean(steps)!, why ? JSON.stringify(why) : null, costUsd, now, now, replyId);
          const thread = num(row.thread_id);
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

      "machines.remove": ({ id }) => ({ removed: num(db.prepare("DELETE FROM machines WHERE id = ?").run(id).changes) === 1 }),

      // A subscription is a person's own account: only its machine's owner and hub admins change it (asked 2/10).
      "machines.setProfile": ({ machineId, profileId, enabled, priority }, actor) =>
        this.#tx(() => {
          const row = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId) as Row | undefined;
          if (!row) throw new HiveError("not_found", `No machine ${machineId}.`, { key: "errors.machineNotFound", vars: { machine: machineId } });
          const m = this.#toMachine(row);
          const hubAdmin = actor.role === "admin" && !actor.access;
          // Not an agent on the owner's token: a run should not turn subscriptions on for itself.
          const owner = !isAgentActor(actor) && actor.account !== undefined && actor.account === m.owner;
          if (!hubAdmin && !owner) {
            throw new HiveError("forbidden", `Only a hub admin or the owner of ${m.machine} changes its profiles.`, { key: "errors.machineProfileForbidden", vars: { machine: m.machine } });
          }
          const p = m.profiles.find((x) => x.id === profileId);
          if (!p) throw new HiveError("not_found", `${m.machine} has no profile ${profileId}.`, { key: "errors.machineProfileNotFound", vars: { machine: m.machine, profile: profileId } });
          // An app that does not report priorities does not take changes either: one would wait a day for nothing.
          if (p.priority === undefined) throw new HiveError("bad_request", `${m.machine} runs an app too old for profile changes.`, { key: "errors.machineAppTooOld", vars: { machine: m.machine } });
          const old = m.profileChanges.find((c) => c.profileId === profileId);
          let on = enabled ?? old?.enabled ?? null;
          let rank = priority ?? old?.priority ?? null;
          // What the machine already has needs no change: switching back cancels the waiting one.
          if (on === p.enabled) on = null;
          if (rank === p.priority) rank = null;
          if (on === null && rank === null) db.prepare("DELETE FROM machine_profile_changes WHERE machine_id = ? AND profile_id = ?").run(machineId, profileId);
          else {
            db.prepare(
              `INSERT INTO machine_profile_changes(machine_id, profile_id, enabled, priority, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(machine_id, profile_id) DO UPDATE SET enabled = excluded.enabled, priority = excluded.priority,
                 requested_by = excluded.requested_by, requested_at = excluded.requested_at`,
            ).run(machineId, profileId, on === null ? null : on ? 1 : 0, rank, actor.account ?? actor.name, this.#now());
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
            output ?? null,
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
        if (!settings) delete projects[project];
        else {
          for (const g of SDLC_GATES) {
            const m = settings.gates[g];
            if (m && GATE_MODES.indexOf(m) > GATE_MODES.indexOf(ceiling[g])) {
              throw new HiveError("forbidden", `The hub lets gate ${g} go up to ${ceiling[g]}, not ${m}.`, { key: "errors.gateOverCeiling", vars: { gate: g, mode: m, ceiling: ceiling[g] } });
            }
          }
          // "human" is a gate's default: kept out, so a later ceiling change reads only the gates the project opened.
          const gates = Object.fromEntries(Object.entries(settings.gates).filter(([, m]) => m !== "human")) as Partial<GateModes>;
          projects[project] = {
            gates,
            ...(settings.maxFixRounds !== undefined ? { maxFixRounds: settings.maxFixRounds } : {}),
            ...(settings.maxParallel ? { maxParallel: settings.maxParallel } : {}),
          };
        }
        this.#saveSdlc({ ...current, projects }, actor);
        return this.#sdlcView();
      },

      "sdlc.gates": ({ project, projects, taskId, status, limit }) =>
        (
          db
            .prepare(
              `SELECT * FROM sdlc_gates WHERE (?1 IS NULL OR project = ?1) AND (?2 IS NULL OR status = ?2)
                 AND (?4 IS NULL OR project IN (SELECT value FROM json_each(?4))) AND (?5 IS NULL OR task_id = ?5)
               ORDER BY CASE status WHEN 'waiting' THEN 0 WHEN 'escalated' THEN 0 ELSE 1 END, id DESC LIMIT ?3`,
            )
            .all(project ?? null, status ?? null, limit, listParam(projects), taskId ?? null) as Row[]
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

      "sdlc.flows": ({ project, projects, limit }) => {
        this.#tx(() => this.#releaseFlows());
        return (
          db
            .prepare(`SELECT task_id FROM sdlc_flows WHERE (?1 IS NULL OR project = ?1) AND (?3 IS NULL OR project IN (SELECT value FROM json_each(?3))) ORDER BY updated_at DESC LIMIT ?2`)
            .all(project ?? null, limit, listParam(projects)) as Row[]
        ).map((r) => this.#flow(str(r.task_id))!);
      },

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
        const docs = num((db.prepare("SELECT COUNT(*) AS n FROM docs WHERE project = ?").get(owner) as Row).n);
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
