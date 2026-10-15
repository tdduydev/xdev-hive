import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings, type SdlcItemDetail } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { fleetRuns } from "./fleet-runs.ts";
import { createItem } from "./items.ts";
import { onBaseline } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectId = "";

const as = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(app, { userId: org.user("admin"), orgId: org.orgId }, fn);

async function run(machineId: string, state: string, opts: { kind?: string; taskId?: string } = {}) {
  const { rows } = await admin.query(
    `insert into hive.runs (org_id, team_id, task_id, project_id, kind, state, branch, policy_snapshot, created_by,
       machine_id, started_at)
     values ($1, $2, $3, $4, $5, $6, 'ai/x', '[]', 'seed', $7, now()) returning id`,
    [org.orgId, org.teamId, opts.taskId ?? null, projectId, opts.kind ?? "code", state, machineId],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  org = await seedOrg(admin, `sfr-${tag}`);
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: `fr${tag}`,
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit", modes: ["speckit"] }),
      },
    })
  ).projectId;
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("fleetRuns", () => {
  it("run chưa kết thúc theo máy; run bước và run task của bản tách kèm hạng mục", async () => {
    const item: SdlcItemDetail = await as((tx) =>
      createItem(tx, org.user("admin"), {
        projectId,
        title: "Xuất báo cáo",
        idea: "Xuất báo cáo doanh thu theo tháng ra file CSV cho kế toán.",
        modeRef: "speckit",
        size: "M",
      }),
    );
    const tasksDoc = item.artifacts.find((a) => a.artifactId === "tasks")?.docKey ?? "";
    await as(async (tx) => {
      const doc = await saveDoc(
        tx,
        { kind: "user", userId: org.user("admin") },
        { key: tasksDoc, content: "# Tasks\n\n## Phase 1: A\n\n- [ ] T001 Bảng (FR-001)\n", baseVersion: 0 },
      );
      await onBaseline(tx, {
        docKey: tasksDoc,
        version: doc.version,
        proposalId: randomUUID(),
        reviewId: randomUUID(),
      });
    });
    const { rows: links } = await admin.query("select task_id from hive.sdlc_item_tasks where item_id = $1", [item.id]);
    const [m1, m2, idle, other] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

    const taskRun = await run(m1, "running", { taskId: links[0].task_id });
    const stepRun = await run(m1, "verifying", { kind: "sdlc" });
    await admin.query(
      `insert into hive.sdlc_steps (org_id, item_id, phase_id, step_id, action, run_id, status, created_by)
       values ($1, $2, 'specify', 'clarify', 'run', $3, 'running', 'seed')`,
      [org.orgId, item.id, stepRun],
    );
    const plain = await run(m2, "leased");
    await run(m1, "succeeded");
    await run(other, "running");

    const got = await as((tx) => fleetRuns(tx, [m1, m2, idle]));
    const ref = { id: item.id, ref: item.ref, title: "Xuất báo cáo" };
    expect(got.get(m1)?.map((r) => [r.runId, r.kind, r.projectKey, r.item, r.step])).toEqual([
      [taskRun, "code", `fr${tag}`, ref, null],
      [stepRun, "sdlc", `fr${tag}`, ref, "clarify"],
    ]);
    expect(got.get(m2)).toEqual([
      { runId: plain, kind: "code", projectKey: `fr${tag}`, item: null, step: null, startedAt: expect.any(String) },
    ]);
    expect(got.has(idle)).toBe(false);
    expect(got.has(other)).toBe(false);
    expect(await as((tx) => fleetRuns(tx, []))).toEqual(new Map());
  });
});
