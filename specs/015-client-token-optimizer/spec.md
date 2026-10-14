# Feature Specification: Quản lý memory và bộ tối ưu token trong app client

**Feature Branch**: `015-client-token-optimizer`

**Created**: 2026-10-14

**Status**: Draft (chờ product owner xem)

**Input**: Người dùng (2026-10-14): "thêm phần quản lý memory, và cách tối ưu memory, token, đánh giá luôn xem dưới máy
đã tối ưu token chưa, được thì tự xây dựng bộ tối ưu token cho app client, có thể dùng dạng embedded".

**Đánh giá đầu vào**: [research.md](research.md). Tóm tắt số đo 7 ngày trên máy dev:
- Phiên Claude mở trực tiếp chiếm 85% token quy đổi: tương tác 72,4%, `claude -p` ngoài worker 12,5%. Các phiên này
  không nhận tối ưu nào của worker.
- 84% chi phí phiên tương tác nằm ở những phiên có ngữ cảnh vượt 400k token.
- Memory của một dự án bị chia theo gói tài khoản.

**Kế hoạch**: [plan.md](plan.md) · **Task**: [tasks.md](tasks.md)

## Phạm vi

- Máy client là máy có app desktop (Tauri) và sidecar `hive-worker`. Người dùng chạy Claude Code, Codex, Gemini,
  Antigravity bằng:
  - terminal trong app;
  - "Gói agent" mở Terminal.app;
  - `CLAUDE_CONFIG_DIR` hoặc `CODEX_HOME` trỏ tới `~/.xdev-hive/accounts/<gói>`;
  - thư mục mặc định `~/.claude`, `~/.codex`.
- Mọi tính năng chạy được **offline, không cần đăng nhập hub**. Riêng đồng bộ memory với hub (US6) cần đăng nhập.
- Không đổi cách worker chạy run do hub giao. Bộ tối ưu dùng lại code worker, không thay nó.

## User Scenarios & Testing

### User Story 1 - Bật tối ưu token cho một gói (Priority: P1)

Người dùng mở màn Token, chọn một gói (vd `claude-3`) và bấm "Bật tối ưu". App ghi vào `settings.json` của gói:
- biến token Claude theo phiên bản CLI;
- hook cắt output tool lớn.

Codex thì app ghi một khối có đánh dấu vào `config.toml`. Mọi phiên mở bằng gói đó đều được áp, gồm terminal trong app,
Terminal.app và `claude -p` của agent chạy song song.

**Why this priority**: đây là đòn bẩy lớn nhất trong research.md (mục 7, dòng 1–2). Phần code chính đã có ở worker.

**Independent Test**: `HOME` giả có gói `claude-2`, trong đó `settings.json` có `theme` và một hook của người dùng. Kiểm:
1. Bật: `settings.json` có thêm `env` và hook của Hive, khoá cũ vẫn còn, có bản sao lưu.
2. Tắt: file trở lại giống hệt bản trước khi bật.

**Acceptance Scenarios**:

1. **Given** gói Claude chưa bật, **When** bật với mức "Cân bằng", **Then** `settings.json` có
   `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` và các trần output (bảng ở plan.md), cùng
   hook `PostToolUse` gọi `hive-worker hook post-tool --local`. Bản sao lưu nằm ở
   `~/.xdev-hive/optimizer/backups/<gói>/<thời điểm>.json`.
2. **Given** CLI cũ hơn phiên bản tối thiểu của một biến hay của `updatedToolOutput`, **When** bật, **Then** bỏ biến hoặc
   hook đó và màn hình ghi lý do. Bảng phiên bản dùng chung với worker.
3. **Given** người dùng đã tự đặt `env.BASH_MAX_OUTPUT_LENGTH`, **When** bật, **Then** giữ giá trị của người dùng và đánh dấu
   "người dùng đặt".
4. **Given** gói đang bật, **When** tắt, **Then** chỉ gỡ những gì Hive đã thêm. Khoá người dùng sửa sau khi bật thì giữ
   nguyên và báo lại. Không còn hook hay biến nào của Hive.
5. **Given** app bị gỡ hoặc không tìm thấy `hive-worker`, **When** CLI gọi hook, **Then** hook thoát 0 và phiên chạy bình
   thường (fail-open).
6. **Given** gói Codex, **When** bật, **Then** `config.toml` có khối `# >>> xdev-hive optimizer >>>` … `# <<< xdev-hive
   optimizer <<<` chứa `tool_output_token_limit` và `model_auto_compact_token_limit`. Tắt thì xoá đúng khối đó.
7. **Given** gói Gemini hoặc Antigravity, **Then** màn hình ghi "chưa hỗ trợ" và không ghi file nào.
8. **Given** thư mục mặc định `~/.claude` hoặc `~/.codex`, **Then** chỉ bật khi người dùng chọn riêng. Không bật kèm
   khi người dùng bấm "bật tất cả gói".

### User Story 2 - Thấy tiết kiệm trước và sau (Priority: P1)

Màn Token có bảng theo gói và theo nguồn phiên (tương tác, `-p`, worker). Mỗi dòng có:
- token quy đổi mỗi lượt và mỗi phiên;
- ngữ cảnh đỉnh trung vị, số phiên vượt 150k và 400k;
- tỉ lệ cache trúng;
- output tool tốn nhất.

Mỗi số có hai cột: trước và sau ngày bật tối ưu. Bảng có thêm số ký tự hook đã cắt, và số của `rtk gain` nếu có RTK.

**Why this priority**: phải đo được thì mới biết bật có lợi không. research.md cho thấy RTK gần như không giảm output
trên kiểu việc của máy này, nên không đoán thay đo.

**Independent Test**: thư mục transcript mẫu (fixture, không có dữ liệu thật) có hai nhóm phiên trước và sau mốc bật. Báo
cáo JSON ra đúng số từng cột.

**Acceptance Scenarios**:

1. **Given** máy có nhiều gói, **When** mở màn Token, **Then** app đọc transcript của mọi gói trong `~/.xdev-hive/accounts`
   và thư mục mặc định, không chỉ `CLAUDE_CONFIG_DIR` của tiến trình app.
2. **Given** gói bật tối ưu ngày D, **Then** cột "trước" là 7 ngày trước D, cột "sau" là từ D. Ít hơn 5 phiên thì ghi
   "chưa đủ dữ liệu".
3. Báo cáo chỉ có số tổng hợp, không có prompt, output hay đường dẫn. Nút "Chép báo cáo" chép đúng nội dung đó.

### User Story 3 - Xem và dọn memory (Priority: P2)

Màn Memory liệt kê memory theo CLI, gói và dự án:
- Claude: `projects/<dự án>/memory/*.md` và `MEMORY.md`, CLAUDE.md cấp người dùng và cấp dự án.
- Codex: `AGENTS.md` cấp người dùng và cấp dự án.
- Gemini: `GEMINI.md`.

Mỗi file có số token ước tính, ngày sửa và cờ:
- trùng (cùng tên hoặc nội dung gần giống ở gói khác);
- cũ (quá 30 ngày, hoặc nhắc file hay hàm không còn trong repo);
- link chết;
- không có trong `MEMORY.md`.

Đầu màn có tổng token nạp mỗi phiên của từng dự án.

**Acceptance Scenarios**:

1. **Given** dự án có memory ở 3 gói, **Then** màn hình gom theo dự án và cho thấy 3 nguồn, số file và token của từng nguồn.
2. **Given** `MEMORY.md` vượt trần (mặc định 1.500 token), **Then** cảnh báo kèm số token vượt.
3. **When** người dùng sửa hoặc xoá một file, **Then** app sao lưu trước. Xoá là chuyển vào
   `~/.xdev-hive/optimizer/trash/`, khôi phục được trong 30 ngày. Dòng chỉ mục trong `MEMORY.md` được cập nhật theo.
4. **When** gộp hai file trùng, **Then** app hiện bản gộp để người dùng sửa, ghi vào file đích, xoá file nguồn (vào thùng
   rác) và sửa link trỏ tới file nguồn.

### User Story 4 - Một bộ memory cho mỗi dự án, dùng chung giữa các gói (Priority: P2)

Người dùng bật "Dùng chung memory" cho một dự án. App gộp các bộ memory của dự án đó, có duyệt từng file trùng. Sau đó
mọi gói Claude dùng chung một thư mục, nên đổi gói khi quota cạn không mất memory.

**Acceptance Scenarios**:

1. **Given** dự án có memory ở `claude-3` và `claude-6`, **When** bật dùng chung, **Then** có thư mục thật
   `~/.xdev-hive/memory/claude/<khoá dự án>/`, và `memory/` của từng gói là liên kết tới đó. Trên Windows liên kết là
   junction.
2. **Given** CLI không theo liên kết, hoặc phiên bản CLI có cách khai báo thư mục memory riêng, **Then** dùng cách CLI hỗ
   trợ. Việc này phải kiểm ở task T010 trước khi làm.
3. **When** tắt dùng chung, **Then** mỗi gói nhận lại một bản sao của memory chung, và liên kết bị gỡ.

### User Story 5 - AI nén memory có duyệt (Priority: P3)

Người dùng chọn file hoặc cả dự án rồi bấm "Gợi ý nén". App chạy CLI của một gói ở chế độ chỉ đọc (như docs agent:
`--restricted`, `--tools Read,Glob,Grep`, không MCP). App hiện diff đề xuất và số token trước/sau. Chỉ ghi khi người
dùng bấm "Áp dụng", có sao lưu.

**Acceptance Scenarios**:

1. Đề xuất không được thêm sự kiện mới. App kiểm mỗi dòng mới có nguồn trong file cũ (so khớp từ khoá) và tô vàng dòng
   nghi ngờ.
2. Chạy nén tốn token của gói đã chọn. App ghi số token đã dùng cạnh đề xuất.

### User Story 6 - Đồng bộ với memory dự án trên hub (Priority: P3)

Khi đã đăng nhập và dự án local gắn với một dự án trên hub, người dùng xem được brief và memory của dự án trên hub (chỉ
đọc). Người dùng cũng gửi được một file memory local lên hub dưới dạng đề xuất memory. Hub duyệt theo luồng review của
knowledge.

**Acceptance Scenarios**:

1. **Given** chưa đăng nhập, **Then** mục đồng bộ ẩn, mọi tính năng khác vẫn chạy.
2. **When** gửi lên hub, **Then** không ghi đè memory trên hub. Hub tạo đề xuất mới, có link nguồn "từ máy <tên máy>".

### User Story 7 - Context pack và CodeGraph cho dự án local (Priority: P3, thử nghiệm)

Với dự án local, người dùng bật "Gợi ý ngữ cảnh". Ở prompt đầu tiên của phiên, hook `UserPromptSubmit` dựng context pack
từ prompt (dùng `buildContextPack` của worker) và chèn làm `additionalContext`.

**Acceptance Scenarios**:

1. Dựng pack quá 5 giây thì bỏ qua và không làm chậm prompt.
2. Pack chỉ dựng một lần mỗi phiên.
3. Máy không có `codegraph` thì pack dùng grep và lịch sử git như worker.

### Edge Cases

- CLI đang chạy và tự ghi `settings.json` (đổi theme, model) đúng lúc app ghi. App đọc, sửa rồi ghi bằng file tạm +
  rename. Nếu mtime đổi giữa chừng thì đọc lại và thử lại tối đa 3 lần.
- `settings.json` hỏng (JSON lỗi): không ghi, báo lỗi tiếng Việt, gợi ý mở file.
- Gói bị xoá khi đang bật: manifest bỏ gói đó ở lần quét sau.
- Đường dẫn sidecar đổi khi cập nhật app: hook gọi qua đường dẫn ổn định `~/.xdev-hive/bin/hive-worker`. App cập nhật
  liên kết này mỗi lần khởi động.
- Hook post-tool không được làm hỏng tool output. Lỗi bất kỳ thì trả output gốc.
- Ngân sách khám phá của worker (chặn sau 4 lệnh khám phá) không hợp phiên tương tác. Ở chế độ `--local` mặc định chỉ
  nhắc, không chặn.
- Windows: không dùng lệnh shell trong hook (dùng dạng exec), liên kết là junction, không kiểm bit thực thi.

## Requirements

### Functional Requirements

- **FR-001**: Bộ tối ưu chạy trong sidecar `hive-worker` (Go) bằng các lệnh con mới `optimize` và `memory`. App desktop
  chỉ gọi sidecar, như đang gọi `accounts`.
- **FR-002**: Preset biến token và bảng phiên bản tối thiểu dùng chung một nguồn với `savingEnv` và `claudeMinVersion` của
  worker. Không chép giá trị ra chỗ khác.
- **FR-003**: Mọi thay đổi file cấu hình của CLI phải:
  - sao lưu trước khi ghi;
  - ghi nguyên tử;
  - ghi vào manifest `~/.xdev-hive/optimizer/state.json` danh sách khoá đã thêm và giá trị cũ;
  - gỡ được sạch khi tắt.
- **FR-004**: Hook do Hive cài nhận diện được bằng đối số `--local` của lệnh `hive-worker hook`. Gỡ chỉ xoá các mục đó.
- **FR-005**: `hive-worker hook pre-tool|post-tool --local` lưu trạng thái theo `session_id` trong
  `~/.xdev-hive/optimizer/sessions/<id>/`. Thư mục quá 7 ngày bị dọn. Output đầy đủ bị cắt nằm trong thư mục này. Sổ ghi
  `ledger.jsonl` chỉ có số (ký tự trước/sau, tool, thời điểm).
- **FR-006**: Báo cáo token đọc transcript chỉ đọc, ra JSON số tổng hợp. Nó là bản Go của `scripts/token-audit.ts`, thêm
  cột trước/sau.
- **FR-007**: Quét memory trả về token ước tính (ký tự / 4, tiếng Việt có dấu ký tự / 3) và các cờ trùng, cũ, link chết,
  mồ côi, vượt trần.
- **FR-008**: Thao tác memory (sửa, xoá, gộp, dùng chung) đều có sao lưu, khôi phục được, và có test trên `HOME` giả.
- **FR-009**: Chữ giao diện và lỗi bằng tiếng Việt, có từ điển vi/en theo cách màn hiện có (`Dict` trong từng màn).
- **FR-010**: Không gửi gì ra mạng khi chưa đăng nhập. Nén bằng AI chạy CLI của gói người dùng chọn, sau khi người dùng
  bấm.

### Key Entities

- **Gói (profile)**: CLI + thư mục cấu hình (`~/.xdev-hive/accounts/<id>` hoặc thư mục mặc định).
- **Preset tối ưu**: `off` | `balanced` | `aggressive`. Gồm env Claude, khối Codex, hook (post-tool, pre-tool nhắc,
  RTK tuỳ chọn).
- **Manifest**: theo gói: preset, thời điểm bật, khoá đã thêm, giá trị cũ, đường dẫn bản sao lưu.
- **Mục memory**: CLI, gói, dự án, đường dẫn, loại (auto-memory, chỉ mục, CLAUDE.md, AGENTS.md, GEMINI.md), token, cờ.

## Success Criteria

- **SC-001**: Sau 7 ngày bật mức "Cân bằng" trên các gói Claude của máy dev:
  - trung vị ngữ cảnh đỉnh của phiên tương tác ≤ 200k token (hiện 184k, với 51 phiên > 400k);
  - số phiên > 400k giảm ít nhất 80%.
- **SC-002**: Token quy đổi mỗi lượt API của phiên tương tác giảm ≥ 25% so với 7 ngày trước khi bật. Mốc hiện tại:
  1.460,7M / 32.110 lượt ≈ 45,5k mỗi lượt.
- **SC-003**: Bật rồi tắt trả `settings.json` và `config.toml` về đúng từng byte, nếu người dùng không sửa gì ở giữa. Có
  test trên macOS, Linux và Windows.
- **SC-004**: Hook thêm ≤ 50 ms trung vị mỗi lượt gọi tool. Hook lỗi không làm hỏng phiên nào (fail-open).
- **SC-005**: Màn Memory quét 100 file memory dưới 1 giây.

## Assumptions

- Claude Code đọc khối `env` và `hooks` trong `settings.json` của `CLAUDE_CONFIG_DIR`. Các phiên bản 2.1.29x trên máy dev
  đã làm vậy.
- `updatedToolOutput` trong `PostToolUse` có từ phiên bản ghi trong `claudeMinVersion` của worker. Không có thì không cài
  hook post-tool.
- Chưa biết `projects/<khoá>/memory` dùng được liên kết hay không. T010 phải kiểm. Không được thì US4 dùng đồng bộ hai
  chiều khi app mở.
- DESKCLIENT đang sửa `apps/desktop`. Các task desktop ở đây chạy sau khi DESKCLIENT merge.
