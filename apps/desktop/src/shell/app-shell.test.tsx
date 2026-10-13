import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      "projects",
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
    expect(items).toHaveLength(12);
    expect(items.find((i) => i.id === "docs")?.readOnly).toBe(false);
  });

  it("chia ba nhóm Công việc, Tài liệu, Máy này; mục docs mang nhãn Tài liệu từ code", () => {
    const groups = navGroups("lead");
    expect(groups.map((g) => [g.label.vi, g.items.map((i) => i.label.vi)])).toEqual([
      ["Công việc", ["Tổng quan", "Việc của tôi", "Chờ tôi duyệt"]],
      ["Tài liệu", ["Tra cứu tri thức", "Soạn tài liệu", "Tài liệu từ code"]],
      ["Máy này", ["Gói agent", "Dự án trên máy", "Lượt chạy trên máy", "Môi trường", "Skills", "Token và ngữ cảnh"]],
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
      ["Gói agent", "Dự án trên máy", "Lượt chạy trên máy", "Môi trường", "Skills", "Token và ngữ cảnh"],
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

describe("phiên bản và ngày build", () => {
  beforeEach(() => setLang("vi"));

  it("đáy menu hiện phiên bản app, mã commit và ngày build", async () => {
    window.__TAURI__ = {
      core: { invoke: async <T,>(command: string) => (command === "plugin:app|version" ? "0.2.6" : null) as T },
    };
    render(<AppShell />);
    const built = new Date("2026-10-13T07:05:00.000Z");
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `${pad(built.getDate())}/${pad(built.getMonth() + 1)}/${built.getFullYear()} ${pad(built.getHours())}:${pad(built.getMinutes())}`;
    expect(await screen.findByText(`v0.2.6 · abc1234 · ${date}`)).toBeTruthy();
  });

  it("ngoài Tauri ghi là bản dựng tại máy", async () => {
    render(<AppShell />);
    expect(await screen.findByText(/^bản dựng tại máy · abc1234 · /)).toBeTruthy();
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

describe("cửa sổ thấp", () => {
  beforeEach(() => setLang("vi"));

  function fakeHeight(matches: boolean) {
    window.matchMedia = ((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  }

  afterEach(() => {
    // @ts-expect-error jsdom không có matchMedia; trả về trạng thái gốc cho các ca khác.
    delete window.matchMedia;
  });

  it("gộp worker và phiên bản sau một dòng, bấm mở chi tiết", async () => {
    fakeHeight(true);
    render(<AppShell />);
    const user = userEvent.setup();
    expect(screen.queryByText(/^bản dựng tại máy · /)).toBeNull();
    const toggle = screen.getByRole("button", { name: "Worker và phiên bản" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText(/^bản dựng tại máy · abc1234 · /)).toBeTruthy();
    await user.click(toggle);
    expect(screen.queryByText(/^bản dựng tại máy · /)).toBeNull();
  });

  it("cửa sổ đủ cao giữ khối chân đầy đủ, không có dòng gộp", async () => {
    fakeHeight(false);
    render(<AppShell />);
    expect(screen.queryByRole("button", { name: "Worker và phiên bản" })).toBeNull();
    expect(await screen.findByText(/^bản dựng tại máy · abc1234 · /)).toBeTruthy();
  });

  it("cuộn mục đang chọn vào tầm nhìn", () => {
    const calls: unknown[] = [];
    Element.prototype.scrollIntoView = (arg?: unknown) => {
      calls.push(arg);
    };
    location.hash = "#/tokens";
    render(<AppShell />);
    // @ts-expect-error gỡ hàm giả để không lọt sang ca khác
    delete Element.prototype.scrollIntoView;
    expect(calls).toContainEqual({ block: "nearest" });
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

describe("dòng báo bản mới", () => {
  beforeEach(() => setLang("vi"));

  function fakeTauri(opts: { ready?: { version: string; notes: string | null }; relaunch?: () => Promise<void> } = {}) {
    const calls: string[] = [];
    let push: (v: unknown) => void = () => {};
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string) => {
          calls.push(command);
          if (command === "update_status") return { current: "0.2.0", ready: opts.ready ?? null } as T;
          if (command === "relaunch_to_update") return (await opts.relaunch?.()) as T;
          return null as T;
        },
      },
      event: {
        listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
          if (event === "update-ready") push = (v) => handler({ payload: v as T });
          return () => {};
        },
      },
    };
    return { calls, emit: (v: unknown) => act(async () => push(v)) };
  }

  it("không hiện khi chưa có bản nào sẵn sàng", async () => {
    const { calls } = fakeTauri();
    render(<AppShell />);
    await act(async () => {});
    expect(calls).toContain("update_status");
    expect(screen.queryByRole("button", { name: "Mở lại để cập nhật" })).toBeNull();
  });

  it("hiện khi có sự kiện update-ready, nút gọi relaunch_to_update", async () => {
    const { calls, emit } = fakeTauri();
    render(<AppShell />);
    await emit({ version: "0.3.0", notes: null });
    expect(screen.getByText("Đã tải bản 0.3.0. Mở lại để cập nhật.")).toBeTruthy();
    // Không có ghi chú thì không có nút Xem thay đổi.
    expect(screen.queryByRole("button", { name: "Xem thay đổi" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở lại để cập nhật" }));
    expect(calls).toContain("relaunch_to_update");
  });

  it("bản đã tải từ trước khi mở cửa sổ cũng hiện", async () => {
    fakeTauri({ ready: { version: "0.3.1", notes: null } });
    render(<AppShell />);
    expect(await screen.findByText("Đã tải bản 0.3.1. Mở lại để cập nhật.")).toBeTruthy();
  });

  it("Ẩn tạm giấu dòng báo, bản mới hơn hiện lại", async () => {
    const { emit } = fakeTauri();
    render(<AppShell />);
    await emit({ version: "0.3.0", notes: null });
    await userEvent.setup().click(screen.getByRole("button", { name: "Ẩn tạm" }));
    expect(screen.queryByText(/Đã tải bản 0.3.0/)).toBeNull();
    await emit({ version: "0.3.1", notes: null });
    expect(screen.getByText("Đã tải bản 0.3.1. Mở lại để cập nhật.")).toBeTruthy();
  });

  it("Xem thay đổi hiện ghi chú markdown", async () => {
    const { emit } = fakeTauri();
    render(<AppShell />);
    await emit({ version: "0.3.0", notes: "## Có gì mới\n\n- Sửa lỗi **đăng nhập**" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Xem thay đổi" }));
    expect(await screen.findByRole("heading", { name: "Có gì mới" })).toBeTruthy();
    expect(screen.getByText("đăng nhập").tagName).toBe("STRONG");
  });

  it("mở lại lỗi thì báo lỗi và cho bấm lại", async () => {
    const { emit } = fakeTauri({
      relaunch: () => Promise.reject("Không cài được bản 0.3.0: hết dung lượng"),
    });
    render(<AppShell />);
    await emit({ version: "0.3.0", notes: null });
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở lại để cập nhật" }));
    expect((await screen.findByRole("alert")).textContent).toContain("hết dung lượng");
    expect((screen.getByRole("button", { name: "Mở lại để cập nhật" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("tiếng Anh", async () => {
    setLang("en");
    const { emit } = fakeTauri();
    render(<AppShell />);
    await emit({ version: "0.3.0", notes: "x" });
    expect(screen.getByText("Version 0.3.0 is downloaded. Restart to update.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "What's new" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide for now" })).toBeTruthy();
  });
});
