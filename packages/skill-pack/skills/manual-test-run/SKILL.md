---
name: manual-test-run
description: Use when a tester runs test cases by hand in a test round ("đợt test", "Milestone 3 lần 1"), records pass or fail results, prepares a retest round, or exports round results to CSV for xDev Hive.
---

# Running a manual test round for xDev Hive

A round (đợt) is a named set of test cases run by hand, such as "Milestone 3 lần 1". Results must use Hive's status
words exactly, or Hive and the CSV export cannot read them.

Read each TC with `qa_get_case` if the hive MCP server exposes it, otherwise from `docs/test-cases/<khu>.md`. To drive
the app in a browser, use `webapp-testing` or `playwright-cli`.

## 1. Statuses

Use these words and no others. Never write Pass, Fail, Blocked, Skipped or Not run.

| Status | When |
|---|---|
| Đạt | every step gave the expected result |
| Không đạt | a step did not give the expected result; record the step number |
| Chưa test | not run yet; this is the default |
| Không test | does not apply to this round, by decision (feature off, out of scope) |
| Chuyển đợt sau | should run but moves to a later round: blocked by another bug, no environment, no time |
| Khác | none of the above; a note is required |

Map what people say:
- "để đợt sau", "bị chặn", "chưa có môi trường" → Chuyển đợt sau. Say in the note what blocks it.
- "không áp dụng", "bỏ" → Không test.
- "chưa chạy" → Chưa test.

## 2. Recording a result

For each TC record: status, failed step number (Không đạt only), a short note, bug links, who ran it and when.

- Run steps in order. Stop at the first step that fails and mark Không đạt with that step number.
- The note says what you saw, not what you think the cause is: `Bước 2: hiện "Lỗi 500" thay vì trang chủ`.
- File the bug with `bug-report` and put its link in the result. One TC can link several bugs.
- Keep a screenshot for every Không đạt. Name it `<mã TC>-buoc-<số>.png`.
- Never type real patient data, real staff accounts or passwords into notes, screenshots or file names.

## 3. Retest round

"Lần 2" of a round holds only the TCs that were **not Đạt** in lần 1: Không đạt, Chưa test, Chuyển đợt sau and Khác.
Leave out Đạt and Không test. Keep the bug links so the tester can check the fix.

## 4. CSV export

When asked for a CSV of a round, match Hive's export so the files line up:

- File name: `dot-test-<slug of round name>-<YYYY-MM-DD>.csv`, e.g. `dot-test-milestone-3-lan-1-2026-10-24.csv`.
- UTF-8 **with BOM**, CRLF line endings, comma separator, quote cells that contain `,` `"` or a line break.
- Columns, in this order:

  `Mã,Tên,Khu,Người được giao,Trạng thái,Bước lỗi,Ghi chú,Liên kết lỗi,Người ghi,Thời điểm`

| Column | Value |
|---|---|
| Khu | area code, a space, area name: `DANGNHAP Đăng nhập` |
| Người được giao | names joined by `; ` |
| Bước lỗi | step number, empty unless Không đạt |
| Liên kết lỗi | links separated by one space |
| Thời điểm | ISO 8601 UTC, `2026-10-24T03:15:00Z`; empty if Chưa test |

- Sort rows by area code, then TC code.
- If a cell starts with `=`, `+`, `-` or `@`, put `'` in front so spreadsheets do not run it as a formula.
- Include every TC in the round, including Chưa test and TCs retired after the round started.

## 5. Round summary

End with counts per status and the list of Không đạt TCs with their bug links:

```
Milestone 3 lần 1: 42 TC — Đạt 35, Không đạt 3, Chuyển đợt sau 2, Không test 1, Chưa test 1
Không đạt: TC-DANGNHAP-002 (bước 1, HIS-1234), …
```
