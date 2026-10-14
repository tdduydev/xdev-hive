import { randomBytes, randomUUID } from "node:crypto";
import {
  defaultProjectSettings,
  type LeaderAction,
  type ProjectSdlcSettingsInput,
  projectSdlcSettings,
} from "@xdev-hive/contracts";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, type Jobs, parseMasterKey, withTenant } from "../platform/index.ts";
import { getItem, type SdlcDeps } from "../sdlc/index.ts";
import { describeAction } from "./actions.ts";
import { assembleLeaderPrompt } from "./prompt.ts";
import { approveApproval } from "./service.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let home = { id: "", key: "" };
let off = { id: "", key: "" };
let enqueued: { queue: string; data: Record<string, unknown> }[] = [];
const jobs = {
  enqueue: async (queue: string, data: Record<string, unknown>) => {
    enqueued.push({ queue, data });
    return randomUUID();
  },
} as unknown as Jobs;
const deps: SdlcDeps = { jobs, masterKey };

async function project(key: string, sdlc: ProjectSdlcSettingsInput | null) {
  const settings = { ...defaultProjectSettings(), ...(sdlc ? { sdlc: projectSdlcSettings.parse(sdlc) } : {}) };
  const seeded = await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key,
    settings,
  });
  return { id: seeded.projectId, key };
}

const action = (projectId = home.id): LeaderAction => ({
  type: "sdlc.item.create",
  item: {
    projectId,
    title: "Hoàn tiền một phần",
    idea: "Cho phép hoàn tiền một phần cho đơn đã thanh toán, có ghi lý do và thông báo khách.",
    modeRef: "speckit",
    size: "M",
    participants: [],
  },
});

async function seedApproval(proposed: LeaderAction) {
  const { rows: threads } = await admin.query(
    "insert into hive.chat_threads (org_id, project_id, created_by, title) values ($1, $2, $3, 'Đề xuất') returning id",
    [org.orgId, home.id, org.user("tmember")],
  );
  const { rows } = await admin.query(
    "insert into hive.approvals (org_id, thread_id, action, expires_at) values ($1, $2, $3, now() + interval '1 day') returning id",
    [org.orgId, threads[0].id, JSON.stringify(proposed)],
  );
  return rows[0].id as string;
}

const approve = (who: string, id: string) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, (tx) =>
    approveApproval(undefined, tx, org.user(who), id, undefined, deps),
  );

beforeAll(async () => {
  org = await seedOrg(admin, `lsd-${tag}`);
  home = await project(`ls${tag}`, { enabled: true, defaultMode: "speckit", modes: ["speckit", "bugfix"] });
  off = await project(`lo${tag}`, null);
});

beforeEach(() => {
  enqueued = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("Leader đề xuất hạng mục AI SDLC", () => {
  it("duyệt đề xuất tạo hạng mục, người duyệt là chủ, nguồn `leader`, giai đoạn đầu đi tiếp", async () => {
    const id = await seedApproval(action());
    const { response } = await approve("tadmin", id);

    expect(response.approval.status).toBe("approved");
    const created = (response.result as { item: { id: string; ref: string; projectKey: string } }).item;
    expect(created).toMatchObject({ ref: "001", title: "Hoàn tiền một phần", projectKey: home.key });

    const item = await withTenant(app, { userId: org.user("tadmin"), orgId: org.orgId }, (tx) =>
      getItem(tx, org.user("tadmin"), { id: created.id }),
    );
    expect(item).toMatchObject({
      modeRef: "speckit",
      source: { kind: "leader" },
      owner: { userId: org.user("tadmin") },
      phase: { id: "specify", status: "drafting" },
    });
    expect(enqueued).toContainEqual({ queue: "sdlc", data: { kind: "advance", orgId: org.orgId, itemId: created.id } });

    const { rows: audit } = await admin.query(
      "select data from hive.audit_log where org_id = $1 and action = 'leader.approval.approve' and target_id = $2",
      [org.orgId, id],
    );
    expect(audit[0]?.data).toMatchObject({ action: "sdlc.item.create" });
  });

  it("người duyệt không có quyền ghi hay dự án chưa bật AI SDLC: từ chối, đề xuất vẫn chờ", async () => {
    const viewer = await seedApproval(action());
    expect(await errorCode(() => approve("tviewer", viewer))).toBe("SDLC_FORBIDDEN");
    const disabled = await seedApproval(action(off.id));
    expect(await errorCode(() => approve("tadmin", disabled))).toBe("SDLC_NOT_ENABLED");

    const { rows } = await admin.query("select status from hive.approvals where id = any($1::uuid[]) order by id", [
      [viewer, disabled],
    ]);
    expect(rows.map((r) => r.status)).toEqual(["pending", "pending"]);
  });
});

describe("prompt Leader", () => {
  it("nhắc đề xuất hạng mục cho việc lớn và mô tả đề xuất có tiêu đề", () => {
    const prompt = assembleLeaderPrompt({
      transcript: "",
      projectName: "Hoá đơn",
      projectKey: "hd",
      defaultBranch: null,
      context: "",
    });
    expect(prompt).toContain("sdlc.item.create");
    expect(describeAction(action())).toBe('Tạo hạng mục AI SDLC "Hoàn tiền một phần"');
  });
});
