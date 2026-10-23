import { WORD_IMPORT_ERRORS } from "@xdev-hive/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dropLockFiles,
  formatBytes,
  LIMITS,
  normalizeTargetDir,
  onUploadProgress,
  type PickedWordFile,
  referencedImages,
  selectionIssues,
  stillWorking,
  targetDirIssue,
  uploadErrorText,
} from "@/lib/word-import.ts";

const file = (name: string, size = 1000, relativeDir = ""): PickedWordFile => ({
  index: 0,
  name,
  relativeDir,
  relativePath: relativeDir ? `${relativeDir}/${name}` : name,
  size,
  lastModified: 0,
});

afterEach(() => {
  delete window.__TAURI__;
});

describe("chọn file", () => {
  it("bỏ file khoá ~$ của Word và đếm số bỏ", () => {
    const { files, dropped } = dropLockFiles([file("a.docx"), file("~$a.docx")]);
    expect(files.map((f) => f.name)).toEqual(["a.docx"]);
    expect(dropped).toBe(1);
  });

  it("chặn quá số file, tổng dung lượng và file quá lớn", () => {
    const many = Array.from({ length: LIMITS.batchFiles + 1 }, (_, i) => file(`f${i}.docx`));
    expect(selectionIssues(many)[0]).toContain(`Quá ${LIMITS.batchFiles} file`);
    expect(selectionIssues([file("big.docx", LIMITS.fileBytes + 1)])[0]).toContain("big.docx");
    const heavy = Array.from({ length: 11 }, (_, i) => file(`h${i}.docx`, LIMITS.fileBytes));
    expect(selectionIssues(heavy).some((line) => line.startsWith("Tổng dung lượng"))).toBe(true);
    expect(selectionIssues([file("ok.docx")])).toEqual([]);
  });

  it("chặn thư mục con có ký tự hub không nhận", () => {
    expect(selectionIssues([file("a.docx", 10, "SRS/a:b")])[0]).toContain('Thư mục "SRS/a:b"');
  });

  it("định dạng dung lượng", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
  });
});

describe("thư mục đích", () => {
  it("chuẩn hoá về dạng có / cuối, rỗng là gốc repo", () => {
    expect(normalizeTargetDir(" ./docs\\srs ")).toBe("docs/srs/");
    expect(normalizeTargetDir("")).toBe("");
  });

  it("phải nằm trong gốc nhà và hợp lệ", () => {
    expect(targetDirIssue("docs/srs/", "docs")).toBeNull();
    expect(targetDirIssue("khac/", "docs")).toContain("docs/");
    expect(targetDirIssue("docs/../x/", "")).not.toBeNull();
  });
});

describe("lỗi tải lên", () => {
  it("mã nghiệp vụ lấy câu của hợp đồng", () => {
    expect(uploadErrorText({ status: 400, code: "WORD_IMPORT_PASSWORD", message: "x" })).toBe(
      WORD_IMPORT_ERRORS.WORD_IMPORT_PASSWORD.message,
    );
  });

  it("lỗi Rust giữ câu tiếng Việt có sẵn, 413 có cách sửa", () => {
    expect(uploadErrorText({ status: 401, message: "Token không còn dùng được (sai, hết hạn hoặc đã thu hồi)." })).toBe(
      "Token không còn dùng được (sai, hết hạn hoặc đã thu hồi).",
    );
    expect(uploadErrorText({ status: 413, message: "" })).toContain("Chia thành nhiều lượt");
    expect(uploadErrorText("lỗi chuỗi")).toBe("lỗi chuỗi");
  });
});

describe("xem trước", () => {
  it("chỉ lấy ảnh được Markdown nhắc tới, đúng thứ tự, không lặp", () => {
    const images = [{ name: "a.png" }, { name: "b.png" }, { name: "c.png" }];
    const md = "![](media/b.png)\n\ntext ![x](media/a.png) ![](media/b.png)";
    expect(referencedImages(md, images).map((i) => i.name)).toEqual(["b.png", "a.png"]);
  });

  it("còn việc hub đang làm thì hỏi lại", () => {
    expect(stillWorking(undefined)).toBe(false);
  });
});

describe("tiến độ", () => {
  it("ngoài Tauri không có sự kiện thì không lỗi", async () => {
    const stop = await onUploadProgress(() => {});
    expect(typeof stop).toBe("function");
  });

  it("chuyển payload sự kiện cho người nghe", async () => {
    const seen = vi.fn();
    let emit: ((e: { payload: unknown }) => void) | undefined;
    window.__TAURI__ = {
      core: { invoke: vi.fn() },
      event: {
        listen: async (_name: string, handler: (e: { payload: never }) => void) => {
          emit = handler as (e: { payload: unknown }) => void;
          return () => {};
        },
      },
    };
    await onUploadProgress(seen);
    emit?.({ payload: { uploadId: "u", index: 0, name: "a.docx", sent: 5, size: 10 } });
    expect(seen).toHaveBeenCalledWith({ uploadId: "u", index: 0, name: "a.docx", sent: 5, size: 10 });
  });
});
