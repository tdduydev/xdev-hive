// Usage notes of the design system tokens: where the app uses each one. tokens.mjs reads the values from CSS.

const COLOR = {
  "brand-blue-light": "Brand primitive: first stop of the logo X gradient. Never in components; use semantic tokens.",
  "brand-blue-mid": "Brand primitive: middle stop of the logo X gradient.",
  "brand-blue-deep": "Brand primitive: last stop of the logo X gradient.",
  "brand-navy": "Brand primitive: the navy tile behind the app icon X.",
  "brand-ink": "Brand primitive: wordmark lettering on light grounds.",
  "brand-ink-inverse": "Brand primitive: wordmark lettering on dark grounds.",
  "brand-canvas": "Brand primitive: the 2026-09 light canvas. Superseded by bg-canvas in the cosmic layer.",
  "bg-canvas": "Page background behind everything. Light #f7f6fa, dark near-black #0e0e11.",
  "bg-subtle": "Sidebar and quiet panels; aliases surface-2.",
  "bg-surface": "Cards, tables, dialogs; aliases surface-1.",
  "bg-raised": "Popovers and menus over a surface; aliases surface-2.",
  "bg-sunken": "Inputs, code wells and inset areas; aliases surface-sunken.",
  "bg-inverse": "Inverted chips and tooltips (dark on light theme, white on dark).",
  "bg-scrim": "Overlay behind dialogs and drawers: 48% light, 64% dark.",
  "text-strong": "Headings and key numbers on bg-canvas and surfaces.",
  "text-primary": "Body copy on bg-canvas, surface-1..4.",
  "text-secondary": "Supporting text, table cells, ghost buttons on bg-canvas and surfaces.",
  "text-muted": "Meta, timestamps, placeholders on bg-canvas and surface-1.",
  "text-disabled": "Disabled labels only; exempt from contrast.",
  "text-inverse": "Text on bg-inverse; aliases bg-canvas.",
  "text-link": "Inline links on bg-canvas and surfaces.",
  "text-link-hover": "Link hover.",
  "text-on-accent": "Text and icons on action-primary-bg, action-danger-bg, action-blue-bg.",
  "text-brand": "Brand-coloured text: the brand button label, active nav count.",
  "text-faint": "Least-important meta on bg-canvas.",
  "border-subtle": "Dividers inside cards and lists.",
  "border-default": "Card, table and panel outlines; the default border (shadcn --border).",
  "border-strong": "Hover outline of interactive cards.",
  "border-control": "Input, checkbox and select borders (shadcn --input); 3:1 on surfaces.",
  "border-selected": "Selected card outline (2px); aliases state-selected-border.",
  "action-primary-bg": "Primary button fill (violet), switch-on track, active tag. One primary per area.",
  "action-primary-hover": "Primary button hover.",
  "action-primary-active": "Primary button pressed.",
  "action-primary-fg": "Label on action-primary-bg.",
  "action-secondary-bg": "Secondary/outline button fill (glass).",
  "action-secondary-hover": "Secondary button hover.",
  "action-secondary-active": "Secondary button pressed.",
  "action-secondary-fg": "Secondary button label.",
  "action-secondary-border": "Secondary button border.",
  "action-ghost-hover": "Ghost button and menu item hover overlay.",
  "action-ghost-active": "Ghost button pressed overlay.",
  "action-danger-bg": "Destructive button fill. Pair with a consequence-naming label.",
  "action-danger-hover": "Destructive button hover and pressed.",
  "action-danger-fg": "Label on action-danger-bg.",
  "action-blue-bg": "The cosmic 'blue' button fill: secondary call to action beside a violet primary.",
  "action-blue-fg": "Label on action-blue-bg.",
  "state-hover": "Hover overlay on rows, list items, chips.",
  "state-pressed": "Pressed overlay.",
  "state-selected-bg": "Selected row, active nav item, selected option background.",
  "state-selected-fg": "Text on state-selected-bg.",
  "state-selected-border": "Outline of a selected item.",
  "state-disabled-bg": "Disabled control fill.",
  "state-disabled-fg": "Disabled control label; exempt from contrast.",
  "state-disabled-border": "Disabled control border.",
  "focus-color": "Keyboard focus ring colour: 2px outline, 2px offset.",
  "switch-thumb": "Switch thumb in both themes.",
  "button-glass-bg": "Fill of the glass button (cosmic default action).",
  "surface-1": "Cosmic surface step 1: cards, tables (bg-surface).",
  "surface-2": "Cosmic surface step 2: sidebar, raised menus, neutral badges.",
  "surface-3": "Cosmic surface step 3: tags, highlighted code line.",
  "surface-4": "Cosmic surface step 4: switch-off track, pressed secondary.",
  "surface-sunken": "Inputs, input groups and code blocks.",
  "surface-violet": "Violet-tinted surface for the selected/active panel.",
  "surface-sticky": "Sticky table header and toolbar over scrolling content.",
  "accent-violet": "Cosmic accent hue: violet badge dot, glow, brand gradient start. Not for text.",
  "accent-blue": "Cosmic accent hue: info/running dot, brand gradient end. Not for text.",
  "accent-green": "Cosmic accent hue: success dot and solid. Not for text.",
  "accent-red": "Cosmic accent hue: danger dot and solid. Not for text.",
  "accent-amber": "Amber accent for warnings and quota on the Today and Machines pages.",
  "accent-violet-soft": "Violet text/icon accent on Pipeline and Features.",
  "violet-soft": "Violet text accent (template --color-violet-soft).",
  "glass-bg": "Translucent glass fill: secondary buttons, default badge, hover.",
  "glass-hover": "Glass fill on hover.",
  "glass-faint": "Faintest glass fill (machine cards).",
  "track": "Progress and quota bar track.",
  "track-off": "Off-state track; aliases glass-bg.",
  "progress-track": "Progress bar track.",
  "board-column-bg": "Kanban column background.",
  "chip-bg": "Neutral chip fill.",
  "divider": "1px rules between rows.",
  "stage-done": "Completed pipeline stage text/icon.",
  "code-well": "Inline code / prompt well (Memory, Skill, Artifact pages).",
  "code-well-fg": "Text in code-well.",
  "num-warn": "Number in a warning state (quota near limit).",
  "num-danger": "Number in a danger state (quota exceeded).",
  "reset-bg": "Quota reset control, on.",
  "reset-off-bg": "Quota reset control, off.",
  "danger-panel-bg": "Danger zone panel fill.",
  "pill-violet-ring": "Ring colour of the violet pill.",
  "status-warning-solid": "Warning dot/bar fill; same value in both themes.",
};

/** The note of a colour token: an exact entry, else a rule by name stem. */
export function colorUsage(n) {
  let m;
  if (COLOR[n]) return COLOR[n];
  if ((m = /^(blue|neutral|navy|green|amber|red)-(\d+)$/.exec(n))) return `Primitive ${m[1]} ${m[2]} (2026-09 palette). Never in components; reference through a semantic token.`;
  if ((m = /^status-(\w+)-(fg|bg|border|solid)$/.exec(n))) {
    const what = { success: "done/passed", warning: "warning/quota", danger: "error/failed", info: "information", running: "running/in progress", neutral: "waiting/offline" }[m[1]];
    return { fg: `Status text and icon for ${what}, on bg-canvas, surfaces and status-${m[1]}-bg. Always with an icon and a word.`, bg: `Soft fill of a ${what} badge, alert or row.`, border: `Border of a ${what} alert; aliases border-default in the cosmic layer.`, solid: `Dot, bar or solid fill for ${what}.` }[m[2]];
  }
  if ((m = /^code-(.+)$/.exec(n))) return `Code block: ${m[1].replace("-hl", " highlight")}.`;
  if ((m = /^syntax-(.+)$/.exec(n))) return `Syntax highlighting: ${m[1]} tokens on code-bg.`;
  if ((m = /^diff-(add|del|hunk|ctx)-?(.*)$/.exec(n))) return `Diff viewer: ${{ add: "added", del: "removed", hunk: "hunk header", ctx: "context" }[m[1]]} line ${m[2] || "fill"}. Always with +/− marks.`;
  if ((m = /^chart-(\d)$/.exec(n))) return `Chart series ${m[1]}, in order. Label series directly; do not rely on hue alone.`;
  if ((m = /^shell-(.+)$/.exec(n))) return `App shell (sidebar, topbar): ${m[1].replace(/-/g, " ")}.`;
  if ((m = /^star-(\d)$/.exec(n))) return `Star dot ${m[1]} of the cosmic page background pattern.`;
  if ((m = /^os-(mac|ubuntu|win)-(bg|fg)$/.exec(n))) return `Machines page OS chip (${m[1]}): ${m[2] === "bg" ? "fill" : "label"}.`;
  if ((m = /^chat-(.+)$/.exec(n))) return `Chat page: ${m[1].replace(/-/g, " ")}.`;
  if ((m = /^chip-(\w+)-(bg|fg)$/.exec(n))) return `Label chip on Memory/Skill cards (${m[1]}): ${m[2] === "bg" ? "fill" : "text"}.`;
  if ((m = /^pill-(\w+)-(bg|fg)$/.exec(n))) return `${m[1]} pill: ${m[2] === "bg" ? "fill" : "text"}.`;
  if ((m = /^mark-(.+)$/.exec(n))) return `Result mark (${m[1]}) next to a word or icon.`;
  if ((m = /^today-(.+)$/.exec(n))) return `Today page: ${m[1].replace(/-/g, " ")}.`;
  if (/tint/.test(n)) return "Violet tint behind a selected or highlighted element.";
  return null;
}

export const SHADOW_USAGE = {
  "shadow-0": "No elevation: cards at rest.", "shadow-1": "Interactive card hover.", "shadow-2": "Dropdowns and menus.", "shadow-3": "Dialogs, drawers, command palette.", "shadow-4": "Toasts.",
  "focus-ring": "Focus ring as a box-shadow: 2px canvas gap, 2px focus-color.", "shell-ring": "App shell glass outline.", "shell-divider": "Topbar bottom rule.", "shell-sidebar-divider": "Sidebar right rule.",
  "ring-glass": "1px inset outline of glass cards, badges, tags.", "ring-glass-strong": "Stronger glass outline.", "glow-violet": "Violet halo behind the brand planet/hero.", "glow-blue": "Blue halo behind the brand planet/hero.",
  "button-glass-shadow": "Glass button bevel and drop shadow.", "button-text-shadow": "Text shadow on glass buttons (dark theme only).", "button-solid-shadow": "Violet glow under the solid button.", "button-blue-shadow": "Blue glow under the blue button.", "switch-thumb-shadow": "Switch thumb drop shadow.",
  "reset-ring": "Quota reset control outline.", "ring-danger": "Danger outline.", "danger-panel-ring": "Danger zone panel outline.", "ring-violet": "Selected violet outline.", "ring-violet-soft": "Softer violet outline.", "ring-violet-faint": "Faintest violet outline.",
  "hairline": "Bottom hairline as inset shadow (rows).", "hairline-top": "Top hairline.", "hairline-faint": "Faint bottom hairline.", "shadow-sticky": "Sticky header shadow.",
  "today-row-selected-ring": "Today page selected row outline.", "today-banner-ring": "Today page banner outline.", "today-banner-glow": "Today page banner glow.",
};

/** The type scale (globals.css @utility type-*, the chat sizes, .hive-prose) and the usage of every non-colour token. */
export const FAMILIES = {
  type: {
    fonts: [],
    families: { sans: "Inter, system-ui, -apple-system, \"Segoe UI\", sans-serif", display: "Inter, system-ui, sans-serif", mono: "\"JetBrains Mono\", ui-monospace, SFMono-Regular, Menlo, monospace" },
    groups: [
      { name: "Display", family: "display", styles: [
        { name: "display-lg", fontSize: "32px", lineHeight: "40px", fontWeight: 600, letterSpacing: "-0.02em", usage: "Page titles.", sample: "Hôm nay" },
        { name: "display-md", fontSize: "24px", lineHeight: "32px", fontWeight: 600, letterSpacing: "-0.02em", usage: "Section and dialog titles." },
        { name: "numeric-lg", fontSize: "28px", lineHeight: "36px", fontWeight: 600, usage: "KPI numbers; tabular figures.", sample: "1.284 · 97,2%" }] },
      { name: "Heading", family: "sans", styles: [
        { name: "heading-lg", fontSize: "20px", lineHeight: "28px", fontWeight: 600, usage: "Card group headings." },
        { name: "heading-md", fontSize: "16px", lineHeight: "24px", fontWeight: 600, usage: "Card titles." },
        { name: "heading-sm", fontSize: "14px", lineHeight: "20px", fontWeight: 600, usage: "Table headers, small titles." }] },
      { name: "Body", family: "sans", styles: [
        { name: "body-lg", fontSize: "16px", lineHeight: "26px", fontWeight: 400, usage: "Lead paragraphs; mobile body." },
        { name: "body-md", fontSize: "14px", lineHeight: "22px", fontWeight: 400, usage: "Default UI text (body)." , sample: "Không kết nối được máy build-03. Kiểm tra agent đang chạy rồi thử lại." },
        { name: "body-sm", fontSize: "13px", lineHeight: "20px", fontWeight: 400, usage: "Dense tables, secondary text." },
        { name: "label", fontSize: "13px", lineHeight: "20px", fontWeight: 500, usage: "Form labels, switches, buttons." },
        { name: "caption", fontSize: "12px", lineHeight: "16px", fontWeight: 500, usage: "Meta and helper text." },
        { name: "overline", fontSize: "11px", lineHeight: "16px", fontWeight: 600, letterSpacing: "0.06em", usage: "Section overlines." }] },
      { name: "Cosmic chat", family: "sans", styles: [
        { name: "text-body-sm", fontSize: "14px", lineHeight: "22px", fontWeight: 500, usage: "Chat and card body in the 2026-10 design (also --ds-body-sm, --design-body-sm)." },
        { name: "text-caption", fontSize: "12px", lineHeight: "18px", fontWeight: 500, usage: "Chat caption (also --ds-caption, --design-caption)." },
        { name: "text-micro", fontSize: "11px", lineHeight: "16px", fontWeight: 600, usage: "Badges, counters (also --ds-micro, --design-micro)." }] },
      { name: "Docs prose", family: "sans", styles: [
        { name: "prose-h1", family: "display", fontSize: "26px", lineHeight: "34px", fontWeight: 600, letterSpacing: "-0.01em", usage: ".hive-prose h1 in Docs and the rich editor." },
        { name: "prose-h2", family: "display", fontSize: "17px", lineHeight: "24px", fontWeight: 600, usage: ".hive-prose h2." },
        { name: "prose-h3", fontSize: "15px", lineHeight: "24px", fontWeight: 600, usage: ".hive-prose h3." },
        { name: "prose-body", fontSize: "15px", lineHeight: "25px", fontWeight: 400, usage: ".hive-prose paragraphs; 16px under 768px." }] },
      { name: "Code", family: "mono", styles: [
        { name: "code-md", fontSize: "13px", lineHeight: "20px", fontWeight: 400, usage: "Code blocks, logs, diffs.", sample: "ai/ADM-backup-restore" },
        { name: "code-sm", fontSize: "12px", lineHeight: "18px", fontWeight: 400, usage: "IDs, slugs, paths, model names inline." }] },
    ],
  },
  spacing: { "space-0": "No gap.", "space-px": "Hairline offsets.", "space-0-5": "Icon-to-text nudge.", "space-1": "Tight inline gaps.", "space-2": "Gap between related controls.", "space-3": "Switch label gap, compact padding.", "space-4": "Card padding (compact), form field gap.", "space-5": "Card padding.", "space-6": "Section gap, page gutter.", "space-8": "Between page sections.", "space-10": "Large section gap.", "space-12": "Empty state padding.", "space-16": "Hero spacing.", "space-20": "Largest vertical rhythm.", gutter: "Page side gutter ≥768px.", "gutter-mobile": "Page side gutter <768px." },
  radius: { "radius-none": "Square.", "radius-xs": "Checkbox, outline badge, xs button.", "radius-sm": "Small buttons, menu items.", "radius-md": "Legacy buttons, inputs (shadcn --radius).", "radius-lg": "Legacy cards, dialogs, toasts.", "radius-xl": "Drawers, command palette.", "radius-full": "Avatars, pills, switch, badges, dots.", "radius-card": "Cosmic cards and panels.", "radius-pill": "Cosmic buttons (all sizes) and pill tabs.", "radius-control": "Cosmic inputs and input groups.", "radius-chip": "Cosmic tags." },
  size: { "control-h-xs": "xs buttons, inline chips.", "control-h-sm": "Small controls.", "control-h-md": "Default legacy button, input.", "control-h-lg": "Large controls.", "control-h-touch": "Minimum touch target on mobile.", "button-h-sm": "Cosmic button sm.", "button-h-md": "Cosmic button md (default for glass/solid/blue/ghost).", "button-h-lg": "Cosmic button lg.", "icon-sm": "Icons in dense rows.", "icon-md": "Default icon.", "icon-lg": "Icons in empty states, headers.", "row-h": "Table row.", "row-h-compact": "Compact table row." },
  layout: { "sidebar-w": "Sidebar ≥1024px.", "sidebar-rail-w": "Icon rail 768–1023px.", "topbar-h": "Top bar height.", "content-max": "Max content width.", "reading-max": "Max line length for docs." },
  border: { "border-width": "Default borders.", "border-width-strong": "Selected card, invalid input.", "focus-ring-width": "Focus outline width.", "focus-ring-offset": "Focus outline offset." },
  zIndex: { "z-base": "Stacking: base.", "z-sticky": "Stacking: sticky.", "z-dropdown": "Stacking: dropdown.", "z-drawer": "Stacking: drawer.", "z-dialog": "Stacking: dialog.", "z-toast": "Stacking: toast.", "z-tooltip": "Stacking: tooltip." },
  breakpoint: { "bp-sm": "Large phones.", "bp-md": "Tablet: sidebar becomes icon rail; mobile drawer below.", "bp-lg": "Desktop: full sidebar.", "bp-xl": "Wide desktop.", "bp-2xl": "Extra wide." },
  tracking: { "tracking-tight": "Display styles.", "tracking-normal": "Body.", "tracking-wide": "Overline." },
};
