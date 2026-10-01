# 27b–d. Trần chi tiêu, nhật ký agent, dừng mọi agent

Viết ngày 1/10, sau nghiên cứu cách các AI orchestrator khác quản trị agent. Mỗi phần là một task: R-27b, R-27c, R-27d. Ba task không phụ thuộc nhau. Cả ba dùng chung các cơ chế sẵn có:
- **heartbeat**: hub trả lệnh cho máy (xem `syncCommands`, `cancelRuns`, `runRequests` trong `machines.heartbeat`);
- **audit**: `hive.audit` và bảng `AUDITED` trong `packages/core/src/sqlite.ts`;
- **cảnh báo**: `apps/web/src/alerts.ts`;
- **chi phí**: bảng `run_costs` và `costs.summary`.

## R-27b. Trần chi tiêu

**Mô hình**
- Một trần (`Budget`) gồm:
  - `scope`: `{ kind: "project", project }`, `{ kind: "user", user }` (người yêu cầu run) hoặc `{ kind: "hub" }`;
  - `period`: `"day"` hoặc `"month"`, tính theo giờ của hub;
  - `limit`: `{ usd?: number, runs?: number }`, ít nhất một trong hai.

  Lưu ở bảng settings, key `budgets`. Method:
  - `budgets.list` (viewer) trả về mỗi trần kèm phần đã dùng trong kỳ: usd và số run.
  - `budgets.set` (admin hub): thay cả danh sách.
- **Phần đã dùng**:
  - usd: tổng `cost_usd` của `run_costs` trong kỳ. Lọc theo project, hoặc theo người yêu cầu run.
  - Người yêu cầu run: thêm cột `requested_by` vào `run_costs`. Máy báo cột này qua `runs.report`, lấy từ run request, hoặc từ chủ token của máy khi run chạy từ Board.
  - runs: số run kết thúc trong kỳ, cùng nguồn.

**Ép trần**
- Hết trần thì `runs.dispatch` từ chối với HiveError `"conflict"`, key `errors.budgetExceeded`, vars là trần nào và đã dùng bao nhiêu.
- Heartbeat trả `budgetBlocked: [{ project | user, key, vars }]`. Runner không bắt đầu run mới cho dự án hay người bị chặn, kể cả run chạy từ Board. Run nằm lại ở *Hàng đợi* với lý do. Run đang chạy không bị dừng.
- Cảnh báo: thêm luật `budget_near` ở 70% và 90%, luật `budget_exceeded` khi chạm 100%. Cả hai đi qua webhook như các luật khác.

**Giao diện**: thẻ *Trần chi tiêu* trên trang *Chi phí* của Web Admin:
- mỗi trần một dòng, với thanh đã dùng / trần;
- admin thêm, sửa, xoá ngay tại đó.

**Test**:
- tính phần đã dùng theo kỳ, cả lúc qua ngày và qua tháng;
- dispatch bị từ chối khi hết trần;
- heartbeat trả `budgetBlocked`;
- runner không bắt đầu run cho dự án bị chặn;
- luật cảnh báo mở ở 70%.

## R-27c. Nhật ký agent và không tự duyệt

**Nhật ký**
- Shim MCP (`packages/mcp`) gửi thêm header `x-hive-run` từ biến `HIVE_RUN` mà runner đã đặt (xem `installer.ts` `runMcpServers`). `tokenActor` trong `apps/web/src/app.ts` đặt nó vào `actor.run`.
- Mọi method ghi của agent (task, tài liệu, đề xuất, memory, chat) được ghi một dòng audit. Dòng audit có thêm các cột:
  - `agent`: nhãn `x-hive-agent`, ví dụ `claude-1`;
  - `on_behalf`: tài khoản sở hữu token;
  - `run`: id run.

  Hiện nay chỉ các method trong `AUDITED` được ghi. Phần này thêm danh sách `AGENT_AUDITED` cho các method ghi khi actor là agent (có `source` là `"mcp"`, hoặc có nhãn agent).
- `admin.audit` nhận thêm các lọc `agent`, `user`, `run`.
- Trang *Nhật ký* của Web Admin:
  - có ô lọc theo agent, người và run;
  - bấm vào id run thì mở run trên trang *Lượt chạy*.

**Không tự duyệt**
- Người không được tự duyệt kết quả của chính mình. Có ba trường hợp:
  - duyệt một đề xuất do chính người đó viết;
  - duyệt một memory do chính người đó ghi;
  - chuyển sang *Xong* một task mà run làm nó do chính người đó yêu cầu.

  "Chính người đó" gồm cả agent chạy bằng token của người đó. Hub từ chối với HiveError `"forbidden"`, key `errors.selfApprove`.
- Ngoại lệ: setting `selfApproval: "admins" | "nobody"` trên trang *Chính sách*, mặc định `"admins"`. Với `"admins"`, admin hub được tự duyệt. Lý do: một hub chỉ có một người, mà agent của người đó lại chạy bằng token của chính người đó.
- MR watcher chuyển task sang *Xong* khi MR merge. Merge trên GitLab hay GitHub đã là một lần người khác duyệt, nên watcher không bị luật này chặn. Ghi chú này vào code.

**Test**:
- dòng audit của agent có đủ agent, on_behalf và run;
- lọc `admin.audit` theo từng trường;
- tự duyệt bị từ chối với member và reviewer;
- admin được tự duyệt khi `"admins"`, bị từ chối khi `"nobody"`;
- watcher vẫn chuyển được task sang *Xong*.

## R-27d. Dừng mọi agent

- **Method**:
  - `agents.stop { project: string | null }`: `null` là cả hub và cần admin hub; một dự án cần quyền `runDispatch` của dự án đó. Method này:
    1. huỷ mọi run request đang chờ của phạm vi đó;
    2. gửi lệnh dừng mọi run đang chạy, qua `cancelRuns` của heartbeat như `runs.cancel`;
    3. đặt cờ tạm ngưng: setting `paused: { hub: boolean, projects: string[] }`.
  - `agents.resume { project: string | null }`: gỡ cờ tạm ngưng.

  Cả hai đều ghi audit và phát event cho webhook.
- **Khi đang tạm ngưng**:
  - `runs.dispatch` và chat leader bị từ chối với key `errors.agentsPaused`.
  - Heartbeat trả `paused`. Runner dừng run đang chạy của phạm vi đó và không bắt đầu run mới, kể cả run chạy từ Board.
  - App hiện một dải báo trên Board: "Agent của <dự án> đang tạm ngưng bởi <ai> lúc <giờ>".
- **Giao diện**:
  - nút *Dừng mọi agent* trên Tổng quan của Web Admin, cho cả hub;
  - nút cùng tên trên trang dự án, cho một dự án;
  - hộp xác nhận ghi rõ sẽ huỷ bao nhiêu request và dừng bao nhiêu run;
  - khi đang tạm ngưng, nút đổi thành *Cho agent chạy lại*.
- **Test**:
  - stop huỷ request, gửi `cancelRuns` và đặt cờ;
  - dispatch bị từ chối khi đang ngưng;
  - runner dừng run đang chạy và không bắt đầu run mới khi heartbeat báo ngưng;
  - resume gỡ cờ;
  - quyền: lead dừng được dự án của mình, không dừng được cả hub.
