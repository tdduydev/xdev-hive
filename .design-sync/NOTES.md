# design-sync notes: @xdev-hive/ui → claude.ai/design

Shape `package`. First sync built from worktree at origin/ai/INT-0151 (a6f76cd9), 2026-10-09.

## Rebuild

```sh
export PATH=$HOME/.nvm/versions/node/v26.10.0/bin:/opt/homebrew/bin:$PATH   # repo needs Node >= 24
npm ci --prefer-offline
# .ds-sync/ = staged skill scripts + esbuild ts-morph @types/react, plus:
(cd .ds-sync && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright@1.64.0 @tailwindcss/cli@4.3.3)
node .design-sync/build.mjs                                   # cfg.buildCmd → .design-sync/dist/
node .ds-sync/package-build.mjs --config .design-sync/config.json --node-modules ./node_modules \
  --entry ./.design-sync/dist/index.js --out ./ds-bundle
node .ds-sync/package-validate.mjs ./ds-bundle
```

Every `package-build.mjs` run wipes `ds-bundle/`, `.render-check.json` and `_screenshots/` included, so re-run validate after it.

## How the input is built

- `packages/ui` ships TypeScript source only (`exports` point into `src/`) and has no build script. `.design-sync/build.mjs` builds `.design-sync/dist/` from `.design-sync/entry/`:
  - `index.js`: esbuild ESM bundle of `entry/index.ts`, with `react`, `react/*`, `react-dom` and `react-dom/*` external.
  - `index.d.ts` + `types/`: declarations from the repo's tsc (TypeScript 7, the native one). `rootDir` is the repo root, so tsc mirrors paths under `dist/types/`; the entry's own `.d.ts` files move up to `dist/`. tsc keeps specifiers as written, so build.mjs rewrites `#ui/*`, `@xdev-hive/ui/*` and `.ts`/`.tsx` specifiers to relative paths into `dist/types/`. The converter's ts-morph only reads `dist/**/*.d.ts`, so any alias left in place would resolve to `.tsx` source outside the package dir. The build fails if a rewritten specifier has no emitted `.d.ts`, and on any tsc error. TS2308 matters most here: a name exported by two `export *` lines is dropped from the JS without any message.
  - `hive.css`: Tailwind CLI build of `entry/hive.css`, which imports `packages/ui/src/globals.css` and adds `@source` for `entry/` and `previews/`.
  - `font-aliases.css`: the variable fonts' `@font-face` again, under their static family names (see Fonts).
  - `package.json`: `{"name":"@xdev-hive/ui", types, module}`. The converter walks up from `--entry` to the nearest package.json that has a name. Without this file it stops at the repo root (`xdev-hive`).
- PKG_DIR is therefore `.design-sync/dist`. Every package-relative cfg path is relative to it: `cssEntry` (`hive.css`), `extraFonts`, `srcDir` (`../../packages/ui/src`, JSDoc enrichment only; 30 components src-matched) and `tsconfig` (`../entry/tsconfig.json`). `cssEntry` and its font files must stay inside `dist/`, because the converter bounds them to PKG_DIR.
- Tailwind runs with `--cwd .design-sync/entry` because automatic source detection scans the cwd: from the repo root it would sweep `apps/` and `docs/` as well. `globals.css`'s own `@source "./"` scans all of `packages/ui/src`, so the shipped CSS has every utility the app uses, not only the ones in-scope components use. That matters for designs, which can only use utilities that exist in the CSS.
- `entry/tsconfig.json` paths copy the maps in `packages/ui/package.json` by hand. `@xdev-hive/ui` (root barrel, the whole app) is deliberately not aliased. Previews import `'@xdev-hive/ui'`, and the converter shims that to `window.XdevHive`. An alias to `src/index.ts` would only be a footgun.

## Decisions

- **Scope: 157 components** (every PascalCase value export of `entry/index.ts`). Sub-components such as `DialogContent` count separately; that is how the converter counts.
  - `components/ui/*.tsx`: every export, `export *` per file (131, including 23 from sidebar.tsx).
  - `primitives.tsx`: Tag, PrimitiveSwitch, SegmentedTabs, StatTile, ListRow, EmptyState (6).
  - `common.tsx`: CommonBadge, ErrorNote, OwnerBadge, Notice, StatusDot, Empty, PageIntro, PageHeader, Page (9). `STATUS_TONE` also ships (a constant, not a component).
  - PageTabs, DataTable (types renamed DataTableColumn/DataTableFilter/DataTableBulk), ResponsiveTable, ResponsiveTableRow, ResponsiveTableFrame, ResponsiveCellLabel, ResponsiveGridRow, SummaryStrip (+ SummaryItem type), HiveWordmark, XMark (10).
  - HiveTheme, the provider (1).
  - Out of scope: everything that needs hub data or a HiveClient (LeaderChat, MachineCards, TaskKanban, QuotaBars, ModelChip, …).
- **Name collisions.** The components/ui export keeps the plain name and the other one gets an alias:
  - `Badge`: ui/badge keeps it; common.tsx's tone badge ships as `CommonBadge`.
  - `Switch`: ui/switch (Radix) keeps it; primitives.tsx's native-checkbox cosmic switch ships as `PrimitiveSwitch`.
  - `Toggle`: ui/toggle keeps it. primitives.tsx's `Toggle` is only `export { Switch as Toggle }` (the same function as PrimitiveSwitch), so it is not exported a second time.
- **sidebar.tsx is included.** It renders with only its own `SidebarProvider`: no hub data and no HiveClient. The app does not use it, though: the hub shell is its own markup (`hive-sidebar` classes in globals.css). Sidebar, SidebarMenuButton, SidebarRail and SidebarTrigger call `useSidebar` and throw outside SidebarProvider. SidebarProvider renders a `min-h-svh` flex wrapper.
- **Provider `HiveTheme({theme:'dark'|'light'})`** (`entry/HiveTheme.tsx`); previews run with `{"theme":"dark"}`. It does three things:
  - Sets `data-theme` on its own div, with `bg-background text-foreground type-body-md antialiased`, and also on `<body>` in a layout effect. Radix portals mount on `<body>`, outside the div. A Popover opened inside a dark HiveTheme was checked ad hoc in chromium: content background `rgb(36,35,37)` = dark `--bg-raised`.
  - Uses `<body>`, not `<html>` as the app's `lib/theme.ts` does. `<html>` paints the page canvas: with it dark, every card's white 24px frame showed a dark band beneath, the floor cards included.
  - Includes `TooltipProvider`. `App.tsx` wraps the app in it, and Radix Tooltip throws without it.
  - No `I18nProvider`: `useT` falls back to the active locale, which defaults to `vi`. Components render Vietnamese copy.
- **Fonts shipped:** Inter 400/500/600/700 and JetBrains Mono Variable (fontsource; the cyrillic, greek, latin, latin-ext and vietnamese subsets), woff2 only. Tailwind CLI does not rebase `url(./files/…)` from inlined `@fontsource` CSS, so build.mjs copies each file from `node_modules/@fontsource*/*/files/` to `dist/fonts/` and rewrites the url. It drops the woff fallbacks to halve the upload.
- **font-aliases.css (cfg.extraFonts).** The token stack is `'JetBrains Mono Variable','JetBrains Mono',…`. Validate flagged the static `JetBrains Mono` as `[FONT_MISSING]`, although the variable face, which comes first, always loads. The alias declares the same files under the static name, so the warn is resolved, not suppressed. Rendering is unchanged.
- **Be Vietnam Pro and Space Grotesk are deliberately not shipped.**
  - globals.css `@theme` names `"Be Vietnam Pro"` for `--font-sans` and `"Space Grotesk Variable"` for `--font-display`. `tokens/typography.css` redefines both as Inter on unlayered `:root`, which beats `@layer theme`, so neither applies. Neither family is imported by globals.css, though both are in packages/ui dependencies.
  - Brand.tsx draws the X in SVG with `'Space Grotesk Variable','Space Grotesk',Inter`. The app loads no Space Grotesk face, so the X renders in Inter in the app and in this bundle alike. Shipping it would make the bundle differ from the app. If globals.css starts importing it, build.mjs picks it up with no change.
- **Groups come from docs** (see "Docs and groups"). 9 groups: actions 4, forms 19, overlays 56, data-display 30, feedback 7, navigation 29, layout 9, brand 2, theme 1 (= 157).
- **Authored previews, all cells graded good:** Button (Variants, Sizes, WithIcons, States), Dialog (NewTask, RunDetails), DataTable (TaskList, MachinesWithBulk, Paginated, NoMatches), Checkbox (States, WithHint), StatusDot (Tones, InlineWithName), SidebarMenuSkeleton (LoadingGroup, TextOnly). Checkbox, StatusDot and SidebarMenuSkeleton were first written as the §3 fix for `[RENDER_BLANK]`: their floor renders were real but tiny (an 18px box, an 8px dot, a faint skeleton). Copy is real UI strings from `i18n/locales/vi.ts` and real names (task ids, machines, agent profiles).
- `cfg.overrides`: `Dialog` `{"cardMode":"single","viewport":"900x640"}`; `DataTable` `{"cardMode":"column"}`.

## Docs and groups

- `cfg.docsDir` is `"../docs"`, not `".design-sync/docs"`: every package-relative cfg path resolves from PKG_DIR (`.design-sync/dist`).
- One real doc per parent component: `.design-sync/docs/<Name>.md`, 48 files, found by name. Frontmatter `category:` sets the group (slugged: "Data display" becomes `data-display`). The body says when to use it, lists the key props (and the composition, for compounds) and ends with a Vietnamese example.
  - A doc body REPLACES the synthesized `.prompt.md`. The converter then still appends `## Props` from the `.d.ts`, but no longer adds the `## Examples` taken from the preview `.tsx`. So write the example into the doc, and never write a `## Props` heading or a `| Prop |` table (either suppresses the appended props).
- Sub-components (106 + ResponsiveCellLabel, ResponsiveGridRow, ScrollBar = 109) have no doc of their own: discovery only matches exact names. `cfg.docsMap` points each one at its parent's group stub `.design-sync/docs/_groups/<group>.md`. A stub holds only frontmatter; its empty body keeps the synthesized prompt (props + related siblings).
  - The map was generated by longest-parent-prefix (e.g. `AlertDialogTitle` → AlertDialog → overlays, `AlertTitle` → Alert → feedback). The three exceptions without a parent prefix were added by hand.
  - A new sub-component needs a docsMap line, or it lands in `general`.

## Authoring previews: recipe for the fan-out

1. Read the component source in `packages/ui/src/components/…`, its `.design-sync/docs/<Parent>.md`, and 1–2 real call sites (`grep -rn "<Name" packages/ui/src`).
2. Write `.design-sync/previews/<Name>.tsx` with 2–6 named PascalCase function exports; each export is one graded cell.
   - Import DS parts only from `"@xdev-hive/ui"` (shimmed to `window.XdevHive`; never deep paths) and icons from `"lucide-react"` (bundled into the preview). Types are fine (`type DataTableColumn`).
   - Non-exported helpers (`function Behind`, `const Frame`) are fine: only exports become cells.
   - Use realistic Vietnamese copy and real hub names: task ids `R-73a`, `BUG-windows-cli`; machines `mac-mini-01`, `hc-duytd20-linux`; agents `claude-1`, `codex-2`; projects `xdev-hive`, `ehospital-ai`. Statuses come from `STATUS_TONE` and the vi labels in `i18n/locales/vi.ts` (`taskStatus`, `runStatus`).
3. The provider wraps every cell in `HiveTheme theme="dark"`: a dark div with no padding inside the card's white 24px frame. Wrap each story in `<div className="p-4">` (or `p-6`), or its content touches the cell edge.
4. Overlays (Dialog, AlertDialog, Sheet, Popover, Select, DropdownMenu, Tooltip):
   - Render them open (`defaultOpen`, or `open` for Tooltip). They portal to `<body>`, which HiveTheme themes, so they come out dark.
   - Add `onOpenAutoFocus={(e) => e.preventDefault()}` to the content. Otherwise Radix focuses and selects the first field, so the capture shows highlighted text or a focus ring.
   - Put a `min-h-svh` dark "page behind" (title + card blocks) under the trigger, so the scrim darkens app content rather than the white frame.
   - The orchestrator sets `cfg.overrides.<Name>: {"cardMode":"single","viewport":"900x640"}`; Dialog/AlertDialog go full screen below 768px, so keep width >= 768. In single mode the product card shows only the first export, but every export is still captured and graded.
5. Wide content (tables, toolbars): the orchestrator sets `{"cardMode":"column"}`.
6. Utility classes. The preview's classes must exist in `hive.css`. Every class the app's source uses is there (Tailwind scans all of `packages/ui/src` plus `previews/`), but a new arbitrary value (e.g. `min-h-[592px]`) only appears after `node .design-sync/build.mjs`, which subagents must not run.
   - Prefer classes the app already uses, or `style={{…}}` for one-off sizes.
   - Check with `grep -cF 'grid-cols-\[120px_minmax' .design-sync/dist/hive.css` (the selector escapes `[` and `]` with one backslash); list any new class in your learnings file.
7. Loop (subagents): `node .ds-sync/lib/preview-rebuild.mjs --config .design-sync/config.json --node-modules ./node_modules --out ./ds-bundle --components <yours>`, then `node .ds-sync/package-capture.mjs --out ./ds-bundle --components <yours>`.
8. Read `ds-bundle/_screenshots/review/<group>__<Name>.png` and write `.design-sync/.cache/review/<Name>.grade.json` as `{"cells":{"<Export>":{"verdict":"good"|"needs-work","note":"…"}}}`.
   - The large light area under each cell is the 900×700 capture viewport. Ignore it.
   - Disabled controls render at the DS's .45 opacity on dark (faint by design).
   - CSS/bundle changes never clear grades; editing the `.tsx` does.
9. Measured cost this session:
   - Build and capture are fast: build.mjs ~2 s, package-build ~2 s, capture ~5–15 s per component. Full validate ~2.5 min.
   - Authoring time: simple leaf ~5 min; compound ~10 min; overlay ~15 min (1–2 iterations: focus, backdrop); data-heavy (DataTable) ~20 min (1 iteration: padding).

## Gotchas

- The base design-sync SKILL.md was not on disk in this session's bundled-skills dir; only `non-storybook/SKILL.md`.
- No playwright pin in the repo. The cached browsers are chromium-1248 and chromium_headless_shell-1248. `playwright@1.64.0` is the release whose `packages/playwright-core/browsers.json` pins 1248; 1.63.0 pins 1243. Install it with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.
- The repo only has `@tailwindcss/vite`/`@tailwindcss/node` 4.3.3, no CLI. Install `@tailwindcss/cli` at the repo's `tailwindcss` version into `.ds-sync/`. build.mjs prints the exact command when it is missing.
- npm 11 skips install scripts not listed in allowScripts (esbuild postinstall and others). esbuild still works through its optional platform package.
- TypeScript 7's tsc has no `baseUrl`: tsconfig `paths` are relative to the tsconfig file.
- JS bundle is about 1.2 MB, of which about 620 KB is the vi + en message catalogs. `useT` (dialog, sheet, common, DataTable, PageIntro) imports `translate.ts`, which imports both.
- 144 floor cards. Many sub-components throw `X must be used within Y` (Dialog*, Select*, DropdownMenu*, Popover*, Tabs*, Tooltip*, Collapsible*, AlertDialog*, Sheet*, ToggleGroupItem, ScrollBar). That is expected for floor cards: `fallbackCard: true`, not bad. The fix is authoring the full parent composition (§4.2).
  - DataTable floor: `c.title is not a function`, because stub columns from the `.d.ts` are not functions. Author it with real columns.
  - SidebarInput floor: `input is a void element tag`, because the stub passes children to an `<input>`.
- Overlay components (Dialog, AlertDialog, Sheet, Popover, Select, DropdownMenu, Tooltip) will need `cfg.overrides.<Name>: {"cardMode":"single","viewport":"WxH"}` when authored open. DataTable, Table and ResponsiveTable probably need `{"cardMode":"column"}`.
- `SidebarMenuSkeleton` picks a random text width (`Math.random` in sidebar.tsx), so its screenshot differs between runs.
- The card template sets `body{padding:24px;background:#fff}`. The dark HiveTheme box sits inside a white frame, and the `<html>` canvas below stays light (#FAF9FC).
- Root `.gitignore` already has `dist/`, which covers `.design-sync/dist/`. It is listed explicitly anyway.
- `Tag`'s `tone` prop only writes `data-tone`; no CSS styles it (only `data-active`), so all tones look identical. The doc says so; don't author a "tones" story for it.
- `CommonBadge` renders ui/badge underneath, so it carries the cosmic tone dot too.
- Usage examples to port in §4.2: `packages/ui/src/pages/DashboardComponentsFixture.tsx` (cosmic primitives) and real call sites (HubSetup.tsx, GrantEditor.tsx, ProfileStates.tsx, BulkBar.tsx, …).

## Known render warns

- `[RENDER_THIN] StatTile`: the floor card renders the stub label and value ("StatTile" twice). Not bad; it clears when `previews/StatTile.tsx` is authored.

## Re-sync risks

- build.mjs and `entry/tsconfig.json` copy `packages/ui/package.json`'s `exports`/`imports` maps by hand (`#ui/*`, `@xdev-hive/ui/*`, `@xdev-hive/ui/i18n`). A new alias or export pattern needs both updated, or the specifier check fails the build.
- `entry/index.ts` enumerates scope per file. New exports in an existing `components/ui/*.tsx` arrive through `export *`, but a new ui file, or new exports in primitives.tsx, common.tsx or the other named files, need a line added. A new collision fails tsc (TS2308) and so the build: resolve it with an alias and record it above.
- The Tailwind CLI version in `.ds-sync/` must follow the repo's `tailwindcss`; `.ds-sync/` is regenerated each sync.
- The font map only knows `node_modules/@fontsource*/*/files/`. A font from anywhere else fails the build loudly (by design). The woff2-only choice assumes the design app's browsers read woff2.
- `font-aliases.css` derives static names by stripping ` Variable`. If tokens change families, re-check validate's `[FONT_MISSING]`. That check takes the last value of each `--font-*` var, so if typography.css stops overriding `--font-sans` or `--font-display`, Be Vietnam Pro and Space Grotesk would surface and need a decision (they are in deps, so `extraFonts` could ship them).
- HiveTheme themes `<body>`, unlike the app (`<html>`). Two HiveThemes with different themes on one page share the `<body>` attribute (last one wins), so portals follow it.
- Playwright 1.64.0 is tied to the cached chromium-1248. A different cache needs the matching release.
- Authored previews inline Vietnamese strings copied from `vi.ts`, which can drift from the catalog.
- `cfg.docsMap` enumerates the 109 sub-components (an enumeration the skill warns about). Each new sub-component export needs a line, or it silently lands in `general`. Regenerate it with the longest-parent-prefix rule in "Docs and groups".
- Docs restate props by hand (variants, sizes, defaults); a changed cva variant or prop makes the doc stale while the appended `## Props` stays correct.
- Preview utility classes that the app source does not use exist only after `build.mjs` re-scans `previews/`, so always run `buildCmd` before `package-build.mjs`. Without it a new class silently does nothing.
- The Dialog card relies on `viewport` 900x640 (>= 768 keeps it centred) and on the `min-h-svh` backdrop; changing the viewport re-keys its grades.
- Six components are authored and graded; nothing is uploaded and `.review.html` has not been reviewed by a human.

## Wave A learnings (9/10, forms + actions, 9 components graded good)
- All 9 authored, 29 cells, every cell graded `good`; a final scoped capture carried all 9 forward.
- `cfg.overrides.Select: {"cardMode":"single","viewport":"900x640"}`. Select's first story (`MachinePicker`) is
-   rendered open (`defaultOpen`, `position="popper"`). The list portals to `<body>`, so in a grid card it would cover
-   the cells next to it. The other two stories (Sizes, States) are closed triggers. There is no scrim, so no "page behind"
-   is needed. The story has `minHeight: 340` so the open list sits over the dark theme box.
- None. Every class in the nine previews was already in `dist/hive.css` (checked with `grep -cF`). One-off sizes use
-   `style` (`minHeight: 340` in Select, `width: 280` on the Toggle FilterBar input).
- **Toggle `size` does not change height.** cosmic.css sets `[data-slot="toggle"]{min-height:var(--control-h-touch)}`
-   (44px), and the size utilities only set `height`, so sm/default/lg all render 44px tall. `size` changes only
-   `min-w-*` and padding. `docs/Toggle.md` lists `size: sm | default | lg` as if it changed height. A "Sizes" story
-   showed three identical toggles, so it was replaced by `FilterBar` (Toggle next to a md Input, both 44px). The
-   icon-only toggles use `size="lg"` (min-w-10) to come out near square. The same cosmic.css rule also gives every
-   Toggle `box-shadow: var(--ring-glass)`, so the `default` variant shows a faint ring. ToggleGroupItem is
-   `data-slot="toggle-group-item"`, so neither rule applies to it.
- **ToggleGroup default variant needs `variant="default"` passed explicitly.** ToggleGroupItem writes
-   `data-variant={context.variant || variant}`. With no variant prop the attribute is missing, so the
-   `data-[variant=default]:data-[spacing=0]:` joined-edge rules never match and the items render as separate rounded
-   chips. The app only uses `variant="outline"`, so this has not shown up there. Worth one line in `docs/ToggleGroup.md`.
- **An open Select (like Dialog) loses the card's white 24px frame in the capture.** Radix's scroll lock
-   (react-remove-scroll) rewrites the `<body>` padding while open. The dark box then runs edge to edge. This comes from
-   the harness, not the component. Graded good.
- `NativeSelect` optgroups only show when the native list is open; the closed capture shows the selected value only.
- The load average was about 200 during this wave. The first `preview-rebuild.mjs` run for 9 components took about
-   4 minutes, not seconds. Later scoped rebuilds and captures took seconds.
- `sips -c … --cropOffset` did not crop from the top-left on this Mac. `ffmpeg -vf crop=W:H:0:0` worked for zooming
-   into `_screenshots/review/raw/*.png`.

## Wave B learnings (9/10, overlays + navigation, 9 components)
- Overlays and Sidebar. Each story's "page behind" or frame is `height: min(100svh, <H>px)`, so it fills the card
- exactly at the viewport below and stays bounded in a grid. A viewport change re-keys these grades, so re-capture and
- re-grade after applying them.
- ```json
- "AlertDialog":  { "cardMode": "single", "viewport": "900x560" },
- "Sheet":        { "cardMode": "single", "viewport": "900x640" },
- "DropdownMenu": { "cardMode": "single", "viewport": "900x460" },
- "Popover":      { "cardMode": "single", "viewport": "900x420" },
- "Tooltip":      { "cardMode": "single", "viewport": "760x240" },
- "Sidebar":      { "cardMode": "single", "viewport": "900x660" }
- ```
- AlertDialog and Sheet keep the width at >= 768, for the same reason as Dialog (below 768px they change layout: full screen, and a full-width sheet).
- Sidebar must be >= 768 wide. `useIsMobile` (window.innerWidth < 768) turns `collapsible="offcanvas"|"icon"` into a closed mobile Sheet, and the panel is then invisible. Only the IconRail story uses that path; the first story (WorkspaceNav) uses `collapsible="none"` and renders at any width.
- PageTabs, SegmentedTabs and Tabs need no override; they render in the grid.
- **DropdownMenu content takes focus on open** (Radix Menu focuses the content itself; `onOpenAutoFocus` is not a public prop). Add `className="outline-hidden"` to `DropdownMenuContent` so the capture shows no outline. No item is highlighted.
- **Open submenus need `open`, not `defaultOpen`.** An uncontrolled `DropdownMenuSub defaultOpen` closes at once: the root content takes focus, and the sub-content's focus-outside handler closes it. `<DropdownMenuSub open>` stays open. Put the trigger on the left so the submenu has room to open to the right.
- **Tooltip**: force it open with `open` on `Tooltip`; one per story was tested. HiveTheme already provides the TooltipProvider.
- **AlertDialog**: with `onOpenAutoFocus={e => e.preventDefault()}`, the capture shows no focus ring on Cancel. Radix normally focuses Cancel on open. [Inference] Its composed handler skips that step once defaultPrevented is set.
- **Sheet**: `onOpenAutoFocus` passes through `useOverlayFocus`, so preventDefault works the same way.
- **Popover**: same as Dialog: preventDefault on `onOpenAutoFocus`.
- **Fixed-position parts are contained.** `.ds-cell` and `.ds-single` have `transform: translateZ(0)`, so a `position: fixed` element inside them (the Sidebar's desktop panel) is positioned against the cell, not the viewport. Radix portals still go to `<body>`, so overlays are not contained.
- **Tooltip.md is wrong about the colour.** It says "dark on any theme". `TooltipContent` uses `bg-inverse`/`text-fg-inverse`, and the dark theme's `--bg-inverse` is `#FFFFFF`, so on dark it is a white chip with dark text. The captures render it correctly by the tokens. The doc line should say "inverse of the theme (light chip on dark)".
- **Collapsed Sidebar rail shows a clipped letter.** With `collapsible="icon"` collapsed, `SidebarMenuButton` becomes `size-10! p-0! justify-center`. The 18px icon plus gap-2 leave about 14px, and the `truncate` label span shrinks into it. Every item then shows "H…", "T…" next to its icon. shadcn upstream uses `size-8! p-2!`, which leaves no room. The IconRail preview hides the label with `group-data-[collapsible=icon]:hidden` on the span (a class already in hive.css). A designer composing the rail must do the same, or `sidebar.tsx` needs a fix. Worth a line in Sidebar.md.
- **`SidebarMenuSubButton` defaults to `size="md"` = `text-sm` (14px).** That is larger than the parent `SidebarMenuButton`'s `type-body-sm`, so sub-items look bigger than their parent. The preview uses `size="sm"` (`text-xs`). Sidebar.md could recommend it.
- **SidebarProvider is `min-h-svh`.** Bound it with `className="min-h-0 overflow-hidden"` plus a fixed height style; tailwind-merge drops `min-h-svh`. In the icon mode, pass `className="h-full"` to `Sidebar`; it goes to the fixed panel and replaces `h-svh`.
- **SegmentedTabs buttons are `flex:1` and wrap their labels.** A 4-item track narrower than about 560px wraps "Quota / chi tiêu" onto two lines. Give it room (the preview uses maxWidth 640).
- No new classes. `pt-14` and `border-b-0` are not in hive.css; the previews use inline `paddingTop: 56` and `border-0` instead.
- The host was under heavy load during this wave (load average 99–143, other agents plus an electron-builder release). `preview-rebuild.mjs` took 72 s for one component and 9.5 min for eight (NOTES measured about 2 s). Capture stayed fast (about 25 s for eight). This came from the load, not from the previews.
- Known component issue (not fixed by design-sync): sidebar.tsx collapsed rail shows a clipped first letter next to each icon; the app shell does not use sidebar.tsx, so previews hide labels in IconRail.

## Wave C1 learnings (9/10, data display, 11 components)
- All 11 authored, 33 cells, every cell graded `good`; a final scoped capture carried all 11 forward.
-   Badge (Tones, Variants, WithIcons, BesideTitle), Card (MachineCard, WithDivider, TextOnly),
-   CommonBadge (Tones, RunStatuses, TaskStatuses, InRunList), OwnerBadge (SharedAndProject, MemoryList, OnTaskCards),
-   Skeleton (MachineCardLoading, TableRowsLoading, Block), ListRow (Integrations, Profiles, TitleOnly),
-   ResponsiveTable (RunList, GridRows), StatTile (Dashboard, Single, WithoutDetail), Table (RunTable, SelectedRow, WithFooter),
-   Tag (FilterChips, WithIcons, TaskLabels), SummaryStrip (ProjectOverview, Runs, Calm).
- `cfg.overrides.Table: {"cardMode":"column"}` and `cfg.overrides.ResponsiveTable: {"cardMode":"column"}`. Both are full-width
-   tables (RunTable is about 820px at the 900px capture). In a multi-column grid cell they would scroll or squeeze.
- Probably `cfg.overrides.SummaryStrip: {"cardMode":"column"}` as well. It is a full-width strip and its 4-item story needs about 600px.
-   Let validate's `[GRID_OVERFLOW]` decide for SummaryStrip, StatTile (`Dashboard` is a 3-column grid) and CommonBadge/OwnerBadge (`max-w-xl` lists).
- No other config change. No provider, CSS, font or import problem appeared.
- None. Every class in the 11 previews was already in `dist/hive.css`. I checked with a small node script that escapes each class and
-   greps `.<class>`. On the first pass it found `w-3/4`, `h-20` and `divide-line-subtle` missing; I swapped them for `w-2/3`, `h-24`
-   and per-row `border-b ... last:border-b-0`.
- **Tag `tone` has no CSS** (as NOTES says). cosmic.css styles only `.cosmic-tag` and `[data-active="true"]`. No story sweeps tones,
-   and none fakes them with extra classes. The stories show the real looks: neutral chips and the violet active chip.
- **Badge `variant="outline"` shows no border.** The base class has `border-0`, and the outline variant sets only
-   `rounded-xs border-line-default` (a colour, no width). The render is a dot plus text, almost the same as `ghost`. OwnerBadge uses
-   `variant="outline"` for project keys, so it renders the same way. Both are graded good as the real render. It is one root cause in
-   the DS source (badge.tsx), not in a preview or the config. Flagging it in case `docs/Badge.md` ("outline (square-ish)") should say so,
-   or badge.tsx should get `border` on outline.
- **CommonBadge's cosmic dot is always neutral grey.** common.tsx renders `<UiBadge className={TONE[tone]}>` without passing `tone`,
-   so the dot keeps `data-tone="neutral"` whatever the tint. Also, in dark cosmic tokens `--status-running-*` equals `--status-info-*`
-   (#18A0FB on #172F40), so `running` and `info` look the same.
- **StatTile:** the authored stories clear the `[RENDER_THIN]` known warn. That line can come out of "Known render warns" after the next validate.
- **ResponsiveTable card layout (<768px) can't show in the grid.** ResponsiveTable.css switches on a viewport media query, so it never
-   fires at the 900px capture. `ResponsiveCellLabel` is `display:none` at desktop width too, so I wrote no standalone story for it;
-   it is exercised inside ResponsiveGridRow. Showing the phone card form would need its own card with `viewport` below 768
-   (e.g. `{"cardMode":"single","viewport":"390x700"}`). That would make RunList the only product-card story, so I left it out. Orchestrator's call.
- ResponsiveTable needs real `TableHeader`/`TableHead` from the same bundle: it finds headers by `child.type === TableHead`. Importing
-   both from `@xdev-hive/ui` works. Cells are `whitespace-nowrap` by default, so a 6-column run table overflowed 820px and clipped the
-   action buttons. Giving the title cell `whitespace-normal` fixed it.
- Skeleton shimmers (`animate-xd-shimmer`). The capture catches one frame, so its light/dark band can differ between runs (like SidebarMenuSkeleton).
- OwnerBadge's `owner` is a project key (or null = "Chung"). The brief asked for account names, so I put them on the author line of
-   the MemoryList (`duythq`, `claude-1`, `codex-2`) instead of inside the badge, which would be an implausible use.
- MemoryList and OnTaskCards port the real call sites (`pages/Overview.tsx` MemoryList, `components/TaskKanban.tsx`); GridRows ports
-   `pages/admin/Budgets.tsx`.
- The first scoped `preview-rebuild.mjs` for 11 components took about 3.5 minutes (machine load). Later rebuilds took under a second,
-   and each scoped capture took 10–35 s.

## Wave B2 learnings (overrides need a full build)
- `preview-rebuild.mjs` refuses the 6 components. Its output: `✗ [CONFIG_STALE] cfg.overrides/cfg.titleMap for a target component changed since the stamped build — run package-build.mjs first (the full build re-stamps the grade keys)`.
- Cause: a targeted rebuild compares the live `cfg.overrides` with the slices `package-build.mjs` stamped into `ds-bundle/.stories-map.json`. A new or changed override always needs a full build first. Only the orchestrator may run that build.
- Current state: the 6 card htmls still have no `viewport=` in their `@dsCard` header. A capture now would run at 900x700 again, so it cannot grade the new viewports. I did not run it.
- To unblock: the orchestrator runs `buildCmd` + `package-build.mjs` (+ validate). Then the scoped capture for these 6 can run, followed by the regrade.
- For NOTES: after adding a `cfg.overrides` entry, do a full build before handing a component back to a subagent. Otherwise its scoped rebuild stops at `[CONFIG_STALE]`.
- Orchestrator rule learned: after adding cfg.overrides, run a full package-build + validate BEFORE handing components back for recapture ([CONFIG_STALE] blocks scoped rebuilds).
- Real component issues seen while authoring (product fixes, tracked for R-72n): Badge variant=outline shows no border (base border-0 wins); CommonBadge dot ignores tone; Tag tone has no CSS; sidebar.tsx collapsed rail shows clipped first letters.

### Regrade at the new viewports (after the full build)

- The full build cleared the blocker. A scoped rebuild of 7 components (+ Select) took 11 min under load (load avg about 375); capture about 30 s.
- **The 24px gutter crops full-height stories.** `?story=` captures keep `body{padding:24px}`, while the product's single render drops it. Content that fills `min(100svh, H)` therefore loses its last 24px in the capture. Overlays don't mind (only the decorative page behind is cropped). The Sidebar's pinned `SidebarFooter` was cut in half. Fix in the preview: footer `style={{ paddingBottom: 36 }}` (12 + 24). The capture shows it whole, and the product only gains some bottom space. For NOTES: anything pinned to the bottom of a full-viewport story needs 24px of extra bottom room.
- Select (another wave's file, regraded on request) needed no change at 900x640.

## Wave C2 learnings (9/10, feedback + layout + brand, 13 components)
- All 13 authored, 38 cells. Alert (InfoTone, Destructive, WithoutIcon), Notice (Tones, MessageOnly, WithAction),
-   ErrorNote (ActionFailed, MultiLine, AboveForm), Empty (Basic, InSection, InCard), EmptyState (WithAction,
-   TitleAndDescription, InPanel), Collapsible (FoldCardOpen, FoldCardClosed, RunLog, Disclosure), Page (Standard, Wide),
-   PageHeader (WithActions, TitleAndSubtitle, TitleOnly), PageIntro (Basic, UnderCustomTitle), ScrollArea (RunLog, RunList,
-   Horizontal), Separator (Toolbar, StatsLine, InList), HiveWordmark (Sizes, SignInHeader), XMark (Sizes, InIconRail, BesideTitle).
- **Overrides needed:** `cfg.overrides.Page: {"cardMode":"column"}` and `cfg.overrides.PageHeader: {"cardMode":"column"}`.
-   Both are page-wide: Page is `w-full` capped at `--content-max` (1200px) with a 3-tile grid, PageHeader is a
-   `justify-between` row with actions on the right; both fill the whole 900px capture. In a grid cell the actions
-   would wrap under the title ([Inference], not rendered in a grid). Let validate's `[GRID_OVERFLOW]` confirm. PageIntro needs none (max-w-3xl, wraps).
-   After adding them, run the full build first (Wave B2 rule: a scoped rebuild stops at `[CONFIG_STALE]`), then
-   re-capture + re-grade Page and PageHeader (overrides re-key grades).
- No provider, CSS, font or import problem.
- Classes not in hive.css, swapped (no new classes left): `h-64` (→ `h-48`), `w-max` (→ `w-fit`), `gap-8` (→ `gap-6`),
-   `group-data-[state=open]:rotate-180` (→ ChevronRight + `rotate-90`, which the app uses).
-   **`docs/ScrollArea.md`'s example uses `h-64`, which is not in hive.css**, so a design copying it gets no height and
-   the area does not scroll. Change the doc example to `h-48`. ([Unverified] `max-h-64` exists but probably does not bound
-   Radix's `size-full` viewport; not tested.)
- **ScrollArea scrollbars are hidden by default.** Radix `type` defaults to `"hover"`, so a static render shows no
-   thumb (checked: `type = ScrollAreaType.Hover` in the Radix dist). The previews pass `type="always"`. Worth a line in ScrollArea.md.
- **Separator vertical height comes from the parent** (`data-[orientation=vertical]:h-full`). A plain `h-5` on the
-   Separator loses to `.data-\[orientation\=vertical\]\:h-full[data-orientation="vertical"]` (checked in hive.css: higher specificity). Toolbar story: `h-10 py-2` parent → 22px lines.
- **HiveWordmark at 22 was not authored.** The brief asked for 22/30/48; the component doc says "at least 24px tall;
-   below that use XMark", so Sizes uses 24/30/48. XMark uses 22/30/48.
- HiveWordmark switches lettering with `dark:`; `[data-theme="dark"] *` matches any descendant, so a nested
-   `data-theme="light"` box inside the dark HiveTheme still shows the dark lettering (read from globals.css:37, not rendered). No light-tone story is possible
-   under the dark provider. (The app's dark sidebar uses an `<img>` of the dark wordmark, not HiveWordmark.)
- EmptyState (`.cosmic-empty`) has no frame and no max-width: centred text only. In a `max-w-xl` wrapper it sat
-   left of centre; the frameless stories use a full-width `p-4` wrapper, InPanel puts it inside a Card. The action
-   needs its own top margin (`mt-4`): [Inference] from cosmic.css, which sets no gap for `strong`/`p`/action (never rendered without it).
- Page pads itself (`--gutter` 24px), so Page stories have no extra `p-4` wrapper.
- Page `wide` looks identical to the standard Page at the 900px capture (the 1200px cap is never reached).
- Load: the first scoped `preview-rebuild.mjs` for 13 components took 9.5 min wall (1% CPU); capture of 13 took 40 s.
- Done after the wave: `docs/ScrollArea.md` example now uses `h-48` and notes `type="always"`; `cfg.overrides` Page and PageHeader got `cardMode: column` (full build + recapture carried both forward).

## readmeHeader (conventions.md, 9/10)
- `cfg.readmeHeader` = `.design-sync/conventions.md`, resolved from the config home (repo root), not PKG_DIR (package-build.mjs). 3,959 chars; the consumer inlines the first 32,000 README chars.
- `ds-bundle/tokens/` ships empty: token values exist only inside `_ds_bundle.css` (`:root` / `[data-theme="dark"]` blocks). The generated README's own "Tokens" section lists Tailwind internals (`--tw-*`), not DS tokens, so the header points at the CSS blocks instead.
- `onOpenAutoFocus` (used by the overlay previews, recipe §4) is missing from the `.d.ts` of DialogContent, AlertDialogContent, SheetContent and PopoverContent ([Inference] the converter leaves out Radix event props; not checked in its source), so the header does not mention it.
- Tokens or utilities a design may reach for that the shipped CSS lacks: `grid-cols-4` (only `md:`/`lg:grid-cols-4`), `max-w-lg`, `py-6`, `border-line-strong` (only `bg-line-strong`), `type-heading-lg` / `type-display-lg` / `type-code-*` (the `--type-*` tokens exist, the utilities do not).
