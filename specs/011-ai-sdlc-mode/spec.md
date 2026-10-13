# Feature Specification: Chế độ AI SDLC (AI SDLC mode)

**Feature Branch**: `011-ai-sdlc-mode`

**Created**: 2026-10-13

**Status**: Draft (đã ghi quyết định của product owner ngày 2026-10-13; còn 3 câu [NEEDS CLARIFICATION])

**Input**: Yêu cầu của product owner (nguyên văn): "hệ thống này sẽ có chế độ AI SDLC, nghiên cứu xem"; "app client chỉ có
nhiệm vụ kiểm tra thôi, làm tài liệu thôi, còn AI SDLC phải chạy tất cả trên app ấy"; "có cách nào cho AI SDLC chạy full
trên web không, và các máy dưới chỉ cài worker chuyên cho AI SDLC".

**Requirements added**: SDLC-01 … SDLC-17 trong [docs/srs.md](../../docs/srs.md#320-ai-sdlc-mode-sdlc).
**Decision record**: [ADR 0021](../../docs/adr/0021-ai-sdlc-mode.md).

## Bối cảnh

Hôm nay Hive có đủ mảnh rời nhưng chưa nối thành một vòng đời:

- **Quy trình duyệt tài liệu** ([spec 004](../004-review-workflows/spec.md)): giai đoạn → checkpoint `ai`, `human`,
  `rule`, `ext`; khung mẫu `aidlc`, `speckit`, `bmad` (`packages/contracts/src/workflows.ts`); duyệt xong thì
  `doc_versions` có bản mới (baseline). `onPass: "task"` tạo **một** task chung, không ai giao; truy vết chỉ so chữ `R-n`
  trong tiêu đề task.
- **Editor tài liệu** ([spec 005](../005-doc-editor/spec.md), `packages/doc-editor`): khối R-n, đề xuất, bình luận,
  "Gửi duyệt"; dùng chung trên web và app desktop. Tài liệu **chỉ nằm trong PostgreSQL**, không vào repo dự án.
- **Task và run**: task không có phụ thuộc, không có cha con; run code chạy khi người bấm, không cần tài liệu nào đã
  duyệt. Plan mode (TASK-04) duyệt kế hoạch của **một** run.
- **Review code** ([spec 009](../009-code-review-workflows/spec.md)): PR của agent qua checkpoint rồi vào hàng merge
  (mới có contract và bảng).
- **Máy**: máy cá nhân chỉ chạy run của chủ; run của đội chạy trên máy dùng chung
  ([ADR 0017](../../docs/adr/0017-admin-web-client-app-and-machine-ownership.md)). Máy không có nhãn; hub không biết gói
  CLI và quota của máy.
- Bài học app v1: đẩy 58 task nhỏ của Spec Kit lên bảng làm bảng thành nhiễu; quyết định là **việc nhỏ là checklist trong
  task cha** ([phân tích 2026-10](../../docs/history/phan-tich-2026-10/README.md)).

Spec này thêm **chế độ AI SDLC**: một hạng mục đi từ ý tưởng tới tài liệu đã duyệt, task có phụ thuộc, PR đã review,
merge, release notes, với cổng người duyệt ở từng giai đoạn và chặn run code khi tài liệu chưa duyệt.

### Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **Hạng mục** (item, intent) | Một đơn vị công việc AI SDLC của một dự án: từ một ý tưởng hoặc issue tới merge và release. Có số thứ tự trong dự án (`012`) và slug (`hoan-tien-mot-phan`). |
| **Chế độ** (mode) | Định nghĩa vòng đời bằng **dữ liệu**: danh sách giai đoạn, tài liệu mỗi giai đoạn (đường dẫn trong repo, mục bắt buộc), bước agent, cổng duyệt, luật tách task, mức chặn. Mỗi phương pháp (AI-DLC, Spec Kit, BMAD, Kiro, OpenSpec) là một hay nhiều **preset** của cùng mô hình. |
| **Giai đoạn** (phase) | Một bước của chế độ, thuộc một trong 7 loại chuẩn: `intake`, `requirements`, `design`, `decomposition`, `implementation`, `verification`, `release`. Loại chuẩn dùng cho bảng tiến độ và chỉ số. |
| **Tài liệu giai đoạn** (artifact) | Một tài liệu Markdown của hạng mục, vừa là tài liệu hub (`project/<dự án>/sdlc/<NNN>-<slug>/<tên>`) vừa là file trong repo (vd. `specs/012-hoan-tien/spec.md`). |
| **Baseline** | Bản đã duyệt mới nhất của tài liệu (`doc_versions`, spec 004). |
| **Cổng** (gate) | Các checkpoint của quy trình duyệt spec 004 gắn với một giai đoạn. |
| **Bản tách task** (breakdown) | Kết quả đọc `tasks.md` (hoặc tương đương của preset): task hub, phụ thuộc, checklist, đợt. |
| **Đợt** (wave) | Nhóm task có phụ thuộc đã xong, chạy song song được. |
| **Ngoại lệ chặn** (override) | Quản trị đội cho run code chạy dù tài liệu bắt buộc chưa duyệt, kèm lý do, có audit. |
| **Máy worker AI SDLC** | Máy chỉ cài `hive-worker` (không cần app desktop), dùng chung cho đội, có nhãn `sdlc`, có thể đặt chỉ nhận run mang nhãn đó. |

### Nơi dùng (quyết định của product owner)

- **App desktop** là nơi người dùng **làm toàn bộ luồng**: tạo hạng mục, chọn chế độ, trả lời câu hỏi, soạn/sửa tài liệu,
  duyệt, duyệt bản tách task, theo dõi tiến độ, truy vết, xem PR/review code. App chỉ **kiểm tra (duyệt) và làm tài
  liệu**; app không tự chạy agent của AI SDLC (worker và hub chạy).
- **Web** đi hết luồng như app, bằng **cùng màn** đặt trong package dùng chung `@xdev-hive/sdlc-ui`; web có thêm phần cấu
  hình (preset chế độ, chính sách chặn, quy trình duyệt, kết nối Git) và quản trị (đội máy AI SDLC).
- **Máy worker AI SDLC** chạy agent; người vận hành dựng bằng `scripts/install.sh` / `install.ps1`, không cần app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tạo hạng mục từ ý tưởng hoặc issue, chọn chế độ hoặc nhận gợi ý (Priority: P1)

PO mở app desktop (hoặc web), vào **AI SDLC → Hạng mục → Tạo hạng mục**, chọn dự án `payment-api`, dán ý tưởng "Cho phép
hoàn tiền một phần cho đơn đã giao" (hoặc dán link issue GitHub/GitLab). Hive gợi ý **cỡ việc** (S, M, L, XL) và **chế độ**
kèm lý do ("Đụng thanh toán, nhiều màn → L → Spec Kit"). PO giữ gợi ý hoặc chọn chế độ khác trong danh sách dự án cho
phép, rồi bấm Tạo. Hạng mục `012-hoan-tien-mot-phan` xuất hiện trên bảng ở giai đoạn đầu.

**Why this priority**: Điểm vào của mọi thứ khác. Gợi ý theo cỡ tránh dùng quy trình nặng cho việc nhỏ (phê bình của
Böckeler: Markdown dài, quá nặng cho bug nhỏ).

**Independent Test**: Dự án bật AI SDLC với chế độ cho phép `speckit`, `bugfix`, `small`. Tạo hạng mục từ issue có nhãn
`bug` và mô tả 3 dòng: gợi ý `bugfix`, cỡ S, lý do có nhắc nhãn `bug`. Tạo từ ý tưởng 2 đoạn có chữ "thanh toán": gợi ý
cỡ ≥ M, chế độ `speckit`. Chọn khác gợi ý: audit `sdlc.item.create` ghi cả gợi ý và lựa chọn.

**Acceptance Scenarios**:

1. **Given** dự án bật AI SDLC, **When** người có quyền `sdlc.write` nhập ý tưởng ≥ 20 ký tự, **Then** hub trả gợi ý cỡ
   và chế độ trong ≤ 3 giây bằng luật tất định (nhãn issue, độ dài, từ khoá rủi ro do dự án khai), kèm nút "Nhờ agent
   ước lượng" chạy bước `size` của agent (kết quả về khi run xong).
2. **Given** link issue của repo dự án, **When** tạo hạng mục, **Then** tiêu đề, nội dung, nhãn lấy từ issue; issue nhận
   một bình luận có link hạng mục; issue đã gắn hạng mục khác thì báo "Issue này đã có hạng mục 009." và không tạo trùng.
3. **Given** chế độ không nằm trong danh sách dự án cho phép, **When** gửi, **Then** bị từ chối "Dự án không cho dùng chế
   độ này.".
4. **Given** hạng mục mới, **When** tạo xong, **Then** hub đặt số `NNN` kế tiếp của dự án, slug từ tiêu đề (bỏ dấu), thư
   mục repo theo preset (vd. `specs/012-hoan-tien-mot-phan/`), các tài liệu hub rỗng theo khuôn của preset, và giai đoạn
   đầu ở trạng thái "Đang soạn".
5. **Given** leader của dự án (LEAD-02) đề xuất hành động `sdlc.item.create`, **When** người duyệt đề xuất, **Then** hạng
   mục được tạo như trên, người duyệt là chủ hạng mục.

---

### User Story 2 - Agent soạn tài liệu và hỏi lại khi thiếu; người trả lời trên app/web (Priority: P1)

Giai đoạn bắt đầu thì hub tạo **run soạn** (loại `sdlc`) trên máy worker AI SDLC: agent đọc repo, ý tưởng, các tài liệu đã
duyệt của giai đoạn trước, rồi viết tài liệu của giai đoạn (vd. `spec.md`) theo khuôn của preset. Chỗ chưa rõ, agent gửi
tối đa 5 câu hỏi (mỗi câu có lựa chọn và đề xuất). Câu hỏi hiện ở hạng mục và ở **Câu hỏi chờ tôi** trên app/web; PO trả
lời hoặc bấm "Dùng đề xuất". Có câu trả lời, agent soạn lại và ghi các quyết định vào mục "Clarifications" của tài liệu.

**Why this priority**: "AI soạn, người duyệt" là quyết định của PO; hỏi lại là cách tránh agent tự bịa yêu cầu.

**Independent Test**: Hạng mục chế độ `speckit`. Worker giả nhận run `sdlc` bước `draft`, gọi `sdlc_ask` với 2 câu hỏi rồi
nộp `specs/012-…/spec.md` còn 2 dấu `[NEEDS CLARIFICATION`. Kiểm: hạng mục ở "Chờ trả lời (2)"; người chủ thấy 2 câu ở
app; trả lời 1 câu, chọn đề xuất cho câu kia; hub tạo run `draft` vòng 2 có cả hai câu trả lời trong prompt; worker giả nộp
bản không còn dấu; bản nháp tài liệu hub được cập nhật thành đề xuất trong editor.

**Acceptance Scenarios**:

1. **Given** giai đoạn có bước `draft`, **When** giai đoạn bắt đầu, **Then** hub tạo run `sdlc` với chủ run theo cấu hình
   dự án (`team` mặc định: chỉ máy dùng chung, có nhãn yêu cầu nếu dự án đặt), worktree từ nhánh mặc định cộng các
   baseline của hạng mục chưa kịp vào repo, và không đẩy commit nào.
2. **Given** agent gọi `sdlc_ask` với 7 câu, **When** hub nhận, **Then** chỉ nhận 5 câu đầu, trả cho agent cảnh báo "Tối đa
   5 câu mỗi vòng.".
3. **Given** run soạn xong, **When** worker trả file tài liệu, **Then** hub ghi nội dung vào **bản nháp** tài liệu hub
   (editor spec 005) dưới tên agent, không gửi duyệt tự động nếu còn câu hỏi mở; nếu không còn câu hỏi và chế độ đặt
   "tự gửi duyệt" thì gửi duyệt ngay.
4. **Given** câu hỏi đang mở, **When** người dùng trả lời trên app, **Then** câu trả lời hiện trên web trong ≤ 10 giây và
   ngược lại; trả lời đủ thì nút "Soạn lại với câu trả lời" bật (hoặc tự chạy nếu chế độ đặt `auto`).
5. **Given** người dùng muốn tự viết, **When** mở tài liệu trong **Soạn tài liệu**, **Then** sửa trực tiếp bằng editor
   spec 005; bấm "Nhờ agent soạn lại" kèm chỉ dẫn thì có run `draft` mới đọc bản nháp hiện tại.
6. **Given** không có máy phù hợp (không có máy dùng chung / thiếu nhãn), **When** run soạn chờ, **Then** hạng mục hiện
   "Chờ máy AI SDLC" kèm lý do (`waiting_machine`), quản trị đội nhận thông báo một lần.

---

### User Story 3 - Duyệt theo giai đoạn, baseline, sang giai đoạn kế (Priority: P1)

Tài liệu soạn xong được **Gửi duyệt** qua cổng của giai đoạn (quy trình duyệt spec 004, chụp từ chế độ): AI tự kiểm, luật
(mục bắt buộc, không còn `[NEEDS CLARIFICATION`, mỗi requirement có tiêu chí chấp nhận), rồi BA/PO/Tech lead duyệt trong
**Chờ tôi duyệt**. Mọi tài liệu bắt buộc của giai đoạn có baseline thì giai đoạn **Đã duyệt**, giai đoạn kế bắt đầu.

**Why this priority**: Cổng người ở checkpoint là điều kiện của chặn cứng và của đồng bộ repo.

**Independent Test**: Chế độ `speckit`, giai đoạn Specify có cổng: rule (`sections`, `requirements`, `no-open-questions`),
human (PO). Gửi `spec.md` còn một `[NEEDS CLARIFICATION`: checkpoint rule không đạt, trả lại người viết. Sửa, gửi lại,
PO duyệt: `doc_versions` có bản mới, giai đoạn Specify `approved`, run `draft` của Plan được tạo.

**Acceptance Scenarios**:

1. **Given** tài liệu của hạng mục, **When** gửi duyệt, **Then** hub mở phiên duyệt bằng **cổng của giai đoạn trong bản
   chụp chế độ của hạng mục**, không dùng luật chọn quy trình theo tiền tố (spec 004 `matchWorkflow`).
2. **Given** phiên duyệt đang mở, **When** BA mở "Chờ tôi duyệt" trên app, **Then** mục có nhãn hạng mục và giai đoạn
   ("012 · Specify"), khung chi tiết là `ReviewPane` của spec 005 cộng thẻ "Câu hỏi đã trả lời" và (ở giai đoạn tách task)
   thẻ "Bản tách task".
3. **Given** người duyệt trả lại với hướng "agent", **When** gửi, **Then** hub tạo run `sdlc` bước `draft` với góp ý (thay
   cho task chung của spec 004), giới hạn số lượt như spec 009 (mặc định 2).
4. **Given** giai đoạn có hai tài liệu bắt buộc, **When** mới một tài liệu có baseline, **Then** giai đoạn vẫn "Đang
   duyệt" và bảng hiện "1/2 tài liệu đã duyệt".
5. **Given** giai đoạn có tài liệu tuỳ chọn, **When** tài liệu bắt buộc đã duyệt, **Then** giai đoạn đạt; tài liệu tuỳ chọn
   chưa duyệt không chặn.
6. **Given** chủ hạng mục, **When** bấm "Bỏ qua giai đoạn" ở giai đoạn đánh dấu `optional`, **Then** giai đoạn `skipped`
   với lý do bắt buộc; giai đoạn không `optional` thì chỉ ngoại lệ (US6) mới qua được.

---

### User Story 4 - Tài liệu ở cả hub và repo, đồng bộ hai chiều (Priority: P1)

Baseline xong, hub **commit Markdown vào repo dự án** ở đường dẫn của preset (`specs/012-hoan-tien-mot-phan/spec.md`) để
agent và người đọc ngay trong repo. Dev sửa `spec.md` trong một PR rồi merge: hub thấy nội dung repo khác baseline và tạo
**đề xuất** sửa tài liệu trên hub, đi lại cổng của giai đoạn; duyệt thì thành baseline mới, không cần commit lại.

**Why this priority**: Quyết định "cả hai, đồng bộ" của PO. Agent đọc file trong repo; người duyệt dùng editor hub.

**Independent Test**: Provider `memory`. Duyệt `spec.md` → có commit trên nhánh đồng bộ chứa đúng nội dung baseline,
`sdlc_artifacts.synced_version = baseline_version`. Giả webhook `push` vào nhánh mặc định với `spec.md` sửa một dòng →
đề xuất mới trên hub, lý do "Sửa trong repo: <sha ngắn>", phiên duyệt mở; push lại với nội dung giống baseline → không có
đề xuất.

**Acceptance Scenarios**:

1. **Given** tài liệu vừa có baseline, **When** job đồng bộ chạy, **Then** hub ghi file vào repo theo cách đồng bộ của dự
   án (xem [NEEDS CLARIFICATION Q1]) trong ≤ 2 phút, lưu commit SHA và hash nội dung; commit có trailer
   `Co-authored-by` của người viết và người duyệt.
2. **Given** commit lên repo lỗi (mất quyền, nhánh bảo vệ), **When** job chạy, **Then** thử lại theo lịch (tối đa 6 lần
   trong 1 giờ), hạng mục hiện "Chưa đồng bộ" với lý do, quản trị dự án nhận thông báo; run code vẫn đọc được tài liệu
   qua seed file (US2-1) nên không bị chặn vì đồng bộ chậm.
3. **Given** push vào nhánh mặc định đổi file của một tài liệu đang theo dõi, **When** nội dung khác baseline và commit
   không phải commit đồng bộ của hub, **Then** hub tạo đề xuất (tác giả: người đẩy nếu khớp được tài khoản, không thì
   "Người sửa trong repo"), mở phiên duyệt theo cổng giai đoạn; trạng thái tài liệu "Lệch repo".
4. **Given** đề xuất từ repo bị trả lại hoặc từ chối, **When** phiên đóng, **Then** hub **không** sửa repo ngược lại tự
   động; tài liệu giữ "Lệch repo" và có nút "Ghi đè repo bằng baseline" (quản trị dự án, có xác nhận).
5. **Given** trên hub đang có bản nháp hoặc phiên duyệt cho cùng tài liệu, **When** repo đổi, **Then** đề xuất từ repo
   vẫn tạo nhưng ghi chú "Xung đột với bản nháp của X"; editor đã có thao tác "Rebase" (spec 005).
6. **Given** file bị xoá trong repo, **When** push tới, **Then** tài liệu "Lệch repo (đã xoá)", không xoá tài liệu hub.

---

### User Story 5 - Tách task thành DAG, việc nhỏ là checklist, duyệt bản tách (Priority: P1)

Ở giai đoạn tách task, agent viết `tasks.md` theo định dạng của preset. Hub **đọc** `tasks.md` thành bản tách: mỗi task
hub là một việc giao được cho **một run, một PR**; các bước nhỏ là checklist trong task; phụ thuộc thành đồ thị; task
không phụ thuộc nhau gom thành đợt. Tech lead duyệt bản tách ở màn **Duyệt bản tách task** (xem đồ thị, gộp/tách, sửa phụ
thuộc, xem độ phủ requirement). Duyệt xong, hub tạo task trên bảng với phụ thuộc và checklist.

**Why this priority**: Nối tài liệu với việc chạy được, đúng bài học "board chỉ giữ việc giao được cho một run".

**Independent Test**: `tasks.md` mẫu Spec Kit có 3 phần, 14 dòng `T###`, 4 dòng phụ thuộc, 6 requirement `FR-00x`.
Độ mịn `heading`: bản tách có 3 task hub, mỗi task có checklist 4–5 mục, phụ thuộc giữa phần 2 → 1 và 3 → 1, đợt 1 = {1},
đợt 2 = {2, 3}. Một `FR-006` không có task nào → checkpoint rule `coverage` không đạt, tên requirement thiếu hiện trong
checklist. Thêm task cho `FR-006`, duyệt → 3 task hub có `dependsOn`, checklist, nhãn hạng mục.

**Acceptance Scenarios**:

1. **Given** `tasks.md` không đọc được (dòng phụ thuộc trỏ tới task không có, có vòng), **When** gửi duyệt, **Then**
   checkpoint rule `breakdown` không đạt, ghi số dòng và lỗi tiếng Việt ("Dòng 42: T009 phụ thuộc T099 không có.").
2. **Given** bản tách vượt giới hạn của chế độ (mặc định 30 task hub, 20 mục checklist mỗi task), **When** kiểm, **Then**
   checkpoint rule không đạt kèm gợi ý "Gộp theo phần (độ mịn heading)".
3. **Given** người duyệt sửa bản tách trên màn Duyệt bản tách (gộp hai task, thêm phụ thuộc), **When** lưu, **Then** hub
   ghi lại `tasks.md` của bản nháp theo định dạng preset (không có hai nguồn sự thật), đề xuất mới thay đề xuất cũ.
4. **Given** `tasks.md` có baseline, **When** hub tạo task, **Then** mỗi task có `title`, `body` (tóm tắt + đường dẫn tài
   liệu + requirement liên quan), `checklist`, `dependsOn`, `source = {kind: "sdlc", itemId, sliceKey}`, trạng thái `todo`;
   task có phụ thuộc chưa xong hiện "Chờ T-…".
5. **Given** `tasks.md` được duyệt lại sau khi đã có task, **When** hub so bản tách mới với cũ, **Then** task mới được tạo;
   task còn `todo` được cập nhật; task bị bỏ còn `todo` thành `cancelled`; task bị bỏ đã chạy thì giữ và gắn cảnh báo
   "Không còn trong tasks.md" cho tech lead.
6. **Given** chế độ nhẹ (`bugfix`, `small`), **When** giai đoạn tách task không có, **Then** hub tạo đúng **một** task với
   checklist lấy từ mục "Cách sửa" / danh sách việc của tài liệu.

---

### User Story 6 - Chạy theo đợt, chặn cứng có ngoại lệ, mỗi task một PR qua review code (Priority: P1)

Bản tách đã duyệt thì chủ hạng mục bấm **Chạy đợt** (hoặc chế độ đặt tự chạy): hub tạo run code cho các task sẵn sàng
(phụ thuộc đã merge) tới mức song song của dự án. Run code của task thuộc hạng mục **chỉ chạy khi mọi tài liệu bắt buộc
của các giai đoạn trước giai đoạn triển khai đã có baseline**. Quản trị đội được bỏ qua kèm lý do. Mỗi task mở một PR
nhánh `ai/<task>`, đi qua quy trình review code (spec 009) hoặc chính sách kết quả của dự án; merge xong thì task kế mở
khoá.

**Why this priority**: Quyết định "chặn cứng có ngoại lệ" của PO; là phần tạo ra code.

**Independent Test**: Hạng mục `speckit`, `plan.md` chưa duyệt. Gọi `runs.start` cho task của hạng mục → lỗi
`SDLC_GATE_BLOCKED` với danh sách "plan.md (Plan) chưa duyệt". Quản trị đội tạo ngoại lệ lý do "Hotfix khách hàng A" →
`runs.start` được, audit `sdlc.override`, quản trị tổ chức nhận thông báo. Duyệt `plan.md`, `tasks.md`; bấm Chạy đợt với
song song 2 → 2 run cho đợt 1; giả webhook merge PR của task 1 → task 2 phụ thuộc task 1 được chạy.

**Acceptance Scenarios**:

1. **Given** task thuộc hạng mục chế độ chặn `hard`, **When** bất kỳ đường nào tạo run code (web, app, leader, bình luận
   @bot, issue), **Then** hub kiểm ở `queueRun` và từ chối với `SDLC_GATE_BLOCKED` liệt kê tài liệu thiếu; không có run nào
   được tạo.
2. **Given** chế độ chặn `soft`, **When** tạo run, **Then** run chạy nhưng có cảnh báo trên run và hạng mục; chế độ `none`
   không kiểm.
3. **Given** task có phụ thuộc chưa `done`, **When** tạo run, **Then** từ chối `TASK_DEPENDENCIES_OPEN` (cùng cơ chế ngoại
   lệ).
4. **Given** ngoại lệ có phạm vi "một task" hoặc "cả hạng mục", **When** quản trị đội tạo, **Then** lý do bắt buộc (≥ 10
   ký tự), hạn tuỳ chọn, audit `sdlc.override`, thông báo `sdlc.override` cho quản trị tổ chức và chủ hạng mục; ngoại lệ
   thu hồi được.
5. **Given** tài liệu đã có baseline đang có đề xuất sửa trong duyệt, **When** tạo run, **Then** không chặn (baseline cũ vẫn
   là baseline); prompt của run dùng baseline.
6. **Given** run code của task trong hạng mục, **When** dispatch, **Then** prompt có: tóm tắt hạng mục, đường dẫn tài liệu
   trong repo, requirement của task (chữ đầy đủ), checklist; agent đánh dấu checklist bằng MCP `task_update`.
7. **Given** PR của task có quy trình review code khớp (spec 009), **When** checkpoint AI chạy, **Then** reviewer nhận
   requirement và tiêu chí chấp nhận của task để chấm "đúng spec".
8. **Given** chủ hạng mục bấm "Tạm dừng", **When** đợt đang chạy, **Then** không tạo run mới; run đang chạy chạy tiếp.

---

### User Story 7 - Đi hết luồng trên app desktop hoặc web, menu theo hồ sơ (Priority: P1)

BA mở app desktop: menu có nhóm **AI SDLC** với Hạng mục, Câu hỏi chờ tôi, Tiến độ; "Chờ tôi duyệt" và "Soạn tài liệu"
đã có. Dev thấy thêm "Việc của tôi" với task của hạng mục. Tech lead thấy thêm "Ngoại lệ chặn", "Chạy đợt". Trên web, cùng
các màn ở `/sdlc/...` do package `@xdev-hive/sdlc-ui` dựng, cộng trang cấu hình chế độ và đội máy.

**Why this priority**: PO yêu cầu app là nơi làm toàn bộ luồng và web cũng đi hết luồng; không bắt người dùng mở web.

**Independent Test**: Desktop với hồ sơ `writer` (BA/PO, xem Q2): tạo hạng mục, trả lời câu hỏi, sửa `spec.md`, duyệt
`spec.md`, xem bảng — không mở web. Hồ sơ `lead`: duyệt bản tách, tạo ngoại lệ, chạy đợt. Cùng kịch bản trên web
(Playwright với hub giả) cho ra cùng dữ liệu.

**Acceptance Scenarios**:

1. **Given** hồ sơ app bất kỳ có quyền `sdlc.use`, **When** mở app, **Then** nhóm menu **AI SDLC** có: Hạng mục (bảng +
   danh sách), Câu hỏi chờ tôi (badge số), Tiến độ và chỉ số.
2. **Given** hồ sơ có `sdlc.manage`, **When** mở chi tiết hạng mục, **Then** có nút Chạy đợt, Tạm dừng, Tạo ngoại lệ, Huỷ
   hạng mục; hồ sơ khác không thấy các nút này (hub vẫn kiểm quyền).
3. **Given** chi tiết hạng mục, **When** bấm vào một tài liệu, **Then** app mở **Soạn tài liệu** (`#/write/<key>`) với
   khung bên "Hạng mục 012 · Specify" (khuôn, mục bắt buộc, câu hỏi đã trả lời).
4. **Given** web, **When** người dùng mở `/sdlc`, **Then** thấy cùng màn với app (cùng component), chữ theo `vi`/`en`.
5. **Given** người dùng chỉ có quyền đọc, **When** mở hạng mục, **Then** xem được mọi thứ, không có nút ghi.

---

### User Story 8 - Quản trị cấu hình chế độ và bật AI SDLC cho dự án trên web (Priority: P1)

Quản trị đội mở **Cài đặt dự án → AI SDLC**: bật, chọn chế độ mặc định và chế độ được dùng, mức chặn, cách đồng bộ repo,
mức song song, nơi chạy agent (máy dùng chung có nhãn nào). Quản trị tổ chức mở **Chế độ AI SDLC** (`/admin/sdlc-modes`)
xem preset có sẵn, nhân bản và sửa (thêm giai đoạn, đổi đường dẫn, đổi cổng duyệt, đổi prompt bước), chạy thử để xem
đường dẫn và cổng sẽ dùng.

**Why this priority**: Preset có sẵn chạy được ngay, nhưng dự án phải bật và chọn; chế độ là dữ liệu nên phải có chỗ sửa.

**Independent Test**: Nhân bản preset `speckit` thành "Spec Kit — Thanh toán", thêm checkpoint người duyệt "Pháp chế"
cho Specify khi có từ khoá "hoàn tiền", đổi đường dẫn thành `docs/specs/{NNN}-{slug}/`. Chạy thử với tiêu đề "Hoàn tiền"
→ thấy đường dẫn và 3 checkpoint. Gắn chế độ cho `payment-api`. Hạng mục mới dùng bản chụp chế độ mới; hạng mục cũ giữ
bản chụp cũ.

**Acceptance Scenarios**:

1. **Given** preset có sẵn, **When** quản trị mở, **Then** chỉ xem và nhân bản được, không sửa trực tiếp.
2. **Given** chế độ tự tạo có đường dẫn `../x` hoặc `.github/workflows/x.md`, **When** lưu, **Then** bị từ chối "Đường dẫn
   tài liệu phải nằm trong repo và không thuộc thư mục bị cấm.".
3. **Given** chế độ có giai đoạn `implementation` mà không có giai đoạn trước nào có tài liệu bắt buộc, **When** lưu với
   mức chặn `hard`, **Then** cảnh báo "Chặn cứng không có tác dụng: chưa có tài liệu bắt buộc.".
4. **Given** CLI hoặc model của bước bị chính sách agent của tổ chức cấm, **When** lưu, **Then** bị từ chối như spec 009
   FR-011.
5. **Given** chế độ đang dùng bởi hạng mục mở, **When** sửa, **Then** hạng mục mở giữ bản chụp; trang hiện số hạng mục
   đang dùng bản cũ.

---

### User Story 9 - Truy vết requirement → task → run → PR → merge, báo độ phủ (Priority: P2)

Người duyệt mở tab **Truy vết** của hạng mục: ma trận mỗi requirement (FR-001, R-3, EARS 1.2 …) với task, run, PR, trạng
thái merge, test chứng minh. Độ phủ: % requirement có task (đã lên kế hoạch), có PR đã merge (đã làm), có test/CI chứng
minh (đã kiểm).

**Why this priority**: Không có truy vết thì không biết hạng mục đã xong thật hay chưa; P2 vì luồng chạy được trước.

**Independent Test**: Hạng mục 6 requirement, 3 task; task 1 (FR-001, FR-002) merged, agent báo test cho FR-001; task 2
(FR-003) đang review; task 3 (FR-004..006) todo. Độ phủ: kế hoạch 100%, đã làm 33%, đã kiểm 17%. Xuất CSV đúng 6 dòng.

**Acceptance Scenarios**:

1. **Given** bản tách đã duyệt, **When** mở Truy vết, **Then** mỗi requirement liệt kê task chứa nó (từ bản tách, không
   khớp chữ tự do như `traceOf` cũ).
2. **Given** run code xong có PR, **When** PR merge, **Then** liên kết `run`, `pr`, `commit` (SHA merge) được ghi.
3. **Given** agent gọi `task_update` với `evidence.requirements = ["FR-001"]` và `evidence.tests`, **When** run kết luận,
   **Then** liên kết `test` được ghi cho FR-001; CI xanh trên commit merge nâng mức "đã kiểm".
4. **Given** requirement không có task, **When** xem, **Then** dòng tô cảnh báo "Chưa có task".

---

### User Story 10 - Converge: kiểm lệch spec–code, thêm việc còn thiếu (Priority: P2)

Mọi task merge xong (hoặc khi chủ bấm), hub chạy bước **converge**: agent đọc tài liệu đã duyệt và code ở đầu nhánh mặc
định, báo từng requirement `met`, `partial`, `missing`, `contradicts` kèm bằng chứng, và đề xuất task bổ sung. Tech lead
duyệt phần bổ sung (thêm vào `tasks.md` qua cổng tách task); lặp tới khi "Đã hội tụ" hoặc hết số vòng.

**Why this priority**: Đóng khoảng giữa "đã merge" và "đúng spec" (Spec Kit converge, AI-DLC phase check); P2 vì cần
truy vết trước.

**Independent Test**: Worker giả trả `sdlc_report` loại `findings`: FR-004 `missing`, FR-005 `met`. Kiểm: hạng mục ở
"Chưa hội tụ (vòng 1/3)", đề xuất bổ sung 1 task; duyệt → `tasks.md` có task mới, đợt mới; vòng 2 trả hết `met` → "Đã hội
tụ".

**Acceptance Scenarios**:

1. **Given** chế độ có `converge.maxRounds = 3`, **When** vòng 3 vẫn còn `missing`, **Then** dừng, báo chủ hạng mục, không
   tự tạo vòng 4.
2. **Given** kết quả `contradicts`, **When** hiện, **Then** có hai hướng: "Sửa code" (thêm task) hoặc "Sửa tài liệu" (mở
   đề xuất cho tài liệu chứa requirement).
3. **Given** chế độ nhẹ, **When** không có bước converge, **Then** hạng mục xong khi task duy nhất merge.

---

### User Story 11 - Release notes và retro, bài học vào constitution (Priority: P3)

Hạng mục hội tụ thì giai đoạn **release**: agent soạn `release-notes.md` từ PR đã merge và truy vết; PO duyệt; hub commit
như tài liệu khác. Retro: hub tính chỉ số của hạng mục, agent soạn `retro.md` và đề xuất sửa tài liệu "constitution" (hoặc
steering) của dự án; đề xuất đi quy trình duyệt tài liệu thường.

**Why this priority**: Giá trị thật nhưng không chặn việc giao code; P3.

**Independent Test**: Hạng mục có 3 PR merged. Bước `release-notes` tạo bản nháp có 3 dòng PR, nhóm theo story. Bước
`retro` tạo `retro.md` có bảng chỉ số và một đề xuất cho `project/payment-api/constitution`.

**Acceptance Scenarios**:

1. **Given** dự án chưa có tài liệu constitution, **When** retro đề xuất bài học, **Then** đề xuất tạo tài liệu mới ở key
   mặc định của preset (`.specify/memory/constitution.md` ↔ `project/<key>/constitution`).
2. **Given** retro xong và release notes đã duyệt, **When** đóng hạng mục, **Then** trạng thái `done`, issue nguồn (nếu
   có) nhận bình luận tóm tắt và link release notes.

---

### User Story 12 - Bảng tiến độ theo giai đoạn và chỉ số (Priority: P2)

PO và tech lead mở **Tiến độ**: bảng cột theo loại giai đoạn chuẩn (Tiếp nhận, Yêu cầu, Thiết kế, Tách task, Triển khai,
Kiểm, Phát hành), mỗi thẻ hạng mục có chế độ, chờ ai, độ phủ, chi phí. Tab **Chỉ số**: lead time theo giai đoạn, thời gian
chờ ở cổng người, tỉ lệ trả lại, số câu hỏi, độ phủ, số vòng converge, số vòng review code mỗi PR, chi phí agent mỗi hạng
mục.

**Why this priority**: Cho quản lý thấy nút thắt; P2 vì cần dữ liệu từ các story trên.

**Independent Test**: Dữ liệu mẫu 40 hạng mục ở các giai đoạn. Bảng có 7 cột đúng số thẻ; lọc theo dự án và chế độ.
Chỉ số lead time giai đoạn Yêu cầu p50 khớp tính tay trên dữ liệu mẫu.

**Acceptance Scenarios**:

1. **Given** hạng mục chờ người duyệt, **When** xem thẻ, **Then** thẻ ghi "Chờ An (PO) · quá hạn 3 giờ" theo SLA spec 004.
2. **Given** hạng mục chờ máy, **When** xem, **Then** thẻ ghi "Chờ máy AI SDLC".
3. **Given** tab Chỉ số, **When** chọn 30 ngày, **Then** mỗi chỉ số có giá trị, p50/p90 khi là thời gian, và link tới danh
   sách hạng mục góp vào chỉ số.

---

### User Story 13 - Người vận hành dựng máy worker AI SDLC không cần app (Priority: P2)

Người vận hành (quản trị đội) trên web bấm **Đội máy AI SDLC → Thêm máy**, nhận lệnh cài một dòng có mã đăng ký đã gắn
nhãn `sdlc`, dùng chung, "chỉ nhận run AI SDLC". Trên máy Linux/macOS chạy `curl … | sh -s -- <mã>` (Windows:
`install.ps1`); worker cài như service, đăng ký vào hub. Người vận hành thêm gói CLI bằng `hive-worker accounts add claude`
(đăng nhập trên máy đó) hoặc `hive-worker accounts discover`. Máy hiện trên web với nhãn, CLI, gói, quota.

**Why this priority**: PO muốn "các máy dưới chỉ cài worker chuyên cho AI SDLC". P2 vì máy dùng chung hiện có đã chạy
được run của đội.

**Independent Test**: Tạo mã đăng ký có `labels: ["sdlc"]`, `shared: true`, `labelsOnly: true`. Chạy `install.sh` trong
container Linux với hub thử: máy đăng ký có đúng nhãn, `shared`, `labels_only`; `systemctl --user status hive-worker`
chạy. `accounts add` một tài khoản giả → heartbeat kế có tóm tắt tài khoản, web hiện gói và % quota.

**Acceptance Scenarios**:

1. **Given** quản trị đội tạo mã đăng ký với nhãn và cờ, **When** worker đăng ký bằng mã, **Then** máy nhận nhãn và cờ từ
   mã (hub là nguồn sự thật; worker không tự khai nhãn).
2. **Given** máy chạy không có phiên đăng nhập (server Linux), **When** cài, **Then** script nhắc bật `loginctl
   enable-linger` để service chạy sau khi đăng xuất; tài liệu vận hành có mục này.
3. **Given** máy dùng chung có 3 tài khoản Claude, **When** worker gửi heartbeat, **Then** hub lưu tóm tắt (CLI, nhãn tài
   khoản, vai trò, bật/tạm dừng, % phiên 5 giờ, % tuần, giờ đặt lại, ngưỡng dừng) — không có token hay email đầy đủ.
4. **Given** worker cũ không gửi tóm tắt tài khoản, **When** xem trên web, **Then** cột gói ghi "Máy chưa báo gói".

---

### User Story 14 - Nhãn máy và lọc run theo máy (Priority: P2)

Quản trị đội gắn nhãn cho máy (`sdlc`, `gpu`, `windows`) và bật "Chỉ nhận run có nhãn của máy". Dự án đặt run AI SDLC yêu
cầu nhãn `sdlc`. Hub chỉ giao run có nhãn yêu cầu cho máy có đủ nhãn; máy "chỉ nhận run có nhãn" không nhận run khác.

**Why this priority**: Cần để tách máy AI SDLC khỏi máy chạy việc thường; P2 vì không có nhãn thì luồng vẫn chạy trên
máy dùng chung.

**Independent Test**: Hai máy dùng chung: A nhãn `sdlc` + chỉ nhận có nhãn; B không nhãn. Run `sdlc` yêu cầu `sdlc` → chỉ
A. Run code thường không nhãn → chỉ B. Run yêu cầu `gpu` → không máy nào, sự kiện `waiting_machine` lý do "Không máy nào
có nhãn gpu".

**Acceptance Scenarios**:

1. **Given** run có `required_labels`, **When** dispatch, **Then** chỉ máy có mọi nhãn đó là ứng viên (cộng các luật cũ:
   `usableBy`, slot, CLI, capability).
2. **Given** máy `labels_only`, **When** dispatch run không có nhãn nào của máy, **Then** máy không là ứng viên.
3. **Given** quản trị đổi nhãn máy, **When** lưu, **Then** áp cho lần dispatch kế, không cần khởi động lại worker; audit
   `machine.labels`.
4. **Given** tên nhãn sai định dạng, **When** lưu, **Then** từ chối "Nhãn gồm chữ thường không dấu, số, `-`, tối đa 32 ký
   tự.".

---

### User Story 15 - Web xem đội máy AI SDLC: trạng thái, quota, run đang chạy (Priority: P2)

Quản trị đội mở **Đội máy AI SDLC** (`/sdlc/fleet`): mỗi máy có trạng thái (online, offline, tạm dừng), nhãn, CLI, slot
đang dùng, run đang chạy (hạng mục, bước), tóm tắt gói và quota. Trên máy dùng chung, quản trị bật/tắt một gói (vd. để
dành gói cho người khác) — worker áp ngay.

**Why this priority**: PO cần thấy đội máy chạy AI SDLC. Bật/tắt gói từ web cần thêm tin nhắn giao thức (xem plan).

**Independent Test**: Hai máy, một đang chạy run `sdlc` bước `draft` của 012. Trang hiện đúng run và hạng mục. Tắt gói
`claude:work-2` trên máy dùng chung có worker hỗ trợ → worker nhận `account_set`, heartbeat kế báo gói tắt. Máy cá nhân
không có nút bật/tắt.

**Acceptance Scenarios**:

1. **Given** máy cá nhân, **When** quản trị đội xem, **Then** chỉ thấy trạng thái và nhãn; không thấy gói của người khác
   (ADR 0017).
2. **Given** worker không báo hỗ trợ `accounts-remote`, **When** quản trị bấm tắt gói, **Then** nút bị khoá với chú thích
   "Cập nhật worker để điều khiển gói từ web.".
3. **Given** mọi gói của máy dưới ngưỡng dừng, **When** dispatch, **Then** máy từ chối offer như hiện nay; trang hiện "Hết
   quota tới HH:MM".

---

### Edge Cases

- **Dự án đổi chế độ mặc định khi có hạng mục mở**: hạng mục giữ bản chụp chế độ lúc tạo; đổi chế độ của một hạng mục
  đang mở chỉ được trước khi giai đoạn đầu có baseline.
- **Tài liệu hub bị sửa ngoài luồng hạng mục** (trang Tài liệu, MCP `doc_propose`): vẫn đi cổng của giai đoạn vì key thuộc
  `project/<dự án>/sdlc/…` và hub chọn cổng theo hạng mục cho mọi đề xuất trên key đó.
- **Hai hạng mục cùng đường dẫn repo** (số trùng sau khi đổi tên thư mục bằng tay): tạo hạng mục từ chối khi đường dẫn đã
  có file không thuộc hạng mục nào ("Thư mục specs/012-… đã có trong repo."), gợi ý "Nhận thư mục có sẵn làm hạng mục".
- **Nhận hạng mục từ thư mục có sẵn trong repo** (brownfield, vd. `specs/009-…` đã viết tay): tạo hạng mục, đọc file làm
  bản đầu, đánh dấu "Nhập từ repo"; baseline cần duyệt như thường (không tự tin bản trong repo).
- **Agent ghi file ngoài danh sách thu**: worker chỉ trả các đường dẫn của bước; file khác bị bỏ, run có ghi chú.
- **Agent không nộp tài liệu** (run xong không có file, không có câu hỏi): bước `failed` với lý do; hạng mục hiện nút chạy
  lại.
- **Tài liệu quá lớn** (> 200 000 ký tự, giới hạn `DOC_MAX_CHARS`): bước `failed` "Tài liệu quá dài, tách thành nhiều
  file.".
- **Vòng trong phụ thuộc** sau khi người sửa bản tách: lưu bị từ chối, chỉ ra chu trình.
- **Task bị huỷ trong hạng mục**: task phụ thuộc vào nó hiện "Phụ thuộc đã huỷ"; tech lead bỏ phụ thuộc hoặc huỷ theo.
- **Task phụ thuộc đã `done` nhưng PR bị revert**: không tự mở lại; converge sẽ phát hiện.
- **Ngoại lệ hết hạn khi run đang chạy**: run chạy tiếp; run mới bị chặn lại.
- **Không có máy dùng chung nào có nhãn yêu cầu**: run chờ, `waiting_machine` một lần, quản trị đội được báo; chủ hạng mục
  thấy "Chờ máy AI SDLC". Dự án có thể đổi nơi chạy sang `requester` (máy của người bấm).
- **Hết ngân sách task / chi phí ngày** (RUN-10, `policy_daily_cap`): bước agent không tạo run, hạng mục hiện lý do.
- **PR của task đóng không merge**: task về `todo` như hiện nay; đợt không mở khoá task phụ thuộc.
- **Webhook không tới**: job đồng bộ ngược chạy định kỳ (mặc định 15 phút) so hash file trong repo với baseline cho các
  hạng mục mở.
- **Repo không có quyền ghi** (kết nối chỉ đọc): đồng bộ lên repo tắt, hạng mục báo "Chỉ lưu trên hub"; agent đọc tài liệu
  qua seed file và MCP `doc_get`.
- **Dự án bị lưu trữ hoặc tắt AI SDLC**: hạng mục mở chuyển `paused`; không tạo run mới; bật lại thì tiếp tục.
- **Hub khởi động lại**: mọi bước chuyển là job pg-boss có thử lại; không giữ trạng thái trong bộ nhớ.
- **Câu hỏi bị bỏ không trả lời quá hạn** (mặc định 3 ngày): nhắc chủ hạng mục một lần; không tự dùng đề xuất.

## Requirements *(mandatory)*

### Functional Requirements

Mô hình chế độ và cấu hình (US8)

- **FR-001 (SDLC-01)**: Hệ thống MUST mô tả chế độ bằng dữ liệu (schema zod `sdlcMode` trong contracts): giai đoạn (loại
  chuẩn, tài liệu, bước agent, cổng, tuỳ chọn, chặn code), luật tách task, mức chặn (`hard`, `soft`, `none`), số vòng
  converge, cấu hình nơi chạy. Không có code riêng cho từng phương pháp ngoài bộ đọc `tasks.md` theo định dạng.
- **FR-002 (SDLC-01)**: Hệ thống MUST có preset: `aidlc-express`, `aidlc-feature`, `aidlc-enterprise`, `speckit`,
  `bmad-quick`, `bmad-method`, `kiro-requirements`, `kiro-design`, `kiro-bugfix`, `openspec`, `bugfix`, `small`. Preset chỉ
  đọc; quản trị tổ chức/đội nhân bản thành chế độ riêng.
- **FR-003 (SDLC-01)**: Lưu chế độ MUST kiểm: đường dẫn tương đối trong repo, không `..`, không thuộc `.git/`,
  `.github/workflows/`, `.gitlab-ci.yml`; biến khuôn chỉ `{NNN}`, `{slug}`, `{date}`, `{unit}`; id giai đoạn/tài liệu/bước
  duy nhất; cổng hợp lệ theo `reviewPhase` của spec 004; CLI/model không bị chính sách agent cấm.
- **FR-004 (SDLC-01)**: Chạy thử chế độ MUST nhận tiêu đề mẫu và trả đường dẫn tài liệu, cổng mỗi giai đoạn, checkpoint bị
  bỏ theo điều kiện; không ghi dữ liệu.
- **FR-005 (SDLC-01)**: Cài đặt dự án MUST có mục AI SDLC: bật/tắt, chế độ mặc định, chế độ được dùng, mức chặn ghi đè
  (chỉ chặt hơn chế độ), cách đồng bộ repo (Q1), thư mục gốc tài liệu, mức song song (1–10, mặc định 2), tự chạy đợt,
  nơi chạy agent (`team` | `requester`), nhãn máy yêu cầu, từ khoá rủi ro cho gợi ý cỡ.

Hạng mục (US1)

- **FR-006 (SDLC-02)**: Người có `sdlc.write` trên đội của dự án MUST tạo được hạng mục từ ý tưởng (tiêu đề + mô tả), từ
  issue của repo dự án, hoặc qua hành động leader `sdlc.item.create` đã duyệt.
- **FR-007 (SDLC-02)**: Hub MUST gợi ý cỡ (S/M/L/XL) và chế độ bằng luật tất định trong ≤ 3 giây, và MUST cho chạy bước
  agent `size` (tuỳ chọn) trả cỡ, chế độ, lý do. Lựa chọn cuối cùng của người dùng và gợi ý đều được audit.
- **FR-008 (SDLC-02)**: Tạo hạng mục MUST cấp số `NNN` duy nhất trong dự án (khoá tư vấn như số task), slug ASCII, chụp
  chế độ, tạo tài liệu hub theo khuôn và giai đoạn đầu.
- **FR-009 (SDLC-02)**: Hub MUST cho nhận thư mục tài liệu có sẵn trong repo làm hạng mục (đọc file làm bản nháp đầu).

Agent soạn và hỏi lại (US2)

- **FR-010 (SDLC-03)**: Hub MUST có loại run mới `sdlc` cho bước agent (`size`, `draft`, `analyze`, `converge`,
  `release-notes`, `retro`, `archive`); run chạy trong worktree tạm từ nhánh mặc định, được ghi file trong worktree,
  **không** commit/đẩy; worker trả nội dung các file trong danh sách thu của bước.
- **FR-011 (SDLC-03)**: Job của run `sdlc` MUST mang seed file là baseline (và bản nháp khi bước là soạn lại) của các tài
  liệu hạng mục chưa có trong repo, để agent đọc đúng bản hub.
- **FR-012 (SDLC-03)**: Agent MUST hỏi lại qua MCP `sdlc_ask` (tối đa 5 câu mỗi vòng, mỗi câu có lựa chọn tuỳ chọn và
  đề xuất); câu hỏi hiện ở hạng mục, ở "Câu hỏi chờ tôi" (app và web) với badge, và thông báo `sdlc.question`.
- **FR-013 (SDLC-03)**: Trả lời MUST lưu theo câu (người, lúc), cho "Dùng đề xuất"; đủ câu trả lời thì soạn lại tự động
  (chế độ `auto`) hoặc chờ người bấm; prompt vòng sau gồm mọi câu hỏi và câu trả lời trước.
- **FR-014 (SDLC-03)**: Kết quả soạn MUST vào **bản nháp** tài liệu hub (editor spec 005) dưới tên tác giả agent của
  run; gửi duyệt tự động chỉ khi không còn câu hỏi mở và chế độ bật `autoSubmit`.
- **FR-015 (SDLC-03)**: Run `sdlc` MUST theo quyền sở hữu ADR 0017: nơi chạy `team` → run không chủ, chỉ máy dùng chung
  hoặc runner host; `requester` → chủ là người bấm. Run mang `required_labels` từ cài đặt dự án.

Duyệt theo giai đoạn (US3)

- **FR-016 (SDLC-04)**: Mọi đề xuất trên key tài liệu của hạng mục MUST mở phiên duyệt bằng cổng của giai đoạn chứa tài
  liệu đó trong bản chụp chế độ (thay luật chọn theo tiền tố).
- **FR-017 (SDLC-04)**: Thêm luật tài liệu: `no-open-questions` (không còn `[NEEDS CLARIFICATION` hoặc câu hỏi mở của giai
  đoạn), `breakdown` (đọc được `tasks.md`, không vòng, trong giới hạn), `coverage` (mỗi requirement của tài liệu yêu cầu
  có ≥ 1 task trong bản tách).
- **FR-018 (SDLC-04)**: Baseline của tài liệu MUST báo cho hạng mục; mọi tài liệu bắt buộc của giai đoạn có baseline thì
  giai đoạn `approved` và giai đoạn kế bắt đầu (chạy bước tự động đầu tiên).
- **FR-019 (SDLC-04)**: Trả lại hướng `agent` cho tài liệu hạng mục MUST tạo run `sdlc` bước `draft` với góp ý, giới hạn
  lượt (mặc định 2, cấu hình 0–5), hết lượt thì về chủ hạng mục.
- **FR-020 (SDLC-04)**: Chủ hạng mục MUST bỏ qua được giai đoạn `optional` với lý do; giai đoạn khác chỉ qua bằng ngoại lệ.

Đồng bộ hub ↔ repo (US4)

- **FR-021 (SDLC-05)**: Baseline của tài liệu hạng mục MUST được ghi vào repo dự án ở đường dẫn của chế độ qua `GitProvider`
  có sẵn, theo cách đồng bộ của dự án (Q1), có trailer tác giả; lưu SHA commit và hash nội dung.
- **FR-022 (SDLC-05)**: Hub MUST phát hiện thay đổi file tài liệu trên nhánh mặc định (webhook `push` và job quét định kỳ)
  và tạo đề xuất trên hub khi nội dung khác baseline và commit không do hub đồng bộ; không bao giờ tự thành baseline.
- **FR-023 (SDLC-05)**: Hạng mục MUST hiện trạng thái đồng bộ từng tài liệu: đã đồng bộ, chờ, lỗi (lý do), lệch repo; có
  "Đồng bộ lại" và "Ghi đè repo bằng baseline" (quản trị dự án, xác nhận).

Tách task (US5)

- **FR-024 (SDLC-06)**: Hub MUST đọc `tasks.md` (hoặc tài liệu tách việc của preset) bằng bộ đọc theo định dạng
  (`speckit-tasks`, `kiro-tasks`, `openspec-tasks`, `bmad-stories`, `aidlc-units`, `hive-tasks`) với độ mịn `item`,
  `heading` hoặc `single`, ra bản tách: task (khoá lát, tiêu đề, mô tả, requirement, checklist, cỡ), phụ thuộc, đợt.
- **FR-025 (SDLC-06)**: Màn Duyệt bản tách MUST hiện đồ thị phụ thuộc, đợt, độ phủ requirement, cho gộp/tách task, sửa phụ
  thuộc, chuyển mục giữa task và checklist; lưu thì ghi lại tài liệu nguồn theo định dạng preset.
- **FR-026 (SDLC-06)**: Baseline của tài liệu tách việc MUST tạo/cập nhật task hub: `checklist`, `dependsOn`, nguồn
  `sdlc`; so với bản tách trước theo khoá lát (tạo mới, cập nhật task `todo`, huỷ task bỏ còn `todo`, cảnh báo task bỏ đã
  chạy).
- **FR-027 (SDLC-06)**: Task MUST có checklist (tối đa 50 mục) và phụ thuộc giữa task cùng dự án, không vòng; contract
  `tasks` trả `checklist`, `dependsOn`, `blockedBy`; bảng việc hiện "Chờ <task>".

Chạy và chặn (US6)

- **FR-028 (SDLC-07)**: `queueRun` MUST từ chối run code của task thuộc hạng mục chặn `hard` khi một tài liệu bắt buộc của
  giai đoạn trước giai đoạn `implementation` chưa có baseline, hoặc bản tách chưa duyệt, trừ khi có ngoại lệ còn hiệu lực
  (`SDLC_GATE_BLOCKED`, liệt kê tài liệu); `soft` thì cho chạy và ghi cảnh báo.
- **FR-029 (SDLC-07)**: `queueRun` MUST từ chối run code của task có phụ thuộc chưa `done` (`TASK_DEPENDENCIES_OPEN`),
  trừ khi có ngoại lệ.
- **FR-030 (SDLC-07)**: Người có `sdlc.override` MUST tạo được ngoại lệ phạm vi task hoặc hạng mục, lý do bắt buộc
  (≥ 10 ký tự), hạn tuỳ chọn, thu hồi được; audit và thông báo cho quản trị tổ chức và chủ hạng mục.
- **FR-031 (SDLC-07)**: Chạy đợt MUST tạo run code cho task sẵn sàng (phụ thuộc `done`, không có run đang chạy) tới mức song
  song của dự án; khi một task `done` (PR merged) hub xét đợt tiếp nếu tự chạy bật. Chủ run theo nơi chạy của dự án.
- **FR-032 (SDLC-08)**: Prompt của run code task hạng mục MUST gồm tóm tắt hạng mục, đường dẫn tài liệu, chữ requirement
  và tiêu chí chấp nhận của task, checklist; MCP `task_update` MUST nhận đánh dấu checklist và
  `evidence.requirements`/`evidence.tests`.
- **FR-033 (SDLC-08)**: Quy trình review code (spec 009) MUST nhận ngữ cảnh spec của task (requirement, tiêu chí) cho
  checkpoint AI khi PR thuộc task hạng mục.

Truy vết, converge, release (US9–US11)

- **FR-034 (SDLC-09)**: Hub MUST lưu liên kết truy vết requirement → task (từ bản tách) → run → PR → commit merge → test
  (từ evidence và CI), và tính độ phủ ba mức (kế hoạch, đã làm, đã kiểm); xuất CSV.
- **FR-035 (SDLC-10)**: Bước `converge` MUST trả kết quả từng requirement (`met`, `partial`, `missing`, `contradicts`, bằng
  chứng) qua MCP `sdlc_report`, đề xuất task bổ sung đi cổng tách task, giới hạn số vòng.
- **FR-036 (SDLC-11)**: Bước `release-notes` và `retro` MUST tạo tài liệu qua cùng luồng soạn–duyệt–đồng bộ; retro MUST
  đề xuất sửa tài liệu constitution/steering của dự án qua đề xuất thường.

Bảng và chỉ số (US12)

- **FR-037 (SDLC-12)**: Hub MUST có bảng hạng mục theo loại giai đoạn chuẩn và chỉ số: lead time mỗi giai đoạn, chờ ở cổng
  người, tỉ lệ trả lại, số câu hỏi, độ phủ, số vòng converge, số vòng review code mỗi PR, chi phí agent (tổng chi phí run
  `sdlc` và run code của task hạng mục), lọc theo dự án, chế độ, thời gian.

App desktop và web (US7)

- **FR-038 (SDLC-13)**: App desktop MUST có nhóm menu AI SDLC (Hạng mục, Câu hỏi chờ tôi, Tiến độ) và màn chi tiết hạng
  mục, tạo hạng mục, duyệt bản tách, truy vết; quyền app mới `sdlc.use`, `sdlc.manage` trong `nav.ts` (`PERMISSIONS`);
  tài liệu mở bằng màn Soạn tài liệu, duyệt bằng Chờ tôi duyệt có sẵn. App không chạy agent cho AI SDLC.
- **FR-039 (SDLC-14)**: Web MUST đi hết luồng như app bằng cùng component trong package `@xdev-hive/sdlc-ui`, cộng cấu hình
  chế độ (`/admin/sdlc-modes`), mục AI SDLC trong cài đặt dự án, đội máy AI SDLC.
- **FR-040 (SDLC-14)**: Chữ giao diện và lỗi MUST tiếng Việt, có từ điển `vi`/`en`; màn dùng được ở 360 px, sáng và tối.

Máy worker AI SDLC (US13–US15)

- **FR-041 (SDLC-15)**: Máy MUST có `labels` (≤ 10 nhãn) và cờ `labels_only`; run MUST có `required_labels`. Dispatch chỉ
  chọn máy có mọi nhãn yêu cầu; máy `labels_only` chỉ nhận run có ít nhất một nhãn của máy. Nhãn do quản trị đội đặt trên
  hub hoặc qua mã đăng ký; worker không tự khai.
- **FR-042 (SDLC-16)**: Mã đăng ký MUST mang tuỳ chọn `labels`, `shared`, `labelsOnly`; `install.sh`/`install.ps1` không
  cần cờ mới; tài liệu vận hành có mục dựng máy worker AI SDLC (service, linger, thêm gói).
- **FR-043 (SDLC-16)**: Worker MUST gửi tóm tắt tài khoản CLI trong heartbeat (tuỳ chọn, không token, không email đầy đủ);
  hub lưu và hiện trên web cho quản trị đội (máy dùng chung) và chủ máy (máy cá nhân).
- **FR-044 (SDLC-16)**: Quản trị đội MUST bật/tắt được một tài khoản trên máy dùng chung có worker hỗ trợ `accounts-remote`
  (tin nhắn hub → worker `account_set`); thêm tài khoản vẫn làm trên máy (`hive-worker accounts add|discover`).
- **FR-045 (SDLC-16)**: Web MUST có trang Đội máy AI SDLC: máy có nhãn của dự án/đội, trạng thái, slot, run đang chạy (hạng
  mục, bước), gói và quota, nút Thêm máy (mã đăng ký có nhãn).

Audit, thông báo, an toàn

- **FR-046 (SDLC-17)**: Mọi thao tác ghi MUST có audit: lưu/xoá chế độ, tạo/huỷ hạng mục, gợi ý và lựa chọn chế độ, trả
  lời câu hỏi, bỏ qua giai đoạn, ngoại lệ, chạy đợt, đồng bộ repo (commit, lỗi, ghi đè), tạo task từ bản tách, nhãn máy,
  bật/tắt gói.
- **FR-047 (SDLC-17)**: Thông báo mới: `sdlc.question`, `sdlc.phase_ready` (tài liệu chờ duyệt dùng sự kiện spec 004),
  `sdlc.blocked`, `sdlc.override`, `sdlc.sync_failed`, `sdlc.converged`, `sdlc.waiting_machine`.
- **FR-048 (NFR-01)**: Bảng mới MUST bật và ép RLS theo `org_id = hive.ctx_org()`.
- **FR-049 (SDLC-17)**: Dự án không bật AI SDLC MUST giữ nguyên hành vi task, run, review, merge.

### Key Entities

- **Chế độ** (`sdlc_modes`): chế độ tự tạo của tổ chức hoặc đội; preset có sẵn nằm trong contracts (không lưu DB).
  Thuộc tính: tên, phương pháp, hồ sơ, `definition` (schema `sdlcMode`), phiên bản, bật.
- **Hạng mục** (`sdlc_items`): dự án, số `NNN`, slug, tiêu đề, ý tưởng, nguồn (tay, issue, leader, nhập từ repo), bản chụp
  chế độ, cỡ (gợi ý và chọn), trạng thái (`active`, `paused`, `done`, `cancelled`), giai đoạn hiện tại, chủ, nơi chạy,
  trạng thái hội tụ.
- **Giai đoạn của hạng mục** (`sdlc_item_phases`): trạng thái (`pending`, `drafting`, `awaiting_answers`, `in_review`,
  `approved`, `skipped`), mốc thời gian (để tính lead time).
- **Tài liệu hạng mục** (`sdlc_artifacts`): key tài liệu hub, đường dẫn repo, bắt buộc, baseline đã biết, trạng thái đồng
  bộ, SHA và hash của lần đồng bộ, hash trong repo.
- **Câu hỏi** (`sdlc_questions`): vòng, nội dung, lựa chọn, đề xuất, câu trả lời, người trả lời, trạng thái.
- **Bước agent** (`sdlc_steps`): một lần chạy bước (`size`, `draft`, `converge`…), run, vòng, kết quả có cấu trúc.
- **Lát task** (`sdlc_item_tasks`): task hub thuộc hạng mục, khoá lát (`T003`, `2.1`, `unit-billing`), đợt, requirement.
- **Phụ thuộc task** (`task_dependencies`, module `tasks`) và **checklist** (`tasks.checklist`).
- **Liên kết truy vết** (`sdlc_trace_links`): requirement ↔ task/run/PR/commit/test/finding.
- **Ngoại lệ chặn** (`sdlc_overrides`): phạm vi, lý do, người, hạn, thu hồi.
- **Máy**: thêm `labels`, `labels_only`, `accounts` (tóm tắt), `accounts_at`; **mã đăng ký** thêm nhãn và cờ; **run** thêm
  `required_labels`, loại `sdlc`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 run code được tạo cho task của hạng mục chặn `hard` khi thiếu baseline bắt buộc mà không có ngoại lệ, qua
  mọi đường tạo run (test DB phủ web/app, leader, bình luận @bot, issue).
- **SC-002**: 100% ngoại lệ có lý do, dòng audit và thông báo tương ứng (test DB).
- **SC-003**: Hạng mục `bugfix` từ issue tới PR mở cần ≤ 5 thao tác người (dán issue, xác nhận chế độ, trả lời câu hỏi nếu
  có, duyệt `bugfix.md`, chạy), đếm bằng Playwright trên web và test tương tác trên desktop với hub giả.
- **SC-004**: Baseline vào repo trong ≤ 2 phút (p95) khi provider sẵn sàng; sửa trong repo thành đề xuất trên hub trong ≤ 5
  phút sau webhook (p95) và ≤ 20 phút khi không có webhook. 0 lần sửa trong repo tự thành baseline.
- **SC-005**: Với `tasks.md` mẫu Spec Kit 58 dòng `T###` (dữ liệu app v1), độ mịn `heading` cho ≤ 12 task hub; mọi task
  hub có ≤ 20 mục checklist; bảng việc không có task nào cho một mục checklist.
- **SC-006**: Độ phủ truy vết tính đúng 100% trên bộ dữ liệu mẫu (test thuần).
- **SC-007**: Bảng tiến độ 500 hạng mục mở trả trong ≤ 500 ms (p95), danh sách "Câu hỏi chờ tôi" ≤ 300 ms (test DB dữ liệu
  mẫu).
- **SC-008**: Câu hỏi agent gửi hiện trên app và web trong ≤ 10 giây; câu trả lời từ app hiện trên web trong ≤ 10 giây.
- **SC-009**: Kịch bản MVP (tạo hạng mục → trả lời → duyệt 3 tài liệu → duyệt bản tách → chạy đợt → xem PR) làm được hoàn
  toàn trong app desktop và hoàn toàn trên web (test desktop + Playwright).
- **SC-010**: 0 run được giao sai nhãn: máy `labels_only` không nhận run không nhãn; run có nhãn không vào máy thiếu nhãn
  (test dispatch).
- **SC-011**: Dự án không bật AI SDLC: 100% test hiện có của task, run, review tài liệu, hàng merge xanh không sửa.
- **SC-012**: Mọi màn mới dùng được ở 360 px không cuộn ngang, sáng và tối (NFR-11).

## Out of Scope

- Hạng mục trải nhiều dự án/repo (xem Q3).
- Agent chạy trong app desktop cho AI SDLC (app chỉ duyệt và soạn; trợ lý soạn `docassist` của spec 005 vẫn giữ).
- Đăng nhập gói CLI từ web (OAuth của CLI cần trình duyệt trên máy chạy); chỉ bật/tắt gói đã có.
- Chạy worker như Windows Service thật (hiện là `schtasks /SC ONLOGON`, cần phiên đăng nhập); ghi rủi ro, để spec sau.
- Giai đoạn vận hành thật (deploy, provisioning, observability) của AI-DLC Operation: chỉ tài liệu (runbook, release
  notes), không chạy deploy.
- Đồng bộ trạng thái hai chiều với công cụ quản lý dự án ngoài (Jira, Linear); GitHub Projects.
- Cài skill/CLI của phương pháp (Spec Kit CLI `specify`, `aidlc`, `bmad` installer) lên máy: hub dùng prompt riêng; nếu
  repo có skill của phương pháp thì prompt gọi skill đó.
- Chỉnh sửa đồng thời thời gian thực (CRDT) của tài liệu; giữ cách của spec 005.
- Archive delta của OpenSpec tự động gộp vào `openspec/specs/` mà không qua PR: bước `archive` đề xuất thay đổi như tài
  liệu khác.

## Assumptions

- Dự án có kết nối Git ghi được (GitHub hoặc GitLab) để đồng bộ tài liệu; không có thì hạng mục chạy "chỉ trên hub".
- Hồ sơ app hiện có là `dev`, `writer`, `lead` (`apps/desktop/src/lib/nav.ts`); BA/PO dùng `writer` hoặc `lead` (Q2).
- Agent soạn dùng CLI có sẵn trên máy (Claude Code mặc định; Codex, Gemini, Antigravity khi chế độ chọn); hub không cần
  CLI riêng của phương pháp.
- Prompt của bước do Hive viết, theo tinh thần từng phương pháp, không chép nguyên văn tài liệu của dự án nguồn (giấy phép
  của Spec Kit, BMAD, AI-DLC cho phép tham khảo; nếu dùng khuôn nguyên văn thì ghi nguồn và giấy phép).
- Run `sdlc` cần ghi file trong worktree tạm (khác `doccheck`/`docassist` chỉ đọc) nhưng không đẩy; quyền `workspace`, không
  cần toàn quyền.
- Quy trình duyệt spec 004 và editor spec 005 chạy như hiện có; spec 009 (review code) có thể chưa xong — khi chưa có, PR
  của task đi chính sách kết quả của dự án (ADR 0009).
- Chi phí run `sdlc` tính theo dự án như run khác (OPS-03).

## Câu hỏi còn mở

- **[NEEDS CLARIFICATION Q1] Ghi tài liệu đã duyệt vào repo bằng cách nào?** Commit thẳng vào nhánh mặc định thì nhanh
  nhưng hay bị bảo vệ nhánh chặn và bỏ qua review; PR thì thêm một bước duyệt cho nội dung đã duyệt trên hub.
  **Đề xuất**: mặc định `pr`: mỗi lần baseline mở (hoặc cập nhật) một PR `hive/sdlc/<NNN>-<slug>` chỉ đổi file trong thư mục
  của hạng mục, đặt commit status `xdev-hive/sdlc` = success, rồi tự đưa vào hàng merge (không qua review code vì nội dung
  đã duyệt trên hub). Dự án được chọn `direct` (commit thẳng, dùng khi nhánh không bảo vệ).
- **[NEEDS CLARIFICATION Q2] BA/PO dùng hồ sơ app nào?** Hồ sơ `writer` ứng với vai trò `viewer` của hub, nên không ghi được
  (không tạo hạng mục, không trả lời câu hỏi). **Đề xuất**: giữ 3 hồ sơ; thêm vai trò tuỳ chỉnh hệ thống "BA/PO" (spec 001)
  có `sdlc.read`, `sdlc.write`, `docs.propose`, duyệt tài liệu, không có `runs.*`; `profileOf()` xếp vai trò có `sdlc.write`
  mà không có quyền chạy vào hồ sơ `writer`, và `writer` có `sdlc.use`. Menu "Máy này" vẫn ẩn với BA/PO.
- **[NEEDS CLARIFICATION Q3] Hạng mục có trải nhiều dự án (nhiều repo) không?** Ví dụ tính năng cần sửa cả `payment-api`
  và `web-shop`. **Đề xuất**: bản này một hạng mục = một dự án; tính năng nhiều repo tạo hạng mục ở dự án chính, tài liệu
  thiết kế nêu các dự án khác, task cho dự án khác tạo tay. "Sáng kiến" gom nhiều hạng mục để spec sau.
