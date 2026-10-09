---
category: Forms
---
# NativeSelect

A styled native `<select>` with a chevron icon. Prefer it for simple lists in forms and on mobile; use `Select` when options need custom content.

**Key props**: `size`: `sm` | `default`; `wrapperClassName` sizes the wrapper (it is `w-fit`, so pass `w-full` to fill); native `value` / `defaultValue` / `onChange`. Children are `NativeSelectOption` (and `NativeSelectOptGroup`).

```tsx
<NativeSelect defaultValue="normal" wrapperClassName="w-48">
  <NativeSelectOption value="high">Cao</NativeSelectOption>
  <NativeSelectOption value="normal">Bình thường</NativeSelectOption>
  <NativeSelectOption value="low">Thấp</NativeSelectOption>
</NativeSelect>
```
