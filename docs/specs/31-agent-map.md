# 31. Agent map: chạy nhiều agent một lần

Viết ngày 2/10. Người dùng hỏi: "hệ thống này hỗ trợ agent map luôn đi, một lần có thể chạy nhiều agents". Ở phiên này người dùng chọn cả ba: fan-out một prompt cho nhiều agent, giao nhiều task cho nhiều agent trong một lần, bản đồ trực quan máy → gói → run. Sau đó người dùng bảo làm luôn R-31.

Lúc 12:28 cùng ngày, một phiên khác đã tạo R-31a–d trên hub, chỉ có tiêu đề, không ghi chú:
- 31a batch-run: chọn nhiều task, chạy một lần trên các máy rảnh, giới hạn chạy song song;
- 31b agent-map: bản đồ máy → gói → agent đang chạy, hàng đợi, đợt chạy;
- 31c map-reduce: chia một việc thành task con cho nhiều agent, gộp và review;
- 31d multi-role: nhiều agent khác vai trên một task, gộp vào một branch.

Trang này giữ bốn mục đó và thêm **31e fan-out** (một prompt cho nhiều agent). Phần 31c và 31d dưới đây là cách hiểu tiêu đề của phiên kia (**[Inference]**), cần người dùng xác nhận trước khi làm.

Thứ tự làm: 31a → 31e → 31b → 31c → 31d. Bốn mục sau dùng bảng *đợt chạy* của 31a.

## Cơ chế có sẵn

- **Yêu cầu run** (`run_requests`, roadmap 16c): `runs.dispatch` và `runs.prompt` (32b) kiểm bằng `#assertDispatchable` rồi ghi bằng `#insertRequest` (`packages/core/src/sqlite.ts`). Ở mỗi heartbeat, hub gửi cho máy mọi yêu cầu `pending` của máy đó. Máy xếp run rồi báo `runs.requestResult`. Yêu cầu hết hạn sau 15 phút.
- **Một task chỉ có một run** tại một thời điểm trên cả hub. Nhiều agent cùng làm "một việc" nghĩa là nhiều task.
- **Run trên hub**: máy đẩy `run_records` (`runs.push`): trạng thái `queued / running / succeeded / failed / rate_limited / cancelled`, branch, MR. `Machine.runs` là các run đang chờ hoặc chạy mà máy báo ở heartbeat.
- **Gói của máy** (`ReportedProfile`): bật, đã cài, đăng nhập, chạm ngưỡng, nghỉ tới, số run. Hub chưa biết `maxConcurrent`.
- **Branch**: run làm task dùng `ai/<task>`; branch đã có thì giữ, nên run sau của cùng task làm tiếp trên đó. Branch chỉ lên remote khi run tạo MR/PR.

## R-31a. Đợt chạy: nhiều task, máy rảnh, giới hạn song song

**Bảng mới** (migration kế tiếp trên main):
```sql
CREATE TABLE run_groups(
  id INTEGER PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL,   -- 'batch' (31a) | 'fanout' (31e) | 'mapreduce' (31c) | 'roles' (31d)
  title TEXT NOT NULL, max_parallel INTEGER, review_after INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '',
  parent_task TEXT, winner_task TEXT, created_by TEXT NOT NULL, on_behalf TEXT, created_at TEXT NOT NULL, closed_at TEXT);
CREATE TABLE run_group_items(
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, position INTEGER NOT NULL, task_id TEXT NOT NULL, role TEXT NOT NULL,
  machine_id TEXT, profile_id TEXT, instructions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,            -- 'held' | 'sent' | 'failed' | 'cancelled'
  request_id INTEGER, error TEXT, updated_at TEXT NOT NULL);
CREATE INDEX run_group_items_group ON run_group_items(group_id, position);
```
Một mục là một task sẽ chạy. Mục `held` chưa thành yêu cầu run; khi được thả, hub kiểm như `runs.dispatch` rồi tạo `run_requests` (`sent` + `request_id`), hoặc ghi `failed` + lỗi (task vừa xong, máy vừa tắt nhận run…). Vì yêu cầu chỉ được tạo lúc thả, `run_requests` không đổi nghĩa và mục chờ lâu không bị hết hạn 15 phút.

**Method `runs.dispatchMany`** (quyền `runDispatch` như `runs.dispatch`):
```ts
{ project, title?: string ≤120,
  items: Array<{ taskId, machineId: machineRef | null, profileId: string | null, role }> (1–50),
  maxParallel: number 1–20 | null,          // null: thả hết ngay
  reviewAfter: boolean, instructions: string ≤4000 }
→ { group: RunGroup }
```
- Kiểm ngay lúc gửi những gì không đổi theo thời gian: task thuộc dự án, chưa xong, chưa nằm trong đợt khác còn mở, không lặp trong đợt; máy ghim (nếu có) có repo của dự án; gói ghim có trên máy đó; trần chi tiêu; ký tự ẩn và secret trong chỉ dẫn. Lỗi thì không tạo gì, lỗi nói hàng nào (`vars.task`).
- `machineId: null` = **máy rảnh**: hub chọn máy lúc thả mục (xem dưới).
- Tạo nhóm `batch` và các mục `held`, rồi thả ngay những gì được thả.

**Thả mục** (`#releaseGroups()`): gọi sau `runs.dispatchMany`, ở mỗi `machines.heartbeat` và sau `runs.requestResult`. Với mỗi nhóm còn mục `held`, theo `position`:
- *Đang chạy* của nhóm = mục `sent` có yêu cầu `pending`, hoặc `accepted` mà run tương ứng (`run_records`) còn `queued` / `running`. Yêu cầu `accepted` chưa có `run_records` thì tính là đang chạy trong 10 phút đầu.
- Còn chỗ (`max_parallel` null, hoặc đang chạy < `max_parallel`) thì thả mục tiếp theo.
- Mục chờ task khác (`waitingOn`) thì bỏ qua lần này, thả mục sau nó.
- Mục ghim máy: tạo yêu cầu cho máy đó (máy tự xếp hàng theo gói).
- Mục **máy rảnh**: chọn máy online, nhận run từ hub, có repo của dự án, dự án không bị dừng, còn chỗ trống. Chỗ trống = tổng `maxConcurrent` (app cũ không báo thì là 1) của các gói dùng được (bật, đã cài, không biết là chưa đăng nhập, không chạm ngưỡng, không đang nghỉ, đúng gói ghim nếu có) − run đang chờ/chạy trên các gói đó − yêu cầu `pending` gửi tới máy đó. Lấy máy trống nhiều nhất, bằng nhau thì theo tên. Không máy nào trống thì mục chờ tới lần thả sau.
- Hết mục `held` và mọi mục `sent` đã xong (yêu cầu bị từ chối, huỷ, hết hạn, hoặc run đã kết thúc) thì nhóm `closed_at`.

**Method khác**: `runs.groups { project?, projects, limit }` (quyền `view`) → nhóm mới nhất trước, kèm mục, yêu cầu và run của mỗi mục; `runs.cancelGroup { id }` (`runDispatch`): mục `held` → `cancelled`, yêu cầu `pending` của nhóm → huỷ; run đang chạy không bị dừng (nút *Dừng* có sẵn).

**Heartbeat**: `ReportedProfile.maxConcurrent?: number` (runner báo từ profile). App cũ không báo.

**Giao diện**
- Trang *Task*: ô chọn ở mỗi hàng (task chưa xong) và thanh *Giao cho agent (N)* khi có hàng được chọn (người có `runDispatch` trên dự án, ở chế độ hub). Hộp *Đợt chạy*: mỗi task một hàng với máy (mặc định *Máy rảnh*), gói (*Tự xoay*), việc; chung: tiêu đề, *Chạy song song tối đa* (để trống = tất cả), review chéo, chỉ dẫn. Gửi xong mở đợt vừa tạo.
- Trang **Đợt chạy** (`#/batches`, nhóm *Công việc*; Web Admin có ở nhóm *Vận hành*): mỗi đợt một thẻ (tiêu đề, ai gửi, lúc nào, *đang chạy n / tối đa m*, đếm theo trạng thái) và bảng mục (task, máy/gói, trạng thái: chờ thả / đã gửi / máy nhận + run / xong / lỗi), nút *Huỷ đợt*.

**Test**: core — tạo đợt, kiểm lúc gửi, thả theo giới hạn, thả tiếp khi run xong (qua `runs.push`), máy rảnh chọn đúng máy và bỏ máy hết chỗ, mục lỗi lúc thả, huỷ đợt, quyền. e2e web — chọn 2 task, giới hạn 1, thấy mục thứ hai chờ thả, máy báo run xong thì mục hai được gửi.

Đã làm khác spec: *Đợt chạy* là trang riêng thay vì tab của *Lượt chạy* (trang đó là danh sách–chi tiết, chèn tab vào thì rối).

## R-31e. Fan-out: một prompt cho nhiều agent

Method riêng `runs.fanout { project, title?, prompt, targets: Array<{ machineId | null, profileId | null }> (2–8), reviewAfter }` → `RunGroup` (quyền như `runs.prompt`). Làm khác spec ban đầu (mở rộng `runs.prompt`): một method trả về đợt chạy thì kiểu dữ liệu rõ hơn.
- Tạo task cha `P-<n>` (ghi chú = prompt, không chạy) và task con `P-<n>-a`, `P-<n>-b`, … một task mỗi đích; tiêu đề con: `<tiêu đề> · <máy>/<gói>` (hoặc *máy rảnh*, *tự xoay*). Task cha `dependsOn` mọi task con.
- Một nhóm `fanout`, `max_parallel` null, `parent_task` = cha; mỗi con một mục. Cùng máy + cùng gói hai lần thì được (máy xếp theo `maxConcurrent`).
- `runs.pickWinner { groupId, taskId }` (`taskManage` + `runDispatch`), chỉ khi mọi agent đã xong (`errors.fanoutRunning`): một run còn chạy sẽ tự đưa task của nó về *Chờ review* khi xong, sau khi đã bị đóng ở đây. task được chọn đi tiếp như thường (review, MR); các task con khác → `done` với ghi chú "Không chọn trong P-<n> (chọn <task>)", yêu cầu còn chờ bị huỷ; task cha → `done`; nhóm `winner_task`, `closed_at`. Branch của bản không chọn giữ nguyên.
- Giao diện: hộp *Prompt cho agent* có *Thêm agent* (mỗi dòng một máy + gói). Thẻ đợt `fanout` trên trang *Đợt chạy* có: máy · gói, kết quả run, chi phí, link tới run (tab *Thay đổi* xem diff) và *Chọn bản này*. Chưa có cột thời gian, số dòng đổi và kết luận review.
- Không có giám khảo tự động (khác best-of-n): các bản nằm trên nhiều máy.

## R-31b. Bản đồ agent

Trang **Bản đồ agent** (`#/agent-map`, nhóm *Agent* của menu; app ở chế độ hub cũng có). Lọc theo dự án đang chọn.
- Mỗi máy một cột (online trước): tên, phiên bản app, có nhận run từ hub không, lần cuối thấy. Mỗi gói một thẻ: loại, nhãn, trạng thái (*sẵn sàng*, *đang chạy n/max*, *nghỉ tới HH:mm*, *chạm ngưỡng*, *chưa đăng nhập*, *chưa cài*, *tắt*), % phiên/tuần; dưới đó các run của gói (task, việc, từ lúc nào, `activity`), link tới *Lượt chạy*. Run chưa có gói ở mục *Hàng đợi* cuối cột.
- Cột phải: **Đợt chạy** đang mở (31a) với tiến độ, và mục *máy rảnh* đang chờ thả.
- Thao tác (người có `runDispatch`): bấm thẻ gói → *Prompt cho agent* chọn sẵn máy + gói; chọn nhiều thẻ → *Prompt cho N agent* (31e) hoặc *Giao task cho N agent* (hộp đợt chạy của 31a, các gói đã chọn là đích).
- Dữ liệu: `machines.list` + `runs.groups` mỗi 5 giây khi tab đang hiện. Heartbeat báo thêm `MachineRun.activity` (≤200 ký tự, lọc ký tự ẩn và dòng giống secret).
- Test: trạng thái thẻ gói từ `ReportedProfile` (mỗi trạng thái); e2e mở bản đồ có 2 máy giả, chọn 2 gói, mở hộp prompt với 2 đích.

## R-31c. Map-reduce (cần xác nhận)

**[Inference]** "Chia một việc thành task con cho nhiều agent, gộp và review":
- Người dùng viết việc lớn và danh sách việc con (mỗi dòng một việc). Hub tạo task cha và các task con `P-<n>-1…k`, task cha chờ các con; một nhóm `mapreduce` có `max_parallel`.
- **Map**: các con chạy như đợt chạy 31a, mỗi con một branch.
- **Reduce**: khi mọi con ở *Chờ review* hoặc *Xong*, nhóm có nút *Gộp* (hoặc tự gộp nếu đã chọn khi tạo): một run *Làm task* trên task cha với chỉ dẫn gộp các branch `ai/<con>` vào `ai/<cha>`, sửa xung đột, chạy test; sau đó review chéo.
- Run gộp cần thấy mọi branch con: chạy trên máy đã chạy mọi con, hoặc các branch con đã lên remote (MR/PR). Không được thì hub báo lý do, không xếp.

## R-31d. Nhiều vai trên một task (cần xác nhận)

**[Inference]** "Nhiều agent khác vai trên một task, gộp vào một branch": một chuỗi bước trên cùng task và cùng branch `ai/<task>`, mỗi bước một gói và một vai, ví dụ: *viết code* (claude-1) → *viết test* (codex-1) → *review* (gemini). Một task chỉ có một run một lúc, nên các bước chạy lần lượt: nhóm `roles`, `max_parallel` 1, bước sau được thả khi run bước trước *xong* (thất bại thì dừng chuỗi). Mọi bước trên cùng một máy để branch có sẵn. Vai *viết test* / *viết tài liệu* là run *Làm task* với chỉ dẫn mẫu của vai; *review* là run review.

## Chưa làm trong mục 31

- Agent tự chia việc lớn thành việc con (31c chỉ nhận danh sách người dùng viết).
- Giám khảo tự động cho fan-out.
- Hub kiểm phiên bản tối thiểu của máy khi tự thả mục máy rảnh (kiểm này hiện ở `apps/web/src/app.ts`, ngoài core).
