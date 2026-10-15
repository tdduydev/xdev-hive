> **Version 2 (2026-10-12).** Token names follow shadcn/ui and the values come from the UI UX Pro Max design system;
> see [xdev-hive/MASTER.md](xdev-hive/MASTER.md) for the decisions and [tokens.json](tokens.json) for the values.

xDev Hive is the hub where teams hand coding work to agent CLIs (Claude Code, Codex, Gemini), watch runs, review PRs and merge them through a queue. The UI is a dense, calm operations tool: blue from the logo marks action and selection, everything else stays quiet so run states read at a glance.

## Brand

- The logo is the blue gradient **X** on a navy **hexagon** (a hive cell), with **HIVE** and the descriptor **DEV HUB** (assets → Logos). The hexagon is what makes the mark read as Hive at 16–32 px, so never drop it or swap it for a square. Use `xdev-hive-light.svg` on `background`/`card` in light theme and `xdev-hive-dark.svg` on `brand-navy` or dark `card`. Use `xdev-hive-icon.svg` for favicons and the desktop app icon, and the one-colour `tray-template.svg` for the tray.
- Keep clear space of at least one quarter of the hexagon height around the logo. Never recolour, outline, stretch or re-letter it, never add glow, and never rebuild the X from a font.
- The X gradient (`brand-sky` → `brand-blue` → `brand-deep`) belongs to the logo and brand art only. Never put it on buttons, headers or backgrounds of UI.
- In written content the product is "xDev Hive"; the descriptor "DEV HUB" appears only inside the logo.

## Content

- UI copy, errors and notifications are Vietnamese; every code-level name (routes, files, ids, env vars, queue names) is English. Routes read `/login`, `/projects/<key>`, `/tasks/<key>`, `/admin/members`.
- Write what the person recognises and what happens next: "Đưa PR vào hàng merge", then a toast "Đã đưa PR #128 vào hàng". Errors say what went wrong and how to fix it: "Máy chủ SMTP trỏ vào địa chỉ nội bộ. Dùng máy chủ SMTP công khai hoặc nhờ quản trị hub bật HIVE_NOTIFY_ALLOW_PRIVATE."
- Sentence case for buttons and titles ("Thêm kênh thông báo"), uppercase only for `caps` sidebar group labels. No emoji in the UI.
- Show identifiers as they are in `mono`: `ai/TASK-42`, `7ff9637`, `hwr_…` (never print a full secret).

## Colour

- Lay pages on `background`; put content on `card` with a 1px `border`. Use `muted` for hover rows, table headers and read-only copy boxes.
- Text: `foreground` for headings, key numbers and running text; `muted-foreground` for hints and metadata.
- `primary` is for the one primary action per view, links and the active nav marker. Primary buttons are `primary` with `primary-foreground` text; hover `primary/90`. In dark theme the primary is light, so its text is dark (`primary-foreground`).
- Selection uses `accent` with `accent-foreground` text and a `primary/40` border (selected nav item, selected row, picked option).
- Status always pairs colour with a word and an icon; colour alone never carries state. Map states:
  - running, updating, merging, leased → `accent` / `accent-foreground` with a pulsing dot
  - queued, removed, cancelled, offline-but-expected → `muted` / `muted-foreground`
  - waiting (CI, reviewers, budget near limit), needs review → `warning-soft` / `warning`
  - succeeded, merged, online, sent → `success-soft` / `success`
  - failed, merge failed, offline too long, delivery failed → `destructive-soft` / `destructive`
- Dialogs sit on a `black/50` overlay with `shadow-lg`; floating menus and the login card use `shadow-sm`. Regular cards use the border, not a shadow.

## Type

- `heading` (JetBrains Mono) is for page, dialog and login titles and key figures. Everything else is `sans` (IBM Plex Sans); ids, SHAs, branches and commands are `mono` (JetBrains Mono). Both fonts are self-hosted with fontsource.
- Body is `foreground` `text-sm` (14px). Labels and table headers `text-sm` medium, metadata `text-xs`, sidebar groups `text-2xs` with `tracking-caps`.
- Use tabular figures (`font-variant-numeric: tabular-nums`) for costs, token counts, durations and queue positions.

## Layout and spacing

- App shell: sidebar 240px on `card` with a `border` right border; it collapses below 900px. Content max width 1200px, side gutter `space-6` (`space-4` on phones).
- Cards: `radius-xl`, padding `space-5` (`space-4` on phones), gap between cards `space-6`. Controls: height 36px, `radius-md`, `input` border.
- Tables are the default for lists (runs, tasks, merge queue, channels): header row `muted` + `label`, rows 44px, row hover `muted`, numeric columns right-aligned.

## States

- Focus: 2px solid `ring` ring with 2px offset on every interactive element, both themes.
- Disabled: 50% opacity, no hover change, cursor `not-allowed`; explain why in a hint where the reason is not obvious.
- Loading: skeleton bars in `muted`; empty states say what will appear and offer the first action ("Chưa có PR nào trong hàng. Đưa PR vào hàng").
- Destructive actions (remove channel, remove from queue) use a `destructive` outline button and a confirm step inside the dialog.

## Iconography

- The source app has no icon set yet. Draw 16px and 20px outline icons with a 1.5px stroke in `currentColor`, round caps and joins, matching the logo lettering's rounded strokes. Do not mix filled and outline icons. Flagged: replace with the team's chosen set when there is one.
