import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ArtifactDetail, ArtifactType, ArtifactVersionMeta, Contract } from "@xdev-hive/contracts";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { type ArtifactsEnv, ArtifactsProvider } from "./env.tsx";

export const ID_A = "00000000-0000-4000-8000-00000000000a";
export const ID_B = "00000000-0000-4000-8000-00000000000b";
export const ID_C = "00000000-0000-4000-8000-00000000000c";
const NOW = "2026-10-14T03:42:00.000Z";

export function detail(
  over: {
    id?: string;
    title?: string;
    type?: ArtifactType;
    version?: number;
    latestVersion?: number;
    content?: string | null;
    compileError?: string | null;
    language?: string | null;
    write?: boolean;
    manage?: boolean;
    owner?: boolean;
    deletedAt?: string | null;
  } = {},
): ArtifactDetail {
  const version = over.version ?? 1;
  return {
    artifact: {
      id: over.id ?? ID_A,
      title: over.title ?? "Luồng hoàn tiền",
      type: over.type ?? "markdown",
      language: over.language ?? null,
      scope: "private",
      teamId: null,
      project: null,
      originProjectId: null,
      owner: { id: "u1", name: "An" },
      origin: "leader",
      latestVersion: over.latestVersion ?? version,
      sizeBytes: 10,
      duplicatedFrom: null,
      deletedAt: over.deletedAt ?? null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    version: {
      version,
      sha256: "x",
      sizeBytes: 10,
      authorUser: null,
      authorRunId: null,
      origin: "leader",
      message: null,
      name: null,
      restoredFrom: null,
      hasCompileError: !!over.compileError,
      tombstonedAt: null,
      createdAt: NOW,
      content: over.content === undefined ? "# Tiêu đề" : over.content,
      compileError: over.compileError ?? null,
    },
    access: { write: over.write ?? true, manage: over.manage ?? true, owner: over.owner ?? true },
  };
}

const versionMeta = (version: number): ArtifactVersionMeta => ({ ...detail({ version }).version });

/** Client giả theo đúng đường dẫn của hợp đồng; test chỉ cần những thủ tục khung bên cạnh gọi. */
export function fakeClient(details: Record<string, ArtifactDetail> = {}) {
  const frameUrl = vi.fn(async ({ id, version }: { id: string; version: number }) => ({
    url: `/_artifact/frame/${id}.${version}`,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  }));
  return {
    artifacts: {
      get: vi.fn(async ({ id, version }: { id: string; version?: number }) => {
        const found = details[`${id}@${version}`] ?? details[id];
        if (!found) throw Object.assign(new Error("Không tìm thấy artifact."), { code: "NOT_FOUND" });
        return found;
      }),
      frameUrl,
      preview: vi.fn(async (_input: { type: string; content: string; theme: string }) => ({
        url: "/_artifact/frame/preview",
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        compileError: null,
      })),
      versions: {
        list: vi.fn(async ({ id }: { id: string }) => {
          const latest = (details[id] ?? Object.values(details)[0])?.artifact.latestVersion ?? 1;
          return Array.from({ length: latest }, (_, i) => versionMeta(latest - i));
        }),
      },
      duplicate: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

export function testEnv(client: FakeClient, over: Partial<ArtifactsEnv> = {}): ArtifactsEnv {
  return {
    api: createTanstackQueryUtils(client as unknown as ContractRouterClient<Contract>),
    lang: "vi",
    theme: "light",
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    link: ({ to, className, children }) => (
      <a href={`#${to.kind}`} className={className}>
        {children}
      </a>
    ),
    frameBase: "http://hub.test",
    offline: false,
    canAskLeader: true,
    onAskLeaderFix: vi.fn(),
    onPublicLinks: vi.fn(),
    ...over,
  };
}

export function renderWithEnv(ui: ReactNode, env: ArtifactsEnv) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <ArtifactsProvider env={env}>{node}</ArtifactsProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(ui));
  return { ...result, rerender: (node: ReactNode) => result.rerender(wrap(node)) };
}
