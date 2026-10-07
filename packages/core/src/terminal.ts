// Remote terminal contract (spec 69, task 69a): limits, schemas, session state machine, machine capability and who
// may do what. Browser-safe. Nothing here opens a PTY, a socket or a recording; the feature stays off until the hub
// sets HIVE_REMOTE_TERMINAL=1 (after 69g), and each machine still has to opt in locally.
import { z } from "zod";
import { may, sees } from "./access.ts";
import { HiveError } from "./errors.ts";
import { PROJECT_NAME } from "./keys.ts";
import { isAgentActor } from "./source.ts";
import type { Actor } from "./types.ts";

export const TERMINAL_PROTOCOL = 1;
/** WebSocket subprotocol of the browser socket. */
export const TERMINAL_WS_PROTOCOL = "hive-terminal.v1";
/** The hub's kill switch. Anything but "1" keeps create, attach and socket upgrades closed. */
export const TERMINAL_HUB_FLAG = "HIVE_REMOTE_TERMINAL";

export function terminalHubEnabled(env: Record<string, string | undefined>): boolean {
  return env[TERMINAL_HUB_FLAG] === "1";
}

const KIB = 1024;
const MIB = 1024 * KIB;
const MIN = 60_000;

/** Spec §6–§8. Hub settings may lower these, never raise them past the max* values. */
export const TERMINAL_LIMITS = {
  inputFrameBytes: 16 * KIB,
  outputFrameBytes: 32 * KIB,
  cols: { min: 20, max: 400 },
  rows: { min: 5, max: 200 },
  inputBytesPerSecond: 64 * KIB,
  outputBytesPerSecond: 1 * MIB,
  outputBurstBytes: 4 * MIB,
  unackedHighWaterBytes: 1 * MIB,
  unackedMaxBytes: 4 * MIB,
  slowConsumerMs: 10_000,
  replayBytes: 4 * MIB,
  replayMs: 5 * MIN,
  /** Only input resets it: output and pings do not keep a forgotten shell alive. */
  idleInputMs: 15 * MIN,
  absoluteTtlMs: 2 * 60 * MIN,
  maxTtlMs: 8 * 60 * MIN,
  warnBeforeMs: MIN,
  unattachedMs: MIN,
  detachedMs: 5 * MIN,
  leaseMs: 30_000,
  leaseRenewMs: 10_000,
  revokeKillMs: 2_000,
  killGraceMs: 5_000,
  stepUpTtlMs: 5 * MIN,
  ticketTtlMs: 30_000,
  firstFrameMs: 5_000,
  heartbeatMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  reasonChars: 500,
  auditQuotaBytes: 100 * MIB,
  retentionDays: 30,
  maxSessionsPerMachine: 1,
} as const;

// ── session state machine ────────────────────────────────────────────────────

export const TERMINAL_STATES = ["requested", "starting", "active", "detached", "closing", "closed", "expired", "revoked", "failed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
export const TERMINAL_FINAL_STATES: readonly TerminalState[] = ["closed", "expired", "revoked", "failed"];
/** A session in one of these may still hold a process (or is about to): it counts against maxSessions and locks. */
export const TERMINAL_LIVE_STATES: readonly TerminalState[] = ["requested", "starting", "active", "detached", "closing"];

export const TERMINAL_EXPIRE_REASONS = ["idleTimeout", "absoluteTimeout", "unattachedTimeout", "detachedTimeout", "leaseLost"] as const;
export const TERMINAL_REVOKE_REASONS = [
  "accessRevoked", "accountDisabled", "logout", "parentRevoked", "projectArchived", "localOptOut", "emergencyStop", "hubDisabled",
] as const;
export const TERMINAL_FAIL_REASONS = ["spawnFailed", "auditFailed", "supervisorRestart", "orphaned", "protocolError"] as const;
export const TERMINAL_REASONS = [
  "spawning", "spawned", "attached", "detached", "reattached", "userClosed", "exited",
  ...TERMINAL_EXPIRE_REASONS, ...TERMINAL_REVOKE_REASONS, ...TERMINAL_FAIL_REASONS,
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

const DOWN = ["expired", "revoked", "failed"] as const;
/**
 * requested → starting → active ↔ detached → closing → closed, and from any live state to expired | revoked | failed.
 * A session that never spawned closes without "closing": there is nothing to kill. No way back from a final state:
 * a supervisor restart marks the session failed, it never spawns the PTY again or replays input.
 */
const TRANSITIONS: Record<TerminalState, readonly TerminalState[]> = {
  requested: ["starting", "closed", ...DOWN],
  starting: ["active", "closing", ...DOWN],
  active: ["detached", "closing", ...DOWN],
  detached: ["active", "closing", ...DOWN],
  closing: ["closed", ...DOWN],
  closed: [],
  expired: [],
  revoked: [],
  failed: [],
};

/** The reasons that may lead into each state, so a revocation is never recorded as a normal close and back. */
const REASONS_INTO: Record<TerminalState, readonly TerminalReason[]> = {
  requested: [],
  starting: ["spawning"],
  active: ["spawned", "attached", "reattached"],
  detached: ["detached"],
  closing: ["userClosed", "exited"],
  closed: ["userClosed", "exited"],
  expired: TERMINAL_EXPIRE_REASONS,
  revoked: TERMINAL_REVOKE_REASONS,
  failed: TERMINAL_FAIL_REASONS,
};

export function canTransition(from: TerminalState, to: TerminalState, reason: TerminalReason): boolean {
  return TRANSITIONS[from].includes(to) && REASONS_INTO[to].includes(reason);
}

export function assertTransition(from: TerminalState, to: TerminalState, reason: TerminalReason): void {
  if (!canTransition(from, to, reason))
    throw new HiveError("conflict", `Terminal session cannot go from ${from} to ${to} (${reason}).`, { key: "errors.terminal.transition", vars: { from, to } });
}

export const isTerminalFinal = (s: TerminalState): boolean => TERMINAL_FINAL_STATES.includes(s);

// ── machine capability (heartbeat) ───────────────────────────────────────────

export const TERMINAL_PLATFORMS = ["darwin", "linux", "win32"] as const;
/** Windows/ConPTY comes later: a win32 machine reports itself and gets "unsupportedPlatform". */
const SUPPORTED_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);

/** What a machine says about its local opt-in. Additive in the heartbeat: an old app leaves it out. */
export const terminalCapabilitySchema = z.object({
  protocol: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  projects: z.array(z.string().regex(PROJECT_NAME)).max(200),
  platforms: z.array(z.enum(TERMINAL_PLATFORMS)).max(TERMINAL_PLATFORMS.length),
  auditReady: z.boolean(),
  guiReady: z.boolean(),
});
export type TerminalCapability = z.output<typeof terminalCapabilitySchema>;

export const TERMINAL_UNAVAILABLE = ["needsUpgrade", "disabledLocally", "projectNotAllowed", "unsupportedPlatform", "auditNotReady"] as const;
export type TerminalUnavailable = (typeof TERMINAL_UNAVAILABLE)[number];

/** Why this machine cannot open a terminal on this project, or null when its side allows it. */
export function terminalUnavailable(raw: unknown, project: string): TerminalUnavailable | null {
  const parsed = terminalCapabilitySchema.safeParse(raw);
  // A machine that does not speak this protocol is told to upgrade, never treated as opted in.
  if (!parsed.success || parsed.data.protocol !== TERMINAL_PROTOCOL) return "needsUpgrade";
  const c = parsed.data;
  if (!c.platforms.some((p) => SUPPORTED_PLATFORMS.has(p))) return "unsupportedPlatform";
  if (!c.enabled) return "disabledLocally";
  if (!c.projects.includes(project)) return "projectNotAllowed";
  if (!c.auditReady) return "auditNotReady";
  return null;
}

// ── RPC inputs (spec §7) ─────────────────────────────────────────────────────

const project = z.string().regex(PROJECT_NAME);
const machineId = z.string().min(1).max(200);
export const terminalSessionId = z.uuid();
/** A one-time proof id from /api/terminal/step-up (69c); the proof itself never travels in RPC bodies. */
const stepUpId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
/**
 * The project's repo, or one of its worktrees by the name the machine reported. Never a path or shell text: the
 * machine resolves the realpath itself and refuses anything outside the project.
 */
export const terminalCheckoutRef = z.union([z.literal("repo"), z.string().regex(/^worktree:[A-Za-z0-9._-]{1,100}$/)]);
const reason = z.string().trim().max(TERMINAL_LIMITS.reasonChars);

// Strict objects: an unknown key (command, env, cwd…) is refused, not silently dropped.
export const terminalInputs = {
  capabilities: z.strictObject({ project, machineId }),
  create: z.strictObject({
    project, machineId, checkoutRef: terminalCheckoutRef, mode: z.literal("shell"), stepUpId, reason, idempotencyKey: z.uuid(),
  }),
  list: z.strictObject({ project }),
  get: z.strictObject({ project, sessionId: terminalSessionId }),
  attach: z.strictObject({ sessionId: terminalSessionId, stepUpId, lastOutputSeq: z.number().int().min(0), takeControl: z.boolean().default(false) }),
  terminate: z.strictObject({ sessionId: terminalSessionId, reason: z.enum(["userClosed", "emergencyStop"]) }),
  recording: z.strictObject({ sessionId: terminalSessionId, stepUpId, cursor: z.number().int().min(0).default(0) }),
  machineReport: z.strictObject({
    sessionId: terminalSessionId,
    epoch: z.number().int().min(0),
    state: z.enum(TERMINAL_STATES),
    reason: z.enum(TERMINAL_REASONS),
    exitCode: z.number().int().nullable().default(null),
    auditSeq: z.number().int().min(0),
    cleanupUncertain: z.boolean().default(false),
  }),
} as const;

// ── WebSocket frames (spec §7) ───────────────────────────────────────────────

/** Bytes a standard base64 string decodes to, or -1 when it is not base64. No Buffer: this runs in the browser too. */
export function base64Bytes(s: string): number {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return -1;
  return (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
}

const data = (max: number) =>
  z.string().refine((s) => {
    const n = base64Bytes(s);
    return n >= 0 && n <= max;
  }, `data must be base64 of at most ${max} bytes`);
const seq = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const terminalClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("input"), epoch: seq, inputSeq: seq, data: data(TERMINAL_LIMITS.inputFrameBytes) }),
  z.strictObject({
    type: z.literal("resize"), epoch: seq,
    cols: z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max),
    rows: z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max),
  }),
  z.strictObject({ type: z.literal("ack"), outputSeq: seq }),
  z.strictObject({ type: z.literal("ping"), nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);
export type TerminalClientFrame = z.output<typeof terminalClientFrameSchema>;

export const terminalServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("output"), epoch: seq, outputSeq: seq, data: data(TERMINAL_LIMITS.outputFrameBytes) }),
  z.strictObject({ type: z.literal("inputAck"), inputSeq: seq }),
  z.strictObject({ type: z.literal("state"), state: z.enum(TERMINAL_STATES), reason: z.enum(TERMINAL_REASONS).optional() }),
  z.strictObject({ type: z.literal("gap"), firstAvailableSeq: seq }),
  z.strictObject({ type: z.literal("pong"), nonce: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }),
]);
export type TerminalServerFrame = z.output<typeof terminalServerFrameSchema>;

// ── session metadata (no terminal I/O ever) ──────────────────────────────────

export interface TerminalSession {
  id: string;
  project: string;
  machineId: string;
  /** The account that opened it: the only one who may attach. */
  creator: string;
  checkoutRef: string;
  mode: "shell";
  reason: string;
  state: TerminalState;
  lastReason: TerminalReason | null;
  /** Compare-and-set counter of every transition. */
  version: number;
  /** Bumped by "Chuyển điều khiển": input with an older epoch is refused. */
  writerEpoch: number;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
  exitCode: number | null;
  cleanupUncertain: boolean;
}

// ── who may do what (spec §6, §7) ────────────────────────────────────────────

export const TERMINAL_OPS = ["capabilities", "create", "list", "get", "attach", "terminate", "recording", "machineReport"] as const;
export type TerminalOp = (typeof TERMINAL_OPS)[number];

export const TERMINAL_DENIALS = [
  "hubDisabled", "notHuman", "notMachine", "notFound", "noProjectAccess", "notOwnerOrAdmin", "notCreator",
  "stepUpRequired", "sessionClosed", "wrongProject", ...TERMINAL_UNAVAILABLE,
] as const;
export type TerminalDenial = (typeof TERMINAL_DENIALS)[number];

/**
 * Everything the decision needs, looked up server-side: the machine's owner is the account of its token (machines.owner,
 * set by the hub at heartbeat), never a label or owner the client sent. `stepUp` is true only after the hub consumed a
 * fresh one-time proof bound to this user, browser session, machine, project and operation (69c).
 */
export interface TerminalCheck {
  op: TerminalOp;
  actor: Actor;
  hubEnabled: boolean;
  project: string;
  machine: { id: string; owner: string | null; capability: unknown } | null;
  session?: Pick<TerminalSession, "creator" | "machineId" | "project" | "state">;
  stepUp?: boolean;
}

export type TerminalDecision = { ok: true } | { ok: false; denial: TerminalDenial };

/**
 * A person signed in to the hub page. Only the hub's cookie middleware sets humanSession; any bearer (admin token,
 * machine, run, MCP, chat leader) or a header saying "desktop" is not one.
 */
export function isTerminalHuman(actor: Actor): boolean {
  return !!actor.humanSession && !!actor.account && actor.role !== "agent" && actor.role !== "viewer" &&
    !actor.runCredential && !actor.mcpCredential && actor.chatReply === undefined && !isAgentActor(actor);
}

const isHubAdmin = (a: Actor): boolean => a.role === "admin" && !a.access;

const deny = (denial: TerminalDenial): TerminalDecision => ({ ok: false, denial });

/**
 * canOpen = humanCookie && activeAccount && (hubAdmin || machineOwner) && projectAccess && machineOptIn &&
 * localProjectAllowed && freshStepUp, and the per-operation rules of §7. Checks run in an order that never tells a
 * caller more than it may know: an invisible project answers notFound before anything about the machine.
 */
export function terminalDecision(c: TerminalCheck): TerminalDecision {
  const { op, actor } = c;
  if (op === "machineReport") {
    // Only the machine the session runs on reports it; a person or agent knowing the id does not.
    if (actor.humanSession || actor.runCredential || actor.mcpCredential || actor.chatReply !== undefined) return deny("notMachine");
    if (!c.session || !c.machine) return deny("notFound");
    if (actor.name !== c.machine.id || c.session.machineId !== c.machine.id) return deny("notMachine");
    return { ok: true };
  }
  if (!isTerminalHuman(actor)) return deny("notHuman");
  // Only what starts or drives a shell stops with the feature off: the kill switch must not strand a running shell
  // where nobody can find or stop it, and audit outlives a rollback.
  if (!c.hubEnabled && (op === "capabilities" || op === "create" || op === "attach")) return deny("hubDisabled");
  if (!sees(actor, c.project)) return deny("notFound");
  if (c.session && c.session.project !== c.project) return deny("wrongProject");
  if (!c.machine || (c.session && c.session.machineId !== c.machine.id)) return deny("notFound");
  const admin = isHubAdmin(actor);
  const owner = c.machine.owner !== null && c.machine.owner === actor.account;
  const creator = !!c.session && c.session.creator === actor.account;
  const live = !!c.session && !isTerminalFinal(c.session.state);

  switch (op) {
    case "capabilities":
      return admin || owner ? { ok: true } : deny("notOwnerOrAdmin");
    case "list":
      // Admins and machine owners see every session of the machine; anyone else only the ones they opened.
      return { ok: true };
    case "get":
    case "terminate":
    case "recording": {
      if (!c.session) return deny("notFound");
      if (!(admin || owner || creator)) return deny("notOwnerOrAdmin");
      if (op === "terminate") return live ? { ok: true } : deny("sessionClosed");
      if (op === "recording" && !c.stepUp) return deny("stepUpRequired");
      return { ok: true };
    }
    case "create":
    case "attach": {
      if (!(admin || owner)) return deny("notOwnerOrAdmin");
      // A shell can change the project's code: it takes the right to work on tasks, not just to read them.
      if (!may(actor, c.project, "taskWork")) return deny("noProjectAccess");
      // An admin is not above the machine's own opt-in.
      const unavailable = terminalUnavailable(c.machine.capability, c.project);
      if (unavailable) return deny(unavailable);
      if (op === "attach") {
        if (!c.session) return deny("notFound");
        // Another admin or owner may stop someone's session, never type in it.
        if (!creator) return deny("notCreator");
        if (!live || c.session.state === "closing") return deny("sessionClosed");
      }
      return c.stepUp ? { ok: true } : deny("stepUpRequired");
    }
  }
}

/** terminalDecision as an error, in the codes the RPC layer already maps to HTTP statuses. */
export function assertTerminal(c: TerminalCheck): void {
  const d = terminalDecision(c);
  if (d.ok) return;
  const code = d.denial === "notFound" ? "not_found" : d.denial === "sessionClosed" ? "conflict" : "forbidden";
  throw new HiveError(code, `Terminal ${c.op}: ${d.denial}.`, { key: `errors.terminal.${d.denial}` });
}
