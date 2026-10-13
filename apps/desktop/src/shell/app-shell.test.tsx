import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { NAV_GROUPS, navGroups, navItems, screenFromHash, screenParam } from "@/lib/nav.ts";
import { windowKind } from "@/lib/tauri.ts";
import { AppShell } from "@/shell/app-shell.tsx";

describe("menu theo hồ sơ", () => {
  it("dev: không có quyền viết tài liệu nên Tài liệu từ code chỉ đọc", () => {
    const items = navItems("dev");
    expect(items.map((i) => i.id)).toEqual([
      "home",
      "work",
      "reviews",
      "knowledge",
      "write",
      "docs",
      "plans",
      "runs",
      "setup",
      "skills",
      "tokens",
    ]);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(true);
  });

  it("writer: không thấy Việc của tôi, Môi trường và Lượt chạy; người xem đội chỉ đọc tài liệu", () => {
    const items = navItems("writer");
    expect(items.map((i) => i.id)).toEqual(["home", "reviews", "knowledge", "write", "docs", "skills", "tokens"]);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(true);
  });

  it("lead: thấy hết, Tài liệu từ code sửa được", () => {
    const items = navItems("lead");
    expect(items).toHaveLength(11);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(false);
  });

  it("chia ba nhóm Công việc, Tài liệu, Máy này; mục docs mang nhãn Tài liệu từ code", () => {
    const groups = navGroups("lead");
    expect(groups.map((g) => [g.label.vi, g.items.map((i) => i.label.vi)])).toEqual([
      ["Công việc", ["Tổng quan", "Việc của tôi", "Chờ tôi duyệt"]],
      ["Tài liệu", ["Tra cứu tri thức", "Soạn tài liệu", "Tài liệu từ code"]],
      ["Máy này", ["Gói agent", "Lượt chạy trên máy", "Môi trường", "Skills", "Token và ngữ cảnh"]],
    ]);
    expect(groups.map((g) => g.label.en)).toEqual(["Work", "Docs", "This machine"]);
    expect(groups[1]?.items.find((i) => i.id === "docs")?.label.en).toBe("Docs from code");
  });

  it("writer vẫn thấy cả ba nhóm, chỉ bớt mục trong nhóm", () => {
    const groups = navGroups("writer");
    expect(groups.map((g) => [g.id, g.items.map((i) => i.id)])).toEqual([
      ["work", ["home", "reviews"]],
      ["docs", ["knowledge", "write", "docs"]],
      ["machine", ["skills", "tokens"]],
    ]);
  });

  it("nhóm không còn mục nào theo hồ sơ thì bỏ cả nhóm", () => {
    // Nhóm Máy này chỉ còn Lượt chạy và Môi trường: writer không có quyền nào trong đó.
    const groups = NAV_GROUPS.map((g) =>
      g.id === "machine" ? { ...g, items: g.items.filter((i) => i.id === "runs" || i.id === "setup") } : g,
    );
    expect(navGroups("writer", groups).map((g) => g.id)).toEqual(["work", "docs"]);
    expect(navGroups("dev", groups).map((g) => g.id)).toEqual(["work", "docs", "machine"]);
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

  it("menu chia nhóm có tiêu đề, mục theo thứ tự trong nhóm", () => {
    render(<AppShell profile="lead" />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    const groups = within(nav).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Công việc", "Tài liệu", "Máy này"]);
    expect(
      groups.map((g) =>
        within(g)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ),
    ).toEqual([
      ["Tổng quan", "Việc của tôi", "Chờ tôi duyệt"],
      ["Tra cứu tri thức", "Soạn tài liệu", "Tài liệu từ code"],
      ["Gói agent", "Lượt chạy trên máy", "Môi trường", "Skills", "Token và ngữ cảnh"],
    ]);
    for (const title of ["Công việc", "Tài liệu", "Máy này"]) expect(within(nav).getByText(title)).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Tài liệu từ code" }).getAttribute("href")).toBe("#/docs");
  });

  it("không hiện người dùng hay thư mục mẫu khi chưa có dữ liệu", () => {
    render(<AppShell profile="writer" />);
    expect(screen.getByText("Chưa liên kết tài khoản")).toBeTruthy();
    expect(screen.getByText("Chưa chọn thư mục")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Môi trường" })).toBeNull();
    // Người xem đội: Tài liệu từ code và Skills đều chỉ đọc (không cài skill lên máy).
    expect(screen.getAllByText("chỉ đọc")).toHaveLength(2);
    // Nhóm Máy này vẫn còn Skills và Token nên giữ tiêu đề.
    expect(screen.getByText("Máy này")).toBeTruthy();
  });

  it("tiếng Anh", () => {
    setLang("en");
    location.hash = "#/runs";
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "App navigation" });
    expect(within(nav).getByRole("link", { name: "Tokens & context" })).toBeTruthy();
    // Hồ sơ dev đọc được tài liệu từ code nhưng không sửa, nên tên mục kèm nhãn read-only.
    expect(within(nav).getByRole("link", { name: /^Docs from code/ })).toBeTruthy();
    expect(within(nav).getByRole("group", { name: "This machine" })).toBeTruthy();
    expect(within(nav).getByText("Work")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Runs on this machine" })).toBeTruthy();
  });
});

describe("đóng mở menu và chọn ngôn ngữ", () => {
  beforeEach(() => setLang("vi"));

  it("nút ở đầu trang thu gọn menu còn icon, bấm lại mở rộng; lựa chọn giữ qua lần mở sau", async () => {
    const { unmount } = render(<AppShell />);
    const user = userEvent.setup();
    const nav = () => screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(nav().hasAttribute("data-compact")).toBe(false);
    expect(within(nav()).getByText("Công việc")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thu gọn menu" }));
    expect(nav().hasAttribute("data-compact")).toBe(true);
    // Chỉ còn icon thì bỏ tiêu đề nhóm, nhưng nhóm vẫn giữ tên cho trình đọc màn hình.
    expect(within(nav()).queryByText("Công việc")).toBeNull();
    expect(within(nav()).queryByText("Máy này")).toBeNull();
    expect(within(nav()).getByRole("group", { name: "Công việc" })).toBeTruthy();
    unmount();
    render(<AppShell />);
    expect(nav().hasAttribute("data-compact")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Mở rộng menu" }));
    expect(nav().hasAttribute("data-compact")).toBe(false);
  });

  it("màn cần chỗ tự thu gọn khi chưa chọn, vẫn mở rộng được", async () => {
    location.hash = "#/write";
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(nav.hasAttribute("data-compact")).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở rộng menu" }));
    expect(nav.hasAttribute("data-compact")).toBe(false);
  });

  it("chọn English ở danh sách ngôn ngữ thì cả app đổi sang tiếng Anh", async () => {
    render(<AppShell />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Ngôn ngữ"), "en");
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(screen.getByLabelText("Language")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
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
    // Màn Tổng quan cũng có ô worker; ở đây chỉ kiểm thẻ trong AppNav.
    expect(within(screen.getByRole("navigation")).getByText("hive.acme.vn")).toBeTruthy();
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
