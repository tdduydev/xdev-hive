# 31. Agent map: chạy nhiều agent một lần

Viết ngày 2/10. Người dùng hỏi: "hệ thống này hỗ trợ agent map luôn đi, một lần có thể chạy nhiều agents". Ở phiên này người dùng chọn cả ba: fan-out một prompt cho nhiều agent, giao nhiều task cho nhiều agent trong một lần, bản đồ trực quan máy → gói → run. Sau đó người dùng bảo làm luôn R-31.

Lúc 12:28 cùng ngày, một phiên khác đã tạo R-31a–d trên hub, chỉ có tiêu đề, không ghi chú:
- 31a batch-run: chọn nhiều task, chạy một lần trên các máy rảnh, giới hạn chạy song song;
- 31b agent-map: bản đồ máy → gói → agent đang chạy, hàng đợi, đợt chạy;
- 31c map-reduce: chia một việc thành task con cho nhiều agent, gộp và review;
- 31d multi-role: nhiều agent khác vai trên một task, gộp vào một branch.

Trang này giữ bốn mục đó và thêm **31e fan-out** (một prompt cho nhiều agent). Phần 31c và 31d dưới đây ban đầu là cách hiểu tiêu đề của phiên kia (**[Inference]**); người dùng đã xác nhận 31c và 31d (2/10).

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

Đã làm khác spec (2/10):
- Không thêm trang `#/agent-map`: bản đồ thay bảng máy của trang *Máy & run* (cùng `#/machines`, đổi tên *Bản đồ agent*), vì hai trang sẽ trùng máy, gói và run (người dùng muốn mỗi việc một trang, roadmap 35). *Quota đang nghỉ* và *Chi phí ước tính* vẫn ở dưới.
- Chỉ trên web: từ 35a app desktop ở chế độ hub chỉ có việc của máy mình; link tới bản đồ mở trình duyệt.
- Không thêm `MachineRun.activity` vào heartbeat: run đang chạy đã được máy đẩy lên (`runs.push`) kèm `activity`; bản đồ ghép theo máy + id run.
- *Giao task cho N agent* mở trang *Task* với các gói đã chọn (`#/tasks?agents=…`): người dùng chọn task ở đó, hộp đợt chạy điền máy + gói lần lượt theo thứ tự đã chọn.
- Cột máy có thêm *Bật/tắt và ưu tiên gói* và *Xoá* (trước nằm trong bảng máy).

## R-31c. Map-reduce

Người dùng xác nhận (2/10): chia việc cả hai cách (người viết danh sách việc con, hoặc nhờ agent chia rồi người sửa); luôn tự gộp branch con vào branch cha rồi review chéo, một MR.

**Engine** (`packages/core/src/mapreduce.ts`, `sqlite.ts`):
- `runs.mapReduce { project, groupId?, title?, prompt, parts (2–12, ≤300 ký tự), machineId | null, profiles[], maxParallel, reviewAfter = true }` (quyền như `runs.dispatch`): task cha `P-<n>` (chờ các con) và `P-<n>-1…k`; nhóm `mapreduce`, `phase` `map`, `machine_id` là máy của mọi con và của run gộp (null = máy còn nhiều chỗ nhất lúc gửi). Các con lần lượt lấy `profiles` (rỗng: máy chọn), không review riêng.
- `runs.mapSplit { project, title?, prompt, machineId | null, profileId | null }`: task cha và một run `plan` trên nó, chỉ dẫn "ghi danh sách việc con vào ghi chú, không viết code"; nhóm ở `phase` `split`. Run xong thì `parts` = các dòng `- …` / `1. …` của ghi chú, `phase` `ready`: chờ người sửa rồi gọi `runs.mapReduce` với `groupId` (máy của nhóm giữ nguyên).
- `#mapStep` trong `#releaseGroups`: mọi con `succeeded` thì các con → `done` và xếp run `implement` trên task cha, trên máy của nhóm, chỉ dẫn gộp `ai/<con>` theo thứ tự (kèm ghi chú bàn giao của con, coi là dữ liệu), sửa xung đột, chạy test; `reviewAfter` của nhóm. Run gộp xong → `done`. Một con, run chia hoặc run gộp không thành công, máy không nhận, hoặc *Huỷ đợt* → `stopped` + `phase_error`.
- `runs.resumeGroup { id }`: nhóm `stopped` chạy lại run chia (chưa có con), hoặc các con chưa `succeeded`, hoặc (đủ con) run gộp.

**Giao diện**:
- Trang *Task*: nút *Chia việc* (ai có `taskManage` + `runDispatch`, chế độ hub) mở hộp *Chia việc cho nhiều agent* (`SplitSheet`, `packages/ui/src/components/AgentSheets.tsx`): dự án, cách chia (*Tôi viết danh sách việc con* / *Nhờ agent chia*), máy (*Máy rảnh* được), tiêu đề, việc lớn; danh sách việc con mỗi dòng một việc, gói (ô chọn, các con lần lượt lấy; chỉ khi đã chọn máy), *Chạy song song tối đa*, review chéo bản gộp. Nhờ agent chia: một gói cho run chia.
- Nhóm ở `ready` hiện thành thông báo trên trang *Task* với *Kiểm và chạy*: cùng hộp, việc lớn chỉ đọc, danh sách của agent để sửa, máy của nhóm. Trang hỏi lại mỗi 5 giây khi có nhóm đang chia. `#/tasks?split=<id>` mở thẳng nhóm đó.
- Trang *Đợt chạy*: thẻ `mapreduce` có giai đoạn, *Việc lớn: P-<n>*, máy, run chia hoặc run gộp (trạng thái + link run), lý do dừng và *Chạy lại* (`runs.resumeGroup`) khi `stopped`; ở `ready` là danh sách agent đề xuất và link *Sửa danh sách và chạy*; bảng việc con như đợt 31a.

**Test**: core `packages/core/test/map-reduce.test.ts`: giữ đủ branch và chỉ dẫn gộp trong 4000 ký tự; retry không gửi trùng run còn hoạt động hoặc run đã thành công sau huỷ; run chia thử lại nhận việc gốc; kiểm cả run chia báo thành công trước ghi chú bàn giao, prompt gốc có danh sách (kể cả >2000 ký tự) không bị nhận làm việc con, và ghi chú sửa lại được đọc tới khi người xác nhận. e2e `map-reduce` (`apps/web/e2e/browser.mjs`): nhờ agent chia trên máy của Lan, máy giả ghi 2 việc con, Lan thêm việc thứ ba và chọn gói rồi chạy; 3 con xong → run gộp có đủ 3 branch; run gộp lỗi → thẻ *Đã dừng*, *Chạy lại* → *Đang gộp*, xong → *Đã gộp*.

Chưa làm: run gộp chỉ chạy trên máy của các con (chưa gộp từ branch đã lên remote).

## R-31d. Nhiều vai trên một task

Người dùng xác nhận (2/10 17:20) cách hiểu ban đầu: một chuỗi bước trên cùng task và cùng branch `ai/<task>`, mỗi bước một gói và một vai, ví dụ: *viết code* (claude-1) → *viết test* (codex-1) → *review*. Một task chỉ có một run một lúc, nên các bước chạy lần lượt: nhóm `roles`, `max_parallel` 1, bước sau được thả khi run bước trước *xong* (thất bại thì dừng chuỗi). Mọi bước trên cùng một máy để branch có sẵn. Vai *viết test* / *viết tài liệu* là run *Làm task* với chỉ dẫn mẫu của vai; *review* là run review.

**Engine** (`packages/core/src/roles.ts`, `sqlite.ts`):
- `runs.roles { project, taskId, title?, machineId | null, steps: Array<{ step: 'code' | 'test' | 'docs' | 'review', profileId | null, instructions ≤2000 }> (2–6) }` → `RunGroup` (quyền `runDispatch` như `runs.dispatch`, không cần `taskManage` vì không tạo task; có trong `AUDITED`). Kiểm như `runs.dispatch`: task thuộc dự án, chưa xong, không trong luồng đang chạy, không trong đợt khác còn mở; máy (null = máy còn nhiều chỗ nhất lúc gửi) online, nhận run, có repo; gói ghim có trên máy; bước đầu qua `#assertDispatchable` (không yêu cầu/run nào của task đang chờ, trần chi tiêu); ký tự ẩn và secret trong chỉ dẫn. Lỗi thì không tạo gì.
- Nhóm `roles`: `max_parallel` 1, `parent_task` = task, `machine_id` = máy của mọi bước, `review_after` 0 (review là một bước). Mỗi bước một mục (cùng `task_id`), cột mới `run_group_items.step` (migration cuối `MIGRATIONS`) vì `role` không phân biệt được code/test/docs. `code`/`test`/`docs` → run `implement`, `review` → run `review`. Chỉ dẫn của mục = ngữ cảnh chuỗi do hub viết (`stepInstructions`: các bước, bước này là bước mấy, làm tiếp trên commit của bước trước, để phần của bước sau cho bước sau) + chỉ dẫn của người (giao diện điền sẵn mẫu của vai *viết test* / *viết tài liệu*, chữ trong i18n).
- `#rolesStep` trong `#releaseGroups`: đi theo `position`; mục đang chạy thì chờ; mục `held` chỉ được thả khi mọi mục trước có run `succeeded`. Một bước không gửi được, máy từ chối/hết hạn, run không `succeeded`, hoặc máy nhận mà không báo run sau 10 phút → các bước sau `cancelled`, nhóm `phase` `stopped` + `phase_error` (`errors.rolesStepFailed`). Mọi bước xong → `phase` `done`. Đang chạy thì `phase` null.
- `#assertNotInGroup` nhìn mọi mục của task (trước chỉ mục đầu): giữa hai bước task vẫn thuộc chuỗi, không ai giao tay hay cho đợt khác.
- *Huỷ đợt* trên chuỗi → `stopped` (như map-reduce). `runs.resumeGroup` trên chuỗi `stopped` (chỉ cần `runDispatch`) đưa bước chưa `succeeded` đầu tiên và các bước sau về `held`; từ chối khi còn run đang chạy (`errors.rolesRunning`), vì bước bị huỷ khi run còn chạy sẽ chạy hai lần.

**Giao diện**:
- Trang *Task*: chọn đúng một task ở chế độ danh sách → nút *Chuỗi vai* trên thanh *Đã chọn*; hoặc *Chạy theo chuỗi vai* trong bảng chi tiết task (ai có `runDispatch`, chế độ hub). Hộp *Chuỗi vai trên <task>* (`RolesSheet`, `AgentSheets.tsx`): máy (*Máy rảnh* được), các bước (mặc định viết code → viết test → review; mỗi bước vai, gói, chỉ dẫn; *Thêm bước* / *Bỏ bước*, 2–6 bước), tên đợt.
- Trang *Đợt chạy*: thẻ *Nhiều vai* có *Task: <task>*, máy, nhãn *Bước n/m* / *Xong chuỗi* / *Đã dừng*, lý do dừng và *Chạy lại*; mỗi hàng là một bước (`1. Viết code`…), máy · gói, trạng thái run.

**Test**: core `packages/core/test/roles.test.ts`: nâng cấp schema 0.139 giữ dữ liệu cũ; chờ classify và giữ model router; huỷ bước cuối rồi nhận thành công không chạy lại cả chuỗi; thả lần lượt, bước sau chờ run bước trước, task bị giữ giữa các bước; dừng khi một bước lỗi và chạy lại từ bước đó; mọi bước trên máy đã chọn dù máy khác rảnh hơn; huỷ rồi chạy lại không chạy một bước hai lần; kiểm lúc gửi và quyền (`runDispatch` đủ, `member` bị từ chối). e2e `roles`: Lan chọn một task, chuỗi 3 bước với hai gói trên máy của mình; bước viết test lỗi → *Đã dừng*, review không chạy; *Chạy lại* → bước test chạy lại, rồi review → *Xong chuỗi*.

Chưa làm: chuỗi chỉ chạy trên một máy (chưa đi tiếp từ branch đã lên remote trên máy khác); chưa chọn chuỗi vai từ *Bản đồ agent*.

## Chưa làm trong mục 31

- Giám khảo tự động cho fan-out.
- Hub kiểm phiên bản tối thiểu của máy khi tự thả mục máy rảnh (kiểm này hiện ở `apps/web/src/app.ts`, ngoài core).
