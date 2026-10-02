import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, nextSpecTaskId, parseSpecTasks, planSpecTasks, specNextStep, specRunTask, specStepInstructions, specTaskPrefix, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machine: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const viewer: Actor = { name: "khoa", role: "member", account: "khoa", access: { projects: { app: "viewer" } } };

const TASKS = `# Tasks: Đăng nhập SSO

<!-- - [ ] T999 an example in a comment -->

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Create project structure
- [ ] T002 [P] Configure linting

## Phase 2: Foundational (Blocking Prerequisites)

- [ ] T003 Setup database schema
- [ ] T004 [P] Implement auth framework
- [ ] T005 [P] Setup API routing

## Phase 3: User Story 1 - Đăng nhập (Priority: P1) 🎯 MVP

### Tests for User Story 1

- [ ] T006 [P] [US1] Contract test in tests/contract/test_login.py
- [ ] T007 [US1] Implement LoginService in src/services/login.py (depends on T006, T009)

## Phase 4: User Story 2 - Đăng xuất (Priority: P2)

- [ ] T008 [P] [US2] Logout endpoint in src/api/logout.py
- [ ] T009 [US2] Session store in src/services/session.py

## Phase 5: Polish & Cross-Cutting Concerns

- [ ] T010 [P] Documentation updates in docs/

\`\`\`bash
- [ ] T998 not a task: inside a code block
\`\`\`
`;

describe("tasks.md into board tasks (roadmap 20c)", () => {
  it("reads the task lines with their phase, [P], story and named dependencies, not the examples", () => {
    const lines = parseSpecTasks(TASKS);
    assert.deepEqual(lines.map((l) => l.code), ["T001", "T002", "T003", "T004", "T005", "T006", "T007", "T008", "T009", "T010"]);
    const t7 = lines.find((l) => l.code === "T007")!;
    assert.deepEqual([t7.story, t7.parallel, t7.named, t7.phaseKind, t7.text], ["US1", false, ["T006", "T009"], "story", "Implement LoginService in src/services/login.py (depends on T006, T009)"]);
    assert.deepEqual([lines[0]!.done, lines[1]!.parallel, lines[9]!.phaseKind], [true, true, "polish"]);
  });

  it("orders them as the template does: steps in a phase, Setup → Foundational → stories side by side → Polish", () => {
    const { tasks } = planSpecTasks(TASKS, "S001");
    const deps = Object.fromEntries(tasks.map((t) => [t.code, t.dependsOn.map((d) => d.slice(5))]));
    assert.deepEqual(deps.T002, [], "T001 is done: nothing to wait for");
    assert.deepEqual(deps.T003, ["T002"]);
    assert.deepEqual(deps.T004, ["T003"]);
    assert.deepEqual(deps.T005, ["T003"], "a run of [P] tasks is one step");
    assert.deepEqual(deps.T006, ["T004", "T005"], "a story waits for Foundational's last step");
    assert.deepEqual(deps.T007, ["T006", "T009"], "plus what it names, even in another story");
    assert.deepEqual(deps.T008, ["T004", "T005"], "stories do not wait for each other");
    assert.deepEqual(deps.T010, ["T007", "T009"], "Polish waits for every story");
    assert.equal(tasks.find((t) => t.code === "T007")!.title, "T007 [US1] Implement LoginService in src/services/login.py (depends on T006, T009)");
    assert.equal(specTaskPrefix("001-dang-nhap-sso"), "S001");
  });

  it("creates the board tasks once, with their order and a note, and plans without writing on a dry run", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("specs.push", { project: "app", features: [{ dir: "001-dang-nhap-sso", branch: "", commit: "abc1234", files: { spec: "# Feature Specification: SSO\n", plan: "# Plan\n", tasks: TASKS } }] }, machine);
    const input = { project: "app", dir: "001-dang-nhap-sso", branch: "" };
    const dry = await hive.call("specs.importTasks", { ...input, dryRun: true }, viewer);
    assert.equal(dry.tasks.length, 9, "T001 is done");
    assert.deepEqual(dry.created, []);
    assert.deepEqual(await hive.call("tasks.list", { project: "app" }, admin), []);
    await assert.rejects(hive.call("specs.importTasks", input, viewer), (e: unknown) => e instanceof HiveError && e.code === "forbidden");

    const made = await hive.call("specs.importTasks", input, admin);
    assert.equal(made.created.length, 9);
    const t7 = (await hive.call("tasks.list", { project: "app" }, admin)).find((t) => t.id === "S001-T007")!;
    assert.deepEqual([t7.dependsOn, t7.waitingOn.length, t7.note], [["S001-T006", "S001-T009"], 2, "Spec Kit · specs/001-dang-nhap-sso/tasks.md · User Story 1 - Đăng nhập (Priority: P1) 🎯 MVP"]);
    assert.deepEqual((await hive.call("tasks.next", { project: "app", limit: 20 }, admin)).map((t) => t.id), ["S001-T002"]);
    // Again: everything is there already.
    const again = await hive.call("specs.importTasks", { ...input, dryRun: true }, admin);
    assert.ok(again.tasks.every((t) => t.exists));
    assert.deepEqual((await hive.call("specs.importTasks", input, admin)).created, []);
    assert.equal((await hive.call("admin.audit", { limit: 10 }, admin)).filter((e) => e.action === "specs.importTasks").length, 1);
  });

  it("refuses a feature without tasks.md, and an id taken by another project", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("specs.push", { project: "app", features: [{ dir: "002-x", branch: "", commit: "abc1234", files: { spec: "# X\n", plan: null, tasks: null } }] }, machine);
    await assert.rejects(hive.call("specs.importTasks", { project: "app", dir: "002-x", branch: "" }, admin), (e: unknown) => e instanceof HiveError && e.key === "errors.specNoTasks");
    await hive.call("specs.push", { project: "app", features: [{ dir: "003-y", branch: "", commit: "abc1234", files: { spec: "# Y\n", plan: "# P\n", tasks: "## Phase 1: Setup\n- [ ] T001 a\n" } }] }, machine);
    await hive.call("tasks.create", { id: "S003-T001", project: "site", title: "taken" }, admin);
    await assert.rejects(hive.call("specs.importTasks", { project: "app", dir: "003-y", branch: "" }, admin), (e: unknown) => e instanceof HiveError && e.key === "errors.taskExists");
  });
});

describe("runs for the Spec Kit steps (roadmap 20d)", () => {
  it("moves a feature on one step at a time", () => {
    assert.deepEqual(["specify", "plan", "tasks", "implement", "done"].map((s) => specNextStep(s as never)), ["plan", "tasks", null, null, null]);
  });

  it("keeps a feature on its run's branch in that task, gives one on the target branch its own, and none to a hand-made branch", () => {
    const has = (id: string) => ["SPEC-1", "S001-PLAN"].includes(id);
    assert.deepEqual(specRunTask({ dir: "001-sso", branch: "ai/SPEC-1", title: "SSO" }, "plan", has), { taskId: "SPEC-1", title: null });
    assert.equal(specRunTask({ dir: "001-sso", branch: "ai/GONE-1", title: "SSO" }, "plan", has), null);
    assert.deepEqual(specRunTask({ dir: "001-sso", branch: "", title: "SSO" }, "plan", has), { taskId: "S001-PLAN", title: null });
    assert.deepEqual(specRunTask({ dir: "001-sso", branch: "", title: "SSO" }, "tasks", has), { taskId: "S001-TASKS", title: "Tasks: SSO" });
    assert.equal(specRunTask({ dir: "002-x", branch: "002-x", title: "X" }, "plan", has), null);
    assert.equal(nextSpecTaskId(["T-1", "SPEC-2", "SPEC-10", "SPEC-x"]), "SPEC-11");
    assert.equal(nextSpecTaskId([]), "SPEC-1");
  });

  it("points the agent at the step's skill, the feature's folder and the person's words, and stops it at the spec files", () => {
    const plan = specStepInstructions("plan", { dir: "001-sso", input: "Dùng PostgreSQL." });
    assert.match(plan, /\.claude\/skills\/speckit-plan\/SKILL\.md \(Codex: \.agents\/skills\/speckit-plan\/SKILL\.md\)/);
    assert.match(plan, /SPECIFY_FEATURE_DIRECTORY=specs\/001-sso/);
    assert.match(plan, /\nDùng PostgreSQL\.\n/);
    assert.match(plan, /Do not write code/);
    const spec = specStepInstructions("specify", { input: "Đăng nhập bằng SSO" });
    assert.match(spec, /for a new feature/);
    assert.doesNotMatch(spec, /SPECIFY_FEATURE_DIRECTORY/);
    assert.ok(specStepInstructions("specify", { input: "x".repeat(3000) }).length <= 4000, "fits a run's instructions");
  });
});
