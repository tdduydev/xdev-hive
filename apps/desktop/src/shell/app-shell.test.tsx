import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { navItems, screenFromHash, screenParam } from "@/lib/nav.ts";
import { windowKind } from "@/lib/tauri.ts";
import { AppShell } from "@/shell/app-shell.tsx";

describe("menu theo hồ sơ", () => {
  it("dev: không có quyền viết tài liệu nên Tài liệu chỉ đọc", () => {
    const items = navItems("dev");
    expect(items.map((i) => i.id)).toEqual([
      "home",
      "work",
      "reviews",
      "knowledge",
      "docs",
      "write",
      "skills",
      "tokens",
      "setup",
      "runs",
    ]);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(true);
  });

  it("writer: không thấy Việc của tôi, Môi trường và Lượt chạy; người xem đội chỉ đọc tài liệu", () => {
    const items = navItems("writer");
    expect(items.map((i) => i.id)).toEqual(["home", "reviews", "knowledge", "docs", "write", "skills", "tokens"]);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(true);
  });

  it("lead: thấy hết, Tài liệu sửa được", () => {
    const items = navItems("lead");
    expect(items).toHaveLength(10);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(false);
  });

  it("đường dẫn lạ về Tổng quan", () => {
    expect(screenFromHash("#/skills")).toBe("skills");
    expect(screenFromHash("#/khong-co")).toBe("home");
    expect(screenFromHash("")).toBe("home");
  });

  it("màn Soạn tài liệu mang key tài liệu trong đường dẫn", () => {
    expect(screenFromHash("#/write/project%2Fpay%2Fprd")).toBe("write");
    expect(screenParam("#/write/project%2Fpay%2Fprd")).toBe("project/pay/prd");
    expect(screenParam("#/write")).toBe("");
    expect(screenParam("#/write/%E0%A4%A")).toBe("");
  });
});

describe("cửa sổ", () => {
  it("theo nhãn cửa sổ Tauri", () => {
    window.__TAURI__ = {
      core: { invoke: async () => undefined as never },
      window: { getCurrentWindow: () => ({ label: "app" }) },
    };
    expect(windowKind()).toBe("app");
    window.__TAURI__ = {
      core: { invoke: async () => undefined as never },
      window: { getCurrentWindow: () => ({ label: "register" }) },
    };
    expect(windowKind()).toBe("register");
  });

  it("ngoài Tauri mặc định là cửa sổ đăng ký", () => {
    expect(windowKind()).toBe("register");
  });
});

describe("AppShell", () => {
  beforeEach(() => setLang("vi"));

  it("mặc định Tổng quan, đổi màn theo #/", async () => {
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(within(nav).getByRole("link", { name: "Tổng quan" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1, name: "Tổng quan" })).toBeTruthy();
    await act(async () => {
      location.hash = "#/runs";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Lượt chạy trên máy" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Lượt chạy trên máy" }).getAttribute("aria-current")).toBe("page");
    // Mọi mục của AppNav đã có màn thật: không còn trang "Sắp có".
    expect(screen.queryByText("Sắp có")).toBeNull();
  });

  it("không hiện người dùng hay thư mục mẫu khi chưa có dữ liệu", () => {
    render(<AppShell profile="writer" />);
    expect(screen.getByText("Chưa liên kết tài khoản")).toBeTruthy();
    expect(screen.getByText("Chưa chọn thư mục")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Môi trường" })).toBeNull();
    // Người xem đội: Tài liệu và Skills đều chỉ đọc (không cài skill lên máy).
    expect(screen.getAllByText("chỉ đọc")).toHaveLength(2);
  });

  it("tiếng Anh", () => {
    setLang("en");
    location.hash = "#/runs";
    render(<AppShell />);
    expect(screen.getByRole("navigation", { name: "App navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tokens & context" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Runs on this machine" })).toBeTruthy();
  });
});

describe("thẻ worker", () => {
  it("hiện trạng thái từ Rust và đổi theo sự kiện worker-state", async () => {
    let push: (v: unknown) => void = () => {};
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string) =>
          (command === "worker_state"
            ? {
                kind: "connecting",
                label: "Worker: đang kết nối",
                detail: null,
                wanted: true,
                hub: "https://hive.acme.vn",
              }
            : null) as T,
      },
      event: {
        listen: async <T,>(_e: string, handler: (e: { payload: T }) => void) => {
          push = (v) => handler({ payload: v as T });
          return () => {};
        },
      },
    };
    render(<AppShell />);
    expect(await screen.findByText("Worker đang kết nối")).toBeTruthy();
    expect(screen.getByText("hive.acme.vn")).toBeTruthy();
    await act(async () =>
      push({
        kind: "online",
        label: "Worker: đang nhận việc",
        detail: null,
        wanted: true,
        hub: "https://hive.acme.vn",
      }),
    );
    expect(screen.getByText("Worker đang nhận việc")).toBeTruthy();
  });

  it("ngoài Tauri không hiện thẻ worker", () => {
    render(<AppShell />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
