import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { errorCode, type OrgFixture, seedOrg } from "../../../test/org-fixture.ts";
import { seedProject } from "../../../test/project-fixture.ts";
import { createPool, parseMasterKey, type Tx, withTenant } from "../platform/index.ts";
import type { Principal } from "./access.ts";
import { getDoc, saveDoc } from "./docs.ts";
import {
  addComment,
  createSnapshot,
  createSuggestion,
  decideSuggestion,
  draftForAgent,
  editorState,
  listSnapshots,
  listSuggestions,
  listThreads,
  previewSubmit,
  rebaseDraft,
  resolveThread,
  saveDraft,
  submitDraft,
} from "./editor.ts";
import { approveProposal } from "./proposals.ts";
import { decideReview, saveWorkflow } from "./reviews.ts";

const { adminUrl, appUrl } = inject("db");
const admin = new pg.Pool({ connectionString: adminUrl });
const app = createPool(appUrl);
const masterKey = parseMasterKey(randomBytes(32).toString("base64"));
const tag = randomUUID().slice(0, 6);

let org: OrgFixture & { user: (n: string) => string };
let projectKey = "";
let projectId = "";
let key = "";

const user = (who: string): Principal => ({ kind: "user", userId: org.user(who) });
const as = <T>(who: string, fn: (tx: Tx) => Promise<T>) =>
  withTenant(app, { userId: org.user(who), orgId: org.orgId }, fn);
const deps = {};

const V1 = "# PRD hoàn tiền\n\n## Yêu cầu\n\n- R-1: Hoàn tiền trong 7 ngày.\n\nPhí hoàn tiền là 2%.\n";

beforeAll(async () => {
  org = await seedOrg(admin, `ed-${tag}`);
  projectKey = `pay-${tag}`;
  projectId = (
    await seedProject(admin, app, {
      orgId: org.orgId,
      teamId: org.teamId,
      systemId: org.systemId,
      adminUserId: org.user("admin"),
      masterKey,
      key: projectKey,
    })
  ).projectId;
});

beforeEach(async () => {
  key = `project/${projectKey}/prd-${randomUUID().slice(0, 6)}`;
  await as("tadmin", (tx) => saveDoc(tx, user("tadmin"), { key, title: "PRD hoàn tiền", content: V1, baseVersion: 0 }));
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("bản nháp", () => {
  it("mở lần đầu là bản đã duyệt; lưu lạc quan theo revision; người xem chỉ đọc", async () => {
    const s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.draft).toMatchObject({ content: V1, revision: 0, baseVersion: 1, latestVersion: 1, canEdit: true });
    expect(s.stage).toBe("drafting");
    expect(s.draftNumber).toBe(1);
    expect(s.presence.map((p) => p.userId)).toEqual([org.user("tmember")]);

    const saved = await as("tmember", (tx) =>
      saveDraft(tx, user("tmember"), { key, content: `${V1}\nĐoạn mới.\n`, revision: 0 }),
    );
    expect(saved.revision).toBe(1);
    // Lưu từ revision cũ: người khác vừa lưu.
    expect(
      await errorCode(() => as("tadmin", (tx) => saveDraft(tx, user("tadmin"), { key, content: V1, revision: 0 }))),
    ).toBe("DRAFT_CHANGED");

    const viewer = await as("tviewer", (tx) => editorState(tx, user("tviewer"), { key }));
    expect(viewer.draft.canEdit).toBe(false);
    expect(viewer.presence.find((p) => p.userId === org.user("tmember"))?.editing).toBe(true);
    expect(
      await errorCode(() => as("tviewer", (tx) => saveDraft(tx, user("tviewer"), { key, content: V1, revision: 1 }))),
    ).toBe("DOC_EDIT_FORBIDDEN");
    // Đội khác không thấy tài liệu của dự án: báo như không có.
    expect(await errorCode(() => as("oadmin", (tx) => editorState(tx, user("oadmin"), { key })))).toBe("DOC_NOT_FOUND");
  });

  it("gộp bản đã duyệt mới vào nháp theo khối", async () => {
    await as("tmember", (tx) =>
      saveDraft(tx, user("tmember"), {
        key,
        content: V1.replace("Phí hoàn tiền là 2%.", "Phí hoàn tiền là 3%."),
        revision: 0,
      }),
    );
    await as("tadmin", (tx) =>
      saveDoc(tx, user("tadmin"), { key, content: V1.replace("7 ngày", "10 ngày"), baseVersion: 1 }),
    );
    const s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.draft).toMatchObject({ baseVersion: 1, latestVersion: 2 });
    const { draft, conflicts } = await as("tmember", (tx) => rebaseDraft(tx, user("tmember"), { key, revision: 1 }));
    expect(conflicts).toBe(0);
    expect(draft.baseVersion).toBe(2);
    expect(draft.content).toContain("10 ngày");
    expect(draft.content).toContain("3%");
  });
});

describe("đề xuất sửa và bình luận", () => {
  it("nhận đề xuất thì sửa bản nháp; đoạn gốc mất thì đề xuất cũ không nhận được", async () => {
    const a = await as("tmember", (tx) =>
      createSuggestion(tx, user("tmember"), {
        key,
        before: "Phí hoàn tiền là 2%.",
        after: "Phí hoàn tiền là 1%.",
        reason: "Theo pháp chế",
      }),
    );
    const b = await as("tmember", (tx) =>
      createSuggestion(tx, user("tmember"), { key, before: "Phí hoàn tiền là 2%.", after: "Miễn phí hoàn tiền." }),
    );
    // Đoạn gốc không có trong bản nháp.
    expect(
      await errorCode(() =>
        as("tmember", (tx) => createSuggestion(tx, user("tmember"), { key, before: "không có", after: "x" })),
      ),
    ).toBe("SUGGESTION_ANCHOR");
    // Người xem không đề xuất được.
    expect(
      await errorCode(() =>
        as("tviewer", (tx) => createSuggestion(tx, user("tviewer"), { key, before: "", after: "Thêm" })),
      ),
    ).toBe("DOC_EDIT_FORBIDDEN");

    const { draft } = await as("tadmin", (tx) => decideSuggestion(tx, user("tadmin"), { id: a.id, accept: true }));
    expect(draft.content).toContain("Phí hoàn tiền là 1%.");
    expect(draft.revision).toBe(1);
    const list = await as("tmember", (tx) => listSuggestions(tx, user("tmember"), { key }));
    expect(list.find((s) => s.id === a.id)).toMatchObject({
      status: "accepted",
      decidedBy: { userId: org.user("tadmin") },
    });
    expect(list.find((s) => s.id === b.id)?.stale).toBe(true);
    expect(
      await errorCode(() => as("tadmin", (tx) => decideSuggestion(tx, user("tadmin"), { id: b.id, accept: true }))),
    ).toBe("SUGGESTION_STALE");
    await as("tadmin", (tx) => decideSuggestion(tx, user("tadmin"), { id: b.id, accept: false }));
    expect((await as("tadmin", (tx) => editorState(tx, user("tadmin"), { key }))).pendingSuggestions).toBe(0);
  });

  it("người xem bình luận, trả lời và đóng luồng; luồng mất neo khi đoạn trích bị sửa", async () => {
    const t = await as("tviewer", (tx) =>
      addComment(tx, user("tviewer"), { key, quote: "Phí hoàn tiền là 2%.", body: "Pháp chế đã duyệt chưa?" }),
    );
    await as("tmember", (tx) => addComment(tx, user("tmember"), { key, threadId: t.id, body: "Đang chờ." }));
    let threads = await as("tmember", (tx) => listThreads(tx, user("tmember"), { key }));
    expect(threads[0]).toMatchObject({ anchored: true, resolvedAt: null });
    expect(threads[0]?.comments.map((c) => c.body)).toEqual(["Pháp chế đã duyệt chưa?", "Đang chờ."]);
    expect((await as("tmember", (tx) => editorState(tx, user("tmember"), { key }))).openComments).toBe(1);

    await as("tmember", (tx) => saveDraft(tx, user("tmember"), { key, content: V1.replace("2%", "1%"), revision: 0 }));
    await as("tviewer", (tx) => resolveThread(tx, user("tviewer"), { id: t.id, resolved: true }));
    threads = await as("tmember", (tx) => listThreads(tx, user("tmember"), { key }));
    expect(threads[0]).toMatchObject({ anchored: false, resolvedBy: { userId: org.user("tviewer") } });
    expect((await as("tmember", (tx) => editorState(tx, user("tmember"), { key }))).openComments).toBe(0);
  });

  it("agent đọc bản nháp, đề xuất và bình luận nhưng không sửa hay nhận đề xuất", async () => {
    const run: Principal = { kind: "run", runId: randomUUID(), projectId };
    const d = await as("tmember", (tx) => draftForAgent(tx, run, key));
    expect(d.content).toBe(V1);
    const s = await as("tmember", (tx) =>
      createSuggestion(tx, run, { key, before: "", after: "## Tiêu chí chấp nhận\n\n- Given ..." }),
    );
    expect(s.author).toMatchObject({ userId: null, runId: run.kind === "run" ? run.runId : null });
    await as("tmember", (tx) => addComment(tx, run, { key, body: "Thiếu mục rủi ro." }));
    expect(await errorCode(() => as("tmember", (tx) => decideSuggestion(tx, run, { id: s.id, accept: true })))).toBe(
      "DOC_EDIT_FORBIDDEN",
    );
    const agentView = await as("tmember", (tx) => draftForAgent(tx, run, key));
    expect(agentView.pendingSuggestions).toHaveLength(1);
    expect(agentView.openThreads).toHaveLength(1);
  });
});

describe("bản chụp và gửi duyệt", () => {
  it("bản chụp có tên đánh số tăng dần", async () => {
    await as("tmember", (tx) => createSnapshot(tx, user("tmember"), { key, name: "Trước khi họp" }));
    await as("tmember", (tx) => saveDraft(tx, user("tmember"), { key, content: `${V1}\nThêm.\n`, revision: 0 }));
    await as("tmember", (tx) => createSnapshot(tx, user("tmember"), { key, name: "Sau họp" }));
    const list = await as("tviewer", (tx) => listSnapshots(tx, user("tviewer"), { key }));
    expect(list.map((s) => [s.number, s.name, s.submission])).toEqual([
      [2, "Sau họp", null],
      [1, "Trước khi họp", null],
    ]);
  });

  it("không có quy trình: gửi thành đề xuất chờ quản trị duyệt tay", async () => {
    expect(
      await errorCode(() => as("tmember", (tx) => submitDraft(tx, user("tmember"), { key, revision: 0 }, deps))),
    ).toBe("DRAFT_UNCHANGED");
    await as("tmember", (tx) => saveDraft(tx, user("tmember"), { key, content: V1.replace("2%", "1%"), revision: 0 }));
    const preview = await as("tmember", (tx) => previewSubmit(tx, user("tmember"), { key }));
    expect(preview).toMatchObject({ workflow: null, gates: [], addedLines: 1, deletedLines: 1 });
    const out = await as("tmember", (tx) =>
      submitDraft(tx, user("tmember"), { key, revision: 1, note: "Giảm phí" }, deps),
    );
    expect(out.reviewId).toBeNull();
    expect(out.snapshot).toMatchObject({ number: 1, name: "Gửi duyệt v1", submission: { status: "pending" } });
    let s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.stage).toBe("in_review");
    expect(s.draftNumber).toBe(2);
    expect(
      await errorCode(() => as("tmember", (tx) => submitDraft(tx, user("tmember"), { key, revision: 1 }, deps))),
    ).toBe("REVIEW_IN_PROGRESS");

    await as("tadmin", (tx) => approveProposal(tx, user("tadmin"), { id: out.proposalId }));
    expect((await as("tadmin", (tx) => getDoc(tx, user("tadmin"), { key }))).content).toContain("1%");
    s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.stage).toBe("approved");
    expect(s.review).toMatchObject({ status: "approved", snapshot: 1 });
    // Bản đã duyệt mới (v2) chính là bản nháp: gộp vào nháp không có xung đột.
    const { conflicts, draft } = await as("tmember", (tx) => rebaseDraft(tx, user("tmember"), { key, revision: 1 }));
    expect(conflicts).toBe(0);
    expect(draft).toMatchObject({ baseVersion: 2, latestVersion: 2 });
  });

  it("có quy trình: phiên duyệt bắt đầu ngay và trình soạn hiện tiến độ từng checkpoint", async () => {
    await as("tadmin", (tx) =>
      saveWorkflow(tx, org.user("tadmin"), {
        name: `PRD ${tag}`,
        preset: "custom",
        teamId: org.teamId,
        docPrefixes: [`project/${projectKey}/prd`],
        phases: [
          {
            name: "Inception",
            gates: [
              {
                id: "po",
                name: "PO duyệt",
                kind: "human",
                reviewers: { users: [], roles: ["team-admin"], quorum: 1 },
                slaHours: 24,
              },
            ],
          },
        ],
        enabled: true,
      }),
    );
    await as("tmember", (tx) => saveDraft(tx, user("tmember"), { key, content: V1.replace("2%", "1%"), revision: 0 }));
    const preview = await as("tmember", (tx) => previewSubmit(tx, user("tmember"), { key }));
    expect(preview.gates).toEqual([
      expect.objectContaining({ gateId: "po", kind: "human", runs: true, who: "Quản trị đội" }),
    ]);
    const out = await as("tmember", (tx) => submitDraft(tx, user("tmember"), { key, revision: 1 }, deps));
    expect(out.reviewId).not.toBeNull();
    let s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.workflow?.steps.map((x) => x.state)).toEqual(["current"]);
    expect(s.stage).toBe("in_review");

    await as("tadmin", (tx) =>
      decideReview(
        tx,
        org.user("tadmin"),
        { id: out.reviewId as string, decision: "changes", note: "Thêm số liệu" },
        deps,
      ),
    );
    s = await as("tmember", (tx) => editorState(tx, user("tmember"), { key }));
    expect(s.stage).toBe("changes_requested");
    expect(s.workflow?.steps.map((x) => x.state)).toEqual(["failed"]);
  });
});
