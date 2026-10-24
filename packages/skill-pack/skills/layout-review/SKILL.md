---
name: layout-review
description: Use when asked to review a web app's layout or UI ("rà soát bố cục", "giao diện ổn chưa", "check responsive"), before a release that changes screens, or when users report overflow, overlap, cut-off text or broken mobile views.
---

# Reviewing a web app's layout

A layout review looks at the **running app** at several widths and reports concrete findings. A plan of what you
would check is not a review.

## 1. Open the app

- Start the dev server, or use a deployed test environment the user names.
- If screens need sign-in, ask the user to sign in in the browser you control. Never type a password yourself, and
  never create accounts.
- Without sign-in, review the public screens and say which screens you could not reach.
- Drive the browser with `playwright-cli`, `webapp-testing`, or the browser tool your client has.

## 2. Screens and widths

List the routes from the router and visit each main screen. For each screen check these widths:

| Width | Device |
|---|---|
| 375 | phone |
| 768 | tablet |
| 1280 | laptop |
| 1920 | large monitor |

Also check dark mode if the app has it, and one screen with long data (long names, many rows) and one empty.

## 3. What to check

| Area | Look for |
|---|---|
| Overflow | horizontal page scroll, content wider than the viewport, tables without their own scroll |
| Overlap | elements on top of each other, sticky headers covering content, toasts covering buttons |
| Text | cut-off or overlapping Vietnamese diacritics (line-height too tight), truncation without a tooltip, text in English |
| Spacing and alignment | inconsistent gutters, misaligned columns, cramped or huge empty areas at 1920 |
| Navigation | menu reachable on phone, current page highlighted, back paths |
| Touch and focus | tap targets under 40px on phone, visible keyboard focus, logical tab order |
| States | loading, empty, error and no-permission states exist and look intentional |
| Colour | contrast of text and icons, status colours readable in dark mode |

`web-design-guidelines` has the full checklist; `vietnamese-ui-copy` covers wording.

You can measure overflow in the page: `document.documentElement.scrollWidth > innerWidth`.

## 4. Report

One finding per row, most severe first:

```markdown
| # | Mức | Màn / độ rộng | Vấn đề | Bằng chứng | Chỗ sửa |
|---|---|---|---|---|---|
| 1 | Cao | /runs @375 | Bảng tràn ngang, cả trang cuộn ngang | runs-375.png | src/pages/runs/list.tsx:42 |
```

- Mức: **Cao** blocks a task or hides content; **Trung bình** looks broken but works; **Thấp** polish.
- Every finding has a screenshot and, when you can find it, the source `file:line` that causes it.
- Say what you did not check (screens behind roles you lack, widths skipped).
- End with the top three fixes you recommend. Do not change code unless asked.
