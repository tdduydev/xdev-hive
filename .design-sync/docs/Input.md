---
category: Forms
---
# Input

Single-line text field: rounded, sunken background with a glass ring. Pair it with `Label` (`htmlFor` → `id`).

**Key props**
- `controlSize`: `sm` (36px) | `md` (44px, default) | `lg` (52px).
- `icon` / `trailing`: nodes placed inside the field, e.g. a lucide `Search` icon or a keyboard hint.
- `aria-invalid` marks an error (red border); all native `<input>` props pass through.

```tsx
<div className="flex flex-col gap-1.5">
  <Label htmlFor="project-key">Mã dự án</Label>
  <Input id="project-key" placeholder="vd. xdev-hive" icon={<FolderGit2 className="size-4 text-fg-muted" />} />
</div>
```
