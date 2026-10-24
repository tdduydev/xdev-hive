# Specification Quality Checklist: Quản lý kiểm thử cấp dự án

**Purpose**: Kiểm spec đủ và rõ trước khi sang plan
**Created**: 2026-10-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Không đi sâu chi tiết cài đặt (mục "Hiện trạng" chỉ trỏ tới file để làm rõ phạm vi, theo kiểu spec 027 và 032)
- [x] Tập trung vào giá trị người dùng: tester bỏ Excel, quản lý dự án bỏ gộp số liệu bằng tay
- [x] Viết cho người không chuyên kỹ thuật ở phần Vì sao làm và User Stories
- [x] Mọi mục bắt buộc đã điền

## Requirement Completeness

- [x] Không còn marker [NEEDS CLARIFICATION]; 3 câu hỏi ở mục "Câu hỏi mở (đã chốt)", chủ dự án giữ khuyến nghị A ngày 2026-10-23
- [x] Yêu cầu kiểm thử được và rõ nghĩa (FR-xxx dùng PHẢI/KHÔNG ĐƯỢC/CÓ THỂ)
- [x] Tiêu chí thành công đo được (SC-001 … SC-009)
- [x] Tiêu chí thành công không nêu công nghệ cụ thể
- [x] Mọi kịch bản chấp nhận đã có (US1 … US7)
- [x] Edge case đã nêu (mã trùng, đổi mã khu, sửa hai phía, test nhiều mã, báo cáo lớn, pipeline huỷ, pipeline MR,
  worker mất kết nối, dữ liệu người bệnh trong ghi chú, vai trò nhân bản cũ)
- [x] Phạm vi có ranh giới rõ (Out of Scope)
- [x] Phụ thuộc và giả định đã nêu (A1 … A9, spec 022, 031, 032, 034, 035)

## Feature Readiness

- [x] Mọi FR có kịch bản chấp nhận hoặc tiêu chí đo tương ứng
- [x] User stories phủ các luồng chính: viết TC, phân quyền Tester, nhận kết quả CI, đợt test tay, dashboard, agent đọc TC,
  xuất CSV
- [x] Đạt các kết quả đo ở Success Criteria
- [x] Không lộ chi tiết cài đặt vào yêu cầu

## Notes

- Mục "Hiện trạng", FR-023 và FR-071 có tên file, bảng, quyền hiện có. Đây là phong cách của spec 027, 031, 032 và chủ ý
  giữ để ràng buộc phạm vi.
- FR-023 lệch có chủ ý với luật của `hive test-summary` (035): với nguồn CI, test chứa nhiều mã TC chỉ bị đếm riêng thay vì
  làm hỏng cả báo cáo.
- US3 phụ thuộc đường worker đọc GitLab của spec 032 (9/20 task xong ngày 2026-10-23). US1, US2, US4, US5 làm được trước.
- Cần kiểm ở plan: A1 (tag Playwright có nằm trong báo cáo JUnit/JSON không), A6 (regex mã yêu cầu), A7 (các ngưỡng mặc
  định), cách đọc báo cáo test của pipeline GitLab từ worker.
