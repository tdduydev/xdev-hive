import type { ComponentType, ReactNode } from "react";
import {
  CommonBadge,
  HiveWordmark,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  XMark,
} from "@xdev-hive/ui";
import {
  BookOpen,
  Brain,
  Cpu,
  GitMerge,
  History,
  Inbox,
  Layers,
  MessagesSquare,
  MoreHorizontal,
  Network,
  Package,
  Play,
  Plus,
  Settings2,
  Shield,
  Sparkles,
  SquareKanban,
} from "lucide-react";

// The hub web menu (lib/nav.ts WEB_MENU + App.tsx icons): Làm việc / Không gian / Vận hành.
// SidebarProvider draws a min-h-svh wrapper; each story caps it to a fixed height so the card stays bounded.
// The main stories use collapsible="none" (a plain in-flow column): the default offcanvas/icon modes position the
// panel `fixed` and turn into a mobile Sheet below 768px, which only the IconRail story exercises.
type Item = { label: string; icon: ComponentType; badge?: number; active?: boolean };
const GROUPS: Array<{ label: string; items: Item[] }> = [
  {
    label: "Làm việc",
    items: [
      { label: "Hôm nay", icon: Inbox, badge: 4 },
      { label: "Task", icon: SquareKanban, active: true },
      { label: "Chat", icon: MessagesSquare },
      { label: "Quy trình", icon: GitMerge },
      { label: "Tính năng", icon: Layers },
      { label: "Agent đang chạy", icon: Play, badge: 3 },
    ],
  },
  {
    label: "Không gian",
    items: [
      { label: "Tài liệu", icon: BookOpen },
      { label: "Memory", icon: Brain },
      { label: "Skill", icon: Sparkles },
      { label: "Artifact", icon: Package },
      { label: "Lịch sử", icon: History },
      { label: "Sơ đồ", icon: Network },
    ],
  },
  {
    label: "Vận hành",
    items: [
      { label: "Máy & agent", icon: Cpu, badge: 1 },
      { label: "Cài đặt service", icon: Settings2 },
      { label: "Quản trị", icon: Shield },
    ],
  },
];

const H = 660;

// On the collapsed rail the label is hidden outright: the 40px button would otherwise show its first letter (see
// learnings: icon 18px + gap leave ~14px for the truncated span).
function Menu({ items, rail }: { items: Item[]; rail?: boolean }) {
  return (
    <SidebarMenu>
      {items.map(({ label, icon: Icon, badge, active }) => (
        <SidebarMenuItem key={label}>
          <SidebarMenuButton isActive={active} tooltip={rail ? label : undefined}>
            <Icon />
            <span className={rail ? "group-data-[collapsible=icon]:hidden" : undefined}>{label}</span>
          </SidebarMenuButton>
          {badge ? <SidebarMenuBadge>{badge}</SidebarMenuBadge> : null}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function PageBody({ title, sub, children }: { title: string; sub: string; children?: ReactNode }) {
  return (
    <SidebarInset className="min-w-0">
      <div className="flex items-center gap-2 border-b border-line-subtle px-4 py-3">
        {children}
        <div className="min-w-0">
          <div className="type-heading-sm text-fg-strong">{title}</div>
          <div className="type-caption text-fg-secondary">{sub}</div>
        </div>
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="h-24 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
        <div className="h-40 rounded-[24px] bg-card shadow-[var(--ring-glass)]" />
      </div>
    </SidebarInset>
  );
}

export function WorkspaceNav() {
  return (
    <SidebarProvider className="min-h-0 overflow-hidden" style={{ height: `min(100svh, ${H}px)` }}>
      <Sidebar collapsible="none" className="border-r border-sidebar-border">
        <SidebarHeader className="px-4 py-3">
          <HiveWordmark height={26} />
        </SidebarHeader>
        <SidebarContent>
          {GROUPS.map((g) => (
            <SidebarGroup key={g.label} className="py-1">
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <Menu items={g.items} />
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
      <PageBody title="Task" sub="Mọi task theo phạm vi đang chọn" />
    </SidebarProvider>
  );
}

export function WithSubmenu() {
  return (
    <SidebarProvider className="min-h-0 overflow-hidden" style={{ height: `min(100svh, ${H}px)` }}>
      <Sidebar collapsible="none" className="border-r border-sidebar-border">
        <SidebarHeader className="px-4 py-3">
          <HiveWordmark height={26} />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Vận hành</SidebarGroupLabel>
            <SidebarGroupAction aria-label="Thêm máy"><Plus /></SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive><Cpu /><span>Máy & agent</span></SidebarMenuButton>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem><SidebarMenuSubButton size="sm" href="#/machines?tab=quota">Quota</SidebarMenuSubButton></SidebarMenuSubItem>
                    <SidebarMenuSubItem><SidebarMenuSubButton size="sm" href="#/machines?tab=map">Bản đồ agent</SidebarMenuSubButton></SidebarMenuSubItem>
                    <SidebarMenuSubItem><SidebarMenuSubButton size="sm" href="#/machines?tab=fleet" isActive>Đội máy</SidebarMenuSubButton></SidebarMenuSubItem>
                    <SidebarMenuSubItem><SidebarMenuSubButton size="sm" href="#/machines?tab=queue">Hàng đợi</SidebarMenuSubButton></SidebarMenuSubItem>
                    <SidebarMenuSubItem><SidebarMenuSubButton size="sm" href="#/machines?tab=costs">Chi phí</SidebarMenuSubButton></SidebarMenuSubItem>
                  </SidebarMenuSub>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton><Settings2 /><span>Cài đặt service</span></SidebarMenuButton>
                  <SidebarMenuAction aria-label="Thêm thao tác"><MoreHorizontal /></SidebarMenuAction>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton><Shield /><span>Quản trị</span></SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarSeparator />
        {/* The extra bottom padding is the capture's 24px top gutter: the provider fills the viewport, so ?story= shots
            crop its last 24px; the footer stays whole there and only gains breathing room in the product. */}
        <SidebarFooter className="px-4 pt-3" style={{ paddingBottom: 36 }}>
          <div className="flex items-center gap-2 type-body-sm">
            <span className="grid size-7 place-items-center rounded-full bg-selected type-caption font-semibold text-selected-fg">DT</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-fg-strong">Trần Đức Duy</div>
              <div className="truncate type-caption text-fg-muted">hive.xdev.asia</div>
            </div>
            <CommonBadge tone="accent">admin</CommonBadge>
          </div>
        </SidebarFooter>
      </Sidebar>
      <PageBody title="Đội máy" sub="Máy đã nối với hub và gói agent của từng máy" />
    </SidebarProvider>
  );
}

// collapsible="icon", collapsed: a 64px rail of icons (labels move to tooltips); SidebarTrigger expands it.
// Its panel is position:fixed, so the card's transformed cell contains it; className h-full replaces h-svh.
export function IconRail() {
  return (
    <SidebarProvider defaultOpen={false} className="min-h-0 overflow-hidden" style={{ height: `min(100svh, ${H}px)` }}>
      <Sidebar collapsible="icon" className="h-full">
        <SidebarHeader className="items-center py-3">
          <XMark size={28} />
        </SidebarHeader>
        <SidebarContent>
          {[GROUPS[0], GROUPS[2]].map((g) => (
            <SidebarGroup key={g.label} className="py-1">
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <Menu items={g.items} rail />
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </Sidebar>
      <PageBody title="Task" sub="Mọi task theo phạm vi đang chọn">
        <SidebarTrigger />
      </PageBody>
    </SidebarProvider>
  );
}
