// @vitest-environment jsdom
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  type Contract,
  type GateRun,
  projectSdlcSettings,
  type ReviewDetail,
  SDLC_PRESETS,
  type SdlcAutoApproval,
  type SdlcItemDetail,
  type SdlcQuestion,
} from "@xdev-hive/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type DocEditorEnv, DocEditorProvider } from "./env.tsx";
import { ReviewPane } from "./review-pane.tsx";
import { parseSdlcDocKey, SdlcPanel, sectionPresence } from "./sdlc-panel.tsx";

const NOW = "2026-10-14T03:42:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SPECKIT = (() => {
  const mode = SDLC_PRESETS.speckit;
  if (!mode) throw new Error("Thiếu preset speckit");
  return mode;
})();
const PLAN_KEY = "project/payment-api/sdlc/012-hoan-tien-mot-phan/plan";
const TASKS_KEY = "project/payment-api/sdlc/012-hoan-tien-mot-phan/tasks";

function question(n: number, over: Partial<SdlcQuestion> = {}): SdlcQuestion {
  return {
    id: uuid(300 + n),
    itemId: uuid(112),
    item: { ref: "012", title: "Hoàn tiền một phần", projectKey: "payment-api" },
    phaseId: "plan",
    round: 1,
    position: n,
    text: `Câu hỏi ${n}?`,
    options: ["Có", "Không"],
    recommended: "Có",
    context: null,
    status: "answered",
    answer: "Có",
    usedRecommended: true,
    answeredBy: { userId: "u2", name: "An" },
    answeredAt: NOW,
    createdAt: NOW,
    ...over,
  };
}

function autoApproval(over: Partial<SdlcAutoApproval> = {}): SdlcAutoApproval {
  return {
    id: uuid(400),
    itemId: uuid(112),
    artifactId: uuid(212),
    docKey: PLAN_KEY,
    artifactName: "plan.md",
    reviewId: uuid(500),
    gateId: "lead",
    gateName: "Tech lead duyệt",
    version: 2,
    score: 9.3,
    threshold: 9,
    reasons: [{ check: "sensitive", passed: true, detail: "Không chạm đường dẫn nhạy cảm" }],
    reviewer: { cli: "claude", model: "claude-opus-5-5" },
    decidedAt: NOW,
    revocableUntil: "2099-01-01T00:00:00.000Z",
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    rereviewId: null,
    canRevoke: true,
    ...over,
  };
}

function artifact(n: number, phaseId: string, artifactId: string) {
  return {
    id: uuid(n),
    phaseId,
    artifactId,
    name: `${artifactId}.md`,
    scope: "item" as const,
    instance: "",
    required: true,
    docKey: `project/payment-api/sdlc/012-hoan-tien-mot-phan/${artifactId}`,
    repoPath: `specs/012-hoan-tien-mot-phan/${artifactId}.md`,
    projectId: uuid(1),
    consumerProjectIds: [],
    contractFormat: null,
    baselineVersion: null,
    approval: "none" as const,
    reviewId: null,
    hasDraft: true,
    syncs: [],
  };
}

/** Hạng mục 012 ở giai đoạn Plan, hai dự án; chỉ những trường khung bên và ReviewPane đọc. */
function item(over: Partial<SdlcItemDetail> = {}): SdlcItemDetail {
  const settings = projectSdlcSettings.parse({ enabled: true });
  const projects = [
    { key: "payment-api", team: "Backend", role: "home" as const },
    { key: "web-shop", team: "Web", role: "participant" as const },
  ];
  return {
    id: uuid(112),
    project: { id: uuid(1), key: "payment-api", name: "payment-api" },
    number: 12,
    ref: "012",
    slug: "hoan-tien-mot-phan",
    title: "Hoàn tiền một phần",
    modeRef: "speckit",
    modeName: "Spec Kit",
    size: "L",
    status: "active",
    mode: SPECKIT,
    projectsDetail: projects.map((p, i) => ({
      id: uuid(i + 1),
      key: p.key,
      name: p.key,
      teamId: uuid(900 + i),
      teamName: p.team,
      role: p.role,
      enabled: true,
      settings,
      addedBy: "u1",
      addedAt: NOW,
    })),
    phases: SPECKIT.phases.map((p, index) => ({
      id: p.id,
      index,
      name: p.id === "plan" ? "Plan" : p.name,
      kind: p.kind,
      optional: p.optional,
      status: index === 0 ? ("approved" as const) : index === 1 ? ("in_review" as const) : ("pending" as const),
      note: null,
      requiredApproved: 0,
      requiredTotal: 1,
      startedAt: null,
      approvedAt: null,
    })),
    artifacts: [artifact(212, "plan", "plan"), artifact(214, "tasks", "tasks")],
    questions: [question(1), question(2, { status: "open", answer: null }), question(3, { phaseId: "specify" })],
    steps: [],
    autoApprovals: [autoApproval()],
    can: { write: true, manage: true, override: true, runWaves: true, editProjects: true, changeMode: false },
    ...over,
  } as SdlcItemDetail;
}

function gate(over: Partial<GateRun>): GateRun {
  return {
    gateId: "lead",
    name: "Tech lead duyệt",
    kind: "human",
    phase: "plan",
    status: "passed",
    score: null,
    checklist: [],
    approvals: [],
    note: null,
    decidedBy: null,
    startedAt: NOW,
    finishedAt: NOW,
    runId: null,
    ...over,
  };
}

function review(over: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    id: uuid(500),
    proposalId: uuid(501),
    docKey: PLAN_KEY,
    docTitle: "plan.md",
    docType: "plan",
    workflowName: "AI SDLC",
    status: "approved",
    gate: null,
    author: { userId: null, runId: null, name: "Agent" },
    awaitingMe: false,
    aiScore: 9.3,
    addedLines: 1,
    deletedLines: 0,
    createdAt: NOW,
    updatedAt: NOW,
    baseVersion: 1,
    baseContent: "# Plan\n",
    content: "# Plan\n\nThêm\n",
    reason: null,
    gates: [],
    trace: [],
    canDecide: false,
    previousGate: null,
    currentGate: null,
    ...over,
  } as ReviewDetail;
}

function fakeClient(data: { item?: SdlcItemDetail; review?: ReviewDetail } = {}) {
  const it = data.item ?? item();
  return {
    reviews: { get: vi.fn(async () => data.review ?? review()), decide: vi.fn() },
    teams: { list: vi.fn(async () => []) },
    orgMembers: { list: vi.fn(async () => []) },
    sdlc: {
      items: {
        get: vi.fn(async (_input: { projectKey: string; number: number }) => it),
        step: vi.fn(async (_input: { id: string; phaseId: string; stepId: string; instructions?: string }) => it),
      },
    },
  };
}

function env(client: ReturnType<typeof fakeClient>, withSdlc = true): DocEditorEnv {
  return {
    api: createTanstackQueryUtils(client as unknown as ContractRouterClient<Contract>),
    lang: "vi",
    errorMessage: (e) => String(e),
    link: ({ to, children, className }) => (
      <a href={`#/${to.kind}`} className={className}>
        {children}
      </a>
    ),
    ...(withSdlc
      ? {
          sdlc: {
            itemLink: ({ projectKey, number, tab, children }) => (
              <a href={`#/sdlc/${projectKey}/${number}${tab ? `/${tab}` : ""}`}>{children}</a>
            ),
          },
        }
      : {}),
  };
}

let root: Root | null = null;
let host: HTMLElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

async function mount(e: DocEditorEnv, ui: ReactNode) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={qc}>
        <DocEditorProvider env={e}>{ui}</DocEditorProvider>
      </QueryClientProvider>,
    );
  });
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(() => new Promise((r) => setTimeout(r, 10)));
  }
  expect(check()).toBe(true);
}

const text = () => host.textContent ?? "";

describe("parseSdlcDocKey", () => {
  it("đọc hạng mục của dự án chính và của dự án tham gia", () => {
    expect(parseSdlcDocKey(PLAN_KEY)).toEqual({ projectKey: "payment-api", number: 12 });
    expect(parseSdlcDocKey("project/web-shop/sdlc/payment-api-012-hoan-tien/spec")).toEqual({
      projectKey: "payment-api",
      number: 12,
    });
  });

  it("bỏ qua tài liệu không thuộc AI SDLC", () => {
    expect(parseSdlcDocKey("project/payment-api/docs/plan")).toBeNull();
    expect(parseSdlcDocKey("project/payment-api/sdlc/012-hoan-tien")).toBeNull();
    expect(parseSdlcDocKey("team/backend/sdlc/012-x/plan")).toBeNull();
  });
});

describe("sectionPresence", () => {
  it("so tiêu đề bỏ hoa thường và khoảng trắng", () => {
    const content = "# Plan\n\n## summary\n\ntext\n\n### Technical   Context ##\n";
    expect(sectionPresence(content, ["Summary", "Technical Context", "Project Structure"])).toEqual([
      { name: "Summary", present: true },
      { name: "Technical Context", present: true },
      { name: "Project Structure", present: false },
    ]);
  });
});

describe("SdlcPanel", () => {
  it("hiện giai đoạn, mục bắt buộc, câu đã trả lời và nhờ agent soạn lại", async () => {
    const client = fakeClient();
    const e = env(client);
    await mount(e, <SdlcPanel docKey={PLAN_KEY} content={"# Plan\n\n## Summary\n"} sdlc={e.sdlc} />);
    await until(() => text().includes("Hạng mục 012 · Plan"));
    expect(client.sdlc.items.get).toHaveBeenCalledWith({ projectKey: "payment-api", number: 12 }, expect.anything());
    expect(text()).toContain("Mỗi đội tham gia có một checkpoint riêng: Tech lead duyệt");
    expect(text()).toContain("Tự duyệt bởi AI · 9,3/10 (ngưỡng 9)");
    const required = host.querySelector('section[aria-label="Mục bắt buộc"]')?.textContent ?? "";
    expect(required).toContain("Summary (đã có)");
    expect(required).toContain("Project Structure (chưa có)");
    // Câu chưa trả lời và câu của giai đoạn khác không thuộc tài liệu này.
    const qa = host.querySelector('section[aria-label="Câu hỏi đã trả lời"]')?.textContent ?? "";
    expect(qa).toContain("Câu hỏi 1?");
    expect(qa).not.toContain("Câu hỏi 2?");
    expect(qa).not.toContain("Câu hỏi 3?");
    expect(host.querySelector('a[href="#/sdlc/payment-api/12"]')).not.toBeNull();

    const textarea = host.querySelector("textarea");
    if (!textarea) throw new Error("thiếu ô chỉ dẫn");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      set?.call(textarea, "Giữ nguyên câu đã trả lời");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Nhờ agent soạn lại"));
    await act(async () => submit?.click());
    await until(() => client.sdlc.items.step.mock.calls.length === 1);
    expect(client.sdlc.items.step.mock.calls[0]?.[0]).toEqual({
      id: uuid(112),
      phaseId: "plan",
      stepId: "draft-plan",
      instructions: "Giữ nguyên câu đã trả lời",
    });
    await until(() => text().includes("Đã giao cho agent"));
  });

  it("người chỉ đọc không có nút soạn lại", async () => {
    const client = fakeClient({ item: item({ can: { ...item().can, write: false } }) });
    const e = env(client);
    await mount(e, <SdlcPanel docKey={PLAN_KEY} content="" sdlc={e.sdlc} />);
    await until(() => text().includes("Chỉ đọc"));
    expect(text()).toContain("Bạn chỉ có quyền đọc hạng mục này");
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("báo máy chờ khi bước agent đang xếp hàng", async () => {
    const step = {
      id: uuid(700),
      phaseId: "plan",
      stepId: "draft-plan",
      action: "draft" as const,
      round: 1,
      status: "queued" as const,
      run: null,
      waitingReason: "Không máy nào có nhãn sdlc",
      instructions: null,
      result: null,
      error: null,
      createdBy: "u1",
      createdAt: NOW,
      finishedAt: null,
    };
    const client = fakeClient({ item: item({ steps: [step] }) });
    const e = env(client);
    await mount(e, <SdlcPanel docKey={PLAN_KEY} content="" sdlc={e.sdlc} />);
    await until(() => text().includes("Chờ máy AI SDLC"));
    expect(text()).toContain("Không máy nào có nhãn sdlc");
    const submit = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Nhờ agent soạn lại"));
    expect(submit?.disabled).toBe(true);
  });
});

describe("ReviewPane với hạng mục AI SDLC", () => {
  it("hiện checkpoint tự duyệt kèm nút Thu hồi, sự kiện không tự duyệt và câu đã trả lời", async () => {
    const client = fakeClient({
      review: review({
        gates: [
          gate({
            gateId: "lead~backend",
            name: "Tech lead duyệt · Backend (payment-api)",
            auto: { score: 9.3, threshold: 9, approvalId: uuid(400) },
          }),
          gate({
            gateId: "lead~web",
            name: "Tech lead duyệt · Web (web-shop)",
            status: "waiting",
            note: "Không tự duyệt: Điểm 8,5 < ngưỡng 9.",
          }),
        ],
      }),
    });
    const revoke = vi.fn((a: SdlcAutoApproval) => <button type="button">Thu hồi {a.gateName}</button>);
    await mount(
      env(client),
      <ReviewPane id={uuid(500)} now={Date.parse(NOW)} onDecided={() => {}} sdlc={{ revoke }} />,
    );
    await until(() => text().includes("Câu hỏi đã trả lời"));
    const steps = host.querySelector('ol[aria-label="Các bước duyệt"]')?.textContent ?? text();
    expect(steps).toContain("Tech lead duyệt · Backend (payment-api) · Tự duyệt bởi AI · 9,3/10");
    expect(text()).toContain("Không tự duyệt");
    expect(text()).toContain("Điểm 8,5 < ngưỡng 9.");
    expect(text()).toContain("Không chạm đường dẫn nhạy cảm");
    expect(text()).toContain("Thu hồi được tới");
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ id: uuid(400) }));
    expect(text()).toContain("Thu hồi Tech lead duyệt");
    // Tài liệu Plan không phải tài liệu tách việc: không có thẻ bản tách.
    expect(text()).not.toContain("Bản tách task");
  });

  it("hết hạn thu hồi thì không còn nút", async () => {
    const client = fakeClient({
      item: item({ autoApprovals: [autoApproval({ revocableUntil: "2026-10-13T00:00:00.000Z" })] }),
      review: review({ gates: [gate({ auto: { score: 9.3, threshold: 9, approvalId: uuid(400) } })] }),
    });
    const revoke = vi.fn(() => <button type="button">Thu hồi</button>);
    await mount(
      env(client),
      <ReviewPane id={uuid(500)} now={Date.parse(NOW)} onDecided={() => {}} sdlc={{ revoke }} />,
    );
    await until(() => text().includes("Hạn thu hồi đã qua"));
    expect(revoke).not.toHaveBeenCalled();
  });

  it("tài liệu tách việc hiện thẻ bản tách từ app chủ", async () => {
    const client = fakeClient({ review: review({ docKey: TASKS_KEY, docTitle: "tasks.md" }) });
    const breakdown = vi.fn((it: SdlcItemDetail) => <p>Bản tách của {it.ref}</p>);
    await mount(
      env(client),
      <ReviewPane id={uuid(500)} now={Date.parse(NOW)} onDecided={() => {}} sdlc={{ breakdown }} />,
    );
    await until(() => text().includes("Bản tách của 012"));
    expect(text()).toContain("Bản tách task");
    expect(host.querySelector('a[href="#/sdlc/payment-api/12/tasks"]')?.textContent).toBe("Mở bản tách đầy đủ");
  });

  it("phiên duyệt thường không gọi API hạng mục", async () => {
    const client = fakeClient({ review: review({ docKey: "project/payment-api/docs/adr-1" }) });
    await mount(env(client, false), <ReviewPane id={uuid(500)} now={Date.parse(NOW)} onDecided={() => {}} />);
    await until(() => text().includes("plan.md"));
    expect(client.sdlc.items.get).not.toHaveBeenCalled();
  });
});
