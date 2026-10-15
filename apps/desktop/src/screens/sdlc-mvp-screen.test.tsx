import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReviewDetail, SdlcBreakdownView, SdlcItemTask } from "@xdev-hive/contracts";
import { useSyncExternalStore } from "react";
import { expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import { ReviewsScreen } from "@/screens/reviews-screen.tsx";
import { SdlcQuestionsScreen } from "@/screens/sdlc-questions-screen.tsx";
import { SdlcScreen, subscribeHash } from "@/screens/sdlc-screen.tsx";
import { installSdlcHub, PAYMENT } from "@/screens/sdlc-test-fixture.ts";

const uid = (n: number) => `5d5d5d5d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ok = (data: unknown) => ({ body: { json: data } });
const ba: Account = {
  name: "An",
  email: "an@example.test",
  orgId: "o",
  orgName: "Hive",
  orgRole: "member",
  teams: [{ id: PAYMENT.teamId, name: "Backend", role: "ba" }],
};

function Screens() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash);
  if (hash.startsWith("#/reviews/")) return <ReviewsScreen />;
  if (hash === "#/sdlc-questions") return <SdlcQuestionsScreen />;
  return <SdlcScreen />;
}

// Hub giả thay đổi baseline và task; test đi qua màn thật và cầu hub_rpc của desktop.
it("SC-009: BA/PO tạo và duyệt; thành viên chạy đợt rồi mở PR", async () => {
  setLang("vi");
  location.hash = "#/sdlc/new";
  const { rpc, state, calls } = installSdlcHub({ participants: [] });
  state.item.can = { ...state.item.can, manage: false, override: false, runWaves: false };
  const specs = [
    ["specify", "spec"],
    ["plan", "plan"],
    ["plan", "research"],
    ["tasks", "tasks"],
  ] as const;
  const reviews: Record<string, ReviewDetail> = {};
  const decided: string[] = [];
  const create = rpc["sdlc/items/create"];
  const answer = rpc["sdlc/questions/answer"];
  if (!create || !answer) throw new Error("Thiếu thủ tục hạng mục");
  rpc["teams/list"] = () => ok([{ id: PAYMENT.teamId, name: "Backend" }]);
  rpc["sdlc/items/create"] = (input) => {
    create(input);
    state.questions = state.questions.map((q) => ({ ...q, itemId: state.item.id, phaseId: "specify" }));
    state.item = {
      ...state.item,
      questions: state.questions,
      openQuestions: 2,
      artifacts: specs.map(([phaseId, artifactId], i) => {
        const id = uid(501 + i);
        const docKey = `project/payment-api/sdlc/013-sua-loi-lam-tron/${artifactId}`;
        reviews[id] = {
          id,
          proposalId: uid(801 + i),
          workflowId: uid(901),
          workflowName: "Spec Kit",
          docKey,
          docTitle: `${artifactId}.md`,
          docType: artifactId,
          status: "in_review",
          baseVersion: 0,
          baseContent: "",
          content: "# Yêu cầu\nFR-001: Giới hạn tổng tiền hoàn.",
          reason: null,
          author: { userId: null, runId: uid(900), name: "Agent" },
          awaitingMe: true,
          aiScore: 9,
          addedLines: 2,
          deletedLines: 0,
          createdAt: state.item.createdAt,
          updatedAt: state.item.updatedAt,
          gate: {
            id: "po",
            name: "BA/PO duyệt",
            kind: "human",
            phase: phaseId,
            index: 0,
            total: 1,
            dueAt: null,
            sla: "none",
          },
          gates: [
            {
              gateId: "po",
              name: "BA/PO duyệt",
              kind: "human",
              phase: phaseId,
              status: "waiting",
              score: null,
              checklist: [],
              approvals: [],
              note: null,
              decidedBy: null,
              startedAt: null,
              finishedAt: null,
              runId: null,
            },
          ],
          trace: [],
          canDecide: true,
          previousGate: null,
          currentGate: null,
        };
        const template = state.item.artifacts[0];
        if (!template) throw new Error("Thiếu tài liệu mẫu");
        return {
          ...template,
          id: uid(211 + i),
          phaseId,
          artifactId,
          name: `${artifactId}.md`,
          docKey,
          reviewId: id,
          baselineVersion: null,
          approval: "none" as const,
          hasDraft: true,
        };
      }),
    };
    return ok(state.item);
  };
  rpc["sdlc/questions/answer"] = (input) => {
    const response = answer(input);
    state.item = {
      ...state.item,
      questions: state.questions,
      openQuestions: state.questions.filter((q) => q.status === "open").length,
    };
    return response;
  };
  rpc["reviews/get"] = (input) => ok(reviews[(input as { id: string }).id]);
  rpc["reviews/decide"] = (input) => {
    const { id, decision } = input as { id: string; decision: string };
    expect(decision).toBe("approve");
    const d = reviews[id];
    if (!d) throw new Error("Thiếu phiên duyệt");
    decided.push(id);
    reviews[id] = {
      ...d,
      status: "approved",
      canDecide: false,
      awaitingMe: false,
      gate: null,
      gates: d.gates.map((g) => ({ ...g, status: "passed" })),
    };
    state.item = {
      ...state.item,
      artifacts: state.item.artifacts.map((a) =>
        a.reviewId === id ? { ...a, baselineVersion: 1, approval: "human", hasDraft: false } : a,
      ),
    };
    if (decided.length === 4) {
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
      state.item = { ...state.item, tasks: [task] };
    }
    return ok(reviews[id]);
  };
  const coverage = { requirements: 1, planned: 100, done: 0, verified: 0 };
  rpc["sdlc/breakdown/get"] = () =>
    ok({
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
      coverage: { total: coverage, byProject: [{ projectKey: PAYMENT.key, coverage }], missing: [] },
    } satisfies SdlcBreakdownView);
  rpc["sdlc/waves/run"] = () => {
    state.item = {
      ...state.item,
      tasks: state.item.tasks.map((t) => ({
        ...t,
        status: "review",
        run: { id: uid(701), state: "succeeded", prUrl: "https://example.test/payment-api/pull/27" },
      })),
    };
    return ok({ started: [{ taskId: uid(601), runId: uid(701) }], skipped: [] });
  };
  const { rerender } = render(
    <AccountContext.Provider value={ba}>
      <Screens />
    </AccountContext.Provider>,
  );
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText("Dự án chính"), PAYMENT.id);
  await user.type(screen.getByLabelText("Tiêu đề"), "Hoàn tiền một phần");
  await user.type(screen.getByRole("textbox", { name: "Ý tưởng" }), "Cho phép hoàn tiền một phần theo số tiền gốc.");
  expect(await screen.findByText("Đụng thanh toán, nhiều màn → L → Spec Kit")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Tạo hạng mục" }));
  expect(await screen.findByRole("heading", { name: /Hoàn tiền một phần/ })).toBeTruthy();
  act(() => {
    location.hash = "#/sdlc-questions";
  });
  await user.click((await screen.findAllByRole("button", { name: "Dùng đề xuất" }))[0] as HTMLElement);
  await user.click(await screen.findByRole("radio", { name: "Không giới hạn" }));
  await user.click(screen.getByRole("button", { name: "Gửi câu trả lời (1/1)" }));
  expect(await screen.findByText("Không có câu hỏi nào đang chờ bạn.")).toBeTruthy();
  for (const [, name] of specs) {
    act(() => {
      location.hash = "#/sdlc/payment-api/13/docs";
    });
    const link = (await screen.findAllByRole("link", { name: "Mở phiên duyệt" })).find((a) =>
      a.closest("li")?.textContent?.includes(`${name}.md`),
    );
    if (!link) throw new Error(`Thiếu phiên duyệt ${name}`);
    await user.click(link);
    expect(await screen.findByRole("heading", { name: `${name}.md` })).toBeTruthy();
    if (name === "tasks") expect(await screen.findByText("API hoàn tiền", { exact: true })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Duyệt" }));
    await waitFor(() => expect(decided).toHaveLength(specs.findIndex((s) => s[1] === name) + 1));
  }
  act(() => {
    location.hash = "#/sdlc/payment-api/13/tasks";
  });
  expect(await screen.findByText("API hoàn tiền", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Chạy đợt" })).toBeNull();
  expect(calls.filter((c) => c.path === "sdlc/waves/run")).toHaveLength(0);
  state.item.can = { ...state.item.can, runWaves: true };
  rerender(
    <AccountContext.Provider value={{ ...ba, teams: ba.teams.map((t) => ({ ...t, role: "member" })) }}>
      <Screens />
    </AccountContext.Provider>,
  );
  await act(async () => {
    await queryClient.invalidateQueries();
  });
  await user.click(await screen.findByRole("button", { name: "Chạy đợt" }));
  const pr = await screen.findByRole("link", { name: "Mở PR" });
  expect(pr.getAttribute("href")).toBe("https://example.test/payment-api/pull/27");
  expect(within(pr.closest("li") as HTMLElement).getByText("API hoàn tiền")).toBeTruthy();
  expect(calls.filter((c) => c.path === "reviews/decide")).toHaveLength(4);
  expect(calls.filter((c) => c.path === "sdlc/waves/run")).toHaveLength(1);
});
