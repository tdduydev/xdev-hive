import type { ArtifactDetail, ArtifactSummary } from "@xdev-hive/contracts";

export const ID_A = "00000000-0000-4000-8000-00000000000a";
export const ID_B = "00000000-0000-4000-8000-00000000000b";
export const NOW = "2026-10-14T03:42:00.000Z";

export function summary(id = ID_A): ArtifactSummary {
  return {
    id,
    title: id === ID_A ? "Luồng hoàn tiền" : "Checklist release",
    type: "markdown",
    language: null,
    scope: "project",
    teamId: null,
    project: { id: ID_B, key: "payment-api", name: "Thanh toán" },
    originProjectId: ID_B,
    owner: { id: "u1", name: "An" },
    origin: "leader",
    latestVersion: 2,
    sizeBytes: 100,
    duplicatedFrom: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function detail(id = ID_A, version = 2): ArtifactDetail {
  return {
    artifact: summary(id),
    version: {
      version,
      sha256: "fixture",
      sizeBytes: 50,
      authorUser: { id: "u1", name: "An" },
      authorRunId: null,
      origin: "leader",
      message: null,
      name: null,
      restoredFrom: null,
      hasBlob: false,
      hasCompileError: false,
      tombstonedAt: null,
      createdAt: NOW,
      content: `## Nội dung bản ${version}`,
      compileError: null,
    },
    access: { write: true, manage: true, owner: true },
  };
}
