---
category: Data display
---
# Badge

The cosmic pill (24px, 11px semibold) with a glowing tone dot. Use it for a short state or label beside a title. For status colours by meaning (ok / warn / danger…) use `CommonBadge`; for filter chips use `Tag`.

**Key props**
- `variant`: `default` (glass) | `secondary` | `destructive` | `outline` (square-ish) | `ghost` | `link`.
- `tone` (colour of the dot): `neutral` | `violet` | `blue` | `green` | `info` | `success` | `warning` | `danger`; `dot={false}` hides it.
- `asChild` to render as a link.

```tsx
<Badge tone="green">Trực tuyến</Badge>
<Badge tone="warning">Gần ngưỡng</Badge>
```
