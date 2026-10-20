import { randomBytes, randomUUID } from "node:crypto";
import type { Doc, Proposal } from "@xdev-hive/contracts";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import {
  approveProposal,
  listProposals,
  type ProposalApprovedHandler,
  proposalsByOrigin,
  proposeDoc,
  provideProposalApproved,
  rejectProposal,
} from "./proposals.ts";
import { docs } from "./schema.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

type Fixture = OrgFixture & { user: (n: string) => string };
let org: Fixture;
let projectKey = "";

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);

let docKey = "";
const fileId = () => randomUUID();

/** Đề xuất của thành viên chỉ có quyền `propose`; `importFileId` có thì như nhập Word gửi duyệt. */
const propose = (importFileId?: string, content = "# Bản từ Word\n") =>
  as("tmember", (tx) =>
    proposeDoc(
      tx,
      user("tmember"),
      { key: docKey, content, baseVersion: 0, title: "Bản từ Word" },
      importFileId ? { origin: { kind: "word", importFileId } } : {},
    ),
  );
const approve = (id: string) => as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id }));
const versionRow = async (key: string) =>
  (
    await admin.query(
      `select v.version, v.source, v.proposal_id from hive.doc_versions v join hive.docs d on d.id = v.doc_id
       where d.key = $1 order by v.version desc limit 1`,
      [key],
    )
  ).rows[0];

let unregister: Array<() => void> = [];
const register = (handler: ProposalApprovedHandler) => unregister.push(provideProposalApproved(handler));

beforeAll(async () => {
  org = await seedOrg(admin, `pa-${tag}`);
  projectKey = `word-${tag}`;
  await seedProject(admin, app, {
    orgId: org.orgId,
    teamId: org.teamId,
    systemId: org.systemId,
    adminUserId: org.user("admin"),
    masterKey,
    key: projectKey,
  });
});

beforeEach(() => {
  docKey = `project/${projectKey}/srs/opd-${randomUUID().slice(0, 6)}`;
});

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("đề xuất có nguồn", () => {
  it("lưu origin khi tạo; đọc lại qua danh sách; duyệt thì phiên bản mang nguồn word", async () => {
    const importFileId = fileId();
    const p = await propose(importFileId);
    expect(p.origin).toEqual({ kind: "word", importFileId });
    const listed = await as("tadmin", (tx) => listProposals(tx, user("tadmin"), { status: "pending" }));
    expect(listed.find((x) => x.id === p.id)?.origin).toEqual({ kind: "word", importFileId });

    const approved = await approve(p.id);
    expect(approved).toMatchObject({ status: "approved", resultVersion: 1, origin: { kind: "word", importFileId } });
    expect(await versionRow(docKey)).toMatchObject({ version: 1, source: "word", proposal_id: p.id });
  });

  it("đề xuất không có origin chạy như cũ: origin null, nguồn hub", async () => {
    const p = await propose();
    expect(p.origin).toBeNull();
    await approve(p.id);
    expect(await versionRow(docKey)).toMatchObject({ version: 1, source: "hub", proposal_id: p.id });
  });
});

describe("provideProposalApproved", () => {
  it("hai bên đăng ký cùng được gọi theo thứ tự, trong giao dịch duyệt, với đề xuất đã duyệt và tài liệu vừa lưu", async () => {
    const calls: Array<{ who: string; proposal: Proposal; doc: Doc; seen: number }> = [];
    const handler =
      (who: string): ProposalApprovedHandler =>
      async (tx, proposal, doc) => {
        // Đọc bằng chính tx: thấy phiên bản chưa commit, tức là handler chạy trong giao dịch duyệt.
        const [row] = await tx.select({ n: docs.currentVersion }).from(docs).where(eq(docs.key, doc.key));
        calls.push({ who, proposal, doc, seen: row?.n ?? 0 });
      };
    register(handler("docsync"));
    register(handler("khác"));

    const importFileId = fileId();
    const p = await propose(importFileId);
    await approve(p.id);
    expect(calls.map((c) => c.who)).toEqual(["docsync", "khác"]);
    for (const c of calls) {
      expect(c.proposal).toMatchObject({ id: p.id, status: "approved", origin: { kind: "word", importFileId } });
      expect(c.doc).toMatchObject({ key: docKey, version: 1, content: "# Bản từ Word\n" });
      expect(c.seen).toBe(1);
    }
  });

  it("handler lỗi thì giao dịch duyệt rollback: không có phiên bản, đề xuất vẫn chờ", async () => {
    register(async () => {
      throw new Error("docsync lỗi");
    });
    const p = await propose(fileId());
    await expect(approve(p.id)).rejects.toThrow("docsync lỗi");
    expect(await versionRow(docKey)).toBeUndefined();
    expect((await admin.query("select status from hive.proposals where id = $1", [p.id])).rows[0].status).toBe(
      "pending",
    );
  });

  it("từ chối không gọi handler; gỡ đăng ký thì không gọi nữa", async () => {
    const handler = vi.fn(async () => {});
    const off = provideProposalApproved(handler);
    const rejected = await propose(fileId());
    await as("tadmin", (tx) => rejectProposal(tx, user("tadmin"), { id: rejected.id, note: "Chưa đúng mẫu" }));
    expect(handler).not.toHaveBeenCalled();

    off();
    docKey = `${docKey}-2`;
    await approve((await propose(fileId())).id);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("proposalsByOrigin", () => {
  it("trả trạng thái và thời điểm theo file nhập; file khác, đề xuất không nguồn và danh sách rỗng thì không có", async () => {
    const [a, b, c] = [fileId(), fileId(), fileId()];
    const pa = await propose(a);
    docKey = `${docKey}-b`;
    const pb = await propose(b);
    await as("tadmin", (tx) => rejectProposal(tx, user("tadmin"), { id: pb.id }));
    docKey = `${docKey}-plain`;
    await propose();

    const states = await as("tadmin", (tx) => proposalsByOrigin(tx, { kind: "word", importFileIds: [a, b, c] }));
    expect(states.map((s) => [s.importFileId, s.id, s.status]).sort()).toEqual(
      [
        [a, pa.id, "pending"],
        [b, pb.id, "rejected"],
      ].sort(),
    );
    const rejected = states.find((s) => s.importFileId === b);
    expect(rejected?.createdAt).toBeInstanceOf(Date);
    expect(rejected?.decidedAt).toBeInstanceOf(Date);
    expect(states.find((s) => s.importFileId === a)?.decidedAt).toBeNull();
    expect(await as("tadmin", (tx) => proposalsByOrigin(tx, { kind: "word", importFileIds: [] }))).toEqual([]);
  });

  it("RLS: tổ chức khác không thấy đề xuất của tổ chức này", async () => {
    const a = fileId();
    await propose(a);
    const stranger = await seedOrg(admin, `pa2-${tag}`);
    const states = await withTenant(app, { userId: stranger.user("admin"), orgId: stranger.orgId }, (tx) =>
      proposalsByOrigin(tx, { kind: "word", importFileIds: [a] }),
    );
    expect(states).toEqual([]);
  });
});
