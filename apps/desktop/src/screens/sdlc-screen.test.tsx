import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import { SdlcScreen } from "@/screens/sdlc-screen.tsx";
import { installSdlcHub, MOBILE, PAYMENT, WEB } from "@/screens/sdlc-test-fixture.ts";
export const ba: Account = {
  name: "An",
  email: "an@example.test",
  orgId: "o",
  orgName: "Hive",
  orgRole: "member",
  teams: [{ id: PAYMENT.teamId, name: "Backend", role: "ba" }],
};
describe("AI SDLC desktop", () => {
  beforeEach(() => {
    setLang("vi");
    location.hash = "#/sdlc/payment-api/12";
  });
  it("ba mở ba dự án, đổi tab và thu hồi tự duyệt bằng hub", async () => {
    const { state } = installSdlcHub({ participants: [WEB, MOBILE] });
    const user = userEvent.setup();
    render(
      <AccountContext.Provider value={ba}>
        <SdlcScreen />
      </AccountContext.Provider>,
    );
    expect(await screen.findByRole("heading", { name: /Hoàn tiền một phần/ })).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /Dự án/ }));
    await waitFor(() => expect(location.hash).toBe("#/sdlc/payment-api/12/projects"));
    await waitFor(() => expect(screen.getAllByText("mobile-app").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("tab", { name: "Tổng quan" }));
    await user.click(await screen.findByRole("button", { name: "Thu hồi tự duyệt" }));
    await user.type(screen.getByLabelText("Lý do"), "Thiếu bước kiểm tra hoàn tiền");
    const confirm = screen.getAllByRole("button", { name: "Thu hồi tự duyệt" }).at(-1);
    if (!confirm) throw new Error("Thiếu nút xác nhận thu hồi");
    await user.click(confirm);
    await waitFor(() => expect(state.revoked).toHaveLength(1));
    expect(state.revoked[0]?.reason).toBe("Thiếu bước kiểm tra hoàn tiền");
  });
  it("viewer thấy dữ liệu và không được tạo", async () => {
    installSdlcHub({ canWrite: false });
    location.hash = "#/sdlc";
    render(
      <AccountContext.Provider value={{ ...ba, teams: ba.teams.map((t) => ({ ...t, role: "viewer" })) }}>
        <SdlcScreen />
      </AccountContext.Provider>,
    );
    expect(await screen.findByRole("region", { name: "Bảng hạng mục theo giai đoạn" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Tạo hạng mục" })).toBeNull();
  });
  it("mở từ màn Chỉ số: bảng lọc sẵn theo dự án và chế độ trên hash", async () => {
    const { calls } = installSdlcHub();
    location.hash = `#/sdlc/loc?project=${PAYMENT.id}&mode=bugfix`;
    render(
      <AccountContext.Provider value={ba}>
        <SdlcScreen />
      </AccountContext.Provider>,
    );
    expect(await screen.findByRole("region", { name: "Bảng hạng mục theo giai đoạn" })).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "sdlc/board").at(-1)?.input).toMatchObject({
        projectId: PAYMENT.id,
        modeRef: "bugfix",
      }),
    );
    expect((screen.getByLabelText("Dự án") as HTMLSelectElement).value).toBe(PAYMENT.id);
  });
  it("lỗi tải có thông báo và thử lại", async () => {
    const { rpc } = installSdlcHub();
    delete rpc["sdlc/items/get"];
    render(
      <AccountContext.Provider value={ba}>
        <SdlcScreen />
      </AccountContext.Provider>,
    );
    expect(await screen.findByRole("button", { name: "Thử lại" })).toBeTruthy();
  });
});
