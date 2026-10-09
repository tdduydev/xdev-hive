---
category: Data display
---
# StatusDot

An 8px status light beside a name: a machine online, an agent profile ready, a leader answering. It is `aria-hidden`, so always put the state in text next to it.

**Key props**: `tone`: `ok` | `warn` | `info` | `running` | `danger` | `neutral` (default); `className` (e.g. `animate-pulse` while something runs).

```tsx
<span className="inline-flex items-center gap-1.5">
  <StatusDot tone="ok" />
  <span className="font-mono text-xs">claude-1</span>
  <span className="text-xs text-muted-foreground">sẵn sàng</span>
</span>
```
