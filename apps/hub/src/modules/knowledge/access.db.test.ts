import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import { type DocAccessGrant, type Principal, provideDocAccess } from "./access.ts";
import { getDoc, saveDoc } from "./docs.ts";
import { editorState } from "./editor.ts";
import { approveProposal, createProposal } from "./proposals.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let projectKey = "";
let itemDoc = "";
let plainDoc = "";

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

/** Hook của hạng mục: chỉ đội CRM (oadmin) được cấp, chỉ cho tài liệu dưới `sdlc/`. */
const grantFor = (grant: DocAccessGrant | null) =>
  vi.fn(async (_tx: Tx, reader: { kind: string; principal: Principal }, key: string) =>
    reader.principal.kind === "user" && reader.principal.userId === org.user("oadmin") && key === itemDoc
      ? grant
      : null,
  );

beforeAll(async () => {
  const suffix = randomUUID().slice(0, 6);
  org = await seedOrg(admin, `ac-${suffix}`);
  projectKey = `pay-${suffix}`;
  await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
  itemDoc = `project/${projectKey}/sdlc/001-hoan-tien/spec`;
  plainDoc = `project/${projectKey}/notes`;
  for (const key of [itemDoc, plainDoc])
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key, title: "Spec", content: "# Spec\n", baseVersion: 0 }),
    );
});

afterEach(() => provideDocAccess(undefined));

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

const read = (who: string, key = itemDoc) => as(who, (tx) => getDoc(tx, user(who), { key }));
const propose = (who: string, key = itemDoc) =>
  as(who, (tx) =>
    createProposal(tx, user(who), {
      kind: "doc",
      key,
      baseVersion: 1,
      content: "# Spec\nThêm mục.\n",
      reason: "Đội CRM dùng",
    }),
  );

describe("docAccessFor", () => {
  it("không có hook: người đội khác không thấy tài liệu của dự án, như trước", async () => {
    expect(await errorCode(() => read("oadmin"))).toBe("DOC_NOT_FOUND");
    expect(await errorCode(() => propose("oadmin"))).toBe("DOC_NOT_FOUND");
  });

  it("mở đọc: đọc được đúng tài liệu được cấp, đề xuất và lưu thẳng vẫn bị chặn", async () => {
    const hook = grantFor({ read: true, propose: false });
    provideDocAccess(hook);
    expect((await read("oadmin")).key).toBe(itemDoc);
    expect(hook).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "user" }), itemDoc);
    // Tài liệu khác của cùng dự án không được cấp.
    expect(await errorCode(() => read("oadmin", plainDoc))).toBe("DOC_NOT_FOUND");
    expect(await errorCode(() => propose("oadmin"))).toBe("NOT_TEAM_MEMBER");
    const save = () =>
      as("oadmin", (tx) => saveDoc(tx, user("oadmin"), { key: itemDoc, content: "# Sửa\n", baseVersion: 1 }));
    expect(await errorCode(save)).toBe("NOT_TEAM_MEMBER");
  });

  it("mở đề xuất: đề xuất được (đọc kèm theo) nhưng không lưu thẳng, không duyệt đề xuất", async () => {
    provideDocAccess(grantFor({ read: false, propose: true }));
    const p = await propose("oadmin");
    expect(p).toMatchObject({ kind: "doc", target: itemDoc, status: "pending" });
    expect((await read("oadmin")).key).toBe(itemDoc);
    const row = await admin.query("select team_id from hive.proposals where id = $1", [p.id]);
    expect(row.rows[0].team_id).toBe(org.teamId);
    const save = () =>
      as("oadmin", (tx) => saveDoc(tx, user("oadmin"), { key: itemDoc, content: "# Sửa\n", baseVersion: 1 }));
    expect(await errorCode(save)).toBe("NOT_TEAM_MEMBER");
    expect(
      await errorCode(() => as("oadmin", (tx) => approveProposal(tx, user("oadmin"), { id: p.id }))),
    ).toBeDefined();
    const version = await admin.query("select current_version from hive.docs where key = $1", [itemDoc]);
    expect(version.rows[0].current_version).toBe(1);
  });

  it("trình soạn: người được cấp đề xuất thì sửa được bản nháp, chỉ đọc thì không", async () => {
    const state = (who: string) => as(who, (tx) => editorState(tx, user(who), { key: itemDoc }));
    provideDocAccess(grantFor({ read: true, propose: false }));
    expect((await state("oadmin")).draft.canEdit).toBe(false);
    provideDocAccess(grantFor({ read: true, propose: true }));
    expect((await state("oadmin")).draft.canEdit).toBe(true);
    // Người trong đội sở hữu không đổi.
    expect((await state("tmember")).draft.canEdit).toBe(true);
  });

  it("hook trả null hoặc cấp không gì thì không mở", async () => {
    provideDocAccess(grantFor(null));
    expect(await errorCode(() => read("oadmin"))).toBe("DOC_NOT_FOUND");
    provideDocAccess(grantFor({ read: false, propose: false }));
    expect(await errorCode(() => read("oadmin"))).toBe("DOC_NOT_FOUND");
  });
});
