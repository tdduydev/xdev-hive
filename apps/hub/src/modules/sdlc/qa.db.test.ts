import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  projectSdlcSettings,
  type QaTestReport,
  type SdlcItemDetail,
} from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { saveDoc } from "../knowledge/index.ts";
import { McpToolRegistry } from "../mcp/index.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { createItem } from "./items.ts";
import { registerMcpTools } from "./mcp-tools.ts";
import { advance, approvePhase, onBaseline, skipPhase } from "./phases.ts";
import { qaCases, qaState, qaViewFor, waiveQaCase } from "./qa.ts";
import { qaFingerprint } from "./qa-gate.ts";
import { sdlcSteps } from "./schema.ts";
import { onSdlcRunFinished } from "./steps.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const tag = randomUUID().slice(0, 6);
let org: OrgFixture & { user: (name: string) => string };
let projectId = "";
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { orgId: org.orgId, userId: org.user(who) }, fn);
const table = (title = "Đăng nhập hợp lệ", second = false) =>
  `# Test case\n\n## Test case\n\n` +
  `| Mã | Tiêu đề | Loại | Yêu cầu | Script |\n|---|---|---|---|---|\n` +
  `| TC-001 | ${title} | automated | FR-001, AC-1.1 | tests/login.ts |\n` +
  (second ? "| TC-002 | Đăng nhập bị từ chối | automated | FR-002 | tests/login.ts |\n" : "");

beforeAll(async () => {
  org = await seedOrg(admin, `qa-${tag}`);
  ({ projectId } = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey: parseMasterKey(randomBytes(32).toString("base64")),
    key: `qa${tag}`,
    settings: {
      ...defaultProjectSettings(),
      sdlc: projectSdlcSettings.parse({ enabled: true, defaultMode: "qa-automation", modes: ["qa-automation"] }),
    },
  }));
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const create = () =>
  as("tmember", (tx) =>
    createItem(tx, org.user("tmember"), {
      projectId,
      title: "Kiểm đăng nhập",
      idea: "Kiểm đăng nhập và từ chối tài khoản sai theo FR-001.",
      modeRef: "qa-automation",
      size: "M",
    }),
  );
async function baseline(item: SdlcItemDetail, content: string) {
  const artifact = item.artifacts.find((a) => a.artifactId === "test-cases")!;
  return as("admin", async (tx) => {
    const { rows } = await admin.query(
      "select coalesce(max(v.version),0)::int as v from hive.doc_versions v join hive.docs d on d.id=v.doc_id where d.key=$1",
      [artifact.docKey],
    );
    const doc = await saveDoc(
      tx,
      { kind: "user", userId: org.user("admin") },
      { key: artifact.docKey, content, baseVersion: rows[0].v },
    );
    await onBaseline(tx, {
      docKey: artifact.docKey,
      version: doc.version,
      proposalId: randomUUID(),
      reviewId: randomUUID(),
    });
  });
}
async function step(itemId: string, status: "running" | "succeeded" = "running") {
  return as("admin", async (tx) => {
    const [row] = await tx
      .insert(sdlcSteps)
      .values({
        orgId: org.orgId,
        itemId,
        phaseId: "verify",
        stepId: "test-run",
        action: "test-run",
        status,
        runId: randomUUID(),
        createdBy: org.user("admin"),
        result: { qaBaseline: qaFingerprint(await qaCases(tx, itemId)) },
      })
      .returning();
    return row!;
  });
}
async function report(runId: string, data: QaTestReport) {
  const registry = new McpToolRegistry();
  registerMcpTools(registry);
  const tool = registry.list().find((t) => t.name === "sdlc_report")!;
  return as("admin", (tx) =>
    tool.handler(
      tool.input.parse({ kind: "test-results", data }),
      {
        tx,
        orgId: org.orgId,
        principal: { kind: "run", userId: "run", runId, runKind: "sdlc", projectId, attempt: 1, scopes: [] },
      },
      undefined,
    ),
  );
}
const passed: QaTestReport = {
  runner: "junit",
  durationMs: 10,
  totals: { total: 1, passed: 1, failed: 0, skipped: 0, flaky: 0 },
  cases: [{ code: "TC-001", status: "passed", retries: 0, durationMs: 10 }],
  truncated: false,
};

describe("QA baseline, metadata và cổng", () => {
  it("bước xong nhưng thiếu metadata phải lỗi; bước draft không được gửi kết quả QA", async () => {
    const item = await create();
    await baseline(item, table());
    const running = await step(item.id);
    const finished = await as("admin", (tx) =>
      onSdlcRunFinished(tx, { runId: running.runId!, ok: true, artifacts: null, error: null }),
    );
    expect(finished?.succeeded).toBe(false);
    expect(finished?.message).toContain("metadata");
    const draft = await step(item.id);
    await as("admin", (tx) => tx.update(sdlcSteps).set({ action: "draft" }).where(eq(sdlcSteps.id, draft.id)));
    expect(await errorCode(() => report(draft.runId!, passed))).toBe("QA_STEP_REQUIRED");
  });
  it("upsert, retire, rollback bảng sai và chỉ xoá miễn khi TC đổi", async () => {
    const item = await create();
    await baseline(item, table("Đăng nhập hợp lệ", true));
    const [first] = await as("admin", (tx) => qaCases(tx, item.id));
    await as("tadmin", (tx) =>
      waiveQaCase(tx, org.user("tadmin"), { caseId: first!.id, waived: true, reason: "Chấp nhận rủi ro bản thử" }),
    );
    await baseline(item, table("Đăng nhập hợp lệ", true));
    expect((await as("admin", (tx) => qaCases(tx, item.id)))[0]?.waivedBy).toBe(org.user("tadmin"));
    expect(await errorCode(() => baseline(item, table().replace("FR-001, AC-1.1", "")))).toBe("QA_CASES_INVALID");
    expect((await as("admin", (tx) => qaCases(tx, item.id)))[0]?.waivedBy).toBe(org.user("tadmin"));
    await baseline(item, table("Đăng nhập với OTP"));
    const cases = await as("admin", (tx) => qaCases(tx, item.id));
    expect(cases[0]).toMatchObject({ id: first!.id, waivedBy: null });
    expect(cases[1]?.retired).toBe(true);
  });
  it("thành viên thường không miễn, thiếu quyền đọc không xem và tenant khác không thấy TC", async () => {
    const item = await create();
    await baseline(item, table());
    const [tc] = await as("admin", (tx) => qaCases(tx, item.id));
    expect(
      await errorCode(() =>
        as("tmember", (tx) =>
          waiveQaCase(tx, org.user("tmember"), { caseId: tc!.id, waived: true, reason: "Chấp nhận rủi ro bản thử" }),
        ),
      ),
    ).toBe("SDLC_FORBIDDEN");
    expect(await errorCode(() => as("loner", (tx) => qaViewFor(tx, org.user("loner"), item.id)))).toBe(
      "SDLC_ITEM_NOT_FOUND",
    );
    expect(await withTenant(app, { orgId: randomUUID() }, (tx) => qaCases(tx, item.id))).toEqual([]);
  });
  it("MCP gửi lại ghi đè, bước chưa kết thúc không mở cổng, chạy mới và đổi TC làm bằng chứng cũ hết hiệu lực", async () => {
    const item = await create();
    await baseline(item, table());
    const running = await step(item.id);
    await report(running.runId!, passed);
    expect((await as("admin", (tx) => qaState(tx, item.id))).checks[0]?.passed).toBe(false);
    await as("admin", (tx) => tx.update(sdlcSteps).set({ status: "succeeded" }).where(eq(sdlcSteps.id, running.id)));
    expect((await as("admin", (tx) => qaState(tx, item.id))).checks[0]?.passed).toBe(true);
    const next = await step(item.id);
    const failed: QaTestReport = {
      ...passed,
      totals: { ...passed.totals, passed: 0, failed: 1 },
      cases: [{ ...passed.cases[0]!, status: "failed" }],
    };
    await report(next.runId!, passed);
    await report(next.runId!, failed);
    await as("admin", (tx) => tx.update(sdlcSteps).set({ status: "succeeded" }).where(eq(sdlcSteps.id, next.id)));
    expect((await as("admin", (tx) => qaState(tx, item.id))).checks[0]?.passed).toBe(false);
    const latest = await step(item.id);
    await baseline(item, table("Đăng nhập với OTP"));
    expect(await errorCode(() => report(latest.runId!, passed))).toBe("QA_BASELINE_CHANGED");
  });
  it("verification không tự qua, không approve/bỏ qua được khi thiếu TC; miễn vẫn cần tài liệu duyệt", async () => {
    const item = await create();
    await baseline(item, table());
    await admin.query("update hive.sdlc_items set phase_index=5 where id=$1", [item.id]);
    expect((await as("admin", (tx) => advance(tx, item.id)))?.phaseIndex).toBe(5);
    expect(await errorCode(() => as("admin", (tx) => approvePhase(tx, item.id, "verify", {})))).toBe("QA_GATE_BLOCKED");
    expect(
      await errorCode(() =>
        as("admin", (tx) => skipPhase(tx, org.user("admin"), { id: item.id, phaseId: "verify", reason: "Bỏ qua QA" })),
      ),
    ).toBe("QA_GATE_REQUIRED");
    const [tc] = await as("admin", (tx) => qaCases(tx, item.id));
    await as("tadmin", (tx) =>
      waiveQaCase(tx, org.user("tadmin"), { caseId: tc!.id, waived: true, reason: "Chấp nhận rủi ro bản thử" }),
    );
    expect((await as("admin", (tx) => qaState(tx, item.id))).checks[0]?.passed).toBe(true);
    expect((await as("admin", (tx) => advance(tx, item.id)))?.phaseIndex).toBe(5);
    await as("tadmin", (tx) =>
      waiveQaCase(tx, org.user("tadmin"), { caseId: tc!.id, waived: false, reason: "Cần kiểm lại trước phát hành" }),
    );
    expect((await as("admin", (tx) => qaState(tx, item.id))).checks[0]?.passed).toBe(false);
  });
});
