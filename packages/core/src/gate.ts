// Gate jobs (spec 69h1, executor 69h2): a fixed command the machine declared, run on one exact commit of a project
// outside any coding run's sandbox, with a structured receipt. Browser-safe: the web shows the same manifest and the
// same green/red rule the hub and the machine apply. The template hash needs node:crypto and lives in gate-hash.ts.
import { z } from "zod";
import { PROJECT_NAME } from "./keys.ts";

export const GATE_PROTOCOL = 1;

/** The only values a template's argv gets from a job, all made or checked by the machine. */
export const GATE_PLACEHOLDERS = ["{sha}", "{jobId}", "{artifactDir}"] as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const GATE_TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const GATE_JOB_ID = /^gj_[a-z0-9]{20}$/;
export const GATE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;

/** The placeholders in one argv element, each occurrence counted. */
export function argvPlaceholders(element: string): string[] {
  return GATE_PLACEHOLDERS.flatMap((p) => Array(element.split(p).length - 1).fill(p) as string[]);
}

/**
 * Literal text, or literal text around exactly one placeholder (spec 69h1 §3). Other braces stay literal (a shell
 * script's `{…}`): only these three names are ever replaced, once, so a value can never form a second one.
 */
const validArgvElement = (element: string): boolean => argvPlaceholders(element).length <= 1;

const relativePath = z.string().min(1).max(200).refine((p) => !p.startsWith("/") && !p.split(/[\\/]/).includes(".."), "a path inside the artifact folder");

const manifestShape = {
  id: z.string().regex(GATE_TEMPLATE_ID),
  version: z.number().int().min(1).max(1_000_000),
  argv: z.array(z.string().min(1).max(1000).refine(validArgvElement, "at most one of {sha}, {jobId}, {artifactDir}, once")).min(1).max(64),
  env: z.array(z.string().regex(ENV_NAME)).max(32),
  timeoutMinutes: z.number().int().min(1).max(120),
  gui: z.boolean(),
  resultFile: relativePath.nullable(),
  artifacts: z.array(z.strictObject({ glob: relativePath, required: z.boolean() })).max(8),
  autoApprove: z.boolean(),
};
const programFixed = (m: { argv: string[] }) => argvPlaceholders(m.argv[0]!).length === 0;
export const gateManifestSchema = z.strictObject(manifestShape).refine(programFixed, "argv[0] is the program, never a placeholder");
export type GateManifest = z.output<typeof gateManifestSchema>;

export const gateTemplateSchema = z.strictObject({ ...manifestShape, label: z.string().min(1).max(80) }).refine(programFixed, "argv[0] is the program, never a placeholder");
export type GateTemplate = z.output<typeof gateTemplateSchema>;

/** The manifest of a template: everything but its label, which is the only field outside the hash. */
export function gateManifest(t: GateTemplate): GateManifest {
  const { label: _label, ...manifest } = t;
  return manifest;
}

/** Keys in byte order, no whitespace (spec 69h1 §3): the same bytes on the hub and on the machine. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** The argv a job runs; {artifactDir} stays as written where the hub shows it (a local path). */
export function expandGateArgv(argv: string[], values: { sha: string; jobId: string; artifactDir?: string }): string[] {
  return argv.map((a) => a.replace("{sha}", values.sha).replace("{jobId}", values.jobId).replace("{artifactDir}", values.artifactDir ?? "{artifactDir}"));
}

/**
 * A manifest's artifact glob against a path relative to the artifact folder: `*` and `?` stay inside one folder,
 * `**` crosses them. Nothing else is special, so a glob never reads as a regular expression.
 */
export function gateGlobMatch(glob: string, rel: string): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(rel);
}

// ── Heartbeat (spec 69h1 §3) ────────────────────────────────────────────────

export const GATE_MANIFESTS_PER_BEAT = 8;
export const GATE_MANIFEST_BYTES_PER_BEAT = 64 * 1024;

const gateIndexEntry = z.object({ id: z.string().regex(GATE_TEMPLATE_ID), version: z.number().int().min(1), hash: z.string().regex(HASH), label: z.string().max(80) });

export const gateCapabilitySchema = z.object({
  protocol: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
  guiReady: z.boolean(),
  busy: z.boolean(),
  projects: z.array(z.object({
    name: z.string().regex(PROJECT_NAME),
    autoApprove: z.boolean(),
    templates: z.array(gateIndexEntry).max(32),
  })).max(200),
  /** Unvalidated here: the hub checks each one (hash, schema, secrets) and ACKs only those it kept. */
  manifests: z.array(z.object({ hash: z.string().regex(HASH), manifest: z.unknown() })).max(GATE_MANIFESTS_PER_BEAT),
});
export type GateCapability = z.output<typeof gateCapabilitySchema>;
export interface GateHeartbeatReply { ack: string[]; want: string[] }

// ── Jobs (spec 69h1 §4) ─────────────────────────────────────────────────────

export const GATE_STATES = ["requested", "approved", "claimed", "running", "passed", "failed", "error", "rejected", "expired", "cancelled", "uncertain"] as const;
export type GateState = (typeof GATE_STATES)[number];
export const GATE_FINAL: ReadonlySet<GateState> = new Set(["passed", "failed", "error", "rejected", "expired", "cancelled"]);

export const GATE_REASONS = [
  "templateChanged", "shaNotOnRef", "cloneFailed", "noGui", "lockTimeout", "timeout", "exitNonZero", "resultNotOk", "resultInvalid",
  "artifactMissing", "treeChanged", "uploadFailed", "cancelled", "leaseLost", "autoApproveRevoked", "batchEnded",
  // Hub-side transitions that are no outcome of a run.
  "rejected", "expired", "reconciled",
] as const;
export type GateReason = (typeof GATE_REASONS)[number];

export const GATE_PURPOSES = ["mergeQueue", "manual", "evidence"] as const;
export type GatePurpose = (typeof GATE_PURPOSES)[number];

/** The lease a take gives, renewed by progress up to claimedAt + timeout + this. */
export const GATE_LEASE_MS = 2 * 60_000;
export const GATE_LEASE_SLACK_MS = 10 * 60_000;
export const GATE_EXPIRY_DEFAULT_MINUTES = 24 * 60;
export const GATE_EXPIRY_MAX_MINUTES = 72 * 60;
/** Prefixed like the hub's other secrets, so the secret filter hides one that lands in a log. */
export const GATE_LEASE_PREFIX = "hivegate_";

export const gateResultFileSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string().max(200), ok: z.boolean() })).max(200).optional(),
  summary: z.string().max(4000).optional(),
});
export type GateResultFile = z.output<typeof gateResultFileSchema>;
export const GATE_RESULT_MAX_BYTES = 64 * 1024;

export const gateReceiptSchema = z.strictObject({
  jobId: z.string().regex(GATE_JOB_ID),
  project: z.string().regex(PROJECT_NAME),
  machineId: z.string().min(1).max(200),
  templateId: z.string().regex(GATE_TEMPLATE_ID),
  templateHash: z.string().regex(HASH),
  sha: z.string().regex(GATE_SHA),
  checkedSha: z.string().max(64),
  treeClean: z.boolean(),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(20).nullable(),
  timedOut: z.boolean(),
  result: gateResultFileSchema.nullable(),
  artifacts: z.array(z.object({ name: z.string().min(1).max(200), type: z.string().max(60), bytes: z.number().int().min(0), sha256: z.string().regex(HASH), required: z.boolean() })).max(20),
  logSha256: z.string().regex(HASH).nullable(),
  /** The last 4 KiB of the log, through the secret filter on both ends; the log itself stays on the machine. */
  logTail: z.string().max(4096),
  app: z.string().max(40),
  os: z.object({ platform: z.string().max(20), release: z.string().max(60) }),
  gui: z.enum(["aqua", "x11", "wayland", "none"]),
  outcome: z.enum(["passed", "failed", "error", "cancelled"]),
  reason: z.enum(GATE_REASONS).nullable(),
});
export type GateReceipt = z.output<typeof gateReceiptSchema>;

export interface GateJob {
  id: string;
  project: string;
  machineId: string;
  templateId: string;
  templateHash: string;
  timeoutMinutes: number;
  sha: string;
  ref: string;
  purpose: GatePurpose;
  batchId: number | null;
  requestedBy: string;
  idempotencyKey: string;
  state: GateState;
  reason: GateReason | null;
  version: number;
  approval: { mode: "human" | "auto"; by: string; at: string } | null;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  leaseUntil: string | null;
  receipt: GateReceipt | null;
}

/** What the machine saw after the command, before the outcome is decided. */
export interface GateObservation {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** The manifest names a result file. */
  resultExpected: boolean;
  /** Its parsed content, or "invalid" (missing, too big, not the schema), or null when none is expected. */
  result: GateResultFile | "invalid" | null;
  missingRequired: number;
  headMatches: boolean;
  treeClean: boolean;
}

/**
 * Green only when every condition of spec 69h1 §4 holds; a test that fails is red even with all its screenshots
 * (AC09). The order says which reason a run gets when several apply: the command's own word first, then what it left.
 */
export function gateOutcome(o: GateObservation): { outcome: GateReceipt["outcome"]; reason: GateReason | null } {
  if (o.cancelled) return { outcome: "cancelled", reason: "cancelled" };
  if (o.timedOut) return { outcome: "failed", reason: "timeout" };
  if (o.exitCode !== 0 || o.signal) return { outcome: "failed", reason: "exitNonZero" };
  if (o.resultExpected) {
    if (o.result === null || o.result === "invalid") return { outcome: "failed", reason: "resultInvalid" };
    if (!o.result.ok || o.result.checks?.some((c) => !c.ok)) return { outcome: "failed", reason: "resultNotOk" };
  }
  if (!o.headMatches || !o.treeClean) return { outcome: "failed", reason: "treeChanged" };
  if (o.missingRequired > 0) return { outcome: "failed", reason: "artifactMissing" };
  return { outcome: "passed", reason: null };
}

// ── RPC inputs (spec 69h1 §9) ───────────────────────────────────────────────

const project = z.string().regex(PROJECT_NAME);
const jobId = z.string().regex(GATE_JOB_ID);
const leaseToken = z.string().regex(/^hivegate_[A-Za-z0-9_-]{43}$/);
/** A branch the machine finds the SHA on: no option, no revision syntax, nothing a shell or git reads as more. */
export const gateRef = z.string().min(1).max(200).regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]+(?<![./])$/);

export const gateInputs = {
  templates: z.object({ project }),
  create: z.object({
    project,
    machineId: z.string().min(1).max(200),
    templateId: z.string().regex(GATE_TEMPLATE_ID),
    templateHash: z.string().regex(HASH),
    sha: z.string().regex(GATE_SHA),
    ref: gateRef,
    purpose: z.enum(["manual", "evidence"]),
    idempotencyKey: z.string().min(1).max(80),
    expiresInMinutes: z.number().int().min(5).max(GATE_EXPIRY_MAX_MINUTES).optional(),
  }),
  approve: z.object({ id: jobId, version: z.number().int().min(0), pass: z.boolean(), reason: z.string().max(500).default("") }),
  cancel: z.object({ id: jobId, reason: z.string().max(500).default("") }),
  reconcile: z.object({ id: jobId, outcome: z.enum(["failed", "error"]), note: z.string().max(1000).default("") }),
  take: z.object({ project }),
  progress: z.object({ id: jobId, leaseToken, step: z.string().max(200) }),
  result: z.object({ id: jobId, leaseToken, receipt: gateReceiptSchema }),
  artifact: z.object({ id: jobId, leaseToken, name: z.string().min(1).max(200), data: z.string().min(1).max(Math.ceil((5 * 1024 * 1024 * 4) / 3) + 8) }),
  list: z.object({ project, state: z.enum(GATE_STATES).optional(), sha: z.string().regex(GATE_SHA).optional(), limit: z.number().int().min(1).max(200).default(50) }),
  get: z.object({ id: jobId }),
};

export interface GateTemplatesView {
  machines: {
    machineId: string;
    machine: string;
    enabled: boolean;
    guiReady: boolean;
    busy: boolean;
    autoApprove: boolean;
    templates: { id: string; version: number; hash: string; label: string; ready: boolean; manifest: GateManifest | null }[];
  }[];
}
