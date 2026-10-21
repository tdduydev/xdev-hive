# Feature Specification: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy

**Feature Branch**: `ai/SPEC027`

**Created**: 2026-10-20

**Status**: Đã chốt Q1–Q3 (2026-10-20). Có plan (2026-10-21), chưa có tasks, chưa code.

**Input**: Chủ dự án (2026-10-20): "với hệ thống này dữ liệu, và tiến độ dự án để trên server, và client sẽ làm hết qua
tools client thì mình nên làm thế nào? review qua kiến trúc hiện tại đi", rồi "dùng spec để viết spec chuyển đổi đi".

## Vì sao làm

Mô hình mong muốn:
- **Hub** (server) là nơi duy nhất giữ dữ liệu và tiến độ dự án: task, run, trạng thái, tài liệu, memory, audit.
- **Client** làm mọi việc trên máy người dùng. Client gồm app desktop, `hive` CLI, `hive-worker`, Claude Code/Codex có
  MCP của Hive, và VS Code extension (ADR 0027).

Kiến trúc hiện tại đã theo mô hình này ở phần lõi (mục "Hiện trạng"). Bản review ngày 2026-10-20 tìm ra bốn chỗ hở:

1. **Hub vắng là mất tiến độ.** Chỉ worker có bộ đệm trên đĩa, và chỉ cho run do hub giao. Việc làm ngoài run không có
   bộ đệm: Claude Code cục bộ gọi MCP, desktop gửi đề xuất tài liệu và skill. Hub không trả lời thì lần ghi đó lỗi.
2. **Nhiều đường ghi tiến độ, mỗi đường một kiểu:** `run_event` của worker, tool MCP (`task_update`, `doc_propose`,
   `memory_write`…), và `hub_rpc`/`hub_tool` của desktop. Không có quy ước chung về khoá chống trùng và nguồn gửi.
3. **Token dài hạn.** Machine token `hwm_…` sống tới khi bị thu hồi. Run push bằng thông tin git sẵn có trên máy. MCP
   OAuth cần HTTPS.
4. **Server chưa đủ bền để làm nguồn duy nhất.** Chỉ có `pg_dump`, một container `api,jobs`.

**Ràng buộc:** hub cũ ở 192.0.2.10 (hive.example.com) đã bị gỡ sau cảnh báo SOC. Hiện không có hub nào chạy. Spec này
**không** chọn nơi đặt hub, không mở cổng, không đo mạng tới máy nội bộ. Các việc đó cần SOC và chủ dự án đồng ý
(FR-060). Spec chỉ mô tả điều hub và client phải đáp ứng. Theo Q2, phần token làm song song, không chặn việc xin mở
lại hub.

> Correction: bản review ngày 2026-10-20 gọi "API evidence của spec 026 T014" là một đường ghi lên hub. Điều đó sai.
> T014 lấy bằng chứng từ GitHub/GitLab, và spec 026 FR-040 không gửi gì lên hub. Spec này không đổi spec 026.

## Câu hỏi đã chốt

Chủ dự án chốt ngày 2026-10-20:

| # | Câu hỏi | Khuyến nghị | Chốt | Ghi ở |
|---|---|---|---|---|
| Q1 | Khi hub vắng, hộp thư đi giữ những loại ghi nào? | Tiến độ và đề xuất | **Tiến độ và đề xuất** | FR-012 |
| Q2 | Phải làm xong gì trước khi xin SOC mở lại hub? | Đủ token và che secret | **Không chặn, làm song song** | FR-062 |
| Q3 | Hub nhận log terminal đầy đủ hay chỉ siêu dữ liệu? | Đầy đủ, có che secret | **Chỉ siêu dữ liệu** | FR-051, FR-055 |

Hệ quả của hai lựa chọn khác khuyến nghị:
- **Q2:** việc xin mở lại hub không phải chờ US3. Hồ sơ gửi SOC (FR-061) phải ghi rõ phần nào chưa làm và khi nào làm,
  để SOC tự quyết. [Suy luận] SOC có thể đòi US3 trước khi cho mở lại hub; khi đó hàng việc đổi theo SOC.
- **Q3:** log terminal không rời máy đã chạy run. Web và app desktop hiện đọc log run từ hub
  (`apps/web/src/lib/run-stream.ts`, `apps/desktop/src/screens/home-screen.tsx:570`), nên phải đổi (FR-055). RMT-03 của
  spec 010 (ghi output phiên lên hub, đang ở trạng thái Planned) cũng phải sửa theo.

## Hiện trạng: dùng lại, mở rộng, làm mới

Đã kiểm trong code ngày 2026-10-20:

| Phần | Có gì | Spec này |
|---|---|---|
| Worker ↔ hub | WSS do worker gọi ra. Gói chưa ack nằm trong `DataDir/pending` (`worker/internal/channel/channel.go:67,280`). Hub loại trùng theo `(run_id, attempt, seq)` | Dùng lại cơ chế gửi lại, mở rộng cho việc ngoài run |
| Socket cục bộ | `worker/internal/localipc`: Unix socket 0600 kiểm UID, named pipe trên Windows (ADR 0019) | Dùng lại làm đường vào hộp thư đi |
| MCP cục bộ | `hive mcp` là proxy MCP stdio → hub (`worker/cmd/hive/mcp.go`) | Mở rộng: đi qua hộp thư đi khi hub vắng |
| Desktop → hub | Lệnh Rust `hub_rpc`, `hub_tool` gắn token cá nhân lưu trong keychain (`apps/desktop/src/lib/hub-rpc.ts`) | Đưa các lần ghi qua hộp thư đi |
| Tool MCP ghi | `task_update`, `memory_write`, `doc_propose`, `doc_comment`, `skill_propose`, `plan_submit`, `review_submit`, `sdlc_report`… (`apps/hub/src/modules/mcp/registry.ts`) | Thêm khoá chống trùng và nguồn gửi |
| Token | Machine token đến khi thu hồi; run token JWT; khoá máy và token git **[Chưa làm]** (`docs/architecture.md` §6) | Làm mới |
| Giữ log | Chính sách giữ log (POL-05) và audit (OPS-07) đã có. Log run lưu ở bảng `run_logs` trên hub (`apps/hub/src/modules/runs/retention.ts`) | Log ở lại máy; chính sách giữ log áp ở máy |
| Xem log run | Web xem log qua SSE (`apps/web/src/lib/run-stream.ts`). Desktop đọc `hub.runs.logs` (`home-screen.tsx:570`) | Đổi: hub chỉ có siêu dữ liệu; log đọc tại máy đã chạy (FR-055) |
| Backup | `deploy/backup.sh` (`pg_dump`); pgBackRest **[Chưa làm]** (§10) | Làm mới |
| Triển khai | Một container hub vai trò `api,jobs` (§10) | Tách vai trò khi chạy |

## Khái niệm

- **Nguồn sự thật**: hub. Trạng thái task/run chỉ do hub suy ra từ sự kiện nó đã nhận.
- **Sự kiện client**: một lần client báo việc đã làm hoặc xin làm ("task X sang review", "đề xuất tài liệu Y"). Mỗi sự
  kiện có khoá chống trùng, nguồn gửi, máy gửi, thời điểm tạo trên máy.
- **Nguồn gửi**: `worker-run`, `desktop`, `hive-cli`, `mcp-local`, `vscode`.
- **Hộp thư đi**: hàng đợi trên đĩa của máy, do `hive-worker` giữ, chứa sự kiện client chưa được hub xác nhận.
- **Kết quả xử lý**: hub trả cho mỗi sự kiện một trong các kết quả `accepted`, `duplicate`, `rejected` (kèm lý do).
- **Mở lại hub**: lần đầu hub được chạy lại ở nơi SOC đồng ý và client được phép kết nối.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Một hợp đồng ghi tiến độ cho mọi client (Priority: P1)

Dev dùng Claude Code cục bộ báo task sang "review". Cùng lúc, worker đang chạy run của task đó báo kết quả. App desktop
gửi đề xuất tài liệu. Cả ba đi qua cùng một dạng sự kiện. Hub ghi nhận, loại trùng, suy ra trạng thái, và lưu được ai
gửi từ đâu.

**Why this priority**: là nền cho hộp thư đi (US2). Không có khoá chống trùng thì gửi lại sẽ ghi hai lần.

**Independent Test**: gửi cùng một sự kiện hai lần từ hai nguồn giả lập. Hub ghi một lần, lần hai trả `duplicate`.
Trạng thái task chỉ đổi một lần.

**Acceptance Scenarios**:

1. **Given** một sự kiện có khoá K đã được nhận, **When** client gửi lại K, **Then** hub trả `duplicate`, không đổi dữ
   liệu và không ghi audit lần hai.
2. **Given** task đã bị huỷ trên hub, **When** client gửi "task sang review", **Then** hub trả `rejected` kèm lý do, và
   trạng thái task giữ nguyên.
3. **Given** một client gửi sự kiện có trường trạng thái đích, **When** hub xử lý, **Then** hub kiểm chuyển trạng thái
   theo luật của mình. Client không ghi đè trạng thái trực tiếp.
4. **Given** sự kiện đã được nhận, **When** admin xem lịch sử task, **Then** thấy nguồn gửi, máy, người, thời điểm tạo
   trên máy và thời điểm hub nhận.

---

### User Story 2 - Làm việc tiếp khi hub vắng (Priority: P1)

Hub mất kết nối trong 3 giờ. Dev vẫn mở app desktop, chạy Claude Code với MCP của Hive, cập nhật task, gửi đề xuất tài
liệu. App hiện "Hub đang vắng – N mục chờ gửi". Khi hub trở lại, máy tự gửi theo đúng thứ tự, rồi báo mục nào được nhận,
mục nào bị từ chối.

**Why this priority**: tình trạng hiện nay là không có hub. Đây là chỗ hở lớn nhất của mô hình.

**Independent Test**: tắt hub giả lập, ghi 20 sự kiện từ desktop, `hive` CLI và proxy MCP, khởi động lại máy, bật hub.
Cả 20 tới hub, đúng thứ tự trong từng task, không trùng.

**Acceptance Scenarios**:

1. **Given** hub không trả lời, **When** Claude Code gọi tool ghi qua `hive mcp`, **Then** tool trả "đã xếp hàng, chờ
   hub" kèm khoá sự kiện, không trả lỗi.
2. **Given** hub không trả lời, **When** Claude Code gọi tool **đọc** (vd. `doc_get`), **Then** tool trả lỗi rõ ràng
   "Hub đang vắng", không trả dữ liệu cũ như thể là mới.
3. **Given** hộp thư đi có mục, **When** máy khởi động lại, **Then** các mục vẫn còn và được gửi khi hub trở lại.
4. **Given** hub trả `rejected` cho một mục, **When** người dùng mở app, **Then** thấy mục đó, lý do, và có nút "Bỏ" hoặc
   "Mở trên hub".
5. **Given** hộp thư đi chạm giới hạn dung lượng (FR-016), **When** client ghi tiếp, **Then** lần ghi bị từ chối với
   thông báo tiếng Việt. Không xoá mục cũ để lấy chỗ.

---

### User Story 3 - Token ngắn hạn (Priority: P1)

Máy không giữ token dài hạn có quyền gọi API. Push git dùng token theo repo, có hạn. Người dùng dùng MCP ngoài run qua
HTTPS và OAuth.

**Why this priority**: [Suy luận] SOC sẽ xét phần này. Theo Q2, US3 làm song song và không chặn việc xin mở lại hub.

**Independent Test**: lấy cắp `worker.json` của một máy rồi dùng sau 20 phút. Hub từ chối vì không có khoá máy.
Token git cấp cho run A không push được vào repo của dự án B.

**Acceptance Scenarios**:

1. **Given** máy đã đăng ký, **When** worker kết nối, **Then** worker ký challenge bằng khoá máy, nhận access token hạn
   khoảng 15 phút, và tự đổi token trước khi hết hạn.
2. **Given** chỉ có machine token mà không có khoá máy, **When** kết nối tới hub, **Then** hub từ chối.
3. **Given** run cần push, **When** worker nhận lease, **Then** hub cấp token git chỉ cho repo của dự án, hết hạn cùng
   run. Run không dùng thông tin git sẵn có trên máy.
4. **Given** người dùng gắn MCP của Hive vào Claude Code ngoài run, **When** kết nối, **Then** đăng nhập qua OAuth trên
   HTTPS. Token có `aud=/mcp` và không dùng được cho API khác.
5. **Given** admin thu hồi một máy, **When** máy đó đổi token lần kế, **Then** bị từ chối trong vòng 15 phút.

---

### User Story 4 - Hub đủ bền để làm nguồn duy nhất (Priority: P2)

Admin vận hành khôi phục được database về một thời điểm bất kỳ trong khoảng giữ lại. Mỗi tháng có một lần diễn tập khôi
phục, có biên bản. Nâng cấp hub không làm client mất sự kiện.

**Why this priority**: dữ liệu chỉ nằm ở hub thì mất hub là mất dự án. Làm sau US1–US3 vì hub hiện chưa chạy.

**Independent Test**: ghi dữ liệu, ghi lại thời điểm T, ghi tiếp, khôi phục về T trên máy diễn tập. Dữ liệu khớp đúng T.

**Acceptance Scenarios**:

1. **Given** hub đang chạy, **When** admin khôi phục về thời điểm T, **Then** database có đúng các giao dịch đã commit
   trước T.
2. **Given** lịch diễn tập hằng tháng, **When** diễn tập xong, **Then** có biên bản ghi thời gian khôi phục và kết quả
   so khớp.
3. **Given** hub khởi động lại để nâng cấp, **When** client đang gửi sự kiện, **Then** sự kiện ở lại hộp thư đi và được
   gửi khi hub chạy lại. Không mất sự kiện nào.
4. **Given** vai trò `jobs` bị treo, **When** client gọi API, **Then** vai trò `api` vẫn trả lời.

---

### User Story 5 - Ranh giới dữ liệu: code và secret ở lại máy (Priority: P2)

SOC hỏi: "hub giữ những gì?". Admin trả lời bằng một trang liệt kê các loại dữ liệu hub nhận. Code, secret, tài khoản AI
và log terminal không có trong danh sách. Người xem run trên web thấy pha, thời gian, mã thoát, chi phí. Muốn đọc log
đầy đủ thì mở app desktop trên máy đã chạy run.

**Why this priority**: phạm vi dữ liệu là điều SOC xét. Q3 chốt: log ở lại máy.

**Independent Test**: chạy một run in ra một secret của dự án. Database và mọi request tới hub không chứa chuỗi log
terminal của run đó. App desktop trên máy chạy run vẫn mở được log đầy đủ.

**Acceptance Scenarios**:

1. **Given** một run đang chạy, **When** worker báo tiến độ, **Then** hub chỉ nhận siêu dữ liệu (FR-051). Không có gói
   log terminal nào rời máy.
2. **Given** run đã xong trên máy của mình, **When** chủ máy mở run trong app desktop, **Then** thấy log đầy đủ đọc từ
   máy.
3. **Given** người dùng xem run trên web, hoặc trên app desktop của máy khác, **Then** thấy siêu dữ liệu kèm câu "Log
   nằm trên máy <tên máy>", không có nút xem log.
4. **Given** chính sách giữ log của tổ chức là N ngày, **When** quá N ngày, **Then** máy xoá log của run cũ hơn N ngày.
   Hub xoá artifact theo chính sách của nó và ghi audit.
5. **Given** admin mở trang "Dữ liệu hub giữ", **Then** thấy danh sách loại dữ liệu, nguồn, thời gian giữ, đúng với
   FR-050.

---

### Edge Cases

- Hai máy của cùng một người gửi sự kiện mâu thuẫn cho một task khi hub vắng. Hub xử lý theo thời điểm nhận. Sự kiện
  không hợp lệ với trạng thái lúc đó thì bị `rejected`.
- Đồng hồ máy lệch. Thời điểm tạo trên máy chỉ để hiển thị, không dùng để sắp thứ tự giữa các máy.
- Phiên bản client cũ, chưa gửi khoá chống trùng. Hub vẫn nhận trong giai đoạn chuyển tiếp (FR-005) và ghi cảnh báo.
- Người dùng đăng xuất khi hộp thư đi còn mục. App hỏi gửi trước, giữ lại hay bỏ. Mục giữ lại không gửi bằng danh tính
  của người khác.
- Máy bị thu hồi khi hộp thư đi còn mục. Hub từ chối các mục đó. App hiện lý do và cho xuất ra file để người dùng tự xử
  lý.
- Sự kiện chứa nội dung lớn (đề xuất tài liệu có ảnh). Hộp thư đi giữ nguyên nội dung trong giới hạn kích thước một mục
  (FR-016).
- Hub trở lại sau khi đã khôi phục về thời điểm cũ hơn sự kiện máy đã gửi. Máy không biết hub đã quên. [Suy luận] Cần
  một "mã đời database" để máy phát hiện và gửi lại (FR-042).
- Máy đã chạy run bị tắt, bị thu hồi hay cài lại. Log của run đó mất. Hub vẫn giữ siêu dữ liệu và báo cáo agent (Q3).
- Reviewer cần log của run trên máy người khác để duyệt. Reviewer dùng báo cáo agent và kết quả kiểm tra trên hub, hoặc
  nhờ chủ máy gửi đoạn log cần thiết qua bình luận (gửi có chủ đích, đã qua bước che ở FR-052).
- Worker không chạy nhưng app desktop đang mở. App báo "Sidecar không chạy" và không ghi trực tiếp lên hub, bỏ qua hộp
  thư đi.

## Requirements *(mandatory)*

### Functional Requirements

**Hợp đồng sự kiện (US1)**

- **FR-001**: Mọi lần client ghi lên hub mang một khoá chống trùng duy nhất do client tạo, một nguồn gửi trong danh sách
  ở mục "Khái niệm", và thời điểm tạo trên máy.
- **FR-002**: Hub giữ khoá chống trùng đủ lâu để loại trùng mọi lần gửi lại hợp lệ, ít nhất bằng thời gian hộp thư đi
  giữ mục (FR-015). Lần gửi trùng trả `duplicate`, không đổi dữ liệu.
- **FR-003**: Hub là nơi duy nhất quyết định chuyển trạng thái task/run. Sự kiện của client là đề nghị. Hub trả
  `rejected` kèm lý do khi đề nghị không hợp lệ với trạng thái hiện tại.
- **FR-004**: Áp dụng cho `run_event`/`run_result` của worker, mọi tool MCP có ghi, và mọi lệnh ghi của desktop
  (`hub_rpc`, `hub_tool`). Đường worker giữ cách loại trùng hiện có theo `(run_id, attempt, seq)`.
- **FR-005**: Giai đoạn chuyển tiếp: hub nhận lần ghi không có khoá trong ít nhất hai bản phát hành, ghi cảnh báo theo
  phiên bản client, rồi mới từ chối. Thay đổi hợp đồng giữ tương thích với worker đã cài (constitution I).
- **FR-006**: Lịch sử task hiện nguồn gửi, máy, người, thời điểm tạo và thời điểm nhận của từng sự kiện.

**Hộp thư đi (US2)**

- **FR-010**: `hive-worker` giữ hộp thư đi trên đĩa. File và thư mục chỉ người dùng đó đọc được (0600/0700, DACL tương
  đương trên Windows). Hàng tồn qua khởi động lại máy.
- **FR-011**: Desktop và `hive` CLI đưa sự kiện vào hộp thư đi qua socket cục bộ của ADR 0019. `hive mcp` đưa lần gọi
  tool ghi vào hộp thư đi khi hub không trả lời.
- **FR-012** (Q1): Khi hub vắng, hộp thư đi xếp hàng hai nhóm:
  - tiến độ task/run: `task_update`, `sdlc_report`, kết quả run;
  - đề xuất có người duyệt sau: `doc_propose`, `doc_comment`, `skill_propose`, `memory_write`, `plan_submit`,
    `review_submit`.

  Tool tạo tác động ngay, như `leader_action` và `artifact_create`, báo lỗi "Hub đang vắng" và không xếp hàng. Thêm
  tool ghi mới thì phải ghi rõ tool đó thuộc nhóm nào.
- **FR-013**: Tool đọc không có bộ đệm. Khi hub vắng, tool đọc trả lỗi "Hub đang vắng", không trả dữ liệu cũ.
- **FR-014**: Gửi theo thứ tự tạo trong từng task (hay từng tài liệu, từng skill). Một mục bị `rejected` không chặn các
  mục của task khác.
- **FR-015**: Mục chưa gửi được giữ 14 ngày. Hết hạn thì chuyển sang "Hết hạn". App vẫn hiện để người dùng xuất ra file
  hoặc bỏ. Không tự xoá âm thầm.
- **FR-016**: Giới hạn mặc định 200 MB cho cả hộp thư đi và 20 MB cho một mục. Chạm giới hạn thì từ chối ghi mới với
  thông báo tiếng Việt.
- **FR-017**: App desktop và khay hiện trạng thái hub (có, vắng, đang gửi lại), số mục chờ, và danh sách mục bị từ chối.
  `hive` CLI có lệnh tương đương.
- **FR-018**: Mỗi mục gắn với danh tính đã tạo ra nó. Không gửi mục của người A bằng token của người B.

**Token và mở lại hub (US3)**

- **FR-020**: Máy tạo cặp khoá lúc đăng ký. Khoá riêng nằm trong keychain hoặc kho khoá của hệ điều hành khi có. Hub chỉ
  lưu khoá công khai.
- **FR-021**: Worker và runner host đổi chữ ký challenge lấy access token hạn khoảng 15 phút. Machine token cũ chỉ còn
  dùng để đăng ký khoá máy lần đầu sau khi nâng cấp, rồi hết hiệu lực.
- **FR-022**: Thu hồi máy có hiệu lực trong vòng một hạn access token.
- **FR-023**: Hub cấp token git cho từng run: chỉ repo của dự án, quyền tối thiểu để push nhánh của run, hết hạn cùng
  run. Lấy từ GitHub App installation token hoặc GitLab project token.
- **FR-024**: MCP cho người dùng ngoài run dùng OAuth trên HTTPS. Token có `aud` là `/mcp`. Cổng MCP không chuyển tiếp
  token xuống dịch vụ khác.
- **FR-025**: Token cá nhân của desktop và `hive` CLI chỉ nằm trong keychain, không ghi ra file cấu hình hay log.

**Độ bền server (US4)**

- **FR-040**: Backup liên tục cho phép khôi phục về thời điểm bất kỳ trong khoảng giữ lại (mặc định 14 ngày), lưu ở nơi
  khác với máy chạy database.
- **FR-041**: Diễn tập khôi phục hằng tháng, có biên bản: thời gian khôi phục, thời điểm khôi phục tới, kết quả so khớp.
- **FR-042**: Hub có mã đời database, đổi sau mỗi lần khôi phục. Client thấy mã đổi thì gửi lại các mục hub đã xác nhận
  sau thời điểm khôi phục.
- **FR-043**: Vai trò `api` và `jobs` chạy được thành tiến trình riêng. Một vai trò treo không chặn vai trò kia.
- **FR-044**: Nâng cấp hub không làm mất sự kiện client. Client giữ trong hộp thư đi trong lúc hub khởi động lại.

**Ranh giới dữ liệu (US5)**

- **FR-050**: Hub chỉ nhận:
  - siêu dữ liệu dự án, máy và run;
  - sự kiện client;
  - artifact, tài liệu và đề xuất mà người dùng hay agent chủ động gửi.

  Hub không nhận: log terminal, mã nguồn (trừ nội dung người dùng đưa vào tài liệu hay đề xuất), secret của máy, thông
  tin tài khoản AI.
- **FR-051** (Q3): Về run, hub chỉ nhận siêu dữ liệu: pha, thời gian, mã thoát, chi phí, `headSha`, kết quả kiểm tra, báo
  cáo agent (`agent_report`). Worker không gửi `log_chunk` và không gửi output phiên PTY. Log đầy đủ ở lại máy đã chạy
  run.
- **FR-052**: Mọi chuỗi chữ tự do gửi lên hub (báo cáo agent, lỗi, tóm tắt) đều qua bước che secret trên máy, rồi hub
  che thêm một lần khi nhận. Bước che xử lý mọi giá trị secret đã biết của dự án và các token có dạng đã biết.
- **FR-053**: Máy xoá log run theo chính sách giữ log của tổ chức (POL-05), lấy từ hub ở lần kết nối gần nhất. Hub xoá
  artifact theo chính sách của mình và ghi audit mỗi lần xoá.
- **FR-054**: Có trang "Dữ liệu hub giữ" cho admin, liệt kê loại dữ liệu, nguồn và thời gian giữ, khớp FR-050.
- **FR-055**: Xem log run:
  - Web và desktop của máy khác chỉ hiện siêu dữ liệu, kèm câu "Log nằm trên máy <tên máy>".
  - Desktop của máy đã chạy run đọc log từ đĩa máy.
  - Run trên runner host hay trong container sandbox thì log ở lại runner host, giữ theo FR-053. Quản trị máy đó đọc
    tại chỗ.
  - Hub ngừng ghi `run_logs`. Dữ liệu cũ trong bảng bị xoá theo chính sách hiện có, không chuyển đi đâu.

**Điều kiện mở lại hub**

- **FR-060**: Spec này không chọn nơi đặt hub, không mở cổng, không đo mạng tới máy nội bộ. Việc mở lại hub chỉ diễn ra
  khi SOC và chủ dự án đồng ý bằng văn bản.
- **FR-061**: Có tài liệu một trang gửi SOC, gồm:
  - dữ liệu hub giữ (FR-050, FR-051);
  - cách xác thực máy và người hiện tại, và theo FR-020…FR-025;
  - cổng cần mở;
  - chiều kết nối (chỉ client gọi ra hub);
  - backup (FR-040).
- **FR-062** (Q2): Việc xin mở lại hub không chờ US3 xong. Tài liệu FR-061 ghi trạng thái từng mục FR-020…FR-025 (đã
  làm hay chưa, dự kiến khi nào). SOC đòi mục nào là điều kiện thì mục đó lên trước trong hàng việc.

### Key Entities

- **Sự kiện client**: khoá chống trùng, nguồn gửi, máy, người, tổ chức, loại, đối tượng (task, run, tài liệu, skill),
  nội dung, thời điểm tạo trên máy, thời điểm nhận, kết quả xử lý, lý do từ chối.
- **Mục hộp thư đi** (trên máy): sự kiện client, danh tính đã tạo, số lần thử, lần thử cuối, trạng thái (chờ, đang gửi,
  đã nhận, từ chối, hết hạn).
- **Khoá máy**: khoá công khai, máy, thời điểm đăng ký, thời điểm thu hồi.
- **Access token máy**: máy, hạn dùng. Không lưu trên hub, chỉ kiểm chữ ký.
- **Token git của run**: run, repo, quyền, hạn dùng. Không lưu giá trị.
- **Mã đời database**: giá trị đổi sau mỗi lần khôi phục.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Tắt hub 3 giờ trong lúc 3 người làm việc bình thường. Bật lại thì 100% sự kiện tới hub, 0 bản trùng, và
  thứ tự trong từng task đúng.
- **SC-002**: Khi hub vắng, người dùng làm được mọi việc trong phạm vi Q1 mà không gặp thông báo lỗi. Mỗi việc có thông
  báo rõ "đang chờ gửi".
- **SC-003**: Sau khi hub trở lại, 95% mục chờ được gửi xong trong 1 phút với hàng 1.000 mục.
- **SC-004**: Token máy hoặc token git lấy cắp được không dùng được quá 15 phút sau khi thu hồi máy, hoặc sau khi run
  kết thúc.
- **SC-005**: Diễn tập khôi phục hằng tháng thành công 3 lần liên tiếp, mỗi lần khôi phục xong trong 1 giờ với database
  hiện tại.
- **SC-006**: Trong 100 run thử có in secret của dự án, hub nhận 0 byte log terminal và 0 giá trị secret.
- **SC-008**: Chủ máy mở được log đầy đủ của run trên máy mình trong 2 giây, với log 10 MB.
- **SC-007**: SOC nhận tài liệu FR-061 và trả lời được "hub giữ gì, ai gọi vào đâu" mà không cần hỏi thêm đội.

## Assumptions

- Hub vẫn chạy trên một server với Docker Compose. Tách vai trò là tách tiến trình, không thêm dịch vụ có trạng thái mới
  (constitution VII). Kho backup có thể là S3 hoặc thư mục trên máy khác. Chọn ở plan, cần ADR nếu thêm dịch vụ.
- Một máy có một `hive-worker` cho mỗi người dùng hệ điều hành (ADR 0019). Hộp thư đi theo người dùng đó.
- 14 ngày giữ mục và 200 MB là mặc định đủ cho một máy dev. [Suy luận] Chưa đo dung lượng thật.
- Spec 026 (nhánh Git trên desktop) không gửi gì lên hub và không đổi.
- VS Code extension (spec 017) dùng cùng đường `hive` CLI/socket cục bộ khi làm phần ghi.
- Hub được mở lại ở một nơi khác với 192.0.2.10. Nơi đó do SOC và chủ dự án chọn.

## Out of Scope

- Chọn máy, mạng, tên miền cho hub; mở cổng; đo mạng nội bộ (FR-060).
- Đọc dữ liệu khi hub vắng (bản sao cục bộ của tài liệu, memory, task).
- Đồng bộ hai chiều kiểu CRDT giữa các máy. Hub là nơi duy nhất quyết định.
- Đổi cách worker nhận job, lease và huỷ run.
- Chạy nhiều bản `api` để nâng cấp không gián đoạn. Ghi lại làm sau.
- Gom log run về hub, kể cả bản nén sau khi run xong (Q3).
