# Mẫu vàng của bộ lọc Word

`filter.test.ts` chạy pandoc 3.12 với `filter.lua` trên từng file Word ở đây và so từng byte với `*.md` vàng.

| File Word | Markdown vàng | Có gì |
|---|---|---|
| `srs.docx` | `srs.md` | Trang bìa, bảng ghi nhận thay đổi, mục lục, style tiêu đề riêng kế thừa `Heading 1`/`Heading 3`, đậm, nghiêng, gạch chân, màu chữ, tô vàng, tô nền, link ngoài, link nội bộ, mục danh sách rỗng, đoạn rỗng, theo dõi thay đổi, bình luận, hình có chú thích, ảnh EMF, chú thích bảng, ô gộp ngang và dọc, cột STT tự động, ô nhiều đoạn, danh sách trong ô, ảnh trong ô, `\|` trong ô, bảng lồng, bảng hai hàng tiêu đề |
| `srs.docx` + `keep-front=true` | `srs.keep-front.md` | Như trên, giữ phần trước tiêu đề cấp 1 (Q5); mục lục vẫn bị bỏ |
| `srs.odt` | `srs.odt.md` | `srs.docx` lưu lại bằng LibreOffice |
| `no-h1.docx` | `no-h1.md` | Không có tiêu đề cấp 1, chú thích cuối trang, công thức, hộp chữ |

## Sinh lại

```sh
python make-fixtures.py
soffice --headless --convert-to odt --outdir . srs.docx
HIVE_UPDATE_GOLDEN=1 pnpm --filter @xdev-hive/hub exec vitest run src/modules/docsync/word/filter.test.ts
git diff -- .
```

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
