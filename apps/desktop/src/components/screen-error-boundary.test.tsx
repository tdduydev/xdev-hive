import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenErrorBoundary } from "@/components/screen-error-boundary.tsx";
import { setLang } from "@/lib/i18n.ts";

let broken = true;

function Flaky() {
  if (broken) throw new TypeError("Cannot read properties of null (reading 'length')");
  return <p>Màn đã hiện</p>;
}

beforeEach(() => {
  setLang("vi");
  broken = true;
  // React in lỗi đã bắt ra console; tắt để log test gọn.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ScreenErrorBoundary", () => {
  it("màn ném lỗi khi vẽ: hiện thông báo tiếng Việt thay vì cửa sổ trắng, Thử lại vẽ lại màn", async () => {
    const user = userEvent.setup();
    render(
      <ScreenErrorBoundary>
        <Flaky />
      </ScreenErrorBoundary>,
    );
    expect(screen.getByText("Màn này gặp lỗi khi hiển thị")).toBeTruthy();
    expect(screen.getByText(/reading 'length'/)).toBeTruthy();
    broken = false;
    await user.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(screen.getByText("Màn đã hiện")).toBeTruthy();
  });

  it("chữ tiếng Anh khi chọn EN", () => {
    setLang("en");
    render(
      <ScreenErrorBoundary>
        <Flaky />
      </ScreenErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
