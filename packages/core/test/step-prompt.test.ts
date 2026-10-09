import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fillStepPromptVars, HiveError, promptPreview, PROMPT_LAYERS, PROMPT_ROLES, STEP_PROMPT_MAX, STEP_PROMPT_VARS, stepPromptBlock, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

// Roadmap 72i: a prompt per SDLC step and project, in versions; contextEdit saves it, view reads it, a flow's run gets it.

const admin: Actor = { name: "duy", role: "admin" };
const lead: Actor = { name: "lan", role: "member", access: { projects: { app: "manage" } } };
const dev: Actor = { name: "minh", role: "member", access: { projects: { app: "contribute" } } };
const outsider: Actor = { name: "khoa", role: "member", access: { projects: { site: "manage" } } };

async function hub() {
  const hive = new SqliteHive(":memory:");
  await hive.call("tasks.create", { id: "T-1", project: "app", title: "One" }, admin);
  await hive.call("tasks.create", { id: "S-1", project: "site", title: "Landing" }, admin);
  return hive;
}

async function refusal(call: Promise<unknown>): Promise<string | undefined> {
  try {
    await call;
  } catch (err) {
    assert.ok(err instanceof HiveError, String(err));
    return err.key ?? err.code;
  }
  assert.fail("expected the call to fail");
}

describe("step prompts (roadmap 72i)", () => {
  it("lists every step, empty at version 0 until it is saved", async () => {
    const hive = await hub();
    const all = await hive.call("sdlc.prompts", { project: "app" }, dev);
    assert.deepEqual(all.map((p) => p.step), ["spec", "plan", "tasks", "dispatch", "review", "fix", "test", "merge", "release"]);
    assert.ok(all.every((p) => p.version === 0 && p.text === "" && p.updatedBy === null));
    hive.close();
  });

  it("keeps each save as a version with who and when, and refuses a save over a newer one", async () => {
    const hive = await hub();
    const one = await hive.call("sdlc.setPrompt", { project: "app", step: "review", text: "  Check the migrations first.  ", baseVersion: 0 }, lead);
    assert.deepEqual([one.version, one.text, one.updatedBy], [1, "Check the migrations first.", "lan"]);
    await hive.call("sdlc.setPrompt", { project: "app", step: "review", text: "Check the migrations, then the API.", baseVersion: 1 }, admin);
    assert.equal(await refusal(hive.call("sdlc.setPrompt", { project: "app", step: "review", text: "stale", baseVersion: 1 }, lead)), "errors.promptVersionConflict");
    const history = await hive.call("sdlc.promptHistory", { project: "app", step: "review" }, dev);
    assert.deepEqual(history.map((v) => [v.version, v.by, v.text]), [[2, "duy", "Check the migrations, then the API."], [1, "lan", "Check the migrations first."]]);
    // The same text again is not a change.
    const same = await hive.call("sdlc.setPrompt", { project: "app", step: "review", text: "Check the migrations, then the API.", baseVersion: 2 }, lead);
    assert.equal(same.version, 2);
    // Emptying is a version too, so who cleared it is on record; the other steps and projects are untouched.
    const cleared = await hive.call("sdlc.setPrompt", { project: "app", step: "review", text: "", baseVersion: 2 }, lead);
    assert.deepEqual([cleared.version, cleared.text], [3, ""]);
    assert.equal((await hive.call("sdlc.prompts", { project: "app" }, lead)).find((p) => p.step === "fix")?.version, 0);
    assert.equal((await hive.call("sdlc.prompts", { project: "site" }, outsider)).find((p) => p.step === "review")?.version, 0);
    hive.close();
  });

  it("takes contextEdit to save and view to read", async () => {
    const hive = await hub();
    assert.equal(await refusal(hive.call("sdlc.setPrompt", { project: "app", step: "fix", text: "x", baseVersion: 0 }, dev)), "errors.need.contextEdit");
    // Not even a view: the project is not there for them.
    assert.equal(await refusal(hive.call("sdlc.setPrompt", { project: "app", step: "fix", text: "x", baseVersion: 0 }, outsider)), "errors.notFound");
    await hive.call("sdlc.setPrompt", { project: "app", step: "fix", text: "x", baseVersion: 0 }, lead);
    assert.equal((await hive.call("sdlc.prompts", { project: "app" }, dev)).find((p) => p.step === "fix")?.text, "x");
    assert.ok(await refusal(hive.call("sdlc.prompts", { project: "app" }, outsider)));
    assert.ok(await refusal(hive.call("sdlc.promptHistory", { project: "app", step: "fix" }, outsider)));
    hive.close();
  });

  it("refuses a secret, hidden characters and a text past the cap", async () => {
    const hive = await hub();
    const save = (text: string) => hive.call("sdlc.setPrompt", { project: "app", step: "spec", text, baseVersion: 0 }, lead);
    assert.ok(await refusal(save("token ghp_" + "a".repeat(36))));
    assert.ok(await refusal(save("looks fine‮evil")));
    assert.ok(await refusal(save("x".repeat(STEP_PROMPT_MAX + 1))));
    assert.equal((await hive.call("sdlc.prompts", { project: "app" }, lead)).find((p) => p.step === "spec")?.version, 0);
    hive.close();
  });

  it("gives a run the prompt of the step it is in, and nothing outside a flow", async () => {
    const hive = await hub();
    for (const step of ["spec", "plan", "dispatch", "fix", "review"] as const) {
      await hive.call("sdlc.setPrompt", { project: "app", step, text: `prompt of ${step}`, baseVersion: 0 }, lead);
    }
    const ask = (taskId: string, role: "implement" | "review" | "plan") => hive.call("sdlc.runPrompt", { project: "app", taskId, role }, lead);
    assert.equal(await ask("T-1", "implement"), null, "a task outside a flow");
    const flow = hive.db.prepare(`INSERT INTO sdlc_flows(task_id, project, step, state, machine_id, created_by, created_at, updated_at)
      VALUES (?, 'app', ?, 'running', 'm', 'duy', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`);
    flow.run("T-1", "specify");
    assert.deepEqual(await ask("T-1", "implement"), { step: "spec", version: 1, text: "prompt of spec" });
    hive.db.prepare("UPDATE sdlc_flows SET step = 'plan' WHERE task_id = 'T-1'").run();
    assert.equal((await ask("T-1", "implement"))?.step, "plan");
    // tasks has no prompt saved: the run gets none.
    hive.db.prepare("UPDATE sdlc_flows SET step = 'tasks' WHERE task_id = 'T-1'").run();
    assert.equal(await ask("T-1", "implement"), null);

    await hive.call("tasks.create", { id: "T-2", project: "app", title: "Two" }, admin);
    hive.db.prepare("INSERT INTO sdlc_flow_tasks(task_id, flow_task, project, stage, created_by, updated_at) VALUES ('T-2', 'T-1', 'app', 'build', 'duy', '2026-10-01T00:00:00.000Z')").run();
    assert.equal((await ask("T-2", "implement"))?.step, "dispatch");
    assert.equal((await ask("T-2", "review"))?.step, "review");
    assert.equal(await ask("T-2", "plan"), null);
    hive.db.prepare("UPDATE sdlc_flow_tasks SET stage = 'fix' WHERE task_id = 'T-2'").run();
    assert.equal((await ask("T-2", "implement"))?.step, "fix");
    // Another project's caller never reads it.
    assert.ok(await refusal(hive.call("sdlc.runPrompt", { project: "app", taskId: "T-2", role: "implement" }, outsider)));
    hive.close();
  });
});

describe("stepPromptBlock", () => {
  it("wraps the text, clips it, and skips what looks like a secret", () => {
    assert.equal(stepPromptBlock(null), null);
    assert.equal(stepPromptBlock({ step: "fix", version: 1, text: "   " }), null);
    const ok = stepPromptBlock({ step: "fix", version: 3, text: "Keep it small." });
    assert.ok(ok && "lines" in ok && ok.lines.join("\n").includes("fix step (version 3)") && ok.lines.includes("Keep it small."));
    const long = stepPromptBlock({ step: "fix", version: 1, text: "y".repeat(STEP_PROMPT_MAX + 500) });
    assert.ok(long && "lines" in long && long.lines[2]!.endsWith("…(cut)") && long.lines[2]!.length < STEP_PROMPT_MAX + 20);
    const secret = stepPromptBlock({ step: "fix", version: 1, text: "use ghp_" + "b".repeat(36) });
    assert.ok(secret && "skipped" in secret && !JSON.stringify(secret).includes("ghp_b"));
  });
});

describe("the layers of a run's prompt", () => {
  const vars = { taskId: "T-1", taskTitle: "Add {service}", service: "app", branch: "ai/T-1" };
  it("fills the four variables and leaves other braces as written", () => {
    assert.equal(fillStepPromptVars("{task.id} {task.title} {service} {branch} {x} {task.id", vars), "T-1 Add {service} app ai/T-1 {x} {task.id");
    for (const v of STEP_PROMPT_VARS) assert.notEqual(fillStepPromptVars(v, vars), v, v);
    // The cap is on what the manager wrote, so a long title does not eat into it.
    const block = stepPromptBlock({ step: "fix", version: 1, text: "{task.title}" }, { ...vars, taskTitle: "t".repeat(3000) });
    assert.ok(block && "lines" in block && block.lines[2]!.length === 3000);
  });
  it("lists the layers in the runner's order, with the step's own only where a run reads it", () => {
    const layers = promptPreview({ role: "implement", project: "app", task: { id: "T-1", title: "x", note: null }, branch: "ai/T-1", step: { step: "spec", version: 1, text: "Hi {task.id}" } })!;
    assert.deepEqual(layers.map((l) => l.id), [...PROMPT_LAYERS]);
    assert.ok(layers.find((l) => l.id === "step")!.text!.includes("Hi T-1"));
    assert.equal(layers.find((l) => l.id === "repo")!.text, null);
    const held = promptPreview({ role: "review", project: "app", task: { id: "T-1", title: "x", note: null }, branch: "b", step: { step: "review", version: 1, text: `ghp_${"a".repeat(36)}` } })!.find((l) => l.id === "step")!;
    assert.ok(held.skipped && held.text === "" && !JSON.stringify(held).includes("ghp_a"));
    assert.equal(promptPreview({ role: "research", project: "app", task: { id: "T-1", title: "x", note: null }, branch: "b", step: null }), null);
    assert.deepEqual(PROMPT_ROLES.flatMap((r) => r.steps).sort(), ["dispatch", "fix", "merge", "plan", "release", "review", "spec", "tasks", "test"], "every step belongs to one role");
  });
});
