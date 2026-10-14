import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ArtifactPageError } from "@xdev-hive/contracts";
import { describe, expect, it, vi } from "vitest";
import { MAX_PAGE_ERRORS, SandboxFrame } from "./sandbox-frame.tsx";
import { fakeClient, renderWithEnv, testEnv } from "./test-fixtures.tsx";

const user = userEvent.setup({ delay: null });
const SRC = "http://hub.test/_artifact/frame/ticket";

function setup() {
  const onErrors = vi.fn<(errors: ArtifactPageError[]) => void>();
  renderWithEnv(<SandboxFrame src={SRC} title="Trang thử" onErrors={onErrors} />, testEnv(fakeClient()));
  const frame = screen.getByTitle("Trang thử") as HTMLIFrameElement;
  const post = (data: unknown, source: MessageEventSource | null = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source }));
    });
  const lastErrors = () => onErrors.mock.lastCall?.[0] ?? [];
  return { frame, post, lastErrors };
}

describe("SandboxFrame", () => {
  it("cách ly bằng sandbox chỉ cho script, không quyền, không Referer", () => {
    const { frame } = setup();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.getAttribute("src")).toBe(SRC);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(screen.getByText(/Nội dung do agent tạo/)).toBeTruthy();
  });

  it("bỏ tin từ nguồn khác và tin sai schema", async () => {
    const { frame, post, lastErrors } = setup();
    await post({ type: "error", kind: "runtime", message: "từ trang cha" }, window);
    await post({ type: "error", kind: "runtime", message: "không nguồn" }, null);
    await post({ type: "error", kind: "runtime", message: "thừa trường", html: "<b>x</b>" });
    await post({ type: "console", level: "info", message: "mức lạ" });
    await post({ type: "navigate", url: "https://evil.test" });
    await post("chuỗi trần");
    await post({ type: "resize", height: -5 });
    expect(lastErrors()).toEqual([]);
    expect(frame.style.height).toBe("240px");

    await post({ type: "resize", height: 812.4 });
    expect(frame.style.height).toBe("813px");
    await post({ type: "error", kind: "runtime", message: "TypeError: x is undefined" });
    await post({ type: "console", level: "warn", message: "<img src=x onerror=alert(1)>" });
    await post({ type: "error", kind: "compile", message: "Thiếu export default" });
    await post({ type: "error", kind: "promise", message: "   " });
    expect(lastErrors()).toEqual([
      { kind: "error", message: "TypeError: x is undefined" },
      { kind: "console", message: "<img src=x onerror=alert(1)>" },
      { kind: "compile", message: "Thiếu export default" },
    ]);
  });

  it(`giữ tối đa ${MAX_PAGE_ERRORS} lỗi mỗi lần nạp, tải lại thì đếm lại`, async () => {
    const { post, lastErrors } = setup();
    for (let i = 0; i < MAX_PAGE_ERRORS + 5; i++) await post({ type: "console", level: "error", message: `lỗi ${i}` });
    expect(lastErrors()).toHaveLength(MAX_PAGE_ERRORS);
    expect(lastErrors().at(-1)?.message).toBe(`lỗi ${MAX_PAGE_ERRORS - 1}`);

    await user.click(screen.getByRole("button", { name: "Dừng trang" }));
    expect(screen.queryByTitle("Trang thử")).toBeNull();
    expect(screen.getByText("Đã dừng trang. Tải lại để tiếp tục.")).toBeTruthy();
    // Dừng rồi vẫn giữ lỗi để người xem nhờ Leader sửa.
    expect(lastErrors()).toHaveLength(MAX_PAGE_ERRORS);

    await user.click(screen.getByRole("button", { name: "Tải lại trang" }));
    expect(screen.getByTitle("Trang thử")).toBeTruthy();
    expect(lastErrors()).toEqual([]);
  });
});
