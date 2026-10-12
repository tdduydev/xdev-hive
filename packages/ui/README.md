# @xdev-hive/ui

Component shadcn/ui (Base UI) dùng chung cho `apps/web` và `apps/desktop` (ADR 0017, spec 008 FR-027): một bản, hai
app import `@xdev-hive/ui/<tên>`. App nào dùng phải thêm `@source` trỏ tới `packages/ui/src` trong CSS để Tailwind
quét được class.
