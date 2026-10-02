import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HiveError, specStage, specTasks, specTitle, type Actor } from "#core/index.ts";
import { SqliteHive } from "#core/node.ts";

const admin: Actor = { name: "duy", role: "admin" };
const machineA: Actor = { name: "runner.duy-mbp@duy-mbp", role: "agent" };
const machineB: Actor = { name: "runner.lan-mbp@lan-mbp", role: "agent" };
const lan: Actor = { name: "lan", role: "member", access: { projects: { app: "view" } } };

const files = (over: Partial<Record<"spec" | "plan" | "tasks", string | null>> = {}) => ({
  spec: "# Feature Specification: Đăng nhập SSO\n\nNội dung.",
  plan: null,
  tasks: null,
  ...over,
});
const feature = (dir: string, branch = "", over: Parameters<typeof files>[0] = {}) => ({ dir, branch, commit: "abc1234", files: files(over) });

describe("Spec Kit files", () => {
  it("takes the title from spec.md's first heading, else the folder", () => {
    assert.equal(specTitle("intro\n# Feature Specification: Đăng nhập SSO\n# Other", "001-sso"), "Đăng nhập SSO");
    assert.equal(specTitle("# Xuất báo cáo", "002-x"), "Xuất báo cáo");
    assert.equal(specTitle("no heading", "003-y"), "003-y");
    assert.equal(specTitle(null, "004-z"), "004-z");
  });

  it("counts task lines with -, *, [x] and [X]", () => {
    const tasks = ["## Phase 1: Setup", "- [x] T001 Init", "* [X] T002 [P] Lint", "- [ ] T003 [US1] Page, src/a.ts", "  - [ ] T004 nested", "- not a task", "[x] no bullet"].join("\n");
    assert.deepEqual(specTasks(tasks), { done: 2, total: 4 });
    assert.deepEqual(specTasks(null), { done: 0, total: 0 });
  });

  it("tells the stage from which files there are and how many tasks are done", () => {
    assert.equal(specStage({ spec: "# A", plan: null, tasks: null }), "specify");
    assert.equal(specStage({ spec: "# A", plan: "# Plan", tasks: null }), "plan");
    assert.equal(specStage({ spec: "# A", plan: "# Plan", tasks: "- [ ] T001 a\n- [ ] T002 b" }), "tasks");
    assert.equal(specStage({ spec: "# A", plan: "# Plan", tasks: "- [x] T001 a\n- [ ] T002 b" }), "implement");
    assert.equal(specStage({ spec: "# A", plan: "# Plan", tasks: "- [x] T001 a\n- [X] T002 b" }), "done");
  });
});

describe("specs on the hub", () => {
  it("keeps the newest push, replaces only the pushing machine's rows", async () => {
    const hive = new SqliteHive(":memory:");
    assert.deepEqual(
      await hive.call("specs.push", { project: "app", features: [feature("001-sso"), feature("002-report", "002-report", { plan: "# Plan" })] }, machineA),
      { stored: 2, removed: 0 },
    );
    await hive.call("specs.push", { project: "app", features: [feature("003-lan", "ai/T-9")] }, machineB);
    // 002-report merged: machine A no longer sends it; B's row stays.
    assert.deepEqual(
      await hive.call("specs.push", { project: "app", features: [feature("001-sso", "", { plan: "# Plan", tasks: "- [x] T001 a\n- [ ] T002 b" })] }, machineA),
      { stored: 1, removed: 1 },
    );
    const list = await hive.call("specs.list", { project: "app" }, admin);
    assert.deepEqual(list.map((f) => [f.dir, f.branch, f.machine]), [["001-sso", "", machineA.name], ["003-lan", "ai/T-9", machineB.name]]);
    const sso = list[0]!;
    assert.deepEqual([sso.title, sso.stage, sso.tasksDone, sso.tasksTotal, sso.commit], ["Đăng nhập SSO", "implement", 1, 2, "abc1234"]);
    assert.equal("files" in sso, false, "no file contents in the list");
    const one = await hive.call("specs.get", { project: "app", dir: "001-sso", branch: "" }, admin);
    assert.match(one?.files.tasks ?? "", /T002/);
    assert.equal(await hive.call("specs.get", { project: "app", dir: "002-report", branch: "002-report" }, admin), null);
  });

  it("hides hidden characters and secret-looking lines", async () => {
    const hive = new SqliteHive(":memory:");
    const token = `glpat-${"x".repeat(24)}`;
    await hive.call("specs.push", { project: "app", features: [feature("001-sso", "", { spec: `# SSO${String.fromCodePoint(0x202e)}\nexport GITLAB_TOKEN=${token}` })] }, machineA);
    const one = (await hive.call("specs.get", { project: "app", dir: "001-sso", branch: "" }, admin))!;
    assert.equal(one.files.spec, "# SSO\n(line hidden: it looked like a GitLab token)");
    assert.equal(one.title, "SSO");
  });

  it("refuses more than 100 features in one push", async () => {
    const hive = new SqliteHive(":memory:");
    const many = Array.from({ length: 101 }, (_, n) => feature(`${String(n).padStart(3, "0")}-f`));
    await assert.rejects(hive.call("specs.push", { project: "app", features: many }, machineA), (e: unknown) => e instanceof HiveError && e.code === "bad_request");
  });

  it("shows each person only the projects they see", async () => {
    const hive = new SqliteHive(":memory:");
    await hive.call("specs.push", { project: "app", features: [feature("001-sso")] }, machineA);
    await hive.call("specs.push", { project: "billing", features: [feature("001-invoice")] }, machineA);
    assert.equal((await hive.call("specs.list", {}, admin)).length, 2);
    assert.deepEqual((await hive.call("specs.list", {}, lan)).map((f) => f.project), ["app"]);
    assert.equal(await hive.call("specs.get", { project: "billing", dir: "001-invoice", branch: "" }, lan), null, "billing is not hers");
    await assert.rejects(hive.call("specs.list", { project: "billing" }, lan), (e: unknown) => e instanceof HiveError && e.code === "not_found");
    await assert.rejects(
      hive.call("specs.push", { project: "app", features: [] }, { ...lan, role: "viewer" }),
      (e: unknown) => e instanceof HiveError && e.code === "forbidden",
    );
  });
});
