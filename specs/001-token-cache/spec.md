# Feature Specification: Cache để agent đỡ tốn token (client, server, tài liệu)

**Feature Branch**: `ai/SPEC-81`

**Created**: 2026-10-11

**Status**: Draft

**Input**: User description: "Nghiên cứu tính năng cache cho toàn bộ client, server, tài liệu để đỡ tốn token"

## Bối cảnh

Spec này nối tiếp, không thay thế:

- **80. tokens-plugins-path** (`docs/specs/80-tokens-plugins-path.md`): làm gọn kết quả tool (80a, 80b đã xong; 80c doc-lean chưa), bớt tool và lời dặn lặp (80d, 80e), leader hub giữ cache (80g), trần token theo task (80h).
- **77. client-perf** (`docs/specs/77-client-perf.md`): cache dữ liệu cho giao diện web và app (TanStack Query, IndexedDB, asset tĩnh). 77 nhằm tốc độ giao diện, không nhằm token.
- **28c / 46**: mỗi run đã lưu token vào mới, ghi cache, đọc cache, ra; giao diện đã hiện tỉ lệ đọc cache.

Số đo của 80 (ước lượng, ngày 9–10/10): run Claude đọc từ cache 74–96% input, nhưng **mỗi run vẫn ghi 20–77k token vào cache**, tức phần đầu ngữ cảnh không được dùng lại giữa các run. `doc_get` lớn nhất ~27k token, `doc_list` ~8k, `memory_search` ~1k mỗi lần.

Spec 81 xét phần 80 chưa làm: **dùng lại** thứ agent đã đọc (giữa các lượt gọi, giữa các run, giữa các máy), thay vì chỉ **làm nhỏ** từng lần đọc. "Cache" ở đây là ba lớp:

1. **Server (hub)**: trả lời "không đổi" khi agent đã có bản mới nhất; giữ sẵn bản rút gọn của tài liệu.
2. **Client (máy chạy run)**: giữ bản sao tài liệu, skill, bộ nhớ theo phiên bản; giữ phần đầu ngữ cảnh của run giống hệt nhau giữa các run để nhà cung cấp model dùng lại prompt cache.
3. **Tài liệu**: mỗi tài liệu có mục lục và bản tóm tắt theo phiên bản, để agent đọc phần cần thay vì cả trang.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Run sau dùng lại phần đầu ngữ cảnh của run trước (Priority: P1)

Người quản trị chạy nhiều task liên tiếp của cùng một dự án, cùng loại agent, cùng vai trò (plan, implement, review). Phần đầu ngữ cảnh mà mọi run này giống nhau (lời dặn chung, danh sách tool, tài liệu dự án, danh sách skill) được gửi giống hệt từng byte và theo cùng thứ tự, nên run sau đọc phần đó từ prompt cache của nhà cung cấp thay vì ghi lại.

**Why this priority**: Đây là chỗ tốn lớn nhất đã đo được (20–77k token ghi cache mỗi run). Giá ghi cache cao hơn giá đọc cache. Làm được thì mọi run đều lợi, không cần agent đổi cách làm.

**Independent Test**: Chạy hai run liên tiếp cùng dự án, cùng loại agent, cùng vai trò, trong thời gian sống của prompt cache, không đổi tài liệu ở giữa. So số token ghi cache của run thứ hai với run thứ nhất trên trang *Lượt chạy*.

**Acceptance Scenarios**:

1. **Given** hai run cùng dự án, loại agent, vai trò, cách nhau ít hơn thời gian sống của prompt cache, không tài liệu nào đổi, **When** run thứ hai bắt đầu, **Then** phần đầu ngữ cảnh chung của nó được đọc từ cache, và số token ghi cache của run thứ hai giảm ít nhất 50% so với run thứ nhất.
2. **Given** một tài liệu dự án vừa đổi phiên bản, **When** run tiếp theo bắt đầu, **Then** run nhận nội dung mới (không dùng bản cũ), và hệ thống ghi lại lý do phần đầu ngữ cảnh đổi (tài liệu nào, phiên bản nào).
3. **Given** giá trị riêng của run (id task, worktree, SHA, thời gian), **When** dựng ngữ cảnh, **Then** các giá trị đó chỉ nằm sau phần đầu chung, không chen vào giữa.

---

### User Story 2 - Agent không tải lại tài liệu, skill, bộ nhớ đã có (Priority: P1)

Trong một run, hoặc giữa các run trên cùng máy, agent gọi đọc tài liệu, skill hoặc bộ nhớ mà nó (hoặc máy) đã có ở đúng phiên bản. Hub trả lời ngắn "không đổi so với phiên bản bạn có" thay vì gửi lại cả nội dung.

**Why this priority**: Agent thường đọc lại cùng tài liệu nhiều lần (đầu phiên, trước khi đề xuất sửa, khi đổi bước). Mỗi lần đọc lại một tài liệu lớn tốn tới ~27k token. Lợi ích độc lập với User Story 1.

**Independent Test**: Trong một run, gọi đọc cùng một tài liệu hai lần không đổi gì ở giữa; lần hai nhận câu trả lời "không đổi" ngắn. Đổi tài liệu rồi đọc lại; nhận nội dung mới.

**Acceptance Scenarios**:

1. **Given** agent đã đọc tài liệu X ở phiên bản N trong run, **When** agent đọc lại X và X vẫn ở phiên bản N, **Then** câu trả lời ngắn (dưới 100 token) cho biết không đổi và nhắc phiên bản N.
2. **Given** agent đã đọc X ở phiên bản N, **When** X lên phiên bản N+1 rồi agent đọc lại, **Then** agent nhận nội dung đầy đủ của N+1.
3. **Given** agent muốn nội dung đầy đủ dù không đổi (ví dụ ngữ cảnh đã bị nén mất), **When** agent yêu cầu rõ bản đầy đủ, **Then** hub trả cả nội dung.
4. **Given** tài liệu X đã bị gỡ (38g) hoặc agent không còn quyền đọc X, **When** agent đọc lại X, **Then** agent nhận lỗi "không còn / không có quyền", không nhận "không đổi".
5. **Given** cùng câu tìm kiếm bộ nhớ được gọi lại trong một run và bộ nhớ không có mục mới liên quan, **When** agent gọi lại, **Then** câu trả lời cho biết kết quả giống lần trước thay vì liệt kê lại.

---

### User Story 3 - Agent đọc mục lục và tóm tắt trước, rồi chỉ phần cần (Priority: P2)

Agent cần một quy chuẩn trong tài liệu dài. Nó nhận trước mục lục và tóm tắt ngắn của tài liệu (đã làm sẵn theo phiên bản, không phải làm lại mỗi lần đọc), rồi chỉ đọc mục cần.

**Why this priority**: Giảm mạnh với tài liệu lớn (tới 27k token mỗi lần), nhưng phụ thuộc 80c (đọc theo mục) và cần quyết định cách làm tóm tắt (xem FR-012).

**Independent Test**: Chọn một tài liệu trên 10k token; đọc mục lục và tóm tắt, rồi đọc một mục. Tổng token nhỏ hơn đọc cả tài liệu, và nội dung mục giống nguyên văn.

**Acceptance Scenarios**:

1. **Given** tài liệu trên ngưỡng dài, **When** agent đọc ở chế độ mặc định, **Then** agent nhận mục lục, tóm tắt và cách lấy từng mục, dưới 2k token.
2. **Given** tài liệu vừa đổi phiên bản, **When** có người đọc, **Then** mục lục và tóm tắt là của phiên bản mới; không bao giờ trả tóm tắt của phiên bản cũ kèm nội dung mới.
3. **Given** tài liệu ngắn dưới ngưỡng, **When** agent đọc, **Then** agent nhận cả nội dung như hôm nay.

---

### User Story 4 - Người quản trị thấy cache tiết kiệm được bao nhiêu (Priority: P2)

Người quản trị mở trang chi phí và thấy, theo dự án và theo gói agent: tỉ lệ đọc prompt cache, số token ghi cache trung bình mỗi run, số lần đọc tài liệu/skill/bộ nhớ được trả "không đổi", và số token ước tính đã tránh được.

**Why this priority**: Không đo thì không biết cache có lợi thật không, và không biết khi nào cache bị phá (ví dụ một thay đổi làm phần đầu ngữ cảnh khác đi mỗi run).

**Independent Test**: Sau một ngày chạy, mở trang chi phí; số liệu cache hiện theo dự án và gói, đối chiếu được với từng run.

**Acceptance Scenarios**:

1. **Given** các run trong 24 giờ / 7 ngày / 30 ngày, **When** người quản trị xem chi phí, **Then** thấy token ghi cache trung bình mỗi run và số lần trả "không đổi" theo dự án.
2. **Given** tỉ lệ ghi cache của một dự án tăng đột ngột so với 7 ngày trước, **When** người quản trị xem, **Then** thấy cảnh báo kèm lý do phần đầu ngữ cảnh đổi (từ User Story 1, kịch bản 2).
3. **Given** số token "đã tránh", **When** hiển thị, **Then** số đó ghi rõ là ước tính và cách ước tính.

---

### User Story 5 - Máy dùng lại bản sao tài liệu và skill giữa các run (Priority: P3)

Máy chạy nhiều run của cùng dự án giữ bản sao tài liệu và skill theo phiên bản. Khi run mới bắt đầu, máy chỉ hỏi hub phiên bản nào đã đổi và chỉ tải phần đổi.

**Why this priority**: Bớt lưu lượng giữa máy và hub, và là nền để agent đọc tài liệu từ file cục bộ thay vì gọi tool. Lợi ích token gián tiếp; có câu hỏi bảo mật cần chốt (FR-016).

**Independent Test**: Chạy hai run liên tiếp của cùng dự án trên một máy, không đổi tài liệu; run thứ hai không tải lại nội dung tài liệu nào.

**Acceptance Scenarios**:

1. **Given** máy có bản sao tài liệu ở phiên bản hiện tại, **When** run mới bắt đầu, **Then** máy không tải lại nội dung, chỉ kiểm phiên bản.
2. **Given** người dùng của máy đăng xuất, hoặc quyền của máy với dự án bị thu hồi, **When** sự kiện đó xảy ra, **Then** bản sao của dự án đó trên máy bị xoá.

---

### Edge Cases

- Prompt cache của nhà cung cấp hết hạn giữa hai run: run sau ghi lại cache, không lỗi; số đo ghi đúng là "hết hạn", không tính là phá cache.
- Hai máy chạy cùng dự án: mỗi tài khoản nhà cung cấp có prompt cache riêng; hệ thống không hứa dùng chung cache giữa các tài khoản.
- Loại agent không báo số token cache (một số CLI chỉ báo tổng): số đo hiện "chưa rõ", không suy ra.
- Agent bị nén ngữ cảnh giữa run và mất nội dung đã đọc: agent phải lấy lại được bản đầy đủ (User Story 2, kịch bản 3).
- Tài liệu đổi trong lúc run đang chạy: lần đọc sau trong run nhận bản mới; phần đầu ngữ cảnh của run đang chạy không đổi.
- Đề xuất sửa tài liệu (`doc_propose`) dựa trên phiên bản agent có: phiên bản trong câu trả lời "không đổi" phải đúng, để `baseVersion` không sai.
- Mục bộ nhớ bị đánh dấu `review`, `stale`, `supersededBy` sau lần tìm trước: lần tìm lại không được trả "giống lần trước".
- Hub khởi động lại hoặc cập nhật phiên bản: bản rút gọn và trạng thái "đã đọc" có thể mất; hệ thống tự làm lại, không trả kết quả sai.
- Run chỉ đọc (token `viewer`) và run của hệ thống (19c): áp dụng cùng luật, theo quyền của chính run đó.

## Requirements *(mandatory)*

### Functional Requirements

**Phần đầu ngữ cảnh ổn định (server + client)**

- **FR-001**: Với cùng dự án, loại agent, vai trò và cùng phiên bản các tài liệu/skill/tool, hệ thống MUST dựng phần đầu ngữ cảnh của run giống hệt nhau, cùng thứ tự.
- **FR-002**: Giá trị riêng của run (id task, id run, worktree, SHA, thời gian, máy) MUST chỉ nằm sau phần đầu chung.
- **FR-003**: Hệ thống MUST lưu cho mỗi run một dấu vân tay của phần đầu ngữ cảnh và danh sách phiên bản tạo nên nó, để so giữa các run và chỉ ra phần nào đổi.
- **FR-004**: Phần đầu ngữ cảnh MUST xếp theo thứ tự ít đổi trước, hay đổi sau (quy chuẩn chung, rồi tài liệu dự án, rồi skill), để một thay đổi nhỏ chỉ làm mất cache phần phía sau.

**Đọc có điều kiện (server)**

- **FR-005**: Các lệnh đọc tài liệu, skill, mục lục tài liệu MUST nhận được phiên bản mà agent đang có, và MUST trả câu trả lời ngắn "không đổi" kèm phiên bản khi phiên bản đó vẫn là mới nhất.
- **FR-006**: Hub MUST nhớ trong phạm vi một run những gì đã trả cho run đó, để trả "không đổi" cả khi agent không tự nhắc phiên bản.
- **FR-007**: Agent MUST lấy được bản đầy đủ bất cứ lúc nào bằng một yêu cầu rõ ràng.
- **FR-008**: Trước khi trả "không đổi", hub MUST kiểm tra lại quyền đọc và trạng thái gỡ của tài liệu; mất quyền hoặc đã gỡ thì trả lỗi tương ứng.
- **FR-009**: Tìm kiếm bộ nhớ lặp lại trong cùng run MUST trả "giống lần trước" chỉ khi tập kết quả và cờ của từng mục (review, stale, supersededBy, conflictsWith) không đổi.
- **FR-010**: Mô tả tool MUST nói rõ cách dùng phiên bản và cách lấy bản đầy đủ, ngắn gọn, không làm danh sách tool dài thêm quá 300 token.

**Tài liệu: mục lục và tóm tắt (tài liệu)**

- **FR-011**: Với tài liệu trên ngưỡng dài (mặc định 4k token ước tính), lệnh đọc mặc định MUST trả mục lục (tiêu đề các mục, cỡ ước tính mỗi mục) và tóm tắt, kèm cách đọc từng mục.
- **FR-012**: Tóm tắt của tài liệu MUST được làm [NEEDS CLARIFICATION: ai/cái gì làm tóm tắt? (a) tự động bằng model mỗi khi tài liệu lên phiên bản, tốn token một lần và có thể sai; (b) tác giả tự viết trong tài liệu, mục lục làm tự động; (c) chỉ mục lục tự động, không tóm tắt] và gắn với đúng một phiên bản.
- **FR-013**: Mục lục và tóm tắt MUST làm sẵn một lần cho mỗi phiên bản và dùng lại cho mọi lần đọc, không làm lại mỗi lần.
- **FR-014**: Nội dung từng mục MUST là nguyên văn của tài liệu, không phải bản tóm tắt.

**Bản sao trên máy (client)**

- **FR-015**: Máy MUST giữ bản sao tài liệu và skill của dự án theo phiên bản, và khi run mới bắt đầu chỉ tải phần đã đổi phiên bản.
- **FR-016**: Bản sao trên máy MUST được giữ [NEEDS CLARIFICATION: phạm vi lưu trên máy? (a) chỉ trong worktree của run, xoá khi run xong; (b) trong thư mục của tài khoản trên máy, dùng lại giữa các run, xoá khi đăng xuất hoặc mất quyền; (c) như (b) nhưng tắt được theo dự án cho dự án của khách hàng].
- **FR-017**: Bản sao trên máy MUST bị xoá khi người dùng của máy đăng xuất hoặc quyền của máy với dự án bị thu hồi.
- **FR-018**: Hệ thống MUST NOT lưu secret, token, mật khẩu vào bất kỳ bản cache nào (hub, máy, tóm tắt).

**Đo và báo cáo**

- **FR-019**: Mỗi run MUST lưu: dấu vân tay phần đầu ngữ cảnh (FR-003), token ghi cache, token đọc cache, số lần trả "không đổi" và số token ước tính đã tránh.
- **FR-020**: Trang chi phí MUST hiện theo dự án và gói agent, trong 24 giờ / 7 ngày / 30 ngày: token ghi cache trung bình mỗi run, tỉ lệ đọc cache, số lần trả "không đổi", số token ước tính đã tránh (ghi rõ là ước tính).
- **FR-021**: Khi token ghi cache trung bình mỗi run của một dự án tăng quá 2 lần so với trung bình 7 ngày trước, hệ thống MUST cảnh báo người quản trị, kèm phần ngữ cảnh đã đổi.
- **FR-022**: Loại agent không báo số token cache MUST hiện "chưa rõ", không suy ra.

**Phạm vi**

- **FR-023**: Phạm vi của 81 so với các mục còn mở của 80 (80c, 80e, 80g) MUST là [NEEDS CLARIFICATION: (a) 81 chỉ làm phần mới, 80c/80e/80g vẫn là task riêng và làm trước; (b) 81 gộp 80c, 80e, 80g vào, đóng các task đó; (c) 81 chỉ làm đo (FR-019 → FR-022) và phần đầu ngữ cảnh (FR-001 → FR-004), phần còn lại để sau].

### Key Entities

- **Context prefix (phần đầu ngữ cảnh)**: phần giống nhau giữa các run cùng dự án, loại agent, vai trò. Thuộc tính: dấu vân tay, danh sách thành phần (tài liệu, skill, bộ tool) và phiên bản của từng cái, cỡ ước tính.
- **Read receipt (biên nhận đọc)**: trong một run, đã trả nội dung gì ở phiên bản nào cho agent. Sống bằng thời gian của run.
- **Doc digest (bản rút gọn tài liệu)**: mục lục và tóm tắt của một tài liệu ở một phiên bản. Bị thay khi tài liệu lên phiên bản mới.
- **Machine copy (bản sao trên máy)**: nội dung tài liệu/skill theo phiên bản, của một dự án, trên một máy, gắn với tài khoản và quyền.
- **Cache metrics (số đo cache)**: theo run, gộp theo dự án/gói/thời gian: token ghi/đọc cache, số lần "không đổi", token đã tránh (ước tính), lý do phần đầu đổi.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Với run thứ hai trở đi của cùng dự án, loại agent, vai trò trong thời gian sống của prompt cache, token ghi cache trung vị mỗi run giảm ít nhất 50% so với số đo của 80 (20–77k).
- **SC-002**: Tỉ lệ token input đọc từ cache theo dự án đạt ít nhất 90% trong 7 ngày (hôm nay 74–96%).
- **SC-003**: Đọc lại tài liệu không đổi trong cùng run tốn dưới 100 token mỗi lần.
- **SC-004**: Đọc mặc định một tài liệu trên ngưỡng dài tốn dưới 2k token (hôm nay tới ~27k).
- **SC-005**: 0 trường hợp agent nhận nội dung cũ hoặc nhận "không đổi" cho tài liệu đã gỡ / không còn quyền, trong bộ test và trong 30 ngày đầu chạy thật.
- **SC-006**: Người quản trị trả lời được "tuần này cache tiết kiệm bao nhiêu, dự án nào bị phá cache" trong dưới 1 phút từ trang chi phí.
- **SC-007**: Tổng token mỗi run task (trung vị, cùng loại task) giảm ít nhất 20% so với trước khi làm 81, đo bằng số của trang *Lượt chạy*.

## Assumptions

- Prompt cache là của nhà cung cấp model (theo tài khoản, có thời gian sống); hệ thống chỉ làm cho phần đầu ngữ cảnh ổn định để dùng lại được, không tự giữ cache phía nhà cung cấp. [Unverified] Thời gian sống và cách tính giá ghi/đọc cache khác nhau giữa Claude, Codex, Gemini; cần kiểm cho từng loại khi lên plan.
- Chỉ các loại agent đã báo được token cache (Claude, Codex theo 28c; OpenCode, Kilo theo step) được đo; loại khác hiện "chưa rõ".
- Số "token đã tránh" là ước tính (số ký tự ÷ 4, như 80), không phải số do nhà cung cấp báo.
- 80a, 80b đã xong và giữ nguyên; 81 không đổi định dạng kết quả của `task_list`, `run_get`.
- Cache dữ liệu cho giao diện web/app (tốc độ, không phải token) thuộc 77, ngoài phạm vi 81.
- Nén output lệnh shell thuộc 28d (RTK), ngoài phạm vi 81.
- Tóm tắt chat leader khi mở phiên mới thuộc 80g, ngoài phạm vi 81 trừ khi FR-023 chọn gộp.
- Quyền đọc theo vai trò của 76 vẫn là nguồn sự thật; mọi lớp cache đều kiểm quyền theo 76.
- Không có dữ liệu cá nhân mới được thu thập; số đo chỉ là số đếm token theo run.
