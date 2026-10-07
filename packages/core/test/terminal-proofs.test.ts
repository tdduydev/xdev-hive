import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findSecret, SqliteHive, TerminalProofs, TerminalStore, terminalStepUpInput, TERMINAL_LIMITS, type TerminalStepUpContext,
} from "#core/node.ts";

// 69c: proofs and tickets are spent once, in the context they were issued for, before their deadline.
const setup = () => {
  const hive = new SqliteHive(":memory:");
  let now = new Date("2026-10-08T00:00:00.000Z");
  const clock = () => now;
  const proofs = new TerminalProofs(hive.db, clock);
  const store = new TerminalStore(hive.db, clock);
  const session = store.create({
    project: "app", machineId: "runner@mini", creator: "alice", browserSession: "b-alice", checkoutRef: "repo", reason: "", idempotencyKey: crypto.randomUUID(),
  });
  return { hive, proofs, session, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
};
const create: TerminalStepUpContext = { account: "alice", browserSession: "b-alice", machineId: "runner@mini", project: "app", operation: "create", sessionId: null };

describe("69c terminal step-up proofs", () => {
  it("are spent once, and only in the context they were issued for", () => {
    const { hive, proofs, session } = setup();
    const { stepUpId } = proofs.issueStepUp(create, "password", new Date());
    assert.match(stepUpId, /^hivestep_[A-Za-z0-9_-]{43}$/);
    const elsewhere: Array<[string, Partial<TerminalStepUpContext>]> = [
      ["another account", { account: "mallory" }],
      ["another browser session of the same person", { browserSession: "b-alice-2" }],
      ["another machine", { machineId: "runner@other" }],
      ["another project", { project: "billing" }],
      ["another operation", { operation: "attach", sessionId: session.id }],
      ["create naming a session", { sessionId: session.id }],
    ];
    for (const [who, change] of elsewhere) assert.equal(proofs.consumeStepUp(stepUpId, { ...create, ...change }), false, who);
    assert.equal(proofs.consumeStepUp(stepUpId, create), true, "a use elsewhere did not spend it");
    assert.equal(proofs.consumeStepUp(stepUpId, create), false, "replay");
    assert.equal(proofs.consumeStepUp("hivestep_" + "a".repeat(43), create), false, "never issued");
    // Only the hash is kept: the database alone does not hand out a working proof.
    const stored = hive.db.prepare("SELECT * FROM terminal_stepups").all();
    assert.ok(!JSON.stringify(stored).includes(stepUpId));
    hive.close();
  });

  it("binds attach and recording to one session", () => {
    const { hive, proofs, session } = setup();
    const attach = { ...create, operation: "attach" as const, sessionId: session.id };
    const { stepUpId } = proofs.issueStepUp(attach, "oidc", new Date());
    assert.equal(proofs.consumeStepUp(stepUpId, { ...attach, sessionId: crypto.randomUUID() }), false);
    assert.equal(proofs.consumeStepUp(stepUpId, { ...attach, operation: "recording" }), false);
    assert.equal(proofs.consumeStepUp(stepUpId, attach), true);
    hive.close();
  });

  it("expire after five minutes", () => {
    const { hive, proofs, advance } = setup();
    const a = proofs.issueStepUp(create, "password", new Date());
    const b = proofs.issueStepUp(create, "password", new Date());
    advance(TERMINAL_LIMITS.stepUpTtlMs - 1);
    assert.equal(proofs.consumeStepUp(a.stepUpId, create), true);
    advance(1);
    assert.equal(proofs.consumeStepUp(b.stepUpId, create), false);
    hive.close();
  });

  it("go when their browser session or account signs out", () => {
    const { hive, proofs } = setup();
    const a = proofs.issueStepUp(create, "password", new Date());
    const b = proofs.issueStepUp({ ...create, browserSession: "b-alice-2" }, "password", new Date());
    proofs.forgetBrowserSession("b-alice");
    assert.equal(proofs.consumeStepUp(a.stepUpId, create), false);
    proofs.forgetAccount("alice");
    assert.equal(proofs.consumeStepUp(b.stepUpId, { ...create, browserSession: "b-alice-2" }), false);
    hive.close();
  });
});

describe("69c terminal socket tickets", () => {
  it("are redeemed once, by the person and browser session they were issued to, within 30 seconds", () => {
    const { hive, proofs, session, advance } = setup();
    const issue = () => proofs.issueTicket({ sessionId: session.id, account: "alice", browserSession: "b-alice", epoch: 3 });
    const t = issue();
    assert.match(t.ticket, /^hivetkt_[A-Za-z0-9_-]{43}$/);
    assert.equal(proofs.redeemTicket(t.ticket, { account: "alice", browserSession: "b-other" }), null);
    assert.equal(proofs.redeemTicket(t.ticket, { account: "mallory", browserSession: "b-alice" }), null);
    assert.deepEqual(proofs.redeemTicket(t.ticket, { account: "alice", browserSession: "b-alice" }), { sessionId: session.id, epoch: 3 });
    assert.equal(proofs.redeemTicket(t.ticket, { account: "alice", browserSession: "b-alice" }), null, "replay");
    const late = issue();
    advance(TERMINAL_LIMITS.ticketTtlMs);
    assert.equal(proofs.redeemTicket(late.ticket, { account: "alice", browserSession: "b-alice" }), null, "expired");
    const ended = issue();
    proofs.forgetSession(session.id);
    assert.equal(proofs.redeemTicket(ended.ticket, { account: "alice", browserSession: "b-alice" }), null, "its session ended");
    hive.close();
  });

  it("are hidden by the secret filter, as proofs are", () => {
    const { hive, proofs, session } = setup();
    assert.equal(findSecret(proofs.issueTicket({ sessionId: session.id, account: "alice", browserSession: "b", epoch: 0 }).ticket), "xDev Hive token");
    assert.equal(findSecret(proofs.issueStepUp(create, "password", new Date()).stepUpId), "xDev Hive token");
    hive.close();
  });
});

describe("69c step-up request", () => {
  it("names a session exactly for attach and recording, and a password exactly for the password method", () => {
    const ok = { method: "password", operation: "create", project: "app", machineId: "runner@mini", password: "x" };
    assert.ok(terminalStepUpInput.safeParse(ok).success);
    assert.ok(terminalStepUpInput.safeParse({ ...ok, operation: "attach", sessionId: crypto.randomUUID() }).success);
    for (const bad of [
      { operation: "attach" },
      { sessionId: crypto.randomUUID() },
      { method: "oidc" },
      { password: undefined },
      { operation: "exec" },
      { command: "id" },
    ]) assert.equal(terminalStepUpInput.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
    assert.ok(terminalStepUpInput.safeParse({ method: "oidc", operation: "create", project: "app", machineId: "runner@mini" }).success);
  });
});
