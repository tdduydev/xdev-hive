# @xdev-hive/doc-editor

Trình soạn tài liệu (DocEditor.dc.html, SRS DOC-01..05) dùng chung cho `apps/web` và `apps/desktop`. App chủ bọc
`<DocEditor docKey>` trong `<DocEditorProvider env>` và đưa vào: `api` (TanStack Query utils của client hub), `lang`,
`errorMessage`, `link`. App phải thêm `@source` trỏ tới `packages/doc-editor/src` trong CSS để Tailwind quét class.
