import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Permission, SdlcFlow, SdlcFlowTask, SdlcGateRecord, SpecFeature } from "@xdev-hive/core";
import {
  checkedCount,
  checksKey,
  featureChecks,
  featureHref,
  featureItems,
  featureTaskIds,
  findFeature,
  flowColumn,
  gateTab,
  mayDecide,
  noteRequired,
  ownsTask,
  readChecks,
  writeChecks,
} from "#ui/lib/features.ts";
import { hasKey } from "#ui/i18n/translate.ts";

const AT = "2026-10-06T08:00:00.000Z";
const gate = (over: Partial<SdlcGateRecord> = {}): SdlcGateRecord => ({ id: 1, project: "app", taskId: "SPEC-1", gate: "spec", mode: "human", status: "waiting", decidedBy: null, note: null, createdAt: AT, decidedAt: null, ...over });
const flow = (over: Partial<SdlcFlow> = {}): SdlcFlow => ({
  taskId: "SPEC-1",
  project: "app",
  dir: "001-qr",
  step: "specify",
  state: "running",
  machineId: "runner.m@x",
  machine: "m",
  profileId: null,
  gate: null,
  note: null,
  createdBy: "lan",
  createdAt: AT,
  updatedAt: AT,
  ...over,
});
const spec = (over: Partial<SpecFeature> = {}): SpecFeature => ({ project: "app", dir: "001-qr", branch: "ai/SPEC-1", title: "Thanh toán QR", stage: "specify", tasksDone: 0, tasksTotal: 0, commit: "abc", machine: "m", pushedAt: AT, ...over });
const task = (stage: SdlcFlowTask["stage"], over: Partial<SdlcFlowTask> = {}): SdlcFlowTask => ({ taskId: `S001-T${stage}`, flowTask: "SPEC-1", project: "app", stage, gate: null, fixRounds: 0, machineId: null, runId: null, note: null, updatedAt: AT, ...over });

describe("feature board (roadmap 49d)", () => {
  it("puts a flow in the column of its Spec Kit step, then where its tasks are", () => {
    assert.equal(flowColumn(flow({ step: "specify" }), []), "spec");
    assert.equal(flowColumn(flow({ step: "plan", state: "gate" }), []), "plan");
    assert.equal(flowColumn(flow({ step: "tasks" }), []), "tasks");
    assert.equal(flowColumn(flow({ step: "import", state: "gate" }), []), "tasks", "the dispatch gate still decides on the tasks");
    assert.equal(flowColumn(flow({ step: "dispatch", state: "done" }), [task("build"), task("review")]), "doing");
    assert.equal(flowColumn(flow({ step: "dispatch", state: "done" }), [task("gate"), task("done")]), "review");
    assert.equal(flowColumn(flow({ step: "dispatch", state: "done" }), [task("done"), task("done")]), "done");
    assert.equal(flowColumn(flow({ step: "dispatch", state: "done" }), []), "done");
  });

  it("makes one card per flow with the folder it wrote, and one per other folder", () => {
    const items = featureItems(
      [flow({ state: "gate", gate: gate() })],
      [spec(), spec({ dir: "002-hoan-tien", branch: "", title: "Hoàn tiền", stage: "implement", pushedAt: "2026-10-05T00:00:00.000Z" })],
      [],
      [{ project: "app", id: "SPEC-1", title: "Spec: thanh toán" }],
    );
    assert.deepEqual(items.map((x) => [x.key, x.column, x.title]), [
      ["flow:app:SPEC-1", "spec", "Thanh toán QR"],
      ["spec:app:002-hoan-tien:", "doing", "Hoàn tiền"],
    ]);
    assert.equal(items[0]!.waiting.length, 1);
    assert.equal(items[0]!.spec?.branch, "ai/SPEC-1");
  });

  it("names a flow by its task until its folder is pushed, and takes the target branch's folder once merged", () => {
    const [writing] = featureItems([flow({ dir: null })], [], [], [{ project: "app", id: "SPEC-1", title: "Spec: thanh toán" }]);
    assert.equal(writing!.title, "thanh toán");
    const [merged] = featureItems([flow()], [spec({ branch: "" })], []);
    assert.equal(merged!.spec?.branch, "");
  });

  it("counts the gates of the flow's tasks as waiting too", () => {
    const [item] = featureItems([flow({ step: "dispatch", state: "done" })], [], [task("gate", { gate: gate({ id: 7, gate: "review", taskId: "S001-T1" }) }), task("gate", { taskId: "S001-T2", gate: gate({ id: 8, status: "passed" }) })]);
    assert.deepEqual(item!.waiting.map((g) => g.id), [7]);
    assert.equal(item!.column, "review");
  });

  it("says who may decide a gate exactly as the hub checks sdlc.decide", () => {
    const grant = (perms: Permission[]) => (_p: string, need: Permission) => perms.includes(need);
    const reviewer = grant(["view", "codeReview"]);
    const dispatcher = grant(["view", "runDispatch"]);
    assert.equal(mayDecide(reviewer, gate({ gate: "review" })), true);
    assert.equal(mayDecide(reviewer, gate({ gate: "merge" })), true);
    assert.equal(mayDecide(reviewer, gate({ gate: "spec" })), false, "Chờ bạn is not shown to a reviewer at a spec gate");
    assert.equal(mayDecide(dispatcher, gate({ gate: "spec" })), true);
    assert.equal(mayDecide(dispatcher, gate({ gate: "tasks" })), false, "passing tasks imports them: taskManage too");
    assert.equal(mayDecide(grant(["runDispatch", "taskManage"]), gate({ gate: "tasks" })), true);
  });

  it("puts a gate's buttons on the tab it decides on, and asks for a note where the agent redoes the step", () => {
    assert.equal(gateTab(gate({ gate: "spec" })), "spec");
    assert.equal(gateTab(gate({ gate: "plan" })), "plan");
    assert.equal(gateTab(gate({ gate: "dispatch" })), "tasks");
    assert.equal(gateTab(gate({ gate: "review" })), "tasks");
    assert.equal(noteRequired(gate({ gate: "spec" })), true);
    assert.equal(noteRequired(gate({ gate: "merge" })), false);
  });

  it("links a card and finds it again, from its own address or the Spec page's", () => {
    const items = featureItems([flow()], [spec(), spec({ dir: "002-x", branch: "", title: "X" })], []);
    assert.equal(featureHref(items[0]!), "#/features?project=app&flow=SPEC-1");
    assert.equal(featureHref(items[1]!), "#/features?project=app&dir=002-x&branch=");
    assert.equal(findFeature(items, { project: "app", flow: "SPEC-1", dir: null, branch: null })?.key, "flow:app:SPEC-1");
    assert.equal(findFeature(items, { project: "app", flow: null, dir: "001-qr", branch: "ai/SPEC-1" })?.key, "flow:app:SPEC-1", "a flow's folder opens the flow");
    assert.equal(findFeature(items, { project: "app", flow: null, dir: "002-x", branch: null })?.key, "spec:app:002-x:");
    assert.equal(findFeature(items, { project: "other", flow: "SPEC-1", dir: null, branch: null }), null);
  });

  it("owns the runs and gates of the flow, its tasks, its branch's task and the folder's S001-… tasks", () => {
    const [item] = featureItems([flow()], [spec()], [task("build", { taskId: "S001-T001" })]);
    const owned = featureTaskIds(item!);
    assert.ok(ownsTask(owned, "SPEC-1"));
    assert.ok(ownsTask(owned, "S001-T001"));
    assert.ok(ownsTask(owned, "S001-PLAN"));
    assert.ok(!ownsTask(owned, "S002-T001"));
    assert.ok(!ownsTask(owned, "PAY-1"));
  });

  it("has every column and tab named in Vietnamese and English", () => {
    for (const k of ["spec", "plan", "tasks", "doing", "review", "done"]) assert.ok(hasKey(`features.column.${k}`), k);
    for (const k of ["spec", "plan", "tasks", "checks", "runs", "gates"]) assert.ok(hasKey(`features.tab.${k}`), k);
  });
});

describe("Kiểm thử checklist (roadmap 49d)", () => {
  const SPEC = [
    "# Feature Specification: Xuất hoá đơn",
    "",
    "## User Scenarios & Testing *(mandatory)*",
    "",
    "### User Story 1 - Kế toán xuất hoá đơn (Priority: P1)",
    "",
    "**Why this priority**: tiền vào.",
    "",
    "**Independent Test**: xuất một hoá đơn.",
    "",
    "**Acceptance Scenarios**:",
    "",
    "1. **Given** một đơn đã trả, **When** bấm Xuất, **Then** có mã tra cứu",
    "2. **Given** đơn chưa trả, **When** bấm Xuất, **Then** nút bị khoá",
    "",
    "### Edge Cases",
    "",
    "- Mất mạng giữa chừng?",
    "",
    "## Requirements",
    "",
    "- **FR-001**: Hệ thống PHẢI ký số hoá đơn",
    "- [x] Đã hỏi kế toán trưởng",
    "",
    "```",
    "- [ ] dòng trong code",
    "```",
    "",
    "## Success Criteria *(mandatory)*",
    "",
    "### Measurable Outcomes",
    "",
    "- **SC-001**: Xuất trong dưới 5 giây",
    "- **SC-002**: Không hoá đơn nào trùng số",
  ].join("\n");

  it("reads Xong khi from Success Criteria and the checklist from the scenarios and [ ] lines", () => {
    const items = featureChecks(SPEC);
    assert.deepEqual(
      items.map((x) => [x.group, x.text]),
      [
        ["check", "Given một đơn đã trả, When bấm Xuất, Then có mã tra cứu"],
        ["check", "Given đơn chưa trả, When bấm Xuất, Then nút bị khoá"],
        ["check", "Đã hỏi kế toán trưởng"],
        ["done", "SC-001: Xuất trong dưới 5 giây"],
        ["done", "SC-002: Không hoá đơn nào trùng số"],
      ],
    );
    assert.equal(items[0]!.under, "User Story 1 - Kế toán xuất hoá đơn (Priority: P1)");
    assert.equal(items[2]!.inFile, true);
    assert.equal(items[3]!.id, "SC-001", "a criterion keeps its own id, so a mark survives an edit of its words");
    assert.equal(featureChecks(SPEC)[0]!.id, items[0]!.id, "the same words give the same id");
  });

  it("reads Vietnamese headings and has nothing for an empty spec", () => {
    const items = featureChecks("# X\n\n## Xong khi\n\n- Kế toán xuất được\n\n## Kịch bản kiểm thử\n\n- Thử đơn chưa trả\n");
    assert.deepEqual(items.map((x) => x.group), ["done", "check"]);
    assert.deepEqual(featureChecks(null), []);
    assert.deepEqual(featureChecks("# X\n\nKhông có gì.\n"), []);
  });

  it("keeps marks per folder in the browser's storage, and survives a broken entry", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const key = checksKey("app", "001-qr");
    assert.equal(key, "xdev-hive.checks:app/001-qr");
    writeChecks(key, { "SC-001": AT }, storage);
    assert.deepEqual(readChecks(key, storage), { "SC-001": AT });
    const items = featureChecks(SPEC);
    assert.equal(checkedCount(items, readChecks(key, storage)), 2, "SC-001 here, and the line ticked in spec.md");
    writeChecks(key, {}, storage);
    assert.equal(store.has(key), false);
    store.set(key, "{not json");
    assert.deepEqual(readChecks(key, storage), {});
    store.set(key, JSON.stringify({ a: 1, b: AT }));
    assert.deepEqual(readChecks(key, storage), { b: AT });
  });
});
