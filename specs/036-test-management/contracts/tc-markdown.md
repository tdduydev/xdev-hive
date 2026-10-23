# Contract: file khu test case (Markdown)

Bộ đọc: `packages/contracts/src/test-library.ts`, hàm thuần, web và hub dùng chung (research D2). Mỗi file `.md` trong
thư mục test case của docs home (mặc định `test-cases/`, FR-001) là một khu.

## Ví dụ

````markdown
# DANGNHAP Đăng nhập

Khu này phủ màn đăng nhập và đổi mật khẩu. Chữ ở đây được giữ nguyên, bộ đọc bỏ qua.

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
````

## Cấu trúc

| Khối | Mẫu | Luật |
|---|---|---|
| Tiêu đề khu | `# <KHU> <tên khu>` | dòng `#` đầu tiên của file; `<KHU>` khớp `^[A-Z][A-Z0-9]{1,15}$`; tên 1–120 ký tự |
| Tiêu đề TC | `### TC-<KHU>-<SỐ> <tên>` | `<KHU>` trùng mã khu của file; `<SỐ>` khớp `^[0-9]{3,5}$`; tên 1–300 ký tự |
| Trường | `- <Tên trường>: <giá trị>` | ngay sau tiêu đề TC, mỗi trường một dòng, không lặp |
| Bảng bước | `\| # \| Thao tác \| Kết quả mong đợi \|` | sau danh sách trường; ít nhất 1 dòng |
| Chữ khác | đoạn văn, `##`, danh sách khác | bộ đọc bỏ qua, tài liệu giữ nguyên |

- TC kéo dài tới tiêu đề `###` kế tiếp hoặc `#`, `##` kế tiếp.
- Khối code (```` ``` ````) bị bỏ qua cả khối, để ví dụ trong ghi chú không thành TC.
- Tên trường so không phân biệt hoa thường, bỏ khoảng trắng hai đầu.

## Trường

| Trường | Bắt buộc | Giá trị | Cột `qa_cases` |
|---|---|---|---|
| Ưu tiên | có | `P1`, `P2`, `P3` | `priority` |
| Loại | có | `tự động`, `tay`, `dự kiến tự động` | `kind`: `automated`, `manual`, `planned` |
| Yêu cầu | có | mã cách nhau bằng dấu phẩy, mỗi mã là mã spec hoặc mã SRS (research D10) | `requirements` |
| Nhãn | không | cách nhau bằng dấu phẩy, không dấu cách, mỗi nhãn ≤ 40 ký tự, tối đa 20 nhãn | `labels` |
| Script | khi `Loại: tự động` | đường dẫn tương đối trong repo test, không `..`, ≤ 255 ký tự | `script` |
| Dữ liệu test | không | mã tham chiếu, ≤ 200 ký tự | `test_data` |
| Điều kiện trước | không | ≤ 1.000 ký tự | `preconditions` |
| Ghi chú | không | ≤ 1.000 ký tự | `note` |

Mã yêu cầu (research D10):

| Loại | Regex | Ví dụ |
|---|---|---|
| Mã spec | `^(\d{3}/)?(FR\|AC\|NFR\|US)-\d{3,4}(\.\d+)?$` | `FR-001`, `036/AC-012.2` |
| Mã SRS | `^(?!(FR\|AC\|NFR\|US)(\d\|$))[A-Z][A-Z0-9]{2,15}$` | `OPD02`, `OPD02P00108` |

Bộ đọc kiểm từng mã theo thứ tự:

1. Khớp mã spec hoặc mã SRS: nhận.
2. Bắt đầu bằng `FR`, `AC`, `NFR`, `US` (có thể kèm `NNN/`): lỗi "mã spec sai dạng", ví dụ `FR001`, `NFR`, `FR-01`.
3. Còn lại: lỗi "mã yêu cầu sai mẫu", ví dụ `opd02`, `OPD-02`, `SC-001`.

Bảng bước: cột `#` là số nguyên tăng dần từ 1. "Thao tác" và "Kết quả mong đợi" mỗi ô 1–1.000 ký tự, không rỗng. Tối đa
50 bước. Lưu vào `steps` dạng `[{ n, action, expected }]`.

[Inference: các giới hạn độ dài ngoài FR-002 (tên khu 120, nhãn 40, ô 1.000, 50 bước) là giá trị đề xuất để chặn file
quá lớn, chưa đo trên bộ TC thật.]

## Đầu ra của bộ đọc

```ts
type ParsedArea = {
  area: { code: string; name: string; line: number } | null;
  cases: Array<{
    code: string; name: string; line: number;
    priority: "P1" | "P2" | "P3";
    kind: "automated" | "manual" | "planned";
    requirements: string[]; labels: string[];
    script: string | null; testData: string | null;
    preconditions: string | null; note: string | null;
    steps: Array<{ n: number; action: string; expected: string }>;
  }>;
  errors: Array<{ line: number; message: string }>; // tối đa 100, xếp theo dòng
};
```

- `errors` khác rỗng thì hub không áp dụng file (FR-004), dù `cases` có TC hợp lệ.
- Bộ đọc không biết database. Lỗi cần database (mã có ở khu khác, mã đã dùng) do hub thêm khi áp dụng (data-model
  `qa_cases`, luật áp dụng file).

## Lỗi

| Trường hợp | Thông điệp |
|---|---|
| Không có dòng `# <KHU> <tên>` | "Dòng 1: file khu phải bắt đầu bằng `# <MÃ KHU> <tên khu>`, ví dụ `# DANGNHAP Đăng nhập`." |
| Mã khu sai mẫu | "Dòng {n}: mã khu `{mã}` phải gồm 2–16 chữ hoa hoặc số, bắt đầu bằng chữ." |
| Mã dạng `TC-<SỐ>` | "Dòng {n}: mã `{mã}` là mã TC của hạng mục. Mã thư viện có dạng `TC-<KHU>-<SỐ>`, ví dụ `TC-{KHU}-001`." |
| Mã TC sai mẫu | "Dòng {n}: mã `{mã}` phải có dạng `TC-<KHU>-<SỐ>`, `<SỐ>` gồm 3–5 chữ số." |
| Khu trong mã khác khu của file | "Dòng {n}: mã `{mã}` thuộc khu `{khu}`, file này là khu `{KHU}`." |
| Mã lặp trong file | "Dòng {n}: mã `{mã}` đã có ở dòng {m}." |
| Thiếu trường bắt buộc | "Dòng {n}: TC `{mã}` thiếu trường `{trường}`." |
| Giá trị không hợp lệ | "Dòng {n}: `{trường}` không nhận `{giá trị}`. Giá trị hợp lệ: {danh sách}." |
| Mã spec sai dạng | "Dòng {n}: mã yêu cầu `{mã}` bắt đầu bằng `{tiền tố}` nên phải có dạng mã spec, ví dụ `{tiền tố}-001` hoặc `036/{tiền tố}-001`." |
| Mã yêu cầu sai mẫu | "Dòng {n}: mã yêu cầu `{mã}` không đúng mẫu. Mã spec có dạng `FR-001` hoặc `036/AC-012.2`. Mã SRS gồm 3–16 chữ hoa hoặc số, bắt đầu bằng chữ, ví dụ `OPD02`." |
| Tự động mà thiếu Script | "Dòng {n}: TC `{mã}` loại tự động phải có `Script`." |
| Trường lặp | "Dòng {n}: trường `{trường}` đã khai ở dòng {m}." |
| Trường lạ | "Dòng {n}: không có trường `{trường}`. Trường hợp lệ: Ưu tiên, Loại, Yêu cầu, Nhãn, Script, Dữ liệu test, Điều kiện trước, Ghi chú." |
| Thiếu bảng bước | "Dòng {n}: TC `{mã}` cần ít nhất một bước có thao tác và kết quả mong đợi." |
| Ô bước rỗng | "Dòng {n}: bước {k} thiếu thao tác hoặc kết quả mong đợi." |
| Vượt độ dài | "Dòng {n}: `{trường}` dài {x} ký tự, tối đa {y}." |
| Quá 100 lỗi | dòng cuối: "Còn {x} lỗi khác. Sửa các lỗi trên rồi lưu lại." |

Lỗi khi hub áp dụng file:

| Trường hợp | Thông điệp |
|---|---|
| Mã khu đã có ở file khác | "Mã khu `{KHU}` đã dùng ở `{đường dẫn}`. Chọn mã khu khác." |
| Mã TC có ở khu khác, đang dùng | "Dòng {n}: mã `{mã}` đã có ở khu khác." |
| Mã TC đã ngừng dùng ở khu khác | "Dòng {n}: mã `{mã}` đã dùng trước đây, chọn số khác." |

## Phiên bản nội dung (FR-007)

`content_hash` là SHA-256 của JSON chuẩn hoá các trường FR-002: tên, ưu tiên, loại, yêu cầu (đã sắp xếp), nhãn (đã sắp
xếp), script, dữ liệu test, điều kiện trước, ghi chú, các bước. Dòng (`line`) và chữ ngoài TC không vào băm, nên di
chuyển TC trong file không tăng phiên bản.

## Mẫu "Thêm khu chức năng" (FR-008)

Người dùng nhập mã khu và tên khu. Hub tạo `test-cases/<slug tên khu>.md`:

```markdown
# <KHU> <tên khu>

Mô tả ngắn phạm vi của khu.

### TC-<KHU>-001 Tên test case ví dụ

- Ưu tiên: P2
- Loại: tay
- Yêu cầu: FR-001
- Nhãn: vi-du

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mô tả thao tác | Mô tả kết quả mong đợi |
```

Mẫu PHẢI qua bộ đọc không có lỗi. Test của `test-library.ts` kiểm điều này.
