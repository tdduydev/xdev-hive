# Mẫu vàng của bộ lọc Word

`filter.test.ts` chạy pandoc 3.12 với `filter.lua` trên từng file Word ở đây và so từng byte với `*.md` vàng.

| File Word | Markdown vàng | Có gì |
|---|---|---|
| `srs.docx` | `srs.md` | Trang bìa, bảng ghi nhận thay đổi, mục lục, style tiêu đề riêng kế thừa `Heading 1`/`Heading 3`, đậm, nghiêng, gạch chân, màu chữ, tô vàng, tô nền, link ngoài, link nội bộ, mục danh sách rỗng, đoạn rỗng, theo dõi thay đổi, bình luận, hình có chú thích, ảnh EMF, chú thích bảng, ô gộp ngang và dọc, cột STT tự động, ô nhiều đoạn, danh sách trong ô, ảnh trong ô, `\|` trong ô, bảng lồng, bảng hai hàng tiêu đề |
| `srs.docx` + `keep-front=true` | `srs.keep-front.md` | Như trên, giữ phần trước tiêu đề cấp 1 (Q5); mục lục vẫn bị bỏ |
| `srs.odt` | `srs.odt.md` | `srs.docx` lưu lại bằng LibreOffice |
| `no-h1.docx` | `no-h1.md` | Không có tiêu đề cấp 1, chú thích cuối trang, công thức, hộp chữ |
| `inline-lists.docx` | `inline-lists.md` | Chỉ số dưới, chỉ số trên (trong và ngoài ô bảng, có dấu, ngoặc, in đậm, chữ không có dạng Unicode), hai danh sách đánh số và hai danh sách chấm liền nhau. Test riêng: `inline-lists.test.ts` |

## Sinh lại

```sh
python make-fixtures.py
soffice --headless --convert-to odt --outdir . srs.docx
HIVE_UPDATE_GOLDEN=1 pnpm --filter @xdev-hive/hub exec vitest run src/modules/docsync/word/filter.test.ts src/modules/docsync/word/fixtures/inline-lists.test.ts
git diff -- .
```

Chạy riêng một mẫu: `python make-fixtures.py inline-lists`. Phiên bản python-docx/lxml khác có thể ra byte khác cho `srs.docx`
và `no-h1.docx`; khi đó chỉ sinh mẫu mới và giữ file cũ.

- `make-fixtures.py` cần python-docx 1.2 và chạy lại ra cùng byte. `.odt` do LibreOffice sinh nên mỗi lần một khác: chỉ
  sinh lại khi đổi `srs.docx`.
- Duyệt diff của `*.md` bằng mắt trước khi commit.
- `.gitattributes` để thư mục này `-text`, nên checkout trên Windows giữ LF.

## Khác biệt đã biết của `.odt` so với `.docx`

Do bộ đọc odt của pandoc 3.12, bộ lọc không sửa được:

- Gạch chân thành nghiêng (`*gạch chân*`): bộ đọc odt đổi gạch chân thành `Emph`.
- Danh sách ngoài bảng ra dạng sát (không có dòng trống giữa các mục).
- Ảnh nằm ở `m/Pictures/<tên của LibreOffice>` thay cho `m/media/imageN`. Hub đổi tên ảnh theo hash nên không ảnh hưởng.
- Chú thích hình và chú thích bảng ra chữ đậm, không thành hình có chú thích: chú thích hình là `**…**` thay cho `*…*`.
- Bảng lồng mất hẳn chữ: bộ đọc odt bỏ bảng trong ô. Bộ lọc vẫn báo `nested_table` nhờ đọc `content.xml`.
- Ô STT sau ô có bảng lồng đánh lại từ 1.

## Chỉ số dưới, chỉ số trên và danh sách liền nhau

- `<sub>`/`<sup>` đổi sang chữ Unicode (`SpO₂`, `m²`, `Ca²⁺`) khi mọi ký tự có chữ tương ứng (số, `+ - = ( )`, và `n`, `i` cho
  chỉ số trên). Còn lại (`T` + `max`, `5` + `th`) giữ chữ và bỏ định dạng. Áp dụng cả ngoài ô bảng.
- Pandoc chèn `<!-- -->` giữa hai danh sách cùng loại liền nhau; bộ lọc chen một khối raw rỗng nên dòng này biến mất. Hai
  danh sách vẫn là hai khối riêng khi editor nạp (codec tách khối theo dòng trống), nhưng một trình đọc Markdown khác sẽ
  gộp chúng làm một (danh sách đánh số đếm tiếp 1, 2, 3, 4).
