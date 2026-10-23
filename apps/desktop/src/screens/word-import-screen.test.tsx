import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Account, AccountContext } from "@/lib/account.ts";
import { queryClient } from "@/lib/hub-query.tsx";
import { setLang } from "@/lib/i18n.ts";
import type { PickedWordFile } from "@/lib/word-import.ts";
import { WordImportScreen } from "@/screens/word-import-screen.tsx";

const ACCOUNT: Account = {
  name: "Phạm Hà",
  email: "ha@acme.vn",
  orgId: "o1",
  orgName: "Acme",
  orgRole: "member",
  teams: [{ id: "t1", name: "Thanh toán", role: "member" }],
};

const HOME = { id: "home-1", root: "docs/", wordImportConfidential: false };
const MB = 1024 * 1024;

const word = (index: number, name: string, relativeDir = "", size = 10 * 1024): PickedWordFile => ({
  index,
  name,
  relativeDir,
  relativePath: relativeDir ? `${relativeDir}/${name}` : name,
  size,
  lastModified: 1,
});

const importFile = (overrides: Record<string, unknown> = {}) => ({
  id: "f1",
  importId: "imp-1",
  relativeDir: "SRS",
  fileName: "OPD.docx",
  format: "docx",
  size: 10240,
  sha256: "a".repeat(64),
  versionLabel: "1.1",
  proposedPath: "docs/srs/opd.md",
  proposedTitle: "OPD",
  path: "docs/srs/opd.md",
  title: "OPD",
  key: null,
  exists: false,
  keepFront: false,
  excluded: false,
  state: "ready",
  stats: null,
  warnings: [],
  findings: [],
  error: null,
  linkMatches: null,
  docId: null,
  docVersion: null,
  proposalId: null,
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
  ...overrides,
});

const importOf = (state = "ready", mode = "create") => ({
  id: "imp-1",
  homeId: HOME.id,
  targetDir: "docs/",
  mode,
  docKey: null,
  confidential: false,
  state,
  counts: {},
  createdBy: { id: "u1", name: "Phạm Hà" },
  createdAt: "2026-10-23T00:00:00Z",
  updatedAt: "2026-10-23T00:00:00Z",
});

type Call = { command: string; args?: Record<string, unknown> | undefined };
type Rpc = Record<string, (input: unknown) => unknown>;
type Handlers = Record<string, (args?: Record<string, unknown>) => unknown>;

function fakeTauri(rpc: Rpc, extra: Handlers = {}) {
  const calls: Call[] = [];
  const listeners: Record<string, (e: { payload: unknown }) => void> = {};
  const routes: Rpc = {
    "projects/list": () => [],
    "docHomes/get": () => HOME,
    "wordImports/list": () => ({ items: [], nextCursor: null }),
    ...rpc,
  };
  const handlers: Handlers = {
    hub_rpc: (args) => {
      const [pathname = "", query = ""] = String(args?.path).split("?");
      const procedure = pathname.replace(/^\/rpc\//, "");
      const wire = args?.body ? String(args.body) : new URLSearchParams(query).get("data");
      const input = wire ? JSON.parse(wire).json : undefined;
      const reply = routes[procedure];
      return {
        status: reply ? 200 : 404,
        contentType: "application/json",
        body: JSON.stringify(
          reply
            ? { json: reply(input) }
            : { json: { defined: false, code: "NOT_FOUND", status: 404, message: "chưa giả" } },
        ),
      };
    },
    ...extra,
  };
  window.__TAURI__ = {
    core: {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        const handler = handlers[command];
        if (!handler) throw new Error(`lệnh chưa giả: ${command}`);
        return (await handler(args)) as T;
      },
    },
    event: {
      listen: async <T,>(event: string, handler: (e: { payload: T }) => void) => {
        listeners[event] = handler as (e: { payload: unknown }) => void;
        return () => {};
      },
    },
  };
  const emit = (event: string, payload: unknown) => act(async () => listeners[event]?.({ payload }));
  return { calls, emit };
}

const renderScreen = () =>
  render(
    <AccountContext.Provider value={ACCOUNT}>
      <WordImportScreen />
    </AccountContext.Provider>,
  );

beforeEach(() => {
  setLang("vi");
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  delete window.__TAURI__;
});

describe("Nhập Word: chọn file", () => {
  it("chọn thư mục: bỏ file khoá ~$, đếm file và dung lượng, rồi tải lên với đúng chỉ số và thư mục đích", async () => {
    const pick = {
      pickId: "pick-1",
      root: "C:\\Tai lieu\\SRS",
      truncated: false,
      files: [word(0, "OPD.docx", "OPD"), word(1, "~$OPD.docx", "OPD", 162), word(2, "IPD.odt", "IPD")],
    };
    const { calls, emit } = fakeTauri(
      {
        "wordImports/get": () => ({ import: importOf(), files: [importFile()], access: "manage" }),
      },
      {
        pick_word_files: () => pick,
        hub_upload_word: async (args) => {
          await emit("word-import:progress", {
            uploadId: args?.uploadId,
            index: 0,
            name: "OPD.docx",
            sent: 5 * 1024,
            size: 10 * 1024,
          });
          return { importId: "imp-1" };
        },
      },
    );
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole("button", { name: "Chọn thư mục…" }));
    expect(await screen.findByText("2 file, 20 KB")).toBeTruthy();
    expect(screen.getByText("Bỏ qua 1 file tạm của Word (tên bắt đầu bằng ~$).")).toBeTruthy();
    expect(screen.getByText("OPD/OPD.docx")).toBeTruthy();
    expect(screen.queryByText("OPD/~$OPD.docx")).toBeNull();
    expect(calls.find((c) => c.command === "pick_word_files")?.args).toEqual({ folder: true });

    await user.click(screen.getByRole("button", { name: "Tải lên" }));
    // Vào trang lượt nhập sau khi hub nhận file.
    expect(await screen.findByRole("button", { name: "Tạo 1 tài liệu" })).toBeTruthy();
    const upload = calls.find((c) => c.command === "hub_upload_word");
    expect(upload?.args).toMatchObject({
      pickId: "pick-1",
      indexes: [0, 2],
      input: { homeId: "home-1", targetDir: "docs/", confidential: false },
    });
    expect(typeof upload?.args?.uploadId).toBe("string");
  });

  it("tiến độ từng file hiện trong bảng khi đang tải lên", async () => {
    let release: (value: { importId: string }) => void = () => {};
    const { emit } = fakeTauri(
      {},
      {
        pick_word_files: () => ({
          pickId: "pick-2",
          root: null,
          truncated: false,
          files: [word(0, "a.docx", "", 10 * 1024)],
        }),
        hub_upload_word: () => new Promise((resolve) => (release = resolve)),
      },
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn file…" }));
    await user.click(await screen.findByRole("button", { name: "Tải lên" }));
    const uploadId = await waitFor(() => {
      const bar = screen.getByRole("progressbar", { name: "Tiến độ gửi a.docx" });
      return bar;
    });
    expect((uploadId as HTMLProgressElement).value).toBe(0);
    // Sự kiện của lượt gửi khác (uploadId lạ) bị bỏ qua.
    await emit("word-import:progress", { uploadId: "khac", index: 0, name: "a.docx", sent: 9, size: 10 });
    expect((uploadId as HTMLProgressElement).value).toBe(0);
    act(() => release({ importId: "imp-x" }));
  });

  it("chọn quá giới hạn: báo lý do và khoá nút Tải lên", async () => {
    const files = Array.from({ length: 101 }, (_, i) => word(i, `f${i}.docx`));
    fakeTauri({}, { pick_word_files: () => ({ pickId: "pick-3", root: "/w", truncated: false, files }) });
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn thư mục…" }));
    expect(await screen.findByText(/Quá 100 file một lượt \(đang chọn 101\)/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Tải lên" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("có file quá 50 MB: nêu tên file và khoá nút", async () => {
    fakeTauri(
      {},
      {
        pick_word_files: () => ({
          pickId: "pick-4",
          root: null,
          truncated: false,
          files: [word(0, "SRS-lon.docx", "", 60 * MB)],
        }),
      },
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn file…" }));
    expect(await screen.findByText(/SRS-lon\.docx \(60 MB\) vượt 50 MB một file/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Tải lên" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("thư mục đích ngoài gốc nhà: báo lỗi và khoá nút", async () => {
    fakeTauri(
      { "docHomes/get": () => ({ ...HOME, root: "docs/" }) },
      { pick_word_files: () => ({ pickId: "p", root: null, truncated: false, files: [word(0, "a.docx")] }) },
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn file…" }));
    const dir = screen.getByRole("textbox", { name: "Thư mục đích" });
    await user.clear(dir);
    await user.type(dir, "khac/");
    expect(await screen.findByText("Thư mục đích phải nằm trong docs/ của nhà tài liệu này.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Tải lên" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("token hết hạn: hiện câu của Rust, không đổi sang màn khác", async () => {
    fakeTauri(
      {},
      {
        pick_word_files: () => ({ pickId: "p", root: null, truncated: false, files: [word(0, "a.docx")] }),
        hub_upload_word: () => {
          throw { status: 401, message: "Token không còn dùng được (sai, hết hạn hoặc đã thu hồi)." };
        },
      },
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn file…" }));
    await user.click(await screen.findByRole("button", { name: "Tải lên" }));
    expect(await screen.findByText(/Token không còn dùng được/)).toBeTruthy();
    // Gửi lại được sau lỗi.
    expect((screen.getByRole("button", { name: "Tải lên" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("lỗi nghiệp vụ của hub lấy câu có cách sửa từ hợp đồng", async () => {
    fakeTauri(
      {},
      {
        pick_word_files: () => ({ pickId: "p", root: null, truncated: false, files: [word(0, "a.docx")] }),
        hub_upload_word: () => {
          throw { status: 400, code: "WORD_IMPORT_PASSWORD", message: "x" };
        },
      },
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Chọn file…" }));
    await user.click(await screen.findByRole("button", { name: "Tải lên" }));
    expect(await screen.findByText("File có mật khẩu. Mở khoá trong Word, lưu lại rồi tải lên.")).toBeTruthy();
  });
});

describe("Nhập Word: lượt nhập", () => {
  async function openImport(rpc: Rpc, extra: Handlers = {}) {
    const tauri = fakeTauri(
      {
        "wordImports/list": () => ({ items: [importOf()], nextCursor: null }),
        ...rpc,
      },
      extra,
    );
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Mở" }));
    return { ...tauri, user };
  }

  it("quyền đề xuất: nút ghi 'Gửi duyệt', bấm gọi commit với các file sẵn sàng", async () => {
    const committed: unknown[] = [];
    const { user } = await openImport({
      "wordImports/get": () => ({
        import: importOf(),
        files: [importFile(), importFile({ id: "f2", fileName: "IPD.docx", state: "failed" })],
        access: "propose",
      }),
      "wordImports/commit": (input) => {
        committed.push(input);
        return {};
      },
    });
    await user.click(await screen.findByRole("button", { name: "Gửi duyệt 1 tài liệu" }));
    await waitFor(() => expect(committed).toEqual([{ importId: "imp-1", fileIds: ["f1"] }]));
    expect(await screen.findByText(/Đã gửi duyệt 1 tài liệu/)).toBeTruthy();
  });

  it("bảng hiện trạng thái và số cảnh báo; lượt cập nhật báo xử lý trên web", async () => {
    await openImport({
      "wordImports/get": () => ({
        import: importOf("ready", "update"),
        files: [
          importFile({
            state: "blocked_secret",
            warnings: [{ code: "IMAGES_DROPPED", count: 2 }],
          }),
        ],
        access: "manage",
      }),
    });
    const table = await screen.findByRole("table", { name: "Các file trong lượt nhập" });
    expect(within(table).getByText("Có bí mật")).toBeTruthy();
    expect(screen.getByText(/app chỉ tạo tài liệu mới/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Tạo / })).toBeNull();
  });

  it("xem trước có ảnh: tải qua hub_fetch_bytes thành data: URL, chỉ ảnh được Markdown nhắc tới", async () => {
    const fetched: string[] = [];
    const { user } = await openImport(
      {
        "wordImports/get": () => ({ import: importOf(), files: [importFile()], access: "manage" }),
        "wordImports/file": () => ({
          ...importFile(),
          markdown: "# OPD\n\nSơ đồ: ![sơ đồ](media/abc123def456.png)\n\n| a | b |\n|---|---|\n| x<br>y | z |",
          images: [
            {
              name: "abc123def456.png",
              mediaType: "image/png",
              bytes: 4,
              url: "/api/v1/docs/word-imports/media/abc123def456.png",
            },
            { name: "thua.png", mediaType: "image/png", bytes: 4, url: "/api/v1/docs/word-imports/media/thua.png" },
          ],
          current: null,
        }),
      },
      {
        hub_fetch_bytes: (args) => {
          fetched.push(String(args?.path));
          return { status: 200, contentType: "image/png", base64: "iVBORw0KGgo=" };
        },
      },
    );
    await user.click(await screen.findByRole("button", { name: "SRS/OPD.docx" }));
    const img = await screen.findByRole("img", { name: "Ảnh abc123def456.png" });
    expect(img.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(fetched).toEqual(["/api/v1/docs/word-imports/media/abc123def456.png"]);
    expect(screen.queryByRole("img", { name: "Ảnh thua.png" })).toBeNull();
    // `<br>` trong ô bảng đổi thành ký hiệu xuống dòng.
    expect(await screen.findByText("x ⏎ y")).toBeTruthy();
  });

  it("file có bí mật: người quản lý được nhập tiếp, gọi commit với acknowledgeSecrets", async () => {
    const committed: unknown[] = [];
    const { user } = await openImport({
      "wordImports/get": () => ({
        import: importOf(),
        files: [importFile({ state: "blocked_secret", findings: [{ kind: "aws_access_key", line: 12 }] })],
        access: "manage",
      }),
      "wordImports/file": () => ({ ...importFile(), markdown: "# OPD", images: [], current: null }),
      "wordImports/commit": (input) => {
        committed.push(input);
        return {};
      },
    });
    await user.click(await screen.findByRole("button", { name: "SRS/OPD.docx" }));
    await user.click(await screen.findByRole("button", { name: "Không phải bí mật, vẫn nhập" }));
    await waitFor(() => expect(committed).toEqual([{ importId: "imp-1", fileIds: ["f1"], acknowledgeSecrets: true }]));
  });

  it("hub trả lỗi: hiện câu lỗi và cho thử lại", async () => {
    await openImport({
      "wordImports/get": () => {
        throw new Error("hub lỗi");
      },
    });
    expect(await screen.findByRole("button", { name: "Thử lại" })).toBeTruthy();
  });
});
