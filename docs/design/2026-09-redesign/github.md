repo: tdduydev/xdev-hive
branch: main
path: packages/ui

## Last sync
date: 2026-09-30T10:16:15Z

### Updated in this project
- Logo mới (apps/desktop/build/icon-square.svg) và bảng màu theo tone logo
- Web admin riêng: vận hành, theo dõi, kiến thức, quản trị; bảng dữ liệu lớn
- Tài liệu dạng cây theo dự án, trang đọc, liên kết giữa trang, ảnh trong tài liệu
- App desktop chỉ còn phần của máy này; thông báo và tự cập nhật

## Screen map
| Screen | Repo files |
|---|---|
| Khung app (sidebar, topbar, scope) | packages/ui/src/App.tsx, packages/ui/src/components/ScopeSwitcher.tsx, packages/ui/src/globals.css |
| Logo | apps/desktop/build/icon-square.svg, apps/desktop/build/icon.png, apps/web/client/public/favicon.svg |
| Hôm nay | packages/ui/src/pages/Overview.tsx, Proposals.tsx, Memory.tsx, Setup.tsx |
| Công việc (Board, Danh sách, Lượt chạy) | packages/ui/src/pages/Board.tsx, Tasks.tsx, Runs.tsx |
| Chat | packages/ui/src/pages/Chat.tsx |
| Kiến thức (Tài liệu, Skill, Memory, Đề xuất) | packages/ui/src/pages/Docs.tsx, Skills.tsx, Memory.tsx, Proposals.tsx |
| Máy này (desktop) | packages/ui/src/pages/Agents.tsx, Setup.tsx, Projects.tsx |
| Web Admin | packages/ui/src/pages/Admin.tsx, Machines.tsx, Users.tsx, Tokens.tsx, Webhooks.tsx, Systems.tsx, Docs.tsx |
