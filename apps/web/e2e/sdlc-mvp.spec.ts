import { expect, test } from "@playwright/test";
import type { ReviewDetail, SdlcBreakdownView, SdlcItemTask } from "@xdev-hive/contracts";
import { ok } from "./fake-hub.ts";
import { inOrg, REVIEW_PRD, reviewsFixture } from "./reviews-fixture.ts";
import { PAYMENT, sdlcFixture } from "./sdlc-fixture.ts";

// Hub giả tiến giai đoạn sau quyết định; bài này kiểm việc nối màn và dữ liệu UI, hub thật có bộ DB test riêng.
test("SC-009: tạo → trả lời → duyệt ba tài liệu → duyệt bản tách → chạy đợt → xem PR", async ({ page }) => {
  const { rpc, state } = sdlcFixture({ participants: [] });
  const template = reviewsFixture().details[REVIEW_PRD];
  if (!template) throw new Error("Thiếu phiên duyệt mẫu");
  const uid = (n: number) => `5d5d5d5d-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const specs = [
    ["specify", "spec"],
    ["plan", "plan"],
    ["plan", "research"],
    ["tasks", "tasks"],
  ] as const;
  const decisions: string[] = [];
  const details: Record<string, ReviewDetail> = {};
  const breakdown: SdlcBreakdownView = {
    itemId: uid(113),
    source: "draft",
    docKey: "project/payment-api/sdlc/013-sua-loi-lam-tron/tasks",
    revision: 1,
    breakdown: {
      parser: "speckit-tasks",
      granularity: "item",
      requirements: ["FR-001"],
      tasks: [
        {
          sliceKey: "T001",
          title: "API hoàn tiền",
          body: "Giới hạn tổng tiền hoàn",
          project: PAYMENT.key,
          requirementIds: ["FR-001"],
          checklist: [],
          dependsOn: [],
          files: ["src/refund.ts"],
          parallel: false,
          line: 1,
        },
      ],
      waves: [["T001"]],
    },
    errors: [],
    coverage: {
      total: { requirements: 1, planned: 100, done: 0, verified: 0 },
      byProject: [{ projectKey: PAYMENT.key, coverage: { requirements: 1, planned: 100, done: 0, verified: 0 } }],
      missing: [],
    },
  };
  const create = rpc["sdlc/items/create"];
  const answer = rpc["sdlc/questions/answer"];
  if (!create || !answer) throw new Error("Thiếu thủ tục hạng mục");
  const hub = await inOrg(page, "admin", {
    ...rpc,
    "sdlc/items/create": (input, call, fake) => {
      create(input, call, fake);
      state.questions = state.questions.map((q) => ({
        ...q,
        itemId: state.item.id,
        phaseId: "specify",
        item: { ...q.item, ref: "013" },
      }));
      state.item = {
        ...state.item,
        questions: state.questions,
        openQuestions: 2,
        artifacts: specs.map(([phaseId, artifactId], i) => {
          const id = uid(501 + i);
          const docKey = `project/payment-api/sdlc/013-sua-loi-lam-tron/${artifactId}`;
          details[id] = {
            ...template,
            id,
            docKey,
            docTitle: `${artifactId}.md`,
            docType: artifactId,
            baseVersion: 0,
            baseContent: "",
            content:
              artifactId === "tasks"
                ? "# Tasks\n- [ ] T001 [payment-api] [FR-001] API hoàn tiền"
                : `# ${artifactId}\nFR-001: Tổng tiền hoàn không vượt số tiền gốc.`,
            canDecide: true,
            gates: template.gates.map((g) => ({ ...g, approvals: [] })),
            trace: [],
          };
          const artifact = state.item.artifacts[0];
          if (!artifact) throw new Error("Thiếu tài liệu mẫu");
          return {
            ...artifact,
            id: uid(211 + i),
            phaseId,
            artifactId,
            name: `${artifactId}.md`,
            docKey,
            repoPath: `specs/013-sua-loi-lam-tron/${artifactId}.md`,
            baselineVersion: null,
            approval: "none" as const,
            reviewId: id,
            hasDraft: true,
          };
        }),
      };
      return ok(state.item);
    },
    "sdlc/questions/answer": (input, call, fake) => {
      const response = answer(input, call, fake);
      state.item = {
        ...state.item,
        questions: state.questions,
        openQuestions: state.questions.filter((q) => q.status === "open").length,
      };
      return response;
    },
    "reviews/list": () => ok({ items: Object.values(details), nextCursor: null }),
    "reviews/get": (input) => ok(details[(input as { id: string }).id]),
    "reviews/decide": (input) => {
      const { id, decision } = input as { id: string; decision: string };
      if (decision !== "approve") throw new Error("Cần duyệt trong kịch bản MVP");
      decisions.push(id);
      const detail = details[id];
      if (!detail) throw new Error("Thiếu phiên duyệt");
      details[id] = {
        ...detail,
        status: "approved",
        canDecide: false,
        awaitingMe: false,
        currentGate: null,
        gate: null,
        gates: detail.gates.map((g) => ({ ...g, status: "passed" })),
      };
      state.item = {
        ...state.item,
        artifacts: state.item.artifacts.map((a) =>
          a.reviewId === id ? { ...a, baselineVersion: 1, approval: "human", hasDraft: false } : a,
        ),
      };
      if (decisions.length === 4) {
        const task: SdlcItemTask = {
          taskId: uid(601),
          key: "PAY-13",
          title: "API hoàn tiền",
          projectId: PAYMENT.id,
          projectKey: PAYMENT.key,
          sliceKey: "T001",
          status: "todo",
          wave: 0,
          requirementIds: ["FR-001"],
          checklist: [],
          dependsOn: [],
          blockedBy: [],
          removed: false,
          run: null,
        };
        state.item = {
          ...state.item,
          tasks: [task],
          phases: state.item.phases.map((p) => ({ ...p, status: p.id === "implement" ? "drafting" : "approved" })),
        };
      }
      return ok(details[id]);
    },
    "sdlc/breakdown/get": () => ok(breakdown),
    "sdlc/waves/run": () => {
      state.item = {
        ...state.item,
        tasks: state.item.tasks.map((t) => ({
          ...t,
          status: "review",
          run: { id: uid(701), state: "succeeded", prUrl: "https://example.test/acme/payment-api/pull/27" },
        })),
      };
      return ok({ started: [{ taskId: uid(601), runId: uid(701) }], skipped: [] });
    },
  });
  await page.goto("/sdlc/new");
  await page.getByLabel("Dự án chính").selectOption({ label: "payment-api" });
  await page.getByLabel("Tiêu đề", { exact: true }).fill("Hoàn tiền một phần");
  await page
    .getByRole("textbox", { name: "Ý tưởng" })
    .fill("Cho phép hoàn tiền một phần, tổng hoàn không vượt số tiền gốc.");
  await expect(page.getByText("Đụng thanh toán, nhiều màn → L → Spec Kit")).toBeVisible();
  await page.getByRole("button", { name: "Tạo hạng mục" }).click();
  await expect(page).toHaveURL(/payment-api\/13$/);
  await page.goto("/sdlc/questions");
  await page.getByRole("button", { name: "Dùng đề xuất" }).first().click();
  await page.getByRole("radio", { name: "Không giới hạn" }).check();
  await page.getByRole("button", { name: "Gửi câu trả lời (1/1)" }).click();
  await expect(page.getByText("Không có câu hỏi nào đang chờ bạn.")).toBeVisible();
  for (const [, name] of specs) {
    await page.goto("/sdlc/payment-api/13/docs");
    const artifact = page
      .locator("li")
      .filter({ hasText: `${name}.md` })
      .first();
    await artifact.getByRole("link", { name: "Mở phiên duyệt" }).click();
    await expect(page.getByRole("heading", { name: `${name}.md`, exact: true })).toBeVisible();
    if (name === "tasks") {
      await expect(page.getByText("API hoàn tiền", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("100%", { exact: true }).first()).toBeVisible();
    }
    await page.getByRole("button", { name: "Duyệt", exact: true }).click();
    await expect.poll(() => decisions.length).toBe(specs.findIndex((s) => s[1] === name) + 1);
  }
  await page.goto("/sdlc/payment-api/13/tasks");
  await expect(page.getByText("API hoàn tiền", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Chạy đợt" }).click();
  const pr = page.getByRole("link", { name: "Mở PR" });
  await expect(pr).toHaveAttribute("href", "https://example.test/acme/payment-api/pull/27");
  await page
    .context()
    .route("https://example.test/**", (route) =>
      route.fulfill({ body: "PR #27: API hoàn tiền", contentType: "text/html" }),
    );
  const popup = page.waitForEvent("popup");
  await pr.click();
  await expect((await popup).locator("body")).toContainText("PR #27");
  expect(hub.rpcCalls.filter((c) => c.path === "reviews/decide")).toHaveLength(4);
  expect(hub.rpcCalls.filter((c) => c.path === "sdlc/waves/run")).toHaveLength(1);
});
