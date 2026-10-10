// One card per component in the design system artifact: its group, row height, the source it documents,
// the guideline README and the preview body. The preview runs `code` with X = window.XdevHive, I = X.Icons,
// h = React.createElement, and row()/col() wrappers. Key order is the card order on the page.
export const COMPONENTS = {
  Button: { group: "Actions", height: 170, src: "components/ui/button.tsx",
    code: `row(h(X.Button,{variant:"solid"},h(I.Plus),"Tạo task"), h(X.Button,{variant:"blue"},h(I.Play),"Chạy agent"), h(X.Button,{variant:"glass"},"Duyệt"), h(X.Button,{variant:"ghost"},"Huỷ"), h(X.Button,{variant:"brand"},"Kết nối máy")),
row(h(X.Button,{variant:"solid",size:"sm"},"Nhỏ"), h(X.Button,{variant:"solid",size:"md"},"Vừa"), h(X.Button,{variant:"solid",size:"lg"},"Lớn"), h(X.Button,{variant:"glass",size:"icon","aria-label":"Cài đặt"},h(I.Settings)), h(X.Button,{variant:"solid",disabled:true},"Đã khoá")),
row(h(X.Button,{variant:"destructive"},h(I.Trash2),"Xoá dự án"), h(X.Button,{variant:"danger-outline"},"Thu hồi"), h(X.Button,{variant:"outline"},"Xuất CSV"), h(X.Button,{variant:"link"},"Xem nhật ký"))`,
    readme: `Starts an action. The cosmic variants are \`solid\` (violet, the one main action of an area), \`blue\` (a second call to action beside it), \`glass\` (the default secondary) and \`ghost\` (tertiary, toolbars).

- \`brand\` draws the brand gradient as its border: at most one per screen.
- \`destructive\` and \`danger-outline\` for irreversible actions; the label names the consequence ("Xoá dự án").
- Sizes \`sm\` 34px, \`md\` 46px, \`lg\` 54px on the cosmic variants; \`default\` (32px), \`xs\` and \`icon*\` for dense legacy layouts. Icon-only buttons need \`aria-label\` and a tooltip.
- The label starts with a verb, in sentence case. Put a 16px Lucide icon before it when it helps recognition.
- \`asChild\` renders the styles onto a link or other element.

The consumer provides the label (children), \`variant\`, \`size\`, and the usual button props.` },
  Toggle: { group: "Actions", height: 80, src: "components/ui/toggle.tsx",
    code: `row(h(X.Toggle,{"aria-label":"Đậm",defaultPressed:true},h(I.Bold)), h(X.Toggle,{"aria-label":"Nghiêng"},h(I.Italic)), h(X.Toggle,{variant:"outline"},h(I.Filter),"Chỉ của tôi"))`,
    readme: `A two-state button (Radix Toggle) for a single on/off option in a toolbar.

- On state fills with \`action-primary-bg\`; the glass fill and \`ring-glass\` at rest.
- Variants \`default\`, \`outline\`; sizes \`sm\`, \`default\`, \`lg\`.
- Give an icon-only toggle an \`aria-label\`. For a form setting use Switch instead.

The consumer provides children, \`pressed\` / \`defaultPressed\` and \`onPressedChange\`.` },
  ToggleGroup: { group: "Actions", height: 80, src: "components/ui/toggle-group.tsx",
    code: `row(h(X.ToggleGroup,{type:"single",defaultValue:"all",variant:"outline"},h(X.ToggleGroupItem,{value:"all"},"Tất cả"),h(X.ToggleGroupItem,{value:"mine"},"Của tôi"),h(X.ToggleGroupItem,{value:"review"},"Chờ duyệt")))`,
    readme: `A set of toggles where one (\`type="single"\`) or several (\`type="multiple"\`) can be on: view switches and filters.

The consumer provides \`type\`, \`value\` / \`defaultValue\`, \`onValueChange\` and one \`ToggleGroupItem\` per option, each with a \`value\` and a label.` },
  Badge: { group: "Status", height: 80, src: "components/ui/badge.tsx",
    code: `row(h(X.Badge,null,"Chờ"), h(X.Badge,{tone:"violet"},"Claude"), h(X.Badge,{tone:"info"},"Đang chạy"), h(X.Badge,{tone:"success"},"Xong"), h(X.Badge,{tone:"warning"},"Hết quota"), h(X.Badge,{tone:"danger"},"Lỗi"), h(X.Badge,{dot:false},"v0.42"))`,
    readme: `A 24px glass pill with a glowing tone dot and one or two words of state.

- \`tone\`: \`neutral\`, \`violet\`, \`blue\`/\`info\`, \`green\`/\`success\`, \`warning\`, \`danger\`. The dot carries the colour; the word carries the meaning, so never leave it out.
- \`dot={false}\` for a plain label such as a version.
- For a tinted status fill use StatusBadge.

The consumer provides children, \`tone\` and optionally \`dot\`, \`variant\`.` },
  StatusBadge: { group: "Status", height: 80, src: "components/common.tsx (Badge)",
    code: `row(...["queued","running","review","succeeded","failed","admin"].map(s=>h(X.StatusBadge,{key:s,tone:{queued:"neutral",running:"running",review:"warn",succeeded:"ok",failed:"danger",admin:"accent"}[s]},s)))`,
    readme: `The app's status badge (exported from common.tsx as \`Badge\`; named \`StatusBadge\` here): a tinted fill in the status colour.

- \`tone\`: \`ok\`, \`warn\`, \`info\`, \`running\`, \`danger\`, \`accent\`, \`neutral\`. \`STATUS_TONE\` in common.tsx maps task, run and role states (queued, running, review, failed, admin…) to a tone.
- Text uses \`status-*-fg\` on \`status-*-bg\`.

The consumer provides children and \`tone\`.` },
  StatusDot: { group: "Status", height: 64, src: "components/common.tsx",
    code: `row(...["ok","running","warn","danger","neutral"].map(t=>h("span",{key:t,style:{display:"inline-flex",alignItems:"center",gap:8,font:"var(--type-label)",color:"var(--text-secondary)"}},h(X.StatusDot,{tone:t}),{ok:"Trực tuyến",running:"Đang chạy",warn:"Gần hết quota",danger:"Mất kết nối",neutral:"Nghỉ"}[t])))`,
    readme: `An 8px status light for machines and agents (online, running, resting).

It is \`aria-hidden\`: always put the state in words beside it. \`tone\`: \`ok\`, \`running\`, \`info\`, \`warn\`, \`danger\`, \`neutral\`.` },
  Tag: { group: "Status", height: 64, src: "components/ui/primitives.tsx",
    code: `row(h(X.Tag,null,"frontend"), h(X.Tag,null,"api"), h(X.Tag,{active:true},"ưu tiên"), h(X.Tag,null,"ai/ADM-backup"))`,
    readme: `A 28px square-cornered chip (\`radius-chip\`) on \`surface-3\` for labels, filters and topics; \`active\` turns it violet.

The consumer provides children, optionally \`active\` and \`tone\`.` },
  Notice: { group: "Status", height: 300, src: "components/common.tsx",
    code: `col(h(X.Notice,{tone:"ok",title:"Đã lưu"},"Cấu hình agent đã cập nhật."), h(X.Notice,{tone:"info"},"Hub sẽ khởi động lại lúc 02:00."), h(X.Notice,{tone:"warn",title:"Sắp hết quota"},"Claude còn 12% cho tuần này."), h(X.ErrorNote,{error:"Không kết nối được máy build-03. Kiểm tra agent đang chạy rồi thử lại."}))`,
    readme: `A tinted message box with an icon: saved, hint, warning. \`ErrorNote\` (same file) shows an action's error with the danger style.

- \`tone\`: \`ok\`, \`info\`, \`warn\`, \`error\`. The icon is built in.
- Errors say what happened and what to do next.

The consumer provides \`tone\`, an optional \`title\`, and the message as children.` },
  Alert: { group: "Status", height: 170, src: "components/ui/alert.tsx",
    code: `col(h(X.Alert,null,h(I.Info),h(X.AlertTitle,null,"Có bản mới"),h(X.AlertDescription,null,"Desktop 0.42 sẵn sàng; cài khi rảnh.")), h(X.Alert,{variant:"destructive"},h(I.X),h(X.AlertTitle,null,"Run thất bại"),h(X.AlertDescription,null,"Test e2e lỗi ở bước login.")))`,
    readme: `The base alert (shadcn) Notice is built on: an icon, \`AlertTitle\` and \`AlertDescription\`. Variants \`default\` (info) and \`destructive\`. Prefer Notice in pages.` },
  Skeleton: { group: "Status", height: 120, src: "components/ui/skeleton.tsx",
    code: `col(h(X.Skeleton,{style:{height:20,width:"40%"}}), h(X.Skeleton,{style:{height:14,width:"90%"}}), h(X.Skeleton,{style:{height:14,width:"75%"}}))`,
    readme: `A shimmer placeholder for content that is loading. Size it like the content it replaces (width, height via className or style). Animation stops under reduced motion.` },
  Input: { group: "Forms", height: 200, src: "components/ui/input.tsx",
    code: `col(h(X.Label,{htmlFor:"n"},"Tên dự án"), h(X.Input,{id:"n",placeholder:"payment-gateway"}), h(X.Input,{icon:h(I.Search),placeholder:"Tìm task, agent, tài liệu…"}), h(X.Input,{"aria-invalid":true,defaultValue:"build 03"}))`,
    readme: `A text field on \`surface-sunken\` with \`radius-control\` and \`ring-glass\`; 16px on mobile, 14px from 768px.

- \`controlSize\`: \`sm\` 36, \`md\` 44 (default), \`lg\` 52.
- \`icon\` (leading) and \`trailing\` wrap it in an input group; focus draws the 2px \`focus-color\` ring on the group.
- \`aria-invalid\` adds a 2px danger ring; also show the message in words below.
- Pair with \`Label\`.

The consumer provides the usual input props plus \`controlSize\`, \`icon\`, \`trailing\`.` },
  Textarea: { group: "Forms", height: 150, src: "components/ui/textarea.tsx",
    code: `col(h(X.Label,{htmlFor:"p"},"Prompt cho agent"), h(X.Textarea,{id:"p",rows:4,defaultValue:"Viết test cho hàm pagesToShow, phủ trang đầu, trang cuối và dấu …"}))`,
    readme: `A multi-line text field with the Input's styling. The consumer provides the usual textarea props.` },
  Checkbox: { group: "Forms", height: 110, src: "components/ui/checkbox.tsx",
    code: `col(...[["a","Chạy test trước khi merge",true],["b","Gửi thông báo khi xong",false],["c","Tự duyệt (đã khoá)",false,true]].map(([id,l,c,d])=>h("div",{key:id,style:{display:"flex",alignItems:"center",gap:8}},h(X.Checkbox,{id,defaultChecked:c,disabled:d}),h(X.Label,{htmlFor:id},l))))`,
    readme: `A Radix checkbox (\`radius-xs\`, \`border-control\`) for multi-select lists and opt-ins. Always pair it with a \`Label\`.

The consumer provides \`checked\` / \`defaultChecked\`, \`onCheckedChange\`, \`id\`, \`disabled\`.` },
  Switch: { group: "Forms", height: 130, src: "components/ui/primitives.tsx",
    code: `col(h(X.Switch,{defaultChecked:true},"Cho phép agent tự commit"), h(X.Switch,null,"Chế độ gọn"), h(X.Switch,{disabled:true},"Đồng bộ đám mây"))`,
    readme: `The cosmic switch: a native checkbox with \`role="switch"\`, a 44×26 track on \`surface-4\` that turns violet when on, and its label beside it. The whole row is the 44px touch target.

The consumer provides the label as children and checkbox props (\`checked\`, \`defaultChecked\`, \`onChange\`, \`disabled\`). For a toolbar on/off use Toggle.` },
  NativeSelect: { group: "Forms", height: 100, src: "components/ui/native-select.tsx",
    code: `col(h(X.Label,null,"Model"), h(X.NativeSelect,{defaultValue:"opus"},h(X.NativeSelectOption,{value:"opus"},"claude-opus-5-5"),h(X.NativeSelectOption,{value:"sonnet"},"claude-sonnet-5-5"),h(X.NativeSelectOption,{value:"codex"},"codex")))`,
    readme: `A styled native \`<select>\`: use it on mobile and in plain forms where the OS picker is best. Options via \`NativeSelectOption\` / \`NativeSelectOptGroup\`.` },
  Select: { group: "Forms", height: 280, src: "components/ui/select.tsx",
    code: `h("div",{style:{width:260}},h(X.Select,{defaultValue:"main",defaultOpen:true},h(X.SelectTrigger,{style:{width:"100%"}},h(X.SelectValue,{placeholder:"Chọn nhánh"})),h(X.SelectContent,null,h(X.SelectGroup,null,h(X.SelectLabel,null,"Nhánh"),h(X.SelectItem,{value:"main"},"main"),h(X.SelectItem,{value:"dev"},"dev"),h(X.SelectItem,{value:"ai"},"ai/ADM-backup-restore")))))`,
    readme: `A Radix select with a custom list: Trigger, Value, Content, Group, Label, Item, Separator. Use it when options need grouping or rich labels; otherwise NativeSelect.

The consumer provides \`value\` / \`defaultValue\`, \`onValueChange\` and the item tree.` },
  Tabs: { group: "Navigation", height: 170, src: "components/ui/tabs.tsx",
    code: `col(h(X.Tabs,{defaultValue:"a"},h(X.TabsList,null,h(X.TabsTrigger,{value:"a"},"Tổng quan"),h(X.TabsTrigger,{value:"b"},"Run"),h(X.TabsTrigger,{value:"c"},"Nhật ký"))), h(X.Tabs,{defaultValue:"b"},h(X.TabsList,{variant:"line"},h(X.TabsTrigger,{value:"a"},"Tổng quan"),h(X.TabsTrigger,{value:"b"},"Run"),h(X.TabsTrigger,{value:"c"},"Nhật ký")),h(X.TabsContent,{value:"b",style:{paddingTop:12,font:"var(--type-body-sm)",color:"var(--text-secondary)"}},"3 run trong 24 giờ qua.")))`,
    readme: `Radix tabs that switch panels in place. \`TabsList\` variant \`default\` is a sunken segmented well; \`line\` is an underline bar with a violet indicator.

The consumer provides \`value\` / \`defaultValue\`, triggers and a \`TabsContent\` per value. For page-level tabs with addresses use PageTabs; for filters use SegmentedTabs.` },
  SegmentedTabs: { group: "Navigation", height: 90, src: "components/ui/primitives.tsx",
    code: `h(function S(){var s=React.useState("week");return h(X.SegmentedTabs,{label:"Khoảng thời gian",value:s[0],onChange:s[1],items:[{value:"day",label:"Hôm nay"},{value:"week",label:"Tuần"},{value:"month",label:"Tháng"},{value:"all",label:"Tất cả",disabled:true}]})})`,
    readme: `Filter tabs as pressed buttons in a sunken well: the pressed segment lifts to \`surface-3\` with \`ring-glass-strong\`. No tabpanel contract, so use it to filter one list.

The consumer provides \`label\` (for screen readers), \`items\` ({value, label, disabled}), \`value\` and \`onChange\`.` },
  PageTabs: { group: "Navigation", height: 120, src: "components/PageTabs.tsx",
    code: `h(X.PageTabs,{page:"admin",tabs:["members","machines","backup"],current:"machines",label:"Quản trị",name:function(t){return {members:"Thành viên",machines:"Máy & agent",backup:"Sao lưu"}[t]}},h("div",{style:{padding:"16px 24px",font:"var(--type-body-sm)",color:"var(--text-secondary)"}},"Nội dung tab Máy & agent"))`,
    readme: `The tab bar of one menu entry: each tab is a link to \`#/<page>?tab=<id>\`, so a tab has an address and Back works. A single tab hides the bar.

The consumer provides \`page\`, \`tabs\`, \`current\`, \`label\`, \`name(tab)\` and the current tab's content as children.` },
  Card: { group: "Layout", height: 220, src: "components/ui/card.tsx",
    code: `h(X.Card,{style:{maxWidth:420}},h(X.CardHeader,null,h(X.CardTitle,null,"build-03"),h(X.CardDescription,null,"Ubuntu 24.04 · 3 agent"),h(X.CardAction,null,h(X.Badge,{tone:"success"},"Trực tuyến"))),h(X.CardContent,{style:{font:"var(--type-body-sm)",color:"var(--text-secondary)"}},"Run gần nhất 3 phút trước."),h(X.CardFooter,{style:{gap:8}},h(X.Button,{variant:"glass",size:"sm"},"Mở terminal"),h(X.Button,{variant:"ghost",size:"sm"},"Chi tiết")))`,
    readme: `The cosmic card: \`surface-1\`, \`radius-card\` 24px, padding \`space-6\`, outlined by \`ring-glass\`, no shadow. Parts: CardHeader (CardTitle, CardDescription, CardAction), CardContent, CardFooter.

Never add a coloured left border. The consumer provides the parts as children.` },
  StatTile: { group: "Layout", height: 140, src: "components/ui/primitives.tsx",
    code: `h("div",{style:{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}},h(X.StatTile,{label:"Task xong tuần này",value:"1.284",detail:"+12% so với tuần trước"}),h(X.StatTile,{label:"Tỉ lệ run thành công",value:"97,2%"}),h(X.StatTile,{label:"Chi phí model",value:"$12,48",detail:"3 nhà cung cấp"}))`,
    readme: `A KPI tile on \`surface-2\`: label, number in \`numeric-lg\`, optional detail. Numbers in Vietnamese format (1.284 · 97,2%).

The consumer provides \`label\`, \`value\` and optional \`detail\`.` },
  ListRow: { group: "Layout", height: 170, src: "components/ui/primitives.tsx",
    code: `col(h(X.ListRow,{title:"Sao lưu hằng ngày",description:"Lần cuối 02:00 · 412 MB",action:h(X.Button,{variant:"glass",size:"sm"},"Khôi phục")}),h(X.ListRow,{title:"Webhook GitHub",description:"Nhận push và PR của 4 repo",action:h(X.Switch,{defaultChecked:true},"Bật")}))`,
    readme: `A settings or list row on \`surface-2\`: title, optional description, and one action on the right. Wraps under 768px.

The consumer provides \`title\`, \`description\` and \`action\`.` },
  EmptyState: { group: "Layout", height: 170, src: "components/ui/primitives.tsx (EmptyState), components/common.tsx (Empty)",
    code: `col(h(X.EmptyState,{title:"Chưa có task",description:"Tạo task đầu tiên hoặc nhập từ GitHub.",action:h(X.Button,{variant:"solid",size:"sm",style:{marginTop:12}},h(I.Plus),"Tạo task")}),h(X.Empty,null,"Không có run nào khớp bộ lọc."))`,
    readme: `What a list shows when it has nothing. \`EmptyState\` (cosmic) centres a title, a description and one action; \`Empty\` is the dashed box the older pages use for a one-line message.

Say why it is empty and what to do next. The consumer provides \`title\`, \`description\`, \`action\` (or children for Empty).` },
  PageHeader: { group: "Layout", height: 140, src: "components/common.tsx",
    code: `h(X.PageHeader,{title:"Dự án",subtitle:"Mọi dự án trên hub, với agent, task và quota của từng dự án.",actions:h(React.Fragment,null,h(X.Button,{variant:"glass"},"Nhập từ GitHub"),h(X.Button,{variant:"solid"},h(I.Plus),"Tạo dự án"))})`,
    readme: `The top of a page: title in \`display-md\`, an intro line (clamped to one line on mobile with a show-more), and actions on the right. A \`border-subtle\` rule closes it.

The consumer provides \`title\`, optional \`subtitle\` and \`actions\`.` },
  Table: { group: "Layout", height: 220, src: "components/ui/table.tsx",
    code: `h(X.Table,null,h(X.TableHeader,null,h(X.TableRow,null,["Task","Agent","Trạng thái","Cập nhật"].map(c=>h(X.TableHead,{key:c},c)))),h(X.TableBody,null,[["ADM-backup-restore","claude","succeeded","3 phút trước"],["INT-ADM-migration","codex","running","vừa xong"],["UX-71-shell","gemini","failed","1 giờ trước"]].map(r=>h(X.TableRow,{key:r[0]},h(X.TableCell,{style:{fontFamily:"var(--font-mono)"}},r[0]),h(X.TableCell,null,r[1]),h(X.TableCell,null,h(X.StatusBadge,{tone:{succeeded:"ok",running:"running",failed:"danger"}[r[2]]},r[2])),h(X.TableCell,{style:{color:"var(--text-muted)"}},r[3])))))`,
    readme: `The base table (shadcn): Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption. Rows are \`row-h\` 40px (32 in compact density); IDs and slugs in mono; status as StatusBadge.

The app's DataTable (sorting, filters, bulk actions) and ResponsiveTable (cards under 768px) build on it and are not in this bundle.` },
  Dialog: { group: "Overlays", height: 330, src: "components/ui/dialog.tsx",
    code: `h(X.Dialog,{defaultOpen:true},h(X.DialogContent,null,h(X.DialogHeader,null,h(X.DialogTitle,null,"Đổi tên dự án"),h(X.DialogDescription,null,"Slug và đường dẫn repo giữ nguyên.")),h(X.Input,{defaultValue:"payment-gateway"}),h(X.DialogFooter,null,h(X.Button,{variant:"glass"},"Huỷ"),h(X.Button,{variant:"solid"},"Lưu"))))`,
    readme: `A modal dialog (Radix) on \`bg-scrim\`: \`radius-lg\`, \`shadow-3\`, with a close button. Parts: Trigger, Content, Header, Title, Description, Footer, Close.

Use it for a short task that blocks the page. The consumer provides \`open\` / \`onOpenChange\` (or a Trigger) and the content; a Title is required for screen readers.` },
  AlertDialog: { group: "Overlays", height: 300, src: "components/ui/alert-dialog.tsx",
    code: `h(X.AlertDialog,{defaultOpen:true},h(X.AlertDialogContent,null,h(X.AlertDialogHeader,null,h(X.AlertDialogTitle,null,"Xoá dự án payment-gateway?"),h(X.AlertDialogDescription,null,"42 task sẽ mất. Không hoàn tác được.")),h(X.AlertDialogFooter,null,h(X.AlertDialogCancel,null,"Huỷ"),h(X.AlertDialogAction,{variant:"destructive"},"Xoá dự án"))))`,
    readme: `A confirmation that must be answered (Radix AlertDialog). The title asks the question with the object's name; the description states the consequence; the action button repeats the verb.

The consumer provides \`open\` / \`onOpenChange\` and the parts.` },
  Popover: { group: "Overlays", height: 240, src: "components/ui/popover.tsx",
    code: `h(X.Popover,{defaultOpen:true},h(X.PopoverTrigger,{asChild:true},h(X.Button,{variant:"glass",size:"sm"},h(I.GitBranch),"ai/ADM-backup")),h(X.PopoverContent,{align:"start"},h(X.PopoverHeader,null,h(X.PopoverTitle,null,"Nhánh của task"),h(X.PopoverDescription,null,"Tạo từ main lúc 09:12, 4 commit."))))`,
    readme: `Non-modal floating content anchored to a trigger (\`bg-raised\`, \`shadow-2\`): details, small forms. Parts: Trigger, Content, Anchor, Header, Title, Description.` },
  DropdownMenu: { group: "Overlays", height: 260, src: "components/ui/dropdown-menu.tsx",
    code: `h(X.DropdownMenu,{defaultOpen:true,modal:false},h(X.DropdownMenuTrigger,{asChild:true},h(X.Button,{variant:"glass",size:"icon","aria-label":"Thêm"},h(I.MoreHorizontal))),h(X.DropdownMenuContent,{align:"start"},h(X.DropdownMenuLabel,null,"Task"),h(X.DropdownMenuItem,null,"Giao cho agent"),h(X.DropdownMenuItem,null,"Sao chép ID",h(X.DropdownMenuShortcut,null,"Ctrl C")),h(X.DropdownMenuSeparator),h(X.DropdownMenuItem,{variant:"destructive"},"Xoá task")))`,
    readme: `A menu of actions from a trigger (Radix): items, checkbox and radio items, labels, separators, shortcuts, submenus. Destructive items go last after a separator.

The consumer provides the trigger and the item tree.` },
  Tooltip: { group: "Overlays", height: 130, src: "components/ui/tooltip.tsx",
    code: `h(X.TooltipProvider,null,h("div",{style:{paddingTop:48}},h(X.Tooltip,{open:true},h(X.TooltipTrigger,{asChild:true},h(X.Button,{variant:"glass",size:"icon","aria-label":"Cài đặt"},h(I.Settings))),h(X.TooltipContent,null,"Cài đặt dự án"))))`,
    readme: `A short label on hover or focus. Mount one \`TooltipProvider\` near the app root. Every icon-only button has one, repeating its \`aria-label\`. Never put essential information only in a tooltip.` },
  Sheet: { group: "Overlays", height: 360, src: "components/ui/sheet.tsx",
    code: `h(X.Sheet,{defaultOpen:true},h(X.SheetContent,{side:"right"},h(X.SheetHeader,null,h(X.SheetTitle,null,"Run #1842"),h(X.SheetDescription,null,"claude · ai/ADM-backup-restore")),h("div",{style:{padding:"0 16px",font:"var(--type-body-sm)",color:"var(--text-secondary)"}},"Đã chạy 4 phút 12 giây.")))`,
    readme: `A drawer from an edge (Radix Dialog): \`side\` \`right\` (details), \`left\` (mobile navigation), \`top\`, \`bottom\`. Parts: Trigger, Content, Header, Title, Description, Footer, Close.

The consumer provides \`open\` / \`onOpenChange\`, \`side\` and the content.` },
};

export function previewHtml(name, { group, height, code }) {
  return `<!-- @dsCard group="${group}" height=${height} -->
<!doctype html>
<html>
<head><meta charset="utf-8"><title>${name}</title>
<style>body{margin:0;background:var(--bg-canvas);color:var(--text-primary);font:var(--type-body-md)}#root{padding:16px 20px}.r{display:flex;flex-wrap:wrap;align-items:center;gap:12px}.c{display:flex;flex-direction:column;gap:12px;max-width:520px}.r+.r{margin-top:12px}</style>
</head>
<body>
<div id="root"></div>
<script>
  var X = window.XdevHive, I = X.Icons, h = React.createElement;
  function row() { return h.apply(null, ["div", { className: "r" }].concat([].slice.call(arguments))); }
  function col() { return h.apply(null, ["div", { className: "c" }].concat([].slice.call(arguments))); }
  ReactDOM.createRoot(document.getElementById("root")).render(h(React.Fragment, null,
${code}
  ));
</script>
</body>
</html>
`;
}

export const readmeMd = (name, { readme, src }) => `# ${name}\n\n${readme}\n\nSource: \`packages/ui-kit/src/${src}\`.\n`;
