import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang } from "@/lib/i18n.ts";
import { windowKind } from "@/lib/tauri.ts";
import { AppShell } from "@/shell/app-shell.tsx";

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

  it("mặc định Máy này, đổi màn theo #/", async () => {
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(within(nav).getByRole("link", { name: "Máy này" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { level: 1, name: "Máy này" })).toBeTruthy();
    await act(async () => {
      location.hash = "#/runs";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("heading", { level: 1, name: "Lượt chạy" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Lượt chạy" }).getAttribute("aria-current")).toBe("page");
    // Mọi mục của AppNav đã có màn thật: không còn trang "Sắp có".
    expect(screen.queryByText("Sắp có")).toBeNull();
  });

  it("menu chỉ còn việc của máy: Máy này, rồi nhóm Chạy, Agent, Dự án; chân menu có web và Cài đặt", () => {
    render(<AppShell profile="lead" />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    const groups = within(nav).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Máy này", "Chạy", "Agent", "Dự án"]);
    expect(
      groups.map((g) =>
        within(g)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ),
    ).toEqual([
      ["Máy này"],
      ["Agent trên máy", "Hộp thư đi", "Cây giao việc", "Lượt chạy", "Điều khiển từ xa"],
      ["Gói agent", "Skills", "Memory", "Token và ngữ cảnh"],
      ["Dự án trên máy", "Môi trường", "Bí mật", "Máy chủ SSH", "Tài liệu từ code", "Nhập Word"],
    ]);
    // Nhóm đầu chỉ một mục nên không vẽ tiêu đề; ba nhóm sau có.
    for (const title of ["Chạy", "Agent", "Dự án"]) expect(within(nav).getByText(title)).toBeTruthy();
    expect(within(nav).getAllByText("Máy này")).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "Tài liệu từ code" }).getAttribute("href")).toBe("#/docs");
    expect(within(nav).getByRole("link", { name: "Cài đặt" }).getAttribute("href")).toBe("#/settings");
    expect(within(nav).getByRole("button", { name: "Mở hub trên web" })).toBeTruthy();
    // Màn việc của đội đã chuyển sang web.
    for (const gone of ["Việc của tôi", "Chờ tôi duyệt", "Leader", "Artifact", "Hạng mục", "Tra cứu tri thức"])
      expect(within(nav).queryByRole("link", { name: gone })).toBeNull();
  });

  it("Mở hub trên web mở trang đầu của hub máy đã đăng ký", async () => {
    const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
          calls.push({ command, args });
          if (command === "worker_state")
            return {
              kind: "online",
              label: "Worker: đang nhận việc",
              detail: null,
              wanted: true,
              hub: "https://hive.acme.vn",
            } as T;
          return null as T;
        },
      },
    };
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(await within(nav).findByText("Worker đang nhận việc")).toBeTruthy();
    await userEvent.setup().click(within(nav).getByRole("button", { name: "Mở hub trên web" }));
    expect(calls.find((c) => c.command === "open_hub_page")?.args).toEqual({ path: "/" });
  });

  it("máy chưa đăng ký: Mở hub trên web mở hộp thoại kết nối", async () => {
    render(<AppShell />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở hub trên web" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("bấm thông báo về run trên máy thì Rust báo chuyển màn, app mở Lượt chạy", async () => {
    let push: (v: unknown) => void = () => {};
    window.__TAURI__ = {
      core: { invoke: async <T,>() => null as T },
      event: {
        listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
          if (event === "app-navigate") push = (v) => handler({ payload: v as T });
          return () => {};
        },
      },
    };
    render(<AppShell />);
    await act(async () => {
      push("runs");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(location.hash).toBe("#/runs");
    expect(screen.getByRole("heading", { level: 1, name: "Lượt chạy" })).toBeTruthy();
  });

  it("không hiện người dùng hay thư mục mẫu khi chưa có dữ liệu", () => {
    render(<AppShell profile="writer" />);
    expect(screen.getByText("Chưa đăng nhập")).toBeTruthy();
    expect(screen.getByText("Chưa chọn thư mục")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(within(nav).queryByRole("link", { name: "Môi trường" })).toBeNull();
    // Người xem đội: Tài liệu từ code và Skills đều chỉ đọc (không cài skill lên máy).
    expect(within(nav).getAllByText("chỉ đọc")).toHaveLength(2);
    // Writer không có Lượt chạy, Điều khiển từ xa; Agent trên máy và Terminal là việc tại máy nên vẫn có.
    expect(
      within(within(nav).getByRole("group", { name: "Chạy" }))
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Agent trên máy", "Hộp thư đi"]);
    expect(within(nav).getByText("Agent")).toBeTruthy();
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
    expect(within(nav).getByText("Agents")).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Settings" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Open the hub on the web" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Runs" })).toBeTruthy();
  });
});

describe("chưa đăng nhập", () => {
  beforeEach(() => setLang("vi"));

  async function open(id: string) {
    await act(async () => {
      location.hash = `#/${id}`;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
  }

  it("mở thẳng giao diện chính, không có màn chặn đăng nhập", async () => {
    render(<AppShell />);
    expect(screen.getByRole("heading", { level: 1, name: "Máy này" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Điều hướng app" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Chưa đăng nhập/ })).toBeTruthy();
  });

  it("màn chỉ có dữ liệu trên hub mời kết nối Hive, nút mở hộp thoại tài khoản", async () => {
    render(<AppShell />);
    const user = userEvent.setup();
    await open("runs");
    expect(await screen.findByRole("heading", { name: "Kết nối Hive để dùng mục này" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Kết nối Hive" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Đăng nhập bằng trình duyệt" })).toBeTruthy();
  });

  it("màn trên máy dùng được, không hiện lời mời kết nối thay cho màn", async () => {
    render(<AppShell />);
    for (const id of [
      "home",
      "remote",
      "docs",
      "plans",
      "projects",
      "setup",
      "skills",
      "tokens",
      "memory",
      "settings",
    ]) {
      await open(id);
      expect(screen.queryByRole("heading", { name: "Kết nối Hive để dùng mục này" })).toBeNull();
    }
  });

  it("mục cần hub vẫn ở menu, chỉ mờ đi kèm chú thích", () => {
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    const offline = within(nav)
      .getAllByRole("link")
      .filter((a) => a.hasAttribute("data-offline"))
      .map((a) => a.getAttribute("href"));
    expect(offline).toEqual(["#/tree", "#/runs", "#/word-import"]);
    expect(within(nav).getByRole("link", { name: "Lượt chạy" }).getAttribute("title")).toBe(
      "Lượt chạy · Cần kết nối Hive",
    );
  });

  it("đã đăng nhập thì không mờ mục nào, màn hub hiện như cũ", async () => {
    window.__TAURI__ = {
      core: {
        invoke: async <T,>(command: string) =>
          (command === "account_status"
            ? {
                hub: "https://hive.acme.vn",
                linked: true,
                account: { name: "Hà", email: "ha@acme.vn", orgId: "o", orgName: "Acme", orgRole: "member", teams: [] },
                error: null,
              }
            : null) as T,
      },
    };
    location.hash = "#/runs";
    render(<AppShell />);
    expect(await screen.findByText("Hà")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(
      within(nav)
        .getAllByRole("link")
        .some((a) => a.hasAttribute("data-offline")),
    ).toBe(false);
    expect(screen.queryByRole("heading", { name: "Kết nối Hive để dùng mục này" })).toBeNull();
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
    expect(within(nav()).getByText("Agent")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Thu gọn menu" }));
    expect(nav().hasAttribute("data-compact")).toBe(true);
    // Chỉ còn icon thì bỏ tiêu đề nhóm, nhưng nhóm vẫn giữ tên cho trình đọc màn hình.
    expect(within(nav()).queryByText("Agent")).toBeNull();
    expect(within(nav()).getByRole("group", { name: "Agent" })).toBeTruthy();
    unmount();
    render(<AppShell />);
    expect(nav().hasAttribute("data-compact")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Mở rộng menu" }));
    expect(nav().hasAttribute("data-compact")).toBe(false);
  });

  it("màn cần chỗ tự thu gọn khi chưa chọn, vẫn mở rộng được", async () => {
    location.hash = "#/docs";
    render(<AppShell />);
    const nav = screen.getByRole("navigation", { name: "Điều hướng app" });
    expect(nav.hasAttribute("data-compact")).toBe(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Mở rộng menu" }));
    expect(nav.hasAttribute("data-compact")).toBe(false);
  });

  it("chọn English ở danh sách ngôn ngữ thì cả app đổi sang tiếng Anh", async () => {
    render(<AppShell />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Ngôn ngữ"), "en");
    expect(screen.getByRole("heading", { level: 1, name: "This machine" })).toBeTruthy();
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
    // AppNav và màn Máy này cùng nghe "worker-state": sự kiện phải tới mọi nơi nghe, như Tauri thật.
    const heard: ((v: unknown) => void)[] = [];
    const push = (v: unknown) => {
      for (const h of heard) h(v);
    };
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
        listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
          if (event === "worker-state") heard.push((v) => handler({ payload: v as T }));
          return () => {};
        },
      },
    };
    render(<AppShell />);
    expect(await screen.findByText("Worker đang kết nối")).toBeTruthy();
    // Màn Máy này cũng có thẻ worker; ở đây chỉ kiểm thẻ trong AppNav.
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
