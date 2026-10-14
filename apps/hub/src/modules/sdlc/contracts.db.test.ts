import { randomBytes, randomUUID } from "node:crypto";
import { defaultProjectSettings, projectSdlcSettings } from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { contractsFromRunReport, createContract, updateContract } from "./contracts.ts";
import { codeRunGate } from "./gate.ts";
import { createItem, getItem } from "./items.ts";
import { onBaseline, workflowFor } from "./phases.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let teamC = "";
const p: Record<"a" | "b" | "c" | "d", string> = { a: "", b: "", c: "", d: "" };
const key = (k: string) => `${k}${tag}`;

const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

async function seedSdlcProject(k: string, teamId: string, systemId: string) {
  return (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId,
      systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: key(k),
      settings: {
        ...defaultProjectSettings(),
        sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "speckit" }),
      },
    })
  ).projectId;
}

/** Hạng mục bốn dự án của ba đội: a (đội A, chính), b (đội B), c (đội C), d (đội A, không là bên của contract). */
const newItem = () =>
  as("admin", (tx) =>
    createItem(tx, org.user("admin"), {
      projectId: p.a,
      participants: [p.b, p.c, p.d],
      title: "Hoàn tiền một phần",
      idea: "Khách hàng được hoàn một phần tiền đơn hàng qua web và app.",
      modeRef: "speckit",
      size: "M",
    }),
  );

const create = (who: string, itemId: string, consumers: string[], name = "refund-api") =>
  as(who, (tx) =>
    createContract(tx, org.user(who), {
      itemId,
      name,
      format: "openapi",
      providerProjectId: p.a,
      consumerProjectIds: consumers,
    }),
  );

let n = 0;
async function seedTask(itemId: string, projectId: string, teamId: string): Promise<string> {
  const number = ++n;
  const { rows } = await admin.query(
    `insert into hive.tasks (org_id, team_id, project_id, number, key, title, status, created_by)
     values ($1, $2, $3, $4, $5, 'Task', 'todo', 'seed') returning id`,
    [org.orgId, teamId, projectId, number, `T-${tag}-${number}`],
  );
  const taskId = rows[0].id as string;
  await admin.query(
    `insert into hive.sdlc_item_tasks (org_id, item_id, task_id, project_id, slice_key, wave, breakdown_version)
     values ($1, $2, $3, $4, $5, 1, 1)`,
    [org.orgId, itemId, taskId, projectId, `T${number}`],
  );
  return taskId;
}

/** Tên tài liệu còn thiếu mà cổng báo cho task. */
async function missingFor(taskId: string): Promise<string[]> {
  const gate = await as("admin", (tx) => codeRunGate(tx, { taskId, kind: "code" }));
  return gate.block ? gate.missing.flatMap((m) => (m.kind === "artifact" ? [m.name] : [])) : [];
}

async function syncs(artifactId: string) {
  const { rows } = await admin.query(
    `select project_id as "projectId", kind, repo_path as "repoPath" from hive.sdlc_artifact_syncs
     where artifact_id = $1 order by kind desc, repo_path, project_id`,
    [artifactId],
  );
  return rows as { projectId: string; kind: string; repoPath: string }[];
}

async function baseline(docKey: string) {
  await as("admin", async (tx) => {
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: docKey, content: "openapi: 3.1.0\n", baseVersion: 0 },
    );
    await onBaseline(tx, {
      docKey,
      version: doc.version,
      proposalId: randomUUID(),
      reviewId: randomUUID(),
    });
  });
}

beforeAll(async () => {
  org = await seedOrg(admin, `sdc-${tag}`);
  teamC = (
    await admin.query("insert into hive.teams (org_id, slug, name) values ($1, 'mobile', 'Mobile') returning id", [
      org.orgId,
    ])
  ).rows[0].id;
  const systemC = (
    await admin.query(
      "insert into hive.systems (org_id, team_id, slug, name) values ($1, $2, 'app', 'App') returning id",
      [org.orgId, teamC],
    )
  ).rows[0].id;
  p.a = await seedSdlcProject("a", org.teamId, org.systemId);
  p.b = await seedSdlcProject("b", org.otherTeamId, org.otherSystemId);
  p.c = await seedSdlcProject("c", teamC, systemC);
  p.d = await seedSdlcProject("d", org.teamId, org.systemId);
});

beforeEach(async () => {
  await admin.query("delete from hive.sdlc_items where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.doc_drafts where org_id = $1", [org.orgId]);
  await admin.query("delete from hive.docs where org_id = $1", [org.orgId]);
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("contracts.create", () => {
  it("ghi contract bắt buộc, file nguồn ở bên cung cấp, bản sao ở mỗi bên dùng có <home>-<NNN>", async () => {
    const item = await newItem();
    const view = await create("admin", item.id, [p.b, p.c]);
    expect(view).toMatchObject({
      scope: "contract",
      instance: "refund-api",
      required: true,
      projectId: p.a,
      consumerProjectIds: [p.b, p.c],
      contractFormat: "openapi",
      docKey: `project/${key("a")}/sdlc/001-${item.slug}/contracts/refund-api`,
      repoPath: `specs/001-${item.slug}/contracts/refund-api.yaml`,
    });
    const copyPath = `specs/${key("a")}-001-${item.slug}/contracts/refund-api.yaml`;
    expect(await syncs(view.id)).toEqual([
      { projectId: p.a, kind: "source", repoPath: `specs/001-${item.slug}/contracts/refund-api.yaml` },
      ...[p.b, p.c].sort().map((projectId) => ({ projectId, kind: "copy", repoPath: copyPath })),
    ]);
    const detail = await as("admin", (tx) => getItem(tx, org.user("admin"), { id: item.id }));
    expect(
      detail.artifacts
        .find((a) => a.id === view.id)
        ?.syncs.map((s) => s.projectKey)
        .sort(),
    ).toEqual([key("a"), key("b"), key("c")].sort());
    const { rows } = await admin.query("select data from hive.audit_log where action = 'sdlc.contract.create'", []);
    expect(rows.some((r) => r.data.artifactId === view.id && r.data.source === "user")).toBe(true);
  });

  it("thiếu quyền ở đội của một bên thì từ chối; bên ngoài hạng mục, tên trùng bị từ chối", async () => {
    const item = await newItem();
    expect(await errorCode(() => create("tadmin", item.id, [p.b]))).toBe("SDLC_FORBIDDEN");
    await create("admin", item.id, [p.b]);
    expect(await errorCode(() => create("admin", item.id, [p.c]))).toBe("SDLC_CONTRACT_EXISTS");
    const outsider = await seedSdlcProject(`x${++n}`, org.otherTeamId, org.otherSystemId);
    expect(await errorCode(() => create("admin", item.id, [outsider], "other-api"))).toBe("SDLC_CONTRACT_INVALID");
  });
});

describe("cổng duyệt của contract", () => {
  it("một checkpoint người cho mỗi đội là một bên, bên cung cấp trước; bỏ checkpoint quy tắc", async () => {
    const item = await newItem();
    const view = await create("admin", item.id, [p.b, p.c]);
    const wf = await as("admin", (tx) => workflowFor(tx, view.docKey));
    expect(wf?.name).toContain("contract refund-api");
    const gates = wf?.phases.flatMap((ph) => ph.gates) ?? [];
    expect(gates.some((g) => g.kind === "rule")).toBe(false);
    const humans = gates.filter((g) => g.kind === "human");
    expect(humans.map((g) => g.reviewers?.teamScope)).toEqual([org.teamId, org.otherTeamId, teamC]);
    // Đội A có hai dự án trong hạng mục nhưng chỉ a là một bên: tên checkpoint không nhắc d.
    expect(humans[0]?.name).toContain(key("a"));
    expect(humans[0]?.name).not.toContain(key("d"));
  });
});

describe("chặn bên dùng tới khi contract có baseline", () => {
  it("chặn bên cung cấp và bên dùng, không chặn dự án khác; baseline xong thì thôi chặn", async () => {
    const item = await newItem();
    const view = await create("admin", item.id, [p.b]);
    const provider = await seedTask(item.id, p.a, org.teamId);
    const consumer = await seedTask(item.id, p.b, org.otherTeamId);
    const other = await seedTask(item.id, p.c, teamC);
    expect(await missingFor(provider)).toContain("contract refund-api");
    expect(await missingFor(consumer)).toContain("contract refund-api");
    expect(await missingFor(other)).not.toContain("contract refund-api");
    await baseline(view.docKey);
    expect(await missingFor(consumer)).not.toContain("contract refund-api");
  });
});

describe("contracts.update", () => {
  it("đổi bên dùng trước baseline: bản sao theo bên dùng mới; sau baseline thì từ chối", async () => {
    const item = await newItem();
    const view = await create("admin", item.id, [p.b, p.c]);
    const updated = await as("admin", (tx) =>
      updateContract(tx, org.user("admin"), { id: view.id, consumerProjectIds: [p.c, p.d] }),
    );
    expect(updated.consumerProjectIds).toEqual([p.c, p.d]);
    expect((await syncs(view.id)).map((s) => [s.projectId, s.kind]).sort()).toEqual(
      [
        [p.a, "source"],
        [p.c, "copy"],
        [p.d, "copy"],
      ].sort(),
    );
    await baseline(view.docKey);
    expect(
      await errorCode(() =>
        as("admin", (tx) => updateContract(tx, org.user("admin"), { id: view.id, consumerProjectIds: [p.b] })),
      ),
    ).toBe("SDLC_CONTRACT_LOCKED");
  });
});

describe("sdlc_report contracts", () => {
  it("contract hợp lệ thành bản nháp của run, key lạ bị bỏ kèm lý do", async () => {
    const item = await newItem();
    const result = await as("admin", (tx) =>
      contractsFromRunReport(
        tx,
        item.id,
        {
          kind: "contracts",
          data: {
            contracts: [
              {
                name: "refund-api",
                format: "openapi",
                provider: key("a"),
                consumers: [key("b")],
                content: "openapi: 3.1.0\n",
              },
              { name: "ghost-api", format: "openapi", provider: key("a"), consumers: ["khong-co"], content: "x" },
            ],
          },
        },
        { kind: "user", userId: org.user("admin") },
      ),
    );
    expect(result.created).toEqual([`project/${key("a")}/sdlc/001-${item.slug}/contracts/refund-api`]);
    expect(result.rejected.map((r) => r.name)).toEqual(["ghost-api"]);
    const { rows } = await admin.query("select content from hive.doc_drafts where key = $1", [result.created[0]]);
    expect(rows[0]?.content).toBe("openapi: 3.1.0\n");
  });
});
