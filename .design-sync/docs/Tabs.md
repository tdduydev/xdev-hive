---
category: Navigation
---
# Tabs

In-page tabs (Radix) that switch panels without changing the address. When each tab should have its own URL, use `PageTabs`; for a filter that is not a set of panels, use `SegmentedTabs`.

**Composition**: `Tabs` > `TabsList` > `TabsTrigger`s, then one `TabsContent` per `value`.

**Key props**: `Tabs` `value` / `defaultValue` / `onValueChange`, `orientation`; `TabsList` `variant`: `default` (sunken segmented track) | `line` (underline).

```tsx
<Tabs defaultValue="notes">
  <TabsList variant="line">
    <TabsTrigger value="notes">Ghi chú</TabsTrigger>
    <TabsTrigger value="runs">Lượt chạy</TabsTrigger>
    <TabsTrigger value="diff">Thay đổi</TabsTrigger>
  </TabsList>
  <TabsContent value="notes">…</TabsContent>
</Tabs>
```
