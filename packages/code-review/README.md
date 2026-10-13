# @xdev-hive/code-review

UI review PR của quy trình code (spec 009, US3; mẫu `docs/design-system/screens/CodeReview.dc.html`) dùng chung cho
`apps/web` và `apps/desktop`. Gói chỉ vẽ: không gọi hub. App chủ lấy dữ liệu (`codeReviews.get`, `codeReviews.files`),
đưa vào props và nối các hành động (`onDecide`, `onOverride`, `onEnqueue`, `onRecheck`, `onReload`) tới hub.

- `CodeReviewPane`: khung đủ bộ. Truyền `detail`, `files` (`loading` | `error` | `ready`), `latestHeadSha` (đầu PR mới
  nhất app biết; khác `detail.pr.headSha` thì chặn quyết định), `now`, `t`, `link` (dựng link run/task theo router của app).
- Phần lẻ: `FileDiff`, `AiResults`, `MachineChecks`, `GateStepper`, `DecisionForm`, `OverrideForm`.
- Chữ: `codeReviewText[lang]` (vi/en); app có từ điển riêng thì tự dựng object cùng kiểu `CodeReviewText`.
- App phải thêm `@source` trỏ tới `packages/code-review/src` trong CSS để Tailwind quét class.
