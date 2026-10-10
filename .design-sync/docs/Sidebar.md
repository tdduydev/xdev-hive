---
category: Navigation
---
# Sidebar

The shadcn sidebar kit: a collapsible side navigation with groups, menus, sub-menus, badges and a mobile sheet. The hub's own shell does not use it (it has its own markup), so reach for it only in a standalone design that needs an app sidebar.

**Composition**: `SidebarProvider` (required: `Sidebar`, `SidebarMenuButton`, `SidebarRail` and `SidebarTrigger` throw without it) > `Sidebar` (`SidebarHeader`, `SidebarContent` > `SidebarGroup` > `SidebarGroupLabel` + `SidebarGroupContent` > `SidebarMenu` > `SidebarMenuItem` > `SidebarMenuButton`, plus `SidebarMenuBadge` / `SidebarMenuAction` / `SidebarMenuSub` / `SidebarMenuSkeleton`, `SidebarFooter`) + `SidebarInset` (the page). `SidebarTrigger` toggles it.

**Key props**: `SidebarProvider` `defaultOpen` / `open` / `onOpenChange`; `Sidebar` `side`, `variant`, `collapsible`; `SidebarMenuButton` `isActive`, `tooltip`, `size`.

```tsx
<SidebarProvider>
  <Sidebar>
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupLabel>Dự án</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton isActive>Bảng task</SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton>Lượt chạy</SidebarMenuButton><SidebarMenuBadge>3</SidebarMenuBadge></SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
  <SidebarInset>…</SidebarInset>
</SidebarProvider>
```
