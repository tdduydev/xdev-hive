import {
  defaultProjectSettings,
  type Project,
  projectSdlcSettings,
  SDLC_PHASE_KINDS,
  SDLC_PRESETS,
  type SdlcAutoApproval,
  type SdlcItemDetail,
  type SdlcItemSummary,
  type SdlcModeView,
  type SdlcPhaseKind,
  type SdlcQuestion,
} from "@xdev-hive/contracts";

type RpcHandler = (input: unknown) => { body: unknown };
const ok = (data: unknown) => ({ body: { json: data } });

/*
 * Hub giả qua cầu Rust cho màn AI SDLC (specs/011 T055): hạng mục 012 "Hoàn tiền một phần" ở giai đoạn Plan, dự án chính
 * payment-api, dự án tham gia web-shop, hai câu hỏi đang chờ. Dữ liệu theo đúng kiểu của contracts để tsc bắt lệch.
 */

const NOW = "2026-10-14T03:42:00.000Z";
const uid = (n: number) => `5d5d5d5d-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const TEAM_BACKEND = "5a5a5a5a-0000-4000-8000-000000000001";
const TEAM_WEB = uid(902);

const SPECKIT = (() => {
  const mode = SDLC_PRESETS.speckit;
  if (!mode) throw new Error("Thiếu preset speckit");
  return mode;
})();

function project(n: number, key: string, teamId: string, enabled = true): Project {
  return {
    id: uid(n),
    systemId: uid(800),
    teamId,
    key,
    name: key,
    state: "active",
    repo: {
      mode: "existing",
      connectionId: uid(700),
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
      sdlc: projectSdlcSettings.parse({ enabled, defaultMode: "speckit", modes: ["speckit", "bugfix"] }),
    },
    createdBy: "u1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export const PAYMENT = project(1, "payment-api", TEAM_BACKEND);
export const WEB = project(2, "web-shop", TEAM_WEB);
export const MOBILE = project(3, "mobile-app", TEAM_WEB);
export const ITEM_ID = uid(112);

function modeView(ref: "speckit" | "bugfix"): SdlcModeView {
  const definition = SDLC_PRESETS[ref];
  if (!definition) throw new Error(`Thiếu preset ${ref}`);
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

const refOf = (p: Project) => ({ id: p.id, key: p.key, name: p.name });

function summary(over: Partial<SdlcItemSummary> & { kind?: SdlcPhaseKind } = {}): SdlcItemSummary {
  const { kind = "design", ...rest } = over;
  return {
    id: ITEM_ID,
    project: refOf(PAYMENT),
    number: 12,
    ref: "012",
    slug: "hoan-tien-mot-phan",
    title: "Hoàn tiền một phần",
    modeRef: "speckit",
    modeName: "Spec Kit",
    method: "speckit",
    size: "L",
    status: "active",
    phase: { id: "plan", name: "Plan", kind, status: "in_review", index: SDLC_PHASE_KINDS.indexOf(kind), total: 5 },
    waitingFor: "Chờ An (PO) · quá hạn 3 giờ",
    waitingMachine: false,
    openQuestions: 2,
    projects: [
      { ...refOf(PAYMENT), role: "home" },
      { ...refOf(WEB), role: "participant" },
    ],
    coverage: null,
    costUsd: 1.84,
    owner: { userId: "u1", name: "Trần Lan" },
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

function question(n: number, over: Partial<SdlcQuestion> = {}): SdlcQuestion {
  return {
    id: uid(300 + n),
    itemId: ITEM_ID,
    item: { ref: "012", title: "Hoàn tiền một phần", projectKey: PAYMENT.key },
    phaseId: "plan",
    round: 1,
    position: n,
    text: n === 1 ? "Hoàn tiền có cần duyệt của kế toán không?" : "Giới hạn số lần hoàn một giao dịch?",
    options: n === 1 ? ["Có", "Không"] : ["1 lần", "3 lần", "Không giới hạn"],
    recommended: n === 1 ? "Có" : "3 lần",
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

function autoApproval(): SdlcAutoApproval {
  return {
    id: uid(400),
    itemId: ITEM_ID,
    artifactId: uid(211),
    docKey: "project/payment-api/sdlc/012-hoan-tien-mot-phan/spec",
    artifactName: "spec.md",
    reviewId: uid(500),
    gateId: "po",
    gateName: "PO duyệt",
    version: 1,
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
  };
}

function itemDetail(canWrite: boolean, participants: Project[]): SdlcItemDetail {
  const settings = PAYMENT.settings.sdlc ?? projectSdlcSettings.parse({ enabled: true });
  const artifact = (n: number, phaseId: string, artifactId: string) => ({
    id: uid(n),
    phaseId,
    artifactId,
    name: `${artifactId}.md`,
    scope: "item" as const,
    instance: "",
    required: true,
    docKey: `project/payment-api/sdlc/012-hoan-tien-mot-phan/${artifactId}`,
    repoPath: `specs/012-hoan-tien-mot-phan/${artifactId}.md`,
    projectId: PAYMENT.id,
    consumerProjectIds: [],
    contractFormat: null,
    baselineVersion: null,
    approval: "none" as const,
    reviewId: null,
    hasDraft: true,
    syncs: [],
  });
  return {
    ...summary(),
    idea: "Cho phép hoàn tiền một phần cho giao dịch thẻ.",
    source: { kind: "manual", url: null, issueNumber: null, path: null },
    mode: SPECKIT,
    sizeSuggested: "L",
    suggestion: null,
    settings,
    projects: [
      { ...refOf(PAYMENT), role: "home" },
      ...participants.map((p) => ({ ...refOf(p), role: "participant" as const })),
    ],
    projectsDetail: [PAYMENT, ...participants].map((p, i) => ({
      ...refOf(p),
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
      { ...artifact(211, "specify", "spec"), baselineVersion: 1, approval: "auto" },
      artifact(212, "plan", "plan"),
    ],
    questions: [question(1), question(2)],
    steps: [],
    tasks: [],
    overrides: [],
    autoApprovals: [autoApproval()],
    warnings: [],
    convergeRound: 0,
    convergedAt: null,
    can: {
      write: canWrite,
      manage: canWrite,
      override: false,
      runWaves: canWrite,
      editProjects: canWrite,
      changeMode: false,
    },
  };
}

/**
 * `canWrite: false` là người chỉ có `sdlc.read`; `participants` là dự án tham gia (mặc định web-shop). `answered` và
 * `revoked` giữ thứ hub nhận để test đọc lại.
 */
export function sdlcFixture(opts: { canWrite?: boolean; participants?: Project[] } = {}) {
  const canWrite = opts.canWrite ?? true;
  const state = {
    questions: [question(1), question(2)],
    answered: [] as unknown[],
    revoked: [] as { id: string; reason: string }[],
    created: [] as unknown[],
    item: itemDetail(canWrite, opts.participants ?? [WEB]),
  };
  const rpc: Record<string, RpcHandler> = {
    "projects/list": () => ok([PAYMENT, WEB]),
    "sdlc/board": () =>
      ok({
        columns: SDLC_PHASE_KINDS.map((kind) => ({ kind, items: kind === "design" ? [summary()] : [] })),
      }),
    "sdlc/modes/list": () => ok([modeView("speckit"), modeView("bugfix")]),
    "sdlc/items/get": () => ok(state.item),
    // Ý tưởng nói "lỗi" thì gợi ý cỡ S, chế độ Bugfix như bộ gợi ý của hub.
    "sdlc/suggest": (input) => {
      const { idea } = input as { idea: string };
      const bug = /lỗi/i.test(idea);
      return ok({
        size: bug ? "S" : "L",
        modeRef: bug ? "bugfix" : "speckit",
        reason: bug ? "Sửa lỗi nhỏ → S → Bugfix" : "Đụng thanh toán, nhiều màn → L → Spec Kit",
        alternatives: [],
      });
    },
    "sdlc/items/create": (input) => {
      const { title, modeRef, size } = input as { title: string; modeRef: string; size: SdlcItemDetail["size"] };
      state.created.push(input);
      const mode = SDLC_PRESETS[modeRef as keyof typeof SDLC_PRESETS] ?? SPECKIT;
      state.item = {
        ...state.item,
        id: uid(113),
        number: 13,
        ref: "013",
        slug: "sua-loi-lam-tron",
        title,
        modeRef,
        modeName: mode.name,
        mode,
        size,
        openQuestions: 0,
        questions: [],
        autoApprovals: [],
      };
      return ok(state.item);
    },
    "sdlc/autoApprovals/revoke": (input) => {
      const { id, reason } = input as { id: string; reason: string };
      state.revoked.push({ id, reason });
      const revoked = state.item.autoApprovals.map((a) =>
        a.id === id
          ? {
              ...a,
              revokedAt: NOW,
              revokedBy: { userId: "u1", name: "Trần Đức Duy" },
              revokeReason: reason,
              canRevoke: false,
            }
          : a,
      );
      state.item = {
        ...state.item,
        autoApprovals: revoked,
        artifacts: state.item.artifacts.map((a) => (a.artifactId === "spec" ? { ...a, approval: "none" as const } : a)),
      };
      return ok(revoked.find((a) => a.id === id));
    },
    "sdlc/questions/count": () => ok({ open: state.questions.filter((q) => q.status === "open").length }),
    "sdlc/questions/list": (input) => {
      const { openOnly } = (input ?? {}) as { openOnly?: boolean };
      return ok({
        items: state.questions.filter((q) => !openOnly || q.status === "open"),
        nextCursor: null,
      });
    },
    "sdlc/questions/answer": (input) => {
      const { answers } = input as { answers: { id: string; answer?: string; useRecommended?: boolean }[] };
      state.answered.push(...answers);
      state.questions = state.questions.map((q) => {
        const a = answers.find((x) => x.id === q.id);
        if (!a) return q;
        return {
          ...q,
          status: "answered" as const,
          answer: a.useRecommended ? q.recommended : (a.answer ?? null),
          usedRecommended: !!a.useRecommended,
          answeredBy: { userId: "u1", name: "Trần Đức Duy" },
          answeredAt: NOW,
        };
      });
      return ok(state.questions.filter((q) => answers.some((a) => a.id === q.id)));
    },
  };
  return { rpc, state };
}

export function installSdlcHub(opts: Parameters<typeof sdlcFixture>[0] = {}) {
  const fixture = sdlcFixture(opts);
  const calls: { path: string; input: unknown }[] = [];
  window.__TAURI__ = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        if (command !== "hub_rpc") return undefined as T;
        const url = new URL(String(args?.path), "http://hub.local");
        const path = url.pathname.replace(/^\/rpc\//, "");
        const input = JSON.parse(String(args?.body ?? url.searchParams.get("data") ?? "{}"))?.json;
        calls.push({ path, input });
        const reply = fixture.rpc[path]?.(input);
        return {
          status: reply ? 200 : 404,
          contentType: "application/json",
          body: JSON.stringify(
            reply?.body ?? { json: { defined: false, code: "NOT_FOUND", status: 404, message: "Không tìm thấy." } },
          ),
        } as T;
      },
    },
  };
  return { ...fixture, calls };
}
