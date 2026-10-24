---
name: test-coverage
description: Use when asked which requirements have no test case, how much of a feature or SRS is covered by tests, how many test cases are automated, or to review or audit a `docs/test-cases/` library before a test round or release.
---

# Test coverage report for xDev Hive

Coverage here means: which requirements (spec or SRS codes) have test cases, how many are automated, and what the
latest round says. Report facts you counted; mark anything you inferred.

## 1. Collect the data

- Test cases: `qa_list_cases` if the hive MCP server exposes it (filter by area, requirement, kind), otherwise parse
  every `docs/test-cases/*.md` file. Format rules are in `test-case-writing`.
- Requirements: the spec's `FR-`/`AC-`/`NFR-`/`US-` codes from `specs/<feature>/spec.md`, and SRS codes from the BA's
  SRS file names. Ask for the requirement list if you cannot find it; do not guess it.
- Latest round results, if the tester gives them (Hive export CSV or the round page).

## 2. Read the format correctly

These are **valid** and must not be reported as problems:
- `### TC-…` directly under `# KHU …` with no `##` in between.
- Free text, `##` group headings, other lists and code blocks between TCs.
- Gaps in TC numbers. Numbers of deleted TCs are never reused. Report gaps for information only and never suggest
  renumbering or filling them.

These **are** problems; Hive skips the whole file when it has one:
- Missing Ưu tiên, Loại or Yêu cầu; `tự động` without Script.
- Requirement code not matching the spec or SRS pattern (`dn01`, `FR001`, `OPD-02`).
- Duplicate TC code; TC area code different from the file's area code.
- Empty step table, or steps not numbered from 1.

Also report, as quality issues that do not break the file: steps with an empty expected result, and TCs with real
personal data.

## 3. Report

Use this shape:

```markdown
## Độ phủ <feature hoặc khu> — <ngày>

| Yêu cầu | Số TC | Tự động | Kết quả đợt gần nhất |
|---|---|---|---|
| FR-001 | 2 | 1 | Đạt 2 |
| FR-003 | 0 | 0 | — |

**Yêu cầu chưa có TC:** FR-003, FR-006, DN02
**TC trỏ tới yêu cầu không có trong danh sách:** TC-DANGNHAP-007 → FR-099
**Lỗi định dạng (Hive sẽ bỏ qua file):** dangnhap.md — TC-DANGNHAP-004 thiếu Ưu tiên
**Chất lượng:** TC-DANGNHAP-002 bước 1 thiếu kết quả mong đợi
**Tự động hoá:** 5/24 TC tự động (21%), 3 TC dự kiến tự động
**Khoảng trống số (chỉ để biết):** TC-DANGNHAP-003
```

- Count each requirement once per TC, even if the TC lists it twice.
- A TC with several requirement codes counts toward each of them.
- Put requirements with no TC first; that is what the reader acts on.
- Do not add TCs while reporting. Offer to write the missing ones with `test-case-writing`.
