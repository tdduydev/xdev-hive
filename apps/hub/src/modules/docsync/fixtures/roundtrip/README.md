# Bộ mẫu T004 và bàn giao

`manifest.json` ghi đường dẫn gốc, commit nguồn, SHA-256 từng byte và SHA-256 kết quả `MarkdownCodec` của mỗi mẫu.
Các file `001.md`–`200.md` là bản sao nguyên byte, không chỉnh sửa hay sinh lại từ parser.

Worktree nguồn tại `c9056056` chỉ có 99 file Markdown trong `docs/` và `specs/`. Bộ mẫu gồm 98 file sạch ở commit đó
và 102 phiên bản nội dung khác nhau từ lịch sử Git của hai thư mục này. Một file bị bộ quét `scanSecrets` đánh dấu
đã được bỏ qua. Tổng cộng 200 mẫu có hash khác nhau; test quét lại bí mật mỗi lần chạy.

## Kết quả SC-005

- EOL/BOM: 200/200 bản gốc khớp từng byte sau `fromLf(toLf(x), detectEol(x), hasBom(x))`. Test còn kiểm mỗi mẫu ở
  cả bốn tổ hợp LF/CRLF và có/không BOM.
- `MarkdownCodec.parse` → tạo node theo schema → `remember` → `serialize`: 191/200 khớp từng byte (95,5%).
- 200/200 đầu ra codec khớp `normalizeDoc` của bản LF. Đây chỉ là hành vi hiện có, không phải SC-005 đạt 100%.
- Chín mẫu khác byte do `serialize` gọi `joinBlocks`: chuẩn hoá khoảng trắng cuối khối, khoảng cách giữa khối
  và dòng cuối file. Không sửa codec vì ngoài phạm vi T004. Task editor cần giữ cách phân cách khối nguyên gốc để
  hoàn thành SC-005 trước khi bật đồng bộ ghi lại qua editor. Test giữ hash đầu ra hiện tại để phát hiện hồi quy.

| Mẫu khác byte | Nguồn | Commit |
|---|---|---|
| 018.md | docs/adr/0016-desktop-local-ui.md | c9056056 |
| 040.md | docs/design-system/screens/README.md | c9056056 |
| 041.md | docs/design-system/screens/v1/README.md | c9056056 |
| 042.md | docs/design-system/xdev-hive/MASTER.md | c9056056 |
| 050.md | docs/srs.md | c9056056 |
| 066.md | specs/008-desktop-v2/plan.md | c9056056 |
| 067.md | specs/008-desktop-v2/spec.md | c9056056 |
| 095.md | specs/018-docs-repo-sync/plan.md | c9056056 |
| 200.md | docs/design-system/screens/README.md | d7f445bb |

## Tích hợp các task sau

- T005: thêm `yaml` vào dependencies của hub rồi đổi import tạm trong `content.ts` thành `from "yaml"`.
  Hiện dùng bản transitive 2.9.1 trong virtual store của pnpm; T004 không sửa package.json/lockfile.
- `keyFromPath(path, home, frontMatterKey?)`: chỉ tạo key lúc nhập lần đầu; key ghim phải đúng phạm vi. Đổi tên phải
  dùng ánh xạ đã lưu. `pathFromKey(key, home)` chỉ dành cho tài liệu mới trên hub; file đã nhập ngoài root phải dùng
  đường dẫn thật đã lưu. `uniqueKey(key, occupied)` không sửa tập key; caller thêm key được chọn trước file kế tiếp.
- Nhà dự án dùng `{ scope: "project", projectKey, root }`; nhà tổ chức dùng `{ scope: "org", root?: "" }`.
  Nhà tổ chức ánh xạ `org/` và `teams/<slug>/`. Kiểm đội tồn tại thuộc lớp nghiệp vụ có DB.
- `matchesHome(path, home, managed?)` áp dụng mẫu lấy/bỏ và loại trừ cứng. Truyền `sdlcRoot`, `sdlcPaths`, `skillRoots`
  và key đã lưu (nếu có) qua `managed`; hàm thuần không tự đọc cấu hình SDLC hay kho skill.
- `overlaps(rootA, rootB)` chỉ so thư mục. Caller kiểm cùng repo trước khi gọi.
- `resolveRelative(docPath, href)` trả `{ path, query, fragment }`, hoặc `null` nếu link ngoài repo/không an toàn.
  Cho phép vượt root nhà để tra tài liệu/đính kèm đã nhập; caller vẫn phải kiểm quyền và tenant trước khi trả file.
- `toLf` bỏ BOM đầu file, chuẩn hoá CRLF; `fromLf` cần EOL và BOM gốc. Metadata chỉ có LF/CRLF, nên file trộn hai
  kiểu xuống dòng không thể được phục hồi từng byte bằng một giá trị EOL. Không có mẫu trộn trong bộ này.
- `parseFrontMatter` giữ `raw` và `body` nguyên văn, chỉ đọc metadata; cảnh báo cố định không chứa dòng YAML nguồn.
- `parseGitattributes` trả quy tắc filter theo thứ tự; `isLfsPath(path, rules)` dùng quy tắc khớp cuối cùng. Không hỗ
  trợ macro, phủ định mẫu, lớp ký tự hoặc C-escape octal (đúng giới hạn bản đầu trong research).
- `matchRenames(removed, added)` nhận `{ path, blobSha?, content? }[]`, trả `{ from, to, method, similarity }[]`.
  Caller bỏ các rename provider đã nhận ra trước. Phần dự phòng ưu tiên sha, rồi Jaccard tập khối ≥ 0,8, mỗi file
  chỉ ghép một lần; cặp không ghép được vẫn là xoá/thêm. Đây là heuristic, có thể nhập nhằng với file trùng nội dung.
