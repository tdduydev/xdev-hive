# 50. Gán task cho từng agent

Viết ngày 6/10. Người dùng hỏi: "hệ thống này cho phép giao cho từng agent làm task đi". Họ chọn **gán rồi tự chạy khi rảnh**:
- task có ô *Agent phụ trách* (máy + gói);
- khi agent đó rảnh và task đã hết phụ thuộc, hub tự giao run;
- Board lọc và nhóm được theo agent, kéo task thả vào agent để gán.

Task: **R-50a** (hub), **R-50b** (giao diện).

## Cơ chế có sẵn

- **Task** (`Task` trong `packages/core/src/types.ts`):
  - có `owner` và `leaseUntil`: ai đã *nhận* task qua `task_claim`;
  - không có ô nào nói task *dành cho* ai.
- **Giao run**: `runs.dispatch` (một task, chọn máy và gói), `runs.dispatchMany` và đợt chạy 31a (`run_groups`).
- **`#releaseGroups()`** trong `sqlite.ts`:
  - mỗi lần máy gửi heartbeat hay một run kết thúc, nó thả các mục của đợt chạy đang chờ;
  - mục chỉ đi khi task hết phụ thuộc, có máy rảnh (`#freeMachine`), và qua `#assertDispatchable` (chính sách agent 27a, ngân sách, dự án tạm dừng hay đã lưu trữ…).
- **`#freeMachine(project, profileId)`** đếm chỗ trống theo `maxConcurrent` của gói đang dùng được, trừ run đang chạy và yêu cầu chưa trả lời.
- **Chốt SDLC** (34):
  - chỉ áp cho task trong luồng;
  - chốt `dispatch` của luồng thả cả danh sách task thành một đợt chạy;
  - task ngoài luồng chạy như người giao.

## Mô hình

- **Cột mới của `tasks`** (migration mới ở cuối `MIGRATIONS`, số kế tiếp lúc merge):
  - `agent_machine TEXT`: id máy (`runner.<máy>@<máy>`);
  - `agent_profile TEXT`: id gói. Để trống là gói nào của máy đó cũng được, hub chọn theo luật xoay vòng 24a/24c như *Gửi cho máy*;
  - `agent_order REAL`: thứ tự trong hàng của agent; số nhỏ chạy trước; kéo thả đổi thứ tự bằng giá trị giữa hai task;
  - `agent_by TEXT`, `agent_at TEXT`: ai gán, lúc nào;
  - `agent_hold TEXT`: lý do agent tạm ngừng với task này (run lỗi, hết lượt sửa). Khi có giá trị này hub không tự giao nữa, cho tới khi người bấm *Chạy lại* hay gán lại.
- **`Task.agent`**: `{ machineId, machine, profileId | null, order, by, at, hold | null } | null`.

## Method (kiểm trong `#check`, ghi `AUDITED`, phát sự kiện `task`)

| Method | Quyền | Làm gì |
|---|---|---|
| `tasks.assign { id, machineId, profileId?, before? }` | `runDispatch` ở dự án của task | Gán hay đổi agent. `before` là id task đứng sau nó trong hàng của agent; không có thì xếp cuối hàng. Xoá `agent_hold`. Máy phải có repo của dự án và nhận run từ hub (`acceptsRuns`); gói (nếu có) phải có trên máy. |
| `tasks.unassign { id }` | `runDispatch` | Bỏ gán. Run đang chạy không bị dừng. |
| `tasks.agentQueue { machineId, profileId? }` | `view` | Hàng của một agent: task đã gán theo thứ tự, kèm trạng thái và lý do đang chờ (phụ thuộc, agent bận, quota, chính sách, tạm ngừng). |

## Hub tự giao

`#releaseAssigned()` chạy ngay sau `#releaseGroups()` ở mọi chỗ gọi nó. Với mỗi agent có task đã gán, xét task theo `agent_order`.

**Một task đủ điều kiện khi:**
- trạng thái `todo` và không ai giữ (`owner` trống hay lease đã hết);
- `waitingOn` rỗng;
- không có run hay yêu cầu run nào đang mở cho task đó;
- không nằm trong một đợt chạy đang mở. Nếu có, đợt chạy quyết định, gán agent chỉ là máy và gói mặc định cho mục của đợt;
- không có `agent_hold`;
- dự án không tạm dừng hay lưu trữ.

**Agent rảnh khi:** gói (hay một gói bất kỳ của máy, nếu không chỉ định) có chỗ theo đúng luật của `#freeMachine`, nhưng chỉ xét máy đó.

**Mỗi lần xét, mỗi agent nhận tối đa số chỗ trống của nó.** Yêu cầu gửi qua `#assertDispatchable` và `#insertRequest`, giống một mục của đợt chạy:
- `role: implement`;
- `reviewAfter` theo cài đặt mặc định của dự án (review chéo);
- người yêu cầu (`requested_by`) là người đã gán, để ngân sách và nhật ký tính đúng người.

**Các lỗi:**
- Lỗi có thể hết sau (máy offline, hết quota, đạt trần ngân sách): task chờ, không ghi `hold`.
- Lỗi không tự hết (máy không còn repo, gói bị xoá): ghi `hold` kèm lý do, và *Hôm nay* có mục cho người gán.

**Run kết thúc:**
- Thành công: task sang `review` như hiện nay; agent nhận task kế trong hàng.
- Lỗi hay bị huỷ: ghi `hold` = lỗi của run, để agent không lặp lại một task hỏng mãi. *Hôm nay* có mục *Agent dừng ở task X*, nút *Chạy lại* (xoá hold) hoặc *Gán agent khác*.

**Task trong luồng SDLC:** chốt `dispatch` vẫn quyết. Agent đã gán chỉ đổi máy và gói mà đợt chạy của luồng dùng cho task đó.

## Agent tự nhận việc (MCP)

- `tasks.next` / `task_next` bỏ qua task đã gán cho agent khác, khi người gọi là token của một máy. Task gán cho chính máy đó (và gói đó, nếu biết) xếp trước.
- `task_claim` một task đã gán cho máy khác: từ chối, lỗi `errors.taskAssignedElsewhere`, trừ admin.
- `task_list` / `task_get` trả thêm `agent`. Bản gọn của 28 chỉ thêm `agent: "<máy>/<gói>"`.

## Leader chat

Thêm loại đề xuất `taskAssign { taskId, machineId, profileId? }` vào `CHAT_ACTION_KINDS`:
- duyệt cần `runDispatch`;
- tự chạy được theo 29c;
- thứ tự trong `CHAT_DECIDE_ORDER` đặt sau `taskCreate`.

Skill `hive-leader` thêm một đoạn: khi người hỏi "giao cho X", leader đề xuất `taskAssign`.

## Giao diện (R-50b)

- **Khung task**: ô *Agent phụ trách* đặt trên *Chạy trên máy*.
  - Chọn máy rồi gói (hay *Gói nào cũng được*); mỗi lựa chọn hiện bận/rảnh, % quota 5 giờ và tuần, số task đang xếp.
  - Khi đã gán: hiện vị trí trong hàng, lý do đang chờ, nút *Chạy lại* nếu đang tạm ngừng, *Bỏ gán*.
- **Board (Task)**:
  - thẻ task có chip agent (`claude-3 · Mac mini`);
  - bộ lọc *Agent* (gồm *Chưa gán*);
  - chế độ **Theo agent**: mỗi agent một làn, thêm làn *Chưa gán*. Kéo thẻ sang làn khác là gán; kéo trong làn là đổi thứ tự. Trên điện thoại không kéo, dùng ô chọn agent (như 42d).
- **Máy & agent** (*Bản đồ agent* hiện tại): mỗi gói hiện hàng task đã gán (3 đầu, *Xem tất cả*), sắp lại được.
- **Hôm nay**: mục *Agent dừng ở task* (cho người gán, và người có `runDispatch`).
- **Chọn nhiều task → *Gán cho agent***: một agent cho cả lô, theo thứ tự đang chọn.
- **Sơ đồ dự án** (51b): thả nút task vào nút agent là gán.
- Chữ vào `vi.ts` trước rồi `en.ts`. Mọi thứ dùng được ở 390×844 (e2e:mobile). Kiểm bằng skill `ui-ux-pro-max` (vùng chạm, nhãn, tương phản).

## Test

**Hub:**
- gán, bỏ gán, đổi thứ tự;
- quyền;
- máy không có repo thì từ chối;
- tự giao khi agent rảnh và task hết phụ thuộc;
- không giao khi agent bận: nhận task kế khi run trước xong;
- run lỗi thì có `hold`, không giao lại; *Chạy lại* thì giao;
- task trong đợt chạy không bị giao hai lần;
- `task_next` của máy khác bỏ qua task đã gán;
- `task_claim` bị từ chối;
- `taskAssign` của leader.

**UI:**
- ô agent trong khung task;
- chế độ *Theo agent* và kéo thả (desktop);
- ô chọn trên mobile.

**E2e web:** gán hai task cho một agent giả có `maxConcurrent` 1. Task thứ nhất chạy, task thứ hai chờ; run giả xong thì task thứ hai được giao.

## Ràng buộc khi làm

- Không đổi hành vi của task chưa gán.
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
