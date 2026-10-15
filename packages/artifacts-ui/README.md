# @xdev-hive/artifacts-ui

Màn artifact dùng chung cho `apps/web` và `apps/desktop` (spec 012 D15; mẫu `docs/design-system/screens/Artifact*.dc.html`).
Gói tự gọi hub qua `ArtifactsEnv.api` (TanStack Query, như `@xdev-hive/doc-editor`); app chủ chỉ dựng route, menu và env.

- `ArtifactsProvider` + `ArtifactsEnv`: `api`, `lang`, `theme` (vé khung theo sáng/tối), `errorMessage`, `link`,
  `frameBase` (gốc phân giải URL khung: web là origin của trang, app là địa chỉ hub), `offline` + `offlineCache` (app
  desktop: đọc bản đã đệm, khung `hive-artifact://`), `canAskLeader` + `onAskLeaderFix`, `onPublicLinks`.
- `ArtifactPanel`: khung bên cạnh của Leader. App giữ `value` (phiên bản đang mở) và đưa `items` (thẻ trong chat theo thứ
  tự); khung tự mở thẻ mới trừ khi đang sửa.
  Đổi cuộc trò chuyện thì dựng lại khung (`key` theo cuộc trò chuyện).
- `ArtifactCard`: thẻ trong tin nhắn (`artifact = null` khi không còn đọc được).
- `ArtifactViewer`: trình xem theo loại. `markdown` (không HTML thô, ảnh ngoài chờ bấm, khối mermaid vào khung qua
  `preview`), `code` (shiki, tải ngôn ngữ khi cần, bộ máy regex JS vì CSP của app không có `wasm-unsafe-eval`), `html`,
  `mermaid`, `react` (lỗi biên dịch hoặc khung).
- `SandboxFrame`: nơi duy nhất tạo `iframe` (`sandbox="allow-scripts"`, kiểm `event.source` rồi schema, ≤ 20 lỗi).
- Tên của T021–T023 (`VersionHistory`, `VersionCompare`, `ShareDialog`, `ArtifactEditor`, `ArtifactLibrary`,
  `ArtifactDetail`, `PublicLinkDialog`, `FixRequestDialog`, `PublicLinksTable`) đã export; các task đó điền file.
- App phải thêm `@source` trỏ tới `packages/artifacts-ui/src` trong CSS để Tailwind quét class.
