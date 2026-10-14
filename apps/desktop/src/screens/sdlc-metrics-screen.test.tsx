import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import { SdlcMetricsScreen } from "@/screens/sdlc-metrics-screen.tsx";
import { installSdlcHub, PAYMENT } from "@/screens/sdlc-test-fixture.ts";

const admin: Account = {
  name: "Minh",
  email: "minh@example.test",
  orgId: "o",
  orgName: "Hive",
  orgRole: "member",
  teams: [{ id: PAYMENT.teamId, name: "Backend", role: "admin" }],
};

function open() {
  render(
    <AccountContext.Provider value={admin}>
      <SdlcMetricsScreen />
    </AccountContext.Provider>,
  );
}

describe("chỉ số AI SDLC trên app", () => {
  it("gọi sdlc/metrics qua hub, nút thắt ở Thiết kế", async () => {
    setLang("vi");
    const { calls } = installSdlcHub();
    open();
    expect(await screen.findByText("Lead time theo giai đoạn")).toBeTruthy();
    expect(screen.getByText("Nút thắt").closest("li")?.textContent).toContain("Thiết kế");
    expect(screen.getByText("9 hạng mục")).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.path === "sdlc/metrics")).toBe(true));
  });

  it("tiếng Anh", async () => {
    setLang("en");
    installSdlcHub();
    open();
    expect(await screen.findByText("AI SDLC metrics")).toBeTruthy();
    expect(await screen.findByText("Auto-approval")).toBeTruthy();
  });
});
