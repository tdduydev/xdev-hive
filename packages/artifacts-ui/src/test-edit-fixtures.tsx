import type {
  ArtifactDetail,
  ArtifactScope,
  ArtifactSettings,
  ArtifactVersionMeta,
  ArtifactWriteResult,
} from "@xdev-hive/contracts";
import { vi } from "vitest";
import { detail, type FakeClient, fakeClient } from "./test-fixtures.tsx";

export const versionMeta = (version: number, over: Partial<ArtifactVersionMeta> = {}): ArtifactVersionMeta => {
  const { content: _content, compileError: _compileError, ...rest } = detail({ version }).version;
  return { ...rest, ...over };
};

export const writeResult = (version: number, over: Partial<ArtifactVersionMeta> = {}): ArtifactWriteResult => ({
  artifact: detail({ version }).artifact,
  version: versionMeta(version, over),
  compileError: null,
});

export const settings = (scopes: ArtifactScope[] = ["private", "project"]): ArtifactSettings => ({
  enabled: true,
  types: ["markdown", "code", "html", "mermaid", "react"],
  scopes,
  maxVersionBytes: 1024 * 1024,
  maxVersions: 200,
  publicLinks: { enabled: true, maxDays: 30 },
});

/**
 * `fakeClient` của T020 chỉ có thủ tục của khung; phần sửa, đổi phạm vi và lịch sử cần thêm rename/restore/update/
 * setScope/projects. Để riêng một file để không sửa file dùng chung của làn khác.
 */
export function editClient(
  details: Record<string, ArtifactDetail> = {},
  versions: ArtifactVersionMeta[] = [],
  scopes: ArtifactScope[] = ["private", "project"],
) {
  const base = fakeClient(details);
  return {
    artifacts: {
      ...base.artifacts,
      settings: vi.fn(async () => settings(scopes)),
      update: vi.fn(async (_input: { id: string; content: string; baseVersion: number; message?: string }) =>
        writeResult(2),
      ),
      setScope: vi.fn(
        async (_input: { id: string; scope: string; projectKey?: string; teamId?: string }) => detail().artifact,
      ),
      versions: {
        list: vi.fn(async (_input: { id: string }) => versions),
        rename: vi.fn(async (input: { version: number; name: string | null }) =>
          versionMeta(input.version, { name: input.name }),
        ),
        restore: vi.fn(async (_input: { version: number; baseVersion?: number }) =>
          writeResult(3, { restoredFrom: 1 }),
        ),
      },
    },
    teams: {
      list: vi.fn(async () => [
        { id: "t1", slug: "payments", name: "Thanh toán", color: null, systemCount: 1, memberCount: 4 },
        { id: "t2", slug: "growth", name: "Tăng trưởng", color: null, systemCount: 0, memberCount: 2 },
      ]),
    },
    projects: {
      list: vi.fn(async (_input: object) => [
        { id: "p1", key: "refund", name: "Hoàn tiền" },
        { id: "p2", key: "billing", name: "Thanh toán" },
      ]),
    },
  };
}

export type EditClient = ReturnType<typeof editClient>;

/** `testEnv` nhận `FakeClient`; client sửa là tập cha về hình dạng nên ép kiểu một chỗ ở đây. */
export const asFake = (client: EditClient) => client as unknown as FakeClient;
