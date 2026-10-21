# Implementation Plan: Cây giao việc của agent

**Branch**: `028-agent-delegation-tree` · **Date**: 2026-10-21 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

**Artifacts**: [data-model.md](data-model.md) · [contracts/](contracts) · [quickstart.md](quickstart.md)

## Tóm tắt

- Hub ghi **liên kết giao việc** (`leader_delegations`) mỗi khi Leader tạo task hay giao run trong một phiên; dựng cây
  phiên → task → run (run con theo `parent_run_id`) → sub-agent, lọc theo quyền, trả qua `leader.tree.get`.
- Worker nhận ra **sub-agent** trong stream-json của Claude Code (dòng `system/task_*`, rơi về `tool_use`/`tool_result`)
  và gửi `run_event` loại `subagent` chỉ có siêu dữ liệu, đã che secret.
- Web (trang Leader) và app desktop (màn mới cạnh Terminal) vẽ cây bằng một component dùng chung, poll 3 giây khi còn
  việc chạy. Bấm run mở trang run hay màn "Agent trên máy". Terminal không đổi.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | TypeScript strict (hub, web, desktop, `packages/ui`), Go 1.27 (worker), Rust (Tauri, nếu cần lệnh mới: không) |
| Phụ thuộc mới | Không |
| Lưu trữ | Bảng `hive.leader_delegations` (migration 0083). Sự kiện `subagent` nằm trong `run_events` sẵn có |
| Test | `*.db.test.ts` (testcontainers), vitest (web, desktop, ui), Playwright (web, hub giả), `go test` cả ba hệ điều hành |
| Hiệu năng | SC-002 ≤ 5 giây (poll 3 giây); SC-003 cây 200 nút mở trong 2 giây |
| Ràng buộc | Tương thích worker và hub đã cài (cờ `subagents` trong `welcome`); ranh giới dữ liệu spec 027 |

## Constitution Check

*Kiểm trước phase 0 và sau phase 1: đạt; một lệch ngôn ngữ như các spec trước.*

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | `leader.ts` (cây, hai route), `worker-protocol.ts` (`subagent`, `subagentEventData`) sửa trước; `pnpm openapi`; fixture `worker-protocol.json` và kiểu Go cập nhật; worker chỉ gửi loại mới khi hub có cờ |
| II. Tenant isolation | `leader_delegations` có `org_id`, bật và ép RLS, vào `leader/rls.db.test.ts`; khoá kép tới phiên, task, run; cây lọc theo quyền xem dự án |
| III. Module boundaries | Bảng và dựng cây ở module `leader`; đọc task, run, máy qua `tasks/index.ts`, `runs/index.ts`, `fleet/index.ts` |
| IV. Tested | Xem quickstart; Go test chạy trên fixture thật của Claude |
| V. Secure by default | Chỉ siêu dữ liệu; mô tả che hai lần; không prompt/summary/output |
| VI. Ngôn ngữ | Giao diện tiếng Việt; spec, plan tiếng Việt theo yêu cầu chủ dự án: **lệch**, ghi ở Complexity Tracking |
| VII. Simple to self-host | Không dịch vụ mới; một bảng |
| Giao diện | `role="tree"` theo WAI-ARIA, phím mũi tên, token màu, 360 px, sáng/tối, Playwright theo role |

## Project Structure

| Phần | File |
|---|---|
| Hợp đồng | `packages/contracts/src/leader.ts`, `worker-protocol.ts`, `fixtures/worker-protocol.json`, `openapi.json` |
| Hub: liên kết | `apps/hub/src/modules/leader/schema.ts` (`leaderDelegations`), `db/migrations/0083_*.sql`, `leader/actions.ts` (nhận `threadId`), `leader/service.ts`, `leader/mcp-tools.ts` (truyền `threadId`) |
| Hub: cây | `apps/hub/src/modules/leader/tree.ts` (mới), `leader/router.ts` (`tree.get`, `tree.links`), test `leader/tree.db.test.ts`, `leader/rls.db.test.ts` |
| Hub: sự kiện | `runs/engine.ts` `onRunEvent`: kiểm `subagentEventData`, che `description`; `fleet/gateway.ts`: thêm `subagents` vào `welcome.features` |
| Worker | `worker/internal/runner/subagent.go` (mới, tracker), `runner.go` (gắn vào stdout khi CLI là claude), `channel/jobs.go` (đổi sự kiện, chặn khi hub thiếu cờ), `channel/protocol.go`, test + `testdata/claude-subagent-stream.jsonl` |
| UI dùng chung | `packages/ui/src/delegation-tree.tsx` (mới) + test |
| Web | `apps/web/src/pages/leader-page.tsx` (tab "Cây giao việc"), lối mở từ trang task và run; `e2e/delegation-tree.spec.ts` |
| Desktop | `apps/desktop/src/screens/delegation-tree-screen.tsx` (mới), `lib/nav.ts` (mục cạnh Terminal), test |

## Thiết kế

- **Liên kết**: [research R1](research.md#r1-bảng-liên-kết-riêng-thay-vì-cột-trên-runs). `executeLeaderAction` nhận
  `threadId` (tham số cuối, tuỳ chọn) và ghi `leader_delegations` cùng transaction với hành động.
- **Dựng cây** (`leader/tree.ts`): đọc phiên (404 nếu không thấy); đọc liên kết của phiên → tập task; đọc task qua module
  tasks và lọc theo quyền xem dự án (đếm `hidden`); đọc mọi run của các task đó, tên máy (`fleet.machineNames`), chi phí
  (sự kiện `cost` cuối), lỗi; gộp sự kiện `subagent` theo `seq` thành danh sách nút (start rồi end; run đã kết thúc mà
  sub-agent chưa end thì `unknown`). `active` = còn run chưa kết thúc hay sub-agent `running`.
- **Sub-agent ở worker**: [research R2, R3](research.md#r2-nhận-diện-sub-agent-theo-dòng-systemtask_-rơi-về-tool_usetool_result).
- **Tương thích**: [research R4](research.md#r4-tương-thích-giao-thức-bằng-cờ-trong-welcome).
- **Vẽ và cập nhật**: [research R5–R8](research.md#r5-cây-dựng-ở-hub-client-chỉ-vẽ).

## Phân đợt

| Đợt | Nội dung | User story | Ước lượng |
|---|---|---|---|
| 1 | Hợp đồng, bảng liên kết, ghi liên kết, `leader.tree.get/links`, test db | US1 | 2 ngày |
| 2 | Component cây dùng chung, tab trên web, poll, mở trang run | US1, US2 | 2 ngày |
| 3 | Tracker sub-agent ở worker, cờ `subagents`, hub nhận và che | US3 | 2 ngày |
| 4 | Màn cây trên desktop | US4 | 1,5 ngày |

Đợt 1 trước; 2 và 3 song song (khác file); 4 sau 2.

## Rủi ro

| Rủi ro | Cách giảm |
|---|---|
| Claude đổi định dạng sự kiện sub-agent | Hai đường nhận diện (`task_*` và `tool_use`); fixture thật trong test; không nhận ra thì cây ghi "không theo dõi được" thay vì lỗi |
| Cây lớn làm poll nặng | Truy vấn theo index của phiên; giới hạn 500 run mỗi cây, quá thì báo "cây quá lớn" |
| Mô tả sub-agent chứa dữ liệu nhạy cảm không theo dạng secret | Cắt 120 ký tự; chính sách tổ chức có thể tắt gửi mô tả (để sau) |

## Complexity Tracking

| Lệch | Vì sao cần | Phương án đơn giản hơn bị loại vì |
|---|---|---|
| Spec, plan viết tiếng Việt (constitution VI) | Chủ dự án yêu cầu, như các spec 010–027 | — |
