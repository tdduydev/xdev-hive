import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MultipartLimits, multipartBoundary, parseMultipart } from "./multipart.ts";

const limits: MultipartLimits = { fileBytes: 1000, files: 3, totalBytes: 1500, bodyBytes: 4000 };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-multipart-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Cắt thân request thành chunk cỡ `size` để ranh giới rơi vào giữa hai chunk. */
function stream(body: Buffer, size = body.length): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= body.length) return controller.close();
      controller.enqueue(new Uint8Array(body.subarray(at, at + size)));
      at += size;
    },
  });
}

async function encode(form: FormData) {
  const request = new Request("http://hub/x", { method: "POST", body: form });
  const boundary = multipartBoundary(request.headers.get("content-type"));
  if (!boundary) throw new Error("Thiếu boundary.");
  return { body: Buffer.from(await request.arrayBuffer()), boundary };
}

describe("multipart theo luồng", () => {
  it("tách trường và file, ghi file ra đĩa, đúng với mọi cỡ chunk", async () => {
    const form = new FormData();
    form.append("homeId", "abc");
    form.append("files[]", new File([Buffer.alloc(700, 7)], 'Báo cáo "OPD".docx'));
    form.append("relativePaths", "Thư mục/con");
    form.append("files", new File(["\r\n--nội dung giống ranh giới"], "b.odt"));
    const { body, boundary } = await encode(form);
    for (const size of [1, 7, 64, body.length]) {
      const out = await mkdtemp(join(dir, "run-"));
      const parsed = await parseMultipart(stream(body, size), boundary, limits, out);
      expect(Object.fromEntries(parsed.fields)).toEqual({ homeId: ["abc"], relativePaths: ["Thư mục/con"] });
      expect(parsed.files.map(({ field, name, size }) => ({ field, name, size }))).toEqual([
        { field: "files", name: 'Báo cáo "OPD".docx', size: 700 },
        { field: "files", name: "b.odt", size: Buffer.byteLength("\r\n--nội dung giống ranh giới") },
      ]);
      expect(await readFile(parsed.files[0]?.path ?? "")).toEqual(Buffer.alloc(700, 7));
      expect((await readFile(parsed.files[1]?.path ?? "")).toString()).toBe("\r\n--nội dung giống ranh giới");
    }
  });

  it("bỏ thư mục trong tên file, đọc filename*, bỏ ô file trống", async () => {
    const boundary = "xyz";
    const body = Buffer.from(
      [
        "--xyz",
        'Content-Disposition: form-data; name="files"; filename="C:\\Users\\a\\x.docx"',
        "",
        "1",
        "--xyz",
        "Content-Disposition: form-data; name=files; filename*=UTF-8''%C4%90%E1%BB%81%20xu%E1%BA%A5t.docx",
        "",
        "2",
        "--xyz",
        // Ô chọn file để trống.
        'Content-Disposition: form-data; name="files"; filename=""',
        "",
        "",
        "--xyz--",
        "",
      ].join("\r\n"),
    );
    const parsed = await parseMultipart(stream(body), boundary, limits, dir);
    expect(parsed.files.map((file) => file.name)).toEqual(["x.docx", "Đề xuất.docx"]);
  });

  it("dừng ngay khi vượt giới hạn file, số file, tổng dung lượng và thân request", async () => {
    const one = new FormData();
    one.append("files", new File([Buffer.alloc(1001)], "a.docx"));
    const big = await encode(one);
    await expect(parseMultipart(stream(big.body, 100), big.boundary, limits, dir)).rejects.toMatchObject({
      reason: "file_too_large",
    });

    const many = new FormData();
    for (let i = 0; i < 4; i++) many.append("files", new File(["x"], `${i}.docx`));
    const count = await encode(many);
    await expect(
      parseMultipart(stream(count.body), count.boundary, limits, await mkdtemp(join(dir, "c-"))),
    ).rejects.toMatchObject({ reason: "batch_too_large" });

    const total = new FormData();
    for (let i = 0; i < 2; i++) total.append("files", new File([Buffer.alloc(800)], `${i}.docx`));
    const sum = await encode(total);
    await expect(
      parseMultipart(stream(sum.body), sum.boundary, limits, await mkdtemp(join(dir, "t-"))),
    ).rejects.toMatchObject({
      reason: "batch_too_large",
    });

    const fields = new FormData();
    fields.append("note", "x".repeat(4100));
    const long = await encode(fields);
    await expect(parseMultipart(stream(long.body), long.boundary, limits, dir)).rejects.toMatchObject({
      reason: "batch_too_large",
    });
  });

  it("thân request hỏng hoặc bị cắt cụt", async () => {
    const form = new FormData();
    form.append("files", new File(["abc"], "a.docx"));
    const { body, boundary } = await encode(form);
    const cut = body.subarray(0, body.length - 10);
    await expect(parseMultipart(stream(cut), boundary, limits, dir)).rejects.toMatchObject({ reason: "malformed" });
    const noName = Buffer.from("--b\r\nContent-Disposition: form-data\r\n\r\nx\r\n--b--\r\n");
    await expect(parseMultipart(stream(noName), "b", limits, await mkdtemp(join(dir, "n-")))).rejects.toMatchObject({
      reason: "malformed",
    });
    const header = Buffer.from(`--b\r\nX: ${"a".repeat(20_000)}`);
    await expect(parseMultipart(stream(header), "b", { ...limits, bodyBytes: 100_000 }, dir)).rejects.toMatchObject({
      reason: "malformed",
    });
  });

  it("đọc boundary trong Content-Type", () => {
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe("a b");
    expect(multipartBoundary("multipart/form-data;boundary=----x")).toBe("----x");
    expect(multipartBoundary("application/json")).toBeNull();
    expect(multipartBoundary(null)).toBeNull();
  });
});
