import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { HiveError, effectivePolicy, parseInput, PROJECT_NAME, type Actor, type HiveEvent } from "@xdev-hive/core";
import type { SqliteHive } from "@xdev-hive/core/node";

const triggers = ["proposal.created", "memory.pending", "run.failed", "mr.created", "run.ciLimit", "alert.opened"] as const;
const ruleSchema = z.object({
  id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(80),
  project: z.string().regex(PROJECT_NAME), trigger: z.enum(triggers), enabled: z.boolean().default(false),
  conditions: z.array(z.object({ path: z.string().regex(/^[a-zA-Z0-9_.]{1,100}$/), equals: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]) })).max(10).default([]),
  action: z.object({ method: z.enum(["tasks.create", "memory.write"]), input: z.record(z.string(), z.unknown()) }),
});
type Rule = z.infer<typeof ruleSchema> & { id: number; owner: string };
type Run = { id: number; rule_id: number; event: string; rule_body: string; status: string; attempts: number };

/** Generated events carry an origin marker so listeners can suppress automation chains. */
export class Automation {
  readonly hive: SqliteHive;
  readonly resolve: (owner: string) => Actor | null;
  constructor(hive: SqliteHive, resolve: (owner: string) => Actor | null) {
    this.hive = hive;
    this.resolve = resolve;
    hive.db.exec(`CREATE TABLE IF NOT EXISTS automation_rules(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_runs(id INTEGER PRIMARY KEY, rule_id INTEGER NOT NULL, event_key TEXT NOT NULL,
      event TEXT NOT NULL, rule_body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
      UNIQUE(rule_id,event_key));`);
    // A crash after a side effect cannot safely be replayed automatically.
    hive.db.exec("UPDATE automation_runs SET status='uncertain' WHERE status='running'");
  }
  get db(): DatabaseSync { return this.hive.db; }
  list(): Rule[] { return this.db.prepare("SELECT body FROM automation_rules ORDER BY id").all().map(r => JSON.parse(String(r.body))); }
  history() { return this.db.prepare("SELECT id,rule_id,status,attempts,error,updated_at FROM automation_runs ORDER BY id DESC LIMIT 200").all(); }
  save(raw: unknown, owner: string, actor: Actor): Rule {
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success) throw new HiveError("bad_request", "Invalid automation rule");
    const input = parsed.data;
    if (!input.id && this.list().length >= 100) throw new HiveError("bad_request", "Automation rule limit reached");
    if (input.id && !this.list().some(r => r.id === input.id)) throw new HiveError("not_found", "Automation rule not found");
    const action = parseInput(input.action.method, input.action.input);
    if (action.project !== input.project) throw new HiveError("bad_request", "Action must stay in the rule project");
    const id = input.id ?? Number(this.db.prepare("INSERT INTO automation_rules(body) VALUES ('{}')").run().lastInsertRowid);
    const rule = { ...input, id, owner, action: { ...input.action, input: action } };
    this.db.prepare("UPDATE automation_rules SET body=? WHERE id=?").run(JSON.stringify(rule), id);
    this.hive.audit(actor, "automation.save", String(id), input.enabled ? "enabled" : "paused");
    return rule;
  }
  matches(rule: Rule, event: HiveEvent): boolean {
    if (!event || typeof event !== "object") return false;
    return rule.project === event.project && rule.trigger === event.type && rule.conditions.every(c => {
      let value: unknown = event;
      for (const key of c.path.split(".")) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return false;
        value = (value as Record<string, unknown>)[key];
      }
      return value === c.equals;
    });
  }
  dryRun(id: number, event: HiveEvent) {
    const rule = this.list().find(r => r.id === id);
    if (!rule) throw new HiveError("not_found", "Automation rule not found");
    if (!event || typeof event !== "object") throw new HiveError("bad_request", "Event is required");
    return { matches: this.matches(rule, event), enabled: rule.enabled, action: rule.action, executionPermissionsChecked: false };
  }
  async onEvent(event: HiveEvent): Promise<void> {
    if (!event || event.automation) return;
    const serialized = JSON.stringify(event);
    let identity: string | number;
    switch (event.type) {
      case "proposal.created": identity = event.proposal.id; break;
      case "memory.pending": identity = event.memory.id; break;
      case "alert.opened": identity = event.alert.id; break;
      case "run.failed": case "mr.created": case "run.ciLimit": identity = `${event.run.machine}:${event.run.runId}`; break;
      default: return;
    }
    const key = JSON.stringify([event.type, event.project, identity]);
    for (const rule of this.list()) {
      if (!rule.enabled || !this.matches(rule, event)) continue;
      const inserted = this.db.prepare("INSERT OR IGNORE INTO automation_runs(rule_id,event_key,event,rule_body,status,updated_at) VALUES (?,?,?,?,'pending',?)").run(rule.id, key, serialized, JSON.stringify(rule), new Date().toISOString());
      if (inserted.changes) await this.execute(Number(inserted.lastInsertRowid));
    }
  }
  async retry(id: number) {
    const run = this.db.prepare("SELECT * FROM automation_runs WHERE id=?").get(id) as Run | undefined;
    if (!run || !["failed", "pending"].includes(run.status)) throw new HiveError("bad_request", "Only failed or pending executions can retry");
    await this.execute(id);
    return this.db.prepare("SELECT id,status,attempts FROM automation_runs WHERE id=?").get(id);
  }
  private async execute(id: number) {
    const run = this.db.prepare("SELECT * FROM automation_runs WHERE id=?").get(id) as Run;
    const rule = this.list().find(r => r.id === run.rule_id);
    if (!rule?.enabled) throw new HiveError("bad_request", "Automation is paused");
    const original = JSON.parse(run.rule_body) as Rule;
    if (JSON.stringify(original.action) !== JSON.stringify(rule.action) || original.owner !== rule.owner || !this.matches(rule, JSON.parse(run.event)))
      throw new HiveError("bad_request", "Rule changed; execution cannot be replayed");
    if (run.attempts >= 3) throw new HiveError("bad_request", "Retry limit reached");
    const claimed = this.db.prepare("UPDATE automation_runs SET status='running',attempts=attempts+1 WHERE id=? AND status IN ('pending','failed')").run(id);
    if (!claimed.changes) return;
    let status = "done";
    let error: string | null = null;
    let actor: Actor | null = null;
    try {
      actor = this.resolve(rule.owner);
      if (!actor) throw new HiveError("forbidden", "Automation owner is no longer authorized");
      const paused = await this.hive.call("agents.paused", {}, actor);
      if (paused.hub || paused.projects.includes(rule.project)) throw new HiveError("forbidden", "Agents are paused");
      const settings = await this.hive.call("agentPolicy.get", {}, actor);
      const policy = effectivePolicy(settings.hub, settings.projects[rule.project] ?? null);
      if (policy.autonomy === "read" || policy.autonomy === "propose") throw new HiveError("forbidden", "Policy disallows automatic writes");
      // Resolve credentials anew and use the normal call path, including project, archive and policy checks.
      await this.hive.call(rule.action.method, rule.action.input as never, { ...actor, agent: "automation", onBehalf: actor.name });
    } catch (e) {
      status = "failed";
      // Persist only an error code: thrown messages can contain sensitive input.
      error = e instanceof HiveError ? e.code : "execution_failed";
    }
    this.db.prepare("UPDATE automation_runs SET status=?,error=?,updated_at=? WHERE id=?").run(status, error, new Date().toISOString(), id);
    if (actor) this.hive.audit(actor, "automation.execute", String(id), `${rule.id} · ${status}`);
  }
}
