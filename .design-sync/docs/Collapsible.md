---
category: Layout
---
# Collapsible

Shows and hides one section (Radix Collapsible): advanced settings, a run's raw log, older history. Unstyled: style the trigger and content yourself.

**Composition**: `Collapsible` > `CollapsibleTrigger asChild` (a `Button`) + `CollapsibleContent`.

**Key props**: `open` / `defaultOpen` / `onOpenChange`; `disabled`.

```tsx
<Collapsible>
  <CollapsibleTrigger asChild><Button variant="ghost" size="sm">Cài đặt nâng cao</Button></CollapsibleTrigger>
  <CollapsibleContent className="pt-2">…</CollapsibleContent>
</Collapsible>
```
