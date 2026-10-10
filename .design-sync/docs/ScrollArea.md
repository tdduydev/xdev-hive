---
category: Layout
---
# ScrollArea

A scroll container with thin custom scrollbars (Radix Scroll Area). Give it a fixed height or max height; add a horizontal `ScrollBar` for wide content.

**Composition**: `ScrollArea` > content; `<ScrollBar orientation="horizontal" />` inside it for sideways scrolling.

```tsx
<ScrollArea className="h-48 rounded-lg border border-line-subtle">
  <div className="flex flex-col gap-2 p-3">{runs.map((r) => <ListRow key={r.id} title={r.title} />)}</div>
</ScrollArea>
```

The scrollbar only shows on hover by default (Radix `type="hover"`). Pass `type="always"` when the thumb must stay visible, for example in a static mock.
