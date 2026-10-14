import type { ArtifactDetail, ArtifactLink, ArtifactListQuery, AuditLogItem } from "@xdev-hive/contracts";
import { vi } from "vitest";
import { detail, fakeClient, ID_A } from "./test-fixtures.tsx";

export const NOW = "2026-10-14T03:42:00.000Z";

export function libraryDetailClient() {
  const latest = detail({ latestVersion: 3, version: 3 });
  const base = fakeClient({ [ID_A]: latest });
  const client = {
    ...base,
    artifacts: {
      ...base.artifacts,
      get: vi.fn(async ({ id, version }: { id: string; version?: number }): Promise<ArtifactDetail> => {
        if (id !== ID_A) throw Object.assign(new Error("Không tìm thấy artifact."), { code: "NOT_FOUND" });
        return detail({ id, latestVersion: 3, version: version ?? 3, content: `# Nội dung bản ${version ?? 3}` });
      }),
      list: vi.fn(async (_input: ArtifactListQuery) => ({
        items: [latest.artifact],
        nextCursor: null as string | null,
      })),
      restore: vi.fn(async (_input: { id: string }) => latest.artifact),
      links: {
        list: vi.fn(async (_input: { id: string }): Promise<ArtifactLink[]> => []),
      },
    },
    projects: {
      list: vi.fn(async (_input: object) => [{ id: ID_A, key: "payment-api", name: "Thanh toán" }]),
    },
    audit: {
      list: vi.fn(async (_input: object) => ({ items: [] as AuditLogItem[], nextCursor: null as string | null })),
    },
  };
  return client;
}

export function auditItem(over: Partial<AuditLogItem> = {}): AuditLogItem {
  return {
    id: ID_A,
    createdAt: NOW,
    actorId: "u1",
    actor: "An",
    actorType: "user",
    action: "artifact.create",
    area: "other",
    targetType: "artifact",
    targetId: ID_A,
    result: "ok",
    source: "web",
    ip: null,
    ...over,
  };
}
