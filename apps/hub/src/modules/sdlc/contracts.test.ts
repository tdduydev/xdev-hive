import { describe, expect, it } from "vitest";
import {
  type ContractParticipant,
  canChangeConsumers,
  checkContractParties,
  contractBaselineWarnings,
  contractCheckpointTeams,
  contractFileName,
  contractsFromReport,
} from "./contracts.ts";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parts: ContractParticipant[] = [
  { projectId: uuid(1), key: "payment-api", teamId: uuid(101) },
  { projectId: uuid(2), key: "web-shop", teamId: uuid(102) },
  { projectId: uuid(3), key: "mobile-app", teamId: uuid(102) },
];
const report = (contracts: Record<string, unknown>[]) =>
  ({ kind: "contracts", data: { contracts } }) as Parameters<typeof contractsFromReport>[0];

describe("contract liên repo (phần thuần)", () => {
  it("bên cung cấp và bên dùng phải thuộc hạng mục, không lặp", () => {
    const ids = new Set(parts.map((p) => p.projectId));
    const base = { itemId: uuid(9), name: "refund-api", format: "openapi" as const };
    expect(
      checkContractParties({ ...base, providerProjectId: uuid(1), consumerProjectIds: [uuid(2)] }, ids),
    ).toBeNull();
    expect(checkContractParties({ ...base, providerProjectId: uuid(1), consumerProjectIds: [uuid(1)] }, ids)).toMatch(
      /đồng thời/,
    );
    expect(
      checkContractParties({ ...base, providerProjectId: uuid(1), consumerProjectIds: [uuid(2), uuid(2)] }, ids),
    ).toMatch(/lặp/);
    expect(checkContractParties({ ...base, providerProjectId: uuid(7), consumerProjectIds: [uuid(2)] }, ids)).toMatch(
      /cung cấp/,
    );
    expect(checkContractParties({ ...base, providerProjectId: uuid(1), consumerProjectIds: [uuid(8)] }, ids)).toMatch(
      /dùng/,
    );
  });

  it("đổi báo cáo của agent thành bản nháp, bỏ riêng contract sai", () => {
    const { drafts, rejected } = contractsFromReport(
      report([
        {
          name: "refund-api",
          format: "openapi",
          provider: "payment-api",
          consumers: ["web-shop", "mobile-app"],
          content: "x",
        },
        { name: "ghost", format: "proto", provider: "khong-co", consumers: ["web-shop"], content: "x" },
        { name: "refund-api", format: "openapi", provider: "payment-api", consumers: ["web-shop"], content: "y" },
        { name: "self", format: "markdown", provider: "web-shop", consumers: ["web-shop"], content: "z" },
      ]),
      parts,
    );
    expect(drafts).toEqual([
      {
        name: "refund-api",
        format: "openapi",
        providerProjectId: uuid(1),
        consumerProjectIds: [uuid(2), uuid(3)],
        content: "x",
      },
    ]);
    expect(rejected.map((r) => r.name)).toEqual(["ghost", "refund-api", "self"]);
  });

  it("tên đã có trong hạng mục bị từ chối", () => {
    const { drafts, rejected } = contractsFromReport(
      report([
        { name: "refund-api", format: "openapi", provider: "payment-api", consumers: ["web-shop"], content: "" },
      ]),
      parts,
      new Set(["refund-api"]),
    );
    expect(drafts).toEqual([]);
    expect(rejected[0]?.reason).toMatch(/đã có/);
  });

  it("checkpoint: bên cung cấp trước, mỗi đội một lần", () => {
    expect(
      contractCheckpointTeams({ providerProjectId: uuid(1), consumerProjectIds: [uuid(2), uuid(3)] }, parts),
    ).toEqual([uuid(101), uuid(102)]);
  });

  it("chỉ đổi bên dùng khi chưa có baseline", () => {
    expect(canChangeConsumers(null)).toBe(true);
    expect(canChangeConsumers(1)).toBe(false);
  });

  it("cảnh báo khi baseline mới sau khi task bên dùng đã chạy", () => {
    const baselineAt = new Date("2026-10-10T10:00:00Z");
    const tasks = [
      { ref: "T-41", projectId: uuid(2), firstRunAt: new Date("2026-10-09T10:00:00Z") },
      { ref: "T-42", projectId: uuid(2), firstRunAt: null },
      { ref: "T-43", projectId: uuid(1), firstRunAt: new Date("2026-10-09T10:00:00Z") },
    ];
    const input = { name: "refund-api", baselineAt, consumerTasks: tasks, consumerProjectIds: [uuid(2)] };
    expect(contractBaselineWarnings({ ...input, baselineVersion: 2, previousBaselineVersion: 1 })).toEqual([
      "Contract refund-api đổi sau khi task T-41 chạy.",
    ]);
    // Baseline đầu tiên: chưa có gì để "đổi".
    expect(contractBaselineWarnings({ ...input, baselineVersion: 1, previousBaselineVersion: null })).toEqual([]);
  });

  it("tên file theo định dạng", () => {
    expect(contractFileName("refund-api", "openapi")).toBe("refund-api.yaml");
    expect(contractFileName("events", "proto")).toBe("events.proto");
  });
});
