// @vitest-environment jsdom
import { WORD_IMPORT_DEFAULT_LIMITS } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUploadForm,
  dirSuggestions,
  filterWordFiles,
  formatBytes,
  mergePicked,
  normalizeTargetDir,
  type PickedFile,
  pickedFromDataTransfer,
  pickedFromFiles,
  selectionIssues,
  targetDirIssue,
  uploadErrorMessage,
  uploadWordImport,
} from "@/components/word-import-dialog.tsx";

const file = (name: string, size = 10, lastModified = 1_700_000_000_000, path?: string) => {
  const value = new File([new Uint8Array(Math.min(size, 16))], name, { lastModified });
  Object.defineProperty(value, "size", { value: size });
  if (path) Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
};
const picked = (name: string, dir = "", size = 10): PickedFile => ({ file: file(name, size), dir });

afterEach(() => vi.unstubAllGlobals());

describe("chọn file", () => {
  it("file lẻ nằm thẳng trong thư mục đích, file trong thư mục chọn giữ thư mục con", () => {
    const result = pickedFromFiles([
      file("a.docx"),
      file("b.docx", 10, 1, "SRS/OPD/b.docx"),
      file("c.docx", 10, 1, "SRS/c.docx"),
    ]);
    expect(result.map((p) => [p.file.name, p.dir])).toEqual([
      ["a.docx", ""],
      ["b.docx", "SRS/OPD"],
      ["c.docx", "SRS"],
    ]);
  });

  it("chỉ lấy .docx, .odt, .doc (không phân biệt hoa thường) và đếm file bị bỏ", () => {
    const { accepted, skipped } = filterWordFiles(
      [picked("a.DOCX"), picked("b.odt"), picked("c.doc"), picked("d.pdf"), picked("e.txt"), picked("~$a.docx")],
      { doc: true },
    );
    expect(accepted.map((p) => p.file.name)).toEqual(["a.DOCX", "b.odt", "c.doc"]);
    expect(skipped).toEqual({ notWord: 2, doc: 0, temp: 1 });
  });

  it(".doc bị bỏ khi hub chưa có LibreOffice", () => {
    const { accepted, skipped } = filterWordFiles([picked("a.docx"), picked("b.doc")], { doc: false });
    expect(accepted.map((p) => p.file.name)).toEqual(["a.docx"]);
    expect(skipped.doc).toBe(1);
  });

  it("chọn thêm lần nữa thì gộp, cùng thư mục, tên, cỡ và ngày sửa thì không lặp", () => {
    const first = pickedFromFiles([file("a.docx", 10, 5)]);
    const merged = mergePicked(first, [...pickedFromFiles([file("a.docx", 10, 5)]), picked("a.docx", "sub")]);
    expect(merged.map((p) => `${p.dir}/${p.file.name}`)).toEqual(["/a.docx", "sub/a.docx"]);
  });
});

describe("giới hạn một lượt", () => {
  it("trong giới hạn thì không có lỗi", () => {
    expect(selectionIssues([picked("a.docx"), picked("b.docx")])).toEqual([]);
  });

  it("quá 100 file", () => {
    const many = Array.from({ length: 101 }, (_, i) => picked(`f${i}.docx`));
    expect(selectionIssues(many).join(" ")).toContain("Quá 100 file");
  });

  it("một file quá 50 MB", () => {
    const issues = selectionIssues([picked("to.docx", "", WORD_IMPORT_DEFAULT_LIMITS.fileBytes + 1)]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("to.docx");
    expect(issues[0]).toContain("50 MB");
  });

  it("tổng quá 500 MB dù từng file hợp lệ", () => {
    const each = WORD_IMPORT_DEFAULT_LIMITS.fileBytes;
    const files = Array.from({ length: 11 }, (_, i) => picked(`f${i}.docx`, "", each));
    expect(selectionIssues(files).join(" ")).toContain("500 MB");
  });

  it("đúng giới hạn thì qua", () => {
    const files = Array.from({ length: 100 }, (_, i) => picked(`f${i}.docx`, "", 5 * 1024 * 1024));
    expect(selectionIssues(files)).toEqual([]);
  });

  it("thư mục con có ký tự hub không nhận thì báo trước khi tải lên", () => {
    expect(selectionIssues([picked("a.docx", "A:B")]).join(" ")).toContain("A:B");
  });

  it("định dạng dung lượng", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1,5 GB");
  });
});

describe("thư mục đích", () => {
  it("chuẩn hoá: bỏ khoảng trắng, gạch chéo đầu, đổi \\ và thêm / cuối", () => {
    expect(normalizeTargetDir("  docs/srs ")).toBe("docs/srs/");
    expect(normalizeTargetDir("./docs//srs/")).toBe("docs/srs/");
    expect(normalizeTargetDir("/docs/srs")).toBe("docs/srs/");
    expect(normalizeTargetDir("docs\\srs")).toBe("docs/srs/");
    expect(normalizeTargetDir("")).toBe("");
    expect(normalizeTargetDir(" / ")).toBe("");
  });

  it("phải nằm trong gốc nhà và đúng dạng đường dẫn repo", () => {
    expect(targetDirIssue("docs/srs/", "docs/")).toBeNull();
    expect(targetDirIssue("docs/", "docs/")).toBeNull();
    expect(targetDirIssue("", "")).toBeNull();
    expect(targetDirIssue("anything/", "")).toBeNull();
    expect(targetDirIssue("other/", "docs/")).toContain("docs/");
    expect(targetDirIssue("", "docs")).toContain("docs/");
    expect(targetDirIssue("docs/../x/", "docs/")).toContain("không hợp lệ");
    expect(targetDirIssue("docs/a:b/", "docs/")).toContain("không hợp lệ");
  });

  it("gợi ý từ cây: thư mục cha của tài liệu trong nhà, trong gốc nhà, không lặp", () => {
    const items = [
      { homeId: "h", path: "docs/srs/OPD/a.md", kind: "doc" as const },
      { homeId: "h", path: "docs/srs/b.md", kind: "doc" as const },
      { homeId: "h", path: "docs/assets/a.png", kind: "asset" as const },
      { homeId: "h", path: "README.md", kind: "doc" as const },
      { homeId: "other", path: "docs/zzz/c.md", kind: "doc" as const },
      { homeId: "h", path: null, kind: "doc" as const },
    ];
    expect(dirSuggestions(items, "h", "docs/")).toEqual(["docs/", "docs/srs/", "docs/srs/OPD/"]);
    expect(dirSuggestions(items, "h", "")).toEqual(["docs/", "docs/srs/", "docs/srs/OPD/"]);
  });
});

describe("form tải lên", () => {
  it("tạo mới: homeId, targetDir, confidential và các mảng song song theo file", () => {
    const form = buildUploadForm({
      homeId: "home-1",
      mode: "create",
      targetDir: "docs/srs/",
      confidential: true,
      picked: [
        { file: file("a.docx", 10, 111), dir: "" },
        { file: file("b.docx", 10, 222), dir: "SRS/OPD" },
      ],
    });
    expect(form.get("homeId")).toBe("home-1");
    expect(form.get("mode")).toBe("create");
    expect(form.get("targetDir")).toBe("docs/srs/");
    expect(form.get("confidential")).toBe("true");
    expect(form.get("docKey")).toBeNull();
    expect((form.getAll("files") as File[]).map((f) => f.name)).toEqual(["a.docx", "b.docx"]);
    expect(form.getAll("relativePaths")).toEqual(["", "SRS/OPD"]);
    expect(form.getAll("lastModified")).toEqual(["111", "222"]);
  });

  it("cập nhật hoặc gắn: gửi docKey, không gửi targetDir và confidential", () => {
    const form = buildUploadForm({
      homeId: "home-1",
      mode: "link",
      docKey: "org/huong-dan",
      targetDir: "docs/",
      confidential: false,
      picked: [picked("a.docx")],
    });
    expect(form.get("mode")).toBe("link");
    expect(form.get("docKey")).toBe("org/huong-dan");
    expect(form.get("targetDir")).toBeNull();
    expect(form.get("confidential")).toBeNull();
  });

  it("confidential false vẫn được gửi để ghi đè mặc định của nhà", () => {
    const form = buildUploadForm({
      homeId: "h",
      mode: "create",
      targetDir: "",
      confidential: false,
      picked: [picked("a.docx")],
    });
    expect(form.get("confidential")).toBe("false");
    expect(form.get("targetDir")).toBe("");
  });
});

describe("lỗi tải lên", () => {
  it("mã lỗi của hợp đồng thì dùng câu có cách sửa", () => {
    expect(
      uploadErrorMessage(400, { defined: true, code: "BAD_REQUEST", data: { code: "WORD_IMPORT_PASSWORD" } }),
    ).toContain("File có mật khẩu");
    expect(uploadErrorMessage(400, { json: { data: { code: "WORD_IMPORT_DISABLED" } } })).toContain("pandoc");
  });

  it("lỗi đã khai báo thì dùng câu của hub", () => {
    expect(
      uploadErrorMessage(403, { defined: true, code: "FORBIDDEN", message: "Bạn không có quyền ở thư mục này." }),
    ).toBe("Bạn không có quyền ở thư mục này.");
  });

  it("lỗi khác đổi theo trạng thái HTTP, không lộ câu tiếng Anh", () => {
    expect(uploadErrorMessage(401, { message: "Unauthorized" })).toContain("hết hạn");
    expect(uploadErrorMessage(403, null)).toContain("quyền");
    expect(uploadErrorMessage(413, null)).toContain("quá lớn");
    expect(uploadErrorMessage(502, "<html>")).toContain("Hub đang gặp lỗi");
    expect(uploadErrorMessage(0, null)).toContain("kết nối");
    expect(uploadErrorMessage(418, null)).toContain("418");
  });
});

class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  headers: Record<string, string> = {};
  opened: [string, string] | null = null;
  body: unknown;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.opened = [method, url];
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  finish(status: number, body: unknown) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.onload?.();
  }
}

describe("tải lên bằng XMLHttpRequest", () => {
  const ID = "20202020-0000-4000-8000-0000000000a1";
  it("gửi POST kèm header tổ chức, báo tiến độ, trả importId", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const form = new FormData();
    const progress = vi.fn();
    const promise = uploadWordImport({ orgId: "org-1", form, onProgress: progress });
    const xhr = FakeXhr.last;
    expect(xhr.opened).toEqual(["POST", "/api/v1/docs/word-imports"]);
    expect(xhr.headers["x-hive-org"]).toBe("org-1");
    expect(xhr.body).toBe(form);
    xhr.upload.onprogress?.({ loaded: 25, total: 100, lengthComputable: true });
    xhr.upload.onprogress?.({ loaded: 0, total: 0, lengthComputable: false });
    expect(progress.mock.calls).toEqual([[0.25]]);
    xhr.finish(200, { importId: ID });
    await expect(promise).resolves.toEqual({ importId: ID });
  });

  it("lỗi HTTP thì ném Error với câu tiếng Việt", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const promise = uploadWordImport({ orgId: "o", form: new FormData(), onProgress: () => {} });
    FakeXhr.last.finish(400, { defined: true, code: "BAD_REQUEST", data: { code: "WORD_IMPORT_NOT_WORD" } });
    await expect(promise).rejects.toThrow("không phải Word");
  });

  it("phản hồi 200 mà không có importId thì báo lỗi", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const promise = uploadWordImport({ orgId: "o", form: new FormData(), onProgress: () => {} });
    FakeXhr.last.finish(200, { ok: true });
    await expect(promise).rejects.toThrow("Hub trả về");
  });

  it("mất mạng và huỷ", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const net = uploadWordImport({ orgId: "o", form: new FormData(), onProgress: () => {} });
    FakeXhr.last.onerror?.();
    await expect(net).rejects.toThrow("kết nối");

    const controller = new AbortController();
    const cancelled = uploadWordImport({
      orgId: "o",
      form: new FormData(),
      onProgress: () => {},
      signal: controller.signal,
    });
    controller.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("kéo thả", () => {
  type FakeEntry = {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    fullPath: string;
    file?: (cb: (f: File) => void) => void;
    createReader?: () => { readEntries: (cb: (e: FakeEntry[]) => void) => void };
  };
  const fileEntry = (path: string): FakeEntry => ({
    isFile: true,
    isDirectory: false,
    name: path.split("/").pop() ?? path,
    fullPath: path,
    file: (cb) => cb(file(path.split("/").pop() ?? path)),
  });
  const dirEntry = (path: string, children: FakeEntry[]): FakeEntry => ({
    isFile: false,
    isDirectory: true,
    name: path.split("/").pop() ?? path,
    fullPath: path,
    createReader: () => {
      let done = false;
      return {
        readEntries: (cb) => {
          cb(done ? [] : children);
          done = true;
        },
      };
    },
  });
  const transfer = (entries: FakeEntry[], files: File[] = []) =>
    ({
      files,
      items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null })),
    }) as unknown as DataTransfer;

  it("thả thư mục thì đi hết thư mục con và giữ đường dẫn tương đối", async () => {
    const result = await pickedFromDataTransfer(
      transfer([
        fileEntry("/a.docx"),
        dirEntry("/SRS", [fileEntry("/SRS/b.docx"), dirEntry("/SRS/OPD", [fileEntry("/SRS/OPD/c.odt")])]),
      ]),
    );
    expect(result.map((p) => [p.file.name, p.dir])).toEqual([
      ["a.docx", ""],
      ["b.docx", "SRS"],
      ["c.odt", "SRS/OPD"],
    ]);
  });

  it("trình duyệt không có webkitGetAsEntry thì dùng danh sách file", async () => {
    const dt = { files: [file("a.docx")], items: [{ kind: "file", getAsFile: () => null }] } as unknown as DataTransfer;
    const result = await pickedFromDataTransfer(dt);
    expect(result.map((p) => p.file.name)).toEqual(["a.docx"]);
  });
});
