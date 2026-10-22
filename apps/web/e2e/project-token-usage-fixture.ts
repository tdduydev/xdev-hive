import { type ProjectTokenUsageRow, projectTokenUsageRow } from "@xdev-hive/contracts";
import { fail, ok, type RpcHandler } from "./fake-hub.ts";

/** Hub giả cho bảng token của dự án (specs/029 T025). `state.calls` giữ input để test đọc lại kỳ đã chọn. */
export type TokenUsageMode = "rows" | "empty" | "outside" | "notFound";

const NOW = "2026-10-20T03:00:00.000Z";
const EARLIER = "2026-10-19T09:30:00.000Z";

const row = (r: Partial<ProjectTokenUsageRow> & Pick<ProjectTokenUsageRow, "machineId" | "machineName">) =>
  projectTokenUsageRow.parse({
    userId: "u-lan",
    userName: "Trần Lan",
    periodEnd: NOW,
    tokens: 0,
    sessions: 0,
    score: null,
    policyDrift: [],
    ...r,
  });

export const TOKEN_ROWS: ProjectTokenUsageRow[] = [
  row({
    machineId: "7a7a7a7a-0000-4000-8000-000000000001",
    machineName: "lan-macbook",
    tokens: 1_250_000,
    sessions: 18,
    score: 82,
    policyDrift: ["level", "rtk"],
  }),
  row({
    machineId: "7a7a7a7a-0000-4000-8000-000000000002",
    machineName: "ha-thinkpad",
    userId: "u-ha",
    userName: "Phạm Hà",
    periodEnd: EARLIER,
    tokens: 480_500,
    sessions: 7,
    score: null,
    policyDrift: [],
  }),
];

/** Bản 30 ngày có thêm một máy đã gửi từ trước, để thấy kỳ đổi thì bảng đổi theo. */
export const TOKEN_ROW_OLD = row({
  machineId: "7a7a7a7a-0000-4000-8000-000000000003",
  machineName: "minh-desktop",
  userId: "u-minh",
  userName: "Lê Minh",
  periodEnd: "2026-10-02T08:00:00.000Z",
  tokens: 90_000,
  sessions: 2,
  score: 55,
  policyDrift: ["autoCompactWindow"],
});

export function projectTokenUsageFixture(mode: TokenUsageMode = "rows") {
  const state = { calls: [] as { key: string; days: number }[] };
  const rpc: Record<string, RpcHandler> = {
    "projects/tokenUsage": (input) => {
      const { key, days } = input as { key: string; days: number };
      state.calls.push({ key, days });
      if (mode === "outside") return fail("FORBIDDEN", 403, "Bạn không có quyền xem token của dự án này.");
      if (mode === "notFound") return fail("NOT_FOUND", 404, "Không tìm thấy dự án trong tổ chức.");
      if (mode === "empty") return ok({ rows: [] });
      return ok({ rows: days >= 30 ? [...TOKEN_ROWS, TOKEN_ROW_OLD] : TOKEN_ROWS });
    },
  };
  return { rpc, state };
}
