---
category: Layout
---
# Page

The body of a page: centred, capped at the content width (`--content-max`) with the standard gutter, a column with 24px gaps. Put a `PageHeader` first, then the sections (cards, tables).

**Key props**: `wide` (no max width, for wide boards and tables); `className`; `children`.

```tsx
<Page>
  <PageHeader title="Lượt chạy" subtitle="Mọi lượt chạy của agent trên các máy trong 30 ngày." />
  <DataTable … />
</Page>
```
