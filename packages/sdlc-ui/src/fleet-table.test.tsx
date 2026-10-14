import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SdlcFleetMachine } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { FleetTable } from "./fleet-table.tsx";
import { fakeClient, NOW, renderWithEnv, testEnv, uuid } from "./test-fixtures.tsx";

const machine: SdlcFleetMachine = {
  id: uuid(1),
  teamId: uuid(2),
  teamName: "Backend",
  kind: "worker",
  name: "sdlc-01",
  os: "linux",
  version: "1.0.0",
  clis: ["codex"],
  capacity: 2,
  status: "online",
  lastSeenAt: NOW,
  createdAt: NOW,
  shared: true,
  registeredBy: "u1",
  labels: ["sdlc"],
  labelsOnly: true,
  accounts: [
    {
      id: "codex-1",
      cli: "codex",
      label: "Nhóm BA",
      roles: [],
      enabled: true,
      loggedIn: true,
      sessionPct: 30,
      weekPct: null,
      resetsAt: null,
      stopAtSession: 90,
      stopAtWeek: 90,
      inUse: 1,
    },
  ],
  accountsAt: NOW,
  slotsUsed: 1,
  runs: [
    {
      runId: uuid(3),
      kind: "sdlc",
      projectKey: "payment-api",
      item: { id: uuid(4), ref: "012", title: "Hoàn tiền" },
      step: "draft",
      startedAt: NOW,
    },
  ],
  quotaResetsAt: null,
  canSetAccounts: true,
};
describe("đội máy", () => {
  it("hiện run, quota và bật/tắt gói qua hợp đồng", async () => {
    const setAccount = vi.fn(async () => machine);
    const client = { ...fakeClient(), machines: { setAccount } };
    const env = testEnv(fakeClient());
    renderWithEnv(<FleetTable machines={[machine]} />, {
      ...env,
      api: createTanstackQueryUtils(client) as unknown as typeof env.api,
    });
    expect(screen.getByText(/payment-api · 012 · Hoàn tiền · draft/)).toBeTruthy();
    expect(screen.getByText("Phiên: 30% · Tuần: —%")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Tắt Nhóm BA" }));
    await waitFor(() =>
      expect(setAccount).toHaveBeenCalledWith(
        { machineId: machine.id, accountId: "codex-1", enabled: false },
        expect.anything(),
      ),
    );
  });
  it("worker chưa báo gói và không có quyền không hiện nút", () => {
    renderWithEnv(
      <FleetTable machines={[{ ...machine, accounts: null, canSetAccounts: false }]} />,
      testEnv(fakeClient(), {
        api: createTanstackQueryUtils({
          machines: { setAccount: vi.fn(async () => machine) },
        }) as unknown as ReturnType<typeof testEnv>["api"],
      }),
    );
    expect(screen.getByText("Máy chưa báo gói")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("rỗng có hướng dẫn thêm máy", () => {
    renderWithEnv(
      <FleetTable machines={[]} />,
      testEnv(fakeClient(), {
        api: createTanstackQueryUtils({
          machines: { setAccount: vi.fn(async () => machine) },
        }) as unknown as ReturnType<typeof testEnv>["api"],
      }),
    );
    expect(screen.getByText(/Thêm máy dùng chung/)).toBeTruthy();
  });
});
