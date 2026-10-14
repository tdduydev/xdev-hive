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
  type SdlcItemSummary,
  type SdlcModeView,
  type SdlcPhaseKind,
  type SdlcQuestion,
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

/** Client giả theo đúng đường dẫn của hợp đồng; test chỉ cần những thủ tục màn gọi. */
export function fakeClient(
  data: {
    columns?: { kind: SdlcPhaseKind; items: SdlcItemSummary[] }[];
    projects?: Project[];
    modes?: SdlcModeView[];
    questions?: SdlcQuestion[];
  } = {},
) {
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
        create: vi.fn(async (input: { projectId: string; title: string }) => ({
          ...summary(15, { title: input.title }),
          source: { kind: "manual", url: null, issueNumber: null, path: null },
        })),
      },
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
