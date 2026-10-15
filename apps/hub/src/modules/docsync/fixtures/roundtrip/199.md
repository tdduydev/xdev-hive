# Admin page layout (2026-10-14)

Rules for every administration page of the web app: people and access, projects and infrastructure, agent
governance, monitoring and the knowledge admin screens. They refine [README.md](README.md) (tokens, colour, type)
and [xdev-hive/MASTER.md](xdev-hive/MASTER.md) (density 8/10, motion 3/10) for pages that are mostly tables, settings
forms and dashboards. Direction chosen with the `ui-ux-pro-max` skill (product: developer tool / admin SaaS; dense
dashboard spacing; tables with filters; save per section; skeletons instead of spinners) and checked against
`web-design-guidelines`.

## Decisions

Chosen by the product owner on 2026-10-14. They override anything below that disagrees.

1. **Admin has its own settings menu.** The main sidebar keeps one "Quản trị" item (gear icon) instead of the admin
   groups. On every admin route a second left menu (208 px, `AdminFrame` in `shell/admin-nav.tsx`) shows a "← Quản
   trị" back link (returns to the last non-admin page) and the admin groups in this order: Người và quyền, Dự án và hạ
   tầng, Quản trị agent, Theo dõi. The groups and items are the `area: "admin"` groups of `lib/nav.ts`; items the
   user may not open stay hidden. Below 1024 px the menu becomes one select (grouped options) above the page title.
   Like GitHub or Linear settings.
2. **Clicking a list row opens a detail page.** The detail page has its own URL (`/admin/teams/$teamId`,
   `/admin/members/$userId`). The whole row is clickable (`onRowClick`), a chevron button at the end opens it from
   the keyboard, and the `⋯` row menu keeps quick actions. No slide-over panels for details.
3. **A detail page is a summary header plus horizontal tabs.** `DetailHeader`: "← list" link, name + status pill,
   secondary actions, one primary button and `⋯`, one line of meta. Below it `PageTabList`, tab in the URL (`?tab=`;
   the first tab has no param). Teams moved from two columns to a list and a team page (Tổng quan / Thành viên /
   Hệ thống).
4. **Settings save per section.** Each `SettingsSection` with `save` is its own `<form>`: Save is enabled when that
   section changed, Cancel reverts only that section, "Đã lưu" and errors show in the section footer. There is no
   page-wide save bar (`StickyFormFooter` was removed). Leaving the page with unsaved sections asks first
   (`UnsavedChangesGuard`; closing the tab uses `beforeunload`).

Templates (Claude Design components, open on the canvas or read the source):

| File | Pattern | Reference page in code |
|---|---|---|
| [`screens/AdminListTemplate.dc.html`](screens/AdminListTemplate.dc.html) | List with tabs, filter bar, table, bulk bar, pagination | `/admin/members` (`members-page.tsx`) |
| [`screens/AdminDetailTemplate.dc.html`](screens/AdminDetailTemplate.dc.html) | Detail with summary header, URL tabs, description list, related table, danger zone | `/admin/teams/$teamId`, `/admin/members/$userId` |
| [`screens/AdminSettingsTemplate.dc.html`](screens/AdminSettingsTemplate.dc.html) | Multi-section settings form, section nav, save per section | `/projects/$key/settings` (`project-settings-page.tsx`) |
| [`screens/AdminDashboardTemplate.dc.html`](screens/AdminDashboardTemplate.dc.html) | Stat cards, chart card, breakdown table | — (costs) |

Each template has the props `lang` (vi/en), `dark`, `narrow` (360 px) and `state` (normal, loading, empty, error) so
every state can be reviewed without the hub.

## Code map

| Need | Component | File |
|---|---|---|
| Admin settings menu (second left menu, select below 1024 px) | `AdminFrame` | `apps/web/src/shell/admin-nav.tsx` |
| Page title, description, actions | `PageHeader` | `apps/web/src/shell/page-header.tsx` |
| Detail page header (back, name, status, actions, meta) | `DetailHeader` | same |
| Page content column | `PageBody` (`width`: `full` · `wide` · `form`) | same |
| Page-level tabs with counts | `PageTabList`, `PageTab` (inside Base UI `Tabs.Root`) | same |
| Titled block inside a page | `PageSection` | `apps/web/src/components/page/page-section.tsx` |
| Search + filters + table actions | `FilterBar`, `FilterSearch` (DataTable uses them) | `apps/web/src/components/page/filter-bar.tsx` |
| Client-side table | `DataTable` (`align`, `pin`, `minWidth`, `toolbar`, `serverPaging`) | `apps/web/src/components/data-table/data-table.tsx` |
| Server-side or simple table | `Table`, `Th variant="plain"`, `Td` (`caps` stays for the desktop app) | `packages/ui/src/table.tsx` |
| Period, kind or group-by switch | `SegmentedControl` (`aria-pressed` buttons) | `apps/web/src/components/page/segmented-control.tsx` |
| Topbar breadcrumb group | `navGroupOf` | `apps/web/src/lib/nav.ts` |
| Key figures | `StatGrid`, `StatCard` | `apps/web/src/components/page/stat-card.tsx` |
| Settings page | `SettingsLayout`, `SettingsNav`, `SettingsSection`, `FormRow`, `SwitchRow`, `RadioCards` | `apps/web/src/components/page/settings.tsx` |
| Save one section | `SettingsSection save={…}` (`SectionSave`) | `apps/web/src/components/page/settings.tsx` |
| Ask before leaving with unsaved sections | `UnsavedChangesGuard` | `apps/web/src/components/page/unsaved-guard.tsx` |
| Loading, error, empty | `TableSkeleton`, `SectionsSkeleton`, `LoadingState`, `LoadFailure`, `EmptyState` | `apps/web/src/components/ui/query-state.tsx` |
| Label + input + hint + error | `Field`, `FieldLabel`, `FieldHint`, `FieldError` | `apps/web/src/components/ui/field.tsx` |
| Label–value pairs | `DescriptionList` | `apps/web/src/components/ui/description-list.tsx` |
| Status word | `Pill` (`tone`) | `packages/ui/src/pill.tsx` |

Do not build local copies of these (`function Section`, `function SwitchRow`, hand-made tab classes, `<p>Đang tải…</p>`).
If a page needs a variant, extend the shared component and add a case to `components/page/page.test.tsx`.

## Page anatomy

```
Topbar            organization › Quản trị › page (nav.ts), ⌘K, VI/EN, theme, inbox
AdminFrame        ← Quản trị │ PageHeader   Title                          [secondary] [Primary]
                  GROUP      │              One sentence: what this page is for.
                    Item     │ PageTabList  Tab 12 | Tab 3 | Tab (0)      ← optional, full-bleed border
                    Item     │ PageBody     stat grid / filter bar / table / sections
                  GROUP      │                …
```

Detail page:

```
DetailHeader      ← List
                  [avatar] Name  (Status)                    [secondary] [Primary] [⋯]
                  meta · meta · meta
PageTabList       Tổng quan | Thành viên 4 | Hệ thống 2      ← ?tab=
PageBody          description list / related table / sections with their own Save
```

### Width and grid

- Gutters: 16 px below 768 px, 24 px from 768 px (`p-4 md:p-6`). The sidebar is 240 px (icon rail when collapsed)
  and admin pages add the 208 px admin menu from 1024 px: at 1100 px the content column of an admin page is about
  600 px, at 1440 px about 970 px. Design every admin table for 600 px first (pin the first column, hide secondary
  columns by default).
- `PageBody width`: `full` for tables and dashboards (no cap), `wide` (1360 px) for detail pages and reading
  surfaces, `form` (1120 px) for settings. Give `PageHeader` the same `width` so the title lines up with the content.
- Content is left-aligned. Do not centre pages on wide screens; the eye starts at the sidebar.
- Vertical rhythm: 16 px between blocks in `PageBody`, 12 px between a section title and its content, 16 px inside
  cards (12 px for `size="sm"`). Never stack two bordered surfaces (card in card, table in card): a `PageSection`
  has no border, the table or card inside it does.

### Page header

- Title = the nav label of the page (`nav.ts`), `font-heading text-xl`. The topbar already shows
  `organization › Quản trị › page` for admin pages (`organization › group › page` elsewhere; group hidden below
  1024 px), so list and settings pages reached from a menu have no `crumb`. Detail pages use `DetailHeader` (its
  "← list" link replaces the crumb). Other pages without a nav item (project settings, merge queue, project sandbox)
  use the page name as title and the parent list as `crumb` (links). Never use ad-hoc labels such as "Vận hành" as
  crumb.
- `description`: one sentence, at most about 120 characters, says what the page controls. Required on admin pages:
  it is the only on-page help most people read.
- `meta`: small facts about the object (counts, owner, last change). Use for detail and settings pages.
- Actions: at most one primary button (`variant="default"`), placed last. Secondary actions are `outline`, before
  it. Three or more secondary actions collapse into a `⋯` `DropdownMenu` with `aria-label`. Destructive actions do
  not go in the header of a list page; on detail pages they live in a "Danger zone" section at the bottom.
- Below 640 px the actions wrap under the title, aligned left.

### Tabs

- Use `PageTabList` + `PageTab` for sibling views of the same object or list (Active / Invitations / Pending).
  Counts sit in a badge after the label; use `tone="warning"` when the count is work waiting for someone.
- The selected tab is in the URL (`?xem=` for existing routes, `?tab=` for new ones) so it can be linked and survives
  reload. Default tab = no param.
- Do not use tabs for fewer than two views, for steps of a flow (use `Steps`) or to hide one long form (use
  `SettingsNav`).
- Hidden tabs (permission) disappear; they are not disabled.

## Lists and tables

### Filter bar

- Order: search (256 px, full width on phones), facet filters (dashed outline buttons with a count badge), then
  table actions pushed right (Columns, Export). Use `FilterBar`/`FilterSearch` when the table is not a `DataTable`.
- Search placeholders say what is searched and end with `…`: `Tìm tên, email…`.
- When any filter is active show the "Đang lọc" row: one chip per filter with its own clear button, "Xoá hết bộ
  lọc", and `n / total dòng khớp`. Server-side filters (audit, runs) are reflected in the URL and appear in the
  same row through `activeFilters`.

### Table

- `DataTable` for lists the hub returns whole, and for hub-paged lists with `serverPaging` (one pager only: the hub's
  previous/next replace the local pager; never show both). `Table`/`Th variant="plain"`/`Td` for small static
  tables. Always inside its own
  bordered, rounded container; the page never scrolls horizontally, the table container does.
- Density: header 40 px (`text-xs` muted, sentence case), rows about 44 px (`py-2.5`), 14 px text. A second line in a
  cell (email under name, branch under task) is `text-xs` muted.
- Alignment: text and status left; numbers, money, durations, token counts and the actions column right
  (`align: "end"`, tabular figures). Dates: relative time with the absolute date in `title`, or `formatDay`.
- Status is a `Pill` with a word; colour never carries state alone.
- `minWidth`: set it to the sum of the columns you need, not the default 1060 px. A table of 3–4 columns should not
  scroll at 836 px. When it does scroll, pin the identifying column (`pin: "start"`, first visible column) and the
  actions column (`pin: "end"`, last column).
- Row actions: at most two visible text buttons (`ghost`, `size="sm"`); more go into a `⋯` menu. Every icon-only
  button has an `aria-label` that names the row (`Thu hồi lời mời cho a@b.vn`). Destructive row actions ask for
  confirmation in a dialog that names the object.
- Rows of a list whose objects have a detail page are clickable (`onRowClick` → navigate to the detail URL; Decision
  2). DataTable adds the chevron button (keyboard and screen readers) and ignores clicks on links, buttons, inputs,
  selects and portalled menus inside the row. Keep inline controls (role select, lock) and the `⋯` menu for quick
  actions; the detail page holds everything else.
- Selection: checkbox column only when there are bulk actions the current user may run. The bulk bar replaces
  nothing: it sits above the table and states `Đã chọn n dòng`.
- Pagination footer: range, rows per page, page n / total, previous/next. Default 20 rows; 10 for tables that share
  the page with other content.
- Empty: inside the table container. No data at all → `emptyContent` sentence + first action if any. No match →
  "Không có dòng nào khớp bộ lọc." + "Xoá hết bộ lọc" (DataTable does this).

## Stat cards and dashboards

- `StatGrid` (1 → 2 → 3/4/5 columns) at the top of monitoring pages (costs, audit summary, machines online). At most
  five cards; more numbers belong in a table.
- Period and group-by switches are a `SegmentedControl` in the page header actions (whole page) or in the card title
  row (one chart). The selected option is in the URL when the page is shareable.
- `StatCard`: label (`text-xs` medium), value (`font-heading text-stat`, tabular), and one of `hint` (period, unit)
  or `trend`. A trend always has words (`+8% so với tuần trước`) and `good` says whether up is good; the colour
  follows. `tone` colours only the icon tile.
- A card that summarises a list links to that list pre-filtered (`to`).
- Charts sit in a `Card` with a title row (title, period selector right) and a table fallback; follow the `dataviz`
  skill for colours. Never put a chart inside a stat card except a sparkline.

## Settings forms

- Four or more sections: `SettingsLayout` with `SettingsNav` (sticky list at ≥1024 px, chip row below) and one
  `SettingsSection` per topic. Fewer: sections stacked without nav.
- `SettingsSection`: card with a header (title, one-line description, optional secondary action such as "Tạo quy trình
  từ cấu hình này") and a body of rows separated by hairlines. Every section has a title; no untitled cards.
- Rows:
  - `SwitchRow` for on/off: label and hint left, switch right at every width. Dependent fields go in its `children`
    (indented with a left rule) and only render when on, or render disabled with the reason in the hint.
  - `FormRow` for one field or a field group: label (and hint) in the left 2/5, control in the right 3/5 from 768 px;
    stacked below. Pass `htmlFor` for a single control; without it the row is a named group.
  - Plain 2- or 3-column grids of `Field`s for related numbers (budget per run / per task / max turns).
  - `RadioCards` for choices that need a sentence each (merge mode, CLI permissions). `tone: "destructive"` for the
    risky option; picking it opens a confirm dialog listing consequences.
- Units are suffixes inside the input (`USD`, `%`, `token`); placeholders show the default (`Không giới hạn`,
  `Mặc định của CLI`), never act as labels.
- Validation: errors appear under the field (`FieldError`) after submit or blur; the section footer shows one summary
  sentence. Focus moves to the first invalid field.
- Save per section (Decision 4): pass `save` to `SettingsSection`. The section becomes a `<form>` (Enter saves that
  section only) with a footer: status left (● Có thay đổi chưa lưu · ✓ Đã lưu · error), Huỷ and Lưu right. Lưu is
  disabled until the section changes; Huỷ appears only when it has. The page keeps one draft and sends only the
  fields of the saved section (`buildSectionPatch` in `lib/project-settings.ts`), so half-typed changes in another
  section are never sent. While one section saves, the Save buttons of the others are disabled (`disabled`).
- Mount `UnsavedChangesGuard when={anyDirty}` once per page: navigating to another page opens a dialog (Ở lại / Rời
  trang); closing or reloading the tab uses the browser prompt. Changing `?tab=` or `#section` on the same page does
  not ask.
- Read-only viewers see the same layout, all controls disabled, a `role="note"` banner at the top explaining who can
  edit, and no section footers.
- Short create/edit forms (up to about six fields) live in a `Dialog`; anything longer is a page.

## States

| State | First load | Refetch / action |
|---|---|---|
| Loading | `TableSkeleton` for lists, `SectionsSkeleton` for forms/details, sized like the content | keep the old data; disable the triggering button and change its label (`Đang lưu…`) |
| Error | `LoadFailure` (hub message in Vietnamese + "Tải lại") in place of the content | inline `Alert` next to the control or in the save bar; keep user input |
| Empty | `EmptyState`: icon, what will appear here, first action (`Mời người`) | — |
| No permission | hide the nav item and actions; if reached by URL show the read-only note or the status page | — |
| Not found | `Alert` + link back to the list | — |

- Never show a bare `Đang tải…` paragraph for a whole page. Spinners (`LoadingState`) are for small inline areas
  (a dialog body, a select's options).
- Messages say what happened and what to do next (README § Content).

## Dialogs and sheets

- `Dialog` (max 512 px; 640 px for forms with two columns): create, invite, confirm. Title is the action
  ("Mời người vào tổ chức"); primary button repeats the verb ("Gửi lời mời"); Cancel is `outline` on the left.
- Confirm destructive actions with the object's name in the title and a `destructive-solid` button ("Xoá kết nối
  GitHub Acme"). Never confirm with "OK".
- No `Sheet` for object details (Decision 2): an object with more than a few fields gets a detail page. A sheet is
  only for a transient read-only peek that has no URL of its own (an audit entry's raw payload).
- Dialog and sheet bodies scroll internally with `overscroll-behavior: contain`; actions stay visible.

## Navigation for admin pages

`apps/web/src/lib/nav.ts` is the single source. The main sidebar shows Tổng quan, the work groups (Công việc, Kiến
thức) and one "Quản trị" item; the groups marked `area: "admin"` (Người và quyền, Dự án và hạ tầng, Quản trị agent,
Theo dõi) render in the admin menu (`AdminFrame`, Decision 1). ⌘K still lists every item.

- "Quản trị" links to the first admin item the user may open and is highlighted (`aria-current="true"`) on every
  admin route; the admin menu highlights the page (`aria-current="page"`). It is hidden when the user may open no
  admin item.
- The admin menu's "← Quản trị" goes back to the last page outside admin (Tổng quan after a reload).
- Admin-only items are hidden for people without the role or permission (`adminOnly`, `permission`), never shown
  disabled. Before joining an organization every main item is shown disabled with the reason (existing behaviour).
- Item label = page title. Badges only for work waiting for the current user.
- Detail pages (`/admin/teams/$teamId`) and pages reached from a list (project settings, merge queue, sandbox of a
  project) do not get nav items; they keep their parent item highlighted. A project's board (`/projects/$key`) is a
  work page: no admin menu, Bảng việc highlighted.

## Responsive and themes

- Check every page at 360, 768, 1100 and 1440 px, light and dark, VI and EN (EN labels are longer: buttons must
  not wrap mid-label; use `whitespace-nowrap` on buttons, let toolbars wrap).
- Below 1024 px the admin menu is a select above the page. 360 px: single column; filter bar search full width;
  tables scroll inside their container with the first column pinned; stat grid one column; settings nav becomes
  chips; section footer buttons stay on one line; detail header actions wrap under the name.
- Never rely on hover alone: row actions are always visible, tooltips repeat the visible label or an `aria-label`.

## Copy

- UI text is Vietnamese with an English pair in the page's `Dict`; errors from the hub stay Vietnamese.
- Sentence case for titles, buttons and column headers. Loading labels end with `…`.
- Numbers and money through `lib/format.ts` (`formatInt`, `formatUsd`, `formatPercent`, `formatDuration`).
- Identifiers (`ai/TASK-42`, `hwr_…`, URLs, emails) are `font-mono` and wrap with `break-all` only inside tables.

## Migration checklist (per page)

1. `PageHeader` with title, `description`, actions ordered secondary → primary; `width` matches `PageBody`.
2. Tabs → `PageTabList`/`PageTab`, selected tab in the URL.
3. Lists → `DataTable` (or `Table` + `FilterBar`), `minWidth` set, numeric columns `align: "end"`, identifying and
   action columns pinned when the table scrolls.
4. Loading → skeleton; errors → `LoadFailure` with retry; empty → `EmptyState` with first action.
5. Forms → `SettingsSection` rows with `save` per section, `UnsavedChangesGuard`, read-only note.
6. Objects with details → row click to a detail page with `DetailHeader` and URL tabs; no side panel.
7. No local copies of shared components; no hard-coded `Đang tải…`.
8. Playwright: update names that changed (tab names now `Đang hoạt động 3`), screenshots at 1440/1100/360, light
   and dark, VI/EN; run the page's spec.
