# Feature Specification: Điểm tối ưu token trên máy dev

**Feature Branch**: `025-token-score` (nhánh tại máy `ai/TOKENSCORE`)

**Created**: 2026-10-18

**Status**: Draft. Chủ dự án chốt Q1–Q11 theo khuyến nghị ngày 2026-10-19. Đang làm đợt P1 ([tasks.md](tasks.md)).

**Input**: Chủ dự án (2026-10-18): nghiên cứu cách tối ưu token cho agent CLI (Claude Code, Codex, Antigravity) chạy
trên máy dev, đưa vào app desktop, kèm **thang điểm đánh giá mức tối ưu token trên từng máy**. Mỗi máy có điểm, chi
tiết từng tiêu chí, cách cải thiện, và nút sửa nhanh khi làm được an toàn. Tiết kiệm token là ràng buộc chính vì gói
thuê bao CLI hay hết hạn mức.

Bối cảnh (chi tiết ở [research.md](research.md)):
- Spec [015](../015-client-token-optimizer/spec.md) đã có bộ tối ưu theo gói, báo cáo token trước/sau và màn Memory.
  Thiếu một con số cho biết máy đã tối ưu tới đâu, tiêu chí nào còn thiếu, và nút sửa đi kèm từng tiêu chí.
- Hai máy đã đo cho cùng một kết quả: cache trúng 97–99%, nhưng ngữ cảnh lớn. Trên máy dev Windows, 77% token quy đổi
  nằm ở 18 phiên vượt 400k token (research mục 2).
- Theo thang đề xuất, gói mặc định `~/.claude` của máy dev Windows đạt khoảng **48/100** (research mục 6).

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md)

## Câu hỏi đã chốt

Chủ dự án chốt cả Q1–Q11 theo cột khuyến nghị ngày 2026-10-19. Cột "Nếu chọn khác" giữ lại để biết đã cân nhắc gì.

| # | Câu hỏi | Đã chốt (khuyến nghị) | Nếu chọn khác |
|---|---|---|---|
| Q1 | Điểm tính cho cả máy hay cho từng gói CLI? | **Cả hai.** Điểm máy là trung bình điểm các gói, trọng số theo token quy đổi 7 ngày của gói. **[Inference]** Token quy đổi của Claude và Codex không cùng bảng giá (`aggregate.go:8–9`), nhưng cùng đo lượng ngữ cảnh đọc lại, nên dùng được làm trọng số | Trọng số bằng nhau cho mỗi CLI có dùng: đơn giản, nhưng gói ít dùng kéo điểm như gói dùng nhiều |
| Q2 | Điểm gồm cấu hình hay cả thói quen dùng (số liệu phiên)? | **Cả hai**: nhóm A cấu hình 45 điểm, nhóm B số liệu phiên 55 điểm. Bật cấu hình mà phiên vẫn phình thì điểm vẫn thấp | Chỉ cấu hình: bấm vài nút là được 100 điểm, nhưng không phản ánh token thật |
| Q3 | Ngưỡng cố định hay so với mốc riêng của máy? | **Cố định** ở bản đầu (bảng Thang điểm), có `scoreVersion`. Xem lại sau khi T016 của 015 có số (2026-10-21) | Mốc riêng: phải có lịch sử dài; máy mới không có điểm |
| Q4 | Sửa nhanh nào được làm bằng một nút? | Chỉ việc **đảo ngược được**: bật tối ưu `balanced` (A1, A2); bật hook RTK (A6, trừ Windows); cài `rtk`, `codegraph` qua màn Môi trường; thêm MCP `codegraph` vào gói; `codegraph init` ở một dự án (A5). Mức `aggressive` (A8, đổi model subagent) cần hộp xác nhận có cảnh báo. MCP, skill, CLAUDE.md (A3, A4) chỉ gợi ý và mở màn liên quan | Cho tắt MCP/skill bằng một nút: nhanh hơn nhưng dễ tắt nhầm thứ người dùng cần |
| Q5 | Có gửi điểm lên hub để quản trị xem điểm các máy không? | **Có, ở P3, người dùng tự bật**, chỉ gửi số (điểm, điểm từng tiêu chí, phạm vi đo). Web hiện cột điểm ở danh sách máy | Không gửi: không cần đổi hub, nhưng quản trị không biết máy nào cần giúp |
| Q6 | Antigravity và Gemini chấm thế nào? | Antigravity: **chỉ chấm cấu hình** (A3 rule, A5 chỉ mục code) và **không tính vào điểm máy**, vì không có log token (research mục 4). Gemini: ghi "chưa hỗ trợ" | Tính cả vào điểm máy: điểm sẽ lệch vì không có số phiên |
| Q7 | Hiện điểm ở đâu? | **Thẻ đầu màn Token**, cộng huy hiệu điểm trên mục Token ở thanh điều hướng | Màn riêng: thêm một mục điều hướng |
| Q8 | Khi nào tính lại? | Lúc mở màn Token (dùng cache báo cáo của 015), sau mỗi lần sửa nhanh, và một lần mỗi ngày khi app mở (chạy nền). Huy hiệu đọc bản ghi lịch sử gần nhất, không tính lúc khởi động. Lưu lịch sử 90 ngày | Chỉ khi bấm "Tính lại": rẻ hơn nhưng không có lịch sử và huy hiệu cũ |
| Q9 | Có tính "token trước lần sửa đầu" cho phiên tại máy không? | **Có** (B7), cho Claude. Cách tính như worker tính `explore` cho run | Không: bỏ B7, chia 6 điểm cho B1 và B5 |
| Q10 | Có thêm biến mới vào preset `balanced` của 015 không? | **Không** ở spec này. Ghi để xem sau: `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (≥ 2.1.290 theo tài liệu [Unverified]), `ENABLE_TOOL_SEARCH` | Thêm ngay: phải sửa bảng preset và test của 015 |
| Q11 | Nhóm B tính những phiên nào? | Phiên **`interactive` và `headless`** (người gõ, và `claude -p`/`codex exec` tự chạy như agent-fleet). Bỏ `worker`, `hub-terminal` (run hub có preset riêng) và `test` | Chỉ `interactive`: bỏ sót agent chạy song song, mà research 015 đo là 12,5% token |

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code ngày 2026-10-18 trên `origin/main` tại `9d2bc66b`. Chi tiết ở [research.md](research.md) mục 1.

| Phần | Dùng thế nào |
|---|---|
| `hive-worker optimize enable/disable/restore` (015) | **Dùng lại** cho sửa nhanh A1, A2, A6, A8. Không viết lại cách ghi file cấu hình |
| Danh sách gói (`optimizeStatus` trong `cmd/hive-worker/optimize.go`: manifest gộp với `accounts.json`) | **Mở rộng**: tách thành hàm dùng chung để `score` nhận đủ gói, kể cả gói chưa bật tối ưu |
| `worker/internal/tokenreport` (015) | **Mở rộng**: số theo gói và theo nguồn phiên, gốc quét lấy từ `accounts.json`, đánh dấu transcript subagent, output tool theo gói, token trước lần sửa đầu (B7), `cwd` của phiên, tỉ trọng token theo model |
| `worker/internal/memstore` (015) | **Mở rộng** cho A3: thêm số dòng và cỡ byte vào kết quả quét |
| `accounts.ReadUsage` (`worker/internal/accounts/usage.go:129–185`: chạy `claude -p /usage` theo từng gói) | **Dùng lại cách làm** để chạy `claude -p /context` theo từng gói cho A1, A4 |
| `doctor.rs` (màn Môi trường) | **Mở rộng**: thêm mục cài `rtk`, `codegraph`. Giao diện chỉ gửi id |
| `setup_extra.rs` `mcp_add_argv` | **Dùng lại** cho sửa nhanh thêm MCP `codegraph` (`claude mcp add`, `codex mcp add`) |
| `tips()` trong `lib/usage.ts` | **Mở rộng**: hiện dưới tiêu chí liên quan: `compact` dưới B1, `cache` dưới B4, `codexCompact` dưới A1 (Codex), `subagents` ở gợi ý hành vi (US5) |
| Hub: `runs.explore/rtk/token_guard`, `costs.summary` nhóm theo máy | **Không đổi** ở P1–P2. P3 (Q5) thêm bảng điểm máy trong module `fleet` |
| `tokenSaving` của dự án, `CODEGRAPH_HINT` | **Không đổi**. Chỉ áp cho run hub; điểm không chấm run hub |
| Thang điểm, lịch sử điểm, thẻ điểm, liên kết tiêu chí với nút sửa | **Làm mới** |

Spec 015 còn để mở, spec này không giải quyết:
- đo lại T016 (Mac mini, gói `claude-4`…`claude-7`, lịch 2026-10-21);
- phần "Còn lại" của T011, T012, T013: `MemoryCompressDialog` và `MemoryHubSync` chưa gắn vào `memory-screen.tsx`, ô chọn
  context pack chưa có trong `optimizer-panel.tsx`;
- RTK trên Windows;
- cắt output `memory_search` của hub;
- preset cho Gemini và Antigravity.

## Thang điểm

`scoreVersion` 1. Tổng 100 điểm. Mỗi tiêu chí có điểm tối đa, cách đo, mức đủ điểm và mức 0 điểm. Giá trị nằm giữa hai
mức thì tính tuyến tính. Tiêu chí có mục con thì điểm = điểm tối đa × trung bình các mục con (mỗi mục con từ 0 đến 1).
Công thức chính xác và cách đọc dữ liệu ở [plan.md](plan.md) mục 2–4.

### Nhóm A: cấu hình (45 điểm)

Đo từ file cấu hình, công cụ trên máy và `/context`. A1, A3, A5 dùng thêm số của báo cáo phiên gần nhất nếu có; không có
thì dùng cách thay thế ở plan mục 3.

| # | Tiêu chí | Điểm | Đo (Claude Code; Codex) | Đủ điểm | 0 điểm | Sửa nhanh | Gợi ý khi thấp |
|---|---|---:|---|---|---|---|---|
| A1 | Trần ngữ cảnh, nén sớm | 10 | Ngưỡng nén hiệu lực: cửa sổ trừ "Autocompact buffer" của `/context`. Không đo được `/context` thì tính từ `CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`autoCompactWindow` và `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`. `DISABLE_AUTO_COMPACT=1` là 0 điểm. Codex: `model_auto_compact_token_limit` | ≤ 200k (Codex ≤ 150k) | ≥ 600k (Codex ≥ 400k hoặc không đặt) | Bật tối ưu `balanced` cho gói | Dùng `/compact` giữa các việc, `/clear` khi đổi việc |
| A2 | Trần output tool | 8 | Claude 4 mục con: `BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, hook cắt output của Hive. Codex 1 mục: `tool_output_token_limit` | Mỗi biến ≤ 15.000 (Codex ≤ 8.000); có hook | Biến lớn hơn mặc định CLI (Codex > 24.000); không có hook. Biến để mặc định: 0,5 | Bật tối ưu `balanced` | Đọc file theo đoạn (`Read` có offset/limit) thay vì `cat` cả file |
| A3 | File chỉ dẫn gọn | 5 | 2 mục con: (1) token chỉ dẫn nạp mỗi phiên, trung vị, gồm `@import`; (2) không file nào bị CLI cắt: `MEMORY.md` > 200 dòng hoặc > 25 KB, `AGENTS.md` > 32 KiB, rule Antigravity > 24.000 byte. CLAUDE.md > 200 dòng chỉ cảnh báo, không trừ điểm | (1) ≤ 2.000 token; (2) không file nào bị cắt | (1) ≥ 8.000 token; (2) có file bị cắt | Không. Mở màn Memory lọc file vượt trần | Chuyển hướng dẫn chuyên biệt sang skill hoặc `.claude/rules/` có `paths:` |
| A4 | Tool, MCP, skill nạp sẵn | 7 | Tổng token các nhóm "Skills", "MCP tools", "Custom agents" của `/context`. Không tính nhóm có chữ "(deferred)". Nhân 0,5 khi `ENABLE_TOOL_SEARCH=false` hoặc có server `alwaysLoad: true`. Codex: số server trong `mcp_servers` không có `enabled = false` | ≤ 4.000 token; Codex ≤ 2 server | ≥ 20.000 token; Codex ≥ 8 server | Không. Mở danh sách MCP và skill kèm token ước tính | Tắt MCP không dùng; dùng CLI (`gh`, `glab`) thay MCP; đặt `disable-model-invocation: true` cho skill chỉ gọi tay |
| A5 | Chỉ mục code | 5 | 3 mục con: (1) có `codegraph` (hoặc Serena); (2) gói có MCP `codegraph`; (3) tỉ lệ dự án có `.codegraph/` trong 3 dự án dùng nhiều token nhất | Đủ 3 mục | Không mục nào | Cài `codegraph` (màn Môi trường); thêm MCP vào gói; `codegraph init` ở dự án (hỏi trước) | Nhắc agent dùng `codegraph_explore` trước grep |
| A6 | Lọc output lệnh | 3 | Claude 2 mục con: (1) `rtk --version` chạy được; (2) gói có hook `PreToolUse` khớp `Bash` gọi `rtk`. Codex: `unsupported` ở bản đầu | Đủ 2 mục | Không có `rtk` | Cài `rtk`; bật hook RTK qua bộ tối ưu (không có trên Windows) | Tác dụng nhỏ với việc đọc code (015 mục 4) |
| A7 | Cache và phiên bản CLI | 3 | Claude 2 mục con: (1) không có `DISABLE_PROMPT_CACHING*`; (2) CLI hỗ trợ hook dạng exec và `updatedToolOutput` (≥ 2.1.296). Codex: `unsupported` | Đủ 2 mục | Không mục nào | Không. Chỉ ra file và khoá | Không đổi model, effort, MCP giữa phiên; cập nhật CLI giữa các phiên |
| A8 | Model và effort mặc định | 4 | 2 mục con: (1) effort mặc định không phải `xhigh`, `max` (`effortLevel`, `CLAUDE_CODE_EFFORT_LEVEL`; Codex `model_reasoning_effort` không phải `xhigh`, `max`, `ultra`); (2) Claude: có `CLAUDE_CODE_SUBAGENT_MODEL` khác Opus; Codex: `model_verbosity` không phải `high` | Đủ 2 mục | Không mục nào | Bật mức `aggressive` (hỏi trước, có cảnh báo) | Chọn model và effort theo việc |

### Nhóm B: số liệu phiên (55 điểm)

7 ngày gần nhất, nguồn `interactive` và `headless` (Q11). Cần ≥ 5 phiên chính của gói. Phiên chính là transcript không
nằm trong thư mục `subagents/`. Token của subagent vẫn tính vào B2, B5, B6.

| # | Tiêu chí | Điểm | Đo | Đủ điểm | 0 điểm | Gợi ý khi thấp |
|---|---|---:|---|---|---|---|
| B1 | Ngữ cảnh đỉnh (trung vị theo phiên chính) | 12 | `medianPeakContext` | ≤ 120k | ≥ 300k | Sửa A1; tách việc thành phiên ngắn |
| B2 | Token ở phiên rất dài | 10 | `weightedOver400k ÷ weighted` | ≤ 10% | ≥ 50% | Sửa A1; `/clear` giữa các việc không liên quan |
| B3 | Ngữ cảnh lượt đầu (trung vị theo phiên chính) | 8 | `medianFirstContext` | ≤ 20k | ≥ 50k | Sửa A3, A4 |
| B4 | Cache trúng | 6 | `cacheHit` | ≥ 90% | ≤ 60% | Không sửa CLAUDE.md, đổi model hay MCP giữa phiên; kiểm A7 |
| B5 | Token quy đổi mỗi lượt API | 8 | `weighted ÷ calls` | ≤ 20k | ≥ 60k | Sửa A1, A2 |
| B6 | Output tool trung bình | 5 | Tổng token output tool ÷ số lượt tool | ≤ 600 | ≥ 2.500 | Sửa A2, A6; đọc file theo đoạn |
| B7 | Token trước lần sửa đầu (Claude) | 6 | Token quy đổi trước lượt có `Edit`/`Write`/`MultiEdit`/`NotebookEdit` đầu tiên ÷ token quy đổi của phiên, chỉ tính phiên chính có sửa file. Codex: `unknown` | ≤ 30% | ≥ 70% | Sửa A5; nêu rõ file hay hàm trong prompt |

Mức: **Tốt** ≥ 80, **Khá** 60–79, **Cần cải thiện** < 60.

Cơ sở ngưỡng (research mục 5):
- Ngưỡng A3 lấy từ tài liệu chính thức.
- Mốc 10% của B2 và 90% của B4 dựa trên cờ của `/usage`.
- Các ngưỡng khác là **[Inference]** rút từ số đo hai máy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem điểm của máy (Priority: P1)

Người dùng mở màn Token. Đầu màn có thẻ "Điểm tối ưu token" gồm:
- điểm máy 0–100 và mức (Tốt, Khá, Cần cải thiện);
- dòng "Đo được X/100 điểm": phần còn lại là tiêu chí chưa đo được;
- điểm nhóm A và nhóm B;
- điểm từng gói CLI kèm tỉ trọng token 7 ngày của gói;
- chênh lệch so với lần tính trước.

**Why this priority**: chủ dự án cần biết mỗi máy đã tối ưu tới đâu. Các số đã có trên màn Token nhưng không gộp thành
một kết luận.

**Independent Test**: `HOME` (và `USERPROFILE` trên Windows) giả có 2 gói Claude và 1 gói Codex trong `accounts.json`,
transcript mẫu (fixture, không có dữ liệu thật), cấu hình mẫu, `/context` mẫu. `hive-worker optimize score --json` ra
đúng điểm từng tiêu chí, điểm gói, điểm máy và phạm vi đo như file mong đợi viết tay.

**Acceptance Scenarios**:

1. **Given** máy có gói `claude-2` (80% token) điểm 50 và `codex-1` (20% token) điểm 75, **When** mở màn Token, **Then**
   điểm máy là 55, mức "Cần cải thiện".
2. **Given** gói có ít hơn 5 phiên chính trong 7 ngày, **Then** nhóm B của gói ghi "chưa đủ dữ liệu", điểm gói chỉ tính
   nhóm A, và dòng phạm vi đo cho thấy phần thiếu.
3. **Given** máy chưa có phiên nào, **Then** điểm máy là trung bình điểm nhóm A của các gói Claude và Codex đã đăng ký.
4. **Given** máy chỉ có gói Antigravity, **Then** thẻ hiện điểm cấu hình của Antigravity, ghi "không có log token, không
   tính vào điểm máy" (Q6), và điểm máy ghi "chưa có".
5. **Given** phạm vi đo dưới 50 điểm, **Then** điểm có nhãn "tạm tính".
6. **Given** gói nằm ngoài `~/.xdev-hive/accounts` (đường dẫn tuỳ chọn trong `accounts.json`), **Then** gói vẫn có điểm
   riêng, không bị gộp vào gói mặc định.

### User Story 2 - Xem chi tiết từng tiêu chí và cách cải thiện (Priority: P1)

Người dùng mở chi tiết điểm. Mỗi tiêu chí có:
- giá trị đo, mức đủ điểm, mức 0 điểm, điểm được;
- nguồn số đo (file cấu hình, `/context`, transcript 7 ngày);
- gợi ý cải thiện bằng tiếng Việt;
- nút sửa nhanh nếu có.

Tiêu chí xếp theo số điểm còn thiếu, nhiều nhất lên đầu.

**Why this priority**: điểm không có hướng sửa thì người dùng không làm gì được.

**Independent Test**: với fixture của US1, danh sách tiêu chí xếp đúng thứ tự điểm thiếu; tiêu chí đủ điểm không có nút
sửa; tiêu chí chưa đo có lý do.

**Acceptance Scenarios**:

1. **Given** A1 được 0/10 vì không đặt trần ngữ cảnh, **Then** dòng A1 ghi "Nén ở khoảng 967k token" và có nút "Bật tối
   ưu Cân bằng cho `claude-2`".
2. **Given** `MEMORY.md` của một dự án dài 260 dòng, **Then** A3 mục (2) được 0, dòng A3 ghi đường dẫn rút gọn (`~/…`),
   số dòng, và nút "Mở trong màn Memory".
3. **When** bấm "Chép báo cáo điểm", **Then** clipboard chỉ có số, id tiêu chí và mã lý do. Không có id gói, tên dự án,
   đường dẫn, prompt hay output.

### User Story 3 - Sửa nhanh an toàn (Priority: P1)

Người dùng bấm nút sửa ở một tiêu chí. App hiện trước:
- file nào đổi;
- khoá nào thêm hoặc đổi, giá trị cũ và mới;
- tác động tới chất lượng nếu có.

Người dùng bấm "Áp dụng". App sao lưu, áp dụng, rồi tính lại điểm nhóm A. Nút "Hoàn tác" trả cấu hình về bản trước.

**Why this priority**: chủ dự án muốn có nút sửa nhanh. Phần ghi cấu hình an toàn đã có ở 015, chỉ cần nối vào tiêu chí.

**Independent Test**: `HOME` giả. Áp dụng từng sửa nhanh trong danh sách cho phép, kiểm điểm nhóm A tăng đúng số điểm
mong đợi. Hoàn tác thì file cấu hình trở lại đúng từng byte (trừ `codegraph.mcp`, xem SC-003).

**Acceptance Scenarios**:

1. **Given** gói `claude-2` chưa bật tối ưu, **When** áp dụng sửa A1, **Then** sidecar chạy `optimize enable --profile
   claude-2 --level balanced`, thêm `--rtk` nếu gói đang có hook RTK của Hive. A1 và A2 lên đủ điểm, B không đổi tới khi
   có phiên mới.
2. **Given** máy không có `codegraph`, **When** bấm sửa A5, **Then** app mở màn Môi trường ở mục `codegraph`. Không tự
   cài ngầm.
3. **Given** sửa A8, **Then** hộp xác nhận liệt kê mọi thay đổi của mức `aggressive` (trần output thấp hơn, subagent
   chạy Sonnet, mô tả MCP ngắn hơn), ghi "chất lượng có thể khác", và chỉ áp dụng khi người dùng bấm xác nhận.
4. **Given** `codegraph init` cho một dự án, **Then** app hỏi trước, chạy trong thư mục dự án đó, thêm `.codegraph/` vào
   `.git/info/exclude` nếu git chưa bỏ qua nó.
5. **Given** CLI đang ghi `settings.json` đúng lúc áp dụng, **Then** làm như 015 (ghi nguyên tử, thử lại tối đa 3 lần);
   lỗi thì báo bằng tiếng Việt, không đổi điểm.
6. Giao diện chỉ gửi id của sửa nhanh, id gói và (khi cần) thư mục dự án đã có trong danh sách dự án của điểm. Rust tra
   bảng cho phép rồi dựng lệnh sidecar, không nhận chuỗi lệnh từ giao diện.

### User Story 4 - Theo dõi điểm theo thời gian (Priority: P2)

Thẻ điểm có biểu đồ 30 ngày, mỗi ngày một điểm, có mốc ở ngày áp dụng sửa nhanh. Người dùng thấy nhóm B thay đổi sau khi
bật tối ưu.

**Independent Test**: file lịch sử mẫu có 10 ngày; biểu đồ có 10 điểm, mốc sửa nhanh đúng ngày; bảng xem dạng chữ có đủ
số.

**Acceptance Scenarios**:

1. Mỗi ngày lưu tối đa một bản ghi tự động, cộng một bản ghi sau mỗi lần sửa nhanh.
2. Bản ghi quá 90 ngày bị dọn.
3. `scoreVersion` đổi thì biểu đồ đánh dấu chỗ đổi thang, không nối hai đoạn.

### User Story 5 - Gợi ý theo hành vi dùng (Priority: P2)

Khi nhóm B thấp mà nhóm A đã đủ, thẻ hiện gợi ý về cách dùng, rút từ số liệu: phiên dài không `/clear`, nhiều subagent
(`/usage`), đọc cả file lớn. Gợi ý có nguồn (research mục 3). Gợi ý chỉ hiện, không sửa gì.

**Independent Test**: fixture có A đủ điểm, B2 ≥ 50%; thẻ hiện đúng gợi ý của B2 và không có nút sửa.

**Acceptance Scenarios**:

1. **Given** A1 đủ điểm mà B2 vẫn ≥ 50%, **Then** gợi ý "Tách việc thành phiên ngắn, `/clear` giữa các việc không liên
   quan".
2. **Given** `/usage` báo phiên dùng nhiều subagent chiếm ≥ 50% hạn mức, **Then** giữ gợi ý `subagents` đang có.

### User Story 6 - Quản trị xem điểm các máy trên web (Priority: P3, Q5)

Người dùng bật "Gửi điểm lên hub" trong màn Token. App gửi điểm khi tính lại, tối đa một lần mỗi giờ. Quản trị đội thấy
cột "Điểm token" ở danh sách máy trên web, bấm vào thì thấy điểm từng tiêu chí.

**Independent Test**: DB test gửi điểm bằng PAT của chủ máy, đọc lại bằng quản trị đội; người ngoài đội không đọc được.
Playwright: cột điểm hiện ở danh sách máy.

**Acceptance Scenarios**:

1. **Given** chưa đăng nhập hoặc chưa bật, **Then** không gửi gì, mọi tính năng khác vẫn chạy.
2. Dữ liệu gửi chỉ có số, enum và mã lý do: điểm máy, điểm nhóm, điểm và trạng thái từng tiêu chí, phạm vi đo,
   `scoreVersion`, thời điểm. Không có đường dẫn, tên dự án hay id gói.
3. Bảng điểm máy trên hub bật và ép RLS, có trong `modules/fleet/rls.db.test.ts`.

### Edge Cases

- `settings.json` hoặc `config.toml` hỏng: tiêu chí đọc file đó là "chưa đo", ghi lý do. Không ghi file.
- `/context` không chạy được (gói chưa đăng nhập, quá 30 giây): A4 là "chưa đo", A1 dùng cách tính từ cấu hình.
- Transcript lớn: dùng cache báo cáo của 015. Lần đầu chạy nền, thẻ hiện nhóm A trước.
- Người dùng tự đặt khoá (vd `BASH_MAX_OUTPUT_LENGTH=20000`): chấm theo giá trị đó, ghi "người dùng đặt". Sửa nhanh
  không ghi đè khoá người dùng đặt, như 015.
- Windows:
  - `optimize enable --rtk` báo lỗi trên Windows (`optimize.go:280–283`), nên nút bật hook RTK ẩn, A6 ghi lý do
    `windows_rtk_unsupported`;
  - hook RTK người dùng tự cài vẫn được tính mục (2) của A6 nếu có trong `settings.json`;
  - hook của Hive (cắt output, A2) cài được khi CLI ≥ 2.1.296.
- Gói đã bật tối ưu nhưng người dùng sửa khoá về giá trị lớn: chấm theo giá trị hiện tại, ghi "đã đổi sau khi bật".
- Bật lại `balanced` (đổi mức) gỡ khoá của mức cũ trước khi áp mức mới (`claude.go:49–57`). Sửa nhanh không thêm khoá nào
  ngoài preset, để không bị gỡ lặng lẽ.
- Dự án chưa có git: `codegraph init` vẫn chạy, bỏ bước `.git/info/exclude`.
- Transcript subagent (`<phiên>/subagents/`): không tính là phiên chính, không vào trung vị và ngưỡng 5 phiên.
- Điểm không được thành mục tiêu thay cho việc làm xong. Màn hình ghi rõ: điểm đo cấu hình và kích thước ngữ cảnh, không
  đo chất lượng kết quả.

## Requirements *(mandatory)*

### Functional Requirements

**Tính điểm**

- **FR-001**: Điểm tính trong sidecar `hive-worker` (Go) bằng lệnh `hive-worker optimize score --json`, theo ADR 0026.
  App desktop chỉ gọi sidecar và hiển thị.
- **FR-002**: Bảng tiêu chí (id, nhóm, điểm tối đa, mức đủ điểm, mức 0 điểm, chiều, mục con, id sửa nhanh) nằm ở một chỗ
  trong Go, có `scoreVersion`. Chữ hiển thị nằm ở `Dict` vi/en của giao diện, theo id tiêu chí và mã lý do.
- **FR-003**: Mỗi tiêu chí trả về:
  - giá trị đo và đơn vị;
  - trạng thái: `ok`, `partial`, `low`, `unknown` hoặc `unsupported`;
  - điểm được, điểm tối đa;
  - nguồn đo;
  - mã lý do khi `unknown` hay `unsupported`;
  - mục con, nếu có;
  - danh sách id sửa nhanh dùng được.
- **FR-004**: Điểm của gói = 100 × tổng điểm được ÷ tổng điểm tối đa của các tiêu chí đo được. Phạm vi đo = tổng điểm tối
  đa của các tiêu chí đo được. Mỗi giá trị tuyến tính giữa hai mức, kẹp trong [0, 1]. Chỉ làm tròn (1 chữ số) ở kết quả
  hiển thị, không làm tròn giữa chừng.
- **FR-005**: Điểm máy = trung bình điểm gói Claude và Codex, trọng số theo token quy đổi 7 ngày của gói (Q1). Gói không
  có token không tính trọng số. Không gói nào có token thì lấy trung bình điểm nhóm A của các gói Claude và Codex.
  Antigravity và Gemini không tính (Q6).
- **FR-006**: Nhóm B của một gói cần ≥ 5 phiên chính trong 7 ngày, nguồn theo Q11. Ít hơn thì cả nhóm B của gói là
  `unknown`.
- **FR-007**: `tokenreport` thêm:
  - gốc quét lấy từ `accounts.json` (id, CLI, thư mục cấu hình), gộp số theo gói và nguồn phiên;
  - cờ transcript subagent;
  - `cwd` của phiên trong cache (chỉ dùng trong sidecar);
  - tổng token output tool và số lượt tool (B6);
  - token quy đổi trước lần sửa file đầu tiên của phiên (B7);
  - tỉ trọng token theo họ model.
  Báo cáo cũ (`optimize report`) giữ nguyên các trường hiện có. Có test so khớp với fixture hiện có.
- **FR-008**: A1 và A4 dùng `/context` của từng gói. Sidecar chạy `claude -p /context` với `CLAUDE_CONFIG_DIR` của gói,
  theo cách `accounts.ReadUsage` đang chạy `/usage`. Kết quả cache 10 phút.

**Sửa nhanh**

- **FR-009**: Danh sách sửa nhanh cố định trong code (plan mục 6). Giao diện gửi `{fixId, profileId, projectKey?}`. Rust
  kiểm id trong bảng cho phép rồi gọi sidecar. Không lệnh nào ghép từ chuỗi giao diện gửi.
- **FR-010**: Mỗi sửa nhanh có bước xem trước (file, khoá, giá trị cũ/mới, cảnh báo), sao lưu, áp dụng, hoàn tác. Sửa
  nhanh ghi cấu hình CLI đi qua `optimizer` của 015 (manifest, ghi nguyên tử, giữ khoá người dùng). Riêng thêm MCP
  `codegraph` đi qua lệnh `mcp add` của CLI, hoàn tác bằng `mcp remove`.
- **FR-011**: Sửa nhanh đổi hành vi hay chất lượng (mức `aggressive`) cần hộp xác nhận riêng, không bao giờ là nút mặc
  định.
- **FR-012**: Không sửa nhanh nào tắt MCP, xoá skill, sửa nội dung CLAUDE.md/AGENTS.md hay memory. Các tiêu chí đó chỉ mở
  màn liên quan.
- **FR-013**: Sau sửa nhanh, tính lại nhóm A (số phiên lấy từ báo cáo cache) và lưu một bản ghi lịch sử có id sửa nhanh.

**Lưu trữ, riêng tư, giao diện**

- **FR-014**: Lịch sử điểm ở `~/.xdev-hive/optimizer/score-history.jsonl`, mỗi dòng chỉ có số, id tiêu chí, CLI và thời
  điểm. Giữ 90 ngày.
- **FR-015**: Riêng tư:
  - JSON điểm của sidecar chỉ dùng trên máy. Nó được có id gói và đường dẫn dự án rút gọn (`~/…`) để hiện trên màn hình;
    không có prompt hay output.
  - Báo cáo chép, lịch sử và dữ liệu gửi hub chỉ có số, enum, id tiêu chí, mã lý do và CLI. Không có id gói, đường dẫn,
    tên dự án.
- **FR-016**: Chạy offline, không cần đăng nhập hub. Chỉ US6 cần đăng nhập và người dùng bật.
- **FR-017**: Chữ giao diện và lỗi bằng tiếng Việt, có từ điển vi/en như màn Token hiện có.
- **FR-018**: Thẻ điểm đúng hệ thiết kế Navy Hive: token màu, sáng/tối, rộng 360 px vẫn đọc được, dùng được bằng bàn
  phím. Biểu đồ có bảng xem dạng chữ như `costs-page.tsx`.

**Hub (P3, Q5)**

- **FR-019**: Hợp đồng mới trong `packages/contracts/src/fleet.ts`: máy gửi điểm, quản trị đội đọc điểm. Zod `strict`,
  chỉ số, enum và mã lý do. Chạy `pnpm openapi`, commit `openapi.json`.
- **FR-020**: Bảng `machine_token_scores` trong module `fleet`: `org_id`, `team_id`, khoá ngoại `(machine_id, org_id)`
  như các bảng `fleet` hiện có; bật và ép RLS; migration sinh bằng `db:generate`; dọn bản ghi quá 90 ngày.
- **FR-021**: App gửi bằng PAT đang dùng (`hub.rs`). Chỉ chủ máy theo ADR 0017 gửi được điểm của máy đó.
- **FR-022**: Web hiện cột "Điểm token" ở danh sách máy và trang chi tiết điểm theo tiêu chí.

### Key Entities

- **Tiêu chí**: id (`A1`…`B7`), nhóm, điểm tối đa, mức đủ điểm, mức 0 điểm, chiều (thấp tốt hay cao tốt), mục con, id
  sửa nhanh.
- **Kết quả tiêu chí**: giá trị đo, trạng thái, điểm, nguồn, mã lý do, mục con.
- **Điểm gói**: id gói, CLI, điểm, phạm vi đo, token 7 ngày, số phiên chính, kết quả các tiêu chí, dự án top 3.
- **Điểm máy**: điểm, mức, phạm vi đo, `scoreVersion`, thời điểm, danh sách điểm gói.
- **Sửa nhanh**: id, tiêu chí, loại (ghi cấu hình, cài công cụ, chạy lệnh trong dự án, mở màn), có cần xác nhận, cách
  hoàn tác.
- **Bản ghi lịch sử**: ngày, điểm máy, điểm nhóm, điểm tiêu chí, id sửa nhanh nếu có.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Mở màn Token trên máy dev (7 ngày transcript, đã có cache) thì thẻ điểm hiện trong ≤ 3 giây. Lần đầu, chưa
  có cache: nhóm A hiện trong ≤ 3 giây (không kể `/context`), cả thẻ trong ≤ 60 giây.
- **SC-002**: Test bảng với fixture: mỗi tiêu chí và mục con có ca ở mức đủ điểm, mức 0 điểm, giữa hai mức, `unknown`.
  Điểm khớp bảng mong đợi tới 0,1.
- **SC-003**: Mọi sửa nhanh qua `optimizer` hoàn tác được về đúng từng byte nếu người dùng không sửa gì ở giữa. Có test
  trên macOS, Linux và Windows (dùng lại test của 015 SC-003). `codegraph.mcp` hoàn tác bằng `mcp remove`; test kiểm
  server không còn trong cấu hình, không so từng byte vì CLI tự ghi lại file.
- **SC-004**: Trên gói Claude mới chưa cấu hình gì, áp dụng hết sửa nhanh không cần xác nhận thì nhóm A đạt ≥ 80% điểm
  đo được.
- **SC-005**: Không dữ liệu riêng nào lọt ra báo cáo chép, lịch sử hay dữ liệu gửi hub. Test dùng fixture có chuỗi đánh
  dấu trong prompt, output, đường dẫn, tên dự án và id gói, rồi tìm chuỗi đó trong ba kết quả trên. JSON điểm của sidecar
  không được có chuỗi đánh dấu của prompt và output.
- **SC-006**: Sau 7 ngày từ lúc áp dụng sửa A1 cho gói mặc định của máy dev Windows, B2 giảm từ 77% xuống ≤ 30% và token
  quy đổi mỗi lượt giảm ≥ 25% (cùng mốc với 015 SC-002). Đây là mục tiêu đo, chưa phải kết quả; có thể không đạt.

## Assumptions

- Tên khoá trong bảng có trong binary Claude Code 2.1.300 và Codex 0.142.5 (research mục 3). Cách CLI dùng khoá và giá
  trị mặc định lấy từ tài liệu, chưa kiểm hết bằng chạy thật. Task đầu tiên phải kiểm lại các mặc định dùng để chấm
  (Bash 30.000 ký tự, Read 25.000, MCP 25.000, nén ở khoảng 967k) và tên nhóm của `/context`.
- Tên nhóm `/context` đã thấy trong fixture thật của app (`usage.rs:857`): "System prompt", "System tools", "System tools
  (deferred)", "Skills", "Messages", "Free space", "Autocompact buffer". "MCP tools" và "Custom agents" **[Unverified]**:
  chưa thấy trong output thật; task kiểm trên máy có MCP và agent riêng.
- `claude -p /context` không tốn hạn mức gói. **[Unverified]** Màn Token đang chạy lệnh này; task kiểm bằng `/usage`
  trước và sau.
- Phần T001–T015 của 015 đã có trong `main`, trừ các mục "Còn lại" ghi ở Hiện trạng. Spec này chạy được trước khi có kết
  quả T016.
- Thang điểm đo cấu hình và kích thước ngữ cảnh, không đo chất lượng kết quả của agent.

## Out of Scope

- Tự đổi thói quen dùng, tự `/compact` hay `/clear` thay người dùng.
- Tự sửa nội dung CLAUDE.md, AGENTS.md, memory. Đã có "Gợi ý nén" có duyệt ở 015 US5.
- Tắt MCP server hay skill bằng một nút.
- Đọc log token của Antigravity và Gemini; hook RTK cho Codex.
- Nhận OpenTelemetry vào hub.
- Chấm run do hub giao. Run đã có số ở trang Chi phí; worker có preset riêng.
- Tính tiền hay dự báo hạn mức gói.
