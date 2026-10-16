# DOCFIX-T025 — sửa test MCP của PR #401

## Đã làm

- Tiếp tục nhánh `ai/DOC-T025`; worktree ban đầu sạch, chưa có bản sửa lỗi này.
- Chạy `git fetch origin && git merge origin/main`, merge không có xung đột.
  Commit đồng bộ: `0246a3b` (`chore: merge origin/main into ai/DOC-T025`).
- Xác định tool mới là `doc_asset_get`, được thêm trong commit `b5fc38c4`.
- Thêm tên tool vào danh sách chờ đã sắp xếp trong `apps/hub/src/mcp.db.test.ts`, từ 34 thành 35 tool.
- Xác nhận cổng MCP thêm `org` qua `tool.input.extend({ org: ORG_PARAM })` trong
  `apps/hub/src/modules/mcp/server.ts`. Vòng kiểm tra hiện có kiểm `org` và gợi ý chỉ đọc của mọi tool,
  bao gồm `doc_asset_get`; không cần sửa implementation hoặc bỏ tool.

## Kiểm tra đã chạy

- `pnpm biome check --write .`: đạt, exit 0; không sửa thêm file; có 43 cảnh báo và 2 thông tin có sẵn.
- `pnpm biome check apps/hub/src/mcp.db.test.ts`: đạt, không có chẩn đoán.
- `pnpm --filter @xdev-hive/hub typecheck`: đạt.
- `pnpm deps`: đạt, không vi phạm phụ thuộc (1912 module, 8244 phụ thuộc).
- `DOCKER_HOST="unix://$HOME/.colima/default/docker.sock" TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock pnpm --filter @xdev-hive/hub exec vitest run src/mcp.db.test.ts`:
  đạt, 1 file / 15 test, PostgreSQL thật qua Testcontainers trên Colima, 20,04 giây.
- `git diff --check`: đạt.

## Phần còn lại và rủi ro

- Không còn phần sửa hoặc kiểm tra liên quan nào chưa làm. Không chạy full `pnpm ci:local` theo yêu cầu.
- Không thay đổi dependencies, contracts, migration, web, desktop hoặc worker nên không cần cài lại hay chạy kiểm tra các phần đó.
- `pnpm deps` có cảnh báo sẵn về TypeScript 7 chưa được dependency-cruiser hỗ trợ đầy đủ;
  kết quả kiểm phụ thuộc có giới hạn này. Không thay đổi công cụ trong phạm vi sửa test.
- Rủi ro thay đổi thấp: chỉ bổ sung kỳ vọng test; hành vi ứng dụng giữ nguyên.
- Chỉ commit tại máy; không push, không gọi `gh`, không mở PR hoặc deploy.

Đề bài không cung cấp đường dẫn tóm tắt cụ thể nên bản bàn giao được lưu tại gốc worktree.
