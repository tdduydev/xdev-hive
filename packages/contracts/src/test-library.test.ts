import { describe, expect, it } from "vitest";
import { areaTemplate, normalizeTestCase, parseTestArea } from "./test-library.ts";

const VALID = `# DANGNHAP Đăng nhập

Khu này phủ màn đăng nhập. Chữ ở đây được giữ nguyên, bộ đọc bỏ qua.

### TC-DANGNHAP-001 Đăng nhập bằng email và mật khẩu đúng

- Ưu tiên: P1
- Loại: tự động
- Yêu cầu: FR-001, 036/AC-012.2
- Nhãn: smoke, dang-nhap
- Script: tests/auth/login.spec.ts
- Dữ liệu test: TK-NGUOIDUNG-01
- Điều kiện trước: Tài khoản đã kích hoạt.
- Ghi chú: Chạy được trên mọi trình duyệt.

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang đăng nhập | Thấy ô email và ô mật khẩu |
| 2 | Nhập email, mật khẩu đúng, bấm "Đăng nhập" | Vào trang chủ, thấy tên người dùng |

### TC-DANGNHAP-002 Báo lỗi khi sai mật khẩu

- Ưu tiên: P2
- Loại: tay
- Yêu cầu: FR-002, AUTH01

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Nhập mật khẩu sai, bấm "Đăng nhập" | Thấy "Email hoặc mật khẩu không đúng" |
`;

/** Một file một TC, chỉ thay phần trường; bảng bước giữ đúng. */
const oneCase = (fields: string, heading = "### TC-DN-001 Một TC") => `# DN Đăng nhập

${heading}

${fields}

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang | Thấy trang |
`;
const BASE = "- Ưu tiên: P1\n- Loại: tay\n- Yêu cầu: FR-001";
const messages = (md: string) => parseTestArea(md).errors.map((e) => e.message);

describe("parseTestArea", () => {
  it("đọc đủ trường, bước và dòng của file đúng", () => {
    const got = parseTestArea(VALID);
    expect(got.errors).toEqual([]);
    expect(got.area).toEqual({ code: "DANGNHAP", name: "Đăng nhập", line: 1 });
    expect(got.cases).toHaveLength(2);
    expect(got.cases[0]).toEqual({
      code: "TC-DANGNHAP-001",
      line: 5,
      name: "Đăng nhập bằng email và mật khẩu đúng",
      priority: "P1",
      kind: "automated",
      requirements: ["036/AC-012.2", "FR-001"],
      labels: ["dang-nhap", "smoke"],
      script: "tests/auth/login.spec.ts",
      testData: "TK-NGUOIDUNG-01",
      preconditions: "Tài khoản đã kích hoạt.",
      note: "Chạy được trên mọi trình duyệt.",
      steps: [
        { n: 1, action: "Mở trang đăng nhập", expected: "Thấy ô email và ô mật khẩu" },
        {
          n: 2,
          action: 'Nhập email, mật khẩu đúng, bấm "Đăng nhập"',
          expected: "Vào trang chủ, thấy tên người dùng",
        },
      ],
    });
    expect(got.cases[1]).toMatchObject({
      code: "TC-DANGNHAP-002",
      kind: "manual",
      requirements: ["AUTH01", "FR-002"],
      labels: [],
      script: null,
      note: null,
    });
  });

  it("nhận CRLF, chữ Việt dạng tổ hợp và tên trường khác hoa thường", () => {
    const md = oneCase("- ƯU TIÊN: P3\n-  loại :  dự kiến tự động\n- Yêu cầu: FR-001".normalize("NFD")).replace(
      /\n/g,
      "\r\n",
    );
    const got = parseTestArea(md);
    expect(got.errors).toEqual([]);
    expect(got.cases[0]).toMatchObject({ priority: "P3", kind: "planned" });
  });

  it("bỏ qua khối code, tiêu đề thường và danh sách sau bảng bước", () => {
    const md = `${oneCase(BASE)}
- Lưu ý: danh sách sau bảng là chữ thường

\`\`\`markdown
### TC-DN-999 Ví dụ trong khối code
\`\`\`

### Ghi chú chung

- Không phải trường: bỏ qua
`;
    const got = parseTestArea(md);
    expect(got.errors).toEqual([]);
    expect(got.cases.map((c) => c.code)).toEqual(["TC-DN-001"]);
  });

  it("thiếu dòng khu hoặc mã khu sai mẫu", () => {
    expect(messages("### TC-DN-001 x")).toContain(
      "Dòng 1: file khu phải bắt đầu bằng `# <MÃ KHU> <tên khu>`, ví dụ `# DANGNHAP Đăng nhập`.",
    );
    const bad = parseTestArea("\n# dangnhap Đăng nhập\n");
    expect(bad.area).toBeNull();
    expect(bad.errors).toEqual([
      { line: 2, message: "Dòng 2: mã khu `dangnhap` phải gồm 2–16 chữ hoa hoặc số, bắt đầu bằng chữ." },
    ]);
  });

  it("thiếu trường bắt buộc và thiếu bước", () => {
    const md = `# DN Đăng nhập

### TC-DN-001 Thiếu hết

- Nhãn: a
`;
    expect(parseTestArea(md)).toMatchObject({
      cases: [],
      errors: [
        { line: 3, message: "Dòng 3: TC `TC-DN-001` thiếu trường `Ưu tiên`." },
        { line: 3, message: "Dòng 3: TC `TC-DN-001` thiếu trường `Loại`." },
        { line: 3, message: "Dòng 3: TC `TC-DN-001` thiếu trường `Yêu cầu`." },
        { line: 3, message: "Dòng 3: TC `TC-DN-001` cần ít nhất một bước có thao tác và kết quả mong đợi." },
      ],
    });
    const emptyTable = `# DN Đăng nhập

### TC-DN-001 Không có bước

${BASE}

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
`;
    expect(messages(emptyTable)).toEqual([
      "Dòng 9: TC `TC-DN-001` cần ít nhất một bước có thao tác và kết quả mong đợi.",
    ]);
  });

  it("mã TC: dạng hạng mục, sai mẫu, khác khu, lặp", () => {
    const md = `# DN Đăng nhập

### TC-001 Mã hạng mục
### TC-DN-01 Thiếu số
### TC-KHAC-001 Khu khác
${oneCase(BASE).split("\n").slice(2).join("\n")}
${oneCase(BASE).split("\n").slice(2).join("\n")}`;
    expect(messages(md)).toEqual([
      "Dòng 3: mã `TC-001` là mã TC của hạng mục. Mã thư viện có dạng `TC-<KHU>-<SỐ>`, ví dụ `TC-DN-001`.",
      "Dòng 4: mã `TC-DN-01` phải có dạng `TC-<KHU>-<SỐ>`, `<SỐ>` gồm 3–5 chữ số.",
      "Dòng 5: mã `TC-KHAC-001` thuộc khu `KHAC`, file này là khu `DN`.",
      "Dòng 16: mã `TC-DN-001` đã có ở dòng 6.",
    ]);
  });

  it("giá trị không hợp lệ, trường lặp, trường lạ", () => {
    const md = oneCase("- Ưu tiên: P4\n- Loại: thủ công\n- Yêu cầu: FR-001\n- Yêu cầu: FR-002\n- Mức độ: cao");
    expect(messages(md)).toEqual([
      "Dòng 5: `Ưu tiên` không nhận `P4`. Giá trị hợp lệ: P1, P2, P3.",
      "Dòng 6: `Loại` không nhận `thủ công`. Giá trị hợp lệ: tự động, tay, dự kiến tự động.",
      "Dòng 8: trường `Yêu cầu` đã khai ở dòng 7.",
      "Dòng 9: không có trường `Mức độ`. Trường hợp lệ: Ưu tiên, Loại, Yêu cầu, Nhãn, Script, Dữ liệu test, Điều kiện trước, Ghi chú.",
    ]);
  });

  it("`automated` thiếu `script`, script ra ngoài repo", () => {
    expect(messages(oneCase("- Ưu tiên: P1\n- Loại: tự động\n- Yêu cầu: FR-001"))).toEqual([
      "Dòng 3: TC `TC-DN-001` loại tự động phải có `Script`.",
    ]);
    expect(messages(oneCase("- Ưu tiên: P1\n- Loại: tự động\n- Yêu cầu: FR-001\n- Script: ../x.spec.ts"))).toEqual([
      "Dòng 8: `Script` không nhận `../x.spec.ts`. Giá trị hợp lệ: đường dẫn tương đối trong repo test, không chứa `..`.",
    ]);
  });

  it("mã yêu cầu: nhận mã spec và mã SRS, báo sai dạng hoặc sai mẫu", () => {
    const ok = parseTestArea(
      oneCase("- Ưu tiên: P1\n- Loại: tay\n- Yêu cầu: FR-001, 036/AC-012.2, OPD02, OPD02P00108, USR01"),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.cases[0]?.requirements).toEqual(["036/AC-012.2", "FR-001", "OPD02", "OPD02P00108", "USR01"]);

    expect(messages(oneCase("- Ưu tiên: P1\n- Loại: tay\n- Yêu cầu: FR001, NFR"))).toEqual([
      "Dòng 7: mã yêu cầu `FR001` bắt đầu bằng `FR` nên phải có dạng mã spec, ví dụ `FR-001` hoặc `036/FR-001`.",
      "Dòng 7: mã yêu cầu `NFR` bắt đầu bằng `NFR` nên phải có dạng mã spec, ví dụ `NFR-001` hoặc `036/NFR-001`.",
    ]);
    const wrong =
      "không đúng mẫu. Mã spec có dạng `FR-001` hoặc `036/AC-012.2`. Mã SRS gồm 3–16 chữ hoa hoặc số, bắt đầu bằng chữ, ví dụ `OPD02`.";
    expect(messages(oneCase("- Ưu tiên: P1\n- Loại: tay\n- Yêu cầu: opd02, OPD-02"))).toEqual([
      `Dòng 7: mã yêu cầu \`opd02\` ${wrong}`,
      `Dòng 7: mã yêu cầu \`OPD-02\` ${wrong}`,
    ]);
  });

  it("nhãn có dấu cách, quá dài, quá nhiều", () => {
    const many = Array.from({ length: 21 }, (_, i) => `n${i}`).join(", ");
    expect(messages(oneCase(`${BASE}\n- Nhãn: dang nhap, ${"a".repeat(41)}`))).toEqual([
      "Dòng 8: `Nhãn` không nhận `dang nhap`. Giá trị hợp lệ: nhãn không có dấu cách, cách nhau bằng dấu phẩy.",
      "Dòng 8: `Nhãn` dài 41 ký tự, tối đa 40.",
    ]);
    expect(messages(oneCase(`${BASE}\n- Nhãn: ${many}`))).toEqual(["Dòng 8: có 21 nhãn, tối đa 20."]);
  });

  it("bước: số thứ tự, ô rỗng, ký tự `|` thoát", () => {
    const md = `# DN Đăng nhập

### TC-DN-001 Bước sai

${BASE}

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Gõ \`a \\| b\` | Thấy \`a \\| b\` |
| 3 | Bấm | |
`;
    expect(messages(md)).toEqual([
      "Dòng 12: `#` không nhận `3`. Giá trị hợp lệ: 2.",
      "Dòng 12: bước 2 thiếu thao tác hoặc kết quả mong đợi.",
    ]);
    const fixed = parseTestArea(md.replace("| 3 | Bấm | |", "| 2 | Bấm | Thấy |"));
    expect(fixed.errors).toEqual([]);
    expect(fixed.cases[0]?.steps[0]).toEqual({ n: 1, action: "Gõ `a | b`", expected: "Thấy `a | b`" });
  });

  it("quá 100 lỗi thì giữ 99 lỗi đầu và một dòng tóm tắt", () => {
    const body = Array.from({ length: 150 }, (_, i) => `### TC-${String(i + 1).padStart(3, "0")} Sai`).join("\n");
    const { errors } = parseTestArea(`# DN Đăng nhập\n${body}`);
    expect(errors).toHaveLength(100);
    expect(errors[98]?.line).toBe(100);
    expect(errors[99]).toEqual({ line: 101, message: "Còn 51 lỗi khác. Sửa các lỗi trên rồi lưu lại." });
  });

  it("TC lỗi không vào `cases`, TC đúng vẫn vào", () => {
    const md = `${oneCase(BASE)}
### TC-DN-002 Lỗi

- Ưu tiên: P9
`;
    const got = parseTestArea(md);
    expect(got.cases.map((c) => c.code)).toEqual(["TC-DN-001"]);
    expect(got.errors.length).toBeGreaterThan(0);
  });
});

describe("normalizeTestCase", () => {
  it("bỏ mã và dòng, sắp xếp yêu cầu và nhãn để di chuyển TC không đổi băm", () => {
    const [a] = parseTestArea(oneCase(`${BASE}, AUTH01\n- Nhãn: b, a`)).cases;
    const [b] = parseTestArea(
      `\n\n${oneCase("- Yêu cầu: AUTH01, FR-001\n- Nhãn: a, b\n- Loại: tay\n- Ưu tiên: P1")}`,
    ).cases;
    if (!a || !b) throw new Error("thiếu TC");
    expect(a.line).not.toBe(b.line);
    const { code: _c, line: _l, ...content } = a;
    expect(JSON.stringify(normalizeTestCase(a))).toBe(JSON.stringify(normalizeTestCase(b)));
    expect(normalizeTestCase(a)).toEqual(content);
    expect(Object.keys(normalizeTestCase(a))).not.toContain("line");
  });
});

describe("areaTemplate", () => {
  it("mẫu qua được bộ đọc không có lỗi (FR-008)", () => {
    const got = parseTestArea(areaTemplate("THANHTOAN", "Thanh toán"));
    expect(got.errors).toEqual([]);
    expect(got.area).toEqual({ code: "THANHTOAN", name: "Thanh toán", line: 1 });
    expect(got.cases.map((c) => c.code)).toEqual(["TC-THANHTOAN-001"]);
  });
});
