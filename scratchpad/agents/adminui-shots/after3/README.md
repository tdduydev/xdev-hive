# ADMINUI3 — ảnh kiểm tra giao diện

32 ảnh từ Playwright và hub giả, tại 1440/1100/360 px, theme light/dark:

- `members-list-*`: bảng mặc định, vai trò là badge, tên và email cùng dòng.
- `member-role-confirm-*`: xác nhận tên người và vai trò cũ → mới.
- `member-detail-*`: trang chi tiết với nút đổi vai trò.
- `project-settings-*`: form với thanh mục ngang phía trên.
- `project-settings-budget-*`: ảnh viewport khi cuộn, thanh mục vẫn dính dưới topbar.
- `members-list-expanded-1100-*`: mở rộng sidebar, bật cột đăng nhập, cuộn bảng; cột Người và thao tác được ghim.

Tạo lại tại worktree này:

```sh
HIVE_ADMINUI_SHOTS=1 HIVE_WEB_E2E_WORKERS=3 HIVE_WEB_E2E_PORT=4193 pnpm --filter @xdev-hive/web test:e2e admin.spec.ts -g ADMINUI3
```

Dữ liệu và tên/email trong ảnh là fixture của `apps/web/e2e/admin.spec.ts`.
