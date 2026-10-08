# UX-70-SHELL — giao diện desktop/mobile

Ngày kiểm: 8/10/2026. Nhánh: `ai/UX-70-SHELL`. Code hoàn thiện: `fba4e3d4`.

Khôi phục WIP của run R-e9c262 trên Mac sau khi retry R-f44003 trên Linux không lấy được nhánh. Checkpoint 81b8a749 đã push; nền origin/main 1a84068d được ghép bằng 86043645.

## Thay đổi

- Sidebar dùng token 240px, thu thành rail 64px; giữ lựa chọn desktop khi mở/đóng drawer điện thoại.
- Điện thoại có tối đa bốn trang truy cập nhanh và Menu ở dưới; các trang tuân theo quyền và loại client đang có.
- Drawer có vùng ngoài để đóng, focus quay lại đúng nút mở; skip link chuyển focus tới nội dung mà không đổi hash route.
- Header, khoảng cách trang, summary, list/detail và metadata dùng chung theo design system; tiêu đề trang hiện rõ, phần mô tả có Xem thêm/Thu gọn trên điện thoại.
- Chỉnh vùng tiêu đề topbar để tiếng Việt không bị các nút hành động ép hẹp.

## Kiểm chứng

- `npm run typecheck`: PASS.
- Desktop 1440×900: `npm run e2e -w @xdev-hive/web -- /tmp/ux70-shell-desktop --only responsive-shell,a11y-menu,a11y-overlays`: 4/4 PASS.
- Điện thoại 390×844: điều hướng nhanh, drawer và skip link PASS; `a11y-menu,a11y-overlays` chạy lại 3/3 PASS. Selector test drawer đã đổi sang `#hive-navigation` để không chọn nhầm bottom nav.
- `responsive-shell-pages`: desktop 10 trang ở sáng/tối; điện thoại 36 trang/tab ở sáng/tối. Điện thoại 72 lượt kiểm không có overflow, input nhỏ hơn 16px, touch target nhỏ hơn 44px, control thiếu tên, motion không giảm hoặc focus không hiện.
- `npm run build -w @xdev-hive/desktop`: PASS.
- `env -u RTK_DB_PATH npm test`: 1.782 test, 1.777 PASS, 5 skipped, 0 FAIL (406,8 giây).
- `npm run smoke -w @xdev-hive/desktop -- /tmp/ux70-shell-smoke`: PASS, exit 0; 79 ảnh desktop/mobile (local và hub), gồm menu, Task/Run/Agent, Tài liệu, Setup và Chat.

Chạy lại quét trang bằng `npm run e2e -w @xdev-hive/web -- <out> --only responsive-shell-pages` và bản `e2e:mobile` tương ứng. Có ảnh từng trang ở cả sáng/tối, JSON kiểm mobile và kết quả tổng.

Artifact tại máy nghiệm thu:

- `/tmp/ux70-shell-pages-desktop/`: ảnh desktop sáng/tối.
- `/tmp/ux70-shell-pages-mobile/`: ảnh mobile sáng/tối và `shell-pages-light.json`, `shell-pages-dark.json`.
- `/tmp/ux70-shell-mobile-recheck/`: kết quả keyboard/drawer, kiểm axe drawer sáng/tối.
- `/tmp/ux70-shell-smoke/`: smoke app desktop.
- `/tmp/ux70-shell-tests.log`, `/tmp/ux70-shell-build.log`, `/tmp/ux70-shell-smoke.log`: log kiểm.

## Giới hạn

Đây là task giao diện dùng chung; không thay thế UX-70-ONBOARDING hay UX-70-WORKFLOW. Kiểm trang dùng dữ liệu fixture, không phải toàn bộ dữ liệu production. Chưa merge, deploy hay phát hành app; các artifact `/tmp` cần giữ lại khi nghiệm thu trên máy khác. Không đưa các thay đổi tài liệu AGENTS.md/skill sinh tự động vào commit task.
