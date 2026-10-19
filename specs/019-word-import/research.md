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

## 6. Kết quả bộ thật lần 1

Chạy ngày 2026-10-19 bằng `pnpm --filter @xdev-hive/hub word:corpus <thư mục SRS>` trên máy dev Windows (pandoc 3.12, `filter.lua` và `runPandoc` của hub trên `main` tại `fd51f925`, 2 file cùng lúc, file đọc từ thư mục OneDrive). Chi tiết từng file nằm ngoài repo (`E:\DevCache\word-corpus\run2`).

**Bộ chạy khác mục 1:** thư mục SRS hôm nay có 283 file `.docx` (mục 1 ghi 270). Sau khi chọn bản mới nhất mỗi tài liệu trong từng thư mục bằng `names.ts` còn 278 file, không phải 261. [Unverified] Chưa rõ vì OneDrive đã có thêm tài liệu, hay vì `pick` theo từng thư mục chưa gộp mã chép ở hai thư mục như cách chọn của `srs2md`. SC-001 vì vậy đo trên 278, rộng hơn bộ 261.

| Chỉ số | Kết quả |
|---|---|
| File pandoc lỗi | 0 / 278 |
| File làm codec ném lỗi (hoặc schema từ chối) | 0 / 278 (mục 3: 24 / 237 với `srs2md`) |
| Bảng | 5.976; thành `table` 5.975 (99,98%); thành khối thô 1 |
| Tài liệu có bảng thành khối thô | 1: EME03 (`SpO<sub>2</sub>` trong ô) |
| Thẻ HTML còn sót ngoài `<br>` trong ô | 1 tài liệu, 2 thẻ: `<sub>` của EME03 |
| Khối không phải bảng mà codec để thô | 215, gồm 28 dòng `<!-- -->` (pandoc ngăn hai danh sách liền nhau) và 187 khối danh sách hoặc đoạn mà codec xuất lại khác chữ gốc |
| Cảnh báo của bộ lọc | `emf_image` 31 (16 tài liệu); `nested_table` 4 (1 tài liệu: OPD20) |
| Thời gian cả bộ | 321 giây (5 phút 21 giây), 2 file cùng lúc |
| Thời gian mỗi file | p50 1,9 giây; p95 4,1 giây; lớn nhất 8,5 giây (giới hạn của hub là 120 giây) |

Lần chạy đầu cho cùng kết quả pandoc, codec nhưng báo 30 tài liệu sót thẻ và file lớn nhất 31,9 giây:
- 30 tài liệu báo sót thẻ là báo sai của script: chữ `\<tên\>`, `Nullable\<int\>` đã được pandoc thoát nên không phải HTML. Script đã bỏ qua `\<`. Biểu thức kiểm thẻ trong `filter.test.ts` (SC-001) giống bản đầu của script, nên gặp chữ như vậy cũng sẽ báo sai.
- 31,9 giây chỉ ở lần đầu, lần hai 8,5 giây. [Inference] Do OneDrive tải file về máy hoặc máy bận lúc đó.

Kết luận SC-001 trên bộ này: không file lỗi, không codec lỗi, 99,98% bảng sửa được trực quan. So với mục 3 (74% bảng sửa được, 24 file làm codec ném lỗi), [Inference] khác biệt đến từ `<br>` trong ô (mọi bảng thô ở mục 3 đều có `<br>`) và mục danh sách rỗng, vì codec hiện tại nạp được cả hai. Chưa tách riêng từng nguyên nhân.

**Lỗi của bộ lọc và bộ chuyển, đề xuất thành task mới** (không sửa trong T007):
1. `<sub>` và `<sup>` trong ô bảng ra HTML thô nên cả bảng thành khối thô (EME03). Đề xuất: bộ lọc đổi chỉ số dưới, trên thành chữ thường (Unicode `₂`) hoặc editor hiểu `<sub>`/`<sup>` trong ô.
2. `runPandoc` không truyền `--eol=lf`: trên Windows pandoc ra CRLF (đã đo trên `srs.docx`: 124 ký tự `\r`), `filter.test.ts` thì có. Hub chạy Linux nên không ảnh hưởng bản chạy thật, nhưng làm hash và test của `runPandoc` khác nhau giữa hai hệ điều hành.
3. Dòng `<!-- -->` giữa hai danh sách liền nhau (28 khối, 12 tài liệu) thành khối thô trong editor. Đề xuất: hậu xử lý bỏ dòng này, hoặc bộ lọc chèn đoạn trống nhìn thấy được.
4. 187 khối danh sách hoặc đoạn bị codec để thô vì xuất lại khác chữ gốc (ví dụ danh sách đánh số lồng bullet, khối `"BenhVien": …`, chú thích ảnh `*![](…)*`). Chưa phân loại nguyên nhân; cần một lần xem mẫu để tách lỗi bộ lọc với giới hạn codec.
5. Biểu thức kiểm thẻ HTML trong `filter.test.ts` tính nhầm `\<…>`; nên bỏ qua `\<`.
6. `apps/hub/tsconfig.json` chỉ gồm `src`, `test`: thư mục `scripts/` mới không được `pnpm typecheck` kiểm. T007 đã kiểm tay bằng tsconfig tạm.
7. Chọn bản trong `pick` theo từng thư mục cho 278, mục 1 nói 261: cần xem 17 tài liệu khác nhau là mã chép hai nơi hay tài liệu mới.
