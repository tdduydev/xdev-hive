# Research: Nhập Word thành tài liệu hub

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-16

## 1. Bộ dữ liệu thật: SRS eHospital trên SharePoint

Nguồn: thư viện SharePoint `ehospitalv2i`, thư mục `60.BA/SRS`, đồng bộ về máy dev bằng OneDrive. Dữ liệu không đưa vào
repo này.

| Mục | Số liệu |
|---|---|
| File `.docx` | 270, trong 16 thư mục module, khoảng 235 MB |
| Tài liệu sau khi chọn bản mới nhất mỗi mã | 261 (18 module theo tên file) |
| Thời gian chuyển cả bộ bằng `srs2md` | 5 phút 14 giây, chạy tuần tự trên máy dev Windows, file đọc từ thư mục OneDrive (khoảng 1,2 giây mỗi file) |
| Mẫu Word | Một mẫu chung của FIS: trang bìa, bảng ghi nhận thay đổi, trang ký, mục lục, rồi `I. TỔNG QUAN`, `II. QUY TRÌNH NGHIỆP VỤ`, `III. … YÊU CẦU` |
| Ảnh | 475 ảnh cho 19 tài liệu OPD nhưng chỉ 61 ảnh khác nhau: logo và 23 ký hiệu quy trình lặp ở mọi tài liệu |
| Tên file | 10 biến thể ngoài mẫu `eHosV2i_SRS_<MODULE>.<MÃ>_v<x.y>.docx` (tiền tố `HC_`, `_` thay `.`, dấu cách trước `v`, hậu tố ` -`, thiếu mã) |
| Dữ liệu cần người xem | 1 mã có hai bản cùng phiên bản khác nội dung (BIL10); 3 mã chép ở hai thư mục; 2 file đặt sai mã (BILL27, BILL30); 1 file nghi đặt nhầm (RIS38) |

Script `tools/srs2md` (Python + pandoc 3.12 + bộ lọc Lua) trong repo `ehospital-ai/docs` đã chuyển cả 261 tài liệu:
- không còn bảng HTML, thẻ `<figure>`, `<img>`, `<u>`;
- không tài liệu nào sót trang bìa;
- chạy lại cho ra đúng từng byte.

Spec này đưa cách làm đó vào hub cho người không cài được Python và pandoc.

## 2. So bộ chuyển trên file thật

Spike ngày 2026-10-16: chạy `mammoth` 1.13.0 (hub đang dùng để trích chữ, `docsync/extract/docx.ts`) và pandoc 3.12 trên
4 file SRS.

| File | Tiêu đề: mammoth | Tiêu đề: pandoc + lọc | Bảng (mammoth / pandoc + lọc) | Ảnh (mammoth / pandoc + lọc) |
|---|---|---|---|---|
| OPD17 (729 KB) | 11 | 32 | 15 / 12 | 24 / 23 |
| OPD02 v1.1 (3 MB) | 20 | 41 | 35 / 32 | 34 / 33 |
| BIL05 | 12 | 69 | 22 / 19 | 30 / 29 |
| Common v1.1 | 18 | 29 | 26 / 24 | 38 / 37 |

Bảng và ảnh của pandoc ít hơn vì bộ lọc đã bỏ trang bìa: 3 bảng (thông tin tài liệu, ghi nhận thay đổi, trang ký) và
logo.

Kết luận:
- **Tiêu đề:** mammoth chỉ nhận style `Heading N` chuẩn. Mẫu FIS dùng style riêng (`FIS_Heading3`, `1b`…), mammoth
  báo "Unrecognised paragraph style" và hạ tiêu đề thành đoạn văn. Pandoc nhận theo style gốc (`basedOn`) nên giữ đủ.
- **Cột STT:** đánh số tự động liền qua các ô. Mammoth bỏ số, ô ra trống (`<td></td>`). Pandoc giữ số bắt đầu của từng
  danh sách (`OrderedList (n, …)`), bộ lọc ghép lại đúng 1, 2, 3…
- **Ô gộp:** cả hai đọc được (`colspan`/`rowspan`, `RowSpan`/`ColSpan`). Editor của hub chỉ sửa trực quan được pipe
  table, nên dù dùng bộ nào cũng phải tự trải ô gộp.
- **Ảnh:** cả hai lấy đủ; 4 file thử đều là PNG. Chưa gặp EMF/WMF trong 261 tài liệu.
- **Mục lục:** cả hai giữ mục lục Word (mammoth: 13–53 link `#_Toc`); phải tự bỏ.

Muốn mammoth đạt mức của pandoc phải tự đọc `styles.xml` (chuỗi `basedOn`) và `numbering.xml` (số trong ô). Đó là viết
lại phần khó nhất của một bộ đọc docx.

## 3. Ràng buộc của editor (đã đọc code)

`packages/doc-editor/src/markdown.ts`: mỗi khối Markdown được nạp riêng rồi xuất thử. HTML hai bản khác nhau thì khối
giữ nguyên dạng chữ (`rawMarkdown`): vẫn lưu đúng nhưng không sửa trực quan được.
- Bảng HTML (`<table>`) và thẻ `<figure>` thành khối thô. Pipe table (`@tiptap/extension-table`) sửa được.
- `|` trong ô được thay tạm lúc xuất (`CELL_PIPE`) để ô không bị tách đôi.

Hệ quả cho bộ chuyển: mọi bảng phải ra pipe table; ảnh ra `![](…)` không thuộc tính.

Spike ngày 2026-10-16: nạp 261 file `tools/srs2md` sinh ra vào `MarkdownCodec` (test tạm, đã xoá).

| Mẫu | Kết quả |
|---|---|
| Pipe table có ô trống, ảnh trong ô, số `1\.` | `table`, sửa được |
| Pipe table có `<br>` trong ô | `rawMarkdown`: cả bảng không sửa trực quan được |
| Mục danh sách đánh số rỗng (`6.  `) | `@tiptap/markdown` ném `TypeError: Cannot read properties of undefined (reading 'type')` trong `renderNodesWithMarkBoundaries`: editor không mở được cả tài liệu |
| Ảnh rồi chú thích `*…*` | hai `paragraph`, sửa được |

Trên 237 file nạp được:
- 3.761 bảng sửa được, 1.340 bảng (26%) thành khối thô, và cả 1.340 bảng đó đều có `<br>`;
- 24 file (EME02, EME16…) làm codec ném lỗi vì có mục danh sách rỗng.

Hệ quả:
1. Editor phải hiểu `<br>` trong ô bảng là xuống dòng trong ô (`hardBreak`) và xuất lại `<br>`. GFM không có cách
   xuống dòng nào khác trong ô.
2. Codec không được ném lỗi vì mục danh sách rỗng. [Inference] Đây là lỗi sẵn có, không riêng Word: file Markdown nào
   trong repo có mục danh sách rỗng, nhập vào hub cũng gặp. Chưa thử trường hợp người gõ trong editor.
3. Bộ chuyển bỏ mục danh sách rỗng.

## 4. Đóng gói pandoc vào hub

- Image hub (`Dockerfile`) dựng từ `node:24.21-bookworm-slim`, không cài gói apt nào.
- Pandoc của Debian bookworm là 2.17, quá cũ cho bộ lọc (cần `Figure`, có từ pandoc 3.0).
- Bản phát hành chính thức của pandoc có binary tĩnh cho `linux-amd64` và `linux-arm64`. Thêm vào image bằng tải có ghim
  phiên bản và SHA-256 ở bước build.
- [Unverified] Dung lượng binary tĩnh chưa đo cho bản sẽ ghim; cần đo lúc làm task Docker.

Chạy pandoc như một tiến trình con với:
- thời gian tối đa;
- giới hạn bộ nhớ của runtime Haskell (`+RTS -M<n>`);
- thư mục tạm riêng, xoá sau khi xong;
- không có mạng: pandoc đọc docx không cần mạng, và `--sandbox` chặn đọc, ghi file ngoài đầu vào.

Đã thử với pandoc 3.12 trên Windows: `--sandbox` vẫn chạy được cùng `--extract-media` và bộ lọc Lua (OPD17 ra 24 ảnh,
33 KB Markdown), và pandoc nhận `+RTS -M256m -RTS`. Chưa thử trên Linux.

## 5. Hub đang chạy

`https://hive.xdev.asia/api/v1/health` ngày 2026-10-16 báo `version` `3fa5aadf` (merge PR #409), build `06:01Z`. Bản này
chưa có PR #413 (sửa nhập từ repo khi archive bị chặn và khi hook lưu đang bật), nên muốn thử spec này trên hub thật thì
phải triển khai lại hub trước.
