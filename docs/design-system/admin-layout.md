# Admin page layout (2026-10-14)

Rules for every administration page of the web app: people and access, projects and infrastructure, agent
governance, monitoring and the knowledge admin screens. They refine [README.md](README.md) (tokens, colour, type)
and [xdev-hive/MASTER.md](xdev-hive/MASTER.md) (density 8/10, motion 3/10) for pages that are mostly tables, settings
forms and dashboards. Direction chosen with the `ui-ux-pro-max` skill (product: developer tool / admin SaaS; dense
dashboard spacing; tables with filters; sticky save; skeletons instead of spinners) and checked against
`web-design-guidelines`.

Templates (Claude Design components, open on the canvas or read the source):

| File | Pattern | Reference page in code |
|---|---|---|
| [`screens/AdminListTemplate.dc.html`](screens/AdminListTemplate.dc.html) | List with tabs, filter bar, table, bulk bar, pagination | `/admin/members` (`members-page.tsx`) |
| [`screens/AdminDetailTemplate.dc.html`](screens/AdminDetailTemplate.dc.html) | Detail with header meta, tabs, description list, related table, danger zone | — (teams, machines, roles detail) |
| [`screens/AdminSettingsTemplate.dc.html`](screens/AdminSettingsTemplate.dc.html) | Multi-section settings form, section nav, sticky save bar | `/projects/$key/settings` (`project-settings-page.tsx`) |
| [`screens/AdminDashboardTemplate.dc.html`](screens/AdminDashboardTemplate.dc.html) | Stat cards, chart card, breakdown table | — (costs) |

Each template has the props `lang` (vi/en), `dark`, `narrow` (360 px) and `state` (normal, loading, empty, error) so
every state can be reviewed without the hub.

## Code map

| Need | Component | File |
|---|---|---|
| Page title, description, actions | `PageHeader` | `apps/web/src/shell/page-header.tsx` |
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
| Save bar | `StickyFormFooter`, `FORM_SCROLL_MARGIN` | `apps/web/src/components/page/sticky-form-footer.tsx` |
| Loading, error, empty | `TableSkeleton`, `SectionsSkeleton`, `LoadingState`, `LoadFailure`, `EmptyState` | `apps/web/src/components/ui/query-state.tsx` |
| Label + input + hint + error | `Field`, `FieldLabel`, `FieldHint`, `FieldError` | `apps/web/src/components/ui/field.tsx` |
| Label–value pairs | `DescriptionList` | `apps/web/src/components/ui/description-list.tsx` |
| Status word | `Pill` (`tone`) | `packages/ui/src/pill.tsx` |

Do not build local copies of these (`function Section`, `function SwitchRow`, hand-made tab classes, `<p>Đang tải…</p>`).
If a page needs a variant, extend the shared component and add a case to `components/page/page.test.tsx`.

## Page anatomy

```
Topbar            organization › group › page (nav.ts), ⌘K, VI/EN, theme, inbox
PageHeader        [crumb]  Title                                  [secondary] [Primary]
                  One sentence: what this page is for.
                  meta · meta · meta
PageTabList       Tab 12 | Tab 3 | Tab (0)                      ← optional, full-bleed border
PageBody          stat grid / filter bar / table / sections
                  …
StickyFormFooter  ● Unsaved changes                    [Discard] [Save]   ← forms only
```

### Width and grid

- Gutters: 16 px below 768 px, 24 px from 768 px (`p-4 md:p-6`). The sidebar is 240 px (icon rail when collapsed);
  at 1100 px the content column is about 836 px, at 1440 px about 1176 px. Design every table for 836 px first.
- `PageBody width`: `full` for tables and dashboards (no cap), `wide` (1360 px) for detail pages and reading
  surfaces, `form` (1120 px) for settings. Give `PageHeader` the same `width` so the title lines up with the content.
- Content is left-aligned. Do not centre pages on wide screens; the eye starts at the sidebar.
- Vertical rhythm: 16 px between blocks in `PageBody`, 12 px between a section title and its content, 16 px inside
  cards (12 px for `size="sm"`). Never stack two bordered surfaces (card in card, table in card): a `PageSection`
  has no border, the table or card inside it does.

### Page header

- Title = the nav label of the page (`nav.ts`), `font-heading text-xl`. The topbar already shows
  `organization › group › page` (group from `navGroupOf`, hidden below 1024 px), so list and settings pages reached
  from the sidebar have no `crumb`. Pages without a nav item (detail pages, project settings, merge queue, project
  sandbox) use the object name or page name as title and the parent list as `crumb` (links). Never use ad-hoc labels
  such as "Quản trị" or "Vận hành" as crumb.
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
- Clickable rows (`onRowClick`) also get a chevron button so keyboard users can open them.
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
- Validation: errors appear under the field (`FieldError`) after submit or blur; the save bar shows one summary
  sentence. Focus moves to the first invalid field.
- `StickyFormFooter` is the last child of the `<form>`: status on the left (unsaved changes · saved · error), Discard
  and Save on the right. Both disabled until something changes. Add `FORM_SCROLL_MARGIN` to the form so the focused
  field is never hidden under the bar. Closing the tab with unsaved changes asks first (`beforeunload`).
- Read-only viewers see the same layout, all controls disabled, a `role="note"` banner at the top explaining who can
  edit, and no save bar.
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
- `Sheet` (right, 480 px, full width below 640 px) for reading or lightly editing one row without losing the list
  (machine details, audit entry). The list stays interactive behind it on wide screens.
- Dialog and sheet bodies scroll internally with `overscroll-behavior: contain`; actions stay visible.

## Sidebar for admin pages

The nav groups in `apps/web/src/lib/nav.ts` stay as they are (Công việc, Kiến thức, Dự án và hạ tầng, Quản trị agent,
Người và quyền, Theo dõi). Rules for admin items:

- Admin-only items are hidden for people without the role or permission (`adminOnly`, `permission`), never shown
  disabled. Before joining an organization every item is shown disabled with the reason (existing behaviour).
- Item label = page title. Badges only for work waiting for the current user.
- Pages reached from a list (project settings, merge queue, sandbox of a project) do not get nav items; the topbar
  breadcrumb and the page crumb link back.

## Responsive and themes

- Check every page at 360, 768, 1100 and 1440 px, light and dark, VI and EN (EN labels are longer: buttons must
  not wrap mid-label; use `whitespace-nowrap` on buttons, let toolbars wrap).
- 360 px: single column; filter bar search full width; tables scroll inside their container with the first column
  pinned; stat grid one column; settings nav becomes chips; save bar buttons stay on one line.
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
5. Forms → `SettingsSection` rows, `StickyFormFooter`, read-only note.
6. No local copies of shared components; no hard-coded `Đang tải…`.
7. Playwright: update names that changed (tab names now `Đang hoạt động 3`), screenshots at 1440/1100/360, light
   and dark, VI/EN; run the page's spec.
