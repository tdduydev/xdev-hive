---
name: test-case-writing
description: Use when writing, editing, numbering or fixing test cases (TC) in a docs repo's `docs/test-cases/*.md` for xDev Hive, when a tester asks for a new "TC" or "kịch bản test", or when Hive reports a test-case file as skipped or invalid.
---

# Writing test cases for xDev Hive

Hive reads every `.md` file in `docs/test-cases/` as one area (khu) of test cases. One error in a file makes Hive skip
the **whole file**, so every rule below matters.

If the hive MCP server exposes `qa_get_case` / `qa_list_cases`, use them to read existing cases. Otherwise read the
Markdown files.

## File shape

````markdown
# DANGNHAP Đăng nhập

Free text here is ignored.

### TC-DANGNHAP-001 Đăng nhập đúng email và mật khẩu

- Ưu tiên: P1
- Loại: tay
- Yêu cầu: FR-001, DN01

| # | Thao tác | Kết quả mong đợi |
|---|---|---|
| 1 | Mở trang đăng nhập, nhập email và mật khẩu của tài khoản test | Nút "Đăng nhập" bật |
| 2 | Bấm "Đăng nhập" | Vào trang chủ, góc phải hiện tên người dùng |
````

| Block | Rule |
|---|---|
| Area heading | First `#` line: `# <KHU> <tên khu>`. KHU = 2–16 uppercase letters/digits, starts with a letter |
| TC heading | `### TC-<KHU>-<SỐ> <tên>`. KHU equals the file's area code. SỐ = 3–5 digits |
| Fields | Right after the TC heading, `- Tên: giá trị`, one per line, no repeats |
| Steps | Table `\| # \| Thao tác \| Kết quả mong đợi \|`, 1–50 rows, `#` counts up from 1 |
| Other text | `##` headings, paragraphs, other lists and code blocks are ignored |

`#` then `###` without `##` is correct. Do not "fix" heading levels. One file per area; no README in `docs/test-cases/`.

## Fields

| Field | Required | Value |
|---|---|---|
| Ưu tiên | yes | `P1`, `P2`, `P3` |
| Loại | yes | `tự động`, `tay`, `dự kiến tự động` |
| Yêu cầu | yes | comma-separated codes, see below |
| Script | when Loại is `tự động` | test file path in the test repo, ≤ 255 chars, no `..` |
| Nhãn | no | comma-separated, ≤ 40 chars each, ≤ 20 labels |
| Dữ liệu test | no | test data-set code, ≤ 200 chars |
| Điều kiện trước | no | ≤ 1000 chars |
| Ghi chú | no | ≤ 1000 chars |

Requirement codes:
- Spec code: `FR`, `AC`, `NFR` or `US`, a `-`, 3–4 digits, optional spec number in front: `FR-001`, `001/AC-012.2`.
- SRS code: exactly as the BA's SRS file name, 3–16 **uppercase** letters/digits, starts with a letter, no `-`: `OPD02`.
- Normalise what people type: `dn01` → `DN01`, `FR001` / `FR-1` → `FR-001`, `OPD-02` → `OPD02`. Say that you did.

## Numbering

- New TC number = **highest number in the file + 1**, zero-padded to 3 digits.
- Never fill a gap. A missing number may belong to a deleted TC, and Hive rejects reused codes.
- Never renumber existing TCs. Other tools, bugs and CI results point at the code.

## Steps

- Every row has an expected result. An empty "Kết quả mong đợi" cell is a defect: fill it or ask the author.
- One action per row; the expected result is something a tester can see on screen.
- Quote button and menu text exactly, in Vietnamese.

## Test data and privacy

Docs repos are shared. Never write a real person's name, email, phone, password, ID number, insurance number or
patient code into a TC, even when the tester gives you one. Use:
- a data-set code in `Dữ liệu test` (`TK-TEST-01`, `BN-BHYT-01`), or the words "tài khoản test";
- a code that cannot exist, such as patient code `999999.99999999`.

If someone pasted a real password in chat, tell them to change it.

## Common errors Hive reports

| Hive says | Cause | Fix |
|---|---|---|
| mã yêu cầu không đúng mẫu | `opd02`, `OPD-02` | uppercase, no `-` |
| phải có dạng mã spec | `FR001`, `FR-01` | `FR-001` |
| loại tự động phải có Script | `tự động` without Script | add Script, or use `dự kiến tự động` |
| mã đã dùng trước đây | reused a deleted number | pick max + 1 |

## Before you finish

- [ ] Area code in every TC heading matches the file's `#` heading.
- [ ] New numbers are max + 1; no gaps filled, nothing renumbered.
- [ ] Ưu tiên, Loại, Yêu cầu present; Script present when Loại is `tự động`.
- [ ] Requirement codes match the patterns above.
- [ ] Every step has an expected result.
- [ ] No real personal data, credentials or patient data.
- [ ] Tell the author which choices you made (priority, type, normalised codes).
