# Feature Specification: Agent đề xuất skill sau việc khó (Skill learning)

**Feature Branch**: `014-skill-learning`

**Created**: 2026-10-14

**Status**: Draft (MVP đã code; chờ product owner xem)

**Input**: Product owner (2026-10-14) đồng ý ý tưởng "agent tự tạo/cải tiến skill sau việc khó" như Hermes Agent, theo
hướng Hive: skill ở kho `tdduydev/xdev-skills` ([spec 006](../006-skills-repo-sync/spec.md)), memory và brief
([ADR 0022](../../docs/adr/0022-project-brief-and-agent-memory.md)), bộ skill mặc định. **Tiết kiệm token** là ràng buộc
chính: không chạy sau mọi run.

**Decision record**: [ADR 0025](../../docs/adr/0025-agent-skill-learning.md).

**Mở rộng**: [spec 024](../024-skill-harness-probe/spec.md) thêm tầng thử đề xuất trong sandbox (Propose–Probe–Compose)
cho một số ít việc đáng học (bản nháp, 2026-10-18).

## User Scenarios & Testing

### User Story 1 - Hub chỉ chọn việc đáng học (Priority: P1)

Hub xét các run code đã xong của dự án và chỉ giữ task đáng học: thử lại ≥ 2 lần, hoặc chi phí run vượt p90 của dự án,
hoặc người trong đội đánh dấu "nên thành skill" trên trang run.

**Why this priority**: không có bước lọc này thì mỗi run tốn thêm một lần gọi model.

**Independent Test**: seed run êm, run thử lại 3 lần, run đắt (đủ 10 mẫu để có p90) và run được đánh dấu; chỉ ba loại
sau vào lô (`skilllearn.db.test.ts`, "chọn run đáng học").

**Acceptance Scenarios**:

1. **Given** task chạy 3 lần (2 thất bại rồi 1 thành công), **When** lô ngày chạy, **Then** run cuối vào lô với lý do `retries`.
2. **Given** dự án có ≥ 10 run có chi phí, **When** một run vượt p90, **Then** vào lô với lý do `cost`; dưới 10 mẫu thì không so.
3. **Given** thành viên đội đánh dấu một run, **When** lô chạy, **Then** run đó vào lô với lý do `marked`; viewer và người ngoài đội không đánh dấu được.
4. **Given** run đã vào một lô, **When** lô ngày sau chạy, **Then** nó không được chọn lại.

### User Story 2 - Lô mỗi ngày mỗi dự án, model rẻ, chỉ đọc (Priority: P1)

Job hẹn giờ gom việc đáng học thành **một** run `skill_proposal` mỗi ngày mỗi dự án. Run chỉ đọc, dùng Sonnet effort
medium, nhận tóm tắt run (mục tiêu, lỗi gặp, cách sửa, lệnh) chứ không phải transcript.

**Acceptance Scenarios**:

1. **Given** job chạy nhiều lần trong ngày, **When** dự án đã có lô hôm nay, **Then** không tạo run thứ hai.
2. **Given** không có việc đáng học, **When** lô chạy, **Then** chỉ ghi lô `empty`, không gọi agent.
3. **Given** không có máy dùng chung khai `skill_proposal`, **When** lô chạy, **Then** không ghi gì và lần hẹn giờ sau thử lại.
4. **Given** tổ chức tắt tính năng, **Then** không có lô nào dù có việc đáng học.
5. Worker Go coi kind `skill_proposal` là chỉ đọc (không cờ ghi, không push, khai capability `skill_proposal`).

### User Story 3 - Hạn mức, bỏ trùng, không đề xuất lại (Priority: P1)

Hub trần số đề xuất mỗi ngày của tổ chức, bỏ đề xuất trùng với skill (kể cả skill mặc định), memory hoặc đề xuất đã bị
từ chối, và lời nhắc cho agent biết tên skill đã có và đã bị từ chối.

**Acceptance Scenarios**:

1. **Given** `maxPerDay = 1`, **When** agent nộp 2 đề xuất, **Then** nhận 1, bỏ 1 với lý do "vượt hạn mức"; hết hạn mức thì không lên lô mới.
2. **Given** đề xuất cùng tên skill đã có, tên khác nhưng mô tả giống, mô tả nằm trong một memory, hoặc giống đề xuất đã bị từ chối, **Then** bị bỏ và đếm vào `duplicates`.
3. **Given** đề xuất `edit` cho skill không tồn tại hoặc nội dung không đổi, **Then** bị bỏ.

### User Story 4 - Duyệt ở tab "Đề xuất từ agent" (Priority: P1)

Quản trị đội xem đề xuất ở trang Skills, tab **Đề xuất từ agent**, kèm lý do, run nguồn và (với `edit`) diff. **Duyệt**:
đã nối kho Git thì hub mở PR vào kho skill, chưa nối thì lưu thành skill của tổ chức. **Từ chối** bắt buộc có lý do.

**Acceptance Scenarios**:

1. **Given** chưa nối kho, **When** duyệt, **Then** skill được lưu (phạm vi dự án nguồn, hoặc đội/tổ chức do người duyệt chọn) và đề xuất ghi phiên bản kết quả.
2. **Given** đã nối kho, **When** duyệt, **Then** đề xuất `approved`, job mở PR trên nhánh `hive/learned-skill-<id>` với `SKILL.md` đúng đường dẫn kho; gọi lại không mở PR thứ hai; Git lỗi thì lỗi ghi vào đề xuất và job thử lại.
3. **Given** skill đã đổi sau khi agent đề xuất, **When** duyệt, **Then** CONFLICT, đề xuất vẫn chờ.
4. Thành viên thường và viewer không duyệt hay từ chối được; đội khác không thấy đề xuất; nâng lên cấp tổ chức cần quản trị tổ chức.

### User Story 5 - Đo và điều chỉnh theo tổ chức (Priority: P2)

Chính sách agent có mục **Học skill từ việc khó**: công tắc (mặc định tắt) và số đề xuất tối đa mỗi ngày. Tab hiện số đề
xuất, tỉ lệ duyệt, số bị bỏ vì trùng, chi phí và token của việc học, hạn mức hôm nay.

## Requirements

- **FR-001**: Hub MUST chọn run đáng học theo ba lý do `retries` (≥ 2), `cost` (> p90 của dự án, ≥ 10 mẫu trong 30 ngày), `marked`.
- **FR-002**: Hub MUST tạo tối đa một lô cho mỗi (dự án, ngày UTC) và tối đa một run `skill_proposal` cho mỗi lô; lô không có việc đáng học MUST NOT gọi agent.
- **FR-003**: Run `skill_proposal` MUST chỉ đọc, chạy trên máy dùng chung có capability `skill_proposal`, dùng model rẻ (Sonnet với Claude) effort medium, và MUST NOT nhận transcript.
- **FR-004**: Agent MUST nộp qua tool MCP `skill_proposal_submit` (0–3 đề xuất `new`/`edit`); tool chỉ có ở run kind này.
- **FR-005**: Hub MUST bỏ đề xuất trùng skill, skill mặc định, memory, đề xuất bị từ chối hoặc đang chờ, và MUST ghi số và lý do bỏ.
- **FR-006**: Chính sách agent MUST có `skillLearning {enabled, maxPerDay}` (mặc định tắt, 5); hết hạn mức MUST NOT tạo lô mới; hạn mức tính theo ngày UTC cho cả tổ chức.
- **FR-007**: Duyệt MUST mở PR vào kho skill khi tổ chức đã nối kho, hoặc lưu skill của tổ chức khi chưa; từ chối MUST có lý do và MUST được lưu để không đề xuất lại.
- **FR-008**: Hub MUST ghi audit `skill_learning.{batch.start,batch.done,approve,reject,mark,run.start}`.
- **FR-009**: Hub MUST trả số liệu: số đề xuất, tỉ lệ duyệt, số trùng, chi phí/token của run học, hạn mức hôm nay.
- **FR-010**: Ba bảng mới (`skill_learning_batches`, `skill_learning_marks`, `learned_skill_proposals`) MUST bật và ép RLS theo tổ chức.

## Edge cases

- Run học thất bại/huỷ: lô `failed`, không có đề xuất; run đã vào lô không được thử lại ngày sau [chủ ý: tránh đốt token lặp].
- Tắt tính năng khi lô đang chạy: đề xuất nộp muộn bị bỏ.
- Worker cũ (không khai `skill_proposal`): lô chờ, không có run nằm queued.
- Chạy chồng hai job hẹn giờ: khoá advisory theo dự án và khoá duy nhất (dự án, ngày).

## Assumptions và câu hỏi mở

- "Chi phí/lượt" được hiểu là chi phí **mỗi run** [Inference: đề bài không nói rõ lượt là run hay turn].
- `hive.json` `"proposals": "pull-request"` của kho xdev-skills không đọc được từ repo này; hub luôn mở PR khi đã nối kho.
- Dedupe dùng so tập từ, chưa dùng embedding hay FTS của memory [chưa đo trên dữ liệu thật].
- **Mở**: có cần thông báo (inbox) cho quản trị đội khi có đề xuất mới không? MVP không gửi.
- **Mở**: lệnh đã dùng chỉ có khi worker báo `tool_call` kèm lệnh; worker hiện chưa báo.
