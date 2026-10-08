// Gate jobs on the hub (spec 69h1, 69h2): rows, CAS transitions, leases and receipts. Called inside SqliteHive's
// transaction; who may call what is SqliteHive's #check. No argv value, env value or log crosses this boundary: the
// hub keeps the manifest a machine published, the receipt it sent, and the hash of the lease it handed out.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HiveError } from "#core/errors.ts";
import {
  GATE_EXPIRY_DEFAULT_MINUTES, GATE_FINAL, GATE_LEASE_MS, GATE_LEASE_PREFIX, GATE_LEASE_SLACK_MS, GATE_MANIFEST_BYTES_PER_BEAT, GATE_PROTOCOL,
  gateCapabilitySchema, gateGlobMatch, gateManifestSchema, gateOutcome,
  type GateCapability, type GateHeartbeatReply, type GateJob, type GateManifest, type GatePurpose, type GateReason, type GateReceipt, type GateState,
  type GateTemplatesView,
} from "#core/gate.ts";
import { gateManifestHash } from "#core/gate-hash.ts";
import { findSecret } from "#core/secrets.ts";

type Row = Record<string, unknown>;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newGateJobId(): string {
  const bytes = randomBytes(20);
  return `gj_${Array.from(bytes, (b) => ID_ALPHABET[b % 32]).join("")}`;
}

export interface GateCreate {
  project: string; machineId: string; templateId: string; templateHash: string; sha: string; ref: string;
  purpose: GatePurpose; requestedBy: string; idempotencyKey: string; expiresInMinutes?: number;
}

export class GateStore {
  private db: DatabaseSync;
  private now: () => Date;
  private audit: (action: string, target: string, detail: string) => void;
  constructor(db: DatabaseSync, now: () => Date, audit: (action: string, target: string, detail: string) => void) {
    this.db = db; this.now = now; this.audit = audit;
  }
  #iso(offsetMs = 0) { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  // ── capability and manifests (§3) ─────────────────────────────────────────

  /**
   * The index of every beat replaces the last one; a manifest is kept once per (machine, hash) and only when it hashes
   * to what it claims, parses, holds no known secret and is in this very beat's index. Anything else gets no ACK.
   */
  heartbeat(machineId: string, raw: unknown, allowed: (project: string) => boolean): GateHeartbeatReply | undefined {
    if (raw === undefined || raw === null) {
      this.db.prepare("UPDATE machines SET gate_capability = NULL WHERE id = ?").run(machineId);
      return undefined;
    }
    const parsed = gateCapabilitySchema.safeParse(raw);
    if (!parsed.success || parsed.data.protocol !== GATE_PROTOCOL) {
      this.db.prepare("UPDATE machines SET gate_capability = NULL WHERE id = ?").run(machineId);
      return { ack: [], want: [] };
    }
    const cap = { ...parsed.data, projects: parsed.data.projects.filter((p) => allowed(p.name)) };
    const { manifests, ...index } = cap;
    this.db.prepare("UPDATE machines SET gate_capability = ? WHERE id = ?").run(JSON.stringify(index), machineId);
    const listed = new Set(cap.projects.flatMap((p) => p.templates.map((t) => t.hash)));
    const ack: string[] = [];
    let bytes = 0;
    for (const { hash, manifest } of manifests) {
      const text = JSON.stringify(manifest) ?? "";
      bytes += text.length;
      const m = gateManifestSchema.safeParse(manifest);
      const why = bytes > GATE_MANIFEST_BYTES_PER_BEAT ? "too big" : !listed.has(hash) ? "not in index" : !m.success ? "schema" : gateManifestHash(m.data) !== hash ? "hash" : findSecret(text) ? "secret" : null;
      if (why) { this.audit("gate.manifest", `${machineId}/${hash.slice(0, 12)}`, `refused: ${why}`); continue; }
      this.db.prepare("INSERT OR IGNORE INTO gate_manifests(machine_id, hash, manifest, first_seen) VALUES (?, ?, ?, ?)").run(machineId, hash, JSON.stringify(m.data), this.#iso());
      ack.push(hash);
    }
    const have = this.db.prepare("SELECT 1 FROM gate_manifests WHERE machine_id = ? AND hash = ?");
    const want = [...listed].filter((h) => !ack.includes(h) && !have.get(machineId, h));
    return { ack, want };
  }

  capability(machineId: string): Omit<GateCapability, "manifests"> | null {
    const row = this.db.prepare("SELECT gate_capability FROM machines WHERE id = ?").get(machineId) as Row | undefined;
    return row?.gate_capability ? JSON.parse(String(row.gate_capability)) : null;
  }

  manifest(machineId: string, hash: string): GateManifest | null {
    const row = this.db.prepare("SELECT manifest FROM gate_manifests WHERE machine_id = ? AND hash = ?").get(machineId, hash) as Row | undefined;
    return row ? JSON.parse(String(row.manifest)) : null;
  }

  /** Ready = listed in the machine's last index for this project and its manifest kept here (§3). */
  ready(machineId: string, project: string, templateId: string, hash: string): GateManifest | null {
    const cap = this.capability(machineId);
    const listed = cap?.enabled && cap.projects.find((p) => p.name === project)?.templates.some((t) => t.id === templateId && t.hash === hash);
    return listed ? this.manifest(machineId, hash) : null;
  }

  templates(project: string, withManifests: boolean): GateTemplatesView {
    const rows = this.db.prepare("SELECT id, machine, gate_capability FROM machines WHERE gate_capability IS NOT NULL ORDER BY id").all() as Row[];
    const machines: GateTemplatesView["machines"] = [];
    for (const r of rows) {
      const cap = JSON.parse(String(r.gate_capability)) as Omit<GateCapability, "manifests">;
      const p = cap.projects.find((x) => x.name === project);
      if (!p) continue;
      const machineId = String(r.id);
      machines.push({
        machineId, machine: String(r.machine), enabled: cap.enabled, guiReady: cap.guiReady, busy: cap.busy, autoApprove: p.autoApprove,
        templates: p.templates.map((t) => {
          const manifest = this.manifest(machineId, t.hash);
          return { ...t, ready: cap.enabled && !!manifest, manifest: withManifests ? manifest : null };
        }),
      });
    }
    return { machines };
  }

  // ── jobs (§4) ─────────────────────────────────────────────────────────────

  get(id: string): GateJob | null {
    this.sweep();
    const row = this.db.prepare("SELECT * FROM gate_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }
  require(id: string): GateJob {
    const job = this.get(id);
    if (!job) throw new HiveError("not_found", "Gate job not found.");
    return job;
  }

  list(project: string, filter: { state?: GateState; sha?: string; limit: number }): GateJob[] {
    this.sweep();
    return (this.db.prepare("SELECT * FROM gate_jobs WHERE project = ? AND (?2 IS NULL OR state = ?2) AND (?3 IS NULL OR sha = ?3) ORDER BY created_at DESC, id LIMIT ?4")
      .all(project, filter.state ?? null, filter.sha ?? null, filter.limit) as Row[]).map(toJob);
  }

  create(c: GateCreate): GateJob {
    const same = this.db.prepare("SELECT * FROM gate_jobs WHERE project = ? AND template_hash = ? AND sha = ? AND idempotency_key = ?").get(c.project, c.templateHash, c.sha, c.idempotencyKey) as Row | undefined;
    if (same) {
      const j = toJob(same);
      // A retried click gets its job; the same key for another machine, template or ref is another request.
      if (j.machineId !== c.machineId || j.templateId !== c.templateId || j.ref !== c.ref || j.purpose !== c.purpose) throw new HiveError("conflict", "That idempotency key already names another gate job.");
      return j;
    }
    const manifest = this.ready(c.machineId, c.project, c.templateId, c.templateHash);
    if (!manifest) throw new HiveError("conflict", "That template is not ready on this machine: its index or manifest is missing or changed.");
    const id = newGateJobId();
    const at = this.#iso();
    this.db.prepare(
      `INSERT INTO gate_jobs(id, project, machine_id, template_id, template_hash, timeout_minutes, sha, ref, purpose, batch_id, requested_by, idempotency_key,
         state, reason, version, approval, created_at, expires_at, claimed_at, lease_until, lease_hash, receipt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'requested', NULL, 0, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
    ).run(id, c.project, c.machineId, c.templateId, c.templateHash, manifest.timeoutMinutes, c.sha, c.ref, c.purpose, c.requestedBy, c.idempotencyKey,
      at, this.#iso((c.expiresInMinutes ?? GATE_EXPIRY_DEFAULT_MINUTES) * 60_000));
    this.audit("gate.create", `${c.project}/${id}`, `${c.machineId} · ${c.templateId}@${c.templateHash.slice(0, 12)} · ${c.sha.slice(0, 12)} · ${c.purpose}`);
    return this.require(id);
  }

  #move(job: GateJob, to: GateState, reason: GateReason | null, set: Record<string, unknown> = {}, action = "gate.transition", detail = ""): GateJob {
    const cols = Object.keys(set);
    const res = this.db.prepare(`UPDATE gate_jobs SET state = ?, reason = ?, version = version + 1${cols.map((c) => `, ${c} = ?`).join("")} WHERE id = ? AND version = ?`)
      .run(to, reason, ...cols.map((c) => set[c] as string | number | null), job.id, job.version);
    if (res.changes !== 1) throw new HiveError("conflict", "The gate job changed meanwhile; reload it.");
    this.audit(action, `${job.project}/${job.id}`, `${job.state} → ${to}${reason ? ` (${reason})` : ""} · ${job.templateId}@${job.templateHash.slice(0, 12)} · ${job.sha.slice(0, 12)}${detail ? ` · ${detail}` : ""}`);
    return toJob(this.db.prepare("SELECT * FROM gate_jobs WHERE id = ?").get(job.id) as Row);
  }

  /** Overdue jobs become expired (never taken) or uncertain (taken, lease gone without a receipt); never taken again. */
  sweep(): void {
    const now = this.#iso();
    for (const row of this.db.prepare("SELECT * FROM gate_jobs WHERE (state IN ('requested', 'approved') AND expires_at <= ?1) OR (state IN ('claimed', 'running') AND lease_until <= ?1)").all(now) as Row[]) {
      const job = toJob(row);
      if (job.state === "requested" || job.state === "approved") this.#move(job, "expired", "expired");
      else this.#move(job, "uncertain", "leaseLost");
    }
  }

  approve(id: string, version: number, pass: boolean, by: string, note: string): GateJob {
    const job = this.require(id);
    if (job.version !== version) throw new HiveError("conflict", "The gate job changed since you saw it; reload it.");
    if (job.state !== "requested") throw new HiveError("conflict", "Only a requested gate job can be approved or rejected.");
    return pass
      ? this.#move(job, "approved", null, { approval: JSON.stringify({ mode: "human", by, at: this.#iso() }) }, "gate.approve", note)
      : this.#move(job, "rejected", "rejected", {}, "gate.reject", note);
  }

  /** Before it runs: ends it. Running: ends it here and the machine kills it at its next progress, then reports. */
  cancel(id: string, note: string): GateJob {
    const job = this.require(id);
    if (GATE_FINAL.has(job.state) || job.state === "uncertain") throw new HiveError("conflict", "The gate job already ended.");
    return this.#move(job, "cancelled", "cancelled", {}, "gate.cancel", note);
  }

  reconcile(id: string, outcome: "failed" | "error", note: string): GateJob {
    const job = this.require(id);
    if (job.state !== "uncertain") throw new HiveError("conflict", "Only an uncertain gate job is reconciled.");
    return this.#move(job, outcome, "reconciled", {}, "gate.reconcile", note);
  }

  /** The oldest approved free job of this project for this machine, with a fresh lease; the token is shown once. */
  take(project: string, machineId: string): { job: GateJob; leaseToken: string } | null {
    this.sweep();
    const row = this.db.prepare("SELECT * FROM gate_jobs WHERE project = ? AND machine_id = ? AND state = 'approved' AND batch_id IS NULL ORDER BY created_at, id LIMIT 1").get(project, machineId) as Row | undefined;
    if (!row) return null;
    const leaseToken = `${GATE_LEASE_PREFIX}${randomBytes(32).toString("base64url")}`;
    const job = this.#move(toJob(row), "claimed", null, { claimed_at: this.#iso(), lease_until: this.#iso(GATE_LEASE_MS), lease_hash: sha256(leaseToken) }, "gate.take");
    return { job, leaseToken };
  }

  #leased(id: string, machineId: string, leaseToken: string): GateJob {
    const row = this.db.prepare("SELECT * FROM gate_jobs WHERE id = ?").get(id) as Row | undefined;
    // The same answer for a job of another machine and a wrong token: neither may learn the other exists.
    if (!row || String(row.machine_id) !== machineId || !row.lease_hash || String(row.lease_hash) !== sha256(leaseToken)) throw new HiveError("forbidden", "Not this machine's gate lease.");
    return toJob(row);
  }

  /** Renews the lease up to claimedAt + timeout + 10 min, whatever the machine sends; a cancelled job says so here. */
  progress(id: string, machineId: string, leaseToken: string): { state: GateState; leaseUntil: string | null } {
    this.sweep();
    const job = this.#leased(id, machineId, leaseToken);
    if (job.state !== "claimed" && job.state !== "running") return { state: job.state, leaseUntil: job.leaseUntil };
    const cap = Date.parse(job.claimedAt!) + job.timeoutMinutes * 60_000 + GATE_LEASE_SLACK_MS;
    const until = new Date(Math.min(this.now().getTime() + GATE_LEASE_MS, cap)).toISOString();
    if (job.state === "claimed") return { state: "running", leaseUntil: this.#move(job, "running", null, { lease_until: until }, "gate.start").leaseUntil };
    this.db.prepare("UPDATE gate_jobs SET lease_until = ? WHERE id = ?").run(until, job.id);
    return { state: job.state, leaseUntil: until };
  }

  /** Artifacts land while the lease holds and before the receipt; result checks them against the receipt. */
  assertUploading(id: string, machineId: string, leaseToken: string): GateJob {
    this.sweep();
    const job = this.#leased(id, machineId, leaseToken);
    if (job.state !== "claimed" && job.state !== "running") throw new HiveError("conflict", "The gate job is not running.");
    return job;
  }

  /**
   * The receipt once. A job that ended here meanwhile (cancelled, uncertain) keeps its state and gets the receipt as
   * evidence; a terminal state is never reopened. The same receipt again answers the same job, another one conflicts.
   */
  result(id: string, machineId: string, leaseToken: string, receipt: GateReceipt, uploaded: (name: string) => string | null): GateJob {
    this.sweep();
    const job = this.#leased(id, machineId, leaseToken);
    if (receipt.jobId !== job.id || receipt.project !== job.project || receipt.machineId !== job.machineId || receipt.templateId !== job.templateId
      || receipt.templateHash !== job.templateHash || receipt.sha !== job.sha) throw new HiveError("bad_request", "The receipt names another job.");
    if (job.receipt) {
      // The hub may have turned a claimed green into red (missing upload); the resend still says what it said.
      const resent = receipt.outcome === "passed" ? { ...receipt, outcome: job.receipt.outcome, reason: job.receipt.reason } : receipt;
      if (JSON.stringify(job.receipt) === JSON.stringify(resent)) return job;
      this.audit("gate.result", `${job.project}/${job.id}`, "conflict: another receipt");
      throw new HiveError("conflict", "This gate job already has another receipt.");
    }
    let { outcome, reason } = receipt;
    if (outcome === "passed") {
      // The hub decides green from the receipt's facts too, so a machine cannot call a red run green.
      const manifest = this.manifest(job.machineId, job.templateHash);
      const check = gateOutcome({
        exitCode: receipt.exitCode, signal: receipt.signal, timedOut: receipt.timedOut, cancelled: false, resultExpected: !!manifest?.resultFile,
        result: receipt.result, missingRequired: 0, headMatches: receipt.checkedSha === job.sha, treeClean: receipt.treeClean,
      });
      if (!manifest || check.outcome !== "passed") throw new HiveError("bad_request", "The receipt says passed but its facts do not.");
      if (manifest.artifacts.some((g) => g.required && !receipt.artifacts.some((a) => gateGlobMatch(g.glob, a.name)))) ({ outcome, reason } = { outcome: "failed", reason: "artifactMissing" });
      else if (receipt.artifacts.some((a) => uploaded(a.name) !== a.sha256)) ({ outcome, reason } = { outcome: "error", reason: "uploadFailed" });
    }
    const stored = JSON.stringify({ ...receipt, outcome, reason });
    if (job.state !== "claimed" && job.state !== "running") {
      this.db.prepare("UPDATE gate_jobs SET receipt = ?, version = version + 1 WHERE id = ? AND version = ?").run(stored, job.id, job.version);
      this.audit("gate.result", `${job.project}/${job.id}`, `late receipt (${outcome}) kept; state stays ${job.state}`);
      return this.require(id);
    }
    const to: GateState = outcome === "cancelled" ? "cancelled" : outcome;
    return this.#move(job, to, reason, { receipt: stored, lease_until: null }, "gate.result", `exit ${receipt.exitCode ?? "-"}${receipt.timedOut ? " · timeout" : ""}`);
  }
}

function toJob(r: Row): GateJob {
  const s = (k: string) => (r[k] === null || r[k] === undefined ? null : String(r[k]));
  return {
    id: String(r.id), project: String(r.project), machineId: String(r.machine_id), templateId: String(r.template_id), templateHash: String(r.template_hash),
    timeoutMinutes: Number(r.timeout_minutes), sha: String(r.sha), ref: String(r.ref), purpose: String(r.purpose) as GatePurpose,
    batchId: r.batch_id === null ? null : Number(r.batch_id), requestedBy: String(r.requested_by), idempotencyKey: String(r.idempotency_key),
    state: String(r.state) as GateState, reason: s("reason") as GateReason | null, version: Number(r.version),
    approval: r.approval ? JSON.parse(String(r.approval)) : null, createdAt: String(r.created_at), expiresAt: String(r.expires_at),
    claimedAt: s("claimed_at"), leaseUntil: s("lease_until"), receipt: r.receipt ? JSON.parse(String(r.receipt)) : null,
  };
}
