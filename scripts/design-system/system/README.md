xDev Hive · Dev Hub is where developers run projects, dispatch AI coding agents and share docs, skills, memory and tasks. The interface is the **cosmic** layer: a near-black (dark) or lavender-white (light) canvas with a faint star field, glass surfaces, pill buttons and one violet accent. Light and dark are equal citizens; set `data-theme="light|dark"` on `<html>` or on any subtree to re-theme it.

## Content fundamentals

- **Vietnamese first**, English second (every string exists in `vi` and `en`). The voice is a technical colleague: clear, direct, no exclamation marks. Neutral address; use "bạn" only when needed.
- **Sentence case** for titles, buttons and menus. Never Title Case Every Word.
- **Keep developer terms as they are:** agent, run, task, skill, memory, commit, PR, worktree, token, webhook.
- **Buttons start with a verb:** "Tạo task", "Chạy agent", "Duyệt".
- **Confirmations name the consequence:** "Xoá dự án payment-gateway? 42 task sẽ mất."
- **Errors say what happened and what to do next:** "Không kết nối được máy build-03. Kiểm tra agent đang chạy rồi thử lại."
- **Vietnamese number format:** 1.284 · 97,2% · $12,48. Relative time for recent items ("3 phút trước"), absolute on hover.
- Project names, slugs, IDs, paths, branches and model names are set in `code-sm` / `code-md` (mono): `ai/ADM-backup-restore`, `claude-opus-5-5`.
- **No emoji**, anywhere.

## Visual foundations

### Color
- Build only with semantic tokens: `bg-*`, `surface-*`, `text-*`, `border-*`, `action-*`, `state-*`, `status-*`. The `blue-*`, `neutral-*`, `navy-*`, `green-*`, `amber-*`, `red-*` and `brand-*` primitives exist for the logo and legacy pages; never reference them from a component.
- **Grounds:** page on `bg-canvas`; cards and tables on `surface-1`; sidebar, menus and neutral fills on `surface-2`; tags on `surface-3`; inputs and code on `surface-sunken`. Step up one surface for each nesting level.
- **Text:** `text-strong` for headings and numbers, `text-primary` for body, `text-secondary` for supporting copy, `text-muted` for meta. `text-faint` is for the least important meta only — in dark it is 4.2:1 on `bg-canvas`, below AA, so never put information there that is not repeated elsewhere.
- **Violet is the brand action:** `action-primary-bg` (#6547e5 light / #7b61ff dark) for the one main action per area, the switch-on track, the active tag and toggle. `text-brand` / `text-link` carry the same hue as text.
- **Blue is the second action** (`action-blue-bg`), used beside a violet primary, never instead of it.
- **Accents** `accent-violet`, `accent-blue`, `accent-green`, `accent-red`, `accent-amber` are for dots, bars, glows and the brand gradient — not for text. Text in a status colour uses `status-*-fg`.
- **Status:** success = green, warning/quota = amber, danger = red, info and running = blue, waiting/offline = neutral. Each has `-fg` (text + icon), `-bg` (soft fill), `-solid` (dot/bar). **Never colour alone:** a status always carries an icon and a word; a diff carries +/−; a log line carries INFO/WARN/ERROR.
- **Brand gradient** (violet → blue in the cosmic layer; #7bd4ff → #1e90ff → #004cff for the logo X) only for: the logo X, a running run's progress bar, an active agent's ring, and the one Brand button per screen. Never for backgrounds, text, tables, editors or reading areas.

### Type
- `sans` and `display` are **Inter**; `mono` is **JetBrains Mono**. Default body is `body-md` (14/22).
- Page titles `display-lg`, section and dialog titles `display-md`, KPI numbers `numeric-lg` with tabular figures. Card titles `heading-md`, table headers `heading-sm`.
- Labels, switches and buttons `label`; meta `caption`; section overlines `overline` (+0.06em tracking).
- Chat and the 2026-10 pages use the slightly heavier `text-body-sm`, `text-caption`, `text-micro`.
- Docs and the rich editor use the `prose-*` styles, capped at `reading-max` (72ch). Body goes to 16px under 768px so iOS does not zoom.
- Inputs are 16px on mobile, 14px from `bp-md` up.

### Spacing, size and layout
- 4/8 grid: `space-1` (4) … `space-20` (80). Page gutter `gutter` (24), `gutter-mobile` (16).
- Cosmic buttons: `button-h-sm` 34, `button-h-md` 46 (default), `button-h-lg` 54. Inputs 36/44/52. Legacy controls 24/28/32/40. Touch targets ≥ `control-h-touch` (44).
- Table rows `row-h` 40, compact 32. `data-density="compact"` on a container shrinks rows and controls.
- Shell: sidebar `sidebar-w` 252 at ≥ `bp-lg`, icon rail `sidebar-rail-w` 64 between `bp-md` and `bp-lg`, drawer + bottom tabs below `bp-md`. Top bar `topbar-h` 72. Content max `content-max` 1200.

### Shape
- `radius-card` 24 for cards and panels; `radius-pill` 32 for every cosmic button; `radius-control` 12 for inputs, segments, toggles and icon buttons; `radius-chip` 8 for tags; `radius-full` for badges, avatars, switches and dots.
- The `radius-xs`…`radius-xl` scale (4–16) remains for legacy shadcn pieces: checkbox 4, menu items 6, dialogs 12, drawers and the command palette 16.

### Surfaces, borders and elevation
- Cosmic surfaces are outlined by `ring-glass` (a 1px inset ring in `border-subtle`), not by borders or drop shadows. Use `ring-glass-strong` for a pressed or selected segment.
- Hairlines between rows: `hairline` / `divider`. Sticky headers: `surface-sticky` + `shadow-sticky`.
- Drop shadows only for floating layers: `shadow-2` menus, `shadow-3` dialogs/drawers/command palette, `shadow-4` toasts. `shadow-1` is an interactive card's hover.
- Dialog and drawer backdrops use `bg-scrim`.
- No coloured left-border accents on cards.

### Backgrounds and imagery
- The page background is `bg-canvas` under a sparse star field (`star-1`…`star-5`, 1–1.5px dots on a 300px tile) and a soft 135° gradient into the canvas. Keep it behind the shell only, never inside cards.
- Glass: the glass button blurs what is behind it (5px, saturate 185%); blur is off under reduced motion.
- The three planet renders (Illustrations group) are the only imagery: each stands for an agent kind (violet = Claude, green = Codex, blue = Gemini), shown as a round avatar.

### States and motion
- Hover: overlay `state-hover` on rows and items; cosmic buttons brighten (×1.14) and lift 1px. Pressed: `state-pressed`, cosmic buttons scale to .96. Selected: `state-selected-bg` + `state-selected-fg`, outlined in `state-selected-border`.
- **Focus:** a solid 2px `focus-color` outline, offset 2px (`focus-ring-width`, `focus-ring-offset`), keyboard only. It meets 3:1 on every surface in both themes.
- Disabled: 45% opacity on buttons, `state-disabled-*` on legacy controls.
- Durations 80–320ms (`instant` 80, `fast` 120, `base` 180, `slow` 240, `slower` 320); `ease-standard` cubic-bezier(.2,0,0,1), opening layers `ease-enter`. Under `prefers-reduced-motion` all durations are 0 and spinners, shimmer and gradient rings stop.

## Components

The library is shadcn/ui (Radix) restyled by the cosmic layer, in `@xdev-hive/ui-kit`. This system carries a build of it: `window.XdevHive` (components/bundle.js) on React 19 (components/lib), styled by components/bundle.css over tokens.css. In the app, import from `@xdev-hive/ui-kit/components/ui/<name>` instead. Each component has a live preview and guidelines; the summary below is the short version.

- **Button** — variants `solid` (violet, main action), `blue`, `glass` (default secondary), `ghost`, `brand` (gradient border; at most one per screen), `destructive`, `danger-outline`, `link`. Sizes `sm`/`md`/`lg` follow `button-h-*`; icon buttons use `radius-control`. Label 13–16px semibold, +.2px tracking.
- **Badge** — 24px pill, `text-micro`, glass fill with `ring-glass`, a 6px glowing dot whose tone is `violet`, `blue`/`info`, `green`/`success`, `warning` or `danger`. Always include the word.
- **Tag** — 28px, `radius-chip`, `surface-3`; active tag turns `action-primary-bg`.
- **Input** — `surface-sunken`, `radius-control`, `ring-glass`, 14px medium; invalid adds a 2px inset `status-danger-fg` ring plus a message.
- **Switch** — 44×26 track on `surface-4`, violet when on, 20px white thumb with `switch-thumb-shadow`.
- **Card** — `surface-1`, `radius-card`, padding `space-6`, `ring-glass`, no shadow.
- **Segments / toggle** — `surface-sunken` well; the pressed segment is `surface-3` with `ring-glass-strong`.
- **Stat** — `surface-2`, `radius-control`, number in `numeric-lg`, caption in `body-sm`.

## Iconography

- **Lucide** (`lucide-react`), outline, round caps; default `icon-md` 16px, `icon-sm` 14 in dense rows, `icon-lg` 20 in headers. Colour follows `currentColor`.
- Icons accompany a label. Icon-only buttons carry an `aria-label` and a tooltip.
- No emoji and no Unicode symbols as icons.

## Logo

- Use the files in the Logos group; **never redraw the mark.** `hive-light.svg` on light grounds, `hive-dark.svg` or `xdev-hive-dark.svg` on dark grounds.
- Below 24px tall use the X alone: `app-icon.svg` (X outlined, on its navy tile) or `x-mark.svg`.
- `x-mark.svg` and `xdev-hive-dark.svg` set the X as live text in Space Grotesk; where that font is not loaded it falls back to Inter. Prefer `app-icon.svg` when an exact X matters.

## Not synced

- Tokens come from the effective cascade of `packages/ui-kit/src/tokens/*.css` (cosmic and Today layers over the 2026-09 colours). Gradients (`brand-gradient*`, `page-gradient`, `page-background`, `shell-backdrop`, `button-glass-overlay`) and motion durations/easings are not representable as tokens; they are described above.
- Fonts are named as hosted faces (Inter, JetBrains Mono); no files are included because the repo only has per-subset @fontsource files.
- `globals.css` also declares Be Vietnam Pro / Space Grotesk in a Tailwind `@theme` block, but the unlayered `typography.css` (Inter) overrides it; this system records Inter.
- The 103-icon Lucide sprite from `docs/design/2026-09-redesign/assets/icons.svg` is not included.
- Component bundle: 31 components from `packages/ui-kit` built with esbuild (React and ReactDOM as globals) and Tailwind v4; the app-level DataTable, ResponsiveTable, Sidebar, ScrollArea, Collapsible and ErrorBoundary are not included.
