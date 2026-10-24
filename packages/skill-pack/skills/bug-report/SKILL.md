---
name: bug-report
description: Use when a test case fails and a tester needs to file a bug, when writing or improving a bug or defect ticket (Jira, GitLab issue), or when a bug report lacks repro steps, environment or evidence.
---

# Writing a bug report from a failed test

A good bug lets a developer reproduce the failure without asking the tester anything. Write it in Vietnamese, the
same language as the test cases.

## 1. Check for an existing bug first

Search the tracker for the TC code and the error text. If an open bug already covers it, add the new evidence as a
comment there and link that bug from the test result. Do not file a duplicate.

## 2. Template

```markdown
**Tiêu đề:** [TC-DANGNHAP-002] Sai mật khẩu nhưng không hiện thông báo lỗi

**Môi trường:** <tên môi trường, ví dụ staging> · bản <phiên bản/commit> · <trình duyệt + phiên bản> · <hệ điều hành>
**Test case:** TC-DANGNHAP-002, bước 2 · Đợt: Milestone 3 lần 1
**Mức độ:** Nghiêm trọng / Cao / Trung bình / Thấp

**Các bước tái hiện**
1. Mở trang đăng nhập.
2. Nhập email của tài khoản test, mật khẩu sai.
3. Bấm "Đăng nhập".

**Kết quả mong đợi:** Hiện "Email hoặc mật khẩu không đúng", vẫn ở trang đăng nhập.
**Kết quả thực tế:** Không hiện thông báo; nút "Đăng nhập" quay mãi.

**Bằng chứng:** TC-DANGNHAP-002-buoc-2.png, đoạn log lỗi (đã che dữ liệu nhạy cảm)
**Tần suất:** 3/3 lần
**Ghi chú:** Lần đầu thấy ở bản <phiên bản>; bản trước đạt.
```

## 3. Rules

- Title: TC code in brackets, then what is wrong, as the user sees it. Not "Lỗi đăng nhập".
- Steps start from a known state and are numbered. Copy them from the TC and add what you did differently.
- Expected result comes from the TC. Actual result describes what you saw, word for word for error messages.
- Severity is impact on users; priority is the team's call. If unsure, propose and say so.
- Say how often it happens (`3/3`, `1/5`) and whether it worked in an earlier version.
- Put the bug link back into the test result (see `manual-test-run`).

## 4. Keep it safe to share

Trackers are read by many people. Before you post:

- Replace server names, IP addresses and internal URLs with placeholders like `<môi trường staging>`.
- Remove passwords, tokens, cookies and session IDs from logs, HAR files and screenshots.
- Never include real patient or staff data. Crop or blur screenshots; use test data-set codes instead.
- If you cannot remove sensitive data from evidence, say the evidence exists and where an authorised person can get it.
