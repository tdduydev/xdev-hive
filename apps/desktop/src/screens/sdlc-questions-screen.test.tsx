import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { setLang } from "@/lib/i18n.ts";
import { SdlcQuestionsScreen } from "@/screens/sdlc-questions-screen.tsx";
import { installSdlcHub, PAYMENT } from "@/screens/sdlc-test-fixture.ts";

const ba: Account = {
  name: "An",
  email: "an@example.test",
  orgId: "o",
  orgName: "Hive",
  orgRole: "member",
  teams: [{ id: PAYMENT.teamId, name: "Backend", role: "ba" }],
};
describe("câu hỏi chờ BA/PO", () => {
  it("dùng đề xuất, trả lời câu còn lại, xem lịch sử", async () => {
    setLang("vi");
    const { state } = installSdlcHub();
    const user = userEvent.setup();
    render(
      <AccountContext.Provider value={ba}>
        <SdlcQuestionsScreen />
      </AccountContext.Provider>,
    );
    const suggestion = (await screen.findAllByRole("button", { name: "Dùng đề xuất" }))[0];
    if (!suggestion) throw new Error("Thiếu đề xuất trả lời");
    await user.click(suggestion);
    await waitFor(() => expect(state.answered).toHaveLength(1));
    await user.click(await screen.findByRole("radio", { name: "Không giới hạn" }));
    await user.click(screen.getByRole("button", { name: "Gửi câu trả lời (1/1)" }));
    await waitFor(() => expect(state.answered).toHaveLength(2));
    expect(await screen.findByText("Không có câu hỏi nào đang chờ bạn.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /Đã trả lời/ }));
    expect(await screen.findByText("Không giới hạn", { exact: false })).toBeTruthy();
  });
  it("tiếng Anh và viewer chỉ xem", async () => {
    setLang("en");
    installSdlcHub();
    render(
      <AccountContext.Provider value={{ ...ba, teams: ba.teams.map((t) => ({ ...t, role: "viewer" })) }}>
        <SdlcQuestionsScreen />
      </AccountContext.Provider>,
    );
    expect((await screen.findAllByRole("button", { name: "Use suggestion" }))[0]?.hasAttribute("disabled")).toBe(true);
  });
});
