---
name: vietnamese-ui-copy
description: Write and review Vietnamese interface text — labels, buttons, empty states, errors, toasts — with one consistent voice, Vietnamese terms instead of stray English, and Vietnamese date, number and currency formats. Use whenever a task adds or changes text users see in a Vietnamese UI.
---

# Vietnamese UI copy

## When to use
Any change that adds or edits text a user reads: page titles, labels, buttons, placeholders, tooltips, empty states,
confirmations, toasts, validation and API error messages, emails and notifications.

## First, follow the project
1. Search the project's existing strings (dictionary files such as `text.ts`, `vi.json`, `messages/`) for the same
   idea before writing a new one. Reuse the wording that is already there.
2. Match the project's spelling choices. If the project writes `Huỷ`, `tuỳ chọn`, `hoà`, keep that tone placement;
   if it writes `Hủy`, `tùy chọn`, keep that. Never mix both in one product.
3. If the app has a vi/en dictionary, add both keys in the same change.

## Voice
- Short, plain, polite without being stiff. Say what happened and what to do next.
- Address the user as `bạn` only when a subject is needed; most UI text needs no pronoun.
- Avoid `Vui lòng`, `Xin hãy`, exclamation marks and blame (`Bạn đã nhập sai`). Prefer `Nhập email hợp lệ.`
- Buttons are verbs that say the result: `Lưu`, `Tạo dự án`, `Gửi lời mời`, `Xoá`, not `OK`, `Xác nhận` alone.
- Sentence case. Capitalise only the first word and proper names: `Cài đặt dự án`, not `Cài Đặt Dự Án`.
- End full sentences with a period; labels, buttons and titles have none.

## Common patterns
| Situation | Write | Avoid |
|---|---|---|
| Loading | `Đang tải…` | `Loading...`, `Vui lòng chờ` |
| Empty list | `Chưa có dự án nào.` + one action (`Tạo dự án`) | `Không có dữ liệu` |
| Not found | `Không tìm thấy dự án.` | `404 Not Found` |
| Retry | `Không tải được danh sách. Thử lại` | `Error!` |
| Saved | `Đã lưu.` | `Lưu thành công!` |
| Delete confirm | Title `Xoá dự án "Thanh toán"?`, body says what is lost, button `Xoá dự án` | `Bạn có chắc không?` |
| Validation | `Tên dài tối đa 64 ký tự.` | `Invalid input` |
| Permission | `Bạn không có quyền sửa dự án này.` | `Forbidden` |

Errors say what went wrong, why if known, and how to fix it — in that order, in one or two sentences. Never show raw
codes, stack traces or English server messages; keep the code in logs or a "Chi tiết" area.

## Terms
- Translate ordinary words: `Settings` → `Cài đặt`, `Search` → `Tìm`, `Cancel` → `Huỷ`, `Close` → `Đóng`,
  `Upload` → `Tải lên`, `Download` → `Tải xuống`, `Sign in` → `Đăng nhập`, `Log out` → `Đăng xuất`,
  `Dashboard` → `Tổng quan`, `Members` → `Thành viên`, `Role` → `Vai trò`, `Permission` → `Quyền`.
- Keep a technical term in English only when the users say it that way and there is no clear Vietnamese word
  (`email`, `API`, `token`, `commit`, `branch`, `pull request`, product names). Write it in normal case inside the
  Vietnamese sentence: `Tạo token mới`, not `Tạo Token Mới`.
- One concept, one word across the whole product. Write the choice into the project's glossary if it has one.
- No half-translated strings (`Đã save`, `Click vào đây`). Use `Bấm` or `Chọn` for click, `Mở` for open.

## Formats (locale `vi-VN`)
- Use the platform formatter, not string concatenation: `Intl.DateTimeFormat("vi-VN")`, `Intl.NumberFormat("vi-VN")`.
- Date `14/10/2026`; date and time `14:05, 14/10/2026`; relative `5 phút trước`, `hôm qua`. 24-hour clock.
- Numbers: `.` groups thousands, `,` is the decimal mark: `1.234.567`, `12,5%`.
- Money: `150.000 ₫` or `150.000 đồng` (no decimals); `Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" })`.
- Units have a space: `25 MB`, `3 giờ`, `10 người`. Plurals do not change the noun: `1 tệp`, `5 tệp`.
- Names: full name in Vietnamese order (`Nguyễn Văn An`); greet by the given name when needed.

## Before you finish
- [ ] Every new string reads as natural Vietnamese said aloud; no leftover English placeholder text.
- [ ] Buttons are specific verbs; destructive actions name the object.
- [ ] Errors say how to fix; no raw codes.
- [ ] Dates, numbers, money use `vi-VN` formatters.
- [ ] Text fits: Vietnamese is often 20–30% longer than English. Check narrow widths and that nothing is cut off.
- [ ] Diacritics are correct and use precomposed Unicode (NFC).
