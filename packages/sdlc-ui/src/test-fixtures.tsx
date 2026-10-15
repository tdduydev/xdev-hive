import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import {
  type Contract,
  defaultProjectSettings,
  type Project,
  projectSdlcSettings,
  SDLC_PHASE_KINDS,
  SDLC_PRESETS,
  type SdlcAutoApproval,
  type SdlcBreakdownView,
  type SdlcItemDetail,
  type SdlcItemSummary,
  type SdlcMetrics,
  type SdlcModeView,
  type SdlcPhaseKind,
  type SdlcQuestion,
  type SdlcTrace,
} from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { type SdlcEnv, SdlcProvider } from "./env.tsx";

export const NOW = "2026-10-14T03:42:00.000Z";
export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const TEAM_BACKEND = uuid(901);
export const TEAM_WEB = uuid(902);

export function project(
  n: number,
  key: string,
  over: { enabled?: boolean; teamId?: string; modes?: string[]; defaultMode?: string | null } = {},
): Project {
  return {
    id: uuid(n),
    systemId: uuid(800),
    teamId: over.teamId ?? TEAM_BACKEND,
    key,
    name: key,
    state: "active",
    repo: {
      mode: "existing",
      connectionId: uuid(700),
      kind: "github",
      owner: "acme",
      name: key,
      defaultBranch: "main",
      visibility: "private",
      httpUrl: null,
      sshUrl: null,
      webUrl: null,
    },
    settings: {
      ...defaultProjectSettings(),
      sdlc: projectSdlcSettings.parse({
        enabled: over.enabled ?? true,
        defaultMode: over.defaultMode === undefined ? "speckit" : over.defaultMode,
        modes: over.modes ?? ["speckit", "bugfix"],
      }),
    },
    createdBy: "u1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export const PAYMENT = project(1, "payment-api");
export const WEB = project(2, "web-shop", { teamId: TEAM_WEB });
export const RECONCILE = project(3, "reconcile", { enabled: false });

export function summary(
  n: number,
  over: Partial<SdlcItemSummary> & { kind?: SdlcPhaseKind; projects?: SdlcItemSummary["projects"] } = {},
): SdlcItemSummary {
  const { kind = "requirements", ...rest } = over;
  return {
    id: uuid(100 + n),
    project: { id: PAYMENT.id, key: PAYMENT.key, name: PAYMENT.name },
    number: n,
    ref: String(n).padStart(3, "0"),
    slug: "hoan-tien-mot-phan",
    title: "Hoàn tiền một phần",
    modeRef: "speckit",
    modeName: "Spec Kit",
    method: "speckit",
    size: "L",
    status: "active",
    phase: { id: kind, name: "Specify", kind, status: "in_review", index: SDLC_PHASE_KINDS.indexOf(kind), total: 5 },
    waitingFor: "Chờ An (PO) · quá hạn 3 giờ",
    waitingMachine: false,
    openQuestions: 0,
    projects: [{ id: PAYMENT.id, key: PAYMENT.key, name: PAYMENT.name, role: "home" }],
    coverage: null,
    costUsd: 1.84,
    owner: { userId: "u1", name: "Trần Lan" },
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

export function modeView(ref: string): SdlcModeView {
  const definition = SDLC_PRESETS[ref as keyof typeof SDLC_PRESETS];
  if (!definition) throw new Error(`Không có preset ${ref}`);
  return {
    ref,
    preset: true,
    teamId: null,
    slug: ref,
    basePreset: null,
    version: 1,
    enabled: true,
    definition,
    openItems: 0,
    updatedAt: null,
  };
}

export function question(n: number, over: Partial<SdlcQuestion> = {}): SdlcQuestion {
  return {
    id: uuid(300 + n),
    itemId: uuid(112),
    item: { ref: "012", title: "Hoàn tiền một phần", projectKey: "payment-api" },
    phaseId: "specify",
    round: 1,
    position: n,
    text: `Câu hỏi ${n}?`,
    options: ["Có", "Không"],
    recommended: "Có",
    context: null,
    status: "open",
    answer: null,
    usedRecommended: false,
    answeredBy: null,
    answeredAt: null,
    createdAt: NOW,
    ...over,
  };
}

const SPECKIT = modeView("speckit").definition;

export function autoApproval(over: Partial<SdlcAutoApproval> = {}): SdlcAutoApproval {
  return {
    id: uuid(400),
    itemId: uuid(112),
    artifactId: uuid(212),
    docKey: "project/payment-api/sdlc/012-hoan-tien-mot-phan/plan",
    artifactName: "plan.md",
    reviewId: uuid(500),
    gateId: "lead",
    gateName: "Tech lead duyệt",
    version: 2,
    score: 9.3,
    threshold: 9,
    reasons: [
      { check: "score", passed: true, detail: "Điểm 9,3 ≥ ngưỡng 9" },
      { check: "sensitive", passed: true, detail: "Không chạm đường dẫn nhạy cảm" },
    ],
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

/** Hạng mục 012 Spec Kit ở giai đoạn Plan, hai dự án, một contract, một task mỗi đợt. */
export function itemDetail(over: Partial<SdlcItemDetail> = {}): SdlcItemDetail {
  const base = summary(12, {
    kind: "design",
    projects: [
      { id: PAYMENT.id, key: PAYMENT.key, name: PAYMENT.name, role: "home" },
      { id: WEB.id, key: WEB.key, name: WEB.name, role: "participant" },
    ],
  });
  const settings = PAYMENT.settings.sdlc ?? projectSdlcSettings.parse({ enabled: true });
  const sync = (projectId: string, projectKey: string, state: "synced" | "failed") => ({
    projectId,
    projectKey,
    kind: "source" as const,
    repoPath: "specs/012-hoan-tien-mot-phan/spec.md",
    state,
    syncedVersion: state === "synced" ? 1 : null,
    syncedCommit: null,
    error: state === "failed" ? "Không có quyền ghi repo" : null,
    attempts: 1,
    syncedAt: state === "synced" ? NOW : null,
    prUrl: null,
  });
  const artifact = (n: number, phaseId: string, artifactId: string, name: string) => ({
    id: uuid(n),
    phaseId,
    artifactId,
    name,
    scope: "item" as const,
    instance: "",
    required: true,
    docKey: `project/payment-api/sdlc/012-hoan-tien-mot-phan/${artifactId}`,
    repoPath: `specs/012-hoan-tien-mot-phan/${name}`,
    projectId: PAYMENT.id,
    consumerProjectIds: [],
    contractFormat: null,
    baselineVersion: null,
    approval: "none" as const,
    reviewId: null,
    hasDraft: false,
    syncs: [],
  });
  const task = (n: number, wave: number, projectKey: string, projectId: string) => ({
    taskId: uuid(600 + n),
    key: `T-${40 + n}`,
    title: `Task ${n}`,
    status: "todo" as const,
    projectId,
    projectKey,
    sliceKey: `T00${n}`,
    wave,
    requirementIds: ["FR-001"],
    checklist: [{ id: "c1", text: "Viết test", done: true, requirementIds: [] }],
    dependsOn: [],
    blockedBy: [],
    removed: false,
    run: null,
  });
  return {
    ...base,
    idea: "Cho phép hoàn tiền một phần cho giao dịch thẻ.",
    source: { kind: "manual", url: null, issueNumber: null, path: null },
    mode: SPECKIT,
    sizeSuggested: "L",
    suggestion: null,
    settings,
    projectsDetail: [PAYMENT, WEB].map((p, i) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      teamId: p.teamId,
      teamName: i ? "Web" : "Backend",
      role: i ? ("participant" as const) : ("home" as const),
      enabled: true,
      settings,
      addedBy: "u1",
      addedAt: NOW,
    })),
    phases: SPECKIT.phases.map((p, index) => ({
      id: p.id,
      index,
      name: p.id === "specify" ? "Specify" : p.id === "plan" ? "Plan" : p.name,
      kind: p.kind,
      optional: p.optional,
      status: index === 0 ? ("approved" as const) : index === 1 ? ("in_review" as const) : ("pending" as const),
      note: null,
      requiredApproved: index === 0 ? 1 : 0,
      requiredTotal: p.artifacts.filter((a) => a.required && a.scope !== "contract").length,
      startedAt: index <= 1 ? NOW : null,
      approvedAt: index === 0 ? NOW : null,
    })),
    artifacts: [
      {
        ...artifact(211, "specify", "spec", "spec.md"),
        baselineVersion: 1,
        approval: "human",
        syncs: [sync(PAYMENT.id, PAYMENT.key, "synced"), sync(WEB.id, WEB.key, "failed")],
      },
      { ...artifact(212, "plan", "plan", "plan.md"), baselineVersion: 2, approval: "auto" },
      {
        ...artifact(213, "plan", "contract", "refund-api.yaml"),
        scope: "contract",
        instance: "refund-api",
        consumerProjectIds: [WEB.id],
        contractFormat: "openapi",
        reviewId: uuid(501),
      },
    ],
    questions: [],
    steps: [
      {
        id: uuid(700),
        phaseId: "plan",
        stepId: "draft-plan",
        action: "draft",
        round: 1,
        status: "queued",
        run: null,
        waitingReason: "Không máy nào có nhãn sdlc",
        instructions: null,
        result: null,
        error: null,
        createdBy: "u1",
        createdAt: NOW,
        finishedAt: null,
      },
    ],
    tasks: [
      task(1, 0, PAYMENT.key, PAYMENT.id),
      {
        ...task(2, 1, WEB.key, WEB.id),
        blockedBy: [{ taskId: uuid(601), key: "T-41", projectKey: PAYMENT.key, status: "todo" }],
      },
    ],
    overrides: [],
    autoApprovals: [autoApproval()],
    warnings: [],
    convergeRound: 0,
    convergedAt: null,
    can: { write: true, manage: true, override: true, runWaves: true, editProjects: true, changeMode: false },
    ...over,
  };
}

/** Lần chạy bước `converge-spec`; `result.findings` theo `sdlc_report` loại `findings`. */
export function convergeRun(
  round: number,
  findings: Record<string, unknown>[],
  over: Partial<SdlcItemDetail["steps"][number]> = {},
): SdlcItemDetail["steps"][number] {
  return {
    id: uuid(720 + round),
    phaseId: "converge",
    stepId: "converge-spec",
    action: "converge",
    round,
    status: "succeeded",
    run: { id: uuid(820 + round), state: "succeeded" },
    waitingReason: null,
    instructions: null,
    result: { findings },
    error: null,
    createdBy: "u1",
    createdAt: NOW,
    finishedAt: NOW,
    ...over,
  };
}

/** Bản tách hai dự án: T003 ở web-shop chờ T002 ở payment-api (cạnh liên dự án); FR-003 chưa có task. */
export function breakdownView(over: Partial<SdlcBreakdownView> = {}): SdlcBreakdownView {
  const task = (key: string, project: string, over: Record<string, unknown> = {}) => ({
    sliceKey: key,
    title: `Việc ${key}`,
    body: "",
    project,
    requirementIds: [] as string[],
    checklist: [] as { id: string; text: string; requirementIds: string[] }[],
    dependsOn: [] as string[],
    files: [] as string[],
    parallel: true,
    line: 1,
    ...over,
  });
  const cov = { requirements: 3, planned: 66.7, done: 0, verified: 0 };
  return {
    itemId: itemDetail().id,
    source: "draft",
    docKey: "project/payment-api/sdlc/012-hoan-tien-mot-phan/tasks",
    revision: 3,
    breakdown: {
      parser: "hive-tasks",
      granularity: "item",
      requirements: ["FR-001", "FR-002", "FR-003"],
      tasks: [
        task("T001", PAYMENT.key, {
          requirementIds: ["FR-001"],
          checklist: [
            { id: "a", text: "Bảng hoàn tiền", requirementIds: ["FR-001"] },
            { id: "b", text: "API hoàn tiền", requirementIds: ["FR-001"] },
          ],
        }),
        task("T002", PAYMENT.key, { requirementIds: ["FR-002"], dependsOn: ["T001"] }),
        task("T003", WEB.key, { requirementIds: ["FR-002"], dependsOn: ["T002"] }),
      ],
      waves: [["T001"], ["T002"], ["T003"]],
    },
    errors: [],
    coverage: {
      total: cov,
      byProject: [
        { projectKey: PAYMENT.key, coverage: cov },
        { projectKey: WEB.key, coverage: { requirements: 1, planned: 100, done: 0, verified: 0 } },
      ],
      missing: ["FR-003"],
    },
    ...over,
  };
}

export function traceView(over: Partial<SdlcTrace> = {}): SdlcTrace {
  const taskRow = (n: number, projectKey: string, over: Record<string, unknown> = {}) => ({
    taskId: uuid(600 + n),
    key: `T-${40 + n}`,
    projectKey,
    status: "done" as const,
    runId: null,
    prUrl: null,
    mergeSha: null,
    tests: [] as string[],
    ci: "none" as const,
    ...over,
  });
  return {
    itemId: itemDetail().id,
    rows: [
      {
        requirementId: "FR-001",
        text: "Hoàn tiền một phần",
        tasks: [
          taskRow(1, PAYMENT.key, {
            runId: uuid(801),
            prUrl: "https://github.com/acme/payment-api/pull/7",
            mergeSha: "abcdef1234567",
            tests: ["refund.test.ts"],
            ci: "success",
          }),
          taskRow(2, WEB.key),
        ],
        findings: [],
        planned: true,
        done: true,
        verified: true,
      },
      {
        requirementId: "FR-003",
        text: "Gửi email",
        tasks: [],
        findings: [],
        planned: false,
        done: false,
        verified: false,
      },
    ],
    total: { requirements: 2, planned: 50, done: 50, verified: 50 },
    byProject: [
      { projectKey: PAYMENT.key, coverage: { requirements: 1, planned: 100, done: 100, verified: 100 } },
      { projectKey: WEB.key, coverage: { requirements: 1, planned: 100, done: 100, verified: 0 } },
    ],
    csv: null,
    ...over,
  };
}

export function metricsView(over: Partial<SdlcMetrics> = {}): SdlcMetrics {
  const hours: Partial<Record<SdlcPhaseKind, [number, number]>> = {
    intake: [2, 6],
    requirements: [30, 72],
    design: [12, 40],
    decomposition: [3, 8],
    implementation: [20, 50],
    verification: [6, 20],
  };
  return {
    from: "2026-09-14T03:42:00.000Z",
    to: NOW,
    items: 12,
    leadTimeHours: SDLC_PHASE_KINDS.map((kind) => {
      const h = hours[kind];
      return { kind, duration: h ? { p50: h[0], p90: h[1], count: 10 } : { p50: null, p90: null, count: 0 } };
    }),
    gateWaitHours: { p50: 5.5, p90: 26, count: 18 },
    returnRate: 0.25,
    questionsPerItem: 1.5,
    coverage: { requirements: 24, planned: 92, done: 75, verified: 60 },
    convergeRounds: 1.4,
    codeReviewRoundsPerPr: 1.2,
    costUsdPerItem: 7.8,
    autoApproval: [
      { modeRef: "speckit", projectKey: null, autoRate: 0.4, revokeRate: 0.05 },
      { modeRef: "speckit", projectKey: PAYMENT.key, autoRate: 0.3, revokeRate: null },
    ],
    ...over,
  };
}

/** Client giả theo đúng đường dẫn của hợp đồng; test chỉ cần những thủ tục màn gọi. */
export function fakeClient(
  data: {
    columns?: { kind: SdlcPhaseKind; items: SdlcItemSummary[] }[];
    projects?: Project[];
    modes?: SdlcModeView[];
    questions?: SdlcQuestion[];
    item?: SdlcItemDetail;
    breakdown?: SdlcBreakdownView;
    trace?: SdlcTrace;
    metrics?: SdlcMetrics;
  } = {},
) {
  const item = data.item ?? itemDetail();
  const returnsItem = () => vi.fn(async (_input: Record<string, unknown>) => item);
  const columns = data.columns ?? SDLC_PHASE_KINDS.map((kind) => ({ kind, items: [] }));
  return {
    projects: { list: vi.fn(async () => data.projects ?? [PAYMENT, WEB, RECONCILE]) },
    teams: {
      list: vi.fn(async () => [
        { id: TEAM_BACKEND, name: "Backend" },
        { id: TEAM_WEB, name: "Web" },
      ]),
    },
    sdlc: {
      board: vi.fn(async (_input: { projectId?: string; modeRef?: string }) => ({ columns })),
      modes: { list: vi.fn(async () => data.modes ?? [modeView("speckit"), modeView("bugfix"), modeView("small")]) },
      suggest: vi.fn(async () => ({
        size: "L" as const,
        modeRef: "speckit",
        reason: "Đụng thanh toán, nhiều màn → L → Spec Kit",
        alternatives: [],
      })),
      items: {
        get: vi.fn(async (_input: { projectKey?: string; number?: number }) => item),
        step: returnsItem(),
        skipPhase: returnsItem(),
        pause: returnsItem(),
        resume: returnsItem(),
        cancel: returnsItem(),
        projects: { add: returnsItem(), remove: returnsItem() },
        create: vi.fn(async (input: { projectId: string; title: string }) => ({
          ...summary(15, { title: input.title }),
          source: { kind: "manual", url: null, issueNumber: null, path: null },
        })),
      },
      waves: {
        run: vi.fn(async (_input: { id: string }) => ({
          started: [{ taskId: uuid(601), runId: uuid(801) }],
          skipped: [{ taskId: uuid(602), key: "T-42", reason: "Chờ T-41 merge" }],
        })),
      },
      overrides: {
        create: vi.fn(async (input: { itemId: string; reason: string }) => ({ id: uuid(900), ...input })),
        revoke: vi.fn(async (input: { id: string }) => input),
      },
      autoApprovals: {
        revoke: vi.fn(async (input: { id: string; reason: string }) =>
          autoApproval({ revokedAt: NOW, revokeReason: input.reason }),
        ),
      },
      contracts: { create: vi.fn(async (input: Record<string, unknown>) => input) },
      sync: vi.fn(async (_input: { id: string; projectId: string; action: string }) => []),
      breakdown: {
        get: vi.fn(async (_input: { id: string; source?: string }) => data.breakdown ?? breakdownView()),
        save: vi.fn(async (input: { breakdown: SdlcBreakdownView["breakdown"]; baseRevision: number }) => ({
          ...(data.breakdown ?? breakdownView()),
          breakdown: input.breakdown,
          revision: input.baseRevision + 1,
        })),
      },
      trace: vi.fn(async (input: { id: string; projectId?: string; format?: string }) => ({
        ...(data.trace ?? traceView()),
        csv: input.format === "csv" ? "requirement,task\nFR-001,T-41\n" : null,
      })),
      metrics: vi.fn(
        async (_input: { from: string; to: string; projectId?: string; modeRef?: string }) =>
          data.metrics ?? metricsView(),
      ),
      questions: {
        list: vi.fn(async (input: { openOnly?: boolean; itemId?: string }) => ({
          items: (data.questions ?? []).filter(
            (q) => (!input.openOnly || q.status === "open") && (!input.itemId || q.itemId === input.itemId),
          ),
          nextCursor: null,
        })),
        count: vi.fn(async () => ({ open: (data.questions ?? []).filter((q) => q.status === "open").length })),
        answer: vi.fn(async (input: { answers: { id: string }[] }) =>
          input.answers.map((a) => ({ ...question(0), id: a.id, status: "answered" as const })),
        ),
      },
    },
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

export function testEnv(client: FakeClient, over: Partial<SdlcEnv> = {}): SdlcEnv {
  return {
    api: createTanstackQueryUtils(client as unknown as ContractRouterClient<Contract>),
    lang: "vi",
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    link: ({ to, className, children }) => (
      <a href={`#${JSON.stringify(to)}`} className={className}>
        {children}
      </a>
    ),
    can: { write: () => true, override: false, manageModes: false },
    ...over,
  };
}

export function renderWithEnv(ui: ReactNode, env: SdlcEnv) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SdlcProvider env={env}>{ui}</SdlcProvider>
    </QueryClientProvider>,
  );
}
