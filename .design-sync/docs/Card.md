---
category: Data display
---
# Card

The surface for a block of related content: 24px radius, `bg-card` with a glass ring, 24px padding. Dashboards and settings pages are built from cards.

**Composition**: `Card` > `CardHeader` (`CardTitle`, `CardDescription`, and `CardAction` for a button in the top-right corner) + `CardContent` + `CardFooter`. Give `CardHeader` the `border-b` class (or `CardFooter` `border-t`) for a divider.

```tsx
<Card>
  <CardHeader>
    <CardTitle>Máy chạy agent</CardTitle>
    <CardDescription>2 trực tuyến · 1 ngoại tuyến</CardDescription>
    <CardAction><Button variant="outline" size="sm">Thêm máy</Button></CardAction>
  </CardHeader>
  <CardContent>…</CardContent>
</Card>
```
