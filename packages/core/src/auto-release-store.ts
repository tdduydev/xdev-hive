import type { DatabaseSync } from "node:sqlite";
import { HiveError } from "#core/errors.ts";
import type { AutoReleaseRecord, AutoReleaseView, GreenBatch, ReleaseStep } from "#core/auto-release.ts";
import type { GateMode } from "#core/sdlc.ts";

/** Called inside SqliteHive's transaction; no command, environment or process output crosses this boundary. */
export class AutoReleaseStore {
  private db: DatabaseSync;
  private now: () => string;
  constructor(db: DatabaseSync, now: () => string) { this.db = db; this.now = now; }
  get(project: string, batchId: string): AutoReleaseRecord | null {
    const row = this.db.prepare("SELECT record FROM auto_releases WHERE project = ? AND batch_id = ?").get(project, batchId);
    return row ? JSON.parse(String(row.record)) : null;
  }
  save(r: AutoReleaseRecord) {
    r.updatedAt = this.now();
    this.db.prepare("INSERT INTO auto_releases(project, batch_id, record) VALUES (?, ?, ?) ON CONFLICT(project, batch_id) DO UPDATE SET record = excluded.record").run(r.project, r.batchId, JSON.stringify(r));
    return r;
  }
  view(project: string): AutoReleaseView {
    return { releases: this.db.prepare("SELECT record FROM auto_releases WHERE project = ? ORDER BY rowid DESC LIMIT 100").all(project).map(r => JSON.parse(String(r.record))), paused: !!this.db.prepare("SELECT project FROM auto_release_pauses WHERE project = ?").get(project) };
  }
  green(batch: GreenBatch, machine: string, mode: GateMode) {
    const old = this.get(batch.project, batch.batchId);
    if (old) {
      if (JSON.stringify(old.batch) !== JSON.stringify(batch) || old.machine !== machine) throw new HiveError("conflict", "Batch identity changed.");
      return old;
    }
    if (this.view(batch.project).paused) throw new HiveError("conflict", "Release queue is paused.");
    if (this.db.prepare("SELECT 1 FROM auto_releases WHERE project = ? AND json_extract(record, '$.batch.version') = ?").get(batch.project, batch.version)) throw new HiveError("conflict", "Version already belongs to another batch.");
    for (const id of batch.taskIds) {
      const t = this.db.prepare("SELECT project, status FROM tasks WHERE id = ?").get(id);
      if (!t || t.project !== batch.project || t.status !== "done") throw new HiveError("conflict", "Only landed, done tasks may be released.");
    }
    const at = this.now();
    const gate = this.db.prepare("INSERT INTO sdlc_gates(project, task_id, gate, mode, status, subject, created_at, decided_at, decided_by) VALUES (?, ?, 'release', ?, ?, ?, ?, ?, ?)").run(batch.project, batch.taskIds[0]!, mode, mode === "auto" ? "passed" : "waiting", JSON.stringify(batch), at, mode === "auto" ? at : null, mode === "auto" ? "auto" : null);
    return this.save({ project: batch.project, batchId: batch.batchId, batch, machine, state: mode === "auto" ? "queued" : "waiting", gateId: Number(gate.lastInsertRowid), step: null, warning: false, createdAt: at, updatedAt: at });
  }
  require(project: string, batchId: string) {
    const r = this.get(project, batchId);
    if (!r) throw new HiveError("not_found", "Release batch not found.");
    return r;
  }
  decide(project: string, batchId: string, pass: boolean, who: string) {
    const r = this.require(project, batchId);
    if (r.state !== "waiting") throw new HiveError("conflict", "Release is not waiting.");
    this.db.prepare("UPDATE sdlc_gates SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(pass ? "passed" : "rejected", who, this.now(), r.gateId);
    r.state = pass ? "queued" : "rejected";
    return this.save(r);
  }
  take(project: string, machine: string, mode: GateMode) {
    if (this.view(project).paused) return null;
    // An interrupted release is never taken again automatically: a person reconciles it first.
    if (this.db.prepare("SELECT 1 FROM auto_releases WHERE project = ? AND json_extract(record, '$.state') = 'running'").get(project)) return null;
    const row = this.db.prepare("SELECT record FROM auto_releases WHERE project = ? AND json_extract(record, '$.state') = 'queued' ORDER BY rowid LIMIT 1").get(project);
    if (!row) return null;
    const r: AutoReleaseRecord = JSON.parse(String(row.record));
    if (r.machine !== machine) return null;
    const gate = this.db.prepare("SELECT decided_by FROM sdlc_gates WHERE id = ?").get(r.gateId);
    if (mode !== "auto" && gate?.decided_by === "auto") {
      r.state = "waiting";
      this.db.prepare("UPDATE sdlc_gates SET mode = ?, status = 'waiting', decided_by = NULL, decided_at = NULL WHERE id = ?").run(mode, r.gateId);
    } else r.state = "running";
    this.save(r);
    return r.state === "running" ? r : null;
  }
  result(project: string, batchId: string, machine: string, success: boolean, step: ReleaseStep, warning: boolean) {
    const r = this.require(project, batchId);
    if (r.machine !== machine) throw new HiveError("forbidden", "Release belongs to another machine.");
    if (r.reconciled) return r;
    if (r.state === (success ? "succeeded" : "failed") && r.step === step && r.warning === warning) return r;
    if (r.state !== "running") throw new HiveError("conflict", "Release is not running.");
    if (success && r.step && r.step !== step) throw new HiveError("conflict", "Receipt does not match the current release step.");
    r.state = success ? "succeeded" : "failed"; r.step = step; r.warning = warning;
    if (!success) {
      this.db.prepare("INSERT OR IGNORE INTO auto_release_pauses(project) VALUES (?)").run(project);
      let id = `OPS-release-${r.batch.version}`;
      const old = this.db.prepare("SELECT project FROM tasks WHERE id = ?").get(id);
      if (old && old.project !== project) id += `-${project}`;
      this.db.prepare("INSERT INTO tasks(id, project, title, note, kind, status, updated_at) VALUES (?, ?, ?, ?, 'ops', 'todo', ?) ON CONFLICT(id) DO UPDATE SET status = 'todo', note = excluded.note, updated_at = excluded.updated_at").run(id, project, `Release ${r.batch.version} failed`, `Batch ${batchId}, main ${r.batch.sha}, failed step: ${step}. Queue paused; inspect logs on Gate machine ${machine}.`, this.now());
    }
    if (warning) {
      const id = `OPS-release-log-${r.batch.version}-${project}`;
      this.db.prepare("INSERT OR IGNORE INTO tasks(id, project, title, note, kind, status, updated_at) VALUES (?, ?, ?, ?, 'ops', 'todo', ?)").run(id, project, `Release ${r.batch.version}: log warning`, `Batch ${batchId} deployed; post-deploy log check raised a warning. Inspect local Gate machine logs (${machine}).`, this.now());
    }
    return this.save(r);
  }
  resume(project: string) {
    if (this.db.prepare("SELECT 1 FROM auto_releases WHERE project = ? AND json_extract(record, '$.state') = 'running'").get(project)) throw new HiveError("conflict", "Reconcile the running release before resuming.");
    this.db.prepare("DELETE FROM auto_release_pauses WHERE project = ?").run(project);
    return this.view(project);
  }
}
