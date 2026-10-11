xDev Hive is the hub where teams hand coding work to agent CLIs (Claude Code, Codex, Gemini), watch runs, review PRs and merge them through a queue. The UI is a dense, calm operations tool: blue from the logo marks action and selection, everything else stays quiet so run states read at a glance.

## Brand

- The logo is the blue gradient **X** with **HIVE** and the descriptor **DEV HUB** (assets → Logos). Use `xdev-hive-light.svg` on `canvas`/`surface` in light theme and `xdev-hive-dark.svg` on `brand-navy` or dark `surface`. Use `xdev-hive-icon.svg` (X on a `brand-navy` rounded tile) for favicons, the desktop app icon and the tray.
- Keep clear space of at least one quarter of the X height around the logo. Never recolour, outline, stretch or re-letter it, and never rebuild the X from a font.
- The X gradient (`brand-sky` → `brand-blue` → `brand-deep`) belongs to the logo and brand art only. Never put it on buttons, headers or backgrounds of UI.
- In written content the product is "xDev Hive"; the descriptor "DEV HUB" appears only inside the logo.

## Content

- UI copy, errors and notifications are Vietnamese; every code-level name (routes, files, ids, env vars, queue names) is English. Routes read `/login`, `/projects/<key>`, `/tasks/<key>`, `/admin/members`.
- Write what the person recognises and what happens next: "Đưa PR vào hàng merge", then a toast "Đã đưa PR #128 vào hàng". Errors say what went wrong and how to fix it: "Máy chủ SMTP trỏ vào địa chỉ nội bộ. Dùng máy chủ SMTP công khai hoặc nhờ quản trị hub bật HIVE_NOTIFY_ALLOW_PRIVATE."
- Sentence case for buttons and titles ("Thêm kênh thông báo"), uppercase only for `caps` sidebar group labels. No emoji in the UI.
- Show identifiers as they are in `mono`: `ai/TASK-42`, `7ff9637`, `hwr_…` (never print a full secret).

## Colour

- Lay pages on `canvas`; put content on `surface` cards with a 1px `line` border. Use `subtle` for hover rows and table headers, `sunken` for read-only copy boxes.
- Text: `ink` for headings and key numbers, `body` for running text, `muted` for hints and metadata. Never use `faint` for text.
- `accent` is for the one primary action per view, links and the active nav marker. Primary buttons are `accent` with `on-accent` text; hover `accent-hover`. In dark theme the accent is light, so its text is dark (`on-accent`).
- Selection uses `sel` with `sel-fg` text and a `sel-line` border (selected nav item, selected row, picked option).
- Status always pairs colour with a word and an icon; colour alone never carries state. Map states:
  - running, updating, merging, leased → `sel` / `sel-fg` with a pulsing dot
  - queued, removed, cancelled, offline-but-expected → `subtle` / `muted`
  - waiting (CI, reviewers, budget near limit), needs review → `warn-bg` / `warn`
  - succeeded, merged, online, sent → `ok-bg` / `ok`
  - failed, merge failed, offline too long, delivery failed → `bad-bg` / `bad`
- Dialogs sit on `backdrop` with `shadow-dialog`; floating menus and the login card use `shadow-app`. Regular cards use the border, not a shadow.

## Type

- `display` (Space Grotesk 600, the face of the logo's X) is only for `title-hero`, `page-title` and `stat`. Everything else is `sans` (Inter); ids, SHAs, branches and commands are `mono` (JetBrains Mono). All three load from Google Fonts.
- Body is `body` 14/1.55. Labels and table headers `label`, metadata `small`, sidebar groups `caps`.
- Use tabular figures (`font-variant-numeric: tabular-nums`) for costs, token counts, durations and queue positions.

## Layout and spacing

- App shell: sidebar 240px on `surface` with a `line` right border; it collapses below 900px. Content max width 1200px, side gutter `space-6` (`space-4` on phones).
- Cards: `radius-xl`, padding `space-5` (`space-4` on phones), gap between cards `space-6`. Controls: height 36px, `radius-md`, `line-strong` border.
- Tables are the default for lists (runs, tasks, merge queue, channels): header row `subtle` + `label`, rows 44px, row hover `subtle`, numeric columns right-aligned.

## States

- Focus: 2px solid `focus` ring with 2px offset on every interactive element, both themes.
- Disabled: 50% opacity, no hover change, cursor `not-allowed`; explain why in a hint where the reason is not obvious.
- Loading: skeleton bars in `subtle`; empty states say what will appear and offer the first action ("Chưa có PR nào trong hàng. Đưa PR vào hàng").
- Destructive actions (remove channel, remove from queue) use a `bad` outline button and a confirm step inside the dialog.

## Iconography

- The source app has no icon set yet. Draw 16px and 20px outline icons with a 1.5px stroke in `currentColor`, round caps and joins, matching the logo lettering's rounded strokes. Do not mix filled and outline icons. Flagged: replace with the team's chosen set when there is one.
